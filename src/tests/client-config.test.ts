// The format-agnostic model: the registry, the env reader, sites, reload, the
// entry transforms, the view and the write facade.
//
// Everything here goes through the PUBLIC contract. Where a syntax is needed
// the built-in JSON adapter provides it, so these tests say what a CONSUMER
// can rely on rather than how the adapter spells it (that is
// client-config-json.test.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  adapterFor,
  addressOf,
  applyClientConfigEdits,
  CLIENT_ENV_VARS,
  type ClientConfigView,
  CONFIG_FORMATS,
  type ConfigAdapter,
  type ConfigRead,
  type ConfigSite,
  canonicalJson,
  carriedFieldsOf,
  carryableEnvOf,
  classifyClientConfig,
  composeEntry,
  describeValueShape,
  type EntryAddress,
  type EntryTransform,
  type EntryView,
  effectiveConfigFormat,
  findLegacyKey,
  hasConfigAdapter,
  importViewOf,
  launchOf,
  MissingConfigAdapterError,
  normalizeEntry,
  positionAt,
  readClientConfigFile,
  readClientEnv,
  registerConfigAdapter,
  reloadDoneClause,
  resetConfigAdapterRegistry,
  selectSites,
  syntaxNameFor,
  terminateWithNewline,
} from "../client-config.js";
import { findLegacyEntry, INSTALL_TARGETS, resolveInstallPath } from "../install-targets.js";

const ENTRY: Record<string, unknown> = { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] };

const site = (over: Partial<ConfigSite> = {}): ConfigSite => ({
  id: "default",
  label: "Test Client",
  format: "jsonc",
  resolved: { absolute: "/home/u/cfg.json", display: "~/cfg.json", containerPath: ["mcpServers"] },
  detectDir: null,
  ...over,
});

describe("the format registry", () => {
  it("serves the JSON family out of the box", () => {
    expect(hasConfigAdapter("json")).toBe(true);
    expect(hasConfigAdapter("jsonc")).toBe(true);
    expect(adapterFor("jsonc").syntax).toBe("JSON");
  });

  it("declares toml without shipping an adapter, and refuses it by name", () => {
    // The whole point of declaring the format: a consumer asking for it gets a
    // sentence about this build, not a parse failure three layers down.
    expect(CONFIG_FORMATS).toContain("toml");
    expect(hasConfigAdapter("toml")).toBe(false);
    expect(() => adapterFor("toml")).toThrow(MissingConfigAdapterError);
    expect(() => adapterFor("toml")).toThrow(/cannot read or write TOML client configs/);
    expect(syntaxNameFor("toml")).toBe("TOML");
  });

  it("lets a sibling module add one, and refuses a second for the same format", () => {
    const stub = { syntax: "TOML" } as unknown as ConfigAdapter;
    try {
      registerConfigAdapter("toml", stub);
      expect(hasConfigAdapter("toml")).toBe(true);
      expect(adapterFor("toml")).toBe(stub);
      expect(() => registerConfigAdapter("toml", stub)).toThrow(/already registered/);
      // And never over a built-in: two readers of one syntax is the split this
      // seam exists to prevent.
      expect(() => registerConfigAdapter("jsonc", stub)).toThrow(/already registered/);
    } finally {
      resetConfigAdapterRegistry();
    }
    expect(hasConfigAdapter("toml")).toBe(false);
  });
});

describe("the env reader", () => {
  it("reads every variable that relocates a client config", () => {
    const env = {
      APPDATA: "C:/Users/u/AppData/Roaming",
      CLAUDE_CONFIG_DIR: "/w/claude",
      CLINE_DATA_DIR: "/w/cline-data",
      CLINE_DIR: "/w/cline",
      CLINE_MCP_SETTINGS_PATH: "/w/cline/settings.json",
      CODEX_HOME: "/w/codex",
      CONTINUE_GLOBAL_DIR: "/w/continue",
      XDG_CONFIG_HOME: "/w/xdg",
    };
    expect(readClientEnv(env)).toEqual({
      appData: "C:/Users/u/AppData/Roaming",
      claudeConfigDir: "/w/claude",
      clineDataDir: "/w/cline-data",
      clineDir: "/w/cline",
      clineMcpSettingsPath: "/w/cline/settings.json",
      codexHome: "/w/codex",
      continueGlobalDir: "/w/continue",
      xdgConfigHome: "/w/xdg",
    });
  });

  it("treats an EMPTY value as unset, one variable at a time", () => {
    // An empty-but-set variable is ordinary on Windows and in CI. Passing one
    // through as a real value is what once made every Claude Desktop path
    // relative to the process cwd.
    for (const name of CLIENT_ENV_VARS) {
      const read = readClientEnv({ [name]: "" }) as Record<string, unknown>;
      expect(Object.keys(read), name).toEqual([]);
    }
  });

  it("reports an unset variable as absent, not as an empty string", () => {
    const read = readClientEnv({}) as Record<string, unknown>;
    expect(Object.keys(read)).toEqual([]);
    expect(read.claudeConfigDir).toBeUndefined();
  });

  it("names every variable it reads, so the CLI help can be checked against it", () => {
    expect([...CLIENT_ENV_VARS]).toEqual([...CLIENT_ENV_VARS].sort());
    expect(CLIENT_ENV_VARS).toContain("CLAUDE_CONFIG_DIR");
    expect(CLIENT_ENV_VARS).toContain("CODEX_HOME");
    expect(CLIENT_ENV_VARS.filter((n) => n.startsWith("CLINE_")).length).toBe(3);
  });

  it("is the only ambient environment read in either module", () => {
    // The rest of the model takes what it needs as a parameter. A second
    // process.env read is how one client comes to honour an override in
    // `install` and ignore it in `doctor`.
    const dir = fileURLToPath(new URL("..", import.meta.url));
    for (const file of ["client-config.ts", "client-config-json.ts"]) {
      const source = readFileSync(join(dir, file), "utf8");
      const hits = source.split("\n").filter((line) => /process\.env/.test(line) && !/^\s*(\/\/|\*)/.test(line));
      expect(hits, file).toEqual(
        file === "client-config.ts"
          ? ["export function readClientEnv(env: NodeJS.ProcessEnv = process.env): ClientEnv {"]
          : [],
      );
    }
  });
});

describe("sites", () => {
  const shared = site({ id: "shared", label: "Cline" });
  const present = site({
    id: "vscode",
    label: "Cline (VS Code)",
    detectDir: "/home/u/.config/Code/User/globalStorage/x",
    resolved: { absolute: "/home/u/.config/Code/.../settings.json", display: "~/...", containerPath: ["mcpServers"] },
  });
  const absent = site({
    id: "cursor",
    label: "Cline (Cursor)",
    detectDir: "/home/u/.config/Cursor/User/globalStorage/x",
    resolved: { absolute: "/home/u/.config/Cursor/.../settings.json", display: "~/...", containerPath: ["mcpServers"] },
  });

  it("keeps the unconditional site and every detected one, in order", () => {
    const exists = (p: string) => p === present.detectDir;
    expect(selectSites([shared, present, absent], exists).map((s) => s.id)).toEqual(["shared", "vscode"]);
  });

  it("keeps an unconditional site even when nothing on disk exists", () => {
    expect(selectSites([shared, present, absent], () => false).map((s) => s.id)).toEqual(["shared"]);
  });

  it("gives each site its own absolute path, display path and container path", () => {
    expect(addressOf(present)).toEqual({ format: "jsonc", containerPath: ["mcpServers"] });
    expect(present.resolved.absolute).not.toBe(shared.resolved.absolute);
    expect(present.label).not.toBe(shared.label);
  });

  it("writes into each detected site independently", () => {
    // What a fan-out install does: the same edit, per site, each against that
    // file's own bytes.
    const raws = new Map([
      [shared.id, '{\n  "mcpServers": {}\n}\n'],
      [present.id, '{\n  "mcpServers": {\n    "fs": {"command": "npx"}\n  }\n}\n'],
    ]);
    const written = selectSites([shared, present, absent], (p) => p === present.detectDir).map((s) => {
      const view = classifyClientConfig(raws.get(s.id) ?? null, s);
      return [s.id, applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], s)] as const;
    });
    expect(written.map(([id]) => id)).toEqual(["shared", "vscode"]);
    for (const [, text] of written) expect(classifyClientConfig(text, shared).entry()?.launch?.command).toBe("npx");
    // The detected site's neighbour survived; the undetected one was never read.
    expect(written[1][1]).toContain('"fs"');
  });
});

describe("format strictness is declared, never guessed", () => {
  it("narrows a JSONC target to strict JSON for a scope that says so", () => {
    const shape = { format: "jsonc" as const, root: "mcpServers" };
    expect(effectiveConfigFormat(shape)).toBe("jsonc");
    expect(effectiveConfigFormat(shape, {})).toBe("jsonc");
    expect(effectiveConfigFormat(shape, { strictJson: false })).toBe("jsonc");
    expect(effectiveConfigFormat(shape, { strictJson: true })).toBe("json");
  });

  it("leaves a target that is already strict, and a non-JSON one, alone", () => {
    expect(effectiveConfigFormat({ format: "json", root: "mcpServers" }, { strictJson: true })).toBe("json");
    expect(effectiveConfigFormat({ format: "toml", root: "mcp_servers" }, { strictJson: true })).toBe("toml");
  });
});

describe("reload descriptors tell the truth per client", () => {
  it("keeps today's restart wording as the default", () => {
    expect(reloadDoneClause(undefined, "Cursor")).toBe("Restart it to pick up the new MCP server.");
    expect(reloadDoneClause("restart", "Cursor")).toBe("Restart it to pick up the new MCP server.");
  });

  it("says no restart is needed for a client that watches the file", () => {
    expect(reloadDoneClause("live", "Zed")).toBe("Zed starts the server when the file is saved -- no restart needed.");
  });

  it("asks for a window reload where that is what it takes", () => {
    expect(reloadDoneClause("reload-window", "Continue")).toBe("Reload the IDE window to pick up the new MCP server.");
  });
});

describe("entry transforms", () => {
  const CLINE: EntryTransform = {
    // The fields a client owns on our entry, type-checked by the target
    // itself: a disabled flag, an auto-approve list and a timeout.
    carry: (stored) => {
      const out: Record<string, unknown> = {};
      if (typeof stored.disabled === "boolean") out.disabled = stored.disabled;
      if (Array.isArray(stored.autoApprove) && stored.autoApprove.every((v) => typeof v === "string")) {
        out.autoApprove = stored.autoApprove;
      }
      if (typeof stored.timeout === "number" && stored.timeout >= 0) out.timeout = stored.timeout;
      return out;
    },
  };

  it("carries the client's own fields forward and drops what it cannot validate", () => {
    const stored = { command: "npx", disabled: true, autoApprove: ["a", "b"], timeout: 60, oauth: {} };
    expect(carriedFieldsOf(stored, CLINE)).toEqual({ disabled: true, autoApprove: ["a", "b"], timeout: 60 });
    expect(carriedFieldsOf({ disabled: "yes", autoApprove: [1] }, CLINE)).toEqual({});
    expect(carriedFieldsOf(stored, {})).toEqual({});
    expect(carriedFieldsOf(7, CLINE)).toEqual({});
  });

  it("never lets a carry hook own `env`, which the core carries itself", () => {
    // Two owners for one field is how a --force that must drop the env keeps
    // handing it back.
    const greedy: EntryTransform = { carry: () => ({ env: { LEAK: "1" }, disabled: true }) };
    expect(carriedFieldsOf({ env: { LEAK: "1" } }, greedy)).toEqual({ disabled: true });
  });

  it("carries an entry's env, string values only, per key", () => {
    expect(carryableEnvOf({ env: { A: "1", B: 2, C: "3" } })).toEqual({ A: "1", C: "3" });
    expect(carryableEnvOf({ env: {} })).toBeUndefined();
    expect(carryableEnvOf({ env: "nope" })).toBeUndefined();
    expect(carryableEnvOf({})).toBeUndefined();
  });

  it("composes the written entry so nothing can clobber the launch", () => {
    const written = composeEntry({
      base: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
      transform: {
        ...CLINE,
        extraFields: ({ purpose }) => ({ startup_timeout_sec: purpose === "broker" ? 60 : 30 }),
      },
      os: "windows",
      purpose: "broker",
      env: { OAM_BIN: "/o/bin" },
      carried: { disabled: true, command: "evil" },
    });
    expect(written).toEqual({
      // carried first, extras next, the launch LAST: a stale carried field
      // cannot change what install is about to run.
      disabled: true,
      startup_timeout_sec: 60,
      command: "npx",
      args: ["-y", "@yawlabs/mcp@latest"],
      env: { OAM_BIN: "/o/bin" },
    });
  });

  it("fills env only when the composed entry has none of its own", () => {
    const upstream = composeEntry({
      base: { command: "npx", args: ["x"], env: { MINE: "1" } },
      os: "macos",
      purpose: "upstream",
      env: { CARRIED: "1" },
    });
    expect(upstream.env).toEqual({ MINE: "1" });
    const empty = composeEntry({ base: { command: "npx", args: [] }, os: "macos", purpose: "broker", env: {} });
    expect(empty.env).toBeUndefined();
  });

  it("drops both env and the carried fields when the caller passes neither, which is --force", () => {
    expect(
      composeEntry({ base: { command: "npx", args: [] }, transform: CLINE, os: "linux", purpose: "broker" }),
    ).toEqual({ command: "npx", args: [] });
  });

  it("reads a launch view without the transform, and a normalised one with it", () => {
    const nested = { transport: { type: "stdio", command: "npx", args: ["-y", "x"] } };
    expect(launchOf(nested)).toBeNull();
    const transform: EntryTransform = {
      normalize: (stored) => (stored as { transport: Record<string, unknown> }).transport,
    };
    expect(launchOf(normalizeEntry(nested, transform))).toEqual({ command: "npx", args: ["-y", "x"] });
    expect(normalizeEntry(nested, {})).toBe(nested);
  });

  it("filters a launch's args to strings and refuses a value with no command", () => {
    expect(launchOf({ command: "npx", args: ["a", 2, null, "b"] })).toEqual({ command: "npx", args: ["a", "b"] });
    expect(launchOf({ args: ["a"] })).toBeNull();
    expect(launchOf(7)).toBeNull();
    expect(launchOf([1])).toBeNull();
  });
});

describe("value helpers", () => {
  it("compares canonically: key order does not matter, an undefined value does not exist", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson({ n: { deep: [1, { z: 1, a: 2 }] } })).toBe('{"n":{"deep":[1,{"a":2,"z":1}]}}');
  });

  it("names a value's shape without echoing its contents", () => {
    expect(describeValueShape(null)).toBe("null");
    expect(describeValueShape([])).toBe("an empty array");
    expect(describeValueShape([1, 2, 3])).toBe("an array of 3");
    expect(describeValueShape("secret")).toBe("a string");
    expect(describeValueShape(3)).toBe("a number");
  });

  it("finds a legacy key the way install-targets does, precedence included", () => {
    expect(findLegacyKey(["a", "yaw-mcp", "mcp.hosting"])).toBe("mcp.hosting");
    expect(findLegacyKey(["mcp"])).toBeNull();
    for (const keys of [["mcp.hosting"], ["mcph"], ["yaw-mcp"], ["mcp", "yaw-mcp"], ["x"]]) {
      const container = Object.fromEntries(keys.map((k) => [k, {}]));
      expect(findLegacyKey(keys), keys.join(",")).toBe(findLegacyEntry(container));
    }
  });

  it("reports a position as an editor would, on LF and CRLF alike", () => {
    expect(positionAt("abc", 1)).toEqual({ offset: 1, line: 1, column: 2 });
    expect(positionAt("ab\ncd", 3)).toEqual({ offset: 3, line: 2, column: 1 });
    expect(positionAt("ab\r\ncd", 4)).toEqual({ offset: 4, line: 2, column: 1 });
    expect(positionAt("abc", 99).offset).toBe(3);
  });

  it("terminates text for a write without ever doubling the newline", () => {
    expect(terminateWithNewline("{}")).toBe("{}\n");
    expect(terminateWithNewline("{}\n")).toBe("{}\n");
  });
});

describe("the view", () => {
  const RAW = '{"mcpServers":{"fs":{"command":"npx"},"mcp":{"command":"npx","env":{"A":"1"}}}}';

  it("answers every entry-level question without the consumer knowing the syntax", () => {
    const view = classifyClientConfig(RAW, site());
    expect(view.count()).toBe(2);
    expect(view.entry()?.key).toBe("mcp");
    expect(view.entry("fs")?.launch?.command).toBe("npx");
    expect(view.otherServerKeys()).toEqual(["fs"]);
    expect(view.legacyKey()).toBeNull();
    expect(view.carryableEnv()).toEqual({ A: "1" });
    expect(view.carried()).toEqual({});
    expect(view.unloadable()).toBeNull();
    expect(view.address).toEqual({ format: "jsonc", containerPath: ["mcpServers"] });
    expect(view.addressIndex).toBe(0);
  });

  it("answers with nothing at all for a read that is not ok", () => {
    for (const raw of ["[1]", '{"mcpServers":', null]) {
      const view = classifyClientConfig(raw, site());
      expect(view.entries()).toEqual([]);
      expect(view.count()).toBe(0);
      expect(view.entry()).toBeUndefined();
      expect(view.legacyKey()).toBeNull();
      expect(view.otherServerKeys()).toEqual([]);
    }
  });

  it("picks the wired container when the caller hands it several spellings", () => {
    // How the Claude Code drive-letter-case fold reaches the model: the caller
    // decides which paths are equivalent, the view says which one holds the
    // wiring.
    const raw = '{"projects":{"C:/repo":{"mcpServers":{}},"c:/repo":{"mcpServers":{"mcp":{"command":"npx"}}}}}';
    const nested = site({
      resolved: {
        absolute: "/home/u/.claude.json",
        display: "~",
        containerPath: ["projects", "C:/repo", "mcpServers"],
      },
    });
    const view = classifyClientConfig(raw, nested, {
      containerPaths: [
        ["projects", "C:/repo", "mcpServers"],
        ["projects", "c:/repo", "mcpServers"],
      ],
    });
    expect(view.addressIndex).toBe(1);
    expect(view.address.containerPath[1]).toBe("c:/repo");
    expect(view.entry()?.launch?.command).toBe("npx");
  });

  it("falls back to the canonical path when no variant holds anything", () => {
    const raw = '{"projects":{"C:/repo":{"mcpServers":{}}}}';
    const nested = site({
      resolved: {
        absolute: "/home/u/.claude.json",
        display: "~",
        containerPath: ["projects", "C:/repo", "mcpServers"],
      },
    });
    const view = classifyClientConfig(raw, nested, {
      containerPaths: [
        ["projects", "C:/repo", "mcpServers"],
        ["projects", "c:/repo", "mcpServers"],
      ],
    });
    expect(view.addressIndex).toBe(0);
    expect(view.read.kind === "ok" && view.read.containerPresent).toBe(true);
  });
});

describe("reading a file", () => {
  it("treats a missing file as absent rather than as an error", async () => {
    const view = await readClientConfigFile(site(), {
      readFile: () => Promise.reject(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })),
    });
    expect(view.read.kind).toBe("absent");
    expect(view.raw).toBeNull();
  });

  it("keeps an unreadable file apart from a malformed one, with its errno", async () => {
    const view = await readClientConfigFile(site(), {
      readFile: () => Promise.reject(Object.assign(new Error("EISDIR: illegal operation"), { code: "EISDIR" })),
    });
    expect(view.read).toEqual({ kind: "unreadable", code: "EISDIR", message: "EISDIR: illegal operation" });
    expect(view.count()).toBe(0);
  });

  it("classifies what it read", async () => {
    const view = await readClientConfigFile(site(), { readFile: () => Promise.resolve('{"mcpServers":{"mcp":{}}}') });
    expect(view.entry()?.key).toBe("mcp");
  });
});

describe("the write facade", () => {
  it("creates the file when there is none", () => {
    const view = classifyClientConfig(null, site());
    const out = applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], site());
    expect(classifyClientConfig(out, site()).entry()?.launch?.command).toBe("npx");
  });

  it("refuses an empty edit list", () => {
    expect(() => applyClientConfigEdits(classifyClientConfig("{}", site()), [])).toThrow(/no edits/);
  });

  it("refuses to remove from, or repair, a file that does not exist", () => {
    const view = classifyClientConfig(null, site());
    expect(() => applyClientConfigEdits(view, [{ op: "remove", key: "mcp" }], site())).toThrow(
      /does not exist, so there is nothing in it to remove/,
    );
    expect(() => applyClientConfigEdits(view, [{ op: "repair", path: ["mcpServers"] }], site())).toThrow(
      /nothing in it to repair/,
    );
  });

  it("returns the input string itself when a removal finds nothing", () => {
    const raw = '{"mcpServers":{"fs":{"command":"npx"}}}';
    const view = classifyClientConfig(raw, site());
    // Identity, not equality: try's cleanup and doctor's GC both detect a
    // no-op that way, and a phantom write would strip a Notepad BOM.
    expect(applyClientConfigEdits(view, [{ op: "remove", key: "mcp" }], site())).toBe(raw);
  });

  it("turns a splicer refusal into the facade's own error type", () => {
    const view = classifyClientConfig('{"mcpServers":{}}', site());
    // An empty key is one the splicer refuses outright.
    expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: "", entry: ENTRY }], site())).toThrow(
      /could not be edited/,
    );
  });
});

describe("every existing client and scope expresses itself through this model", () => {
  it("resolves to a site the adapter can classify, for each OS the client supports", () => {
    let checked = 0;
    for (const target of INSTALL_TARGETS) {
      for (const os of target.availableOn) {
        for (const spec of target.scopes) {
          const resolved = resolveInstallPath({
            clientId: target.clientId,
            scope: spec.scope,
            os,
            home: "/home/u",
            appData: "C:/Users/u/AppData/Roaming",
            projectDir: spec.requiresProjectDir ? "/home/u/proj" : undefined,
          });
          const where: ConfigSite = {
            id: "default",
            label: target.label,
            format: effectiveConfigFormat({ format: "jsonc", root: resolved.containerPath.at(-1) as string }),
            resolved,
            detectDir: null,
          };
          // The container key every consumer used to hard-code is the last
          // segment of the resolved path -- "servers" for VS Code, "mcpServers"
          // for everyone else -- and the adapter reads it from the address.
          expect(resolved.containerPath.at(-1), `${target.clientId}/${spec.scope}`).toBe(
            target.clientId === "vscode" ? "servers" : "mcpServers",
          );
          const view = classifyClientConfig(null, where);
          expect(view.read.kind, `${target.clientId}/${spec.scope}/${os}`).toBe("absent");
          const written = applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], where);
          const back: ClientConfigView = classifyClientConfig(written, where);
          expect(back.entry()?.launch?.command, `${target.clientId}/${spec.scope}/${os}`).toBe("npx");
          checked++;
        }
      }
    }
    // A floor, so a filter that silently matched nothing cannot pass this.
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  it("has no site for a scope a client does not support, which is how availability is expressed", () => {
    // Claude Desktop has no project scope and is not configurable on Linux.
    // Both are absences in the table, so neither produces a site -- the model
    // never has to carry an "unavailable" site kind.
    const desktop = INSTALL_TARGETS.find((t) => t.clientId === "claude-desktop");
    expect(desktop?.scopes.map((s) => s.scope)).toEqual(["user"]);
    expect(desktop?.availableOn).not.toContain("linux");
    expect(desktop?.notConfigurableOn?.linux).toBeTruthy();
  });

  it("narrows the Claude Code PROJECT scope to strict JSON, and only that scope", () => {
    // The one existing client whose scopes disagree about strictness: it
    // writes ~/.claude.json itself (user and local) and reads a project's
    // .mcp.json with JSON.parse. One flag on the scope spec, not a second
    // client row.
    const shape = { format: "jsonc" as const, root: "mcpServers" };
    const byScope = {
      user: effectiveConfigFormat(shape, {}),
      project: effectiveConfigFormat(shape, { strictJson: true }),
      local: effectiveConfigFormat(shape, {}),
    };
    expect(byScope).toEqual({ user: "jsonc", project: "json", local: "jsonc" });
    // And a project file carrying a comment is then readable but unwritable,
    // which is the whole behavioural difference between the two spellings.
    const project = site({ format: byScope.project, label: "Claude Code" });
    const commented = '{\n  // mine\n  "mcpServers": {"fs": {"command": "npx"}}\n}\n';
    expect(classifyClientConfig(commented, project).unloadable()).not.toBeNull();
    expect(classifyClientConfig(commented, site({ format: byScope.user })).unloadable()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Contract fit: every client the product will have, expressed through these
// types. A target package reads its case here to know what it has to produce.
// ---------------------------------------------------------------------------

/** A stand-in adapter for a format this build does not ship, reached ONLY
 *  through the public registry -- registering it edits no file in src/, which
 *  is the claim it exists to pin.
 *
 *  Its syntax is a toy: a `[container.path]` header line, then one
 *  `key = <json>` line per entry, then anything else. A value of `INLINE`
 *  stands for a spelling a header-based splicer cannot extend. What this
 *  proves is that the facade drives an UNFAMILIAR syntax through the same
 *  contract end to end -- not that anything here parses TOML. */
const BLOCK_HEADER = (addr: { containerPath: readonly string[] }): string => `[${addr.containerPath.join(".")}]`;

function blockSection(
  raw: string,
  addr: { containerPath: readonly string[] },
): { lines: string[]; start: number; end: number } | null {
  const lines = raw.split("\n");
  const start = lines.indexOf(BLOCK_HEADER(addr));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && lines[end].includes(" = ")) end++;
  return { lines, start, end };
}

function classifyBlock(raw: string, addr: EntryAddress, transform?: EntryTransform): ConfigRead {
  if (raw.trim().length === 0) return { kind: "absent" };
  const found = blockSection(raw, addr);
  if (found === null) return { kind: "ok", containerPresent: false, entries: [], unloadable: null };
  const entries: EntryView[] = [];
  for (let i = found.start + 1; i < found.end; i++) {
    const line = found.lines[i];
    const eq = line.indexOf(" = ");
    const key = line.slice(0, eq);
    const text = line.slice(eq + 3);
    if (text === "INLINE") {
      return { kind: "unspliceable", key, reason: "defined inline, which a later header cannot extend" };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (err) {
      return {
        kind: "malformed",
        syntax: "TOML",
        reason: "syntax",
        detail: err instanceof Error ? err.message : String(err),
        position: positionAt(raw, found.lines.slice(0, i).join("\n").length + 1),
      };
    }
    entries.push({ key, value, launch: launchOf(normalizeEntry(value, transform)) });
  }
  return { kind: "ok", containerPresent: true, entries, unloadable: null };
}

const BLOCK_ADAPTER: ConfigAdapter = {
  syntax: "TOML",
  classify: classifyBlock,
  upsert(raw, addr, key, entry) {
    const rendered = `${key} = ${JSON.stringify(entry)}`;
    if (raw === null || raw.trim().length === 0) return `${BLOCK_HEADER(addr)}\n${rendered}\n`;
    const found = blockSection(raw, addr);
    if (found === null) return `${raw.endsWith("\n") ? raw : `${raw}\n`}${BLOCK_HEADER(addr)}\n${rendered}\n`;
    const at = found.lines.findIndex((l, i) => i > found.start && i < found.end && l.startsWith(`${key} = `));
    const next = [...found.lines];
    // A new key is APPENDED after the section's last member; an existing one
    // is replaced where it stands.
    if (at === -1) next.splice(found.end, 0, rendered);
    else next[at] = rendered;
    return next.join("\n");
  },
  remove(raw, addr, key) {
    const found = blockSection(raw, addr);
    if (found === null) return raw;
    const at = found.lines.findIndex((l, i) => i > found.start && i < found.end && l.startsWith(`${key} = `));
    if (at === -1) return raw;
    const next = [...found.lines];
    next.splice(at, 1);
    return next.join("\n");
  },
  repairContainer() {
    // A header-based syntax has no "wrong-shaped container key" to replace:
    // every blocked shape it can report is non-reparable, so the facade never
    // reaches this.
    throw new Error("a block-syntax container cannot be repaired in place");
  },
  renderPreview(addr, key, entry) {
    return `${BLOCK_HEADER(addr)}\n${key} = ${JSON.stringify(entry)}`;
  },
  describeLocation(absolute, addr) {
    return `${absolute} ${BLOCK_HEADER(addr)}`;
  },
  canon(raw, addr, opts) {
    const read = classifyBlock(raw, addr);
    if (read.kind !== "ok") throw new Error(`block canon needs a readable document, got ${read.kind}`);
    const container: Record<string, unknown> = {};
    if (opts?.dropContainer !== true) {
      for (const e of read.entries) {
        if (!(opts?.drop ?? []).includes(e.key)) container[e.key] = e.value;
      }
    }
    // Everything outside the section, by VALUE rather than by line, so blank
    // space is not drift -- and another section's header counts, which is what
    // makes a splice that ate one visible.
    const found = blockSection(raw, addr);
    const rest: Record<string, unknown> = {};
    raw.split("\n").forEach((line, i) => {
      if (found !== null && i >= found.start && i < found.end) return;
      const eq = line.indexOf(" = ");
      if (eq !== -1) rest[line.slice(0, eq)] = JSON.parse(line.slice(eq + 3));
      else if (line.trim().length > 0) rest[line] = true;
    });
    return canonicalJson({ container, rest });
  },
};

describe("contract fit: the five new clients", () => {
  afterEach(resetConfigAdapterRegistry);

  it("zed: a different root key, its own carried fields, and a live reload", () => {
    const zed = site({
      id: "default",
      label: "Zed",
      format: "jsonc",
      resolved: {
        absolute: "/home/u/.config/zed/settings.json",
        display: "~/.config/zed/settings.json",
        containerPath: ["context_servers"],
      },
    });
    // The root key is the address's business, so nothing but the table changes.
    const raw = '{\n  // my agent settings\n  "context_servers": {\n    "other": {"command": "node"}\n  }\n}\n';
    const view = classifyClientConfig(raw, zed);
    expect(view.otherServerKeys()).toEqual(["other"]);
    const out = applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], zed);
    expect(out).toContain("// my agent settings");
    expect(classifyClientConfig(out, zed).entry()?.launch?.command).toBe("npx");
    // Zed owns `enabled`, `remote` and `timeout` on our entry; `source` is a
    // field it no longer recognises, so it is drift to be shown, never carried.
    const zedCarry: EntryTransform = {
      carry: (stored) => {
        const kept: Record<string, unknown> = {};
        if (typeof stored.enabled === "boolean") kept.enabled = stored.enabled;
        if (typeof stored.remote === "boolean") kept.remote = stored.remote;
        if (typeof stored.timeout === "number" && Number.isInteger(stored.timeout) && stored.timeout >= 0) {
          kept.timeout = stored.timeout;
        }
        return kept;
      },
    };
    expect(carriedFieldsOf({ command: "npx", enabled: false, timeout: 30, source: "custom" }, zedCarry)).toEqual({
      enabled: false,
      timeout: 30,
    });
    expect(reloadDoneClause("live", "Zed")).toContain("no restart needed");
  });

  it("cline: ONE target, several files, strict JSON, and a nested transport form", () => {
    // The shared file is written unconditionally; a host copy only where that
    // editor's Cline storage already exists.
    const hosts = ["Code", "Cursor", "Windsurf"];
    const sites: ConfigSite[] = [
      site({
        id: "shared",
        label: "Cline",
        format: "json",
        resolved: {
          absolute: "/home/u/.cline/data/settings/cline_mcp_settings.json",
          display: "~/.cline/...",
          containerPath: ["mcpServers"],
        },
      }),
      ...hosts.map((host) =>
        site({
          id: host.toLowerCase(),
          label: `Cline (${host})`,
          format: "json",
          detectDir: `/home/u/.config/${host}/User/globalStorage/saoudrizwan.claude-dev`,
          resolved: {
            absolute: `/home/u/.config/${host}/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`,
            display: `~/.config/${host}/...`,
            containerPath: ["mcpServers"],
          },
        }),
      ),
    ];
    const installed = selectSites(sites, (p) => p.includes("/Cursor/"));
    expect(installed.map((s) => s.id)).toEqual(["shared", "cursor"]);
    expect(installed.map((s) => s.label)).toEqual(["Cline", "Cline (Cursor)"]);
    // Every site is its own file with its own bytes, and each is strict.
    for (const where of installed) {
      expect(where.format).toBe("json");
      const view = classifyClientConfig('{"mcpServers":{}}', where);
      expect(
        classifyClientConfig(
          applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], where),
          where,
        ).entry(),
      ).toBeDefined();
    }
    // `cline mcp install` rewrites our entry into its nested transport shape;
    // normalize is what keeps that reading as ours rather than as a foreigner.
    const clineTransform: EntryTransform = {
      normalize: (stored) => {
        if (typeof stored !== "object" || stored === null) return stored;
        const nested = (stored as { transport?: unknown }).transport;
        return typeof nested === "object" && nested !== null
          ? { ...(stored as object), ...(nested as object) }
          : stored;
      },
      carry: (stored) => (typeof stored.disabled === "boolean" ? { disabled: stored.disabled } : {}),
    };
    const nested =
      '{"mcpServers":{"mcp":{"disabled":true,"transport":{"type":"stdio","command":"npx","args":["-y","@yawlabs/mcp@latest"]}}}}';
    const clineSite = site({ format: "json" });
    const view = classifyClientConfig(nested, clineSite, { transform: clineTransform });
    expect(view.entry()?.launch).toEqual({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
    expect(view.carried()).toEqual({ disabled: true });
    // The view normalises once, for the read AND for the drift comparison.
    expect((view.normalized() as Record<string, unknown>).command).toBe("npx");
  });

  it("continue: a file yaw-mcp owns, created from nothing, with a window reload", () => {
    const shape = { format: "jsonc" as const, root: "mcpServers", ownership: "dedicated" as const };
    const cont = site({
      id: "default",
      label: "Continue",
      format: effectiveConfigFormat(shape),
      resolved: {
        absolute: "/home/u/.continue/mcpServers/yaw-mcp.json",
        display: "~/.continue/mcpServers/yaw-mcp.json",
        containerPath: ["mcpServers"],
      },
    });
    expect(shape.ownership).toBe("dedicated");
    const fresh = applyClientConfigEdits(
      classifyClientConfig(null, cont),
      [{ op: "upsert", key: "mcp", entry: ENTRY }],
      cont,
    );
    expect(fresh).toBe(
      '{\n  "mcpServers": {\n    "mcp": {\n      "command": "npx",\n      "args": [\n        "-y",\n' +
        '        "@yawlabs/mcp@latest"\n      ]\n    }\n  }\n}\n',
    );
    // Uninstall empties the container and leaves the file, which loads as zero
    // servers. Ownership is carried for the WORDING; nothing here behaves
    // differently on it.
    const emptied = applyClientConfigEdits(classifyClientConfig(fresh, cont), [{ op: "remove", key: "mcp" }], cont);
    expect(classifyClientConfig(emptied, cont).count()).toBe(0);
    expect(reloadDoneClause("reload-window", "Continue")).toBe("Reload the IDE window to pick up the new MCP server.");
  });

  it("codex-cli: a format with no adapter in this build, added by a sibling module", () => {
    const codex = site({
      id: "default",
      label: "Codex CLI",
      format: "toml",
      resolved: {
        absolute: "/home/u/.codex/config.toml",
        display: "~/.codex/config.toml",
        containerPath: ["mcp_servers"],
      },
    });
    // Before registration the model refuses by NAME rather than failing to
    // parse somewhere deeper.
    expect(() => classifyClientConfig(null, codex)).toThrow(MissingConfigAdapterError);

    registerConfigAdapter("toml", BLOCK_ADAPTER);
    // Everything below runs through the same facade as the JSON clients, with
    // no branch on the format anywhere.
    const raw = 'model = "gpt-5"\n[mcp_servers]\nother = {"command":"node"}\n';
    const view = classifyClientConfig(raw, codex);
    expect(view.adapter.syntax).toBe("TOML");
    expect(view.otherServerKeys()).toEqual(["other"]);
    expect(view.adapter.describeLocation(codex.resolved.absolute, view.address)).toBe(
      "/home/u/.codex/config.toml [mcp_servers]",
    );
    // Codex requires a startup timeout it does not write itself, and
    // re-serialises 60 as 60.0 -- extraFields writes it, normalize makes the
    // round trip compare equal.
    const codexTransform: EntryTransform = {
      extraFields: () => ({ startup_timeout_sec: 60 }),
      normalize: (stored) => {
        if (typeof stored !== "object" || stored === null) return stored;
        const record = { ...(stored as Record<string, unknown>) };
        if (typeof record.startup_timeout_sec === "string")
          record.startup_timeout_sec = Number(record.startup_timeout_sec);
        return record;
      },
      carry: (stored) => (typeof stored.enabled === "boolean" ? { enabled: stored.enabled } : {}),
    };
    const entry = composeEntry({ base: ENTRY, transform: codexTransform, os: "macos", purpose: "broker" });
    expect(entry.startup_timeout_sec).toBe(60);
    const out = applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry }], codex);
    // Appended after the last member, and the root key beside it is untouched.
    expect(out).toContain('model = "gpt-5"');
    expect(out.trim().split("\n").at(-1)?.startsWith("mcp = ")).toBe(true);
    const back = classifyClientConfig(out, codex, { transform: codexTransform });
    expect(back.entries().map((e) => e.key)).toEqual(["other", "mcp"]);
    expect(back.entry()?.launch?.command).toBe("npx");
    // A spelling the splicer will not edit refuses instead of corrupting it.
    const inline = classifyClientConfig("[mcp_servers]\nmcp = INLINE\n", codex);
    expect(inline.read.kind).toBe("unspliceable");
    expect(() => applyClientConfigEdits(inline, [{ op: "remove", key: "mcp" }], codex)).toThrow(
      /is defined inline, which a later header cannot extend, so yaw-mcp will not edit it/,
    );
    // And a removal that finds nothing is the same identity no-op it is for
    // JSON, which is how try's cleanup detects "nothing to do".
    expect(applyClientConfigEdits(back, [{ op: "remove", key: "absent-key" }], codex)).toBe(out);
  });

  it("the mcp alias: a synonym for another target's scope, not a row of its own", () => {
    // `install mcp` and `install claude-code --scope project` must resolve to
    // ONE site -- same file, same address, same strictness. The alias is an
    // argv-level spelling (client-aliases.ts); the model never learns it, and
    // that absence is what keeps --list and doctor from showing the file twice.
    const project = resolveInstallPath({
      clientId: "claude-code",
      scope: "project",
      os: "linux",
      home: "/home/u",
      projectDir: "/home/u/proj",
    });
    const shape = { format: "jsonc" as const, root: "mcpServers" };
    const viaAlias: ConfigSite = {
      id: "default",
      label: "Claude Code",
      format: effectiveConfigFormat(shape, { strictJson: true }),
      resolved: project,
      detectDir: null,
    };
    const viaClient: ConfigSite = { ...viaAlias };
    expect(addressOf(viaAlias)).toEqual(addressOf(viaClient));
    expect(viaAlias.resolved.absolute).toBe(viaClient.resolved.absolute);
    expect(viaAlias.format).toBe("json");
    // Inheriting the scope means inheriting its strictness: a .mcp.json with a
    // comment refuses through both spellings, identically.
    const commented = '{\n  // shared with my team\n  "mcpServers": {}\n}\n';
    for (const where of [viaAlias, viaClient]) {
      const view = classifyClientConfig(commented, where);
      expect(view.unloadable()).not.toBeNull();
      expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], where)).toThrow(
        /refusing to write into it/,
      );
    }
  });

  it("hands `import` one canonical entry shape, whatever the client calls its fields", () => {
    // Without this the importer would learn every client's vocabulary; with
    // it, a target maps its own spellings and the importer reads one shape.
    const stored = { command: "npx", args: ["-y", "x"] };
    expect(importViewOf(stored)).toEqual({ entry: stored });
    // Default: the NORMALISED entry, so a nested transport form imports as a
    // launchable server rather than as an opaque object.
    const nested = { transport: { command: "npx", args: ["-y", "x"] } };
    const unwrap: EntryTransform = { normalize: (s) => (s as { transport: unknown }).transport };
    expect(importViewOf(nested, unwrap)).toEqual({ entry: { command: "npx", args: ["-y", "x"] } });
    // A hook replaces that outright -- here the three shapes the new clients
    // need: a renamed field, a disabled flag, an entry that cannot be imported
    // at all, and keys the destination cannot hold.
    const codexImport: EntryTransform = {
      forImport: (s) => ({
        entry: { url: s.url, headers: s.http_headers },
        disabled: s.enabled === false,
        discardedKeys: Object.keys(s).filter((k) => k === "bearer_token_env_var" || k === "env_vars"),
      }),
    };
    expect(
      importViewOf({ url: "https://x", http_headers: { A: "1" }, enabled: false, env_vars: ["A"] }, codexImport),
    ).toEqual({
      entry: { url: "https://x", headers: { A: "1" } },
      disabled: true,
      discardedKeys: ["env_vars"],
    });
    const zedImport: EntryTransform = {
      forImport: (s) =>
        s.remote === true ? { entry: {}, skipReason: "Zed resolves it through an extension" } : { entry: s },
    };
    expect(importViewOf({ remote: true }, zedImport).skipReason).toBe("Zed resolves it through an extension");
    // A normalise hook that returns a non-object leaves the stored value in
    // place: a transform written for one shape cannot empty a foreign entry.
    expect(importViewOf(stored, { normalize: () => 7 })).toEqual({ entry: stored });
  });

  it("compares a value no JSON number can hold, which a TOML parser will hand it", () => {
    // smol-toml returns a bigint for an integer outside the double-safe range,
    // and JSON.stringify THROWS on one. Rendering the digits keeps the
    // post-write check a refusal rather than a TypeError.
    const big = BigInt("9007199254740993");
    expect(canonicalJson({ n: big })).toBe('{"n":9007199254740993}');
    expect(canonicalJson([big])).toBe("[9007199254740993]");
    expect(canonicalJson(big)).not.toBe(canonicalJson(BigInt("9007199254740992")));
    expect(describeValueShape(big)).toBe("a bigint");
  });
});
