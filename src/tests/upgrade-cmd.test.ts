import { describe, expect, it } from "vitest";
import {
  type InstallMethod,
  buildUpgradePlan,
  detectInstallMethod,
  detectSea,
  localInstallRoot,
  parseUpgradeArgs,
  refineInstallMethod,
  runUpgrade,
} from "../upgrade-cmd.js";

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
      // biome-ignore lint/performance/noDelete: unsetting an env var needs delete, not "= undefined" (which would leave "undefined" as the string value)
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
    expect(io.out.join("\n")).toContain("Upgraded @yawlabs/mcp to 0.45.0");
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
    expect(io.out.join("\n")).toContain("Upgraded @yawlabs/mcp to 0.45.0");
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
