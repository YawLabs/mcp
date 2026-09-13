// The alias table, and the `mcp` row in particular.
//
// An alias is a SPELLING, not a target: `install mcp` has to land in exactly
// the place `install claude-code --scope project` lands, and `--list`, doctor
// and `try` have to be unable to tell that a second name exists. So most of
// what is asserted here is an EQUIVALENCE between two argv spellings rather
// than a property of one of them -- a claim that only the alias resolves
// "correctly" would pass just as well if the canonical spelling had moved.
//
// Hermetic: no file is read or written, every path is resolved from an
// explicit `home` / `projectDir`, and the two end-to-end installs use
// `mkdtempSync` directories torn down in `afterEach`. Absolute-path
// expectations are built with `join` from node:path, never a POSIX literal,
// because `join` is what the code under test uses and a literal would agree
// only on the platforms that are not this one.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aliasTableProblems,
  CLIENT_ALIASES,
  type ClientVerb,
  clientChoices,
  resolveClientArg,
} from "../client-aliases.js";
import { effectiveConfigFormat } from "../client-config.js";
import { renderScript } from "../completion-cmd.js";
import { parseImportArgs } from "../import-cmd.js";
import { INSTALL_USAGE, parseInstallArgs, parseUninstallArgs, runInstall, runUninstall } from "../install-cmd.js";
import { INSTALL_TARGETS, type InstallOS, resolveInstallPath } from "../install-targets.js";
import { parseTryArgs } from "../try-cmd.js";

/** The ONE literal list of alias ids in the suite. `clientChoices`, the
 *  completion word lists, the usage synopsis and the "Choose: ..." line all
 *  DERIVE from `CLIENT_ALIASES`, so without a literal somewhere every one of
 *  those assertions is satisfied by an empty table. This is the same
 *  arrangement client-config-boundary.test.ts uses for the canonical client
 *  ids, and its comment there names this file as the other half. */
const ALIAS_IDS = ["mcp"];

/** The verbs that take a `<client>` positional. `try` is in the list on
 *  purpose: the point of including it is that it must NOT accept an alias. */
const CLIENT_VERBS: ClientVerb[] = ["install", "uninstall", "import", "try"];

describe("the alias table", () => {
  it("holds exactly the ids this file names", () => {
    expect(CLIENT_ALIASES.map((a) => a.id)).toEqual(ALIAS_IDS);
  });

  it("is well formed, which is the check nothing else in src/ calls", () => {
    // `aliasTableProblems` is exported for exactly this and has no runtime
    // consumer, so an empty table made it vacuous and a filled one makes it
    // real: a `mcp` that collided with a client id, was declared twice, or
    // pointed at a row that does not exist would come back here.
    expect(aliasTableProblems()).toEqual([]);
  });

  it("gives every alias a non-empty ASCII label", () => {
    // Alias labels are help/completion text. ASCII only, for the reason the
    // claude-desktop row's own `notes` comment gives: this is a Windows
    // client, and a console whose active codepage is not UTF-8 renders a
    // non-ASCII byte as mojibake. The same scan catches a control byte
    // smuggled in by an escape that collapsed on the way to disk.
    for (const alias of CLIENT_ALIASES) {
      expect(alias.label.length, `${alias.id} has an empty label`).toBeGreaterThan(0);
      expect(alias.label, `${alias.id} label is not printable ASCII`).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("pins `mcp` to Claude Code's project scope", () => {
    const mcp = CLIENT_ALIASES.find((a) => a.id === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp?.clientId).toBe("claude-code");
    // The pin is load-bearing rather than decorative: claude-code has a `user`
    // scope, and `resolveInstallSite` defaults to `user` when one exists, so
    // an alias with no scope would resolve `install mcp` to ~/.claude.json.
    expect(mcp?.scope).toBe("project");
    const claudeCode = INSTALL_TARGETS.find((t) => t.clientId === "claude-code");
    expect(claudeCode?.scopes.map((s) => s.scope)).toContain("user");
    expect(claudeCode?.scopes.map((s) => s.scope)).toContain("project");
  });
});

describe("which verbs accept the alias", () => {
  it("resolves `mcp` for install, uninstall and import, and not for try", () => {
    for (const verb of CLIENT_VERBS) {
      const resolved = resolveClientArg(verb, "mcp");
      if (verb === "try") {
        // `try` writes a one-off trial entry and picks its client by PROBING
        // the slots it knows. A second name for a slot it already probes
        // would let one file be trialled twice.
        expect(resolved, "try must not take an alias").toBeNull();
        continue;
      }
      expect(resolved, `${verb} should accept mcp`).not.toBeNull();
      expect(resolved?.clientId).toBe("claude-code");
      expect(resolved?.scope).toBe("project");
      expect(resolved?.via).toBe("mcp");
    }
  });

  it("leaves EVERY canonical id resolving to itself, with no pinned scope", () => {
    // The alias must not change what the real ids do. `via: null` is how a
    // caller tells "the user typed claude-code" from "the user typed mcp",
    // and an undefined `scope` is what leaves the caller's own default alone.
    //
    // Every row rather than just claude-code, because this is the observable
    // half of `resolveClientArg`'s canonical-ids-win ordering: the ordering
    // itself cannot be mutated into a failure while the two id sets are
    // disjoint (`aliasTableProblems` is what keeps them so, and is asserted
    // above), but an alias that DID shadow a real client would surface here
    // as a `via` naming the alias instead of null.
    for (const verb of CLIENT_VERBS) {
      for (const target of INSTALL_TARGETS) {
        const direct = resolveClientArg(verb, target.clientId);
        expect(direct, `${verb} ${target.clientId}`).toEqual({ clientId: target.clientId, via: null });
        expect(direct?.scope, `${verb} ${target.clientId} must pin no scope`).toBeUndefined();
      }
    }
  });

  it("still rejects a name that is neither a client nor an alias", () => {
    for (const verb of CLIENT_VERBS) expect(resolveClientArg(verb, "emacs")).toBeNull();
  });

  it("offers the alias last, after every real client", () => {
    const ids = INSTALL_TARGETS.map((t) => t.clientId as string);
    expect(clientChoices("install")).toEqual([...ids, ...ALIAS_IDS]);
    expect(clientChoices("uninstall")).toEqual(clientChoices("install"));
    expect(clientChoices("import")).toEqual(clientChoices("install"));
    expect(clientChoices("try")).toEqual(ids);
    // The ordering claim is only meaningful if the two halves differ.
    expect(clientChoices("install")).not.toEqual(clientChoices("try"));
  });
});

describe("the parsers map `mcp` onto the canonical client and scope", () => {
  it("parses `install mcp` as claude-code at project scope", () => {
    const r = parseInstallArgs(["mcp"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.clientId).toBe("claude-code");
    expect(r.options.scope).toBe("project");
  });

  it("parses `uninstall mcp` and `import mcp` the same way", () => {
    // An alias you can install with but not uninstall with is the worst shape
    // this could have, so both halves are pinned rather than assumed.
    const un = parseUninstallArgs(["mcp", "-y"]);
    expect(un.ok).toBe(true);
    if (un.ok) {
      expect(un.options.clientId).toBe("claude-code");
      expect(un.options.scope).toBe("project");
    }
    const imp = parseImportArgs(["mcp"]);
    expect(imp.ok).toBe(true);
    if (imp.ok) {
      expect(imp.options.clientId).toBe("claude-code");
      expect(imp.options.scope).toBe("project");
    }
  });

  it("keeps `try --client mcp` refused, naming only the real clients", () => {
    const r = parseTryArgs(["some-slug", "--client", "mcp"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(clientChoices("try").join("|"));
    expect(r.error).not.toContain("|mcp");
  });

  it("names the alias in the unknown-client list, through the derived choices", () => {
    const r = parseInstallArgs(["emacs"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(`Unknown client: emacs. Choose: ${clientChoices("install").join(", ")}`);
    expect(r.error).toContain("mcp");
  });

  it("keeps `install --all mcp` refused as a client argument to --all", () => {
    const r = parseInstallArgs(["--all", "mcp"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--all does not take a client argument.");
  });
});

describe("the usage synopsis and completion carry the alias without a new literal", () => {
  it("builds the install synopsis from clientChoices, so `mcp` rides in on the table", () => {
    // Asserted as the DERIVED join rather than as a spelled-out synopsis: a
    // literal here would keep passing if the parser stopped accepting the
    // name the synopsis advertises, which is the exact promise it makes.
    expect(INSTALL_USAGE).toContain(`Usage: yaw-mcp install <${clientChoices("install").join("|")}>`);
    expect(INSTALL_USAGE).toContain("mcp");
  });

  it("offers `mcp` at the install, uninstall and import positionals in every shell", () => {
    for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
      const script = renderScript(shell);
      expect(script, `${shell} script does not offer mcp`).toContain("mcp");
      for (const id of clientChoices("install")) {
        expect(script, `${shell} script dropped ${id}`).toContain(id);
      }
    }
  });
});

describe("`mcp` and `claude-code --scope project` are one file", () => {
  const OSES: InstallOS[] = ["macos", "linux", "windows"];

  it("resolves the same absolute path, display path and container on every OS", () => {
    for (const os of OSES) {
      const home = os === "windows" ? "C:\\synth\\home" : "/synth/home";
      const projectDir = join(home, "proj");
      const viaAlias = resolveInstallPath({
        clientId: resolveClientArg("install", "mcp")?.clientId ?? "claude-code",
        scope: resolveClientArg("install", "mcp")?.scope ?? "project",
        os,
        home,
        projectDir,
      });
      const viaClient = resolveInstallPath({ clientId: "claude-code", scope: "project", os, home, projectDir });
      expect(viaAlias, `${os}: the two spellings resolve different sites`).toEqual(viaClient);
      // And the site is the project-root .mcp.json the vendor documents, not
      // something under .claude/ -- "Lives at the project root, not inside
      // .claude/" (code.claude.com/docs/en/claude-directory).
      expect(viaAlias.absolute).toBe(join(projectDir, ".mcp.json"));
      expect(viaAlias.containerPath).toEqual(["mcpServers"]);
    }
  });

  it("inherits the scope's strictness rather than declaring its own", () => {
    // The alias carries no format, no strictness and no notes -- it carries a
    // (clientId, scope) pair, and `effectiveConfigFormat` is then handed the
    // SAME scope spec object either way. So whatever `strictJson` that scope
    // declares applies to both spellings by construction, and a future commit
    // that sets the flag on the row needs no change here.
    const target = INSTALL_TARGETS.find((t) => t.clientId === "claude-code");
    expect(target).toBeDefined();
    if (!target) return;
    const pinned = CLIENT_ALIASES.find((a) => a.id === "mcp")?.scope;
    const viaAlias = target.scopes.find((s) => s.scope === pinned);
    const viaClient = target.scopes.find((s) => s.scope === "project");
    expect(viaAlias).toBe(viaClient);
    expect(effectiveConfigFormat(target.config, viaAlias)).toBe(effectiveConfigFormat(target.config, viaClient));
  });

  it("adds no row to --list, no slot to doctor and no target to the table", () => {
    // The reason the alias is not a seventh InstallTarget: a row would resolve
    // to the byte-identical absolute path, so every surface that walks
    // INSTALL_TARGETS x scopes would print that one file twice, once under
    // each name, and doctor would fold one broken file into two warnings.
    expect(INSTALL_TARGETS.map((t) => t.clientId)).not.toContain("mcp");
    for (const os of OSES) {
      const home = os === "windows" ? "C:\\synth\\home" : "/synth/home";
      const projectDir = join(home, "proj");
      const mcpJsonSites: string[] = [];
      for (const target of INSTALL_TARGETS) {
        if (!target.availableOn.includes(os)) continue;
        for (const scope of target.scopes) {
          const resolved = resolveInstallPath({
            clientId: target.clientId,
            scope: scope.scope,
            os,
            home,
            projectDir: scope.requiresProjectDir ? projectDir : undefined,
          });
          if (resolved.absolute === join(projectDir, ".mcp.json")) {
            mcpJsonSites.push(`${target.clientId}/${scope.scope}`);
          }
        }
      }
      expect(mcpJsonSites, `${os}: more than one row resolves the project-root .mcp.json`).toEqual([
        "claude-code/project",
      ]);
    }
  });
});

// --- end-to-end: the two spellings must produce the same bytes -------------

let projAlias: string;
let projClient: string;
let synthHome: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-alias-home-"));
  projAlias = mkdtempSync(join(tmpdir(), "yaw-mcp-alias-a-"));
  projClient = mkdtempSync(join(tmpdir(), "yaw-mcp-alias-c-"));
});

afterEach(() => {
  for (const d of [synthHome, projAlias, projClient]) rmSync(d, { recursive: true, force: true });
});

function captureIo() {
  const out: string[] = [];
  const sink = (arr: string[]): NodeJS.WritableStream =>
    new Writable({
      write(chunk: Buffer, _enc, cb): void {
        arr.push(chunk.toString());
        cb();
      },
    }) as unknown as NodeJS.WritableStream;
  const err: string[] = [];
  return {
    io: { stdin: process.stdin, stdout: sink(out), stderr: sink(err), isTTY: false },
    stdout: (): string => out.join(""),
    stderr: (): string => err.join(""),
  };
}

/** Replace EVERY occurrence of the twin project dir with a placeholder, so the
 *  two runs' output can be compared verbatim. split/join rather than
 *  `String.replace`, which takes only the first match with a string pattern --
 *  install names the directory several times per run (the `File:` line, one
 *  `Wrote ...` line per file), so a first-match replace left the later
 *  mentions differing and made the comparison fail on the scrub, not on the
 *  behaviour. `replaceAll` would do, but split/join needs no lib setting. */
function scrub(text: string, dir: string): string {
  return text.split(dir).join("<P>");
}

/** Read a file as raw text, or null when it was never created. */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

describe("installing through either spelling writes the same bytes", () => {
  it("writes the same .mcp.json and the same Claude Code grant", async () => {
    // THE invariant. Two twin project directories, the same options but for
    // the argv that produced them, compared on bytes rather than on "it
    // looks installed": a divergence in the launch entry, the indent, the
    // trailing newline or the permissions patch fails here.
    const parsedAlias = parseInstallArgs(["mcp", "--project-dir", projAlias]);
    const parsedClient = parseInstallArgs(["claude-code", "--scope", "project", "--project-dir", projClient]);
    expect(parsedAlias.ok && parsedClient.ok).toBe(true);
    if (!parsedAlias.ok || !parsedClient.ok) return;

    const a = captureIo();
    const c = captureIo();
    const ra = await runInstall({ ...parsedAlias.options, home: synthHome, os: "macos", io: a.io });
    const rc = await runInstall({ ...parsedClient.options, home: synthHome, os: "macos", io: c.io });

    expect(ra.exitCode).toBe(0);
    expect(rc.exitCode).toBe(ra.exitCode);

    const bytesA = readOrNull(join(projAlias, ".mcp.json"));
    const bytesC = readOrNull(join(projClient, ".mcp.json"));
    expect(bytesA).not.toBeNull();
    expect(bytesA).toBe(bytesC);
    // Pinned literally too, so the equality above cannot be satisfied by two
    // identically-wrong files. Built with String.fromCharCode for the newline
    // rather than spelled as an escape, because an escape written through a
    // shell heredoc collapses into a real control byte in the source.
    const LF = String.fromCharCode(10);
    expect(bytesA).toBe(
      [
        "{",
        '  "mcpServers": {',
        '    "mcp": {',
        '      "command": "npx",',
        '      "args": [',
        '        "-y",',
        '        "@yawlabs/mcp@latest"',
        "      ]",
        "    }",
        "  }",
        "}",
        "",
      ].join(LF),
    );

    // The Claude-Code-only side effect rides along, because it is keyed on the
    // resolved row's `hooks.permissionsPatch` and not on the spelling.
    const grantA = readOrNull(join(projAlias, ".claude", "settings.json"));
    const grantC = readOrNull(join(projClient, ".claude", "settings.json"));
    expect(grantA).not.toBeNull();
    expect(grantA).toBe(grantC);
    expect(JSON.parse(grantA ?? "{}")).toEqual({ permissions: { allow: ["mcp__mcp__*"] } });

    // ... and so does the approve-on-restart Done line, which is the one
    // piece of install's output that exists only for this scope.
    const sayA = scrub(a.stdout(), projAlias);
    const sayC = scrub(c.stdout(), projClient);
    expect(sayA).toContain("approve the .mcp.json server when prompted");
    expect(sayA).toBe(sayC);
  });

  it("uninstalls through either spelling back to the same bytes", async () => {
    const install = (dir: string): string[] => ["claude-code", "--scope", "project", "--project-dir", dir];
    for (const dir of [projAlias, projClient]) {
      const p = parseInstallArgs(install(dir));
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      await runInstall({ ...p.options, home: synthHome, os: "macos", io: captureIo().io });
    }

    const ua = parseUninstallArgs(["mcp", "-y", "--project-dir", projAlias]);
    const uc = parseUninstallArgs(["claude-code", "--scope", "project", "-y", "--project-dir", projClient]);
    expect(ua.ok && uc.ok).toBe(true);
    if (!ua.ok || !uc.ok) return;

    const a = captureIo();
    const c = captureIo();
    const ra = await runUninstall({ ...ua.options, home: synthHome, os: "macos", io: a.io });
    const rc = await runUninstall({ ...uc.options, home: synthHome, os: "macos", io: c.io });

    expect(ra.exitCode).toBe(0);
    expect(rc.exitCode).toBe(ra.exitCode);
    expect(readOrNull(join(projAlias, ".mcp.json"))).toBe(readOrNull(join(projClient, ".mcp.json")));
    expect(readOrNull(join(projAlias, ".claude", "settings.json"))).toBe(
      readOrNull(join(projClient, ".claude", "settings.json")),
    );
    // The entry is gone from both; the file is left behind rather than deleted.
    expect(readOrNull(join(projAlias, ".mcp.json"))).not.toContain('"mcp":');
    expect(scrub(a.stdout(), projAlias)).toBe(scrub(c.stdout(), projClient));
  });

  it("refuses a JSONC .mcp.json identically through both spellings", async () => {
    // Claude Code 2.1.268 was measured reading a `.mcp.json` carrying one `//`
    // comment as unparseable and loading NO server from the file
    // ("No MCP servers configured", then "[Failed to parse] Project config
    // (shared via .mcp.json)"), so splicing our entry into one produces a
    // Done line for an entry that will never load.
    //
    // Whether install refuses is the claude-code project SCOPE's call, through
    // `strictJson` on its InstallScopeSpec -- this test asserts only that both
    // spellings get the SAME answer, which is the alias's whole contract. It
    // stays honest whichever way that flag is set: today the scope declares no
    // strictness and both spellings write, and the day the row sets the flag
    // both spellings refuse. What it forbids is the two diverging.
    const LF = String.fromCharCode(10);
    const SLASH = String.fromCharCode(47);
    const jsonc = ["{", `  ${SLASH}${SLASH} shared with my team`, '  "mcpServers": {}', "}", ""].join(LF);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(projAlias, ".mcp.json"), jsonc);
    writeFileSync(join(projClient, ".mcp.json"), jsonc);

    const pa = parseInstallArgs(["mcp", "--project-dir", projAlias]);
    const pc = parseInstallArgs(["claude-code", "--scope", "project", "--project-dir", projClient]);
    expect(pa.ok && pc.ok).toBe(true);
    if (!pa.ok || !pc.ok) return;

    const a = captureIo();
    const c = captureIo();
    const ra = await runInstall({ ...pa.options, home: synthHome, os: "macos", io: a.io });
    const rc = await runInstall({ ...pc.options, home: synthHome, os: "macos", io: c.io });

    expect(ra.exitCode).toBe(rc.exitCode);
    expect(readOrNull(join(projAlias, ".mcp.json"))).toBe(readOrNull(join(projClient, ".mcp.json")));
    expect(scrub(a.stdout(), projAlias)).toBe(scrub(c.stdout(), projClient));
    expect(scrub(a.stderr(), projAlias)).toBe(scrub(c.stderr(), projClient));
  });

  it("takes an explicit --scope beside the alias, which the pin does NOT override", async () => {
    // RECORDED, not endorsed. `resolveClientArg` hands the pinned scope back
    // as a DEFAULT and every caller applies it only when `--scope` is absent
    // (install-cmd.ts and import-cmd.ts both say so in a comment), so
    // `install mcp --scope user` resolves claude-code at USER scope and writes
    // ~/.claude.json -- the alias's pin is discarded in silence.
    //
    // Refusing it instead needs the caller's scope at resolve time, which
    // `resolveClientArg(verb, arg)` does not receive; expressing that is a
    // signature change plus the three call sites, none of them this file.
    // This test exists so that change is a visible, deliberate edit here
    // rather than a silent behaviour swing.
    const r = parseInstallArgs(["mcp", "--scope", "user"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.clientId).toBe("claude-code");
    expect(r.options.scope).toBe("user");
    // Which is a different file from the one `mcp` names.
    const user = resolveInstallPath({ clientId: "claude-code", scope: "user", os: "linux", home: "/synth/home" });
    expect(user.absolute).toBe(join("/synth/home", ".claude.json"));
    expect(user.absolute).not.toBe(join("/synth/home/proj", ".mcp.json"));
  });
});
