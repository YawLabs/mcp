# @yawlabs/mcp

One install. All your MCP servers. Managed from the cloud.

Yaw MCP (the `yaw-mcp` CLI, package `@yawlabs/mcp`) is an MCP server that fronts every other MCP server you use. Install it once per AI client (Claude Code, Claude Desktop, Cursor, VS Code) and your servers come from your [yaw.sh/mcp](https://yaw.sh/mcp) account instead of a hand-edited `mcpServers` block. It earns its keep when you hit any of these:

- **More than one client or more than one machine.** Add a server once on the dashboard; every client/device picks it up on the next poll. No copy-paste of the same JSON into four config files, no per-machine drift.
- **Tool-context bloat.** The `dispatch` meta-tool ranks your installed servers against the task at hand and loads only the top match(es). A 30-server account stays at a handful of tools in context at any moment instead of surfacing hundreds by default.
- **API tokens you'd rather not sit in disk configs.** Credentials live encrypted on yaw.sh/mcp and inject at spawn time. Rotate once -- every client picks up the new value. Revoke the yaw.sh/mcp token and every install stops working.
- **A trust signal before you activate.** Every scored server renders with its A-F compliance grade in `discover`. Set `YAW_MCP_MIN_COMPLIANCE=B` to refuse anything below.

If you use one client on one machine with a handful of servers, `claude mcp add` or hand-editing `mcp.json` is fine -- yaw-mcp's value shows up when that setup stops scaling.

## How it works

```
Your MCP client (Claude Code, Cursor, etc.)
    |
    |  single stdio connection
    v
@yawlabs/mcp
    |         |         |
    v         v         v
  GitHub    Slack    Stripe     <- your MCP servers (local or remote)
```

1. You add servers on [yaw.sh/mcp](https://yaw.sh/mcp) (name, command, args, env vars)
2. yaw-mcp pulls your config on startup
3. You use a handful of meta-tools to control which servers' tools are loaded in the current session:
   - **`mcp_connect_dispatch`** -- describe a task in plain English; yaw-mcp picks the right server, loads its tools, and exposes them. The fast path when you know what you want.
   - **`mcp_connect_discover`** -- list all installed servers, optionally ranked by relevance to a context string. Auto-loads the top match when one server clearly wins.
   - **`mcp_connect_activate`** -- load specific servers' tools by namespace.
   - **`mcp_connect_deactivate`** -- unload a server and remove its tools from context.
   - **`mcp_connect_install`** -- install a new MCP server on your yaw.sh/mcp account.
   - **`mcp_connect_import`** -- bulk-import servers from an existing client config (`claude_desktop_config.json`, `mcp.json`, etc.).
   - **`mcp_connect_health`** -- show call counts, error rates, and latency per loaded server.
   - **`mcp_connect_suggest`** -- surface recurring multi-server workflows yaw-mcp has learned from persisted pack history. When you repeatedly use `gh` -> `linear` -> `slack` for the same kind of task, `suggest` lists the pattern with a ready-to-run `activate` call so you can load the whole pack at once.
   - **`mcp_connect_read_tool`** -- return a single tool's schema + docs without activating its server. Reads 1-2 schemas instead of loading a whole catalog when the model only needs a couple of tools from a big server.
   - **`mcp_connect_exec`** -- run a short declarative pipeline of tool calls in one round-trip. Steps name namespaced tools + args; `{"$ref": "<stepId>[.path]"}` markers splice prior outputs into later inputs. No eval -- only dot/bracket path resolution. Capped at 16 steps.
   - **`mcp_connect_bundles`** -- list curated multi-server presets (DevOps incident, PR review, growth stack, data ops, etc.) and/or match them against your current config. Pair it with `mcp_connect_activate` to load a whole bundle at once.

Installing a server puts it on your account; loading it brings its tools into the current session's context. yaw-mcp loads servers lazily so your context window stays clean.

Ranking is two-stage when the backend has a Voyage embeddings key configured: a local BM25 pass narrows to a shortlist, then a `/api/connect/rerank` call semantically reorders. With no key on the backend it gracefully degrades to BM25-only -- `dispatch` and `discover(context)` keep working, just with slightly weaker ranking on ambiguous queries.

On top of the ranker, yaw-mcp applies three client-side signals to dispatch scores:

- **Health-aware**: servers that have recently failed to load or have high error rates get down-ranked. Never boosts above raw -- "all else equal, prefer the one that works".
- **Learning**: servers that have succeeded before get a small (+10% max) nudge, so the router remembers what's been useful. Success counts persist across restarts via `~/.yaw-mcp/state.json` (opt out with `YAW_MCP_DISABLE_PERSISTENCE=1`).
- **Sampling tiebreak**: when the top two candidates are within 10% of each other and your client supports [MCP sampling](https://modelcontextprotocol.io/specification/server/sampling), yaw-mcp asks your client's LLM to pick. Uses the model you're already running -- no extra provider key, no extra cost to yaw-mcp.

## Install

### One command (recommended)

```bash
npx -y @yawlabs/mcp@latest install <claude-code|claude-desktop|cursor|vscode> --token mcp_pat_your_token_here
```

This:

1. Edits the chosen client's config file (correct path for your OS, correct JSON shape) to launch yaw-mcp.
2. Writes your token to `~/.yaw-mcp/config.json` so every other client you install picks it up automatically -- no need to copy the token into each client's `env` block.
3. On Windows, wraps `npx` in `cmd /c` (without this, MCP clients hit `ENOENT` on the `npx.cmd` shim).

Run it once per client. To rotate the token later, run `install` again with `--token` -- both files get rewritten.

Helpful flags:

- `--scope user|project|local` -- which file to write (Claude Code + Cursor support project/local; VS Code is workspace-only; Claude Desktop is user-only).
- `--dry-run` -- print the diff and exit without writing.
- `--force` / `--skip` -- overwrite or leave an existing `mcp` entry. Without either, yaw-mcp prompts (TTY) or refuses (non-TTY).
- `--no-yaw-mcp-config` -- write only the client config; leave `~/.yaw-mcp/config.json` untouched.

Or install into every detected client at once:

```bash
yaw-mcp install --list                      # read-only: detect clients + show install state per scope
yaw-mcp install --all --token mcp_pat_...   # one-shot: install into every user-scope client on this machine
```

`--list` never writes (no token needed). `--all` installs into every client whose user-scope target is resolvable on this OS -- Claude Desktop is skipped on Linux, VS Code is skipped unless `--project-dir` is given (it's workspace-only). Aggregate exit code is non-zero if any sub-install fails.

Or [edit the JSON by hand](#manual-install) if you'd rather.

> The launch entry is keyed as `"mcp"` in the client config, so its tools surface under the `mcp__mcp__` namespace. Installs created before the rename used `"mcp.hosting"` / `"yaw-mcp"`; `yaw-mcp install` (and Yaw Terminal) detect and migrate those to `"mcp"`.

### Diagnose problems -- `yaw-mcp doctor`

```bash
npx -y @yawlabs/mcp@latest doctor          # human-readable report
npx -y @yawlabs/mcp@latest doctor --json   # machine-readable snapshot for pipelines
```

Prints the loaded config files, your token's source + fingerprint (last 4 chars), the API base URL, installed clients, env overrides, persisted learning state, flaky-namespace reliability rollup, shell-history "shadow" hits (CLIs you run that an MCP server could replace), and an upgrade check against the npm registry. Exits `0` healthy / `1` no token / `2` warnings (e.g. world-readable token file). Paste the text output into a support ticket; the `--json` blob is the same data as a structured snapshot, so dashboards and CI scripts can `jq` instead of parsing the text layout.

### Add servers locally (no account) -- `add` / `remove` / `list`

In Free (no-account) mode, yaw-mcp loads servers from `~/.yaw-mcp/bundles.json`.
Manage that set from the catalog at [yaw.sh/mcp/catalog](https://yaw.sh/mcp/catalog/):

```bash
yaw-mcp add <slug>                       # resolve a catalog server and write it into bundles.json
yaw-mcp add github --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...   # supply a required env value
yaw-mcp add <slug> --dry-run [--json]    # preview the entry without writing
yaw-mcp remove <slug-or-namespace>       # drop a server from bundles.json
yaw-mcp list [--json]                    # list the servers yaw-mcp loads locally
```

`add` is NOT `install`: `install <client>` connects an AI client to yaw-mcp;
`add <slug>` adds an MCP server to yaw-mcp itself. Required env keys are seeded
empty and only a value passed via `--env` is written to disk (yaw-mcp inherits
your shell env when it spawns the server, so an ambient secret reaches it at
runtime without being persisted). The same one-click lives on the website as
the "Add to Yaw MCP" button.

### Try a server for an hour -- `try`

```bash
yaw-mcp try <slug> [--client <name>] [--ttl 1h] [--env KEY=value]   # wire a one-off trial directly into your AI client
yaw-mcp try-cleanup <slug>               # remove a wired trial early (doctor GCs expired ones)
```

`try` points the AI client straight at the upstream server (bypassing yaw-mcp)
so you can evaluate it without an account; the entry expires after `--ttl`.

### Other CLI subcommands

```bash
yaw-mcp servers [<namespace-filter>] [--json]    # list servers; optional substring filter on namespace
yaw-mcp bundles [list|match] [--json]    # browse curated multi-server bundles (PR review, DevOps incident, etc.)
yaw-mcp reset-learning                   # clear cross-session learning history (~/.yaw-mcp/state.json)
yaw-mcp completion <bash|zsh|fish|powershell>   # print shell completion script
yaw-mcp upgrade [--run] [--json]         # show (or execute) the command that bumps @yawlabs/mcp
yaw-mcp compliance <target> [--publish]  # run the compliance suite against an MCP server
yaw-mcp --version                        # print version
```

Account / sync (Yaw Team -- a license key unlocks cross-machine bundle sync):

```bash
yaw-mcp login [--key <license>]          # authenticate this machine with a Yaw MCP account
yaw-mcp logout                           # sign this machine out
yaw-mcp sync <push|pull|status> [--json] # replicate bundles.json to/from the account store (env values stripped on push)
yaw-mcp secrets <set|get|list|remove|lock|push|pull>   # manage synced secret VALUES
yaw-mcp stats [--limit N] [--days N] [--json]          # account usage statistics
```

Every CLI that reads state has a `--json` mode for pipeline use. `yaw-mcp servers` hits the backend; `yaw-mcp bundles list` and `yaw-mcp completion` are fully static (no network, no token). `yaw-mcp bundles match` partitions the curated set against your enabled servers so you see the same ready-to-activate vs. partially-installed view the LLM-facing `mcp_connect_bundles` meta-tool produces.

To wire up shell completion:

```bash
# bash
yaw-mcp completion bash > ~/.local/share/bash-completion/completions/yaw-mcp

# zsh (must be on $fpath, then rebuild compinit)
yaw-mcp completion zsh > "${fpath[1]}/_yaw-mcp"

# fish
yaw-mcp completion fish > ~/.config/fish/completions/yaw-mcp.fish

# powershell
yaw-mcp completion powershell >> $PROFILE
```

### Getting your token

1. Sign up at [yaw.sh/mcp](https://yaw.sh/mcp)
2. Go to **Settings > Tokens**
3. Create a token -- it starts with `mcp_pat_`
4. Pass it to `yaw-mcp install` as shown above

### Manual install

If you'd rather edit the config files yourself, the JSON shapes are:

**Claude Code, Cursor, Claude Desktop** -- top-level key `mcpServers`:

```json
{
  "mcpServers": {
    "mcp": {
      "command": "npx",
      "args": ["-y", "@yawlabs/mcp@latest"]
    }
  }
}
```

**VS Code** -- top-level key `servers` (NOT `mcpServers`) in `.vscode/mcp.json`:

```json
{
  "servers": {
    "mcp": {
      "command": "npx",
      "args": ["-y", "@yawlabs/mcp@latest"]
    }
  }
}
```

**Windows** -- `command: "cmd", args: ["/c", "npx", "-y", "@yawlabs/mcp@latest"]` (the `cmd /c` wrapper is required because `npx.cmd` is a shim).

Then put your token in `~/.yaw-mcp/config.json` so yaw-mcp picks it up at startup:

```json
{
  "version": 1,
  "token": "mcp_pat_your_token_here"
}
```

Or set `YAW_MCP_TOKEN` in the client's `env` block -- both work.

## Adding servers

On [yaw.sh/mcp](https://yaw.sh/mcp), add each MCP server you want to orchestrate:

| Field | Description |
|-------|-------------|
| **Name** | Display name (e.g., "GitHub") |
| **Namespace** | Short prefix for tool names (e.g., "gh") |
| **Type** | `local` (stdio) or `remote` (HTTP) |
| **Command** | For local: the command to run (e.g., "npx") |
| **Args** | For local: command arguments (e.g., ["-y", "@modelcontextprotocol/server-github"]) |
| **Env** | Environment variables (API keys, tokens) |
| **URL** | For remote: the server URL |

## Usage

### Fast path -- `dispatch`

When you know what you want to do, skip the discover/load dance:

```
> Create a GitHub issue for the login bug

[mcp_connect_dispatch is called with intent="create a GitHub issue for the login bug"]

Dispatched "create a GitHub issue for the login bug" -- loaded top 1 of 1 matching server.
gh (score 4.32): Loaded "gh" -- 24 tools: gh_create_issue, gh_list_prs, ...

[gh_create_issue is then called, returns the new issue]
```

`dispatch` ranks every installed server, loads the top match's tools, and immediately exposes them so the LLM can call them. Default budget is 1 (one server). For tasks that need multiple servers, pass `budget: 3` etc.

### Manual control

```
> What MCP servers do I have?

Installed MCP servers:

  gh -- GitHub [ready] (local)
  slack -- Slack [ready] (local)
  stripe -- Stripe [ready] (local)

0 loaded in this session, 0 tools in context.
```

```
> Load my GitHub server

Loaded "gh" -- 24 tools: gh_create_issue, gh_list_prs, ...
```

You can load multiple at once: `> Load GitHub and Slack`. Tools are namespaced as `{namespace}_{original_tool_name}` to prevent collisions. The tool list updates automatically via `tools/list_changed`.

```
> Unload GitHub when you're done

Unloaded "gh". Tools removed from context.
```

Servers also auto-unload after ~10 tool calls to other servers, so context stays clean even if you forget. The threshold is adaptive per-namespace: a server that's been called in bursts recently gets more patience (up to +20) before it's unloaded, so heavily-used servers don't get torn down mid-task. Long-idle servers still unload at the baseline.

## `.yaw-mcp/` config directory

yaw-mcp stores its config under a `.yaw-mcp/` directory -- mirroring the `.git/`, `.vscode/`, `.claude/` convention so everything related to yaw-mcp (config, project guide, future additions) lives under one predictable folder you can grep, gitignore, or blow away atomically. yaw-mcp reads `config.json` from three optional locations (highest precedence first):

| Scope | Path | Holds |
|-------|------|-------|
| **local** | `<project>/.yaw-mcp/config.local.json` | Machine-local override; `gitignore` it. Token allowed. |
| **project** | `<project>/.yaw-mcp/config.json` | Shared with the team via git. Token NOT allowed (warned). |
| **global** | `~/.yaw-mcp/config.json` | Personal default for every project. Token allowed. |

The project `.yaw-mcp/` is found by walking UP from the current directory until a `.yaw-mcp/` is found, stopping just before `$HOME` (exclusive) so a `.yaw-mcp/` sitting at `$HOME` is treated as user-global only and never double-loaded as project.

Full schema:

```jsonc
{
  // Schema version. yaw-mcp emits version 1; older fields stay
  // readable. Newer versions log a warning so an old yaw-mcp can't
  // silently miss new fields.
  "version": 1,

  // Personal access token from yaw.sh/mcp -> Settings -> Tokens.
  // env YAW_MCP_TOKEN still wins over the file value.
  "token": "mcp_pat_your_token_here",

  // API base override -- point yaw-mcp at a self-hosted backend or staging.
  // Defaults to https://yaw.sh/mcp. env YAW_MCP_URL still wins.
  "apiBase": "https://yaw.sh/mcp",

  // Project profile: which namespaces are allowed.
  "servers": ["gh", "pg", "linear"],

  // Project profile: namespaces denied even if in `servers`.
  "blocked": ["prod-db"]
}
```

**Comments are allowed** (line `//` and block `/* ... */`) -- handy for documenting a shared `config.json` checked into git.

**Resolution:**

- **Token** -- `YAW_MCP_TOKEN` env > local > global. (`token` in the project file is ignored and warned: it'd get committed to git.)
- **apiBase** -- `YAW_MCP_URL` env > local > project > global > `https://yaw.sh/mcp`.
- **servers** allow-list -- local wins if set, else project, else global (most-specific scope overrides).
- **blocked** deny-list -- UNION across every scope that sets it (fail-safe on deny).
- Malformed files log a warning and fall through -- fail-open so a typo doesn't brick the session.
- On POSIX, yaw-mcp warns if the file contains a token and is readable by group/other; run `chmod 600 ~/.yaw-mcp/config.json` to silence it.

**Token rotation**: yaw-mcp reads its config at startup. After editing `~/.yaw-mcp/config.json`, restart the MCP client (or kill yaw-mcp; the client respawns it).

`mcp_connect_health` shows which file(s) are currently applied.

## Project guide -- `YAW-MCP.md`

Drop a `YAW-MCP.md` next to `config.json` inside either `.yaw-mcp/` and yaw-mcp surfaces its contents to your client via a `yaw-mcp://guide` MCP resource. The meta-tool descriptions (`discover`, `dispatch`) tell the model to read this resource first, so project-specific routing conventions ("use the `gh` server for GitHub, not bash") and credential guidance ("keys go in the dashboard, not `.mcp.json`") stick without the user restating them every session.

| Scope | Path | Purpose |
|-------|------|---------|
| **user** | `~/.yaw-mcp/YAW-MCP.md` | Personal defaults that apply everywhere (your preferred tools, credential conventions). |
| **project** | `<project>/.yaw-mcp/YAW-MCP.md` | Project-specific guidance shared via git (which servers are load-bearing, project idioms). |

When both exist, the project guide is appended after the user guide with a `---` separator so project-specific rules get the final word in the reader's attention. A missing or empty file is silently skipped -- if neither file exists, the `yaw-mcp://guide` resource isn't listed at all.

## Elicitation for missing credentials

When a server fails to start with stderr like `GITHUB_TOKEN is required` and your client advertises the MCP [elicitation](https://modelcontextprotocol.io/specification/server/elicitation) capability, yaw-mcp prompts you for the missing value inline and retries the load. Values stay in-memory for the current yaw-mcp session only -- persist them in the yaw.sh/mcp dashboard if you want them across restarts.

### Errors come with deep-links

When a load fails (missing token, runtime not on PATH, server crashes on init), yaw-mcp emits a message ending with `-> Edit at https://yaw.sh/mcp/dashboard/connect#server-<id>`. Most LLMs render that as a clickable link, and the dashboard scrolls to and highlights the matching card so you find the right server in one click.

## Config sync

yaw-mcp polls [yaw.sh/mcp](https://yaw.sh/mcp) every 60 seconds for config changes. When you add, remove, or modify a server on the dashboard, yaw-mcp picks it up automatically -- no restart needed.

### Multi-device sync

Because every yaw-mcp install reads the same account's server list, the same token gives you the same servers across every machine. Install yaw-mcp on a second laptop with the same `mcp_pat_...`, and within 60 seconds it sees the same GitHub/Slack/Stripe/etc. servers you configured from the first. Tokens, environment variables, and credentials stay in the dashboard -- you don't have to sync a JSON file across machines, copy secrets into a dotfile repo, or re-paste an API key per device.

Rotate a credential in one place (the dashboard), every machine picks up the new value on the next poll. Revoke a token in Settings -> Tokens, every install stops working immediately (the token is the only thing authenticating the config pull). This is why `~/.yaw-mcp/config.json` holds a token, not a server list -- the server list is the cloud's concern.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `YAW_MCP_TOKEN` | Yes (or in `~/.yaw-mcp/config.json`) | Personal access token from yaw.sh/mcp. Env wins over `~/.yaw-mcp/config.json`. |
| `YAW_MCP_URL` | No | API URL (default: `https://yaw.sh/mcp`). Env wins over `apiBase` in `config.json`. |
| `LOG_LEVEL` | No | Log verbosity: `debug`, `info`, `warn`, `error` (default: `info`) |
| `YAW_MCP_POLL_INTERVAL` | No | Config-poll interval in seconds. `0` disables polling (config fetched once at startup). Default: `60` |
| `YAW_MCP_AUTO_ACTIVATE` | No | When `discover` is called with a context string and one server clearly wins, auto-load it. Set to `0` to disable. Default: enabled |
| `YAW_MCP_AUTO_UPGRADE` | No | When yaw-mcp starts as a server, runs a non-blocking background check for a newer npm/pnpm/bun global install and upgrades quietly with the owning tool. Set to `0` to disable. Default: enabled. |
| `YAW_MCP_SERVER_CAP` | No | Hard cap on concurrently activated servers. Default: `6`. Set to `0` to disable. |
| `YAW_MCP_PRUNE_RESPONSES` | No | Conservative response pruning (redact large file blobs etc. before returning to the client). Set to `0` or `false` to disable. Default: enabled. |
| `YAW_MCP_DISABLE_PERSISTENCE` | No | Set to `1` or `true` to keep learning + pack-history scoped to the current process -- nothing loaded at start, nothing written on shutdown. Intended for ephemeral / shared environments (CI, containers). Default: cross-session persistence enabled at `~/.yaw-mcp/state.json`. |
| `YAW_MCP_AUTO_LOAD` | No | Set to `1` or `true` to pre-activate the top recurring pack (from persisted pack-history) on startup -- no LLM round-trip required. Skips silently when history is empty or no pack's namespaces are all installed. Default: off. Requires persistence to be enabled. |
| `YAW_MCP_MIN_COMPLIANCE` | No | Minimum compliance grade (`A`, `B`, `C`, `D`, or `F`, case-insensitive) an installed server must report before `mcp_connect_activate` will load it. Ungraded servers always pass (don't punish unknown). `discover()` annotates below-grade servers in place and shows a "Compliance filter active" header when set. Invalid values log a warning and disable the filter. Default: unset (no filter). |
| `MCP_CONNECT_TIMEOUT` | No | Connection timeout in ms for upstream servers (default: `15000`) |
| `MCP_CONNECT_IDLE_THRESHOLD` | No | Baseline for idle auto-unload (default: `10`). The per-namespace adaptive cap is `[5, 50]` -- bursty namespaces extend past the baseline, long-idle ones unload at it. |

## Runtime detection

On startup, yaw-mcp probes your machine for `node`, `npx`, `python`, `uvx`, and `docker` and reports the snapshot to yaw.sh/mcp. The dashboard uses this to warn before you add a catalog server whose runtime isn't installed (e.g., adding the Sentry server when Python isn't on your PATH). No prompt, no LLM round-trip -- just a yellow banner on the Add Server form.

The detection is best-effort: each probe has a 3-second timeout and missing runtimes are recorded as absent rather than blocking startup. yaw-mcp itself only requires Node.js -- every other runtime is optional and only matters for servers that need it.

### Automatic `uv` bootstrap

The popular Python-based MCP servers (`sqlite`, `time`, `sentry`, and other uvx-launched entries) all launch via Astral's `uv`/`uvx`. yaw-mcp ships its own bootstrap for these: on first encounter with a `uv`/`uvx` command, if the binary isn't on your PATH, yaw-mcp lazily downloads Astral's standalone `uv` release, verifies the sha256, and caches it under the platform-appropriate cache dir. Subsequent loads reuse the cached binary. If you already have `uv` installed, yaw-mcp uses your version and never downloads.

`uvx ARGS` is always rewritten to `uv tool run ARGS` at spawn time -- so only `uv` needs to be reachable, not `uvx` separately. Fixes Windows setups where one was on PATH and the other wasn't.

## Trust & security

MCP servers are third-party code that you choose to run, and yaw-mcp launches them on your machine or calls them over the network. We don't sandbox arbitrary code and we're not an antivirus -- that's your OS and network. What yaw-mcp gives you is **visibility and a gate**:

- **Compliance grades (A-F)** -- the `@yawlabs/mcp-compliance` suite runs 88 behavioral tests against an MCP server and reports a grade. yaw.sh/mcp publishes grades for catalog servers; `yaw-mcp servers` shows them, and `mcp_connect_discover` surfaces them inline on every listing (e.g., `github -- GitHub [ready] [A]`). Set `YAW_MCP_MIN_COMPLIANCE=B` (or any grade) and `mcp_connect_activate` will refuse to load anything below the floor -- the refusal message spells out the grade and the env var to unset. Ungraded servers always pass (don't punish unknown), so audit unknowns yourself with `yaw-mcp compliance <target>` before you rely on them.
- **Source transparency** -- `yaw-mcp servers` and the yaw.sh/mcp dashboard show the exact `command`, `args`, and `url` each server launches with. Nothing is hidden or wrapped -- if a server is `npx -y @example/foo` you see that, and you can trace it back to npm / GitHub / the remote endpoint before installing.
- **Credentials stay encrypted at rest on yaw.sh/mcp** -- API tokens and other secrets you paste into a server's `env` block are encrypted on the backend and injected at spawn time. They don't sit in a committed `.env` file or a client config JSON, and they are never logged. Revoke the yaw.sh/mcp token (Settings -> Tokens) and every install loses access on the next poll.
- **Response pruning** -- `YAW_MCP_PRUNE_RESPONSES` (on by default) redacts large file-blob-shaped content before it reaches your LLM. This cuts the easiest form of cross-server prompt injection (stuffing a giant payload into a tool reply to swamp the model's context) and reduces accidental token burn. Set to `0` to disable.
- **Namespace isolation** -- tools are namespace-prefixed (`gh_create_issue`, never bare `create_issue`), so a server can't impersonate tools from another server it has no business touching. `mcp_connect_read_tool` lets you inspect a tool's schema without loading its server, so you can decide before any code runs.

**What yaw-mcp does not try to solve.** yaw-mcp does not prevent a server you deliberately installed from doing harmful things inside its own process. It doesn't block outbound network traffic, firewall DNS, analyze source, or pin package hashes. A malicious server you chose to run can call any URL your machine can reach; cross-server prompt injection through tool output is a fundamentally model-layer problem that no orchestrator fully fixes. The defenses that matter for those threats live at the layer below yaw-mcp:

- Review the command (`npx -y @scope/pkg`, a remote URL, ...) before adding a server. If you don't recognize it, run `yaw-mcp compliance <target>` against it first.
- Run yaw-mcp and its spawned servers under a restricted OS user or inside a container if you're handling sensitive data. yaw-mcp stays out of your sandbox's way -- a restricted user will block egress just like it would for anything else.
- Keep the yaw.sh/mcp token scoped to the devices that need it. Rotate with `yaw-mcp install <client> --token ...`; every client picks up the new value.
- Prefer graded servers when the alternatives are otherwise equivalent. A server that can't pass the compliance suite on basic spec conformance is a worse choice than one that does.

If you find a security issue in yaw-mcp itself, report it via [GitHub's private vulnerability reporting](https://github.com/YawLabs/mcp/security/advisories/new) -- details in [`SECURITY.md`](./SECURITY.md).

## Requirements

- Node.js 18+
- No account required for core features. A Yaw Team license key is needed only for sync and shared bundles (yaw.sh/mcp).

## Links

- [yaw.sh/mcp](https://yaw.sh/mcp) -- Dashboard and server management
- [@yawlabs/mcp-compliance](https://www.npmjs.com/package/@yawlabs/mcp-compliance) -- Test your MCP servers for spec compliance
- [CHANGELOG](./CHANGELOG.md) -- Release notes
- [GitHub](https://github.com/YawLabs/mcp) -- Source code and issues
