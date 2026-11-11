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
  asciiLines,
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
  tokenUsername,
} from "./git-source.js";
import { deriveNamespace, relativeSegments } from "./local-bundles.js";
import { createStreamWriter } from "./logger.js";
import { GIT_BUILD_SHA_LEN, gitBuildDir } from "./paths.js";
import { SECRET_REF_RE } from "./secrets-vault.js";
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

/** The POSIX spelling of an apostrophe inside a single-quoted word: close the
 *  quote, a double-quoted apostrophe, reopen. */
const POSIX_APOSTROPHE = `'"'"'`;

/** Quote a word for a POSIX shell: bare when it is plainly safe, else in
 *  single quotes. A word is never left bare when it STARTS with `#` (both
 *  shells read that as a comment and drop the rest of the line) or with `@`
 *  (PowerShell's splat sigil); past the first character both are inert.
 *
 *  PowerShell reads the same line the same way (it does not expand inside
 *  single quotes either) with TWO exceptions, and runShare adds a note for
 *  each whenever a word needs it:
 *   - an embedded apostrophe. POSIX has to leave the quotes to write one and
 *     PowerShell doubles it instead, so no single spelling serves both; the
 *     POSIX one is printed.
 *   - an embedded double quote. Windows PowerShell 5.1 drops it when it hands
 *     a single-quoted word to a native command ('say "hi"' arrives as
 *     `say hi`) unless it is written \" (both checked on 5.1.26100).
 *     PowerShell 7.3 changed native argument passing and is documented to
 *     pass the quote through; that was not checked here.
 *  cmd.exe is not covered: single quotes do not quote there. */
function shellWord(w: string): string {
  if (/^[A-Za-z0-9._/:=+,-][A-Za-z0-9._/:@#=+,-]*$/.test(w)) return w;
  return `'${w.replace(/'/g, POSIX_APOSTROPHE)}'`;
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

/** `${secret:NAME}` and nothing else, anchored. Built from the vault's own
 *  SECRET_REF_RE source (as local-set-cmd.ts does) rather than a wider class
 *  of its own, so a malformed reference such as `${secret:gh token}` is a
 *  plain value here exactly as it is to the vault. */
const WHOLE_SECRET_REF_RE = new RegExp(`^${SECRET_REF_RE.source}$`);

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
  // Compared as directories, not as strings: the stored subdir is the tidy
  // spelling ("server") while the manifest's is read as its author typed it
  // ("./server", "server/"), and those name one directory.
  const subdir = e.git.subdir;
  const dirOf = (p: string | undefined): string => relativeSegments(p ?? "").join("/");
  if (subdir && dirOf(subdir) !== dirOf(manifest?.subdir)) {
    push("--subdir", ["--subdir", subdir], manifest?.subdir !== undefined);
  }
  const entryCovered = manifest?.entry !== undefined ? manifest.entry === e.git.entry : inferred === e.git.entry;
  if (!entryCovered) push("--entry", ["--entry", e.git.entry], manifest?.entry !== undefined);
  for (const [key, value] of Object.entries(e.env)) {
    const decl = manifest?.env?.[key];
    const ref = WHOLE_SECRET_REF_RE.exec(value)?.[1];
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
  // Terminal hardening for the human text: anything outside printable ASCII
  // becomes "?". That alters a paste line holding such a character, which is
  // why the text path adds a note when it happens (see below).
  const print = (s = ""): void => out(`${asciiLines(s)}\n`);
  // The --json document is data, so it is escaped rather than replaced: every
  // UTF-16 unit outside printable ASCII is written as a JSON \uXXXX escape
  // (JSON.stringify already escaped the C0 controls; the newlines left are its
  // own indentation). The output is still pure ASCII and parses back to the
  // exact strings.
  const printJson = (doc: unknown): void =>
    out(
      `${JSON.stringify(doc, null, 2).replace(/[^\x20-\x7e\n]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`,
    );
  const fail = (exitCode: number, message: string): { exitCode: number } => {
    // Under --json the refusal is the result: stdout gets the document (same
    // printJson path the success doc uses), stderr keeps the human
    // line. share's refusals are selection failures, so nothing has been
    // rendered yet and the doc is the whole stdout.
    if (opts.json === true) printJson({ ok: false, error: `yaw-mcp share: ${message}`, exitCode });
    err(`yaw-mcp share: ${asciiLines(message)}\n`);
    return { exitCode };
  };
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const name = opts.name ?? "";

  const file = await readTargetGitEntries(opts.project === true, home, cwd, env);
  if ("error" in file) return fail(1, file.error);
  for (const w of file.warnings) err(`warning: ${asciiLines(w)}\n`);
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
  const wordsFor = (url: string, https: boolean): string[] => [
    "yaw-mcp",
    "add",
    ...(nameWord ? [nameWord] : []),
    "--git",
    `${url}${ref ? `#${ref}` : ""}`,
    ...flags.flatMap((f) => f.words),
    ...(https && e.git.tokenSecret ? ["--git-token-secret", e.git.tokenSecret] : []),
  ];
  const lineFor = (url: string, https: boolean): string => wordsFor(url, https).map(shellWord).join(" ");
  const other = otherProtocolUrl(spec);
  // The sharer's own https username is dropped, as otherProtocolUrl drops it:
  // the repo is the same without it, and a coworker pasting it would be
  // prompted for that account. (parseGitSpec already refused a password or a
  // token there.) The exception is a URL username that git SENDS beside the
  // vault token: with --git-token-secret, tokenUsername uses it on every host
  // it has no fixed name for, so it can be the one the host requires
  // (Bitbucket's x-token-auth) and dropping it would authenticate coworkers as
  // "git". It is kept, and a note names it. An ssh username is kept too -- it
  // can be the account the host requires -- and named when it is not the
  // conventional "git".
  const tokenUser =
    spec.protocol === "https" &&
    e.git.tokenSecret &&
    spec.username !== undefined &&
    tokenUsername(spec) === spec.username
      ? spec.username
      : null;
  const ownUrl =
    spec.protocol === "https" && tokenUser === null ? spec.url.replace(/^([a-z]+:\/\/)[^/@]*@/i, "$1") : spec.url;
  const sshUrl = spec.protocol === "ssh" ? ownUrl : other;
  const httpsUrl = spec.protocol === "https" ? ownUrl : other;
  const commands = {
    primary: lineFor(ownUrl, spec.protocol === "https"),
    ssh: sshUrl ? lineFor(sshUrl, false) : null,
    https: httpsUrl ? lineFor(httpsUrl, true) : null,
  };

  const secrets = new Map<string, string>();
  for (const [key, value] of Object.entries(e.env)) {
    const s = WHOLE_SECRET_REF_RE.exec(value)?.[1];
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
  if (spec.protocol === "ssh" && spec.username !== undefined && spec.username !== "git") {
    notes.push(
      `The SSH URL logs in as "${spec.username}". Coworkers who do not use that account replace it with their own username.`,
    );
  }
  if (tokenUser !== null) {
    notes.push(
      `The HTTPS URL keeps the username "${tokenUser}": git sends it with the token on this host. Coworkers whose token needs a different username replace it.`,
    );
  }
  // Every form shares its words bar the URL, so the primary line's words plus
  // the other protocol's URL cover all of them.
  const allWords = [...wordsFor(ownUrl, true), other ?? ""];
  if (allWords.some((w) => w.includes("'"))) {
    notes.push(
      `The command is quoted for bash and zsh. It contains an apostrophe, written ${POSIX_APOSTROPHE}; in PowerShell replace each ${POSIX_APOSTROPHE} with two single quotes ('').`,
    );
  }
  // See shellWord: Windows PowerShell 5.1 drops a double quote inside a
  // single-quoted word on its way to yaw-mcp, so the paste would silently
  // change the value.
  if (allWords.some((w) => w.includes('"'))) {
    notes.push(
      `The command is quoted for bash and zsh. It contains a double quote ("), which Windows PowerShell 5.1 drops when it runs the command; there, write each one as \\".`,
    );
  }
  if (e.args.length > 0) {
    notes.push(
      `${e.namespace} also passes ${e.args.length} server argument${e.args.length === 1 ? "" : "s"}, not shown here (they can hold local paths); coworkers add their own after --.`,
    );
  }

  const repo = normalizeRepoUrl(spec.url);
  if (opts.json) {
    printJson({
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
    });
    return { exitCode: 0 };
  }
  // Text only: `print` turns anything outside printable ASCII into "?", so a
  // command holding such a character is NOT what the entry says. The --json
  // document carries it exactly, hence the pointer.
  if ([commands.primary, commands.ssh ?? "", commands.https ?? ""].some((c) => /[^\x20-\x7e]/.test(c))) {
    notes.push(
      `The command holds characters outside printable ASCII, shown here as "?". Coworkers retype them after pasting; yaw-mcp share ${shellWord(name)}${opts.project ? " --project" : ""} --json prints the command exactly.`,
    );
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
