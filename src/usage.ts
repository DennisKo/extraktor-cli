/**
 * Usage errors that tell the agent the fix, so it does not need a help call:
 * the likely option or command, and the options that the command accepts.
 */
import type { ParseArgsConfig } from "node:util";

import { CliError, EXIT } from "./errors.ts";

type Flags = NonNullable<ParseArgsConfig["options"]>;

const UNKNOWN_OPTION = /^Unknown option '(?<option>[^']+)'/u;
const MISSING_VALUE = /^Option '(?<option>-[^' ]+)[^']*' argument missing/u;
/** A typo in a long name can have 2 wrong letters, in a short name only 1. */
const LONG_NAME_LENGTH = 8;
const MIN_PREFIX_LENGTH = 3;

/** Names that agents guess, mapped to the option that does the job. */
const SYNONYMS = new Map<string, string>(
  Object.entries({
    filter: "find",
    grep: "find",
    search: "find",
    query: "find",
    match: "find",
    section: "find",
    format: "json",
    output: "save",
    out: "save",
    o: "save",
    file: "save",
    path: "save",
    write: "save",
    download: "save",
    full: "save",
    all: "save",
    page: "offset",
    start: "offset",
    skip: "offset",
    question: "focus",
    topic: "focus",
    prompt: "fields",
    schema: "fields",
    "json-schema": "fields",
    structured: "fields",
    data: "fields",
    map: "links",
    urls: "links",
    subpages: "links",
    pages: "links",
    crawl: "links",
    sitemaps: "sitemap",
    quote: "excerpts",
    quotes: "excerpts",
    summarize: "summary",
    email: "contacts",
    emails: "contacts",
    phone: "contacts",
    phones: "contacts",
    address: "contacts",
    addresses: "contacts",
    social: "contacts",
    socials: "contacts",
    profiles: "contacts",
    imprint: "contacts",
    impressum: "contacts",
    company: "contacts",
    positioning: "messaging",
    marketing: "messaging",
    "value-proposition": "messaging",
    fresh: "no-cache",
    refresh: "no-cache",
    force: "no-cache",
    png: "screenshot",
    image: "screenshot",
    "full-page": "screenshot",
    questions: "serp",
    paa: "serp",
    related: "serp",
    features: "serp",
    "serp-features": "serp",
  })
);

const distance = (a: string, b: string) => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (const [i, charA] of [...a].entries()) {
    const current = [i + 1];
    for (const [j, charB] of [...b].entries()) {
      current.push(
        Math.min(
          (previous[j + 1] ?? 0) + 1,
          (current[j] ?? 0) + 1,
          (previous[j] ?? 0) + (charA === charB ? 0 : 1)
        )
      );
    }
    previous = current;
  }
  return previous[b.length] ?? Number.POSITIVE_INFINITY;
};

/** The closest name: a known synonym, a prefix, or a small typo. */
export const closest = (name: string, names: string[]): string | null => {
  const synonym = SYNONYMS.get(name.toLowerCase());
  if (synonym && names.includes(synonym)) {
    return synonym;
  }
  if (name.length >= MIN_PREFIX_LENGTH) {
    const prefixed = names.filter((candidate) => candidate.startsWith(name));
    if (prefixed.length === 1) {
      return prefixed[0] ?? null;
    }
  }
  let best: string | null = null;
  let bestDistance = name.length >= LONG_NAME_LENGTH ? 3 : 2;
  for (const candidate of names) {
    const value = distance(name.toLowerCase(), candidate);
    if (value < bestDistance) {
      best = candidate;
      bestDistance = value;
    }
  }
  return best;
};

const VALUE_NAMES = new Map<string, string>([
  ["offset", "n"],
  ["screenshot-file", "path"],
  ["design-file", "path"],
  ["save", "file"],
]);

/** Every option of a command in one line, for example "--find <text>, --json". */
export const optionList = (flags: Flags) => {
  const options: string[] = [];
  for (const [name, { type }] of Object.entries(flags)) {
    if (name !== "help") {
      options.push(
        type === "string"
          ? `--${name} <${VALUE_NAMES.get(name) ?? "text"}>`
          : `--${name}`
      );
    }
  }
  return options.join(", ");
};

export const usageError = (message: string, command?: string) =>
  new CliError(
    message,
    EXIT.usage,
    `Run "extraktor ${command ? `${command} ` : ""}--help" to see the correct usage.`
  );

/**
 * Turns a parseArgs error into a usage error that names the fix and lists
 * the options of the command.
 */
export const optionError = (
  message: string,
  flags: Flags,
  command: string
): CliError => {
  const options = `Options for ${command}: ${optionList(flags)}.`;
  const unknown = UNKNOWN_OPTION.exec(message)?.groups?.option;
  if (unknown) {
    const name = unknown.replace(/^-+/u, "").split("=")[0] ?? "";
    const match = closest(name, Object.keys(flags));
    return new CliError(
      `Unknown option ${unknown}.${match ? ` Did you mean --${match}?` : ""}`,
      EXIT.usage,
      options
    );
  }
  const missing = MISSING_VALUE.exec(message)?.groups?.option;
  if (missing) {
    return new CliError(
      `${missing} needs a value, for example ${missing} "text".`,
      EXIT.usage,
      options
    );
  }
  return new CliError(message.split("\n")[0] ?? message, EXIT.usage, options);
};
