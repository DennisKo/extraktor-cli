/**
 * A short-lived local cache of tool results. Agents read long output in
 * slices: they run the same command again with head, sed or grep. Without the
 * cache, each slice is a new extraction that costs a credit and a page load.
 */
import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { callTool } from "./mcp.ts";
import type { CallToolOptions, ToolResult } from "./mcp.ts";

export const CACHE_TTL_MS = 10 * 60_000;

export const cacheDir = (env: NodeJS.ProcessEnv) =>
  path.join(
    env.XDG_CACHE_HOME ||
      (process.platform === "win32" && env.LOCALAPPDATA) ||
      path.join(homedir(), ".cache"),
    "extraktor",
    "results"
  );

const cacheFile = (dir: string, { baseUrl, name, args }: CallToolOptions) =>
  path.join(
    dir,
    `${createHash("sha256")
      .update(JSON.stringify([baseUrl, name, args]))
      .digest("hex")}.json`
  );

const isFresh = async (file: string, now: number) => {
  try {
    const { mtimeMs } = await stat(file);
    return now - mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
};

const readCached = async (file: string): Promise<ToolResult | null> => {
  if (!(await isFresh(file, Date.now()))) {
    return null;
  }
  try {
    const { toolResultSchema } = await import("./schemas.ts");
    return toolResultSchema.parse(JSON.parse(await readFile(file, "utf-8")));
  } catch {
    return null;
  }
};

/** Deletes results older than the cache time, so the directory stays small. */
const pruneExpired = async (dir: string, now: number) => {
  const files = await readdir(dir);
  await Promise.all(
    files.map(async (name) => {
      const file = path.join(dir, name);
      if (!(await isFresh(file, now))) {
        await rm(file, { force: true });
      }
    })
  );
};

const writeCached = async (dir: string, file: string, result: ToolResult) => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
  await rename(temporary, file);
  await pruneExpired(dir, Date.now());
};

const OUTPUT_KEYS = new Set([
  "excerpts",
  "summary",
  "screenshot",
  "contacts",
  "messaging",
  "seo",
  "design",
  "agentAccess",
]);

/**
 * The page text part of an extract result with outputs: the result of the
 * same page without outputs. A later read, --find or --offset of the page
 * then uses it and makes no new request.
 */
const plainPage = (
  options: CallToolOptions,
  result: ToolResult
): [CallToolOptions, ToolResult] | null => {
  if (
    options.name !== "extract" ||
    !Object.entries(options.args).some(
      ([key, value]) => value !== undefined && OUTPUT_KEYS.has(key)
    )
  ) {
    return null;
  }
  const page = Object.fromEntries(
    Object.entries(result.structuredContent ?? {}).filter(
      ([key]) => !OUTPUT_KEYS.has(key)
    )
  );
  return [
    { ...options, args: { url: options.args.url } },
    {
      ...result,
      // Keep the page warnings. Drop the image of a screenshot.
      content: [
        { type: "text", text: JSON.stringify(page) },
        ...result.content.slice(1).filter((item) => item.type === "text"),
      ],
      structuredContent: page,
    },
  ];
};

/**
 * Calls the tool, or returns the saved result of the same call from the last
 * 10 minutes. Only successful results are saved.
 */
export const callToolCached = async (
  options: CallToolOptions,
  env: NodeJS.ProcessEnv,
  useCache: boolean
): Promise<ToolResult> => {
  const dir = cacheDir(env);
  const file = cacheFile(dir, options);
  const cached = useCache ? await readCached(file) : null;
  if (cached) {
    return cached;
  }
  const result = await callTool(options);
  try {
    await writeCached(dir, file, result);
    const plain = plainPage(options, result);
    if (plain) {
      await writeCached(dir, cacheFile(dir, plain[0]), plain[1]);
    }
  } catch {
    // The cache only saves time. A full disk must not fail the command.
  }
  return result;
};
