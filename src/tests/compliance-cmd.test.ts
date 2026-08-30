import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveComplianceSuiteVersion } from "../audit-cmd.js";
import {
  COMPLIANCE_USAGE,
  createInterruptHandler,
  formatLaunchFailure,
  INTERRUPT_EXIT_CODE,
  isRenderableReport,
  PUBLISH_REMOVED_MESSAGE,
  resolveComplianceSuiteSpec,
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

  // --publish was removed with the hosted backend (it POSTed to
  // /api/compliance/ext, which 404s).
  it("no longer advertises --publish", () => {
    expect(COMPLIANCE_USAGE).not.toContain("--publish");
  });

  it("--publish is rejected with an explanation and exit 2 (never reaches the child)", async () => {
    // Behavior, not docs. Unhandled, --publish falls through to runTest as a
    // stray extra arg and the user gets an opaque child-process error instead
    // of "that flag is gone". Exit 2 is load-bearing: the child path returns
    // the mcp-compliance exit code, which is only ever 0 or 1, so a 2 here
    // proves we short-circuited before spawn.
    const cap = captureIo();
    const code = await runComplianceCommand(["--publish"], cap.io);
    expect(code).toBe(2);
    expect(cap.err()).toBe(PUBLISH_REMOVED_MESSAGE);
    expect(cap.err()).toContain("no longer publishes compliance reports");
    expect(cap.out()).toBe("");
  });

  it("--publish is rejected even alongside a valid target", async () => {
    const cap = captureIo();
    const code = await runComplianceCommand(["https://example.com/mcp", "--publish"], cap.io);
    expect(code).toBe(2);
    expect(cap.err()).toBe(PUBLISH_REMOVED_MESSAGE);
  });

  it("--publish=<value> is rejected too, not just the bare flag", async () => {
    // A removed flag is the one a user is most likely to type with its old
    // ARGUMENT still attached (the retired backend took `--publish=public`).
    // An exact-match `argv.includes("--publish")` let that spelling through to
    // the child as an unrecognized extra arg -- exactly the opaque failure this
    // branch exists to replace, and only for the spelling people actually used.
    for (const spelling of ["--publish=public", "--publish=private", "--publish="]) {
      const cap = captureIo();
      const code = await runComplianceCommand(["https://example.com/mcp", spelling], cap.io);
      expect(code).toBe(2);
      expect(cap.err()).toBe(PUBLISH_REMOVED_MESSAGE);
      expect(cap.out()).toBe("");
    }
  });

  it("does not mistake a different flag that merely starts with --publish", async () => {
    // The prefix match is anchored on `--publish=`, not on "--publish": a
    // bare startsWith would swallow a hypothetical `--publisher` and refuse a
    // flag that was never removed. Spawn is mocked so the forwarding path can
    // be exercised without launching npx.
    const report = {
      grade: "A",
      score: 100,
      url: "https://example.com/mcp",
      summary: { total: 1, passed: 1, failed: 0, required: 1, requiredPassed: 1 },
      tests: [],
    };
    const calls: string[][] = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const spawn = (_command: string, args: string[]) => {
        calls.push(args);
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          pid: number;
          kill: () => boolean;
        };
        child.stdout = new EventEmitter();
        child.pid = 4242;
        child.kill = () => true;
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from(JSON.stringify(report)));
          child.emit("close", 0);
        });
        return child;
      };
      return { spawn, default: { spawn } };
    });
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const code = await mod.runComplianceCommand(["https://example.com/mcp", "--publisher"], cap.io);
      expect(code).toBe(0);
      expect(cap.err()).not.toContain("--publish was removed");
      // Forwarded to the child like any other extra arg.
      expect((calls[0] ?? []).join(" ")).toContain("--publisher");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
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

  // Built from a char code rather than typed as an escape so no editing layer
  // between here and disk can quietly halve the run -- the whole point of
  // these cases is the exact number of trailing backslashes.
  const BS = String.fromCharCode(92);

  it("refuses a win32 argument ending in a backslash (it would escape the closing quote)", () => {
    // quoteForShell wraps a win32 arg as `"<arg>"`. CommandLineToArgvW -- which
    // node uses to split the command line back into argv on the receiving side
    // -- reads a `\"` as a LITERAL quote, so a trailing backslash never closes
    // the quoted run and the NEXT argument is merged into this one. Before the
    // refusal this produced a launch whose argv was silently one element short.
    const target = `C:${BS}Program Files${BS}srv${BS}`;
    expect(
      resolveNpxLaunch(["-y", "pkg", target], {
        execPath: "C:\\nodejs\\node.exe",
        platform: "win32",
        exists: () => false,
      }),
    ).toBeNull();
    // A doubled trailing run is the same hazard: cmd hands the text through and
    // the receiving parser still sees the final `\` against the closing quote.
    expect(
      resolveNpxLaunch(["-y", `dir${BS}${BS}`], {
        execPath: "C:\\nodejs\\node.exe",
        platform: "win32",
        exists: () => false,
      }),
    ).toBeNull();
  });

  it("still accepts a win32 argument whose backslashes are interior", () => {
    // Only the TRAILING position is dangerous -- refusing every Windows path
    // would make the fallback useless on the platform it exists for.
    const launch = resolveNpxLaunch(["-y", `C:${BS}srv${BS}main.js`], {
      execPath: "C:\\nodejs\\node.exe",
      platform: "win32",
      exists: () => false,
    });
    expect(launch?.shell).toBe(true);
    expect(launch?.args).toEqual(['"-y"', `"C:${BS}srv${BS}main.js"`]);
  });

  it("leaves a trailing backslash alone on POSIX, where single quotes are literal", () => {
    // The refusal is a win32-quoting concern; `'a\'` is a perfectly good POSIX
    // single-quoted token and must not be collateral damage.
    const launch = resolveNpxLaunch(["-y", `dir${BS}`], {
      execPath: "/usr/local/bin/node",
      platform: "linux",
      exists: () => false,
    });
    expect(launch?.shell).toBe(true);
    expect(launch?.args).toEqual(["'-y'", `'dir${BS}'`]);
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

  it("names the trailing backslash and echoes the offending win32 path", () => {
    // The character class quoteForShell refuses has to stay in lockstep with
    // the sentence naming it: a path rejected for its trailing separator used
    // to be explained by a list that mentioned only quotes, percent signs,
    // newlines and NUL bytes -- none of which appear in it.
    const target = `C:${String.fromCharCode(92)}srv${String.fromCharCode(92)}`;
    const msg = formatLaunchFailure(["-y", "pkg", target], "win32");
    expect(msg).toContain("trailing backslash");
    expect(msg).toContain(JSON.stringify(target));
    // Still a win32-only concern; a POSIX operator must not see it.
    expect(formatLaunchFailure(["-y", "it's"], "linux")).not.toContain("trailing backslash");
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
  // `url` is part of the fixture because the gate now checks it: printSummary
  // renders `Target: ${url}`, and the child is spawned unpinned (`npx -y
  // @yawlabs/mcp-compliance`), so a renamed field must route to the
  // "unexpected JSON" path rather than printing "Target: undefined".
  const base = {
    grade: "A",
    score: 91.5,
    url: "stdio:npx -y server",
    summary: { total: 1, passed: 1, failed: 0, required: 1, requiredPassed: 1 },
  };

  it("accepts a report with grade, summary and a finite numeric score", () => {
    expect(isRenderableReport(base)).toBe(true);
    expect(isRenderableReport({ ...base, score: 0 })).toBe(true);
  });

  // A truthy-but-empty summary used to pass the gate, and printSummary then
  // rendered "undefined/undefined passed, undefined/undefined required" with
  // exit 0 -- garbage presented as a clean result.
  it("rejects a summary missing the counters printSummary formats", () => {
    expect(isRenderableReport({ ...base, summary: {} })).toBe(false);
    expect(isRenderableReport({ ...base, summary: { total: 1, passed: 1 } })).toBe(false);
    expect(isRenderableReport({ ...base, summary: { ...base.summary, requiredPassed: "1" } })).toBe(false);
    expect(isRenderableReport({ ...base, summary: { ...base.summary, total: Number.NaN } })).toBe(false);
  });

  it("rejects a missing or non-string url", () => {
    expect(isRenderableReport({ grade: "A", score: 1, summary: base.summary })).toBe(false);
    expect(isRenderableReport({ ...base, url: 42 })).toBe(false);
  });

  // summary.failed is not rendered, so the gate must not demand it -- this
  // guard protects what is printed, it does not re-declare the child schema.
  it("does not require fields printSummary never renders", () => {
    const { failed: _failed, ...rest } = base.summary;
    expect(isRenderableReport({ ...base, summary: rest })).toBe(true);
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

  it("rejects a non-string grade instead of printing it as a letter", () => {
    // `grade` was checked for truthiness only, so a suite that switched the
    // field to a numeric score passed the gate and printSummary interpolated
    // it: "Compliance: 5 (91.5%)" reads as a letter grade of 5. Every other
    // rendered field is type-checked; this one was the hole.
    expect(isRenderableReport({ ...base, grade: 5 })).toBe(false);
    expect(isRenderableReport({ ...base, grade: true })).toBe(false);
    expect(isRenderableReport({ ...base, grade: ["A"] })).toBe(false);
    expect(isRenderableReport({ ...base, grade: { letter: "A" } })).toBe(false);
    // An empty string renders as "Compliance:  (91.5%)" -- also not a grade.
    expect(isRenderableReport({ ...base, grade: "" })).toBe(false);
    // The real shape still passes.
    expect(isRenderableReport({ ...base, grade: "F" })).toBe(true);
  });
});

// `compliance` and `audit` are two front doors onto the same suite. `audit`
// runs the PINNED dependency and records its version as `suiteVersion` in
// grades.json; `compliance` shelled out to `npx -y @yawlabs/mcp-compliance`
// with no pin, so it graded under whatever npm called latest. Once latest moved
// ahead of the dependency the two could hand the same server different letters
// with nothing in either output naming the rubric.
describe("compliance suite version pin", () => {
  it("pins the spec to the dependency version audit records", async () => {
    const version = await resolveComplianceSuiteVersion();
    const spec = await resolveComplianceSuiteSpec();
    // This repo has the dependency installed, so the pin must resolve here.
    expect(version).toBeTypeOf("string");
    expect(spec).toBe(`@yawlabs/mcp-compliance@${version}`);
    // The unpinned spelling is precisely what regressed.
    expect(spec).not.toBe("@yawlabs/mcp-compliance");
  });

  it("hands the pinned spec to npx rather than the bare package name", async () => {
    const version = await resolveComplianceSuiteVersion();
    expect(version).toBeTypeOf("string");
    const report = {
      grade: "A",
      score: 100,
      url: "https://example.com/mcp",
      summary: { total: 1, passed: 1, failed: 0, required: 1, requiredPassed: 1 },
      tests: [],
    };
    const calls: string[][] = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const spawn = (_command: string, args: string[]) => {
        calls.push(args);
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          pid: number;
          kill: () => boolean;
        };
        child.stdout = new EventEmitter();
        child.pid = 4242;
        child.kill = () => true;
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from(JSON.stringify(report)));
          child.emit("close", 0);
        });
        return child;
      };
      return { spawn, default: { spawn } };
    });
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const code = await mod.runComplianceCommand(["https://example.com/mcp"], cap.io);
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      // resolveNpxLaunch may prepend node + npx-cli.js (or shell-quote each
      // element), so assert on the presence of the spec token rather than a
      // fixed index.
      const flat = (calls[0] ?? []).join(" ");
      expect(flat).toContain(`@yawlabs/mcp-compliance@${version}`);
      // The bare name must not appear as a standalone spec token any more.
      expect(flat).not.toMatch(/@yawlabs\/mcp-compliance(?!@)/);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});

// Registering a `process.once` SIGINT listener suppresses node's default "die
// on the signal" behaviour, so the handler owns the promise that the run ends.
// killTree is best-effort (it shells out to taskkill on Windows and swallows
// the error), and when it fails to land the first Ctrl-C was consumed for
// nothing: the CLI sat on a child that would never close until a SECOND
// interrupt -- the shape a user reads as a hang.
describe("createInterruptHandler", () => {
  it("force-exits when the kill did not take the child down within the grace window", () => {
    vi.useFakeTimers();
    try {
      let directKills = 0;
      const child = {
        pid: 4242,
        kill: () => {
          directKills += 1;
          return true;
        },
      } as unknown as Parameters<typeof createInterruptHandler>[0];
      const exits: number[] = [];
      // A killTree that does nothing -- the real win32 failure mode, where
      // taskkill cannot spawn and the error is deliberately swallowed.
      const handler = createInterruptHandler(child, {
        graceMs: 50,
        exit: (c) => exits.push(c),
        kill: () => {},
      });
      handler.onInterrupt();
      expect(exits).toEqual([]);
      vi.advanceTimersByTime(49);
      expect(exits).toEqual([]);
      vi.advanceTimersByTime(1);
      // Direct kill first (it reaches the wrapper even when the tree walk
      // failed), then the forced exit so ONE Ctrl-C always ends the run.
      expect(directKills).toBe(1);
      expect(exits).toEqual([INTERRUPT_EXIT_CODE]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not force-exit when the run settles first", () => {
    vi.useFakeTimers();
    try {
      const child = { pid: 1, kill: () => true } as unknown as Parameters<typeof createInterruptHandler>[0];
      const exits: number[] = [];
      const handler = createInterruptHandler(child, { graceMs: 50, exit: (c) => exits.push(c), kill: () => {} });
      handler.onInterrupt();
      handler.cancel();
      vi.advanceTimersByTime(5000);
      expect(exits).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms exactly one fallback no matter how many interrupts arrive", () => {
    vi.useFakeTimers();
    try {
      const child = { pid: 1, kill: () => true } as unknown as Parameters<typeof createInterruptHandler>[0];
      const exits: number[] = [];
      let killTreeCalls = 0;
      const handler = createInterruptHandler(child, {
        graceMs: 50,
        exit: (c) => exits.push(c),
        kill: () => {
          killTreeCalls += 1;
        },
      });
      handler.onInterrupt();
      handler.onInterrupt();
      handler.onInterrupt();
      // Every interrupt still re-attempts the kill -- only the timer is single.
      expect(killTreeCalls).toBe(3);
      vi.advanceTimersByTime(5000);
      expect(exits).toEqual([INTERRUPT_EXIT_CODE]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// `--strict` and `--min-grade` are forwarded to the child verbatim, and their
// ONLY effect is a non-zero exit -- the JSON report is identical either way.
// Swallowing the child's code made both flags silent no-ops through yaw-mcp:
// a CI gate printed "Grade F is below threshold A" and exited 0.
describe("runComplianceCommand child exit propagation", () => {
  const report = {
    grade: "F",
    score: 12,
    url: "https://example.com/mcp",
    summary: { total: 10, passed: 2, failed: 8, required: 5, requiredPassed: 1 },
    tests: [],
  };

  async function runWithChildExit(exitCode: number | null) {
    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const spawn = (): EventEmitter & { stdout: EventEmitter; pid: number; kill: () => boolean } => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          pid: number;
          kill: () => boolean;
        };
        child.stdout = new EventEmitter();
        child.pid = 4242;
        child.kill = () => true;
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from(JSON.stringify(report)));
          child.emit("close", exitCode);
        });
        return child;
      };
      return { spawn, default: { spawn } };
    });
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const code = await mod.runComplianceCommand(["https://example.com/mcp", "--min-grade", "A"], cap.io);
      return { code, out: cap.out(), err: cap.err() };
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  }

  it("propagates a non-zero child exit while still printing the report", async () => {
    const r = await runWithChildExit(1);
    expect(r.code).toBe(1);
    // The report is NOT suppressed -- the user still sees why the gate failed.
    expect(r.out).toContain("Compliance: F");
    expect(r.out).toContain("2/10 passed, 1/5 required");
  });

  it("stays 0 when the child exits cleanly", async () => {
    const r = await runWithChildExit(0);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Compliance: F");
  });

  it("reports a signal death (null code) as 1", async () => {
    const r = await runWithChildExit(null);
    expect(r.code).toBe(1);
  });

  it("reassembles a multi-byte UTF-8 sequence split across two pipe chunks", async () => {
    // A report bigger than the pipe's highWaterMark arrives in multiple
    // Buffer chunks, and the split lands wherever the kernel cuts it --
    // including MID-character. Decoding each chunk on its own turned both
    // halves into U+FFFD, silently corrupting the field the split landed in.
    const utf8Report = {
      grade: "B",
      score: 88,
      url: "https://exämple.com/mcp",
      summary: { total: 10, passed: 9, failed: 1, required: 5, requiredPassed: 5 },
      tests: [],
    };
    const bytes = Buffer.from(JSON.stringify(utf8Report), "utf8");
    // Cut INSIDE the two-byte "ä" sequence (0xc3 0xa4).
    const cut = bytes.indexOf(0xc3) + 1;
    expect(cut).toBeGreaterThan(0);
    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const spawn = (): EventEmitter & { stdout: EventEmitter; pid: number; kill: () => boolean } => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          pid: number;
          kill: () => boolean;
        };
        child.stdout = new EventEmitter();
        child.pid = 4242;
        child.kill = () => true;
        setImmediate(() => {
          child.stdout.emit("data", bytes.subarray(0, cut));
          child.stdout.emit("data", bytes.subarray(cut));
          child.emit("close", 0);
        });
        return child;
      };
      return { spawn, default: { spawn } };
    });
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const code = await mod.runComplianceCommand(["https://example.com/mcp"], cap.io);
      expect(code).toBe(0);
      expect(cap.out()).toContain("https://exämple.com/mcp");
      expect(cap.out()).not.toContain("�");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});
