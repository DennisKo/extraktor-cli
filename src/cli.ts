#!/usr/bin/env node
import { text } from "node:stream/consumers";

import { run } from "./run.ts";

const exitCode = await run(process.argv.slice(2), {
  stdout: (output) => process.stdout.write(output),
  stderr: (output) => process.stderr.write(output),
  env: process.env,
  readStdin: () => text(process.stdin),
  cwd: process.cwd(),
  interactive:
    Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI,
});
process.exitCode = exitCode;
