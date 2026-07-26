# yaw-mcp Roadmap

> Renamed from `mcph` -> `yaw-mcp` in 0.58.0. Historical env-var names (`MCPH_*`) below are kept as-is for accuracy against the release they shipped in; the current names are `YAW_MCP_*`.

> **Architecture change (0.74.0):** the hosted control plane is retired and yaw-mcp is
> local-only -- servers come from `~/.yaw-mcp/bundles.json`, credentials from the local
> encrypted vault. Completed items below that depended on the backend (config polling,
> analytics upload, plan limits, multi-device sync, the semantic reranker) shipped and
> were then REMOVED; they are marked as such rather than deleted, so this file stays an
> accurate record of what was built. Anything not marked still describes current behavior.

## Phase 1 — v0.1 (Complete)

- [x] ~~Cloud-configured~~, locally-executed MCP orchestrator _(config is now local-only, 0.74.0)_
- [x] discover / load / unload meta-tools
- [x] Local server spawning (stdio) + remote server connections (HTTP)
- [x] Namespace-based tool routing
- [x] tools/list_changed notifications on load/unload
- [x] ~~60s config polling with version hash comparison~~ _(removed 0.74.0 -- bundles.json is read once at startup)_
- [x] Auto-unload servers idle for 10+ tool calls
- [x] Directive tool descriptions for context-aware LLM behavior
- [x] Graceful shutdown (SIGTERM/SIGINT)
- [x] ~~Plan-based server limits (free: 3, paid: unlimited)~~ _(removed 0.74.0 -- no plans; `YAW_MCP_SERVER_CAP` is the only cap)_

## Phase 2 — Smart Routing & Observability

- [x] **Context cost estimates in discover()** — Show token cost per server (e.g., "npm: 22 tools, ~2,800 tokens") so the LLM can reason about context budget
- [x] **Usage pattern hints** — Track which servers are frequently loaded together and surface suggestions in discover() ("based on your last 3 calls, you probably need github next")
- [x] **Suggested load** — Orchestrator infers what to load based on recent tool call patterns, LLM confirms. Two surfaces: (a) `mcp_connect_suggest` returns explicit recommendations with ready-to-run `activate` calls; (b) `mcp_connect_discover` inlines a "Recurring packs" block at the top of its output so the model can act without the extra round-trip
- [x] **Automatic load** — Pre-load servers based on learned patterns without LLM confirmation (opt-in). `MCPH_AUTO_LOAD=1` activates every namespace in the top recurring pack (by frequency, tie-break recency) from persisted pack-history on startup, provided every namespace is installed. Silent no-op otherwise.
- [x] ~~**Routing analytics upload**~~ _(removed 0.74.0)_ — sent tool call patterns, load/unload events, and error rates to the hosted backend. Nothing is transmitted off the machine now.
- [x] **Error tracking in discover()** — Show server health in discover results ("npm: last 3 calls failed, might be down")
- [x] **Concurrent server cap** — Limit max loaded servers (default 6, `MCPH_SERVER_CAP` override) as both a business lever and context protection
- [x] **Resource proxying** — Proxy MCP resources from upstream servers, not just tools
- [x] **Prompt proxying** — Proxy MCP prompts from upstream servers
- [x] **Cross-session persistence** — Learning + pack history restored across mcph restarts from `~/.mcph/state.json`; opt-out via `MCPH_DISABLE_PERSISTENCE`
- [x] **Per-tool load** — Load specific tools from a server instead of all tools (category-based subsets). `mcp_connect_activate({ server, tools: [...] })` hides every unlisted tool from `tools/list`; hidden tools stay reachable via `mcp_connect_dispatch` (routes are unfiltered). Re-activate without `tools` to clear the filter; discover surfaces a `(filtered: K of N)` indicator.
- [x] **Signature-on-demand meta-tool** — A `mcp_connect_read_tool` that returns a single tool's schema + docs without loading its server. For servers with many tools where the model only needs 1–2, loads 1–2 schemas instead of the whole catalog. One step beyond per-tool load: no load event at all. (Pattern borrowed from Bifrost Code Mode's `list → read → execute` surface.)
- [x] **Orchestration sandbox** — `mcp_connect_exec` runs a short declarative pipeline of upstream tool calls in one round-trip. Each step names a namespaced tool + args; `{"$ref": "<stepId>[.path]"}` markers in args splice a prior step's output into the next step's input so the model can express `a = call_x(); b = call_y(a); return b` without code execution. No eval / no expression language — only sequential dispatch and dot/bracket path resolution on previously-bound outputs. Capped at 16 steps; any step failure fails the pipeline and returns completed outputs as `partial`.
- [x] ~~**Marketplace integration**~~ _(reworked 0.74.0)_ — `discover()` surfaces the public catalog at `https://yaw.sh/mcp/catalog/` for users with sparse configs (< 5 servers), alongside a `yaw-mcp add <slug>` hint. The original `mcp.hosting/explore` URL is dead.
- [x] ~~**Multi-device config sync**~~ _(removed 0.74.0)_ — depended on the account backend. Sync `~/.yaw-mcp/bundles.json` with your dotfiles instead.

## Phase 3 — Platform Intelligence

- [ ] ~~**Server recommendation engine**~~ _(void 0.74.0)_ — required the anonymized cross-user load patterns the analytics upload collected. Not buildable local-only.
- [x] **Pre-built orchestrator configs** — Curated bundles ("The DevOps Stack: GitHub + AWS + PagerDuty", "The Marketing Stack: HubSpot + Slack + Analytics"). `mcp_connect_bundles` meta-tool lists the curated catalog and with `action="match"` partitions bundles against installed servers (ready-to-activate vs partially-installed with missing-namespace hints). Static client-side data — see `src/bundles.ts`.
- [x] **Compliance-aware routing** — `MCPH_MIN_COMPLIANCE=A|B|C|D|F` refuses activation of servers whose `complianceGrade` is below the floor; discover annotates below-grade servers in place with a `(grade X — below MCPH_MIN_COMPLIANCE=Y, won't auto-activate)` marker and emits a "Compliance filter active" header. Forward-compatible schema: the optional `complianceGrade` field on `UpstreamServerConfig` rides the bundles.json entry shape (originally the `/api/connect/config` response). Ungraded servers always pass ("don't punish unknown"). See `src/compliance.ts`.
- [x] **Tool deduplication** — `discover()` surfaces bare tool names that appear in ≥2 currently-connected servers in an "Overlapping tools" block (top 5, sorted by namespace count desc then alphabetical), with a dispatch-to-disambiguate hint.
- [ ] **Conversation-aware routing** — If mcph could receive conversation context (future MCP spec), route automatically based on what the user is talking about
