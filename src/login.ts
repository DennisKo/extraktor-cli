/**
 * Browser sign-in. The Extraktor page /cli/login makes a new API key and posts
 * it to a one-time server on 127.0.0.1. A random state value proves that the
 * key comes from the page that this command opened.
 */
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";

import { API_KEY_FORMAT } from "./auth.ts";
import { CliError, EXIT } from "./errors.ts";

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_CALLBACK_BYTES = 4096;
const KEY_NAME_MAX_LENGTH = 50;

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`;

const reply = (
  response: ServerResponse,
  status: number,
  title: string,
  text: string
) => {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(page(title, text));
};

const readForm = async (request: IncomingMessage) => {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > MAX_CALLBACK_BYTES) {
      throw new Error("The callback body is too large.");
    }
  }
  return new URLSearchParams(body);
};

const browserCommand = (url: string): [string, string[]] => {
  if (process.platform === "darwin") {
    return ["open", [url]];
  }
  if (process.platform === "win32") {
    return ["cmd", ["/c", "start", '""', url.replaceAll("&", "^&")]];
  }
  return ["xdg-open", [url]];
};

const openBrowser = (url: string) => {
  const [command, args] = browserCommand(url);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // The user can open the printed URL when no browser starts.
    child.on("error", () => null);
    child.unref();
  } catch {
    // The user can open the printed URL.
  }
};

interface Pending {
  state: string;
  resolve: (key: string) => void;
  reject: (error: CliError) => void;
}

const handleCallback = async (
  request: IncomingMessage,
  response: ServerResponse,
  { state, resolve, reject }: Pending
) => {
  if (request.method !== "POST" || request.url !== "/callback") {
    reply(response, 404, "Not found", "This address is for the Extraktor CLI.");
    return;
  }
  let form: URLSearchParams;
  try {
    form = await readForm(request);
  } catch {
    reply(response, 413, "Sign-in failed", "The request is too large.");
    return;
  }
  if (!sameText(form.get("state") ?? "", state)) {
    reply(
      response,
      400,
      "Sign-in failed",
      "The request is not from this sign-in."
    );
    return;
  }
  if (form.get("error")) {
    reply(response, 200, "Sign-in canceled", "You can close this tab.");
    reject(
      new CliError("The sign-in was canceled in the browser.", EXIT.access)
    );
    return;
  }
  const key = form.get("key") ?? "";
  if (!API_KEY_FORMAT.test(key)) {
    reply(
      response,
      400,
      "Sign-in failed",
      "The browser did not send a correct key."
    );
    reject(
      new CliError("The browser did not send a correct key.", EXIT.failure)
    );
    return;
  }
  reply(
    response,
    200,
    "The Extraktor CLI is signed in",
    "You can close this tab and go back to the terminal."
  );
  resolve(key);
};

export interface LoginOptions {
  baseUrl: string;
  browser: boolean;
  /** Prints the sign-in URL and progress. */
  log: (line: string) => void;
}

/** Signs in with a browser and returns the new API key. */
export const loginWithBrowser = async ({
  baseUrl,
  browser,
  log,
}: LoginOptions) => {
  const state = randomBytes(24).toString("base64url");
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const server = createServer(async (request, response) => {
    try {
      await handleCallback(request, response, { state, resolve, reject });
    } catch {
      response.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
  } catch (error) {
    throw new CliError(
      `The CLI cannot open a local port for sign-in: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.failure,
      "Set EXTRAKTOR_API_KEY, or use extraktor login --with-key."
    );
  }
  const address = server.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node returns a string for a Unix socket and AddressInfo for TCP.
  const port = typeof address === "object" && address ? address.port : 0;
  const url = new URL("/cli/login", baseUrl);
  url.search = new URLSearchParams({
    port: String(port),
    state,
    name: `CLI on ${hostname()}`.slice(0, KEY_NAME_MAX_LENGTH),
  }).toString();
  log(`Open this URL to sign in:\n\n  ${url.href}\n`);
  log("Waiting for the browser. Press Ctrl+C to stop.");
  if (browser) {
    openBrowser(url.href);
  }
  const timer = setTimeout(
    () =>
      reject(
        new CliError(
          "The sign-in did not complete in 5 minutes.",
          EXIT.access,
          'Run "extraktor login" again.'
        )
      ),
    LOGIN_TIMEOUT_MS
  );
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
};
