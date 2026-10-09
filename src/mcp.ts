/**
 * The smallest MCP client that the CLI needs: one stateless `tools/call`
 * request to the Extraktor server. The server needs no `initialize` handshake,
 * so each command costs one round trip.
 */
import { subscribe, unsubscribe } from "node:diagnostics_channel";

import { CliError, EXIT } from "./errors.ts";
import type * as SchemaModule from "./schemas.ts";
import type { JsonRpcResponse, ToolFailure, ToolResult } from "./schemas.ts";
import { VERSION } from "./version.ts";

export type { ToolFailure, ToolResult } from "./schemas.ts";

type Schemas = typeof SchemaModule;

export const PROTOCOL_VERSION = "2026-07-28";
const REQUEST_TIMEOUT_MS = 180_000;

// Node's fetch (undici) publishes this event when the request body is sent.
const BODY_SENT = "undici:request:bodySent";

/**
 * Loads the zod schemas (about 20 ms of CPU) after fetch has sent the request.
 * zod then loads while the server works. If it loaded before the request or
 * between the headers and the body, the request would leave later.
 */
const loadSchemasAfterSend = () => {
  let loading: Promise<Schemas> | undefined;
  const onSent = () => {
    unsubscribe(BODY_SENT, onSent);
    loading ??= import("./schemas.ts");
  };
  subscribe(BODY_SENT, onSent);
  return {
    load: () => {
      onSent();
      return loading ?? import("./schemas.ts");
    },
    cancel: () => unsubscribe(BODY_SENT, onSent),
  };
};

const unexpectedResponse = () =>
  new CliError(
    "The server response has an unexpected form.",
    EXIT.failure,
    "Update the CLI: npm install --global @extraktor/cli@latest",
    "UNEXPECTED_RESPONSE"
  );

const ACCESS_CODES = new Set(["BILLING_REQUIRED"]);

const failureError = (failure: ToolFailure) =>
  new CliError(
    `${failure.message} (${failure.code})`,
    ACCESS_CODES.has(failure.code) ? EXIT.access : EXIT.failure,
    failure.guidance,
    failure.code
  );

/** Reads the JSON-RPC response from a JSON body or from server-sent events. */
const readResponse = async (
  response: Response,
  id: number,
  { jsonRpcSchema, parseJson }: Schemas
): Promise<JsonRpcResponse> => {
  const text = await response.text();
  const messages = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length))
    : [text];
  for (const message of messages.toReversed()) {
    const parsed = jsonRpcSchema.safeParse(parseJson(message));
    if (parsed.success && (parsed.data.id === id || messages.length === 1)) {
      return parsed.data;
    }
  }
  throw unexpectedResponse();
};

const SIGN_IN_GUIDANCE =
  'Run "extraktor login", or set EXTRAKTOR_API_KEY to an API key from the developers page.';

const httpError = async (
  response: Response,
  { httpErrorSchema, parseJson }: Schemas
) => {
  const description =
    httpErrorSchema.safeParse(parseJson(await response.text())).data
      ?.error_description ?? null;
  if (response.status === 401 || response.status === 403) {
    return new CliError(
      description ?? "Sign-in is necessary.",
      EXIT.access,
      SIGN_IN_GUIDANCE,
      "SIGN_IN_REQUIRED"
    );
  }
  return new CliError(
    `The server returned HTTP ${response.status}.`,
    EXIT.failure,
    response.status >= 500
      ? "Try again one time. If it fails again, report the failure."
      : undefined,
    `HTTP_${response.status}`
  );
};

interface Enabled {
  enabled: true;
}

/** The input of the extract tool. JSON omits undefined fields. */
export interface ExtractArgs {
  url: string;
  excerpts?: Enabled & { query?: string };
  summary?: Enabled & { query?: string };
  screenshot?: Enabled;
  contacts?: Enabled;
  messaging?: Enabled;
  seo?: Enabled & { keyword?: string; deep?: true };
  design?: Enabled & { vision?: true };
  agentAccess?: Enabled;
}

export interface SearchArgs {
  query: string;
  serp?: true;
}

export type CallToolOptions = {
  baseUrl: string;
  apiKey: string;
  /** The agent that runs the CLI, for example claude-code. Not part of the cache key. */
  agent?: string | null;
} & (
  | { name: "extract"; args: ExtractArgs }
  | { name: "search"; args: SearchArgs }
);

/** Calls one Extraktor MCP tool. Throws a CliError when the call fails. */
export const callTool = async ({
  baseUrl,
  apiKey,
  name,
  args,
  agent,
}: CallToolOptions): Promise<ToolResult> => {
  const id = 1;
  const schemasLoader = loadSchemasAfterSend();
  let response: Response;
  try {
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
      "User-Agent": `extraktor-cli/${VERSION}`,
    });
    if (agent) {
      headers.set("X-Extraktor-Agent", agent);
    }
    if (name === "extract") {
      // The CLI makes the parts and finds text itself, from one result.
      headers.set("X-Extraktor-Text", "complete");
    }
    response = await fetch(new URL("/mcp", baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    schemasLoader.cancel();
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new CliError(
      timedOut
        ? "The server did not reply in time."
        : `Extraktor at ${baseUrl} is not available.`,
      EXIT.failure,
      timedOut
        ? "Try again one time."
        : "Make sure that the computer is online. Check EXTRAKTOR_URL if you set it.",
      timedOut ? "TIMEOUT" : "SERVER_UNAVAILABLE"
    );
  }
  const schemas = await schemasLoader.load();
  if (!response.ok) {
    throw await httpError(response, schemas);
  }
  const message = await readResponse(response, id, schemas);
  if (message.error) {
    throw new CliError(message.error.message, EXIT.failure);
  }
  const { result } = message;
  if (!result) {
    throw unexpectedResponse();
  }
  if (result.isError) {
    const failure = schemas.parseFailure(result.content[0]?.text);
    throw failure
      ? failureError(failure)
      : new CliError("The tool call did not complete.", EXIT.failure);
  }
  return result;
};
