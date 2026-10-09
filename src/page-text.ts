/**
 * Page text in parts, and the sections that match a find. The MCP server uses
 * it for each result. The CLI uses it on the complete page text that it keeps,
 * so that it reads other parts and finds text without a new request.
 */

/** Readers can stop at this heading: after it come the site's menus. */
export const SITE_NAVIGATION_HEADING = "Site navigation";
/** The heading as the Markdown shows it. */
export const SITE_NAVIGATION_LINE = `## ${SITE_NAVIGATION_HEADING}`;

/** A result with page text. */
interface WithMarkdown {
  markdown: string;
}

// Codex 0.149 gives the model at most about 48,000 bytes of serialized
// structured content and silently removes the middle of a larger result.
// Agents then repeat the same read, which returns the same cut. Keep each
// result below that limit, with room for serialization differences.
export const MAX_RESULT_BYTES = 44_000;
const MAX_OUTLINE_ENTRIES = 40;
const MAX_HEADING_CHARACTERS = 120;
const HEADING = /^(?<marks>#{1,6})\s+(?<text>.+?)\s*#*\s*$/u;
const FENCE = /^\s*(?:```|~~~)/u;

export interface OutlineEntry {
  level: number;
  heading: string;
  offset: number;
}

export interface MarkdownRange {
  start: number;
  end: number;
  totalCharacters: number;
  nextOffset: number | null;
  message: string;
}

/** A page with its text, or one part of it with the range and outline. */
export type PageTextResult<Page extends WithMarkdown = WithMarkdown> = Page & {
  markdownRange?: MarkdownRange;
  outline?: OutlineEntry[];
};

const jsonBytes = <Value>(value: Value) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const readOutline = (markdown: string): OutlineEntry[] => {
  const entries: OutlineEntry[] = [];
  let offset = 0;
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const heading = HEADING.exec(line)?.groups;
      if (heading) {
        entries.push({
          level: heading.marks.length,
          heading: heading.text.slice(0, MAX_HEADING_CHARACTERS),
          offset,
        });
      }
    }
    offset += line.length + 1;
  }
  return entries;
};

/**
 * Keep the broadest heading levels that fit; a long reference can have
 * hundreds. When even the broadest level has too many, keep evenly spaced
 * entries of it, so the outline covers the whole page, for example every
 * twelfth "Page N" heading of a long PDF.
 */
const limitOutline = (entries: OutlineEntry[]): OutlineEntry[] => {
  for (let level = 6; level >= 1; level -= 1) {
    const kept = entries.filter((entry) => entry.level <= level);
    if (kept.length === 0) {
      break;
    }
    if (kept.length <= MAX_OUTLINE_ENTRIES) {
      return kept;
    }
  }
  if (entries.length === 0) {
    return [];
  }
  const broadest = Math.min(...entries.map((entry) => entry.level));
  const top = entries.filter((entry) => entry.level === broadest);
  const step = top.length / MAX_OUTLINE_ENTRIES;
  return Array.from(
    { length: MAX_OUTLINE_ENTRIES },
    (_, index) => top[Math.floor(index * step)]
  ).filter((entry) => entry !== undefined);
};

/** The headings of the page with their offsets, at most 40. */
export const pageOutline = (markdown: string): OutlineEntry[] =>
  limitOutline(readOutline(markdown));

/** Ends on a line break when possible and never splits a surrogate pair. */
const sliceEnd = (markdown: string, start: number, budget: number): number => {
  let used = 0;
  let end = start;
  while (end < markdown.length) {
    const lineBreak = markdown.indexOf("\n", end);
    const lineEnd = lineBreak === -1 ? markdown.length : lineBreak + 1;
    const cost = jsonBytes(markdown.slice(end, lineEnd)) - 2;
    if (used + cost > budget) {
      break;
    }
    used += cost;
    end = lineEnd;
  }
  if (end > start || end === markdown.length) {
    return end;
  }
  // A single line is larger than the budget: cut it by characters.
  while (end < markdown.length) {
    const width = (markdown.codePointAt(end) ?? 0) > 0xff_ff ? 2 : 1;
    const cost = jsonBytes(markdown.slice(end, end + width)) - 2;
    if (used + cost > budget) {
      break;
    }
    used += cost;
    end += width;
  }
  return end;
};

const rangeMessage = (
  start: number,
  end: number,
  total: number,
  skippedPreface: boolean
) =>
  [
    `This is one part of the page text: Markdown characters ${start}–${end} of ${total}.`,
    skippedPreface
      ? "This part starts at the first main heading. The text before it is usually site navigation. To get that text, send offset 0."
      : "",
    "Use this part if it is sufficient for the task.",
    "To read a different part, call extract with the same url and an offset from nextOffset or outline.",
    "The same request returns the same part again.",
  ]
    .filter(Boolean)
    .join(" ");

// A matched section up to this size comes back complete, for context.
const MAX_WHOLE_SECTION_CHARACTERS = 2500;
// A larger matched block comes back as its matched lines.
const MAX_WHOLE_BLOCK_CHARACTERS = 1200;
const MIN_FIND_WORD_LENGTH = 2;
const BLANK_LINE = /\n[ \t]*\n/u;
const TABLE_ROW = /^\s*\|/u;
const FIND_WORD = /[\p{L}\p{N}]+/gu;

export interface FoundSection {
  level: number;
  heading: string;
  offset: number;
}

export interface FindResult {
  query: string;
  /** "phrase": the exact text matched. "words": all words of the query matched in one block. */
  matchedBy: "phrase" | "words" | null;
  sections: FoundSection[];
  /** Matched sections that did not fit in the result. Read them with offset. */
  omittedSections: FoundSection[];
  message: string;
}

export type FoundPageText<Page extends WithMarkdown = WithMarkdown> = Page & {
  found: FindResult;
  outline?: OutlineEntry[];
};

interface Section extends FoundSection {
  text: string;
}

/** Splits the page at each heading. Text before the first heading has level 0. */
const readSections = (markdown: string): Section[] => {
  const sections: Section[] = [];
  let current: Section = { level: 0, heading: "", offset: 0, text: "" };
  let offset = 0;
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
    }
    const heading = inFence ? undefined : HEADING.exec(line)?.groups;
    if (heading) {
      sections.push(current);
      current = {
        level: heading.marks.length,
        heading: heading.text.slice(0, MAX_HEADING_CHARACTERS),
        offset,
        text: "",
      };
    }
    current.text += `${line}\n`;
    offset += line.length + 1;
  }
  sections.push(current);
  return sections.filter((section) => section.text.trim());
};

/** Splits section text into blocks at blank lines. A code fence stays one block. */
const readBlocks = (text: string): string[] => {
  const blocks: string[] = [];
  let inFence = false;
  let block = "";
  for (const part of text.split(BLANK_LINE)) {
    block = block ? `${block}\n\n${part}` : part;
    for (const line of part.split("\n")) {
      if (FENCE.test(line)) {
        inFence = !inFence;
      }
    }
    if (!inFence) {
      blocks.push(block);
      block = "";
    }
  }
  if (block) {
    blocks.push(block);
  }
  return blocks;
};

type Matcher = (text: string) => boolean;

const phraseMatcher =
  (query: string): Matcher =>
  (text) =>
    text.toLowerCase().includes(query.toLowerCase());

const wordsMatcher = (query: string): Matcher | null => {
  const words = [...new Set(query.toLowerCase().match(FIND_WORD))].filter(
    (word) => word.length >= MIN_FIND_WORD_LENGTH
  );
  if (words.length < 2) {
    return null;
  }
  return (text) => {
    const lower = text.toLowerCase();
    return words.every((word) => lower.includes(word));
  };
};

/** The matched lines of a large block, with one line of context, or the table header and matched rows. */
const trimBlock = (block: string, matches: Matcher) => {
  const lines = block.split("\n");
  if (lines.every((line) => TABLE_ROW.test(line))) {
    const header = lines.slice(0, 2);
    const rows = lines.slice(2).filter((line) => matches(line));
    return [...header, ...rows].join("\n");
  }
  const keep = new Set<number>();
  for (const [index, line] of lines.entries()) {
    if (matches(line)) {
      keep
        .add(index - 1)
        .add(index)
        .add(index + 1);
    }
  }
  if (keep.size === 0) {
    // The words match across lines: the block is the smallest unit.
    return block.slice(0, MAX_WHOLE_BLOCK_CHARACTERS);
  }
  const kept: string[] = [];
  let last = -1;
  for (const [index, line] of lines.entries()) {
    if (keep.has(index)) {
      if (last !== -1 && index > last + 1) {
        kept.push("…");
      }
      kept.push(line);
      last = index;
    }
  }
  return kept.join("\n");
};

/** The text of a matched section: all of it when it is short, else its matched blocks. */
const matchedText = (section: Section, matches: Matcher) => {
  if (section.text.length <= MAX_WHOLE_SECTION_CHARACTERS) {
    return section.text.trimEnd();
  }
  const [first = "", ...rest] = readBlocks(section.text);
  // Keep the heading line of the section for context.
  const headingLine = section.level > 0 ? first.split("\n")[0] : null;
  const parts: string[] = [];
  for (const block of [first, ...rest]) {
    if (matches(block)) {
      parts.push(
        block.length <= MAX_WHOLE_BLOCK_CHARACTERS
          ? block
          : trimBlock(block, matches)
      );
    }
  }
  if (headingLine && !parts[0]?.startsWith(headingLine)) {
    parts.unshift(headingLine);
  }
  return parts.join("\n\n…\n\n");
};

const toFound = ({ level, heading, offset }: Section): FoundSection => ({
  level,
  heading: heading || "(start of page)",
  offset,
});

const findMessage = (
  query: string,
  matchedBy: FindResult["matchedBy"],
  shown: number,
  omitted: number
) => {
  if (!matchedBy) {
    return `The page text does not contain "${query}". Use a shorter or different phrase, or read a section with offset from the outline. Do not send the same find again.`;
  }
  const sections = shown === 1 ? "This section" : `These ${shown} sections`;
  return [
    matchedBy === "phrase"
      ? `${sections} of the page text contain "${query}".`
      : `The exact phrase "${query}" is not in the page text. ${sections} have all of its words.`,
    "Large sections show only their matched paragraphs, lines or table rows.",
    omitted > 0
      ? `${omitted} more matched sections did not fit. Read them with offset from omittedSections.`
      : "",
    "To read all of a section, send its offset.",
  ]
    .filter(Boolean)
    .join(" ");
};

/**
 * Returns only the sections of the complete page text that contain the query,
 * so an agent gets a fact from a large page in one call. Matching is
 * deterministic: the exact phrase (any case), else all words of the query in
 * one block. With `completeWhenNoMatch`, a page that fits in `maxBytes` comes
 * back complete when nothing matches, so the agent needs no second call to
 * check that the page does not state the fact.
 */
export const findPageText = <Page extends WithMarkdown>(
  result: Page,
  query: string,
  maxBytes = MAX_RESULT_BYTES,
  { completeWhenNoMatch = false } = {}
): FoundPageText<Page> => {
  const sections = readSections(result.markdown);
  const phrase = phraseMatcher(query);
  const words = wordsMatcher(query);
  let matches: Matcher | null = phrase;
  let matchedBy: FindResult["matchedBy"] = "phrase";
  let hits = sections.filter((section) => phrase(section.text));
  if (hits.length === 0 && words) {
    matches = words;
    matchedBy = "words";
    hits = sections.filter((section) =>
      readBlocks(section.text).some((block) => words(block))
    );
  }
  if (hits.length === 0) {
    matches = null;
    matchedBy = null;
  }
  // The site menus come after the page content. Show their matches last.
  const navigation = sections.find(
    (section) => section.text.split("\n")[0] === SITE_NAVIGATION_LINE
  )?.offset;
  if (navigation !== undefined) {
    hits = [
      ...hits.filter((section) => section.offset < navigation),
      ...hits.filter((section) => section.offset >= navigation),
    ];
  }
  const none: FoundSection[] = [];
  const base = {
    ...result,
    markdown: "",
    found: {
      query,
      matchedBy,
      sections: none,
      omittedSections: none,
      message: findMessage(query, matchedBy, 0, 0),
    },
  };
  if (!matches) {
    const complete = {
      ...result,
      found: {
        ...base.found,
        message: `The page text does not contain "${query}" or all of its words. markdown has the complete page text. Use it to answer. Do not call extract again for this page.`,
      },
    };
    return completeWhenNoMatch && jsonBytes(complete) <= maxBytes
      ? complete
      : { ...base, outline: limitOutline(readOutline(result.markdown)) };
  }
  // Each section can list as an omitted entry. Keep room for all of them.
  let budget =
    maxBytes -
    jsonBytes({
      ...base,
      found: { ...base.found, omittedSections: hits.map(toFound) },
    });
  const parts: string[] = [];
  const shown: FoundSection[] = [];
  const omitted: FoundSection[] = [];
  for (const section of hits) {
    let text = matchedText(section, matches);
    let cost = jsonBytes(`${text}\n\n---\n\n`) - 2;
    if (cost > budget && shown.length === 0) {
      // Never return no text when there is a match: cut the first one to fit.
      text = text.slice(0, sliceEnd(text, 0, budget - 16));
      cost = jsonBytes(`${text}\n\n---\n\n`) - 2;
    }
    if (cost <= budget) {
      parts.push(text);
      shown.push(toFound(section));
      budget -= cost;
    } else {
      omitted.push(toFound(section));
    }
  }
  return {
    ...base,
    markdown: parts.join("\n\n---\n\n"),
    found: {
      query,
      matchedBy,
      sections: shown,
      omittedSections: omitted,
      message: findMessage(query, matchedBy, shown.length, omitted.length),
    },
  };
};

/**
 * Returns the complete result when it fits. Otherwise returns one part of the
 * Markdown with its character range and the page outline, so another part can
 * be requested explicitly instead of repeating the same read.
 */
export const fitPageText = <Page extends WithMarkdown>(
  result: Page,
  offset?: number,
  maxBytes = MAX_RESULT_BYTES
): PageTextResult<Page> => {
  if (offset === undefined && jsonBytes(result) <= maxBytes) {
    return { ...result };
  }
  const { markdown } = result;
  const total = markdown.length;
  const outline = readOutline(markdown);
  const firstMainHeading = outline.find((entry) => entry.level === 1)?.offset;
  const skippedPreface = offset === undefined && (firstMainHeading ?? 0) > 0;
  const start = Math.min(
    offset ?? (skippedPreface ? (firstMainHeading ?? 0) : 0),
    total
  );
  const emptyPart = {
    ...result,
    markdown: "",
    markdownRange: {
      start: total,
      end: total,
      totalCharacters: total,
      nextOffset: total,
      message: rangeMessage(total, total, total, skippedPreface),
    },
    outline: limitOutline(outline),
  };
  const end = sliceEnd(
    markdown,
    start,
    Math.max(0, maxBytes - jsonBytes(emptyPart))
  );
  return {
    ...emptyPart,
    markdown: markdown.slice(start, end),
    markdownRange: {
      start,
      end,
      totalCharacters: total,
      nextOffset: end < total ? end : null,
      message: rangeMessage(start, end, total, skippedPreface),
    },
  };
};
