// doctor's launch checks on the entry as its row NORMALISES it, the
// command-less entry, and the injected clock / platform seams in the text
// report. Its own file so it needs none of doctor-cmd.test.ts's module mocks.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DoctorOptions, formatRelativeAge, runDoctor as runDoctorUnstubbed } from "../doctor-cmd.js";
import { ENTRY_NAME } from "../install-targets.js";
import { STATE_FILENAME, STATE_SCHEMA_VERSION } from "../persistence.js";

/** probeOam's answer when oam is not installed: keeps the real probe (a spawn
 *  of `oam --version`) out of the suite. */
const oamNotInstalled = () => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});

let home: string;
let cwd: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "yaw-doctor-launch-")));
  cwd = realpathSync(mkdtempSync(join(home, "cwd-")));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function doctor(opts: DoctorOptions = {}) {
  const lines: string[] = [];
  const result = await runDoctorUnstubbed({
    cwd,
    home,
    env: {},
    os: "linux",
    out: (s) => lines.push(s),
    err: () => {},
    oamProbe: oamNotInstalled,
    skipRegistryCheck: true,
    ...opts,
  });
  return { result, text: lines.join("") };
}

function writeClaudeUserEntry(entry: unknown): void {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { [ENTRY_NAME]: entry } }));
}

describe("doctor launch checks read the entry through the row's normalize hook", () => {
  it("checks a Cline entry in its nested transport form instead of reporting it OK", async () => {
    // Cline has written `{ transport: { command, args } }`; the row's
    // normalize hook folds it flat, and the heal sweep reads its launch from
    // that view. The JSON walk used to run the launch checks on the raw
    // value, found no top-level `command`, and printed `OK -- has "mcp" entry`
    // for an entry whose oam entry file is gone.
    const first = await doctor();
    const clinePath = first.result.snapshot.clients.find((c) => c.clientId === "cline")?.path;
    expect(clinePath).toBeTruthy();
    const oamBin = join(home, "oam");
    writeFileSync(oamBin, "");
    const gone = join(home, "gone", "broker.js");
    mkdirSync(dirname(clinePath as string), { recursive: true });
    writeFileSync(
      clinePath as string,
      JSON.stringify({
        mcpServers: { [ENTRY_NAME]: { transport: { command: oamBin, args: ["run", "--no-check", gone] } } },
      }),
    );

    const { result, text } = await doctor();
    const cline = result.snapshot.clients.find((c) => c.clientId === "cline");
    expect(cline?.hasMcpEntry).toBe(true);
    expect(cline?.launchRuntime).toBe("oam");
    expect(cline?.launchOamEntryMissing).toBe(gone);
    expect(cline?.launchNoCommand).toBe(false);
    expect(text).toContain("oam cannot fetch it on demand");
    expect(result.exitCode).toBe(2);
  });
});

describe("doctor reports an entry with nothing to launch", () => {
  it.each([
    ["an empty object", {}],
    ["null", null],
    ["args with no command", { args: ["-y", "@yawlabs/mcp"] }],
  ])("flags %s as unable to launch, with a warning and exit 2", async (_label, entry) => {
    writeClaudeUserEntry(entry);
    const { result, text } = await doctor();
    const client = result.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "user");
    expect(client?.hasMcpEntry).toBe(true);
    expect(client?.launchNoCommand).toBe(true);
    expect(text).toContain(`has "${ENTRY_NAME}" entry, but it has no launch command`);
    expect(text).not.toMatch(/Claude Code \(user\): OK/);
    expect(text).not.toContain("All good");
    expect(result.exitCode).toBe(2);
    expect(result.snapshot.config.warnings.join("\n")).toContain("has no launch command");
  });

  it("says the same on --json", async () => {
    writeClaudeUserEntry({});
    const { result, text } = await doctor({ json: true });
    const parsed = JSON.parse(text);
    expect(result.exitCode).toBe(2);
    expect(parsed.diagnosis.summary).not.toContain("All good");
    expect(JSON.stringify(parsed.warnings)).toContain("has no launch command");
  });

  it("leaves a command entry and a remote (url) entry alone", async () => {
    writeClaudeUserEntry({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
    const spawned = await doctor();
    const a = spawned.result.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "user");
    expect(a?.launchNoCommand).toBe(false);
    expect(spawned.text).toMatch(/Claude Code \(user\): OK/);
    expect(spawned.result.exitCode).toBe(0);

    // An "mcp" entry its client CONNECTS to has no command by design.
    writeClaudeUserEntry({ type: "http", url: "https://mcp.example.com/mcp" });
    const remote = await doctor();
    const b = remote.result.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "user");
    expect(b?.launchNoCommand).toBe(false);
    expect(remote.result.exitCode).toBe(0);
  });

  it("leaves an object `command` with a string `path` alone, and still flags one without", async () => {
    // Zed's older `command: { path, args }` spelling: something to start,
    // though none of the launch checks can read it.
    writeClaudeUserEntry({ command: { path: "npx", args: ["-y", "@yawlabs/mcp@latest"] } });
    const nested = await doctor();
    const a = nested.result.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "user");
    expect(a?.launchNoCommand).toBe(false);
    expect(a?.launchRuntime).toBeNull();
    expect(nested.text).not.toContain("has no launch command");
    expect(nested.result.exitCode).toBe(0);

    writeClaudeUserEntry({ command: { args: ["-y", "@yawlabs/mcp@latest"] } });
    const empty = await doctor();
    const b = empty.result.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "user");
    expect(b?.launchNoCommand).toBe(true);
    expect(empty.result.exitCode).toBe(2);
  });

  it("is false on a row with no entry", async () => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const { result } = await doctor();
    const client = result.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "user");
    expect(client?.hasMcpEntry).toBe(false);
    expect(client?.launchNoCommand).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});

describe("doctor's text report reads the injected clock and platform everywhere", () => {
  it("ages RELIABILITY rows on DoctorOptions.now, like the STATE section", async () => {
    // A clock far from the wall clock, so an age computed from Date.now()
    // cannot land on the expected string.
    const NOW = Date.parse("2031-03-04T12:00:00.000Z");
    const lastUsedAt = NOW - 2 * 3600_000;
    mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
    writeFileSync(
      join(home, ".yaw-mcp", STATE_FILENAME),
      JSON.stringify({
        version: STATE_SCHEMA_VERSION,
        savedAt: NOW - 60_000,
        learning: { flaky: { dispatched: 10, succeeded: 2, lastUsedAt } },
        packHistory: [],
      }),
    );
    const { text } = await doctor({ now: () => NOW });
    expect(text).toContain("RELIABILITY");
    expect(text).toContain(`flaky -- 10 calls, 20% success, last used ${formatRelativeAge(2 * 3600_000)} ago`);
  });

  it("names the platform the managed-tree mismatch was judged against", async () => {
    mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
    writeFileSync(
      join(home, ".yaw-mcp", "bundles.json"),
      JSON.stringify({
        version: 1,
        servers: [{ namespace: "fetch", name: "Fetch", command: "npx", args: ["-y", "@yawlabs/fetch-mcp@latest"] }],
      }),
    );
    const root = join(home, ".yaw-mcp", "sidecars");
    const pkgDir = join(root, "node_modules", "@yawlabs", "fetch-mcp");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@yawlabs/fetch-mcp", version: "0.3.6" }));
    writeFileSync(join(root, "platform.json"), JSON.stringify({ platform: "beos", arch: "sparc" }));

    // "aix" is no runner this suite uses, so process.platform cannot match it.
    const { text } = await doctor({ platform: "aix" });
    expect(text).toContain(`! installed on beos/sparc; this process is aix/${process.arch}.`);
  });
});
