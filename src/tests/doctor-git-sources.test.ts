// doctor's git sources block: one row per git entry, read from build markers,
// `.failed` records and git/state.json only. A missing, failed or foreign build
// is a warning (exit 2); "behind" comes from the last update --check, never
// from asking the remote.
//
// Its own file because the child_process spy is module-scoped.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnCalls } = vi.hoisted(() => ({ spawnCalls: [] as string[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const record =
    <F extends (...a: never[]) => unknown>(name: string, fn: F) =>
    (...a: Parameters<F>): ReturnType<F> => {
      spawnCalls.push(`${name} ${JSON.stringify(a.slice(0, 2))}`);
      return fn(...a) as ReturnType<F>;
    };
  return {
    ...actual,
    spawn: record("spawn", actual.spawn),
    spawnSync: record("spawnSync", actual.spawnSync),
    execFile: record("execFile", actual.execFile),
    execFileSync: record("execFileSync", actual.execFileSync),
    exec: record("exec", actual.exec),
    execSync: record("execSync", actual.execSync),
  };
});

const { runDoctor } = await import("../doctor-cmd.js");
const { gitAvailable } = await import("../git-source.js");
const { CONFIG_DIRNAME, gitBuildDir, gitFailedPath, gitRoot } = await import("../paths.js");
const { TRUST_BYPASS_ENV } = await import("../trust.js");
const { fakeFinishedBuild } = await import("./git-fixture.js");

const OK = "1111111111111111111111111111111111111111";
const BEHIND = "4b77e0d000000000000000000000000000000000";
const MISSING = "2222222222222222222222222222222222222222";
const FAILED = "3333333333333333333333333333333333333333";
const FOREIGN = "5555555555555555555555555555555555555555";
const TAGGED = "6666666666666666666666666666666666666666";
const URL = "git@github.com:acme/tools-mcp.git";
const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const TWO_HOURS_AGO = new Date(NOW - 2 * 3600_000).toISOString();

let home: string;
let cwd: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "yaw-doctor-git-")));
  cwd = realpathSync(mkdtempSync(join(home, "cwd-")));
  spawnCalls.length = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function entry(namespace: string, git: Record<string, unknown>): Record<string, unknown> {
  return {
    namespace,
    name: namespace,
    type: "local",
    transport: "stdio",
    git: { url: URL, entry: "dist/index.js", ...git },
  };
}

function writeBundles(servers: unknown[]): void {
  mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
  writeFileSync(join(home, ".yaw-mcp", "bundles.json"), JSON.stringify({ version: 1, servers }));
}

function writeMarker(ns: string, commit: string, over: Record<string, string> = {}): void {
  fakeFinishedBuild(gitBuildDir(ns, commit, home), commit, {
    entry: "dist/index.js",
    marker: { url: URL, pmVersion: "10.9.0", builtAt: "2026-11-01T00:00:00.000Z", ...over },
  });
}

function writeState(entries: Record<string, unknown>): void {
  mkdirSync(gitRoot(home), { recursive: true });
  writeFileSync(join(gitRoot(home), "state.json"), JSON.stringify({ version: 1, entries }));
}

function stateFor(pinned: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: URL,
    ref: "main",
    kind: "branch",
    pinned,
    remote: pinned,
    newerTags: [],
    checkedAt: TWO_HOURS_AGO,
    ...over,
  };
}

const oamNotInstalled = () => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});

async function doctor(
  json: boolean,
  over: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number; text: string; err: string }> {
  const lines: string[] = [];
  const err: string[] = [];
  const r = await runDoctor({
    cwd,
    home,
    env: over.env ?? {},
    os: "linux",
    json,
    out: (s) => lines.push(s),
    err: (s) => err.push(s),
    skipRegistryCheck: true,
    oamProbe: oamNotInstalled,
    now: () => NOW,
  });
  return { exitCode: r.exitCode, text: r.lines.join("\n"), err: err.join("") };
}

/** Same run, but the servers come from a PROJECT bundles.json (the trust
 *  bypass makes the loader honour it -- doctor threads its own env to the
 *  loader), which is what sets the `project` flag on the git rows. */
async function projectDoctor(
  servers: unknown[],
  json: boolean,
): Promise<{ exitCode: number; text: string; err: string }> {
  mkdirSync(join(cwd, CONFIG_DIRNAME), { recursive: true });
  writeFileSync(join(cwd, CONFIG_DIRNAME, "bundles.json"), JSON.stringify({ version: 1, servers }));
  return doctor(json, { env: { [TRUST_BYPASS_ENV]: "1" } });
}

function fullFixture(): void {
  writeBundles([
    entry("acme_ok", { ref: "main", commit: OK }),
    entry("acme_missing", { ref: "main", commit: MISSING }),
    entry("acme_failed", { ref: "main", commit: FAILED }),
    entry("acme_foreign", { ref: "main", commit: FOREIGN }),
    entry("acme_tagged", { ref: "v1.4.0", commit: TAGGED }),
    entry("acme_floating", { ref: "main" }),
  ]);
  writeMarker("acme_ok", OK);
  writeMarker("acme_foreign", FOREIGN, { platform: "darwin", arch: "x64", node: "v20.11.1" });
  writeMarker("acme_tagged", TAGGED);
  mkdirSync(join(gitRoot(home), "acme_failed"), { recursive: true });
  writeFileSync(
    gitFailedPath("acme_failed", FAILED, home),
    JSON.stringify({ step: "install", tail: "npm ERR! code E404\nnpm ERR! not found" }),
  );
  writeState({
    acme_ok: stateFor(OK, { remote: BEHIND }),
    acme_tagged: stateFor(TAGGED, { ref: "v1.4.0", kind: "tag", newerTags: ["v1.4.1", "v1.5.0"] }),
  });
}

/** The hint a repo with no script consent here adds to "not built". */
const NO_CONSENT =
  " (off a TTY: yaw-mcp sidecars install --yes, which allows the repo's install and build scripts to run, asked once per repo)";

describe("doctor git sources", () => {
  it("--json mirrors one row per git entry, with the build verdict and the last recorded check", async () => {
    fullFixture();
    const r = await doctor(true);
    const parsed = JSON.parse(r.text);
    const rows = parsed.oamRuntime.git as Array<Record<string, unknown>>;
    expect(rows.map((g) => [g.namespace, g.build])).toEqual([
      ["acme_ok", "ok"],
      ["acme_missing", "missing"],
      ["acme_failed", "failed"],
      ["acme_foreign", "mismatch"],
      ["acme_tagged", "ok"],
      ["acme_floating", "no-commit"],
    ]);
    expect(rows[0]).toEqual({
      namespace: "acme_ok",
      ref: "main",
      commit: OK,
      build: "ok",
      failedStep: null,
      builtFor: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pm: "npm",
        builtAt: "2026-11-01T00:00:00.000Z",
      },
      remote: { checkedAt: TWO_HOURS_AGO, kind: "branch", commit: BEHIND, behind: true, newerTags: [] },
    });
    expect(rows[2]).toMatchObject({ failedStep: "install", builtFor: null, remote: null });
    expect(rows[4]).toMatchObject({ remote: { kind: "tag", behind: false, newerTags: ["v1.4.1", "v1.5.0"] } });
    // The remedy rides the row too, so a --json consumer reads the same text
    // the warnings carry without re-deriving it from `build`.
    expect(rows[1].warning).toBe(
      `"acme_missing" is not built on this machine (git 2222222). Run: yaw-mcp sidecars install${NO_CONSENT}`,
    );
    expect(rows[3].warning).toContain("Rebuild: yaw-mcp update acme_foreign --to 5555555");
    expect(rows[0].warning).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain(URL);

    expect(r.exitCode).toBe(2);
    expect(parsed.diagnosis.exitCode).toBe(2);
    const warnings = parsed.warnings as string[];
    expect(warnings).toContain(
      `"acme_missing" is not built on this machine (git 2222222). Run: yaw-mcp sidecars install${NO_CONSENT}`,
    );
    expect(warnings).toContain(
      `"acme_failed" is not built on this machine (git 3333333). Run: yaw-mcp sidecars install${NO_CONSENT}. Its last build failed at install: npm ERR! code E404 | npm ERR! not found`,
    );
    const major = /^v(\d+)/.exec(process.version)?.[1];
    expect(warnings).toContain(
      `acme_foreign was built on darwin-x64 node 20; this is ${process.platform}-${process.arch} node ${major}. Rebuild: yaw-mcp update acme_foreign --to 5555555`,
    );
    expect(warnings.filter((w) => w.includes("acme_ok") || w.includes("acme_tagged"))).toEqual([]);
    expect(warnings.filter((w) => w.includes("acme_floating"))).toHaveLength(1);
    expect(r.err).toContain("warning: acme_foreign was built on darwin-x64");
  });

  it("prints the block in OAM RUNTIME with the same warnings in WARNINGS", async () => {
    fullFixture();
    const r = await doctor(false);
    const nodeShort = process.version.replace(/^v/, "").split(".").slice(0, 2).join(".");
    const host = `node ${nodeShort} ${process.platform}-${process.arch}`;
    expect(r.text).toContain("  git sources:");
    expect(r.text).toContain(`    acme_ok        1111111 (main; behind 4b77e0d as of 2h ago)  built ok  ${host}`);
    expect(r.text).toContain("    acme_missing   2222222 (main; not checked)  not built");
    expect(r.text).toContain("    acme_failed    3333333 (main; not checked)  build failed at install");
    expect(r.text).toContain(
      "    acme_foreign   5555555 (main; not checked)  built for another machine  node 20.11 darwin-x64",
    );
    expect(r.text).toContain(
      `    acme_tagged    6666666 (v1.4.0; newer tags v1.4.1, v1.5.0 as of 2h ago)  built ok  ${host}`,
    );
    expect(r.text).toContain("    acme_floating  (main)  no commit pinned");
    expect(r.text.indexOf("  git sources:")).toBeGreaterThan(r.text.indexOf("OAM RUNTIME"));
    expect(r.text).toContain("  ! acme_foreign was built on darwin-x64");
    expect(r.exitCode).toBe(2);
    const gitLines = r.text.split("\n").filter((l) => l.includes("acme_"));
    expect(gitLines.length).toBeGreaterThan(6);
    expect(gitLines.filter((l) => !/^[\x20-\x7e]*$/.test(l))).toEqual([]);
  });

  it("reads a check recorded for an older pin or another url as not checked", async () => {
    writeBundles([entry("acme_a", { ref: "main", commit: OK }), entry("acme_b", { ref: "main", commit: TAGGED })]);
    writeMarker("acme_a", OK);
    writeMarker("acme_b", TAGGED);
    writeState({
      acme_a: stateFor(MISSING, { remote: BEHIND }),
      acme_b: stateFor(TAGGED, { url: "git@github.com:other/repo.git", remote: BEHIND }),
    });
    const parsed = JSON.parse((await doctor(true)).text);
    expect(parsed.oamRuntime.git.map((g: { remote: unknown }) => g.remote)).toEqual([null, null]);
  });

  it("an up-to-date, matching build adds no warning and exits 0", async () => {
    writeBundles([entry("acme_ok", { ref: "main", commit: OK })]);
    writeMarker("acme_ok", OK);
    writeState({ acme_ok: stateFor(OK) });
    const r = await doctor(false);
    expect(r.text).toContain("1111111 (main; up to date as of 2h ago)  built ok");
    expect(r.exitCode).toBe(0);
  });

  it("omits the block, and the field stays an empty array, with no git entries", async () => {
    writeBundles([{ namespace: "plain", name: "plain", command: "node", args: ["x.js"] }]);
    expect((await doctor(false)).text).not.toContain("git sources:");
    expect(JSON.parse((await doctor(true)).text).oamRuntime.git).toEqual([]);
  });

  it("a mismatch rebuild hint carries --project when the config came from a project bundles.json", async () => {
    // The same foreign build: once as a user-file row (plain hint) and once
    // as a project-file row (the flag appended).
    writeBundles([entry("acme_foreign", { ref: "main", commit: FOREIGN })]);
    writeMarker("acme_foreign", FOREIGN, { platform: "darwin", arch: "x64", node: "v20.11.1" });
    const major = /^v(\d+)/.exec(process.version)?.[1];
    const userRun = await doctor(true);
    expect(userRun.text).toContain("Rebuild: yaw-mcp update acme_foreign --to 5555555");
    expect(userRun.text).not.toContain("--to 5555555 --project");

    const projectRun = await projectDoctor([entry("acme_foreign", { ref: "main", commit: FOREIGN })], true);
    const rows = JSON.parse(projectRun.text).oamRuntime.git as Array<Record<string, unknown>>;
    expect(rows[0].warning).toBe(
      `acme_foreign was built on darwin-x64 node 20; this is ${process.platform}-${process.arch} node ${major}. Rebuild: yaw-mcp update acme_foreign --to 5555555 --project`,
    );
    expect(projectRun.text).toContain("Rebuild: yaw-mcp update acme_foreign --to 5555555 --project");
  });

  it("gitRemoteText: a sha-kind row reads pinned, checked; a branch whose remote commit is null reads not on the remote; a tag with no newer tags reads no newer tag", async () => {
    const SHA = "7777777777777777777777777777777777777777";
    const NULLED = "8888888888888888888888888888888888888888";
    const NOTAG = "9999999999999999999999999999999999999999";
    writeBundles([
      entry("acme_sha", { ref: SHA, commit: SHA }),
      entry("acme_gone", { ref: "main", commit: NULLED }),
      entry("acme_tag", { ref: "v1.4.0", commit: NOTAG }),
    ]);
    writeMarker("acme_sha", SHA);
    writeMarker("acme_gone", NULLED);
    writeMarker("acme_tag", NOTAG);
    writeState({
      acme_sha: stateFor(SHA, { ref: SHA, kind: "sha", remote: SHA }),
      acme_gone: stateFor(NULLED, { kind: "branch", remote: null }),
      acme_tag: stateFor(NOTAG, { ref: "v1.4.0", kind: "tag", newerTags: [] }),
    });
    const r = await doctor(false);
    expect(r.text).toContain(`${SHA.slice(0, 7)} (${SHA}; pinned, checked 2h ago)`);
    expect(r.text).toContain(`${NULLED.slice(0, 7)} (main; not on the remote as of 2h ago)`);
    expect(r.text).toContain(`${NOTAG.slice(0, 7)} (v1.4.0; no newer tag as of 2h ago)`);
    expect(r.exitCode).toBe(0);
  });

  it("never spawns git, on either path", async () => {
    fullFixture();
    await doctor(true);
    await doctor(false);
    expect(spawnCalls.filter((c) => /git/i.test(c))).toEqual([]);
    // The spy sees a real git spawn, so the empty list above is not a blind spot.
    await gitAvailable({ env: process.env, interactive: false });
    expect(spawnCalls.some((c) => /git/i.test(c))).toBe(true);
  });
});
