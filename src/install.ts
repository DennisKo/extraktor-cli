/**
 * `extraktor mcp add` and `extraktor mcp remove`: add the Extraktor MCP server
 * to each coding agent on this computer, or remove it. Claude Code changes its
 * own config with its CLI, because running sessions also write that file. For
 * the other agents, the CLI changes the config file directly. All agents run
 * at the same time. A second run changes nothing.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { parseJson } from "./schemas.ts";

export const SERVER_NAME = "extraktor";

export type AgentId =
  | "claude-code"
  | "codex"
  | "cursor"
  | "vscode"
  | "gemini-cli"
  | "windsurf";

export type Status = "added" | "removed" | "unchanged" | "not-found" | "failed";

export interface AgentResult {
  id: AgentId;
  name: string;
  status: Status;
  /** Why the change failed. */
  detail?: string;
  /** What to do next in the agent, after an add. */
  next?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program. Throws an error with code ENOENT when it is not installed. */
export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

export interface InstallContext {
  env: NodeJS.ProcessEnv;
  exec: Exec;
  platform: NodeJS.Platform;
  url: string;
}

type Outcome = Pick<AgentResult, "status" | "detail">;

interface Agent {
  id: AgentId;
  name: string;
  next: string;
  add: (context: InstallContext) => Promise<Outcome>;
  remove: (context: InstallContext) => Promise<Outcome>;
}

const EXEC_TIMEOUT_MS = 20_000;
const ALREADY_EXISTS = /already exists/iu;
const NOT_PRESENT = /no mcp server named/iu;
const TOML_HEADER = /^\s*\[/u;
const TOML_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*"?extraktor"?\s*[\].]/u;
const TOML_EXISTING = [
  /^\s*\[\s*mcp_servers\s*\.\s*"?extraktor"?\s*[\].]/mu,
  /^\s*mcp_servers\s*\.\s*"?extraktor"?\s*[.=]/mu,
];
const TOML_SERVERS_TABLE = /^\s*\[\s*mcp_servers\s*\]/mu;
const TOML_EXTRAKTOR_KEY = /^\s*"?extraktor"?\s*[.=]/mu;

const execFileAsync = promisify(execFile);
/** A program that ran and exited with an error code. */
const exitFailureSchema = z.object({
  code: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});
/** The program or the file does not exist. */
const notFoundSchema = z.object({ code: z.literal("ENOENT") });
const jsonObjectSchema = z.record(z.string(), z.json());
type JsonObject = z.infer<typeof jsonObjectSchema>;

export const defaultExec: Exec = async (file, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = exitFailureSchema.safeParse(error);
    if (failure.success) {
      return failure.data;
    }
    throw error;
  }
};

const homeOf = (env: NodeJS.ProcessEnv) => env.HOME || homedir();

const exists = async (file: string) => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

const isNotFound = (error: Error) => notFoundSchema.safeParse(error).success;

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

/** Writes a file through a temporary file, so a crash never leaves half a file. */
const writeAtomic = async (file: string, text: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
};

const readText = async (file: string) => {
  try {
    return await readFile(file, "utf-8");
  } catch (error) {
    if (error instanceof Error && isNotFound(error)) {
      return "";
    }
    throw error;
  }
};

const claudeCode: Agent = {
  id: "claude-code",
  name: "Claude Code",
  next: "Run /mcp in Claude Code, select extraktor, and sign in.",
  add: async ({ exec, url }) => {
    const result = await exec("claude", [
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      SERVER_NAME,
      url,
    ]);
    if (result.code === 0) {
      return { status: "added" };
    }
    if (ALREADY_EXISTS.test(result.stderr + result.stdout)) {
      return { status: "unchanged" };
    }
    return {
      status: "failed",
      detail: firstLine(result.stderr || result.stdout),
    };
  },
  remove: async ({ exec }) => {
    const result = await exec("claude", [
      "mcp",
      "remove",
      "--scope",
      "user",
      SERVER_NAME,
    ]);
    if (result.code === 0) {
      return { status: "removed" };
    }
    if (NOT_PRESENT.test(result.stderr + result.stdout)) {
      return { status: "unchanged" };
    }
    return {
      status: "failed",
      detail: firstLine(result.stderr || result.stdout),
    };
  },
};

/** The line breaks that put one empty line between the text and a new table. */
const blankLineAfter = (text: string) => {
  if (text === "" || text.endsWith("\n\n")) {
    return "";
  }
  return text.endsWith("\n") ? "\n" : "\n\n";
};

const codexDir = (env: NodeJS.ProcessEnv) =>
  env.CODEX_HOME || path.join(homeOf(env), ".codex");

const hasCodexServer = (toml: string) =>
  TOML_EXISTING.some((pattern) => pattern.test(toml)) ||
  (TOML_SERVERS_TABLE.test(toml) && TOML_EXTRAKTOR_KEY.test(toml));

/** Removes [mcp_servers.extraktor] and its subtables from a TOML file. */
const removeCodexTables = (toml: string) => {
  const kept: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (TOML_HEADER.test(line)) {
      skipping = TOML_TABLE.test(line);
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return kept.join("\n").replaceAll(/\n{3,}/gu, "\n\n");
};

const codex: Agent = {
  id: "codex",
  name: "Codex",
  next: "Run: codex mcp login extraktor --scopes profile",
  add: async ({ env, url }) => {
    const dir = codexDir(env);
    if (!(await exists(dir))) {
      return { status: "not-found" };
    }
    const file = path.join(dir, "config.toml");
    const toml = await readText(file);
    if (hasCodexServer(toml)) {
      return { status: "unchanged" };
    }
    await writeAtomic(
      file,
      `${toml}${blankLineAfter(toml)}[mcp_servers.${SERVER_NAME}]\nurl = ${JSON.stringify(url)}\n`
    );
    return { status: "added" };
  },
  remove: async ({ env }) => {
    const dir = codexDir(env);
    if (!(await exists(dir))) {
      return { status: "not-found" };
    }
    const file = path.join(dir, "config.toml");
    const toml = await readText(file);
    const next = removeCodexTables(toml);
    if (next === toml) {
      return hasCodexServer(toml)
        ? {
            status: "failed",
            detail: `Remove "extraktor" from ${file} by hand.`,
          }
        : { status: "unchanged" };
    }
    await writeAtomic(file, next);
    return { status: "removed" };
  },
};

const notJson = (target: string) =>
  `${target} is not plain JSON (it can have comments). Add the server by hand.`;

/** An agent that keeps its MCP servers in a JSON object in one file. */
const jsonAgent = ({
  dir,
  entry,
  file,
  key,
  ...agent
}: Pick<Agent, "id" | "name" | "next"> & {
  /** The agent's config directory. It exists when the agent is installed. */
  dir: (context: InstallContext) => string;
  file: string;
  /** The object that holds the servers, for example "mcpServers". */
  key: string;
  entry: (url: string) => Record<string, string>;
}): Agent => {
  const load = async (context: InstallContext) => {
    const directory = dir(context);
    if (!(await exists(directory))) {
      return;
    }
    const target = path.join(directory, file);
    const text = await readText(target);
    const parsed = jsonObjectSchema.safeParse(
      text.trim() === "" ? {} : parseJson(text)
    );
    return { target, data: parsed.data };
  };
  const servers = (data: JsonObject) =>
    jsonObjectSchema.safeParse(data[key]).data;

  return {
    ...agent,
    add: async (context) => {
      const loaded = await load(context);
      if (!loaded) {
        return { status: "not-found" };
      }
      const { data, target } = loaded;
      if (!data) {
        return { status: "failed", detail: notJson(target) };
      }
      if (servers(data)?.[SERVER_NAME]) {
        return { status: "unchanged" };
      }
      data[key] = { ...servers(data), [SERVER_NAME]: entry(context.url) };
      await writeAtomic(target, `${JSON.stringify(data, null, 2)}\n`);
      return { status: "added" };
    },
    remove: async (context) => {
      const loaded = await load(context);
      if (!loaded) {
        return { status: "not-found" };
      }
      const { data, target } = loaded;
      if (!data) {
        return { status: "failed", detail: notJson(target) };
      }
      const current = servers(data);
      if (!current?.[SERVER_NAME]) {
        return { status: "unchanged" };
      }
      const { [SERVER_NAME]: _removed, ...rest } = current;
      data[key] = rest;
      await writeAtomic(target, `${JSON.stringify(data, null, 2)}\n`);
      return { status: "removed" };
    },
  };
};

/** The user settings directory of VS Code on each platform. */
const vscodeUserDir = ({ env, platform }: InstallContext) => {
  const home = homeOf(env);
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User");
  }
  if (platform === "win32") {
    return path.join(
      env.APPDATA || path.join(home, "AppData", "Roaming"),
      "Code",
      "User"
    );
  }
  return path.join(
    env.XDG_CONFIG_HOME || path.join(home, ".config"),
    "Code",
    "User"
  );
};

export const AGENTS: readonly Agent[] = [
  claudeCode,
  codex,
  jsonAgent({
    id: "cursor",
    name: "Cursor",
    next: "Open Cursor's MCP settings and sign in to extraktor.",
    dir: ({ env }) => path.join(homeOf(env), ".cursor"),
    file: "mcp.json",
    key: "mcpServers",
    entry: (url) => ({ url }),
  }),
  jsonAgent({
    id: "vscode",
    name: "VS Code",
    next: "Run MCP: List Servers, start extraktor, and sign in.",
    dir: vscodeUserDir,
    file: "mcp.json",
    key: "servers",
    entry: (url) => ({ type: "http", url }),
  }),
  jsonAgent({
    id: "gemini-cli",
    name: "Gemini CLI",
    next: "Run /mcp auth extraktor in Gemini CLI.",
    dir: ({ env }) => path.join(homeOf(env), ".gemini"),
    file: "settings.json",
    key: "mcpServers",
    entry: (url) => ({ httpUrl: url }),
  }),
  jsonAgent({
    id: "windsurf",
    name: "Windsurf",
    next: "Refresh the MCP servers in Windsurf and sign in to extraktor.",
    dir: ({ env }) => path.join(homeOf(env), ".codeium", "windsurf"),
    file: "mcp_config.json",
    key: "mcpServers",
    entry: (url) => ({ serverUrl: url }),
  }),
];

export const AGENT_IDS = AGENTS.map(({ id }) => id);
const AGENT_ID_SET: ReadonlySet<string> = new Set(AGENT_IDS);

export const isAgentId = (name: string): name is AgentId =>
  AGENT_ID_SET.has(name);

/** Adds or removes the server in each agent, all at the same time. */
export const changeAgents = (
  action: "add" | "remove",
  ids: ReadonlySet<AgentId>,
  context: InstallContext
): Promise<AgentResult[]> =>
  Promise.all(
    AGENTS.filter(({ id }) => ids.has(id)).map(
      async (agent): Promise<AgentResult> => {
        const base = { id: agent.id, name: agent.name };
        try {
          const outcome = await agent[action](context);
          return outcome.status === "added"
            ? { ...base, ...outcome, next: agent.next }
            : { ...base, ...outcome };
        } catch (error) {
          if (error instanceof Error && isNotFound(error)) {
            return { ...base, status: "not-found" };
          }
          return {
            ...base,
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }
    )
  );

const LABELS: Record<"add" | "remove", Partial<Record<Status, string>>> = {
  add: { added: "Added to:", unchanged: "Already added (no change):" },
  remove: { removed: "Removed from:", unchanged: "Not present (no change):" },
};

/** The result as text: one group for each outcome, then the next steps. */
export const formatResults = (
  action: "add" | "remove",
  results: readonly AgentResult[],
  url: string
) => {
  const lines = [`Extraktor MCP server: ${url}`, ""];
  for (const status of ["added", "removed", "unchanged"] as const) {
    const group = results.filter((result) => result.status === status);
    const label = LABELS[action][status];
    if (group.length > 0 && label) {
      lines.push(label);
      for (const { name, next } of group) {
        lines.push(next ? `  - ${name}. Next: ${next}` : `  - ${name}`);
      }
    }
  }
  const failed = results.filter(({ status }) => status === "failed");
  if (failed.length > 0) {
    lines.push("Failed:");
    for (const { name, detail } of failed) {
      lines.push(`  - ${name}: ${detail ?? "unknown error"}`);
    }
  }
  const missing = results.filter(({ status }) => status === "not-found");
  if (missing.length > 0) {
    lines.push(
      `Not found on this computer: ${missing.map(({ name }) => name).join(", ")}.`
    );
  }
  if (action === "add") {
    lines.push(
      "",
      `Claude app (desktop and web): open Settings > Connectors > Add custom connector and paste ${url}.`
    );
  }
  return `${lines.join("\n")}\n`;
};
