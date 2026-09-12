// The boundary around the client-config core, as a SOURCE-SHAPE scan.
//
// The core's guarantees -- post-write verification on every edit, one strict
// gate, one env reader, one container walk -- hold only for a consumer that
// goes THROUGH it. Nothing in the type system stops a new module from calling
// an adapter's `upsert` directly, parsing a client config with `parseJsonc`,
// or reading `process.env.CODEX_HOME` for itself, and each of those is the
// obvious thing to type. So each is a rule below, with the files allowed to
// match it named one at a time, and a WHOLE-SET compare: a shape appearing in
// a file this table has never heard of fails, which is precisely the "new
// module bypasses the core" case the scan exists for.
//
// HONESTY ABOUT WHAT THIS IS. Some rules are still allowed in a consumer
// because that consumer carries its own walk. Those entries say so in as many
// words, and each is a line to DELETE as its consumer adopts the core -- the
// table is a ratchet, not a claim that the migration is finished. Read the
// reasons, not this paragraph, for which consumers those are today: the
// "allow-listed but no longer matches" assertion below fails on a stale entry,
// so the table cannot describe a consumer that has already migrated. R10, the
// one that makes the verification unskippable, is tight: `client-config.ts`
// alone.
//
// It is TEXTUAL, so it is a net under the behavioural tests, not a proof. It
// cannot follow a container object handed in by a caller, nor an adapter
// reached through an alias. The `describe` at the bottom pins each regex
// against positive AND negative samples, so a rule that silently stopped
// matching fails here rather than going quietly green.

import { describe, expect, it } from "vitest";
import { CLIENT_ALIASES, clientChoices } from "../client-aliases.js";
import { CLIENT_ENV_VARS } from "../client-config.js";
import { INSTALL_TARGETS, type InstallClientId } from "../install-targets.js";
import { sourceFiles, sourceSubdirectories } from "./source-files.js";

/** `//` line comments and the body lines of block / JSDoc comments. Blanked
 *  rather than dropped so a reported line number still points into the file.
 *  Without this, the prose in this repo's doc comments -- which necessarily
 *  quotes the shapes being scanned for -- would fill the table with sentences. */
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;

function codeOf(text: string): string {
  return text
    .split("\n")
    .map((line) => (COMMENT_LINE.test(line) ? "" : line))
    .join("\n");
}

interface Rule {
  /** What the shape is, for the failure message. */
  what: string;
  pattern: RegExp;
  /** File -> why it is allowed to match. A reason is required, so an entry
   *  cannot be added without saying what it is. */
  allowed: Record<string, string>;
  /** Path PATTERNS allowed to match, for a family of files whose membership
   *  grows by design -- `src/target-*.ts`, one module per client row.
   *
   *  Naming those file by file made a landing target edit this table for a
   *  path its own row legitimately spells, which is a hunk the handoff to
   *  those packages does not mention and would not survive review as
   *  "expected". Each pattern carries a reason like a file does, and the scan
   *  below asserts at least one file matches it -- so a pattern that stopped
   *  matching anything cannot sit here reading as a live exemption. */
  allowedPaths?: { pattern: RegExp; why: string }[];
  /** Scan `src/tests` too. Default false: these are source-shape rules, and a
   *  fixture quoting a forbidden shape is not an offender. */
  includeTests?: boolean;
  /** Lines the pattern MUST match, and lines it must not. A scan that matched
   *  nothing would pass every whole-set compare below. */
  positive: string[];
  negative: string[];
}

const NOT_YET_MIGRATED = "still carries its own container walk; this line goes when that consumer adopts the core";

const RULES: Rule[] = [
  {
    what: "a container walk or a raw JSONC entry edit",
    pattern:
      /\b(?:readNested|walkContainer|mergeClientConfig|readEntryAt|findLegacyEntry|directClientEntries|findBlockedContainerSegment|removeJsoncEntry|editJsoncEntry)\s*\(/,
    allowed: {
      "src/client-config-json.ts": "the JSON-family adapter -- these ARE its implementation",
      "src/jsonc.ts": "the splicer the adapter delegates to; it declares editJsoncEntry/removeJsoncEntry",
      "src/install-targets.ts":
        "declares findBlockedContainerSegment and findLegacyEntry, which doctor and install both ask",
      "src/doctor-cmd.ts": NOT_YET_MIGRATED,
      "src/import-cmd.ts": NOT_YET_MIGRATED,
      "src/install-cmd.ts": NOT_YET_MIGRATED,
    },
    positive: [
      "const c = readNested(root, path);",
      "editJsoncEntry(raw, ['a'], 'mcp', e)",
      "  mergeClientConfig({}, p, e)",
    ],
    negative: ["// readNested( in a comment", "const readNestedThing = 1;", "view.entries()"],
  },
  {
    what: "a direct JSONC parse or path edit",
    pattern: /\b(?:parseJsonc|editJsoncPath)\s*\(/,
    allowed: {
      "src/client-config-json.ts": "the adapter's own parse, both flavours",
      "src/jsonc.ts": "declares both",
      "src/claude-code-settings.ts":
        "settings.json is a permissions file, not an MCP server list -- allow-listed by design",
      "src/config-loader.ts": "yaw-mcp's OWN config, not a client config",
      "src/grades-cache.ts": "yaw-mcp's own cache file",
      "src/local-add-cmd.ts": "bundles.json, yaw-mcp's own server list",
      "src/local-bundles.ts": "bundles.json",
      "src/local-set-cmd.ts": "bundles.json, edited through editJsoncPath by design",
      "src/doctor-cmd.ts": NOT_YET_MIGRATED,
      "src/import-cmd.ts": NOT_YET_MIGRATED,
    },
    positive: ["const v = parseJsonc(raw);", "editJsoncPath(src, ['servers', 3], v)"],
    negative: ["/* parseJsonc( */", "const parseJsoncish = 1;"],
  },
  {
    what: "an entry-key membership test the view already answers",
    pattern: /ENTRY_NAME\s+in\b|\[\s*ENTRY_NAME\s*\]|LEGACY_ENTRY_NAMES\.(?:some|find|includes)/,
    allowed: {
      "src/client-config.ts": "findLegacyKey and the view's default key -- the core's own answer",
      "src/install-targets.ts": "findLegacyEntry's body, over an object rather than a key list",
      "src/doctor-cmd.ts": NOT_YET_MIGRATED,
      "src/import-cmd.ts": NOT_YET_MIGRATED,
    },
    positive: ["if (ENTRY_NAME in container) {", "const e = c[ENTRY_NAME];", "LEGACY_ENTRY_NAMES.some((n) => n === k)"],
    negative: ["const ENTRY_NAMES = 1;", "view.entry()", "LEGACY_ENTRY_NAMES.join(', ')"],
  },
  {
    what: "a container path handled outside the core and the target rows",
    pattern: /\bcontainerPath\b/,
    allowed: {
      "src/client-config.ts": "the address the core hands the adapter",
      "src/client-config-json.ts": "the adapter walks it -- that is its job",
      "src/jsonc.ts": "editJsoncEntry/removeJsoncEntry take one as a parameter",
      "src/install-target-model.ts": "declares ResolvedPath.containerPath",
      "src/install-targets.ts": "resolves it per client; the six inline rows and claudeCodeContainerPaths",
      "src/doctor-cmd.ts": NOT_YET_MIGRATED,
      "src/import-cmd.ts": NOT_YET_MIGRATED,
      "src/install-cmd.ts": NOT_YET_MIGRATED,
      "src/try-cmd.ts":
        "a TRIAL MARKER records the container path it wrote at, on disk, in a versioned schema -- so try " +
        "reads that field back and hands it to `markerSite`, which is the only way a sweep can delete the " +
        "key the trial wrote and no other. Not a walk: every read and write goes through the core",
    },
    allowedPaths: [
      {
        pattern: /^src\/target-[^/]+\.ts$/,
        why: "a row spells its OWN container path -- which is what `what` above means by 'and the target rows'",
      },
    ],
    positive: ["const p = resolved.containerPath;", "containerPath: ['mcpServers']"],
    negative: ["const containerPaths2 = 1;", "// containerPath in prose"],
  },
  {
    what: "a launch entry built outside the resolver",
    pattern: /\bbuildLaunchEntry\s*\(/,
    allowed: {
      "src/install-targets.ts": "declares it",
      "src/install-cmd.ts": "the broker entry, with the row's windowsLaunch policy passed in",
      "src/try-cmd.ts": "the upstream trial entry",
    },
    positive: ["buildLaunchEntry({ os })"],
    negative: ["// buildLaunchEntry( in prose"],
  },
  {
    what: "a client-id branch or an unchecked cast to a client id",
    pattern: /clientId\s*===\s*["']|as\s+InstallClientId\b/,
    allowed: {
      "src/install-cmd.ts":
        "THREE Claude Code branches remain, each on a line this reason names so it can be deleted with the " +
        'branch: install\'s settings patch (the `opts.clientId === "claude-code"` guarding ' +
        "prepareClaudeCodeSettingsPatch), the project-scope approval clause in the Done block, and " +
        "uninstall's settings patch. All three move to hooks.permissionsPatch with the consumer migration",
      "src/import-cmd.ts":
        'one `target.clientId === "vscode"` branch, the input-variable expansion that ' +
        "hooks.importVariables is declared to replace -- it goes when import reads the hook instead",
    },
    positive: ['if (t.clientId === "vscode") {', "const c = x as InstallClientId;"],
    negative: ["if (t.clientId === id) {", "resolveClientArg('install', arg)"],
  },
  {
    what: "a client env var read outside the one reader",
    pattern:
      /env(?:\?\.|\.|\[")(?:CLAUDE_CONFIG_DIR|CODEX_HOME|CLINE_MCP_SETTINGS_PATH|CLINE_DATA_DIR|CLINE_DIR|CONTINUE_GLOBAL_DIR|XDG_CONFIG_HOME|APPDATA)\b/,
    allowed: {
      "src/install-target-model.ts": "resolveAppDataDir -- the one place %APPDATA% is chosen for a client path",
      "src/doctor-cmd.ts":
        "%APPDATA% for the PowerShell HISTORY file, which is not a client config at all. APPDATA stays in " +
        "the pattern rather than being dropped, because the client-PATH use of that variable is exactly " +
        "what has to stay in one place",
    },
    positive: ["process.env.CODEX_HOME", 'env["XDG_CONFIG_HOME"]', "opts.env?.CLINE_DIR"],
    negative: ["process.env.LOG_LEVEL", "env.HOME"],
  },
  {
    what: "a hand-kept client-id list",
    pattern: /claude-code\s*[|,]\s*claude-desktop/,
    // Every id list in src/ derives from `clientChoices()` or
    // `INSTALL_TARGETS`, so nothing outside THIS file may carry the pair. The
    // order literal below spells the ids one per array element and does not
    // match; the samples in this rule's own positive list do, which is why
    // this file is the single allowed entry.
    allowed: {
      "src/tests/client-config-boundary.test.ts":
        "this rule's own positive samples, plus the append-order literal -- the one place the id list is spelled out",
    },
    includeTests: true,
    positive: ["<claude-code|claude-desktop|cursor>", "one of: claude-code, claude-desktop"],
    negative: ['["claude-code", "claude-desktop"]', "clientChoices('install').join('|')"],
  },
  {
    what: "a client config file read outside the core",
    pattern: /(?:readFile|readFileSync|existsSync)\(\s*(?:[\w.]*resolved\.absolute|[\w.]*clientPath|read\.path)/,
    allowed: {
      "src/doctor-cmd.ts": NOT_YET_MIGRATED,
      "src/import-cmd.ts": NOT_YET_MIGRATED,
    },
    positive: ["await readFile(resolved.absolute, 'utf8')", "existsSync(site.resolved.absolute)"],
    negative: ["await readFile(path, 'utf8')", "atomicWriteFile(resolved.absolute, next)"],
  },
  {
    what: "an adapter's writer called directly, which skips the post-write verification",
    // At least TWO arguments, because that is what an adapter writer takes
    // (raw, addr, key[, entry]). Without the second argument the rule matched
    // every `map.remove(k)` in the codebase, and a rule that noisy gets
    // switched off rather than obeyed.
    pattern: /\.(?:upsert|remove|repairContainer)\([^),]+,/,
    // THE tight one. `applyClientConfigEdits` is the only exported route to
    // edited text, and it verifies before it returns (no reordered entries, no
    // changed neighbour, no strict file made unloadable). A consumer calling
    // `JSONC_ADAPTER.upsert(...)` itself would get text with none of that
    // checked, which is why this list has exactly one entry and no
    // "not yet migrated" escape.
    allowed: {
      "src/client-config.ts": "the write facade -- it calls the adapter and then verifies the result",
    },
    positive: ["adapter.upsert(raw, addr, key, entry)", "JSON_ADAPTER.remove(raw, addr, k)"],
    // A one-argument `.remove(` is not an adapter call: the adapter's takes
    // (raw, addr, key). Requiring at least two arguments is what keeps this
    // from matching every Map and Set in the codebase -- an over-broad rule
    // would be switched off rather than obeyed.
    negative: ["map.remove(k)", "set.remove(item)", "applyClientConfigEdits(view, edits, site)"],
  },
];

describe("the client-config boundary", () => {
  it("recognises every shape it exists to catch, and not the ones it must not", () => {
    // A scan that matched nothing would pass every whole-set compare below.
    for (const rule of RULES) {
      for (const line of rule.positive) {
        expect(rule.pattern.test(line), `${rule.what}: should match ${line}`).toBe(true);
      }
      for (const line of rule.negative) {
        expect(rule.pattern.test(codeOf(line)), `${rule.what}: should NOT match ${line}`).toBe(false);
      }
    }
  });

  it("has a stated reason for every file on every allowlist", () => {
    for (const rule of RULES) {
      for (const [file, why] of Object.entries(rule.allowed)) {
        expect(why.length, `${rule.what}: ${file} has no reason`).toBeGreaterThan(10);
      }
      for (const { pattern, why } of rule.allowedPaths ?? []) {
        expect(why.length, `${rule.what}: ${pattern.source} has no reason`).toBeGreaterThan(10);
      }
    }
  });

  for (const rule of RULES) {
    it(`confines ${rule.what} to the files that are allowed it`, () => {
      const offenders: string[] = [];
      const silent: string[] = [];
      const every = new RegExp(rule.pattern.source, "g");
      const matched = new Set<string>();
      /** Which path patterns actually covered a matching file, so a pattern
       *  that has stopped matching is reported like a silent file entry. */
      const coveredByPath = new Set<string>();
      for (const file of sourceFiles({ includeTests: rule.includeTests })) {
        const code = codeOf(file.text);
        every.lastIndex = 0;
        const hits = [...code.matchAll(every)];
        if (hits.length === 0) continue;
        matched.add(file.path);
        if (rule.allowed[file.path] !== undefined) continue;
        const byPath = (rule.allowedPaths ?? []).find((a) => a.pattern.test(file.path));
        if (byPath !== undefined) {
          coveredByPath.add(byPath.pattern.source);
          continue;
        }
        for (const hit of hits) {
          const line = code.slice(0, hit.index ?? 0).split("\n").length;
          offenders.push(`${file.path}:${line}  ${(file.text.split("\n")[line - 1] ?? "").trim().slice(0, 110)}`);
        }
      }
      // A file on the allowlist that no longer matches is a line to DELETE:
      // left in place it reads as a live exemption for a consumer that has
      // already adopted the core, which is exactly the stale-comment failure
      // this repo keeps hitting.
      for (const file of Object.keys(rule.allowed)) {
        if (!matched.has(file)) silent.push(file);
      }
      // A path pattern covering nothing is the same stale exemption as a file
      // entry covering nothing, and is reported the same way.
      for (const { pattern } of rule.allowedPaths ?? []) {
        if (!coveredByPath.has(pattern.source)) silent.push(`${pattern.source} (pattern)`);
      }
      expect(
        offenders,
        `${rule.what} -- these bypass the client-config core. Route them through it, or add the file to this ` +
          `rule's allowlist WITH a reason:\n  ${offenders.join("\n  ")}`,
      ).toEqual([]);
      expect(
        silent,
        `${rule.what} -- these files are allow-listed but no longer match. Delete their allowlist entries:\n  ${silent.join(
          "\n  ",
        )}`,
      ).toEqual([]);
    });
  }
});

describe("no import cycle between the target rows and the table", () => {
  it("keeps every target-*.ts on the LEAF model, never install-targets.ts", () => {
    // install-targets.ts's own evaluation builds INSTALL_TARGETS out of these
    // modules, so an import back is a cycle -- and a target that used a
    // RUNTIME binding from it at module scope would read undefined (TDZ).
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!/\/target-[^/]+\.ts$/.test(file.path)) continue;
      if (/from\s+["']\.\/install-targets\.js["']/.test(codeOf(file.text))) offenders.push(file.path);
    }
    expect(offenders, `these import the table they are part of:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("keeps the target-*.ts imports in install-targets.ts alone", () => {
    const importers = sourceFiles()
      .filter((f) => /from\s+["']\.\/target-/.test(codeOf(f.text)))
      .map((f) => f.path);
    expect(importers).toEqual(["src/install-targets.ts"]);
  });

  it("has at least one target row module, so the two rules above are not vacuous", () => {
    expect(sourceFiles().filter((f) => /\/target-[^/]+\.ts$/.test(f.path)).length).toBeGreaterThan(0);
  });
});

describe("the table's structure", () => {
  it("keeps src/ flat but for tests, which is what the recursive walk makes safe", () => {
    // Belt and braces with the walker: this says the tree is flat TODAY, and
    // the walker means a future subdirectory is scanned rather than invisible.
    expect(sourceSubdirectories()).toEqual(["tests"]);
  });

  it("keeps the historical client ids in their landed order, appended never inserted", () => {
    // ONE of the two id-list literals in the suite (the other is
    // CLIENT_ALIASES in client-aliases.test.ts). `try`'s auto-detect returns
    // the FIRST usable probe slot in this order, so inserting a row ahead of
    // an existing one silently changes which client an existing user's `try`
    // picks. A landing target APPENDS one id to this array and nothing else.
    expect(INSTALL_TARGETS.map((t) => t.clientId)).toEqual([
      "claude-code",
      "claude-desktop",
      "cursor",
      "vscode",
      "windsurf",
      "gemini-cli",
      "zed",
      "cline",
      "continue",
    ]);
  });

  it("derives InstallClientId from the rows without collapsing to string", () => {
    // If `defineTarget`'s `const` type parameter stopped preserving each row's
    // literal, the union would widen to `string` and every id check in the
    // codebase would silently accept anything. A type-level assertion is the
    // only thing that sees that.
    const _narrow: string extends InstallClientId ? never : true = true;
    expect(_narrow).toBe(true);
  });

  it("gives every non-inline row its own resolvePath", () => {
    // The six inline ids keep the `pathFor` switch; everything else resolves
    // its own path, and a row with neither would resolve to whatever the
    // switch's fallthrough does.
    const inline = ["claude-code", "claude-desktop", "cursor", "vscode", "windsurf", "gemini-cli"];
    for (const t of INSTALL_TARGETS) {
      if (inline.includes(t.clientId)) {
        expect(t.resolvePath, `${t.clientId} is inline and must not carry resolvePath`).toBeUndefined();
        continue;
      }
      expect(typeof t.resolvePath, `${t.clientId} has no resolvePath`).toBe("function");
    }
  });

  it("declares an adapter for every format a row uses", () => {
    // A row whose format has no adapter registered resolves, lists and probes
    // -- and then throws MissingConfigAdapterError on the first read. The
    // formats WP1 ships are the JSON family; "toml" is declared and has no
    // adapter, so no row may use it yet.
    for (const t of INSTALL_TARGETS) {
      expect(["json", "jsonc"], `${t.clientId} uses a format with no adapter in this build`).toContain(t.config.format);
    }
  });

  it("gives try the ids with no alias, and install the ids then the aliases", () => {
    const ids = INSTALL_TARGETS.map((t) => t.clientId as string);
    expect(clientChoices("try")).toEqual(ids);
    expect(clientChoices("install")).toEqual([...ids, ...CLIENT_ALIASES.map((a) => a.id)]);
    expect(clientChoices("uninstall")).toEqual(clientChoices("install"));
    expect(clientChoices("import")).toEqual(clientChoices("install"));
  });
});

describe("the Environment help block names every LIVE client env var", () => {
  /** Declared in CLIENT_ENV_VARS for a target that has not landed, so no
   *  shipped row reads it and a help line claiming install honours it would be
   *  FALSE. One entry, owned by the package that lands its target: WP2 (codex)
   *  deletes this line and adds the help text in the same commit. */
  const NOT_YET_LIVE: Record<string, string> = {
    CODEX_HOME: "no codex-cli row ships in this build; nothing reads it yet",
  };

  it("documents each one, since the existing scan cannot see a read off a parameter", () => {
    // index-dispatch.test.ts's env scan looks for `process.env.X` / `env["X"]`
    // literals, and `readClientEnv` reads its `env` PARAMETER -- so without
    // this positive check nothing would force a new variable's name into
    // --help at all.
    const help = sourceFiles().find((f) => f.path === "src/index.ts");
    expect(help, "src/index.ts not found").toBeDefined();
    const text = help?.text ?? "";
    const live = CLIENT_ENV_VARS.filter((name) => NOT_YET_LIVE[name] === undefined);
    // Not vacuous: a NOT_YET_LIVE list that swallowed everything would make
    // the check below trivially pass.
    expect(live.length).toBeGreaterThan(CLIENT_ENV_VARS.length / 2);
    const missing = live.filter((name) => !text.includes(name));
    expect(
      missing,
      `these client env vars are read but never documented in index.ts's Environment block:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the not-yet-live list honest: each name really is unread by every row", () => {
    // The escape hatch above is only defensible while nothing reads the
    // variable. Once a row does, the help text is owed to the user and this
    // assertion is what notices.
    const rowSources = sourceFiles().filter(
      (f) => /\/target-[^/]+\.ts$/.test(f.path) || f.path === "src/install-targets.ts",
    );
    for (const [name, why] of Object.entries(NOT_YET_LIVE)) {
      expect(why.length, `${name} has no reason`).toBeGreaterThan(10);
      // `readClientEnv` maps SCREAMING_SNAKE to camelCase, so a row reads it
      // as `env.codexHome`; check for both spellings.
      const camel = name.toLowerCase().replace(/_(.)/g, (_m, c: string) => c.toUpperCase());
      for (const f of rowSources) {
        expect(codeOf(f.text).includes(`env.${camel}`), `${f.path} reads ${name}; document it in --help`).toBe(false);
      }
    }
  });
});
