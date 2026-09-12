// The Zed row, driven end to end.
//
// WHAT MAKES ZED DIFFERENT, and therefore what this file is about:
//
//   * Its settings.json is JSONC -- `//` comments AND trailing commas -- and
//     that is not a tolerated edge case, it is the file Zed itself WRITES.
//     The `zed: open settings file` action (`OpenSettingsFile` in
//     crates/zed/src/zed.rs) creates settings.json from
//     `initial_user_settings_content()`, which is the asset
//     `assets/settings/initial_user_settings.json` -- and that asset ships 8
//     `//` header lines and two trailing commas. So the decisive test here is
//     an install into that verbatim template with a byte-for-byte
//     comparison, not a parse-and-compare.
//   * The container key is `context_servers`, not `mcpServers`.
//   * Zed watches the file and starts, restarts or stops servers on save, so
//     the Done line must not tell anyone to restart the editor.
//   * `enabled`, `remote` and `timeout` are Zed's own per-server fields, and
//     the row carries them so a server the user switched OFF does not come
//     back on.
//
// EVERY BYTE FIXTURE IS ON DISK, in `fixtures/zed/`, with its own README
// explaining why they are `.txt` (biome's formatter deletes a trailing comma
// out of a `.jsonc`, and `npm run lint:fix` runs before every commit) and why
// that directory carries its own `.gitattributes` (the repo root's
// `eol=lf` would rewrite the CRLF fixture). A fixture whose point is a
// control byte was generated with `String.fromCharCode` and read back with
// `cat -A` before it was committed.
//
// Hermetic: a synthetic home and cwd per test, the oam probe and the
// bundles.json read both pinned by seam, and no client binary is run -- none
// exists on the machine this was written on, and install never spawns one
// anyway.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyClientConfigEdits,
  type ConfigSite,
  classifyClientConfig,
  composeEntry,
  effectiveConfigFormat,
  reloadDoneClause,
} from "../client-config.js";
import {
  type BundlesSummary,
  type InstallCommandOptions,
  resolveInstallSite,
  runInstall,
  runUninstall,
} from "../install-cmd.js";
import {
  ENTRY_NAME,
  INSTALL_TARGETS,
  type InstallOS,
  type InstallScope,
  resolveInstallPath,
} from "../install-targets.js";
import { parseJsonc } from "../jsonc.js";
import type { OamProbe } from "../oam-spawn.js";

// ---------------------------------------------------------------------------
// Fixtures and seams
// ---------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL("./fixtures/zed/", import.meta.url));

/** One byte fixture, read as text so a `\r` survives the read. */
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.txt`), "utf8");
}

const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);

/** oam absent, so every entry these tests assert is the npx one. Without the
 *  seam the entry written depends on whether the machine running the suite
 *  happens to have oam plus a durable @yawlabs/mcp -- which is the worst way
 *  for a byte-exact assertion to fail. */
const OAM_ABSENT = async (): Promise<OamProbe> => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});

/** The bundles.json read, pinned for the same reason: without it a run that
 *  overrides `home` but not `cwd` can still walk up from the real process cwd
 *  and find the developer's own ~/.yaw-mcp. */
const BUNDLES_EMPTY = (): BundlesSummary => ({
  state: "empty",
  count: 0,
  path: "/synth/.yaw-mcp/bundles.json",
  warnings: [],
});

function captureIo(): {
  io: NonNullable<InstallCommandOptions["io"]>;
  stdout: () => string;
  stderr: () => string;
} {
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

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-zed-home-"));
  cwd = mkdtempSync(join(tmpdir(), "yaw-mcp-zed-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** Where the user-scope file lands under the synthetic home on a posix run.
 *  Built with `join`, never a POSIX literal: the SUT joins too, so on a
 *  Windows runner both sides come back with backslashes and agree. */
function userSettingsPath(): string {
  return join(home, ".config", "zed", "settings.json");
}

/** Seed the user-scope settings.json with a fixture's exact bytes. */
function seed(text: string): string {
  const path = userSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** `install zed`, off a TTY, with both machine probes pinned. macOS on
 *  purpose for the byte tests: Zed's macOS branch resolves `~/.config/zed`
 *  without consulting XDG at all (paths.rs `config_dir`), so these
 *  assertions cannot be moved by an XDG value on the box or by a future
 *  consumer that starts threading one. */
async function install(
  extra: Partial<InstallCommandOptions> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cap = captureIo();
  const r = await runInstall({
    clientId: "zed",
    scope: "user",
    os: "macos",
    home,
    cwd,
    io: cap.io,
    oamProbe: OAM_ABSENT,
    bundlesSummary: BUNDLES_EMPTY,
    ...extra,
  });
  return { exitCode: r.exitCode, stdout: cap.stdout(), stderr: cap.stderr() };
}

async function uninstall(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cap = captureIo();
  const r = await runUninstall({ clientId: "zed", scope: "user", os: "macos", home, cwd, io: cap.io, force: true });
  return { exitCode: r.exitCode, stdout: cap.stdout(), stderr: cap.stderr() };
}

const ZED = ((): (typeof INSTALL_TARGETS)[number] => {
  const row = INSTALL_TARGETS.find((t) => t.clientId === "zed");
  if (!row) throw new Error("no zed row in INSTALL_TARGETS");
  return row;
})();

/** The site a consumer builds for one (scope, os) -- the same three calls
 *  every migrated consumer makes, so a core test here exercises the real
 *  path rather than a parallel one. */
function siteFor(scope: InstallScope, os: InstallOS, projectDir?: string): ConfigSite {
  const spec = ZED.scopes.find((s) => s.scope === scope);
  if (!spec) throw new Error(`zed has no ${scope} scope`);
  return {
    id: "default",
    label: ZED.label,
    format: effectiveConfigFormat(ZED.config, spec),
    resolved: resolveInstallPath({ clientId: "zed", scope, os, home, projectDir }),
    detectDir: null,
  };
}

// ---------------------------------------------------------------------------
// 1. The row, as data
// ---------------------------------------------------------------------------

describe("the zed row", () => {
  it("stores its servers under context_servers, in JSONC, on all three OSes", () => {
    expect(ZED.config).toEqual({ format: "jsonc", root: "context_servers" });
    expect([...ZED.availableOn].sort()).toEqual(["linux", "macos", "windows"]);
    expect(ZED.notConfigurableOn).toBeUndefined();
    // User first: the probe walks this array in order, and that order decides
    // which slot `try` auto-detects and how `--list` and doctor sort.
    expect(ZED.scopes.map((s) => s.scope)).toEqual(["user", "project"]);
    expect(ZED.scopes.map((s) => s.requiresProjectDir)).toEqual([false, true]);
    // Neither scope is strict JSON. A strict narrowing here would refuse every
    // write into Zed's own template, whose comments Zed itself put there.
    for (const spec of ZED.scopes) expect(effectiveConfigFormat(ZED.config, spec)).toBe("jsonc");
  });

  it("says the file reloads live, so the Done line does not ask for a restart", () => {
    expect(ZED.reload).toBe("live");
    expect(reloadDoneClause(ZED.reload, ZED.label)).toBe(
      "Zed starts the server when the file is saved -- no restart needed.",
    );
    expect(reloadDoneClause(ZED.reload, ZED.label)).not.toContain("Restart");
  });

  it("carries enabled, remote and timeout -- each only with the type Zed gives it", () => {
    const carry = ZED.entry?.carry;
    expect(carry).toBeDefined();
    if (!carry) return;
    // The three fields, with Zed's own types: `enabled` and `remote` are
    // bools and `timeout` a number of seconds (settings_content/src/project.rs,
    // ContextServerSettingsContent::Stdio and ContextServerCommand).
    expect(carry({ enabled: false, remote: true, timeout: 120 })).toEqual({
      enabled: false,
      remote: true,
      timeout: 120,
    });
    // `true`/`false` both carry: a mutation that carried only the truthy one
    // would let `enabled: false` -- the whole reason the hook exists -- fall
    // through as drift.
    expect(carry({ enabled: true, remote: false })).toEqual({ enabled: true, remote: false });
    expect(carry({ timeout: 0 })).toEqual({ timeout: 0 });

    // Ill-typed values are NOT carried: writing one back would put something
    // Zed's untagged enum rejects into the file, and leaving it out is what
    // surfaces it to the user as drift instead.
    expect(carry({ enabled: "yes", remote: 1, timeout: "120" })).toEqual({});
    expect(carry({ timeout: -1 })).toEqual({});
    expect(carry({ timeout: Number.NaN })).toEqual({});
    expect(carry({ timeout: Number.POSITIVE_INFINITY })).toEqual({});

    // Nothing else rides along. `source` in particular: current Zed migrates
    // that key away from the user file, so carrying it would put it straight
    // back on the next install and produce a write loop.
    expect(carry({ source: "custom", command: "npx", args: [], env: { A: "1" }, url: "https://x" })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 2. Paths, per OS and per scope
// ---------------------------------------------------------------------------

describe("where zed keeps its settings", () => {
  const HOME = "/synth/home";

  it("uses ~/.config/zed on macOS, and ignores XDG_CONFIG_HOME there", () => {
    // paths.rs `config_dir()`: the macOS branch is
    // `home_dir().join(".config").join(APP_NAME_LOWERCASE)` and never calls
    // dirs, so no XDG value reaches it.
    const plain = resolveInstallPath({ clientId: "zed", scope: "user", os: "macos", home: HOME });
    expect(plain.absolute).toBe(join(HOME, ".config", "zed", "settings.json"));
    expect(plain.display).toBe("~/.config/zed/settings.json");
    expect(plain.containerPath).toEqual(["context_servers"]);
    const withXdg = resolveInstallPath({
      clientId: "zed",
      scope: "user",
      os: "macos",
      home: HOME,
      clientEnv: { xdgConfigHome: "/xdg" },
    });
    expect(withXdg.absolute).toBe(plain.absolute);
    expect(withXdg.display).toBe(plain.display);
  });

  it("follows an ABSOLUTE XDG_CONFIG_HOME on Linux and ignores a relative one", () => {
    // dirs-rs `lin.rs`: XDG_CONFIG_HOME is used only when it passes
    // `is_absolute_path`; otherwise it falls back to $HOME/.config. Zed reads
    // its config dir through that crate, so a relative value is ignored
    // rather than resolved against the process cwd.
    const abs = resolveInstallPath({
      clientId: "zed",
      scope: "user",
      os: "linux",
      home: HOME,
      clientEnv: { xdgConfigHome: "/xdg" },
    });
    expect(abs.absolute).toBe(join("/xdg", "zed", "settings.json"));
    expect(abs.display).toBe("$XDG_CONFIG_HOME/zed/settings.json");

    for (const relative of ["conf", "./conf", ""]) {
      const r = resolveInstallPath({
        clientId: "zed",
        scope: "user",
        os: "linux",
        home: HOME,
        clientEnv: { xdgConfigHome: relative },
      });
      expect(r.absolute, `XDG_CONFIG_HOME=${JSON.stringify(relative)}`).toBe(
        join(HOME, ".config", "zed", "settings.json"),
      );
      expect(r.display).toBe("~/.config/zed/settings.json");
    }

    const unset = resolveInstallPath({ clientId: "zed", scope: "user", os: "linux", home: HOME });
    expect(unset.absolute).toBe(join(HOME, ".config", "zed", "settings.json"));
    expect(unset.display).toBe("~/.config/zed/settings.json");
  });

  it("uses %APPDATA%\\Zed on Windows -- capitalised, as APP_NAME spells it", () => {
    // paths.rs: the Windows branch joins `dirs::config_dir()` (RoamingAppData)
    // with APP_NAME, and `pub const APP_NAME: &str = "Zed"`. The lowercase
    // spelling is the XDG one and is wrong here; on a case-sensitive volume it
    // would be a different directory, and on Windows it is the name the user
    // sees in a path we print.
    const win = resolveInstallPath({
      clientId: "zed",
      scope: "user",
      os: "windows",
      home: HOME,
      appData: "C:\\Users\\alice\\AppData\\Roaming",
    });
    expect(win.absolute).toBe(join("C:\\Users\\alice\\AppData\\Roaming", "Zed", "settings.json"));
    expect(win.absolute).toContain("Zed");
    expect(win.display).toBe("%APPDATA%\\Zed\\settings.json");
    // And XDG has no say on Windows either.
    const winXdg = resolveInstallPath({
      clientId: "zed",
      scope: "user",
      os: "windows",
      home: HOME,
      appData: "C:\\Users\\alice\\AppData\\Roaming",
      clientEnv: { xdgConfigHome: "/xdg" },
    });
    expect(winXdg.absolute).toBe(win.absolute);
  });

  it("puts the project scope at <project>/.zed/settings.json on every OS", () => {
    // configuring-zed.md: "Override user settings for a specific project by
    // creating a `.zed/settings.json` file in your project root."
    const proj = join(HOME, "repo");
    for (const os of ["macos", "linux", "windows"] as const) {
      const r = resolveInstallPath({ clientId: "zed", scope: "project", os, home: HOME, projectDir: proj });
      expect(r.absolute, os).toBe(join(proj, ".zed", "settings.json"));
      expect(r.containerPath).toEqual(["context_servers"]);
      expect(r.display).toBe(
        os === "windows" ? "<project folder>\\.zed\\settings.json" : "<project folder>/.zed/settings.json",
      );
    }
  });

  it("resolves the same file through the CLI's own site resolver", () => {
    // The path assertions above call the resolver directly; this one goes
    // through what `install`, `uninstall` and `import` all funnel into, so a
    // refusal or a defaulting bug in that layer cannot hide behind them.
    const refusals: string[] = [];
    const site = resolveInstallSite("install", { clientId: "zed", os: "macos", home, cwd }, (s) => refusals.push(s));
    expect(refusals).toEqual([]);
    expect(site).not.toBeNull();
    // No --scope given: user is the default, because the row has one.
    expect(site?.scope).toBe("user");
    expect(site?.resolved.absolute).toBe(userSettingsPath());

    // --project-dir with no --scope picks the project scope, because zed has
    // exactly one scope that reads a project directory.
    const proj = resolveInstallSite("install", { clientId: "zed", os: "macos", home, cwd, projectDir: "." }, (s) =>
      refusals.push(s),
    );
    expect(refusals).toEqual([]);
    expect(proj?.scope).toBe("project");
    expect(proj?.resolved.absolute).toBe(join(cwd, ".zed", "settings.json"));
  });
});

// ---------------------------------------------------------------------------
// 3. The decisive one: Zed's own default template, byte for byte
// ---------------------------------------------------------------------------

describe("installing into Zed's verbatim default template", () => {
  it("keeps every header comment and every trailing comma, byte for byte", async () => {
    const template = fixture("initial-user-settings");
    // The fixture really is the file Zed writes: 8 `//` header lines and the
    // two trailing commas its own template ships.
    expect(template.split("\n").filter((l) => l.startsWith("//")).length).toBe(8);
    expect(template).toContain('"dark": "One Dark",\n  },\n}');

    const path = seed(template);
    const r = await install();
    expect(r.exitCode, r.stderr).toBe(0);

    const after = readFileSync(path, "utf8");
    // The golden, byte for byte. Committed next to the input so a reader can
    // diff the two without running anything.
    expect(after).toBe(fixture("initial-user-settings.installed"));

    // ...and the same claim stated independently of the golden, so a golden
    // regenerated from a broken run cannot make this test vacuous:
    //   every original byte up to the closing brace is untouched,
    expect(after.startsWith(template.slice(0, template.lastIndexOf("}\n")))).toBe(true);
    //   the header survives verbatim,
    for (const line of template.split("\n").filter((l) => l.startsWith("//"))) expect(after).toContain(`${line}\n`);
    //   both of the template's trailing commas survive,
    expect(after).toContain('"dark": "One Dark",\n');
    expect(after).toContain('"light": "One Light",\n');
    expect(after).toContain('  },\n  "context_servers": {');
    //   the new container mirrors that same trailing-comma style,
    expect(after).toContain("  },\n}\n");
    //   and the file still loads as the JSONC Zed parses it as.
    const parsed = parseJsonc(after) as Record<string, Record<string, unknown>>;
    expect(parsed.theme).toEqual({ mode: "system", light: "One Light", dark: "One Dark" });
    expect(parsed.ui_font_size).toBe(16);
    expect(parsed.context_servers).toEqual({
      [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
    });
  });

  it("tells the user no restart is needed, and states the version floor and the trust gate", async () => {
    seed(fixture("initial-user-settings"));
    const r = await install();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "Done: Zed is configured. Zed starts the server when the file is saved -- no restart needed.",
    );
    expect(r.stdout).not.toContain("Restart it to pick up");
    // The row's notes, printed verbatim. Each clause below is a vendor fact
    // this suite or the report backs: the JSONC syntax and the live reload are
    // asserted above, the trust gate is Zed's worktree-trust doc, and the
    // version floor is the release that first accepted an entry with no
    // `source` key.
    expect(r.stdout).toContain("Note: Zed reads context_servers from settings.json");
    expect(r.stdout).toContain("Zed ignores a project's .zed/settings.json until you trust the project.");
    expect(r.stdout).toContain("Needs Zed v0.214.5 (2025-11-26) or newer");
  });

  it("is a genuine no-op on a re-run -- no write, so mtime and size do not move", async () => {
    const path = seed(fixture("initial-user-settings"));
    expect((await install()).exitCode).toBe(0);
    const first = readFileSync(path, "utf8");
    const stamp = statSync(path);

    const again = await install();
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stdout).toContain("Nothing to do: Zed is already configured.");
    expect(readFileSync(path, "utf8")).toBe(first);
    const after = statSync(path);
    expect(after.size).toBe(stamp.size);
    expect(after.mtimeMs).toBe(stamp.mtimeMs);
  });

  it("puts the template's own bytes back on uninstall", async () => {
    const template = fixture("initial-user-settings");
    const path = seed(template);
    expect((await install()).exitCode).toBe(0);

    const r = await uninstall();
    expect(r.exitCode, r.stderr).toBe(0);
    const after = readFileSync(path, "utf8");
    expect(after).toBe(fixture("initial-user-settings.uninstalled"));

    // Everything the user had is back byte for byte -- the comments, the
    // fonts, the theme block and its trailing commas.
    expect(after.startsWith(template.slice(0, template.lastIndexOf("}\n")))).toBe(true);
    expect(parseJsonc(after)).toEqual({
      ui_font_size: 16,
      buffer_font_size: 15,
      theme: { mode: "system", light: "One Light", dark: "One Dark" },
      // The splicer removes the ENTRY, not the container it lived in, so an
      // emptied `context_servers` is left behind. Parse-clean, and Zed reads
      // it as "no context servers" -- which is what the file said before.
      context_servers: {},
    });
    expect(after).toContain('  "context_servers": {\n  },\n');

    const again = await uninstall();
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("Nothing to do");
    expect(readFileSync(path, "utf8")).toBe(after);
  });
});

// ---------------------------------------------------------------------------
// 4. Neighbours, comments, line endings and indentation
// ---------------------------------------------------------------------------

describe("what the splice leaves alone", () => {
  it("keeps a neighbouring server's bytes AND its trailing comment, and trims the legacy key", async () => {
    const before = fixture("neighbours");
    const path = seed(before);
    const r = await install();
    expect(r.exitCode, r.stderr).toBe(0);

    const after = readFileSync(path, "utf8");
    expect(after).toBe(fixture("neighbours.installed"));
    // The neighbour's whole line, its trailing `//` comment included, and the
    // comment line above it: both byte-identical.
    expect(after).toContain('    "github": { "command": "gh-mcp", "args": [] }, // keep me\n');
    expect(after).toContain("    // github\n");
    expect(after).toContain("// my zed\n");
    // The legacy key went in the same write, and the run said so.
    expect(after).not.toContain('yaw-mcp"');
    expect(r.stdout).toContain('Removed the legacy "yaw-mcp" entry');
    const parsed = parseJsonc(after) as { context_servers: Record<string, unknown> };
    expect(Object.keys(parsed.context_servers)).toEqual(["github", ENTRY_NAME]);

    // And uninstall gives the neighbour and its comment back untouched.
    expect((await uninstall()).exitCode).toBe(0);
    const removed = readFileSync(path, "utf8");
    expect(removed).toBe(fixture("neighbours.uninstalled"));
    expect(removed).toContain('    "github": { "command": "gh-mcp", "args": [] }, // keep me\n');
  });

  it("writes CRLF into a CRLF file, with no lone LF anywhere", async () => {
    const before = fixture("initial-user-settings.crlf");
    // The fixture is what it claims to be. Built with String.fromCharCode(13)
    // rather than a typed escape, and it carries its own .gitattributes so the
    // repo's `eol=lf` cannot normalise it back to the LF copy.
    expect(before.split(CR).length - 1).toBe(17);
    expect(new RegExp(`[^${CR}]\n`).test(before)).toBe(false);

    const path = seed(before);
    const r = await install();
    expect(r.exitCode, r.stderr).toBe(0);

    const after = readFileSync(path, "utf8");
    expect(after).toBe(fixture("initial-user-settings.crlf.installed"));
    // Not one LF that is not part of a CRLF -- the whole point, since a mixed
    // file is what a naive re-render produces.
    expect(new RegExp(`[^${CR}]\n`).test(after)).toBe(false);
    expect(after.startsWith("\n")).toBe(false);
    expect(after.split(CR).length - 1).toBe(26);
    expect(parseJsonc(after)).toMatchObject({
      context_servers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] } },
    });
  });

  it("indents the new entry with TABS in a tab-indented file", async () => {
    const before = fixture("tab-indent");
    expect(before).toContain(`${TAB}"context_servers": {`);
    expect(before).not.toContain('  "context_servers"');

    const path = seed(before);
    const r = await install();
    expect(r.exitCode, r.stderr).toBe(0);

    const after = readFileSync(path, "utf8");
    expect(after).toBe(fixture("tab-indent.installed"));
    expect(after).toContain(`${TAB}${TAB}"${ENTRY_NAME}": {`);
    expect(after).toContain(`${TAB}${TAB}${TAB}"command": "npx",`);
    expect(after).toContain(`${TAB}${TAB}${TAB}${TAB}"@yawlabs/mcp@latest"`);
    // Nothing space-indented crept in beside the tabs.
    for (const line of after.split("\n"))
      expect(line.startsWith(" "), `space-indented: ${JSON.stringify(line)}`).toBe(false);
    expect(parseJsonc(after)).toMatchObject({
      context_servers: {
        github: { command: "gh-mcp" },
        [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
      },
    });
  });

  it("creates ~/.config/zed and a whole fresh file when Zed has never been opened", async () => {
    // Zed's own startup creates directories but not settings.json: a user who
    // has never run `zed: open settings file` has neither. install must not
    // depend on the client having been run first.
    const path = userSettingsPath();
    const r = await install();
    expect(r.exitCode, r.stderr).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(
      `${JSON.stringify({ context_servers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] } } }, null, 2)}\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Project scope and the trust gate
// ---------------------------------------------------------------------------

describe("the project scope", () => {
  it("writes <project>/.zed/settings.json and says Zed ignores it until the project is trusted", async () => {
    const r = await install({ scope: "project", projectDir: cwd });
    expect(r.exitCode, r.stderr).toBe(0);
    const path = join(cwd, ".zed", "settings.json");
    expect(parseJsonc(readFileSync(path, "utf8"))).toEqual({
      context_servers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] } },
    });
    // The claim Zed's worktree-trust doc makes about this exact file:
    // "Restricted Mode prevents: Project settings (`.zed/settings.json`) from
    // being parsed and applied". The whole file is withheld, not merely its
    // servers -- so this is a caveat the install has to state, since nothing
    // in yaw-mcp can see or grant the trust.
    expect(r.stdout).toContain("Zed ignores a project's .zed/settings.json until you trust the project.");
    // The user-scope install is NOT trust-gated ("Global MCP servers ... are
    // installed and started as usual, independent of worktree trust"), so the
    // caveat must not claim otherwise -- it names the project file by path.
    expect(r.stdout).toContain(".zed/settings.json");
  });

  it("spliced into a project file, it leaves the project's own settings alone", async () => {
    const path = join(cwd, ".zed", "settings.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '// team settings\n{\n  "tab_size": 2,\n}\n');
    const r = await install({ scope: "project", projectDir: cwd });
    expect(r.exitCode, r.stderr).toBe(0);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("// team settings\n");
    expect(after).toContain('  "tab_size": 2,\n');
    expect(parseJsonc(after)).toMatchObject({ tab_size: 2 });
  });
});

// ---------------------------------------------------------------------------
// 6. Drift, and what --force drops that --repair keeps
// ---------------------------------------------------------------------------

describe("an entry that is already there", () => {
  /** A settings.json holding one `mcp` entry, rendered fresh. */
  function seedEntry(entry: Record<string, unknown>): string {
    return seed(`${JSON.stringify({ context_servers: { [ENTRY_NAME]: entry } }, null, 2)}\n`);
  }

  it("refuses off a TTY when a stored field it would not write is in the way", async () => {
    // `source` is the live case: Zed's pre-2025-11 schema required it, and an
    // entry carried over from that era still has it. It is not carried (see
    // the row test), so it shows up here rather than being silently kept.
    const path = seedEntry({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"], source: "custom" });
    const before = readFileSync(path, "utf8");
    const r = await install();
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('already has a "mcp" entry and stdin is not a TTY');
    expect(r.stderr).toContain("source: would be removed (value not shown)");
    expect(readFileSync(path, "utf8")).toBe(before);

    const repaired = await install({ repair: true });
    expect(repaired.exitCode, repaired.stderr).toBe(0);
    const after = parseJsonc(readFileSync(path, "utf8")) as { context_servers: Record<string, unknown> };
    expect(after.context_servers[ENTRY_NAME]).toEqual({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
  });

  it("--repair keeps the entry's env; --force drops it and names the keys it dropped", async () => {
    const stored = {
      command: "npx",
      // Stale args, so the entry genuinely differs and both flags have work to
      // do -- with matching args the env carry alone makes --repair a no-op.
      args: ["-y", "@yawlabs/mcp"],
      env: { YAW_MCP_VAULT_PASSPHRASE: "s3cret", OAM_BIN: "/opt/oam" },
    };

    const path = seedEntry(stored);
    const repaired = await install({ repair: true });
    expect(repaired.exitCode, repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain("Kept existing env on the mcp entry: OAM_BIN, YAW_MCP_VAULT_PASSPHRASE");
    const kept = parseJsonc(readFileSync(path, "utf8")) as { context_servers: Record<string, unknown> };
    expect(kept.context_servers[ENTRY_NAME]).toEqual({
      command: "npx",
      args: ["-y", "@yawlabs/mcp@latest"],
      env: { YAW_MCP_VAULT_PASSPHRASE: "s3cret", OAM_BIN: "/opt/oam" },
    });

    seedEntry(stored);
    const forced = await install({ force: true });
    expect(forced.exitCode, forced.stderr).toBe(0);
    expect(forced.stdout).toContain(
      "Dropping existing env on the mcp entry (--force): OAM_BIN, YAW_MCP_VAULT_PASSPHRASE",
    );
    // Keys only, never values -- this line goes on a terminal users paste into
    // bug reports.
    expect(forced.stdout).not.toContain("s3cret");
    const dropped = parseJsonc(readFileSync(path, "utf8")) as { context_servers: Record<string, unknown> };
    expect(dropped.context_servers[ENTRY_NAME]).toEqual({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
  });
});

// ---------------------------------------------------------------------------
// 7. The carried fields, driven through the core the consumers are adopting
// ---------------------------------------------------------------------------

describe("Zed's own per-server fields, carried through the core", () => {
  const site = (): ConfigSite => siteFor("user", "macos");

  /** A settings.json whose `mcp` entry carries the Zed-owned fields. */
  const STORED = `{
  "context_servers": {
    "mcp": {
      "command": "npx",
      "args": ["-y", "@yawlabs/mcp"],
      "enabled": false,
      "remote": true,
      "timeout": 120,
      "source": "custom",
      "env": { "YAW_MCP_VAULT_PASSPHRASE": "s3cret" }
    }
  }
}
`;

  it("carries enabled, remote and timeout onto the entry a rewrite writes", () => {
    const view = classifyClientConfig(STORED, site(), { transform: ZED.entry });
    expect(view.read.kind).toBe("ok");
    expect(view.carried()).toEqual({ enabled: false, remote: true, timeout: 120 });
    // `env` belongs to the core, which has its own string-only filter and its
    // own --force drop line; the transform must not own it twice.
    expect(view.carried().env).toBeUndefined();
    expect(view.carryableEnv()).toEqual({ YAW_MCP_VAULT_PASSPHRASE: "s3cret" });

    const entry = composeEntry({
      base: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
      transform: ZED.entry,
      os: "macos",
      purpose: "broker",
      env: view.carryableEnv(),
      carried: view.carried(),
    });
    expect(entry).toEqual({
      enabled: false,
      remote: true,
      timeout: 120,
      command: "npx",
      args: ["-y", "@yawlabs/mcp@latest"],
      env: { YAW_MCP_VAULT_PASSPHRASE: "s3cret" },
    });
    // Not carried, so it stays visible as drift rather than being written back
    // into a file current Zed migrates it out of.
    expect(entry.source).toBeUndefined();

    // And it survives the round trip into the file.
    const written = applyClientConfigEdits(view, [{ op: "upsert", key: ENTRY_NAME, entry }], site());
    const back = classifyClientConfig(written, site(), { transform: ZED.entry });
    expect(back.entry()?.value).toEqual(entry);
    expect(written).toContain('"enabled": false');
  });

  it("carries nothing on --force, which is what makes that flag a true overwrite", () => {
    const view = classifyClientConfig(STORED, site(), { transform: ZED.entry });
    const entry = composeEntry({
      base: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
      transform: ZED.entry,
      os: "macos",
      purpose: "broker",
    });
    expect(entry).toEqual({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
    const written = applyClientConfigEdits(view, [{ op: "upsert", key: ENTRY_NAME, entry }], site());
    expect(written).not.toContain('"enabled"');
    expect(written).not.toContain("s3cret");
  });

  it("treats a carried field with the WRONG type as drift instead of writing it back", () => {
    // A hand-edited `"timeout": "120"` parses, and Zed's `Option<u64>` rejects
    // it. Carrying it forward would persist something the client cannot read;
    // dropping it is what puts it in the user's drift diff.
    const raw = `{
  "context_servers": {
    "mcp": { "command": "npx", "args": ["-y", "@yawlabs/mcp@latest"], "enabled": false, "timeout": "120" }
  }
}
`;
    const view = classifyClientConfig(raw, site(), { transform: ZED.entry });
    expect(view.carried()).toEqual({ enabled: false });
    const entry = composeEntry({
      base: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
      transform: ZED.entry,
      os: "macos",
      purpose: "broker",
      carried: view.carried(),
    });
    // The well-typed field rides along; the ill-typed one does not, so the
    // stored entry and the entry to write differ -- which is drift.
    expect(entry).toEqual({ enabled: false, command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
    expect(view.entry()?.value).not.toEqual(entry);
  });

  it("leaves a well-typed stored entry byte-identical, so an enabled:false server is not switched back on", () => {
    // The reason the carry list exists at all: without it this entry differs
    // from the one install would write on EVERY run, so a scripted re-install
    // refuses and `--repair` quietly turns the server back on.
    const raw = `{
  "context_servers": {
    "mcp": { "command": "npx", "args": ["-y", "@yawlabs/mcp@latest"], "enabled": false }
  }
}
`;
    const view = classifyClientConfig(raw, site(), { transform: ZED.entry });
    const entry = composeEntry({
      base: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
      transform: ZED.entry,
      os: "macos",
      purpose: "broker",
      carried: view.carried(),
    });
    expect(entry).toEqual({ enabled: false, command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
    // Key ORDER differs (the carried field comes first), which is why the
    // comparison a consumer makes is deepEqualJson over the key SET rather
    // than a string compare.
    expect(new Set(Object.keys(entry))).toEqual(new Set(Object.keys(view.entry()?.value as object)));
  });
});
