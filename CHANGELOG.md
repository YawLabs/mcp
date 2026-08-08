# Changelog

All notable changes to `@yawlabs/mcp` (formerly `@yawlabs/mcph`) are documented here. This project uses [semantic versioning](https://semver.org) and a script-gated release flow: `./release.sh <version>` runs lint + typecheck + tests + build, bumps, tags, publishes to npm, and publishes `server.json` to the MCP registry.

## 0.74.2 -- the oam floor moves to 0.9.0, and a full-pass sweep of the runtime

**Changed -- the oam floor moves to 0.9.0**

`MIN_OAM_VERSION` tracks the latest oam release as policy, and v0.9.0 is now current. A machine running an older oam falls back to node/npx with one warning naming both versions and the command that fixes it (`oam self-update`), and `doctor` reports `installed (v0.8.3) -- below min 0.9.0; IGNORED, servers run on node`. That is the documented trade: an aggressive floor costs a fallback, a lax one silently hosts production sidecars on a runtime nobody else is running.

**Fixed -- `--help` described the opposite of the shipped default**

The `YAW_MCP_DEFAULT_RUNTIME` entry still read `Unset = node (today's default)`. Unset has meant oam-when-installed since 0.74.1; `doctor`, the README and this changelog all already said so, leaving the CLI's own help as the only surface contradicting the feature it documents.

**Fixed -- an oam-hosted npx server could receive different arguments than the npx fallback**

The `-y`/`--yes` filter ran over the whole argument list rather than only the flags npx itself consumes, so a `--yes` belonging to the SERVER was dropped when the launch was rewritten for oam and kept when it was not. Same configuration, different child argv depending on whether oam happened to be installed -- which the rewrite exists specifically never to do.

**Fixed -- a broken `bundles.json` could invert an explicit `defaultRuntime: "node"`**

A file that exists but cannot be parsed produced no value, and that empty answer was cached for the life of the process. Since unset now means oam-when-installed, the cached blank silently flipped a machine that had explicitly opted OUT back onto oam. Only that degraded-and-empty combination is now left uncached; every healthy shape, including "no bundles.json at all", still resolves once and stays cached, so the connect path does not re-read per spawn.

**Fixed -- the version-pinning notice was silent or misleading depending on where the sidecar came from**

Hosting on oam runs a copy from disk, so `@latest` stops re-resolving and the version pins itself. The notice that says so only fired for npx-cache copies -- never for a durable install, and never for the managed tree that `sidecars install` exists to create. It now covers all three, carries the directory the entry was resolved out of, and names the command that actually refreshes THAT copy. The broker's own `node_modules` is correctly treated as a cache when it sits under `_npx`, which is where `npx -y @yawlabs/mcp` puts it; the managed tree logs at debug, since re-running `sidecars install` is a decision the user already made.

**Fixed -- `sidecars install --json` reported no error on a failed install**

When npm exited 0 but no requested package resolved, the command exited 1 while the JSON document still carried `error: null`, so a caller branching on `error` -- the field that document exists to provide -- read a failed install as a clean one.

**Added -- `doctor --json` reports the managed install**

The `oamRuntime` block now carries `managed`, mirroring the text report: the managed directory and the installed version of each configured package. That version is what an oam-hosted sidecar actually runs and nothing else reports it, since `bundles.json` only ever says `@latest`.

**Fixed -- usage output could be truncated when piped**

Thirteen subcommands wrote their usage to stdout and then called `process.exit()`, which force-flushes the event loop and can cut a buffered body short on a slow consumer (`yaw-mcp install --help | less`). They now set the exit code and let Node drain the write, matching what `--help` and the dispatch tail already did.

**Fixed -- a server that had just loaded could dead-end on "no longer available"**

Four paths activated an upstream without rebuilding the routing tables or telling the client its lists had moved: discover's auto-warm, the auto-loaded recurring pack, the lazy activation behind a deferred tool, and prewarm's reconciliation. The namespace was connected, but `toolRoutes` still held the placeholder built from the persisted tool cache -- so the very next call took the deferred branch, found the server already up, and returned `no longer available after loading X`. No retry clears that, for a server that loaded fine seconds earlier, and the session stays wedged until the client restarts. The deferred path made it worse by rebuilding only when activation reported a change, which is exactly false when the namespace was already warm. Every activation and deactivation site now goes through one helper that does both halves, because doing one of them is the bug that kept recurring.

**Fixed -- `mcp_connect_read_tool` ran servers the project profile and the compliance floor had refused**

The tool spawns a server transiently to read one schema, and it consulted neither gate before doing it. A namespace excluded by the project's allow/deny profile, or graded below `YAW_MCP_MIN_COMPLIANCE`, still had its configured command executed with its vault-resolved env -- secrets included. Disconnecting afterwards does not make that acceptable; every other surface narrows by the profile before it reaches a server. Both gates now run here, in the same order and with the same wording activation uses. The floor itself also went from two copies to one: the duplicate in `activate` produced identical text for the common case but reordered precedence for a server failing two gates, so a below-grade server that was also disabled reported one reason to `activate` and a different one to `dispatch`.

**Fixed -- a busy upstream could be closed in the middle of your call**

The idle reaper runs on other calls' completions, and a namespace's idle counter is only reset once its own call returns. A slow call to B could therefore be tipped over the threshold by a burst of short calls to A: B's transport closed, your pending call rejected, and the rejection booked as B's own zero-reward failure -- dragging the ranking of a healthy server down for a fault yaw-mcp caused. Namespaces with a call in flight are now skipped and re-evaluated on the next completion. Shutdown had the mirror-image problem: it snapshotted the connection map while prewarm activations were still mid-handshake, leaving live child processes nothing would ever disconnect (the parent exiting is what masked it). It now refuses new activations first, drains what was already past the gate, and clears any credentials elicited during the session, as that field's contract promised. The idle baseline is also re-read per call instead of latched at import, and `YAW_MCP_IDLE_THRESHOLD` now works at all -- only the pre-rename `MCP_CONNECT_IDLE_THRESHOLD` was ever read.

**Fixed -- prompts could route to the wrong upstream, and one blip could empty a server's inventory**

Prompt namespacing carried the cross-namespace collision that was fixed for tools in 0.74.0. Namespace `gh` with a `review_pr` prompt and namespace `gh_review` with a `pr` prompt both flatten to `gh_review_pr`; `prompts/list` advertised the first upstream's prompt while `prompts/get` executed the last writer's, so the model saw one server's description and got another server's prompt, and a later-activated server could capture an earlier one's traffic. Both surfaces now agree on the first writer. In the same area, the resources and prompts refreshers returned an empty list on any error, so a single transport blip or list timeout on a `list_changed` notification replaced a healthy server's entire inventory with nothing -- until some future notification that may never arrive. A failed refresh now leaves the previous inventory standing, which is what the tools refresher already got for free.

**Fixed -- `install` destroyed comments in client configs and loosened their permissions**

`install` read the client config with a JSONC parser and wrote it back through `JSON.stringify`, deleting every `//` and `/* */` in the file. `.vscode/mcp.json` is documented JSONC and its `inputs` array is routinely commented; Claude Code's `settings.json` is hand-maintained and carries hooks and model settings around the one key being patched. Both are now spliced in place, the way `yaw-mcp try` already wrote them -- only the `mcp` entry and the `permissions.allow` node move, and the rest of the file keeps its comments, key order and indentation byte for byte.

The atomic write underneath was a second bug. `rename` publishes a new inode, so the surviving file took the umask default rather than the mode it had -- widening a config `yaw-mcp try` had deliberately written 0600 because it holds an inline secret. An existing target's mode is now carried forward whenever the caller passes none, and every write gets a unique temp path so two concurrent writers to the same file cannot truncate each other's.

`install` also stopped stripping a legacy `permissions.allow` wildcard while leaving the legacy server entry that wildcard grants -- it only warns about that entry, so removing the pattern in the same run revoked a live grant and made Claude Code re-prompt on every one of that server's tool calls. Alongside those: `--all` says "every client available on this OS" instead of promising detection it never did, `--dry-run` says "Would overwrite" rather than announcing a write that has not happened, `--scope project` honours the documented `cwd` override instead of writing `.vscode/mcp.json` into whatever directory the process started in, and each fallback to node when oam cannot host the broker now names its reason -- below the floor, unusable, or resolvable only as a bare name a GUI-launched client would never find.

**Fixed -- `remove` skipped its confirmation on exactly the files most likely to hold a secret**

The destructive-confirmation gate parsed `bundles.json` with `JSON.parse` while the write path used the loader's JSONC parser. One `// prod token lives in 1Password` line, or one trailing comma, made the file look malformed to the gate and perfectly fine to the delete -- so the preview, the off-TTY refusal and the `[y/N]` prompt were all skipped on hand-edited files, which are precisely the ones carrying stored env values `add` cannot bring back. Both now read the file the same way.

**Fixed -- re-running `add` threw away what was already on the entry**

`yaw-mcp add <slug>` rebuilds its entry from the catalog every time, and replaced the stored one wholesale. Re-adding a server to pick up a new launch command silently dropped a persisted `--env` value, an explicit `"isActive": false`, a per-server `"runtime"` override, a hand-tuned `connectTimeoutMs`, and any field outside the writer's vocabulary -- all of it under an `Updated ...` success line. An upsert is a partial update now: a field the incoming entry leaves undefined keeps its on-disk value, `env` merges per key so an empty incoming value never blanks a stored one, and an incoming `isActive: true` will not re-enable something you deliberately turned off (an explicit `false` still disables). `--json` and the ambient-env note report the entry as written rather than the pre-merge input, so they describe a file that exists.

**Fixed -- `sidecars install` could not actually move a `@latest` sidecar forward**

npm cannot re-resolve a dist-tag against an existing tree: with a lockfile present, a package locked at 0.3.6 under a `latest` range reports "up to date" and stays there. The command whose entire purpose is refreshing the pin was therefore a no-op after the first run, and "Re-run this command to move them forward" was false. It now runs `npm update` after the install, which does honour the manifest's ranges -- an exact-pinned spec still cannot drift -- and reports a failed refresh separately from a failed install, since the tree is still usable either way.

It also stopped over-promising in the other direction. When nothing on the machine would read the managed tree -- no oam, or every server resolving to node -- it names the closed gate instead of announcing that versions are now fixed. It names the config the server list came from, and warns when that is a project `bundles.json`, because the managed tree is keyed on home alone: installing from project A writes A's dependency set into the one directory every project shares, and the broker in B then resolves out of it on A's versions with nothing in B to say why. Loader warnings go to stderr instead of being swallowed, and a `bundles.json` that exists but cannot be parsed is now reported as `unreadable-config` with a non-null `error` and exit 1, rather than as "no servers configured yet".

**Fixed -- `doctor` reported the runtime policy rather than the spawn**

The oam rewrite has six deterministic refusals -- a `node` launch naming no entry file or opening with a flag, an `npx` launch with no spec, a flag where the spec belongs, a git or path target, or a version range. Each holds on every machine, oam installed or not, and `doctor` reported all of them as "oam". Each is now its own runtime code with its own reason, derived through the rewrite's own predicates rather than re-implemented, and `sidecars` no longer hands `doctor` a partial server object that made every refused server look hosted.

Two more reporting failures went with it. An oam that is installed but wedged -- `oam --version` hanging, exiting non-zero, or not executable -- was reported as "not installed", sending someone who has oam installed off to install it again while the real cause never surfaced; it now reads `installed but UNUSABLE` with the underlying error and a command to reproduce it. And a `bundles.json` that had stopped parsing -- every server gone -- still printed "All good. yaw-mcp should start cleanly." and exited 0, because the loader's warnings were never folded into the report.

`doctor` now also checks that a client's yaw-mcp entry can start at all: an absolute launch command that no longer exists, a bare `oam` that a GUI-launched client cannot resolve against its own PATH (older installs wrote exactly that, and nothing rewrites them), or a stale `oam run <entry>` path. oam cannot fetch a missing entry on demand, so each of those is a hard launch failure with no fallback, and `doctor` is the only thing that can surface them.

**Fixed -- an oam boot failure pinned a server to node on no evidence**

When an oam-hosted server failed to boot, yaw-mcp respawned it on node and remembered the downgrade for the rest of the process. It recorded that memo *before* the respawn, so a server failing for a reason that has nothing to do with the runtime -- a missing `GITHUB_TOKEN`, which fails identically on both -- was pinned to node anyway. The in-process credential retry then supplied the token and reconnected on node, and every later reconnect stayed there, while `doctor` still reported oam. Nothing clears the memo short of a restart, so the memo is now written only when the node attempt actually behaves differently: booting cleanly, or failing in a different category. One wasted oam boot is cheaper than silently disabling oam hosting for the life of the process on evidence that never implicated it.

**Fixed -- a version-pinned sidecar could be hosted from a copy that does not match the pin**

`oam run <entry>` runs whatever sits at the path it is handed, so hosting a spec that constrains its version means proving the copy on disk satisfies it. `npx -y pkg@1.2.3` was resolved by package name alone, so the pin was honoured on npx and quietly ignored on oam. An exact pin now moves to oam only when the resolved copy declares that same version; a range or partial (`^1.2.3`, `~1.2`, `1.x`) always stays on npx, since honouring one means a semver range evaluator this package does not carry. The version parser also stopped truncating prereleases -- `oam 0.8.3-rc.1` read as `0.8.3`, which compared equal to the floor and was hosted, while every line printing the oam version named a release the machine does not have. Comparison now follows semver's prerelease precedence rules rather than a numeric triple.

Relatedly, node and npx launches are matched on the command's basename with any Windows executable extension stripped, so `/usr/bin/node app.js`, `node.exe`, and nvm or volta shims are now hosted on oam like a bare `node` -- they previously fell through to node with no explanation. `doctor` uses the same predicate, so the report and the spawn cannot disagree about it.

**Fixed -- the zsh completion ran most of its own subcommand list as shell commands**

The generator joined 19 subcommand specs with a bare newline, so only the first reached `_values` and the other 18 were emitted as standalone commands: the first TAB after `yaw-mcp ` offered `install` and nothing else, followed by 18 `command not found` errors. The specs also used `name:description`, which is `_describe` syntax -- `_values` reads the text after the colon as an argument spec, so every subcommand that did render came out with no description. bash, fish and PowerShell were unaffected. `install --help` is offered now too; it was always accepted and never completed.

**Fixed -- a two-character namespace was invisible to discover and dispatch**

The BM25 index dropped tokens shorter than three characters everywhere, including in identifiers. A server namespaced `pg`, `gh`, or `db` therefore had a permanently empty namespace field -- the second-heaviest weight in the ranking -- and an intent naming only that namespace ("use pg") ranked nothing at all; `s3` and `ec2` fragments inside tool names went the same way. Descriptions keep the three-character floor, where noise words actually live. Namespaces, server names and tool names index down to one character, because an identifier is chosen rather than written: a two-letter namespace is a deliberate name, not a stopword.

**Fixed -- three commands that misreported their own failure**

`yaw-mcp compliance <target> --min-grade A` printed "Grade F is below threshold A" on stderr and exited 0. The wrapper discarded the child's exit status, so `--strict` and `--min-grade` were silent no-ops through yaw-mcp and no CI gate built on them ever fired. A malformed report from the compliance child -- spawned unpinned, so everyone runs whatever npm calls latest -- could also print `undefined/undefined passed` and exit 0; every field the summary formats is now validated before rendering, and anything that fails routes into the existing "unexpected JSON" path.

`yaw-mcp audit` threw a raw errno out of the dispatcher when `grades.json` could not be written -- a read-only home in a container or a locked-down CI image is the common shape. The grade the suite had just spent minutes computing was never printed, and the process exited 1, the code documented as "no server with that namespace", so anything branching on exit codes read a cache-write failure as a typo. The grade prints either way now, with a dedicated exit 3 and a `cacheError` field in `--json`.

And a damaged vault verification marker reported `wrong passphrase for this vault` -- for a passphrase that was correct, about a vault whose secrets were all still readable. A key that opens an entry but not the marker now names the marker as the damaged part.

**Fixed -- `bundles match` offered activations the broker would refuse**

The partition counted every enabled server in `bundles.json`, while the broker also narrows by the `config.json` allow/deny profile. A denied namespace made a bundle read as "Ready to activate" alongside an `mcp_connect_activate` snippet the server then hard-refused -- the one thing that command exists to get right. The profile is applied now, and what it excluded is named rather than silently missing from the count, so a bundle that "should" be ready reads as the deny-list working instead of as a broken matcher.

**Fixed -- the long tail**

The rest is the kind of thing you only notice when it bites. A per-server `connectTimeoutMs` in `bundles.json` was dropped by the loader's field whitelist, so nothing in the process could ever set the value the connect path reads. `secrets audit <name>` ignored the argument instead of pointing at `--secret`/`--server`, and `--stdin`/`--value` were accepted on actions that have no use for them; `--value`'s help now says the value is visible to every local user via `ps` for the whole run, key derivation included. `reset-learning` now says that a running `yaw-mcp serve` holds the same learning in memory and re-saves it over the deleted file within a second of the next tool call. A trust store written by a newer yaw-mcp is refused with an upgrade instruction instead of being treated as corrupt and offered for deletion, and `trust` no longer asks you to "read all the commands above" for a file that defines none. `doctor` reads the tail of each shell history rather than the whole file -- a multi-hundred-MB history threw and took the shadowed-CLI section with it, silently. A trial marker is validated before `try-cleanup` acts on it, and the trial help no longer claims a timer sweeps expired entries; `doctor` is what removes them. `prune` stops round-tripping numbers it cannot reproduce exactly, so a large identifier in a tool result survives truncation intact. npm's `cache=` setting is parsed with npmrc's own quoting, escape and inline-comment rules, and `~/` is expanded. A stale `lastIndex` on a shared regex could make the secrets report skip leading references, which reads as "this server needs no secrets". Learning counters clamp `succeeded` to `dispatched` rather than the reverse, so a corrupted state file inflates nothing. discover's three-second memo is dropped when an activation fails or the learning counters move, so a re-discover no longer replays pre-failure text and sends the model back at a server it just watched die. A tool filter installed for an activation that then failed is rolled back instead of narrowing a later, successful load nobody filtered. And the meta-tool name set that keeps meta-tools out of an `exec` pipeline is derived from the definitions rather than hand-listed, so an eleventh meta-tool cannot become exec-callable by omission.

The balance is dead code, predicates that had been copied and started to drift, comments describing behaviour that changed releases ago, and error paths nothing exercised. The suite grows from 2,138 to 2,412 tests, all of it regression coverage written alongside the fixes.

## 0.74.1 -- oam becomes the default sidecar runtime

**Changed -- oam hosts the sidecars by default**

When oam is installed and meets the minimum version, yaw-mcp now hosts the MCP servers it spawns on it without any configuration. Previously this required `runtime: "oam"` on each server or a top-level `defaultRuntime` in `bundles.json`.

Nothing is required and nothing changes for a machine without oam: those servers run on node/npx exactly as before, and no warning is printed, because nothing was asked for. The escape hatches are unchanged and still win -- `runtime: "node"` on a server, `"defaultRuntime": "node"` for the whole machine, or `YAW_MCP_DEFAULT_RUNTIME=node` for one process. Only Node-based launches are rewritten; `docker`, `uvx`, and native commands are untouched.

**Fixed -- the oam runtime never actually reached the sidecars on a global install**

An opted-in sidecar silently ran on npx instead of oam whenever yaw-mcp itself was installed globally. Resolving an `npx -y <pkg>` server to an on-disk entry requires finding npm's `_npx` cache, and that lookup was derived from the broker's own module path -- so it only found anything when the broker had *itself* been launched through npx. A global install has no `_npx` segment in its path and therefore found nothing.

The result was the feature quietly doing nothing on the most common shape, made worse by `install` recommending `npm i -g @yawlabs/mcp` in order to host on oam. `doctor` reported those servers as "oam" the whole time, because it reports the policy decision rather than the spawn. The cache is now located from npm's own configuration, independent of how the broker was started, so all three shapes -- global, project, npx -- resolve. The only trace of this was a `debug`-level log line.

**Added -- `yaw-mcp sidecars install`**

Installs the npx-launched servers from `bundles.json` into `~/.yaw-mcp/sidecars`, and resolution prefers that tree over npm's npx cache. One copy per package at a version that is written down, and re-running the command is how it moves forward.

This is the answer to the pinning note below. The npx cache is keyed by content hash, so it accumulates every version ever fetched and names none of them current; a managed install replaces that with a single deliberate answer. `yaw-mcp doctor` prints the installed version of each configured package.

Deliberately not automatic: acquiring packages means network and minutes, and the connect path is what an MCP client blocks on while waiting for its tools. Nothing requires it -- without it, resolution falls back to the npx cache exactly as before.

npm does the installing, not `oam install`: that is frozen-lockfile only, so it cannot acquire `@latest` into an empty directory; its `--precompile` has nothing to do for packages that ship compiled JavaScript, which every MCP server does; and running it over an npm-installed tree skips lifecycle scripts unless the package is trusted, which would quietly cost puppeteer its browser download.

Only npx servers naming a registry package are installed. An npx launch pointing at a git or path target -- `npx -y github:owner/repo`, `npx -y ./local-server` -- is skipped and named in the output, and keeps using npx. Those specs carry no `@version` separator to cut at, so they would otherwise have become dependency *keys* (`{"github:owner/repo": "latest"}`), which npm rejects -- failing the install for every other package too. Resolving them properly would mean fetching the target just to learn the name it declares, which is more than this command should do.

Two servers pinning one package at different versions is reported rather than silently resolved: a flat `node_modules` holds a single version, so the command names the one it installed instead of letting the loser start on something it did not ask for.

`--json` emits the same keys on every path -- `root`, `installed`, `reason`, `error`, `conflicts`, `skipped` -- so a caller can read the result without first determining which path it took. `reason` distinguishes the empty states: `no-config` (nothing configured yet), `no-npx-servers` (a docker/uvx-only config), and `only-non-registry-specs`.

**Changed -- an oam-hosted sidecar no longer self-updates, and now says so**

`npx -y <pkg>@latest` re-resolves the tag on every spawn; `oam run <entry>` cannot, because oam has no fetch-on-demand. Once oam is the default, npx stops running for those servers, so the on-disk copy that supplied the entry also stops being refreshed and the version pins itself indefinitely.

This was already true for servers that opted in explicitly; making oam the default makes it apply broadly, so it is now logged. yaw-mcp reports the resolved version once per package at startup rather than leaving it to be discovered. Refresh a pinned sidecar by running it through npx once, or set `runtime: "node"` on that server to keep npx's self-updating behavior.

**Fixed -- an arbitrary cached version could be run instead of the newest**

The npx cache is keyed by content hash, so a machine that has run a server for months holds every version it ever fetched. Resolution took the first directory-listing hit, which is hash order, so a server configured as `@latest` could be started from a months-old build with nothing logged. The highest version present now wins, and a durable `npm i` install still takes precedence over any cached copy.

**Changed -- minimum oam version is 0.8.2, and now tracks the latest oam release**

Raised from 0.6.0. The floor is no longer set by whichever release happened to fix something yaw-mcp noticed; it tracks the current oam release and moves with every one. oam is pre-1.0 and moves fast, and oamjs.org only ever installs the current release, so hosting sidecars on anything older means running a build nobody else is.

A below-minimum oam is refused rather than silently used -- the servers run on node instead, which is where they were before oam existed, with one warning naming both versions. `install` now says so when oam is missing.

**Changed -- `LICENSE` renamed to `LICENSE.md`**

The license file is renamed from `LICENSE` to `LICENSE.md` and `package.json` now declares `SEE LICENSE IN LICENSE.md` rather than the doubled-up `SEE LICENSE IN LICENSE`. `SEE LICENSE IN <filename>` is npm's own syntax for a license with no SPDX identifier, so the repetition was just the filename having no extension.

Cosmetic only. The license text, its terms, and the licensor are unchanged.

## 0.74.0 -- local-only: the hosted control plane is retired (BREAKING)

The hosted backend is gone. Every endpoint yaw-mcp called returns 404 -- `/api/connect/config`, `/heartbeat`, `/analytics`, `/servers`, `/api/compliance/ext`, `/api/try/event`, the dashboard, and `/signup`. Rather than keep code that cannot succeed, account mode is removed outright: your servers come from `~/.yaw-mcp/bundles.json` and your credentials from the local encrypted vault. Roughly 5,800 lines deleted.

Only two hosted surfaces survive, and neither needs an account: the public server catalog at `https://yaw.sh/data/mcp-catalog.json` (fetched on demand by `add` / `try`) and its browsable form at `https://yaw.sh/mcp/catalog/`.

**Breaking -- removed**

- `mcp_connect_install` and `mcp_connect_import` meta-tools. Both wrote to the account and already hard-errored in local mode. Add servers with `yaw-mcp add <slug>`.
- `compliance --publish` -- posted reports to a dead endpoint. Now rejected with exit 2.
- The 60s config poll. `bundles.json` is read once at startup, so restart the MCP client after editing it.
- Semantic reranking. Ranking is BM25 computed locally, plus the health, learning, and sampling signals. The Voyage-backed embedding index it depended on is retired.
- All telemetry. The analytics, heartbeat, and tool-report posters are deleted, and `try`'s event POST is a no-op that no longer computes or stores a machine fingerprint. Nothing is transmitted off your machine.
- `yaw-mcp servers` is now a deprecation stub that prints to stderr and exits 1. It is retained for one release because Yaw Terminal's MCP panel shells out to it and reads a non-zero exit as signed-out; the compliance grade it used to show moved to a `GRADE` column in `yaw-mcp list`.

**Breaking -- `yaw-mcp remove` now confirms**

`remove` was the only destructive verb without a gate. On a TTY it previews the namespace, name, launch command, and env KEY names (never values), then asks -- bare Enter is no. Off a TTY it refuses with exit 2 and names `--force`.

This breaks scripted use, and it breaks intermittently: a script removing an already-absent server still exits 0, so the cleanup path that worked yesterday fails the one time there was something to clean. Add `--force`. The gate exists because removal is less reversible than it looks -- env values stored on the entry go with it and `add` will not bring them back.

**Breaking -- Node 20 is the floor**

`engines` moves from `>=18.17` to `>=20`, and the build target moves from `node18` to `node20` to match. This is a correction, not a new requirement: `@yawlabs/mcp-compliance` is a direct production dependency and already required `node>=20`, so the package could not actually run on Node 18 while still advertising that it could. Node 18 is also past end of life.

The practical change is where it fails. `npm install` on Node 18 now refuses with `EBADENGINE` instead of installing a tree that breaks at runtime. `npx -y @yawlabs/mcp` is unaffected -- it pulls a recent Node on its own.

**Deprecated for one release -- still accepted, now warns**

- `--token` and `--no-yaw-mcp-config` on `yaw-mcp install`. Both are still fully parsed, so `install --all --token mcp_pat_...` keeps working and keeps exiting 0; the values are ignored.
- The `token` and `apiBase` keys in `.yaw-mcp/config.json`. The file still loads; a warning names it and tells you to revoke the PAT at its source, since deleting the key does not deactivate it.
- `doctor --json` keeps every key it used to emit. `token` and `apiBase` retain their nested shapes with null members and `backgroundPosters` keeps `{"analytics": null, "toolReport": null}`, rather than flattening to a bare `null` that would throw for anyone reading `.token.source`.

**Security**

- **Project `bundles.json` now requires explicit consent.** A project-scoped `<project>/.yaw-mcp/bundles.json` is normally committed to a repo, and every server in it is a command yaw-mcp spawns as you at startup. Cloning a hostile repo and opening an editor in it was enough to execute arbitrary argv. An unapproved file is ignored and your user-global file still loads; approve with `yaw-mcp trust`, which prints every command and arg before asking. Approval pins the file's SHA-256, so a later commit re-requires it. `--list` flags drifted entries, `--revoke` withdraws, and `YAW_MCP_TRUST_PROJECT=1` bypasses for CI. Your own `~/.yaw-mcp/bundles.json` is never gated.
- The consent preview escapes C0, DEL, C1 (0x9b is 8-bit CSI), and bidi overrides. Without it a repo could conceal its argv with SGR 8 or erase the rendered block with cursor-up before the prompt painted, defeating the one thing the gate guarantees.
- An unreadable project file no longer suppresses your user-global servers. A repo committing `.yaw-mcp` as a regular file (ENOTDIR) or `bundles.json` as a symlink loop (ELOOP) previously dropped every server on POSIX.
- Dropping the `apiBase` precedence chain closes a real hole: project scope was honored for `apiBase` while refused for `token`, so a committed project config could redirect the API base and the global token would follow it to an attacker host. `url-safety.ts` is deleted with it -- nothing dials a config-supplied URL any more.
- A transient trust-store read error (EACCES/EIO, an antivirus lock) no longer wipes every approval; I/O and parse failures are distinguished and I/O refuses to write.

**Fixed**

- `YAW_MCP_MIN_COMPLIANCE` was silently inert and the discover `[A]`-`[F]` badge never rendered -- `complianceGrade` lost its supplier with the backend and nothing read `grades.json`. Grades are now overlaid at startup.
- Prewarm respawned every active server on every client start, because the tool cache lost its only writer. It is persisted at state schema v2; v1 files migrate rather than being dropped.
- A tool-name collision between two upstreams pointed `tools/list` and dispatch at different servers -- the model saw one upstream's schema while the call executed another's, letting a later-activated server capture an earlier one's traffic. Both surfaces now agree on the first writer.
- On Windows, an `npm --prefix` containing a space was split into two argv tokens by the `shell: true` self-upgrade spawn, so the upgrade landed in the wrong tree and the running copy stayed stale. `C:\Users\<First Last>\AppData\Roaming\npm` is npm's default global prefix, so any account with a space in its name hit this on every stale startup.
- `doctor` lost its only exit-2 path when account mode went (both gates tested `config.token === null`), so a malformed config exited 0. The gate is unconditional now.

**Added**

- A root `LICENSE`: source-available, not open source. Free personal and commercial use and redistribution of unmodified copies; no right to offer it to third parties as a competing product. Contributions are accepted under DCO 1.1 sign-off -- no CLA, no copyright assignment. `package.json` previously declared `UNLICENSED` with no license file at all.
- `yaw-mcp trust` (`--list`, `--revoke`, `--yes`, `--json`).
- Test coverage grew from 1,809 to 1,998 tests. `ConnectServer.start()` had none and is now the only startup path.

## 0.73.1 -- README rewrite and a full-pass review sweep

**Docs.** The README is rewritten against `index.ts --help`, `KNOWN_SUBCOMMANDS`, and `meta-tools.ts` -- about half its former length. It drops the retired Yaw Team surface (`login`/`logout`/`sync`/`stats`, `secrets push`/`pull`, `rotate --push`), gone since 0.71.0 but still documented, and adds the previously-undocumented top-level `audit` and `mcp_connect_secrets`.

**Fixed** -- 33 findings from a full-pass sweep of all source files, each adversarially re-verified before being fixed:

- `YAW_MCP_MIN_COMPLIANCE` was enforced only in `handleActivate`; the floor gate moved into `runActivateOne` so dispatch, discover auto-warm, deferred activation, and autoLoad all honor it.
- A concurrent-server-cap TOCTOU: the slot is reserved synchronously before `connectToUpstream`, so parallel activations of distinct namespaces cannot exceed the cap.
- A non-string allow-list entry no longer collapses to `[]` (allow-all), shadowing a valid parent scope; it warns and falls through.
- `recordSuccess` no longer fabricates a dispatch; shutdown counts an undrained backlog as dropped; sub-30% error rates are surfaced rather than silently penalizing rank.
- A child that dies during the initial fetch window is no longer reported as connected.
- Secret redaction sorts longest-first, so a secret that is a substring of another cannot leak a tail.

Intentionally deferred: converting `index.ts`'s 39 `process.exit()` calls to `process.exitCode` (needs restructuring the top-level ESM dispatch), and `reward.ts`'s first-text-block-only grading heuristic (changes cross-session learning behavior).

## 0.73.0 -- post-merge review findings and ship-ready UX blockers

**Fixed**

- PowerShell positional completion was entirely dead. Every slot guard read `if ($tokens.Count -eq <index+2>)`, but that switch only runs inside the `else` of `if ($tokens.Count -le 2)`, so slot 0's `-eq 2` could never be true and no client, action, or shell candidate was ever offered. Verified with `TabExpansion2` against real PowerShell 5.1. bash/zsh/fish were correct and untouched.
- The secrets audit log recorded `injected` for secrets that were never injected. `recordResolveAudit` ran before the fail-closed missing-refs throw, so a refused spawn still logged every resolvable ref as injected -- meaning `yaw-mcp secrets audit` answered "did this server ever receive my prod token" with a false yes. Only `missing` events are recorded on that path now.
- A fatal startup config error exited 0. The fire-and-forget `runServer()` rejection was caught by the last-resort `unhandledRejection` handler, so a bad `YAW_MCP_URL` reported failure while returning success to any supervisor. Exits 1 now.
- An invalid secret name was rejected only after both prompts, so `secrets set "my token"` made you enter a passphrase and a secret value before saying the name was never valid. Validated in `parseSecretsArgs` now.
- The compliance shell-fallback message named the wrong characters -- `quoteForShell` also rejects `%` on win32 and `'` on POSIX.
- A pre-existing prompt bug in the same reader path: the value prompt rendered as `Secret value: Vault passphrase: `.

**Ship-ready blockers**

- `yaw-mcp --HELP` booted a silent stdio server. `suggestFlag` dropped the one alias you meant from its own candidate pool, returned `[]`, and fell through to `runServer()` -- the exact hang that branch exists to prevent. Exits 2 with a suggestion now.
- Neither destructive secrets path confirmed. `secrets remove` deleted immediately, and `secrets set` over an existing name overwrote while printing the same message as a fresh write. Both are now gated the way a config collision already was: prompt on a TTY, refuse off one. `remove` is gated both ways since it is unrecoverable; `set` still proceeds non-interactively so rotation scripts keep working, but prints `Replaced secret "X"` and sets `replaced` in `--json`.

## 0.72.0 -- unblock the release on win32-arm64

**Fixed**

- Pinned `@biomejs/biome` to 2.4.16. The 2.5.x native binary segfaults (exit 139) on MINGW64-ARM64 before producing any output, which blocked `npm run lint` and stalled the release script -- its tolerance paths could not engage because there was no output to match against. 2.4.16 runs cleanly.
- `biome.json` follows the 2.4 flat schema (`rules.recommended: true` rather than `rules.preset`), plus the formatter rewrites that pin brought with it.

## 0.71.0 -- remove the Yaw Team surface (BREAKING)

The Yaw Team tier is fully retired. The yaw.sh `/api/team/*` and `/api/admin/*` endpoints have been deleted, so every command that spoke to them is removed rather than left to fail at runtime.

**Breaking -- these subcommands no longer exist:**

- `yaw-mcp login` / `logout` / `token` -- team session auth.
- `yaw-mcp sync` (`push` / `pull` / `status`) -- replicated `bundles.json` via the team resource. The local file was the payload; the transport was team, so there is nothing left to keep.
- `yaw-mcp stats` -- read team-analytics; it had no local data source.
- `yaw-mcp set-active` -- wrote the shared team resource.
- `yaw-mcp secrets push` / `secrets pull`, and the `--force` / `--replace` / `--push` flags. These are now **rejected** with a usage error rather than accepted as no-ops -- a flag that parses and does nothing reads as supported.

**Not affected -- these are local and keep working:**

- **The secrets vault.** `secrets set` / `get` / `list` / `remove` / `lock` / `rotate` / `audit` are entirely local and unchanged. `rotate` still re-encrypts every entry under a new passphrase; only its optional `--push` step is gone, making it a purely local operation.
- **Reranking.** `rerank.ts` had two transports. The team path is removed; the legacy `MCPH_TOKEN` endpoint is retained, so account-mode reranking works as before and still falls back to BM25 when the backend is unavailable.
- **Analytics.** Only the team tee-out is gone. Local buffering, flushing, and the connect/dispatch endpoints are unchanged.

`src/team-sync.ts` is deleted in full.

## 0.70.3 -- drop the SEA binary track; npm install is the install story

The per-platform Node SEA (Single Executable Application) build track is removed. Going forward, install via `npm install -g @yawlabs/mcp` (or `npx -y @yawlabs/mcp`). See `docs/v0.70.3-binary-track-decision.md` for the full rationale; short version: the SEA track required a dedicated build host per platform (Node SEA cannot cross-compile), the GCP and AWS path for win32-x64 + linux-arm64 hit a 5-hour OpenSSH bootstrap and a `CPUS_ALL_REGIONS` quota lockout, and the npm install path covers every install target we ship to with one build.

- **`release.sh` simplified to 5 steps.** Lint + typecheck + tests (step 1), build (step 2), bump + commit + tag + push (step 3), publish to npm (step 4), publish `server.json` to the MCP registry (step 5). The previous `--build-only` and `--upload-asset` subcommands are removed; `release.sh` now has one mode and a single entry point.
- **Build-infra files deleted.** `sea-config.json`, `scripts/build-binary.mjs`, `scripts/build-platform-remote.sh`, `scripts/build-platforms-all.sh`, `scripts/build-win-x64-ephemeral.sh`, `scripts/platforms.json.example`, `scripts/stage-release-asset.mjs`, `scripts/update-manifests.mjs`, and the untracked `bin/platforms.json` + `bin/win32-arm64/` are removed. The `.gitignore` entries for `bin/`, `build-tmp/`, and `dist-release/` go with them.
- **`postject` devDependency removed.** It was the only Node-SEA-only dep.
- **Install paths collapsed.** `BINARY_DISTRIBUTION.md` (which documented the SEA build) is replaced with a one-page install guide pointing to npm. Scoop (`YawLabs/scoop-yaw`) and Homebrew (`YawLabs/homebrew-yaw`) taps are not updated for 0.70.3 and may lag -- prefer `npm install -g @yawlabs/mcp` until the taps catch up.

## 0.70.1 -- `yaw-mcp token` subcommand for trusted local apps

Adds a `token` subcommand that prints this machine's Yaw Team session token (the raw `yaw_team` cookie) on stdout, for a TRUSTED LOCAL app to present to a Yaw endpoint that verifies the same HMAC session -- e.g. Vew Meetings' `POST /api/meeting`. Makes NO network call: reads the session persisted by `login` and emits it only when still valid (exp-checked via `team-sync`'s `loadStoredState`), else exits 1 with nothing on stdout.

- **`team-sync`:** new `getSessionWithCookie()` reads + exp-validates the stored `{ cookie, session }` and returns it (or `null`); no network call.
- **Registered everywhere a subcommand must be:** `index.ts` dispatch + help, `KNOWN_SUBCOMMANDS`, and `SUBCOMMAND_SPEC` (the completion-coverage test enforces no drift). `--json` emits `{ ok, token, email, exp }`; plain prints the raw token (treat stdout as sensitive -- it's a bearer credential).
- **Completion spec dedup.** `SUBCOMMAND_SPEC` had a stale duplicate `token` entry from a prior WIP; removed so the spec stays one-entry-per-subcommand. Caught by `biome check` formatting the now-double entry, not by the coverage test -- the spec coverage test should arguably also assert uniqueness, file a follow-up.

## 0.63.2 -- release pipeline: publish npm from CI

No changes to the package runtime or CLI -- this release exists to exercise the
new CI-on-tag-push publish flow end to end. The published artifact is identical
to 0.63.1 aside from the version bump.

- **npm is now published from CI, not the workstation.** A new `publish-npm` job
  in `release.yml` publishes `@yawlabs/mcp` on every `v*` tag using the org
  `NPM_TOKEN` + `--provenance` (the repo and package are public), gated on the
  binary build so npm and the GitHub Release stay in lockstep. It is idempotent:
  a version already live is a clean skip, and an `EPUBLISHCONFLICT` from
  registry read-replica lag is treated as success. `publish-registry` now
  `needs: publish-npm`, so the MCP-registry verify can no longer race ahead of
  the npm publish. `release.sh`'s hand-off detection was tightened to key on a
  real `npm publish` / `NODE_AUTH_TOKEN` signal instead of the registry job's
  `id-token: write` (the false positive that wedged the 0.63.0/0.63.1 runs).
- **Registry job hardening.** `mcp-publisher` is pinned to a tagged release and
  verified against its published sha256 before execution (was an unpinned
  `curl .../latest | tar`), and the job pins its Node toolchain via `setup-node`.

## 0.63.1 -- CLI follow-ups: wire dead --dry-run/--stdin flags, fix completion drift, dedup probes

Patch-level follow-ups on the 0.63.0 CLI hardening pass. All fixes; no behavior changes for callers who weren't already hitting the dead-flag bugs.

- **`sync push --dry-run`** now short-circuits before any remote mutation. The flag was parsed but never checked by `syncPush`, so a "dry-run" PUT actually mutated `mcp_bundles`. Preview now prints server count and exits 0 without calling `putResource`.
- **`secrets set --stdin`** now reads raw multi-line stdin even on a TTY. The flag was parsed but never consumed by `runSecrets`, so it silently fell through to the line-buffered echo-off prompt regardless. `--stdin` now forces the raw read path as documented.
- **`install <client> --dry-run`** now bypasses the collision gate. With an existing yaw-mcp entry + non-TTY stdin, the gate refused before the dry-run preview block ever ran -- so the "...or --dry-run to preview" hint was unreachable. The decision chain now treats `dryRun` like `force` for the overwrite-vs-skip choice.
- **Completion `SUBCOMMAND_SPEC` drift fixed.** `sync` no longer advertises a phantom `--key` (replaced with the real `--dry-run`); `secrets` no longer advertises a phantom `--key` (replaced with the real `--force`).
- **`try-cmd` telemetry POSTs are now awaited.** Three fire-and-forget `postEvent(...).catch(() => undefined)` calls (try / cleanup / expiry-gc) could be killed by `process.exit` before the request landed. Now awaited so the analytics event reliably reaches the backend before exit.
- **`doctor` `state.json` double-read eliminated.** `peekStateFile` hoisted to the caller and the result threaded into `renderStateSection`, removing the redundant disk read inside the section.
- **`doctor` probe duplication removed.** Extracted `classifyProbeContent` shared by both sync and async client-config probes (~60 lines deduped). Also added the missing `try/catch` around `resolveInstallPath` in `probeClientsAsync` for parity with the sync variant.
- **`secrets get` / `remove` against a missing vault or missing entry** now short-circuit before the passphrase prompt, avoiding the wasted scrypt key derivation just to say "not found".
- **`upgrade-cmd`:** removed unreachable `if (!plan.command)` branch -- every install method whose plan reaches that point already returned earlier in the chain.
- **`index.ts` help text:** corrected the `YAW_MCP_AUTO_UPGRADE` description ("yaw-mcp serve startup" was not a subcommand; now "server startup").

## 0.63.0 -- CLI hardening: flag parsing, exit-code consistency, secret-file perms, dispatch error handling

A full-pass sweep of the `yaw-mcp` subcommand surface. Every change is a fix, a hardening, or additive; there are no breaking changes to the MCP server or the public CLI contract.

- **Value-taking flags no longer swallow a following flag.** `login --key`, `secrets set --value`, `try --base`, and `add --catalog` reject a dash-prefixed token instead of storing it as the value -- e.g. `login --key --json` no longer POSTs `"--json"` as the license key, and `try slug --base --dry-run` no longer silently drops `--dry-run` and wires the trial for real. (`--value` points at `--stdin` for a genuinely dash-leading secret.)
- **`--help` / exit-code consistency.** `yaw-mcp audit --help` and `compliance --help` now print usage to stdout and exit 0 like every other subcommand (compliance previously forwarded `--help` into an `npx` download); `compliance` with no target exits 2 (arg error) instead of 1.
- **Uncaught command rejections are handled.** Every subcommand funnels through a shared dispatcher `.catch` that prints `yaw-mcp <cmd>: <message>` and exits 1, instead of dumping a raw Node stack and bypassing the logger (reachable e.g. via `secrets` against a corrupt vault).
- **Secret-bearing files are born 0600.** `atomicWriteFile` gained a creation-mode option; the token config, team session cookie, encrypted vault, and the install config backup are now written owner-only rather than sitting at the default umask in the window before the post-hoc chmod. `install --dry-run` redacts the token in the config dump, and `--token` carries a process-table exposure note.
- **`doctor`:** `--json` now runs the same expired-trial GC as the text path, and the snapshot carries the `trials` + `backgroundPosters` sections (it was not the "1:1 mirror" its comment claimed). The header documents the config read-modify-write side effect and the now-unreachable exit code 1.
- **Completion drift guard made real.** Shell completion now offers `foundry`, and the completion test asserts coverage against the real dispatch table (extracted to `src/subcommands.ts`) instead of a hand-maintained list that had silently diverged.
- **`secrets`:** `get` documents that it prints cleartext (with an interactive-TTY stderr warning); Ctrl-D at the passphrase prompt cancels instead of submitting a partial passphrase; `pull` empty-remote `--json` carries the same hint as the prose path.
- **`compliance --publish`** projects the report to an explicit allowlist before upload (no echoed env/argv/stack leaks), and the suite child's stdout is capped (16 MB) behind a wall-clock watchdog.
- **`upgrade`:** the `_npx` marker now requires the full npm-cache hex context, so a user project path that merely contains a `_npx` segment is no longer misclassified as an npx run; the 1->2 exit sequence for non-runnable methods (binary/dev-checkout) is documented.
- **`add`** trims whitespace-only `--env` values so a blank-ish required secret is never persisted to bundles.json. Did-you-mean now includes `help`, gates its substring tier for very short queries, and a leading-dash near-miss (`--versionn`) suggests the flag instead of silently booting the MCP server.
- **deps:** `esbuild` override pinned to `^0.28.1`.

## 0.62.0 -- verifiable-signal routing: graded reward, miss tracking, and an eval foundry

Lands #25, #26, and #27. The dispatch router's learning signal moves from a binary "any non-error reply counts as success" to a sound, quality-graded reward, plus the surrounding machinery to manufacture and verify that signal. All of the new behavior is additive and the new knobs are off by default, so existing setups are unchanged.

- **Dispatch reward is now graded, not binary.** An empty body or an error-shaped 200 (e.g. `{isError:false, text:"not found"}`) no longer banks full credit toward a server's `mcp_connect_dispatch` boost -- the learning signal is a quality-weighted reward in [0,1], so a server that "replies" but does not actually help stops accruing a nudge. When every reply is a clean success or a hard error this collapses to the old behavior.
- **Re-dispatch miss signal.** When an intent routes to server A, A replies cleanly but is abandoned, and a token-similar intent then routes to a different server B within ~2 minutes, A is penalized as the wrong route. Designed multi-server flows (curated bundles, detected packs) are excluded so an intentional A-then-B chain is not mistaken for a miss.
- **Step-level (process) reward in `mcp_connect_exec`.** Each pipeline step is graded on its own; a step that fails on bad `$ref` input it consumed from an upstream step splits the blame with the producer instead of being fully blamed, so a flaky producer does not hide behind a healthy consumer (or vice versa).
- **Routing effort dial -- `YAW_MCP_ROUTE_EFFORT=off|auto|aggressive`** (also a per-call `routeEffort` arg on `mcp_connect_dispatch`). Controls how much LLM sampling dispatch spends to disambiguate close rankings. `auto` (default) preserves the prior fixed top-2 tiebreak exactly -- no latency change on the default path; `aggressive` samples best-of-3 on milder ambiguity; `off` never samples.
- **Opt-in LLM reward grader -- `YAW_MCP_REWARD_GRADER=1`** (off by default). On the uncertain reward bands only, it asks the client's own LLM (via MCP sampling) whether a call accomplished the goal and revises the credit in the background. Non-blocking (the tool result never waits on the grade), capability-gated, and never-throwing -- a missing capability / timeout / unparseable reply just leaves the heuristic reward standing.
- **Opt-in routing-eval harvest + CI gate -- `YAW_MCP_FOUNDRY=1`** (off by default). Writes a privacy-safe `(intent -> chosen server)` corpus to `~/.yaw-mcp/foundry.jsonl`: the intent is reduced to a redacted, secret-stripped, order-shuffled token bag, never the raw text. New `yaw-mcp foundry export` folds the harvest into a checked-in regression corpus (snapshotting the local server catalog), and a BM25-floor gate scores the ranker against real dispatches -- it skips cleanly until a corpus is committed.

## 0.61.0 -- audit-fix wave: exec binding payloads (BREAKING), live-bug fixes, 50+ hardening items

- **BREAKING: `mcp_connect_exec` step bindings now hold the step's semantic payload, not the raw MCP wire wrapper.** A single-text-item JSON response binds as the parsed value, a non-JSON text response binds as the string, and anything else binds as the content array. `$ref` paths written against the old wire shape -- e.g. `"stepId.content[0].text"` -- now throw a RefError; migrate to `"stepId"` (whole value) or `"stepId.field"` (a specific field). This matches what the tool description always promised.
- `mcp_connect_activate` / `mcp_connect_dispatch` set `isError` whenever a real activation failure occurs (partial successes no longer mask failures); concurrent-server-cap refusals are flagged internally and stay informational in both. Deactivating an already-unloaded namespace is now an idempotent success.
- ~30 further fixes from a full-implementation audit: bundles.json write serialization + ENOENT-only absence handling, `list` surfaces parse warnings, analytics 401 no longer clears the team session, `secrets pull` refuses cross-passphrase overwrites without `--force`, uv probe/retry fixes on Windows, stable array positions in pruned tool output, `--help` exits 0 on stdout across subcommands, ASCII-safe terminal output, and assorted copy corrections.

## 0.60.3 -- npm-prefix refinement + pnpm/bun self-upgrade

- `refineInstallMethod` now probes `npm prefix -g` (3s timeout) and normalises the result through `realpathSync` so junctioned prefixes (scoop's `current` symlink, Volta shims) resolve to the real path before comparison. When the running entrypoint lives under the npm global prefix, ambiguous `local-node-modules` / `unknown` detections are promoted to `global-npm` -- fixes exotic prefix setups the path-marker list doesn't know.
- The probe is wired into both `yaw-mcp upgrade` and `yaw-mcp doctor` via the shared `refineInstallMethod` call in `runUpgrade` / `runDoctor`.
- `maybeAutoUpgrade` (the fire-and-forget startup check) now acts on stale pnpm and bun global installs with `pnpm add -g` / `bun add -g @yawlabs/mcp@latest` in addition to the existing `npm install -g` path. The background spawn log messages interpolate the actual tool name instead of hardcoding `npm`.

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
