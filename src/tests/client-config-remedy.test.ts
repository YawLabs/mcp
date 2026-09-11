// Doctor's CLIENTS line and install's refusal describe the SAME client config
// file, so doctor's advice has to name a step install will actually take. For
// a malformed file it did not: doctor said "fix or rerun `yaw-mcp install`",
// and `yaw-mcp install <client> --force` then exited 1 on that very file. A
// non-empty array under the container key had the same trap one level down
// ("present, no entry -- run install", and install refuses it).
//
// These run BOTH commands against one fixture. The remedy on each surface comes
// from one helper (unparseableConfigFix / blockedContainerFix in
// install-targets.ts), and the parity tests compare each surface's text with
// that helper's output -- a surface whose wording drifts from the helper goes
// red here. They pin the rendered words, not the call: a surface that swapped
// the helper for an identical literal would stay green. Each group also has a
// test that FOLLOWS the advice and checks that the named command then succeeds,
// because advice whose text matches is still wrong if the step does not work.
//
// `import --remove-originals` is the third surface: when it refuses to remove
// the originals it names `yaw-mcp install <client>` as the way forward, and it
// did so even when install refuses the very file it would write. Its group, at
// the end, runs import, follows the advice, and re-runs import.

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../doctor-cmd.js";
import { runImport } from "../import-cmd.js";
import { runInstall } from "../install-cmd.js";
import {
  blockedContainerFix,
  ENTRY_NAME,
  type InstallClientId,
  type InstallScope,
  resolveInstallPath,
  unparseableConfigFix,
} from "../install-targets.js";
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

  it("following the advice works: install refuses the array as it stands, then succeeds once the key is an object", async () => {
    const blocked = '{"mcpServers": [{"command": "x"}]}';
    const path = writeFile(cursorUserFile(), blocked);
    expect((await doctor()).text).toContain(blockedContainerFix("run `yaw-mcp install cursor`"));
    // The named command, run before the by-hand step, is refused and leaves the
    // array's entries alone -- which is why the line leads with that step.
    const refused = await install();
    expect(refused.exitCode).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(blocked);
    // Follow the advice: make the key an object, then run the named command.
    writeFileSync(path, '{"mcpServers": {}}');
    const i = await install();
    expect(i.exitCode).toBe(0);
    const written = parseJsonc(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers[ENTRY_NAME]).toBeDefined();
    const row = (await doctor()).snapshot.clients.find((c) => c.clientId === "cursor" && c.scope === "user");
    expect(row?.containerBlocked).toBe(null);
    expect(row?.hasMcpEntry).toBe(true);
  });
});

describe("a legacy entry -- doctor does not send the user to remove what install removes", () => {
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

  // The same fact on the three cannot-launch lines, where it rides as a trailer.
  // Each line's remedy is an install run, and install removes the legacy entry
  // in the same write -- off a TTY too, once the collision refusal's --repair is
  // added. The trailer used to say "remove it once the working entry is back",
  // sending the user to delete by hand an entry that run had already removed.
  // Only the bare-oam line offers a step that is not an install run (OAM_BIN),
  // so only it keeps a by-hand clause, and scoped to that step.
  const CANNOT_LAUNCH = [
    {
      state: "a launch command that does not exist",
      says: "its launch command does not exist",
      entry: () => ({ command: join(home, "gone", "oam"), args: ["run", "x.js"] }),
      byHandForOamBin: false,
    },
    {
      state: "an oam entry file that does not exist",
      says: "oam cannot fetch it on demand",
      entry: () => ({
        command: writeFile(join(home, "bin", "oam"), ""),
        args: ["run", "--no-check", join(home, "gone", "broker.js")],
      }),
      byHandForOamBin: false,
    },
    {
      state: "a bare oam command",
      says: "resolves against the client's PATH",
      entry: () => ({ command: "oam", args: ["run", "--no-check", writeFile(join(home, "broker.js"), "")] }),
      byHandForOamBin: true,
    },
  ];

  const cursorUserRow = (text: string): string => text.split("\n").find((l) => l.includes("Cursor (user):")) ?? "";

  it("the launch-missing line, byte for byte: install removes the legacy entry, nothing by hand", async () => {
    const gone = join(home, "gone", "oam");
    writeFile(
      cursorUserFile(),
      JSON.stringify({
        mcpServers: { [ENTRY_NAME]: { command: gone, args: ["run", "x.js"] }, "mcp.hosting": { command: "npx" } },
      }),
    );
    const d = await doctor();
    expect(d.text).toContain(
      `Cursor (user): has "${ENTRY_NAME}" entry, but its launch command does not exist: ${gone} -- the client cannot start yaw-mcp; rerun ` +
        '`yaw-mcp install cursor`; legacy "mcp.hosting" entry also present -- install removes it as it writes the working entry\n',
    );
  });

  it.each(
    CANNOT_LAUNCH,
  )("$state plus a legacy entry: install --repair removes the legacy key, and doctor never asked for it by hand", async ({
    says,
    entry,
    byHandForOamBin,
  }) => {
    const path = writeFile(
      cursorUserFile(),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: entry(), "mcp.hosting": { command: "npx" } } }),
    );
    const row = cursorUserRow((await doctor()).text);
    expect(row).toContain(says);
    expect(row).toContain(
      'legacy "mcp.hosting" entry also present -- install removes it as it writes the working entry',
    );
    expect(row).not.toContain("remove it once the working entry is back");
    const [, afterTrailer] = row.split("install removes it as it writes the working entry");
    if (byHandForOamBin) {
      // The one by-hand clause, and it names the step that does not trim.
      expect(afterTrailer).toBe(
        "; if you set OAM_BIN instead of rerunning install, remove it by hand once the working entry is back",
      );
    } else {
      expect(afterTrailer).toBe("");
      expect(row).not.toContain("by hand");
    }
    // Off a TTY the named rerun is refused with --repair named, and writes
    // nothing: the legacy key is still there at this point.
    const refused = await install();
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("Re-run with --repair");
    const before = parseJsonc(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(before.mcpServers["mcp.hosting"]).toBeDefined();
    // Follow it: the legacy key goes in the same write as the working entry.
    const i = await install({ repair: true });
    expect(i.exitCode).toBe(0);
    const written = parseJsonc(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers[ENTRY_NAME]).toBeDefined();
    expect(written.mcpServers["mcp.hosting"]).toBeUndefined();
    const after = (await doctor()).snapshot.clients.find((c) => c.clientId === "cursor" && c.scope === "user");
    expect(after?.hasLegacyEntry).toBe(false);
    expect(after?.launchCommandMissing).toBe(null);
    expect(after?.launchOamEntryMissing).toBe(null);
    expect(after?.launchOamNotAbsolute).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// import --remove-originals refuses to remove the originals when the client has
// no yaw-mcp entry, and names `yaw-mcp install <client>` as the way forward. It
// read every other scope's container through a helper that turned "cannot
// parse" into "no entry", so for the very file doctor now flags it still said
// "Run `yaw-mcp install cursor` first" -- and that install exits 1 on it. These
// pin that the refusal names install's own by-hand step when the file install
// writes is one it refuses, and keeps the plain advice when it is not.

/** Cursor's project-scope file for the test's project directory. */
const cursorProjectFile = (): string => join(cwd, ".cursor", "mcp.json");

/** A client config with one server of the user's own and no yaw-mcp entry. */
const PROJECT_SERVERS = '{"mcpServers": {"github": {"command": "npx", "args": ["-y", "gh"]}}}';

async function importRemoving(clientId: InstallClientId = "cursor", scope: InstallScope = "project") {
  const out: string[] = [];
  const err: string[] = [];
  const r = await runImport({
    clientId,
    scope,
    // resolveInstallSite refuses --project-dir on a scope that does not read it.
    projectDir: scope === "user" ? undefined : cwd,
    os: "linux",
    home,
    cwd,
    removeOriginals: true,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { exitCode: r.exitCode, stdout: out.join(""), stderr: err.join("") };
}

describe("import --remove-originals -- a client config install refuses gets install's remedy, not 'run install first'", () => {
  it("the reported repro, byte for byte: an unparseable user file while importing at project scope", async () => {
    const user = writeFile(cursorUserFile(), TRUNCATED);
    const project = writeFile(cursorProjectFile(), PROJECT_SERVERS);
    const r = await importRemoving();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain(
      `Not removing the originals: no yaw-mcp entry in ${project} (mcpServers), and ${user} is not valid JSON, so Cursor would be left with no way to reach them. \`yaw-mcp install cursor\` refuses to overwrite ${user}; fix the JSON by hand, or move the file aside, then run \`yaw-mcp install cursor\` and re-run this with --remove-originals.\n`,
    );
    expect(r.stderr).not.toContain("Run `yaw-mcp install cursor` first");
    // The refusal itself is unchanged: neither file is touched.
    expect(readFileSync(project, "utf8")).toBe(PROJECT_SERVERS);
    expect(readFileSync(user, "utf8")).toBe(TRUNCATED);
  });

  it("a non-empty array under the container key, byte for byte", async () => {
    const user = writeFile(cursorUserFile(), '{"mcpServers": [{"command": "x"}]}');
    const project = writeFile(cursorProjectFile(), PROJECT_SERVERS);
    const r = await importRemoving();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain(
      `Not removing the originals: no yaw-mcp entry in ${project} (mcpServers), and "mcpServers" in ${user} is an array of 1, not a JSON object, so Cursor would be left with no way to reach them. \`yaw-mcp install cursor\` refuses to overwrite "mcpServers" in ${user}; make it an object (or remove the key), then run \`yaw-mcp install cursor\` and re-run this with --remove-originals.\n`,
    );
    expect(readFileSync(project, "utf8")).toBe(PROJECT_SERVERS);
  });

  it("a root that parses but is not an object: the same remedy install and doctor give", async () => {
    const user = writeFile(cursorUserFile(), "[]");
    const project = writeFile(cursorProjectFile(), PROJECT_SERVERS);
    const r = await importRemoving();
    expect(r.stderr).toContain(
      `Not removing the originals: no yaw-mcp entry in ${project} (mcpServers), and ${user} is not a JSON object, so Cursor would be left with no way to reach them. \`yaw-mcp install cursor\` refuses to overwrite ${user}; ${unparseableConfigFix("run `yaw-mcp install cursor` and re-run this with --remove-originals")}.\n`,
    );
  });

  it("a directory where the user file belongs: named the way install names it", async () => {
    const user = cursorUserFile();
    mkdirSync(user, { recursive: true });
    const project = writeFile(cursorProjectFile(), PROJECT_SERVERS);
    const r = await importRemoving();
    expect(r.stderr).toContain(
      `Not removing the originals: no yaw-mcp entry in ${project} (mcpServers), and ${user} is a directory, not a file, so Cursor would be left with no way to reach them. \`yaw-mcp install cursor\` cannot read ${user}; move or remove it, then run \`yaw-mcp install cursor\` and re-run this with --remove-originals.\n`,
    );
    // The wording import claims to share with install's describeUnreadableConfig.
    const i = await install();
    expect(i.exitCode).toBe(1);
    expect(i.stderr).toContain(`${user} is a directory, not a file -- move or remove it, then re-run.`);
  });

  it.each([
    {
      shape: "an unparseable file moved aside",
      setup: (u: string) => writeFile(u, TRUNCATED),
      follow: (u: string) => renameSync(u, `${u}.bak`),
    },
    {
      shape: "an unparseable file fixed by hand",
      setup: (u: string) => writeFile(u, TRUNCATED),
      follow: (u: string) => writeFileSync(u, '{"mcpServers": {}}'),
    },
    {
      shape: "a blocked container made an object",
      setup: (u: string) => writeFile(u, '{"mcpServers": [{"command": "x"}]}'),
      follow: (u: string) => writeFileSync(u, '{"mcpServers": {}}'),
    },
    {
      shape: "a directory moved aside",
      setup: (u: string) => mkdirSync(u, { recursive: true }),
      follow: (u: string) => renameSync(u, `${u}.aside`),
    },
  ])("following the advice works: $shape, then the named install, then the re-run removes the original", async ({
    setup,
    follow,
  }) => {
    const user = cursorUserFile();
    setup(user);
    const project = writeFile(cursorProjectFile(), PROJECT_SERVERS);
    expect((await importRemoving()).stderr).toContain("Not removing the originals");
    follow(user);
    expect((await install()).exitCode).toBe(0);
    const again = await importRemoving();
    expect(again.exitCode).toBe(0);
    expect(again.stderr).not.toContain("Not removing the originals");
    const after = parseJsonc(readFileSync(project, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers).toEqual({});
  });

  it("a refused file that is NOT the one install writes keeps 'run install first' -- and that step works", async () => {
    // Imported from the USER file; the project file beside it is cut off. A
    // bare install writes the user file, so the plain advice is true here --
    // but the cut-off file is named for what it is, not as "no entry".
    const user = writeFile(cursorUserFile(), PROJECT_SERVERS);
    const project = writeFile(cursorProjectFile(), TRUNCATED);
    const r = await importRemoving("cursor", "user");
    expect(r.stderr).toContain(
      `Not removing the originals: no yaw-mcp entry in ${user} (mcpServers), and ${project} is not valid JSON, so Cursor would be left with no way to reach them. Run \`yaw-mcp install cursor\` first, then re-run this with --remove-originals.\n`,
    );
    expect((await install()).exitCode).toBe(0);
    const again = await importRemoving("cursor", "user");
    expect(again.stderr).not.toContain("Not removing the originals");
    const after = parseJsonc(readFileSync(user, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(after.mcpServers)).toEqual([ENTRY_NAME]);
  });

  // The shapes install writes over by itself: an empty file is treated as
  // absent, and null / a scalar / an empty array under the key is replaced with
  // `{}`. For these "run install first" is true and must stay.
  it.each([
    ["an empty file", ""],
    ["a whitespace-only file", "  \n"],
    ["a null container", '{"mcpServers": null}'],
    ["an empty-array container", '{"mcpServers": []}'],
  ])("%s is no refusal, so the advice stays 'run install first' -- and that install succeeds", async (_label, bytes) => {
    const user = writeFile(cursorUserFile(), bytes);
    const project = writeFile(cursorProjectFile(), PROJECT_SERVERS);
    const r = await importRemoving();
    expect(r.stderr).toContain(
      `Not removing the originals: no yaw-mcp entry in ${project} (mcpServers) or ${user} (mcpServers), so Cursor would be left with no way to reach them. Run \`yaw-mcp install cursor\` first, then re-run this with --remove-originals.\n`,
    );
    expect((await install()).exitCode).toBe(0);
  });

  it("an absent user file is no refusal either -- install creates it", async () => {
    const user = cursorUserFile();
    const project = writeFile(cursorProjectFile(), PROJECT_SERVERS);
    const r = await importRemoving();
    expect(r.stderr).toContain(
      `Not removing the originals: no yaw-mcp entry in ${project} (mcpServers) or ${user} (mcpServers), so Cursor would be left with no way to reach them. Run \`yaw-mcp install cursor\` first, then re-run this with --remove-originals.\n`,
    );
    expect((await install()).exitCode).toBe(0);
  });

  it("one clause per fault: Claude Code's user and local scopes share one unparseable ~/.claude.json", async () => {
    const claudeJson = writeFile(join(home, ".claude.json"), TRUNCATED);
    const project = resolveInstallPath({
      clientId: "claude-code",
      scope: "project",
      os: "linux",
      projectDir: cwd,
      home,
    });
    writeFile(project.absolute, PROJECT_SERVERS);
    const r = await importRemoving("claude-code", "project");
    expect(r.stderr).toContain(
      `Not removing the originals: no yaw-mcp entry in ${project.absolute} (${project.containerPath.join(".")}), and ${claudeJson} is not valid JSON, so Claude Code would be left with no way to reach them. \`yaw-mcp install claude-code\` refuses to overwrite ${claudeJson}; ${unparseableConfigFix("run `yaw-mcp install claude-code` and re-run this with --remove-originals")}.\n`,
    );
    expect(r.stderr.split("is not valid JSON").length - 1).toBe(1);
  });
});
