// Coverage gaps on the upstream spawn path: what rewriteNpmToManagedNode logs
// when an npx flag keeps a server off the managed tree, how connectToUpstream
// hands a Windows "Path" to the stdio transport, and which wording
// defaultRuntime warns with while bundles.json is unparseable.
//
// LOG_LEVEL is raised BEFORE the dynamic imports below, for the reason
// oam-spawn-probe-log.test.ts gives: a static import would build the logger
// during hoisting, before any statement in the file runs.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const priorLogLevel = process.env.LOG_LEVEL;
process.env.LOG_LEVEL = "debug";

const { rewriteNpmToManagedNode } = await import("../oam-spawn.js");
const { defaultRuntime, resetDefaultRuntimeCache } = await import("../default-runtime.js");
const { localBundlesPath } = await import("../local-bundles.js");
const { CONFIG_DIRNAME } = await import("../paths.js");

// vitest gives each FILE a fresh module registry, not a fresh process.env.
afterAll(() => {
  if (priorLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = priorLogLevel;
});

/** Every log line written to stderr while `fn` runs, parsed. */
async function captureLines(fn: () => unknown): Promise<Array<Record<string, unknown>>> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks
    .join("")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("rewriteNpmToManagedNode flag diagnostic", () => {
  it("names the flag and the argv length, never the argv, when an npx flag keeps a server off the managed tree", async () => {
    // The managed-tree sibling of rewriteForOam's redaction rule: everything
    // after the flag belongs to the server, and a server's args are where a
    // token rides. Debug logs are what support asks users to send in.
    const args = ["-y", "--package=some-mcp", "some-mcp", "--token", "hunter2-not-for-logs"];
    let result: { command: string; args: string[] } | undefined;
    const lines = await captureLines(() => {
      result = rewriteNpmToManagedNode("npx", args, {
        nodeBin: "/usr/bin/node",
        resolveEntry: () => "/pkgs/some-mcp/index.js",
      });
    });

    expect(result).toEqual({ command: "npx", args });

    const notes = lines.filter((l) =>
      String(l.msg ?? "").includes("carries flags yaw-mcp does not parse; staying on npx instead of the managed tree"),
    );
    expect(notes, "exactly one stay-on-npx line for the managed tree").toHaveLength(1);
    const note = notes[0];
    expect(note.level).toBe("debug");
    expect(note.flag).toBe("--package=some-mcp");
    expect(note.argc).toBe(5);
    expect(JSON.stringify(note)).not.toContain("hunter2-not-for-logs");
    // Nothing else logged in that call may carry the token either.
    expect(JSON.stringify(lines)).not.toContain("hunter2-not-for-logs");
  });
});

describe("connectToUpstream child env on win32", () => {
  afterEach(() => {
    for (const m of [
      "@modelcontextprotocol/sdk/client/index.js",
      "@modelcontextprotocol/sdk/client/stdio.js",
      "@modelcontextprotocol/sdk/client/sse.js",
      "@modelcontextprotocol/sdk/client/streamableHttp.js",
      "../oam-spawn.js",
      "../default-runtime.js",
      "../uv-bootstrap.js",
      "../secrets-audit.js",
    ]) {
      vi.doUnmock(m);
    }
    vi.resetModules();
  });

  it.runIf(process.platform === "win32")(
    "hands the transport the server's own Path as PATH, with no other-case spelling left behind",
    async () => {
      // The same SDK stand-ins upstream.test.ts installs, scoped to this case
      // with doMock + a fresh registry so the rest of this file keeps the real
      // modules. The connect is made to fail: only the transport construction
      // is under test.
      const seen: { stdio: Array<{ command: string; args: string[]; env?: Record<string, string> }> } = {
        stdio: [],
      };
      vi.resetModules();
      vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
        Client: function MockClient() {
          return {
            connect: () => Promise.reject(new Error("transport error")),
            close: () => Promise.resolve(),
            listTools: () => Promise.resolve({ tools: [] }),
            listResources: () => Promise.resolve({ resources: [] }),
            listPrompts: () => Promise.resolve({ prompts: [] }),
            getInstructions: () => undefined,
            onclose: undefined,
            setNotificationHandler: () => {},
            setRequestHandler: () => {},
          };
        },
      }));
      vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", async () => {
        const { EventEmitter } = await import("node:events");
        return {
          StdioClientTransport: function MockStdio(opts: {
            command: string;
            args: string[];
            env?: Record<string, string>;
          }) {
            seen.stdio.push(opts);
            return { stderr: new EventEmitter(), pid: undefined };
          },
        };
      });
      vi.doMock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: function MockSSE() {} }));
      vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
        StreamableHTTPClientTransport: function MockHTTP() {},
      }));
      vi.doMock("../oam-spawn.js", async (importOriginal) => {
        const actual = await importOriginal<typeof import("../oam-spawn.js")>();
        return {
          ...actual,
          resolveOamSpawn: vi.fn((command: string, args: string[]) => ({ command, args })),
          resolveManagedSpawn: vi.fn((command: string, args: string[]) => ({ command, args })),
          probeOam: vi.fn(() => ({ bin: "/usr/bin/oam", version: actual.MIN_OAM_VERSION, belowMin: false })),
        };
      });
      vi.doMock("../default-runtime.js", () => ({ defaultRuntime: vi.fn().mockResolvedValue(null) }));
      vi.doMock("../uv-bootstrap.js", () => ({
        resolveUvSpawn: vi.fn((cmd: string, args: string[]) => Promise.resolve({ command: cmd, args })),
      }));
      vi.doMock("../secrets-audit.js", () => ({ appendAuditEvent: vi.fn().mockResolvedValue(undefined) }));

      const { connectToUpstream, ActivationError } = await import("../upstream.js");

      const config = {
        id: "test-srv",
        name: "Test Server",
        namespace: "test",
        type: "local",
        command: "node",
        args: [],
        env: { Path: "C:\\mine" },
        isActive: true,
      };

      let err: unknown;
      await captureLines(async () => {
        try {
          await connectToUpstream(config as never);
        } catch (e) {
          err = e;
        }
      });

      expect(err).toBeInstanceOf(ActivationError);
      expect(seen.stdio.length).toBeGreaterThan(0);
      const env = seen.stdio[seen.stdio.length - 1].env ?? {};
      expect(env.PATH).toBe("C:\\mine");
      const pathKeys = Object.keys(env).filter((k) => k.toUpperCase() === "PATH");
      expect(pathKeys, "a second spelling of PATH reached the child").toEqual(["PATH"]);
    },
  );
});

describe("defaultRuntime degraded-read warn wording", () => {
  let synthHome: string;
  let synthCwd: string;

  beforeEach(() => {
    // synthCwd inside synthHome so the project walk stops at the synthetic
    // home (default-runtime.test.ts's isolation).
    synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-defrt-gap-"));
    synthCwd = mkdtempSync(join(synthHome, "cwd-"));
    resetDefaultRuntimeCache();
    delete process.env.YAW_MCP_DEFAULT_RUNTIME;
  });

  afterEach(() => {
    rmSync(synthHome, { recursive: true, force: true });
    resetDefaultRuntimeCache();
    delete process.env.YAW_MCP_DEFAULT_RUNTIME;
  });

  function bundlesFile(): string {
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    return localBundlesPath(join(synthHome, CONFIG_DIRNAME));
  }

  function degradedWarns(lines: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return lines.filter((l) => String(l.msg ?? "").includes("could not be read for the default runtime"));
  }

  it("names the kept value when a usable read came first", async () => {
    const file = bundlesFile();
    writeFileSync(file, JSON.stringify({ version: 1, servers: [], defaultRuntime: "node" }));
    const opts = { cwd: synthCwd, home: synthHome, now: () => 1_000 };
    expect(await defaultRuntime(opts)).toBe("node");

    writeFileSync(file, '{ "version": 1, "servers": [], "defaultRuntime": "node"');
    let answer: unknown;
    const lines = await captureLines(async () => {
      answer = await defaultRuntime(opts);
    });

    expect(answer).toBe("node");
    const warns = degradedWarns(lines);
    expect(warns).toHaveLength(1);
    expect(warns[0].level).toBe("warn");
    expect(String(warns[0].msg)).toContain('keeping the last value read ("node")');
    expect(String(warns[0].msg)).not.toContain("using the fallback");
  });

  it("says the fallback is in use when no usable read ever happened", async () => {
    const file = bundlesFile();
    writeFileSync(file, '{ "version": 1, "servers": [], "defaultRuntime": "node"');
    let answer: unknown;
    const lines = await captureLines(async () => {
      answer = await defaultRuntime({ cwd: synthCwd, home: synthHome, now: () => 1_000 });
    });

    expect(answer).toBeNull();
    const warns = degradedWarns(lines);
    expect(warns).toHaveLength(1);
    expect(warns[0].level).toBe("warn");
    expect(String(warns[0].msg)).toContain("using the fallback until the file changes");
    expect(String(warns[0].msg)).not.toContain("keeping the last value read");
  });
});
