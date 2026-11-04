// Activation of a git-sourced server: a missing build fails fast with an
// install_failure that names the fix, and spawns nothing on the way; a ready
// build hands its derived cwd to the stdio transport.
//
// Its own file because the SDK transport and child_process mocks are
// module-scoped.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSpy, transportOpts } = vi.hoisted(() => ({
  spawnSpy: vi.fn(),
  transportOpts: [] as Array<Record<string, unknown>>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...a: unknown[]) => {
      spawnSpy(...a);
      throw new Error("spawn must not run in this file");
    },
    execFile: (...a: unknown[]) => {
      spawnSpy(...a);
      throw new Error("execFile must not run in this file");
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: function MockStdio(opts: Record<string, unknown>) {
    transportOpts.push(opts);
    return { stderr: { on: () => {} } };
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: function MockClient() {
    return {
      connect: () => Promise.reject(new Error("handshake not modelled")),
      close: () => Promise.resolve(),
      setNotificationHandler: () => {},
      setRequestHandler: () => {},
    };
  },
}));

vi.mock("../uv-bootstrap.js", () => ({
  resolveUvSpawn: vi.fn((command: string, args: string[]) => Promise.resolve({ command, args })),
}));

vi.mock("../oam-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../oam-spawn.js")>();
  return {
    ...actual,
    resolveOamSpawn: vi.fn((command: string, args: string[]) => ({ command, args })),
    resolveManagedSpawn: vi.fn((command: string, args: string[]) => ({ command, args })),
    probeOam: vi.fn(() => ({ bin: null, version: null, belowMin: false })),
  };
});

vi.mock("../default-runtime.js", () => ({ defaultRuntime: vi.fn().mockResolvedValue("node") }));
vi.mock("../secrets-audit.js", () => ({ appendAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../logger.js", () => ({ log: vi.fn() }));

const { ActivationError, connectToUpstream, gitBuildMissing } = await import("../upstream.js");
const { resolveUvSpawn } = await import("../uv-bootstrap.js");
const { gitBuildDir, gitFailedPath } = await import("../paths.js");
const { fakeFinishedBuild } = await import("./git-fixture.js");

import type { UpstreamServerConfig } from "../types.js";

const COMMIT = "9f3c2a1d7e0b4c5d6e7f8091a2b3c4d5e6f70812";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-git-preflight-"));
  // gitBuildMissing's default home is os.homedir(), which reads these.
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("HOME", home);
  spawnSpy.mockClear();
  vi.mocked(resolveUvSpawn).mockClear();
  transportOpts.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function gitConfig(over: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig {
  const cwd = join(gitBuildDir("acme_tools", COMMIT, home), "packages", "server");
  return {
    id: "local-acme_tools",
    name: "acme-tools",
    namespace: "acme_tools",
    type: "local",
    transport: "stdio",
    command: "node",
    args: [join(cwd, "dist", "index.js")],
    cwd,
    git: {
      url: "git@github.com:acme/acme-tools-mcp.git",
      ref: "main",
      commit: COMMIT,
      subdir: "packages/server",
      entry: "dist/index.js",
    },
    isActive: true,
    ...over,
  };
}

async function activationError(config: UpstreamServerConfig): Promise<InstanceType<typeof ActivationError>> {
  const err = await connectToUpstream(config).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ActivationError);
  return err as InstanceType<typeof ActivationError>;
}

describe("git build preflight at activation", () => {
  it("refuses a not-built entry as install_failure with the fix and the config pointer, spawning nothing", async () => {
    const err = await activationError(gitConfig());
    expect(err.category).toBe("install_failure");
    expect(err.message).toContain(
      '"acme_tools" is not built on this machine (git 9f3c2a1). Run: yaw-mcp sidecars install',
    );
    expect(err.message).toContain('-> Fix "acme_tools" in');
    expect(err.message).not.toContain("last build failed");
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(resolveUvSpawn).not.toHaveBeenCalled();
    expect(transportOpts).toEqual([]);
  });

  it("quotes the step and tail of the last failed build", async () => {
    mkdirSync(join(home, ".yaw-mcp", "git", "acme_tools"), { recursive: true });
    writeFileSync(
      gitFailedPath("acme_tools", COMMIT, home),
      JSON.stringify({
        commit: COMMIT,
        at: "2026-11-04T00:00:00Z",
        step: "build",
        tail: `error TS2304\n${String.fromCharCode(27)}[31mred`,
      }),
    );
    const err = await activationError(gitConfig());
    expect(err.message).toContain("Its last build failed at build: error TS2304\n?[31mred");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("ignores a .failed file that is not a failed-build record", async () => {
    mkdirSync(join(home, ".yaw-mcp", "git", "acme_tools"), { recursive: true });
    writeFileSync(gitFailedPath("acme_tools", COMMIT, home), "not json");
    expect(await gitBuildMissing(gitConfig(), home)).toBe(
      '"acme_tools" is not built on this machine (git 9f3c2a1). Run: yaw-mcp sidecars install',
    );
  });

  it("adds the --yes hint only when the repo is known to have no script consent here", async () => {
    const bare = '"acme_tools" is not built on this machine (git 9f3c2a1). Run: yaw-mcp sidecars install';
    expect(await gitBuildMissing(gitConfig(), home, true)).toBe(bare);
    expect(await gitBuildMissing(gitConfig(), home, false)).toBe(
      `${bare} (off a TTY: yaw-mcp sidecars install --yes, which allows the repo's install and build scripts to run, asked once per repo)`,
    );
  });

  it("the activation error carries the --yes hint until the repo is allowed here", async () => {
    const hint = "(off a TTY: yaw-mcp sidecars install --yes";
    expect((await activationError(gitConfig())).message).toContain(hint);
    const { recordRepoConsent } = await import("../git-source.js");
    await recordRepoConsent("git@github.com:acme/acme-tools-mcp.git", home);
    const err = await activationError(gitConfig());
    expect(err.message).toContain('"acme_tools" is not built on this machine');
    expect(err.message).not.toContain(hint);
  });

  it("names the missing pin for an entry with no commit, not 'command is required'", async () => {
    const config = gitConfig({ command: undefined, args: undefined, cwd: undefined });
    delete config.git?.commit;
    const err = await activationError(config);
    expect(err.category).toBe("install_failure");
    expect(err.message).toContain('"acme_tools" is a git server with no pinned commit');
    expect(err.message).toContain("yaw-mcp update acme_tools");
    expect(transportOpts).toEqual([]);
  });

  it("is a no-op for an entry without git", async () => {
    expect(await gitBuildMissing({ ...gitConfig(), git: undefined }, home)).toBeNull();
  });

  it("passes the derived cwd to the stdio transport once the build is ready", async () => {
    const buildDir = gitBuildDir("acme_tools", COMMIT, home);
    fakeFinishedBuild(buildDir, COMMIT, { subdir: "packages/server", entry: "dist/index.js" });
    const config = gitConfig();
    await connectToUpstream(config).catch(() => {});
    expect(transportOpts.length).toBeGreaterThan(0);
    expect(transportOpts[0].command).toBe("node");
    expect(transportOpts[0].args).toEqual(config.args);
    expect(transportOpts[0].cwd).toBe(config.cwd);
  });

  it("sets no cwd for a plain entry", async () => {
    await connectToUpstream({
      id: "p",
      name: "p",
      namespace: "plain",
      type: "local",
      transport: "stdio",
      command: "node",
      args: ["x.js"],
      isActive: true,
    }).catch(() => {});
    expect(transportOpts.length).toBeGreaterThan(0);
    expect("cwd" in transportOpts[0]).toBe(false);
  });
});
