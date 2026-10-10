// Masked-entry secret prompts against a real yaw-mcp process, under node and
// under oam (yaw-mcp's default runtime), with a real upstream.
//
// secret-entry-modern.test.ts covers the 2026-07-28 flow in process, where
// the upstream is mocked. This runs the whole chain once per runtime: the
// broker bundle as a child, a @modelcontextprotocol/client 2.3.1 Client
// talking to it over stdio, an upstream child that will not start without
// PROBE_TOKEN, and the real masked-entry page the broker serves, which the
// test types into over HTTP. The value typed on the page has to come back
// out of the upstream's own environment for the test to pass.
//
// Two openings per runtime, each on a fresh process:
//   - 2026-07-28 (versionNegotiation auto): the prompt rides in the tools/call
//     reply as input_required, URL mode with no elicitationId, and nothing is
//     pushed -- no elicitation/create, no notifications/elicitation/complete;
//   - 2025-11-25 (the client's default, initialize): unchanged, the prompt is
//     pushed as elicitation/create WITH an elicitationId and the completion
//     notification follows.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeOam } from "../oam-spawn.js";
import { BROKER_BUNDLE_HOOK_TIMEOUT_MS, useBrokerBundle } from "./broker-bundle.js";

const TEST_TIMEOUT_MS = 180_000;

/** A stdio MCP server that exits at once, naming PROBE_TOKEN on stderr the
 *  way real servers report a missing credential, unless it was launched with
 *  one. Its one tool echoes the token it received. */
const UPSTREAM_SOURCE = `
if (!process.env.PROBE_TOKEN) {
  process.stderr.write("PROBE_TOKEN is required\\n");
  process.exit(1);
}
let buf = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      reply(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } });
    } else if (msg.method === "tools/list") {
      reply(msg.id, { tools: [{ name: "echo", description: "echoes PROBE_TOKEN", inputSchema: { type: "object" } }] });
    } else if (msg.method === "tools/call") {
      reply(msg.id, { content: [{ type: "text", text: "token=" + process.env.PROBE_TOKEN }] });
    } else if (msg.method === "resources/list" || msg.method === "prompts/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } }) + "\\n");
    } else if (msg.id !== undefined) {
      reply(msg.id, {});
    }
  }
});
process.stdin.resume();
`;

const oam = await probeOam();

let bundlePath: string;
let releaseBundle: () => Promise<void> = async () => {};

beforeAll(async () => {
  const bundle = await useBrokerBundle("yaw-mcp-secret-modern-bundle-");
  bundlePath = bundle.path;
  releaseBundle = bundle.release;
}, BROKER_BUNDLE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await releaseBundle();
});

/** A fresh HOME holding a bundles.json with the probe upstream and no
 *  PROBE_TOKEN for it. */
async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "yaw-mcp-secret-modern-"));
  const upstreamPath = join(home, "upstream.mjs");
  await writeFile(upstreamPath, UPSTREAM_SOURCE, "utf8");
  await mkdir(join(home, ".yaw-mcp"), { recursive: true });
  await writeFile(
    join(home, ".yaw-mcp", "bundles.json"),
    JSON.stringify({
      version: 1,
      servers: [
        {
          id: "probe",
          name: "probe",
          namespace: "probe",
          type: "local",
          command: process.execPath,
          args: [upstreamPath],
          isActive: true,
          description: "probe upstream",
        },
      ],
    }),
    "utf8",
  );
  return home;
}

/** The broker's environment: a throwaway HOME and every background job that
 *  would reach the network or the user's real files switched off. */
function brokerEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("YAW_MCP_")) env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    YAW_MCP_AUTO_UPGRADE: "0",
    YAW_MCP_PREWARM: "0",
    YAW_MCP_AUTO_HEAL: "0",
    YAW_MCP_SIDECAR_REFRESH: "0",
    YAW_MCP_DISABLE_PERSISTENCE: "1",
  };
}

/** The SDK's base stdio transport probes the era on a disposable sibling
 *  process; a subclass probes in place. One broker process per test keeps
 *  the oam run to a single cold start. */
class InPlaceStdioTransport extends StdioClientTransport {}

async function submitPage(url: string, fields: Record<string, string>): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  await res.text();
  return res.status;
}

function text(result: { content?: unknown }): string {
  return ((result.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
}

interface Run {
  /** Messages the broker wrote after the opening, in order. */
  wire: Array<Record<string, unknown>>;
  /** The params of each elicitation the client fulfilled. */
  asked: Array<Record<string, unknown>>;
  activate: string;
  echo: string;
  era: string | undefined;
}

/** Open a session on `launch`, activate the probe (which asks for
 *  PROBE_TOKEN), type `token` on the page the prompt points at, then call the
 *  upstream's tool. */
async function runSecretEntry(launch: [string, string[]], era: "auto" | "legacy", token: string): Promise<Run> {
  const home = await makeHome();
  const [command, args] = launch;
  const transport = new InPlaceStdioTransport({ command, args, env: brokerEnv(home), cwd: home, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const client = new Client(
    { name: "secret-entry-process-test", version: "0.0.0" },
    {
      capabilities: { elicitation: { form: {}, url: {} } },
      ...(era === "auto" ? { versionNegotiation: { mode: "auto" as const } } : {}),
    },
  );
  const asked: Array<Record<string, unknown>> = [];
  client.setRequestHandler("elicitation/create", async (request) => {
    const params = request.params as unknown as Record<string, unknown>;
    asked.push(params);
    expect(await submitPage(params.url as string, { PROBE_TOKEN: token })).toBe(200);
    return { action: "accept" };
  });
  const wire: Array<Record<string, unknown>> = [];
  try {
    await client.connect(transport, { timeout: 60_000 });
    const onmessage = transport.onmessage;
    transport.onmessage = (message) => {
      wire.push(message as unknown as Record<string, unknown>);
      onmessage?.(message);
    };
    const activated = await client.callTool(
      { name: "mcp_connect_activate", arguments: { server: "probe" } },
      { timeout: 120_000 },
    );
    const echoed = await client.callTool({ name: "probe_echo", arguments: {} }, { timeout: 60_000 });
    return { wire, asked, activate: text(activated), echo: text(echoed), era: client.getProtocolEra() };
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\nbroker stderr tail:\n${stderr}`);
  } finally {
    await client.close().catch(() => {});
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

const RUNTIMES: Array<{ name: string; available: boolean; launch: () => [string, string[]] }> = [
  { name: "node", available: true, launch: () => [process.execPath, [bundlePath]] },
  {
    name: `oam ${oam.version ?? "(absent)"}`,
    available: oam.bin !== null,
    launch: () => [oam.bin as string, ["run", bundlePath]],
  },
];

describe.each(RUNTIMES)("secret entry against the broker under $name", ({ available, launch }) => {
  it.skipIf(!available)(
    "on 2026-07-28 asks in the tools/call reply and the typed value reaches the upstream",
    async () => {
      const run = await runSecretEntry(launch(), "auto", "typed-on-2026");
      expect(run.era).toBe("modern");
      expect(run.activate).toContain('Loaded "probe"');
      expect(run.echo).toContain("token=typed-on-2026");
      expect(run.asked).toHaveLength(1);
      expect(run.asked[0].mode).toBe("url");
      expect(run.asked[0]).not.toHaveProperty("elicitationId");
      const inputRequired = run.wire.filter(
        (m) => (m.result as { resultType?: string } | undefined)?.resultType === "input_required",
      );
      expect(inputRequired).toHaveLength(1);
      expect(run.wire.filter((m) => m.method !== undefined && m.id !== undefined)).toEqual([]);
      expect(run.wire.filter((m) => m.method === "notifications/elicitation/complete")).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!available)(
    "on 2025-11-25 still pushes the prompt with an elicitationId and sends the completion notification",
    async () => {
      const run = await runSecretEntry(launch(), "legacy", "typed-on-2025");
      expect(run.era).toBe("legacy");
      expect(run.activate).toContain('Loaded "probe"');
      expect(run.echo).toContain("token=typed-on-2025");
      expect(run.asked).toHaveLength(1);
      expect(run.asked[0].mode).toBe("url");
      expect(typeof run.asked[0].elicitationId).toBe("string");
      const pushed = run.wire.filter((m) => m.method === "elicitation/create" && m.id !== undefined);
      expect(pushed).toHaveLength(1);
      const complete = run.wire.filter((m) => m.method === "notifications/elicitation/complete");
      expect(complete).toHaveLength(1);
      expect((complete[0].params as { elicitationId?: string }).elicitationId).toBe(run.asked[0].elicitationId);
    },
    TEST_TIMEOUT_MS,
  );
});
