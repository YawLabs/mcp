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
//   list           show the servers yaw-mcp would load locally, each with the
//                  compliance grade `yaw-mcp audit` last cached for it
//
// `add` resolves through the same static catalog the website and the Yaw
// Terminal app use (catalog.ts), so a slug that works as an "Add to Yaw MCP"
// button works here too.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { type FetchCatalog, resolveCatalogSlug } from "./catalog.js";
import { type GradesCache, readGradesCache } from "./grades-cache.js";
// The removal gate must see the same files the WRITE path can modify, so it
// parses with the loader's JSONC parser (comments + trailing commas) rather
// than a stricter JSON.parse. See findRemovalTarget.
import { parseJsonc } from "./jsonc.js";
import {
  deriveNamespace,
  findShadowingProjectBundles,
  loadLocalBundles,
  localBundlesPath,
  removeUserBundle,
  upsertUserBundle,
} from "./local-bundles.js";
import { userConfigDir } from "./paths.js";
// The removal preview renders command / args / url / name straight out of
// bundles.json immediately above a [y/N] prompt, so it needs the same
// control-byte neutering the `trust` gate uses. IMPORTED, never re-spelled:
// a second hand-rolled copy of that escape logic would drift from the one
// trust-cmd's tests actually cover.
import { displayArg, displaySafe } from "./trust-cmd.js";
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
  if (!v?.includes("=")) return "--env requires KEY=value";
  const eq = v.indexOf("=");
  const key = v.slice(0, eq);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `--env: invalid KEY "${key}"`;
  bag[key] = v.slice(eq + 1);
  return null;
}

export function parseAddArgs(
  argv: string[],
): { ok: true; options: AddCommandOptions } | { ok: false; error: string; help?: boolean } {
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
        // Reject a following flag (e.g. `add slug --catalog --dry-run`, which
        // would otherwise set catalogUrl="--dry-run" and drop the flag). A URL
        // never starts with "--".
        if (!v || v.startsWith("--")) return { ok: false, error: "--catalog requires a URL" };
        opts.catalogUrl = v;
        break;
      }
      case "-h":
      case "--help":
        return { ok: false, error: ADD_USAGE, help: true };
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
  // Trim before the emptiness test so a whitespace-only value (FOO=" ") counts
  // as missing instead of slipping through and persisting a blank-ish secret to
  // bundles.json -- matching try-cmd.ts:465.
  const missing = server.requiredEnvKeys.filter((k) => (supplied[k] ?? "").trim() === "");
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
  // Trim each --env value before persisting: a whitespace-only value is treated
  // as missing (a required key stays seeded EMPTY; a non-required key is skipped
  // entirely) so it never lands as a blank-ish secret in bundles.json --
  // consistent with the trimmed required-env gate above.
  for (const [k, v] of Object.entries(opts.envOverrides ?? {})) {
    const trimmed = v.trim();
    if (trimmed === "") continue;
    entryEnv[k] = trimmed;
  }

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

  // Report the entry AS WRITTEN, not the one built above: an update folds onto
  // whatever was already on disk (env values, an explicit isActive:false, a
  // per-server runtime override -- see mergeServerEntry), so the pre-merge
  // object would describe a file that doesn't exist.
  const written = res.entry;

  if (opts.json) {
    print(JSON.stringify({ ok: true, namespace, path: res.path, replaced: res.replaced, entry: written }, null, 2));
  } else {
    print(`${res.replaced ? "Updated" : "Added"} ${server.name} (namespace "${namespace}") in ${res.path}`);
    // A re-add folds onto a stored `"isActive": false` instead of silently
    // re-enabling it (mergeServerEntry rule 3). That is deliberate, but it
    // makes the usual "restart to pick it up" line WRONG: a disabled entry
    // never loads, so the user restarts, sees nothing, and has no reason to
    // suspect the file. There is no `enable` verb to point at, so name the
    // edit that actually turns it on.
    if (written.isActive === false) {
      print(
        `Note: this entry is "isActive": false in ${res.path}, so it stays disabled and will NOT load. Set it to true there to enable it.`,
      );
    } else {
      print("Restart your MCP client (or yaw-mcp) to pick it up.");
    }
  }

  // Required keys that passed the gate but landed on disk EMPTY: the value came
  // from the ambient shell (not --env) and was deliberately not persisted, so
  // the server depends on that shell var still being set wherever yaw-mcp
  // launches. Computed from the WRITTEN entry rather than from the flags, so a
  // re-add over an entry that already carries a stored value stays quiet
  // instead of claiming nothing was persisted. Warned on stderr so it survives
  // --json.
  const writtenEnv = (written.env ?? {}) as Record<string, string>;
  const ambientOnlyRequired = server.requiredEnvKeys.filter(
    (k) => (writtenEnv[k] ?? "").trim() === "" && (env[k] ?? "").trim() !== "",
  );
  if (ambientOnlyRequired.length > 0) {
    printErr(
      `Note: ${ambientOnlyRequired.join(", ")} ${
        ambientOnlyRequired.length === 1 ? "was" : "were"
      } read from your shell env and NOT persisted; the server depends on ${
        ambientOnlyRequired.length === 1 ? "that var" : "those vars"
      } being present wherever yaw-mcp launches. Pass --env ${ambientOnlyRequired[0]}=... to persist a value.`,
    );
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

export const REMOVE_USAGE = `Usage: yaw-mcp remove <slug-or-namespace> [--force]

  Remove a server from your local ~/.yaw-mcp/bundles.json. Accepts either the
  catalog slug it was added with (e.g. "brave-search") or its namespace as
  shown by \`yaw-mcp list\` (e.g. "bravesearch"). No-op if it isn't present.

  Dropping an entry also drops any env value stored on it, so when there IS
  something to remove you are shown the server -- namespace, name, and the
  command or url it launches -- and asked to confirm. A bare Enter is NO.

  --force, -y, --yes  Skip the confirmation. Required when stdin or stdout
                      is not a TTY (there is nothing to ask on).`;

// slug (dashes) or namespace (underscores) shape -- the two forms a user might
// pass to remove.
const REMOVE_TARGET_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface RemoveCommandOptions {
  target?: string;
  /** Skip the destructive-action confirmation. Required off a TTY. */
  force?: boolean;
  home?: string;
  cwd?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test hook: override the TTY verdict instead of reading process.std*. */
  isTTY?: boolean;
  /** Test hook: answer the confirmation without a real TTY read. */
  promptAnswer?: string;
  /** Test hook: replaces process.stdin/stdout for the interactive prompt. */
  io?: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream };
}

export function parseRemoveArgs(
  argv: string[],
): { ok: true; options: RemoveCommandOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: REMOVE_USAGE };
  const positional: string[] = [];
  const opts: RemoveCommandOptions = {};
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { ok: false, error: REMOVE_USAGE, help: true };
    // --force is the name `secrets remove` uses; -y / --yes is the name `trust`
    // uses. Both siblings gate a destructive write, so both spellings are
    // accepted here rather than making the user remember which verb took which.
    if (a === "--force" || a === "--yes" || a === "-y") {
      opts.force = true;
      continue;
    }
    // Single dash included, not just "--": now that -y is a real flag, a
    // mistyped short flag must be reported as an unknown flag instead of
    // becoming the removal TARGET. (No valid target starts with "-";
    // REMOVE_TARGET_RE requires a leading alphanumeric.)
    if (a.startsWith("-")) return { ok: false, error: `Unknown flag: ${a}\n${REMOVE_USAGE}` };
    positional.push(a);
  }
  if (positional.length !== 1) {
    return { ok: false, error: `Expected exactly one slug or namespace.\n${REMOVE_USAGE}` };
  }
  opts.target = positional[0];
  return { ok: true, options: opts };
}

// --- removal confirmation ---------------------------------------------------
//
// `remove` was the only destructive verb in the CLI with no gate: it deleted
// the entry on a TTY and off it alike. It now follows the idiom its siblings
// already set -- `secrets remove` (confirm on a TTY, refuse off one without
// --force) and `trust` (isTTY + promptAnswer test hooks, bare Enter = NO).
//
// The gate fires ONLY when something is actually going to be deleted. A target
// that isn't in the file, or no file at all, stays the exit-0 "nothing to do"
// no-op it has always been -- refusing to no-op off a TTY would break cleanup
// scripts for no safety gain.

/** Enough of the doomed entry to show the user WHAT they are dropping. A slug
 *  alone would teach them to hit `y` without reading. */
interface RemovalTarget {
  namespace: string;
  name: string;
  /** Rendered launch line ("$ npx -y pkg" / "HTTP https://...") . */
  launch: string;
  /** env KEY names only -- never values; bundles.json env can hold secrets. */
  envKeys: string[];
}

/**
 * Which candidate namespace is really present in the user-global bundles.json,
 * plus the fields the preview renders. Null when there is nothing to confirm:
 * no file, no match, or a file this lookup could not read or parse.
 *
 * PARSE WITH THE WRITE PATH'S PARSER. parseJsonc is what readBundlesAt (and so
 * removeUserBundle) uses, and it accepts `//` comments and trailing commas.
 * Gating on the stricter JSON.parse instead meant a bundles.json carrying one
 * hand-added `// prod token lives in 1Password` line looked malformed HERE
 * while the write path parsed and deleted from it happily -- so the preview,
 * the off-TTY refusal AND the [y/N] prompt were all skipped on exactly the
 * hand-edited files most likely to hold a stored secret. The two parsers must
 * see the same set of files or the gate does not cover the write.
 *
 * A null return skips the gate, which is safe because the two shapes behind it
 * end differently in runRemove: a genuine miss stays the exit-0 "nothing to do"
 * no-op it has always been, while an unreadable / malformed file reaches
 * removeUserBundle, whose readRawUserBundles THROWS rather than clobber a file
 * it could not parse -- surfacing the same error `remove` has always printed
 * instead of a bogus "nothing to remove". There is deliberately no
 * found/uncertain distinction in the return value: nothing ever consumed it,
 * and a flag no caller reads documents an invariant nothing enforces.
 *
 * Matching is done on the RAW parsed servers, deliberately NOT through
 * previewBundlesContent: that runs validateEntry, which DROPS malformed
 * entries, while removeUserBundle filters raw entries by namespace string. An
 * entry validateEntry rejects is still one removeUserBundle deletes, so a
 * validated lookup would let it be deleted with no confirmation at all.
 */
async function findRemovalTarget(candidates: string[], home: string): Promise<RemovalTarget | null> {
  const path = localBundlesPath(userConfigDir(home));
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const servers = (parsed as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return null;

  for (const ns of candidates) {
    // Same predicate as doRemoveUserBundle's filter (s?.namespace !== ns), so
    // the preview can never disagree with what the write actually deletes.
    const hit = servers.find((s) => (s as { namespace?: unknown } | null)?.namespace === ns) as Record<
      string,
      unknown
    > | null;
    if (!hit) continue;
    const name = typeof hit.name === "string" && hit.name.length > 0 ? hit.name : "(unnamed)";
    const env = typeof hit.env === "object" && hit.env !== null ? (hit.env as Record<string, unknown>) : {};
    return { namespace: ns, name, launch: renderLaunch(hit), envKeys: Object.keys(env) };
  }
  return null;
}

/** How the entry would be launched, as one reviewable line. Mirrors
 *  trust-cmd's renderLaunch, but reads an UNVALIDATED raw entry (see
 *  findRemovalTarget) so every field is type-checked before use. */
function renderLaunch(entry: Record<string, unknown>): string {
  const command = typeof entry.command === "string" ? entry.command : "";
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
  const parts = [command, ...args].filter((p) => p.length > 0);
  // Args containing whitespace or quotes are quoted, so `sh -c "curl ... | sh"`
  // reads as the single argument it really is instead of blending into the line.
  if (parts.length > 0) return `$ ${parts.map(displayArg).join(" ")}`;
  const url = typeof entry.url === "string" ? entry.url : "";
  return url.length > 0 ? `HTTP ${displaySafe(url)}` : "(no command)";
}

/** Render the doomed entry. Shared by the TTY prompt and the off-TTY refusal:
 *  a scripted run gets to see what it WOULD have removed before being told
 *  which flag to re-run with (same courtesy as `yaw-mcp trust`). */
function printRemovalPreview(print: (s?: string) => void, path: string, t: RemovalTarget): void {
  print("");
  print(`  Remove from ${displaySafe(path)}:`);
  print("");
  print(`    namespace: ${t.namespace}`);
  print(`    name:      ${displaySafe(t.name)}`);
  print(`    launch:    ${t.launch}`);
  if (t.envKeys.length > 0) print(`    env keys:  ${t.envKeys.map(displayArg).join(", ")}`);
  print("");
  print("  yaw-mcp will stop loading it. Any env value stored on the entry goes");
  print("  with it -- re-adding the server will not bring those values back.");
  print("");
}

/** Both ends must be a TTY: stdin to read the answer, stdout to show the
 *  question. Mirrors trust-cmd.ts:isInteractive. */
function isInteractive(opts: RemoveCommandOptions): boolean {
  if (opts.isTTY !== undefined) return opts.isTTY;
  if (opts.promptAnswer !== undefined) return true;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Ask the confirmation. Defaults to NO -- only an explicit y/yes proceeds, so
 *  a bare Enter (or ^D, or a stray keystroke) leaves bundles.json untouched. */
async function askYesNo(opts: RemoveCommandOptions, question: string): Promise<string> {
  if (opts.promptAnswer !== undefined) return opts.promptAnswer.trim().toLowerCase();
  const input = opts.io?.stdin ?? process.stdin;
  const output = opts.io?.stdout ?? process.stdout;
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
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

  // ----- destructive-action confirmation --------------------------------
  // Gated on there being something to delete (see findRemovalTarget): a miss
  // or an unreadable/malformed file skips straight to the loop below, which
  // keeps the exit-0 no-op and the existing parse-error message intact.
  //
  // The preview is not re-checked after the answer the way `trust` re-hashes
  // the file it is approving. That check exists there because approval grants
  // EXECUTION authority to content a repo controls; here the file is the
  // user's own, the write below re-reads it anyway, and the worst case of a
  // concurrent edit is an entry `yaw-mcp add` puts straight back.
  if (!opts.force) {
    const doomed = await findRemovalTarget(candidates, home);
    if (doomed) {
      printRemovalPreview(print, localBundlesPath(userConfigDir(home)), doomed);
      if (!isInteractive(opts)) {
        // Exit 2, matching `secrets remove`'s off-TTY refusal: a required flag
        // is missing, which is this CLI's usage-error code. (A DECLINED prompt
        // is exit 1 below -- the argv was fine, the user said no.)
        printErr(
          `yaw-mcp remove: refusing to remove "${doomed.namespace}" without a confirmation -- stdin/stdout is not a TTY.`,
        );
        printErr("  Re-run with --force (or -y) to remove it.");
        return { exitCode: 2, written: [] };
      }
      const answer = await askYesNo(opts, `  Remove "${doomed.namespace}"? [y/N] `);
      if (answer !== "y" && answer !== "yes") {
        printErr("yaw-mcp remove: Aborted. Nothing was removed.");
        return { exitCode: 1, written: [] };
      }
    }
  }

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

  if (!res?.removed) {
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
  project-local file wins over user-global), with the compliance grade
  \`yaw-mcp audit\` last cached for each. --json for machine output.`;

export interface ListCommandOptions {
  json?: boolean;
  home?: string;
  cwd?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test hook: supply a grade cache instead of reading ~/.yaw-mcp/grades.json. */
  gradesReader?: (home?: string) => Promise<GradesCache>;
}

export function parseListArgs(
  argv: string[],
): { ok: true; options: ListCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: ListCommandOptions = {};
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { ok: false, error: LIST_USAGE, help: true };
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
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const loaded = await loadLocalBundles({ home, cwd });
  const servers = loaded.config?.servers ?? [];

  // Always surface load warnings so malformed-file problems aren't silently
  // swallowed. In --json mode they go into the response body; in text mode
  // they go to stderr before the listing/empty-state so a script can still
  // parse stdout cleanly while a human sees the diagnostic.
  for (const w of loaded.warnings) printErr(`warning: ${w}`);

  // Overlay the compliance grades `yaw-mcp audit` cached in ~/.yaw-mcp/
  // grades.json. This is the ONLY reader of that cache in local mode -- without
  // it, `audit` would be write-only and the grade would never reach a human.
  // bundles.json entries never carry a grade of their own (validateEntry drops
  // unknown fields), so the cache is the sole source; the `?? s.complianceGrade`
  // fallback keeps any future in-file grade rather than blanking it. Applied to
  // BOTH --json and the table so the two surfaces agree. readGradesCache never
  // throws -- a missing or garbled cache just means no overlay.
  const gradesReader = opts.gradesReader ?? readGradesCache;
  const grades = await gradesReader(home).catch(() => ({}) as GradesCache);
  const graded: UpstreamServerConfig[] = servers.map((s) => {
    const cached = grades[s.namespace];
    return cached ? { ...s, complianceGrade: cached.grade } : s;
  });

  if (opts.json) {
    print(JSON.stringify({ path: loaded.path, servers: graded, warnings: loaded.warnings }, null, 2));
    return { exitCode: 0, written: [] };
  }

  if (servers.length === 0) {
    print("No local servers configured. Add one with `yaw-mcp add <slug>`");
    print("(browse the catalog at https://yaw.sh/mcp/catalog/).");
    return { exitCode: 0, written: [] };
  }

  const rows = [...graded].sort((a, b) => a.namespace.localeCompare(b.namespace));
  const cols: Array<[string, (s: UpstreamServerConfig) => string]> = [
    ["NAMESPACE", (s) => s.namespace],
    ["NAME", (s) => s.name],
    ["STATUS", (s) => (s.isActive ? "active" : "disabled")],
    // "-" for never-audited, matching the GRADE column this ported from.
    // LAUNCH stays last: it's the only variable-width cell, so anything after
    // it would be ragged.
    ["GRADE", (s) => s.complianceGrade ?? "-"],
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
