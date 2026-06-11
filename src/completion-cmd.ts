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
  positional?: string[];
  flags: string[];
}

const INSTALL_CLIENTS = ["claude-code", "claude-desktop", "cursor", "vscode"] as const;

// Single source of truth for shell completion across bash/zsh/fish/powershell.
// MUST stay in sync with the dispatch in index.ts (KNOWN_SUBCOMMANDS) -- the
// completion test asserts every dispatched subcommand appears here.
export const SUBCOMMAND_SPEC: SubcommandSpec[] = [
  // Setup -- connect a client to yaw-mcp.
  {
    name: "install",
    description: "Connect an MCP client to yaw-mcp",
    positional: [...INSTALL_CLIENTS],
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
    positional: ["<slug>"],
    flags: ["--env", "--dry-run", "--json", "--catalog", "--help"],
  },
  { name: "remove", description: "Remove a local server", positional: ["<slug-or-namespace>"], flags: ["--help"] },
  { name: "list", description: "List the servers yaw-mcp loads locally", flags: ["--json", "--help"] },
  {
    name: "try",
    description: "Wire a one-off trial of a catalog server",
    positional: ["<slug>"],
    flags: ["--client", "--ttl", "--env", "--dry-run", "--base", "--help"],
  },
  { name: "try-cleanup", description: "Remove a wired trial", positional: ["<slug>"], flags: ["--base", "--help"] },
  // Inspection.
  { name: "doctor", description: "Print diagnostic of yaw-mcp setup", flags: ["--json", "--help"] },
  { name: "servers", description: "List servers in your yaw.sh/mcp dashboard", flags: ["--json", "--help"] },
  {
    name: "bundles",
    description: "Browse curated multi-server bundles",
    positional: ["list", "match"],
    flags: ["--json", "--help"],
  },
  // Maintenance.
  { name: "upgrade", description: "Upgrade @yawlabs/mcp to the latest version", flags: ["--run", "--json", "--help"] },
  { name: "reset-learning", description: "Clear cross-session learning history", flags: ["--help"] },
  {
    name: "completion",
    description: "Print a shell completion script",
    positional: ["bash", "zsh", "fish", "powershell"],
    flags: ["--help"],
  },
  // Account / sync (Yaw Team).
  { name: "login", description: "Authenticate with a Yaw MCP account", flags: ["--key", "--json", "--help"] },
  { name: "logout", description: "Sign out of your account", flags: ["--json", "--help"] },
  {
    name: "sync",
    description: "Sync bundles across machines",
    positional: ["push", "pull", "status"],
    flags: ["--key", "--json", "--help"],
  },
  { name: "stats", description: "Show usage statistics", flags: ["--key", "--limit", "--days", "--json", "--help"] },
  {
    name: "secrets",
    description: "Manage stored secrets",
    positional: ["set", "get", "list", "remove", "lock", "push", "pull"],
    flags: ["--key", "--value", "--stdin", "--json", "--help"],
  },
  // Other.
  { name: "compliance", description: "Run the compliance suite against a server", flags: ["--publish", "--help"] },
  { name: "help", description: "Show usage", flags: [] },
];

export function parseCompletionArgs(
  argv: string[],
): { ok: true; options: { shell: CompletionShell } } | { ok: false; error: string } {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { ok: false, error: COMPLETION_USAGE };
  }
  const positional = argv.filter((a) => !a.startsWith("-"));
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

function renderBash(): string {
  const subcommandList = SUBCOMMAND_SPEC.map((s) => s.name).join(" ");
  const topLevelFlags = "--help -h --version -V";
  const cases = SUBCOMMAND_SPEC.map((spec) => {
    const posClause = spec.positional
      ? `    if [[ $cword -eq 2 ]]; then
      COMPREPLY=( $(compgen -W "${spec.positional.join(" ")} ${spec.flags.join(" ")}" -- "$cur") )
      return 0
    fi`
      : "";
    return `  ${spec.name})
${posClause}
    COMPREPLY=( $(compgen -W "${spec.flags.join(" ")}" -- "$cur") )
    return 0
    ;;`;
  }).join("\n");

  return `# bash completion for yaw-mcp — generated by \`yaw-mcp completion bash\`
# Install: save this to ~/.local/share/bash-completion/completions/yaw-mcp
#          or source it from your .bashrc.
_yaw-mcp() {
  local cur prev words cword
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
    if (spec.positional) {
      lines.push(`        _arguments '1: :(${spec.positional.join(" ")})' '*: :(${spec.flags.join(" ")})'`);
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
    if (spec.positional) {
      for (const p of spec.positional) {
        positionalLines.push(`complete -c yaw-mcp -n "__fish_seen_subcommand_from ${spec.name}" -a ${p}`);
      }
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
    const positional = spec.positional ? spec.positional.map((p) => `'${p}'`).join(", ") : "";
    const flags = spec.flags.map((f) => `'${f}'`).join(", ");
    const positionalLine = positional ? `      $completions += @(${positional})\n` : "";
    return `    '${spec.name}' {
${positionalLine}      $completions += @(${flags})
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
