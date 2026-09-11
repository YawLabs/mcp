// Doctor's CLIENTS line and install's refusal describe the SAME client config
// file, so doctor's advice has to name a step install will actually take. For
// a malformed file it did not: doctor said "fix or rerun `yaw-mcp install`",
// and `yaw-mcp install <client> --force` then exited 1 on that very file. A
// non-empty array under the container key had the same trap one level down
// ("present, no entry -- run install", and install refuses it).
//
// These run BOTH commands against one fixture. The remedy on each surface comes
// from one helper (unparseableConfigFix / blockedContainerFix in
// install-targets.ts), and the parity tests pin that both call it -- a surface
// that goes back to its own literal goes red here. The last test in each group
// FOLLOWS the advice and checks that the named command then succeeds, because
// advice whose text matches is still wrong if the step does not work.

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../doctor-cmd.js";
import { runInstall } from "../install-cmd.js";
import { blockedContainerFix, ENTRY_NAME, unparseableConfigFix } from "../install-targets.js";
import { parseJsonc } from "../jsonc.js";
import type { OamProbe } from "../oam-spawn.js";

// Neither command may spawn the host's oam: both accept a probe seam.
const OAM_ABSENT = async (): Promise<OamProbe> => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});

// The exact bytes of the reported repro: an object cut off after its first key.
const TRUNCATED = '{"mcpServers": ';

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-remedy-home-"));
  cwd = mkdtempSync(join(tmpdir(), "yaw-mcp-remedy-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** Cursor's user-scope file on linux: `~/.cursor/mcp.json`. */
const cursorUserFile = (): string => join(home, ".cursor", "mcp.json");

function writeFile(path: string, bytes: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

async function doctor() {
  const lines: string[] = [];
  const r = await runDoctor({
    cwd,
    home,
    env: {},
    os: "linux",
    out: (s) => lines.push(s),
    err: () => {},
    oamProbe: OAM_ABSENT,
    skipRegistryCheck: true,
  });
  return { text: lines.join("\n"), exitCode: r.exitCode, snapshot: r.snapshot };
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  const sink = (arr: string[]): NodeJS.WritableStream =>
    new Writable({
      write(chunk: Buffer, _enc, cb): void {
        arr.push(chunk.toString());
        cb();
      },
    }) as unknown as NodeJS.WritableStream;
  return {
    io: { stdin: process.stdin, stdout: sink(out), stderr: sink(err), isTTY: false },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

async function install(flags: { force?: boolean; repair?: boolean; skip?: boolean; dryRun?: boolean } = {}) {
  const cap = captureIo();
  const r = await runInstall({
    clientId: "cursor",
    scope: "user",
    os: "linux",
    home,
    cwd,
    io: cap.io,
    oamProbe: OAM_ABSENT,
    ...flags,
  });
  return { exitCode: r.exitCode, written: r.written, stderr: cap.stderr() };
}

describe("a client config that does not parse -- doctor's advice is a step install takes", () => {
  it("doctor names the client id and the by-hand fix, never a bare rerun", async () => {
    writeFile(cursorUserFile(), TRUNCATED);
    const d = await doctor();
    // Byte-exact: this line is what the user acts on.
    expect(d.text).toContain(
      "Cursor (user): exists but JSON is malformed -- install refuses to overwrite it; fix the JSON by hand, or move the file aside, then run `yaw-mcp install cursor`",
    );
    expect(d.text).not.toContain("fix or rerun");
    // A bare `yaw-mcp install` (no client) is not a command anyone can run.
    expect(d.text).not.toMatch(/`yaw-mcp install`/);
    // Still a cannot-launch state: the wording changed, the exit code did not.
    expect(d.exitCode).toBe(2);
    expect(d.snapshot.config.warnings).toEqual([
      `${cursorUserFile()}: Cursor (user) exists but JSON is malformed -- install refuses to overwrite it; ${unparseableConfigFix("run `yaw-mcp install cursor`")}`,
    ]);
  });

  it("a project-scope row names ITS install command, --scope included", async () => {
    // `yaw-mcp install cursor` would write the USER file and leave this one as
    // broken as it was; the row has to name the command that targets it.
    writeFile(join(cwd, ".cursor", "mcp.json"), TRUNCATED);
    const d = await doctor();
    expect(d.text).toContain(
      `Cursor (project): exists but JSON is malformed -- install refuses to overwrite it; ${unparseableConfigFix("run `yaw-mcp install cursor --scope project`")}`,
    );
  });

  it("parity: doctor and install render the remedy through the one shared helper", async () => {
    const path = writeFile(cursorUserFile(), TRUNCATED);
    const d = await doctor();
    const i = await install({ force: true });
    expect(d.text).toContain(unparseableConfigFix("run `yaw-mcp install cursor`"));
    expect(i.stderr).toContain(`yaw-mcp install: ${path} is not valid JSON (`);
    expect(i.stderr).toContain(`) -- refusing to overwrite it; ${unparseableConfigFix("re-run")}.`);
  });

  // unparseableConfigFix's doc says no flag gets past the refusal; this is what
  // makes "move the file aside" the ONLY way forward, so it is pinned per flag.
  it.each([
    ["--force", { force: true }],
    ["--repair", { repair: true }],
    ["--skip", { skip: true }],
    ["--dry-run", { dryRun: true }],
  ])("install refuses the file under %s and leaves its bytes alone", async (_flag, flags) => {
    const path = writeFile(cursorUserFile(), TRUNCATED);
    const i = await install(flags);
    expect(i.exitCode).toBe(1);
    expect(i.stderr).toContain(unparseableConfigFix("re-run"));
    expect(i.written).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(TRUNCATED);
  });

  it("a root that parses but is not an object: same row, same remedy on both surfaces", async () => {
    const path = writeFile(cursorUserFile(), "[]");
    const d = await doctor();
    const i = await install();
    expect(d.text).toContain(
      `Cursor (user): exists but JSON is malformed -- install refuses to overwrite it; ${unparseableConfigFix("run `yaw-mcp install cursor`")}`,
    );
    expect(i.exitCode).toBe(1);
    expect(i.stderr).toContain(
      `yaw-mcp install: ${path} is not a JSON object -- refusing to overwrite it; ${unparseableConfigFix("re-run")}.`,
    );
  });

  it.each([
    ["moved aside", (path: string) => renameSync(path, `${path}.bak`)],
    ["fixed by hand", (path: string) => writeFileSync(path, '{"mcpServers": {}}')],
  ])("following the advice works: once the file is %s, the named command succeeds", async (_how, follow) => {
    const path = writeFile(cursorUserFile(), TRUNCATED);
    follow(path);
    const i = await install();
    expect(i.exitCode).toBe(0);
    const written = parseJsonc(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers[ENTRY_NAME]).toBeDefined();
  });
});

describe("a container key install cannot splice into -- doctor no longer says 'run install'", () => {
  it("doctor names the key, its shape, and the fix -- and does not call it a warning", async () => {
    writeFile(cursorUserFile(), '{"mcpServers": [{"command": "x"}]}');
    const d = await doctor();
    expect(d.text).toContain(
      'Cursor (user): present, but "mcpServers" is an array of 1, not a JSON object -- install refuses to overwrite it; make it an object (or remove the key), then run `yaw-mcp install cursor`',
    );
    const row = d.snapshot.clients.find((c) => c.clientId === "cursor" && c.scope === "user");
    expect(row?.containerBlocked).toBe('"mcpServers" is an array of 1');
    // Unchanged from the "present, no entry" line it replaces: there is no
    // yaw-mcp entry to fail, so this is advice, not a cannot-launch warning.
    expect(d.snapshot.config.warnings).toEqual([]);
  });

  it("parity: install's refusal carries the same remedy", async () => {
    const path = writeFile(cursorUserFile(), '{"mcpServers": [{"command": "x"}]}');
    const d = await doctor();
    const i = await install();
    expect(d.text).toContain(blockedContainerFix("run `yaw-mcp install cursor`"));
    expect(i.exitCode).toBe(1);
    expect(i.stderr).toContain(
      `yaw-mcp install: "mcpServers" in ${path} is an array of 1, not a JSON object -- refusing to overwrite it; ${blockedContainerFix("re-run")}.`,
    );
  });

  // The other half of findBlockedContainerSegment's split: install REPAIRS these
  // shapes, so doctor's plain "run install" is true for them and must stay.
  it.each([
    ["null", "null"],
    ["an empty array", "[]"],
    ["a string", '"x"'],
    ["a number", "5"],
  ])("a reparable %s container keeps 'run install', and install then succeeds", async (_label, value) => {
    const path = writeFile(cursorUserFile(), `{"mcpServers": ${value}}`);
    const d = await doctor();
    expect(d.text).toContain(`Cursor (user): present, no "${ENTRY_NAME}" entry -- run \`yaw-mcp install cursor\``);
    expect(d.snapshot.clients.find((c) => c.clientId === "cursor" && c.scope === "user")?.containerBlocked).toBe(null);
    const i = await install();
    expect(i.exitCode).toBe(0);
    const written = parseJsonc(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers[ENTRY_NAME]).toBeDefined();
  });

  it("names the blocking key on a nested container path, per scope", async () => {
    // Claude Code's local scope lives at projects.<dir>.mcpServers in
    // ~/.claude.json. A non-empty array at `projects` blocks the LOCAL scope
    // only; the user scope's top-level mcpServers is simply absent.
    writeFile(join(home, ".claude.json"), '{"projects": [1]}');
    const d = await doctor();
    expect(d.text).toContain(
      `Claude Code (local): present, but "projects" is an array of 1, not a JSON object -- install refuses to overwrite it; ${blockedContainerFix("run `yaw-mcp install claude-code --scope local`")}`,
    );
    expect(d.text).toContain(
      `Claude Code (user): present, no "${ENTRY_NAME}" entry -- run \`yaw-mcp install claude-code\``,
    );
  });

  it("following the advice works: once the key is an object, the named command succeeds", async () => {
    const path = writeFile(cursorUserFile(), '{"mcpServers": [{"command": "x"}]}');
    writeFileSync(path, '{"mcpServers": {}}');
    const i = await install();
    expect(i.exitCode).toBe(0);
  });
});

describe("a lone legacy entry -- doctor does not send the user to remove what install removes", () => {
  it("doctor says install migrates it, and install does remove the legacy key", async () => {
    const path = writeFile(cursorUserFile(), '{"mcpServers": {"mcp.hosting": {"command": "npx"}}}');
    const d = await doctor();
    expect(d.text).toContain(
      'Cursor (user): legacy "mcp.hosting" entry present -- run `yaw-mcp install cursor` to migrate; install removes the legacy entry as it writes the new one',
    );
    expect(d.text).not.toContain("remove the legacy entry by hand");
    const i = await install();
    expect(i.exitCode).toBe(0);
    const written = parseJsonc(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers[ENTRY_NAME]).toBeDefined();
    expect(written.mcpServers["mcp.hosting"]).toBeUndefined();
  });
});
