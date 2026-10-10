// The dual-era serving entry against real processes: the broker bundle,
// spawned under node and under oam, answered over raw stdio.
//
// server-start.test.ts drives the same entry in-process through a fake
// transport, which covers the wiring but not the two things only a real
// process shows: that @modelcontextprotocol/server's serveStdio boots on the
// runtime at all (oam's child_process/stdio is its own implementation), and
// what bytes the client actually reads. So this speaks JSON-RPC by hand rather
// than through an SDK client -- the v1 client this package carries cannot open
// a 2026-07-28 connection, and a hand-written frame is also the only way to
// see the envelope the server stamps instead of the one a client re-derives.
//
// Three openings, each on a fresh process:
//   - modern: server/discover then tools/list, both with the 2026-07-28
//     request envelope (what Claude Code 2.1.292 sends);
//   - legacy: initialize 2025-11-25 (what Cursor, VS Code and typed send);
//   - the escape hatch: YAW_MCP_PROTOCOL=legacy, where server/discover gets
//     -32601 again and initialize still works.
//
// Nothing here is a wall-clock budget; the deadline only bounds "hung". The
// latency claim (discover answered before start() finishes loading) is pinned
// in server-start.test.ts, where start() can be made slow on purpose.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { META_TOOL_NAMES, SERVER_INSTRUCTIONS } from "../meta-tools.js";
import { probeOam } from "../oam-spawn.js";
import { BROKER_BUNDLE_HOOK_TIMEOUT_MS, useBrokerBundle } from "./broker-bundle.js";

const DEADLINE_MS = 30_000;

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "serve-era-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const oam = await probeOam();

let home: string;
let bundlePath: string;
let releaseBundle: () => Promise<void> = async () => {};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "yaw-mcp-serve-era-"));
  const bundle = await useBrokerBundle("yaw-mcp-serve-era-bundle-");
  bundlePath = bundle.path;
  releaseBundle = bundle.release;
}, BROKER_BUNDLE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await releaseBundle();
  await rm(home, { recursive: true, force: true });
});

interface Broker {
  request(id: string | number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string): void;
  /** Every message the broker wrote that was not a reply to a request. */
  unsolicited(): Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Spawn the bundle on `command args...` with a throwaway HOME and every
 *  background job that would reach the network or the user's real files
 *  switched off. */
function startBroker(command: string, args: string[], extraEnv: Record<string, string> = {}): Broker {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("YAW_MCP_")) delete env[k];
  }
  const child = spawn(command, args, {
    cwd: home,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      YAW_MCP_AUTO_UPGRADE: "0",
      YAW_MCP_PREWARM: "0",
      YAW_MCP_AUTO_HEAL: "0",
      YAW_MCP_SIDECAR_REFRESH: "0",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (d: string) => {
    stderr = (stderr + d).slice(-2000);
  });
  const waiters = new Map<string | number, (m: Record<string, unknown>) => void>();
  const others: Array<Record<string, unknown>> = [];
  let buf = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      const id = msg.id as string | number | undefined;
      const waiter = id === undefined ? undefined : waiters.get(id);
      if (waiter) {
        waiters.delete(id as string | number);
        waiter(msg);
      } else {
        others.push(msg);
      }
    }
  });
  const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
  const write = (msg: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  };
  return {
    request(id, method, params) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`no reply to ${method} within ${DEADLINE_MS}ms; broker stderr tail:\n${stderr}`));
        }, DEADLINE_MS);
        waiters.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        write({ id, method, ...(params ? { params } : {}) });
      });
    },
    notify(method) {
      write({ method });
    },
    unsolicited: () => others,
    async close() {
      // The broker's own shutdown trigger: stdin EOF.
      child.stdin.end();
      const killed = setTimeout(() => child.kill(), DEADLINE_MS);
      await exited;
      clearTimeout(killed);
    },
  };
}

const RUNTIMES: Array<{ name: string; available: boolean; launch: () => [string, string[]] }> = [
  { name: "node", available: true, launch: () => [process.execPath, [bundlePath]] },
  {
    name: `oam ${oam.version ?? "(absent)"}`,
    available: oam.bin !== null,
    launch: () => [oam.bin as string, ["run", bundlePath]],
  },
];

describe.each(RUNTIMES)("the serving entry under $name", ({ available, launch }) => {
  it.skipIf(!available)(
    "opens 2026-07-28 on server/discover and serves tools/list with the request envelope",
    async () => {
      const [command, args] = launch();
      const broker = startBroker(command, args);
      try {
        const discover = await broker.request("d1", "server/discover", { _meta: MODERN_META });
        const d = discover.result as Record<string, unknown>;
        expect(discover.error).toBeUndefined();
        expect(d.supportedVersions).toEqual(["2026-07-28"]);
        // Verbatim: the routing prose that used to ride only on initialize.
        expect(d.instructions).toBe(SERVER_INSTRUCTIONS);
        expect(d.resultType).toBe("complete");
        expect(d.capabilities).toMatchObject({ tools: { listChanged: true } });

        const list = await broker.request(1, "tools/list", { _meta: MODERN_META });
        const l = list.result as { tools: Array<{ name: string }>; resultType?: string; ttlMs?: number };
        expect(l.resultType).toBe("complete");
        expect(l.ttlMs).toBe(0);
        // A fresh HOME has no servers, so the list is exactly the meta-tools.
        expect(new Set(l.tools.map((t) => t.name))).toEqual(META_TOOL_NAMES);
        // No initialize was ever sent, and nothing was answered as if it had
        // been: a modern opening is discover-then-requests.
        expect(broker.unsolicited()).toEqual([]);
      } finally {
        await broker.close();
      }
    },
    DEADLINE_MS * 3,
  );

  it.skipIf(!available)(
    "still serves a 2025-11-25 client that opens with initialize",
    async () => {
      const [command, args] = launch();
      const broker = startBroker(command, args);
      try {
        const init = await broker.request(0, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "serve-era-test", version: "0.0.0" },
        });
        const r = init.result as Record<string, unknown>;
        expect(r.protocolVersion).toBe("2025-11-25");
        expect(r.instructions).toBe(SERVER_INSTRUCTIONS);
        broker.notify("notifications/initialized");

        const list = await broker.request(1, "tools/list", {});
        const l = list.result as Record<string, unknown> & { tools: Array<{ name: string }> };
        expect(new Set(l.tools.map((t) => t.name))).toEqual(META_TOOL_NAMES);
        // The 2025 wire has no result envelope; the SDK strips it there.
        expect("resultType" in l).toBe(false);
        expect("ttlMs" in l).toBe(false);
      } finally {
        await broker.close();
      }
    },
    DEADLINE_MS * 3,
  );

  it.skipIf(!available)(
    "with YAW_MCP_PROTOCOL=legacy answers server/discover -32601 and keeps initialize",
    async () => {
      const [command, args] = launch();
      const broker = startBroker(command, args, { YAW_MCP_PROTOCOL: "legacy" });
      try {
        // The legacy signal a probing client falls back on: method not found,
        // with the probe's own id echoed.
        const discover = await broker.request("probe-1", "server/discover", { _meta: MODERN_META });
        expect(discover.id).toBe("probe-1");
        expect((discover.error as { code: number }).code).toBe(-32601);

        const init = await broker.request(0, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "serve-era-test", version: "0.0.0" },
        });
        expect((init.result as Record<string, unknown>).protocolVersion).toBe("2025-11-25");
        broker.notify("notifications/initialized");
        const list = await broker.request(1, "tools/list", {});
        expect(new Set((list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name))).toEqual(
          META_TOOL_NAMES,
        );
      } finally {
        await broker.close();
      }
    },
    DEADLINE_MS * 3,
  );
});
