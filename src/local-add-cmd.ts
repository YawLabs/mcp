// `yaw-mcp add <slug>` / `remove <slug>` / `list`
//
// These manage the LOCAL server set in ~/.yaw-mcp/bundles.json -- the file
// yaw-mcp loads in no-account (Free) mode. This is deliberately distinct from
// `yaw-mcp install <client>`, which wires the yaw-mcp aggregator INTO an AI
// client's config. "install" connects a client; "add" adds a server.
//
//   add <slug>     resolve <slug> from the yaw.sh/mcp catalog and write it
//                  into ~/.yaw-mcp/bundles.json
//   remove <slug>  drop a server (by slug or namespace) from bundles.json
//   list           show the servers yaw-mcp would load locally
//
// `add` resolves through the same static catalog the website and the Yaw
// Terminal app use (catalog.ts), so a slug that works as an "Add to Yaw MCP"
// button works here too.

import { homedir } from "node:os";
import { type FetchCatalog, resolveCatalogSlug } from "./catalog.js";
import {
  deriveNamespace,
  findShadowingProjectBundles,
  loadLocalBundles,
  removeUserBundle,
  upsertUserBundle,
} from "./local-bundles.js";
import type { UpstreamServerConfig } from "./types.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// --- add --------------------------------------------------------------------

export const ADD_USAGE = `Usage: yaw-mcp add <slug> [flags]

  Resolve <slug> from the yaw.sh/mcp catalog and add it to your local
  ~/.yaw-mcp/bundles.json so yaw-mcp loads it (no account needed).

  This is NOT the same as \`yaw-mcp install\` -- install wires the yaw-mcp
  aggregator into an AI client; add adds an MCP server to yaw-mcp itself.

  --env KEY=value   Provide a required env var's value. Repeatable. Required
                    vars not given here AND not in your shell block the add.
  --dry-run         Print what would be written without writing.
  --json            Emit the written entry as JSON (implies success on stdout).
  --catalog <url>   Override the catalog URL (default the public catalog).`;

export interface AddCommandOptions {
  slug?: string;
  envOverrides?: Record<string, string>;
  dryRun?: boolean;
  json?: boolean;
  catalogUrl?: string;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchCatalog?: FetchCatalog;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface AddCommandResult {
  exitCode: number;
  written: string[];
}

function parseEnvFlag(v: string | undefined, bag: Record<string, string>): string | null {
  if (!v || !v.includes("=")) return "--env requires KEY=value";
  const eq = v.indexOf("=");
  const key = v.slice(0, eq);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `--env: invalid KEY "${key}"`;
  bag[key] = v.slice(eq + 1);
  return null;
}

export function parseAddArgs(argv: string[]): { ok: true; options: AddCommandOptions } | { ok: false; error: string } {
  if (argv.length === 0) return { ok: false, error: ADD_USAGE };
  const positional: string[] = [];
  const opts: AddCommandOptions = {};
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--env": {
        const e = parseEnvFlag(next(), env);
        if (e) return { ok: false, error: e };
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--catalog": {
        const v = next();
        if (!v) return { ok: false, error: "--catalog requires a URL" };
        opts.catalogUrl = v;
        break;
      }
      case "-h":
      case "--help":
        return { ok: false, error: ADD_USAGE };
      default:
        if (a.startsWith("--")) return { ok: false, error: `Unknown flag: ${a}\n${ADD_USAGE}` };
        positional.push(a);
    }
  }
  if (positional.length !== 1) {
    return { ok: false, error: `Expected exactly one server slug, got ${positional.length}.\n${ADD_USAGE}` };
  }
  opts.slug = positional[0];
  if (Object.keys(env).length > 0) opts.envOverrides = env;
  return { ok: true, options: opts };
}

export async function runAdd(opts: AddCommandOptions): Promise<AddCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  if (!opts.slug) {
    printErr(ADD_USAGE);
    return { exitCode: 2, written: [] };
  }
  const slug = opts.slug;
  if (!SLUG_RE.test(slug)) {
    printErr(`yaw-mcp add: invalid slug "${slug}" (lowercase letters, digits, and dashes only).`);
    return { exitCode: 2, written: [] };
  }

  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();

  // Resolve the launch shape from the catalog.
  let server: Awaited<ReturnType<typeof resolveCatalogSlug>>;
  try {
    server = await resolveCatalogSlug(slug, {
      catalogUrl: opts.catalogUrl ?? env.YAW_MCP_CATALOG_URL,
      fetchCatalog: opts.fetchCatalog,
    });
  } catch (e) {
    printErr(`yaw-mcp add: ${(e as Error).message}`);
    return { exitCode: 1, written: [] };
  }

  // Derive the namespace from the resolved catalog NAME via the same algorithm
  // the Yaw Terminal app uses, NOT from the slug -- so the same server lands
  // under the same namespace whether added here or via the app's one-click /
  // "Add to Yaw MCP" badge. (deriveNamespace always returns a valid namespace.)
  const namespace = deriveNamespace(server.name);

  // Required-env gate: refuse with a re-run hint when a required var has no
  // value in --env or the shell. Same posture as `yaw-mcp try` so the two
  // commands behave alike. (The GUI provides the richer fill-in-the-blank UX.)
  const supplied = { ...env, ...(opts.envOverrides ?? {}) } as Record<string, string | undefined>;
  const missing = server.requiredEnvKeys.filter((k) => !supplied[k] || supplied[k] === "");
  if (missing.length > 0) {
    printErr(`yaw-mcp add: ${server.name} needs the following env var(s) before it can run:`);
    for (const k of missing) printErr(`  - ${k}`);
    printErr("");
    printErr("Provide them with --env KEY=value (repeatable) or your shell, then re-run:");
    printErr(`  yaw-mcp add ${slug} ${missing.map((k) => `--env ${k}=...`).join(" ")}`);
    if (server.docUrl) printErr(`Docs: ${server.docUrl}`);
    return { exitCode: 1, written: [] };
  }

  // Seed required keys EMPTY and persist a VALUE only when the user passed it
  // explicitly via --env. yaw-mcp inherits the ambient shell env when it spawns
  // the upstream (upstream.ts), so a shell-resident secret reaches the server
  // at runtime WITHOUT being copied to disk -- matching the app's one-click
  // posture ("env values are not pulled from your shell") and avoiding writing
  // an ambient secret into bundles.json the user never asked to persist.
  const entryEnv: Record<string, string> = {};
  for (const k of server.requiredEnvKeys) entryEnv[k] = "";
  for (const [k, v] of Object.entries(opts.envOverrides ?? {})) entryEnv[k] = v;

  const entry: Partial<UpstreamServerConfig> = {
    id: `local-${namespace}`,
    name: server.name,
    namespace,
    type: "local",
    transport: "stdio",
    command: server.command,
    args: server.args,
    env: Object.keys(entryEnv).length > 0 ? entryEnv : undefined,
    isActive: true,
    description: server.description,
  };

  if (opts.dryRun) {
    if (opts.json) {
      // Same wrapper shape as the real add below, with dryRun:true, so a
      // script parsing `add --json` sees one consistent shape either way.
      print(JSON.stringify({ ok: true, dryRun: true, namespace, entry }, null, 2));
    } else {
      print(`yaw-mcp add (dry-run): would write ${server.name} as namespace "${namespace}"`);
      print(`  command: ${entry.command} ${(entry.args ?? []).join(" ")}`);
      if (entry.env) print(`  env keys: ${Object.keys(entry.env).join(", ")}`);
    }
    return { exitCode: 0, written: [] };
  }

  let res: Awaited<ReturnType<typeof upsertUserBundle>>;
  try {
    res = await upsertUserBundle(entry, { home });
  } catch (e) {
    printErr(`yaw-mcp add: ${(e as Error).message}`);
    return { exitCode: 1, written: [] };
  }

  if (opts.json) {
    print(JSON.stringify({ ok: true, namespace, path: res.path, replaced: res.replaced, entry }, null, 2));
  } else {
    print(`${res.replaced ? "Updated" : "Added"} ${server.name} (namespace "${namespace}") in ${res.path}`);
    print("Restart your MCP client (or yaw-mcp) to pick it up.");
  }

  // Honest warning: a project-local bundles.json shadows the user-global file.
  // Goes to stderr, so it surfaces even under --json without corrupting the
  // JSON on stdout that a script is parsing.
  const shadow = await findShadowingProjectBundles(cwd, home).catch(() => null);
  if (shadow) {
    printErr(
      `Note: ${shadow} overrides your user-global bundles.json, so this entry won't load until you add it there or remove that file.`,
    );
  }
  return { exitCode: 0, written: [res.path] };
}

// --- remove -----------------------------------------------------------------

export const REMOVE_USAGE = `Usage: yaw-mcp remove <slug-or-namespace>

  Remove a server from your local ~/.yaw-mcp/bundles.json. Accepts either the
  catalog slug it was added with (e.g. "brave-search") or its namespace as
  shown by \`yaw-mcp list\` (e.g. "bravesearch"). No-op if it isn't present.`;

// slug (dashes) or namespace (underscores) shape -- the two forms a user might
// pass to remove.
const REMOVE_TARGET_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface RemoveCommandOptions {
  target?: string;
  home?: string;
  cwd?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export function parseRemoveArgs(
  argv: string[],
): { ok: true; options: RemoveCommandOptions } | { ok: false; error: string } {
  if (argv.length === 0) return { ok: false, error: REMOVE_USAGE };
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { ok: false, error: REMOVE_USAGE };
    if (a.startsWith("--")) return { ok: false, error: `Unknown flag: ${a}\n${REMOVE_USAGE}` };
    positional.push(a);
  }
  if (positional.length !== 1) {
    return { ok: false, error: `Expected exactly one slug or namespace.\n${REMOVE_USAGE}` };
  }
  return { ok: true, options: { target: positional[0] } };
}

export async function runRemove(opts: RemoveCommandOptions): Promise<AddCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  if (!opts.target) {
    printErr(REMOVE_USAGE);
    return { exitCode: 2, written: [] };
  }
  if (!REMOVE_TARGET_RE.test(opts.target)) {
    printErr(`yaw-mcp remove: "${opts.target}" isn't a valid slug or namespace.`);
    return { exitCode: 2, written: [] };
  }
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();

  // Try the literal target first -- covers a namespace copied from `list`
  // (including legacy underscore namespaces from older `add` versions). On a
  // miss, try its derived form so passing the catalog SLUG also works
  // ("brave-search" -> "bravesearch"). deriveNamespace strips non-alphanumerics,
  // so it would mangle an underscore namespace; that's why the literal goes first.
  const derived = deriveNamespace(opts.target);
  const candidates = derived === opts.target ? [opts.target] : [opts.target, derived];

  let res: Awaited<ReturnType<typeof removeUserBundle>> | null = null;
  let matched = "";
  try {
    for (const ns of candidates) {
      res = await removeUserBundle(ns, { home });
      if (res.removed) {
        matched = ns;
        break;
      }
    }
  } catch (e) {
    printErr(`yaw-mcp remove: ${(e as Error).message}`);
    return { exitCode: 1, written: [] };
  }

  if (!res || !res.removed) {
    // No-op exits 0 (like try-cleanup): "make it absent" succeeded.
    print(`yaw-mcp remove: no server matching "${opts.target}" in ${res?.path ?? "bundles.json"} (nothing to do).`);
    // `list` reads the project-local bundles.json when present (it overrides
    // user-global), but `remove` only manages user-global -- so a server the
    // user just saw in `list` can be "not found" here. Explain when that's why.
    const shadow = await findShadowingProjectBundles(cwd, home).catch(() => null);
    if (shadow) {
      printErr(
        `Note: a project-local ${shadow} is in effect; \`remove\` only manages your user-global bundles.json, so a server defined there must be removed from that file directly.`,
      );
    }
    return { exitCode: 0, written: [] };
  }
  print(`Removed "${matched}" from ${res.path}. Restart your MCP client to apply.`);

  // Honest warning: a project-local bundles.json shadows the user-global file,
  // so the server may keep loading from there even after this removal.
  const shadow = await findShadowingProjectBundles(cwd, home).catch(() => null);
  if (shadow) {
    printErr(
      `Note: ${shadow} shadows your user-global bundles.json; a server defined there is unaffected by this removal.`,
    );
  }
  return { exitCode: 0, written: [res.path] };
}

// --- list -------------------------------------------------------------------

export const LIST_USAGE = `Usage: yaw-mcp list [--json]

  List the MCP servers yaw-mcp loads locally from bundles.json (the
  project-local file wins over user-global). --json for machine output.`;

export interface ListCommandOptions {
  json?: boolean;
  home?: string;
  cwd?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export function parseListArgs(
  argv: string[],
): { ok: true; options: ListCommandOptions } | { ok: false; error: string } {
  const opts: ListCommandOptions = {};
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { ok: false, error: LIST_USAGE };
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    return { ok: false, error: `Unknown argument: ${a}\n${LIST_USAGE}` };
  }
  return { ok: true, options: opts };
}

export async function runList(opts: ListCommandOptions): Promise<AddCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const print = (s = ""): void => out(`${s}\n`);

  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const loaded = await loadLocalBundles({ home, cwd });
  const servers = loaded.config?.servers ?? [];

  if (opts.json) {
    print(JSON.stringify({ path: loaded.path, servers }, null, 2));
    return { exitCode: 0, written: [] };
  }

  if (servers.length === 0) {
    print("No local servers configured. Add one with `yaw-mcp add <slug>`");
    print("(browse the catalog at https://yaw.sh/mcp/catalog/).");
    return { exitCode: 0, written: [] };
  }

  const rows = [...servers].sort((a, b) => a.namespace.localeCompare(b.namespace));
  const cols: Array<[string, (s: UpstreamServerConfig) => string]> = [
    ["NAMESPACE", (s) => s.namespace],
    ["NAME", (s) => s.name],
    ["STATUS", (s) => (s.isActive ? "active" : "disabled")],
    ["LAUNCH", (s) => [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || s.url || ""],
  ];
  const widths = cols.map(([h, get]) => Math.max(h.length, ...rows.map((r) => get(r).length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  print(fmt(cols.map(([h]) => h)));
  for (const r of rows) print(fmt(cols.map(([, get]) => get(r))));
  if (loaded.path) print(`\n${servers.length} server${servers.length === 1 ? "" : "s"} in ${loaded.path}`);
  return { exitCode: 0, written: [] };
}
