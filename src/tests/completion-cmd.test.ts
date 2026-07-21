import { describe, expect, it } from "vitest";
import {
  COMPLETION_USAGE,
  parseCompletionArgs,
  renderScript,
  runCompletion,
  SUBCOMMAND_SPEC,
} from "../completion-cmd.js";
import { FLAG_ALIASES, KNOWN_SUBCOMMANDS } from "../subcommands.js";

const SUBCOMMAND_NAMES = SUBCOMMAND_SPEC.map((s) => s.name);

// Ground truth comes straight from the real dispatch table
// (src/subcommands.ts), which index.ts imports. Drop the leading-dash
// flag aliases and `help` (which has no per-subcommand completion of its
// own) to get the set the completion spec must cover. Importing the live
// table -- not a hand-maintained mirror -- makes the drift guard REAL: a
// new dispatched subcommand that forgets a SUBCOMMAND_SPEC entry fails
// this test.
const DISPATCHED_SUBCOMMANDS = KNOWN_SUBCOMMANDS.filter(
  (s) => !(FLAG_ALIASES as readonly string[]).includes(s) && s !== "help",
);

function capture(): { out: string[]; err: string[]; push: (s: string) => void; pushErr: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    push: (s: string) => {
      out.push(s);
    },
    pushErr: (s: string) => {
      err.push(s);
    },
  };
}

describe("parseCompletionArgs", () => {
  it("accepts each supported shell", () => {
    for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
      const r = parseCompletionArgs([shell]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.options.shell).toBe(shell);
    }
  });

  it("rejects missing shell argument", () => {
    const r = parseCompletionArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("missing shell argument");
  });

  it("rejects unknown shell", () => {
    const r = parseCompletionArgs(["tcsh"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown shell "tcsh"');
  });

  it("rejects multiple positional args", () => {
    const r = parseCompletionArgs(["bash", "zsh"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("too many arguments");
  });

  it("--help returns usage string", () => {
    const r = parseCompletionArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(COMPLETION_USAGE);
  });

  it("rejects unknown flags instead of silently ignoring them", () => {
    const r = parseCompletionArgs(["bash", "--verbose"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown flag "--verbose"');
  });
});

describe("renderScript — bash", () => {
  it("contains the complete -F registration", () => {
    const s = renderScript("bash");
    expect(s).toContain("complete -F _yaw-mcp yaw-mcp");
    expect(s).toContain("_yaw-mcp()");
  });

  it("includes every spec'd subcommand in the top-level compgen", () => {
    const s = renderScript("bash");
    for (const sub of SUBCOMMAND_NAMES) {
      expect(s).toContain(sub);
    }
  });

  it("branches on install client choices", () => {
    const s = renderScript("bash");
    expect(s).toContain("claude-code");
    expect(s).toContain("claude-desktop");
    expect(s).toContain("cursor");
    expect(s).toContain("vscode");
  });

  it("offers positional alternatives at the SAME argument position (one compgen word list)", () => {
    const s = renderScript("bash");
    // All four install clients complete at `install <TAB>`, not one per slot.
    expect(s).toContain('compgen -W "claude-code claude-desktop cursor vscode"');
    // Same for bundles actions and completion shells.
    expect(s).toContain('compgen -W "list match"');
    expect(s).toContain('compgen -W "bash zsh fish powershell"');
  });

  it("includes install flags", () => {
    const s = renderScript("bash");
    for (const flag of ["--token", "--scope", "--force", "--dry-run"]) {
      expect(s).toContain(flag);
    }
  });
});

describe("renderScript — zsh", () => {
  it("starts with #compdef directive", () => {
    const s = renderScript("zsh");
    expect(s.startsWith("#compdef yaw-mcp")).toBe(true);
  });

  it("declares the _yaw-mcp function", () => {
    const s = renderScript("zsh");
    expect(s).toContain("_yaw-mcp()");
  });

  it("lists every subcommand as a _values candidate with a non-blank description", () => {
    const s = renderScript("zsh");
    for (const spec of SUBCOMMAND_SPEC) {
      // Each entry renders as 'name:description' -- description must be present
      // (regression guard for the old hardcoded-map gap that blanked new cmds).
      expect(s).toContain(`'${spec.name}:${spec.description}'`);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it("offers positional alternatives at the same _arguments slot", () => {
    const s = renderScript("zsh");
    expect(s).toContain("'1: :(claude-code claude-desktop cursor vscode)'");
    expect(s).toContain("'1: :(bash zsh fish powershell)'");
    expect(s).toContain("'1: :(list match)'");
  });
});

describe("renderScript — fish", () => {
  it("uses complete -c yaw-mcp lines", () => {
    const s = renderScript("fish");
    expect(s).toMatch(/complete -c yaw-mcp/);
  });

  it("registers every spec'd subcommand under __fish_use_subcommand", () => {
    const s = renderScript("fish");
    for (const sub of SUBCOMMAND_NAMES) {
      expect(s).toContain(`-a ${sub}`);
    }
  });

  it("scopes flags to each subcommand via __fish_seen_subcommand_from", () => {
    const s = renderScript("fish");
    expect(s).toMatch(/__fish_seen_subcommand_from install/);
  });

  it("offers positional alternatives at the same argument position", () => {
    const s = renderScript("fish");
    expect(s).toContain('-a "claude-code claude-desktop cursor vscode"');
    expect(s).toContain('-a "list match"');
  });
});

describe("renderScript — powershell", () => {
  it("registers ArgumentCompleter for yaw-mcp", () => {
    const s = renderScript("powershell");
    expect(s).toContain("Register-ArgumentCompleter");
    expect(s).toContain("-CommandName yaw-mcp");
  });

  it("covers every spec'd subcommand in the switch block", () => {
    const s = renderScript("powershell");
    for (const sub of SUBCOMMAND_NAMES) {
      expect(s).toContain(`'${sub}'`);
    }
  });

  it("offers positional alternatives at the same token position", () => {
    const s = renderScript("powershell");
    expect(s).toContain("@('claude-code', 'claude-desktop', 'cursor', 'vscode')");
    expect(s).toContain("@('list', 'match')");
  });

  it("guards positional slots on a normalized $argIndex, never on a raw token count", () => {
    const s = renderScript("powershell");
    // The per-subcommand switch only runs once at least one argument follows
    // the subcommand, so a raw `$tokens.Count -eq N` slot guard is dead code:
    // slot 0's `-eq 2` can never be true inside that branch and NO positional
    // candidate was ever offered (install clients, secrets actions, bundles
    // list/match, completion shells, foundry export).
    expect(s).not.toMatch(/\$tokens\.Count -eq \d+/);
    expect(s).toContain("$argIndex = $tokens.Count - 2");
    expect(s).toContain("if ($wordToComplete -ne '') { $argIndex-- }");
    expect(s).toContain("if ($argIndex -lt 0) {");
    // Slot 0 candidates are emitted under the normalized index.
    expect(s).toContain(
      "if ($argIndex -eq 0) { $completions += @('claude-code', 'claude-desktop', 'cursor', 'vscode') }",
    );
    expect(s).toContain("if ($argIndex -eq 0) { $completions += @('bash', 'zsh', 'fish', 'powershell') }");
    expect(s).toContain("if ($argIndex -eq 0) { $completions += @('list', 'match') }");
    expect(s).toContain("if ($argIndex -eq 0) { $completions += @('export') }");
    expect(s).toContain(
      "if ($argIndex -eq 0) { $completions += @('set', 'get', 'list', 'remove', 'lock', 'rotate', 'audit') }",
    );
  });

  it("resolves the real completion cases (subcommand, slot 0, slot 1, flags)", () => {
    const s = renderScript("powershell");
    const complete = (tokens: string[], word: string) => simulatePowershell(s, tokens, word);

    // Still on the subcommand itself -- with or without a partial word.
    expect(complete(["yaw-mcp"], "")).toContain("install");
    expect(complete(["yaw-mcp", "ins"], "ins")).toEqual(["install"]);

    // `yaw-mcp install <TAB>` and `yaw-mcp install cl<TAB>` both land on slot 0.
    const installEmpty = complete(["yaw-mcp", "install"], "");
    expect(installEmpty).toEqual(expect.arrayContaining([...INSTALL_CLIENTS]));
    // Flags must still be offered alongside the positional candidates.
    expect(installEmpty).toEqual(expect.arrayContaining(["--scope", "--token", "--dry-run"]));
    expect(complete(["yaw-mcp", "install", "cl"], "cl")).toEqual(["claude-code", "claude-desktop"]);

    // Slot 1: `yaw-mcp secrets set <TAB>` is past the action list, so only the
    // free-form <name> slot (no candidates) plus flags remain.
    expect(complete(["yaw-mcp", "secrets"], "")).toEqual(expect.arrayContaining(["set", "rotate", "audit"]));
    const secretsSlot1 = complete(["yaw-mcp", "secrets", "set"], "");
    expect(secretsSlot1).not.toContain("set");
    expect(secretsSlot1).toEqual(expect.arrayContaining(["--value", "--stdin"]));

    // A subcommand with no positionals falls straight through to its flags.
    expect(complete(["yaw-mcp", "doctor"], "")).toEqual(["--json", "--help"]);
  });
});

const INSTALL_CLIENTS = ["claude-code", "claude-desktop", "cursor", "vscode"];

/**
 * Minimal interpreter for the exact shape `renderPowershell` emits, so the
 * cases above assert BEHAVIOR (what a user sees on TAB) rather than just the
 * presence of a substring. Mirrors PowerShell semantics for this script:
 * $tokens is CommandElements (a partially typed word is already one of them),
 * a negative normalized index means the subcommand list, otherwise the branch
 * for $tokens[1] contributes its matching slot candidates plus its flags, and
 * the whole set is prefix-filtered by $wordToComplete.
 */
function simulatePowershell(script: string, tokens: string[], wordToComplete: string): string[] {
  const parseList = (list: string): string[] => Array.from(list.matchAll(/'([^']*)'/g), (m) => m[1]);

  const subcommandLine = script.match(/if \(\$argIndex -lt 0\) \{\n\s*\$completions = @\((.*)\)\n/);
  if (!subcommandLine) throw new Error("no normalized subcommand branch in the generated script");

  let argIndex = tokens.length - 2;
  if (wordToComplete !== "") argIndex--;

  let candidates: string[];
  if (argIndex < 0) {
    candidates = parseList(subcommandLine[1]);
  } else {
    const sub = tokens[1];
    const branch = script.match(new RegExp(`\\n    '${sub}' \\{\\n([\\s\\S]*?)\\n    \\}`));
    if (!branch) throw new Error(`no switch branch for "${sub}"`);
    candidates = [];
    for (const line of branch[1].split("\n")) {
      const guarded = line.match(/if \(\$argIndex -eq (\d+)\) \{ \$completions \+= @\((.*)\) \}/);
      if (guarded) {
        if (Number(guarded[1]) === argIndex) candidates.push(...parseList(guarded[2]));
        continue;
      }
      const plain = line.match(/^\s*\$completions \+= @\((.*)\)\s*$/);
      if (plain) candidates.push(...parseList(plain[1]));
    }
  }
  return candidates.filter((c) => c.startsWith(wordToComplete));
}

describe("SUBCOMMAND_SPEC coverage", () => {
  it("covers every dispatched subcommand (no drift vs the real KNOWN_SUBCOMMANDS table)", () => {
    // Every non-flag, non-`help` subcommand the dispatcher knows MUST have a
    // SUBCOMMAND_SPEC entry, or the shell completions silently omit it. This
    // compares against the live table imported from src/subcommands.ts, so a
    // new dispatched subcommand without a spec entry fails here.
    const missing = DISPATCHED_SUBCOMMANDS.filter((s) => !SUBCOMMAND_NAMES.includes(s));
    expect(missing).toEqual([]);
  });

  it("does not spec any name that is not dispatched (no stale completion entries)", () => {
    // The only legitimate spec entry without a bare KNOWN_SUBCOMMANDS slot is
    // `help` (it has its own completion candidate but no per-subcommand args).
    const known = new Set<string>(KNOWN_SUBCOMMANDS);
    const stale = SUBCOMMAND_NAMES.filter((s) => s !== "help" && !known.has(s));
    expect(stale).toEqual([]);
  });

  it("specs foundry (previously dispatched but absent from the completion spec)", () => {
    expect(SUBCOMMAND_NAMES).toContain("foundry");
  });

  it("includes the local-server commands that were previously missing", () => {
    for (const sub of ["add", "remove", "list", "try", "try-cleanup", "secrets"]) {
      expect(SUBCOMMAND_NAMES).toContain(sub);
    }
  });

  it("does not advertise the subcommands removed with the Yaw Team surface (45a3462)", () => {
    for (const dead of ["login", "logout", "sync", "stats", "token", "set-active"]) {
      expect(SUBCOMMAND_NAMES).not.toContain(dead);
      expect([...KNOWN_SUBCOMMANDS]).not.toContain(dead);
    }
  });

  it("keeps the secrets entry in sync with parseSecretsArgs (rotate/audit in, push/pull/--force out)", () => {
    const secrets = SUBCOMMAND_SPEC.find((s) => s.name === "secrets");
    expect(secrets).toBeDefined();
    expect(secrets?.positional?.[0]).toEqual(["set", "get", "list", "remove", "lock", "rotate", "audit"]);
    expect(secrets?.flags).toEqual(expect.arrayContaining(["--value", "--stdin", "--secret", "--server", "--json"]));
    expect(secrets?.flags).not.toContain("--force");
  });
});

describe("runCompletion", () => {
  it("prints the bash script to stdout and exits 0", async () => {
    const io = capture();
    const r = await runCompletion({ shell: "bash", out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(io.out.join("\n")).toContain("complete -F _yaw-mcp yaw-mcp");
    expect(io.err).toEqual([]);
  });

  it("exits 2 when shell is missing", async () => {
    const io = capture();
    const r = await runCompletion({ out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(2);
    expect(io.err.join("")).toContain("missing shell argument");
  });

  it("writes distinct scripts for each shell", async () => {
    const bash = await runCompletion({ shell: "bash", out: capture().push });
    const zsh = await runCompletion({ shell: "zsh", out: capture().push });
    const fish = await runCompletion({ shell: "fish", out: capture().push });
    const ps = await runCompletion({ shell: "powershell", out: capture().push });
    expect(bash.lines[0]).not.toBe(zsh.lines[0]);
    expect(fish.lines[0]).not.toBe(ps.lines[0]);
  });
});
