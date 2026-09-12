// Every row in INSTALL_TARGETS, driven end to end through the client-config
// core: resolve a site, classify an absent file, write the entry, read it
// back, remove it.
//
// TABLE-DRIVEN over the table itself, so a landing row is covered the moment
// it is appended -- which is the point. A per-client test file can assert what
// makes that client different (Zed's carried `enabled`, Cline's fan-out,
// Continue's dedicated file); what has to hold for EVERY row is that its
// resolved path, its container address and its format agree well enough for
// the adapter to classify, splice and un-splice it, and that is what this
// file holds. The per-client fixture matrices belong in each row's own test.
//
// Hermetic: a synthetic home per run, every env value passed in rather than
// read, and nothing is written to disk -- `classifyClientConfig` takes the raw
// text and `applyClientConfigEdits` returns it.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyClientConfigEdits,
  type ConfigSite,
  classifyClientConfig,
  effectiveConfigFormat,
  normalizeEntry,
  reloadDoneClause,
} from "../client-config.js";
import { ENTRY_NAME, INSTALL_TARGETS, type InstallOS, resolveInstallPath } from "../install-targets.js";

const HOME = "/synth/home";
const APPDATA = "C:/synth/AppData/Roaming";
const PROJECT = "/synth/home/proj";
const ENTRY = { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] };

// Every ABSOLUTE-path expectation below is built with `join` from node:path,
// never spelled as a POSIX literal. `join` is platform-aware and the SUT uses
// it too, so on a Windows runner both sides come back with backslashes and
// agree; a literal would match on macOS and Linux and fail only on Windows,
// which is exactly how a path expectation ships broken. DISPLAY strings are
// different: they are spelled for the TARGET os, not the runner, so those stay
// literals.

/** One site per (row, scope, os), built the way a consumer builds it. */
function siteFor(
  target: (typeof INSTALL_TARGETS)[number],
  scope: (typeof INSTALL_TARGETS)[number]["scopes"][number],
  os: InstallOS,
): ConfigSite {
  const resolved = resolveInstallPath({
    clientId: target.clientId,
    scope: scope.scope,
    os,
    home: HOME,
    appData: APPDATA,
    projectDir: scope.requiresProjectDir ? PROJECT : undefined,
  });
  return {
    id: "default",
    label: target.label,
    format: effectiveConfigFormat(target.config, scope),
    resolved,
    detectDir: null,
  };
}

describe("every row round-trips through the core", () => {
  const cases: Array<{ name: string; site: ConfigSite; target: (typeof INSTALL_TARGETS)[number] }> = [];
  for (const target of INSTALL_TARGETS) {
    for (const os of target.availableOn) {
      for (const scope of target.scopes) {
        cases.push({ name: `${target.clientId}/${scope.scope}/${os}`, site: siteFor(target, scope, os), target });
      }
    }
  }

  it("covers every row, so a landing target is not silently skipped", () => {
    // A floor, not a count: the point is that the loop above produced a case
    // for each row rather than filtering them all away.
    const covered = new Set(cases.map((c) => c.target.clientId));
    expect([...covered].sort()).toEqual(INSTALL_TARGETS.map((t) => t.clientId).sort());
    expect(cases.length).toBeGreaterThanOrEqual(INSTALL_TARGETS.length);
  });

  for (const { name, site, target } of cases) {
    it(`${name}: writes, reads back and removes its entry`, () => {
      const absent = classifyClientConfig(null, site);
      expect(absent.read.kind).toBe("absent");

      // Create the file, with a FOREIGN sibling already in it so the write has
      // a neighbour to preserve -- the case a splice that re-renders the
      // container would silently rewrite.
      const seeded = applyClientConfigEdits(
        absent,
        [{ op: "upsert", key: "other", entry: { command: "x", args: [] } }],
        site,
      );
      const withOther = classifyClientConfig(seeded, site);
      const written = applyClientConfigEdits(withOther, [{ op: "upsert", key: ENTRY_NAME, entry: ENTRY }], site);

      const back = classifyClientConfig(written, site);
      expect(back.read.kind).toBe("ok");
      expect(back.entry()?.launch?.command).toBe("npx");
      expect(back.otherServerKeys()).toEqual(["other"]);
      expect(back.count()).toBe(2);
      // The container the row declares is the one that was written into.
      expect(site.resolved.containerPath.at(-1)).toBe(target.config.root);

      // And out again, leaving the neighbour byte for byte.
      const removed = applyClientConfigEdits(back, [{ op: "remove", key: ENTRY_NAME }], site);
      const after = classifyClientConfig(removed, site);
      expect(after.entry()).toBeUndefined();
      expect(after.otherServerKeys()).toEqual(["other"]);
      expect(removed).toContain('"other"');
    });
  }
});

describe("each row's own behaviour, as data", () => {
  const row = (id: string): (typeof INSTALL_TARGETS)[number] => {
    const t = INSTALL_TARGETS.find((x) => x.clientId === id);
    if (!t) throw new Error(`no ${id} row`);
    return t;
  };

  it("zed keeps its own container key and says no restart is needed", () => {
    const zed = row("zed");
    expect(zed.config.root).toBe("context_servers");
    expect(zed.reload).toBe("live");
    expect(reloadDoneClause(zed.reload, zed.label)).toBe(
      "Zed starts the server when the file is saved -- no restart needed.",
    );
  });

  it("zed carries its own per-server fields, type-checked, and never `source`", () => {
    const carry = row("zed").entry?.carry;
    expect(carry).toBeDefined();
    expect(carry?.({ enabled: false, remote: true, timeout: 120, source: "custom", command: "x" })).toEqual({
      enabled: false,
      remote: true,
      timeout: 120,
    });
    // An ill-typed value is NOT carried: writing it back would put something
    // Zed rejects into the file, and leaving it out surfaces it as drift.
    expect(carry?.({ enabled: "yes", timeout: "120", remote: 1 })).toEqual({});
    // A stored `source` is deliberately dropped -- current Zed migrates that
    // key away from the user file, so carrying it would put it straight back.
    expect(carry?.({ source: "custom" })).toEqual({});
  });

  it("zed follows an ABSOLUTE $XDG_CONFIG_HOME on Linux and ignores a relative one", () => {
    const absolute = resolveInstallPath({
      clientId: "zed",
      scope: "user",
      os: "linux",
      home: HOME,
      clientEnv: { xdgConfigHome: "/xdg" },
    });
    expect(absolute.absolute).toBe(join("/xdg", "zed", "settings.json"));
    expect(absolute.display).toBe("$XDG_CONFIG_HOME/zed/settings.json");
    // Relative is ignored, the rule Zed inherits from the dirs crate.
    const relative = resolveInstallPath({
      clientId: "zed",
      scope: "user",
      os: "linux",
      home: HOME,
      clientEnv: { xdgConfigHome: "conf" },
    });
    expect(relative.absolute).toBe(join(HOME, ".config", "zed", "settings.json"));
    // And it is a LINUX rule: macOS uses ~/.config regardless.
    const mac = resolveInstallPath({
      clientId: "zed",
      scope: "user",
      os: "macos",
      home: HOME,
      clientEnv: { xdgConfigHome: "/xdg" },
    });
    expect(mac.absolute).toBe(join(HOME, ".config", "zed", "settings.json"));
  });

  it("cline reads its file as STRICT json, so a comment in it is not writable", () => {
    const cline = row("cline");
    expect(cline.config.format).toBe("json");
    expect(effectiveConfigFormat(cline.config, cline.scopes[0])).toBe("json");
    const site = siteFor(cline, cline.scopes[0], "linux");
    const commented = '{\n  // a note\n  "mcpServers": {}\n}\n';
    const view = classifyClientConfig(commented, site);
    // Readable, and its entries enumerable -- uninstall and import still work
    // on a file Cline itself skips.
    expect(view.read.kind).toBe("ok");
    expect(view.unloadable()).not.toBeNull();
    // But a WRITE into it is refused: adding a server to a file whose every
    // server Cline is already ignoring would print Done over nothing.
    expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: ENTRY_NAME, entry: ENTRY }], site)).toThrow();
  });

  it("cline fans one (client, scope) out to the shared file plus a site per editor", () => {
    const cline = row("cline");
    expect(cline.sites).toBeDefined();
    const sites = cline.sites?.({
      home: HOME,
      appData: APPDATA,
      projectDir: "",
      os: "linux",
      scope: "user",
      env: {},
    });
    expect(sites?.[0].id).toBe("shared");
    // The shared file is UNCONDITIONAL -- it is where install creates one.
    expect(sites?.[0].detectDir).toBeNull();
    expect(sites?.[0].resolved.absolute).toBe(join(HOME, ".cline", "data", "settings", "cline_mcp_settings.json"));
    // Every editor site is gated on its extension storage directory existing.
    expect(sites?.slice(1).every((s) => s.detectDir !== null)).toBe(true);
    expect(sites?.map((s) => s.id)).toEqual(["shared", "vscode", "vscode-insiders", "vscodium", "cursor", "windsurf"]);
  });

  it("cline honours its three env knobs in Cline's own precedence", () => {
    const sites = (env: Record<string, string>) =>
      row("cline").sites?.({ home: HOME, appData: APPDATA, projectDir: "", os: "linux", scope: "user", env })?.[0]
        .resolved;
    expect(sites({ clineMcpSettingsPath: "/exact/file.json" })?.absolute).toBe("/exact/file.json");
    expect(sites({ clineDataDir: "/data" })?.absolute).toBe(join("/data", "settings", "cline_mcp_settings.json"));
    expect(sites({ clineDir: "/cline" })?.absolute).toBe(join("/cline", "data", "settings", "cline_mcp_settings.json"));
    // The exact path wins over the data dir, which wins over the dir above it.
    expect(sites({ clineMcpSettingsPath: "/exact/file.json", clineDataDir: "/data", clineDir: "/c" })?.absolute).toBe(
      "/exact/file.json",
    );
    // An env-directed path is shown VERBATIM, so the redirect is visible.
    expect(sites({ clineDataDir: "/data" })?.display).toBe(join("/data", "settings", "cline_mcp_settings.json"));
  });

  it("cline folds the nested transport form so every consumer compares one shape", () => {
    const normalize = row("cline").entry?.normalize;
    expect(normalizeEntry({ transport: { command: "npx", args: ["-y", "x"] }, disabled: true }, { normalize })).toEqual(
      {
        command: "npx",
        args: ["-y", "x"],
        disabled: true,
      },
    );
    // The FLAT fields win when both spellings are present -- that is what
    // install writes.
    expect(normalizeEntry({ transport: { command: "old" }, command: "new" }, { normalize })).toEqual({
      command: "new",
    });
    // A row with no transport key is returned as it is.
    expect(normalizeEntry({ command: "npx" }, { normalize })).toEqual({ command: "npx" });
  });

  it("cline carries its own fields, and `type` only when it says stdio", () => {
    const carry = row("cline").entry?.carry;
    expect(carry?.({ disabled: true, autoApprove: ["a"], timeout: 60, type: "stdio" })).toEqual({
      disabled: true,
      autoApprove: ["a"],
      timeout: 60,
      type: "stdio",
    });
    expect(carry?.({ type: "sse", autoApprove: [1], timeout: -1 })).toEqual({});
  });

  it("continue owns its file, reloads the window, and takes a bare npx on Windows", () => {
    const cn = row("continue");
    expect(cn.config.ownership).toBe("dedicated");
    expect(cn.reload).toBe("reload-window");
    expect(reloadDoneClause(cn.reload, cn.label)).toBe("Reload the IDE window to pick up the new MCP server.");
    expect(cn.entry?.windowsLaunch?.broker).toBe("bare");
    // The trial entry still takes the shared wrap: it names a third-party
    // launcher whose args have to survive cmd's parse.
    expect(cn.entry?.windowsLaunch?.upstream).toBe("cmd-wrap");
  });

  it("continue writes into its own mcpServers folder, per scope and per OS", () => {
    const user = resolveInstallPath({ clientId: "continue", scope: "user", os: "linux", home: HOME });
    expect(user.absolute).toBe(join(HOME, ".continue", "mcpServers", "yaw-mcp.json"));
    expect(user.display).toBe("~/.continue/mcpServers/yaw-mcp.json");
    const project = resolveInstallPath({
      clientId: "continue",
      scope: "project",
      os: "linux",
      home: HOME,
      projectDir: PROJECT,
    });
    expect(project.absolute).toBe(join(PROJECT, ".continue", "mcpServers", "yaw-mcp.json"));
    expect(project.display).toBe("<project folder>/.continue/mcpServers/yaw-mcp.json");
  });

  it("continue honours CONTINUE_GLOBAL_DIR, verbatim in the display", () => {
    const redirected = resolveInstallPath({
      clientId: "continue",
      scope: "user",
      os: "linux",
      home: HOME,
      clientEnv: { continueGlobalDir: "/elsewhere" },
    });
    expect(redirected.absolute).toBe(join("/elsewhere", "mcpServers", "yaw-mcp.json"));
    // Shown as-is, the CLAUDE_CONFIG_DIR precedent: a `~` spelling would hide
    // the redirect.
    expect(redirected.display).toBe(redirected.absolute);
  });

  it("leaves every pre-existing row on the default restart wording", () => {
    // The six oldest rows print exactly what they printed before `reload`
    // existed, which is what makes routing them through reloadDoneClause a
    // no-op rather than a rewording.
    for (const id of ["claude-code", "claude-desktop", "cursor", "vscode", "windsurf", "gemini-cli"]) {
      const t = row(id);
      expect(t.reload, `${id} gained a reload kind`).toBeUndefined();
      expect(reloadDoneClause(t.reload, t.label)).toBe("Restart it to pick up the new MCP server.");
    }
  });
});
