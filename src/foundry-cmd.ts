// `yaw-mcp foundry export` -- fold the opt-in harvest (~/.yaw-mcp/foundry.jsonl,
// written when YAW_MCP_FOUNDRY is on) into a checked-in routing-regression
// corpus that the foundry-routing.test.ts gate consumes.
//
// This is a MAINTAINER command: it snapshots the local server catalog (from
// bundles.json) so the corpus is self-contained and the BM25 floor can be
// replayed in CI without a live config. See foundry-corpus.ts for what the
// gate measures (a BM25-floor regression check on real intents, NOT a
// correctness oracle).
//
// Exit codes:
//   0  corpus written
//   1  no harvested traces found (nothing to export)
//   2  no usable entries after folding (every trace's `chosen` is unknown to
//      the local server catalog, or all tokens were empty)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_CORPUS_CAP, buildCorpusFromTraces, parseTraceLines, scoreCorpus } from "./foundry-corpus.js";
import { FOUNDRY_FILENAME } from "./foundry.js";
import { loadLocalBundles } from "./local-bundles.js";
import { userConfigDir } from "./paths.js";
import type { RankableServer } from "./relevance.js";

const DEFAULT_OUT = path.join("src", "tests", "fixtures", "foundry-corpus.json");

export interface ParsedFoundryArgs {
  action: "export";
  out: string;
  cap: number;
  json: boolean;
}

export const FOUNDRY_USAGE = `Usage: yaw-mcp foundry export [--out <path>] [--cap <n>] [--json]

  Fold the opt-in dispatch harvest (~/.yaw-mcp/foundry.jsonl) into a routing
  regression corpus consumed by the foundry-routing test gate. Maintainer
  command: requires a local bundles.json for the server-catalog snapshot.

  --out <path>   Where to write the corpus (default: ${DEFAULT_OUT}).
  --cap <n>      Max entries, stratified by chosen server (default: ${DEFAULT_CORPUS_CAP}).
  --json         Emit a machine-readable summary instead of text.`;

export function parseFoundryArgs(
  argv: string[],
): { ok: true; options: ParsedFoundryArgs } | { ok: false; error: string } {
  let action: "export" | undefined;
  let out = DEFAULT_OUT;
  let cap = DEFAULT_CORPUS_CAP;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { ok: false, error: FOUNDRY_USAGE };
    if (a === "--json") {
      json = true;
    } else if (a === "--out") {
      const v = argv[++i];
      if (!v) return { ok: false, error: `yaw-mcp foundry: --out needs a path\n\n${FOUNDRY_USAGE}` };
      out = v;
    } else if (a === "--cap") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0)
        return { ok: false, error: `yaw-mcp foundry: --cap needs a positive number\n\n${FOUNDRY_USAGE}` };
      cap = Math.floor(v);
    } else if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp foundry: unknown argument "${a}"\n\n${FOUNDRY_USAGE}` };
    } else if (action === undefined) {
      if (a !== "export")
        return { ok: false, error: `yaw-mcp foundry: unknown action "${a}" (only "export")\n\n${FOUNDRY_USAGE}` };
      action = a;
    } else {
      return { ok: false, error: `yaw-mcp foundry: unexpected extra argument "${a}"\n\n${FOUNDRY_USAGE}` };
    }
  }
  if (action === undefined) return { ok: false, error: `yaw-mcp foundry: missing action.\n\n${FOUNDRY_USAGE}` };
  return { ok: true, options: { action, out, cap, json } };
}

export interface FoundryExportOptions {
  out: string;
  cap: number;
  json: boolean;
  home?: string;
  cwd?: string;
  // Test hooks: inject the harvested blob + server catalog to bypass fs/bundles.
  readTraces?: () => string | null;
  loadServers?: () => Promise<RankableServer[]>;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
}

async function defaultLoadServers(cwd: string | undefined, home: string): Promise<RankableServer[]> {
  const { config } = await loadLocalBundles({ cwd, home });
  return (config?.servers ?? []).map((s) => ({
    namespace: s.namespace,
    name: s.name,
    description: s.description,
    tools: s.toolCache ?? [],
  }));
}

export async function runFoundryExport(opts: FoundryExportOptions): Promise<{ exitCode: number; lines: string[] }> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.writeErr ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };
  const printErr = (s: string): void => {
    lines.push(s);
    writeErr(`${s}\n`);
  };

  const home = opts.home ?? homedir();
  const harvestPath = path.join(userConfigDir(home), FOUNDRY_FILENAME);

  const blob = opts.readTraces
    ? opts.readTraces()
    : (() => {
        try {
          return readFileSync(harvestPath, "utf8");
        } catch {
          return null;
        }
      })();

  if (blob === null) {
    printErr(`yaw-mcp foundry: no harvest at ${harvestPath}. Set YAW_MCP_FOUNDRY=1 and dispatch first.`);
    return { exitCode: 1, lines };
  }

  const traces = parseTraceLines(blob);
  if (traces.length === 0) {
    printErr(`yaw-mcp foundry: ${harvestPath} has no parseable traces.`);
    return { exitCode: 1, lines };
  }

  const servers = opts.loadServers ? await opts.loadServers() : await defaultLoadServers(opts.cwd, home);
  const corpus = buildCorpusFromTraces(traces, servers, { cap: opts.cap });

  if (corpus.entries.length === 0) {
    printErr(
      `yaw-mcp foundry: ${traces.length} traces but 0 usable entries -- none of the chosen servers are in the local catalog (${servers.length} servers).`,
    );
    return { exitCode: 2, lines };
  }

  mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");

  const score = scoreCorpus(corpus);
  if (opts.json) {
    print(
      JSON.stringify(
        {
          out: opts.out,
          entries: corpus.entries.length,
          servers: corpus.servers.length,
          fromTraces: traces.length,
          top1: score.top1,
          top3: score.top3,
        },
        null,
        2,
      ),
    );
    return { exitCode: 0, lines };
  }

  print(`Wrote ${corpus.entries.length} entries (from ${traces.length} traces) to ${opts.out}`);
  print(
    `BM25-floor accuracy on this corpus: top-1 ${(score.top1 * 100).toFixed(1)}%, top-3 ${(score.top3 * 100).toFixed(1)}%`,
  );
  return { exitCode: 0, lines };
}
