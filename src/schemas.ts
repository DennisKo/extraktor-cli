/**
 * Every zod schema of the CLI. The CLI loads this module while the request is
 * on the network, so zod adds no wait before the request starts.
 */
import { z } from "zod";

import { API_KEY_FORMAT } from "./auth.ts";

export const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  guidance: z.string().optional(),
  retryAfterMs: z.number().optional(),
  feature: z.string().optional(),
});
/** The failure JSON that the Extraktor MCP tools return. */
export type ToolFailure = z.infer<typeof failureSchema>;

export const toolResultSchema = z.object({
  content: z.array(
    z.looseObject({
      type: z.string(),
      text: z.string().optional(),
      data: z.string().optional(),
      mimeType: z.string().optional(),
    })
  ),
  structuredContent: z.record(z.string(), z.json()).optional(),
  isError: z.boolean().optional(),
});
export type ToolResult = z.infer<typeof toolResultSchema>;

export const jsonRpcSchema = z.object({
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: toolResultSchema.optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
export type JsonRpcResponse = z.infer<typeof jsonRpcSchema>;

export const httpErrorSchema = z.object({ error_description: z.string() });

export const parseJson = (text: string) => {
  try {
    // SAFETY: JSON.parse returns only JSON values. The caller parses the shape.
    return JSON.parse(text) as z.core.util.JSONType;
  } catch {
    return null;
  }
};

/** Reads the tool failure JSON from a text content item, if it has one. */
export const parseFailure = (text: string | undefined): ToolFailure | null =>
  text ? (failureSchema.safeParse(parseJson(text)).data ?? null) : null;

export const credentialsSchema = z.record(
  z.string(),
  z.object({ apiKey: z.string().regex(API_KEY_FORMAT), savedAt: z.string() })
);
export type Credentials = z.infer<typeof credentialsSchema>;

// The schemas below mirror the agent schemas of the Extraktor MCP tools. They
// keep only the fields that the Markdown output shows. --json prints the
// complete result.
export const outputFailure = z.object({
  status: z.enum(["empty", "error"]),
  message: z.string(),
});
export const markdownOutput = z.union([
  z.object({ status: z.literal("success"), markdown: z.string() }),
  outputFailure,
]);
export const excerptsOutput = z.union([
  z.object({
    status: z.literal("success"),
    markdown: z.string(),
    passageLinks: z.array(z.string().nullable()),
  }),
  outputFailure,
]);
export const contactsOutput = z.union([
  z.object({
    status: z.literal("success"),
    emails: z.array(
      z.object({ address: z.string(), label: z.string().nullable() })
    ),
    phones: z.array(
      z.object({
        number: z.string().nullable(),
        text: z.string(),
        label: z.string().nullable(),
      })
    ),
    // Older servers do not send these fields.
    addresses: z
      .array(
        z.object({
          text: z.string(),
          country: z.string().nullable(),
          label: z.string().nullable(),
        })
      )
      .default([]),
    profiles: z
      .array(z.object({ network: z.string(), url: z.string() }))
      .default([]),
    organization: z
      .object({
        name: z.string().nullable(),
        legalName: z.string().nullable(),
        registrationId: z.string().nullable(),
        vatId: z.string().nullable(),
      })
      .nullable()
      .default(null),
    contactPages: z.array(z.string()).optional(),
    message: z.string().optional(),
  }),
  z.object({
    status: z.enum(["empty", "error"]),
    message: z.string(),
    contactPages: z.array(z.string()).optional(),
  }),
]);
const messagingCta = z
  .object({ text: z.string(), url: z.string().nullable() })
  .nullable();
export const messagingOutput = z.union([
  z.object({
    status: z.literal("success"),
    headline: z.string().nullable(),
    subheadline: z.string().nullable(),
    primaryCta: messagingCta,
    secondaryCta: messagingCta,
    benefits: z.array(z.string()),
    differentiators: z.array(z.string()),
    proof: z.object({
      metrics: z.array(z.string()),
      testimonials: z.array(
        z.object({
          quote: z.string(),
          person: z.string().nullable(),
          role: z.string().nullable(),
          company: z.string().nullable(),
        })
      ),
      customers: z.array(z.string()),
      awards: z.array(z.string()),
      certifications: z.array(z.string()),
      reviewBadges: z.array(z.string()),
    }),
    positioning: z.object({
      category: z.string(),
      audience: z.string(),
      valueProposition: z.string(),
      painPoints: z.array(z.string()),
      tone: z.array(z.string()),
    }),
  }),
  outputFailure,
]);
/** Reports without a fixed shape. The CLI prints them as JSON. */
export const reportOutput = z.looseObject({
  status: z.enum(["success", "empty", "error"]),
  message: z.string().optional(),
  /** The report as Markdown, as the site shows it. */
  markdown: z.string().optional(),
});
export const screenshotOutput = z.union([
  z.object({
    status: z.literal("success"),
    url: z.string(),
    bytes: z.number(),
  }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);

const foundSection = z.object({
  level: z.number(),
  heading: z.string(),
  offset: z.number(),
});

/** Any result with page text. --json keeps every other field. */
export const pageTextSchema = z.looseObject({ markdown: z.string() });

export const extractSchema = z.object({
  finalUrl: z.string(),
  status: z.number().nullable(),
  markdown: z.string(),
  markdownRange: z
    .object({
      start: z.number(),
      end: z.number(),
      totalCharacters: z.number(),
      nextOffset: z.number().nullable(),
    })
    .optional(),
  outline: z
    .array(
      z.object({ level: z.number(), heading: z.string(), offset: z.number() })
    )
    .optional(),
  found: z
    .object({
      query: z.string(),
      matchedBy: z.enum(["phrase", "words"]).nullable(),
      sections: z.array(foundSection),
      omittedSections: z.array(foundSection),
      message: z.string(),
    })
    .optional(),
  metadata: z.object({
    title: z.string().nullable(),
    description: z.string().nullable(),
    byline: z.string().nullable(),
    publishedTime: z.string().nullable(),
    modifiedTime: z.string().nullable(),
  }),
  stats: z.object({ words: z.number() }),
  structuredData: z.array(z.json()).optional(),
  summary: markdownOutput.optional(),
  excerpts: excerptsOutput.optional(),
  contacts: contactsOutput.optional(),
  messaging: messagingOutput.optional(),
  seo: reportOutput.optional(),
  agentAccess: reportOutput.optional(),
  design: markdownOutput.optional(),
  screenshot: screenshotOutput.optional(),
});
export type ExtractPage = z.infer<typeof extractSchema>;

const jsonValue = z.json();
export type JsonValue = z.infer<typeof jsonValue>;
const serpEntry = z.record(z.string(), jsonValue);
export type SerpEntry = z.infer<typeof serpEntry>;
const scalarText = z.union([z.string(), z.number()]).transform(String);
/** A string or a number of a SERP block as text; null for other values. */
export const serpText = (value: JsonValue | undefined) => {
  const parsed = scalarText.safeParse(value);
  return parsed.success ? parsed.data : null;
};
export const serpBlockSchema = z.object({
  feature: z.string(),
  y: z.number().optional(),
  column: z.string().optional(),
  ranks: z.array(z.number()).optional(),
  count: z.number().optional(),
  deferred: z.boolean().optional(),
  title: z.string().optional(),
  type: z.string().optional(),
  source: jsonValue.optional(),
  link: z.string().optional(),
  website: z.string().optional(),
  text: z.string().optional(),
  description: z.string().optional(),
  list: z.array(z.string()).optional(),
  sources: z.array(serpEntry).optional(),
  items: z.array(serpEntry).optional(),
});
export type SerpBlock = z.infer<typeof serpBlockSchema>;

export const searchSchema = z.object({
  organic_results: z.array(
    z.looseObject({
      title: z.string().optional(),
      link: z.string().optional(),
      snippet: z.string().optional(),
      date: z.string().optional(),
    })
  ),
  serp: z.array(serpBlockSchema).default([]),
});
