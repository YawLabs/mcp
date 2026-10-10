// The server `npm run verify:oam-floor` hosts on `oam run`: the smallest
// stdio @modelcontextprotocol/server server that answers both protocol eras --
// server/discover (2026-07-28) or initialize (2025-11-25), then tools/list and
// tools/call. It has to be the REAL SDK, not a hand-rolled JSON-RPC loop like
// the one in shutdown-on-stdin-close.test.ts -- what the floor check proves is
// that the SDK's stdio serving entry works on oam's child_process/stdio
// implementation, which is the entry yaw-mcp itself serves through and the
// stdio every node/npx sidecar yaw-mcp hosts goes through (the "MEASURED"
// note in src/oam-spawn.ts). serveStdio over the low-level Server, as
// src/server.ts does, so the probe takes the same era routing; and the
// low-level Server rather than McpServer, so the only import is the SDK this
// package already depends on: McpServer's tool registration wants a schema
// library, which is the SDK's dependency, not ours, and a hoisting change
// would break the probe for a reason that has nothing to do with oam.
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

/** The one tool. The verifier passes a nonce and expects it back, so a reply
 *  that is merely well-formed cannot pass for one the server computed. */
const PING = {
  name: "ping",
  description: "Echoes the nonce back, prefixed with pong:",
  inputSchema: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"] },
};

// serveStdio may call the factory twice on one connection (a discover probe
// instance, then a 2025 fallback), so it builds a fresh instance each time.
serveStdio(() => {
  const server = new Server({ name: "oam-floor-probe", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({ tools: [PING] }));
  server.setRequestHandler("tools/call", async (req) => {
    if (req.params.name !== "ping") throw new Error(`unknown tool ${req.params.name}`);
    const nonce = req.params.arguments?.nonce;
    return { content: [{ type: "text", text: `pong:${typeof nonce === "string" ? nonce : ""}` }] };
  });
  return server;
});
