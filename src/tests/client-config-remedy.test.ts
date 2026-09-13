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
// did so even when install refuses the very file it would write. Its group
// runs import, follows the advice, and re-runs import.
//
// The last two groups are a STRICT-JSON file its client cannot load (a comment
// in Claude Code's project `.mcp.json`): the same parity over
// unloadableConfigProblem / unloadableConfigFix, and the import case where
// calling such a file "wired" deleted servers from a config that was loading
// them -- pinned byte for byte on the file that lost them.

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type StrictViolation, unloadableConfigProblem } from "../client-config.js";
import { readStrictJson } from "../client-config-json.js";
import { runDoctor } from "../doctor-cmd.js";
import { runImport } from "../import-cmd.js";
import { runInstall } from "../install-cmd.js";
import {
  blockedContainerFix,
  ENTRY_NAME,
  type InstallClientId,
  type InstallScope,
  resolveInstallPath,
  unloadableConfigFix,
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

/** `env` is a parameter so one test can run doctor twice over one fixture, with
 *  and without OAM_BIN, and compare the bytes. Every other call takes the empty
 *  default. */
async function doctor(env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const r = await runDoctor({
    cwd,
    home,
    env,
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
  //
  // All THREE, the bare-oam line included. It kept a by-hand clause for the
  // reader who "set OAM_BIN instead of rerunning install" -- a state that does
  // not exist. OAM_BIN is read inside yaw-mcp's own process, so it steers which
  // binary INSTALL writes; the client spawns the stored bare `oam` against its
  // own PATH, and doctor computes this row from that stored token and is handed
  // no env at all. Setting it cannot restore the working entry, so it cannot
  // leave a legacy entry outliving one -- pinned below by the OAM_BIN test,
  // which runs doctor over one fixture twice and compares the bytes.
  const CANNOT_LAUNCH = [
    {
      state: "a launch command that does not exist",
      says: "its launch command does not exist",
      entry: () => ({ command: join(home, "gone", "oam"), args: ["run", "x.js"] }),
    },
    {
      state: "an oam entry file that does not exist",
      says: "oam cannot fetch it on demand",
      entry: () => ({
        command: writeFile(join(home, "bin", "oam"), ""),
        args: ["run", "--no-check", join(home, "gone", "broker.js")],
      }),
    },
    {
      state: "a bare oam command",
      says: "resolves against the client's PATH",
      entry: () => ({ command: "oam", args: ["run", "--no-check", writeFile(join(home, "broker.js"), "")] }),
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
    // The trailer is the END of the line on all three: nothing walks it back,
    // and no clause after it asks for a by-hand removal.
    const [, afterTrailer] = row.split("install removes it as it writes the working entry");
    expect(afterTrailer).toBe("");
    expect(row).not.toContain("by hand");
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

  /** The bare-`oam` fixture: a launch command the client resolves against its
   *  own PATH, plus a legacy entry. Shared by the two tests below so the
   *  byte-exact wording and the OAM_BIN comparison cannot drift apart. */
  const writeBareOamPlusLegacy = (): string =>
    writeFile(
      cursorUserFile(),
      JSON.stringify({
        mcpServers: {
          [ENTRY_NAME]: { command: "oam", args: ["run", "--no-check", writeFile(join(home, "broker.js"), "")] },
          "mcp.hosting": { command: "npx" },
        },
      }),
    );

  it("the bare-oam line, byte for byte: OAM_BIN is a precondition of the rerun, and nothing is left by hand", async () => {
    writeBareOamPlusLegacy();
    const d = await doctor();
    expect(d.text).toContain(
      `Cursor (user): has "${ENTRY_NAME}" entry with a bare "oam" command -- it resolves against the client's PATH, ` +
        "which a GUI-launched client does not inherit from your shell; rerun `yaw-mcp install cursor` to write an " +
        'absolute path (set OAM_BIN to oam\'s full path first if install cannot find it); legacy "mcp.hosting" ' +
        "entry also present -- install removes it as it writes the working entry\n",
    );
    // Not "or set OAM_BIN": the var is not a second remedy. Nothing it can do
    // rewrites this entry, so no branch of this line may offer it as one.
    expect(d.text).not.toContain("or set OAM_BIN");
  });

  it("setting OAM_BIN changes nothing doctor says about the entry", async () => {
    writeBareOamPlusLegacy();
    // The value install would be told to use: an absolute path to a real file,
    // the shape the line's parenthetical asks for.
    const oamBin = writeFile(join(home, "opt", "oam"), "");
    const withOut = await doctor();
    const withSet = await doctor({ OAM_BIN: oamBin });
    // Whole output, not just the row: doctor is handed the var and still has
    // nowhere to spend it on a client entry. (The OAM RUNTIME section does read
    // a real OAM_BIN through probeOam -- seamed to OAM_ABSENT here, which is
    // what makes the rest of the report comparable.) Only the run's own header
    // timestamp is normalised away; it differs between any two runs, OAM_BIN or
    // not, and runDoctor has no clock seam to pin it with.
    const stamp = (t: string): string => t.replace(/^yaw-mcp doctor -- .*$/m, "yaw-mcp doctor");
    expect(stamp(withSet.text)).toBe(stamp(withOut.text));
    expect(withSet.exitCode).toBe(withOut.exitCode);
    const row = cursorUserRow(withSet.text);
    expect(row).toContain('has "mcp" entry with a bare "oam" command');
    // The var's own name appears once, inside the rerun's parenthetical, and
    // the path it was set to appears nowhere.
    expect(row.split("OAM_BIN").length - 1).toBe(1);
    expect(withSet.text).not.toContain(oamBin);
  });

  // Everything above pins the rendered STRINGS. This pins the premise they
  // were derived from: the field every one of those lines reads carried a doc
  // comment making the claim the lines dropped -- "Surfaced so upgraded users know to
  // trim by hand -- nothing in the runtime writes this key anymore" (a4a204d,
  // predating any of this and untouched by the fix). A comment is not
  // executable, so no assertion above could go red on it, and the next caller
  // to print from this field takes its word. `install` is the remover on every
  // path that writes: the same write as the working entry, or the run's only
  // edit when that entry is already correct (install-cmd.ts, `trimLegacy` /
  // the `skipEntryWrite` removeJsoncEntry branch), unless `--keep-legacy`.
  it("the fields those lines read do not document a by-hand trim", () => {
    const src = readFileSync(fileURLToPath(new URL("../doctor-cmd.ts", import.meta.url)), "utf8");
    /** The contiguous doc block immediately above a field declaration, comment
     *  furniture stripped and rejoined. THROWS rather than returning "" when
     *  the field or its block is missing: a scan that quietly finds nothing
     *  satisfies every assertion made about it. */
    const docFor = (decl: string): string => {
      const lines = src.split("\n");
      const at = lines.findIndex((l) => l.trim() === decl);
      if (at < 0) throw new Error(`no declaration \`${decl}\` in doctor-cmd.ts`);
      let start = at;
      while (start > 0 && /^\s*(\/\*\*|\*)/.test(lines[start - 1])) start -= 1;
      if (!/^\s*\/\*\*/.test(lines[start])) throw new Error(`no doc comment above \`${decl}\``);
      return lines
        .slice(start, at)
        .map((l) =>
          l
            .replace(/^\s*\/?\*+/, "")
            .replace(/\*\/\s*$/, "")
            .trim(),
        )
        .join(" ")
        .trim();
    };
    expect(() => docFor("noSuchField: boolean;")).toThrow(/no declaration/);

    const legacyDoc = docFor("hasLegacyEntry: boolean;");
    const nameDoc = docFor("legacyEntryName: string | null;");
    // Anchors: the blocks were found, so the assertions below are about real
    // text rather than about an empty string.
    expect(legacyDoc).toContain("Pre-rename");
    expect(nameDoc).toContain("legacy entry key");
    for (const doc of [legacyDoc, nameDoc]) expect(doc).not.toMatch(/by[ -]hand/i);
    // And the remover is named, so a reader does not have to infer it from the
    // status lines: install trims the key in the run those lines send you to.
    expect(legacyDoc).toContain("install removes it");
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
  return { exitCode: r.exitCode, written: r.written, stdout: out.join(""), stderr: err.join("") };
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

// ---------------------------------------------------------------------------
// A STRICT-JSON client config that yaw-mcp reads and its client does not.
// Claude Code parses the project `.mcp.json` with JSON.parse, so one comment or
// one trailing comma means it loads NO server from that file -- a yaw-mcp entry
// in it included -- while yaw-mcp's lenient parser reads every entry. Each
// surface used to describe that file from yaw-mcp's side of the parse: install
// printed success over an entry that was already there, and import called the
// entry "wired", which is the answer that deletes servers.
//
// The clause comes from unloadableConfigProblem and the fix from
// unloadableConfigFix. The violation both are composed from is readStrictJson's
// -- the one client-side parse the write facade, doctor's probe and import's
// view all route through -- so the expected text is the helpers' output over
// the fixture's own bytes, never a hand-copied literal.

const mcpJsonFile = (): string => join(cwd, ".mcp.json");
const claudeJsonFile = (): string => join(home, ".claude.json");

/** A yaw-mcp entry as a hand-written or older `.mcp.json` carries it. Its launch
 *  command is beside the point: every surface checks loadability ahead of any
 *  entry state. */
const YAW_ENTRY = { command: "npx", args: ["-y", "@yawlabs/mcp"] };

/** The two shapes the helpers' wording names, applied to a strict-valid body.
 *
 *  The comment is LONGER than the ~10 source bytes V8 quotes into a JSON.parse
 *  "Unexpected token" message. A shorter one (`// c` then a newline) puts that
 *  raw newline -- or any control byte the file holds -- into the violation's
 *  `detail`, which every surface interpolates unescaped, so the one-line row
 *  and refusal split in two. That is a source defect, not a wording rule, and
 *  is not pinned here as if it were behaviour. */
const UNLOADABLE_SHAPES = [
  ["a comment", (json: string): string => `// shared with the team -- keep this list short\n${json}`],
  ["a trailing comma", (json: string): string => json.replace(/\}\s*$/, ",}")],
] as const;

/** The client's own verdict on `raw`. THROWS when the client would load the
 *  file: a clause composed from no violation would make every wording
 *  assertion below compare one wrong string with another. */
function violationOf(raw: string): StrictViolation {
  const r = readStrictJson(raw);
  if (r.ok) throw new Error(`fixture parses as strict JSON, so it is not unloadable: ${raw}`);
  return r.violation;
}

const linesOf = (s: string): string[] => s.split(/\r?\n/);

/** Doctor's CLIENTS row for one label, from the label to the end of its line.
 *  Exactly one row must carry the label, or the assertion is about the wrong
 *  line. */
function doctorRow(text: string, label: string): string {
  const rows = linesOf(text).filter((l) => l.includes(`${label}:`));
  expect(rows).toHaveLength(1);
  return rows[0].slice(rows[0].indexOf(`${label}:`));
}

async function installClaudeCode(
  scope: InstallScope,
  flags: { force?: boolean; repair?: boolean; skip?: boolean; dryRun?: boolean } = {},
) {
  const cap = captureIo();
  const r = await runInstall({
    clientId: "claude-code",
    scope,
    os: "linux",
    home,
    cwd,
    io: cap.io,
    oamProbe: OAM_ABSENT,
    ...flags,
  });
  return { exitCode: r.exitCode, written: r.written, stdout: cap.stdout(), stderr: cap.stderr() };
}

/** Did this install run tell the user the client is configured -- either of the
 *  two success lines ("Nothing to do", "Done:"), whichever path it took. */
const saysConfigured = (stdout: string): boolean =>
  linesOf(stdout).some((l) => l.includes("Nothing to do") || l.startsWith("Done:"));

/** install's refusal line for an unloadable file, from the two helpers. */
const installRefusal = (path: string, raw: string): string =>
  `yaw-mcp install: ${path} ${unloadableConfigProblem(violationOf(raw))} -- refusing to write into it; ${unloadableConfigFix("re-run")}.`;

const PROJECT_INSTALL = "yaw-mcp install claude-code --scope project";

describe("a strict .mcp.json its client cannot load -- doctor and install name one fault and one fix", () => {
  it.each(
    UNLOADABLE_SHAPES,
  )("%s: doctor's row and install's refusal, byte for byte, from the shared helpers", async (_shape, spoil) => {
    const bytes = spoil(PROJECT_SERVERS);
    const path = writeFile(mcpJsonFile(), bytes);
    const problem = unloadableConfigProblem(violationOf(bytes));
    const d = await doctor();
    expect(doctorRow(d.text, "Claude Code (project)")).toBe(
      `Claude Code (project): exists but ${problem} -- install refuses to write into it; ${unloadableConfigFix(`run \`${PROJECT_INSTALL}\``)}`,
    );
    const row = d.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "project");
    expect(row?.unloadable).toBe(problem);
    // No yaw-mcp entry in the file: advice, not a cannot-launch warning.
    expect(row?.hasMcpEntry).toBe(false);
    expect(d.snapshot.config.warnings).toEqual([]);

    const i = await installClaudeCode("project");
    expect(i.exitCode).toBe(1);
    expect(linesOf(i.stderr).filter((l) => l !== "")).toEqual([installRefusal(path, bytes)]);
    expect(i.written).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it("one fixture, all three surfaces: doctor, install and import print the one clause for the file", async () => {
    const user = writeFile(claudeJsonFile(), CLAUDE_JSON_WITH_SERVER);
    const bytes = UNLOADABLE_SHAPES[0][1](PROJECT_SERVERS);
    const project = writeFile(mcpJsonFile(), bytes);
    const problem = unloadableConfigProblem(violationOf(bytes));
    const local = claudeLocal();

    const d = await doctor();
    expect(doctorRow(d.text, "Claude Code (project)")).toBe(
      `Claude Code (project): exists but ${problem} -- install refuses to write into it; ${unloadableConfigFix(`run \`${PROJECT_INSTALL}\``)}`,
    );
    const i = await installClaudeCode("project");
    expect(linesOf(i.stderr).filter((l) => l !== "")).toEqual([installRefusal(project, bytes)]);
    // import names the same file with the same clause. Its NEXT STEP is not
    // unloadableConfigFix, and correctly so: import's install step is the one a
    // bare `yaw-mcp install claude-code` takes, which writes ~/.claude.json --
    // a file its client loads -- not this one.
    const r = await importRemoving("claude-code", "user");
    expect(linesOf(r.stderr)).toContain(
      `Not removing the originals: no yaw-mcp entry in ${user} (mcpServers) or ${local.absolute} (${local.containerPath.join(".")}), and ${project} ${problem}, so Claude Code would be left with no way to reach them. Run \`yaw-mcp install claude-code\` first, then re-run this with --remove-originals.`,
    );
    expect(readFileSync(user)).toEqual(Buffer.from(CLAUDE_JSON_WITH_SERVER));
    expect(readFileSync(project)).toEqual(Buffer.from(bytes));
  });

  it("with the yaw-mcp entry in it, doctor's row is a cannot-launch warning: that entry is present and not loading", async () => {
    const bytes = UNLOADABLE_SHAPES[0][1](JSON.stringify({ mcpServers: { [ENTRY_NAME]: YAW_ENTRY } }, null, 2));
    const path = writeFile(mcpJsonFile(), bytes);
    const problem = unloadableConfigProblem(violationOf(bytes));
    const status = `exists but ${problem} -- install refuses to write into it; ${unloadableConfigFix(`run \`${PROJECT_INSTALL}\``)}`;
    const d = await doctor();
    expect(doctorRow(d.text, "Claude Code (project)")).toBe(`Claude Code (project): ${status}`);
    expect(d.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "project")?.hasMcpEntry).toBe(
      true,
    );
    expect(d.snapshot.config.warnings).toEqual([`${path}: Claude Code (project) ${status}`]);
    expect(d.exitCode).toBe(2);
  });

  // The two paths the read-path gate exists for: neither builds a write, so
  // the facade's own refusal never fired, and install said "configured" over a
  // file its client loads nothing from. Each fixture starts from the entry
  // install ITSELF wrote, so "identical" is install's own verdict, not ours.
  it.each([
    ["no flag", {}],
    ["--force", { force: true }],
    ["--repair", { repair: true }],
    ["--skip", { skip: true }],
    ["--dry-run", { dryRun: true }],
  ])("an entry install wrote, then commented: install refuses under %s instead of calling it configured", async (_flag, flags) => {
    const path = mcpJsonFile();
    expect((await installClaudeCode("project")).exitCode).toBe(0);
    // The control: the same flags over the same entry, still loadable, and
    // install calls it configured. This is what makes the negative check below
    // a check -- it looks for a line this run really prints.
    const control = await installClaudeCode("project", flags);
    expect(control.exitCode).toBe(0);
    expect(saysConfigured(control.stdout)).toBe(true);
    const commented = UNLOADABLE_SHAPES[0][1](readFileSync(path, "utf8"));
    writeFileSync(path, commented);
    const i = await installClaudeCode("project", flags);
    expect(i.exitCode).toBe(1);
    expect(linesOf(i.stderr).filter((l) => l !== "")).toEqual([installRefusal(path, commented)]);
    expect(saysConfigured(i.stdout)).toBe(false);
    expect(i.written).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(commented);
  });

  it("an entry install wrote plus a legacy key, commented: install does not trim the key out of a file nothing loads", async () => {
    const path = mcpJsonFile();
    expect((await installClaudeCode("project")).exitCode).toBe(0);
    const doc = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
    doc.mcpServers["mcp.hosting"] = { command: "npx" };
    const commented = UNLOADABLE_SHAPES[0][1](`${JSON.stringify(doc, null, 2)}\n`);
    writeFileSync(path, commented);
    const i = await installClaudeCode("project");
    expect(i.exitCode).toBe(1);
    expect(linesOf(i.stderr).filter((l) => l !== "")).toEqual([installRefusal(path, commented)]);
    expect(i.written).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(commented);
  });

  it("a file that is BOTH commented and a blocked container: doctor and install lead with the blocked fault", async () => {
    const bytes = UNLOADABLE_SHAPES[0][1]('{"mcpServers": [{"command": "x"}]}');
    const path = writeFile(mcpJsonFile(), bytes);
    const d = await doctor();
    expect(doctorRow(d.text, "Claude Code (project)")).toBe(
      `Claude Code (project): present, but "mcpServers" is an array of 1, not a JSON object -- install refuses to overwrite it; ${blockedContainerFix(`run \`${PROJECT_INSTALL}\``)}`,
    );
    const row = d.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "project");
    // Both facts are carried; the row picks the one install raises first.
    expect(row?.containerBlocked).toBe('"mcpServers" is an array of 1');
    expect(row?.unloadable).toBe(unloadableConfigProblem(violationOf(bytes)));
    const i = await installClaudeCode("project");
    expect(i.exitCode).toBe(1);
    expect(linesOf(i.stderr).filter((l) => l !== "")).toEqual([
      `yaw-mcp install: "mcpServers" in ${path} is an array of 1, not a JSON object -- refusing to overwrite it; ${blockedContainerFix("re-run")}.`,
    ]);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it.each(
    UNLOADABLE_SHAPES,
  )("following the advice works: with %s removed, the named install succeeds and doctor sees the entry", async (_shape, spoil) => {
    const path = writeFile(mcpJsonFile(), spoil(PROJECT_SERVERS));
    expect((await installClaudeCode("project")).exitCode).toBe(1);
    // Follow it: the file its client can load again, then the named command.
    writeFileSync(path, PROJECT_SERVERS);
    const i = await installClaudeCode("project");
    expect(i.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(written.mcpServers).sort()).toEqual(["github", ENTRY_NAME].sort());
    const row = (await doctor()).snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "project");
    expect(row?.unloadable).toBe(null);
    expect(row?.hasMcpEntry).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE DATA-LOSS CASE. `import claude-code --remove-originals` at USER scope
// searches every other scope for a yaw-mcp entry before deleting the imported
// servers from ~/.claude.json, and the project `.mcp.json` is one of them. A
// commented `.mcp.json` holding the entry read as "wired", so the servers were
// deleted from the file Claude Code WAS loading them from, on the strength of a
// broker it loads from nowhere: the client could reach neither. Pinned at the
// filesystem boundary, byte for byte, because the loss is on disk.

/** ~/.claude.json as Claude Code leaves it: our server plus the client's own
 *  state, indented so any re-serialisation of the file would show. */
const CLAUDE_JSON_WITH_SERVER = `{
  "numStartups": 12,
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/data"]
    }
  },
  "tipsHistory": { "memory-command": 3 }
}
`;

const PROJECT_WITH_BROKER = `${JSON.stringify({ mcpServers: { [ENTRY_NAME]: YAW_ENTRY } }, null, 2)}\n`;

/** The container `import` searches at local scope, as the resolver spells it. */
const claudeLocal = () =>
  resolveInstallPath({ clientId: "claude-code", scope: "local", os: "linux", projectDir: cwd, home });

describe("import --remove-originals -- a yaw-mcp entry its client cannot load is not wiring", () => {
  it.each(
    UNLOADABLE_SHAPES,
  )("%s in .mcp.json: the import refuses, and ~/.claude.json keeps its server byte for byte", async (_shape, spoil) => {
    const user = writeFile(claudeJsonFile(), CLAUDE_JSON_WITH_SERVER);
    const projectBytes = spoil(PROJECT_WITH_BROKER);
    const project = writeFile(mcpJsonFile(), projectBytes);
    const local = claudeLocal();
    const r = await importRemoving("claude-code", "user");
    expect(r.exitCode).toBe(0);
    // The import itself ran -- the refusal is at the removal step, so the
    // byte comparison below is about a run that reached the decision, not one
    // that bailed before it.
    expect(r.written).toHaveLength(1);
    expect(r.written).not.toContain(user);
    expect(linesOf(r.stdout)).toContain(`Imported 1 server into ${r.written[0]}.`);
    // The project container is named for the client's fault, not as wiring
    // and not as "no entry". The next step is the user-scope install -- the
    // file a bare `yaw-mcp install claude-code` writes is ~/.claude.json, which
    // its client does load, so "run install first" is true here.
    expect(linesOf(r.stderr)).toContain(
      `Not removing the originals: no yaw-mcp entry in ${user} (mcpServers) or ${local.absolute} (${local.containerPath.join(".")}), and ${project} ${unloadableConfigProblem(violationOf(projectBytes))}, so Claude Code would be left with no way to reach them. Run \`yaw-mcp install claude-code\` first, then re-run this with --remove-originals.`,
    );
    expect(linesOf(r.stdout).filter((l) => l.startsWith("Reached through") || l.startsWith("Removed "))).toEqual([]);
    expect(readFileSync(user)).toEqual(Buffer.from(CLAUDE_JSON_WITH_SERVER));
    expect(readFileSync(project)).toEqual(Buffer.from(projectBytes));
  });

  it("the same files with the .mcp.json loading: that entry IS wiring, so the original goes -- the refusal is loadability, not scope", async () => {
    const user = writeFile(claudeJsonFile(), CLAUDE_JSON_WITH_SERVER);
    const project = writeFile(mcpJsonFile(), PROJECT_WITH_BROKER);
    const r = await importRemoving("claude-code", "user");
    expect(r.exitCode).toBe(0);
    expect(linesOf(r.stderr).filter((l) => l.startsWith("Not removing the originals"))).toEqual([]);
    expect(linesOf(r.stdout)).toContain(`Reached through the yaw-mcp entry in ${project} (mcpServers).`);
    expect(linesOf(r.stdout)).toContain(`Removed 1 entry from ${user}. Restart Claude Code so it picks up the change.`);
    expect(r.written).toContain(user);
    const after = parseJsonc(readFileSync(user, "utf8")) as Record<string, unknown>;
    expect(after.mcpServers).toEqual({});
    // Only the server went: the client's own state in the file is untouched.
    expect(after.numStartups).toBe(12);
    expect(after.tipsHistory).toEqual({ "memory-command": 3 });
    expect(readFileSync(project, "utf8")).toBe(PROJECT_WITH_BROKER);
  });

  it("following the advice works: the user-scope install, then the re-run removes the original through that entry", async () => {
    const user = writeFile(claudeJsonFile(), CLAUDE_JSON_WITH_SERVER);
    const projectBytes = UNLOADABLE_SHAPES[0][1](PROJECT_WITH_BROKER);
    const project = writeFile(mcpJsonFile(), projectBytes);
    expect(
      linesOf((await importRemoving("claude-code", "user")).stderr).some((l) =>
        l.startsWith("Not removing the originals"),
      ),
    ).toBe(true);
    expect((await installClaudeCode("user")).exitCode).toBe(0);
    const again = await importRemoving("claude-code", "user");
    expect(again.exitCode).toBe(0);
    expect(linesOf(again.stderr).filter((l) => l.startsWith("Not removing the originals"))).toEqual([]);
    expect(linesOf(again.stdout)).toContain(
      `Removed 1 entry from ${user}. Restart Claude Code so it picks up the change.`,
    );
    const after = parseJsonc(readFileSync(user, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(after.mcpServers)).toEqual([ENTRY_NAME]);
    // The commented project file is the user's to fix; nothing here touched it.
    expect(readFileSync(project, "utf8")).toBe(projectBytes);
  });
});
