import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GRADES_FILENAME } from "../grades-cache.js";
import { BUNDLES_FILENAME } from "../local-bundles.js";
import { CONFIG_DIRNAME } from "../paths.js";
import { STATE_FILENAME, STATE_SCHEMA_VERSION } from "../persistence.js";
import { SECRETS_FILENAME } from "../secrets-vault.js";
import { collectStatus, parseStatusArgs, runStatus, STATUS_SCHEMA_VERSION, STATUS_USAGE } from "../status-cmd.js";

// Every test runs against an isolated fake home so the developer's real
// ~/.yaw-mcp is never read (and, per the no-writes test below, never
// written). `cwd` is set to that same home on purpose: findProjectConfigDir
// bounds a walk that STARTS at $HOME to dirs strictly UNDER it, so no
// project-local bundles.json candidate is ever found and these tests are
// about the user-global file only.
describe("status", () => {
  let home: string;
  let yawMcpDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-status-"));
    yawMcpDir = join(home, CONFIG_DIRNAME);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

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

  function writeBundles(raw: string): void {
    mkdirSync(yawMcpDir, { recursive: true });
    writeFileSync(join(yawMcpDir, BUNDLES_FILENAME), raw, "utf8");
  }

  function writeServers(servers: unknown[]): void {
    writeBundles(JSON.stringify({ version: 1, servers }));
  }

  function writeGrades(grades: unknown): void {
    mkdirSync(yawMcpDir, { recursive: true });
    writeFileSync(join(yawMcpDir, GRADES_FILENAME), JSON.stringify(grades), "utf8");
  }

  function writeState(state: unknown): void {
    mkdirSync(yawMcpDir, { recursive: true });
    writeFileSync(join(yawMcpDir, STATE_FILENAME), JSON.stringify(state), "utf8");
  }

  const collect = (env: NodeJS.ProcessEnv = {}) => collectStatus({ home, cwd: home, env });

  // --- fresh machine ------------------------------------------------------

  it("exits 0 with an empty-but-readable payload on a machine with no config", async () => {
    // A fresh install is not an error: the panel polls this on every open and
    // must render "no servers yet" rather than an error state.
    const io = captureIO();
    const r = await runStatus({ home, cwd: home, env: {}, json: true, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(io.out.join(""));
    expect(payload.schemaVersion).toBe(STATUS_SCHEMA_VERSION);
    expect(payload.ok).toBe(true);
    expect(payload.config.readable).toBe(true);
    expect(payload.config.path).toBeNull();
    expect(payload.config.scope).toBeNull();
    expect(payload.serverCount).toBe(0);
    expect(payload.servers).toEqual([]);
    expect(payload.vault.exists).toBe(false);
    expect(payload.vault.locked).toBe(false);
    expect(payload.learning.readable).toBe(true);
    expect(payload.learning.namespaces).toBe(0);
  });

  // --- servers ------------------------------------------------------------

  it("reports each configured server's namespace, name, type and active flag", async () => {
    writeServers([
      { namespace: "gh", name: "GitHub", command: "npx", args: ["gh-mcp"] },
      { namespace: "linear", name: "Linear", url: "https://linear.example/mcp", isActive: false },
    ]);
    const payload = await collect();
    expect(payload.serverCount).toBe(2);
    expect(payload.activeCount).toBe(1);
    expect(payload.config.scope).toBe("user");
    expect(payload.config.path).toBe(join(yawMcpDir, BUNDLES_FILENAME));
    const gh = payload.servers.find((s) => s.namespace === "gh");
    expect(gh).toMatchObject({ name: "GitHub", type: "local", active: true });
    const linear = payload.servers.find((s) => s.namespace === "linear");
    expect(linear).toMatchObject({ name: "Linear", type: "remote", active: false });
  });

  // --- grades -------------------------------------------------------------

  it("prefers the audited grade cache over the grade bundles.json carries", async () => {
    // Same precedence `list` applies: the cached letter was measured against
    // the bytes on THIS machine, the bundles.json one is what the catalog
    // claimed when `add` ran. A panel showing the stale one is showing a
    // grade for a build the user is not running.
    writeServers([
      { namespace: "gh", name: "GitHub", command: "npx", complianceGrade: "C" },
      { namespace: "linear", name: "Linear", command: "npx", complianceGrade: "B" },
    ]);
    writeGrades({ gh: { grade: "A", score: 97.5, gradedAt: "2026-06-11T00:00:00.000Z", suiteVersion: "0.17.1" } });
    const payload = await collect();
    const gh = payload.servers.find((s) => s.namespace === "gh");
    expect(gh).toMatchObject({
      grade: "A",
      gradeSource: "audit",
      score: 97.5,
      gradedAt: "2026-06-11T00:00:00.000Z",
      suiteVersion: "0.17.1",
    });
    // No cache entry: the catalog letter still shows, tagged as such so the
    // panel can render it differently from a measured one.
    const linear = payload.servers.find((s) => s.namespace === "linear");
    expect(linear).toMatchObject({ grade: "B", gradeSource: "catalog", score: null, gradedAt: null });
  });

  it("reports an ungraded server as grade null rather than omitting the field", async () => {
    writeServers([{ namespace: "gh", name: "GitHub", command: "npx" }]);
    const payload = await collect();
    expect(payload.servers[0]).toMatchObject({ grade: null, gradeSource: null });
  });

  // --- unreadable config --------------------------------------------------

  it("exits 1 and says why when bundles.json exists but cannot be parsed", async () => {
    // The one genuinely unreadable state. Distinguishable from the fresh
    // machine above by `config.path` being non-null: a file IS there.
    writeBundles("{ this is not json");
    const io = captureIO();
    const r = await runStatus({ home, cwd: home, env: {}, json: true, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(io.out.join(""));
    expect(payload.ok).toBe(false);
    expect(payload.config.readable).toBe(false);
    expect(payload.config.path).toBe(join(yawMcpDir, BUNDLES_FILENAME));
    expect(payload.config.warnings.join(" ")).toContain("invalid JSON");
    // The reason reaches a human on stderr too, so `status | jq` still
    // explains itself.
    expect(io.err.join("")).toContain("invalid JSON");
  });

  // --- vault --------------------------------------------------------------

  it("calls the vault locked when it exists and this process's env carries no passphrase", async () => {
    mkdirSync(yawMcpDir, { recursive: true });
    writeFileSync(join(yawMcpDir, SECRETS_FILENAME), "{}", "utf8");
    const locked = await collect({});
    expect(locked.vault).toMatchObject({ exists: true, locked: true, passphraseInEnv: false });
    const unlocked = await collect({ YAW_MCP_VAULT_PASSPHRASE: "hunter2" });
    expect(unlocked.vault).toMatchObject({ exists: true, locked: false, passphraseInEnv: true });
  });

  it("does not call a vault that was never created locked", async () => {
    // "No vault" is not "locked vault": a panel badge saying locked on a
    // machine with no secrets at all sends the user to unlock nothing.
    const payload = await collect({});
    expect(payload.vault).toMatchObject({ exists: false, locked: false });
  });

  it("flags the servers whose credentials come from the vault", async () => {
    writeServers([
      { namespace: "gh", name: "GitHub", command: "npx", env: { TOKEN: "${secret:GH_TOKEN}" } },
      { namespace: "linear", name: "Linear", url: "https://l.example", headers: { A: "${secret:L}" } },
      { namespace: "plain", name: "Plain", command: "npx", env: { X: "literal" } },
    ]);
    const payload = await collect({});
    const bySlug = Object.fromEntries(payload.servers.map((s) => [s.namespace, s.needsSecrets]));
    expect(bySlug).toEqual({ gh: true, linear: true, plain: false });
  });

  // --- learning / state ---------------------------------------------------

  it("summarizes state.json and attaches each server's call counts", async () => {
    writeServers([
      { namespace: "gh", name: "GitHub", command: "npx" },
      { namespace: "cold", name: "Cold", command: "npx" },
    ]);
    writeState({
      version: STATE_SCHEMA_VERSION,
      savedAt: 1700,
      learning: {
        gh: { dispatched: 10, succeeded: 4, lastUsedAt: 500 },
        gone: { dispatched: 2, succeeded: 2, lastUsedAt: 600 },
      },
      packHistory: [{ namespace: "gh", toolName: "listPrs", at: 300 }],
      toolCache: { gh: { tools: [{ name: "listPrs" }], learnedAt: Date.now() } },
    });
    const payload = await collect();
    expect(payload.learning).toMatchObject({
      enabled: true,
      readable: true,
      namespaces: 2,
      calls: 12,
      packHistory: 1,
      toolCaches: 1,
      savedAt: 1700,
    });
    const gh = payload.servers.find((s) => s.namespace === "gh");
    expect(gh).toMatchObject({ calls: 10, successRate: 0.4, lastUsedAt: 500, flaky: true });
    // A configured server with no learning row reads as never called, not as
    // a 0% success rate -- those render very differently in a panel.
    const cold = payload.servers.find((s) => s.namespace === "cold");
    expect(cold).toMatchObject({ calls: 0, successRate: null, lastUsedAt: null, flaky: false });
  });

  it("does not call a reliable server flaky", async () => {
    // The flaky rule is >=3 dispatches AND <80% success (learning.ts). 9/10
    // is above the floor; without the shared selector this would be an
    // independent re-derivation free to disagree with doctor and health.
    writeServers([{ namespace: "gh", name: "GitHub", command: "npx" }]);
    writeState({
      version: STATE_SCHEMA_VERSION,
      savedAt: 1,
      learning: { gh: { dispatched: 10, succeeded: 9, lastUsedAt: 5 } },
      packHistory: [],
      toolCache: {},
    });
    const payload = await collect();
    expect(payload.servers[0]).toMatchObject({ successRate: 0.9, flaky: false });
  });

  it("reports persistence as disabled when the opt-out env var is set", async () => {
    writeState({
      version: STATE_SCHEMA_VERSION,
      savedAt: 1,
      learning: { gh: { dispatched: 3, succeeded: 0, lastUsedAt: 5 } },
      packHistory: [],
      toolCache: {},
    });
    const payload = await collect({ YAW_MCP_DISABLE_PERSISTENCE: "1" });
    expect(payload.learning.enabled).toBe(false);
  });

  it("reports an unparseable state.json as unreadable instead of as empty", async () => {
    writeState("not-an-object");
    const payload = await collect();
    expect(payload.learning.readable).toBe(false);
    // Still exit-0 material: learning is disposable derived data, so a
    // garbled state file is a degraded reading, not an unreadable machine.
    expect(payload.ok).toBe(true);
  });

  // --- side-effect freedom ------------------------------------------------

  it("writes nothing at all -- not one byte under the config dir", async () => {
    // THE headline contract: a panel polls this command. Anything it wrote
    // (a rebuilt cache, a lock sidecar, a migrated config) would be a write
    // amplified by the poll interval.
    writeServers([{ namespace: "gh", name: "GitHub", command: "npx", env: { T: "${secret:X}" } }]);
    writeGrades({ gh: { grade: "A", score: 90, gradedAt: "2026-01-01T00:00:00.000Z" } });
    writeState({
      version: STATE_SCHEMA_VERSION,
      savedAt: 1,
      learning: { gh: { dispatched: 4, succeeded: 1, lastUsedAt: 5 } },
      packHistory: [],
      toolCache: {},
    });
    writeFileSync(join(yawMcpDir, SECRETS_FILENAME), "{}", "utf8");

    const before = snapshot(home);
    const io = captureIO();
    await runStatus({ home, cwd: home, env: {}, json: true, out: io.push, err: io.pushErr });
    expect(snapshot(home)).toEqual(before);
  });

  // --- human-readable default ---------------------------------------------

  it("prints a human summary, not JSON, without --json", async () => {
    writeServers([{ namespace: "gh", name: "GitHub", command: "npx" }]);
    const io = captureIO();
    const r = await runStatus({ home, cwd: home, env: {}, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    const text = io.out.join("");
    expect(text).toContain("gh");
    expect(text).toContain("servers:");
    expect(() => JSON.parse(text)).toThrow();
  });

  it("neuters control bytes in a server name before printing it", async () => {
    // bundles.json is a file a repo can ship or a badge can write, so NAME is
    // untrusted: unescaped, an ESC sequence repaints the user's terminal.
    // Same neutering `list` applies to the same cell.
    const esc = String.fromCharCode(0x1b);
    writeServers([{ namespace: "gh", name: `${esc}[31mred`, command: "npx" }]);
    const io = captureIO();
    await runStatus({ home, cwd: home, env: {}, out: io.push, err: io.pushErr });
    expect(io.out.join("")).not.toContain(esc);
  });

  // --- argv ---------------------------------------------------------------

  it("parses --json, --help and rejects anything else", () => {
    expect(parseStatusArgs([])).toEqual({ ok: true, options: {} });
    expect(parseStatusArgs(["--json"])).toEqual({ ok: true, options: { json: true } });
    const help = parseStatusArgs(["--help"]);
    expect(help).toEqual({ ok: false, error: STATUS_USAGE, help: true });
    const bad = parseStatusArgs(["--wat"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain("--wat");
      expect(bad.help).toBeUndefined();
    }
  });
});

/** Every file under `root` as `relative path -> "size:mtimeMs"`. Compared
 *  before and after a run to prove the command touched nothing: a rewritten
 *  file changes mtime even when its length is unchanged, and a created or
 *  deleted one changes the key set. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const st = statSync(full);
      out[relative(root, full)] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}
