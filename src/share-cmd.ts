// `yaw-mcp share <name>`: the one line a coworker pastes to install a git
// server (yaw-mcp add --git) you already run.
//
// Read-only, and it says nothing a coworker should not see: env VALUES never
// appear (a secret reference is printed as the reference, any other value as
// `<set this>`), and neither do local paths -- server arguments are counted,
// not shown, and a file:// repository is refused. Read access to the repo is
// the whole permission model; there is no sharing layer to publish to.
//
// The repo's yaw-mcp.json is optional and its absence is ordinary: whatever
// it does not declare (the name, --description, --subdir, --entry, --env) is
// spelled out as flags, and when it exists the note saying so is information,
// not a nudge.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CATALOG_SLUG_RE } from "./catalog.js";
import {
  GIT_MANIFEST_FILENAME,
  type GitManifest,
  type GitRefKind,
  type GitSpec,
  inferredEntry,
  normalizeRepoUrl,
  parseGitSpec,
  readBuildMarker,
  readGitManifest,
  readGitState,
  runGit,
} from "./git-source.js";
import { deriveNamespace } from "./local-bundles.js";
import { createStreamWriter } from "./logger.js";
import { GIT_BUILD_SHA_LEN, gitBuildDir } from "./paths.js";
import { pickGitEntry, type RawGitEntry, readTargetGitEntries } from "./update-cmd.js";

export const SHARE_USAGE = `Usage: yaw-mcp share <name> [--pin] [--project] [--json]

  Print the command coworkers paste to install a git server you added with
  yaw-mcp add --git. Anyone with read access to the repository can run it;
  nothing else is needed. Env values, vault contents and local paths are
  never printed: coworkers are told which secrets they will be asked for.

  It prints the ref the server tracks. Tracking a branch means each coworker
  gets whatever the branch points at when they run it; tag a release, or use
  --pin, so everyone runs the same code.

  --pin       Print the exact commit this machine runs instead of the ref.
  --project   Share an entry of the project's .yaw-mcp/bundles.json.
  --json      Print a JSON document.`;

export interface ShareCommandOptions {
  name?: string;
  pin?: boolean;
  project?: boolean;
  json?: boolean;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export function parseShareArgs(
  argv: string[],
): { ok: true; options: ShareCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: ShareCommandOptions = {};
  const usage = (msg: string): { ok: false; error: string } => ({
    ok: false,
    error: `yaw-mcp share: ${msg}\n\n${SHARE_USAGE}`,
  });
  for (const a of argv) {
    if (a === "--pin") opts.pin = true;
    else if (a === "--project") opts.project = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") return { ok: false, error: SHARE_USAGE, help: true };
    else if (a.startsWith("-")) return usage(`unknown flag "${a}"`);
    else if (opts.name !== undefined) return usage(`one server at a time; got "${opts.name}" and "${a}"`);
    else opts.name = a;
  }
  if (opts.name === undefined) return usage("name the server to share");
  return { ok: true, options: opts };
}

/** Quote a word for a POSIX shell (and PowerShell): bare when it is plainly
 *  safe, else in single quotes, which neither shell expands inside. */
function shellWord(w: string): string {
  if (/^[A-Za-z0-9._/:@#=+,-]+$/.test(w)) return w;
  return `'${w.replace(/'/g, `'"'"'`)}'`;
}

/** Forges whose ssh user is always "git", so any other ssh username in a URL
 *  for them is ignored rather than a reason not to convert. */
const WELL_KNOWN_FORGES = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

/** The URL in the other protocol, when it converts without guessing: an
 *  scp-form or ssh:// URL with user "git" (or none, or any user on a
 *  well-known forge) on the default port, or an https URL on the default port.
 *  An https bare username is dropped: the repo is the same without it. */
export function otherProtocolUrl(spec: GitSpec): string | null {
  if (spec.protocol === "file") return null;
  const forge = WELL_KNOWN_FORGES.has(spec.host);
  const sshUserOk = (user: string): boolean => user === "" || user === "git" || forge;
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec.url)) {
    const u = new URL(spec.url);
    if (u.password !== "") return null;
    if (spec.protocol === "https" && u.port !== "") return null;
    if (spec.protocol === "ssh" && u.port !== "" && u.port !== "22") return null;
    if (spec.protocol === "ssh" && !sshUserOk(u.username)) return null;
    host = u.hostname.toLowerCase();
    path = u.pathname.replace(/^\/+/, "");
  } else {
    if (!sshUserOk(spec.username ?? "")) return null;
    host = spec.host;
    path = spec.url.slice(spec.url.indexOf(":") + 1).replace(/^\/+/, "");
  }
  if (path === "" || path.startsWith("~") || !path.includes("/")) return null;
  return spec.protocol === "https" ? `git@${host}:${path}` : `https://${host}/${path}`;
}

/** Branch or tag, from what this machine already knows: the build's own clone
 *  (no network), else the last `update --check`. */
async function refKind(
  e: RawGitEntry,
  buildDir: string | null,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<GitRefKind | null> {
  const ref = e.git.ref;
  if (ref === undefined) return "branch";
  if (/^[0-9a-f]{4,40}$/i.test(ref) && e.git.commit?.startsWith(ref.toLowerCase())) return "sha";
  if (buildDir) {
    const ctx = { env, interactive: false };
    const has = async (name: string): Promise<boolean> =>
      (await runGit(["rev-parse", "--verify", "--quiet", name], ctx, buildDir)).code === 0;
    if (await has(`refs/tags/${ref}`)) return "tag";
    if (await has(`refs/remotes/origin/${ref}`)) return "branch";
  }
  const st = readGitState(home)[e.namespace];
  return st && normalizeRepoUrl(st.url) === normalizeRepoUrl(e.git.url) ? st.kind : null;
}

const SECRET_REF_RE = /^\$\{secret:([^}]+)\}$/;

interface ShareFlag {
  flag: string;
  words: string[];
  /** What the drift note names: the flag, or `--env KEY`. */
  label: string;
  /** "undeclared": yaw-mcp.json has no such field or key; "differs": it has
   *  one, and this entry's value is not it. */
  reason: "undeclared" | "differs";
}

/** The flags a coworker's command needs beyond `--git`: everything the
 *  repo's manifest (null: not readable here) does not already supply. */
function flagsFor(e: RawGitEntry, manifest: GitManifest | null, inferred: string | null): ShareFlag[] {
  const flags: ShareFlag[] = [];
  const push = (flag: string, words: string[], declared: boolean, label = flag): void => {
    flags.push({ flag, words, label, reason: declared ? "differs" : "undeclared" });
  };
  const description = e.description;
  if (description && description !== manifest?.description) {
    push("--description", ["--description", description], manifest?.description !== undefined);
  }
  const subdir = e.git.subdir;
  if (subdir && subdir !== manifest?.subdir) push("--subdir", ["--subdir", subdir], manifest?.subdir !== undefined);
  const entryCovered = manifest?.entry !== undefined ? manifest.entry === e.git.entry : inferred === e.git.entry;
  if (!entryCovered) push("--entry", ["--entry", e.git.entry], manifest?.entry !== undefined);
  for (const [key, value] of Object.entries(e.env)) {
    const decl = manifest?.env?.[key];
    const ref = SECRET_REF_RE.exec(value)?.[1];
    if (decl?.secret !== undefined && decl.secret === ref) continue;
    if (decl?.default !== undefined && decl.default === value) continue;
    push(
      "--env",
      ["--env", ref ? `${key}=\${secret:${ref}}` : `${key}=<set this>`],
      decl !== undefined,
      `--env ${key}`,
    );
  }
  return flags;
}

export async function runShare(opts: ShareCommandOptions): Promise<{ exitCode: number }> {
  const out = opts.out ?? createStreamWriter(process.stdout);
  const err = opts.err ?? createStreamWriter(process.stderr);
  const print = (s = ""): void => out(`${s.replace(/[^\x20-\x7e\n]/g, "?")}\n`);
  const fail = (exitCode: number, message: string): { exitCode: number } => {
    // Under --json the refusal is the result: stdout gets the document (same
    // print/sanitizer path the success doc uses), stderr keeps the human
    // line. share's refusals are selection failures, so nothing has been
    // rendered yet and the doc is the whole stdout.
    if (opts.json === true) print(JSON.stringify({ ok: false, error: `yaw-mcp share: ${message}`, exitCode }, null, 2));
    err(`yaw-mcp share: ${message.replace(/[^\x20-\x7e\n]/g, "?")}\n`);
    return { exitCode };
  };
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const name = opts.name ?? "";

  const file = await readTargetGitEntries(opts.project === true, home, cwd, env);
  if ("error" in file) return fail(1, file.error);
  for (const w of file.warnings) err(`warning: ${w.replace(/[^\x20-\x7e\n]/g, "?")}\n`);
  const pick = pickGitEntry(file, name);
  if (!pick.ok) {
    const hint = !opts.project && pick.exitCode === 1 ? " For a project entry add --project." : "";
    return fail(pick.exitCode, `${pick.message}${hint}`);
  }
  const e = pick.entry;
  const parsed = parseGitSpec(e.git.url);
  if (!parsed.ok) return fail(1, parsed.error);
  const spec = parsed.spec;
  if (spec.protocol === "file") {
    return fail(
      1,
      `"${e.namespace}" is built from a local file:// repository, which coworkers cannot clone. Add it from the repository's shared URL first.`,
    );
  }
  if (opts.pin && !e.git.commit)
    return fail(1, `"${e.namespace}" has no pinned commit. Pin one with: yaw-mcp update ${e.namespace}`);

  const buildDir = e.git.commit ? gitBuildDir(e.namespace, e.git.commit, home) : null;
  const built = buildDir !== null && readBuildMarker(buildDir, e.git.commit) !== null;
  const pkgDir = built ? join(buildDir, ...(e.git.subdir ?? "").split(/[\\/]/).filter(Boolean)) : null;
  // An absent yaw-mcp.json reads as an empty manifest: every flag is spelled
  // out, and that is the ordinary case, so it earns no note.
  const manifest = built ? readGitManifest(buildDir, e.git.subdir).manifest : null;
  const hasManifest =
    pkgDir !== null &&
    (existsSync(join(buildDir as string, GIT_MANIFEST_FILENAME)) || existsSync(join(pkgDir, GIT_MANIFEST_FILENAME)));
  const inferred = pkgDir && existsSync(join(pkgDir, "package.json")) ? inferredEntry(pkgDir) : null;
  const kind = opts.pin ? "sha" : await refKind(e, built ? buildDir : null, home, env);
  const ref = opts.pin ? e.git.commit : e.git.ref;

  const nameWord =
    manifest?.namespace === e.namespace
      ? null
      : (e.slug ?? (CATALOG_SLUG_RE.test(e.namespace) ? e.namespace : e.namespace.replace(/_/g, "-")));
  const flags = flagsFor(e, manifest, inferred);
  const lineFor = (url: string, https: boolean): string =>
    [
      "yaw-mcp",
      "add",
      ...(nameWord ? [nameWord] : []),
      "--git",
      `${url}${ref ? `#${ref}` : ""}`,
      ...flags.flatMap((f) => f.words),
      ...(https && e.git.tokenSecret ? ["--git-token-secret", e.git.tokenSecret] : []),
    ]
      .map(shellWord)
      .join(" ");
  const other = otherProtocolUrl(spec);
  const sshUrl = spec.protocol === "ssh" ? spec.url : other;
  const httpsUrl = spec.protocol === "https" ? spec.url : other;
  const commands = {
    primary: lineFor(spec.url, spec.protocol === "https"),
    ssh: sshUrl ? lineFor(sshUrl, false) : null,
    https: httpsUrl ? lineFor(httpsUrl, true) : null,
  };

  const secrets = new Map<string, string>();
  for (const [key, value] of Object.entries(e.env)) {
    const s = SECRET_REF_RE.exec(value)?.[1];
    if (s && !secrets.has(s)) secrets.set(s, key);
  }
  for (const [key, decl] of Object.entries(manifest?.env ?? {})) {
    if (decl.secret && !secrets.has(decl.secret) && !(key in e.env)) secrets.set(decl.secret, key);
  }

  const notes: string[] = [];
  if (!opts.pin && kind !== "tag" && kind !== "sha") {
    notes.push(
      `${e.namespace} tracks ${kind === "branch" ? "the branch" : "the ref"} ${e.git.ref ?? "(the default branch)"}, so each coworker builds whatever it points at when they run this. Tag a release (git tag v1.0.0 && git push --tags) so coworkers pin a version, or use --pin for the commit you run.`,
    );
  }
  if (nameWord && deriveNamespace(nameWord) !== e.namespace && !e.slug) {
    notes.push(`Coworkers' server will be named "${deriveNamespace(nameWord)}", not "${e.namespace}".`);
  }
  if (hasManifest) {
    const undeclared = flags.filter((f) => f.reason === "undeclared").map((f) => f.label);
    const differs = flags.filter((f) => f.reason === "differs").map((f) => f.label);
    if (undeclared.length > 0) {
      notes.push(
        `Coworkers' command includes ${undeclared.join(", ")} because the repo's yaw-mcp.json does not declare ${undeclared.length === 1 ? "it" : "them"}.`,
      );
    }
    if (differs.length > 0) {
      notes.push(
        `Coworkers' command includes ${differs.join(", ")} because this entry sets ${differs.length === 1 ? "it" : "them"} differently from the repo's yaw-mcp.json.`,
      );
    }
  }
  if (!built) {
    notes.push(
      `${e.namespace} is not built on this machine, so the repo's yaw-mcp.json was not read; the command spells out every flag.`,
    );
  }
  if (e.args.length > 0) {
    notes.push(
      `${e.namespace} also passes ${e.args.length} server argument${e.args.length === 1 ? "" : "s"}, not shown here (they can hold local paths); coworkers add their own after --.`,
    );
  }

  const repo = normalizeRepoUrl(spec.url);
  if (opts.json) {
    print(
      JSON.stringify(
        {
          ok: true,
          namespace: e.namespace,
          repo,
          ref: ref ?? null,
          kind,
          pinned: opts.pin === true,
          command: commands.primary,
          commands: { ssh: commands.ssh, https: commands.https },
          flags: [...new Set(flags.map((f) => f.flag))],
          secrets: [...secrets].map(([secret, envKey]) => ({ name: secret, env: envKey })),
          tokenSecret: e.git.tokenSecret ?? null,
          notes,
        },
        null,
        2,
      ),
    );
    return { exitCode: 0 };
  }
  // The placeholder travels INSIDE the paste line on purpose (a paste must be
  // one byte-exact line), so it needs the only place a human reads this: an
  // annotation here, never inside the command itself.
  if (flags.some((f) => f.words.some((w) => w.includes("<set this>")))) {
    print("Replace <set this> in any --env flag below with the real value before running this.");
    print();
  }
  print(`Send this to coworkers with read access to ${repo}:`);
  print();
  if (commands.ssh && commands.https) {
    print(`  SSH:   ${commands.ssh}`);
    print(`  HTTPS: ${commands.https}`);
  } else {
    print(`  ${commands.primary}`);
  }
  print();
  if (secrets.size > 0) {
    print(`They will be asked for: ${[...secrets].map(([s, k]) => `${s} (${k})`).join(", ")}`);
  }
  if (e.git.tokenSecret) {
    print(`Over HTTPS they first store a token with read access: yaw-mcp secrets set ${e.git.tokenSecret}`);
  }
  if (opts.pin && e.git.commit) print(`Pinned to ${e.git.commit.slice(0, GIT_BUILD_SHA_LEN)}.`);
  for (const n of notes) print(`Note: ${n}`);
  return { exitCode: 0 };
}
