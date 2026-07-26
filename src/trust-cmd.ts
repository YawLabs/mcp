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
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { previewBundlesContent, probeProjectTrust } from "./local-bundles.js";
import {
  grantTrust,
  hashTrustContent,
  listTrusted,
  readTrustStore,
  revokeTrust,
  TRUST_BYPASS_ENV,
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
  contents: if the file changes, it needs approving again.

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
        ? `yaw-mcp trust: no .yaw-mcp/ directory found by walking up from ${cwd}. There is no project bundles.json to approve; your user-global ~/.yaw-mcp/bundles.json is always loaded.`
        : `yaw-mcp trust: no project bundles.json at ${probe.path}. Nothing to approve.`,
    );
    return { exitCode: 1 };
  }
  if (probe.status === "unreadable") {
    printErr(`yaw-mcp trust: cannot read ${probe.path} (${probe.error}). Fix the permissions, then re-run.`);
    return { exitCode: 1 };
  }

  const path = probe.path as string;
  const raw = probe.raw as Buffer;

  if (probe.status === "trusted") {
    print(`Already approved: ${path}`);
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
    printErr(`yaw-mcp trust: ${path} is not a usable bundles.json, so there is nothing to review:`);
    for (const w of preview.warnings) printErr(`  ! ${w}`);
    printErr("Fix the file, then re-run `yaw-mcp trust`.");
    return { exitCode: 1 };
  }

  print("");
  print(`  Project file: ${path}`);
  print(`  SHA-256:      ${probe.sha256}`);
  print(
    `  Status:       ${probe.status === "changed" ? "CHANGED since you approved it" : probe.status === "store-unreadable" ? `trust store unreadable (${probe.storePath})` : "never approved"}`,
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
      if (envKeys.length > 0) print(`       env: ${envKeys.join(", ")}`);
    }
  }
  for (const w of preview.warnings) print(`    ! ${w}`);
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
      `yaw-mcp trust: ${path} could not be re-read before approving (${(e as Error).message}). Nothing approved.`,
    );
    return { exitCode: 1 };
  }
  if (hashTrustContent(confirmBytes) !== probe.sha256) {
    printErr(
      `yaw-mcp trust: ${path} changed while you were reviewing it. Nothing approved -- re-run \`yaw-mcp trust\` to see the new contents.`,
    );
    return { exitCode: 1 };
  }

  const granted = await grantTrust(path, raw, { home, now: opts.now });
  if (granted.storeWasMalformed) {
    printErr(
      `Note: the previous trust store at ${granted.storePath} was unreadable and has been replaced -- any other project you had approved must be approved again.`,
    );
  }
  print(`Approved ${path}`);
  print(`  pinned to sha256 ${granted.record.sha256}`);
  print(`  recorded in ${granted.storePath}`);
  print("  Any later edit to the file re-requires approval.");
  print("Restart your MCP client (or yaw-mcp) to load it.");
  return { exitCode: 0 };
}

/** How a server would be launched, as one reviewable line. Args containing
 *  whitespace or quotes are JSON-quoted so `sh -c "curl ... | sh"` reads as
 *  the single argument it really is instead of blending into the line. */
function renderLaunch(s: UpstreamServerConfig): string {
  if (s.type === "remote" || (!s.command && s.url)) return `HTTP ${s.url ?? "(no url)"}`;
  const parts = [s.command ?? "", ...(s.args ?? [])].filter((p) => p.length > 0);
  if (parts.length === 0) return "(no command)";
  return `$ ${parts.map((p) => (/[\s"']/.test(p) ? JSON.stringify(p) : p)).join(" ")}`;
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
    const msg = `trust store unusable: ${store.malformedReason ?? "unknown"} -- NOTHING is trusted until it is fixed or deleted`;
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
    ["PATH", (r) => r.path],
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
      const msg = `no .yaw-mcp/ directory found by walking up from ${cwd}; pass an explicit path (see \`yaw-mcp trust --list\`)`;
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
    print(`yaw-mcp trust --revoke: ${target} was not approved (nothing to do).`);
    return { exitCode: 0 };
  }
  print(`Revoked ${target}`);
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
