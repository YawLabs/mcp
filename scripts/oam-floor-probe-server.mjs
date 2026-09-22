// The server `npm run verify:oam-floor` hosts on `oam run`: the smallest
// stdio @modelcontextprotocol/sdk server that answers initialize, tools/list
// and tools/call. It has to be the REAL SDK, not a hand-rolled JSON-RPC loop
// like the one in shutdown-on-stdin-close.test.ts -- what the floor check
// proves is that the SDK's stdio transport works on oam's child_process/stdio
// implementation, which is what every node/npx sidecar yaw-mcp hosts goes
// through (the "MEASURED" note in src/oam-spawn.ts). The low-level Server
// rather than McpServer, so the only import is the SDK this package already
// depends on: McpServer's tool registration wants zod, which is the SDK's
// dependency, not ours, and a hoisting change would break the probe for a
// reason that has nothing to do with oam.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** The one tool. The verifier passes a nonce and expects it back, so a reply
 *  that is merely well-formed cannot pass for one the server computed. */
const PING = {
  name: "ping",
  description: "Echoes the nonce back, prefixed with pong:",
  inputSchema: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"] },
};

const server = new Server({ name: "oam-floor-probe", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [PING] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "ping") throw new Error(`unknown tool ${req.params.name}`);
  const nonce = req.params.arguments?.nonce;
  return { content: [{ type: "text", text: `pong:${typeof nonce === "string" ? nonce : ""}` }] };
});
await server.connect(new StdioServerTransport());
