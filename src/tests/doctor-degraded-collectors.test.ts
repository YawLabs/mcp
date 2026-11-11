// Two doctor collectors whose failure has no on-disk shape: the expired-trial
// sweep rejecting as a whole (gcExpiredTrials catches per marker), and a throw
// inside the JSON classifier past the parse (the launch checks read the disk
// only through calls that do not throw on a real one, and the container
// question before them is not expected to throw at all). All are injected at a
// module boundary, which is why they live here and not in doctor-cmd.test.ts:
// a node:fs mock there would sit under several hundred tests that read real
// files.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { faults } = vi.hoisted(() => ({ faults: { gc: null as Error | null } }));

/** Any path containing this makes existsSync throw. */
const EXISTS_THROWS = "EXISTS-THROWS-HERE";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = ((p: unknown) => {
    if (typeof p === "string" && p.includes("EXISTS-THROWS-HERE")) throw new Error("injected exists failure");
    return actual.existsSync(p as string);
  }) as typeof actual.existsSync;
  return { ...actual, existsSync };
});

/** Raw config bytes containing this make classifyClientConfig throw, for the
 *  calls doctor-cmd.ts makes (client-config.ts's own internal calls bind the
 *  real function and are not affected). */
const CLASSIFY_THROWS = "CLASSIFY-THROWS-HERE";

vi.mock("../client-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client-config.js")>();
  const classifyClientConfig: typeof actual.classifyClientConfig = (raw, ...rest) => {
    if (typeof raw === "string" && raw.includes("CLASSIFY-THROWS-HERE")) throw new Error("injected classify failure");
    return actual.classifyClientConfig(raw, ...rest);
  };
  return { ...actual, classifyClientConfig };
});

vi.mock("../try-cmd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../try-cmd.js")>();
  const gcExpiredTrials: typeof actual.gcExpiredTrials = (...args) => {
    if (faults.gc !== null) return Promise.reject(faults.gc);
    return actual.gcExpiredTrials(...args);
  };
  return { ...actual, gcExpiredTrials };
});

import { runDoctor as runDoctorUnstubbed } from "../doctor-cmd.js";
import { ENTRY_NAME } from "../install-target-model.js";

const oamNotInstalled = () => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});

const runDoctor: typeof runDoctorUnstubbed = (opts = {}) =>
  runDoctorUnstubbed({ ...opts, oamProbe: opts.oamProbe ?? oamNotInstalled, skipRegistryCheck: true });

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = realpathSync(mkdtempSync(join(tmpdir(), "yaw-mcp-doctor-degraded-")));
  synthCwd = realpathSync(mkdtempSync(join(synthHome, "cwd-")));
});

afterEach(() => {
  faults.gc = null;
  rmSync(synthHome, { recursive: true, force: true });
});

function captureOut() {
  const lines: string[] = [];
  return { out: (s: string) => lines.push(s), text: () => lines.join("") };
}

describe("runDoctor -- the expired-trial sweep rejects as a whole", () => {
  const fixedNow = 1_000_000_000_000;

  function seedExpiredTrial(): string {
    const clientPath = join(synthHome, "client.json");
    writeFileSync(clientPath, JSON.stringify({ mcpServers: { "yaw-mcp-try-foo": { command: "npx" } } }));
    const trialsRoot = join(synthHome, ".yaw-mcp", "trials");
    mkdirSync(trialsRoot, { recursive: true });
    writeFileSync(
      join(trialsRoot, "foo.json"),
      JSON.stringify({
        slug: "foo",
        expiresAt: fixedNow - 60_000,
        clientPath,
        clientName: "claude-code",
        containerPath: ["mcpServers"],
        entryName: "yaw-mcp-try-foo",
      }),
    );
    return clientPath;
  }

  it("reports every expired trial as a failure: json, warnings and exit 2, never an empty result", async () => {
    // The catch used to answer a rejection with { cleared: 0, failed: 0,
    // failures: [] }, so the expired trial appeared nowhere and doctor could
    // say "All good" over an entry still wired in.
    const clientPath = seedExpiredTrial();
    faults.gc = new Error("injected sweep failure");
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: {},
      os: "linux",
      out: cap.out,
      err: () => {},
      json: true,
      now: () => fixedNow,
    });
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.trials.cleared).toBe(0);
    expect(parsed.trials.failed).toBe(1);
    expect(parsed.trials.failures[0]).toMatchObject({ slug: "foo", clientPath, stage: "peel" });
    const warning = parsed.warnings.find((w: string) => w.includes('trial "foo"'));
    expect(warning).toContain("injected sweep failure");
    expect(warning).toContain("may still be wired into");
    expect(warning).toContain("yaw-mcp try-cleanup foo");
    expect(r.exitCode).toBe(2);
  });

  it("says so in the text report too", async () => {
    seedExpiredTrial();
    faults.gc = new Error("injected sweep failure");
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: {},
      os: "linux",
      out: cap.out,
      err: () => {},
      now: () => fixedNow,
    });
    expect(cap.text()).toContain("TRIALS (yaw-mcp try)");
    expect(cap.text()).toContain("1 expired trial could not be swept -- see WARNINGS");
    expect(cap.text()).not.toContain("All good");
    expect(r.exitCode).toBe(2);
  });
});

describe("runDoctor -- a throw in the JSON classifier past the parse", () => {
  it("is reported as a failed launch check, never as malformed JSON", async () => {
    // The parse and everything after it shared one catch that answered
    // MALFORMED, so this file -- which parses -- sent the user after a syntax
    // error that is not there. The TOML path already reported the same throw
    // as `unreadable: launch check failed`.
    const command = join(synthHome, EXISTS_THROWS, "oam");
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command, args: ["run", "--no-check", "x.js"] } } }),
    );
    const cap = captureOut();
    const r = await runDoctor({ cwd: synthCwd, home: synthHome, env: {}, os: "linux", out: cap.out, err: () => {} });
    const client = r.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "user");
    expect(client?.malformed).toBe(false);
    expect(client?.hasMcpEntry).toBe(true);
    expect(client?.unreadable).toBe("launch check failed: injected exists failure");
    expect(cap.text()).not.toContain("JSON is malformed");
    expect(r.exitCode).toBe(2);
  });

  it("reports a throw before the launch checks as unreadable, worded as a classify failure", async () => {
    // The outer catch: everything past the parse that is not the launch
    // checks. Reached here through the blocked-container question, which is
    // asked only when the file holds no container -- hence no mcpServers key.
    writeFileSync(join(synthHome, ".claude.json"), JSON.stringify({ note: CLASSIFY_THROWS }));
    const cap = captureOut();
    const r = await runDoctor({ cwd: synthCwd, home: synthHome, env: {}, os: "linux", out: cap.out, err: () => {} });
    const client = r.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "user");
    expect(client?.malformed).toBe(false);
    expect(client?.hasMcpEntry).toBe(false);
    expect(client?.unreadable).toBe("could not classify the parsed file: injected classify failure");
    expect(cap.text()).not.toContain("JSON is malformed");
  });
});
