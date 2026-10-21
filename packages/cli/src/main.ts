#!/usr/bin/env node
import { run } from "./cli.js";

run(process.argv.slice(2), { env: process.env, stdout: process.stdout, stderr: process.stderr }).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`deskhand: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
