import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPLIANCE_USAGE,
  formatLaunchFailure,
  isRenderableReport,
  projectForPublish,
  resolveNpxLaunch,
  runComplianceCommand,
} from "../compliance-cmd.js";

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

// Only the pre-spawn arg paths are exercised here (--help and missing
// <target>). Both return before spawning the mcp-compliance child, so these
// tests never touch the network or npx.
describe("runComplianceCommand arg handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--help prints usage to stdout and exits 0 (does not spawn the sub-tool)", async () => {
    const cap = captureIo();
    const code = await runComplianceCommand(["--help"], cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toBe(COMPLIANCE_USAGE);
    expect(cap.err()).toBe("");
  });

  it("-h behaves like --help", async () => {
    const cap = captureIo();
    const code = await runComplianceCommand(["-h"], cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toBe(COMPLIANCE_USAGE);
  });

  it("missing <target> prints usage to stderr and exits 2 (arg-error convention)", async () => {
    const cap = captureIo();
    const code = await runComplianceCommand([], cap.io);
    expect(code).toBe(2);
    expect(cap.err()).toBe(COMPLIANCE_USAGE);
    expect(cap.out()).toBe("");
  });

  it("--publish alone (no target) still exits 2, not 1", async () => {
    const cap = captureIo();
    const code = await runComplianceCommand(["--publish"], cap.io);
    expect(code).toBe(2);
  });

  it("defaults to the real process streams when no io is injected", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = await runComplianceCommand(["--help"]);
    expect(code).toBe(0);
    expect(out).toHaveBeenCalledWith(COMPLIANCE_USAGE);
  });
});

// The spawn strategy. `spawn("npx.cmd", ...)` throws EINVAL synchronously on
// every patched Node on Windows (CVE-2024-27980 hardening), so the launcher
// resolves npm's npx-cli.js and runs it with the current node binary instead.
describe("resolveNpxLaunch", () => {
  it("prefers node + npx-cli.js beside node.exe (Windows layout)", () => {
    const launch = resolveNpxLaunch(["-y", "pkg"], {
      execPath: "C:\\nodejs\\node.exe",
      platform: "win32",
      // Separator-agnostic: the SUT builds candidates with path.join, which
      // emits "/" on a POSIX test runner and "\\" on Windows.
      exists: (p) => p.replace(/\\/g, "/").endsWith("nodejs/node_modules/npm/bin/npx-cli.js"),
    });
    expect(launch).not.toBeNull();
    expect(launch?.shell).toBe(false);
    expect(launch?.command).toBe("C:\\nodejs\\node.exe");
    expect(launch?.args[0]).toContain("npx-cli.js");
    expect(launch?.args.slice(1)).toEqual(["-y", "pkg"]);
    // The .cmd shim is never spawned -- that is the EINVAL path.
    expect(launch?.command).not.toContain("npx.cmd");
  });

  it("finds the POSIX <prefix>/lib/node_modules layout", () => {
    const launch = resolveNpxLaunch(["-y", "pkg"], {
      execPath: "/usr/local/bin/node",
      platform: "linux",
      exists: (p) => p.includes("lib") && p.endsWith("npx-cli.js"),
    });
    expect(launch?.shell).toBe(false);
    expect(launch?.command).toBe("/usr/local/bin/node");
    expect(launch?.args[0]).toContain("npx-cli.js");
  });

  it("falls back to a shell with every argument quoted when npx-cli.js is missing", () => {
    const launch = resolveNpxLaunch(["-y", "pkg", "npx -y server /tmp"], {
      execPath: "/usr/local/bin/node",
      platform: "linux",
      exists: () => false,
    });
    expect(launch?.shell).toBe(true);
    expect(launch?.command).toBe("npx");
    expect(launch?.args).toEqual(["'-y'", "'pkg'", "'npx -y server /tmp'"]);
  });

  it("refuses the shell fallback for arguments that cannot be quoted safely", () => {
    expect(
      resolveNpxLaunch(["-y", "pkg", "it's; rm -rf /"], {
        execPath: "/usr/local/bin/node",
        platform: "linux",
        exists: () => false,
      }),
    ).toBeNull();
    expect(
      resolveNpxLaunch(["-y", 'a"b'], { execPath: "C:\\nodejs\\node.exe", platform: "win32", exists: () => false }),
    ).toBeNull();
    expect(
      resolveNpxLaunch(["-y", "%PATH%"], { execPath: "C:\\nodejs\\node.exe", platform: "win32", exists: () => false }),
    ).toBeNull();
    expect(
      resolveNpxLaunch(["-y", "a\nb"], { execPath: "/usr/local/bin/node", platform: "linux", exists: () => false }),
    ).toBeNull();
  });

  // Live smoke on THIS machine's node: the resolved launch must actually
  // start (no EINVAL). `npx --version` is offline and prints the npm version.
  it("the resolved launch actually spawns on this host", async () => {
    const launch = resolveNpxLaunch(["--version"]);
    expect(launch).not.toBeNull();
    if (!launch || launch.shell) return; // no npx-cli.js here; nothing to smoke
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, { stdio: ["ignore", "ignore", "ignore"] });
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(code).toBe(0);
  }, 60_000);
});

// The diagnostic printed when BOTH strategies are out (no npx-cli.js on disk
// AND an argument we refuse to shell-quote). quoteForShell rejects a different
// character set per platform -- `%` only on win32, `'` only on POSIX -- so a
// message that always says "quotes / newlines" names nothing actually at fault
// for a percent-encoded target.
describe("formatLaunchFailure", () => {
  it("names the win32 character class and echoes the offending % argument", () => {
    const msg = formatLaunchFailure(["-y", "pkg", "https://example.com/%7Bid%7D"], "win32");
    // Installing npm stays the leading remedy -- it removes the shell path.
    expect(msg).toContain("Install npm");
    expect(msg).toContain("percent signs");
    expect(msg).toContain('"https://example.com/%7Bid%7D"');
    // `%` is inert on POSIX; don't send a Windows operator after single quotes.
    expect(msg).not.toContain("single quotes");
  });

  it("names the POSIX character class and echoes the offending ' argument", () => {
    const msg = formatLaunchFailure(["-y", "npx -y it's-a-server"], "linux");
    expect(msg).toContain("Install npm");
    expect(msg).toContain("single quotes");
    expect(msg).toContain("it's-a-server");
    // cmd.exe's %VAR% expansion is a win32-only concern.
    expect(msg).not.toContain("percent signs");
  });

  it("escapes a control character in the echoed argument instead of breaking the line", () => {
    const msg = formatLaunchFailure(["-y", "a\nb"], "linux");
    expect(msg).toContain('"a\\nb"');
    // 4 lines of prose + trailing newline; the echoed \n must not add one.
    expect(msg.split("\n")).toHaveLength(5);
  });

  it("still explains itself if no single argument is to blame", () => {
    const msg = formatLaunchFailure(["-y", "pkg"], "linux");
    expect(msg).toContain("Install npm");
    expect(msg).toContain("cannot be safely quoted");
  });
});

// Wiring: the unlaunchable path inside runComplianceCommand must print THAT
// message, not a hardcoded one. node:fs is mocked so no npx-cli.js resolves,
// and the platform is pinned so the assertion holds on any CI runner. The
// command returns before spawning anything.
describe("runComplianceCommand unlaunchable path", () => {
  it("surfaces the platform-accurate message and exits 1 without spawning", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, default: actual, existsSync: () => false };
    });
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const target = "https://example.com/%7Bid%7D";
      const code = await mod.runComplianceCommand([target], cap.io);
      expect(code).toBe(1);
      expect(cap.out()).toBe("");
      // Content first: the old text named only "quotes / newlines", neither of
      // which appears in this target -- `%` is what quoteForShell rejected.
      expect(cap.err()).toContain("percent signs");
      expect(cap.err()).toContain(target);
      expect(cap.err()).toBe(
        mod.formatLaunchFailure(["-y", "@yawlabs/mcp-compliance", "test", "--format", "json", target], "win32"),
      );
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

// printSummary does score.toFixed(1); a report that reaches it without a
// numeric score would crash the CLI with a raw TypeError, so the score check
// lives in the parse gate and routes to the "unexpected JSON" path instead.
describe("isRenderableReport", () => {
  const base = { grade: "A", score: 91.5, summary: { total: 1, passed: 1, failed: 0, required: 1, requiredPassed: 1 } };

  it("accepts a report with grade, summary and a finite numeric score", () => {
    expect(isRenderableReport(base)).toBe(true);
    expect(isRenderableReport({ ...base, score: 0 })).toBe(true);
  });

  it("rejects a missing, non-numeric or non-finite score", () => {
    expect(isRenderableReport({ grade: "A", summary: base.summary })).toBe(false);
    expect(isRenderableReport({ ...base, score: "91.5" })).toBe(false);
    expect(isRenderableReport({ ...base, score: null })).toBe(false);
    expect(isRenderableReport({ ...base, score: Number.NaN })).toBe(false);
  });

  it("still rejects a missing grade or summary", () => {
    expect(isRenderableReport({ score: 1, summary: base.summary })).toBe(false);
    expect(isRenderableReport({ grade: "A", score: 1 })).toBe(false);
    expect(isRenderableReport(null)).toBe(false);
    expect(isRenderableReport("nope")).toBe(false);
  });
});

describe("projectForPublish allowlist", () => {
  it("strips extra top-level fields and per-test fields not on the allowlist", () => {
    const raw = {
      grade: "A",
      score: 91.5,
      url: "https://example.com/mcp",
      summary: { total: 10, passed: 9, failed: 1, required: 5, requiredPassed: 5 },
      tests: [
        {
          name: "tools/list",
          status: "pass",
          required: true,
          message: "ok",
          // Fields the suite might echo back -- must NOT survive projection.
          env: { SECRET_TOKEN: "leak-me" },
          argv: ["--secret", "value"],
          stack: "Error: at /home/user/secret/path",
        },
      ],
      // Extra top-level junk that must be dropped.
      rawEnv: { AWS_SECRET_ACCESS_KEY: "leak" },
      argv: ["npx", "-y", "thing"],
    } as unknown as Parameters<typeof projectForPublish>[0];

    const out = projectForPublish(raw);

    expect(Object.keys(out).sort()).toEqual(["grade", "score", "summary", "tests", "url"]);
    expect(out.tests).toHaveLength(1);
    expect(Object.keys(out.tests[0]).sort()).toEqual(["message", "name", "required", "status"]);

    // No leaked values anywhere in the serialized body.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("leak");
    expect(serialized).not.toContain("SECRET_TOKEN");
    expect(serialized).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(serialized).not.toContain("stack");
  });

  it("tolerates a non-array tests field and malformed test entries", () => {
    const raw = {
      grade: "F",
      score: 0,
      url: "https://example.com/mcp",
      summary: { total: 0, passed: 0, failed: 0, required: 0, requiredPassed: 0 },
      tests: "not-an-array",
    } as unknown as Parameters<typeof projectForPublish>[0];

    const out = projectForPublish(raw);
    expect(out.tests).toEqual([]);
  });
});
