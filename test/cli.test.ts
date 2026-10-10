/* oxlint-disable no-await-in-loop -- Failure cases share one fetch mock and run in order. */
/* oxlint-disable unicorn/no-await-expression-member -- Assertions read one field of a response right after it arrives. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { credentialsPath } from "../src/auth.ts";
import { EXIT } from "../src/errors.ts";
import { MAIN_HELP } from "../src/help.ts";
import { loginWithBrowser } from "../src/login.ts";
import type { SearchArgs } from "../src/mcp.ts";
import { run } from "../src/run.ts";
import type { Io } from "../src/run.ts";
import { VERSION } from "../src/version.ts";

const KEY = `ext_${"a".repeat(64)}`;
const BASE = "https://extraktor.test";

const makeIo = async (env: NodeJS.ProcessEnv = {}, stdin = "") => {
  const dir = await mkdtemp(path.join(tmpdir(), "extraktor-cli-"));
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {
      XDG_CONFIG_HOME: dir,
      XDG_CACHE_HOME: path.join(dir, "cache"),
      EXTRAKTOR_URL: BASE,
      EXTRAKTOR_API_KEY: KEY,
      ...env,
    },
    readStdin: () => Promise.resolve(stdin),
    cwd: dir,
  };
  return {
    io,
    dir,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
};

interface FixtureContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
}

interface FixtureResult {
  content: FixtureContent[];
  structuredContent?: Record<string, z.core.util.JSONType>;
  isError?: true;
}

const rpcResult = (result: FixtureResult) =>
  Response.json({ jsonrpc: "2.0", id: 1, result });

const page = (overrides: Record<string, z.core.util.JSONType> = {}) => ({
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  status: 200,
  markdown: "# Example Domain\n\nThis domain is for use in examples.",
  metadata: {
    title: "Example Domain",
    description: null,
    byline: null,
    canonicalUrl: null,
    image: null,
    lang: "en",
    modifiedTime: null,
    publishedTime: null,
    siteName: null,
  },
  stats: { characters: 52, htmlBytes: 577, words: 8 },
  timings: { convertMs: 1, totalMs: 120 },
  ...overrides,
});

const extractResult = (
  overrides: Record<string, z.core.util.JSONType> = {},
  extraContent: FixtureContent[] = []
) => {
  const structuredContent = page(overrides);
  return rpcResult({
    content: [
      { type: "text", text: JSON.stringify(structuredContent) },
      ...extraContent,
    ],
    structuredContent,
  });
};

/** A long page: 30 sections of about 2,000 characters each. */
const longMarkdown = () =>
  Array.from(
    { length: 30 },
    (_, index) =>
      `## Section ${index + 1}\n\n${`Text of section ${index + 1}. `.repeat(80)}\n`
  ).join("\n");

test("one help call lists every command and every option", () => {
  for (const word of [
    "extract",
    "search",
    "login",
    "logout",
    "--find",
    "--offset",
    "--excerpts",
    "--summary",
    "--focus",
    "--screenshot",
    "--screenshot-file",
    "--save",
    "--design-file",
    "--contacts",
    "--seo",
    "--keyword",
    "--deep",
    "--design",
    "--vision",
    "--agent-access",
    "--serp",
    "--json",
    "EXTRAKTOR_API_KEY",
  ]) {
    assert.ok(MAIN_HELP.includes(word), word);
  }
});

test("the first 40 lines of help name a command for every task", () => {
  const top = MAIN_HELP.split("\n").slice(0, 40).join("\n");
  for (const word of [
    "--find",
    "--summary",
    "--excerpts",
    "--save",
    "--contacts",
    "--screenshot",
    "--design-file",
    "--seo",
    "--keyword",
    "--agent-access",
    "search",
    "--serp",
  ]) {
    assert.ok(top.includes(word), word);
  }
});

test("the CLI version matches package.json", async () => {
  const manifest = await readFile(
    new URL("../package.json", import.meta.url),
    "utf-8"
  );
  assert.equal(JSON.parse(manifest).version, VERSION);
});

test("extract sends one stateless tools/call and prints the outputs before the page text", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    (url: URL, init: RequestInit) => {
      assert.equal(url.href, `${BASE}/mcp`);
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
      assert.equal(headers.get("mcp-method"), "tools/call");
      assert.equal(headers.get("mcp-name"), "extract");
      assert.equal(headers.get("x-extraktor-text"), "complete");
      const body = JSON.parse(String(init.body));
      assert.equal(body.method, "tools/call");
      assert.deepEqual(body.params.arguments, {
        url: "https://example.com",
        excerpts: { enabled: true, query: "pricing" },
        seo: { enabled: true, keyword: "crm" },
      });
      return Promise.resolve(
        extractResult(
          {
            excerpts: {
              status: "success",
              markdown: "> Plans start at $10.",
              passageLinks: ["https://example.com/#:~:text=Plans"],
            },
            seo: {
              status: "success",
              words: 8,
              markdown:
                "# SEO keyword report\n\nPage: https://example.com/\n\n- Words: 8\n\n## Keywords",
            },
            markdown: longMarkdown(),
          },
          [
            {
              type: "text",
              text: JSON.stringify({
                code: "CAPTURE_INCOMPLETE",
                message: "The page stopped loading at a limit.",
                retryable: false,
              }),
            },
          ]
        )
      );
    }
  );
  const { io, stdout } = await makeIo();
  const code = await run(
    [
      "extract",
      "https://example.com",
      "--excerpts",
      "--focus",
      "pricing",
      "--keyword",
      "crm",
    ],
    io
  );
  assert.equal(code, EXIT.ok);
  assert.equal(fetchMock.mock.callCount(), 1);
  const output = stdout();
  assert.match(
    output,
    /^# Example Domain\n\nSource: https:\/\/example\.com\/ \(HTTP 200, 8 words\)/u
  );
  assert.match(output, /> Warning \(CAPTURE_INCOMPLETE\)/u);
  assert.match(
    output,
    /## Excerpts\n\n> Plans start at \$10\.\n\nPassage links:\n1\. https/u
  );
  // The report is Markdown under its section, one heading level lower.
  assert.match(output, /## SEO\n\n- Words: 8\n\n### Keywords/u);
  assert.doesNotMatch(output, /SEO keyword report|Page: https/u);
  assert.ok(output.indexOf("## Excerpts") < output.indexOf("## Page text"));
  // The CLI cuts a part that agents can see completely.
  assert.ok(output.length < 25_000, String(output.length));
  assert.match(
    output,
    /For the next part, run: extraktor extract https:\/\/example\.com --offset \d+\n/u
  );
  assert.match(output, /- ## Section 30 \(offset \d+\)/u);
});

const searchContent = {
  organic_results: [
    {
      title: "Limits",
      link: "https://developers.cloudflare.com/workers/platform/limits/",
      snippet: "CPU time per request.",
      position: 1,
    },
    {
      title: "Pricing",
      link: "https://developers.cloudflare.com/workers/platform/pricing/",
    },
  ],
  serp: [
    {
      feature: "ai_overview",
      y: 170,
      text: "Workers have a CPU limit.\n- Paid: 5 minutes",
      sources: [
        {
          title: "Limits",
          link: "https://developers.cloudflare.com/workers/platform/limits/",
          source: "Cloudflare",
        },
      ],
    },
    { feature: "organic_results", y: 590, ranks: [1] },
    {
      feature: "people_also_ask",
      y: 800,
      count: 4,
      items: [{ question: "What is the CPU limit?" }],
    },
    {
      feature: "local_pack",
      y: 1200,
      column: "right",
      count: 3,
      items: [
        {
          title: "Cafe",
          rating: 4.5,
          reviews: 10,
          address: "1 Main St",
          website: "https://cafe.example",
        },
      ],
    },
    { feature: "organic_results", y: 1500, ranks: [2, 3] },
  ],
};

const mockSearch = (t: TestContext, expected: SearchArgs) =>
  t.mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.params.arguments, expected);
    return Promise.resolve(
      rpcResult({
        content: [{ type: "text", text: JSON.stringify(searchContent) }],
        structuredContent: z.record(z.string(), z.json()).parse(searchContent),
      })
    );
  });

test("search joins unquoted words and prints the results, then the SERP layout", async (t) => {
  mockSearch(t, { query: "workers cpu limit" });
  const { io, stdout } = await makeIo();
  assert.equal(await run(["search", "workers", "cpu", "limit"], io), EXIT.ok);
  const output = stdout();
  assert.match(
    output,
    /## Results\n\n1\. Limits\n {3}https:\/\/developers\.cloudflare\.com\/workers\/platform\/limits\/\n {3}CPU time per request\./u
  );
  assert.match(
    output,
    /## Google results page \(SERP\), top first\n\n1\. ai_overview, y 170 px\n2\. organic_results #1, y 590 px\n3\. people_also_ask \(4\), y 800 px\n4\. local_pack \(3\), y 1200 px, right column\n5\. organic_results #2–#3, y 1500 px\n/u
  );
  assert.ok(output.indexOf("## Results") < output.indexOf("## Google results"));
  // The layout only: the content comes with --serp.
  assert.doesNotMatch(output, /What is the CPU limit/u);
  assert.match(output, /run the search again with --serp\.\n$/u);
});

test("search --serp prints the content of each SERP feature first", async (t) => {
  mockSearch(t, { query: "workers cpu limit", serp: true });
  const { io, stdout } = await makeIo();
  assert.equal(
    await run(["search", "workers cpu limit", "--serp"], io),
    EXIT.ok
  );
  const output = stdout();
  assert.ok(output.indexOf("## Google results") < output.indexOf("## Results"));
  assert.match(
    output,
    /1\. ai_overview, y 170 px\n {3}Workers have a CPU limit\.\n {3}- Paid: 5 minutes\n {3}Sources:\n {3}- Limits · Cloudflare\n {5}https:\/\/developers\.cloudflare\.com\/workers\/platform\/limits\/\n/u
  );
  assert.match(
    output,
    /3\. people_also_ask \(4\), y 800 px\n {3}- What is the CPU limit\?\n/u
  );
  assert.match(
    output,
    / {3}- Cafe · 4\.5 stars · \(10 reviews\) · 1 Main St · https:\/\/cafe\.example\n/u
  );
  assert.match(
    output,
    /To compare the content of the top results, run: extraktor extract https:\/\/developers\.cloudflare\.com\/workers\/platform\/limits\/ https:\/\/developers\.cloudflare\.com\/workers\/platform\/pricing\/\n$/u
  );
});

test("a guessed --related option names --serp", async () => {
  const { io, stderr } = await makeIo();
  assert.equal(await run(["search", "crm", "--related"], io), EXIT.usage);
  assert.match(stderr(), /--serp/u);
});

test("server-sent events responses are read", async (t) => {
  const structuredContent = { organic_results: [] };
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent } })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      )
    )
  );
  const { io, stdout } = await makeIo();
  assert.equal(await run(["search", "rare"], io), EXIT.ok);
  assert.match(stdout(), /No results\./u);
});

test("failures map to exit codes and print the server guidance", async (t) => {
  const cases = [
    {
      response: () =>
        Response.json(
          {
            error: "invalid_token",
            error_description: "The API key is not correct or not active.",
          },
          { status: 401 }
        ),
      exit: EXIT.access,
      text: /The API key is not correct or not active\.\nRun "extraktor login"/u,
    },
    {
      response: () =>
        rpcResult({
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "BILLING_REQUIRED",
                message: "API keys need an active Starter or Pro subscription.",
                retryable: false,
                guidance: "Stop. Tell the user to manage the subscription.",
              }),
            },
          ],
        }),
      exit: EXIT.access,
      text: /\(BILLING_REQUIRED\)\nStop\. Tell the user/u,
    },
    {
      response: () =>
        rpcResult({
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "PAGE_UNAVAILABLE",
                message: "The page did not load.",
                retryable: false,
                guidance: "Stop. Do not send this URL again.",
              }),
            },
          ],
        }),
      exit: EXIT.failure,
      text: /The page did not load\. \(PAGE_UNAVAILABLE\)/u,
    },
    {
      response: () => new Response("Bad gateway", { status: 502 }),
      exit: EXIT.failure,
      text: /HTTP 502\.\nTry again one time\./u,
    },
  ];
  for (const { response, exit, text } of cases) {
    t.mock.method(globalThis, "fetch", () => Promise.resolve(response()));
    const { io, stderr } = await makeIo();
    assert.equal(await run(["extract", "example.com"], io), exit);
    assert.match(stderr(), text);
    t.mock.restoreAll();
  }
});

test("usage errors and a missing key stop before any request", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch");
  const usage = [
    [],
    ["extract"],
    ["extract", "a.com", "b.com", "c.com", "d.com", "e.com", "f.com"],
    ["extract", "a.com", "b.com", "--offset", "5"],
    ["extract", "a.com", "b.com", "--screenshot-file", "x.png"],
    ["extract", "a.com", "--focus", "x"],
    ["extract", "a.com", "--find", " "],
    ["extract", "a.com", "--find", "x", "--offset", "5"],
    ["extract", "a.com", "--offset", "-1"],
    ["extract", "a.com", "--bogus"],
    ["extract", "cloudflare workers limits"],
    ["search"],
    ["fetch"],
    ["serch", "x"],
  ];
  for (const argv of usage) {
    const { io, stderr } = await makeIo();
    assert.equal(await run(argv, io), EXIT.usage, argv.join(" "));
    if (argv.length > 0) {
      // Each usage error gives the next step: the options, a command or help.
      assert.match(stderr(), /--help|Options for|Commands:/u, argv.join(" "));
    }
  }
  const unknown = await makeIo();
  await run(["extract", "a.com", "--bogus"], unknown.io);
  assert.equal(
    unknown.stderr().split("\n")[0],
    "Error: Unknown option --bogus."
  );

  const signedOut = await makeIo({ EXTRAKTOR_API_KEY: "" });
  assert.equal(await run(["extract", "a.com"], signedOut.io), EXIT.access);
  assert.match(signedOut.stderr(), /You are not signed in\./u);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("a screenshot is saved from the native image content", async (t) => {
  const png = Buffer.from("fake png bytes");
  t.mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.params.arguments.screenshot, { enabled: true });
    return Promise.resolve(
      extractResult(
        {
          screenshot: {
            status: "success",
            url: "/api/screenshots/abc",
            bytes: png.length,
          },
        },
        [
          {
            type: "resource_link",
            uri: "extraktor://screenshots/abc",
            name: "Screenshot",
          },
          {
            type: "image",
            data: png.toString("base64"),
            mimeType: "image/png",
          },
        ]
      )
    );
  });
  const { io, dir, stdout } = await makeIo();
  assert.equal(
    await run(
      ["extract", "https://example.com", "--screenshot-file", "shot.png"],
      io
    ),
    EXIT.ok
  );
  const file = path.join(dir, "shot.png");
  assert.deepEqual(await readFile(file), png);
  assert.match(
    stdout(),
    new RegExp(`Saved to ${file} \\(${png.length} bytes\\)`, "u")
  );
  assert.match(stdout(), /https:\/\/extraktor\.test\/api\/screenshots\/abc/u);
});

test("login --with-key saves a private key file; logout deletes it", async (t) => {
  const { io, stderr, dir } = await makeIo(
    { EXTRAKTOR_API_KEY: "" },
    `${KEY}\n`
  );
  assert.equal(await run(["login", "--with-key"], io), EXIT.ok);
  const file = credentialsPath(io.env);
  assert.ok(file.startsWith(dir));
  assert.equal((await stat(file)).mode.toString(8).slice(-3), "600");
  assert.match(stderr(), /Signed in to https:\/\/extraktor\.test\./u);

  t.mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => {
    assert.equal(
      new Headers(init.headers).get("authorization"),
      `Bearer ${KEY}`
    );
    return Promise.resolve(extractResult());
  });
  assert.equal(await run(["extract", "example.com"], io), EXIT.ok);

  assert.equal(await run(["logout"], io), EXIT.ok);
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal(await run(["extract", "example.com"], io), EXIT.access);

  const bad = await makeIo({ EXTRAKTOR_API_KEY: "" }, "not-a-key");
  assert.equal(await run(["login", "--with-key"], bad.io), EXIT.usage);
});

const URL_IN_LINE = /https?:\/\/\S+/u;

/** Starts a browser login and returns its result and the printed sign-in URL. */
const startLogin = () => {
  const { promise, resolve } = Promise.withResolvers<URL>();
  const login = loginWithBrowser({
    baseUrl: BASE,
    browser: false,
    log: (line) => {
      const match = URL_IN_LINE.exec(line);
      if (match) {
        resolve(new URL(match[0]));
      }
    },
  });
  return { login, url: promise };
};

const callbackOf = (url: URL) =>
  `http://127.0.0.1:${url.searchParams.get("port")}/callback`;

const postCallback = (url: URL, fields: Record<string, string>) =>
  fetch(callbackOf(url), { method: "POST", body: new URLSearchParams(fields) });

const stateOf = (url: URL) => url.searchParams.get("state") ?? "";

test("browser login accepts only a post with the matching state", async () => {
  const { login, url: opened } = startLogin();
  const url = await opened;
  assert.equal(url.pathname, "/cli/login");
  const outcome = assert.rejects(login, {
    message: "The browser did not send a correct key.",
  });
  assert.equal((await fetch(callbackOf(url))).status, 404);
  assert.equal(
    (await postCallback(url, { state: "wrong", key: KEY })).status,
    400
  );
  assert.equal(
    (await postCallback(url, { state: stateOf(url), key: "ext_short" })).status,
    400
  );
  await outcome;
});

test("browser login resolves with the key, and cancel rejects", async () => {
  const success = startLogin();
  const successUrl = await success.url;
  const response = await postCallback(successUrl, {
    state: stateOf(successUrl),
    key: KEY,
  });
  assert.match(await response.text(), /signed in/u);
  assert.equal(await success.login, KEY);

  const canceled = startLogin();
  const outcome = assert.rejects(canceled.login, {
    message: "The sign-in was canceled in the browser.",
  });
  const canceledUrl = await canceled.url;
  await postCallback(canceledUrl, {
    state: stateOf(canceledUrl),
    error: "access_denied",
  });
  await outcome;
});

test("the same command within 10 minutes uses the saved result, and --no-cache reads again", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(extractResult())
  );
  const { io, stdout } = await makeIo();
  assert.equal(await run(["extract", "example.com"], io), EXIT.ok);
  const first = stdout();
  assert.equal(await run(["extract", "example.com"], io), EXIT.ok);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(stdout(), first + first);
  // Different options are a different call.
  assert.equal(
    await run(["extract", "example.com", "--contacts"], io),
    EXIT.ok
  );
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(
    await run(["extract", "example.com", "--no-cache"], io),
    EXIT.ok
  );
  assert.equal(fetchMock.mock.callCount(), 3);
});

test("failed calls are not saved", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      rpcResult({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: "TIMEOUT",
              message: "The page did not load in time.",
              retryable: true,
            }),
          },
        ],
      })
    )
  );
  const { io } = await makeIo();
  assert.equal(await run(["extract", "example.com"], io), EXIT.failure);
  assert.equal(await run(["extract", "example.com"], io), EXIT.failure);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("a bare URL reads the page, and a large page says so at the top", async (t) => {
  t.mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.params.name, "extract");
    assert.deepEqual(body.params.arguments, {
      url: "https://example.com/docs",
      contacts: { enabled: true },
    });
    return Promise.resolve(extractResult({ markdown: longMarkdown() }));
  });
  const { io, stdout } = await makeIo();
  assert.equal(
    await run(["https://example.com/docs", "--contacts"], io),
    EXIT.ok
  );
  const lines = stdout().split("\n");
  assert.match(
    lines.at(3) ?? "",
    /^Part of the page: characters 0 to \d+ of \d+\. The next part starts at --offset \d+\./u
  );
});

test("--deep asks for the slower SEO checks and implies --seo", async (t) => {
  t.mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.params.arguments, {
      url: "https://example.com/",
      seo: { enabled: true, deep: true },
    });
    return Promise.resolve(extractResult({ markdown: "Text" }));
  });
  const { io } = await makeIo();
  assert.equal(
    await run(["extract", "https://example.com/", "--deep"], io),
    EXIT.ok
  );
});

const unavailable = () =>
  rpcResult({
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "PAGE_UNAVAILABLE",
          message: "The page did not load.",
          retryable: false,
          guidance: "Stop. Tell the user that a different source is necessary.",
        }),
      },
    ],
  });

test("a usage error names the fix and lists the options, with no help call", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch");
  const cases = [
    [["extract", "a.com", "--filter", "x"], /Did you mean --find\?/u],
    [["extract", "a.com", "--screnshot"], /Did you mean --screenshot\?/u],
    [["extract", "a.com", "--exerpts"], /Did you mean --excerpts\?/u],
    [["extract", "a.com", "--find"], /--find needs a value/u],
    [["serch", "x"], /Did you mean "extraktor search"\?/u],
    [
      ["extract", "cloudflare workers limits"],
      /run: extraktor search "cloudflare workers limits"/u,
    ],
  ] as const;
  for (const [argv, message] of cases) {
    const { io, stderr } = await makeIo();
    assert.equal(await run([...argv], io), EXIT.usage, argv.join(" "));
    assert.match(stderr(), message, argv.join(" "));
  }
  const options = await makeIo();
  await run(["extract", "a.com", "--filter", "x"], options.io);
  assert.match(
    options.stderr(),
    /^Options for extract: --find <text>, --offset <n>, .*--no-cache\.$/mu
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("read, fetch, get, scrape and open run extract", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(extractResult())
  );
  for (const alias of ["read", "fetch", "get", "scrape", "open"]) {
    const { io, stdout } = await makeIo();
    assert.equal(await run([alias, "example.com"], io), EXIT.ok, alias);
    assert.match(stdout(), /^# Example Domain/u, alias);
  }
  assert.equal(fetchMock.mock.callCount(), 5);
});

test("--find and --offset use the complete page text of one request", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    (_url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      // The CLI finds text itself. The server gets no find and no offset.
      assert.deepEqual(body.params.arguments, {
        url: "https://example.com/docs",
      });
      return Promise.resolve(
        extractResult({
          markdown: `${longMarkdown()}\n## Miscellaneous\n\n599 Network Connect Timeout Error\n\n## Prices\n\nPro costs $10 per month.\n`,
        })
      );
    }
  );
  const { io, stdout } = await makeIo();
  assert.equal(
    await run(
      [
        "extract",
        "https://example.com/docs",
        "--find",
        " 599 ",
        "--find",
        "per month",
      ],
      io
    ),
    EXIT.ok
  );
  const output = stdout();
  assert.match(
    output,
    /^Find "599": searched the complete page\. 1 section matches\./mu
  );
  assert.match(output, /^Find "per month": searched the complete page\./mu);
  assert.match(output, /## Matches for "599"\n\n## Miscellaneous\n\n599 /u);
  assert.match(output, /## Matches for "per month"\n\n## Prices/u);
  assert.doesNotMatch(output, /## Page text/u);
  assert.match(output, /- ## Miscellaneous \(offset \d+\)/u);
  assert.match(
    output,
    /run: extraktor extract https:\/\/example\.com\/docs --offset <offset>/u
  );
  const offset = Number(
    /Miscellaneous \(offset (?<offset>\d+)\)/u.exec(output)?.groups?.offset
  );
  const part = await makeIo({ XDG_CACHE_HOME: io.env.XDG_CACHE_HOME });
  assert.equal(
    await run(
      ["extract", "https://example.com/docs", "--offset", String(offset)],
      part.io
    ),
    EXIT.ok
  );
  assert.match(part.stdout(), /## Page text\n\n## Miscellaneous\n\n599/u);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("--find with no match prints the outline", async (t) => {
  t.mock.method(globalThis, "fetch", () => Promise.resolve(extractResult()));
  const { io, stdout } = await makeIo();
  assert.equal(
    await run(["extract", "example.com", "--find", "zzz"], io),
    EXIT.ok
  );
  assert.match(stdout(), /The page text does not contain it\./u);
  assert.match(stdout(), /Page outline:\n- # Example Domain \(offset 0\)/u);
});

test("a read with an output keeps the page for a later read, --find and --offset", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      extractResult({
        contacts: {
          status: "success",
          emails: [{ address: "a@example.com", label: null }],
          phones: [],
        },
      })
    )
  );
  const { io, stdout } = await makeIo();
  assert.equal(
    await run(["extract", "example.com", "--contacts"], io),
    EXIT.ok
  );
  assert.equal(
    await run(["extract", "example.com", "--find", "domain"], io),
    EXIT.ok
  );
  assert.equal(fetchMock.mock.callCount(), 1);
  // The later read has no contacts section: the agent did not ask for it.
  assert.equal(stdout().split("## Contacts").length, 2);
});

test("--contacts prints each kind of contact detail and the next page to read", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      extractResult({
        contacts: {
          status: "success",
          emails: [],
          phones: [
            {
              label: "Fax",
              number: "+4930123456",
              source: "text",
              text: "030 123456",
            },
          ],
          addresses: [
            {
              country: "DE",
              label: "Headquarters",
              locality: "Berlin",
              postalCode: "10115",
              region: null,
              source: "text",
              street: "Musterstraße 1",
              text: "Musterstraße 1, 10115 Berlin",
            },
          ],
          profiles: [
            {
              handle: "example",
              network: "linkedin",
              source: "link",
              url: "https://www.linkedin.com/company/example",
            },
          ],
          organization: {
            legalName: "Example GmbH",
            name: "Example",
            registrationId: "HRB 12345",
            vatId: "DE123456789",
          },
        },
      })
    )
  );
  const { io, stdout } = await makeIo();
  assert.equal(
    await run(["extract", "example.com", "--contacts"], io),
    EXIT.ok
  );
  const output = stdout();
  assert.match(output, /Emails: none/u);
  assert.match(output, /- 030 123456 \[\+4930123456\] \(Fax\)/u);
  assert.match(
    output,
    /- Musterstraße 1, 10115 Berlin \[DE\] \(Headquarters\)/u
  );
  assert.match(
    output,
    /- LinkedIn: https:\/\/www\.linkedin\.com\/company\/example/u
  );
  assert.match(output, /- Registration: HRB 12345\n- VAT ID: DE123456789/u);
});

test("contacts with profiles only show the contact page as the next step", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      extractResult({
        contacts: {
          status: "success",
          emails: [],
          phones: [],
          addresses: [],
          profiles: [
            {
              handle: "@example",
              network: "x",
              source: "json-ld",
              url: "https://x.com/example",
            },
          ],
          organization: null,
          contactPages: ["https://example.com/impressum"],
          message:
            "This page gives no email address, phone number or postal address. Extract the first URL in contactPages with contacts enabled.",
        },
      })
    )
  );
  const { io, stdout } = await makeIo();
  assert.equal(
    await run(["extract", "example.com", "--contacts"], io),
    EXIT.ok
  );
  assert.match(
    stdout(),
    /- X: https:\/\/x\.com\/example[\s\S]*Next: extraktor extract https:\/\/example\.com\/impressum --contacts/u
  );
});

test("--save writes the complete page text and --design-file writes DESIGN.md", async (t) => {
  const markdown = longMarkdown();
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      extractResult({
        markdown,
        design: { status: "success", markdown: "---\nname: Example\n---" },
      })
    )
  );
  const { io, dir, stdout } = await makeIo();
  assert.equal(
    await run(
      [
        "extract",
        "example.com",
        "--save",
        "page.md",
        "--design-file",
        "DESIGN.md",
      ],
      io
    ),
    EXIT.ok
  );
  assert.equal(await readFile(path.join(dir, "page.md"), "utf-8"), markdown);
  assert.equal(
    await readFile(path.join(dir, "DESIGN.md"), "utf-8"),
    "---\nname: Example\n---\n"
  );
  const output = stdout();
  assert.match(output, /Saved the complete page text \(\d+ characters\)/u);
  assert.match(output, /Saved DESIGN\.md to /u);
  assert.doesNotMatch(output, /Text of section/u);
  assert.match(output, /- ## Section 30 \(offset \d+\)/u);
});

test("schema.org data prints as short facts before the page text", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      extractResult({
        structuredData: [
          {
            "@context": "https://schema.org",
            "@type": "Recipe",
            name: "Cookies",
            aggregateRating: {
              "@type": "AggregateRating",
              ratingValue: "4.6",
              ratingCount: "19331",
            },
            recipeInstructions: [
              { text: "a" },
              { text: "b" },
              { text: "c" },
              { text: "d" },
            ],
          },
        ],
      })
    )
  );
  const { io, stdout } = await makeIo();
  assert.equal(await run(["extract", "example.com"], io), EXIT.ok);
  const output = stdout();
  assert.match(
    output,
    /- @type: Recipe\n- name: Cookies\n- aggregateRating\.ratingValue: 4\.6\n- aggregateRating\.ratingCount: 19331\n- recipeInstructions: 4 items/u
  );
  assert.doesNotMatch(output, /@context|AggregateRating/u);
  assert.ok(
    output.indexOf("## Structured data") < output.indexOf("## Page text")
  );
});

test("several long pages share one output that agents can see completely", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(extractResult({ markdown: longMarkdown() }))
  );
  const { io, stdout } = await makeIo();
  assert.equal(
    await run(
      ["extract", "a.example.com", "b.example.com", "c.example.com"],
      io
    ),
    EXIT.ok
  );
  const output = stdout();
  assert.ok(output.length < 25_000, String(output.length));
  assert.equal(output.split("For the next part, run:").length, 4);
});

test("several URLs load at the same time, and a failed page keeps the others", async (t) => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: URL, init: RequestInit) => {
      const { url } = JSON.parse(String(init.body)).params.arguments;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight -= 1;
      return url === "down.example"
        ? unavailable()
        : extractResult({
            finalUrl: `https://${url}/`,
            metadata: { ...page().metadata, title: `Title of ${url}` },
          });
    }
  );
  const { io, stdout, stderr } = await makeIo();
  assert.equal(
    await run(["extract", "a.example", "down.example", "b.example"], io),
    EXIT.failure
  );
  assert.equal(fetchMock.mock.callCount(), 3);
  assert.equal(maxInFlight, 3);
  const output = stdout();
  assert.match(
    output,
    /^===== Page 1 of 3: a\.example =====\n\n# Title of a\.example/u
  );
  assert.match(
    output,
    /[=]==== Page 2 of 3: down\.example =====\n\nError: The page did not load\. \(PAGE_UNAVAILABLE\)\nStop\./u
  );
  assert.match(
    output,
    /[=]==== Page 3 of 3: b\.example =====\n\n# Title of b\.example/u
  );
  assert.match(
    stderr(),
    /1 of 3 pages failed\. The output has the other pages\./u
  );
});

test("--json prints results and errors as JSON on standard output", async (t) => {
  t.mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => {
    const { url } = JSON.parse(String(init.body)).params.arguments;
    return Promise.resolve(
      url === "down.example" ? unavailable() : extractResult()
    );
  });
  const single = await makeIo();
  assert.equal(
    await run(["extract", "down.example", "--json"], single.io),
    EXIT.failure
  );
  assert.deepEqual(JSON.parse(single.stdout()), {
    error: {
      code: "PAGE_UNAVAILABLE",
      message: "The page did not load.",
      guidance: "Stop. Tell the user that a different source is necessary.",
      exitCode: EXIT.failure,
    },
  });
  assert.equal(single.stderr(), "");

  const usage = await makeIo();
  assert.equal(
    await run(["extract", "a.com", "--bogus", "--json"], usage.io),
    EXIT.usage
  );
  assert.equal(JSON.parse(usage.stdout()).error.code, "INVALID_USAGE");

  const several = await makeIo();
  assert.equal(
    await run(["extract", "example.com", "down.example", "--json"], several.io),
    EXIT.failure
  );
  const pages = JSON.parse(several.stdout());
  assert.equal(pages.length, 2);
  assert.equal(pages[0].url, "example.com");
  assert.equal(pages[0].metadata.title, "Example Domain");
  assert.deepEqual(pages[1], {
    url: "down.example",
    error: {
      code: "PAGE_UNAVAILABLE",
      message: "The page did not load.",
      guidance: "Stop. Tell the user that a different source is necessary.",
      exitCode: EXIT.failure,
    },
  });
});

test("the request names the coding agent that runs the CLI", async (t) => {
  const agents: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => {
    agents.push(new Headers(init.headers).get("x-extraktor-agent"));
    return Promise.resolve(extractResult());
  });
  for (const env of [
    { CLAUDECODE: "1" },
    { CODEX_THREAD_ID: "thread-1" },
    { AI_AGENT: "Some-Agent" },
    { AI_AGENT: "not a name!" },
    {},
  ]) {
    const { io } = await makeIo(env);
    await run(["extract", "example.com", "--no-cache"], io);
  }
  assert.deepEqual(agents, ["claude-code", "codex", "some-agent", null, null]);
});

test("--messaging prints the positioning, then the site text", async (t) => {
  const messaging = {
    status: "success",
    headline: "Ship faster",
    subheadline: null,
    primaryCta: { text: "Start free", url: "https://example.com/signup" },
    secondaryCta: null,
    benefits: ["Less noise"],
    differentiators: [],
    proof: {
      metrics: ["10,000+ teams"],
      testimonials: [
        { quote: "It works.", person: "Ana", role: "CTO", company: null },
      ],
      customers: ["Acme"],
      awards: [],
      certifications: ["SOC 2"],
      reviewBadges: [],
    },
    positioning: {
      category: "Issue tracker",
      audience: "Software teams.",
      valueProposition: "Teams plan work fast.",
      painPoints: ["Slow tools"],
      tone: ["confident"],
    },
  };
  t.mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.params.arguments.messaging, { enabled: true });
    return Promise.resolve(extractResult({ messaging }));
  });
  const { io, stderr, stdout } = await makeIo();
  const code = await run(["extract", "example.com", "--messaging"], io);
  assert.equal(code, EXIT.ok, stderr());
  const out = stdout();
  assert.match(out, /Headline: Ship faster/u);
  assert.match(out, /Subheadline: not on the page/u);
  assert.match(
    out,
    /Primary CTA: Start free \(https:\/\/example\.com\/signup\)/u
  );
  assert.match(out, /- Metrics: 10,000\+ teams/u);
  assert.match(out, /> It works\.\n> \(Ana, CTO\)/u);
  assert.match(
    out,
    /Positioning \(Extraktor's words, not site text\):\n- Category: Issue tracker\n/u
  );
  assert.doesNotMatch(out, /confidence/u);
  assert.ok(out.indexOf("Positioning") < out.indexOf("Headline:"));
});

test("--messaging on a page that is not a marketing page prints the next step", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      extractResult({
        messaging: {
          status: "empty",
          message:
            "This page is not a marketing page. Extract the home page with messaging enabled: https://example.com/",
        },
      })
    )
  );
  const { io, stdout } = await makeIo();
  assert.equal(
    await run(["extract", "example.com/docs", "--messaging"], io),
    EXIT.ok
  );
  assert.match(
    stdout(),
    /Not available: This page is not a marketing page\. Extract the home page/u
  );
});
