#!/usr/bin/env node
import { access, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve a linked skill back to its checkout/package. Do not spawn another Node process.
const script = await realpath(fileURLToPath(import.meta.url));
const root = process.env.JEV_BROWSER_ROOT
  ? resolve(process.env.JEV_BROWSER_ROOT)
  : resolve(dirname(script), '../../..');
const entry = resolve(root, 'dist/agent-cli.js');
try {
  await access(entry);
} catch {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'SKILL_SETUP_REQUIRED',
    message: 'Cannot find the built Jev isolation entry. Build this fork, or set JEV_BROWSER_ROOT to its built checkout/package root.' } })}\n`);
  process.exit(1);
}
process.argv[1] = entry;
await import(pathToFileURL(entry).href);
