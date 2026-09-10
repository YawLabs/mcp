import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The product's central claim, exercised against real processes for the first
// time: a client asks the broker for a tool, the broker routes the call to an
// upstream it spawned, and the upstream's own answer comes back.
//
// Every other test of that path stops at a boundary. upstream.test.ts mocks
// StdioClientTransport, so nothing is ever spawned; proxy.test.ts builds
// routes from fixture connections; call-cmd.test.ts injects a fake `connect`.
// Those are the right shape for what they test -- but stacked together they
// mean the round trip had only ever been verified in pieces that each assume
// the next piece works. shutdown-on-stdin-close.test.ts does spawn a real
// broker and a real upstream, and is the scaffolding this file reuses, but it
// activates and then immediately closes stdin: no tool call is ever dispatched
// and no result is ever read back.
//
// So this walks the whole path against real processes:
//
//   1. the broker answers a real MCP handshake and advertises its meta-tools;
//   2. an upstream's tools are ABSENT from tools/list before activation and
//      PRESENT, namespaced, after -- the lazy-load behaviour the whole design
//      rests on;
//   3. a namespaced call reaches the upstream and its answer comes back; and
//   4. the `env` on the bundles entry actually arrives in the spawned child's
//      environment.
//
// The upstream echoes back a nonce it is given plus a value only a real child
// process could produce, so a regression that quietly answered from cache or
// from a stub cannot satisfy the assertion.
//
// What this is NOT, stated plainly because the opposite is the tempting claim:
// it is not the only coverage of any step above, and it was not written on the
// premise that it would be. Two mutations were run against the whole suite to
// check -- dropping `serverEnv` from the spawn, and keying tool routes by the
// bare name instead of the namespaced one. Each one turns this test red, and
// each is ALSO caught by three or more existing tests in upstream.test.ts and
// proxy.test.ts respectively. That is a fact about those suites being good,
// not a reason to delete this one.
//
// Its distinct job is composition. Every unit above is verified against a mock
// of the thing next to it, which leaves exactly one class of bug uncovered:
// the one where every piece passes against its mock and the assembled system
// still does not work -- a seam mismatch, an option the real SDK transport
// reads differently than the mock does, a schema the real server rejects at
// registration. No other test in this repo spawns a real upstream AND
// completes a tool call through it, so nothing else would fail.

const INDEX_SRC = fileURLToPath(new URL("../index.ts", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Generous on purpose. Nothing here is a wall-clock BUDGET -- the assertions
 *  are all on values -- so this is only "how long before we call it hung".
 *  A spawn plus a handshake plus an inventory is ~2s standalone; the rest is
 *  headroom for a contended box. */
const DEADLINE_MS = 30_000;

let workDir: string;
let bundlePath: string;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A minimal stdio MCP server that answers the three inventory calls the
 *  broker makes on connect, plus one real tool.
 *
 *  `echo` returns the nonce it was handed, the value of PROBE_TOKEN as the
 *  process actually received it, and its own pid. All three are things only a
 *  genuinely spawned child can report: the nonce proves the arguments crossed
 *  the boundary, PROBE_TOKEN proves the broker injected the entry's `env`, and
 *  the pid proves a distinct process produced the answer. */
const UPSTREAM_SOURCE = (pidFile: string): string => `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
let buf = "";
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
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
      reply(msg.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "probe-upstream", version: "1" },
      });
    } else if (msg.method === "tools/list") {
      reply(msg.id, {
        tools: [{
          name: "echo",
          description: "echoes the nonce it is given",
          inputSchema: {
            type: "object",
            properties: { nonce: { type: "string" } },
            required: ["nonce"],
          },
        }],
      });
    } else if (msg.method === "tools/call") {
      const nonce = msg.params?.arguments?.nonce ?? "MISSING";
      const token = process.env.PROBE_TOKEN ?? "UNSET";
      reply(msg.id, {
        content: [{
          type: "text",
          text: "nonce=" + nonce + " token=" + token + " pid=" + process.pid,
        }],
      });
    } else if (msg.method === "resources/list" || msg.method === "prompts/list") {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } }) + "\\n",
      );
    } else if (msg.id !== undefined) {
      reply(msg.id, {});
    }
  }
});
process.stdin.resume();
`;

describe("a real client, a real broker and a real upstream complete a tool call", () => {
  beforeAll(async () => {
    // Bundled from source rather than read from dist/, so the test does not
    // depend on a build step having run first -- same reasoning, and the same
    // esbuild call, as shutdown-on-stdin-close.test.ts.
    const { build } = await import("esbuild");
    workDir = await mkdtemp(join(tmpdir(), "yaw-mcp-e2e-"));
    bundlePath = join(workDir, "entry.mjs");
    await build({
      entryPoints: [INDEX_SRC],
      absWorkingDir: PROJECT_ROOT,
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      mainFields: ["module", "main"],
      banner: {
        js: 'import { createRequire as __yawCreateRequire } from "node:module";\nconst require = __yawCreateRequire(import.meta.url);',
      },
      define: { __VERSION__: JSON.stringify("0.0.0-test") },
      logLevel: "silent",
    });
  }, 180_000);

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("routes a namespaced call to the upstream it spawned and returns its answer", async () => {
    const home = await mkdtemp(join(tmpdir(), "yaw-mcp-e2e-home-"));
    const pidFile = join(home, "upstream.pid");
    const upstreamPath = join(home, "upstream.mjs");
    await writeFile(upstreamPath, UPSTREAM_SOURCE(pidFile), "utf8");
    await mkdir(join(home, ".yaw-mcp"), { recursive: true });
    await writeFile(
      join(home, ".yaw-mcp", "bundles.json"),
      JSON.stringify({
        servers: [
          {
            id: "probe",
            name: "probe",
            namespace: "probe",
            type: "local",
            command: process.execPath,
            args: [upstreamPath],
            // The credential-injection half of the test. A mocked transport
            // never proves this reaches the child's environment.
            env: { PROBE_TOKEN: "s3cret-from-bundles" },
            isActive: true,
            description: "probe upstream",
          },
        ],
      }),
      "utf8",
    );

    // Strip inherited YAW_MCP_* so the developer's own environment cannot
    // change what this test measures.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(childEnv)) {
      if (k.startsWith("YAW_MCP_")) delete childEnv[k];
    }

    const child = spawn(process.execPath, [bundlePath], {
      cwd: home,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...childEnv,
        HOME: home,
        USERPROFILE: home,
        YAW_MCP_AUTO_UPGRADE: "0",
        YAW_MCP_SIDECAR_REFRESH: "0",
        YAW_MCP_DISABLE_PERSISTENCE: "1",
        LOG_LEVEL: "info",
      },
    });

    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });

    // Frame stdout as newline-delimited JSON-RPC and index responses by id,
    // which is what an MCP client's transport does. Reading raw text and
    // regexing for an id cannot tell a response apart from a log line that
    // happens to contain the same digits.
    const responses = new Map<number, Record<string, unknown>>();
    let stdoutBuf = "";
    child.stdout.on("data", (c: Buffer) => {
      stdoutBuf += c.toString();
      for (let i = stdoutBuf.indexOf("\n"); i >= 0; i = stdoutBuf.indexOf("\n")) {
        const line = stdoutBuf.slice(0, i).trim();
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (typeof msg.id === "number") responses.set(msg.id, msg);
        } catch {
          // Not JSON-RPC. Ignorable here -- the assertion that the broker
          // keeps stdout clean belongs to its own test, not this one.
        }
      }
    });

    let exited = false;
    child.on("exit", () => {
      exited = true;
    });

    const send = (o: unknown): void => {
      child.stdin.write(`${JSON.stringify(o)}\n`);
    };

    /** Send a request and wait for the response carrying its id. Fails with
     *  the broker's stderr tail rather than a bare timeout, because "it hung"
     *  says nothing about why. */
    const request = async (id: number, method: string, params?: unknown): Promise<Record<string, unknown>> => {
      send({ jsonrpc: "2.0", id, method, params });
      const deadline = Date.now() + DEADLINE_MS;
      while (Date.now() < deadline) {
        const got = responses.get(id);
        if (got) return got;
        if (exited) throw new Error(`broker exited awaiting ${method}; stderr tail:\n${stderr.slice(-800)}`);
        await sleep(50);
      }
      throw new Error(`no response to ${method} within ${DEADLINE_MS}ms; stderr tail:\n${stderr.slice(-800)}`);
    };

    /** The text of a tools/call result, however the content is shaped. */
    const resultText = (res: Record<string, unknown>): string => {
      const result = res.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
      return (result?.content ?? [])
        .filter((b) => b?.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
    };

    const toolNames = (res: Record<string, unknown>): string[] => {
      const result = res.result as { tools?: Array<{ name?: string }> } | undefined;
      return (result?.tools ?? []).map((t) => t.name ?? "");
    };

    try {
      // 1. A real MCP handshake.
      const init = await request(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e-probe", version: "0" },
      });
      expect(init.error, `initialize failed: ${JSON.stringify(init.error)}`).toBeUndefined();
      const initResult = init.result as { serverInfo?: { name?: string } };
      expect(initResult.serverInfo?.name).toBeTruthy();
      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      // 2. Before activation the meta-tools are advertised and the upstream's
      //    tool is not. This is the lazy-load property the design rests on --
      //    if `probe_echo` were listed here, nothing would have been saved.
      const before = await request(2, "tools/list", {});
      const beforeNames = toolNames(before);
      expect(beforeNames).toContain("mcp_connect_discover");
      expect(beforeNames).toContain("mcp_connect_activate");
      expect(beforeNames).not.toContain("probe_echo");

      // 3. Activate, which spawns the real upstream.
      const activate = await request(3, "tools/call", {
        name: "mcp_connect_activate",
        arguments: { server: "probe" },
      });
      expect(activate.error, `activate failed: ${JSON.stringify(activate.error)}`).toBeUndefined();

      const upstreamPid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isFinite(upstreamPid), "upstream never wrote a pid file").toBe(true);
      expect(isAlive(upstreamPid), "upstream is not running after activate").toBe(true);
      expect(upstreamPid).not.toBe(process.pid);

      // 4. After activation the upstream's tool is routed, under the
      //    `${namespace}_${tool}` name buildToolRoutes documents.
      const after = await request(4, "tools/list", {});
      expect(toolNames(after)).toContain("probe_echo");

      // 5. The round trip. The nonce proves the arguments crossed into the
      //    child; PROBE_TOKEN proves the broker injected the entry's `env`;
      //    the pid proves the answer came from that spawned process and not
      //    from anything inside the broker.
      const nonce = "e2e-nonce-9f4c2a";
      const called = await request(5, "tools/call", {
        name: "probe_echo",
        arguments: { nonce },
      });
      expect(called.error, `probe_echo failed: ${JSON.stringify(called.error)}`).toBeUndefined();
      const text = resultText(called);
      expect(text).toContain(`nonce=${nonce}`);
      expect(text).toContain("token=s3cret-from-bundles");
      expect(text).toContain(`pid=${upstreamPid}`);
    } finally {
      // Cleanup must never throw: when this test fails, it fails with two
      // processes still holding `home` open, and an unguarded rm would raise
      // EBUSY on Windows and replace the real assertion error with it.
      if (!exited) child.kill("SIGKILL");
      try {
        const pid = Number((await readFile(pidFile, "utf8")).trim());
        if (Number.isFinite(pid) && isAlive(pid)) process.kill(pid, "SIGKILL");
      } catch {
        // never started, or already gone
      }
      await sleep(250);
      await rm(home, { recursive: true, force: true }).catch(() => {
        // A leftover temp dir is noise; a masked assertion is a lie.
      });
    }
  }, 120_000);
});
