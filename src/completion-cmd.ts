// `yaw-mcp completion <shell>` — prints a shell completion script to
// stdout. Every decent CLI has this; surfacing it as a first-class
// subcommand means a user can one-line it into their completions dir
// (the install instructions render right below the script for each
// shell, commented out so they're preserved but don't pollute the
// sourced file).
//
// Supported shells:
//   bash        Writes to ~/.local/share/bash-completion/completions/yaw-mcp
//   zsh         Writes to a path on $fpath (e.g., ~/.zsh/completions/_yaw-mcp)
//   fish        Writes to ~/.config/fish/completions/yaw-mcp.fish
//   powershell  Sourced from $PROFILE
//
// The completion surface is derived from a single SUBCOMMAND_SPEC table
// so that adding a new subcommand or flag updates every shell template
// at once. Static strings would drift on a codebase that's been
// shipping a subcommand a day.

export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";

export interface CompletionCommandOptions {
  shell?: CompletionShell;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface CompletionCommandResult {
  exitCode: number;
  lines: string[];
}

export const COMPLETION_USAGE = `Usage: yaw-mcp completion <bash|zsh|fish|powershell>

  Print a shell completion script to stdout. Redirect it to the right
  location for your shell:

    bash        yaw-mcp completion bash       > ~/.local/share/bash-completion/completions/yaw-mcp
    zsh         yaw-mcp completion zsh        > "\${fpath[1]}/_yaw-mcp"    (must be on $fpath)
    fish        yaw-mcp completion fish       > ~/.config/fish/completions/yaw-mcp.fish
    powershell  yaw-mcp completion powershell >> $PROFILE`;

// Central spec for every user-facing subcommand. One source of truth —
// every shell template derives from this so a new subcommand added
// elsewhere shows up in all four completions without hand-edits.
interface SubcommandSpec {
  name: string;
  /** One-line description. Used by the zsh generator (and kept here as the
   *  single source so descriptions can't drift from the spec). Keep it free of
   *  ':' and parentheses -- zsh `_values` treats ':' as the value/desc
   *  separator. */
  description: string;
  /** Positional argument POSITIONS, in order. Each inner array is the set of
   *  one-of-N alternative candidates that complete at that single position
   *  (`install` takes ONE client chosen from four, so all four clients live
   *  together in position 0 -- NOT one candidate per position). An entry like
   *  "<slug>" is a documentation placeholder for a free-form argument;
   *  placeholders are filtered out of the generated scripts but keep their
   *  slot so later positions still line up. */
  positional?: string[][];
  flags: string[];
}

const INSTALL_CLIENTS = ["claude-code", "claude-desktop", "cursor", "vscode"] as const;

// Single source of truth for shell completion across bash/zsh/fish/powershell.
// MUST cover every dispatched subcommand in KNOWN_SUBCOMMANDS (src/subcommands.ts)
// -- the completion test imports that table directly and asserts every non-flag,
// non-`help` dispatched subcommand appears here, so drift fails the build.
export const SUBCOMMAND_SPEC: SubcommandSpec[] = [
  // Setup -- connect a client to yaw-mcp.
  {
    name: "install",
    description: "Connect an MCP client to yaw-mcp",
    positional: [[...INSTALL_CLIENTS]],
    flags: [
      "--scope",
      "--token",
      "--project-dir",
      "--os",
      "--force",
      "--skip",
      "--dry-run",
      "--no-yaw-mcp-config",
      "--list",
      "--all",
    ],
  },
  // Local servers -- manage ~/.yaw-mcp/bundles.json (no account).
  {
    name: "add",
    description: "Add a catalog server to bundles.json",
    positional: [["<slug>"]],
    flags: ["--env", "--dry-run", "--json", "--catalog", "--help"],
  },
  { name: "remove", description: "Remove a local server", positional: [["<slug-or-namespace>"]], flags: ["--help"] },
  { name: "list", description: "List the servers yaw-mcp loads locally", flags: ["--json", "--help"] },
  {
    name: "try",
    description: "Wire a one-off trial of a catalog server",
    positional: [["<slug>"]],
    flags: ["--client", "--ttl", "--env", "--dry-run", "--base", "--help"],
  },
  { name: "try-cleanup", description: "Remove a wired trial", positional: [["<slug>"]], flags: ["--base", "--help"] },
  // Inspection.
  { name: "doctor", description: "Print diagnostic of yaw-mcp setup", flags: ["--json", "--help"] },
  { name: "servers", description: "List servers in your yaw.sh/mcp dashboard", flags: ["--json", "--help"] },
  {
    name: "bundles",
    description: "Browse curated multi-server bundles",
    positional: [["list", "match"]],
    flags: ["--json", "--help"],
  },
  // Maintenance.
  { name: "upgrade", description: "Upgrade @yawlabs/mcp to the latest version", flags: ["--run", "--json", "--help"] },
  { name: "reset-learning", description: "Clear cross-session learning history", flags: ["--help"] },
  {
    name: "completion",
    description: "Print a shell completion script",
    positional: [["bash", "zsh", "fish", "powershell"]],
    flags: ["--help"],
  },
  // Secrets vault (local, encrypted). Actions/flags mirror parseSecretsArgs
  // in src/secrets-cmd.ts -- keep them in sync.
  {
    name: "secrets",
    description: "Manage stored secrets",
    positional: [["set", "get", "list", "remove", "lock", "rotate", "audit"], ["<name>"]],
    flags: ["--value", "--stdin", "--secret", "--server", "--json", "--help"],
  },
  // Other.
  { name: "audit", description: "Run a full-pass audit of loaded servers", flags: ["--json", "--help"] },
  { name: "compliance", description: "Run the compliance suite against a server", flags: ["--publish", "--help"] },
  {
    name: "foundry",
    description: "Export the opt-in dispatch-trace corpus",
    positional: [["export"]],
    flags: ["--out", "--cap", "--json", "--help"],
  },
  { name: "help", description: "Show usage", flags: [] },
];

export function parseCompletionArgs(
  argv: string[],
): { ok: true; options: { shell: CompletionShell } } | { ok: false; error: string; help?: boolean } {
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      return { ok: false, error: COMPLETION_USAGE, help: true };
    }
    // Reject unknown flags loudly (same shape as the sibling parsers, e.g.
    // parseSecretsArgs) instead of silently dropping them.
    if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp completion: unknown flag "${a}"\n\n${COMPLETION_USAGE}` };
    }
    positional.push(a);
  }
  if (positional.length === 0) {
    return { ok: false, error: `yaw-mcp completion: missing shell argument\n\n${COMPLETION_USAGE}` };
  }
  if (positional.length > 1) {
    return { ok: false, error: `yaw-mcp completion: too many arguments\n\n${COMPLETION_USAGE}` };
  }
  const shell = positional[0];
  if (shell !== "bash" && shell !== "zsh" && shell !== "fish" && shell !== "powershell") {
    return { ok: false, error: `yaw-mcp completion: unknown shell "${shell}"\n\n${COMPLETION_USAGE}` };
  }
  return { ok: true, options: { shell } };
}

export async function runCompletion(opts: CompletionCommandOptions = {}): Promise<CompletionCommandResult> {
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s: string): void => {
    lines.push(s);
    write(`${s}\n`);
  };

  if (!opts.shell) {
    writeErr(`yaw-mcp completion: missing shell argument\n${COMPLETION_USAGE}\n`);
    return { exitCode: 2, lines };
  }

  const script = renderScript(opts.shell);
  print(script);
  return { exitCode: 0, lines };
}

export function renderScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return renderBash();
    case "zsh":
      return renderZsh();
    case "fish":
      return renderFish();
    case "powershell":
      return renderPowershell();
  }
}

/** True when a positional value is a documentation placeholder, not a real
 *  completion candidate. Placeholders look like "<slug>" or "<name>". */
function isPlaceholder(s: string): boolean {
  return s.startsWith("<") && s.endsWith(">");
}

/** Completable candidates per positional slot. Filters placeholders out of
 *  each slot's alternatives and drops slots left empty (free-form args),
 *  while preserving each slot's ORIGINAL index so the generators' position
 *  math (cword / token count / zsh slot number) stays aligned with the
 *  argument the user is actually typing. */
function realPositionals(spec: SubcommandSpec): Array<{ candidates: string[]; index: number }> {
  return (spec.positional ?? [])
    .map((alternatives, index) => ({ candidates: alternatives.filter((a) => !isPlaceholder(a)), index }))
    .filter(({ candidates }) => candidates.length > 0);
}

function renderBash(): string {
  const subcommandList = SUBCOMMAND_SPEC.map((s) => s.name).join(" ");
  const topLevelFlags = "--help -h --version -V";
  const cases = SUBCOMMAND_SPEC.map((spec) => {
    // Emit one if-block per positional SLOT, offering every alternative for
    // that slot in a single compgen word list (so `install <TAB>` shows all
    // four clients at once). The slot's original index computes the cword
    // position (cword == slotIndex + 2 because COMP_WORDS[0] is "yaw-mcp",
    // COMP_WORDS[1] is the subcommand).
    const posClauses = realPositionals(spec).map(
      ({ candidates, index }) =>
        `    if [[ $cword -eq $((${index} + 2)) ]]; then\n      COMPREPLY=( $(compgen -W "${candidates.join(" ")}" -- "$cur") )\n      return 0\n    fi`,
    );
    const parts = [
      ...posClauses,
      `    COMPREPLY=( $(compgen -W "${spec.flags.join(" ")}" -- "$cur") )`,
      "    return 0",
    ].filter((p) => p !== "");
    return `  ${spec.name})\n${parts.join("\n")}\n    ;;`;
  }).join("\n");

  return `# bash completion for yaw-mcp — generated by \`yaw-mcp completion bash\`
# Install: save this to ~/.local/share/bash-completion/completions/yaw-mcp
#          or source it from your .bashrc.
_yaw-mcp() {
  local cur cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cword=$COMP_CWORD

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${subcommandList} ${topLevelFlags}" -- "$cur") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
${cases}
  esac
}
complete -F _yaw-mcp yaw-mcp
`;
}

function renderZsh(): string {
  // Descriptions come straight from the spec (single source of truth), so a
  // newly-added subcommand can never render with a blank zsh description.
  const subcommandList = SUBCOMMAND_SPEC.map((s) => `    '${s.name}:${s.description}'`).join("\n");

  const argsCases = SUBCOMMAND_SPEC.map((spec) => {
    const lines = [`      ${spec.name})`];
    const positionals = realPositionals(spec);
    if (positionals.length > 0) {
      // Emit one _arguments entry per positional SLOT with every alternative
      // for that slot in its candidate group, using the slot's original index
      // for the zsh slot number (slot == slotIndex + 1 because zsh _arguments
      // slot numbering is 1-based and slot 1 is already claimed by the
      // subcommand dispatch in the outer _arguments call).
      const posArgs = positionals.map(({ candidates, index }) => `'${index + 1}: :(${candidates.join(" ")})'`).join(" ");
      lines.push(`        _arguments ${posArgs} '*: :(${spec.flags.join(" ")})'`);
    } else {
      lines.push(`        _arguments '*: :(${spec.flags.join(" ")})'`);
    }
    lines.push("        ;;");
    return lines.join("\n");
  }).join("\n");

  return `#compdef yaw-mcp
# zsh completion for yaw-mcp — generated by \`yaw-mcp completion zsh\`
# Install: save this to a file on your $fpath named _yaw-mcp
#          (e.g., ~/.zsh/completions/_yaw-mcp), then rebuild completions:
#            autoload -U compinit && compinit
_yaw-mcp() {
  local context state line
  _arguments -C \\
    '1: :->cmd' \\
    '*::arg:->args'

  case $state in
    cmd)
      _values 'yaw-mcp subcommand' \\
${subcommandList}
      ;;
    args)
      case $line[1] in
${argsCases}
      esac
      ;;
  esac
}
_yaw-mcp "$@"
`;
}

function renderFish(): string {
  const header = `# fish completion for yaw-mcp — generated by \`yaw-mcp completion fish\`
# Install: save this to ~/.config/fish/completions/yaw-mcp.fish
complete -c yaw-mcp -f`;

  const subcommandLines = SUBCOMMAND_SPEC.map((spec) => {
    return `complete -c yaw-mcp -n __fish_use_subcommand -a ${spec.name}`;
  });

  const positionalLines: string[] = [];
  const flagLines: string[] = [];
  for (const spec of SUBCOMMAND_SPEC) {
    // One `complete` line per positional SLOT, offering every alternative for
    // that slot in a single space-separated -a list (fish splits it into
    // individual candidates). The slot's original index keeps the position
    // guard's argument count right: `count (commandline -opc)` returns the
    // number of tokens before the cursor (including "yaw-mcp" and the
    // subcommand), so the expected count for slotIndex N is N + 2.
    for (const { candidates, index } of realPositionals(spec)) {
      const expectedCount = index + 2;
      positionalLines.push(
        `complete -c yaw-mcp -n "__fish_seen_subcommand_from ${spec.name}; and test (count (commandline -opc)) -eq ${expectedCount}" -a "${candidates.join(" ")}"`,
      );
    }
    for (const f of spec.flags) {
      // `-l` takes a LONG option name (no dashes). Only emit for `--` flags;
      // a single-dash flag (e.g. `-V`) would produce invalid `-l -V` syntax.
      if (!f.startsWith("--")) continue;
      const long = f.slice(2);
      flagLines.push(`complete -c yaw-mcp -n "__fish_seen_subcommand_from ${spec.name}" -l ${long}`);
    }
  }

  return [header, "", ...subcommandLines, "", ...positionalLines, "", ...flagLines, ""].join("\n");
}

function renderPowershell(): string {
  const subcommandNames = SUBCOMMAND_SPEC.map((s) => `'${s.name}'`).join(", ");
  const caseBranches = SUBCOMMAND_SPEC.map((spec) => {
    const flags = spec.flags.map((f) => `'${f}'`).join(", ");
    // Emit one guarded block per positional SLOT, adding every alternative
    // for that slot to the candidate array. $tokens[0] is "yaw-mcp",
    // $tokens[1] is the subcommand, so the token count when completing
    // slotIndex N is N + 2 (the cursor is on the next token to be typed).
    const positionalLines = realPositionals(spec)
      .map(
        ({ candidates, index }) =>
          `      if ($tokens.Count -eq ${index + 2}) { $completions += @(${candidates.map((c) => `'${c}'`).join(", ")}) }`,
      )
      .join("\n");
    const positionalBlock = positionalLines ? `${positionalLines}\n` : "";
    return `    '${spec.name}' {
${positionalBlock}      $completions += @(${flags})
    }`;
  }).join("\n");

  return `# PowerShell completion for yaw-mcp — generated by \`yaw-mcp completion powershell\`
# Install: append this script to your profile ($PROFILE) and reload.
Register-ArgumentCompleter -CommandName yaw-mcp -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
  $completions = @()
  if ($tokens.Count -le 2) {
    $completions = @(${subcommandNames}, '--help', '-h', '--version', '-V')
  } else {
    switch ($tokens[1]) {
${caseBranches}
    }
  }
  $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}
