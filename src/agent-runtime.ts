import { execFile } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

/** Independent browser state, not a security boundary between processes of the same OS user. */
export function agentPaths(name: string, root = process.env.JEV_AGENT_HOME) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name))
    throw new Error('Agent names must be 1–64 lowercase letters, digits, underscores or hyphens, excluding Windows device names.');
  const base = resolve(root ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'jev-browser', 'agents')
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'jev-browser', 'agents')));
  const directory = join(base, name);
  return { base, directory, profile: join(directory, 'profile'), runtime: join(directory, 'runtime'), output: join(directory, 'output') };
}

export async function prepareAgent(paths: ReturnType<typeof agentPaths>) {
  for (const path of [paths.base, paths.directory, paths.profile, paths.runtime, paths.output]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid!())))
      throw new Error('Agent directories must be private directories, not symbolic links.');
  }
  if (process.platform === 'win32') {
    // mode: 0700 does not restrict NTFS ACLs. Use the current SID, not a guessed/localized account name.
    const run = promisify(execFile);
    const { stdout } = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/S-1-5-[0-9-]+/)?.[0];
    if (!sid) throw new Error('Cannot identify the Windows account to protect browser credentials.');
    await run('icacls.exe', [paths.directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
  }
}

/** Filter by cookie domain, never by substring or URL-looking cookie values. */
export function xCookies(input: unknown): import('playwright-core').Cookie[] {
  if (!input || typeof input !== 'object' || !Array.isArray((input as { cookies?: unknown }).cookies))
    throw new Error('Expected a Playwright storage-state object with cookies.');
  const cookies = (input as { cookies: unknown[] }).cookies.filter((item): item is import('playwright-core').Cookie => {
    if (!item || typeof item !== 'object') return false;
    const cookie = item as Record<string, unknown>;
    if (typeof cookie.domain !== 'string') return false;
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    if (domain !== 'x.com' && !domain.endsWith('.x.com')) return false;
    if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.path !== 'string'
      || typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires)
      || typeof cookie.httpOnly !== 'boolean' || typeof cookie.secure !== 'boolean'
      || (cookie.partitionKey !== undefined && typeof cookie.partitionKey !== 'string')
      || !['Strict', 'Lax', 'None'].includes(String(cookie.sameSite))) throw new Error('Invalid X cookie in storage state.');
    return true;
  });
  if (!cookies.length) throw new Error('No x.com cookies found; the profile was not changed.');
  return cookies.map(({ name, value, domain, path, expires, httpOnly, secure, sameSite, partitionKey }) =>
    ({ name, value, domain, path, expires, httpOnly, secure, sameSite, ...(partitionKey !== undefined ? { partitionKey } : {}) }));
}
