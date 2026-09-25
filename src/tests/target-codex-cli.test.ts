// The codex-cli row and its TOML adapter, driven through the client-config
// core the way client-config-matrix.test.ts drives every row -- plus the
// things that are Codex's alone: CODEX_HOME, the bare-npx Windows entry, the
// startup timeout, the carried env_vars, and the spellings the splice refuses.
//
// TWO LAYERS. Most of this file drives the core directly: classify the bytes,
// compose the entry from the row's transform, apply the edits through the
// write facade that verifies its own output. `installThrough` below is exactly
// that sequence, and every byte-exact expectation is a fixture on disk that the
// TOML adapter's own suite already loads. Those describes are hermetic: a
// synthetic home, every env value passed in rather than read, and nothing is
// written to disk -- `classifyClientConfig` takes the text and
// `applyClientConfigEdits` returns it.
//
// TOML is also reachable from the CLI: install, uninstall, try, import, doctor
// and `install --list` all read config.toml through the same core. The last
// describe carries that round trip -- `runInstall` writes a real config.toml
// into a temp home, and `--list` and `runDoctor` read back the file install
// wrote -- so install and doctor cannot disagree about a Codex file unnoticed.
// That was the reported bug: doctor and --list parsed the file install had
// just written as JSON and called it malformed.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adapterFor,
  applyClientConfigEdits,
  type ClientConfigEdit,
  type ClientConfigView,
  ClientConfigWriteError,
  type ConfigAdapter,
  type ConfigSite,
  canonicalJson,
  classifyClientConfig,
  composeEntry,
  effectiveConfigFormat,
  hasConfigAdapter,
  importViewOf,
  normalizeEntry,
  registerConfigAdapter,
  reloadDoneClause,
  resetConfigAdapterRegistry,
} from "../client-config.js";
import { readTomlConfig } from "../client-config-toml.js";
import { runDoctor } from "../doctor-cmd.js";
import { type BundlesSummary, runInstall, runUninstall } from "../install-cmd.js";
import {
  buildLaunchEntry,
  ENTRY_NAME,
  INSTALL_TARGETS,
  type InstallOS,
  type InstallScope,
  type InstallTarget,
  LEGACY_ENTRY_NAMES,
  resolveInstallPath,
} from "../install-targets.js";
import type { OamProbe } from "../oam-spawn.js";

const HOME = "/synth/home";
const PROJECT = "/synth/home/proj";
const APPDATA = "C:/synth/AppData/Roaming";

const FIXTURES = fileURLToPath(new URL("./fixtures/codex/", import.meta.url));

/** One fixture file's bytes, verbatim -- BOM and CRLF included. */
function fixture(id: string, name = "input"): string {
  return readFileSync(join(FIXTURES, id, `${name}.toml`), "utf8");
}

function rowOf(clientId: string): InstallTarget {
  const found = INSTALL_TARGETS.find((t) => t.clientId === clientId);
  if (found === undefined) throw new Error(`no ${clientId} row`);
  return found;
}

const CODEX = rowOf("codex-cli");

interface SiteOptions {
  scope?: InstallScope;
  os?: InstallOS;
  codexHome?: string;
  projectDir?: string;
}

/** The site a consumer resolves for one (scope, OS), built the way the matrix
 *  test builds one: through `resolveInstallPath`, with the env passed in. */
function siteFor(opts: SiteOptions = {}): ConfigSite {
  const scope = opts.scope ?? "user";
  const scopeSpec = CODEX.scopes.find((s) => s.scope === scope);
  if (scopeSpec === undefined) throw new Error(`codex-cli has no ${scope} scope`);
  const resolved = resolveInstallPath({
    clientId: CODEX.clientId,
    scope,
    os: opts.os ?? "linux",
    home: HOME,
    appData: APPDATA,
    projectDir: scopeSpec.requiresProjectDir ? (opts.projectDir ?? PROJECT) : undefined,
    clientEnv: opts.codexHome === undefined ? {} : { codexHome: opts.codexHome },
  });
  return {
    id: "default",
    label: CODEX.label,
    format: effectiveConfigFormat(CODEX.config, scopeSpec),
    resolved,
    detectDir: null,
  };
}

/** The broker entry install would write, composed the way install-cmd does:
 *  the launcher for this OS under the row's own Windows policy, then the row's
 *  transform (its extra fields), then anything carried from a stored entry. */
function brokerEntry(
  os: InstallOS = "linux",
  carry: { env?: Record<string, string>; carried?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return composeEntry({
    base: buildLaunchEntry({ os, windowsWrap: CODEX.entry?.windowsLaunch?.broker !== "bare" }),
    transform: CODEX.entry,
    os,
    purpose: "broker",
    env: carry.env,
    carried: carry.carried,
  });
}

interface InstallResult {
  view: ClientConfigView;
  /** The entry that would be written. */
  entry: Record<string, unknown>;
  /** True when the stored entry already reads back as `entry`: install's
   *  no-op, which writes nothing at all. */
  identical: boolean;
  /** The text a write would persist. Computed even when `identical`, so a test
   *  can assert the no-op is a no-op in BYTES too. */
  next: string;
}

/** Classify, compose, and apply the edits -- the sequence a consumer runs.
 *
 *  `force` is the flag's whole meaning at this layer: neither the stored env
 *  nor the row's carried fields are passed to `composeEntry`, so the rewrite
 *  is a true overwrite. Legacy trimming is the second edit, in the SAME call,
 *  which is what puts the new table where the user last saw the old one. */
function installThrough(
  raw: string | null,
  site: ConfigSite,
  opts: { os?: InstallOS; force?: boolean; keepLegacy?: boolean } = {},
): InstallResult {
  const view = classifyClientConfig(raw, site, { transform: CODEX.entry });
  const force = opts.force === true;
  const entry = brokerEntry(opts.os ?? "linux", {
    env: force ? undefined : view.carryableEnv(),
    carried: force ? {} : view.carried(),
  });
  const edits: ClientConfigEdit[] = [{ op: "upsert", key: ENTRY_NAME, entry }];
  const legacy = view.legacyKey();
  if (legacy !== null && opts.keepLegacy !== true) edits.push({ op: "remove", key: legacy });
  const stored = view.normalized();
  const identical = stored !== undefined && canonicalJson(stored) === canonicalJson(entry);
  return { view, entry, identical, next: applyClientConfigEdits(view, edits, site) };
}

/** What install refused with, or "" when it did not refuse. */
function refusalOf(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (e) {
    if (e instanceof ClientConfigWriteError) return e.message;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The row, as data
// ---------------------------------------------------------------------------

describe("the codex-cli row", () => {
  it("is APPENDED to the table, never inserted", () => {
    // `try`'s auto-detect returns the first usable probe slot in table order,
    // so a row inserted ahead of an existing one changes which client an
    // existing user's `try` picks.
    //
    // Asserted as "after every row that landed before it", not as the literal
    // last row: `at(-1)` was a statement about merge order that held only
    // until the next row (typed) was appended -- the same correction the
    // continue test made when this row landed after it.
    const ids = INSTALL_TARGETS.map((t) => t.clientId);
    const landedBefore = [
      "claude-code",
      "claude-desktop",
      "cursor",
      "vscode",
      "windsurf",
      "gemini-cli",
      "zed",
      "cline",
    ];
    expect(ids.slice(0, landedBefore.length)).toEqual(landedBefore);
    expect(ids.indexOf("codex-cli")).toBeGreaterThan(ids.indexOf("continue"));
  });

  it("declares the TOML container Codex reads, on every OS Codex ships on", () => {
    expect(CODEX.config).toEqual({
      format: "toml",
      root: "mcp_servers",
      rootDefaults: [{ key: "mcp_optional_startup_grace_ms", value: 0, why: expect.any(String) }],
    });
    expect([...CODEX.availableOn]).toEqual(["macos", "linux", "windows"]);
    expect(CODEX.notConfigurableOn).toBeUndefined();
    // User first: the probe walks this array in order, and it decides
    // `--list` and doctor row order.
    expect(CODEX.scopes.map((s) => s.scope)).toEqual(["user", "project"]);
    expect(CODEX.scopes.every((s) => s.strictJson === undefined)).toBe(true);
    expect(CODEX.scopes[1].requiresProjectDir).toBe(true);
  });

  it("registers the adapter its own format needs, by being imported", () => {
    // The row is data; the adapter is the one side effect. Without the
    // module-scope `registerConfigAdapter` call, every read of a codex site
    // throws MissingConfigAdapterError instead.
    expect(hasConfigAdapter(CODEX.config.format)).toBe(true);
    expect(classifyClientConfig(null, siteFor()).adapter.syntax).toBe("TOML");
  });

  it("says restart, because Codex has no hot reload", () => {
    expect(CODEX.reload).toBeUndefined();
    expect(reloadDoneClause(CODEX.reload, CODEX.label)).toBe("Restart it to pick up the new MCP server.");
  });

  it("keeps its notes ASCII, and states the four facts a user acts on", () => {
    const notes = CODEX.notes ?? "";
    // ASCII only: the line prints verbatim as `Note: ...` on a Windows
    // console, where a smart quote or an em-dash arrives as mojibake.
    expect(/^[\t\n\r -~]*$/.test(notes)).toBe(true);
    expect(notes).toContain("[mcp_servers.<name>] tables");
    expect(notes).toContain("CODEX_HOME, which defaults to ~/.codex");
    expect(notes).toContain("only once Codex trusts the project");
    expect(notes).toContain("name them in env_vars");
    expect(notes).toContain("Codex 0.59.0 or newer");
  });

  it("declares the startup-grace key as DATA, with a reason that prints on a Windows console", () => {
    const [grace, ...rest] = CODEX.config.rootDefaults ?? [];
    expect(rest).toEqual([]);
    expect(grace.key).toBe("mcp_optional_startup_grace_ms");
    expect(grace.value).toBe(0);
    // Printed after "Set ... in <file>: " and after "0 is recommended: ", so
    // ASCII, one clause, and no period of its own.
    expect(/^[ -~]+$/.test(grace.why)).toBe(true);
    expect(grace.why.endsWith(".")).toBe(false);
    // 0.151 is the first release that reads the key (S6: absent from
    // config_toml.rs at rust-v0.150.0, present from rust-v0.151.0).
    expect(grace.why).toContain("Codex 0.151 and later");
    expect(grace.why).toContain("startup_timeout_sec");
    // The notes say what install does with it, and what uninstall does not.
    const notes = CODEX.notes ?? "";
    expect(notes).toContain("Install also sets mcp_optional_startup_grace_ms = 0 at the top of config.toml");
    expect(notes).toContain("Codex 0.151 and later otherwise give MCP servers a shared 1 s grace");
    expect(notes).toContain(
      "Codex 0.147 to 0.150 already wait a fixed 1 s that this key cannot change, so the fix needs Codex 0.151 or newer.",
    );
    expect(notes).not.toContain("0.156");
    expect(notes).toContain("A value already in the file is left alone");
    expect(notes).toContain("uninstall leaves the key in place");
    expect(notes).toContain("startup_timeout_sec, which the entry sets to 60");
  });

  it("uses a format whose adapter can read and add a top-level key, as every rootDefaults row must", () => {
    // The facade names this as a programming error at run time; this is the
    // same fact checked before any run, for every row that declares one.
    const declaring = INSTALL_TARGETS.filter((t) => (t.config.rootDefaults ?? []).length > 0);
    expect(declaring.map((t) => t.clientId)).toEqual(["codex-cli"]);
    for (const t of declaring) {
      const adapter = adapterFor(t.config.format);
      expect(typeof adapter.readRootKey, t.clientId).toBe("function");
      expect(typeof adapter.insertRootKey, t.clientId).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe("where codex-cli's config.toml is", () => {
  it("resolves ~/.codex/config.toml for user scope on every OS", () => {
    for (const os of ["macos", "linux", "windows"] as InstallOS[]) {
      const { absolute, containerPath } = siteFor({ os }).resolved;
      // `join`, never a POSIX literal: the SUT joins too, so on a Windows
      // runner both sides come back with backslashes and agree.
      expect(absolute).toBe(join(HOME, ".codex", "config.toml"));
      expect([...containerPath]).toEqual(["mcp_servers"]);
    }
    expect(siteFor({ os: "linux" }).resolved.display).toBe("~/.codex/config.toml");
    expect(siteFor({ os: "macos" }).resolved.display).toBe("~/.codex/config.toml");
    // The display string is spelled for the TARGET OS, not the runner.
    expect(siteFor({ os: "windows" }).resolved.display).toBe("%USERPROFILE%\\.codex\\config.toml");
  });

  it("resolves <project>/.codex/config.toml for project scope", () => {
    const posix = siteFor({ scope: "project", os: "linux" }).resolved;
    expect(posix.absolute).toBe(join(PROJECT, ".codex", "config.toml"));
    expect(posix.display).toBe("<project folder>/.codex/config.toml");
    expect(siteFor({ scope: "project", os: "windows" }).resolved.display).toBe("<project folder>\\.codex\\config.toml");
  });

  it("follows CODEX_HOME for user scope, and displays the path it will write", () => {
    const relocated = siteFor({ codexHome: "/elsewhere/codex" }).resolved;
    expect(relocated.absolute).toBe(join("/elsewhere/codex", "config.toml"));
    // Absolute, like the claudeConfigDir branch: a `~` spelling here would
    // name a file the run is not writing.
    expect(relocated.display).toBe(relocated.absolute);
  });

  it("treats an empty CODEX_HOME as unset", () => {
    // `readClientEnv` already drops an empty value; the row guards it too, so
    // a caller that threads a raw env through cannot land the config in the
    // process cwd.
    expect(siteFor({ codexHome: "" }).resolved.absolute).toBe(join(HOME, ".codex", "config.toml"));
  });

  it("resolves a relative CODEX_HOME against the current directory", () => {
    // Codex canonicalizes the value against ITS cwd; from here the process
    // cwd is the only defensible reading, and it agrees when both run in the
    // same directory.
    expect(siteFor({ codexHome: "rel-codex" }).resolved.absolute).toBe(join(process.cwd(), "rel-codex", "config.toml"));
  });

  it("does not let CODEX_HOME move a project's file", () => {
    const site = siteFor({ scope: "project", codexHome: "/elsewhere/codex" });
    expect(site.resolved.absolute).toBe(join(PROJECT, ".codex", "config.toml"));
  });
});

// ---------------------------------------------------------------------------
// The launch entry
// ---------------------------------------------------------------------------

describe("the launch entry Codex gets", () => {
  it("is BARE npx on Windows, byte-identical to the POSIX entry", () => {
    // Codex resolves the `.cmd` shim itself (which::which_in), and this is
    // also what `codex mcp add` writes -- so a `cmd /c` entry of ours would
    // read as drift the moment the user ran that command.
    expect(CODEX.entry?.windowsLaunch?.broker).toBe("bare");
    const windows = brokerEntry("windows");
    expect(windows).toEqual({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"], startup_timeout_sec: 60 });
    expect(windows).toEqual(brokerEntry("linux"));
  });

  it("still wraps a `try` trial on Windows, which is what the row's upstream policy says", () => {
    // A trial names a THIRD-PARTY launcher whose args have to survive cmd's
    // parse. `buildLaunchEntry`'s upstream branch wraps on Windows whatever
    // this field says, so the field and the behaviour agree only because the
    // row says "cmd-wrap" here.
    expect(CODEX.entry?.windowsLaunch?.upstream).toBe("cmd-wrap");
    const trial = buildLaunchEntry({
      os: "windows",
      windowsWrap: false,
      upstream: { command: "npx", args: ["-y", "@acme/foo-mcp"] },
    });
    expect(trial).toEqual({ command: "cmd", args: ["/c", "npx", "-y", "@acme/foo-mcp"] });
  });

  it("writes the startup timeout Codex does not default to, for a trial as well", () => {
    // Codex's documented default is 10 seconds; a warm `npx` fetch of the
    // broker is the same order of magnitude as that, which is the whole
    // reason this field is written.
    expect(CODEX.entry?.extraFields?.({ os: "linux", purpose: "broker" })).toEqual({ startup_timeout_sec: 60 });
    expect(CODEX.entry?.extraFields?.({ os: "windows", purpose: "upstream" })).toEqual({ startup_timeout_sec: 60 });
  });

  it("renders an oam-hosted Windows entry with escaped path separators (f14)", () => {
    const oamBinPath = "C:\\Users\\me\\.oam\\bin\\oam.exe";
    const oamEntry = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@yawlabs\\mcp\\dist\\index.js";
    const entry = composeEntry({
      base: buildLaunchEntry({ os: "windows", windowsWrap: false, oamBinPath, oamEntry }),
      transform: CODEX.entry,
      os: "windows",
      purpose: "broker",
    });
    const site = siteFor({ os: "windows" });
    expect(applyClientConfigEdits(classifyClientConfig(null, site), [{ op: "upsert", key: ENTRY_NAME, entry }])).toBe(
      fixture("f14-oam-windows", "expected"),
    );
  });
});

// ---------------------------------------------------------------------------
// Install, through the core
// ---------------------------------------------------------------------------

describe("install writes the table Codex documents", () => {
  it("creates the file when there is none (f01)", () => {
    const result = installThrough(null, siteFor());
    expect(result.view.read.kind).toBe("absent");
    expect(result.identical).toBe(false);
    expect(result.next).toBe(fixture("f01-missing", "expected"));
  });

  it("treats an empty file like a missing one (g11)", () => {
    expect(installThrough(fixture("g11-empty"), siteFor()).next).toBe(fixture("g11-empty", "expected"));
  });

  it("appends after the last mcp_servers table, leaving every other byte (f03)", () => {
    const input = fixture("f03-siblings");
    const result = installThrough(input, siteFor());
    expect(result.next).toBe(fixture("f03-siblings", "expected"));
    // The claim the byte compare makes concrete: a sibling's own spelling
    // survives -- `'node'` stays literal, `20` stays an integer, its env stays
    // unsorted, and both comments stay.
    expect(result.next).toContain("command = 'node'");
    expect(result.next).toContain("startup_timeout_sec = 20\n");
    expect(result.next).toContain("# the sibling server");
    expect(result.view.otherServerKeys()).toEqual(["sib"]);
  });

  it("adds the table to a file that has only trust entries (f02)", () => {
    const result = installThrough(fixture("f02-trust-only"), siteFor());
    // The container is absent, not the file: `ok` with containerPresent false
    // is what tells `--list` "no entries" from "not configured".
    expect(result.view.read).toMatchObject({ kind: "ok", containerPresent: false });
    expect(result.next).toBe(fixture("f02-trust-only", "expected"));
  });

  it("keeps a file's CRLF endings and its BOM (f04)", () => {
    const input = fixture("f04-crlf-bom");
    expect(input.charCodeAt(0)).toBe(0xfeff);
    const next = installThrough(input, siteFor()).next;
    expect(next).toBe(fixture("f04-crlf-bom", "expected"));
    expect(next.charCodeAt(0)).toBe(0xfeff);
    expect(next).toContain("[mcp_servers.mcp]\r\n");
    expect(next.includes("[mcp_servers.mcp]\n")).toBe(false);
  });

  it("is a no-op on a re-run, in bytes as well as in the comparison (f05)", () => {
    const input = fixture("f05-identical");
    const result = installThrough(input, siteFor());
    expect(result.identical).toBe(true);
    // The comparison is what install acts on -- it writes nothing. The byte
    // equality is the belt: had it written, the file would not have changed.
    expect(result.next).toBe(input);
    expect(input).toBe(fixture("f05-identical", "expected"));
  });

  it("reads a Codex-re-serialised timeout as identical, not as drift", () => {
    // Codex writes `startup_timeout_sec` from an f64, so a round trip through
    // `codex mcp add <other>` respells our 60 as 60.0. Measured on smol-toml:
    // both spellings parse to the JS number 60, so this is not drift.
    const asFloat = fixture("f05-identical");
    const asInt = asFloat.replace("60.0", "60");
    expect(asInt).not.toBe(asFloat);
    for (const raw of [asFloat, asInt, asFloat.replace("60.0", "6e1")]) {
      expect(installThrough(raw, siteFor()).identical).toBe(true);
    }
  });

  it("reports what `codex mcp add` left out as drift, and repairs it (f06)", () => {
    const result = installThrough(fixture("f06-codex-add-shape"), siteFor());
    expect(result.identical).toBe(false);
    // The stored entry is OURS but for the one field Codex's own command does
    // not write, which is exactly what the diff has to say.
    expect(result.view.normalized()).toEqual({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
    expect(result.entry.startup_timeout_sec).toBe(60);
    expect(result.next).toBe(fixture("f06-codex-add-shape", "expected-repair"));
  });

  it("--repair keeps the env sub-table wherever it sat; --force drops it (f07)", () => {
    const input = fixture("f07-env-elsewhere");
    const site = siteFor();
    const repaired = installThrough(input, site);
    expect(repaired.view.carryableEnv()).toEqual({ YAW_MCP_VAULT_PASSPHRASE: "s3cret" });
    expect(repaired.entry.env).toEqual({ YAW_MCP_VAULT_PASSPHRASE: "s3cret" });
    expect(repaired.next).toBe(fixture("f07-env-elsewhere", "expected-repair"));

    const forced = installThrough(input, site, { force: true });
    expect(forced.entry.env).toBeUndefined();
    expect(forced.next).toBe(fixture("f07-env-elsewhere", "expected-force"));
    expect(forced.next).not.toContain("s3cret");
  });

  it("carries env_vars and enabled, and --force drops those too (f13)", () => {
    const input = fixture("f13-env-vars-carried");
    const site = siteFor();
    const repaired = installThrough(input, site);
    expect(repaired.view.carried()).toEqual({ env_vars: ["HTTPS_PROXY"] });
    expect(repaired.entry.env_vars).toEqual(["HTTPS_PROXY"]);
    expect(repaired.next).toBe(fixture("f13-env-vars-carried", "expected-repair"));

    const forced = installThrough(input, site, { force: true });
    expect(forced.entry.env_vars).toBeUndefined();
    expect(forced.entry.env).toBeUndefined();
    expect(forced.next).toBe(fixture("f01-missing", "expected"));
  });

  it("puts the new table where a legacy one sat, in one write (f08, f08b)", () => {
    for (const id of ["f08-legacy", "f08b-legacy-quoted"]) {
      const result = installThrough(fixture(id), siteFor());
      expect(LEGACY_ENTRY_NAMES).toContain(result.view.legacyKey());
      expect(result.next).toBe(fixture(id, "expected"));
    }
  });

  it("leaves a legacy entry alone under --keep-legacy, and still adds ours", () => {
    const result = installThrough(fixture("f08-legacy"), siteFor(), { keepLegacy: true });
    const after = classifyClientConfig(result.next, siteFor(), { transform: CODEX.entry });
    expect(after.entries().map((e) => e.key)).toEqual(["yaw-mcp", "mcp"]);
  });

  it("uninstalls back to the original bytes (f02, f03, f04)", () => {
    for (const id of ["f02-trust-only", "f03-siblings", "f04-crlf-bom"]) {
      const input = fixture(id);
      const site = siteFor();
      const installed = installThrough(input, site).next;
      const view = classifyClientConfig(installed, site, { transform: CODEX.entry });
      expect(applyClientConfigEdits(view, [{ op: "remove", key: ENTRY_NAME }], site)).toBe(input);
    }
  });

  it("leaves an empty file behind when our table was the whole file", () => {
    const site = siteFor();
    const installed = installThrough(null, site).next;
    const view = classifyClientConfig(installed, site, { transform: CODEX.entry });
    // Codex reads a missing and an empty config.toml the same way, so this is
    // the TOML analogue of JSON's leftover `{"mcpServers": {}}`.
    expect(applyClientConfigEdits(view, [{ op: "remove", key: ENTRY_NAME }], site)).toBe("");
  });

  it("still refuses an UPSERT that would leave the file empty", () => {
    // The other half of the rule above. A removal may empty the document; an
    // upsert that did would be claiming to have written an entry that is not
    // there, so it stays a refusal. Reachable only through an adapter that
    // empties the file, which is what this stand-in is for.
    const real = adapterFor("toml");
    const emptying: ConfigAdapter = { ...real, upsert: () => "", remove: () => "" };
    try {
      resetConfigAdapterRegistry();
      registerConfigAdapter("toml", emptying);
      const site = siteFor();
      const view = classifyClientConfig(fixture("f05-identical"), site, { transform: CODEX.entry });
      const upsert: ClientConfigEdit[] = [{ op: "upsert", key: ENTRY_NAME, entry: brokerEntry() }];
      expect(refusalOf(() => applyClientConfigEdits(view, upsert, site))).toContain("cannot read back (absent)");
      expect(applyClientConfigEdits(view, [{ op: "remove", key: ENTRY_NAME }], site)).toBe("");
    } finally {
      resetConfigAdapterRegistry();
      registerConfigAdapter("toml", real);
    }
    expect(adapterFor("toml")).toBe(real);
  });

  it("is nothing to do when there is nothing to remove", () => {
    const raw = fixture("f03-siblings");
    const view = classifyClientConfig(raw, siteFor(), { transform: CODEX.entry });
    expect(view.entry()).toBeUndefined();
    // The adapter returns the input STRING ITSELF when the entry is absent,
    // which is how a caller detects "nothing to do" by identity rather than by
    // diffing -- and what keeps uninstall from rewriting an untouched file.
    expect(view.adapter.remove(raw, view.address, ENTRY_NAME)).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("install refuses rather than corrupt a file", () => {
  it("reports a malformed file with the parser's reason and position (f10)", () => {
    const raw = fixture("f10-malformed");
    const view = classifyClientConfig(raw, siteFor(), { transform: CODEX.entry });
    expect(view.read).toMatchObject({
      kind: "malformed",
      syntax: "TOML",
      reason: "syntax",
      position: { line: 2, column: 15 },
    });
    // The offset the position carries points into the bytes the parser
    // complained about -- the end of the unterminated string on line 2.
    const position = view.read.kind === "malformed" ? view.read.position : null;
    expect(position).not.toBeNull();
    expect(raw.slice(0, position?.offset ?? 0).endsWith('command = "npx')).toBe(true);
    // `detail` carries the reason WITHOUT a position, because the refusal adds
    // one of its own -- otherwise the line reads "at line 2 column 15 (line 2,
    // column 15: ...)".
    const detail = view.read.kind === "malformed" ? view.read.detail : "";
    expect(detail).not.toContain("line 2");
  });

  it("counts a leading BOM when it reports where the TOML broke", () => {
    // The BOM is stripped for the PARSE (smol-toml rejects one) and is a real
    // character of the file, so the parser's line and column are against the
    // stripped text while the offset has to be against these bytes.
    // String.fromCharCode, never a literal U+FEFF in this source: an
    // invisible character is unreviewable, and any tool that rewrites the file
    // can drop it and leave the test silently checking nothing.
    const raw = `${String.fromCharCode(0xfeff)}${fixture("f10-malformed")}`;
    const view = classifyClientConfig(raw, siteFor(), { transform: CODEX.entry });
    const position = view.read.kind === "malformed" ? view.read.position : null;
    expect(position).toMatchObject({ line: 2, column: 15 });
    expect(raw.slice(0, position?.offset ?? 0).endsWith('command = "npx')).toBe(true);
    // On the FIRST line there is no line break to count from, so this is the
    // case the BOM term carries on its own: a mutation that drops it moves
    // this offset one byte left, onto the BOM itself.
    const firstLine = `${String.fromCharCode(0xfeff)}command = "npx\n`;
    const broken = classifyClientConfig(firstLine, siteFor(), { transform: CODEX.entry });
    const at = broken.read.kind === "malformed" ? broken.read.position : null;
    expect(at).toMatchObject({ line: 1 });
    // The parser counted the column from the byte AFTER the BOM, so the
    // offset is the BOM plus that many characters. Without the BOM term the
    // offset lands one byte earlier, inside the text the column excludes.
    expect(at?.offset).toBe(1 + ((at?.column ?? 0) - 1));
    expect(firstLine.slice(0, at?.offset ?? 0)).toBe(`${String.fromCharCode(0xfeff)}command = "npx`);
  });

  it("writes nothing into a malformed file, whichever edit is asked for (f10)", () => {
    const site = siteFor();
    const view = classifyClientConfig(fixture("f10-malformed"), site, { transform: CODEX.entry });
    for (const edits of [
      [{ op: "upsert", key: ENTRY_NAME, entry: brokerEntry() }] as ClientConfigEdit[],
      [{ op: "remove", key: ENTRY_NAME }] as ClientConfigEdit[],
      [{ op: "repair", path: ["mcp_servers"] }] as ClientConfigEdit[],
    ]) {
      expect(refusalOf(() => applyClientConfigEdits(view, edits, site))).toContain("is not valid TOML at line 2");
    }
  });

  it("reports a non-table mcp_servers as blocked and NEVER reparable (f11)", () => {
    const site = siteFor();
    const view = classifyClientConfig(fixture("f11-array-container"), site, { transform: CODEX.entry });
    expect(view.read).toMatchObject({
      kind: "blocked",
      path: ["mcp_servers"],
      shape: "an array of 1",
      reparable: false,
    });
    // Codex refuses to load such a file, and repairing it would mean
    // rewriting a root key-value line -- a splice this adapter does not do.
    // So the facade refuses, and the adapter's own repair throws if reached.
    const refusal = refusalOf(() =>
      applyClientConfigEdits(
        view,
        [
          { op: "repair", path: ["mcp_servers"] },
          { op: "upsert", key: ENTRY_NAME, entry: brokerEntry() },
        ],
        site,
      ),
    );
    expect(refusal).toContain("is an array of 1, not an object -- refusing to overwrite it");
    expect(() => view.adapter.repairContainer(fixture("f11-array-container"), view.address, ["mcp_servers"])).toThrow(
      /cannot be repaired in place/,
    );
  });

  const unspliceable: Array<{ id: string; shape: RegExp; removable: boolean }> = [
    { id: "f09-inline", shape: /an inline table under \[mcp_servers\]/, removable: false },
    { id: "f16-dotted", shape: /dotted keys at the top level/, removable: false },
    { id: "g14-dotted-in-container", shape: /dotted keys under \[mcp_servers\]/, removable: false },
    { id: "g10-array-entry", shape: /an array of tables/, removable: true },
  ];

  for (const { id, shape, removable } of unspliceable) {
    it(`refuses to rewrite our entry when it is ${id}, and writes nothing`, () => {
      const raw = fixture(id);
      const site = siteFor();
      const view = classifyClientConfig(raw, site, { transform: CODEX.entry });
      expect(view.read).toMatchObject({ kind: "unspliceable", key: ENTRY_NAME });
      const reason = view.read.kind === "unspliceable" ? view.read.reason : "";
      expect(reason).toMatch(shape);
      // The codec's by-hand `fix` reaches the core read too (doctor prints
      // it); its splice-facing `remedy` deliberately does not.
      const codec = readTomlConfig(raw, ["mcp_servers"], [ENTRY_NAME]);
      if (codec.kind !== "unspliceable") throw new Error(`codec says ${codec.kind}`);
      expect(view.read).toMatchObject({ fix: codec.fix });
      expect(view.read).not.toHaveProperty("remedy");
      // An `unspliceable` read refuses every edit through the facade --
      // install AND uninstall -- which is the safe end of the trade: the
      // splice has no table span it can take (or, for an array of tables,
      // collapsing one could drop a second definition the user wrote).
      for (const edits of [
        [{ op: "upsert", key: ENTRY_NAME, entry: brokerEntry() }] as ClientConfigEdit[],
        [{ op: "remove", key: ENTRY_NAME }] as ClientConfigEdit[],
      ]) {
        expect(refusalOf(() => applyClientConfigEdits(view, edits, site))).toContain("yaw-mcp will not edit it");
      }
      // The splicer itself is stricter for a rewrite than for a removal, and
      // this is where that difference is visible: an array-of-tables entry is
      // whole lines, so there IS a span to delete, while a spelling with no
      // header at all has none and the splicer says so.
      if (removable) {
        expect(view.adapter.remove(raw, view.address, ENTRY_NAME)).not.toBe(raw);
      } else {
        expect(() => view.adapter.remove(raw, view.address, ENTRY_NAME)).toThrow(/can be rewritten in place/);
      }
    });
  }

  it("refuses to append a table to an inline mcp_servers (g09)", () => {
    // Our entry is not in the file at all, so the READ is fine -- TOML is
    // what forbids extending an inline table with a later header, and the
    // write is where that surfaces.
    const raw = fixture("g09-inline-root");
    const site = siteFor();
    const view = classifyClientConfig(raw, site, { transform: CODEX.entry });
    expect(view.read).toMatchObject({ kind: "ok", containerPresent: true });
    expect(view.otherServerKeys()).toEqual(["sib"]);
    expect(refusalOf(() => installThrough(raw, site))).toContain("an inline table, which cannot gain an entry");
    // The read says on the side that this write is refused, so doctor does
    // not send the user to it. Absent (not null) on a header container: the
    // field is optional on the core union so a sibling adapter written
    // before it compiles unchanged.
    expect(view.read).toMatchObject({
      containerUnspliceable: {
        reason: "an inline table (mcp_servers = { ... }) that a later [mcp_servers.mcp] header cannot extend",
        fix: "convert it to [mcp_servers.mcp]-style tables by hand",
      },
    });
    const header = classifyClientConfig(fixture("f03-siblings"), site, { transform: CODEX.entry });
    expect(header.read.kind).toBe("ok");
    expect(header.read).not.toHaveProperty("containerUnspliceable");
  });
});

// ---------------------------------------------------------------------------
// The entry transform
// ---------------------------------------------------------------------------

describe("what Codex owns on our entry", () => {
  it("folds a lone startup_timeout_ms into seconds, Codex's own precedence", () => {
    // `(None, Some(ms)) => Duration::from_millis(ms)`: with no seconds field
    // beside it, the ms field IS the startup timeout, so an entry spelling our
    // 60 seconds that way means what we would write.
    const stored = { command: "npx", args: ["-y", "@yawlabs/mcp@latest"], startup_timeout_ms: 60000 };
    expect(normalizeEntry(stored, CODEX.entry)).toEqual({
      command: "npx",
      args: ["-y", "@yawlabs/mcp@latest"],
      startup_timeout_sec: 60,
    });
    expect(canonicalJson(normalizeEntry(stored, CODEX.entry))).toBe(canonicalJson(brokerEntry()));
    // A different value is still drift, with the seconds it really means.
    expect(normalizeEntry({ ...stored, startup_timeout_ms: 1500 }, CODEX.entry)).toMatchObject({
      startup_timeout_sec: 1.5,
    });
  });

  it("leaves a stale startup_timeout_ms visible when seconds are set too", () => {
    // Codex ignores the ms field when both are present, so folding it away
    // would hide a key the drift diff should offer to remove.
    const stored = { command: "npx", args: [], startup_timeout_sec: 60, startup_timeout_ms: 5 };
    expect(normalizeEntry(stored, CODEX.entry)).toBe(stored);
  });

  it("normalises nothing else, including a value that is not a table", () => {
    for (const stored of [
      42,
      "npx",
      null,
      ["a"],
      { command: "npx", startup_timeout_ms: "60000" },
      // Neither is a duration Codex would accept, so neither is folded into
      // one: a negative or non-finite value stays exactly as stored, visible
      // as the drift it is.
      { command: "npx", startup_timeout_ms: -1 },
      { command: "npx", startup_timeout_ms: Number.POSITIVE_INFINITY },
    ]) {
      expect(normalizeEntry(stored, CODEX.entry)).toBe(stored);
    }
  });

  it("carries env_vars only in the shapes Codex accepts", () => {
    const carry = CODEX.entry?.carry;
    expect(carry).toBeDefined();
    expect(carry?.({ env_vars: ["HTTPS_PROXY", { name: "TOK", source: "remote" }, { name: "L" }] })).toEqual({
      env_vars: ["HTTPS_PROXY", { name: "TOK", source: "remote" }, { name: "L" }],
    });
    // Each of these makes Codex refuse to load the whole file, so carrying it
    // forward would write back a config the user cannot start.
    for (const env_vars of [
      "HTTPS_PROXY",
      [1],
      [{ source: "local" }],
      [{ name: 1 }],
      [{ name: "TOK", source: "elsewhere" }],
      [{ name: "TOK", nope: true }],
      [["TOK"]],
      [],
    ]) {
      expect(carry?.({ env_vars })).toEqual({});
    }
  });

  it("carries enabled only as a boolean, and never carries env", () => {
    const carry = CODEX.entry?.carry;
    expect(carry?.({ enabled: false })).toEqual({ enabled: false });
    expect(carry?.({ enabled: true })).toEqual({ enabled: true });
    expect(carry?.({ enabled: "false" })).toEqual({});
    // `env` is the CORE's to carry, with its own string-only filter and its
    // own --force drop line; two owners for one field is the split the hook
    // contract forbids.
    expect(carry?.({ env: { A: "1" } })).toEqual({});
  });

  it("keeps a disabled server disabled through a re-run", () => {
    const raw = `${fixture("f05-identical")}enabled = false\n`;
    const result = installThrough(raw, siteFor());
    expect(result.entry.enabled).toBe(false);
    // Carried, so it is not drift: a user who switched the server off means
    // it, and --repair must not switch it back on.
    expect(result.identical).toBe(true);
  });

  it("maps Codex's own import spellings, and names what it drops", () => {
    const view = importViewOf(
      {
        url: "https://mcp.example.com/mcp",
        http_headers: { "X-Region": "us-east-1" },
        bearer_token_env_var: "TOKEN",
        enabled: false,
        cwd: "/srv",
        startup_timeout_sec: 20,
        tools: { echo: { approval_mode: "approve" } },
      },
      CODEX.entry,
    );
    expect(view.entry).toEqual({ url: "https://mcp.example.com/mcp", headers: { "X-Region": "us-east-1" } });
    expect(view.disabled).toBe(true);
    expect(view.discardedKeys).toEqual(["cwd", "startup_timeout_sec", "bearer_token_env_var", "tools"]);
  });

  it("imports an ordinary stdio entry unchanged, and says nothing was dropped", () => {
    const view = importViewOf({ command: "node", args: ["x.js"], env: { A: "1" } }, CODEX.entry);
    expect(view).toEqual({ entry: { command: "node", args: ["x.js"], env: { A: "1" } } });
  });
});

// ---------------------------------------------------------------------------
// The adapter's own surface
// ---------------------------------------------------------------------------

describe("the TOML adapter the row registers", () => {
  const address = { format: "toml", containerPath: ["mcp_servers"] } as const;
  const adapter = classifyClientConfig(null, siteFor()).adapter;

  it("previews the table a --dry-run would write, and nothing else", () => {
    const preview = adapter.renderPreview(address, ENTRY_NAME, brokerEntry(), true);
    expect(preview).toBe(fixture("f01-missing", "expected"));
    // Never the merged file: that would put a sibling server's env into a
    // transcript the user pastes into a bug report.
    expect(adapter.renderPreview(address, ENTRY_NAME, brokerEntry(), false)).toBe(preview);
  });

  it("names the file alone as the location, since the container is a header in it", () => {
    expect(adapter.describeLocation("/home/u/.codex/config.toml", address)).toBe("/home/u/.codex/config.toml");
  });

  it("fingerprints everything the edit was not about", () => {
    const raw = fixture("f03-siblings");
    const withoutOurs = adapter.canon(raw, address, { drop: [ENTRY_NAME] });
    const installed = installThrough(raw, siteFor()).next;
    // Our entry added: the rest of the document is unchanged, which is the
    // claim the write facade checks before it hands the text back.
    expect(adapter.canon(installed, address, { drop: [ENTRY_NAME] })).toBe(withoutOurs);
    // A sibling touched: the fingerprint moves.
    expect(adapter.canon(raw.replace('theme = "dark"', 'theme = "light"'), address, { drop: [ENTRY_NAME] })).not.toBe(
      withoutOurs,
    );
    // dropContainer takes the whole container out, for the two edits that
    // legitimately change it (a repair, and an upsert that creates it). The
    // before-and-after of such an edit then compare equal: f02 has no
    // container at all, and the file install made from it has one.
    const noContainer = adapter.canon(raw, address, { dropContainer: true });
    expect(JSON.parse(noContainer)).not.toHaveProperty("mcp_servers");
    const seeded = fixture("f02-trust-only");
    expect(adapter.canon(installThrough(seeded, siteFor()).next, address, { dropContainer: true })).toBe(
      adapter.canon(seeded, address, { dropContainer: true }),
    );
  });

  it("lists the entries in FILE order, with the stored value and a launch view", () => {
    const raw = `${fixture("f03-siblings")}\n[mcp_servers.aaa]\ncommand = "z"\n`;
    const view = classifyClientConfig(raw, siteFor(), { transform: CODEX.entry });
    expect(view.entries().map((e) => e.key)).toEqual(["sib", "aaa"]);
    expect(view.entry("sib")?.launch).toEqual({ command: "node", args: ["x.js", "--flag"], env: { B: "2", A: "1" } });
    expect(view.count()).toBe(2);
  });

  it("reports each entry's launch through the transform, not off the raw value", () => {
    // The core documents `EntryView.launch` as the NORMALISED view, which is
    // what lets a client that stores our launch under its own transport shape
    // still read as ours. Codex's own normalize only folds a timeout, which
    // `launch` does not carry, so a stand-in transform is what pins the call.
    const folding = { normalize: () => ({ command: "folded", args: ["--x"] }) };
    const view = classifyClientConfig(fixture("f05-identical"), siteFor(), { transform: folding });
    expect(view.entry()?.launch).toEqual({ command: "folded", args: ["--x"] });
    // The STORED value is untouched: drift comparison and carry-forward read
    // what the file holds.
    expect(view.entry()?.value).toMatchObject({ command: "npx" });
  });

  it("reads a file with no mcp_servers as present-but-empty, not as missing", () => {
    const view = classifyClientConfig(fixture("g12-no-container"), siteFor());
    expect(view.read).toMatchObject({ kind: "ok", containerPresent: false });
    expect(view.count()).toBe(0);
    // No strict-JSON gap in TOML: what the reader accepts, Codex accepts.
    expect(view.unloadable()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The CLI round trip: install -> --list -> doctor over the file install wrote
// ---------------------------------------------------------------------------

/** oam absent, so the entry written is the npx one on every machine. */
const OAM_ABSENT = async (): Promise<OamProbe> => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});

/** The bundles.json summary, seamed so no run walks up from the real cwd
 *  looking for one. The path is the fixture's own string and never compared. */
const BUNDLES_EMPTY = (): BundlesSummary => ({
  state: "empty",
  count: 0,
  path: "/synth/.yaw-mcp/bundles.json",
  warnings: [],
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

// Deliberately OUTSIDE every describe that swaps the adapter registry: these
// runs need the real TOML adapter the row registers at module scope.
describe("install -> --list -> doctor over the file install wrote", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-codex-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "yaw-mcp-codex-proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  /** The user-scope file. `join`, so a Windows runner agrees with the row. */
  const userFile = (): string => join(home, ".codex", "config.toml");

  function seed(text: string): void {
    mkdirSync(dirname(userFile()), { recursive: true });
    writeFileSync(userFile(), text, "utf8");
  }

  async function install() {
    const cap = captureIo();
    const result = await runInstall({
      clientId: "codex-cli",
      scope: "user",
      os: "linux",
      home,
      cwd: projectDir,
      io: cap.io,
      oamProbe: OAM_ABSENT,
      bundlesSummary: BUNDLES_EMPTY,
    });
    return { result, stdout: cap.stdout(), stderr: cap.stderr() };
  }

  async function list(): Promise<string> {
    const cap = captureIo();
    await runInstall({ listOnly: true, os: "linux", home, cwd: projectDir, io: cap.io });
    return cap.stdout();
  }

  /** The cells of the one Codex CLI row for SCOPE, split on the table's
   *  two-space gutter so `not installed` stays one cell. */
  function listRow(out: string, scope: string): string[] {
    const rows = out
      .split("\n")
      .map((l) => l.trim().split(/ {2,}/))
      .filter((cells) => cells[0] === "Codex CLI" && cells[1] === scope);
    expect(rows, `exactly one Codex CLI (${scope}) row in:\n${out}`).toHaveLength(1);
    return rows[0];
  }

  /** The `N/M client scopes have yaw-mcp configured` headline's N. */
  function headlineCount(out: string): number {
    const m = /^(\d+)\/\d+ client scopes have yaw-mcp configured on linux\./m.exec(out);
    expect(m, `no headline in:\n${out}`).not.toBeNull();
    return Number(m?.[1]);
  }

  async function doctor(): Promise<{ text: string; exitCode: number }> {
    const out: string[] = [];
    const diagnosis = await runDoctor({
      home,
      cwd: projectDir,
      os: "linux",
      env: {},
      out: (s) => out.push(s),
      err: () => {},
      skipRegistryCheck: true,
      oamProbe: OAM_ABSENT,
    });
    return { text: out.join(""), exitCode: diagnosis.exitCode };
  }

  it("install codex-cli writes a config.toml that --list and doctor read as installed", async () => {
    const before = await list();
    expect(listRow(before, "user")[3]).toBe("not installed");
    expect(headlineCount(before)).toBe(0);

    const installed = await install();
    expect(installed.result.exitCode, installed.stderr).toBe(0);
    // The premise: what install wrote is the TOML table, not a JSON document
    // -- under the startup-grace key the row declares, at the top.
    expect(readFileSync(userFile(), "utf8")).toBe(
      `mcp_optional_startup_grace_ms = 0\n\n${fixture("f01-missing", "expected")}`,
    );

    const after = await list();
    expect(listRow(after, "user")[3]).toBe("installed");
    expect(headlineCount(after)).toBe(1);

    // The reported repro: this line read "exists but JSON is malformed" and
    // doctor exited 2 over the file install had just written.
    const d = await doctor();
    expect(d.text).toContain('Codex CLI (user): OK -- has "mcp" entry');
    expect(d.text).not.toContain("JSON is malformed");
    expect(d.exitCode).toBe(0);
  });

  it("truncated bytes: --list says malformed, and doctor and install both say TOML", async () => {
    seed(fixture("f10-malformed"));
    expect(listRow(await list(), "user")[3]).toBe("malformed");

    const d = await doctor();
    expect(d.text).toContain("Codex CLI (user): exists but TOML is malformed");
    expect(d.text).toContain("fix the TOML by hand, or move the file aside, then run `yaw-mcp install codex-cli`");

    const refused = await install();
    expect(refused.result.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("is not valid TOML");
    expect(refused.stderr).toContain(
      "-- refusing to overwrite it; fix the TOML by hand, or move the file aside, then re-run.",
    );
    expect(refused.stderr).not.toContain("JSON");
    // And the file is untouched.
    expect(readFileSync(userFile(), "utf8")).toBe(fixture("f10-malformed"));
  });

  it("install over an [[mcp_servers]] array refuses in TOML words", async () => {
    seed(fixture("f11-array-container"));
    const refused = await install();
    expect(refused.result.exitCode).not.toBe(0);
    expect(refused.stderr).toContain(
      `"mcp_servers" in ${userFile()} is an array of 1, not a TOML table -- refusing to overwrite it; make it a table (or remove the key), then re-run.`,
    );
    expect(refused.stderr).not.toContain("JSON");
    expect(readFileSync(userFile(), "utf8")).toBe(fixture("f11-array-container"));
  });

  it("an inline mcp entry lists as installed and counts in the headline (f09)", async () => {
    // The accepted over-count: install will not edit this spelling, but the
    // entry IS there, so --list says installed and the headline counts it.
    // Doctor words the row as present-but-not-editable (doctor-cmd.test.ts).
    seed(fixture("f09-inline"));
    const out = await list();
    expect(listRow(out, "user")[3]).toBe("installed");
    expect(headlineCount(out)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The startup grace: install adds `mcp_optional_startup_grace_ms = 0` at the
// top of config.toml, and never changes a value that is there
// ---------------------------------------------------------------------------

describe("install sets Codex's startup grace at the top of config.toml", () => {
  const GRACE = "mcp_optional_startup_grace_ms";
  const GRACE_LINE = `${GRACE} = 0`;
  /** The row's own reason, so these assertions follow the data. */
  const WHY = CODEX.config.rootDefaults?.[0]?.why ?? "(no rootDefaults on the codex-cli row)";
  /** The entry install writes, as its bytes on disk. */
  const TABLE = fixture("f01-missing", "expected");

  let home: string;
  let projectDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-codex-grace-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "yaw-mcp-codex-grace-proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const userFile = (): string => join(home, ".codex", "config.toml");

  function seed(text: string, file = userFile()): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
  }

  const read = (file = userFile()): string => readFileSync(file, "utf8");

  async function install(over: Partial<Parameters<typeof runInstall>[0]> = {}) {
    const cap = captureIo();
    const result = await runInstall({
      clientId: "codex-cli",
      scope: "user",
      os: "linux",
      home,
      cwd: projectDir,
      io: cap.io,
      oamProbe: OAM_ABSENT,
      bundlesSummary: BUNDLES_EMPTY,
      ...over,
    });
    return { result, stdout: cap.stdout(), stderr: cap.stderr() };
  }

  const setLine = (file: string): string => `Set ${GRACE_LINE} in ${file}: ${WHY}.`;
  const keptNote = (file: string, value: string): string =>
    `Note: ${file} already sets ${GRACE} to ${value}, and install leaves a value you set alone. 0 is recommended: ${WHY}.`;
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it("a fresh install writes the key and the entry, and says it set the key", async () => {
    const run = await install();
    expect(run.result.exitCode, run.stderr).toBe(0);
    expect(read()).toBe(`${GRACE_LINE}\n\n${TABLE}`);
    expect(run.result.written).toEqual([userFile()]);
    expect(count(run.stdout, setLine(userFile()))).toBe(1);
    // After the write, never before it.
    expect(run.stdout.indexOf(`Wrote ${userFile()}`)).toBeLessThan(run.stdout.indexOf(setLine(userFile())));
    // The entry WAS written here, so the Done line keeps its server wording.
    expect(run.stdout).toContain("\nDone: Codex CLI is configured. Restart it to pick up the new MCP server.");
  });

  it("a re-run over a correct entry with the key missing writes ONLY the key line, and says so", async () => {
    // One shape of an existing Codex setup: the entry install wrote, a root
    // key of the user's, and no grace key. The key line lands under the
    // user's key, so the write is that one line.
    const before = `model = "gpt-5"   # mine\n\n${fixture("f05-identical")}`;
    seed(before);
    const run = await install();
    expect(run.result.exitCode, run.stderr).toBe(0);
    expect(read()).toBe(before.replace("# mine\n", `# mine\n${GRACE_LINE}\n`));
    expect(run.stdout).toContain(`The "mcp" entry in ${userFile()} is already correct.`);
    expect(run.stdout).toContain(`Wrote ${userFile()}`);
    expect(count(run.stdout, setLine(userFile()))).toBe(1);
    expect(run.stdout).not.toContain("Nothing to do");
    expect(run.result.written).toEqual([userFile()]);
    // No server was added, so the Done line names the change.
    expect(run.stdout).toContain("\nDone: Codex CLI is configured. Restart it to pick up the change.");
    expect(run.stdout).not.toContain("new MCP server");

    // And the run after THAT is the no-op again, in bytes too.
    const after = read();
    const again = await install();
    expect(again.stdout).toContain("Nothing to do: Codex CLI is already configured.");
    expect(again.stdout).not.toContain(GRACE);
    expect(again.result.written).toEqual([]);
    expect(read()).toBe(after);
  });

  it("a re-run over the file an earlier install created adds the key line AND a blank line under it", async () => {
    // What `install codex-cli` wrote before this release: tables only. The
    // key goes at the very top, and the blank line keeps it apart from the
    // table it now sits above.
    const before = fixture("f05-identical");
    seed(before);
    const run = await install();
    expect(run.result.exitCode, run.stderr).toBe(0);
    expect(read()).toBe(`${GRACE_LINE}\n\n${before}`);
    expect(count(run.stdout, setLine(userFile()))).toBe(1);
    expect(run.stdout).toContain("\nDone: Codex CLI is configured. Restart it to pick up the change.");
  });

  it("a write that trims a legacy entry and adds the key still names the change, not a new server", async () => {
    const before = `${fixture("f05-identical")}\n[mcp_servers.yaw-mcp]\ncommand = "npx"\nargs = ["-y", "@yawlabs/mcph"]\n`;
    seed(before);
    const run = await install();
    expect(run.result.exitCode, run.stderr).toBe(0);
    expect(read()).toBe(`${GRACE_LINE}\n\n${fixture("f05-identical")}`);
    expect(run.stdout).toContain('Removed the legacy "yaw-mcp" entry');
    expect(count(run.stdout, setLine(userFile()))).toBe(1);
    expect(run.stdout).toContain("\nDone: Codex CLI is configured. Restart it to pick up the change.");
    expect(run.stdout).not.toContain("new MCP server");
  });

  it("a key-only write into a CRLF file with no final line break adds no bare LF", async () => {
    // Notepad's shape: CRLF, and no line break after the last line. The key
    // line goes in at the top, and the last line gets the FILE's break -- so
    // install's own "end with a newline" finds nothing to add.
    const table = fixture("f05-identical").replace(/\n/g, "\r\n");
    seed(table.replace(/\r\n$/, ""));
    const run = await install();
    expect(run.result.exitCode, run.stderr).toBe(0);
    expect(run.result.written).toEqual([userFile()]);
    expect(read()).toBe(`${GRACE_LINE}\r\n\r\n${table}`);
    expect(/(^|[^\r])\n/.test(read())).toBe(false);
    expect(count(run.stdout, setLine(userFile()))).toBe(1);
  });

  it("a key already at 0 is nothing to do and nothing to say", async () => {
    // The control: the same correct entry WITHOUT the key is a write, so what
    // makes the run below a no-op is the key being there at 0 -- not the
    // entry alone.
    seed(fixture("f05-identical"));
    expect((await install({ dryRun: true })).result.wouldWrite).toEqual([userFile()]);

    const before = `${GRACE_LINE}\n\n${fixture("f05-identical")}`;
    seed(before);
    const run = await install();
    expect(run.result.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toContain("Nothing to do: Codex CLI is already configured.");
    expect(run.stdout).not.toContain(GRACE);
    expect(run.result.written).toEqual([]);
    expect(read()).toBe(before);
  });

  it("a key the user set to another value is left byte-for-byte, with ONE note", async () => {
    // Quoted on purpose: presence comes from the parse, so this is the key.
    const before = `"${GRACE}" = 1000\n\n${fixture("f05-identical")}`;
    seed(before);
    const run = await install();
    expect(run.result.exitCode, run.stderr).toBe(0);
    expect(read()).toBe(before);
    expect(run.result.written).toEqual([]);
    expect(count(run.stdout, keptNote(userFile(), "1000"))).toBe(1);
    expect(count(`${run.stdout}${run.stderr}`, GRACE)).toBe(1);
    expect(run.stdout).toContain("Nothing to do: Codex CLI is already configured.");
  });

  it("a FLOAT the user wrote is another value: left alone, and the note names it as written", async () => {
    // `0.0` parses to the same number as `0`, and Codex (which types the key
    // as an integer) refuses it -- so it is never read as the recommended 0.
    for (const spelled of ["0.0", "-0.0", "0e0", "1000.0"]) {
      const before = `${GRACE} = ${spelled}\n\n${fixture("f05-identical")}`;
      seed(before);
      const run = await install();
      expect(run.result.exitCode, run.stderr).toBe(0);
      expect(read(), spelled).toBe(before);
      expect(run.result.written, spelled).toEqual([]);
      expect(count(run.stdout, keptNote(userFile(), `${spelled}, a float where Codex CLI needs an integer`))).toBe(1);
      expect(count(`${run.stdout}${run.stderr}`, GRACE), spelled).toBe(1);
    }
  });

  it("--repair and --force rewrite a stale entry and still leave the user's value alone", async () => {
    for (const flag of [{ repair: true }, { force: true }]) {
      const before = `${GRACE} = 5000\n\n${fixture("f06-codex-add-shape")}`;
      seed(before);
      const run = await install(flag);
      expect(run.result.exitCode, run.stderr).toBe(0);
      expect(read(), JSON.stringify(flag)).toBe(
        `${GRACE} = 5000\n\n${fixture("f06-codex-add-shape", "expected-repair")}`,
      );
      expect(count(run.stdout, keptNote(userFile(), "5000")), JSON.stringify(flag)).toBe(1);
      expect(run.stdout).not.toContain(`Set ${GRACE}`);
    }
  });

  it("--skip leaves the whole file as it is, the missing key included", async () => {
    // `--skip` means "leave what is there": it returns before the key is
    // planned, so over a correct entry with the key missing it is a no-op --
    // no write, the same bytes -- and says nothing about the key.
    const before = fixture("f05-identical");
    seed(before);
    const run = await install({ skip: true });
    expect(run.result.exitCode, run.stderr).toBe(0);
    expect(run.result.written).toEqual([]);
    expect(read()).toBe(before);
    expect(run.stdout).toContain('Existing "mcp" entry left untouched. Nothing to do.');
    expect(`${run.stdout}${run.stderr}`).not.toContain(GRACE);

    const dry = await install({ skip: true, dryRun: true });
    expect(dry.result.wouldWrite).toEqual([]);
    expect(dry.stdout).toContain('Would leave existing "mcp" entry untouched (--skip). Nothing to do.');
    expect(`${dry.stdout}${dry.stderr}`).not.toContain(GRACE);
    expect(read()).toBe(before);
  });

  it("--dry-run writes nothing, shows the line in the preview, and says it WOULD set it", async () => {
    const fresh = await install({ dryRun: true });
    expect(fresh.result.exitCode, fresh.stderr).toBe(0);
    expect(existsSync(userFile())).toBe(false);
    expect(fresh.result.written).toEqual([]);
    expect(fresh.result.wouldWrite).toEqual([userFile()]);
    // The block is the fresh file itself: the key, a blank line, the table.
    expect(fresh.stdout).toContain(`# ${userFile()}\n${GRACE_LINE}\n\n${TABLE}`);
    expect(count(fresh.stdout, `Would set ${GRACE_LINE} in ${userFile()}: ${WHY}.`)).toBe(1);
    expect(fresh.stdout).not.toContain(setLine(userFile()));

    // Over a correct entry the preview is the key line alone.
    const before = fixture("f05-identical");
    seed(before);
    const keyOnly = await install({ dryRun: true });
    expect(read()).toBe(before);
    expect(keyOnly.result.wouldWrite).toEqual([userFile()]);
    expect(keyOnly.stdout).toContain(`# ${userFile()}\n${GRACE_LINE}\n`);
    expect(keyOnly.stdout).not.toContain("[mcp_servers.mcp]");
    expect(keyOnly.stdout).not.toContain("Nothing to do");
    expect(count(keyOnly.stdout, `Would set ${GRACE_LINE} in ${userFile()}: ${WHY}.`)).toBe(1);
  });

  it("--scope project writes the key into the project's .codex/config.toml, and only there", async () => {
    const projectFile = join(projectDir, ".codex", "config.toml");
    const run = await install({ scope: "project" });
    expect(run.result.exitCode, run.stderr).toBe(0);
    expect(read(projectFile)).toBe(`${GRACE_LINE}\n\n${TABLE}`);
    expect(existsSync(userFile())).toBe(false);
    expect(count(run.stdout, setLine(projectFile))).toBe(1);
  });

  it("follows CODEX_HOME exactly as the entry does", async () => {
    const codexHome = join(home, "elsewhere");
    mkdirSync(codexHome, { recursive: true });
    const file = join(codexHome, "config.toml");
    const run = await install({ clientEnv: { codexHome } });
    expect(run.result.exitCode, run.stderr).toBe(0);
    expect(read(file)).toBe(`${GRACE_LINE}\n\n${TABLE}`);
    expect(existsSync(userFile())).toBe(false);
    expect(count(run.stdout, setLine(file))).toBe(1);
  });

  it("uninstall takes the entry and leaves the key", async () => {
    await install();
    const cap = captureIo();
    const result = await runUninstall({
      clientId: "codex-cli",
      scope: "user",
      os: "linux",
      home,
      cwd: projectDir,
      force: true,
      io: cap.io,
    });
    expect(result.exitCode, cap.stderr()).toBe(0);
    expect(read()).toBe(`${GRACE_LINE}\n`);
    // And a later install puts the entry back without touching the key.
    const reinstall = await install();
    expect(read()).toBe(`${GRACE_LINE}\n\n${TABLE}`);
    expect(reinstall.stdout).not.toContain(`Set ${GRACE}`);
  });

  it("--list and doctor read a file carrying the key as installed and healthy", async () => {
    await install();
    expect(read().startsWith(`${GRACE_LINE}\n`)).toBe(true);
    const cap = captureIo();
    await runInstall({ listOnly: true, os: "linux", home, cwd: projectDir, io: cap.io });
    const row = cap
      .stdout()
      .split("\n")
      .map((l) => l.trim().split(/ {2,}/))
      .find((cells) => cells[0] === "Codex CLI" && cells[1] === "user");
    expect(row?.[3]).toBe("installed");
    const out: string[] = [];
    const diagnosis = await runDoctor({
      home,
      cwd: projectDir,
      os: "linux",
      env: {},
      out: (s) => out.push(s),
      err: () => {},
      skipRegistryCheck: true,
      oamProbe: OAM_ABSENT,
    });
    expect(out.join("")).toContain('Codex CLI (user): OK -- has "mcp" entry');
    expect(out.join("")).not.toContain("malformed");
    expect(diagnosis.exitCode).toBe(0);
  });

  it("a failed key-only write says it was setting the key, not splicing the entry", async () => {
    const real = adapterFor("toml");
    try {
      resetConfigAdapterRegistry();
      registerConfigAdapter("toml", {
        ...real,
        insertRootKey: () => {
          throw new Error("stand-in refusal");
        },
      });
      const before = fixture("f05-identical");
      seed(before);
      const run = await install();
      expect(run.result.exitCode).toBe(1);
      expect(run.stderr).toContain(
        `yaw-mcp install: failed to set ${GRACE_LINE} in ${userFile()} (${userFile()} could not be edited (stand-in refusal)). Refusing to overwrite.`,
      );
      expect(run.stderr).not.toContain("failed to splice");
      expect(read()).toBe(before);
    } finally {
      resetConfigAdapterRegistry();
      registerConfigAdapter("toml", real);
    }
  });
});

// ---------------------------------------------------------------------------
// A CRLF config.toml whose last line has no line break stays CRLF
// ---------------------------------------------------------------------------

describe("install ends a CRLF config.toml in CRLF", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-codex-crlf-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "yaw-mcp-codex-crlf-proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const userFile = (): string => join(home, ".codex", "config.toml");

  /** Every LF in `text` that is not the second half of a CRLF. */
  const bareLfs = (text: string): number => (text.match(/(?<!\r)\n/g) ?? []).length;

  async function install(over: Partial<Parameters<typeof runInstall>[0]> = {}) {
    const cap = captureIo();
    const result = await runInstall({
      clientId: "codex-cli",
      scope: "user",
      os: "linux",
      home,
      cwd: projectDir,
      io: cap.io,
      oamProbe: OAM_ABSENT,
      bundlesSummary: BUNDLES_EMPTY,
      ...over,
    });
    return { result, stdout: cap.stdout(), stderr: cap.stderr() };
  }

  // Our table in the MIDDLE, differing from what install writes, and the last
  // line -- another server's -- with no line break. The grace key is already
  // there, so the table replace is the whole write: nothing else in it gives
  // that last line its line break, and the terminator install ends every write
  // with used to add a bare LF, leaving the file with mixed line endings.
  const BEFORE = [
    "mcp_optional_startup_grace_ms = 0",
    "",
    "[mcp_servers.mcp]",
    'command = "theirs"',
    "",
    "[mcp_servers.other]",
    'command = "node"',
  ].join("\r\n");

  for (const flag of ["repair", "force"] as const) {
    it(`--${flag} over a differing entry that is not the last table ends the file in CRLF, with no bare LF`, async () => {
      mkdirSync(dirname(userFile()), { recursive: true });
      writeFileSync(userFile(), BEFORE, "utf8");
      const run = await install({ [flag]: true });
      expect(run.result.exitCode, run.stderr).toBe(0);
      const after = readFileSync(userFile(), "utf8");
      expect(after).not.toContain('"theirs"');
      expect(bareLfs(after)).toBe(0);
      expect(after.endsWith('[mcp_servers.other]\r\ncommand = "node"\r\n')).toBe(true);
    });
  }

  it("an LF file with no final line break still gets an LF, and no CR", async () => {
    mkdirSync(dirname(userFile()), { recursive: true });
    writeFileSync(userFile(), BEFORE.replaceAll("\r\n", "\n"), "utf8");
    const run = await install({ repair: true });
    expect(run.result.exitCode, run.stderr).toBe(0);
    const after = readFileSync(userFile(), "utf8");
    expect(after).not.toContain("\r");
    expect(after.endsWith('[mcp_servers.other]\ncommand = "node"\n')).toBe(true);
  });

  it("a CRLF file that already ends in CRLF keeps exactly that one line break", async () => {
    mkdirSync(dirname(userFile()), { recursive: true });
    writeFileSync(userFile(), `${BEFORE}\r\n`, "utf8");
    const run = await install({ repair: true });
    expect(run.result.exitCode, run.stderr).toBe(0);
    const after = readFileSync(userFile(), "utf8");
    expect(bareLfs(after)).toBe(0);
    expect(after.endsWith('command = "node"\r\n')).toBe(true);
    expect(after.endsWith("\r\n\r\n")).toBe(false);
  });
});
