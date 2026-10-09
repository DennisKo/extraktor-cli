/* oxlint-disable no-await-in-loop -- Cases that share a pattern run in order, each with its own home directory. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { z } from "zod";

import { EXIT } from "../src/errors.ts";
import { MAIN_HELP } from "../src/help.ts";
import type { Exec } from "../src/install.ts";
import { run } from "../src/run.ts";
import type { Io } from "../src/run.ts";

const URL = "https://extraktor.app/mcp";
const VSCODE_DIR = ["Library", "Application Support", "Code", "User"];

/** A fake `claude` CLI that keeps its servers in memory, like the real one. */
const fakeClaude = () => {
  const servers = new Set<string>();
  const calls: string[][] = [];
  const exec: Exec = (file, args) => {
    calls.push([file, ...args]);
    const name = args.at(args[1] === "add" ? -2 : -1) ?? "";
    if (args[1] === "add") {
      if (servers.has(name)) {
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: `MCP server ${name} already exists in user config\n`,
        });
      }
      servers.add(name);
      return Promise.resolve({ code: 0, stdout: "Added\n", stderr: "" });
    }
    if (servers.delete(name)) {
      return Promise.resolve({ code: 0, stdout: "Removed\n", stderr: "" });
    }
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: `No MCP server named "${name}" in user scope\n`,
    });
  };
  return { calls, exec, servers };
};

const missingProgram: Exec = (file) =>
  Promise.reject(
    Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" })
  );

/** A home directory with the config directory of each agent in `agents`. */
const AGENT_DIRS = {
  codex: [".codex"],
  cursor: [".cursor"],
  vscode: VSCODE_DIR,
  "gemini-cli": [".gemini"],
  windsurf: [".codeium", "windsurf"],
} satisfies Record<string, string[]>;

const makeHome = async (agents: (keyof typeof AGENT_DIRS)[]) => {
  const home = await mkdtemp(path.join(tmpdir(), "extraktor-install-"));
  for (const agent of agents) {
    await mkdir(path.join(home, ...AGENT_DIRS[agent]), { recursive: true });
  }
  return home;
};

const makeIo = (home: string, exec: Exec) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: { HOME: home },
    readStdin: () => Promise.resolve(""),
    cwd: home,
    exec,
    platform: "darwin",
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
};

const readJson = async (file: string) =>
  z.json().parse(JSON.parse(await readFile(file, "utf-8")));

test("mcp add adds the server to each agent that it finds", async () => {
  const home = await makeHome(["codex", "cursor", "vscode", "gemini-cli"]);
  const claude = fakeClaude();
  const { io, stdout } = makeIo(home, claude.exec);

  assert.equal(await run(["mcp", "add"], io), EXIT.ok);

  assert.deepEqual(claude.calls, [
    [
      "claude",
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "extraktor",
      URL,
    ],
  ]);
  assert.equal(
    await readFile(path.join(home, ".codex", "config.toml"), "utf-8"),
    `[mcp_servers.extraktor]\nurl = "${URL}"\n`
  );
  assert.deepEqual(await readJson(path.join(home, ".cursor", "mcp.json")), {
    mcpServers: { extraktor: { url: URL } },
  });
  assert.deepEqual(await readJson(path.join(home, ...VSCODE_DIR, "mcp.json")), {
    servers: { extraktor: { type: "http", url: URL } },
  });
  assert.deepEqual(
    await readJson(path.join(home, ".gemini", "settings.json")),
    {
      mcpServers: { extraktor: { httpUrl: URL } },
    }
  );
  const output = stdout();
  assert.match(output, /Added to:\n {2}- Claude Code\. Next: Run \/mcp/u);
  assert.match(
    output,
    /- Codex\. Next: Run: codex mcp login extraktor --scopes profile/u
  );
  assert.match(output, /Not found on this computer: Windsurf\./u);
  assert.match(output, /Claude app \(desktop and web\)/u);
});

test("mcp add a second time changes nothing", async () => {
  const home = await makeHome(["codex", "cursor"]);
  const claude = fakeClaude();
  const first = makeIo(home, claude.exec);
  assert.equal(await run(["mcp", "add"], first.io), EXIT.ok);
  const cursorFile = path.join(home, ".cursor", "mcp.json");
  const before = await readFile(cursorFile, "utf-8");

  const second = makeIo(home, claude.exec);
  assert.equal(await run(["mcp", "add"], second.io), EXIT.ok);

  assert.equal(await readFile(cursorFile, "utf-8"), before);
  assert.match(
    second.stdout(),
    /Already added \(no change\):\n {2}- Claude Code\n {2}- Codex\n {2}- Cursor\n/u
  );
  assert.doesNotMatch(second.stdout(), /Added to:/u);
});

test("mcp add keeps the other servers and settings", async () => {
  const home = await makeHome(["codex", "cursor"]);
  const toml =
    'model = "o3"\n\n[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n';
  await writeFile(path.join(home, ".codex", "config.toml"), toml);
  await writeFile(
    path.join(home, ".cursor", "mcp.json"),
    JSON.stringify({ theme: "dark", mcpServers: { linear: { url: "x" } } })
  );
  const { io } = makeIo(home, missingProgram);

  assert.equal(await run(["mcp", "add"], io), EXIT.ok);

  assert.equal(
    await readFile(path.join(home, ".codex", "config.toml"), "utf-8"),
    `${toml}\n[mcp_servers.extraktor]\nurl = "${URL}"\n`
  );
  assert.deepEqual(await readJson(path.join(home, ".cursor", "mcp.json")), {
    theme: "dark",
    mcpServers: { linear: { url: "x" }, extraktor: { url: URL } },
  });
});

test("mcp add finds an existing Codex server in any TOML form", async () => {
  for (const toml of [
    '[mcp_servers."extraktor"]\nurl = "x"\n',
    '[mcp_servers.extraktor.env_http_headers]\nA = "B"\n',
    'mcp_servers.extraktor.url = "x"\n',
    '[mcp_servers]\nextraktor = { url = "x" }\n',
  ]) {
    const home = await makeHome(["codex"]);
    const file = path.join(home, ".codex", "config.toml");
    await writeFile(file, toml);
    const { io, stdout } = makeIo(home, missingProgram);

    assert.equal(await run(["mcp", "add"], io), EXIT.ok, toml);
    assert.equal(await readFile(file, "utf-8"), toml);
    assert.match(stdout(), /Already added \(no change\):\n {2}- Codex/u);
  }
});

test("mcp remove removes the server and keeps the rest", async () => {
  const home = await makeHome(["codex", "cursor"]);
  const claude = fakeClaude();
  assert.equal(
    await run(["mcp", "add"], makeIo(home, claude.exec).io),
    EXIT.ok
  );
  const codexFile = path.join(home, ".codex", "config.toml");
  await writeFile(
    codexFile,
    `${await readFile(codexFile, "utf-8")}\n[mcp_servers.extraktor.env_http_headers]\nA = "B"\n\n[mcp_servers.linear]\nurl = "y"\n`
  );
  const { io, stdout } = makeIo(home, claude.exec);

  assert.equal(await run(["mcp", "remove"], io), EXIT.ok);

  assert.equal(claude.servers.size, 0);
  assert.equal(
    await readFile(codexFile, "utf-8"),
    '[mcp_servers.linear]\nurl = "y"\n'
  );
  assert.deepEqual(await readJson(path.join(home, ".cursor", "mcp.json")), {
    mcpServers: {},
  });
  assert.match(
    stdout(),
    /Removed from:\n {2}- Claude Code\n {2}- Codex\n {2}- Cursor\n/u
  );
  assert.doesNotMatch(stdout(), /Claude app/u);

  const again = makeIo(home, claude.exec);
  assert.equal(await run(["mcp", "remove"], again.io), EXIT.ok);
  assert.match(again.stdout(), /Not present \(no change\):/u);
});

test("mcp add does not change a config that is not plain JSON", async () => {
  const home = await makeHome(["cursor", "vscode"]);
  const file = path.join(home, ".cursor", "mcp.json");
  const jsonc = '{\n  // my servers\n  "mcpServers": {}\n}\n';
  await writeFile(file, jsonc);
  const { io, stdout, stderr } = makeIo(home, missingProgram);

  assert.equal(await run(["mcp", "add"], io), EXIT.failure);

  assert.equal(await readFile(file, "utf-8"), jsonc);
  assert.match(stdout(), /Added to:\n {2}- VS Code/u);
  assert.match(
    stdout(),
    /Failed:\n {2}- Cursor: .*mcp\.json is not plain JSON/u
  );
  assert.match(stderr(), /1 of 2 agents failed/u);
});

test("mcp add stops with the next step when no agent is found", async () => {
  const home = await makeHome([]);
  const { io, stdout, stderr } = makeIo(home, missingProgram);

  assert.equal(await run(["mcp", "add"], io), EXIT.failure);

  assert.equal(stdout(), "");
  assert.match(stderr(), /No coding agent was found on this computer\./u);
  assert.match(
    stderr(),
    /add https:\/\/extraktor\.app\/mcp to your MCP client by hand/u
  );
});

test("mcp add --agent changes only the given agents", async () => {
  const home = await makeHome(["codex", "cursor"]);
  const claude = fakeClaude();
  const { io, stdout } = makeIo(home, claude.exec);

  assert.equal(
    await run(["mcp", "add", "--agent", "cursor", "--json"], io),
    EXIT.ok
  );

  assert.equal(claude.calls.length, 0);
  assert.deepEqual(JSON.parse(stdout()), {
    action: "add",
    url: URL,
    agents: [
      {
        id: "cursor",
        name: "Cursor",
        status: "added",
        next: "Open Cursor's MCP settings and sign in to extraktor.",
      },
    ],
  });
});

test("mcp usage errors name the fix", async () => {
  const home = await makeHome([]);
  const agent = makeIo(home, missingProgram);
  assert.equal(
    await run(["mcp", "add", "--agent", "cusor"], agent.io),
    EXIT.usage
  );
  assert.match(
    agent.stderr(),
    /"cusor" is not an agent\. Did you mean "--agent cursor"\?/u
  );

  const action = makeIo(home, missingProgram);
  assert.equal(await run(["mcp", "install"], action.io), EXIT.usage);
  assert.match(
    action.stderr(),
    /Use "extraktor mcp add" or "extraktor mcp remove"/u
  );
});

test("setup and install run mcp add", async () => {
  for (const command of ["setup", "install"]) {
    const home = await makeHome(["cursor"]);
    const { io } = makeIo(home, missingProgram);
    assert.equal(await run([command], io), EXIT.ok);
    assert.deepEqual(await readJson(path.join(home, ".cursor", "mcp.json")), {
      mcpServers: { extraktor: { url: URL } },
    });
  }
});

test("mcp add uses EXTRAKTOR_URL for a local server", async () => {
  const home = await makeHome(["cursor"]);
  const { io } = makeIo(home, missingProgram);
  io.env.EXTRAKTOR_URL = "http://localhost:3847";

  assert.equal(await run(["mcp", "add"], io), EXIT.ok);

  assert.deepEqual(await readJson(path.join(home, ".cursor", "mcp.json")), {
    mcpServers: { extraktor: { url: "http://localhost:3847/mcp" } },
  });
});

test("the main help shows mcp add", () => {
  assert.match(
    MAIN_HELP,
    /extraktor mcp add {2,}Add the Extraktor MCP server/u
  );
});
