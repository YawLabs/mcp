// `yaw-mcp trust` -- approve a project-local .yaw-mcp/bundles.json.
//
// The consent half of the gate in local-bundles.ts. yaw-mcp itself runs as
// an MCP *stdio* server with no TTY, so it can never ask "do you trust this
// repo?" at load time -- it can only consult a store. This command is where
// the asking happens, because the CLI DOES have a TTY.
//
// The central rule of this file: the user must SEE THE ARGV before they
// approve it. A consent prompt that only shows a path teaches the user to
// hit `y`, which is worse than no prompt at all -- so the grant path always
// renders every command + args (and env KEY NAMES, never values) that the
// file would spawn, derived through the SAME parse + validation the loader
// uses, and only then asks.
//
//   yaw-mcp trust                approve the project found from cwd
//   yaw-mcp trust --list         show approved projects (+ stale ones)
//   yaw-mcp trust --revoke [p]   withdraw approval
//
// Exit codes: 0 success, 1 refused / aborted / nothing to approve,
// 2 argv error (matching the sibling subcommands).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { previewBundlesContent, probeProjectTrust } from "./local-bundles.js";
import {
  grantTrust,
  hashTrustContent,
  listTrusted,
  readTrustStore,
  revokeTrust,
  TRUST_BYPASS_ENV,
  TrustStoreUnreadableError,
  trustStorePath,
} from "./trust.js";
import type { UpstreamServerConfig } from "./types.js";

export const TRUST_USAGE = `Usage: yaw-mcp trust [--yes]
       yaw-mcp trust --list [--json]
       yaw-mcp trust --revoke [<path>] [--json]

  Approve the project-local .yaw-mcp/bundles.json found by walking up from
  the current directory, so yaw-mcp will load it.

  A project bundles.json is normally committed to the repo, and every server
  in it is a command yaw-mcp SPAWNS AS YOU at startup. yaw-mcp therefore
  ignores an unapproved one (your user-global ~/.yaw-mcp/bundles.json still
  loads) until you approve it here. Approval is pinned to the file's exact
  contents: if the file changes, it needs approving again. The pin does NOT
  cover the code those commands run -- a script in the repo or an
  unversioned package can change without any edit to bundles.json.

  Your own ~/.yaw-mcp/bundles.json is never gated by this command.

  --yes, -y         Skip the confirmation prompt. Required when stdin or
                    stdout is not a TTY (there is nothing to ask on).
  --list            List approved project files. Any whose contents changed
                    since approval are flagged \`stale (content changed)\`.
  --revoke [<path>] Withdraw approval for <path>, or for the project found
                    from the current directory when <path> is omitted.
  --json            Machine-readable output for --list and --revoke.

  ${TRUST_BYPASS_ENV}=1 in the environment skips the check entirely
  (CI/automation only -- it lets any repo you run inside spawn commands
  as you).`;

export interface TrustCommandOptions {
  /** Defaults to "grant". */
  mode?: "grant" | "list" | "revoke";
  /** --revoke target; defaults to the project found from cwd. */
  path?: string;
  yes?: boolean;
  json?: boolean;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test hook: override the TTY verdict instead of reading process.std*. */
  isTTY?: boolean;
  /** Test hook: answer the confirmation without a real TTY read. */
  promptAnswer?: string;
  /** Test hook: fixed clock for the grantedAt stamp. */
  now?: () => number;
  /** Test hook: replaces process.stdin/stdout for the interactive prompt. */
  io?: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream };
}

export interface TrustCommandResult {
  exitCode: number;
}

export function parseTrustArgs(
  argv: string[],
): { ok: true; options: TrustCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: TrustCommandOptions = {};
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { ok: false, error: TRUST_USAGE, help: true };
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    if (a === "--yes" || a === "-y") {
      opts.yes = true;
      continue;
    }
    if (a === "--list") {
      if (opts.mode && opts.mode !== "list") {
        return { ok: false, error: `yaw-mcp trust: --list and --revoke are mutually exclusive\n\n${TRUST_USAGE}` };
      }
      opts.mode = "list";
      continue;
    }
    if (a === "--revoke") {
      if (opts.mode && opts.mode !== "revoke") {
        return { ok: false, error: `yaw-mcp trust: --list and --revoke are mutually exclusive\n\n${TRUST_USAGE}` };
      }
      opts.mode = "revoke";
      continue;
    }
    if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp trust: unknown flag "${a}"\n\n${TRUST_USAGE}` };
    }
    positional.push(a);
  }
  if (positional.length > 1) {
    return { ok: false, error: `yaw-mcp trust: expected at most one path\n\n${TRUST_USAGE}` };
  }
  if (positional.length === 1) {
    // A bare path only means something for --revoke. Grant deliberately has
    // no path argument: you approve the project you are standing in, after
    // reading its commands -- not one named from memory.
    if (opts.mode !== "revoke") {
      return {
        ok: false,
        error: `yaw-mcp trust: unexpected argument "${positional[0]}" (a path is only accepted with --revoke)\n\n${TRUST_USAGE}`,
      };
    }
    opts.path = positional[0];
  }
  opts.mode = opts.mode ?? "grant";
  return { ok: true, options: opts };
}

export async function runTrust(opts: TrustCommandOptions = {}): Promise<TrustCommandResult> {
  const mode = opts.mode ?? "grant";
  if (mode === "list") return runTrustList(opts);
  if (mode === "revoke") return runTrustRevoke(opts);
  return runTrustGrant(opts);
}

// --- grant ------------------------------------------------------------------

async function runTrustGrant(opts: TrustCommandOptions): Promise<TrustCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const probe = await probeProjectTrust({ cwd, home, env });

  if (probe.status === "none") {
    printErr(
      probe.path === null
        ? `yaw-mcp trust: no .yaw-mcp/ directory found by walking up from ${displaySafe(cwd)}. There is no project bundles.json to approve; your user-global ~/.yaw-mcp/bundles.json is always loaded.`
        : `yaw-mcp trust: no project bundles.json at ${displaySafe(probe.path)}. Nothing to approve.`,
    );
    return { exitCode: 1 };
  }
  if (probe.status === "unreadable") {
    printErr(
      `yaw-mcp trust: cannot read ${displaySafe(probe.path ?? "")} (${probe.error}). Fix the permissions, then re-run.`,
    );
    return { exitCode: 1 };
  }

  const path = probe.path as string;
  const raw = probe.raw as Buffer;

  if (probe.status === "trusted") {
    print(`Already approved: ${displaySafe(path)}`);
    print(`  contents unchanged since approval (sha256 ${probe.sha256}) -- nothing to do.`);
    return { exitCode: 0 };
  }

  // Refuse to approve a file we cannot show the user. Trusting an
  // unparseable file is the worst of both worlds: it spawns nothing, but it
  // DOES commit the loader to the project location and shadow the
  // user-global file (see loadLocalBundles), so it silently deletes the
  // user's real server list.
  const preview = previewBundlesContent(path, raw);
  if (!preview.ok) {
    printErr(`yaw-mcp trust: ${displaySafe(path)} is not a usable bundles.json, so there is nothing to review:`);
    for (const w of preview.warnings) printErr(`  ! ${displaySafe(w)}`);
    printErr("Fix the file, then re-run `yaw-mcp trust`.");
    return { exitCode: 1 };
  }

  print("");
  print(`  Project file: ${displaySafe(path)}`);
  print(`  SHA-256:      ${probe.sha256}`);
  print(
    `  Status:       ${probe.status === "changed" ? "CHANGED since you approved it" : probe.status === "store-unreadable" ? `trust store unreadable (${displaySafe(probe.storePath)})` : "never approved"}`,
  );
  print("");
  if (preview.servers.length === 0) {
    print("  This file defines no servers, so approving it spawns nothing. It");
    print("  WILL still take precedence over your user-global bundles.json,");
    print("  which means yaw-mcp would load no servers at all in this project.");
  } else {
    print("  Approving this file lets yaw-mcp SPAWN the following as you, every");
    print("  time an MCP client starts in this project:");
    print("");
    let n = 0;
    for (const s of preview.servers) {
      n += 1;
      print(`    ${n}. ${s.namespace}${s.isActive ? "" : "  (inactive)"}`);
      const launch = renderLaunch(s);
      print(`       ${launch}`);
      const envKeys = Object.keys(s.env ?? {});
      // Names only, never values -- bundles.json env can hold secrets, and
      // this output is meant to be pasted into a support thread.
      if (envKeys.length > 0) print(`       env: ${envKeys.map(displayArg).join(", ")}`);
      for (const gap of pinGaps(s)) print(`       ! ${gap}`);
    }
  }
  for (const w of preview.warnings) print(`    ! ${displaySafe(w)}`);
  print("");

  if (!opts.yes) {
    if (!isInteractive(opts)) {
      printErr(
        "yaw-mcp trust: refusing to approve without a confirmation -- stdin/stdout is not a TTY. Review the commands above, then re-run with --yes.",
      );
      return { exitCode: 1 };
    }
    const answer = await askYesNo(opts, "  Read every command above. Approve this file? [y/N] ");
    if (answer !== "y" && answer !== "yes") {
      printErr("yaw-mcp trust: Aborted. Nothing was approved.");
      return { exitCode: 1 };
    }
  }

  // Re-read the file and confirm it is byte-identical to what we just
  // showed. A prompt is an unbounded pause: without this, a repo could swap
  // bundles.json between the render and the grant and get a hash approved
  // for argv the user never saw.
  let confirmBytes: Buffer;
  try {
    confirmBytes = await readFile(path);
  } catch (e) {
    printErr(
      `yaw-mcp trust: ${displaySafe(path)} could not be re-read before approving (${(e as Error).message}). Nothing approved.`,
    );
    return { exitCode: 1 };
  }
  if (hashTrustContent(confirmBytes) !== probe.sha256) {
    printErr(
      `yaw-mcp trust: ${displaySafe(path)} changed while you were reviewing it. Nothing approved -- re-run \`yaw-mcp trust\` to see the new contents.`,
    );
    return { exitCode: 1 };
  }

  // A store we could not READ is refused rather than replaced -- the other
  // projects the user approved are still in that file (see trust.ts). Only a
  // store that would not PARSE gets rebuilt, and that is reported below.
  let granted: Awaited<ReturnType<typeof grantTrust>>;
  try {
    granted = await grantTrust(path, raw, { home, now: opts.now });
  } catch (e) {
    if (e instanceof TrustStoreUnreadableError) {
      printErr(
        `yaw-mcp trust: cannot read the trust store at ${displaySafe(e.storePath)}${e.code ? ` (${e.code})` : ""} -- ${e.reason}.`,
      );
      printErr(
        "Nothing was approved and the store was NOT touched: your existing approvals are still in that file. Fix its permissions (or close whatever is holding it open), then re-run `yaw-mcp trust`.",
      );
      return { exitCode: 1 };
    }
    throw e;
  }
  if (granted.storeWasMalformed) {
    printErr(
      `Note: the previous trust store at ${displaySafe(granted.storePath)} was not valid JSON and has been replaced -- any other project you had approved must be approved again.`,
    );
  }
  print(`Approved ${displaySafe(path)}`);
  print(`  pinned to sha256 ${granted.record.sha256}`);
  print(`  recorded in ${displaySafe(granted.storePath)}`);
  print("  PINNED: the exact bytes of that file -- any later edit to it re-requires approval.");
  print("  NOT PINNED: the code those commands actually run. Files inside this repo and");
  print("  packages fetched at spawn time can change with no edit to bundles.json, and so");
  print("  with no new prompt. Approving is trusting the repo, not just this one file.");
  print("Restart your MCP client (or yaw-mcp) to load it.");
  return { exitCode: 0 };
}

/** How a server would be launched, as one reviewable line. Args containing
 *  whitespace or quotes are JSON-quoted so `sh -c "curl ... | sh"` reads as
 *  the single argument it really is instead of blending into the line. */
function renderLaunch(s: UpstreamServerConfig): string {
  if (s.type === "remote" || (!s.command && s.url)) return `HTTP ${displaySafe(s.url ?? "(no url)")}`;
  const parts = [s.command ?? "", ...(s.args ?? [])].filter((p) => p.length > 0);
  if (parts.length === 0) return "(no command)";
  return `$ ${parts.map((p) => displayArg(p)).join(" ")}`;
}

// --- making the file's own strings safe to print ----------------------------
//
// Everything rendered above (command, args, env KEY names, url, the project
// path, the parser's warnings) comes out of a file a hostile repo controls,
// and it is written straight to a terminal immediately above a [y/N] prompt.
// Control bytes there are not cosmetic:
//
//   ESC [8m   turns the pen invisible, so `args: ["-c<ESC>[8m", "curl ...
//             | sh<ESC>[0m"]` renders as a bare `$ sh -c` with the payload
//             concealed in the same colour as the background;
//   ESC [3A ESC [J  moves the cursor up and erases -- the argv block the
//             user was told to read is gone before the prompt paints;
//   BS / CR   rewrite the line in place, so what is on screen is not what
//             is in the file.
//
// The gate's whole value is that the user SEES the argv being authorized, so
// anything the terminal ACTS on instead of PRINTING has to be turned into
// visible text first.

/**
 * Everything a terminal may act on rather than print: C0 (incl. ESC, BEL,
 * BS, CR), DEL, the C1 block (0x9b is CSI in its 8-bit form), and the bidi
 * overrides / isolates, which can visually reorder an argv without changing
 * a byte of it.
 */
const DISPLAY_CONTROL_SOURCE =
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]";
const DISPLAY_CONTROL_RE = new RegExp(DISPLAY_CONTROL_SOURCE);
const DISPLAY_CONTROL_RE_G = new RegExp(DISPLAY_CONTROL_SOURCE, "g");

/** JSON-quote, then escape by hand what JSON.stringify leaves raw. It only
 *  escapes code units below 0x20 (plus `"` and `\`), so DEL, the whole C1
 *  block and the bidi controls survive a JSON.stringify untouched and would
 *  reach the terminal intact. */
function quoteVisible(s: string): string {
  return JSON.stringify(s).replace(DISPLAY_CONTROL_RE_G, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * A string that is NOT argv -- a path, a url, a parser warning. Quoted only
 * when it carries something the terminal would act on. Whitespace alone does
 * not trigger it: `C:\Program Files\...` is an ordinary path, and quoting it
 * would double every backslash for no security gain.
 */
export function displaySafe(s: string): string {
  return DISPLAY_CONTROL_RE.test(s) ? quoteVisible(s) : s;
}

/**
 * One argv token or env key name. Quoted on whitespace and quote characters
 * too, so `sh -c "curl ... | sh"` reads as the single argument it really is
 * instead of blending into the rest of the line.
 */
export function displayArg(s: string): string {
  return /[\s"']/.test(s) || DISPLAY_CONTROL_RE.test(s) ? quoteVisible(s) : s;
}

// --- what the pin does NOT cover --------------------------------------------
//
// The SHA-256 pins bundles.json's bytes. It does not pin what those bytes
// POINT AT. Spawns inherit yaw-mcp's cwd, so an approved
// `{"command":"node","args":["scripts/mcp-server.js"]}` re-executes whatever
// that script contains TODAY -- a later commit rewriting it leaves
// bundles.json untouched, the hash still matches, and nothing re-prompts.
// Same for `npx -y pkg` with no version: the registry decides what runs.
//
// This is a heads-up line next to the entry, deliberately NOT a static
// analyzer. It fires on the two shapes that are unambiguous and stays quiet
// otherwise -- a false negative here costs nothing (the closing text already
// says the pin does not cover executed code), a false positive would train
// the user to ignore the line.

/** Extensions that mean "this token is a script the interpreter will read
 *  from disk", as opposed to a package name or a subcommand. */
const SCRIPT_EXT_RE = /\.(?:js|mjs|cjs|ts|mts|cts|py|rb|sh|bash|zsh|pl|php|lua|jar|bat|cmd|ps1|exe)$/i;

/** Tokens that resolve against the cwd -- i.e. inside the repo -- at spawn. */
function inRepoTokens(s: UpstreamServerConfig): string[] {
  const hits: string[] = [];
  const isLocalish = (t: string): boolean =>
    t.length > 0 && !/\s/.test(t) && !isAbsolute(t) && !t.includes("://") && !t.startsWith("-");
  const command = s.command ?? "";
  // A bare `node` resolves off PATH; `scripts/serve` or `./run.sh` does not.
  if (isLocalish(command) && (/^\.{1,2}[\\/]/.test(command) || /[\\/]/.test(command))) hits.push(command);
  for (const a of s.args ?? []) {
    // An explicit ./ or ../ is unambiguous; otherwise require a script
    // extension, so `@scope/pkg` and `owner/repo` are left alone.
    if (isLocalish(a) && (/^\.{1,2}[\\/]/.test(a) || SCRIPT_EXT_RE.test(a))) hits.push(a);
  }
  return hits;
}

/** Package runners whose first non-flag operand names something fetched at
 *  spawn time. `sub` is the subcommand that has to be present first. */
const REGISTRY_RUNNERS: Array<{ cmd: string; sub?: string }> = [
  { cmd: "npx" },
  { cmd: "bunx" },
  { cmd: "uvx" },
  { cmd: "pnpm", sub: "dlx" },
  { cmd: "npm", sub: "exec" },
  { cmd: "pipx", sub: "run" },
];

/** Flags that take no value, so the token after them is still the operand.
 *  Any OTHER flag makes us give up rather than guess which token is the
 *  package (`npx -p a -c b` must not report `b`). */
const VALUELESS_RUNNER_FLAGS = new Set([
  "-y",
  "--yes",
  "-q",
  "--quiet",
  "--silent",
  "--offline",
  "--prefer-offline",
  "--prefer-online",
  "--no-install",
  "--ignore-existing",
]);

/** The registry spec this entry would fetch, when it has no version pin. */
function unversionedRegistrySpec(s: UpstreamServerConfig): string | null {
  const base =
    (s.command ?? "")
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(?:exe|cmd|bat)$/i, "") ?? "";
  const runner = REGISTRY_RUNNERS.find((r) => r.cmd === base);
  if (!runner) return null;
  let rest = s.args ?? [];
  if (runner.sub) {
    if (rest[0] !== runner.sub) return null;
    rest = rest.slice(1);
  }
  let spec: string | null = null;
  for (const a of rest) {
    if (a.startsWith("-")) {
      if (VALUELESS_RUNNER_FLAGS.has(a)) continue;
      return null; // an unrecognised flag may consume the next token
    }
    spec = a;
    break;
  }
  if (spec === null || spec.length === 0) return null;
  // A local path / url / git ref is not a registry lookup (inRepoTokens or
  // the closing text covers those).
  if (spec.includes("://") || isAbsolute(spec) || /^\.{1,2}[\\/]/.test(spec)) return null;
  // Strip the scope sigil and the scope itself, then look for a version:
  // `@scope/pkg@1.2.3` and `pkg@1.2.3` are pinned, `pkg==1.2.3` is uv's form.
  const body = spec.startsWith("@") ? spec.slice(1) : spec;
  const afterScope = body.includes("/") ? body.slice(body.indexOf("/") + 1) : body;
  if (afterScope.includes("@") || afterScope.includes("==")) return null;
  return spec;
}

/** At most two lines naming content the SHA-256 does not cover. */
function pinGaps(s: UpstreamServerConfig): string[] {
  if (s.type === "remote" || (!s.command && s.url)) return [];
  const lines: string[] = [];
  const repo = inRepoTokens(s);
  if (repo.length > 0) {
    lines.push(
      `NOT covered by the pin: ${repo.slice(0, 3).map(displayArg).join(" ")} runs from inside this repo -- a later commit rewrites it with no re-approval.`,
    );
  }
  const spec = unversionedRegistrySpec(s);
  if (spec !== null) {
    lines.push(
      `NOT covered by the pin: ${displayArg(spec)} has no version -- it resolves to whatever the registry serves at spawn time.`,
    );
  }
  return lines;
}

// --- list -------------------------------------------------------------------

type ListStatus = "ok" | "stale (content changed)" | "missing (file not found)" | "unreadable";

async function runTrustList(opts: TrustCommandOptions): Promise<TrustCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const home = opts.home ?? homedir();

  const store = await readTrustStore(home);
  if (store.malformed) {
    // An unreadable store still HOLDS the grants -- telling the user to
    // delete it would throw away exactly what they are trying to inspect.
    const fix =
      store.malformedKind === "io"
        ? "fix its permissions (do NOT delete it -- your approvals are still in there)"
        : "it is fixed or deleted";
    const msg = `trust store unusable: ${store.malformedReason ?? "unknown"} -- NOTHING is trusted until ${fix}`;
    if (opts.json) {
      out(
        `${JSON.stringify({ storePath: trustStorePath(home), malformed: true, error: msg, trusted: [] }, null, 2)}\n`,
      );
    } else {
      err(`yaw-mcp trust: ${msg}\n`);
    }
    return { exitCode: opts.json ? 0 : 1 };
  }

  const records = await listTrusted({ home });
  const rows: Array<{ path: string; sha256: string; grantedAt: string; status: ListStatus }> = [];
  for (const r of records) {
    rows.push({ ...r, status: await classifyRecord(r.path, r.sha256) });
  }

  if (opts.json) {
    out(`${JSON.stringify({ storePath: trustStorePath(home), malformed: false, trusted: rows }, null, 2)}\n`);
    return { exitCode: 0 };
  }

  if (rows.length === 0) {
    print("No project bundles.json files are approved.");
    print("Run `yaw-mcp trust` from inside a project to approve its file.");
    return { exitCode: 0 };
  }

  const cols: Array<[string, (r: (typeof rows)[number]) => string]> = [
    // displaySafe, not the raw path: a repo directory name can legally carry
    // ESC on POSIX, and `trust --list` is the surface a user audits to decide
    // what to revoke -- rewriting it with cursor control defeats that. Column
    // widths stay consistent because they are measured from this same getter.
    // The --json branch above stays raw; its consumers want the real path and
    // JSON.stringify handles its own quoting.
    ["PATH", (r) => displaySafe(r.path)],
    ["APPROVED", (r) => (r.grantedAt.length > 0 ? r.grantedAt : "-")],
    ["STATUS", (r) => r.status],
  ];
  const widths = cols.map(([h, get]) => Math.max(h.length, ...rows.map((r) => get(r).length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  print(fmt(cols.map(([h]) => h)));
  for (const r of rows) print(fmt(cols.map(([, get]) => get(r))));
  print("");
  print(`${rows.length} approved in ${trustStorePath(home)}`);
  if (rows.some((r) => r.status !== "ok")) {
    print("A stale entry is NOT loaded -- re-run `yaw-mcp trust` from that project to re-approve.");
  }
  return { exitCode: 0 };
}

async function classifyRecord(path: string, sha256: string): Promise<ListStatus> {
  try {
    const raw = await readFile(path);
    return hashTrustContent(raw) === sha256 ? "ok" : "stale (content changed)";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "EISDIR" ? "missing (file not found)" : "unreadable";
  }
}

// --- revoke -----------------------------------------------------------------

async function runTrustRevoke(opts: TrustCommandOptions): Promise<TrustCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  let target: string;
  if (opts.path) {
    target = resolve(cwd, opts.path);
  } else {
    const probe = await probeProjectTrust({ cwd, home, env });
    if (probe.path === null) {
      const msg = `no .yaw-mcp/ directory found by walking up from ${displaySafe(cwd)}; pass an explicit path (see \`yaw-mcp trust --list\`)`;
      if (opts.json) out(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
      else printErr(`yaw-mcp trust --revoke: ${msg}`);
      return { exitCode: 1 };
    }
    target = probe.path;
  }

  const res = await revokeTrust(target, { home });
  if (res.storeWasMalformed) {
    const msg = `the trust store at ${res.storePath} is unreadable, so nothing is trusted and there was nothing to revoke`;
    if (opts.json) out(`${JSON.stringify({ ok: false, path: target, removed: false, error: msg }, null, 2)}\n`);
    else printErr(`yaw-mcp trust --revoke: ${msg}`);
    return { exitCode: 1 };
  }
  if (opts.json) {
    out(`${JSON.stringify({ ok: true, path: target, removed: res.removed, storePath: res.storePath }, null, 2)}\n`);
    return { exitCode: 0 };
  }
  // A no-op revoke exits 0: "make it not approved" is satisfied either way
  // (same posture as `yaw-mcp remove` and `try-cleanup`).
  if (!res.removed) {
    print(`yaw-mcp trust --revoke: ${displaySafe(target)} was not approved (nothing to do).`);
    return { exitCode: 0 };
  }
  // displaySafe on the human path only -- the --json branch above keeps the
  // raw target for consumers. A revoke target can come from an attacker-named
  // repo directory just like a grant target can.
  print(`Revoked ${displaySafe(target)}`);
  print(`  removed from ${res.storePath}`);
  print("Restart your MCP client (or yaw-mcp) to stop loading it.");
  return { exitCode: 0 };
}

// --- prompt -----------------------------------------------------------------

/** Both ends must be a TTY: stdin to read the answer, stdout to show the
 *  question. Mirrors secrets-cmd.ts:isInteractiveTTY. */
function isInteractive(opts: TrustCommandOptions): boolean {
  if (opts.isTTY !== undefined) return opts.isTTY;
  if (opts.promptAnswer !== undefined) return true;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Ask the confirmation. Defaults to NO -- only an explicit y/yes proceeds,
 *  so a bare Enter (or ^D, or a stray keystroke) leaves the file unapproved. */
async function askYesNo(opts: TrustCommandOptions, question: string): Promise<string> {
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
