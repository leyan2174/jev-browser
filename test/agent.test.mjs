import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentPaths, xCookies } from '../dist/agent-runtime.js';
import { httpServer } from './helpers.mjs';

const entry = fileURLToPath(new URL('../dist/agent-cli.js', import.meta.url));
const cookie = { name: 'synthetic', value: 'test-secret-never-real', domain: '.x.com', path: '/', expires: Math.floor(Date.now()/1000)+3600, httpOnly: true, secure: true, sameSite: 'Lax' };
test('Windows session worker does not create a visible console window', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-console-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const probe = fileURLToPath(new URL('./windows-console.ps1', import.meta.url));
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-File', probe, '-Entry', entry, '-NodePath', process.execPath, '-AgentHome', root], { windowsHide: true, timeout: 60000 });
  const result = JSON.parse(stdout);
  assert.equal(result.newVisibleConsoleWindows, 0);
  for (const key of ['opened','healthy','snapshot','closed']) assert.equal(result[key], true);
});
test('agent client startup does not load Playwright, provider SDK or MCP', async () => {
  const script = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (/^(playwright-core|@typesafe-ai|@modelcontextprotocol)/.test(specifier)) throw new Error('Heavy dependency in agent client: ' + specifier);
      return next(specifier, context);
    }});
    process.argv = [process.execPath, ${JSON.stringify(entry)}, '--help'];
    await import(${JSON.stringify(new URL('../dist/agent-cli.js', import.meta.url).href)});`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
  assert.match(stdout, /import-x/);
});
function cli(root, agent, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, '--agent', agent, ...args], { cwd, env: { ...process.env, JEV_AGENT_HOME: root, JEV_SESSION_DIR: join(root, 'wrong-shared-runtime'), JEV_API_KEY: '', TYPESAFE_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr, body: JSON.parse(stdout) }));
  });
}
async function ok(root, agent, args, cwd) {
  const output = await cli(root, agent, args, cwd);
  assert.equal(output.code, 0, output.stdout + output.stderr);
  return output.body.result;
}

test('agent paths reject traversal, case collisions and reserved Windows names; X filter is domain exact', () => {
  for (const name of ['', '../escape', 'Mixed', 'con', 'nul', 'a/b', 'x'.repeat(65)]) assert.throws(() => agentPaths(name));
  assert.notEqual(agentPaths('first').runtime, agentPaths('second').runtime);
  const state = { cookies: [cookie, ...['evilx.com', 'x.com.evil.test', 'google.com'].map(domain => ({ ...cookie, domain }))], origins: [{ origin: 'https://google.com', localStorage: [{ name: 'secret', value: 'no' }] }] };
  assert.deepEqual(xCookies(state), [cookie]);
  const partitioned = { ...cookie, partitionKey: 'https://x.com' };
  assert.deepEqual(xCookies({ cookies: [partitioned] }), [partitioned]);
  assert.throws(() => xCookies({ cookies: [{ ...cookie, domain: 'google.com' }] }));
  assert.throws(() => xCookies({ cookies: [{ ...cookie, value: 1 }] }));
});

test('two agents isolate concurrent profiles, runtime, cookies, localStorage and close; restart persists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-agents-'));
  const server = await httpServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<h1>${req.url}</h1>`); });
  t.after(async () => { await Promise.all(['a','b'].map(name => cli(root, name, ['close']))); await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  await Promise.all(['a', 'b'].map(name => ok(root, name, ['open', server.url + '/' + name, '--caps', 'storage'])));
  await ok(root, 'a', ['call', 'storage', '--args', JSON.stringify({ area: 'local', action: 'set', name: 'owner', value: 'a' })]);
  await ok(root, 'a', ['call', 'cookies', '--args', JSON.stringify({ action: 'add', cookies: [{ name: 'owner', value: 'a', url: server.url, expires: Math.floor(Date.now()/1000)+3600 }] })]);
  const bState = await ok(root, 'b', ['call', 'storage', '--args', JSON.stringify({ area: 'local', action: 'get', name: 'owner' })]);
  assert.ok(!JSON.stringify(bState).includes('"a"'));
  const bCookies = await ok(root, 'b', ['call', 'cookies', '--args', '{"action":"list"}']);
  assert.ok(!JSON.stringify(bCookies).includes('owner'));
  await ok(root, 'b', ['call', 'assert', '--args', '{"target":"h1","property":"text","expected":"/b"}'], tmpdir());
  await ok(root, 'a', ['close']);
  await ok(root, 'b', ['call', 'assert', '--args', '{"target":"h1","property":"text","expected":"/b"}']);
  await ok(root, 'a', ['open', server.url, '--caps', 'storage']);
  assert.match(JSON.stringify(await ok(root, 'a', ['call', 'storage', '--args', '{"area":"local","action":"get","name":"owner"}'])), /"a"/);
  assert.match(JSON.stringify(await ok(root, 'a', ['call', 'cookies', '--args', '{"action":"list"}'])), /owner/);
  const blocked = await cli(root, 'a', ['call', 'evaluate', '--args', '{"function":"() => 1"}']);
  assert.equal(blocked.code, 1); assert.match(blocked.stdout, /capability/);
  assert.equal((await cli(root, 'a', ['snapshot', '--cdp-endpoint', 'http://127.0.0.1:1'])).code, 1);
  await ok(root, 'a', ['close']);
  await ok(root, 'a', ['open', server.url, '--caps', 'evaluate']);
  const evaluated = await ok(root, 'a', ['call', 'evaluate', '--args', JSON.stringify({ function: '() => document.querySelector("h1").textContent' })]);
  assert.equal(evaluated.value, '/');
});

test('X migration persists only allowed cookies, leaves source unchanged and redacts malformed inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-agent-x-'));
  t.after(async () => { await cli(root, 'x', ['close']); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const state = JSON.stringify({ cookies: [cookie, { ...cookie, domain: '.google.com' }], origins: [] });
  await writeFile(join(root, 'state.json'), state, { mode: 0o600 });
  const migrated = await ok(root, 'x', ['import-x', '--state', 'state.json']);
  assert.equal(migrated.importedCookies, 1);
  await ok(root, 'x', ['open', '--caps', 'storage']);
  const stored = await ok(root, 'x', ['call', 'cookies', '--args', '{"action":"list"}']);
  assert.match(JSON.stringify(stored), /test-secret-never-real/);
  assert.ok(!JSON.stringify(stored).includes('google.com'));
  const busy = await cli(root, 'x', ['import-x', '--state', 'state.json']);
  assert.equal(busy.code, 1); assert.ok(!busy.stdout.includes(cookie.value));
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), state);
  await ok(root, 'x', ['close']);
  await writeFile(join(root, 'bad.json'), '{"secret":"do-not-print-this"');
  const bad = await cli(root, 'x', ['import-x', '--state', 'bad.json']);
  assert.equal(bad.code, 1); assert.ok(!bad.stdout.includes('do-not-print-this'));
});

test('explicit CDP migration disconnects without closing or changing source pages/cookies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-agent-cdp-'));
  const sourceProfile = join(root, 'source');
  const source = await chromium.launchPersistentContext(sourceProfile, { headless: true, args: ['--remote-debugging-port=0'] });
  t.after(async () => { await cli(root, 'target', ['close']); await source.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  await source.addCookies([cookie, { ...cookie, domain: '.google.com' }]);
  const before = await source.cookies();
  const page = source.pages()[0];
  await page.setContent('<h1>Unchanged source</h1>');
  const [port, path] = (await readFile(join(sourceProfile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
  const migration = await ok(root, 'target', ['import-x', '--cdp-endpoint', `ws://127.0.0.1:${port}${path}`]);
  assert.equal(migration.importedCookies, 1);
  assert.equal(source.pages().length, 1);
  assert.equal(await page.locator('h1').innerText(), 'Unchanged source');
  assert.deepEqual(await source.cookies(), before);
  await ok(root, 'target', ['open', '--caps', 'storage']);
  const stored = JSON.stringify(await ok(root, 'target', ['call', 'cookies', '--args', '{"action":"list"}']));
  assert.match(stored, /test-secret-never-real/); assert.ok(!stored.includes('google.com'));
});
