// Regression tests for the install / uninstall fixes made in the full-pass
// audit. Each case names the behaviour it pins and the edit that turns it red.
//
// HERMETIC: every case runs against a throwaway home under the OS temp dir,
// with the oam probe and the durable-entry resolver passed as seams, so no
// case reads this machine's client configs or spawns a real `oam`.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseUninstallArgs, runInstall, runUninstall } from "../install-cmd.js";
import { CURRENT_OS, ENTRY_NAME, type InstallOS } from "../install-targets.js";
import { MIN_OAM_VERSION, type OamProbe } from "../oam-spawn.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-full-pass-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

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

/** An oam the probe found at an absolute path. The path is absolute under
 *  both win32 and POSIX rules, which is all buildLaunchEntry asks of it;
 *  nothing spawns it. */
const OAM_BIN = "/usr/local/bin/oam";
const OAM_PRESENT = async (): Promise<OamProbe> => ({
  bin: OAM_BIN,
  binPath: OAM_BIN,
  version: MIN_OAM_VERSION,
  belowMin: false,
  failure: null,
  failureDetail: null,
});

describe("install over an oam-hosted entry, launched from a copy with no durable install (npx)", () => {
  /** A REAL file inside a `node_modules/@yawlabs/mcp/` tree: the stored entry
   *  has to name something `oam run` could start, or it is a dead entry and
   *  repairing it to npx is the right answer. */
  function durableEntryFile(): string {
    const file = join(home, "global", "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "// broker entry\n", "utf8");
    return file;
  }
  const clientFile = (): string => join(home, ".claude.json");
  const base = () => ({
    clientId: "claude-code" as const,
    scope: "user" as const,
    os: "linux" as const,
    home,
    oamProbe: OAM_PRESENT,
    suppressBundlesNote: true,
  });

  /** What a global `yaw-mcp install` leaves behind: `oam run --no-check <entry>`. */
  async function seedOamHosted(entry: string): Promise<string> {
    const r = await runInstall({ ...base(), io: captureIo().io, resolveOamEntry: () => entry });
    expect(r.exitCode).toBe(0);
    const bytes = readFileSync(clientFile(), "utf8");
    expect(JSON.parse(bytes).mcpServers[ENTRY_NAME]).toEqual({ command: OAM_BIN, args: ["run", "--no-check", entry] });
    return bytes;
  }

  it("is the documented no-op off a TTY: exit 0, nothing written, the oam entry kept", async () => {
    // RED without the stored-entry fallback in runInstall (`resolveEntry(...)
    // ?? storedOamEntryFile(storedEntry)`): the running copy resolves no
    // durable install, the candidate entry is npx, the healthy oam entry reads
    // as drift, and this is exit 2 with "stdin is not a TTY".
    const before = await seedOamHosted(durableEntryFile());
    const cap = captureIo();
    const r = await runInstall({ ...base(), io: cap.io, resolveOamEntry: () => null });
    expect(cap.stderr()).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(cap.stdout()).toContain("\nNothing to do: Claude Code (user) is already configured.");
    expect(readFileSync(clientFile(), "utf8")).toBe(before);
  });

  it("--repair leaves it on oam instead of rewriting it down to npx", async () => {
    const before = await seedOamHosted(durableEntryFile());
    const cap = captureIo();
    const r = await runInstall({ ...base(), io: cap.io, repair: true, resolveOamEntry: () => null });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(cap.stdout()).not.toContain("not durably installed");
    expect(readFileSync(clientFile(), "utf8")).toBe(before);
  });

  it("still reads a DEAD oam entry as drift, and --repair still takes it to npx", async () => {
    // The fallback adopts a path only while it is a file on disk. Once the
    // global install is gone the entry cannot start, and the npx entry is the
    // repair it always was.
    const entry = durableEntryFile();
    await seedOamHosted(entry);
    rmSync(entry);

    const refused = captureIo();
    const off = await runInstall({ ...base(), io: refused.io, resolveOamEntry: () => null });
    expect(off.exitCode).toBe(2);
    expect(off.collisionRefused).toBe(true);

    const cap = captureIo();
    const r = await runInstall({ ...base(), io: cap.io, repair: true, resolveOamEntry: () => null });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(clientFile(), "utf8")).mcpServers[ENTRY_NAME]).toEqual({
      command: "npx",
      args: ["-y", "@yawlabs/mcp@latest"],
    });
    expect(cap.stdout()).toContain("yaw-mcp is not durably installed");
  });

  it("does not adopt an `oam run` of a file outside a node_modules/@yawlabs/mcp tree", async () => {
    // A hand-written entry under the "mcp" key that runs somebody else's
    // script is not a broker install to keep: it stays drift.
    const other = join(home, "scripts", "server.js");
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, "// not ours\n", "utf8");
    writeFileSync(
      clientFile(),
      `${JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: OAM_BIN, args: ["run", "--no-check", other] } } }, null, 2)}\n`,
      "utf8",
    );
    const cap = captureIo();
    const r = await runInstall({ ...base(), io: cap.io, resolveOamEntry: () => null });
    expect(r.exitCode).toBe(2);
    expect(cap.stderr()).toContain(
      `args: ["run","--no-check",${JSON.stringify(other)}] -> ["-y","@yawlabs/mcp@latest"]`,
    );
  });
});

describe("install --dry-run over a differing entry", () => {
  const clientFile = (): string => join(home, ".claude.json");
  const OAM_ABSENT = async (): Promise<OamProbe> => ({
    bin: null,
    binPath: null,
    version: null,
    belowMin: false,
    failure: null,
    failureDetail: null,
  });
  const run = (extra: { repair?: boolean; force?: boolean }) => {
    writeFileSync(clientFile(), JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2));
    const cap = captureIo();
    return runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
      suppressBundlesNote: true,
      ...extra,
    }).then((r) => ({ r, lines: cap.stdout().split("\n") }));
  };
  const PLAIN = `Would overwrite existing "${ENTRY_NAME}" entry.`;
  const NEEDS_FLAG =
    `Would overwrite existing "${ENTRY_NAME}" entry -- only with --repair or --force. Without one, the real run ` +
    "asks first on a terminal (default: leave it) and refuses off one. The preview below assumes the flag.";

  it("says the overwrite needs --repair or --force when neither was given", async () => {
    // RED when `needsFlag` is dropped from the Would-overwrite line: a bare
    // preview then promises an overwrite the same command without --dry-run
    // refuses off a TTY and defaults to skipping on one.
    const { r, lines } = await run({});
    expect(r.exitCode).toBe(0);
    expect(lines).toContain(NEEDS_FLAG);
    expect(lines).not.toContain(PLAIN);
  });

  it("keeps the unconditional line when the flag that authorises it is there", async () => {
    for (const flag of [{ repair: true }, { force: true }]) {
      const { r, lines } = await run(flag);
      expect(r.exitCode).toBe(0);
      expect(lines, JSON.stringify(flag)).toContain(PLAIN);
      expect(lines, JSON.stringify(flag)).not.toContain(NEEDS_FLAG);
    }
  });
});

describe("uninstall --os <another OS> --dry-run", () => {
  const other: InstallOS = CURRENT_OS === "linux" ? "macos" : "linux";

  it("is marked by the parser, and only for a foreign --os", () => {
    const foreign = parseUninstallArgs(["claude-code", "--os", other, "--dry-run"]);
    expect(foreign.ok && foreign.options.crossOsPreview).toBe(true);
    const native = parseUninstallArgs(["claude-code", "--os", CURRENT_OS, "--dry-run"]);
    expect(native.ok && native.options.crossOsPreview).toBeUndefined();
    const plain = parseUninstallArgs(["claude-code", "--dry-run"]);
    expect(plain.ok && plain.options.crossOsPreview).toBeUndefined();
    // Without --dry-run it is still refused, and the refusal no longer calls
    // the dry run a preview of something it cannot inspect.
    const refused = parseUninstallArgs(["claude-code", "--os", other]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toContain("does not match this machine");
      expect(refused.error).toContain("Add --dry-run to see which file that is");
    }
  });

  // Skipped on macOS: `--os macos` is the native OS there, so there is no
  // cross-OS preview to pin and the ordinary run is right.
  const foreignOnly = it.skipIf(CURRENT_OS === "macos");
  foreignOnly("names the target-OS file and says it was not inspected, instead of `Nothing to do`", async () => {
    // RED without the crossOsPreview branch in runUninstall: the run reads
    // this machine's host-shaped path, finds no file, and prints "Nothing to
    // do: Claude Desktop (user) has no yaw-mcp entry" -- an answer about a
    // config it never looked at.
    const parsed = parseUninstallArgs(["claude-desktop", "--os", "macos", "--dry-run"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cap = captureIo();
    const r = await runUninstall({ ...parsed.options, home, io: cap.io });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(r.wouldWrite).toEqual([]);
    const out = cap.stdout();
    expect(out).toContain("Target: Claude Desktop (user)\n");
    expect(out).toContain("File:   ~/Library/Application Support/Claude/claude_desktop_config.json\n");
    expect(out).toContain(
      `\nNot inspected: that is Claude Desktop's config on macos, and this machine is ${CURRENT_OS} -- uninstall ` +
        "reads only the machine it runs on, so it cannot say whether that file has a yaw-mcp entry. Run " +
        "`yaw-mcp uninstall claude-desktop --dry-run` on the macos machine itself.\n",
    );
    expect(out).not.toContain("Nothing to do");
    expect(cap.stderr()).toBe("");
  });

  it("carries --scope and the user's own --project-dir into the suggested command", async () => {
    // RED with the bare `uninstall <client> --dry-run` suggestion: on the
    // other machine that reads the USER scope, a different file from the
    // project one named on the File: line.
    const parsed = parseUninstallArgs([
      "claude-code",
      "--scope",
      "project",
      "--project-dir",
      "/work/repo",
      "--os",
      other,
      "--dry-run",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cap = captureIo();
    const r = await runUninstall({ ...parsed.options, home, io: cap.io });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toContain(
      `\`yaw-mcp uninstall claude-code --scope project --project-dir /work/repo --dry-run\` on the ${other} machine itself.`,
    );

    // A non-default scope with no --project-dir names the scope alone.
    const local = parseUninstallArgs(["claude-code", "--scope", "local", "--os", other, "--dry-run"]);
    expect(local.ok).toBe(true);
    if (!local.ok) return;
    const cap2 = captureIo();
    await runUninstall({ ...local.options, home, io: cap2.io });
    expect(cap2.stdout()).toContain(`\`yaw-mcp uninstall claude-code --scope local --dry-run\` on the ${other}`);
  });

  it("quotes the suggested --project-dir for the TARGET OS's shell, not this machine's", async () => {
    // A `$` means nothing to cmd but expands in bash, so a Linux target needs
    // the POSIX single quotes whichever OS the preview runs on.
    const target = CURRENT_OS === "linux" ? "windows" : "linux";
    const dir = target === "linux" ? "/work/$repo" : "C:\\work\\$repo";
    const parsed = parseUninstallArgs([
      "claude-code",
      "--scope",
      "project",
      "--project-dir",
      dir,
      "--os",
      target,
      "--dry-run",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cap = captureIo();
    await runUninstall({ ...parsed.options, home, io: cap.io });
    const expected = target === "linux" ? "'/work/$repo'" : "C:\\work\\$repo";
    expect(cap.stdout()).toContain(`--project-dir ${expected} --dry-run\` on the ${target} machine itself.`);
  });

  it("leaves a direct caller's foreign `os` alone: that pairing is the hermetic test seam", async () => {
    // No crossOsPreview, so the run reads the synthetic home as before.
    const cap = captureIo();
    const r = await runUninstall({ clientId: "claude-code", scope: "user", os: other, home, dryRun: true, io: cap.io });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toContain("Nothing to do: Claude Code (user) has no yaw-mcp entry.");
  });
});

describe("uninstall preview of a Cline entry in the nested transport form", () => {
  it("shows the launch line and the env keys the entry carries", async () => {
    // RED when RemovalSite.storedEntry goes back to the raw `at.entry()?.value`:
    // the nested form has no top-level command or env, so the preview printed
    // "launch:   (no command)" and no env-keys line for an entry that has both.
    const shared = join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
    mkdirSync(dirname(shared), { recursive: true });
    const nested = {
      mcpServers: {
        [ENTRY_NAME]: {
          transport: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@yawlabs/mcp@latest"],
            env: { OAM_BIN: "/opt/oam", YAW_MCP_VAULT_PASSPHRASE: "hunter2" },
          },
          disabled: false,
        },
      },
    };
    writeFileSync(shared, `${JSON.stringify(nested, null, 2)}\n`, "utf8");
    const cap = captureIo();
    const r = await runUninstall({
      clientId: "cline",
      os: "linux",
      home,
      appData: join(home, "AppData", "Roaming"),
      dryRun: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    expect(r.wouldWrite).toEqual([shared]);
    const lines = cap.stdout().split("\n");
    expect(lines).toContain(`    entry:    "${ENTRY_NAME}"`);
    expect(lines).toContain("    launch:   $ npx -y @yawlabs/mcp@latest");
    expect(lines).toContain("    env keys: OAM_BIN, YAW_MCP_VAULT_PASSPHRASE (values go with the entry)");
    // Keys only, never the values.
    expect(cap.stdout()).not.toContain("hunter2");
    expect(cap.stdout()).not.toContain("(no command)");
  });
});
