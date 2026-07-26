// `yaw-mcp bundles [list|match]` — CLI counterpart to the `mcp_connect_bundles`
// meta-tool (v0.28.0). The LLM-facing tool has always been the primary
// surface, but users ask "what bundles exist?" in support threads often
// enough that surfacing them in the CLI is worth it: a human can skim the
// curated list without starting an MCP session.
//
// Two actions mirror the meta-tool's `action` parameter:
//
//   list    Static view of every curated bundle with activate hints. No
//           network, no token needed. Good for browsing or sharing in
//           onboarding docs.
//
//   match   Reads the servers yaw-mcp actually loads (bundles.json, project
//           file winning over user-global) and partitions the bundles into
//           "ready to activate" vs "partially installed" vs "ignored" (zero
//           overlap). Also local: no network, no token needed.
//
// Output is human-readable text by default. `--json` on either action
// emits a machine-readable shape for pipeline use.
//
// Exit codes:
//   0  always -- both actions are local reads with no failure mode. A
//      malformed bundles.json degrades to "no servers" plus a warning on
//      stderr rather than an error exit.

import {
  type BundleMatchResult,
  bundleActivateHint,
  CURATED_BUNDLES,
  type CuratedBundle,
  matchBundles,
} from "./bundles.js";
import { loadLocalBundles } from "./local-bundles.js";

export type BundlesAction = "list" | "match";

export interface BundlesCommandOptions {
  home?: string;
  cwd?: string;
  action?: BundlesAction;
  json?: boolean;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface BundlesCommandResult {
  exitCode: number;
  lines: string[];
}

export interface ParsedBundlesArgs {
  action: BundlesAction;
  json: boolean;
}

export const BUNDLES_USAGE = `Usage: yaw-mcp bundles [list|match] [--json]

  Curated multi-server bundles -- hand-picked stacks you can activate in one step.

  list      List every curated bundle (default).
  match     Partition bundles against the servers in your bundles.json.

  --json    Emit machine-readable JSON instead of a table.`;

export function parseBundlesArgs(
  argv: string[],
): { ok: true; options: ParsedBundlesArgs } | { ok: false; error: string; help?: boolean } {
  let action: BundlesAction = "list";
  let json = false;
  let actionSet = false;
  for (const a of argv) {
    if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      return { ok: false, error: BUNDLES_USAGE, help: true };
    } else if (a === "list" || a === "match") {
      if (actionSet) {
        return {
          ok: false,
          error: `yaw-mcp bundles: action already set to "${action}" (got "${a}")\n\n${BUNDLES_USAGE}`,
        };
      }
      action = a;
      actionSet = true;
    } else {
      return { ok: false, error: `yaw-mcp bundles: unknown argument "${a}"\n\n${BUNDLES_USAGE}` };
    }
  }
  return { ok: true, options: { action, json } };
}

export async function runBundlesCommand(opts: BundlesCommandOptions = {}): Promise<BundlesCommandResult> {
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };
  const printErr = (s: string): void => {
    lines.push(s);
    writeErr(`${s}\n`);
  };

  const action = opts.action ?? "list";

  if (action === "list") {
    if (opts.json) {
      print(JSON.stringify({ bundles: CURATED_BUNDLES }, null, 2));
    } else {
      renderList(print);
    }
    return { exitCode: 0, lines };
  }

  // action === "match" — reads the same local bundles.json server.ts loads at
  // startup, so the CLI's partition and the LLM-facing `mcp_connect_bundles`
  // partition are computed over the identical server set.
  const loaded = await loadLocalBundles({ cwd: opts.cwd, home: opts.home });

  // Surface load warnings so a malformed bundles.json reads as "this file is
  // broken" instead of "you have no servers." stderr keeps stdout clean for
  // a --json consumer.
  for (const w of loaded.warnings) printErr(`warning: ${w}`);

  // Only count enabled servers — disabled ones won't auto-activate so
  // they shouldn't count toward a bundle being "ready." This mirrors
  // the filter the LLM-facing `mcp_connect_bundles` uses.
  const installed = (loaded.config?.servers ?? []).filter((s) => s.isActive).map((s) => s.namespace);
  const match = matchBundles(installed);

  if (opts.json) {
    print(JSON.stringify({ installed, ...match }, null, 2));
    return { exitCode: 0, lines };
  }

  renderMatch(match, installed, print);
  return { exitCode: 0, lines };
}

function renderList(print: (s?: string) => void): void {
  print(`${CURATED_BUNDLES.length} curated bundles`);
  print("");
  // Group by category so the reader can skim the category they care
  // about. Inside each category sort by id alphabetical for stability.
  const byCategory = new Map<string, CuratedBundle[]>();
  for (const b of CURATED_BUNDLES) {
    const list = byCategory.get(b.category) ?? [];
    list.push(b);
    byCategory.set(b.category, list);
  }
  const categories = [...byCategory.keys()].sort();
  for (const cat of categories) {
    const list = (byCategory.get(cat) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
    print(`  [${cat}]`);
    for (const b of list) {
      print(`    ${b.id.padEnd(18)} ${b.name}`);
      print(`                       ${b.description}`);
      print(`                       -> ${bundleActivateHint(b)}`);
    }
    print("");
  }
}

function renderMatch(match: BundleMatchResult, installed: string[], print: (s?: string) => void): void {
  const installedList = installed.length === 0 ? "(none)" : installed.slice().sort().join(", ");
  const serverWord = installed.length === 1 ? "server" : "servers";
  print(
    `Checked ${CURATED_BUNDLES.length} bundles against ${installed.length} enabled ${serverWord}: ${installedList}`,
  );
  print("");

  if (match.ready.length === 0 && match.partial.length === 0) {
    print("No curated bundles match your current config.");
    print("Run `yaw-mcp bundles list` to see the full catalog.");
    return;
  }

  if (match.ready.length > 0) {
    print("Ready to activate (every namespace installed):");
    for (const b of match.ready.slice().sort((a, c) => a.id.localeCompare(c.id))) {
      print(`  ${b.id.padEnd(18)} ${b.description}`);
      print(`                     -> ${bundleActivateHint(b)}`);
    }
    print("");
  }

  if (match.partial.length > 0) {
    // Same sort as topPartialBundles: fewest missing first, then most
    // have, then id. Matches the inline discover hint ranking so users
    // see the same priority in both surfaces.
    const sorted = match.partial.slice().sort((a, b) => {
      if (a.missing.length !== b.missing.length) return a.missing.length - b.missing.length;
      if (a.have.length !== b.have.length) return b.have.length - a.have.length;
      return a.bundle.id.localeCompare(b.bundle.id);
    });
    print("Partially installed (install more to complete):");
    for (const entry of sorted) {
      const have = entry.have.join(", ");
      const missing = entry.missing.join(", ");
      print(`  ${entry.bundle.id.padEnd(18)} have: ${have}; missing: ${missing}`);
    }
    print("");
  }
}
