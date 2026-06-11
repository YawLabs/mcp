# Changelog

All notable changes to `@yawlabs/mcp` (formerly `@yawlabs/mcph`) are documented here. This project uses [semantic versioning](https://semver.org) and a script-gated release flow: `./release.sh <version>` runs lint + tests + build, bumps, tags, publishes to npm, and creates the GitHub release.

## 0.60.2 -- pnpm/bun global stores upgrade with their owning tool

- `yaw-mcp upgrade` now detects pnpm global stores (`<pnpm-home>/global/<n>/node_modules/...`) and bun global installs (`~/.bun/install/global/...`) as their own install methods. `--run` spawns `pnpm add -g` / `bun add -g @yawlabs/mcp@latest` instead of misclassifying them as local node_modules trees -- which would have npm-installed a foreign package-lock + node_modules into the tool manager's internal store.
- `yaw-mcp doctor`'s UPGRADE AVAILABLE hint includes pnpm/bun globals in the "`yaw-mcp upgrade --run` works here" set.

## 0.60.1 -- scoop/custom-prefix npm globals detected correctly

- npm prefixes that live in a `bin` directory (scoop's nodejs persist dir, custom prefixes) put globals at `<prefix>/node_modules` with no `npm`/`lib`/`AppData` marker in the path, so they misclassified as `local-node-modules` -- `upgrade --run` then refused (pre-0.60.0) or npm-installed into the node prefix instead of upgrading the global. New `/bin/node_modules/` marker classifies them as `global-npm`.

## 0.60.0 -- nag removed; `upgrade --run` actually upgrades

- **The free-tier nag interstitial is gone.** Yaw MCP is free (the Pro tier is retired); `src/nag.ts`, its state file handling, and the dispatch gate were deleted. `YAW_MCP_NO_NAG` no longer has any effect -- there is nothing left to suppress. Remaining Pro references in help text, README, and the package description now read Yaw Team.
- **`yaw-mcp upgrade --run` upgrades local node_modules installs in place** instead of refusing and printing another command: it derives the package-tree root from the running entrypoint's path and runs `npm install @yawlabs/mcp@latest` there.
- **New `bundled-app` install method** for the copy that ships inside Yaw Terminal (`app.asar.unpacked`): upgrade/doctor say plainly that it updates with the app instead of suggesting an npm command that can never affect it.
- **Method-aware `doctor` upgrade hints**: the UPGRADE AVAILABLE section prints the user's terminal action for their install method, never a command that turns around and prints another command.
- Upgrade/doctor output puts commands on their own line with no trailing punctuation so they copy cleanly.

## 0.58.0 -- Rename to Yaw MCP + local-first Free mode + Pro nag + sync client

### Secrets sync + spawn-time substitution (Phase 6c)

The encrypted vault from Phase 6b now syncs across machines and pipes secrets into spawned MCP servers automatically.

- `yaw-mcp secrets push` / `pull` -- ship the encrypted vault to/from the `mcp_secrets` team-resource on yaw.sh. The server never sees plaintext or the derived key; it stores the salt + ciphertext + IV + auth tag as an opaque blob. Push uses optimistic-concurrency PUT (pull-first-to-learn-version pattern). Pull overwrites the local vault and locks the in-process key cache so the next operation re-prompts.
- Spawn-time substitution: any `${secret:NAME}` reference inside a server's `env` value gets replaced with the decrypted vault entry at spawn time. Inline composition like `Bearer ${secret:GITHUB}` works -- the regex replaces just the reference span. Missing secrets pass through as literal text so the child process surfaces its own "missing env var" error rather than receiving an empty string.

The spawn path is in `src/upstream.ts:resolveServerEnv`. Requires `YAW_MCP_VAULT_PASSPHRASE` in env because the MCP-server spawn happens in a non-interactive context where prompting on stdin would corrupt the parent's transport. Without the passphrase, refs pass through literally + a warning logs.

### Runtime event emission (Phase 5b)

`recordConnectEvent` now tees out tool-call events to `/api/team/analytics/event` on yaw.sh when a team session is cached, in parallel with the existing legacy mcp.hosting backend POST. Fire-and-forget; auth failures latch a process-lifetime flag so we don't keep hitting the disk after a session expires. Discover / activate / etc. events stay in the legacy buffer only -- only tool_call events flow to team-analytics.

### Encrypted secret vault (`yaw-mcp secrets`)

New `yaw-mcp secrets <action>` subcommand for managing a passphrase-encrypted vault at `~/.yaw-mcp/secrets.json`. AES-256-GCM with per-entry IVs; key derived from a passphrase via scrypt (N=2^15, r=8, p=1) and cached in process memory for the lifetime of the yaw-mcp invocation.

Actions:
- `set <name>` -- read value from stdin (TTY: no-echo prompt; piped: raw stdin)
- `set <name> --value <v>` -- inline value (beware shell history)
- `get <name>` -- decrypt + print to stdout
- `list` -- show entry names only (values stay encrypted)
- `remove <name>` -- delete an entry
- `lock` -- clear the in-process passphrase cache

Passphrase resolution: `YAW_MCP_VAULT_PASSPHRASE` env var > interactive TTY prompt (raw-mode, no echo) > error.

File format (vault-level salt + per-entry encrypted blobs):
```
{ "version": 1, "salt": "<base64>", "entries": { "<name>": { "iv": "<base64>", "ciphertext": "<base64>", "authTag": "<base64>" } } }
```

New modules: `src/secrets-crypto.ts` (key derivation + encrypt/decrypt primitives), `src/secrets-vault.ts` (file I/O + entry management + in-process key cache), `src/secrets-cmd.ts` (CLI). 31 new tests covering encryption round-trips, tamper detection (ciphertext + auth tag), set/get/list/remove vault ops, passphrase derivation determinism, and parse-arg coverage for all actions.

Phase 6c will add the two missing pieces: sync push|pull to the `mcp_secrets` team-resource on yaw.sh (server gets an opaque ciphertext blob, never plaintext) and spawn-time substitution of `${secret:NAME}` references in bundles.json env values.

### Stats command (`yaw-mcp stats`)

Pro / Yaw Business buyers get a new `yaw-mcp stats` subcommand that prints a digest of their recent AI tool calls. By default shows the last 7 days, capped at the most-recent 50 events; `--limit N` and `--days N` tune the window; `--json` emits machine-readable output for scripting.

Aggregates: by server (calls / success / errors / avg latency) and by AI client (Claude Code, Cursor, Claude Desktop, etc.). Each event records server-stamped `ts` + `seat_email`, plus the client-supplied `tool_namespace`, `tool_name`, `status`, optional `latency_ms`, `error_category`, `client_name`, and `client_version`.

Free users running `yaw-mcp stats` get an upsell pointer instead of empty output -- analytics requires an account.

Phase 5a ships read-only (the command reads `/api/team/analytics` on yaw.sh). Phase 5b will wire runtime event emission from `mcp_connect_dispatch` / `mcp_connect_activate` so events flow automatically; until then only events explicitly POSTed via the team-sync client surface in `yaw-mcp stats`.

New module: `src/stats-cmd.ts`. `team-sync.ts` exports `postAnalyticsEvent` + `listAnalyticsEvents` against the new yaw.sh `mcp_analytics` endpoint.

### Sync client (bundles)

Three new subcommands for Yaw Business + Yaw MCP Pro buyers:

- `yaw-mcp login --key <license-key>` -- sign in with the license key emailed at purchase. Persists an HMAC-signed `yaw_team` cookie at `~/.yaw-mcp/team-session.json` (mode 0600 on POSIX, user-profile ACLs on Windows). Same cookie + same `/api/team/session` endpoint as Yaw Terminal Business -- one license key unlocks both surfaces.
- `yaw-mcp logout` -- best-effort POST to `/api/team/session/logout`, then clears the local file.
- `yaw-mcp sync push | pull | status` -- replicate `~/.yaw-mcp/bundles.json` across machines via the `mcp_bundles` team-resource:
  - `push` strips env VALUES (preserves keys), PUTs the schema. The server never sees secret values; Phase 6b will add an encrypted `mcp_secrets` vault for syncing those.
  - `pull` GETs `mcp_bundles`, merges env values from the local file where namespaces overlap (so a machine's local API keys aren't wiped by a pull from a machine that didn't have them), writes the result to `~/.yaw-mcp/bundles.json`.
  - `status` shows sign-in state, remote version, and a coarse local-vs-remote diff (servers added/removed; env not compared).

All three accept `--json` for scripted use.

Free mode is unchanged -- no account required, no sign-in. The nag interstitial now also suppresses when a team-session cookie is present (signed-in user is not Free), in addition to the existing token-set suppression.

New module: `src/team-sync.ts` (CLI adapter of `yaw/src/team-sync.ts` from Yaw Terminal). New env: `YAW_MCP_TEAM_BASE_URL` (overrides `https://yaw.sh` for Netlify-preview testing).



### Free-tier nag interstitial

Free-mode `yaw-mcp` users now see a one-shot interstitial roughly every 2-4 human-initiated subcommand invocations, capped at one per 1.5 days. The CLI analogue of Yaw Terminal's click-to-close toast -- same product family, same nudge cadence. Pitches Pro ($9/mo or $90/yr) and Yaw Business ($10/seat/mo or $99/seat/yr) and requires a keypress (Enter) to continue.

Touch points (human-driven subcommands that count toward the cadence):
- `yaw-mcp install`, `yaw-mcp doctor`, `yaw-mcp servers`, `yaw-mcp bundles`, `yaw-mcp compliance`, `yaw-mcp upgrade`, `yaw-mcp try`, `yaw-mcp try-cleanup`, `yaw-mcp reset-learning`

Suppressed when:
- A token resolves (account mode -- Pro/Business already paying)
- Either stdin or stdout is not a TTY (CI, piped output, MCP-client subprocess)
- `YAW_MCP_NO_NAG=1` is set (escape hatch; intentionally not advertised in help)
- The bare server invocation (no subcommand) -- the AI client launching yaw-mcp must never be interrupted by a keypress prompt mid-tool-call

State persists at `~/.yaw-mcp/nag-state.json` (separate from `state.json` so `YAW_MCP_DISABLE_PERSISTENCE=1` doesn't dodge the nag, and so the schema stays trivial: 3 numeric fields, no migration path needed). No grace period; counting starts at touch #1. No escalation; cadence stays constant regardless of how many prior nags the user has dismissed.



**Breaking change.** The package is renamed from `@yawlabs/mcph` to `@yawlabs/mcp`, the binary from `mcph` to `yaw-mcp`. Part of a broader rebrand to Yaw MCP, a product under the Yaw Labs umbrella alongside Yaw Terminal and Yaw Mode. See `plans-v2.md` in the mcp-hosting repo for the strategy doc.

### Local-first Free mode

`yaw-mcp` no longer requires an account. When `YAW_MCP_TOKEN` is unset and `~/.yaw-mcp/config.json` carries no token, the server starts in **local mode**:

- Server definitions load from `~/.yaw-mcp/bundles.json` (user-global) or `<project>/.yaw-mcp/bundles.json` (project-local; takes priority over user-global, no merge)
- No backend polling, no telemetry, no heartbeat -- nothing leaves the machine
- `mcp_connect_install` and `mcp_connect_import` return a clear "not available in local mode -- edit bundles.json directly" message
- `yaw-mcp install <client>` works without `--token`; the launch entry just omits the env var and the client launches yaw-mcp in local mode

The `bundles.json` schema mirrors the existing dashboard server config (id, name, namespace, type, transport, command, args, env, url, isActive, description). Minimal example:

```json
{
  "version": 1,
  "servers": [
    {
      "namespace": "github",
      "name": "GitHub",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  ]
}
```

Account mode (token set) is unchanged: polls `/api/connect/config` from the backend, runs all the telemetry + heartbeat paths, dashboard is the source of truth.

### Rename details

What changes for users on upgrade:

- **Install command**: `npm install -g @yawlabs/mcp` (was `@yawlabs/mcph`). The old package is deprecated with a pointer to the new one.
- **Binary name**: `yaw-mcp` (was `mcph`). All subcommands invoke the same way: `yaw-mcp install`, `yaw-mcp doctor`, `yaw-mcp servers`, `yaw-mcp bundles`, etc.
- **Env var prefix**: `YAW_MCP_*` (was `MCPH_*`). Affects `YAW_MCP_TOKEN`, `YAW_MCP_URL`, `YAW_MCP_POLL_INTERVAL`, `YAW_MCP_SERVER_CAP`, `YAW_MCP_MIN_COMPLIANCE`, `YAW_MCP_AUTO_LOAD`, `YAW_MCP_AUTO_ACTIVATE`, `YAW_MCP_AUTO_UPGRADE`, `YAW_MCP_PRUNE_RESPONSES`, `YAW_MCP_DISABLE_PERSISTENCE`, `YAW_MCP_BASE_URL`.
- **Config dir**: `~/.yaw-mcp/` (was `~/.mcph/`). Project-local: `<project>/.yaw-mcp/`. Existing config files at the old path are not auto-migrated yet (planned in 0.59).
- **Guide file**: `YAW-MCP.md` inside the config dir (was `MCPH.md`).
- **Default API base**: `https://yaw.sh/mcp` (was `https://mcp.hosting`). Set `YAW_MCP_URL` to override. `mcp.hosting` will 301 to `yaw.sh/mcp` once the new backend is live.
- **MCP resource scheme**: `yaw-mcp://guide` (was `mcph://guide`).

Internal code identifiers (`loadMcphConfig`, `composeMcphConfig`, `mcphConfigPath` locals) retain `Mcph` in their names -- those are not user-visible and will be normalized in a follow-up code-hygiene pass.

The dev-checkout regex in `detectInstallMethod` now matches either `/yaw-mcp/(dist|src)/` or `/mcph/(dist|src)/` so the dev path keeps working before the repo dir is renamed.

## 0.47.2 — 2026-05-01

- **`mcph install claude-code` honors `CLAUDE_CONFIG_DIR`** — When Claude Code runs under a wrapper that sets `CLAUDE_CONFIG_DIR` (Yaw Mode's per-session overlay, dev containers that pin a config dir, sandboxed sessions), the user-scope MCP file moves from `~/.claude.json` to `<DIR>/.claude.json`, and `settings.json` moves from `~/.claude/settings.json` to `<DIR>/settings.json` (the `.claude` segment is absorbed by the env redirect — the dir IS the `.claude` equivalent). Prior versions of `mcph install` always wrote to the HOME-based defaults, so a user inside a wrapped session would get a "successful" install whose entry landed in a file Claude Code wasn't reading — `claude mcp list` then showed nothing despite the install reporting success. Discovered when a Yaw Mode session reported `claude mcp list` as empty after `npx -y @yawlabs/mcph install claude-code --token ...` returned 0 and the entry was visibly present in `~/.claude.json`. The CLI dispatcher in `index.ts` now reads `process.env.CLAUDE_CONFIG_DIR` once and passes it through `runInstall` → `resolveInstallPath` / `resolveClaudeCodeSettingsPath`. The same env is plumbed through `runDoctor` → `probeClients(Async)` so `mcph doctor` and `mcph install --list` see the same file Claude Code reads in this session. Resolver functions stay pure (no `process.env` reads inside) — env-handling lives in the entry points so unit tests stay deterministic regardless of whether the test runner inherits a real `CLAUDE_CONFIG_DIR`. Project-scope (`<project>/.mcp.json`) and project/local-scope `settings.json` (project-relative) are unaffected. Cursor / Claude Desktop / VS Code paths are unaffected (Claude Code is the only client that reads `CLAUDE_CONFIG_DIR`). 17 new tests lock the redirect for resolver, install, and doctor.

## 0.47.1 — 2026-04-18

- **README intro rewritten to frame mcph's value vs. `claude mcp add` / hand-edited `mcp.json`** — Same forum thread (r/cursor, 2026-04-18) had a second comment that v0.47.0 didn't address: "I don't think any developer is 9$ a month afraid of json. Also all of those tools have a nicer way of installing mcp servers than editing json." Fair — the old intro led with "never hand-edit MCP JSON configs again," which is exactly the dismissal that lands. The new intro replaces that line with four concrete situations where mcph earns its keep (multi-client / multi-machine sync, `dispatch` context-pruning for large server accounts, encrypted credential centralization, A–F compliance visibility). It then *concedes* the skeptic's point directly in the last sentence: "If you use one client on one machine with a handful of servers, `claude mcp add` or hand-editing `mcp.json` is fine — mcph's value shows up when that setup stops scaling." Honest framing beats defensive framing; the people who actually have the scaling problem will self-select in.

## 0.47.0 — 2026-04-18

- **Compliance grade surfaces on every `discover` output, not just when `MCPH_MIN_COMPLIANCE` is set** — Previously the `[A]`/`[B]`/… tag only appeared when the user had pre-configured a floor with `MCPH_MIN_COMPLIANCE`, which meant the trust signal was invisible by default. Forum feedback (r/cursor, 2026-04-18) called this out directly: "how do you manage trust … making sure MCPs do not contain malicious code?" The grade is the answer — but only if you can see it without opting in first. Now every scored server renders with its grade inline (`github — GitHub [ready] [A]`), so the model (and the human reading the output) factors trust into activation decisions unconditionally. The `mcp_connect_discover` tool description picks this up ("treat it as a trust signal and prefer higher-graded alternatives when otherwise equivalent"). Ungraded servers still render untagged (don't punish unknown on a catalog where many entries aren't scored yet). When the floor IS set and a server is below it, the tag is replaced by the existing `(grade D — below MCPH_MIN_COMPLIANCE=B, won't auto-activate)` refusal line. Paired test: `server.test.ts` flips the "omits `[grade]` when env unset" contract to "shows `[grade]` when env unset" and keeps the ungraded-leaves-line-clean invariant.
- **`Trust & security` section in `README.md`** — Explicit trust-model section addressing the three concerns raised in the same forum thread: (1) malicious code in MCPs, (2) prompt injection through tool output, (3) data siphoning to third parties. Takes the posture that mcph is a source of **visibility and a gate**, not a sandbox — compliance grades + `MCPH_MIN_COMPLIANCE` + `mcph compliance <target>` + `mcph servers` transparency + per-server encrypted credentials + response pruning + namespace isolation — and explicitly documents what mcph does **not** try to solve (outbound network firewalling, process sandboxing, source-hash pinning) so users know where to layer their own defenses (restricted OS user, containers, token rotation). Direct answer to the forum question rather than a hand-wave.

## 0.46.4 — 2026-04-18

- **`mcph --help` Setup block rewritten for clarity** — The v0.46.3 rewrite used jargony wording ("Auto-edit an MCP client's config") and split the client list onto an ambiguous continuation line. Rewrote the three install rows to action-first prose: `install <client>` says "Configure one MCP client to launch mcph" and spells out the exact slugs (`claude-code, claude-desktop, cursor, vscode`) inline; `--list` says "List which MCP clients are installed on this machine"; `--all` says "Configure every installed MCP client in one go". Same three commands, but it now reads as plain English.
- **Help + doctor now list `MCPH_AUTO_ACTIVATE`** — The env var has controlled the discover auto-activate gate since the confidence-scoring work landed, but neither the help page nor `mcph doctor`'s ENVIRONMENT section mentioned it, so the only way to discover the toggle was to grep `server.ts`. Added to both: help describes what flipping to `0` does, doctor surfaces the current value with `default on` hint. Also tightens the config resolution table in help — tier 3 (`<project>/.mcph/config.json`, the project-shared file) now notes "never put a token here — apiBase only" so nobody accidentally commits a token to a shared repo.

## 0.46.3 — 2026-04-18

- **`mcph --help` rewritten: quickstart, grouped subcommands, env vars, config precedence** — The old help listed ten subcommands in a flat table and spent most of its real estate on install flag details (already available via `mcph install --help`) and a three-line token-resolution note. Subcommands are now grouped by purpose (Setup, Inspection, Maintenance, Other), each with a multi-line description that explains what the command actually does — not just its name. A numbered Quickstart at the top points users at the token URL and shows the two commands needed to finish onboarding. An Environment variables section documents the eight `MCPH_*` overrides (`MCPH_URL`, `MCPH_POLL_INTERVAL`, `MCPH_SERVER_CAP`, `MCPH_MIN_COMPLIANCE`, `MCPH_AUTO_LOAD`, `MCPH_PRUNE_RESPONSES`, `MCPH_DISABLE_PERSISTENCE`) that were previously only discoverable by reading the doctor source. Config resolution is expanded from three lines to a proper four-tier precedence list (env → project.local → project → user-global). Trailing pointer to `mcph <subcommand> --help` for flag-level detail so the top-level stays scannable. `INSTALL_USAGE` import removed from `index.ts` since the install flag block no longer inlines into top-level help.

## 0.46.2 — 2026-04-18

- **Doctor's UPGRADE AVAILABLE section points at `mcph upgrade`** — Previously it inlined `npm install -g @yawlabs/mcph@latest` with a long prose aside about npx-vs-global. Now it tells the user to run `mcph upgrade` (prints the exact command for their install method) or `mcph upgrade --run` (executes for global-npm). Shorter, single source of truth for "how do I actually update?" since doctor already detects staleness and the upgrade subcommand already understands how the install was done.

## 0.46.1 — 2026-04-18

- **Fix `mcph upgrade` reporting `Current: dev` in shipped bundles** — The v0.46.0 `readCurrentVersion()` used `(globalThis as ...).__VERSION__`, but tsup's `define` only substitutes bare identifier references, not property accesses — so the compiled bundle fell through to the "dev" fallback regardless of what version was installed. Switched to the same `declare const __VERSION__ / typeof __VERSION__ !== "undefined"` pattern used in `index.ts`, `doctor-cmd.ts`, `server.ts`, and `upstream.ts`. Smoke-tested via `npx @yawlabs/mcph@latest upgrade`: now reports the actual installed version.

## 0.46.0 — 2026-04-18

- **`mcph upgrade` — show (or run) the command that bumps `@yawlabs/mcph` to the latest version** — `mcph doctor` has surfaced staleness for a while, but the fix step was left to the user. This subcommand turns that prompt into an action: it detects *how* mcph is installed by inspecting `process.argv[1]` (global npm, npx cache, project-local `node_modules`, or a dev checkout), fetches the latest version from the npm registry (3s timeout, graceful offline fallback), and prints the exact command that moves the current install forward. `--run` spawns the upgrade for the global-npm case (whitelisted to `npm install -g @yawlabs/mcph@latest` — never arbitrary input into a shell), refuses with exit 2 on non-global install methods to avoid surprise writes, and exit 3 if the spawned npm invocation fails. `--json` emits `{ current, latest, stale, method, command }` so CI scripts can branch on staleness without parsing prose. `npx -y` installs are a no-op ("restart the MCP client and it will fetch the new version") — the path detection catches the `_npx` staging directory and says so. Exit codes are wired for scripting: 0 up-to-date or offline, 1 stale without `--run` (copy-paste mode), 2 usage/refusal, 3 `--run` failed. Completes the doctor→fix handoff that's been missing since the upgrade-check section landed.

## 0.45.0 — 2026-04-18

- **Clearer 401/403 errors with token fingerprint + actionable fix link** — When the backend rejects a token (`HTTP 401` revoked/malformed, `HTTP 403` accepted but scope-denied), `fetchConfig` now throws an error that names the offending token by its fingerprint (e.g., `mcp_pat_…abcd`), explains what state the token is in, and points directly at the tokens page with a concrete re-install command. Prior wording was "Invalid MCPH_TOKEN — check your token at mcp.hosting" and "Access denied — your token may have expired" — both too vague to action without pinging support. New wording is structured as three lines: cause, fix URL, and the `mcph install … --token mcp_pat_...` re-install command. Messages surface verbatim through `mcph servers`, the top-level `mcph` runtime, and anywhere else `fetchConfig` is awaited, so every user-facing rejection reads the same way.

## 0.44.0 — 2026-04-18

- **`mcph install --list` + `mcph install --all`** — Two new modes on the install subcommand. `--list` is read-only: it enumerates every client/scope combo for the current OS and shows whether an `mcp.hosting` entry is already wired up, plus a path-per-row and a one-line summary (`N/M client scopes have mcp.hosting configured on linux`). No token, no network, no writes — just a diagnostic view that mirrors the `doctor` CLIENTS section but without the rest of doctor's noise. `--all` walks `INSTALL_TARGETS`, picks the default scope per client (user where supported, else the first non-project-dir scope, else skipped unless `--project-dir` is passed), and calls `runInstall` in a loop — so `--dry-run`, `--force`, `--skip`, and `--token` all propagate as expected. Status is aggregated into a single summary line, and the process exit code is non-zero if any sub-install failed so CI can still gate on one-shot onboarding. Works around the main drop-off during setup ("which client am I supposed to pick?") by offering both the answer (`--list`) and the sledgehammer (`--all`) from the same subcommand.

## 0.43.0 — 2026-04-18

- **`mcph servers <namespace-filter>` — positional filter** — Passing a bare positional argument now filters the listing to servers whose namespace contains that substring (case-insensitive): `mcph servers git` matches both `github` and `gitlab`. Applies to both the text table and the `--json` output so the two surfaces agree. Summary line reflects the filtered count, and a filter that matches nothing prints an explanatory "No servers match …" instead of an empty table (which previously looked like an empty account).
- **README catch-up — `CLI reference` block + `doctor --json` documented** — The README was missing the subcommands that landed in v0.38.0 onward (`servers`, `bundles`, `reset-learning`, `completion`) and hadn't been updated to mention doctor's `--json` mode. New compact "Other CLI subcommands" block lists every user-facing command with a one-line purpose, documents the `--json` pattern as the pipeline interface across doctor/servers/bundles, and includes copy-paste install snippets for bash/zsh/fish/powershell completions. The doctor paragraph now lists the actual section coverage (env overrides, persisted state, reliability rollup, shell-shadow hits, upgrade check) so first-time readers know what they get.

## 0.42.0 — 2026-04-18

- **`mcph completion <shell>` — shell completion scripts** — Prints a completion script for `bash`, `zsh`, `fish`, or `powershell` to stdout so users can one-line it into their completions directory. Each script covers every known subcommand (install, doctor, servers, bundles, compliance, reset-learning, completion) with positional choices (install clients, bundles actions, completion shells) and per-subcommand flags (`--json`, `--scope`, `--token`, `--force`, etc.). Every template derives from a single `SUBCOMMAND_SPEC` table so adding a new subcommand elsewhere updates all four shells at once — no drift between what the CLI accepts and what it completes. Install hints are inlined as comments at the top of each generated script: the bash file drops into `~/.local/share/bash-completion/completions/mcph`, zsh into any `$fpath` dir as `_mcph`, fish into `~/.config/fish/completions/mcph.fish`, pwsh appended to `$PROFILE`.

## 0.41.0 — 2026-04-18

- **`mcph doctor --json` — machine-readable diagnostic output** — Doctor already tracks a lot of state (config files, token source, env overrides, persisted learning, installed clients, shell-history shadow hits, upgrade availability, diagnosis summary) and the text output optimises for pasting into a support ticket. `--json` emits the same data as a single structured blob so dashboards, CI scripts, and support tooling can pick fields with `jq` instead of parsing the text layout. Token is fingerprinted the same way in both modes (never raw). Section data is 1:1 with the text renderer: config (token/apiBase/loadedFiles/warnings), env overrides (null when unset), state (path/savedAt/entries; `disabled: true` when `MCPH_DISABLE_PERSISTENCE` is set), reliability (same `selectFlakyNamespaces` rollup that `mcp_connect_health` and the text RELIABILITY section use), clients probe results, shell shadow hits, upgrade info, and the exit-code diagnosis. Completes the `--json` pattern across `servers`, `bundles`, and now `doctor` — every CLI that reads state has a pipeline mode.

## 0.40.0 — 2026-04-18

- **`mcph bundles` CLI subcommand** — CLI counterpart to the `mcp_connect_bundles` meta-tool (v0.28.0). Two actions mirror the meta-tool's `action` parameter: `list` prints every curated bundle grouped by category with activate hints (static, no network, no token needed — good for browsing or sharing in onboarding docs), and `match` partitions the curated set against the user's enabled servers from the backend into ready-to-activate vs partially-installed, so a human can see in the terminal what the LLM-facing tool would suggest. The LLM tool has always been primary surface, but "what bundles exist?" is a frequent enough support question that surfacing them in the CLI earns its keep. Match only counts `isActive: true` servers — disabled ones don't auto-activate, so they shouldn't count toward "ready" — matching the LLM tool's filter so both surfaces agree. Partial bundles sort fewest-missing first to match the discover inline hint ranking. `--json` emits machine-readable output (`{bundles}` for list, `{installed, ready, partial}` for match). Exit codes: 0 success, 1 match needs a token and none resolved, 2 match couldn't reach the backend.

## 0.39.0 — 2026-04-18

- **`mcph servers` CLI subcommand** — Lists the servers currently configured for your account in the mcp.hosting dashboard, hitting the same `/api/connect/config` endpoint that `runServer` polls at startup. Fills a gap between `mcph doctor` (local state: config files, clients, state.json) and the web dashboard: users can sanity-check their dashboard edits from the terminal, support engineers can ask for `mcph servers --json` output in a ticket, and scripts can pick a namespace up-front before piping into `mcph compliance` or `mcph install`. Table view groups the relevant columns (namespace, name, type, enabled/disabled, compliance grade, cached tool count) and is sorted alphabetically by namespace for diffable re-runs; `--json` emits the raw backend response verbatim. Exit codes: 0 success, 1 no token, 2 fetch error.

## 0.38.0 — 2026-04-18

- **`mcph reset-learning` CLI subcommand** — Deletes `~/.mcph/state.json` so cross-session learning starts fresh; prints the entry counts that were cleared. Pairs with v0.37.0's doctor RELIABILITY section: once a namespace has been flagged flaky, the dispatch penalty branch (v0.36.0) keeps suppressing it until enough new successes pile up — but if the user has since fixed the underlying cause (rotated a token, swapped the upstream, re-authed), that history is stale and the penalty has overstayed its welcome. This gives them a direct CLI lever to clear it. Scope is all-or-nothing by design; a per-namespace flag is footgunny (user clears one, forgets the others, keeps getting silently mis-ranked). No-op with an explanatory message when `MCPH_DISABLE_PERSISTENCE` is set or the file doesn't exist, so `mcph reset-learning` never surprises. Exit 0 on success or no-op, exit 1 on I/O error (permissions, disk).

## 0.37.0 — 2026-04-18

- **`mcph doctor` RELIABILITY section** — New block surfaces flaky dormant namespaces pulled directly from `~/.mcph/state.json`, using the same ≥3-dispatches / <80%-success definition as `mcp_connect_health`'s cross-session reliability block — so the CLI diagnostic and the LLM-facing health tool agree on what "flaky" means. Sorted worst-rate first, capped at 5. Silently omitted when no namespace qualifies, state.json doesn't exist yet, or `MCPH_DISABLE_PERSISTENCE` is set. Threshold constants + sort logic extracted into `selectFlakyNamespaces` so handleHealth and doctor can't drift apart.

## 0.36.0 — 2026-04-18

- **Negative signal in dispatch ranking (`boostFactor` penalty branch)** — The learning store's `boostFactor` now drops *below* 1.0 for namespaces with flaky history, mirroring the existing upward boost. Threshold is the same ≥3 dispatches / <80% success gate used by discover's inline reliability warning (v0.35.0) and health's cross-session block (v0.34.0) — so a server flagged flaky in those views also loses rank points at dispatch time rather than quietly continuing to win routing. Floor is `-10%` (`LEARNING_MIN_BOOST = 0.9`), symmetric with the existing `+10%` ceiling. Rate-based signal trumps count-based: a namespace with 10 successes but a 50% overall rate is flaky, not useful, and the penalty branch beats the positive branch in that case.

## 0.35.0 — 2026-04-18

- **Inline reliability warning in `mcp_connect_discover`** — Discover now annotates dormant (not currently loaded) servers with `reliability: P% success across N past calls` when persisted learning shows ≥3 dispatches and <80% success. Renders under the server card right after the live health warning, so the LLM sees the flaky history *before* it picks a server to activate — not only after `handleHealth` surfaces it post-hoc. Thresholds match the cross-session reliability block from v0.34.0 so the two views stay consistent. Suppressed for loaded servers (the live per-call warning already covers them with fresher data).

## 0.34.0 — 2026-04-18

- **Cross-session reliability block in `mcp_connect_health`** — New section at the bottom of health output surfaces flaky *dormant* namespaces pulled from persisted learning: `<namespace> — N calls, P% success, last used <age> ago`. Threshold is deliberately high (≥3 dispatches, <80% success) so a one-off failure doesn't light up the panel; loaded namespaces are skipped (in-session block already covers them). Sorted worst-rate first, ties broken by most calls then alpha; capped at 5. Also fixes a gap where `handleHealth` returned early on an empty-connections session and never showed dormant history — now it falls through so operators can see which past servers were unreliable even before loading anything.

## 0.33.0 — 2026-04-18

- **`mcph doctor` ENVIRONMENT section** — New block enumerating every behavior-modifier env var mcph actually reads (`MCPH_POLL_INTERVAL`, `MCPH_SERVER_CAP`, `MCPH_MIN_COMPLIANCE`, `MCPH_AUTO_LOAD`, `MCPH_PRUNE_RESPONSES`). Each shows its current value, or `(not set — <default>)` when unset. Closes a diagnostic gap where users reporting "my server cap isn't taking effect" or "compliance filter isn't blocking anything" had no doctor signal on whether the knob was even set. TOKEN / URL / DISABLE_PERSISTENCE still get their dedicated sections (richer context there).

## 0.32.0 — 2026-04-18

- **Unknown CLI subcommand detection + typo suggestions** — `mcph <typo>` (e.g. `mcph instal`, `mcph docto`) now exits 2 with `unknown subcommand "X". Did you mean: install?` instead of silently falling through to MCP-server mode and erroring opaquely on the missing token. Bare flags (anything with a leading `-`) still fall through so server startup can parse them.

## 0.31.0 — 2026-04-18

- **"Did you mean?" suggestions on `mcp_connect_activate`** — When a caller tries to activate a namespace that doesn't exist, the error message now splits the two underlying cases: (a) not installed at all (with up to 3 fuzzy-matched installed namespaces via substring containment or ≤2 edit distance, or a pointer to `mcp_connect_discover` when nothing is close), and (b) installed but disabled in the dashboard (with a pointer to `mcp.hosting` to enable). Replaces the previous conflated "`X` not found or disabled" message.

## 0.30.0 — 2026-04-18

- **Inline bundle completions in `discover()`** — When a curated bundle has some installed servers but is missing one or two, `mcp_connect_discover` surfaces a "Bundle completions" block with the partial bundle id, what's already installed, and what to add. Top 3 entries, ranked by fewest-missing first (cheapest to complete), tie-broken by most-momentum then id. Same data source as `mcp_connect_bundles action="match"`, but inline so the model can act on the nudge without the extra round-trip. Suppressed when no curated bundle has any overlap with the installed set.

## 0.29.0 — 2026-04-18

- **Compliance-aware routing (`MCPH_MIN_COMPLIANCE`)** — Phase 3 item. Set the env var to `A`, `B`, `C`, `D`, or `F` and `mcp_connect_activate` refuses to load any installed server whose reported `complianceGrade` is below the floor, with an error that names the grade and the env var to unset. `mcp_connect_discover` annotates below-grade servers in place (so the model knows they exist and why they won't auto-activate) and emits a "Compliance filter active" header. Forward-compatible schema: the optional `complianceGrade` field on `UpstreamServerConfig` rides the existing `/api/connect/config` response — the feature kicks in automatically once the backend starts populating grades. Ungraded servers always pass (don't punish unknown).

## 0.28.1 — 2026-04-18

Docs-only release.

- First-ever `CHANGELOG.md`, covering 0.5.0 → 0.28.0. Linked from `README.md`.
- README catches up with the meta-tools shipped in the 0.20 – 0.28 arc: `mcp_connect_read_tool`, `mcp_connect_exec`, `mcp_connect_bundles` are now documented in the top-level list. Corrected "session-local" phrasing on the Learning ranker signal (cross-session since v0.23.0).
- New "Multi-device sync" section under "Config sync" — same token, same servers across every machine; no dotfile repos for secrets.
- Phase 2 "Multi-device config sync" marked shipped in `ROADMAP.md` (docs-only; backing behavior already worked).
- `package.json` `files` array now includes `CHANGELOG.md` so release notes ship with the npm tarball.

## 0.28.0 — 2026-04-18

Phase 3 opener. Two client-only intelligence features.

- **Tool deduplication** — `mcp_connect_discover` now surfaces an "Overlapping tools" block when two or more currently-connected servers expose the same bare tool name. Top 5 overlaps, sorted by namespace count descending, with a dispatch-to-disambiguate hint.
- **Curated bundles (`mcp_connect_bundles`)** — New meta-tool returning hand-picked multi-server presets: `devops-incident`, `pr-review`, `growth-stack`, `data-ops`, `product-release`, `support-ops`. `action: "list"` (default) returns all bundles; `action: "match"` partitions them into "ready to activate now" vs. "partially installed" against the user's current config.

## 0.27.0 — 2026-04-18

Four Phase 2 items shipped together.

- **Automatic load (`MCPH_AUTO_LOAD`)** — Opt-in env flag. On startup, after persistence hydration, activates every namespace in the top recurring pack (by frequency, tie-break recency) from pack history, provided every namespace is installed. Silent no-op otherwise.
- **Per-tool filter on `mcp_connect_activate`** — Pass `tools: [...]` to expose only the named tools via `tools/list`. Hidden tools stay reachable through `mcp_connect_dispatch` (routes are unfiltered). Re-activate without `tools` to clear the filter. `discover()` shows a `(filtered: K of N)` indicator on filtered connections.
- **Orchestration pipeline (`mcp_connect_exec`)** — Declarative multi-step tool-call pipeline. Each step names a namespaced tool plus args; `{"$ref": "<stepId>[.path]"}` markers in args splice a prior step's output into the next step's input. No eval / no expression language — only sequential dispatch and dot/bracket path resolution. Capped at 16 steps; any step failure fails the pipeline and returns completed outputs as `partial`.
- **Marketplace pointer** — `discover()` appends `https://mcp.hosting/explore` for users with fewer than 5 installed servers. URL hint only; a full marketplace meta-tool is parked until the backend ships a catalog API.

## 0.26.0 — 2026-04-18

- **Recurring packs block in `discover()`** — When pack history and installed config overlap, `discover()` now surfaces an "Recurring packs" block at the top of its output with a ready-to-run `mcp_connect_activate` call. Saves the second `mcp_connect_suggest` round-trip when the signal is already there.

## 0.25.1 — 2026-04-18

- Truthed up "this session" phrasing across user-facing strings and tool descriptions. With cross-session persistence (v0.23.0) shipping, counts and pack history are no longer session-scoped; the copy now matches.

## 0.25.0 — 2026-04-18

- `mcp_connect_suggest` now emits a ready-to-run `mcp_connect_activate` call with a verbatim `namespaces=[...]` JSON array, rather than pointing at `mcp_connect_dispatch` (the wrong primitive for loading a pack).

## 0.24.0 — 2026-04-18

- **`mcph doctor` STATE section** — Prints `~/.mcph/state.json` path, last-saved age, learning count, pack history count; shows "disabled" when persistence is opted out.
- **`MCPH_DISABLE_PERSISTENCE` opt-out** — Env flag skips both load and save. Useful for CI, sandboxed containers, or users who don't want a state file.

## 0.23.0 — 2026-04-18

- **Cross-session persistence** — Learning counts (`succeeded`/`dispatched`/`lastUsedAt` per namespace) and pack history (co-activation chains) now round-trip through `~/.mcph/state.json`. Schema-versioned, atomic write-rename.

## 0.22.0 — 2026-04-17

- **Inline usage hints in `discover()`** — `used Nx` success counts and "often loaded with X, Y" co-activation peers are surfaced per-server in discover output.

## 0.21.0 — 2026-04-17

- **Concurrent server cap** — Default max 6 simultaneously-active servers; `MCPH_SERVER_CAP` env override. Hard cap both as context protection and a business lever.

## 0.20.0 — 2026-04-17

- **`mcp_connect_read_tool`** — Schema-on-demand: return a single tool's schema + docs without activating its server. For servers with large tool catalogs where the model only needs 1–2 tools, reads 1–2 schemas instead of loading the entire catalog.

## 0.19.x and earlier

- v0.19.0 — internal refactor around config reconciliation.
- v0.18.0 — analytics uploads for tool-call patterns, load/unload events, error rates.
- v0.17.0 — resource + prompt proxying (beyond tools).
- v0.16.0 — error tracking surfaced in `discover()`.
- v0.15.x — `install` command gates success on config refresh; misc fixes.
- v0.14.0 — auto-allow mcph tools in Claude Code settings + discover dedup.
- v0.13.0 — deferred tools: advertise inactive-but-cached servers in `tools/list`.
- v0.12.x — legacy-config migrator + `doctor` freshness checks.
- v0.11.x — stability patches.
- v0.10.x — 7-feature bundle, adaptive routing, policy profiles.
- v0.9.0 — `mcph compliance` subcommand.
- v0.8.0 — runtime detection + test runner + error deep-links.
- v0.7.0 — two-stage retrieval: BM25 + semantic rerank.
- v0.6.0 — BM25 dispatch + auto-warm discover + stderr capture.
- v0.5.0 — `MCPH_POLL_INTERVAL` env var.
- v0.1.x – v0.4.x — initial public release, core meta-tools, namespace routing, config polling.
