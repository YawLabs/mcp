# Protocol eras: how yaw-mcp serves MCP 2026-07-28 and 2025-11-25

yaw-mcp answers both protocol eras from one process. A client that opens with `server/discover` gets 2026-07-28; a client that opens with `initialize` gets the 2025 revision it asked for. `YAW_MCP_PROTOCOL=legacy` turns the 2026-07-28 side off (see the README's environment table).

## Who the client is

On the 2025 protocol the client says who it is once, in `initialize`. On 2026-07-28 there is no handshake: every request carries the client's `clientInfo` and `clientCapabilities` in its `_meta` envelope, and yaw-mcp reads them from each request. That is what picks the `lite` tool list for `typed-cli`, and the "re-list or use exec" hint for clients that never re-read `tools/list`, in either era.

Pre-warm and the opt-in auto-load start once per process: after the `initialize` handshake on the 2025 protocol, and on the first request after `server/discover` on 2026-07-28. A discover probe the client abandons for `initialize` starts nothing.

## Requests yaw-mcp sends to the client

2026-07-28 has no server-to-client requests. yaw-mcp therefore sends no `elicitation/create`, `sampling/createMessage` or `roots/list` in a 2026-07-28 session, whatever capabilities the client declares:

- A server that fails on a missing credential is reported with its own error instead of a prompt for the value; store the value with `yaw-mcp secrets set` (or in the server's `env` in `bundles.json`) and activate again.
- The sampling tiebreak and `YAW_MCP_REWARD_GRADER` are inactive, as for a client without the sampling capability.
- Upstream servers are told the client supports none of the three, so a sidecar sees a client without them rather than one whose requests yaw-mcp cannot forward.

On the 2025 protocol all of this works as before.

## Lists

- **Order.** `tools/list` puts the meta-tools first, then each loaded server's tools in namespace order (a plain code-unit compare, the same on every host), keeping each server's own tool order. `resources/list` and `prompts/list` use the same namespace order. The same set of loaded servers gives byte-identical lists whatever order they were loaded in.
- **Name collisions.** Two namespaces can flatten onto one wire name (`gh` + `actions_list` and `gh_actions` + `list` are both `gh_actions_list`). The lexically first namespace owns the name on the list and on the routes alike, so a call always reaches the tool whose schema was listed.
- **Caching.** On 2026-07-28 every list, `resources/read` and `server/discover` result carries `ttlMs: 0` and `cacheScope: "private"`: loading, unloading, idle eviction, a config reload and tool filters all change the lists mid-session.
- **Change notifications.** yaw-mcp emits `notifications/tools/list_changed` (and the resource and prompt twins) whenever a list moves. On the 2025 protocol they are sent unsolicited. On 2026-07-28 they are delivered only on an open `subscriptions/listen` that asked for them, stamped with its subscription id; with no listen open they are dropped.

## Per-process lists and SEP-2567

The 2026-07-28 revision (SEP-2567) says list results no longer vary per connection, and that servers needing cross-call state pass explicit handles as tool arguments. yaw-mcp's `tools/list` does change during a session: `mcp_connect_activate`, `mcp_connect_dispatch` and `mcp_connect_deactivate` add and remove servers' tools.

On stdio this is the server's own state, not per-connection state: one client launches one yaw-mcp process, and that process serves exactly one connection. The list reflects what this process has loaded, it changes only through yaw-mcp's own tools (or its idle reaper and config reload), and every change is announced with `list_changed` and never cached (`ttlMs: 0`). That is a server whose tool list changes over time, which `listChanged` exists for.

This stops holding if yaw-mcp ever serves Streamable HTTP, where one process serves many connections. Activation would then need a server-minted handle passed as a tool argument, or state keyed by an authenticated principal.
