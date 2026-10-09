/**
 * Turns tool results into Markdown for the terminal. Requested outputs come
 * first, then the page text, so that the answer to the request is near the top.
 */
import type { z } from "zod";

import { CliError, EXIT } from "./errors.ts";
import { findPageText, fitPageText, pageOutline } from "./page-text.ts";
import type {
  FindResult,
  FoundPageText,
  OutlineEntry,
  PageTextResult,
} from "./page-text.ts";
import {
  extractSchema,
  pageTextSchema,
  parseFailure,
  searchSchema,
  serpText,
} from "./schemas.ts";
import type {
  ExtractPage,
  contactsOutput,
  excerptsOutput,
  markdownOutput,
  messagingOutput,
  reportOutput,
  screenshotOutput,
  JsonValue,
  SerpBlock,
  SerpEntry,
  ToolFailure,
  ToolResult,
} from "./schemas.ts";

const SAFE_SHELL_WORD = /^[\w./:@%+=,-]+$/u;

/** Quotes a value for a POSIX shell command when it needs quotes. */
const quoteArg = (value: string) =>
  SAFE_SHELL_WORD.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

const parseResult = <Schema extends z.ZodType>(
  schema: Schema,
  result: ToolResult
): z.infer<Schema> => {
  const parsed = schema.safeParse(result.structuredContent);
  if (!parsed.success) {
    throw new CliError(
      "The server result has an unexpected form.",
      EXIT.failure,
      "Update the CLI: npm install --global @extraktor/cli@latest. Or use --json."
    );
  }
  return parsed.data;
};

/** Warnings that the server adds after the result, for example a capture limit. */
export const resultWarnings = (result: ToolResult) => {
  const warnings: ToolFailure[] = [];
  for (const item of result.content.slice(1)) {
    const failure = item.type === "text" ? parseFailure(item.text) : null;
    // A failed output shows its own message in its section.
    if (failure && failure.code !== "OPTIONAL_FEATURE_FAILED") {
      warnings.push(failure);
    }
  }
  return warnings;
};

const failedOutput = ({ message }: { message?: string }) =>
  `Not available: ${message || "the output did not complete."}`;

const renderMarkdown = (output: z.infer<typeof markdownOutput>) =>
  output.status === "success" ? output.markdown.trim() : failedOutput(output);

const renderExcerpts = (output: z.infer<typeof excerptsOutput>) => {
  if (output.status !== "success") {
    return failedOutput(output);
  }
  const links: string[] = [];
  for (const [index, link] of output.passageLinks.entries()) {
    if (link) {
      links.push(`${index + 1}. ${link}`);
    }
  }
  return links.length > 0
    ? `${output.markdown.trim()}\n\nPassage links:\n${links.join("\n")}`
    : output.markdown.trim();
};

const labelled = (value: string, label: string | null) =>
  label ? `${value} (${label})` : value;

const NETWORK_NAMES = new Map([
  ["bluesky", "Bluesky"],
  ["facebook", "Facebook"],
  ["github", "GitHub"],
  ["instagram", "Instagram"],
  ["linkedin", "LinkedIn"],
  ["mastodon", "Mastodon"],
  ["tiktok", "TikTok"],
  ["x", "X"],
  ["xing", "XING"],
  ["youtube", "YouTube"],
]);

const ORGANIZATION_FIELDS = [
  ["name", "Name"],
  ["legalName", "Legal name"],
  ["registrationId", "Registration"],
  ["vatId", "VAT ID"],
] as const;

/** The message, the contact pages and the command for the first one. */
const contactPageLines = (output: {
  contactPages?: string[];
  message?: string;
}) => {
  const pages = output.contactPages ?? [];
  return [
    output.message ?? "",
    ...pages.map((page) => `- ${page}`),
    pages[0] ? `Next: extraktor extract ${quoteArg(pages[0])} --contacts` : "",
  ].filter(Boolean);
};

const listSection = (title: string, items: readonly string[]) =>
  items.length > 0 ? `${title}:\n${items.join("\n")}` : `${title}: none`;

const renderContacts = (output: z.infer<typeof contactsOutput>) => {
  if (output.status !== "success") {
    const lines = contactPageLines(output);
    return output.status === "empty" && lines.length > 0
      ? lines.join("\n")
      : failedOutput(output);
  }
  const emails = output.emails.map(
    ({ address, label }) => `- ${labelled(address, label)}`
  );
  const phones = output.phones.map(({ number, text, label }) => {
    const value = number && number !== text ? `${text} [${number}]` : text;
    return `- ${labelled(value, label)}`;
  });
  const addresses = output.addresses.map(({ country, label, text }) => {
    const value =
      country && !text.endsWith(country) ? `${text} [${country}]` : text;
    return `- ${labelled(value, label)}`;
  });
  const profiles = output.profiles.map(
    ({ network, url }) => `- ${NETWORK_NAMES.get(network) ?? network}: ${url}`
  );
  const { organization } = output;
  const company = organization
    ? ORGANIZATION_FIELDS.flatMap(([field, title]) =>
        organization[field] ? [`- ${title}: ${organization[field]}`] : []
      )
    : [];
  return [
    listSection("Emails", emails),
    listSection("Phones", phones),
    listSection("Addresses", addresses),
    listSection("Profiles", profiles),
    listSection("Organization", company),
    ...(output.contactPages ? [contactPageLines(output).join("\n")] : []),
  ].join("\n\n");
};

const NOT_ON_PAGE = "not on the page";

const renderCta = (cta: { text: string; url: string | null } | null) => {
  if (!cta) {
    return NOT_ON_PAGE;
  }
  return cta.url ? `${cta.text} (${cta.url})` : cta.text;
};

const bulletList = (title: string, items: string[]) =>
  items.length > 0
    ? `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`
    : `${title}: ${NOT_ON_PAGE}`;

/**
 * What the offer is and who it is for first, then the site's own words. Every
 * page prints the same lines, so pages compare line by line.
 */
const renderMessaging = (output: z.infer<typeof messagingOutput>) => {
  if (output.status !== "success") {
    return failedOutput(output);
  }
  const { positioning, proof } = output;
  const proofLines = (
    [
      ["Metrics", proof.metrics],
      ["Customers", proof.customers],
      ["Awards", proof.awards],
      ["Certifications", proof.certifications],
      ["Review badges", proof.reviewBadges],
    ] as const
  ).map(
    ([label, items]) =>
      `- ${label}: ${items.length > 0 ? items.join("; ") : NOT_ON_PAGE}`
  );
  const testimonials = proof.testimonials.map(
    ({ company, person, quote, role }) => {
      const source = [person, role, company].filter(Boolean).join(", ");
      return `> ${quote}${source ? `\n> (${source})` : ""}`;
    }
  );
  return [
    [
      "Positioning (Extraktor's words, not site text):",
      `- Category: ${positioning.category || "none"}`,
      `- Audience: ${positioning.audience || "none"}`,
      `- Value proposition: ${positioning.valueProposition || "none"}`,
      `- Pain points: ${positioning.painPoints.join("; ") || "none"}`,
      `- Tone: ${positioning.tone.join(", ") || "none"}`,
    ].join("\n"),
    "Site text, as the page writes it:",
    `Headline: ${output.headline ?? NOT_ON_PAGE}`,
    `Subheadline: ${output.subheadline ?? NOT_ON_PAGE}`,
    `Primary CTA: ${renderCta(output.primaryCta)}`,
    `Secondary CTA: ${renderCta(output.secondaryCta)}`,
    bulletList("Benefits", output.benefits),
    bulletList("Differentiators", output.differentiators),
    `Proof:\n${proofLines.join("\n")}`,
    testimonials.length > 0
      ? `Testimonials:\n${testimonials.join("\n\n")}`
      : `Testimonials: ${NOT_ON_PAGE}`,
  ].join("\n\n");
};

const HEADING_MARKS = /^(?<marks>#{1,5}) /gmu;
const REPORT_TITLE = /^# .*\n+(?:Page: .*\n+)?/u;

/**
 * A report as the server writes it in Markdown, one heading level lower, so
 * that it fits under its section. The section heading and the header give
 * its title and the page URL.
 */
const renderReport = (output: z.infer<typeof reportOutput>) => {
  if (output.status === "error") {
    return failedOutput(output);
  }
  if (output.markdown) {
    return output.markdown
      .replace(REPORT_TITLE, "")
      .replaceAll(HEADING_MARKS, "#$<marks> ")
      .trim();
  }
  return `\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``;
};

const outputSections = (page: ExtractPage) =>
  [
    ["Summary (AI)", page.summary && renderMarkdown(page.summary)],
    ["Excerpts", page.excerpts && renderExcerpts(page.excerpts)],
    ["Contacts", page.contacts && renderContacts(page.contacts)],
    ["Messaging", page.messaging && renderMessaging(page.messaging)],
    ["SEO", page.seo && renderReport(page.seo)],
    ["Agent access", page.agentAccess && renderReport(page.agentAccess)],
  ] as const;

/** What page text to print: one part, the matches of each --find, or none. */
export interface TextRequest {
  finds: string[];
  offset?: number;
  /** The CLI saved the complete page text in this file. */
  savedFile?: string;
}

export interface ExtractFormatOptions extends TextRequest {
  url: string;
  baseUrl: string;
  /** Where the CLI saved the screenshot PNG, if it did. */
  screenshotFile?: string;
  /** Where the CLI saved DESIGN.md, if it did. */
  designFile?: string;
  /** The characters that the page can use in the output. */
  maxCharacters: number;
}

type PartText = PageTextResult;
type FoundText = FoundPageText;

/**
 * The page text of a request. The server sends the complete page text, and
 * the CLI cuts each part and finds each text in it. So the offsets agree, and
 * a different part or find needs no new request.
 */
type TextView =
  | { kind: "part"; part: PartText }
  | { kind: "found"; results: FoundText[] }
  | { kind: "saved"; file: string; outline: OutlineEntry[] };

const viewText = (
  markdown: string,
  { finds, offset, savedFile }: TextRequest,
  maxCharacters: number
): TextView => {
  if (savedFile) {
    return { kind: "saved", file: savedFile, outline: pageOutline(markdown) };
  }
  if (finds.length > 0) {
    const each = Math.floor(maxCharacters / finds.length);
    return {
      kind: "found",
      results: finds.map((find) => findPageText({ markdown }, find, each)),
    };
  }
  return {
    kind: "part",
    part: fitPageText({ markdown }, offset, maxCharacters),
  };
};

/** The --json result: the server result with the page text of the request. */
export const jsonPage = (
  result: ToolResult,
  request: TextRequest,
  maxCharacters: number
) => {
  const parsed = pageTextSchema.safeParse(result.structuredContent);
  if (!parsed.success) {
    return result.structuredContent ?? {};
  }
  const { markdown, ...page } = parsed.data;
  const view = viewText(markdown, request, maxCharacters);
  if (view.kind === "saved") {
    return { ...page, savedFile: view.file, outline: view.outline };
  }
  if (view.kind === "part") {
    return { ...page, ...view.part };
  }
  const [first] = view.results;
  return view.results.length === 1 && first
    ? { ...page, ...first }
    : { ...page, finds: view.results };
};

// Room for the header and the warnings.
const HEADER_CHARACTERS = 800;
const MIN_TEXT_CHARACTERS = 2000;

const findLine = ({
  query,
  matchedBy,
  sections,
  omittedSections,
}: FindResult) => {
  if (!matchedBy) {
    return `Find "${query}": searched the complete page. The page text does not contain it.`;
  }
  const count = sections.length + omittedSections.length;
  return `Find "${query}": searched the complete page. ${count} ${count === 1 ? "section matches" : "sections match"}${matchedBy === "words" ? " all the words (not the exact phrase)" : ""}.`;
};

const viewLines = (view: TextView) => {
  if (view.kind === "found") {
    return view.results.map(({ found }) => findLine(found));
  }
  const range = view.kind === "part" ? view.part.markdownRange : undefined;
  if (!range) {
    return [];
  }
  // Say it at the top too: agents often read only the first lines.
  return [
    `Part of the page: characters ${range.start} to ${range.end} of ${range.totalCharacters}.${range.nextOffset === null ? "" : ` The next part starts at --offset ${range.nextOffset}.`} The outline with the offset of each heading is at the end.`,
  ];
};

const header = (
  { finalUrl, metadata, stats, status }: ExtractPage,
  view: TextView
) => {
  const facts = [
    status === null ? null : `HTTP ${status}`,
    `${stats.words.toLocaleString("en-US")} words`,
  ].filter(Boolean);
  const lines = [
    `# ${metadata.title || finalUrl}`,
    "",
    `Source: ${finalUrl} (${facts.join(", ")})`,
    ...viewLines(view),
  ];
  for (const [label, value] of [
    ["Description", metadata.description],
    ["Author", metadata.byline],
    ["Published", metadata.publishedTime],
    ["Modified", metadata.modifiedTime],
  ] as const) {
    if (value) {
      lines.push(`${label}: ${value}`);
    }
  }
  return lines.join("\n");
};

const outlineLine = ({ level, heading, offset }: OutlineEntry) =>
  `- ${level > 0 ? `${"#".repeat(level)} ` : ""}${heading} (offset ${offset})`;

const partNote = (
  { markdownRange: range, outline = [] }: PartText,
  url: string
) => {
  if (!range) {
    return null;
  }
  const lines = [
    `This is part of the page: characters ${range.start} to ${range.end} of ${range.totalCharacters}.`,
  ];
  if (range.nextOffset !== null) {
    lines.push(
      `For the next part, run: extraktor extract ${quoteArg(url)} --offset ${range.nextOffset}`,
      "Other parts and --find use the saved result: no new request and no credit. To summarize the complete page, use --summary. To save it to a file, use --save <file>."
    );
  }
  if (outline.length > 0) {
    lines.push(
      "",
      "Page outline. To read a section, use its offset with --offset:",
      ...outline.map((entry) => outlineLine(entry))
    );
  }
  return lines.join("\n");
};

const foundSections = ({ found, markdown }: FoundText) =>
  found.matchedBy && markdown.trim()
    ? `## Matches for "${found.query}"\n\n${markdown.trim()}`
    : null;

const foundNote = (results: FoundText[], url: string) => {
  const read = `extraktor extract ${quoteArg(url)} --offset <offset>`;
  const lines: string[] = [];
  for (const { found, outline = [] } of results) {
    if (lines.length > 0) {
      lines.push("");
    }
    if (!found.matchedBy) {
      lines.push(
        `No match for "${found.query}". Try a shorter or different text, or read a section: ${read}`
      );
      if (outline.length > 0) {
        lines.push(
          "",
          "Page outline:",
          ...outline.map((entry) => outlineLine(entry))
        );
      }
      continue;
    }
    lines.push(
      `Sections that match "${found.query}". Large sections show only the matched paragraphs, lines and table rows. To read all of a section, run: ${read}`,
      ...found.sections.map((entry) => outlineLine(entry))
    );
    if (found.omittedSections.length > 0) {
      lines.push(
        "More matched sections that did not fit. Read them with --offset:",
        ...found.omittedSections.map((entry) => outlineLine(entry))
      );
    }
  }
  return lines.join("\n");
};

/** The page text of the view, and the note after it. */
interface TextSections {
  text: string[];
  /** The offsets and the outline after the page text. */
  note: string | null;
}

const textSections = (
  page: ExtractPage,
  view: TextView,
  url: string
): TextSections => {
  if (view.kind === "saved") {
    return {
      text: [
        `## Page text\n\nSaved the complete page text (${page.markdown.length} characters) as Markdown to ${view.file}.`,
      ],
      note:
        view.outline.length > 0
          ? [
              "Page outline:",
              ...view.outline.map((entry) => outlineLine(entry)),
            ].join("\n")
          : null,
    };
  }
  if (view.kind === "found") {
    const text: string[] = [];
    for (const result of view.results) {
      const section = foundSections(result);
      if (section) {
        text.push(section);
      }
    }
    return { text, note: foundNote(view.results, url) };
  }
  return {
    text: [`## Page text\n\n${view.part.markdown.trim()}`],
    note: partNote(view.part, url),
  };
};

const screenshotSection = (
  screenshot: z.infer<typeof screenshotOutput>,
  { baseUrl, screenshotFile }: ExtractFormatOptions
) => {
  if (screenshot.status !== "success") {
    return failedOutput(screenshot);
  }
  return [
    screenshotFile
      ? `Saved to ${screenshotFile} (${screenshot.bytes} bytes).`
      : "The CLI did not save the image.",
    `Copy on the server (needs sign-in): ${new URL(screenshot.url, baseUrl).href}`,
  ].join("\n");
};

const MAX_FACT_CHARACTERS = 160;
const MAX_LIST_ITEMS = 5;
const MAX_NESTED_OBJECTS = 3;
const MAX_FACT_DEPTH = 2;
const MAX_FACTS_PER_ITEM = 30;
const SKIPPED_KEYS = new Set(["@context", "@id"]);
const WHITESPACE_RUN = /\s+/gu;

type Json = z.core.util.JSONType;

const scalarText = (value: Json) => {
  const text = String(value).replaceAll(WHITESPACE_RUN, " ").trim();
  return text.length > MAX_FACT_CHARACTERS
    ? `${text.slice(0, MAX_FACT_CHARACTERS)}…`
    : text;
};

const isScalar = (value: Json) => !(value instanceof Object);

/**
 * schema.org data as short "path: value" lines. Long lists, for example
 * reviews or recipe steps, show only their count. --json has all of it.
 */
const factLines = (value: Json, path: string, depth: number): string[] => {
  if (value === null || value === "") {
    return [];
  }
  if (isScalar(value)) {
    return [`- ${path}: ${scalarText(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.every((item) => isScalar(item))) {
      const items = value
        .filter((item) => item !== null)
        .map((item) => scalarText(item));
      const more = items.length - MAX_LIST_ITEMS;
      return items.length === 0
        ? []
        : [
            `- ${path}: ${items.slice(0, MAX_LIST_ITEMS).join("; ")}${more > 0 ? ` (and ${more} more)` : ""}`,
          ];
    }
    if (value.length > MAX_NESTED_OBJECTS || depth >= MAX_FACT_DEPTH) {
      return [`- ${path}: ${value.length} items`];
    }
    return value.flatMap((item) => factLines(item, path, depth + 1));
  }
  if (depth >= MAX_FACT_DEPTH) {
    return [];
  }
  // Plain values first. A nested @type only names the kind of object.
  const entries = Object.entries(value)
    .filter(
      ([key]) => !SKIPPED_KEYS.has(key) && (depth === 0 || key !== "@type")
    )
    .toSorted(([, a], [, b]) => Number(!isScalar(a)) - Number(!isScalar(b)));
  return entries.flatMap(([key, item]) =>
    factLines(item, path ? `${path}.${key}` : key, depth + 1)
  );
};

const structuredDataSection = ({ structuredData }: ExtractPage) => {
  if (!structuredData?.length) {
    return null;
  }
  const items = structuredData.map((item) => {
    const lines = factLines(item, "", 0);
    const more = lines.length - MAX_FACTS_PER_ITEM;
    return [
      ...lines.slice(0, MAX_FACTS_PER_ITEM),
      ...(more > 0 ? [`- (${more} more facts in --json)`] : []),
    ].join("\n");
  });
  return `## Structured data (schema.org)\n\nThe site gives these facts to search engines. They can be different from the visible page.\n\n${items.join("\n\n")}`;
};

const designSection = (
  design: NonNullable<ExtractPage["design"]>,
  designFile: string | undefined
) => {
  const body = renderMarkdown(design);
  return designFile && design.status === "success"
    ? `Saved DESIGN.md to ${designFile}.\n\n${body}`
    : body;
};

/** The requested outputs, each in its section. */
const outputBlocks = (page: ExtractPage, options: ExtractFormatOptions) => {
  const blocks: string[] = [];
  for (const [heading, body] of outputSections(page)) {
    if (body) {
      blocks.push(`## ${heading}\n\n${body}`);
    }
  }
  if (page.design) {
    blocks.push(
      `## Design (DESIGN.md)\n\n${designSection(page.design, options.designFile)}`
    );
  }
  if (page.screenshot) {
    blocks.push(
      `## Screenshot\n\n${screenshotSection(page.screenshot, options)}`
    );
  }
  return blocks;
};

const totalLength = (blocks: (string | null)[]) =>
  blocks.reduce((total, block) => total + (block?.length ?? 0), 0);

/** Reads the extract result. Throws when the server sent a different form. */
export const parsePage = (result: ToolResult) =>
  parseResult(extractSchema, result);

/** Formats an extract result as Markdown. */
export const formatExtract = (
  result: ToolResult,
  options: ExtractFormatOptions
) => {
  const page = parseResult(extractSchema, result);
  const outputs = outputBlocks(page, options);
  const data = structuredDataSection(page);
  // The outputs and facts come first. The page text gets the rest.
  const available =
    options.maxCharacters - HEADER_CHARACTERS - totalLength([data, ...outputs]);
  const viewWith = (characters: number) =>
    viewText(page.markdown, options, Math.max(MIN_TEXT_CHARACTERS, characters));
  let view = viewWith(available);
  // The note after the page text lists offsets. Make room for it.
  const { note } = textSections(page, view, options.url);
  if (note) {
    view = viewWith(available - note.length);
  }
  const sections = [header(page, view)];
  const warnings = resultWarnings(result);
  if (warnings.length > 0) {
    sections.push(
      warnings
        .map(({ code, message, guidance }) =>
          `> Warning (${code}): ${message} ${guidance ?? ""}`.trim()
        )
        .join("\n")
    );
  }
  sections.push(...outputs);
  if (data) {
    sections.push(data);
  }
  const text = textSections(page, view, options.url);
  sections.push(...text.text);
  if (text.note) {
    sections.push(`---\n\n${text.note}`);
  }
  return `${sections.join("\n\n")}\n`;
};

export type PageOutcome =
  | {
      url: string;
      result: ToolResult;
      screenshotFile: string | undefined;
      designFile: string | undefined;
    }
  | { url: string; error: CliError };

/** Formats several pages, each after a line that names it. */
export const formatPages = (
  pages: PageOutcome[],
  options: TextRequest & { baseUrl: string; maxCharacters: number }
) =>
  pages
    .map((page, index) => {
      const title = `===== Page ${index + 1} of ${pages.length}: ${page.url} =====`;
      if ("error" in page) {
        const { message, guidance } = page.error;
        return `${title}\n\nError: ${message}${guidance ? `\n${guidance}` : ""}\n`;
      }
      return `${title}\n\n${formatExtract(page.result, {
        ...options,
        url: page.url,
        screenshotFile: page.screenshotFile,
        designFile: page.designFile,
      })}`;
    })
    .join("\n");

const ORGANIC = "organic_results";
/** Fields of a SERP item that name it, or link to it; the others are details. */
const ITEM_NAMES = ["title", "question", "query", "name"];
const PIXELS_ABOVE_FOLD = 600;

/** A detail of a SERP item as text, for example "4.5 stars". */
const serpDetail = (field: string, value: JsonValue) => {
  if (Array.isArray(value)) {
    const parts = value.flatMap((part) => serpText(part) ?? []);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  const text = serpText(value);
  if (text && field === "rating") {
    return `${text} stars`;
  }
  return text && field === "reviews" ? `(${text} reviews)` : text;
};

/** One SERP item on one line, then its link: name · details. */
const serpItem = (item: SerpEntry, indent: string) => {
  const name = ITEM_NAMES.map((field) => serpText(item[field])).find(Boolean);
  const details = Object.entries(item).flatMap(([field, value]) =>
    ITEM_NAMES.includes(field) || field === "link"
      ? []
      : (serpDetail(field, value) ?? [])
  );
  const link = serpText(item.link);
  return [
    `${indent}- ${[name ?? "(no name)", ...details].join(" · ")}`,
    link && `${indent}  ${link}`,
  ]
    .filter(Boolean)
    .join("\n");
};

/** One line for a block of the results page: its name, size and place. */
const serpLine = (block: SerpBlock, index: number) => {
  const { feature, y, column, ranks, count, deferred } = block;
  const name = ranks
    ? `${feature} #${ranks[0]}${ranks.length > 1 ? `–#${ranks.at(-1)}` : ""}`
    : `${feature}${count === undefined ? "" : ` (${count})`}`;
  const place = [
    y === undefined ? null : `y ${y} px`,
    column ? `${column} column` : null,
    deferred ? "text not available" : null,
  ].filter(Boolean);
  return `${index + 1}. ${name}${place.length > 0 ? `, ${place.join(", ")}` : ""}`;
};

/** The content of a block, indented under its line. */
const serpContent = (block: SerpBlock) => {
  const indent = "   ";
  const lines: string[] = [];
  if (block.deferred) {
    lines.push(
      `${indent}Google loads this AI Overview separately. Its text is not available, and a new search does not give it.`
    );
  }
  const head = [block.title, block.type, serpText(block.source)]
    .filter(Boolean)
    .join(" · ");
  const text = block.text ?? block.description;
  lines.push(
    ...[head, block.link, block.website].flatMap((line) =>
      line ? [`${indent}${line}`] : []
    ),
    ...(text?.split("\n").map((line) => `${indent}${line}`) ?? []),
    ...(block.list?.map((item) => `${indent}- ${item}`) ?? [])
  );
  if (block.sources?.length) {
    lines.push(
      `${indent}Sources:`,
      ...block.sources.map((item) => serpItem(item, indent))
    );
  }
  lines.push(...(block.items ?? []).map((item) => serpItem(item, indent)));
  return lines;
};

const serpSection = (blocks: SerpBlock[], withContent: boolean) => {
  if (!blocks.some(({ feature }) => feature !== ORGANIC)) {
    return null;
  }
  const lines = blocks.flatMap((block, index) => [
    serpLine(block, index),
    ...(withContent && block.feature !== ORGANIC ? serpContent(block) : []),
  ]);
  return `## Google results page (SERP), top first\n\n${lines.join("\n")}\n\ny is the distance from the top of a desktop page 1200 px wide. A block with y less than ${PIXELS_ABOVE_FOLD} shows without scrolling.`;
};

/** Formats a search result as Markdown. */
export const formatSearch = (
  result: ToolResult,
  query: string,
  withContent = false
) => {
  const data = parseResult(searchSchema, result);
  const sections = [`# Search: ${query}`];
  const serp = serpSection(data.serp, withContent);
  // --serp asks for the SERP features, so they come first.
  if (serp && withContent) {
    sections.push(serp);
  }
  const results = data.organic_results.map(
    ({ title, link, snippet, date }, index) =>
      [
        `${index + 1}. ${title || "(no title)"}`,
        link && `   ${link}`,
        date && `   Date: ${date}`,
        snippet && `   ${snippet}`,
      ]
        .filter(Boolean)
        .join("\n")
  );
  sections.push(
    `## Results\n\n${results.length > 0 ? results.join("\n\n") : "No results."}`
  );
  if (serp && !withContent) {
    sections.push(serp);
  }
  const next = ["To read a result, run: extraktor extract <link>"];
  const snippetLink = data.serp.find(
    ({ feature }) => feature === "featured_snippet"
  )?.link;
  if (snippetLink) {
    next.push(
      `The featured snippet quotes ${snippetLink}. To read the complete answer, run: extraktor extract ${quoteArg(snippetLink)}`
    );
  }
  if (withContent) {
    const links = data.organic_results
      .slice(0, 3)
      .flatMap(({ link }) => (link ? [quoteArg(link)] : []));
    if (links.length > 1) {
      next.push(
        `To compare the content of the top results, run: extraktor extract ${links.join(" ")}`
      );
    }
  } else if (serp) {
    next.push(
      "Only if the task needs the content of the SERP features, run the search again with --serp."
    );
  }
  sections.push(next.join("\n"));
  return `${sections.join("\n\n")}\n`;
};
