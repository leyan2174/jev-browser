# Isolated agent entry point (fork extension)

`jev-browser-agent` is a small client for Jev's existing persistent session worker.
It does not add another browser automation dependency. `open` starts a headless
Chromium with an agent-owned persistent profile; subsequent commands use the
existing authenticated loopback protocol without importing Playwright, the model
SDK, or the MCP server into the client process. Command validation, capability
checks and execution remain in the shared Jev worker.

```sh
jev-browser-agent --agent research-a open https://example.org
jev-browser-agent --agent research-a snapshot
jev-browser-agent --agent research-a call assert --args '{"target":"h1","property":"text","expected":"Example Domain"}'
jev-browser-agent --agent research-a close
```

Use a different lowercase `--agent` for every concurrent agent. Reusing a name
intentionally reuses its browser. Names are stable across working directories.
There is no implicit default agent and no automatic retry of browser actions.
`call COMMAND --args JSON` uses the same command schemas as `jev-browser`.
For example, `call extract --args '{"instruction":"Read the visible page heading","fields":{"heading":"string"},"scope":"h1"}'`
uses Jev's model-backed extraction and requires the usual provider credentials.
`--caps storage,network,trace,evaluate` is opt-in on `open`; enabled capabilities
and launch options must match when reopening a running session. The default has
none of those capabilities. `--executable-path` may select an installed Chromium
binary for `open` or `import-x`; the default is Playwright's installed Chromium.

## State and lifecycle

The default root is `%LOCALAPPDATA%/jev-browser/agents` on Windows and
`${XDG_STATE_HOME:-~/.local/state}/jev-browser/agents` elsewhere. `JEV_AGENT_HOME`
can select another private root. Each agent gets `profile/`, `runtime/` and
`output/`. A foreign `JEV_SESSION_DIR` is ignored. The worker's cwd is the agent
directory, so output paths are independent of the caller's repository.

Directories use mode 0700 on POSIX. On Windows the agent directory disables
inherited ACLs and grants the current account and SYSTEM access. Do not place
state in a repository, shared directory, or cloud-synchronized folder. This is
browser-state isolation, **not an OS sandbox**: processes running as the same
user can still access it. Use a new empty root when adopting this entry point.

`close` closes only that agent and removes its live runtime descriptor; its
profile and outputs remain. Idle workers close after 30 minutes. To log out,
log out within the isolated browser or close the agent and remove its profile
explicitly. Removing this profile does not log out a source browser. Existing
Jev SDK/CLI/MCP behavior is unchanged. This command is a separate CLI, not a
global Codex routing change or a new MCP server.

## One-time X login migration

Here “X migration” means X/Twitter login cookies, not the X11 display protocol.
First close the target agent, then choose **one** authorized source:

```sh
jev-browser-agent --agent x-research import-x --state /private/x-state.json
# Or, only after the user has enabled/authorized this source CDP connection:
jev-browser-agent --agent x-research import-x --cdp-endpoint http://127.0.0.1:9222
jev-browser-agent --agent x-research open https://x.com/home
jev-browser-agent --agent x-research snapshot
jev-browser-agent --agent x-research close
```

Only cookies for `x.com` and its subdomains are copied. Cookies for lookalike
domains, Google and other sites, origins/localStorage, passwords, extensions,
history and the source profile are not copied. File sources are read without
modification. A CDP source is read once and disconnected without navigating,
creating or closing its pages. Normal agent commands reject CDP/source-state
flags and never attach to personal Chrome. You can disable source Chrome remote
debugging after migration.

The import prints a cookie count, never values or raw provider/parser errors.
Cookies are written directly into the isolated persistent profile, with no new
plaintext export. Existing target cookies are merged by Chromium's cookie key.
Run import only on a closed target; Chromium's profile lock also prevents a
concurrent worker/import from owning the same profile. Retrying an import is an
explicit user operation. A successful copy does not prove the remote account is
still logged in: verify the X page separately. Expiration, revocation and session
cookie lifetime still apply. This does not bypass Google's sign-in restrictions,
and it does not add a complete X post/thread extraction adapter.

## Verification

`test/agent.test.mjs` uses real Chromium and synthetic cookies to check concurrent
agents, independent cookies/localStorage/navigation/close, profile persistence,
caller-cwd independence, capability enforcement, cookie-domain filtering,
redacted import failures and preservation of a real CDP source's pages/cookies.
Run `npm run check`, `npm run lint`, `npm run check:examples` and
`npm run check:package` before publishing. Tests never require a personal login
or live model credentials.
