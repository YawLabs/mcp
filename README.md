# @yawlabs/mcp

**One install. Every MCP server. Managed from one place.**

Yaw MCP (the `yaw-mcp` CLI) is an MCP server that fronts every other MCP server you use. Point each AI client (Claude Code, Claude Desktop, Cursor, VS Code) at it once, and your servers load lazily from a single connection instead of a hand-edited `mcpServers` block per client.

It runs entirely on your machine. No account, no sign-in, no telemetry -- your servers live in a local `bundles.json` and your credentials in a local encrypted vault. Running as an MCP server, its only outbound call is a background npm check for its own updates (`YAW_MCP_AUTO_UPGRADE=0` to disable); `yaw-mcp add` fetches the public server catalog on demand.

It earns its keep when you hit any of these:

- **More than one client.** Define a server once in `bundles.json`; every client on the machine picks it up. No copy-pasting the same JSON into four config files. (Sync `bundles.json` across machines with your dotfiles if you want it everywhere.)
- **Tool-context bloat.** The `dispatch` meta-tool ranks your servers against the task and loads only the top match. A 30-server setup keeps a handful of tools in context at a time instead of hundreds.
- **Tokens you'd rather not leave in disk configs.** Credentials live encrypted in a local vault and inject at spawn time. Rotate once; every client picks up the new value.
- **A trust signal before you activate.** Every scored server shows an A-F compliance grade. Set `YAW_MCP_MIN_COMPLIANCE=B` to refuse anything below.

One client, a few servers? `claude mcp add` is fine -- yaw-mcp's value shows up when that setup stops scaling.

## How it works

```
Your MCP client (Claude Code, Cursor, ...)
    |
    |  single stdio connection
    v
@yawlabs/mcp  --lazy load-->  GitHub | Slack | Stripe | ...  (your servers)
```

1. Add servers with `yaw-mcp add <slug>` (or edit `~/.yaw-mcp/bundles.json` directly).
2. yaw-mcp reads that file on startup.
3. The model uses a handful of **meta-tools** to control which servers' tools are in context. Adding a server puts it on your list; loading it brings its tools into the session.

| Meta-tool | What it does |
|-----------|--------------|
| `mcp_connect_dispatch` | Describe a task in plain English; picks the best server, loads its tools, exposes them in one call. The fast path. |
| `mcp_connect_discover` | List available servers, optionally ranked by a context string. Auto-loads the top match when one clearly wins. |
| `mcp_connect_activate` / `deactivate` | Load / unload specific servers by namespace. |
| `mcp_connect_read_tool` | Return one tool's schema without loading its server. |
| `mcp_connect_exec` | Run a short declarative pipeline of tool calls in one round-trip (`{"$ref": "<step>[.path]"}` splices prior outputs; no eval, max 16 steps). |
| `mcp_connect_bundles` | List curated multi-server presets (PR review, DevOps incident, ...) and match them against your config. |
| `mcp_connect_suggest` | Surface recurring multi-server workflows learned from usage, with a ready-to-run `activate` call. |
| `mcp_connect_secrets` | Show which local-vault secrets each server's `${secret:NAME}` refs resolve to -- by name only, never a value. |
| `mcp_connect_health` | Call counts, error rates, and latency per loaded server. |

**Ranking.** dispatch/discover rank with BM25, computed locally. On top of the ranker, three signals adjust scores:

- **Health-aware** -- servers that recently failed or error often get down-ranked (never boosted above raw).
- **Learning** -- servers that succeeded before get a small nudge (+10% max), persisted across restarts.
- **Sampling tiebreak** -- when the top two are within 10% and your client supports [MCP sampling](https://modelcontextprotocol.io/specification/server/sampling), yaw-mcp asks your own model to pick (no extra provider key or cost).

Servers auto-unload after ~10 tool calls to other servers, so context stays clean even if you forget. The threshold is adaptive per namespace (`[5, 50]`): bursty servers get more patience, long-idle ones unload at the baseline.

## Install

### One command (recommended)

```bash
npx -y @yawlabs/mcp@latest install <claude-code|claude-desktop|cursor|vscode>
```

This edits the chosen client's config (correct path + JSON shape for your OS) to launch yaw-mcp. On Windows it wraps `npx` in `cmd /c` (without which MCP clients hit `ENOENT` on the `npx.cmd` shim). Run it once per client.

Useful flags:

- `--scope user|project|local` -- which file to write (Claude Code + Cursor support project/local; VS Code is workspace-only; Claude Desktop is user-only).
- `--dry-run` -- print the diff and exit without writing.
- `--force` / `--skip` -- overwrite or leave an existing `mcp` entry (otherwise prompts on a TTY, refuses off-TTY).

Or do every detected client at once:

```bash
yaw-mcp install --list   # detect clients + show install state (read-only)
yaw-mcp install --all    # install into every user-scope client on this machine
```

> The launch entry is keyed `"mcp"`, so its tools surface under the `mcp__mcp__` namespace. Installs made before the rename used `"mcp.hosting"` / `"yaw-mcp"`; `yaw-mcp install` detects and migrates those.

### Manual install

The JSON shape (top-level `mcpServers`, except VS Code uses `servers` in `.vscode/mcp.json`):

```json
{
  "mcpServers": {
    "mcp": { "command": "npx", "args": ["-y", "@yawlabs/mcp@latest"] }
  }
}
```

On **Windows**, use `"command": "cmd", "args": ["/c", "npx", "-y", "@yawlabs/mcp@latest"]`.

## CLI

`yaw-mcp` with no subcommand runs as the MCP server, serving the servers in your `~/.yaw-mcp/bundles.json`. Most read-only subcommands accept `--json`. Run `yaw-mcp <cmd> --help` for per-command flags.

**Setup**

```bash
yaw-mcp install <client>       # connect a client to yaw-mcp (see above)
yaw-mcp doctor [--json]        # diagnose config, clients, learning, reliability, upgrade
```

**Servers** -- managed in `~/.yaw-mcp/bundles.json`, browse the catalog at [yaw.sh/mcp/catalog](https://yaw.sh/mcp/catalog/):

```bash
yaw-mcp add <slug> [--env KEY=value] [--dry-run]   # add a catalog server to bundles.json
yaw-mcp remove <slug-or-namespace>                 # drop a server
yaw-mcp list [--json]                              # list configured servers with their cached compliance grade
yaw-mcp try <slug> [--client <name>] [--ttl 1h]    # wire a one-off trial straight into your client (expires)
yaw-mcp try-cleanup <slug>                          # remove a trial early (doctor GCs expired ones)
```

`add` is not `install`: `install <client>` connects an AI client to yaw-mcp; `add <slug>` adds an MCP server to yaw-mcp itself. `try` points the client directly at the upstream server, bypassing yaw-mcp, so you can evaluate it in isolation.

**Inspection & maintenance**

```bash
yaw-mcp bundles [list|match] [--json]  # browse curated bundles; match partitions against your enabled servers
yaw-mcp upgrade [--run] [--json]       # show (or run) the command that bumps @yawlabs/mcp
yaw-mcp reset-learning                 # clear cross-session learning (~/.yaw-mcp/state.json)
yaw-mcp completion <bash|zsh|fish|powershell>   # print a shell-completion script
```

**Compliance**

```bash
yaw-mcp compliance <target>   # run the 88-test compliance suite against a server
yaw-mcp audit <namespace>     # audit a stdio server from bundles.json, cache its A-F grade in grades.json
```

To install completion, redirect to your shell's completions dir, e.g. `yaw-mcp completion zsh > "${fpath[1]}/_yaw-mcp"`, or `yaw-mcp completion powershell >> $PROFILE`.

## Configuration -- `.yaw-mcp/`

yaw-mcp keeps its config under a `.yaw-mcp/` directory (mirroring `.git/`, `.vscode/`, `.claude/`). It reads `config.json` from three optional scopes, highest precedence first:

| Scope | Path | Use |
|-------|------|-----|
| **local** | `<project>/.yaw-mcp/config.local.json` | Machine-local overrides; gitignore it. |
| **project** | `<project>/.yaw-mcp/config.json` | Shared via git with the repo. |
| **global** | `~/.yaw-mcp/config.json` | Personal default for every project. |

The project `.yaw-mcp/` is found by walking up from the cwd, stopping just before `$HOME` so a `.yaw-mcp/` at `$HOME` is treated as global only. Files may contain `//` and `/* */` comments. Full schema:

```jsonc
{
  "version": 1,                          // schema version; newer versions log a warning
  "servers": ["gh", "pg", "linear"],     // allow-list of namespaces (most-specific scope wins)
  "blocked": ["prod-db"]                 // deny-list (UNION across all scopes -- fail-safe on deny)
}
```

Malformed files log a warning and fall through (fail-open). yaw-mcp reads config at startup, so restart the client after editing; `mcp_connect_health` shows which files are applied.

### Project guide -- `YAW-MCP.md`

Drop a `YAW-MCP.md` next to `config.json` in either `.yaw-mcp/` and yaw-mcp surfaces it via a `yaw-mcp://guide` MCP resource. The `discover`/`dispatch` descriptions tell the model to read it first, so project routing conventions ("use the `gh` server, not bash") and credential guidance stick without restating them each session. A user guide (`~/.yaw-mcp/YAW-MCP.md`) and a project guide are concatenated with the project one last; a missing file is skipped silently.

## Local secret vault

Rather than putting credentials in a client config, keep a value in an encrypted file on your own machine and reference it from any server's `env` with a `${secret:NAME}` placeholder:

```jsonc
"env": {
  "GITHUB_PERSONAL_ACCESS_TOKEN": "${secret:gh}",
  "AUTH_HEADER": "Bearer ${secret:gh}"   // placeholders compose inline
}
```

At spawn time, if `YAW_MCP_VAULT_PASSPHRASE` is set in yaw-mcp's own env, it decrypts the referenced names and substitutes them into the child's env. If the passphrase is absent or a name isn't stored, the literal `${secret:NAME}` passes through unchanged, so the child surfaces its own "missing credential" error rather than an empty string. The value never leaves your machine.

```bash
yaw-mcp secrets set <name>      # store a value (no-echo prompt, or --value/--stdin)
yaw-mcp secrets get <name>      # decrypt and print one value
yaw-mcp secrets list            # show entry NAMES only (values stay encrypted)
yaw-mcp secrets remove <name>   # delete an entry
yaw-mcp secrets lock            # clear the in-process passphrase cache
yaw-mcp secrets rotate          # re-encrypt the whole vault under a NEW passphrase
yaw-mcp secrets audit [--secret NAME] [--server NS] [--json]   # who consumed which secret, when
```

The passphrase derives the key via scrypt and is cached in memory for one process; the on-disk file holds only ciphertext (AES-256-GCM, per-entry IV + tag, one vault salt). `rotate` decrypts every entry first and aborts untouched if any fails -- and it re-wraps the **encryption**, not the underlying tokens (a leaked token is still leaked; rotate it at its source). `audit` reads an append-only `0600` NDJSON log of secret NAME + namespace + timestamp -- never a value -- and writes fail-open so a broken log never blocks a spawn.

**Threat model.** The vault protects the on-disk file against offline brute-force after exfiltration (stolen laptop, leaked backup): useless without the passphrase, tamper-evident via GCM. It does **not** defend against a process running as you while the passphrase is cached, a keylogger, or a value already leaked at its source.

## Runtime detection & `uv` bootstrap

On startup yaw-mcp probes for `node`, `npx`, `python`, `uvx`, and `docker` (best-effort, 3s per probe) so it can warn when a server's runtime is missing. yaw-mcp itself needs only Node.js.

Python servers (`sqlite`, `time`, `sentry`, ...) launch via Astral's `uv`/`uvx`. On first encounter, if `uv` isn't on your PATH, yaw-mcp downloads Astral's standalone release, verifies the sha256, and caches it -- reusing your own `uv` if you have one. `uvx ARGS` is always rewritten to `uv tool run ARGS`, so only `uv` needs to be reachable.

## Trust & security

MCP servers are third-party code you choose to run. yaw-mcp doesn't sandbox them -- that's your OS and network. What it gives you is **visibility and a gate**:

- **Compliance grades (A-F)** -- the `@yawlabs/mcp-compliance` suite (88 tests) grades a server; `yaw-mcp list` shows it in a `GRADE` column and `discover` shows it inline (`github [ready] [A]`). `YAW_MCP_MIN_COMPLIANCE=B` makes `activate` refuse anything below the floor. Ungraded servers pass (don't punish unknown); audit them yourself with `yaw-mcp compliance <target>`.
- **Source transparency** -- `list` and `discover` show the exact `command`, `args`, and `url` each server launches with. Nothing is wrapped.
- **Local credentials** -- vault values are encrypted at rest (scrypt + AES-256-GCM), injected at spawn, and never logged. Nothing is transmitted off the machine.
- **Response pruning** (`YAW_MCP_PRUNE_RESPONSES`, on by default) -- redacts large file-blob content before it reaches the model, cutting the easiest cross-server prompt-injection vector.
- **Namespace isolation** -- tools are namespace-prefixed (`gh_create_issue`, never bare `create_issue`), so a server can't impersonate another's tools. `mcp_connect_read_tool` inspects a schema before any code runs.

yaw-mcp does **not** block outbound traffic, firewall DNS, analyze source, or pin hashes -- a malicious server you chose to run can reach any URL your machine can. Review the command before adding a server, run untrusted ones under a restricted user or container, and prefer graded servers when alternatives are equivalent. Report a security issue in yaw-mcp itself via [GitHub private advisories](https://github.com/YawLabs/mcp/security/advisories/new) (see [`SECURITY.md`](./SECURITY.md)).

## Missing credentials

If a server exits with something like `GITHUB_TOKEN is required` and your client advertises MCP [elicitation](https://modelcontextprotocol.io/specification/server/elicitation), yaw-mcp prompts for the value and retries, rather than failing the call outright.

## Environment variables

Common ones (run `yaw-mcp --help` for the full list):

| Variable | Description |
|----------|-------------|
| `YAW_MCP_SERVER_CAP` | Max concurrently active servers. Default `6`; `0` disables the cap. |
| `YAW_MCP_MIN_COMPLIANCE` | Minimum grade (`A`-`F`) an installed server must report before `activate` loads it. |
| `YAW_MCP_VAULT_PASSPHRASE` | Passphrase for the local secret vault. Required for spawn-time `${secret:NAME}` substitution. |
| `YAW_MCP_AUTO_ACTIVATE` | `0` disables discover auto-loading a clearly-winning server. Default on. |
| `YAW_MCP_AUTO_UPGRADE` | `0` disables the background self-upgrade check at startup. Default on. |
| `YAW_MCP_AUTO_LOAD` | `1` pre-activates the top recurring pack at startup (needs persistence). Default off. |
| `YAW_MCP_PRUNE_RESPONSES` | `0` disables response pruning. Default on. |
| `YAW_MCP_DISABLE_PERSISTENCE` | `1` keeps learning + pack history process-scoped (CI, containers). Default off. |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`. Default `info`. |

## Requirements

- Node.js 18.17+.
- No account. Everything runs locally.

## License

Source-available, not open source. Copyright (c) 2026 Yaw Labs, all rights reserved.

The source is published so you can read and audit it before running it -- `yaw-mcp` spawns processes on your machine and handles your credentials, and you should not have to take that on faith. You may use it freely, personally or commercially, and redistribute unmodified copies. You may not offer it to third parties as a competing product. See [LICENSE](./LICENSE) for the terms, and [CONTRIBUTING.md](./CONTRIBUTING.md) for the DCO sign-off contributors use.

## Links

- [yaw.sh/mcp/catalog](https://yaw.sh/mcp/catalog/) -- browse the server catalog
- [@yawlabs/mcp-compliance](https://www.npmjs.com/package/@yawlabs/mcp-compliance) -- test your MCP servers for spec compliance
- [CHANGELOG](./CHANGELOG.md) -- release notes
- [GitHub](https://github.com/YawLabs/mcp) -- source and issues
