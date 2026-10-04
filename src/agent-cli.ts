#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { agentPaths, prepareAgent, xCookies } from './agent-runtime.js';
import { hasSession, openSession, sendSession } from './sessions.js';
import { parseCapabilities } from './capabilities.js';
import { publicError } from './errors.js';

const help = `jev-browser-agent --agent NAME COMMAND [--args JSON]

  open [URL]       Start/reuse this agent's headless persistent Chromium
  goto URL         Navigate this agent's browser
  snapshot         Read the current page
  close            Close only this agent's browser; retain its profile
  call COMMAND     Any existing Jev command, validated by the session worker
  import-x         Import only x.com cookies while this agent is closed

Options:
  --agent NAME             Required lowercase agent identifier
  --args JSON              Command arguments (same schema as jev-browser)
  --caps GROUPS            Capabilities fixed at open (storage,network,trace,evaluate)
  --executable-path PATH   Optional Chromium binary for open/import-x
  --state FILE             Playwright storage state for import-x only
  --cdp-endpoint URL       Explicit source connection for import-x only

JEV_AGENT_HOME overrides the state root. Each agent owns profile/runtime/output
directories. Normal commands never attach to your personal Chrome. import-x
reads the authorized source once, never modifies it, and prints no cookie values.
This is state isolation, not an OS sandbox. No automatic retries.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, agent: { type: 'string' }, args: { type: 'string' },
    caps: { type: 'string', multiple: true }, 'executable-path': { type: 'string' },
    state: { type: 'string' }, 'cdp-endpoint': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(help); return; }
  if (!values.agent) throw new Error('--agent is required.');
  const paths = agentPaths(values.agent);
  const statePath = values.state ? resolve(values.state) : undefined;
  const executablePath = values['executable-path'] ? resolve(values['executable-path']) : undefined;
  const [command, ...words] = positionals;
  if (!command) throw new Error('A command is required. See --help.');
  if (command !== 'import-x' && (values.state || values['cdp-endpoint'])) throw new Error('Source state/CDP options are allowed only with import-x.');
  if (!['open', 'import-x'].includes(command) && (values.caps || values['executable-path'])) throw new Error('Launch options belong on open, not on subsequent commands.');
  if (command === 'open' || command === 'import-x') await prepareAgent(paths);
  // Stable cwd makes the existing Jev session namespace independent of the caller's project.
  process.chdir(paths.directory);
  process.env.JEV_SESSION_DIR = paths.runtime;
  const session = 'browser';
  const launchOptions = executablePath ? { executablePath } : undefined;
  let result: unknown;
  if (command === 'import-x') {
    if (words.length || values.args || values.caps || !!values.state === !!values['cdp-endpoint'])
      throw new Error('import-x requires exactly one of --state or --cdp-endpoint, and no command arguments.');
    if (await hasSession(session)) throw new Error('Close this agent before importing X cookies.');
    const { chromium } = await import('playwright-core');
    let cookies;
    if (values.state) {
      // Provider/parser errors may contain secrets. The outer error handler deliberately redacts them.
      cookies = xCookies(JSON.parse(await readFile(statePath!, 'utf8')));
    } else {
      const source = await chromium.connectOverCDP(values['cdp-endpoint']!);
      try {
        const context = source.contexts()[0];
        if (!context) throw new Error('Source browser has no context.');
        cookies = xCookies({ cookies: await context.cookies('https://x.com') });
      } finally { await source.close(); } // Disconnect only; borrowed pages stay open.
    }
    const target = await chromium.launchPersistentContext(paths.profile, { headless: true, ...launchOptions });
    try { await target.addCookies(cookies); }
    finally { await target.close(); }
    result = { agent: values.agent, importedCookies: cookies.length, domain: 'x.com', status: 'imported' };
  } else if (command === 'open') {
    if (words.length > 1 || values.args) throw new Error('open accepts at most one URL.');
    const capabilities = parseCapabilities(values.caps);
    result = await openSession(session, { browser: 'chromium', headless: true, userDataDir: paths.profile,
      outputDir: paths.output, fileRoots: [], launchOptions, allowEvaluate: capabilities.includes('evaluate') }, words[0], 1_800_000, capabilities);
  } else {
    const name = command === 'call' ? words.shift() : command;
    if (!name) throw new Error('call requires a command name.');
    const args: unknown = values.args ? JSON.parse(values.args) : {};
    if (!args || typeof args !== 'object' || Array.isArray(args) || 'command' in args) throw new Error('--args must be an object without a command field.');
    if (name === 'goto' && words.length === 1 && !values.args) Object.assign(args, { url: words.shift() });
    if (words.length) throw new Error('Use --args JSON for command arguments.');
    // The worker parses the shared command schema and enforces the capabilities fixed at open.
    result = await sendSession(session, { ...args, command: name } as Parameters<typeof sendSession>[1]);
    if (result && typeof result === 'object' && 'status' in result && ['stopped', 'unverified', 'dialog'].includes(String(result.status))) process.exitCode = 2;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}
main().catch(error => {
  process.exitCode = 1;
  // Import parsing/Playwright errors can echo cookie payloads; never serialize those errors.
  const importing = process.argv.includes('import-x');
  process.stdout.write(`${JSON.stringify({ ok: false, error: importing ? { code: 'X_IMPORT_FAILED',
    message: 'X import failed. Check the source, browser installation and that this agent is closed; no source browser state was changed.' } : publicError(error) })}\n`);
});
