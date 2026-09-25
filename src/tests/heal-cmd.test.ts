// runHeal (src/heal-cmd.ts): what `yaw-mcp heal` prints and exits with.
//
// The audited defect: over a read-only config.toml holding a stale entry, the
// dry run said "Would re-point 1 stale entry", and the real run then said "No
// stale yaw-mcp entries found." and exited 0 -- with --json reporting healed
// [] and unhealable [] -- because the sweep logged the failed write and
// dropped it. The only trace was a raw EPERM log line naming a temp file.
//
// Most cases hand runHeal a SWEEP STUB (its second parameter), so the output
// for each outcome is pinned without touching a disk. The last describe runs
// the real sweep over a fake home: once through the sweep's `writeConfig`
// seam, which fails the write on every runner, and once over a real read-only
// file, which fails it only where the disk does (Windows).

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHeal } from "../heal-cmd.js";
import {
  type FailedHeal,
  type HealedEntry,
  type HealResult,
  healStaleBrokerEntries,
  type HealOptions as SweepOptions,
  type UnhealableConfig,
} from "../heal-entries.js";
import { setLogSurface } from "../logger.js";
import { MIN_OAM_VERSION, type OamProbe } from "../oam-spawn.js";
import { describeWriteFailure } from "../write-failure.js";

/** Everything runHeal writes to the two process streams during one call. */
function captureStreams(): { stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  return { stdout: () => out.join(""), stderr: () => err.join("") };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const CONFIG = process.platform === "win32" ? "C:\\Users\\u\\.codex\\config.toml" : "/home/u/.codex/config.toml";
const CLAUDE = process.platform === "win32" ? "C:\\Users\\u\\.claude.json" : "/home/u/.claude.json";
const GONE =
  process.platform === "win32"
    ? "C:\\gone\\node_modules\\@yawlabs\\mcp\\dist\\index.js"
    : "/gone/node_modules/@yawlabs/mcp/dist/index.js";
/** Stands in for any clause: runHeal prints `error` as the sweep words it. */
const READ_ONLY = `failed to write ${CONFIG}: it is read-only -- clear its read-only attribute (\`attrib -R "${CONFIG}"\`), then re-run`;

const FAILED: FailedHeal = {
  clientId: "codex-cli",
  scope: "user",
  path: CONFIG,
  from: GONE,
  to: "npx",
  error: READ_ONLY,
};
const HEALED: HealedEntry = { clientId: "claude-code", scope: "user", path: CLAUDE, from: GONE, to: "npx" };

/** A sweep that answers `result`, with every list it leaves out empty. */
function sweepOf(result: Partial<HealResult>): (opts: SweepOptions) => Promise<HealResult> {
  return async () => ({ healed: [], unhealable: [], failed: [], ...result });
}

/** The stderr block for FAILED alone, as a real run prints it. */
function failedBlock(verb: "could not" | "cannot"): string {
  return (
    `yaw-mcp heal: ${verb} re-point 1 stale entry:\n` +
    `  codex-cli (user): ${CONFIG}\n` +
    `    still -> ${GONE}\n` +
    `    ${READ_ONLY}\n` +
    "It still names a launch file that no longer exists, so its client cannot start yaw-mcp -- fix what the line above says, then re-run `yaw-mcp heal`.\n"
  );
}

describe("runHeal -- a stale entry the sweep could not re-point", () => {
  it("says so on stderr -- the file, why, and the step -- never 'No stale yaw-mcp entries found.', and exits 1", async () => {
    const io = captureStreams();
    const { exitCode } = await runHeal({}, sweepOf({ failed: [FAILED] }));
    expect(exitCode).toBe(1);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toBe(failedBlock("could not"));
  });

  it("--json lists it under a new `failed` field, keeps the four fields it had, and exits 1", async () => {
    const io = captureStreams();
    const { exitCode } = await runHeal({ json: true }, sweepOf({ failed: [FAILED] }));
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(io.stdout()) as Record<string, unknown>;
    expect(parsed).toEqual({ healed: [], unhealable: [], failed: [FAILED], count: 0, dryRun: false });
    // The error still reaches a person reading stderr; stdout stays pure JSON.
    expect(io.stderr()).toBe(failedBlock("could not"));
  });

  it("--quiet drops the transcript but not the error or the exit code", async () => {
    const io = captureStreams();
    const { exitCode } = await runHeal({ quiet: true }, sweepOf({ failed: [FAILED] }));
    expect(exitCode).toBe(1);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toBe(failedBlock("could not"));
  });

  it("--dry-run words a refusal it can already see in the present tense, and exits 1", async () => {
    const io = captureStreams();
    const { exitCode } = await runHeal({ dryRun: true }, sweepOf({ failed: [FAILED] }));
    expect(exitCode).toBe(1);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toBe(failedBlock("cannot"));
  });

  it("prints a repair that landed as before, then the failure after a blank line, and exits 1", async () => {
    const io = captureStreams();
    const { exitCode } = await runHeal({}, sweepOf({ healed: [HEALED], failed: [FAILED] }));
    expect(exitCode).toBe(1);
    expect(io.stdout()).toBe(
      `Re-pointed 1 stale entry:\n  claude-code (user): ${CLAUDE}\n    was -> ${GONE}\n    now -> npx\n\n` +
        "Restart the affected client(s) to pick this up.\n",
    );
    expect(io.stderr()).toBe(`\n${failedBlock("could not")}`);
  });

  it("counts several in the plural", async () => {
    const io = captureStreams();
    const second: FailedHeal = { ...FAILED, clientId: "cursor", path: CLAUDE, error: `failed to write ${CLAUDE}: EIO` };
    const { exitCode } = await runHeal({}, sweepOf({ failed: [FAILED, second] }));
    expect(exitCode).toBe(1);
    expect(io.stderr()).toBe(
      "yaw-mcp heal: could not re-point 2 stale entries:\n" +
        `  codex-cli (user): ${CONFIG}\n    still -> ${GONE}\n    ${READ_ONLY}\n` +
        `  cursor (user): ${CLAUDE}\n    still -> ${GONE}\n    failed to write ${CLAUDE}: EIO\n` +
        "Each still names a launch file that no longer exists, so its client cannot start yaw-mcp -- fix what each entry's last line says, then re-run `yaw-mcp heal`.\n",
    );
  });
});

describe("runHeal -- the outcomes that were already right keep their output and exit 0", () => {
  const UNHEALABLE: UnhealableConfig = { clientId: "codex-cli", scope: "user", path: CONFIG, reason: "malformed" };

  it("a clean sweep", async () => {
    const io = captureStreams();
    const { exitCode } = await runHeal({}, sweepOf({}));
    expect(exitCode).toBe(0);
    expect(io.stdout()).toBe("No stale yaw-mcp entries found.\n");
    expect(io.stderr()).toBe("");
  });

  it("a clean sweep with a config it could not check", async () => {
    const io = captureStreams();
    const { exitCode } = await runHeal({}, sweepOf({ unhealable: [UNHEALABLE] }));
    expect(exitCode).toBe(0);
    expect(io.stdout()).toBe(
      "No stale yaw-mcp entries found.\n\n1 config could not be checked:\n" +
        `  codex-cli (user): ${CONFIG} -- malformed\nRun \`yaw-mcp doctor\` for what each one needs.\n`,
    );
    expect(io.stderr()).toBe("");
  });

  it("a repair, as JSON", async () => {
    const io = captureStreams();
    const { exitCode } = await runHeal({ json: true }, sweepOf({ healed: [HEALED] }));
    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout())).toEqual({ healed: [HEALED], unhealable: [], failed: [], count: 1, dryRun: false });
    expect(io.stderr()).toBe("");
  });

  it("a failed repair beside a config it could not check: the list opens stdout with no blank line above it", async () => {
    const io = captureStreams();
    const { exitCode } = await runHeal({}, sweepOf({ unhealable: [UNHEALABLE], failed: [FAILED] }));
    expect(exitCode).toBe(1);
    expect(io.stdout().startsWith("1 config could not be checked:\n")).toBe(true);
    expect(io.stderr()).toBe(`\n${failedBlock("could not")}`);
  });
});

// ---------------------------------------------------------------------------
// The real sweep over a fake home
// ---------------------------------------------------------------------------

/** Whether this machine refuses to REPLACE a file made read-only with chmod --
 *  what the read-only run below needs, since the sweep's write is a rename
 *  onto the file (atomic-write.ts). Windows does: chmod 0o444 sets the
 *  read-only attribute, and a rename onto such a file fails EPERM. POSIX does
 *  not: rename(2) asks the DIRECTORY for write access, never the file it
 *  replaces. Asked of the disk rather than assumed from the platform (the same
 *  probe target-codex-cli.test.ts runs for install). */
const READ_ONLY_BLOCKS_REPLACE: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), "yaw-mcp-heal-ro-probe-"));
  const target = join(dir, "target");
  try {
    writeFileSync(target, "a");
    writeFileSync(join(dir, "other"), "b");
    chmodSync(target, 0o444);
    try {
      renameSync(join(dir, "other"), target);
      return false;
    } catch {
      return true;
    }
  } finally {
    try {
      chmodSync(target, 0o666);
    } catch {
      // Already gone or never made; the rmSync below copes either way.
    }
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe("yaw-mcp heal over a config it cannot write -- the audited run", () => {
  const OAM_BIN = process.platform === "win32" ? "C:\\tools\\oam.exe" : "/usr/local/bin/oam";
  const probe = (): OamProbe => ({
    bin: "oam",
    binPath: OAM_BIN,
    version: MIN_OAM_VERSION,
    belowMin: false,
    failure: null,
    failureDetail: null,
  });
  const DEAD =
    process.platform === "win32"
      ? "C:\\Users\\x\\scoop\\apps\\yaw\\2.1.2\\resources\\app.asar.unpacked\\node_modules\\@yawlabs\\mcp\\dist\\index.js"
      : "/opt/yaw/2.1.2/resources/node_modules/@yawlabs/mcp/dist/index.js";

  let home: string;
  let liveEntry: string;
  let config: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-heal-cmd-"));
    const pkgDir = join(home, "live", "node_modules", "@yawlabs", "mcp", "dist");
    mkdirSync(pkgDir, { recursive: true });
    liveEntry = join(pkgDir, "index.js");
    writeFileSync(liveEntry, "// broker\n");
    config = join(home, ".codex", "config.toml");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(
      config,
      `[mcp_servers.mcp]\ncommand = ${JSON.stringify(OAM_BIN)}\nargs = ["run", "--no-check", ${JSON.stringify(DEAD)}]\n`,
    );
    // What the dispatcher sets for every subcommand: warnings as plain lines,
    // the server's info telemetry dropped.
    vi.stubEnv("LOG_LEVEL", undefined);
    setLogSurface("cli");
  });

  afterEach(() => {
    setLogSurface("server");
    try {
      chmodSync(config, 0o666);
    } catch {
      // Not made read-only by this case, or already gone.
    }
    rmSync(home, { recursive: true, force: true });
  });

  /** The real sweep, pinned to the fake home. `env: {}` keeps an ambient
   *  CLAUDE_CONFIG_DIR or CODEX_HOME from sending it to a real file. */
  function sweepIn(extra: Partial<SweepOptions> = {}): (opts: SweepOptions) => Promise<HealResult> {
    return (opts) =>
      healStaleBrokerEntries({
        ...opts,
        home,
        cwd: home,
        env: {},
        oamProbe: probe,
        resolveOamEntry: () => liveEntry,
        ...extra,
      });
  }

  it("the dry run lists the entry as one it would re-point; the live run reports that entry as failed and exits 1 (seam, every runner)", async () => {
    const before = readFileSync(config, "utf8");
    const tmp = `${config}.tmp-4242-1790344914194-1`;
    const err = Object.assign(new Error(`EPERM: operation not permitted, rename '${tmp}' -> '${config}'`), {
      code: "EPERM",
      syscall: "rename",
      path: tmp,
      dest: config,
    });
    const refuse = sweepIn({
      writeConfig: async () => {
        throw err;
      },
    });

    // A dry run writes nothing, so it never meets the refused write: it lists
    // the entry and exits 0, as install's dry run does over the same file.
    // The live run is where the failure has to show.
    let io = captureStreams();
    expect((await runHeal({ dryRun: true }, refuse)).exitCode).toBe(0);
    expect(io.stdout()).toBe(
      `Would re-point 1 stale entry:\n  codex-cli (user): ${config}\n    was -> ${DEAD}\n    now -> ${liveEntry}\n`,
    );
    vi.restoreAllMocks();

    io = captureStreams();
    expect((await runHeal({}, refuse)).exitCode).toBe(1);
    expect(io.stdout()).toBe("");
    // One report, in the command's words: no raw log line beside it.
    expect(io.stderr()).toBe(
      "yaw-mcp heal: could not re-point 1 stale entry:\n" +
        `  codex-cli (user): ${config}\n    still -> ${DEAD}\n    ${describeWriteFailure(config, err)}\n` +
        "It still names a launch file that no longer exists, so its client cannot start yaw-mcp -- fix what the line above says, then re-run `yaw-mcp heal`.\n",
    );
    vi.restoreAllMocks();

    io = captureStreams();
    expect((await runHeal({ json: true }, refuse)).exitCode).toBe(1);
    const parsed = JSON.parse(io.stdout()) as HealResult & { count: number };
    expect(parsed.healed).toEqual([]);
    expect(parsed.count).toBe(0);
    expect(parsed.failed.map((f) => [f.path, f.from, f.error])).toEqual([
      [config, DEAD, describeWriteFailure(config, err)],
    ]);
    expect(readFileSync(config, "utf8")).toBe(before);
  });

  it.skipIf(process.platform !== "win32" || !READ_ONLY_BLOCKS_REPLACE)(
    "a real read-only config.toml: names the file and how to clear the attribute, exits 1, writes nothing",
    async () => {
      // Windows only: see READ_ONLY_BLOCKS_REPLACE. This is the audited run
      // itself -- the raw error named config.toml.tmp-<pid>-... and said
      // nothing to do.
      const before = readFileSync(config, "utf8");
      chmodSync(config, 0o444);
      const io = captureStreams();
      expect((await runHeal({}, sweepIn())).exitCode).toBe(1);
      expect(io.stdout()).toBe("");
      expect(io.stderr()).toBe(
        "yaw-mcp heal: could not re-point 1 stale entry:\n" +
          `  codex-cli (user): ${config}\n    still -> ${DEAD}\n` +
          `    failed to write ${config}: it is read-only -- clear its read-only attribute (\`attrib -R "${config}"\`), then re-run\n` +
          "It still names a launch file that no longer exists, so its client cannot start yaw-mcp -- fix what the line above says, then re-run `yaw-mcp heal`.\n",
      );
      expect(io.stderr()).not.toContain(".tmp-");
      expect(readFileSync(config, "utf8")).toBe(before);
      expect(readdirSync(dirname(config))).toEqual(["config.toml"]);
    },
  );
});
