// The Cline row, driven through the client-config core the way a consumer has
// to drive it: resolve the sites, keep the ones this machine has, and then run
// the same per-file machinery against EACH site's own bytes.
//
// WHY THIS FILE IS DIFFERENT FROM EVERY OTHER ROW'S. Cline is the one target
// whose single (client, scope) pair is several files. The shipped VS Code
// extension is an A/B package of two runtimes that read DIFFERENT copies of
// cline_mcp_settings.json -- the "next"/SDK half and the CLI read the shared
// `~/.cline/data/settings/` copy, the legacy half (which the loader activates
// by default and falls back to on any error) reads the copy under the editor's
// own globalStorage -- so writing one copy leaves most Cline windows seeing no
// server at all. Sources, fetched as raw bytes on 2026-09-12:
//
//   * shared copy, and its env precedence --
//     https://raw.githubusercontent.com/cline/cline/main/sdk/packages/shared/src/storage/paths.ts
//     `resolveMcpSettingsPath` (:440) -> `$CLINE_MCP_SETTINGS_PATH` trimmed,
//     else `resolveClineDataDir()` (:177) -> `$CLINE_DATA_DIR` trimmed, else
//     `resolveClineDir()` (:151) -> `$CLINE_DIR` trimmed, else
//     `join(<home>, ".cline")` -- then `settings/cline_mcp_settings.json`
//     (`CLINE_MCP_SETTINGS_FILE_NAME`, :81).
//   * the extension's newer runtime reads that same shared copy --
//     https://raw.githubusercontent.com/cline/cline/main/apps/vscode/src/sdk/SdkController.ts
//     :293 "IMPORTANT: Use ~/.cline/data/settings/ for the settings directory,
//     NOT ensureSettingsDirectoryExists() which returns the VSCode extension
//     storage path".
//   * the legacy runtime reads the per-editor copy --
//     branch `legacy-extension`, apps/vscode/src/core/storage/disk.ts:242
//     `ensureSettingsDirectoryExists() => getGlobalStorageDir("settings")`,
//     :444 `path.resolve(HostProvider.get().globalStorageFsPath, ...subdirs)`.
//   * an entry left in an editor copy can be MIGRATED back into the shared one,
//     which is why uninstall has to reach every copy --
//     https://raw.githubusercontent.com/cline/cline/main/apps/vscode/src/hosts/vscode/mcp-settings-legacy-migration.ts
//     :239-243 reads `<globalStorageUri.fsPath>/settings/cline_mcp_settings.json`.
//   * both runtimes parse STRICTLY -- main McpHub.ts:213 and legacy
//     McpHub.ts:183 both `JSON.parse(content)`, and the main one toasts
//     "Invalid JSON in MCP settings file. Please check the syntax." (:218).
//   * both watch the file and reconnect without a restart -- main
//     McpHub.ts:292-302, `chokidar.watch(settingsPath, { persistent: true,
//     ignoreInitial: true, awaitWriteFinish: {...}, atomic: true })`.
//   * the editor user-data root is `join(<platform app-data dir>, productName)`
//     -- https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/environment/node/userDataPath.ts
//     `getDefaultUserDataPath` (:79): win32 `%APPDATA%`, darwin
//     `~/Library/Application Support`, linux `$XDG_CONFIG_HOME || ~/.config`.
//
// HERMETIC. Every case builds its own throwaway home under the OS temp dir,
// every path is resolved from that home, and the row is asked for its sites
// with an explicit `env` -- so nothing here can read, let alone write, a real
// Cline config. The row is reached through INSTALL_TARGETS rather than
// imported from target-cline.js on purpose: a row that is not in the table is
// not installed by anything, and this file would otherwise pass for a row that
// had been dropped from it.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyClientConfigEdits,
  type ClientConfigEdit,
  type ClientConfigView,
  type ConfigSite,
  canonicalJson,
  classifyClientConfig,
  composeEntry,
  effectiveConfigFormat,
  importViewOf,
  normalizeEntry,
  readClientConfigFile,
  reloadDoneClause,
  selectSites,
  terminateWithNewline,
} from "../client-config.js";
import { UTF8_BOM } from "../client-config-json.js";
import { buildLaunchEntry, ENTRY_NAME, INSTALL_TARGETS, type InstallOS, type PathBase } from "../install-targets.js";

// CR is built from its code point, never typed as an escape. A backslash-r
// that loses a level on its way into this file would become a real CR inside a
// literal, which is valid TypeScript and silently changes what a line-ending
// assertion means. (A lone backslash-n cannot hide the same way -- it ends the
// literal and the file stops parsing -- so LF stays a readable escape.)
const CR = String.fromCharCode(13);

const FIXTURES = fileURLToPath(new URL("fixtures/cline/", import.meta.url));

/** One fixture's bytes, verbatim. No trimming, no line-ending fix-up: three of
 *  these deliberately end WITHOUT a final newline, because that is how Cline's
 *  own writer leaves the file. */
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.json.txt`), "utf8");
}

const BOOTSTRAP = fixture("bootstrap");
const SIBLINGS = fixture("sibling-servers");
const RESTAMPED_WIN = fixture("restamped-win");
const STALE_WIN = fixture("stale-win");
const NESTED_WIN = fixture("nested-transport-win");
const LEGACY_KEY = fixture("legacy-key-posix");
const TRAILING_COMMA = fixture("trailing-comma");
const LINE_COMMENT = fixture("line-comment");
const BLOCK_COMMENT = fixture("block-comment");
const TRUNCATED = fixture("truncated");

/** What install writes into a file that does not exist yet, per OS. */
const FRESH_POSIX =
  '{\n  "mcpServers": {\n    "mcp": {\n      "command": "npx",\n      "args": [\n        "-y",\n' +
  '        "@yawlabs/mcp@latest"\n      ]\n    }\n  }\n}\n';
const FRESH_WIN =
  '{\n  "mcpServers": {\n    "mcp": {\n      "command": "cmd",\n      "args": [\n        "/c",\n' +
  '        "npx",\n        "-y",\n        "@yawlabs/mcp@latest"\n      ]\n    }\n  }\n}\n';

const SETTINGS_FILE = "cline_mcp_settings.json";
const STORAGE = "saoudrizwan.claude-dev";

const row = (() => {
  const found = INSTALL_TARGETS.find((t) => t.clientId === "cline");
  if (!found) throw new Error("no cline row in INSTALL_TARGETS");
  return found;
})();

const SCOPE = row.scopes[0];

// ---------------------------------------------------------------------------
// The hermetic machine
// ---------------------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), "yaw-mcp-cline-"));
let seq = 0;

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** A fresh empty home, plus the PathBase a consumer hands the row. `appData`
 *  is derived from that home rather than read from the environment, which is
 *  what keeps a Windows case from resolving to the developer's own editor. */
function machine(os: InstallOS, env: PathBase["env"] = {}): PathBase {
  seq += 1;
  const home = join(ROOT, `h${seq}`);
  mkdirSync(home, { recursive: true });
  return { home, appData: join(home, "AppData", "Roaming"), projectDir: "", os, scope: "user", env };
}

/** The row's sites, as ConfigSites -- the format resolved once, from the
 *  target's shape narrowed by the scope, exactly as a consumer must. */
function sitesOf(base: PathBase): ConfigSite[] {
  const spec = row.sites?.(base);
  if (spec === undefined) throw new Error("the cline row has no sites hook");
  const format = effectiveConfigFormat(row.config, SCOPE);
  return spec.map((s) => ({ id: s.id, label: s.label, resolved: s.resolved, detectDir: s.detectDir, format }));
}

/** The sites this machine actually has: the shared file always, an editor copy
 *  only where that editor's Cline storage directory exists. */
function detectedSites(base: PathBase): ConfigSite[] {
  return selectSites(sitesOf(base));
}

/** Make it look as though Cline has run in `editor` -- create its storage
 *  DIRECTORY, which is what the extension does on first activation, and
 *  optionally seed the settings file with `raw`. */
function editorRan(base: PathBase, editorDir: string, raw?: string): string {
  const settings = join(base.appData, editorDir, "User", "globalStorage", STORAGE, "settings");
  mkdirSync(settings, { recursive: true });
  const file = join(settings, SETTINGS_FILE);
  if (raw !== undefined) writeFileSync(file, raw, "utf8");
  return file;
}

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function viewOf(site: ConfigSite): ClientConfigView {
  return classifyClientConfig(readIfPresent(site.resolved.absolute), site, { transform: row.entry });
}

type Flag = "none" | "repair" | "force";

/** The entry install would write into one site: the launcher's command and
 *  args, plus whatever the site's stored entry hands forward. `--force` is the
 *  one path that carries nothing -- it drops the stored env AND the
 *  Cline-owned fields, which is exactly what makes it an overwrite. */
function entryFor(view: ClientConfigView, os: InstallOS, flag: Flag): Record<string, unknown> {
  const force = flag === "force";
  return composeEntry({
    base: buildLaunchEntry({ os }),
    transform: row.entry,
    os,
    purpose: "broker",
    env: force ? undefined : view.carryableEnv(),
    carried: force ? {} : view.carried(),
  });
}

interface SiteOutcome {
  id: string;
  path: string;
  action: "wrote" | "identical" | "refused";
  detail?: string;
}

/** Install across every detected site, each against its OWN bytes.
 *
 *  This is the shape the consumer owes Cline: one read, one comparison, one
 *  write per site. Nothing is shared between sites but the launch entry --
 *  a site whose file carries a disabled flag keeps it while its neighbour
 *  does not, and a site that is already correct is not rewritten. */
function installAcross(base: PathBase, flag: Flag = "none"): SiteOutcome[] {
  const out: SiteOutcome[] = [];
  for (const site of detectedSites(base)) {
    const view = viewOf(site);
    const path = site.resolved.absolute;
    const entry = entryFor(view, base.os, flag);
    if (view.read.kind === "ok" && canonicalJson(view.normalized()) === canonicalJson(entry)) {
      out.push({ id: site.id, path, action: "identical" });
      continue;
    }
    const edits: ClientConfigEdit[] = [{ op: "upsert", key: ENTRY_NAME, entry }];
    const legacy = view.legacyKey();
    if (legacy !== null) edits.push({ op: "remove", key: legacy });
    try {
      const text = terminateWithNewline(applyClientConfigEdits(view, edits, site));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, "utf8");
      out.push({ id: site.id, path, action: "wrote" });
    } catch (err) {
      out.push({ id: site.id, path, action: "refused", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Uninstall across every detected site. A site with nothing of ours in it is
 *  silent; a site whose removal is a no-op is never rewritten. */
function uninstallAcross(base: PathBase): SiteOutcome[] {
  const out: SiteOutcome[] = [];
  for (const site of detectedSites(base)) {
    const view = viewOf(site);
    const path = site.resolved.absolute;
    const keys = [ENTRY_NAME, ...(view.legacyKey() === null ? [] : [view.legacyKey() as string])].filter(
      (k) => view.entry(k) !== undefined,
    );
    if (keys.length === 0) continue;
    try {
      const text = applyClientConfigEdits(
        view,
        keys.map((key) => ({ op: "remove", key }) as ClientConfigEdit),
        site,
      );
      // Identity, not equality: a removal that found nothing returns the input
      // string ITSELF, and terminating that would turn "nothing changed" into
      // a phantom write.
      if (text === view.raw) continue;
      writeFileSync(path, terminateWithNewline(text), "utf8");
      out.push({ id: site.id, path, action: "wrote" });
    } catch (err) {
      out.push({ id: site.id, path, action: "refused", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** The STATUS one site reports in `install --list` and in doctor.
 *
 *  A strict-unloadable file is `malformed` here even though the core read it
 *  `ok`: Cline parses this file with JSON.parse, so a comment in it means no
 *  server in it is loading, and a row saying "installed" would be false. That
 *  is read off `view.unloadable()`, never off the read kind. */
function statusOf(view: ClientConfigView): string {
  if (view.read.kind === "absent") return "not installed";
  if (view.read.kind === "unreadable") return `unreadable: ${view.read.code ?? "?"}`;
  if (view.read.kind === "malformed") return "malformed";
  if (view.unloadable() !== null) return "malformed";
  if (view.read.kind !== "ok") return view.read.kind;
  if (view.entry() !== undefined) return "installed";
  const legacy = view.legacyKey();
  if (legacy !== null) return `legacy: ${legacy}`;
  if (view.otherServerKeys().length > 0) return "other-entries";
  return "no-entries";
}

// ---------------------------------------------------------------------------
// Sites and detection
// ---------------------------------------------------------------------------

describe("cline resolves one (client, scope) to a shared file plus a site per editor", () => {
  it("names six sites in a fixed order, every one addressing mcpServers", () => {
    const sites = sitesOf(machine("windows"));
    expect(sites.map((s) => s.id)).toEqual(["shared", "vscode", "vscode-insiders", "vscodium", "cursor", "windsurf"]);
    for (const site of sites) {
      expect(site.resolved.containerPath, `${site.id} addresses another container`).toEqual(["mcpServers"]);
      // STRICT on every site: Cline reads each copy the same way.
      expect(site.format, `${site.id} is not strict`).toBe("json");
    }
    // The shared copy is unconditional -- it is the one install creates when
    // there is nothing at all -- and every editor copy is gated.
    expect(sites[0].detectDir).toBeNull();
    expect(sites.slice(1).every((s) => s.detectDir !== null)).toBe(true);
  });

  it("with no editor detected, keeps the shared file and creates no editor tree", () => {
    // The MUTATION this pins: drop the `detectDir` gate on the editor sites in
    // target-cline.ts and this goes red on the first assertion, because every
    // editor becomes a site on a machine that has none of them.
    const base = machine("windows");
    expect(detectedSites(base).map((s) => s.id)).toEqual(["shared"]);

    const outcomes = installAcross(base);
    expect(outcomes.map((o) => o.action)).toEqual(["wrote"]);
    expect(readFileSync(outcomes[0].path, "utf8")).toBe(FRESH_WIN);

    // Not one editor directory was brought into existence. yaw-mcp does not
    // pre-provision another application's storage tree.
    for (const dir of ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"]) {
      expect(existsSync(join(base.appData, dir)), `${dir} was created`).toBe(false);
    }
  });

  it("with one editor detected, writes that copy and the shared one", () => {
    const base = machine("windows");
    const vscode = editorRan(base, "Code");

    expect(detectedSites(base).map((s) => s.id)).toEqual(["shared", "vscode"]);
    const outcomes = installAcross(base);
    expect(outcomes.map((o) => `${o.id}:${o.action}`)).toEqual(["shared:wrote", "vscode:wrote"]);
    expect(readFileSync(vscode, "utf8")).toBe(FRESH_WIN);
    expect(readFileSync(outcomes[0].path, "utf8")).toBe(FRESH_WIN);
    expect(existsSync(join(base.appData, "Cursor"))).toBe(false);
  });

  it("with several editors detected, writes each one against its own bytes", () => {
    const base = machine("windows");
    // Three editors in three different states: one that has never had a
    // server, one carrying a foreign server, and one that is already wired to
    // an old version. A fan-out that shared one read between sites would write
    // the same bytes into all three.
    const code = editorRan(base, "Code", BOOTSTRAP);
    const cursor = editorRan(base, "Cursor", SIBLINGS);
    const codium = editorRan(base, "VSCodium", STALE_WIN);

    // TABLE order, not creation order: the rows a user reads are stable.
    expect(detectedSites(base).map((s) => s.id)).toEqual(["shared", "vscode", "vscodium", "cursor"]);
    const outcomes = installAcross(base, "repair");
    expect(outcomes.every((o) => o.action === "wrote")).toBe(true);
    expect(outcomes.length).toBe(4);

    // The bootstrap file becomes exactly what a fresh one would be.
    expect(readFileSync(code, "utf8")).toBe(FRESH_WIN);
    // The foreign server keeps every byte it had, ours is appended after it.
    const withSibling = readFileSync(cursor, "utf8");
    expect(withSibling.startsWith(SIBLINGS.slice(0, SIBLINGS.lastIndexOf("\n    }\n  }\n}")))).toBe(true);
    expect(withSibling).toContain('"@modelcontextprotocol/server-filesystem"');
    expect(JSON.parse(withSibling).mcpServers.filesystem).toEqual(JSON.parse(SIBLINGS).mcpServers.filesystem);
    // The stale one is repaired, and keeps the user's own Cline settings.
    const repaired = JSON.parse(readFileSync(codium, "utf8")).mcpServers.mcp;
    expect(repaired.args).toEqual(["/c", "npx", "-y", "@yawlabs/mcp@latest"]);
    expect(repaired.disabled).toBe(true);
    expect(repaired.autoApprove).toEqual(["mcp_connect_dispatch"]);
    expect(repaired.timeout).toBe(120);
    expect(repaired.env).toEqual({ OAM_BIN: "C:/oam/oam.exe" });
    // Untouched editors stay untouched.
    expect(existsSync(join(base.appData, "Code - Insiders"))).toBe(false);
    expect(existsSync(join(base.appData, "Windsurf"))).toBe(false);
  });

  it("spells each site's path and display per OS", () => {
    const win = sitesOf(machine("windows"));
    expect(win[0].resolved.display).toBe(`%USERPROFILE%\\.cline\\data\\settings\\${SETTINGS_FILE}`);
    expect(win[1].resolved.display).toBe(
      `%APPDATA%\\Code\\User\\globalStorage\\${STORAGE}\\settings\\${SETTINGS_FILE}`,
    );

    const macBase = machine("macos");
    const mac = sitesOf(macBase);
    expect(mac[0].resolved.absolute).toBe(join(macBase.home, ".cline", "data", "settings", SETTINGS_FILE));
    expect(mac[4].resolved.absolute).toBe(
      join(
        macBase.home,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        STORAGE,
        "settings",
        SETTINGS_FILE,
      ),
    );
    expect(mac[4].resolved.display).toBe(
      `~/Library/Application Support/Cursor/User/globalStorage/${STORAGE}/settings/${SETTINGS_FILE}`,
    );

    const linuxBase = machine("linux");
    const linux = sitesOf(linuxBase);
    expect(linux[3].resolved.absolute).toBe(
      join(linuxBase.home, ".config", "VSCodium", "User", "globalStorage", STORAGE, "settings", SETTINGS_FILE),
    );
    expect(linux[3].resolved.display).toBe(
      `~/.config/VSCodium/User/globalStorage/${STORAGE}/settings/${SETTINGS_FILE}`,
    );
  });

  it("follows Cline's own env precedence for the shared copy, and only for it", () => {
    const shared = (env: PathBase["env"]): ConfigSite => sitesOf(machine("linux", env))[0];
    expect(shared({ clineMcpSettingsPath: "/exact/file.json" }).resolved.absolute).toBe("/exact/file.json");
    expect(shared({ clineDataDir: "/data" }).resolved.absolute).toBe(join("/data", "settings", SETTINGS_FILE));
    expect(shared({ clineDir: "/cline" }).resolved.absolute).toBe(join("/cline", "data", "settings", SETTINGS_FILE));
    // Cline trims each value and treats a blank one as unset
    // (`process.env.CLINE_DATA_DIR?.trim()`), so a whitespace-only value must
    // not become a path made of spaces.
    const blank = machine("linux", { clineDataDir: "   " });
    expect(sitesOf(blank)[0].resolved.absolute).toBe(join(blank.home, ".cline", "data", "settings", SETTINGS_FILE));

    // An env-directed path is shown verbatim: a `~` spelling would hide the
    // redirect that moved the file.
    expect(shared({ clineDataDir: "/data" }).resolved.display).toBe(join("/data", "settings", SETTINGS_FILE));

    // The editor copies are the EXTENSION's storage, which no CLINE_* variable
    // moves -- they are addressed by the editor, not by Cline.
    const redirected = machine("windows", { clineDataDir: "D:/data", clineDir: "D:/c" });
    expect(sitesOf(redirected)[1].resolved.absolute).toBe(
      join(redirected.appData, "Code", "User", "globalStorage", STORAGE, "settings", SETTINGS_FILE),
    );
  });
});

// ---------------------------------------------------------------------------
// The bytes one site ends up with
// ---------------------------------------------------------------------------

describe("each site's own bytes", () => {
  it("turns Cline's bootstrap into exactly what a fresh install renders", () => {
    // Cline's legacy runtime creates the file as
    // `JSON.stringify({ mcpServers: {} }, null, 2)` -- no trailing newline --
    // on its first activation in an editor, so this is the commonest input.
    expect(BOOTSTRAP.endsWith("\n")).toBe(false);
    const base = machine("linux");
    const shared = sitesOf(base)[0].resolved.absolute;
    mkdirSync(dirname(shared), { recursive: true });
    writeFileSync(shared, BOOTSTRAP, "utf8");

    expect(installAcross(base).map((o) => o.action)).toEqual(["wrote"]);
    expect(readFileSync(shared, "utf8")).toBe(FRESH_POSIX);
  });

  it("keeps a CRLF file on CRLF, final line ending included", () => {
    // The fixture is LF on disk -- `.gitattributes` sets `* text=auto eol=lf`,
    // so a committed CRLF file would be normalised and would be lying about
    // its own bytes -- and the CRLF input is therefore built here, from a code
    // point, and checked before it is used. It ends WITH a CRLF, so the one
    // trailing newline the writer guarantees is already there and the whole
    // output can be asserted rather than all-but-the-last-byte.
    const crlf = `${SIBLINGS.split("\n").join(`${CR}\n`)}${CR}\n`;
    expect(crlf.includes(`${CR}\n`)).toBe(true);
    expect(/[^\r]\n/.test(crlf)).toBe(false);

    const base = machine("windows");
    const file = editorRan(base, "Code", crlf);
    installAcross(base);
    const after = readFileSync(file, "utf8");
    expect(/[^\r]\n/.test(after), "a bare LF got into a CRLF file").toBe(false);
    expect(after.split(`${CR}\n`).length).toBeGreaterThan(crlf.split(`${CR}\n`).length);
    expect(JSON.parse(after).mcpServers.mcp.command).toBe("cmd");
  });

  it("strips a UTF-8 BOM, which is what makes the file readable for Cline again", () => {
    // Node's `readFile(..., "utf-8")` keeps a leading U+FEFF and `JSON.parse`
    // rejects it, so a BOM-prefixed file is one Cline cannot read. The splicer
    // drops the BOM and does not re-emit it, so the write is the fix -- which
    // is why a BOM is NOT a refusal.
    expect(UTF8_BOM.charCodeAt(0)).toBe(0xfeff);
    expect(UTF8_BOM.length).toBe(1);
    const base = machine("linux");
    const shared = sitesOf(base)[0].resolved;
    mkdirSync(dirname(shared.absolute), { recursive: true });
    writeFileSync(shared.absolute, UTF8_BOM + BOOTSTRAP, "utf8");

    installAcross(base);
    const after = readFileSync(shared.absolute, "utf8");
    expect(after.charCodeAt(0)).toBe(0x7b);
    expect(after).toBe(FRESH_POSIX);
    expect(() => JSON.parse(after)).not.toThrow();
  });

  it("trims a legacy key in the same write, and leaves the file strict", () => {
    const base = machine("linux");
    const shared = sitesOf(base)[0].resolved.absolute;
    mkdirSync(dirname(shared), { recursive: true });
    writeFileSync(shared, LEGACY_KEY, "utf8");

    installAcross(base);
    const after = readFileSync(shared, "utf8");
    expect(after).toBe(FRESH_POSIX);
    expect(Object.keys(JSON.parse(after).mcpServers)).toEqual([ENTRY_NAME]);
  });

  it("writes nothing at all on a re-run", () => {
    const base = machine("windows");
    editorRan(base, "Code", BOOTSTRAP);
    const first = installAcross(base);
    expect(first.map((o) => o.action)).toEqual(["wrote", "wrote"]);

    const stamps = first.map((o) => statSync(o.path).mtimeMs);
    const second = installAcross(base);
    expect(second.map((o) => o.action)).toEqual(["identical", "identical"]);
    expect(second.map((o) => statSync(o.path).mtimeMs)).toEqual(stamps);
  });
});

// ---------------------------------------------------------------------------
// The fields Cline owns on our entry
// ---------------------------------------------------------------------------

describe("the Cline-owned fields on our entry", () => {
  it("carries disabled, autoApprove and timeout, and `type` only when it says stdio", () => {
    const carry = row.entry?.carry;
    expect(carry).toBeDefined();
    expect(carry?.({ disabled: true, autoApprove: ["a"], timeout: 60, type: "stdio", command: "x" })).toEqual({
      disabled: true,
      autoApprove: ["a"],
      timeout: 60,
      type: "stdio",
    });
    // Ill-typed values are the user's to fix, not ours to propagate: carrying
    // one would write something Cline's own schema rejects back into the file.
    expect(carry?.({ disabled: "yes", autoApprove: [1], timeout: "60", type: "sse" })).toEqual({});
    // `env` is the CORE's field, never the row's -- two owners for one field is
    // how a `--force` drop comes to miss half of it.
    expect(carry?.({ env: { A: "b" } })).toEqual({});
  });

  it("treats a Cline write-back as identical, so one UI click does not become drift", () => {
    // The MUTATION this pins: delete the `carry` hook from the row and this
    // goes red, because the re-stamped `timeout` and `type` read as drift and
    // the run rewrites a file it had no reason to touch.
    //
    // The legacy runtime re-serialises the whole ZOD-PARSED settings object on
    // any server's toggle (`McpHub.ts:1133-1144` on branch legacy-extension:
    // `fs.writeFile(settingsPath, JSON.stringify(config, null, 2))`), so our
    // entry comes back with the schema's own defaults stamped onto it.
    const base = machine("windows");
    const file = editorRan(base, "Code", RESTAMPED_WIN);
    const before = statSync(file).mtimeMs;

    const outcomes = installAcross(base);
    expect(outcomes.find((o) => o.id === "vscode")?.action).toBe("identical");
    expect(readFileSync(file, "utf8")).toBe(RESTAMPED_WIN);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("keeps them through --repair and drops them under --force", () => {
    const repaired = machine("windows");
    const rFile = editorRan(repaired, "Code", STALE_WIN);
    installAcross(repaired, "repair");
    const kept = JSON.parse(readFileSync(rFile, "utf8")).mcpServers.mcp;
    expect(kept).toEqual({
      disabled: true,
      autoApprove: ["mcp_connect_dispatch"],
      timeout: 120,
      command: "cmd",
      args: ["/c", "npx", "-y", "@yawlabs/mcp@latest"],
      env: { OAM_BIN: "C:/oam/oam.exe" },
    });

    const forced = machine("windows");
    const fFile = editorRan(forced, "Code", STALE_WIN);
    installAcross(forced, "force");
    expect(readFileSync(fFile, "utf8")).toBe(FRESH_WIN);
  });

  it("names the keys --force would drop, so the line can say what it dropped", () => {
    const base = machine("windows");
    editorRan(base, "Code", STALE_WIN);
    const view = viewOf(detectedSites(base)[1]);
    expect(Object.keys(view.carried()).sort()).toEqual(["autoApprove", "disabled", "timeout"]);
    expect(Object.keys(view.carryableEnv() ?? {})).toEqual(["OAM_BIN"]);
    // A disabled entry is a fact a run has to be able to state: install leaves
    // that choice alone, so it has to say so rather than silently ship a
    // server that will not start.
    expect(view.carried().disabled).toBe(true);
  });

  it("does NOT carry the three keys Cline preserves for its CLI", () => {
    // `remoteConfigured`, `oauth` and `metadata` are optional per-server fields
    // in Cline's schema, annotated there as "preserved as-is"
    // (apps/vscode/src/services/mcp/schemas.ts:21-27). The row does not carry
    // them, so an entry of ours that has one reads as DRIFT and `--repair`
    // drops it. Nothing consumes that today -- import-cmd has not adopted the
    // core -- and it is recorded here so the next change to the row is a
    // decision rather than a discovery.
    expect(row.entry?.carry?.({ remoteConfigured: true, oauth: { t: 1 }, metadata: { a: "b" } })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The nested transport form
// ---------------------------------------------------------------------------

describe("the nested transport form the Cline CLI writes", () => {
  it("folds to the flat shape on read, the way Cline's own schema folds it", () => {
    // Cline's `nestedTransportConfigSchema` transform is
    // `const { transport, ...rest } = data; return { ...transport, ...rest }`
    // (apps/vscode/src/services/mcp/schemas.ts:80-84). The row folds it the
    // same way round, so the flat spelling wins when both are present.
    const normalize = row.entry?.normalize;
    expect(normalizeEntry(JSON.parse(NESTED_WIN).mcpServers.mcp, { normalize })).toEqual({
      type: "stdio",
      command: "cmd",
      args: ["/c", "npx", "-y", "@yawlabs/mcp@latest"],
      disabled: false,
      timeout: 60,
    });
    expect(normalizeEntry({ transport: { command: "old" }, command: "new" }, { normalize })).toEqual({
      command: "new",
    });
    // Anything that is not an object under `transport` is left alone rather
    // than spread into the entry.
    expect(normalizeEntry({ transport: "stdio", command: "x" }, { normalize })).toEqual({
      transport: "stdio",
      command: "x",
    });
  });

  it("reads a nested entry as OURS rather than as a foreign server", () => {
    // The MUTATION this pins: delete the `normalize` hook and this goes red.
    // Without it the stored value has no top-level `command`, so `launch` is
    // null, the entry reads as an opaque object, and `--list` and doctor both
    // report a server that is plainly there as not installed.
    const base = machine("windows");
    editorRan(base, "Code", NESTED_WIN);
    const view = viewOf(detectedSites(base)[1]);
    expect(view.entry()?.launch?.command).toBe("cmd");
    expect(view.entry()?.launch?.args).toEqual(["/c", "npx", "-y", "@yawlabs/mcp@latest"]);
    expect(statusOf(view)).toBe("installed");
  });

  it("rewrites the nested form FLAT once, then leaves it alone", () => {
    // A nested entry is rewritten even when its command and args already
    // match, and that is deliberate rather than churn: the LEGACY runtime --
    // the one the rollout loader activates by default and falls back to on any
    // error -- has no nested arm at all. Its three arms each require a
    // top-level `command` or `url`
    // (branch legacy-extension, apps/vscode/src/services/mcp/schemas.ts:17-91),
    // and `McpSettingsSchema` is `z.object({ mcpServers: z.record(...) })`
    // (:95-97), so ONE nested entry fails the whole-file `safeParse` and that
    // window loads no server from the file at all ("Invalid MCP settings
    // schema.", McpHub.ts:197-201). Flattening ours is the repair.
    const base = machine("windows");
    const file = editorRan(base, "Code", NESTED_WIN);
    expect(installAcross(base).find((o) => o.id === "vscode")?.action).toBe("wrote");

    const after = JSON.parse(readFileSync(file, "utf8")).mcpServers.mcp;
    expect(after.transport).toBeUndefined();
    expect(after.command).toBe("cmd");
    expect(after.args).toEqual(["/c", "npx", "-y", "@yawlabs/mcp@latest"]);
    // The user's own fields come across from the top level of the stored
    // entry, where the CLI writes them.
    expect(after.disabled).toBe(false);
    expect(after.timeout).toBe(60);
    // `type` is NOT written. It lived inside the `transport` object, which is
    // the one place `carry` cannot see (it is handed the STORED value, and
    // `normalize` is what hoists that key). Omitting it is valid either way:
    // both stdio arms declare `type: z.literal("stdio").optional()` and
    // default it in their transform.
    expect(after.type).toBeUndefined();

    // Converged: the second run writes nothing, so the flattening costs one
    // write and not one per invocation.
    const stamp = statSync(file).mtimeMs;
    expect(installAcross(base).find((o) => o.id === "vscode")?.action).toBe("identical");
    expect(statSync(file).mtimeMs).toBe(stamp);
  });
});

// ---------------------------------------------------------------------------
// Strict JSON
// ---------------------------------------------------------------------------

describe("a file Cline cannot parse is refused, not spliced", () => {
  const unloadable: Array<[string, string]> = [
    ["a trailing comma", TRAILING_COMMA],
    ["a line comment", LINE_COMMENT],
    ["a block comment", BLOCK_COMMENT],
  ];

  for (const [what, raw] of unloadable) {
    it(`refuses ${what} under every flag, and leaves the bytes alone`, () => {
      // The MUTATION this pins: change the row's `config.format` from "json"
      // to "jsonc" and this goes red -- the write succeeds and yaw-mcp prints
      // Done over a file in which Cline is loading no server at all.
      expect(() => JSON.parse(raw)).toThrow();
      for (const flag of ["none", "repair", "force"] as Flag[]) {
        const base = machine("windows");
        const file = editorRan(base, "Code", raw);
        const shared = sitesOf(base)[0].resolved.absolute;
        const outcomes = installAcross(base, flag);
        const refusal = outcomes.find((o) => o.id === "vscode");
        expect(refusal?.action, `${what} was written under --${flag}`).toBe("refused");
        expect(refusal?.detail).toContain("refusing to write into it");
        expect(readFileSync(file, "utf8")).toBe(raw);
        // The shared copy is a DIFFERENT file, so one site's refusal does not
        // take the rest of the fan-out down with it.
        expect(readFileSync(shared, "utf8")).toBe(FRESH_WIN);
      }
    });
  }

  it("still lists the entries in such a file, and still lets uninstall take ours out", () => {
    const base = machine("windows");
    const withOurs = TRAILING_COMMA.replace(
      '"filesystem"',
      '"mcp": {"command": "cmd", "args": ["/c", "npx", "-y", "@yawlabs/mcp@latest"]},\n    "filesystem"',
    );
    const file = editorRan(base, "Code", withOurs);
    const view = viewOf(detectedSites(base)[1]);
    // Readable by us, unreadable by Cline: that is the whole point of the
    // strict flavour reporting `ok` with `unloadable` set.
    expect(view.read.kind).toBe("ok");
    expect(view.unloadable()).not.toBeNull();
    expect(view.otherServerKeys()).toEqual(["filesystem"]);
    // ... and reported as malformed, because a row saying "installed" would
    // claim a server is loading when none in this file is.
    expect(statusOf(view)).toBe("malformed");

    expect(uninstallAcross(base).map((o) => o.action)).toEqual(["wrote"]);
    expect(readFileSync(file, "utf8")).not.toContain("@yawlabs/mcp@latest");
    expect(readFileSync(file, "utf8")).toContain("server-filesystem");
  });

  it("takes the ordinary malformed path when BOTH parsers refuse the file", () => {
    const base = machine("windows");
    const file = editorRan(base, "Code", TRUNCATED);
    const view = viewOf(detectedSites(base)[1]);
    expect(view.read.kind).toBe("malformed");
    expect(view.unloadable()).toBeNull();
    expect(statusOf(view)).toBe("malformed");

    const refused = installAcross(base).find((o) => o.id === "vscode");
    expect(refused?.action).toBe("refused");
    expect(refused?.detail).toContain("is not valid JSON");
    expect(readFileSync(file, "utf8")).toBe(TRUNCATED);
  });

  it("gives a dry run the one signal it has to consult before printing a preview", () => {
    // A flag changes only the ENTRY a run composes, never the edit it applies,
    // which is why all three flags above hit the same refusal. A `--dry-run`
    // applies no edit at all, so the signal it reads is the view's own.
    const base = machine("windows");
    editorRan(base, "Code", LINE_COMMENT);
    expect(viewOf(detectedSites(base)[1]).unloadable()?.syntax).toBe("JSON");
    expect(viewOf(detectedSites(base)[0]).unloadable()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

describe("uninstall reaches every copy", () => {
  it("empties the entry out of the shared file and every detected editor", () => {
    // The MUTATION this pins: delete the `sites` hook from the row (so the
    // target falls back to the single `resolvePath` site) and this goes red
    // with the editor copy still holding `mcp`.
    //
    // It is not a tidiness point. A first-time activation of the newer runtime
    // MIGRATES servers out of an editor copy into the shared file
    // (mcp-settings-legacy-migration.ts:239-243, once per source, recorded
    // under globalState `__vscodeLegacyMcpSettingsMigration`), so an entry
    // left behind in one copy comes back in another.
    const base = machine("windows");
    const code = editorRan(base, "Code");
    const cursor = editorRan(base, "Cursor", SIBLINGS);
    installAcross(base);
    const shared = detectedSites(base)[0].resolved.absolute;

    const outcomes = uninstallAcross(base);
    expect(outcomes.map((o) => o.id).sort()).toEqual(["cursor", "shared", "vscode"]);
    for (const path of [shared, code, cursor]) {
      const after = JSON.parse(readFileSync(path, "utf8"));
      expect(Object.keys(after.mcpServers)).not.toContain(ENTRY_NAME);
    }
    // The neighbour survives, with its own fields intact.
    expect(JSON.parse(readFileSync(cursor, "utf8")).mcpServers.filesystem).toEqual(
      JSON.parse(SIBLINGS).mcpServers.filesystem,
    );
    // Removing the last entry leaves a strict, still-loadable file that Cline
    // reads as "no servers".
    expect(() => JSON.parse(readFileSync(code, "utf8"))).not.toThrow();
    expect(JSON.parse(readFileSync(code, "utf8")).mcpServers).toEqual({});
  });

  it("is silent on a site that holds nothing of ours, and rewrites nothing there", () => {
    const base = machine("windows");
    const cursor = editorRan(base, "Cursor", SIBLINGS);
    const code = editorRan(base, "Code", BOOTSTRAP);
    const before = [statSync(cursor).mtimeMs, statSync(code).mtimeMs];
    expect(uninstallAcross(base)).toEqual([]);
    expect([statSync(cursor).mtimeMs, statSync(code).mtimeMs]).toEqual(before);
    expect(readFileSync(cursor, "utf8")).toBe(SIBLINGS);
    expect(readFileSync(code, "utf8")).toBe(BOOTSTRAP);
  });

  it("takes a legacy key out too", () => {
    const base = machine("linux");
    const shared = sitesOf(base)[0].resolved.absolute;
    mkdirSync(dirname(shared), { recursive: true });
    writeFileSync(shared, LEGACY_KEY, "utf8");
    expect(uninstallAcross(base).map((o) => o.action)).toEqual(["wrote"]);
    expect(JSON.parse(readFileSync(shared, "utf8")).mcpServers).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// --list and doctor, per site
// ---------------------------------------------------------------------------

describe("--list and doctor report one row per site", () => {
  it("reports only the sites this machine has, in table order, with a status each", () => {
    const base = machine("windows");
    editorRan(base, "Code", BOOTSTRAP);
    editorRan(base, "Cursor", SIBLINGS);
    const rows = detectedSites(base).map((site) => ({
      id: site.id,
      label: site.label,
      display: site.resolved.display,
      status: statusOf(viewOf(site)),
    }));

    expect(rows.map((r) => `${r.id}=${r.status}`)).toEqual([
      "shared=not installed",
      "vscode=no-entries",
      "cursor=other-entries",
    ]);
    // Undetected editors are NOT rows: five "not installed" lines would read
    // as five config files the user is missing.
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.label)).toEqual(["shared settings", "VS Code", "Cursor"]);
    expect(rows[1].display.startsWith("%APPDATA%\\Code\\")).toBe(true);

    installAcross(base);
    expect(detectedSites(base).map((s) => statusOf(viewOf(s)))).toEqual(["installed", "installed", "installed"]);
  });

  it("reports a legacy key and an unreadable path distinctly", async () => {
    const base = machine("linux");
    const shared = sitesOf(base)[0].resolved.absolute;
    mkdirSync(dirname(shared), { recursive: true });
    writeFileSync(shared, LEGACY_KEY, "utf8");
    expect(statusOf(viewOf(sitesOf(base)[0]))).toBe("legacy: yaw-mcp");

    // A DIRECTORY where the file should be. Through the core's own IO, so the
    // errno is carried rather than turned into a syntax complaint: a user with
    // a directory (or an AV scanner holding the handle) must not be sent to go
    // and fix JSON that is not there.
    const dirBase = machine("linux");
    const site = sitesOf(dirBase)[0];
    mkdirSync(site.resolved.absolute, { recursive: true });
    const view = await readClientConfigFile(site, { transform: row.entry });
    expect(view.read.kind).toBe("unreadable");
    expect(statusOf(view).startsWith("unreadable: ")).toBe(true);
    expect(statusOf(view)).not.toBe("unreadable: ?");
  });
});

// ---------------------------------------------------------------------------
// The row as data
// ---------------------------------------------------------------------------

describe("the cline row as data", () => {
  it("is strict JSON under mcpServers, on every OS, with one user scope", () => {
    expect(row.config).toEqual({ format: "json", root: "mcpServers" });
    expect(effectiveConfigFormat(row.config, SCOPE)).toBe("json");
    expect([...row.availableOn].sort()).toEqual(["linux", "macos", "windows"]);
    expect(row.scopes.map((s) => s.scope)).toEqual(["user"]);
    expect(SCOPE.requiresProjectDir).toBe(false);
    expect(row.notConfigurableOn).toBeUndefined();
  });

  it("says the extension needs no restart", () => {
    expect(row.reload).toBe("live");
    expect(reloadDoneClause(row.reload, row.label)).toBe(
      "Cline starts the server when the file is saved -- no restart needed.",
    );
  });

  it("names its own import variable spelling rather than letting the importer learn it", () => {
    // Cline expands `${env:NAME}` itself before validating
    // (McpHub.ts, `expandEnvironmentVariables(config)` -- "This allows
    // ${env:VAR_NAME} syntax in URLs, headers, env vars, etc."), so import has
    // to report such a value as unresolved rather than substitute one.
    expect(row.hooks?.importVariables).toBe("cline-env");
  });

  it("imports a stored entry as its folded self, and carries no `disabled` mapping yet", () => {
    // As committed the row has no `forImport` hook, so `importViewOf` falls
    // back to the normalised entry: the nested transport form imports as a
    // launchable server (which is the part that matters), and a
    // `disabled: true` entry imports ACTIVE. Nothing consumes this today --
    // import-cmd still carries its own walk -- and the mapping is owed before
    // it does.
    const stored = JSON.parse(NESTED_WIN).mcpServers.mcp as Record<string, unknown>;
    const view = importViewOf(stored, row.entry);
    expect(view.entry.command).toBe("cmd");
    expect(view.disabled).toBeUndefined();
  });

  it("keeps its notes ASCII, and says only what is verified", () => {
    const notes = row.notes ?? "";
    for (let i = 0; i < notes.length; i++) {
      expect(notes.charCodeAt(i), `notes[${i}] is not ASCII`).toBeLessThan(0x80);
    }
    // Each clause maps to a source quoted in this file's header.
    expect(notes).toContain("~/.cline/data/settings/");
    expect(notes).toContain(`<editor>/User/globalStorage/${STORAGE}/settings/`);
    expect(notes).toContain("strict JSON: no comments, no trailing commas");
    expect(notes).toContain("without a restart");
    // And it does NOT send the user to a command that does not exist. Neither
    // manifest contributes one for the settings file: both 4.1.17 (main) and
    // 4.0.12 (legacy-extension) contribute exactly `cline.mcpButtonClicked`
    // ("MCP Servers", no category) and a dev-mode OAuth command, so a
    // "Cline: Open MCP Settings" instruction would be false.
    expect(notes).not.toContain("Open MCP Settings");
    expect(notes).not.toContain("command palette");
  });

  it("keeps every fixture pure ASCII with LF endings", () => {
    // A fixture whose point is an indent or a missing newline is worth nothing
    // if a stray control byte got into it -- and `git diff` renders a file
    // holding one as "Binary file ... matches", so review cannot see it.
    for (const raw of [BOOTSTRAP, SIBLINGS, RESTAMPED_WIN, STALE_WIN, NESTED_WIN, LEGACY_KEY]) {
      for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        expect(code === 0x0a || (code >= 0x20 && code < 0x7f), `byte ${i} is ${code}`).toBe(true);
      }
    }
    expect(BOOTSTRAP).toBe('{\n  "mcpServers": {}\n}');
  });
});
