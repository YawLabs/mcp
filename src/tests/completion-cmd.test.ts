import { describe, expect, it } from "vitest";
import {
  COMPLETION_USAGE,
  SUBCOMMAND_SPEC,
  parseCompletionArgs,
  renderScript,
  runCompletion,
} from "../completion-cmd.js";

const SUBCOMMAND_NAMES = SUBCOMMAND_SPEC.map((s) => s.name);

// Ground-truth dispatched subcommands (index.ts). Pinned here so dropping one
// from SUBCOMMAND_SPEC -- which would silently shrink every shell's
// completion -- fails this test loudly. Update both together by design.
const EXPECTED_SUBCOMMANDS = [
  "install",
  "add",
  "remove",
  "list",
  "try",
  "try-cleanup",
  "doctor",
  "servers",
  "bundles",
  "upgrade",
  "reset-learning",
  "completion",
  "login",
  "logout",
  "sync",
  "stats",
  "secrets",
  "compliance",
  "help",
];

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
});

describe("SUBCOMMAND_SPEC coverage", () => {
  it("matches the dispatched subcommand set exactly (no drift vs index.ts)", () => {
    expect([...SUBCOMMAND_NAMES].sort()).toEqual([...EXPECTED_SUBCOMMANDS].sort());
  });

  it("includes the local-server + account commands that were previously missing", () => {
    for (const sub of ["add", "remove", "list", "try", "try-cleanup", "login", "logout", "sync", "stats", "secrets"]) {
      expect(SUBCOMMAND_NAMES).toContain(sub);
    }
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
