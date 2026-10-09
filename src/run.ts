import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";

import { detectAgent } from "./agent.ts";
import { deleteSavedApiKey, resolveApiKey, saveApiKey } from "./auth.ts";
import { callToolCached } from "./cache.ts";
import { CliError, EXIT } from "./errors.ts";
import type { TextRequest } from "./format.ts";
import {
  EXTRACT_HELP,
  LOGIN_HELP,
  LOGOUT_HELP,
  MAIN_HELP,
  MCP_HELP,
  SEARCH_HELP,
} from "./help.ts";
import type { AgentId, Exec } from "./install.ts";
import type { ExtractArgs, ToolResult } from "./mcp.ts";
import { closest, optionError, usageError } from "./usage.ts";
import { VERSION } from "./version.ts";

const DEFAULT_URL = "https://extraktor.app";
const UNSAFE_FILE_CHARACTERS = /[^a-z0-9.-]/giu;
const LOOKS_LIKE_URL = /^(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:[/?#]\S*)?$/iu;
const WHITESPACE = /\s/u;
/** At most 5 pages in one command, so that the output stays easy to read. */
const MAX_URLS = 5;
/**
 * The characters that one command prints. Agents see about 30,000 characters
 * of a command's output (Claude Code cuts the rest), so each output fits
 * completely. Several pages share it.
 */
const MAX_OUTPUT_CHARACTERS = 24_000;
const SOME_PAGES_FAILED = "SOME_PAGES_FAILED";
const SOME_AGENTS_FAILED = "SOME_AGENTS_FAILED";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
  cwd: string;
  /** Runs a program, for `mcp add`. Tests replace it. */
  exec?: Exec;
  platform?: NodeJS.Platform;
}

const EXTRACT_FLAGS = {
  find: { type: "string", multiple: true },
  offset: { type: "string" },
  excerpts: { type: "boolean" },
  summary: { type: "boolean" },
  focus: { type: "string" },
  screenshot: { type: "boolean" },
  "screenshot-file": { type: "string" },
  save: { type: "string" },
  contacts: { type: "boolean" },
  messaging: { type: "boolean" },
  seo: { type: "boolean" },
  keyword: { type: "string" },
  deep: { type: "boolean" },
  design: { type: "boolean" },
  "design-file": { type: "string" },
  vision: { type: "boolean" },
  "agent-access": { type: "boolean" },
  json: { type: "boolean" },
  "no-cache": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsConfig["options"];

const SEARCH_FLAGS = {
  serp: { type: "boolean" },
  json: { type: "boolean" },
  "no-cache": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsConfig["options"];

const LOGIN_FLAGS = {
  "no-browser": { type: "boolean" },
  "with-key": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsConfig["options"];

const MCP_FLAGS = {
  agent: { type: "string", multiple: true },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsConfig["options"];

const HELP_ONLY = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsConfig["options"];

/** parseArgs with usage errors that tell the agent what to change. */
const parse = <Options extends NonNullable<ParseArgsConfig["options"]>>(
  args: string[],
  options: Options,
  command: string
) => {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw optionError(
      error instanceof Error ? error.message : String(error),
      options,
      command
    );
  }
};

const baseUrlOf = (env: NodeJS.ProcessEnv) => {
  const value = env.EXTRAKTOR_URL || DEFAULT_URL;
  const url = URL.parse(value);
  if (!url) {
    throw new CliError(
      `EXTRAKTOR_URL is not a correct URL: ${value}`,
      EXIT.usage
    );
  }
  return url.origin;
};

const requireKey = async (baseUrl: string, env: NodeJS.ProcessEnv) => {
  const apiKey = await resolveApiKey(baseUrl, env);
  if (!apiKey) {
    throw new CliError(
      "You are not signed in.",
      EXIT.access,
      'Run "extraktor login", or set EXTRAKTOR_API_KEY to an API key from https://extraktor.app/developers.',
      "SIGN_IN_REQUIRED"
    );
  }
  return apiKey;
};

const screenshotName = (url: string) => {
  const host = URL.parse(
    url.includes("://") ? url : `https://${url}`
  )?.hostname;
  return `screenshot-${host?.replaceAll(UNSAFE_FILE_CHARACTERS, "_") || "page"}-${Date.now()}.png`;
};

/** Saves Markdown in a file, with a line break at the end. */
const saveMarkdown = async (markdown: string, file: string, io: Io) => {
  const absolute = path.resolve(io.cwd, file);
  await writeFile(
    absolute,
    markdown.endsWith("\n") ? markdown : `${markdown}\n`
  );
  return absolute;
};

/**
 * Saves the complete page text for --save, and DESIGN.md for --design-file
 * when the design output completed.
 */
const saveFiles = async (result: ToolResult, values: ExtractValues, io: Io) => {
  if (values.save === undefined && values["design-file"] === undefined) {
    return { savedFile: undefined, designFile: undefined };
  }
  // zod loaded while the request was on the network.
  // oxlint-disable-next-line react-doctor/server-sequential-independent-await
  const { parsePage } = await import("./format.ts");
  const { design, markdown } = parsePage(result);
  const designFile = values["design-file"];
  return {
    savedFile:
      values.save === undefined
        ? undefined
        : await saveMarkdown(markdown, values.save, io),
    designFile:
      designFile !== undefined && design?.status === "success"
        ? await saveMarkdown(design.markdown, designFile, io)
        : undefined,
  };
};

const saveScreenshot = async (result: ToolResult, file: string, io: Io) => {
  const image = result.content.find((item) => item.type === "image");
  if (!image?.data) {
    io.stderr(
      "Warning: the result has no image data. Use the server copy of the screenshot.\n"
    );
    return;
  }
  const absolute = path.resolve(io.cwd, file);
  await writeFile(absolute, Buffer.from(image.data, "base64"));
  return absolute;
};

type ExtractValues = ReturnType<typeof parse<typeof EXTRACT_FLAGS>>["values"];

const parseOffset = (value: string | undefined) => {
  if (value === undefined) {
    return;
  }
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < 0) {
    throw usageError("--offset must be a whole number, 0 or more.", "extract");
  }
  return offset;
};

/** Option combinations that do not work. */
const checkExtractOptions = (values: ExtractValues) => {
  if (values.focus !== undefined && !values.excerpts && !values.summary) {
    throw usageError(
      'Use --focus with --excerpts or --summary. To get only the parts of the page with some text, use --find "text".',
      "extract"
    );
  }
  if (values.find?.some((find) => !find.trim())) {
    throw usageError(
      'Give --find a text, for example --find "price".',
      "extract"
    );
  }
  if (values.find !== undefined && values.offset !== undefined) {
    throw usageError(
      "Use --find or --offset, not both. --find searches the complete page.",
      "extract"
    );
  }
  if (
    values.save !== undefined &&
    (values.find !== undefined || values.offset !== undefined)
  ) {
    throw usageError(
      "--save saves the complete page text. Do not use it with --find or --offset. Use grep on the file.",
      "extract"
    );
  }
};

/** The page text that the command prints. The CLI cuts it from the complete text. */
const textRequest = (values: ExtractValues): TextRequest => ({
  finds: [...new Set(values.find?.map((find) => find.trim()))],
  offset: parseOffset(values.offset),
});

/** Turns the command options into the extract tool input. */
const extractArgs = (url: string, values: ExtractValues): ExtractArgs => {
  const focus = values.focus?.trim() || undefined;
  const keyword = values.keyword?.trim() || undefined;
  const enabled = true as const;
  const wants = {
    screenshot: values.screenshot || values["screenshot-file"] !== undefined,
    seo: values.seo || values.keyword !== undefined || values.deep,
    design:
      values.design || values.vision || values["design-file"] !== undefined,
  };
  return {
    url,
    excerpts: values.excerpts ? { enabled, query: focus } : undefined,
    summary: values.summary ? { enabled, query: focus } : undefined,
    screenshot: wants.screenshot ? { enabled } : undefined,
    contacts: values.contacts ? { enabled } : undefined,
    messaging: values.messaging ? { enabled } : undefined,
    seo: wants.seo
      ? { enabled, keyword, deep: values.deep || undefined }
      : undefined,
    design: wants.design
      ? { enabled, vision: values.vision || undefined }
      : undefined,
    agentAccess: values["agent-access"] ? { enabled } : undefined,
  };
};

/** A URL has a host name with a dot and no spaces. Catches a query given to extract. */
const isUrlLike = (value: string) =>
  !WHITESPACE.test(value) &&
  (
    URL.parse(value.includes("://") ? value : `https://${value}`)?.hostname ??
    ""
  ).includes(".");

const checkUrls = (urls: string[], values: ExtractValues) => {
  if (urls.length === 0) {
    throw usageError("Give one or more URLs.", "extract");
  }
  const notUrl = urls.find((url) => !isUrlLike(url));
  if (notUrl) {
    throw usageError(
      `"${notUrl}" is not a URL. To find pages about it, run: extraktor search "${notUrl.replaceAll('"', "")}"`,
      "extract"
    );
  }
  if (urls.length > MAX_URLS) {
    throw usageError(
      `Give ${MAX_URLS} URLs or fewer in one command. Run a second command for the other pages.`,
      "extract"
    );
  }
  if (urls.length > 1 && values.offset !== undefined) {
    throw usageError(
      "--offset is for one page. Give one URL with --offset.",
      "extract"
    );
  }
  if (urls.length > 1 && values["screenshot-file"] !== undefined) {
    throw usageError(
      "--screenshot-file is for one page. Use --screenshot to save one PNG for each page.",
      "extract"
    );
  }
  for (const option of ["save", "design-file"] as const) {
    if (urls.length > 1 && values[option] !== undefined) {
      throw usageError(
        `--${option} is for one page. Run one command for each page.`,
        "extract"
      );
    }
  }
};

interface Connection {
  baseUrl: string;
  apiKey: string;
  agent: string | null;
}

interface PageRead {
  url: string;
  result: ToolResult;
  screenshotFile: string | undefined;
  designFile: string | undefined;
  savedFile: string | undefined;
}

const readPage = async (
  url: string,
  values: ExtractValues,
  connection: Connection,
  io: Io
): Promise<PageRead> => {
  const toolArgs = extractArgs(url, values);
  const result = await callToolCached(
    { ...connection, name: "extract", args: toolArgs },
    io.env,
    !values["no-cache"]
  );
  const screenshotFile = toolArgs.screenshot
    ? await saveScreenshot(
        result,
        values["screenshot-file"] ?? screenshotName(url),
        io
      )
    : undefined;
  return {
    url,
    result,
    screenshotFile,
    ...(await saveFiles(result, values, io)),
  };
};

const connect = async (io: Io): Promise<Connection> => {
  const baseUrl = baseUrlOf(io.env);
  return {
    baseUrl,
    apiKey: await requireKey(baseUrl, io.env),
    agent: detectAgent(io.env),
  };
};

const extract = async (args: string[], io: Io) => {
  const { values, positionals: urls } = parse(args, EXTRACT_FLAGS, "extract");
  if (values.help) {
    io.stdout(EXTRACT_HELP);
    return;
  }
  // Check every option before the first request.
  checkUrls(urls, values);
  checkExtractOptions(values);
  parseOffset(values.offset);
  const connection = await connect(io);
  const reads = await Promise.allSettled(
    urls.map((url) => readPage(url, values, connection, io))
  );
  // Import after the requests on purpose: an earlier import would load zod
  // before the requests leave. callTool loaded zod during the requests.
  // oxlint-disable-next-line react-doctor/server-sequential-independent-await
  const { formatExtract, formatPages, jsonPage, resultWarnings } =
    await import("./format.ts");
  const request = textRequest(values);
  const maxCharacters = Math.floor(MAX_OUTPUT_CHARACTERS / urls.length);
  const [first] = reads;
  if (urls.length === 1 && first) {
    if (first.status === "rejected") {
      throw first.reason;
    }
    const { url, result, screenshotFile, designFile, savedFile } = first.value;
    const pageRequest = { ...request, savedFile };
    if (values.json) {
      for (const warning of resultWarnings(result)) {
        io.stderr(`Warning (${warning.code}): ${warning.message}\n`);
      }
      io.stdout(
        `${JSON.stringify(
          {
            ...jsonPage(result, pageRequest, maxCharacters),
            ...(screenshotFile && { screenshotFile }),
            ...(designFile && { designFile }),
          },
          null,
          2
        )}\n`
      );
      return;
    }
    io.stdout(
      formatExtract(result, {
        ...pageRequest,
        url,
        baseUrl: connection.baseUrl,
        screenshotFile,
        designFile,
        maxCharacters,
      })
    );
    return;
  }
  const pages = reads.map((read, index) => {
    const url = urls[index] ?? "";
    if (read.status === "fulfilled") {
      return read.value;
    }
    if (!(read.reason instanceof CliError)) {
      throw read.reason;
    }
    return { url, error: read.reason };
  });
  io.stdout(
    values.json
      ? `${JSON.stringify(
          pages.map((page) => {
            if ("error" in page) {
              return { url: page.url, ...page.error.toJSON() };
            }
            return {
              url: page.url,
              ...jsonPage(page.result, request, maxCharacters),
              ...(page.screenshotFile && {
                screenshotFile: page.screenshotFile,
              }),
            };
          }),
          null,
          2
        )}\n`
      : formatPages(pages, {
          ...request,
          baseUrl: connection.baseUrl,
          maxCharacters,
        })
  );
  const failed = pages.find((page) => "error" in page);
  if (failed && "error" in failed) {
    // The output above has every page. The exit code tells that one failed.
    const count = pages.filter((page) => "error" in page).length;
    throw new CliError(
      count === pages.length
        ? `All ${count} pages failed. The output has the error of each page.`
        : `${count} of ${pages.length} pages failed. The output has the other pages.`,
      failed.error.exitCode,
      undefined,
      SOME_PAGES_FAILED
    );
  }
};

const search = async (args: string[], io: Io) => {
  const { values, positionals } = parse(args, SEARCH_FLAGS, "search");
  if (values.help) {
    io.stdout(SEARCH_HELP);
    return;
  }
  // Agents sometimes forget quotes. Join the words into one query.
  const query = positionals.join(" ").trim();
  if (!query) {
    throw usageError("Give a search query.", "search");
  }
  const connection = await connect(io);
  const result = await callToolCached(
    {
      ...connection,
      name: "search",
      args: { query, serp: values.serp || undefined },
    },
    io.env,
    !values["no-cache"]
  );
  // After the request on purpose. See extract.
  // oxlint-disable-next-line react-doctor/server-sequential-independent-await
  const { formatSearch } = await import("./format.ts");
  io.stdout(
    values.json
      ? `${JSON.stringify(result.structuredContent ?? {}, null, 2)}\n`
      : formatSearch(result, query, values.serp === true)
  );
};

const login = async (args: string[], io: Io) => {
  const { values, positionals } = parse(args, LOGIN_FLAGS, "login");
  if (values.help) {
    io.stdout(LOGIN_HELP);
    return;
  }
  if (positionals.length > 0) {
    throw usageError("login does not accept arguments.", "login");
  }
  const baseUrl = baseUrlOf(io.env);
  let key: string;
  if (values["with-key"]) {
    const input = await io.readStdin();
    key = input.trim();
  } else {
    // node:http takes about 9 ms to load. Only login needs it.
    const { loginWithBrowser } = await import("./login.ts");
    key = await loginWithBrowser({
      baseUrl,
      browser: !values["no-browser"],
      log: (line) => io.stderr(`${line}\n`),
    });
  }
  const file = await saveApiKey(baseUrl, key, io.env);
  io.stderr(`Signed in to ${baseUrl}. The key is saved in ${file}.\n`);
  if (io.env.EXTRAKTOR_API_KEY) {
    io.stderr(
      "Note: EXTRAKTOR_API_KEY is set. The CLI uses it and not the saved key.\n"
    );
  }
};

const logout = async (args: string[], io: Io) => {
  const { values, positionals } = parse(args, HELP_ONLY, "logout");
  if (values.help) {
    io.stdout(LOGOUT_HELP);
    return;
  }
  if (positionals.length > 0) {
    throw usageError("logout does not accept arguments.", "logout");
  }
  const baseUrl = baseUrlOf(io.env);
  const deleted = await deleteSavedApiKey(baseUrl, io.env);
  io.stderr(
    deleted
      ? `Deleted the saved key for ${baseUrl}. The key continues to work until you delete it on ${baseUrl}/developers.\n`
      : `No key is saved for ${baseUrl}.\n`
  );
};

const MCP_ACTIONS = new Set(["add", "remove"]);

const isMcpAction = (value: string): value is "add" | "remove" =>
  MCP_ACTIONS.has(value);

const mcp = async (args: string[], io: Io) => {
  const [action = "", ...rest] = args;
  if (
    action === "" ||
    action === "help" ||
    action === "--help" ||
    action === "-h"
  ) {
    io.stdout(MCP_HELP);
    return;
  }
  if (!isMcpAction(action)) {
    throw usageError(
      `"${action}" is not an mcp command. Use "extraktor mcp add" or "extraktor mcp remove".`,
      "mcp"
    );
  }
  const { values, positionals } = parse(rest, MCP_FLAGS, `mcp ${action}`);
  if (values.help) {
    io.stdout(MCP_HELP);
    return;
  }
  if (positionals.length > 0) {
    throw usageError(`mcp ${action} does not accept arguments.`, "mcp");
  }
  const { AGENT_IDS, changeAgents, defaultExec, formatResults, isAgentId } =
    await import("./install.ts");
  const ids = new Set<AgentId>();
  for (const name of values.agent ?? AGENT_IDS) {
    if (!isAgentId(name)) {
      const match = closest(name, [...AGENT_IDS]);
      throw usageError(
        `"${name}" is not an agent.${match ? ` Did you mean "--agent ${match}"?` : ""} Agents: ${AGENT_IDS.join(", ")}.`,
        "mcp"
      );
    }
    ids.add(name);
  }
  const url = `${baseUrlOf(io.env)}/mcp`;
  const results = await changeAgents(action, ids, {
    env: io.env,
    exec: io.exec ?? defaultExec,
    platform: io.platform ?? process.platform,
    url,
  });
  const found = results.filter(({ status }) => status !== "not-found");
  if (found.length === 0 && action === "add") {
    throw new CliError(
      "No coding agent was found on this computer.",
      EXIT.failure,
      `Install Claude Code, Codex, Cursor, VS Code, Gemini CLI or Windsurf, then run this command again. Or add ${url} to your MCP client by hand.`,
      "NO_AGENT_FOUND"
    );
  }
  io.stdout(
    values.json
      ? `${JSON.stringify({ action, url, agents: results }, null, 2)}\n`
      : formatResults(action, results, url)
  );
  const failed = results.filter(({ status }) => status === "failed").length;
  if (failed > 0) {
    throw new CliError(
      `${failed} of ${found.length} agents failed. The output tells why.`,
      EXIT.failure,
      undefined,
      SOME_AGENTS_FAILED
    );
  }
};

const COMMANDS = { extract, search, login, logout, mcp } satisfies Record<
  string,
  (args: string[], io: Io) => Promise<void>
>;

/** Names that agents guess for mcp add. They run it, with no error. */
const MCP_ADD_ALIASES = new Set(["install", "setup"]);

/** Names that agents guess for extract. They run extract, with no error. */
const EXTRACT_ALIASES = new Set(["read", "fetch", "get", "scrape", "open"]);

const isCommand = (name: string): name is keyof typeof COMMANDS =>
  Object.hasOwn(COMMANDS, name);

const unknownCommand = (name: string) => {
  const match = closest(name, Object.keys(COMMANDS));
  return new CliError(
    `"${name}" is not a command.${match ? ` Did you mean "extraktor ${match}"?` : ""}`,
    EXIT.usage,
    'Commands: extract <url>..., search "<query>", login, logout, mcp add, mcp remove. To read a page, run: extraktor extract <url>'
  );
};

const reportError = (error: CliError, json: boolean, io: Io) => {
  if (json) {
    // The JSON array already has an error entry for each failed page.
    if (error.code === SOME_PAGES_FAILED || error.code === SOME_AGENTS_FAILED) {
      return;
    }
    io.stdout(`${JSON.stringify(error.toJSON(), null, 2)}\n`);
    return;
  }
  io.stderr(`Error: ${error.message}\n`);
  if (error.guidance) {
    io.stderr(`${error.guidance}\n`);
  }
};

/** Runs the CLI and returns the exit code. */
export const run = async (argv: string[], io: Io): Promise<number> => {
  const [command, ...args] = argv;
  if (!command) {
    io.stdout(MAIN_HELP);
    return EXIT.usage;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    io.stdout(MAIN_HELP);
    return EXIT.ok;
  }
  if (command === "--version" || command === "-v") {
    io.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  try {
    if (isCommand(command)) {
      await COMMANDS[command](args, io);
    } else if (MCP_ADD_ALIASES.has(command)) {
      await mcp(["add", ...args], io);
    } else if (EXTRACT_ALIASES.has(command)) {
      await extract(args, io);
    } else if (LOOKS_LIKE_URL.test(command)) {
      // Agents often run "extraktor <url>". Read the page, as extract does.
      await extract(argv, io);
    } else {
      throw unknownCommand(command);
    }
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    reportError(error, argv.includes("--json"), io);
    return error.exitCode;
  }
};
