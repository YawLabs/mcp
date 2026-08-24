import { afterEach, describe, expect, it, vi } from "vitest";
import { quoteArgForDisplay, quoteShellArgIfNeeded } from "../auto-upgrade.js";
import {
  buildUpgradePlan,
  detectInstallMethod,
  detectSea,
  fetchLatestVersion,
  type InstallMethod,
  localInstallRoot,
  npmGlobalPrefix,
  parseUpgradeArgs,
  REGISTRY_FETCH_TIMEOUT_MS,
  refineInstallMethod,
  runUpgrade,
} from "../upgrade-cmd.js";

/** An oam probe answer for runUpgrade's advisory floor line. Only the two
 *  fields the line reads are needed. */
const oamProbe =
  (belowMin: boolean, version: string | null = "0.8.2") =>
  async () => ({ version, belowMin });

function captureIO(): { out: string[]; err: string[]; push: (s: string) => void; pushErr: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    push: (s: string) => {
      out.push(s);
    },
    pushErr: (s: string) => {
      err.push(s);
    },
  };
}

describe("parseUpgradeArgs", () => {
  it("defaults to no flags", () => {
    expect(parseUpgradeArgs([])).toEqual({ ok: true, options: {} });
  });

  it("accepts --run", () => {
    expect(parseUpgradeArgs(["--run"])).toEqual({ ok: true, options: { run: true } });
  });

  it("accepts --json", () => {
    expect(parseUpgradeArgs(["--json"])).toEqual({ ok: true, options: { json: true } });
  });

  it("accepts both --run and --json", () => {
    expect(parseUpgradeArgs(["--run", "--json"])).toEqual({ ok: true, options: { run: true, json: true } });
  });

  it("rejects unknown flags", () => {
    const r = parseUpgradeArgs(["--bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown argument "--bogus"');
  });

  it("--help returns usage as error", () => {
    const r = parseUpgradeArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Usage: yaw-mcp upgrade");
  });
});

describe("detectInstallMethod", () => {
  it("returns `unknown` for undefined argvPath", () => {
    expect(detectInstallMethod(undefined)).toBe("unknown");
  });

  it("detects npx cache on linux/macos", () => {
    expect(detectInstallMethod("/home/user/.npm/_npx/abc123/node_modules/@yawlabs/mcp/dist/index.js")).toBe("npx");
  });

  it("detects npx cache on windows", () => {
    expect(
      detectInstallMethod(
        "C:\\Users\\jeff\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@yawlabs\\mcp\\dist\\index.js",
      ),
    ).toBe("npx");
  });

  it("does NOT classify a user project path that merely contains a `_npx` segment as npx", () => {
    // A bare `_npx` directory anywhere in the path used to match. The npx
    // marker now requires the npm-cache context (_npx/<hex>/node_modules/
    // @yawlabs/mcp/), so a project dir named `_npx` falls through to the
    // real install method (local-node-modules) instead of false-positiving.
    expect(detectInstallMethod("/home/u/projects/_npx/app/node_modules/@yawlabs/mcp/dist/index.js")).toBe(
      "local-node-modules",
    );
  });

  it("detects linux global install under /usr/lib/node_modules", () => {
    expect(detectInstallMethod("/usr/lib/node_modules/@yawlabs/mcp/dist/index.js")).toBe("global-npm");
  });

  it("detects macos homebrew-style /usr/local/lib/node_modules", () => {
    expect(detectInstallMethod("/usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js")).toBe("global-npm");
  });

  it("detects windows global npm under AppData/Roaming/npm", () => {
    expect(
      detectInstallMethod("C:\\Users\\jeff\\AppData\\Roaming\\npm\\node_modules\\@yawlabs\\mcp\\dist\\index.js"),
    ).toBe("global-npm");
  });

  it("detects scoop/volta-style <prefix>/bin/node_modules as global", () => {
    expect(
      detectInstallMethod(
        "C:\\Users\\jeff\\scoop\\persist\\nodejs22\\bin\\node_modules\\@yawlabs\\mcp\\dist\\index.js",
      ),
    ).toBe("global-npm");
    expect(
      detectInstallMethod(
        "C:\\Users\\jeff\\scoop\\apps\\nodejs22\\current\\bin\\node_modules\\@yawlabs\\mcp\\dist\\index.js",
      ),
    ).toBe("global-npm");
  });

  it("detects nvm-style /home/u/.nvm/versions/node/.../lib/node_modules as global", () => {
    expect(detectInstallMethod("/home/u/.nvm/versions/node/v22.11.0/lib/node_modules/@yawlabs/mcp/dist/index.js")).toBe(
      "global-npm",
    );
  });

  it("detects a project-local node_modules install", () => {
    expect(detectInstallMethod("/proj/app/node_modules/@yawlabs/mcp/dist/index.js")).toBe("local-node-modules");
  });

  it("does NOT classify a workspace package directory named `lib` as a global install", () => {
    // The POSIX global marker used to be a bare `/lib/node_modules/@yawlabs/mcp/`,
    // which any monorepo package literally named `lib` satisfies. maybeAutoUpgrade
    // then treated it as global-npm and spawned
    // `npm install -g --prefix <repo>/packages` (detectRunningInstallPrefix strips
    // the trailing /lib), writing a global tree and bin shims into the user's repo
    // and overwriting the workspace-pinned version. The marker is now anchored on
    // real Node-root shapes, so this falls through to local-node-modules.
    expect(detectInstallMethod("/home/u/repo/packages/lib/node_modules/@yawlabs/mcp/dist/index.js")).toBe(
      "local-node-modules",
    );
    expect(detectInstallMethod("C:\\dev\\repo\\packages\\lib\\node_modules\\@yawlabs\\mcp\\dist\\index.js")).toBe(
      "local-node-modules",
    );
  });

  it("still detects the real POSIX global prefixes after anchoring the lib marker", () => {
    // The anchored marker must keep every shape a global install actually uses:
    // system prefixes, /opt tool prefixes, and version-manager Node roots. An
    // exotic prefix that misses these degrades safely (local-node-modules, which
    // refineInstallMethod then fixes via `npm prefix -g`) -- but these must not
    // need refinement.
    for (const p of [
      "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/opt/homebrew/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/opt/node/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.nvm/versions/node/v22.11.0/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.volta/tools/image/node/22.11.0/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.asdf/installs/nodejs/22.11.0/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.local/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.local/share/fnm/node-versions/v22.11.0/installation/lib/node_modules/@yawlabs/mcp/dist/index.js",
    ]) {
      expect(detectInstallMethod(p), p).toBe("global-npm");
    }
  });

  it("detects pnpm global stores on linux/macos/windows", () => {
    expect(detectInstallMethod("/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js")).toBe(
      "pnpm-global",
    );
    expect(detectInstallMethod("/Users/u/Library/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js")).toBe(
      "pnpm-global",
    );
    expect(
      detectInstallMethod("C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@yawlabs\\mcp\\dist\\index.js"),
    ).toBe("pnpm-global");
  });

  it("detects bun global installs", () => {
    expect(detectInstallMethod("/home/u/.bun/install/global/node_modules/@yawlabs/mcp/dist/index.js")).toBe(
      "bun-global",
    );
  });

  it("detects the Yaw Terminal bundled copy (asar.unpacked) over the node_modules marker", () => {
    expect(
      detectInstallMethod(
        "C:\\Users\\u\\AppData\\Local\\yaw\\resources\\app.asar.unpacked\\node_modules\\@yawlabs\\mcp\\dist\\index.js",
      ),
    ).toBe("bundled-app");
    expect(
      detectInstallMethod(
        "/Applications/Yaw.app/Contents/Resources/app.asar.unpacked/node_modules/@yawlabs/mcp/dist/index.js",
      ),
    ).toBe("bundled-app");
  });

  it("detects dev checkout (src/)", () => {
    expect(detectInstallMethod("/home/jeff/yaw/yaw-mcp/src/index.ts")).toBe("dev-checkout");
  });

  it("detects dev checkout (dist/)", () => {
    expect(detectInstallMethod("/home/jeff/yaw/yaw-mcp/dist/index.js")).toBe("dev-checkout");
  });
});

describe("detectSea", () => {
  it("returns false when ELECTRON_RUN_AS_NODE is set (Electron is never a SEA)", async () => {
    const prev = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      expect(await detectSea()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = prev;
    }
  });

  it("returns false on an ordinary node run (execPath basename is node; no SEA blob)", async () => {
    // Vitest runs under plain node, so the basename gate (and isSea()) yield
    // false -- this pins that detectSea() never false-positives on real node.
    expect(await detectSea()).toBe(false);
  });
});

describe("refineInstallMethod", () => {
  it("reclassifies local-node-modules as global-npm when the entrypoint lives under npm's prefix", async () => {
    // Windows layout: globals at <prefix>/node_modules.
    expect(
      await refineInstallMethod(
        "local-node-modules",
        "/custom/prefix/node_modules/@yawlabs/mcp/dist/index.js",
        async () => "/custom/prefix",
      ),
    ).toBe("global-npm");
    // POSIX layout: globals at <prefix>/lib/node_modules.
    expect(
      await refineInstallMethod(
        "local-node-modules",
        "/custom/prefix/lib/node_modules/@yawlabs/mcp/dist/index.js",
        async () => "/custom/prefix",
      ),
    ).toBe("global-npm");
  });

  it("leaves a genuine project-local install alone", async () => {
    expect(
      await refineInstallMethod(
        "local-node-modules",
        "/proj/app/node_modules/@yawlabs/mcp/dist/index.js",
        async () => "/custom/prefix",
      ),
    ).toBe("local-node-modules");
  });

  it("skips refinement for unambiguous methods and when npm doesn't answer", async () => {
    let probed = false;
    const probe = async () => {
      probed = true;
      return "/custom/prefix";
    };
    expect(await refineInstallMethod("global-npm", "/x/node_modules/@yawlabs/mcp/dist/index.js", probe)).toBe(
      "global-npm",
    );
    expect(await refineInstallMethod("bundled-app", "/x/node_modules/@yawlabs/mcp/dist/index.js", probe)).toBe(
      "bundled-app",
    );
    expect(probed).toBe(false);
    expect(
      await refineInstallMethod(
        "local-node-modules",
        "/proj/node_modules/@yawlabs/mcp/dist/index.js",
        async () => null,
      ),
    ).toBe("local-node-modules");
  });
});

describe("npmGlobalPrefix", () => {
  it("short-circuits to null under vitest so no unit test spawns a real npm", async () => {
    // The guard is load-bearing for both callers: refineInstallMethod's
    // second-chance classification AND auto-upgrade's multi-prefix warning route
    // through this one helper, and a real `npm prefix -g` in a unit test is a
    // multi-second subprocess whose answer varies per machine. Tests that need a
    // prefix inject their own probe (opts.npmPrefix / deps.npmPrefixImpl).
    expect(process.env.VITEST).toBeTruthy();
    expect(await npmGlobalPrefix()).toBeNull();
  });
});

// The ONE registry probe for the package. `upgrade`, auto-upgrade at serve
// startup and `doctor` all call this; it used to exist three times over, and the
// copies had drifted on exactly the two axes covered here -- the abort budget
// and whether a stand-in could be injected. Both are now parameters, so these
// tests are what keep a caller with a real difference in requirement from
// forking the URL and the failure semantics along with it.
describe("fetchLatestVersion -- the shared registry probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A fetch that never resolves on its own -- it settles only when the
   *  AbortController fires, which is what a real fetch does on abort. Captures
   *  the signal so a test can assert WHEN the abort landed, not just that it
   *  eventually did. */
  function hangingFetch(): { mock: ReturnType<typeof vi.fn>; signal: () => AbortSignal | undefined } {
    let seen: AbortSignal | undefined;
    const mock = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init.signal;
          init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
        }),
    );
    return { mock, signal: () => seen };
  }

  it("uses the override instead of the network, and never touches fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchLatestVersion({ override: async () => "1.2.3" })).toBe("1.2.3");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("absorbs a throwing override to null -- an injected probe cannot fail its caller", async () => {
    // doctor's registryFetch hook lands here. A hook that rejects must degrade
    // the freshness line to "unknown", exactly like an offline registry does,
    // rather than take down the whole diagnostic.
    const thrower = async (): Promise<string | null> => {
      throw new Error("hook blew up");
    };
    await expect(fetchLatestVersion({ override: thrower })).resolves.toBeNull();
  });

  it("aborts at the caller's timeout when one is given, not at the default", async () => {
    vi.useFakeTimers();
    const { mock, signal } = hangingFetch();
    vi.stubGlobal("fetch", mock);

    const pending = fetchLatestVersion({ timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal()?.aborted).toBe(true);
    // An aborted fetch is a failure like any other: null, never a throw.
    await expect(pending).resolves.toBeNull();
  });

  it("falls back to the 3s default budget when the caller names none", async () => {
    // Pins the asymmetry doctor depends on: doctor passes 2000 (see
    // DOCTOR_REGISTRY_TIMEOUT_MS) precisely because the shared default is
    // longer. If these two ever collapse to one number, this test and the
    // 2000ms one above stop disagreeing and the requirement is silently gone.
    expect(REGISTRY_FETCH_TIMEOUT_MS).toBe(3000);
    vi.useFakeTimers();
    const { mock, signal } = hangingFetch();
    vi.stubGlobal("fetch", mock);

    const pending = fetchLatestVersion();
    await vi.advanceTimersByTimeAsync(2999);
    expect(signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal()?.aborted).toBe(true);
    await expect(pending).resolves.toBeNull();
  });

  it("returns null for a non-2xx response and for a body with no string version", async () => {
    const responses = [
      { ok: false, json: async () => ({ version: "9.9.9" }) },
      { ok: true, json: async () => ({}) },
      { ok: true, json: async () => ({ version: 47 }) },
    ];
    for (const res of responses) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => res as unknown as Response),
      );
      expect(await fetchLatestVersion()).toBeNull();
    }
  });

  it("requests @yawlabs/mcp/latest with a JSON accept header and an abort signal", async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ version: "0.47.8" }) }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchLatestVersion()).toBe("0.47.8");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: unknown; signal: unknown }];
    expect(url).toBe("https://registry.npmjs.org/@yawlabs/mcp/latest");
    expect(init.headers).toEqual({ accept: "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("localInstallRoot", () => {
  it("returns the tree root before the first node_modules segment", () => {
    expect(localInstallRoot("/proj/app/node_modules/@yawlabs/mcp/dist/index.js")).toBe("/proj/app");
  });

  it("keeps Windows drive letters and backslashes intact", () => {
    expect(localInstallRoot("C:\\Users\\u\\node_modules\\@yawlabs\\mcp\\dist\\index.js")).toBe("C:\\Users\\u");
  });

  it("uses the FIRST node_modules segment for nested installs", () => {
    expect(localInstallRoot("/proj/node_modules/foo/node_modules/@yawlabs/mcp/dist/index.js")).toBe("/proj");
  });

  it("returns null when no node_modules segment exists", () => {
    expect(localInstallRoot("/home/jeff/yaw/yaw-mcp/dist/index.js")).toBeNull();
    expect(localInstallRoot(undefined)).toBeNull();
  });
});

describe("buildUpgradePlan", () => {
  const method = (m: InstallMethod) => m;

  it("flags stale=true when current < latest", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: method("global-npm") });
    expect(plan.stale).toBe(true);
    expect(plan.command).toBe("npm install -g @yawlabs/mcp@latest");
  });

  it("flags stale=false when current === latest", () => {
    const plan = buildUpgradePlan({ current: "0.45.0", latest: "0.45.0", method: method("global-npm") });
    expect(plan.stale).toBe(false);
  });

  it("flags stale=false when latest is null (offline)", () => {
    const plan = buildUpgradePlan({ current: "0.45.0", latest: null, method: method("global-npm") });
    expect(plan.stale).toBe(false);
  });

  it("returns null command for npx (nothing to run)", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: method("npx") });
    expect(plan.command).toBeNull();
    expect(plan.stale).toBe(true);
  });

  it("uses plain `npm install` for local node_modules", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: method("local-node-modules") });
    expect(plan.command).toBe("npm install @yawlabs/mcp@latest");
  });

  it("uses the owning tool for pnpm/bun global stores", () => {
    expect(buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: method("pnpm-global") }).command).toBe(
      "pnpm add -g @yawlabs/mcp@latest",
    );
    expect(buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: method("bun-global") }).command).toBe(
      "bun add -g @yawlabs/mcp@latest",
    );
  });

  it("returns null command for the Yaw Terminal bundled copy (updates with the app)", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: method("bundled-app") });
    expect(plan.command).toBeNull();
    expect(plan.stale).toBe(true);
  });

  it("suggests git pull for dev checkouts", () => {
    const plan = buildUpgradePlan({ current: "dev", latest: "0.45.0", method: method("dev-checkout") });
    expect(plan.command).toContain("git pull");
    // dev is always non-stale because the version string doesn't parse.
    expect(plan.stale).toBe(false);
  });

  it("falls back to npm -g command for unknown method", () => {
    // Item 2: the default switch arm for unknown must return the npm -g
    // install command so an unrecognized install path still gives the
    // user a sensible copy-paste command.
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: method("unknown") });
    expect(plan.command).toBe("npm install -g @yawlabs/mcp@latest");
    expect(plan.stale).toBe(true);
  });

  it("returns null command for a standalone binary (replace the executable, no package manager)", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: method("binary") });
    expect(plan.command).toBeNull();
    expect(plan.stale).toBe(true);
  });
});

describe("runUpgrade", () => {
  it("prints Current/Latest and flags already-up-to-date", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.45.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toContain("Current: 0.45.0");
    expect(out).toContain("Latest:  0.45.0");
    expect(out).toContain("Install: global-npm");
    expect(out).toContain("latest version");
    expect(out).toContain("OK:");
  });

  it("exits 1 and prints the command when stale and --run not passed (global-npm)", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    expect(io.out.join("\n")).toContain("npm install -g @yawlabs/mcp@latest");
  });

  it("tells npx users to restart the MCP client (exit 0, no command)", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/home/u/.npm/_npx/abc/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toContain("restart the MCP client");
    expect(out).not.toContain("npm install");
  });

  it("with --run, spawns npm install -g and reports success", async () => {
    const io = captureIO();
    const spawned: Array<{ cmd: string; args: string[] }> = [];
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async (cmd, args) => {
        spawned.push({ cmd, args });
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual({ cmd: "npm", args: ["install", "-g", "@yawlabs/mcp@latest"] });
    expect(io.out.join("\n")).toContain("OK: Upgraded @yawlabs/mcp to 0.45.0");
  });

  // --prefix pinning for global-npm: without it, `npm install -g` writes into
  // whatever `npm prefix -g` resolves, which can be a DIFFERENT tree than the
  // running install (multiple Node versions, custom NPM_CONFIG_PREFIX, the
  // bundled Node) -- the child exits 0, we print "OK: Upgraded", and the copy
  // the client spawns stays stale. Same policy as auto-upgrade's
  // maybeAutoUpgrade, whose detectRunningInstallPrefix backs the default walk.
  describe("--prefix pinning for global-npm", () => {
    it("with --run, passes --prefix from the running-install walk and prints the exact spawned line", async () => {
      const io = captureIO();
      const spawned: Array<{ cmd: string; args: string[] }> = [];
      const r = await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => "/custom/node-root",
        spawnImpl: async (cmd, args) => {
          spawned.push({ cmd, args });
          return 0;
        },
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(0);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toEqual({
        cmd: "npm",
        args: ["install", "-g", "--prefix", "/custom/node-root", "@yawlabs/mcp@latest"],
      });
      // The printed line matches what was spawned -- not the bare plan.command.
      expect(io.out.join("\n")).toContain("  npm install -g --prefix /custom/node-root @yawlabs/mcp@latest");
    });

    it("without --run, the 'run it yourself' suggestion carries the same --prefix the spawn would", async () => {
      const io = captureIO();
      const r = await runUpgrade({
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => "/custom/node-root",
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(1);
      expect(io.out.join("\n")).toContain("npm install -g --prefix /custom/node-root @yawlabs/mcp@latest");
    });

    it("falls back to bare `npm install -g` when the walk finds no prefix", async () => {
      const io = captureIO();
      const spawned: Array<{ cmd: string; args: string[] }> = [];
      await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => null,
        spawnImpl: async (cmd, args) => {
          spawned.push({ cmd, args });
          return 0;
        },
        out: io.push,
        err: io.pushErr,
      });
      expect(spawned[0]).toEqual({ cmd: "npm", args: ["install", "-g", "@yawlabs/mcp@latest"] });
    });

    it("routes the detected prefix through quoteShellArgIfNeeded (spaces survive win32's shell:true spawn)", async () => {
      // quoteShellArgIfNeeded quotes only on win32 (POSIX execve needs no
      // quoting), so compute the expectation with the same helper the SUT
      // uses rather than hardcoding a platform's answer.
      const spaced = "/custom/node root";
      const expected = quoteShellArgIfNeeded(spaced);
      expect(expected).not.toBeNull();
      const spawned: Array<{ cmd: string; args: string[] }> = [];
      const io = captureIO();
      await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => spaced,
        spawnImpl: async (cmd, args) => {
          spawned.push({ cmd, args });
          return 0;
        },
        out: io.push,
        err: io.pushErr,
      });
      expect(spawned[0]?.args).toEqual(["install", "-g", "--prefix", expected, "@yawlabs/mcp@latest"]);
    });

    it("never consults the walk for non-global-npm methods", async () => {
      const io = captureIO();
      const runningPrefix = vi.fn(async () => "/should/not/be/used");
      const spawned: Array<{ cmd: string; args: string[] }> = [];
      await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix,
        spawnImpl: async (cmd, args) => {
          spawned.push({ cmd, args });
          return 0;
        },
        out: io.push,
        err: io.pushErr,
      });
      expect(runningPrefix).not.toHaveBeenCalled();
      expect(spawned[0]).toEqual({ cmd: "pnpm", args: ["add", "-g", "@yawlabs/mcp@latest"] });
    });

    it("offline suggestion carries the same --prefix the spawn would (walk is filesystem-only)", async () => {
      // The walk realpaths argv[1] and never touches the network, so the
      // "when you're back online" suggestion must pin the prefix too -- a
      // bare `-g` there re-opens the wrong-tree hazard for the one user who
      // will paste it verbatim later.
      const io = captureIO();
      const r = await runUpgrade({
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => null,
        runningPrefix: async () => "/custom/node-root",
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(0);
      const out = io.out.join("\n");
      expect(out).toMatch(/couldn't reach/i);
      expect(out).toContain("npm install -g --prefix /custom/node-root @yawlabs/mcp@latest");
      expect(out).not.toContain("npm install -g @yawlabs/mcp@latest");
    });

    it("--json plan.command carries the same --prefix the spawn would", async () => {
      const io = captureIO();
      const r = await runUpgrade({
        json: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => "/custom/node-root",
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(1);
      const parsed = JSON.parse(io.out.join("\n"));
      expect(parsed.command).toBe("npm install -g --prefix /custom/node-root @yawlabs/mcp@latest");
      expect(parsed).toMatchObject({ stale: true, method: "global-npm" });
    });

    it("--json + offline still pins --prefix in the command", async () => {
      const io = captureIO();
      const r = await runUpgrade({
        json: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => null,
        runningPrefix: async () => "/custom/node-root",
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(io.out.join("\n"));
      expect(parsed.latest).toBeNull();
      expect(parsed.command).toBe("npm install -g --prefix /custom/node-root @yawlabs/mcp@latest");
    });

    it("display-quotes a whitespace prefix in printed lines; the spawn argv keeps the platform form", async () => {
      // Display and spawn quoting are computed independently: the spawn
      // argv gets quoteShellArgIfNeeded (raw on POSIX, double-quoted on
      // win32), the printed line gets quoteArgForDisplay (single-quoted on
      // POSIX so the paste doesn't split, same double quotes on win32).
      // Compute both expectations with the SUT's own helpers rather than
      // hardcoding one platform's answer.
      const spaced = "/custom/node root";
      const expectedSpawn = quoteShellArgIfNeeded(spaced);
      const expectedDisplay = quoteArgForDisplay(spaced);
      expect(expectedSpawn).not.toBeNull();
      expect(expectedDisplay).not.toBeNull();
      const spawned: Array<{ cmd: string; args: string[] }> = [];
      const io = captureIO();
      const r = await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => spaced,
        spawnImpl: async (cmd, args) => {
          spawned.push({ cmd, args });
          return 0;
        },
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(0);
      expect(spawned[0]?.args).toEqual(["install", "-g", "--prefix", expectedSpawn, "@yawlabs/mcp@latest"]);
      expect(io.out.join("\n")).toContain(`  npm install -g --prefix ${expectedDisplay} @yawlabs/mcp@latest`);
    });

    it("exit-1 and exit-3 manual-run suggestions both use the display-quoted prefix", async () => {
      const spaced = "/custom/node root";
      const expectedDisplay = quoteArgForDisplay(spaced);
      const suggestion = `  npm install -g --prefix ${expectedDisplay} @yawlabs/mcp@latest`;

      // exit 1: stale without --run.
      const io1 = captureIO();
      const r1 = await runUpgrade({
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => spaced,
        out: io1.push,
        err: io1.pushErr,
      });
      expect(r1.exitCode).toBe(1);
      expect(io1.out.join("\n")).toContain(suggestion);

      // exit 3: --run whose child failed; the retry hint goes to stderr.
      const io3 = captureIO();
      const r3 = await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => spaced,
        spawnImpl: async () => 42,
        out: io3.push,
        err: io3.pushErr,
      });
      expect(r3.exitCode).toBe(3);
      expect(io3.err.join("\n")).toContain(suggestion);
    });
  });

  it("with --run, propagates the child exit code as 3 on failure", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async () => 42,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(3);
    expect(io.err.join("\n")).toContain("npm exited 42");
  });

  it("with --run on a local-node-modules install, spawns npm install in the tree root", async () => {
    const io = captureIO();
    const spawned: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/proj/app/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async (cmd, args, cwd) => {
        spawned.push({ cmd, args, cwd });
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual({ cmd: "npm", args: ["install", "@yawlabs/mcp@latest"], cwd: "/proj/app" });
    expect(io.out.join("\n")).toContain("OK: Upgraded @yawlabs/mcp to 0.45.0");
  });

  it("with --run on a pnpm global store, spawns pnpm (never npm-installs into the store)", async () => {
    const io = captureIO();
    const spawned: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async (cmd, args, cwd) => {
        spawned.push({ cmd, args, cwd });
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual({ cmd: "pnpm", args: ["add", "-g", "@yawlabs/mcp@latest"], cwd: undefined });
  });

  it("with --run on a dev checkout, refuses with exit 2 and prints the command", async () => {
    const io = captureIO();
    let didSpawn = false;
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/home/jeff/yaw/yaw-mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async () => {
        didSpawn = true;
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(2);
    expect(didSpawn).toBe(false);
    const err = io.err.join("\n");
    expect(err).toContain("can't be upgraded automatically");
    expect(err).toContain("git pull && npm run build");
  });

  it("without --run on a local-node-modules install, prints 'in <root>:' above the command", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/proj/app/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    const out = io.out.join("\n");
    expect(out).toContain("in /proj/app:");
    // Command must be on its own line with no trailing punctuation.
    const cmdLine = io.out.find((l) => l.includes("npm install @yawlabs/mcp@latest"));
    expect(cmdLine).toBeDefined();
    expect(cmdLine!.trimEnd()).toMatch(/@latest$/);
    // The 'in <root>:' line must appear before the command line.
    const rootIdx = io.out.findIndex((l) => l.includes("in /proj/app:"));
    const cmdIdx = io.out.findIndex((l) => l.includes("npm install @yawlabs/mcp@latest"));
    expect(rootIdx).toBeLessThan(cmdIdx);
  });

  it("without --run on a dev checkout, prints the command and notes --run won't work", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/home/jeff/yaw/yaw-mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    const out = io.out.join("\n");
    expect(out).toContain("Run it yourself");
    expect(out).toContain("git pull && npm run build");
  });

  it("tells Yaw Terminal bundled-copy users the app updates it (exit 0, no spawn)", async () => {
    const io = captureIO();
    let didSpawn = false;
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/Applications/Yaw.app/Contents/Resources/app.asar.unpacked/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async () => {
        didSpawn = true;
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(didSpawn).toBe(false);
    const out = io.out.join("\n");
    expect(out).toContain("Update Yaw Terminal");
    expect(out).not.toContain("npm install");
  });

  it("command lines carry no trailing punctuation (copy-friendly)", async () => {
    const io = captureIO();
    await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    const cmdLines = io.out.filter((l) => l.includes("npm install"));
    expect(cmdLines.length).toBeGreaterThan(0);
    for (const line of cmdLines) {
      expect(line.trimEnd()).toMatch(/@latest$/);
    }
  });

  it("--json emits the plan and exits 1 when stale without --run", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      json: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed).toMatchObject({
      current: "0.40.0",
      latest: "0.45.0",
      stale: true,
      method: "global-npm",
      command: "npm install -g @yawlabs/mcp@latest",
    });
    // Never contains the human-readable summary lines.
    expect(io.out.join("\n")).not.toContain("Current: 0.40.0");
  });

  it("handles a null latest (offline) gracefully", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => null,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toMatch(/couldn't reach/i);
    // Still prints the suggested command so the user can copy it.
    expect(out).toContain("npm install -g @yawlabs/mcp@latest");
  });

  it("--json + offline emits plan with latest: null", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      json: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => null,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.latest).toBeNull();
    expect(parsed.stale).toBe(false);
  });

  it("--json --run emits JSON and never calls spawnImpl (report-only snapshot)", async () => {
    // Pins that --json is a report-only snapshot: combining it with --run
    // must NOT spawn the upgrade.
    const io = captureIO();
    let didSpawn = false;
    const r = await runUpgrade({
      json: true,
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async () => {
        didSpawn = true;
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(didSpawn).toBe(false);
    // JSON branch emits the plan and exits per upgrade-cmd.ts's
    // `plan.stale && !opts.run ? 1 : 0`: with opts.run set (but ignored
    // for spawning), the exit code is 0.
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.stale).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("offline (fetchLatest null) with bundled-app argvPath: prints the app-update hint, never spawns, exit 0", async () => {
    // Item 3: offline + bundled-app must print the app-update hint, never
    // an npm command, and always exit 0.
    const io = captureIO();
    let didSpawn = false;
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/Applications/Yaw.app/Contents/Resources/app.asar.unpacked/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => null,
      spawnImpl: async () => {
        didSpawn = true;
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(didSpawn).toBe(false);
    const out = io.out.join("\n");
    expect(out).toContain("Yaw Terminal");
    expect(out).not.toContain("npm install");
    expect(out).not.toContain("npm run");
  });

  it("with --run on a bun-global argvPath, spawns ['bun', ['add', '-g', '@yawlabs/mcp@latest']]", async () => {
    // Item 4: mirror the pnpm-global --run test for bun-global.
    const io = captureIO();
    const spawned: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/home/u/.bun/install/global/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async (cmd, args, cwd) => {
        spawned.push({ cmd, args, cwd });
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual({ cmd: "bun", args: ["add", "-g", "@yawlabs/mcp@latest"], cwd: undefined });
    expect(io.out.join("\n")).toContain("OK: Upgraded @yawlabs/mcp to 0.45.0");
  });

  it("tells a standalone-binary user to download the latest build (exit 1, no npm)", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      isSea: () => true,
      currentVersion: "0.40.0",
      argvPath: "/opt/yaw-mcp/yaw-mcp",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    const out = io.out.join("\n");
    expect(out).toContain("Install: binary");
    expect(out).toContain("standalone binary");
    expect(out).toContain("github.com/YawLabs/mcp/releases");
    expect(out).not.toContain("npm install");
  });

  it("with --run on a binary, refuses with exit 2 (no package manager to run)", async () => {
    const io = captureIO();
    let didSpawn = false;
    const r = await runUpgrade({
      run: true,
      isSea: () => true,
      currentVersion: "0.40.0",
      argvPath: "/opt/yaw-mcp/yaw-mcp",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async () => {
        didSpawn = true;
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(2);
    expect(didSpawn).toBe(false);
    expect(io.out.join("\n")).not.toContain("npm install");
  });

  it("--json reports method: binary with a null command", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      json: true,
      isSea: () => true,
      currentVersion: "0.40.0",
      argvPath: "/opt/yaw-mcp/yaw-mcp",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed).toMatchObject({ method: "binary", command: null, stale: true });
  });

  it("warns that oam is below the floor even when yaw-mcp itself has nothing to do", async () => {
    // MIN_OAM_VERSION tracks the LATEST oam release, so upgrading yaw-mcp can
    // raise the floor past the user's oam and silently drop every sidecar from
    // oam to node. `upgrade` is the command a user runs to "get current", and it
    // used to print "nothing to do" with no mention of that -- the only other
    // notices are a warn line on the broker's stderr (which MCP clients hide)
    // and `doctor`.
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.45.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      oamProbe: oamProbe(true, "0.8.2"),
      out: io.push,
      err: io.pushErr,
    });
    // Advisory only: the exit-code contract for "already current" is unchanged.
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toContain("nothing to do");
    expect(out).toContain("v0.8.2");
    expect(out).toContain("oam self-update");
    expect(out).toContain("run on node instead of oam");
  });

  it("says nothing about oam when it is absent or already at/above the floor", async () => {
    const io = captureIO();
    await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      oamProbe: oamProbe(false, "0.8.3"),
      out: io.push,
      err: io.pushErr,
    });
    expect(io.out.join("\n")).not.toContain("oam");
  });

  it("keeps the oam note out of --json (the snapshot stays machine-parseable)", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      json: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      oamProbe: oamProbe(true, "0.8.2"),
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    // Would throw if an advisory line leaked into the snapshot.
    expect(JSON.parse(io.out.join("\n"))).toMatchObject({ method: "global-npm", stale: true });
  });

  it("never fails the upgrade when the oam probe throws", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.45.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      oamProbe: async () => {
        throw new Error("oam probe exploded");
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(io.out.join("\n")).toContain("nothing to do");
  });

  it("offline + binary points at the release page, not the npx restart message", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      isSea: () => true,
      currentVersion: "0.40.0",
      argvPath: "/opt/yaw-mcp/yaw-mcp",
      fetchLatest: async () => null,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toContain("standalone binary");
    expect(out).toContain("releases/latest");
    expect(out).not.toContain("npx");
  });
});
