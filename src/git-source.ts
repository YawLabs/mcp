// Git-sourced MCP servers: turn a repository URL and a commit into an
// immutable build directory under ~/.yaw-mcp/git/<namespace>/<sha12>.
//
// Everything here runs the repo's own code (lifecycle scripts, the build), so
// it only ever runs behind a consent: `add --git`, and later `update`,
// `sidecars install` and the build `trust` offers. Activation never clones,
// installs or builds: upstream.ts checks for the marker a finished build
// leaves (gitBuildMissing) and imports this module on demand for two things
// only -- hasRepoConsent, to word the "not built" message, and
// recordLoadedGitPin, to note in refs.json which file uses the build.
//
// Credentials are never accepted in a URL (parseGitSpec refuses them before
// anything is persisted or logged). Auth is the user's own git -- ssh-agent,
// ~/.ssh/config, a credential helper -- or a vault token handed to git through
// GIT_ASKPASS for HTTPS, never through argv, the URL or .git/config.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { asciiLines, printable } from "./ascii.js";
import { atomicWriteFile } from "./atomic-write.js";
import { ENV_KEY_RE } from "./catalog.js";
import {
  builtMarkerPath,
  type GitBuildMarker,
  gitEntryBuilt,
  type PackageManagerName,
  readBuildMarker,
  writeBuildMarker,
} from "./git-build-state.js";
import { stripInternalSecretsFromEnv } from "./internal-secret-env.js";
import { parseJsonc } from "./jsonc.js";
import {
  GIT_COMMIT_RE,
  gitSourceFromRaw,
  hasControlChar,
  localBundlesPath,
  NAMESPACE_RE,
  probeProjectTrust,
  projectFileIsHonoured,
  readBundlesServersSync,
  relativeSegments,
  unsafeRelativePathReason,
} from "./local-bundles.js";
import { log } from "./logger.js";
import { compareVersions, packageEntry, resolveBinAbsolute } from "./oam-spawn.js";
import {
  findProjectConfigDir,
  GIT_BUILD_SHA_LEN,
  gitBuildDir,
  gitFailedPath,
  gitRoot,
  userConfigDir,
} from "./paths.js";
import { getSecret, loadVault, SECRET_NAME_RE, unlock, vaultPath } from "./secrets-vault.js";
import { acquireSidecarsLock, defaultRunNpm, npmBin, type RunNpmOptions } from "./sidecars-cmd.js";
import { readTrustStore, trustedRecords, trustStorePath } from "./trust.js";
import type { UpstreamServerConfig } from "./types.js";
import { redactSecretsInOutput, vaultPassphrase } from "./upstream.js";

// --- URL parsing ------------------------------------------------------------

export interface GitSpec {
  /** The URL exactly as given, minus the `#ref`. Safe to persist. */
  url: string;
  ref?: string;
  protocol: "https" | "ssh" | "file";
  /** Lowercased host; "" for file://. */
  host: string;
  /** The username the URL names, if any (never a password: those are refused). */
  username?: string;
}

export const GIT_CREDENTIALS_REFUSAL =
  "--git: the URL carries credentials. Remove them -- yaw-mcp uses your ssh-agent or git credential helper; a token here would be written into bundles.json and .git/config.";

const GIT_URL_FORMS =
  "https://host/org/repo.git, ssh://git@host/org/repo.git, git@host:org/repo.git or file:///path/to/repo";

/** A username that reads as a name rather than a credential. A token pasted as
 *  the userinfo (`https://ghp_xxx@github.com/...`) is the shape git's own docs
 *  show, so anything long or token-prefixed is refused. */
function isBareUsername(user: string): boolean {
  if (!/^[A-Za-z0-9._-]{1,19}$/.test(user)) return false;
  return !/^(gh[pousr]_|github_pat_|glpat-|glptt-|xox[abp]-)/i.test(user);
}

// `printable` (one line) and `asciiLines` (several) make repo-supplied text
// safe for a terminal. They live in the leaf module ascii.ts, which imports
// nothing, so a module this file itself imports could take them without a
// cycle (none does yet: this file is the only importer). Re-exported here for
// the callers that take them from this module.
// The loader's path-segment splitter, re-exported so a caller comparing a
// stored or manifest subdir with the tidy one a build records (see
// `tidySubdir` in buildLocked) can take it from the module that tidies.
export { asciiLines, printable, relativeSegments };

/** A ref a user may name after `#`: a branch, a tag or a (short) SHA. */
export function gitRefProblem(ref: string): string | null {
  if (ref === "") return "the ref after # is empty";
  if (ref.startsWith("-")) return 'the ref cannot start with "-"';
  if (!/^[A-Za-z0-9._/+@-]+$/.test(ref) || ref.includes("..") || ref.startsWith("/") || ref.endsWith("/")) {
    return `"${ref}" is not a usable branch, tag or commit name`;
  }
  return null;
}

/**
 * Parse `--git <url>[#ref]`. Allowed: https://, ssh://, scp-form
 * `[user@]host:path` and file://. Refused: credentials in the userinfo,
 * `<transport>::` (git's remote helpers, `ext::` among them, run commands),
 * a leading "-" (git would read it as an option), control bytes, and every
 * other scheme. No refusal quotes the URL: it can be the credential.
 */
export function parseGitSpec(raw: string): { ok: true; spec: GitSpec } | { ok: false; error: string } {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
  if (hasControlChar(raw)) return fail("--git: the URL contains control characters.");
  const value = raw.trim();
  if (value === "") return fail("--git requires a URL");
  if (value.startsWith("-")) return fail('--git: the URL cannot start with "-".');
  const hash = value.indexOf("#");
  const url = hash >= 0 ? value.slice(0, hash) : value;
  let ref: string | undefined;
  if (hash >= 0) {
    ref = value.slice(hash + 1);
    const problem = gitRefProblem(ref);
    if (problem) return fail(`--git: ${problem}.`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) {
    return fail(`--git: "<transport>::" URLs are refused (they run a helper program). Use ${GIT_URL_FORMS}.`);
  }
  if (/\s/.test(url)) return fail("--git: the URL contains whitespace.");
  const withRef = (spec: Omit<GitSpec, "ref">): { ok: true; spec: GitSpec } => ({
    ok: true,
    spec: { ...spec, ...(ref !== undefined ? { ref } : {}) },
  });

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme !== "https" && scheme !== "ssh" && scheme !== "file") {
      return fail(`--git: ${scheme}:// is not supported. Use ${GIT_URL_FORMS}.`);
    }
    // Userinfo is checked on the raw text before URL parsing: WHATWG parsing
    // percent-decodes and normalizes, and a credential must be refused in the
    // form the user typed it.
    const authority = url.slice(scheme.length + 3).split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    const userinfo = at >= 0 ? authority.slice(0, at) : undefined;
    if (userinfo !== undefined) {
      if (userinfo.includes(":") || userinfo === "") return fail(GIT_CREDENTIALS_REFUSAL);
      if (scheme === "https" && !isBareUsername(userinfo)) return fail(GIT_CREDENTIALS_REFUSAL);
      if (scheme === "file") return fail("--git: a file:// URL cannot carry a username.");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail(`--git: not a valid URL. Use ${GIT_URL_FORMS}.`);
    }
    if (scheme === "file") {
      if (parsed.host !== "" && parsed.host !== "localhost")
        return fail("--git: a file:// URL must name a local path.");
      return withRef({ url, protocol: "file", host: "" });
    }
    if (parsed.hostname === "") return fail(`--git: the URL names no host. Use ${GIT_URL_FORMS}.`);
    if (parsed.pathname === "" || parsed.pathname === "/") return fail("--git: the URL names no repository path.");
    return withRef({
      url,
      protocol: scheme === "https" ? "https" : "ssh",
      host: parsed.hostname.toLowerCase(),
      ...(userinfo ? { username: userinfo } : {}),
    });
  }

  // `user:pw@host:path` would otherwise parse below as host "user".
  if (/^[^@/]+:[^@/]*@/.test(url)) return fail(GIT_CREDENTIALS_REFUSAL);
  // scp-form: [user@]host:path. A one-letter "host" is a Windows drive
  // (C:\repo), which git itself treats as a local path.
  const scp = /^(?:([^@/:]+)@)?([^@/:[\]]+):(.+)$/.exec(url);
  if (scp) {
    const [, user, host = "", path = ""] = scp;
    if (host.length === 1) return fail("--git: local paths need a file:// URL (file:///C:/path/to/repo).");
    if (path.startsWith("//")) return fail(`--git: not a git URL. Use ${GIT_URL_FORMS}.`);
    return withRef({ url, protocol: "ssh", host: host.toLowerCase(), ...(user ? { username: user } : {}) });
  }
  return fail(`--git: not a git URL. Use ${GIT_URL_FORMS}.`);
}

/**
 * The identity a repo grant is stored under: protocol, username and port
 * dropped, host lowercased, a trailing "/" and ".git" stripped. So
 * `git@github.com:acme/x`, `ssh://git@github.com/acme/x.git` and
 * `https://github.com/acme/x` are one repo -- a grant over SSH covers HTTPS.
 */
export function normalizeRepoUrl(url: string): string {
  const spec = parseGitSpec(url);
  const tidy = (p: string): string => {
    let out = p.replace(/\\/g, "/");
    for (;;) {
      const next = out.replace(/\/+$/, "").replace(/\.git$/i, "");
      if (next === out) return out;
      out = next;
    }
  };
  if (!spec.ok) return tidy(url.trim());
  const bare = spec.spec.url;
  if (spec.spec.protocol === "file") {
    let path = new URL(bare).pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // A stray "%" (file:///tmp/a%zz/repo) parses as a URL but does not
      // decode. The raw pathname is still one stable identity for the repo.
    }
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1).toLowerCase();
    return `file:${tidy(path)}`;
  }
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(bare)) path = new URL(bare).pathname;
  else path = bare.slice(bare.indexOf(":", bare.indexOf("@") + 1) + 1);
  return `${spec.spec.host}/${tidy(path).replace(/^\/+/, "")}`;
}

// --- redaction ---------------------------------------------------------------

/** Every `scheme://userinfo@` in `text` with the userinfo replaced. Catches the
 *  bare `https://TOKEN@host` form, which hasUrlPassword (user:pass only) and
 *  the value map cannot see when the token never passed through yaw-mcp.
 *
 *  A `user:password` userinfo runs to the LAST `@` on its line, the rule
 *  upstream.ts's hasUrlPassword / splitUserinfo apply (mirrored, not
 *  imported: they are module-private there). An UNENCODED password can hold
 *  `/`, `?`, `#`, a space or an `@` (a base64 key does), and a matcher that
 *  stopped at the first `/` or space left `https://user:abc/def==@host` in a
 *  refusal untouched. As there, the user half stops at `/`, whitespace or
 *  `:`, so a path `@` with no colon ahead of it (`https://host/@org/mcp`)
 *  stays readable. Unlike there, `text` is free text (git stderr, a log
 *  line), not one url, so the password also stops at a newline, a quote
 *  (git quotes the url it reports) and the next `://`, which keeps a
 *  second url on the line its own match. The stop is a fixed-width `://`
 *  lookahead, not a `scheme://` one: re-scanning a scheme run at every
 *  password character made a long line after `http://host:port` quadratic
 *  (20k chars took seconds), and this runs on whole build logs. The scheme
 *  is capped at 32 characters for the same reason: `\b` holds after every
 *  `.` in a run like `a.b.c...`, and an unbounded scheme scan from each of
 *  those starts was quadratic too. A real scheme is far shorter; a run
 *  glued to its front still matches from any `.`, `+` or `-` within 32
 *  characters of the `://`. What over-matches is a port with
 *  an `@` later on the line: `https://host:8443/mcp?user=a@b.example`
 *  becomes `https://***@b.example`. Over-scrubbing a string that is only
 *  ever displayed costs less than printing a key, but that is why a single
 *  url that is stored or compared goes through scrubRepoUrlUserinfo
 *  instead. A password holding a quote is not scrubbed at all: neither
 *  branch can reach its `@`, so the url is printed as it is. */
export function scrubUrlUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^/\s:'"]*:(?:(?!:\/\/)[^\r\n'"])*|[^/@\s'"]+)@/gi, "$1***@");
}

/** One repo url (not free text) with its userinfo replaced by `***`, for a
 *  url that is persisted (state.json) or shown as the repo's identity in an
 *  error. The userinfo is what the WHATWG URL parser finds: up to the last
 *  `@` before the first `/`, `?`, `#` or `\`, so a port with an `@` later in
 *  the path (`https://git.corp:8443/@team/mcp.git`) keeps its host, where
 *  the free-text scrubUrlUserinfo would run to that `@`. The rest of the url
 *  is left byte for byte (no URL re-serialisation). A url the parser
 *  rejects -- an unencoded `/` in a password makes `user:abc` the host, with
 *  a bad port -- goes through scrubUrlUserinfo, which scrubs more, not less;
 *  an scp-style `git@host:path` has no `://` and is returned unchanged. */
export function scrubRepoUrlUserinfo(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return scrubUrlUserinfo(url);
  }
  if (!parsed.username && !parsed.password) return url;
  const m = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#\\]*@/i.exec(url);
  if (m) return `${m[1]}***@${url.slice(m[0].length)}`;
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/** Build output made safe to print, persist in `.failed` or put in an error:
 *  vault and credential-shaped env values by redactSecretsInOutput, then any
 *  URL userinfo. */
export function redactGitOutput(text: string, secrets: Record<string, string> = {}): string {
  return scrubUrlUserinfo(redactSecretsInOutput(text, secrets));
}

// --- git ----------------------------------------------------------------------

export const GIT_MISSING_MESSAGE =
  "git is not installed or not on PATH. Install: winget install Git.Git / xcode-select --install / apt install git";

/** The env a git child runs under, minus yaw-mcp's own secrets. Off a TTY
 *  nothing may prompt: git fails fast instead of hanging a `--json` run or
 *  the panel. */
export interface GitRunContext {
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  /** HTTPS token from the vault, handed to git through GIT_ASKPASS only. */
  token?: { value: string; username: string; askpass: string };
}

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const OUTPUT_CAP = 64 * 1024;

function gitOverlay(ctx: GitRunContext): Record<string, string> {
  const out: Record<string, string> = {};
  if (!ctx.interactive || ctx.token) {
    out.GIT_TERMINAL_PROMPT = "0";
    out.GCM_INTERACTIVE = "never";
  }
  if (ctx.token) {
    out.GIT_ASKPASS = ctx.token.askpass;
    out.YAW_MCP_GIT_TOKEN = ctx.token.value;
    out.YAW_MCP_GIT_USERNAME = ctx.token.username;
  }
  return out;
}

/** Run git with fixed argv and no shell: git.exe is a real executable, and the
 *  URL always follows `--` at the call sites. */
export function runGit(args: string[], ctx: GitRunContext, cwd?: string): Promise<GitRunResult> {
  // An empty credential.helper first, so a stale stored credential cannot win
  // over the vault token the user asked for.
  const argv = ctx.token ? ["-c", "credential.helper=", ...args] : args;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", argv, {
        cwd,
        shell: false,
        windowsHide: !ctx.interactive,
        stdio: [ctx.interactive ? "inherit" : "ignore", "pipe", "pipe"],
        env: { ...stripInternalSecretsFromEnv(ctx.env), ...gitOverlay(ctx) },
      });
    } catch {
      resolve({ code: -1, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.setEncoding("utf8").on("data", (c: string) => {
      stderr = (stderr + c).slice(-OUTPUT_CAP);
    });
    child.on("error", () => resolve({ code: -1, stdout, stderr }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export async function gitAvailable(ctx: GitRunContext): Promise<boolean> {
  return (await runGit(["--version"], { ...ctx, token: undefined })).code === 0;
}

const AUTH_FAILURE_RE =
  /Permission denied \(publickey|Authentication failed|could not read Username|could not read Password|terminal prompts disabled|returned error: 40[13]|HTTP Basic: Access denied/i;

const HOST_KEY_CHANGED_RE = /REMOTE HOST IDENTIFICATION HAS CHANGED/i;
const HOST_KEY_UNKNOWN_RE = /Host key verification failed|No \S+ host key is known/i;

/** The repo path a user would recognise ("acme/crm-mcp"), for the access hint. */
function repoPath(spec: GitSpec): string {
  const norm = normalizeRepoUrl(spec.url);
  return spec.protocol === "file" ? norm.slice("file:".length) : norm.slice(norm.indexOf("/") + 1);
}

/** The text a git `insteadOf` rule matches: everything before the repo path. */
function urlPrefix(spec: GitSpec): string {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i.exec(spec.url);
  if (scheme) return scheme[0];
  return spec.url.slice(0, spec.url.indexOf(":", spec.url.indexOf("@") + 1) + 1);
}

/** `ssh -T` for the host and port the URL names. */
function sshProbe(spec: GitSpec): string {
  let port: string | undefined;
  if (/^ssh:\/\//i.test(spec.url)) port = new URL(spec.url).port || undefined;
  return `ssh -T ${port ? `-p ${port} ` : ""}${spec.username ?? "git"}@${spec.host}`;
}

/**
 * Why git could not reach the repo, for each protocol in its own terms. An
 * SSH URL gets the ssh checks, an HTTPS URL the credential checks, never both.
 * Both suggest git's own `insteadOf` rewrite to the other protocol, which is
 * per machine: `shared` (a committed project file) says not to edit the file.
 * The URL is shown as stored -- parseGitSpec refused any credential in it.
 */
export function gitAuthMessage(spec: GitSpec, tokenSecret?: string, shared = false): string {
  const host = spec.host || "the remote";
  const lines: string[] = [];
  const rewrite = (to: string, from: string, label: string): string =>
    `To use ${label} on this machine${shared ? " without editing the shared file" : ""}: git config --global url."${to}".insteadOf "${from}"`;
  if (spec.protocol === "ssh") {
    lines.push(
      `git could not authenticate to ${host} over SSH. Check: ${sshProbe(spec)}`,
      "On Windows, Git for Windows' ssh does not use the Windows ssh-agent unless core.sshCommand points at C:/Windows/System32/OpenSSH/ssh.exe.",
      rewrite(`https://${spec.host}/`, urlPrefix(spec), "HTTPS"),
    );
  } else if (spec.protocol === "https") {
    lines.push(
      `git could not authenticate to ${host} over HTTPS. Check: git ls-remote ${spec.url}`,
      "A git credential helper (Git Credential Manager, osxkeychain, libsecret) or --git-token-secret NAME supplies the credential.",
      rewrite(`git@${spec.host}:`, urlPrefix(spec), "SSH"),
    );
  } else {
    lines.push(`git could not read ${spec.url}.`);
  }
  if (tokenSecret && spec.protocol === "https") {
    lines.push(`The token in secret "${tokenSecret}" was rejected, or lacks read access.`);
  }
  lines.push(`You may not have access to ${repoPath(spec)} -- ask its owner.`);
  return lines.join("\n");
}

/** ssh refusing the host itself, which no credential fixes. Never accepted
 *  for the user: a changed key can be an interception. */
export function gitHostKeyMessage(spec: GitSpec, stderr: string): string | null {
  const host = spec.host || "the remote";
  if (HOST_KEY_CHANGED_RE.test(stderr)) {
    return [
      `WARNING: ${host}'s ssh host key has CHANGED since this machine last connected. Someone may be intercepting the connection (a man-in-the-middle attack), or ${host} rotated its key.`,
      `Check the fingerprint ${host} publishes before you remove the old key (ssh-keygen -R ${spec.host}); yaw-mcp never accepts a host key for you.`,
    ].join("\n");
  }
  if (HOST_KEY_UNKNOWN_RE.test(stderr)) {
    return `ssh does not trust ${host}'s host key yet. Connect once to accept it: ${sshProbe(spec)}`;
  }
  return null;
}

/** The access failure in git's stderr (host key first, then auth), or null. */
function gitAccessFailure(spec: GitSpec, stderr: string, tokenSecret?: string, shared = false): string | null {
  return (
    gitHostKeyMessage(spec, stderr) ?? (AUTH_FAILURE_RE.test(stderr) ? gitAuthMessage(spec, tokenSecret, shared) : null)
  );
}

function lastLines(text: string, max = 2000): string {
  return text.trim().slice(-max);
}

export type GitRefKind = "branch" | "tag" | "sha" | "head";

export interface ResolvedRef {
  /** What the entry tracks: the branch or tag name, or the SHA as given. */
  ref: string;
  kind: GitRefKind;
  /** The full commit when ls-remote could name it; a short SHA is completed
   *  only after the clone (resolveCommitInClone). */
  commit?: string;
  /** The hex prefix to resolve after the clone, for a short SHA. */
  shortSha?: string;
}

/** `needsConsent`: refused only because nothing could ask to run the repo's
 *  scripts; --yes is the remedy, not a fix to the repo. `cancelled`: the user
 *  pressed Ctrl+C at the consent prompt (exit code 130); the command stops. */
export type GitFailure = {
  ok: false;
  exitCode: 1 | 2 | 130;
  message: string;
  needsConsent?: true;
  cancelled?: true;
};

/** What one `git ls-remote --symref` advertises: every head and tag (an
 *  annotated tag also under `<tag>^{}`, naming its commit) and HEAD's target. */
export interface RemoteRefs {
  refs: Map<string, string>;
  headTarget?: string;
}

export async function listRemoteRefs(
  spec: GitSpec,
  git: PreparedGit,
  tokenSecret?: string,
  shared = false,
): Promise<({ ok: true } & RemoteRefs) | GitFailure> {
  const r = await runGit(["ls-remote", "--symref", "--", spec.url], git.run);
  if (r.code !== 0) {
    if (r.code === -1 && !r.stderr) return { ok: false, exitCode: 2, message: GIT_MISSING_MESSAGE };
    const access = gitAccessFailure(spec, r.stderr, tokenSecret, shared);
    if (access) return { ok: false, exitCode: 1, message: access };
    const tail = redactGitOutput(lastLines(r.stderr), git.secrets);
    return { ok: false, exitCode: 1, message: `git ls-remote failed for ${scrubRepoUrlUserinfo(spec.url)}:\n${tail}` };
  }
  const refs = new Map<string, string>();
  let headTarget: string | undefined;
  for (const line of r.stdout.split(/\r?\n/)) {
    const sym = /^ref: (\S+)\tHEAD$/.exec(line);
    if (sym) {
      headTarget = sym[1];
      continue;
    }
    const m = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
    if (m?.[1] && m[2]) refs.set(m[2], m[1]);
  }
  return { ok: true, refs, ...(headTarget ? { headTarget } : {}) };
}

/** Resolve `spec.ref` (or the remote's default branch) with one `git
 *  ls-remote`. A branch or tag match wins; a hex string with no ref match is a
 *  commit. */
export async function resolveGitRef(
  spec: GitSpec,
  git: PreparedGit,
  tokenSecret?: string,
  shared = false,
): Promise<({ ok: true } & ResolvedRef) | GitFailure> {
  const listed = await listRemoteRefs(spec, git, tokenSecret, shared);
  if (!listed.ok) return listed;
  return resolveRefIn(spec, listed);
}

/** `resolveGitRef` over refs already listed. "HEAD" -- what an entry tracking
 *  a remote that advertises no symref stores -- resolves as no ref does, so
 *  such an entry can be updated and shared. */
export function resolveRefIn(spec: GitSpec, remote: RemoteRefs): ({ ok: true } & ResolvedRef) | GitFailure {
  const { refs, headTarget } = remote;
  const ref = spec.ref;
  if (ref === undefined || ref === "HEAD") {
    const head = refs.get("HEAD");
    if (!head)
      return {
        ok: false,
        exitCode: 1,
        message: `${scrubRepoUrlUserinfo(spec.url)} has no default branch to track. Name one: --git <url>#<branch>`,
      };
    if (headTarget?.startsWith("refs/heads/")) {
      return { ok: true, ref: headTarget.slice("refs/heads/".length), kind: "branch", commit: head };
    }
    return { ok: true, ref: "HEAD", kind: "head", commit: head };
  }
  const branch = refs.get(`refs/heads/${ref}`) ?? (ref.startsWith("refs/heads/") ? refs.get(ref) : undefined);
  if (branch) return { ok: true, ref, kind: "branch", commit: branch };
  const tagName = ref.startsWith("refs/tags/") ? ref : `refs/tags/${ref}`;
  // An annotated tag advertises the tag object and, under `^{}`, the commit.
  const tag = refs.get(`${tagName}^{}`) ?? refs.get(tagName);
  if (tag) return { ok: true, ref, kind: "tag", commit: tag };
  if (/^[0-9a-f]{40}$/i.test(ref)) return { ok: true, ref: ref.toLowerCase(), kind: "sha", commit: ref.toLowerCase() };
  if (/^[0-9a-f]{4,39}$/i.test(ref))
    return { ok: true, ref: ref.toLowerCase(), kind: "sha", shortSha: ref.toLowerCase() };
  const safe = scrubRepoUrlUserinfo(spec.url);
  return {
    ok: false,
    exitCode: 1,
    message: `ref "${ref}" not found on ${safe}. Branches/tags: git ls-remote --heads --tags ${safe}`,
  };
}

const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The tags on the remote that sort after `current` as semver (a leading "v"
 *  allowed), newest first. A prerelease is offered only to an entry already
 *  tracking one. Empty when `current` is not a version tag. */
export function newerTags(current: string, refs: Map<string, string>): string[] {
  const name = current.startsWith("refs/tags/") ? current.slice("refs/tags/".length) : current;
  if (!SEMVER_TAG_RE.test(name)) return [];
  const bare = (t: string): string => (t.startsWith("v") ? t.slice(1) : t);
  const pre = bare(name).includes("-");
  const tags = new Set<string>();
  for (const key of refs.keys()) {
    if (!key.startsWith("refs/tags/")) continue;
    const t = key.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    if (!SEMVER_TAG_RE.test(t) || (!pre && bare(t).includes("-"))) continue;
    if (compareVersions(bare(t), bare(name)) > 0) tags.add(t);
  }
  return [...tags].sort((a, b) => compareVersions(bare(b), bare(a)));
}

// --- package managers ---------------------------------------------------------

export interface PackageManagerPlan {
  pm: PackageManagerName;
  /** The version `packageManager` pins, if any. */
  version?: string;
  /** Yarn 2+: installs with a node_modules linker so `node <entry>` works. */
  berry: boolean;
  lockfile: string | null;
  installArgs: string[];
  /** Laid over the child env for install and build. */
  env: Record<string, string | undefined>;
  warnings: string[];
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Which package manager builds the repo, decided at its root: the
 * `packageManager` field first, then the lockfile, else npm with a warning.
 * bun is refused. Lockfiles are only ever installed frozen/immutable.
 */
export function detectPackageManager(rootDir: string): PackageManagerPlan | { error: string } {
  const pkg = readJsonObject(join(rootDir, "package.json")) ?? {};
  const has = (f: string): boolean => existsSync(join(rootDir, f));
  let pm: PackageManagerName | undefined;
  let version: string | undefined;
  const field = typeof pkg.packageManager === "string" ? pkg.packageManager.trim() : "";
  if (field !== "") {
    const m = /^(npm|pnpm|yarn|bun)@(\d+(?:\.\d+){0,2}[0-9A-Za-z.-]*)(?:\+.*)?$/.exec(field);
    if (!m) return { error: `package.json "packageManager" is ${JSON.stringify(field)}; expected e.g. "pnpm@9.12.0".` };
    if (m[1] === "bun")
      return { error: "this repo uses bun (packageManager); yaw-mcp builds npm, pnpm and yarn repos only." };
    pm = m[1] as PackageManagerName;
    version = m[2];
  }
  const lockOf: Record<PackageManagerName, string[]> = {
    pnpm: ["pnpm-lock.yaml"],
    yarn: ["yarn.lock"],
    npm: ["package-lock.json", "npm-shrinkwrap.json"],
  };
  if (pm === undefined) {
    const bunLock = ["bun.lock", "bun.lockb"].find(has);
    if (bunLock) return { error: `this repo uses bun (${bunLock}); yaw-mcp builds npm, pnpm and yarn repos only.` };
    pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
  }
  const lockfile = lockOf[pm].find(has) ?? null;
  const warnings: string[] = [];
  if (lockfile === null) {
    warnings.push(`the repo has no ${lockOf[pm][0]}; installing unpinned dependencies (${pm} install).`);
  }
  const major = Number.parseInt(version ?? "", 10);
  const berry = pm === "yarn" && ((Number.isFinite(major) && major >= 2) || has(".yarnrc.yml"));
  let installArgs: string[];
  // cmd.exe (every package-manager run on Windows goes through it) otherwise
  // looks in the clone itself before PATH, where a repo can plant a pnpm.cmd.
  const env: Record<string, string | undefined> = {
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    NoDefaultCurrentDirectoryInExePath: "1",
  };
  if (pm === "npm") {
    installArgs = [lockfile ? "ci" : "install", "--include=dev", "--no-audit", "--no-fund"];
  } else if (pm === "pnpm") {
    installArgs = lockfile ? ["install", "--frozen-lockfile"] : ["install"];
    // NODE_ENV=production makes pnpm skip devDependencies -- the build tools.
    env.NODE_ENV = undefined;
  } else if (berry) {
    installArgs = lockfile ? ["install", "--immutable"] : ["install"];
    env.YARN_NODE_LINKER = "node-modules";
    if (!lockfile) env.YARN_ENABLE_IMMUTABLE_INSTALLS = "false";
  } else {
    installArgs = lockfile ? ["install", "--frozen-lockfile", "--production=false"] : ["install", "--production=false"];
  }
  return { pm, ...(version ? { version } : {}), berry, lockfile, installArgs, env, warnings };
}

/** Is `p` the directory `base` or anywhere under it? */
function isWithin(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** How to invoke a package manager: `bin` plus the args that precede the
 *  package manager's own (`corepack pnpm ...`). */
export interface PmCommand {
  /** Absent for npm: defaultRunNpm's own npmBin. */
  bin?: string;
  prefix: string[];
  /** For display: "pnpm" or "corepack pnpm". */
  label: string;
}

/**
 * corepack when `packageManager` pins a version and corepack exists. Else npm
 * runs as the npm beside this node (npmBin), the rule the sidecar install also
 * keeps, and pnpm and yarn as the binary on PATH, else through corepack.
 * Every `bin` is an ABSOLUTE path found on PATH outside `exclude` (the clone)
 * or derived from process.execPath, quoted on Windows -- never a bare name,
 * which cmd.exe would look up in the clone first, and never a path a repo
 * chose.
 */
export function resolvePmCommand(
  plan: Pick<PackageManagerPlan, "pm" | "version">,
  opts: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    nodeDir?: string;
    nodeVersion?: string;
    exclude?: string;
  } = {},
): PmCommand | { error: string } {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const nodeDir = opts.nodeDir ?? dirname(process.execPath);
  const sep = platform === "win32" ? ";" : ":";
  const pathDirs = (env.PATH ?? env.Path ?? env.path ?? "").split(sep).filter((d) => {
    const clean = d.replace(/^"|"$/g, "");
    return clean !== "" && (opts.exclude === undefined || !isWithin(opts.exclude, clean));
  });
  const searchEnv: NodeJS.ProcessEnv = { ...env, PATH: pathDirs.join(sep) };
  delete searchEnv.Path;
  delete searchEnv.path;
  const quote = (abs: string): string => (platform === "win32" ? `"${abs}"` : abs);
  const onPath = (name: string): string | null => {
    const abs = resolveBinAbsolute(name, searchEnv, platform);
    return abs === null ? null : quote(abs);
  };
  const sibling = join(nodeDir, platform === "win32" ? "corepack.cmd" : "corepack");
  const corepack = onPath("corepack") ?? (existsSync(sibling) ? quote(sibling) : null);
  const viaCorepack = (cp: string): PmCommand => ({ bin: cp, prefix: [plan.pm], label: `corepack ${plan.pm}` });
  if (plan.version && corepack) return viaCorepack(corepack);
  if (plan.pm === "npm") {
    const npm = npmBin(platform, nodeDir);
    if (npm.startsWith('"') || npm.includes("/") || npm.includes("\\")) return { prefix: [], label: "npm" };
    const found = onPath("npm");
    return found ? { bin: found, prefix: [], label: "npm" } : { error: "npm is not installed or not on PATH." };
  }
  const direct = onPath(plan.pm);
  if (direct) return { bin: direct, prefix: [], label: plan.pm };
  if (corepack) return viaCorepack(corepack);
  const major = Number.parseInt((opts.nodeVersion ?? process.version).replace(/^v/, ""), 10);
  const hint = major >= 25 ? "npm i -g corepack && corepack enable" : "corepack enable";
  return { error: `this repo builds with ${plan.pm}, which is not installed. Run: ${hint}` };
}

/** pnpm's `--filter <name>...` is the one place a repo-chosen string reaches a
 *  package-manager command line, and on Windows that line goes through
 *  cmd.exe. A registry package name cannot hold a shell metacharacter; this
 *  holds the repo to that. */
export const PNPM_FILTER_NAME_RE = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;

/** The build step, or null when the target package declares no `build`. A
 *  pnpm workspace builds through `--filter <name>...` at the root, so the
 *  workspace packages the server depends on build first. */
export function planBuild(
  plan: PackageManagerPlan,
  rootDir: string,
  targetDir: string,
): { args: string[]; cwd: string } | { error: string } | null {
  const pkg = readJsonObject(join(targetDir, "package.json"));
  const scripts = pkg?.scripts as Record<string, unknown> | undefined;
  if (!scripts || typeof scripts.build !== "string") return null;
  if (plan.pm === "pnpm" && targetDir !== rootDir && existsSync(join(rootDir, "pnpm-workspace.yaml"))) {
    const name = typeof pkg?.name === "string" ? pkg.name : "";
    if (!PNPM_FILTER_NAME_RE.test(name)) {
      return { error: `the package in the subdir has no usable name (${JSON.stringify(name)}) for pnpm --filter.` };
    }
    return { args: ["--filter", `${name}...`, "run", "build"], cwd: rootDir };
  }
  return { args: ["run", "build"], cwd: targetDir };
}

/** The lifecycle scripts that run repo code during install and build, with
 *  the pre/post hooks npm and yarn run around `prepare` and `build`. Measured
 *  on an install with no lockfile changes: npm 11 and yarn 1.22 both still run
 *  the deprecated `prepublish`, and npm runs `dependencies` whenever the
 *  install changes node_modules. */
const CONSENT_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "dependencies",
  "preprepare",
  "prepare",
  "postprepare",
  "prebuild",
  "build",
  "postbuild",
] as const;

const WORKSPACE_SKIP = new Set(["node_modules", ".git"]);

/** The directories a workspace pattern ("packages/*", "apps/**", "lib")
 *  names under `rootDir`. A "**" descends a few levels only. */
function expandWorkspacePattern(rootDir: string, pattern: string): string[] {
  const parts = pattern.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter(Boolean);
  if (parts.some((p) => p === "..")) return [];
  let dirs = [rootDir];
  for (const part of parts) {
    const next: string[] = [];
    for (const d of dirs) {
      if (part === "**") {
        const stack: Array<{ dir: string; depth: number }> = [{ dir: d, depth: 0 }];
        while (stack.length > 0) {
          const { dir, depth } = stack.pop() as { dir: string; depth: number };
          next.push(dir);
          if (depth >= 4) continue;
          for (const child of subdirs(dir)) stack.push({ dir: join(dir, child), depth: depth + 1 });
        }
      } else if (part.includes("*")) {
        const re = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
        for (const child of subdirs(d)) if (re.test(child)) next.push(join(d, child));
      } else if (existsSync(join(d, part))) {
        next.push(join(d, part));
      }
    }
    dirs = next;
  }
  return dirs;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !WORKSPACE_SKIP.has(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** The workspace patterns the root declares: package.json "workspaces"
 *  (npm, yarn) and pnpm-workspace.yaml's `packages:` list. */
function workspacePatterns(rootDir: string): string[] {
  const pkg = readJsonObject(join(rootDir, "package.json"));
  const ws = pkg?.workspaces;
  const out: string[] = [];
  const list = Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages;
  if (Array.isArray(list)) for (const p of list) if (typeof p === "string") out.push(p);
  let yaml = "";
  try {
    yaml = readFileSync(join(rootDir, "pnpm-workspace.yaml"), "utf8");
  } catch {
    // No pnpm workspace.
  }
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    const flow = /^packages\s*:\s*\[(.*)\]/.exec(line);
    if (flow?.[1] !== undefined) {
      for (const p of flow[1].split(",")) {
        const v = p.trim().replace(/^["']|["']$/g, "");
        if (v) out.push(v);
      }
      continue;
    }
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) inPackages = false;
    const item = inPackages ? /^\s*-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line) : null;
    if (item?.[1]) out.push(item[1]);
  }
  return out;
}

/** The scripts that will run: the root's, the target package's and, in a
 *  workspace, every workspace package's (the root install runs their install
 *  scripts, and a pnpm `--filter <name>...` build runs their builds). */
export function lifecycleScripts(rootDir: string, targetDir: string): Array<{ label: string; text: string }> {
  const out: Array<{ label: string; text: string }> = [];
  const dirs = [rootDir];
  const addDir = (d: string): void => {
    if (!dirs.some((x) => relative(x, d) === "")) dirs.push(d);
  };
  addDir(targetDir);
  const members: string[] = [];
  for (const pattern of workspacePatterns(rootDir)) {
    if (pattern.startsWith("!")) continue;
    for (const d of expandWorkspacePattern(rootDir, pattern)) {
      if (existsSync(join(d, "package.json"))) members.push(d);
    }
  }
  for (const d of members.sort()) addDir(d);
  for (const dir of dirs) {
    const scripts = readJsonObject(join(dir, "package.json"))?.scripts as Record<string, unknown> | undefined;
    if (!scripts) continue;
    const where = dir === rootDir ? "" : `${relative(rootDir, dir).replace(/\\/g, "/")} `;
    for (const name of CONSENT_SCRIPTS) {
      const text = scripts[name];
      if (typeof text === "string") out.push({ label: `${where}${name}`, text });
    }
  }
  return out;
}

const NPMRC_CODE_KEYS = /^\s*(node-options|script-shell|shell|pnpmfile|global-pnpmfile)\s*=\s*(.*)$/;
const PNPM_WORKSPACE_CODE_KEYS = /^(pnpmfile|globalPnpmfile|hooks|configDependencies)\s*:\s*(.*)$/;

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * The repo's own package-manager config files: they can run code at install
 * whatever package.json declares (yarn's yarnPath IS the yarn that runs, a
 * plugin or a .pnpmfile.cjs is loaded into it, .npmrc can set node-options).
 * Listed on the consent screen, the values that name code shown. Nothing is
 * blocked. Every directory from the repo root `rootDir` down to `targetDir`
 * is read: yarn and pnpm look for their config (and pnpm for its workspace)
 * in parent directories too, so a subdir package under a root .yarnrc.yml
 * runs the root's yarnPath even when the root has no package.json.
 */
export function repoConfigFiles(rootDir: string, targetDir: string): Array<{ label: string; text: string }> {
  const out: Array<{ label: string; text: string }> = [];
  const dirs = [rootDir];
  const rel = relative(rootDir, targetDir);
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
    let at = rootDir;
    for (const seg of rel.split(/[\\/]/).filter(Boolean)) {
      at = join(at, seg);
      dirs.push(at);
    }
  }
  for (const dir of dirs) {
    const where = dir === rootDir ? "" : `${relative(rootDir, dir).replace(/\\/g, "/")}/`;
    const add = (label: string, text: string): void => {
      out.push({ label: `${where}${label}`, text: text.trim() });
    };
    const npmrc = readText(join(dir, ".npmrc"));
    if (npmrc !== null) {
      const keys = npmrc.split(/\r?\n/).flatMap((l) => {
        const m = NPMRC_CODE_KEYS.exec(l);
        return m ? [`${m[1]}=${m[2]}`] : [];
      });
      add(".npmrc", keys.length > 0 ? keys.join("; ") : "package-manager settings");
    }
    const yarnrc = readText(join(dir, ".yarnrc"));
    if (yarnrc !== null) {
      const path = /^\s*yarn-path\s+["']?([^"'\r\n]+)["']?/m.exec(yarnrc)?.[1];
      if (path) add(".yarnrc yarn-path", `${path} (this file runs as yarn)`);
      else add(".yarnrc", "yarn settings");
    }
    const yml = readText(join(dir, ".yarnrc.yml"));
    if (yml !== null) {
      let named = false;
      const yarnPath = /^yarnPath\s*:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(yml)?.[1];
      if (yarnPath) {
        add(".yarnrc.yml yarnPath", `${yarnPath} (this file runs as yarn)`);
        named = true;
      }
      let inPlugins = false;
      for (const line of yml.split(/\r?\n/)) {
        if (/^plugins\s*:/.test(line)) {
          inPlugins = true;
          continue;
        }
        if (inPlugins && /^\S/.test(line)) inPlugins = false;
        if (!inPlugins) continue;
        const item = /^\s*-?\s*(?:path\s*:\s*)?["']?([^"'\s:][^"'\r\n]*?)["']?\s*$/.exec(line);
        if (item?.[1] && /^\s*-|^\s*path\s*:/.test(line)) {
          add(".yarnrc.yml plugin", item[1]);
          named = true;
        }
      }
      if (!named) add(".yarnrc.yml", "yarn settings");
    }
    for (const f of [".pnpmfile.cjs", ".pnpmfile.mjs"]) {
      if (existsSync(join(dir, f))) add(f, "loaded into pnpm at install");
    }
    const ws = readText(join(dir, "pnpm-workspace.yaml"));
    if (ws !== null) {
      for (const line of ws.split(/\r?\n/)) {
        const m = PNPM_WORKSPACE_CODE_KEYS.exec(line);
        if (m) add(`pnpm-workspace.yaml ${m[1]}`, m[2] || "(set)");
      }
    }
  }
  return out;
}

// --- manifest (yaw-mcp.json) -----------------------------------------------------

export const GIT_MANIFEST_FILENAME = "yaw-mcp.json";

export interface ManifestEnvDecl {
  secret?: string;
  required?: boolean;
  help?: string;
  default?: string;
}

export interface GitManifest {
  namespace?: string;
  description?: string;
  entry?: string;
  subdir?: string;
  env?: Record<string, ManifestEnvDecl>;
}

/** Keys that would change WHAT runs. The manifest only describes a server;
 *  its launch is always `node <entry>` and its build always `<pm> run build`. */
const MANIFEST_REFUSED_KEYS = new Set(["command", "args", "scripts", "build", "install", "runtime", "cwd"]);
const MANIFEST_KEYS = new Set(["$schema", "version", "namespace", "description", "entry", "subdir", "env"]);

function readManifestFile(file: string, label: string, warnings: string[], allowSubdir: boolean): GitManifest {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = parseJsonc(readFileSync(file, "utf8"));
  } catch (e) {
    warnings.push(`${label} ignored: ${printable((e as Error).message)}`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`${label} ignored: it is not a JSON object.`);
    return {};
  }
  const m = parsed as Record<string, unknown>;
  const out: GitManifest = {};
  for (const key of Object.keys(m)) {
    if (MANIFEST_REFUSED_KEYS.has(key)) {
      warnings.push(`${label}: "${key}" is refused -- the manifest cannot change what runs.`);
    } else if (!MANIFEST_KEYS.has(key)) {
      warnings.push(`${label}: unknown key "${printable(key)}" ignored.`);
    }
  }
  if (m.version !== undefined && m.version !== 1) {
    const shown = printable(JSON.stringify(m.version) ?? "");
    warnings.push(
      typeof m.version === "number" && m.version > 1
        ? `${label}: version ${shown} is newer than this yaw-mcp; reading the fields it knows.`
        : `${label}: version ${shown} is not a supported version (this yaw-mcp reads version 1); reading the fields it knows.`,
    );
  }
  const str = (key: string): string | undefined => {
    const v = m[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.trim() === "" || hasControlChar(v)) {
      warnings.push(`${label}: "${key}" ignored: not a non-empty string.`);
      return undefined;
    }
    return v;
  };
  const namespace = str("namespace");
  if (namespace !== undefined) {
    if (NAMESPACE_RE.test(namespace)) out.namespace = namespace;
    else
      warnings.push(
        `${label}: namespace "${printable(namespace)}" ignored: lowercase letters, digits and "_", 30 at most.`,
      );
  }
  const description = str("description");
  if (description !== undefined) out.description = description;
  for (const key of ["entry", "subdir"] as const) {
    const v = str(key);
    if (v === undefined) continue;
    if (key === "subdir" && !allowSubdir) {
      warnings.push(`${label}: "subdir" ignored in a subdir manifest.`);
      continue;
    }
    const reason = unsafeRelativePathReason(v);
    if (reason) warnings.push(`${label}: "${key}" ignored: ${reason}.`);
    else out[key] = v;
  }
  if (m.env !== undefined) {
    if (!m.env || typeof m.env !== "object" || Array.isArray(m.env)) {
      warnings.push(`${label}: "env" ignored: not an object.`);
    } else {
      const env: Record<string, ManifestEnvDecl> = {};
      for (const [k, raw] of Object.entries(m.env as Record<string, unknown>)) {
        if (!ENV_KEY_RE.test(k)) {
          warnings.push(`${label}: env "${printable(k)}" ignored: not a shell identifier.`);
          continue;
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          warnings.push(`${label}: env "${k}" ignored: a declaration is an object.`);
          continue;
        }
        const d = raw as Record<string, unknown>;
        const decl: ManifestEnvDecl = {};
        if (typeof d.secret === "string") {
          if (SECRET_NAME_RE.test(d.secret)) decl.secret = d.secret;
          else warnings.push(`${label}: env "${k}" secret name ignored: letters, digits, "_", "." or "-" only.`);
        }
        if (d.required === true) decl.required = true;
        if (typeof d.help === "string" && !hasControlChar(d.help)) decl.help = d.help;
        if (typeof d.default === "string" && !hasControlChar(d.default)) {
          if (decl.secret) warnings.push(`${label}: env "${k}" default ignored: a secret has no default.`);
          else decl.default = d.default;
        }
        env[k] = decl;
      }
      out.env = env;
    }
  }
  return out;
}

/**
 * The repo's optional yaw-mcp.json: at the root, and -- when a subdir is in
 * effect (`subdirFlag`, else the root manifest's own `subdir`; a `subdirFlag`
 * of "" names the root) -- at `<subdir>/yaw-mcp.json`, whose fields override
 * the root's key by key. A missing file is the ordinary case and says nothing.
 */
export function readGitManifest(repoDir: string, subdirFlag?: string): { manifest: GitManifest; warnings: string[] } {
  const warnings: string[] = [];
  const root = readManifestFile(join(repoDir, GIT_MANIFEST_FILENAME), GIT_MANIFEST_FILENAME, warnings, true);
  const subdir = subdirFlag ?? root.subdir;
  if (subdir === undefined || subdir === "") return { manifest: root, warnings };
  const label = `${subdir.replace(/\\/g, "/").replace(/\/+$/, "")}/${GIT_MANIFEST_FILENAME}`;
  const sub = readManifestFile(join(repoDir, ...subdir.split(/[\\/]/), GIT_MANIFEST_FILENAME), label, warnings, false);
  return { manifest: { ...root, ...sub, ...(root.subdir ? { subdir: root.subdir } : {}) }, warnings };
}

// --- consent ------------------------------------------------------------------

export const GIT_CONSENT_FILENAME = "consent.json";

export function gitConsentPath(home: string): string {
  return join(gitRoot(home), GIT_CONSENT_FILENAME);
}

function readConsentRepos(home: string): Record<string, { grantedAt: string }> {
  const file = readJsonObject(gitConsentPath(home));
  const repos = file?.repos;
  return repos && typeof repos === "object" && !Array.isArray(repos)
    ? (repos as Record<string, { grantedAt: string }>)
    : {};
}

/** Has this repo's code been allowed to run on this machine? Asked once per
 *  repo (normalizeRepoUrl), whatever later builds change. */
export function hasRepoConsent(url: string, home: string): boolean {
  return Object.hasOwn(readConsentRepos(home), normalizeRepoUrl(url));
}

export async function recordRepoConsent(url: string, home: string, now: Date = new Date()): Promise<void> {
  const repos = { ...readConsentRepos(home), [normalizeRepoUrl(url)]: { grantedAt: now.toISOString() } };
  await atomicWriteFile(
    gitConsentPath(home),
    `${JSON.stringify({ version: 1, repos }, null, 2)}\n`,
    "utf8",
    0o600,
    0o700,
  );
}

// --- tokens ---------------------------------------------------------------------

/** The username git sends with a vault token. */
export function tokenUsername(spec: GitSpec): string {
  if (spec.host === "github.com") return "x-access-token";
  if (spec.host.startsWith("gitlab.")) return "oauth2";
  return spec.username ?? "git";
}

/** Write the GIT_ASKPASS helper: it prints the username or the token from the
 *  env vars set only on that git child, so the token never touches a file.
 *  One sh script everywhere: Git for Windows runs a `#!/bin/sh` file through
 *  its own sh, where a .cmd helper went through cmd.exe, which splits an
 *  unquoted home path at & ( ) % or ^. */
export function writeAskpassHelper(home: string): string {
  const root = gitRoot(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, "askpass.sh");
  const body = [
    "#!/bin/sh",
    'case "$1" in',
    "  Username*) printf '%s\\n' \"$YAW_MCP_GIT_USERNAME\" ;;",
    "  *) printf '%s\\n' \"$YAW_MCP_GIT_TOKEN\" ;;",
    "esac",
    "",
  ].join("\n");
  writeFileSync(file, body, { mode: 0o700 });
  // The create mode applies only to a new file, under the umask: a helper
  // restored without its exec bit would fail as a rejected token.
  try {
    chmodSync(file, 0o700);
  } catch {
    // A filesystem without modes; the create mode is all there is.
  }
  return file;
}

/** Read a vault secret for a git token. The passphrase comes from the env (or
 *  this session), never a prompt: a failure names the secret and the fix. */
export async function readVaultSecret(name: string, home: string): Promise<string> {
  const vault = await loadVault(vaultPath(home));
  if (!vault || !Object.hasOwn(vault.entries, name)) {
    throw new Error(`secret "${name}" is not in your vault. Store it: yaw-mcp secrets set ${name}`);
  }
  const passphrase = vaultPassphrase();
  if (!passphrase) {
    throw new Error(
      `the vault is locked, so the git token in secret "${name}" cannot be read. Set YAW_MCP_VAULT_PASSPHRASE for this command.`,
    );
  }
  const value = getSecret(vault, await unlock(vault, passphrase), name);
  if (!value) throw new Error(`secret "${name}" is empty or unreadable.`);
  return value;
}

// --- build --------------------------------------------------------------------------

/** Dotted, so no namespace (NAMESPACE_RE) names a build directory that
 *  collides with it. */
export const GIT_LOCK_NAME = ".lock";

export { type GitBuildMarker, gitEntryBuilt, type PackageManagerName, readBuildMarker };

/** rmSync over a tree that can hold pnpm's junctions: rmSync unlinks a link
 *  rather than walking into its target. */
export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

/** removeTree for cleanup nobody asked for: a tree an orphaned npm or a
 *  scanner still holds (EBUSY on Windows) is left, with a warning, for the
 *  next run to sweep, rather than replacing the real result with the error. */
export function tryRemoveTree(path: string, warn?: (line: string) => void): boolean {
  try {
    removeTree(path);
    return true;
  } catch (e) {
    warn?.(
      `could not delete ${path} (${(e as NodeJS.ErrnoException).code ?? "error"}); it is swept on the next build.`,
    );
    return false;
  }
}

/** Delete every staging directory a killed build left. Called under the lock,
 *  so none of them belongs to a live build; one still held open is skipped. */
export function sweepStaging(home: string, warn?: (line: string) => void): void {
  const root = gitRoot(home);
  const sweep = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) if (n.startsWith(".tmp-")) tryRemoveTree(join(dir, n), warn);
  };
  sweep(root);
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const n of entries) if (NAMESPACE_RE.test(n)) sweep(join(root, n));
}

export interface GitBuildRequest {
  spec: GitSpec;
  /** The ref the entry tracks, for messages. */
  ref?: string;
  /** Full commit, or the short SHA to complete after the clone. */
  commit: string;
  /** Known up front (the name argument); otherwise the manifest must name one. */
  namespace?: string;
  /** The package's directory in the repo. Absent: the manifest may name one
   *  (a new entry). "": the repo root, whatever the manifest says -- what a
   *  pinned entry with no subdir builds, since its launch path is fixed. */
  subdir?: string;
  entry?: string;
  tokenSecret?: string;
  /** The commit the entry is pinned to now, for `update` on a tracked branch:
   *  the new commit must descend from it, or the branch was force-moved and
   *  nothing is built -- not even a switch to a build already on disk. */
  ancestor?: string;
  /** The entry comes from a committed project file (for the auth hint). */
  shared?: boolean;
  /** The bundles.json that will pin the result, recorded in refs.json so GC
   *  and remove keep the build while that file still pins it. */
  pinFile?: string;
  /** What a failed install or build says it left behind, in place of the
   *  default "Nothing was changed[; the previous build still runs]." -- for a
   *  caller that already changed something first (update --to deletes a build
   *  made for another machine before rebuilding it). */
  unchanged?: string;
}

export interface GitBuildContext {
  home: string;
  /** The env git children run under, and the PATH the package manager's
   *  binary is looked up on. It does NOT reach the install and build children
   *  themselves: `runPm` (defaultRunNpm) starts them from the stripped
   *  process.env plus the plan's overlay. The CLI passes process.env here, so
   *  the two only differ for an embedder or a test. */
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  /** `--yes`: the consent to run the repo's lifecycle scripts. */
  yes: boolean;
  platform?: NodeJS.Platform;
  progress: (line: string) => void;
  warn: (line: string) => void;
  /** Ask the consent question (TTY only). The lines are the screen to show.
   *  true runs the scripts; false declines (exit 1, nothing built);
   *  "cancelled" is Ctrl+C (exit 130, `cancelled: true`). Every command passes
   *  git-consent-prompt.ts's scriptConsentConfirm. */
  confirm?: (lines: string[]) => Promise<boolean | "cancelled">;
  runPm?: (args: string[], cwd: string, opts: RunNpmOptions) => Promise<number>;
  resolveToken?: (name: string) => Promise<string>;
  /** A context prepareGit already built (the caller ran ls-remote with it). */
  git?: PreparedGit;
  now?: () => Date;
}

export interface GitBuildResult {
  ok: true;
  namespace: string;
  commit: string;
  dir: string;
  subdir?: string;
  entry: string;
  manifest: GitManifest;
  pm: PackageManagerName;
  reused: boolean;
  /** Commits from `ancestor` to `commit`, when an ancestor was checked. */
  ahead?: number;
}

function timed(label: string, startedAt: number): string {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  return `${`${label} ...`.padEnd(56)} ${secs}s`;
}

function lockHolderPid(root: string): string {
  try {
    return readFileSync(join(root, GIT_LOCK_NAME), "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // A scanner or indexer holding a freshly written file open is the usual
      // Windows cause; it lets go within moments.
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      await new Promise<void>((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}

/** The relative, forward-slash form of `abs` inside `base`, or null outside it. */
function insideRelative(base: string, abs: string): string | null {
  const rel = relative(base, abs);
  if (rel === "" || rel.startsWith("..") || /^[A-Za-z]:/.test(rel) || rel.startsWith("/")) return null;
  return rel.replace(/\\/g, "/");
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The entry a package's own package.json names ("bin", else "main"), relative
 *  to `pkgDir` with forward slashes, or null when it names no file on disk. */
export function inferredEntry(pkgDir: string): string | null {
  const pkg = readJsonObject(join(pkgDir, "package.json"));
  const hit = packageEntry(pkgDir, typeof pkg?.name === "string" ? pkg.name : "");
  return hit ? insideRelative(pkgDir, hit.entry) : null;
}

/** The consent screen: what will run, and what the server will ask for. */
export function consentLines(
  scripts: Array<{ label: string; text: string }>,
  manifest: GitManifest,
  namespace: string,
  configs: Array<{ label: string; text: string }> = [],
): string[] {
  const lines: string[] = [];
  const list = (items: Array<{ label: string; text: string }>): void => {
    const width = Math.max(...items.map((s) => s.label.length)) + 3;
    for (const s of items) lines.push(`  ${`${s.label}:`.padEnd(width)}${s.text}`);
  };
  if (manifest.description) lines.push(`${namespace} -- "${manifest.description}" (from the repo's yaw-mcp.json)`);
  if (scripts.length === 0) {
    lines.push("This will install the repo's dependencies on this machine (it declares no lifecycle scripts).");
  } else {
    lines.push("This will run code from the repo on this machine:");
    list(scripts);
  }
  if (configs.length > 0) {
    lines.push("The package manager also reads the repo's own config, which can run code:");
    list(configs);
  }
  const secrets = Object.entries(manifest.env ?? {}).filter(([, d]) => d.secret);
  if (secrets.length > 0) {
    const parts = secrets.map(([k, d]) => `${d.secret} (${k})${d.help ? ` -- ${d.help}` : ""}`);
    lines.push(`Needs secrets: ${parts.join(", ")}`);
  }
  return lines.map(printable);
}

/**
 * Clone, install and build one commit into `<home>/.yaw-mcp/git/<ns>/<sha12>`,
 * under the git lock. The install and the build run in that directory itself,
 * never in one renamed afterwards: npm workspaces (and pnpm without symlink
 * rights) link packages with ABSOLUTE junctions on Windows, which a rename
 * leaves pointing at nothing. The `<sha12>.built` marker, written last and
 * outside the checkout (a repo can commit any file inside it), is the only
 * sign a build finished: a directory without a valid one is wiped before a
 * build starts in it and is never launched. A failure leaves
 * `<sha12>.failed`. An existing finished build for the commit is reused
 * without running anything.
 */
export async function buildGitSource(req: GitBuildRequest, ctx: GitBuildContext): Promise<GitBuildResult | GitFailure> {
  const root = gitRoot(ctx.home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const release = acquireSidecarsLock(root, GIT_LOCK_NAME);
  if (release === null) {
    return {
      ok: false,
      exitCode: 1,
      message: `another yaw-mcp is building git sources (pid ${lockHolderPid(root)}); try again shortly.`,
    };
  }
  try {
    sweepStaging(ctx.home, ctx.warn);
    const res = await buildLocked(req, ctx, root);
    // `repair: false` on purpose: a caller that GCs after this build
    // (update) must still SEE a refs.json that does not parse as the
    // unreadable source that stops the deletion -- consuming it here would
    // hand the GC a clean file holding only this record and let it delete
    // everything the corrupt one named.
    if (res.ok && req.pinFile) await writePinRecord(res.namespace, req.pinFile, res.commit, ctx.home, ctx.warn, false);
    return res;
  } finally {
    release();
  }
}

/** The git child context for one repo, with its vault token (HTTPS only)
 *  resolved, and the values to redact from every child's output. */
export interface PreparedGit {
  run: GitRunContext;
  secrets: Record<string, string>;
}

export async function prepareGit(
  spec: GitSpec,
  tokenSecret: string | undefined,
  ctx: Pick<GitBuildContext, "home" | "env" | "interactive" | "platform" | "warn" | "resolveToken">,
): Promise<({ ok: true } & PreparedGit) | GitFailure> {
  const run: GitRunContext = { env: ctx.env, interactive: ctx.interactive };
  const secrets: Record<string, string> = {};
  if (!tokenSecret) return { ok: true, run, secrets };
  if (spec.protocol === "ssh") {
    ctx.warn("--git-token-secret is ignored for ssh URLs; git uses your SSH setup.");
    return { ok: true, run, secrets };
  }
  if (spec.protocol === "file") {
    ctx.warn("--git-token-secret is ignored for file URLs; a local repository needs no authentication.");
    return { ok: true, run, secrets };
  }
  let value: string;
  try {
    value = await (ctx.resolveToken ?? ((n: string) => readVaultSecret(n, ctx.home)))(tokenSecret);
  } catch (e) {
    return { ok: false, exitCode: 1, message: (e as Error).message };
  }
  secrets[tokenSecret] = value;
  run.token = { value, username: tokenUsername(spec), askpass: writeAskpassHelper(ctx.home) };
  return { ok: true, run, secrets };
}

async function buildLocked(
  req: GitBuildRequest,
  ctx: GitBuildContext,
  root: string,
): Promise<GitBuildResult | GitFailure> {
  if (req.namespace !== undefined && !NAMESPACE_RE.test(req.namespace)) {
    return { ok: false, exitCode: 2, message: `"${printable(req.namespace)}" is not a usable namespace.` };
  }
  const subdirProblem = req.subdir ? unsafeRelativePathReason(req.subdir) : null;
  if (subdirProblem) return { ok: false, exitCode: 2, message: `subdir is refused: ${subdirProblem}.` };
  const runPm = ctx.runPm ?? defaultRunNpm;
  // Repo-supplied text (manifest fields, package.json, build output) reaches
  // these; none may drive the terminal.
  const warn = (line: string): void => ctx.warn(printable(line));
  const progress = (line: string): void => ctx.progress(printable(line));
  let prepared = ctx.git;
  if (!prepared) {
    const p = await prepareGit(req.spec, req.tokenSecret, { ...ctx, warn });
    if (!p.ok) return p;
    prepared = p;
  }
  const gitCtx = prepared.run;
  const secrets = prepared.secrets;
  const redact = (text: string): string => redactGitOutput(lastLines(text), secrets);
  // One spelling per directory: "./pkg", "pkg/" and "pkg" build, record and
  // compare as "pkg", and "." as the repo root -- what the loader's own
  // relativeSegments makes of a stored git.subdir.
  const tidySubdir = (s: string): string => relativeSegments(s).join("/");
  const reqSubdir = req.subdir === undefined ? undefined : tidySubdir(req.subdir);
  const subdirOf = (manifest: GitManifest): string | undefined =>
    (reqSubdir !== undefined ? reqSubdir : tidySubdir(manifest.subdir ?? "")) || undefined;

  const fullKnown = /^[0-9a-f]{40}$/.test(req.commit);
  const reuse = (ns: string, commit: string): GitBuildResult | GitFailure | null => {
    const dir = gitBuildDir(ns, commit, ctx.home);
    const marker = readBuildMarker(dir, commit);
    if (!marker) return null;
    const { manifest, warnings } = readGitManifest(dir, reqSubdir);
    const subdir = subdirOf(manifest);
    // Tidied on both sides: a marker an earlier yaw-mcp wrote holds the
    // subdir as it was typed.
    if (tidySubdir(marker.subdir ?? "") !== (subdir ?? "")) {
      return {
        ok: false,
        exitCode: 1,
        message: printable(
          `${commit.slice(0, 7)} is already built for subdir "${marker.subdir ?? "."}" under "${ns}"; add it under another name to build subdir "${subdir ?? "."}".`,
        ),
      };
    }
    for (const w of warnings) warn(w);
    const entry = (req.entry ?? marker.entry).replace(/\\/g, "/");
    // A regular file, as readBuildMarker demands of the entry a marker names.
    const entryPath = join(dir, ...(subdir ?? "").split("/"), ...entry.split("/"));
    if (!isRegularFile(entryPath)) {
      // The fresh-build branch's sentence (step "entry" below), so a directory
      // is not reported as missing.
      const why = existsSync(entryPath) ? "is not a file" : "does not exist";
      return {
        ok: false,
        exitCode: 1,
        message: printable(`Built ${commit.slice(0, 7)} but its entry ${entry} ${why}. Pass --entry <file>.`),
      };
    }
    return {
      ok: true,
      namespace: ns,
      commit,
      dir,
      ...(subdir ? { subdir } : {}),
      entry,
      manifest,
      pm: marker.pm,
      reused: true,
    };
  };
  // A force-move check needs the new commit's history from the remote, so
  // even a build already on disk is switched to only after it passes.
  const ancestorCheck = req.ancestor !== undefined && req.ancestor !== req.commit;
  if (req.namespace && fullKnown && !ancestorCheck) {
    const hit = reuse(req.namespace, req.commit);
    if (hit) {
      if (hit.ok) progress(`Using the existing build of ${req.commit.slice(0, GIT_BUILD_SHA_LEN)}`);
      return hit;
    }
  }

  let namespace = req.namespace;
  let commit = req.commit;
  // Straight into the final directory when it is known and holds no finished
  // build. Otherwise (no name yet, a short SHA, or a finished build the
  // force-move check must not touch) a `.tmp-*` clone, moved into place
  // before anything is installed in it: a bare checkout holds no links.
  const directDir =
    req.namespace && fullKnown && readBuildMarker(gitBuildDir(req.namespace, req.commit, ctx.home), req.commit) === null
      ? gitBuildDir(req.namespace, req.commit, ctx.home)
      : null;
  let work = directDir ?? join(root, `.tmp-${randomBytes(6).toString("hex")}`);
  let step = "clone";
  // `record` is off for a refusal: nothing failed to build, so no `.failed`.
  const fail = async (
    exitCode: 1 | 2 | 130,
    message: string,
    tail = "",
    suffix = "",
    record = true,
  ): Promise<GitFailure> => {
    if (tryRemoveTree(work, warn) && dirname(work) !== root) {
      try {
        // The namespace directory this build created, if nothing else is in it.
        rmdirSync(dirname(work));
      } catch {
        // Other builds or records live there.
      }
    }
    if (record && namespace && /^[0-9a-f]{40}$/.test(commit)) {
      const failedRecord = { commit, at: (ctx.now?.() ?? new Date()).toISOString(), step, tail: redact(tail) };
      try {
        mkdirSync(dirname(gitFailedPath(namespace, commit, ctx.home)), { recursive: true, mode: 0o700 });
        writeFileSync(gitFailedPath(namespace, commit, ctx.home), `${JSON.stringify(failedRecord, null, 2)}\n`, {
          mode: 0o600,
        });
      } catch {
        // The record is a diagnostic; the failure itself is still reported.
      }
    }
    const text = [message, ...(tail ? [redact(tail)] : []), ...(suffix ? [suffix] : [])].join("\n");
    return { ok: false, exitCode, message: asciiLines(text) };
  };

  if (directDir) {
    try {
      mkdirSync(dirname(directDir), { recursive: true, mode: 0o700 });
      // No valid marker: a build that never finished, never launched. A stale
      // `.built` goes first, so a half-deleted tree never reads as built.
      rmSync(builtMarkerPath(directDir), { force: true });
      if (existsSync(directDir)) removeTree(directDir);
    } catch (e) {
      return {
        ok: false,
        exitCode: 1,
        message: asciiLines(
          `could not clear the unfinished build at ${directDir}: ${(e as Error).message}. Close what holds it open and run this again.`,
        ),
      };
    }
  }

  const gitCfg = ["-c", "core.longpaths=true", "-c", "core.autocrlf=false"];
  let t = Date.now();
  const clone = await runGit(
    [...gitCfg, "clone", "--filter=blob:none", "--no-checkout", "--", req.spec.url, work],
    gitCtx,
  );
  if (clone.code !== 0) {
    if (clone.code === -1 && !clone.stderr) return fail(2, GIT_MISSING_MESSAGE);
    const access = gitAccessFailure(req.spec, clone.stderr, req.tokenSecret, req.shared);
    if (access) return fail(1, access);
    return fail(1, `git clone failed for ${scrubRepoUrlUserinfo(req.spec.url)}:`, clone.stderr);
  }
  progress(timed("Cloning (blobless)", t));
  step = "checkout";
  if (!fullKnown) {
    const rp = await runGit(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], gitCtx, work);
    const full = rp.stdout.trim();
    if (rp.code !== 0 || !/^[0-9a-f]{40}$/.test(full)) {
      return fail(
        1,
        `commit ${commit} is not in ${scrubRepoUrlUserinfo(req.spec.url)} (or the short SHA is ambiguous).`,
      );
    }
    commit = full;
  }
  const co = await runGit([...gitCfg, "checkout", "--detach", commit], gitCtx, work);
  if (co.code !== 0) {
    const sha12 = commit.slice(0, 12);
    const url = scrubRepoUrlUserinfo(req.spec.url);
    let headline = `git checkout of ${sha12} from ${url} failed:`;
    if (/invalid path '/i.test(co.stderr)) {
      headline = `${sha12} of ${url} holds a file name this system cannot create (on Windows: a reserved name such as aux or con, a ":", or a trailing dot or space), so it cannot be checked out here:`;
    } else if (/reference is not a tree|did not match any|unable to read tree/i.test(co.stderr)) {
      headline = `commit ${sha12} is not reachable from any branch or tag of ${url}:`;
    }
    return fail(1, headline, co.stderr);
  }
  const head = (await runGit(["rev-parse", "HEAD"], gitCtx, work)).stdout.trim();
  if (head !== commit)
    return fail(
      1,
      `checkout landed on ${head.slice(0, 12) || "nothing"}, not ${commit.slice(0, 12)}; refusing to build.`,
    );
  let ahead: number | undefined;
  if (req.ancestor && req.ancestor !== commit) {
    const anc = await runGit(["merge-base", "--is-ancestor", req.ancestor, commit], gitCtx, work);
    if (anc.code !== 0) {
      const ref = req.ref ?? "the ref";
      return fail(
        1,
        `${ref} was force-moved or rewritten: ${commit.slice(0, 7)} does not descend from the pinned ${req.ancestor.slice(0, 7)}. Nothing was changed. To take it anyway: yaw-mcp update ${namespace ?? "<name>"} --ref ${ref}`,
        "",
        "",
        false,
      );
    }
    const count = Number((await runGit(["rev-list", "--count", `${req.ancestor}..${commit}`], gitCtx, work)).stdout);
    if (Number.isInteger(count)) ahead = count;
  }

  const { manifest, warnings: manifestWarnings } = readGitManifest(work, reqSubdir);
  for (const w of manifestWarnings) warn(w);
  namespace = namespace ?? manifest.namespace;
  if (!namespace) {
    return fail(2, "nothing names this server: yaw-mcp add <name> --git <url>");
  }
  if (!directDir) {
    const hit = reuse(namespace, commit);
    if (hit) {
      tryRemoveTree(work, warn);
      if (hit.ok) progress(`Using the existing build of ${commit.slice(0, GIT_BUILD_SHA_LEN)}`);
      return hit.ok && ahead !== undefined ? { ...hit, ahead } : hit;
    }
    const dest = gitBuildDir(namespace, commit, ctx.home);
    try {
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      rmSync(builtMarkerPath(dest), { force: true });
      if (existsSync(dest)) removeTree(dest);
      await renameWithRetry(work, dest);
    } catch (e) {
      return fail(1, `could not move the clone into place: ${(e as Error).message}`);
    }
    work = dest;
  }
  const subdir = subdirOf(manifest);
  const targetDir = subdir ? join(work, ...subdir.split("/")) : work;
  if (targetDir !== work && insideRelative(work, targetDir) === null) {
    return fail(2, `subdir "${subdir}" is outside the repository; refusing to build.`, "", "", false);
  }
  if (!existsSync(join(targetDir, "package.json"))) {
    // subdir "" is a pinned entry (update, sidecars install, trust), whose
    // commands take no --subdir: the remedy is a re-add, and a subdir the
    // repo's manifest now declares is the likely one.
    if (req.subdir === "") {
      const moved = manifest.subdir ? printable(manifest.subdir) : undefined;
      const url = scrubRepoUrlUserinfo(req.spec.url) + (req.ref ? `#${req.ref}` : "");
      return fail(
        1,
        `the repo root has no package.json. "${namespace}" builds the repo root (its entry has no git.subdir)${
          moved ? `, but the repo's yaw-mcp.json now puts the server in "${moved}"` : ""
        }. Re-add it with the subdir: yaw-mcp add ${namespace} --git ${url} --subdir ${moved ?? "<path>"}${req.shared ? " --project" : ""}`,
      );
    }
    return fail(
      1,
      `${subdir ? `${subdir}/` : "the repo root "}has no package.json; pass --subdir <path> to the package.`,
    );
  }
  // ONE install, at the root whenever the root has a package.json: that is
  // right for a workspace, and it is an assumption for anything else. A subdir
  // package the root does not list as a workspace member (its own lockfile,
  // a tooling-only root) gets no install of its own -- its build and start
  // see only what the root install put in the root node_modules.
  const installDir = existsSync(join(work, "package.json")) ? work : targetDir;

  const plan = detectPackageManager(installDir);
  if ("error" in plan) return fail(2, `${scrubRepoUrlUserinfo(req.spec.url)}: ${plan.error}`);
  for (const w of plan.warnings) warn(w);
  const pmCmd = resolvePmCommand(plan, { env: ctx.env, platform: ctx.platform, exclude: work });
  if ("error" in pmCmd) return fail(2, pmCmd.error);
  const build = planBuild(plan, installDir, targetDir);
  if (build && "error" in build) return fail(2, build.error);

  if (!hasRepoConsent(req.spec.url, ctx.home)) {
    const lines = consentLines(
      lifecycleScripts(installDir, targetDir),
      manifest,
      namespace,
      repoConfigFiles(work, targetDir),
    );
    if (!ctx.yes) {
      if (!ctx.interactive || !ctx.confirm) {
        const refused = await fail(
          2,
          `${lines.join("\n")}\nNot a TTY, so nothing can be asked: re-run with --yes to allow this repo's scripts to run (asked once per repo).`,
          "",
          "",
          false,
        );
        return { ...refused, needsConsent: true };
      }
      const consent = await ctx.confirm(lines);
      if (consent === "cancelled") {
        return { ...(await fail(130, "Cancelled; nothing was built.", "", "", false)), cancelled: true };
      }
      if (!consent) return fail(1, "Aborted; nothing was built.", "", "", false);
    }
    await recordRepoConsent(req.spec.url, ctx.home, ctx.now?.());
  }

  const pmOpts = (output: (c: string) => void): RunNpmOptions => ({
    ...(pmCmd.bin ? { bin: pmCmd.bin } : {}),
    env: plan.env,
    output,
    platform: ctx.platform,
    windowsHide: !ctx.interactive,
  });
  const runStep = async (args: string[], cwd: string): Promise<{ code: number; log: string }> => {
    let log = "";
    const code = await runPm(
      [...pmCmd.prefix, ...args],
      cwd,
      pmOpts((c) => {
        log = (log + c).slice(-OUTPUT_CAP);
      }),
    );
    return { code, log };
  };
  const shown = (args: string[]): string =>
    `${pmCmd.label} ${args.filter((a) => a !== "--no-audit" && a !== "--no-fund").join(" ")}`;
  const sha7 = commit.slice(0, 7);
  const built = commit;
  const unchanged =
    req.unchanged ??
    (keptBuilds(namespace, ctx.home).some((k) => k.marker.commit !== built)
      ? "Nothing was changed; the previous build still runs."
      : "Nothing was changed.");

  step = "install";
  t = Date.now();
  const install = await runStep(plan.installArgs, installDir);
  if (install.code !== 0) {
    return fail(
      1,
      `${shown(plan.installArgs)} failed (exit ${install.code}) for ${namespace} @ ${sha7}:`,
      install.log,
      unchanged,
    );
  }
  progress(timed(`Installing (${shown(plan.installArgs)})`, t));
  if (build) {
    step = "build";
    t = Date.now();
    const b = await runStep(build.args, build.cwd);
    if (b.code !== 0) {
      return fail(1, `${shown(build.args)} failed (exit ${b.code}) for ${namespace} @ ${sha7}:`, b.log, unchanged);
    }
    progress(timed(`Building (${shown(build.args)})`, t));
  }

  step = "entry";
  const entryName = req.entry ?? manifest.entry;
  let entry: string | null = null;
  if (entryName !== undefined) {
    // A regular file: readBuildMarker accepts nothing else, so a directory
    // here (`--entry dist`) would write a marker that never reads as built.
    const entryPath = join(targetDir, ...entryName.split(/[\\/]/));
    if (isRegularFile(entryPath)) entry = entryName.replace(/\\/g, "/");
    else {
      const why = existsSync(entryPath) ? "is not a file" : "does not exist";
      return fail(1, `Built ${sha7} but its entry ${entryName} ${why}. Pass --entry <file>.`);
    }
  } else {
    entry = inferredEntry(targetDir);
    if (!entry) {
      return fail(
        1,
        `Built ${sha7} but found no entry: package.json has no "bin" or "main" file on disk. Pass --entry <file>.`,
      );
    }
  }
  progress(`Entry: ${entry}${entryName !== undefined ? "" : ' (package.json "bin" or "main")'}`);

  let pmVersion = "";
  await runPm(
    [...pmCmd.prefix, "--version"],
    installDir,
    pmOpts((c) => {
      pmVersion += c;
    }),
  );
  const marker: GitBuildMarker = {
    url: req.spec.url,
    commit,
    ...(subdir ? { subdir } : {}),
    entry,
    node: process.version,
    platform: ctx.platform ?? process.platform,
    arch: process.arch,
    pm: plan.pm,
    pmVersion: printable(pmVersion.trim().split(/\r?\n/).pop() ?? ""),
    builtAt: (ctx.now?.() ?? new Date()).toISOString(),
  };
  step = "finish";
  try {
    writeBuildMarker(work, marker);
  } catch (e) {
    return fail(1, `could not write the build marker: ${(e as Error).message}`);
  }
  rmSync(gitFailedPath(namespace, commit, ctx.home), { force: true });
  return {
    ok: true,
    namespace,
    commit,
    dir: work,
    ...(subdir ? { subdir } : {}),
    entry,
    manifest,
    pm: plan.pm,
    reused: false,
    ...(ahead !== undefined ? { ahead } : {}),
  };
}

// --- building pinned entries (sidecars install, trust) ------------------------

/** "needs-consent": not built because the repo's scripts were never allowed
 *  to run here and nothing could ask; a build that ran and broke is "failed".
 *  "cancelled": Ctrl+C at the consent prompt -- always the LAST report, since
 *  the entries after it are not attempted, and only on a TTY (so never in a
 *  --json document, which nothing is asked under). */
export type GitEntryStatus = "built" | "ready" | "failed" | "refused" | "needs-consent" | "cancelled";

export interface GitEntryReport {
  namespace: string;
  commit: string | null;
  status: GitEntryStatus;
  error: string | null;
}

/**
 * Build each git entry whose pinned commit has no build yet, one at a time.
 * Never moves a pin: an entry with no commit is refused, so nobody builds
 * whatever a branch points at today. `shared` names the project-file wording
 * for that refusal and for the auth hint.
 */
export async function buildPinnedGitEntries(
  servers: Array<Partial<UpstreamServerConfig>>,
  ctx: GitBuildContext,
  shared: boolean,
  pinFile?: string,
): Promise<GitEntryReport[]> {
  const reports: GitEntryReport[] = [];
  for (const s of servers) {
    const git = s.git;
    const ns = s.namespace;
    if (!git || !ns) continue;
    if (!git.commit) {
      reports.push({
        namespace: ns,
        commit: null,
        status: "refused",
        error: shared
          ? `${ns} has no "commit" -- refusing to build a moving ref from a shared file. Ask the maintainer to run yaw-mcp update --project.`
          : `${ns} has no "commit" -- refusing to build a moving ref. Pin one with: yaw-mcp update ${ns}`,
      });
      continue;
    }
    const commit = git.commit;
    if (gitEntryBuilt(ns, git, ctx.home)) {
      if (pinFile) await recordGitPin(ns, pinFile, commit, ctx.home, ctx.warn);
      reports.push({ namespace: ns, commit, status: "ready", error: null });
      continue;
    }
    const parsed = parseGitSpec(git.url);
    if (!parsed.ok) {
      reports.push({ namespace: ns, commit, status: "failed", error: asciiLines(`${ns}: ${parsed.error}`) });
      continue;
    }
    ctx.progress(`${ns}: building git ${commit.slice(0, GIT_BUILD_SHA_LEN)}`);
    const res = await buildGitSource(
      {
        spec: parsed.spec,
        ...(git.ref ? { ref: git.ref } : {}),
        commit,
        namespace: ns,
        subdir: git.subdir ?? "",
        entry: git.entry,
        ...(git.tokenSecret ? { tokenSecret: git.tokenSecret } : {}),
        shared,
        ...(pinFile ? { pinFile } : {}),
      },
      ctx,
    );
    if (res.ok) {
      ctx.progress(`${ns} ready (${commit.slice(0, 7)}).`);
      reports.push({ namespace: ns, commit, status: res.reused ? "ready" : "built", error: null });
    } else if (res.cancelled) {
      // The user left: build nothing more.
      reports.push({ namespace: ns, commit, status: "cancelled", error: asciiLines(res.message) });
      break;
    } else {
      reports.push({
        namespace: ns,
        commit,
        status: res.needsConsent ? "needs-consent" : "failed",
        error: asciiLines(res.message),
      });
    }
  }
  return reports;
}

/** Bytes under `path`, counting links as themselves (never their targets), so
 *  a pnpm tree's junctions are not walked twice or out of the tree. */
export function treeSizeBytes(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const p = stack.pop() as string;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = readdirSync(p);
      } catch {
        continue;
      }
      for (const n of names) stack.push(join(p, n));
    } else {
      total += st.size;
    }
  }
  return total;
}

// --- references: which bundles.json pins which build -------------------------

export const GIT_REFS_FILENAME = "refs.json";

/** How long recordGitPin waits for the git lock before it skips the record. */
export const GIT_PIN_LOCK_WAIT_MS = 5_000;

/** `~/.yaw-mcp/git/<ns>/refs.json`, `{ "<absolute bundles.json>": "<commit>" }`:
 *  files seen pinning a build of this namespace. A HINT, not the truth: GC and
 *  remove derive what is live from the files themselves (see gitLiveness), and
 *  this record only adds the files they could not otherwise find -- a project
 *  loaded under YAW_MCP_TRUST_PROJECT outside the cwd, say. */
export function gitRefsPath(namespace: string, home: string): string {
  return join(gitCheckoutDir(namespace, home), GIT_REFS_FILENAME);
}

type RefsRead =
  | { kind: "ok"; refs: Record<string, string> }
  /** It exists and was read, but is not a JSON object: a hand edit, a
   *  truncated or zero-byte write. */
  | { kind: "corrupt"; message: string }
  /** It could not be read at all (EACCES, EIO...). */
  | { kind: "unreadable"; message: string };

function readRefs(namespace: string, home: string): RefsRead {
  const path = gitRefsPath(namespace, home);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "ok", refs: {} };
    return { kind: "unreadable", message: `cannot read ${path} (${code ?? asciiLines((e as Error).message)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "corrupt", message: `${path} is ${raw.trim() === "" ? "empty" : "not a JSON object"}` };
  }
  const refs: Record<string, string> = {};
  for (const [file, commit] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof commit === "string" && GIT_COMMIT_RE.test(commit)) refs[file] = commit;
  }
  return { kind: "ok", refs };
}

/** Move a refs.json that does not parse to `refs.json.bad`, so nothing writes
 *  over what it held. The warning to print, naming both paths. */
function setRefsAside(namespace: string, home: string, message: string): string {
  const path = gitRefsPath(namespace, home);
  try {
    renameSync(path, `${path}.bad`);
    return `${message}; moved it to ${path}.bad`;
  } catch (e) {
    return `${message}, and it could not be moved to ${path}.bad: ${asciiLines((e as Error).message)}`;
  }
}

async function writeRefs(namespace: string, home: string, refs: Record<string, string>): Promise<void> {
  await atomicWriteFile(gitRefsPath(namespace, home), `${JSON.stringify(refs, null, 2)}\n`, "utf8", 0o600, 0o700);
}

/** The record write itself; the caller holds the git lock.
 *
 *  `repair` decides what a refs.json that does not parse does: a direct
 *  `recordGitPin` (a rollback, a reuse, a pin with no build) moves it aside and
 *  writes a fresh file with just this record, as it always has. A record made
 *  DURING a build does not -- the build's own GC reads refs.json straight
 *  afterwards, and consuming the corrupt file there would turn "unreadable
 *  source: delete nothing" into a clean file that names only what this build
 *  just added, letting the GC delete everything the corrupt file held. Those
 *  callers repair upfront instead (see buildGitSource). */
async function writePinRecord(
  namespace: string,
  file: string,
  commit: string,
  home: string,
  warn: (line: string) => void,
  repair = true,
): Promise<void> {
  try {
    const read = readRefs(namespace, home);
    if (read.kind === "unreadable") {
      warn(`could not record that ${file} uses build ${commit.slice(0, 7)} of ${namespace}: ${read.message}`);
      return;
    }
    if (read.kind === "corrupt") {
      if (!repair) {
        warn(
          `could not record that ${file} uses build ${commit.slice(0, 7)} of ${namespace}: ${gitRefsPath(namespace, home)} is unreadable; it is kept for the next update or remove to check`,
        );
        return;
      }
      warn(setRefsAside(namespace, home, read.message));
    }
    const refs = read.kind === "ok" ? read.refs : {};
    const key = resolve(file);
    if (refs[key] === commit) return;
    await writeRefs(namespace, home, { ...refs, [key]: commit });
  } catch (e) {
    warn(`could not record that ${file} uses build ${commit.slice(0, 7)} of ${namespace}: ${(e as Error).message}`);
  }
}

/** The git lock, waiting up to `waitMs` for another yaw-mcp to let go of it. */
async function acquireGitLockWithin(root: string, waitMs: number): Promise<(() => void) | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = acquireSidecarsLock(root, GIT_LOCK_NAME);
    if (release !== null || Date.now() >= deadline) return release;
    await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
}

/**
 * Record that `file` pins `commit` of `namespace` when no build ran: a
 * rollback, an update with nothing new, a build already on disk, an
 * activation. Only ever under the git lock, waited for up to `waitMs`: an
 * unlocked write could be lost to a GC rewriting the same file. When the lock
 * stays busy the record is skipped -- it is a hint, and GC derives what is
 * live from the files themselves.
 */
export async function recordGitPin(
  namespace: string,
  file: string,
  commit: string,
  home: string,
  warn: (line: string) => void = () => {},
  opts: { waitMs?: number } = {},
): Promise<void> {
  if (!NAMESPACE_RE.test(namespace) || !GIT_COMMIT_RE.test(commit)) return;
  if (!existsSync(gitCheckoutDir(namespace, home))) return;
  const known = readRefs(namespace, home);
  if (known.kind === "ok" && known.refs[resolve(file)] === commit) return;
  const release = await acquireGitLockWithin(gitRoot(home), opts.waitMs ?? GIT_PIN_LOCK_WAIT_MS);
  if (release === null) {
    log("debug", "Skipped recording a git pin: the git lock stayed busy", { namespace, file, commit });
    return;
  }
  try {
    await writePinRecord(namespace, file, commit, home, warn);
  } finally {
    release();
  }
}

/**
 * Drop the record that `file` pins `commit` of `namespace`, when refs.json
 * still says exactly that: a build recorded for a file that then did not pin
 * it (an update whose new build failed its start check, for an entry with no
 * commit pinned). Under the git lock, like recordGitPin; a busy lock, an
 * unreadable or corrupt refs.json, or a record naming another commit leaves
 * the file as it is -- the record is a hint, and GC derives what is live from
 * the files themselves.
 */
export async function forgetGitPin(
  namespace: string,
  file: string,
  commit: string,
  home: string,
  warn: (line: string) => void = () => {},
  opts: { waitMs?: number } = {},
): Promise<void> {
  if (!NAMESPACE_RE.test(namespace) || !GIT_COMMIT_RE.test(commit)) return;
  if (!existsSync(gitCheckoutDir(namespace, home))) return;
  const key = resolve(file);
  const known = readRefs(namespace, home);
  if (known.kind !== "ok" || known.refs[key] !== commit) return;
  const release = await acquireGitLockWithin(gitRoot(home), opts.waitMs ?? GIT_PIN_LOCK_WAIT_MS);
  if (release === null) {
    log("debug", "Skipped dropping a git pin record: the git lock stayed busy", { namespace, file, commit });
    return;
  }
  try {
    const read = readRefs(namespace, home);
    if (read.kind !== "ok" || read.refs[key] !== commit) return;
    const { [key]: _dropped, ...rest } = read.refs;
    await writeRefs(namespace, home, rest);
  } catch (e) {
    warn(
      `could not drop the record that ${file} uses build ${commit.slice(0, 7)} of ${namespace}: ${(e as Error).message}`,
    );
  } finally {
    release();
  }
}

/**
 * The activation preflight's record: the file the loader honours from `cwd`
 * (an approved or bypassed project file, else the user file) uses the build of
 * `commit`, when that file really pins it. Never waits for the lock: an
 * activation must not stall behind a build, and the next one records it.
 */
export async function recordLoadedGitPin(
  namespace: string,
  commit: string,
  opts: { home: string; cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const probe = await probeProjectTrust({ cwd: opts.cwd, home: opts.home, env: opts.env }).catch(() => null);
  const file = probe?.path && projectFileIsHonoured(probe) ? probe.path : localBundlesPath(userConfigDir(opts.home));
  if (pinnedCommitIn(file, namespace) !== commit) return;
  await recordGitPin(namespace, file, commit, opts.home, () => {}, { waitMs: 0 });
}

/** A path's parent is a directory that exists. */
function parentDirExists(file: string): boolean {
  try {
    return statSync(dirname(file)).isDirectory();
  } catch {
    return false;
  }
}

/** The commit `file` pins for `namespace` now: null when it pins none or the
 *  file is gone, "unreadable" when it cannot be read or parsed, when its git
 *  block for `namespace` is one the loader refuses, or when even its directory
 *  is missing -- an unmounted drive reads as ENOENT, not as a deleted file. */
function pinnedCommitIn(file: string, namespace: string): string | null | "unreadable" {
  const read = readBundlesServersSync(file);
  if (read.kind === "absent") return parentDirExists(file) ? null : "unreadable";
  if (read.kind === "error") return "unreadable";
  for (const s of read.servers) {
    if ((s as { namespace?: unknown } | null)?.namespace !== namespace) continue;
    const raw = (s as { git?: unknown }).git;
    if (raw === undefined || raw === null) return null;
    const git = gitSourceFromRaw(raw, namespace, []);
    if (git === null) return "unreadable";
    return git.commit ?? null;
  }
  return null;
}

/** A build some file still pins, with the files that pin it. */
export interface GitPinnedBuild {
  sha12: string;
  files: string[];
}

/** What is live for one namespace, derived from every file that could pin it. */
interface GitLiveness {
  pins: GitPinnedBuild[];
  /** Sources that could not be read. While any is listed nothing is deleted. */
  unreadable: string[];
  /** Warnings to print as they are (a refs.json moved aside). */
  notes: string[];
  /** The refs.json to write back: records followed or dropped. */
  refs: Record<string, string>;
  refsChanged: boolean;
}

function pathKey(p: string): string {
  const abs = resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * Every commit of `namespace` some file still pins, read from the files
 * themselves: the user bundles.json, every project file the trust store
 * approved (stale approvals included, while the file exists), the project file
 * found from `cwd`, and every file refs.json records. `exclude` (the file an
 * entry is being removed from) pins nothing. `repair` moves a refs.json that
 * does not parse aside; a preview leaves it.
 */
async function gitLiveness(
  namespace: string,
  home: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; exclude?: string; repair: boolean },
): Promise<GitLiveness> {
  const unreadable: string[] = [];
  const notes: string[] = [];
  const files = new Map<string, string>();
  const add = (f: string): void => {
    if (!files.has(pathKey(f))) files.set(pathKey(f), resolve(f));
  };

  const read = readRefs(namespace, home);
  const before = read.kind === "ok" ? read.refs : {};
  if (read.kind === "unreadable") unreadable.push(read.message);
  if (read.kind === "corrupt") {
    unreadable.push(gitRefsPath(namespace, home));
    notes.push(opts.repair ? setRefsAside(namespace, home, read.message) : read.message);
  }

  add(localBundlesPath(userConfigDir(home)));
  const store = await readTrustStore(home);
  if (store.malformed) unreadable.push(store.malformedReason ?? trustStorePath(home));
  for (const r of trustedRecords(store)) add(r.path);
  if (opts.cwd !== undefined) {
    const dir = await findProjectConfigDir(opts.cwd, home, opts.env ?? process.env).catch((e: unknown) => {
      // "no project file here" is a normal answer; anything else means the
      // walk could not be completed, and a source we failed to read must
      // never read as "pins nothing".
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== undefined) unreadable.push(`the project config walk from ${resolve(opts.cwd as string)} (${code})`);
      return null;
    });
    if (dir) add(localBundlesPath(dir));
  }
  for (const f of Object.keys(before)) add(f);

  const recorded = new Map(Object.entries(before).map(([f, c]) => [pathKey(f), { file: f, commit: c }]));
  const refs: Record<string, string> = {};
  const byBuild = new Map<string, string[]>();
  const skip = opts.exclude === undefined ? null : pathKey(opts.exclude);
  for (const [key, file] of files) {
    const now = pinnedCommitIn(file, namespace);
    const rec = recorded.get(key);
    if (now === "unreadable") {
      unreadable.push(file);
      if (rec) refs[rec.file] = rec.commit;
      continue;
    }
    if (now === null) continue;
    if (rec) refs[rec.file] = now;
    if (key === skip) continue;
    const sha12 = now.slice(0, GIT_BUILD_SHA_LEN);
    byBuild.set(sha12, [...(byBuild.get(sha12) ?? []), file]);
  }
  const pins = [...byBuild].map(([sha12, f]) => ({ sha12, files: f }));
  return { pins, unreadable, notes, refs, refsChanged: JSON.stringify(refs) !== JSON.stringify(before) };
}

/** The warning for a namespace GC or remove left alone because a source of
 *  its liveness could not be read. */
export function gitLivenessWarning(namespace: string, unreadable: string[]): string {
  return `no build of ${namespace} was deleted: yaw-mcp could not read ${unreadable.join(", ")}, which may pin one. Fix or reconnect it (or, for a project that is gone for good, yaw-mcp trust --revoke <its bundles.json>) and the next update or remove deletes what is unused.`;
}

/** The `<sha12>` build directories of `namespace` on disk, finished or not. */
function buildDirNames(namespace: string, home: string): string[] {
  try {
    return readdirSync(gitCheckoutDir(namespace, home)).filter((n) => /^[0-9a-f]{12}$/.test(n));
  } catch {
    return [];
  }
}

/**
 * What `remove` would do to the builds of `namespace` once `removing` (the
 * file losing its entry) no longer pins one: the builds it deletes, the ones
 * it keeps because another file still pins them, and the sources it could not
 * read (then it deletes nothing). Read-only.
 */
export async function planGitRemoval(
  namespace: string,
  home: string,
  removing: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ deletes: Array<{ sha12: string; bytes: number }>; keeps: GitPinnedBuild[]; unreadable: string[] }> {
  const dir = gitCheckoutDir(namespace, home);
  const onDisk = buildDirNames(namespace, home);
  const live = await gitLiveness(namespace, home, { ...opts, exclude: removing, repair: false });
  const keeps = live.pins.filter((p) => onDisk.includes(p.sha12));
  if (live.unreadable.length > 0) return { deletes: [], keeps, unreadable: live.unreadable };
  const kept = new Set(keeps.map((p) => p.sha12));
  const deletes = onDisk
    .filter((n) => !kept.has(n))
    .map((sha12) => ({ sha12, bytes: treeSizeBytes(join(dir, sha12)) }));
  return { deletes, keeps, unreadable: [] };
}

/** `~/.yaw-mcp/git/<ns>`: every build of one entry. */
export function gitCheckoutDir(namespace: string, home: string): string {
  return join(gitRoot(home), namespace);
}

function lockedMessage(root: string, tail: string): string {
  return `another yaw-mcp is building git sources (pid ${lockHolderPid(root)}); ${tail}`;
}

interface CollectResult {
  removed: string[];
  /** Build directories that could not be deleted (`<sha12>`). */
  failed: string[];
  kept: GitPinnedBuild[];
  errors: string[];
  unreadable: string[];
  notes: string[];
}

/** The GC itself; the caller holds the git lock, so liveness is read at the
 *  moment of deletion and no record or build can land meanwhile. */
async function collectLocked(
  namespace: string,
  keep: string[],
  home: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<CollectResult> {
  const dir = gitCheckoutDir(namespace, home);
  const live = await gitLiveness(namespace, home, { ...opts, repair: true });
  const base = { kept: live.pins, unreadable: live.unreadable, notes: live.notes };
  // Fail safe: a source that cannot be read may pin any build.
  if (live.unreadable.length > 0) return { removed: [], failed: [], errors: [], ...base };
  const kept = new Set([...keep.map((c) => c.slice(0, GIT_BUILD_SHA_LEN)), ...live.pins.map((p) => p.sha12)]);
  const removed: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];
  // `.built` sorts after its directory, so delete every unkept marker first: a
  // directory a held-open file stops half-way through never reads as built.
  const names = readdirSync(dir).sort((a, b) => Number(b.endsWith(".built")) - Number(a.endsWith(".built")));
  for (const n of names) {
    const sha = /^([0-9a-f]{12})(\.failed|\.built)?$/.exec(n);
    if (!sha?.[1] || kept.has(sha[1])) continue;
    try {
      removeTree(join(dir, n));
      if (!sha[2]) removed.push(sha[1]);
    } catch (e) {
      if (!sha[2]) failed.push(sha[1]);
      errors.push(`${n}: ${asciiLines((e as Error).message)}`);
    }
  }
  if (live.refsChanged) {
    try {
      await writeRefs(namespace, home, live.refs);
    } catch (e) {
      errors.push(`${GIT_REFS_FILENAME}: ${asciiLines((e as Error).message)}`);
    }
  }
  return { removed, failed, errors, ...base };
}

/** What removeGitCheckout did. `kept` lists builds left because a file pins
 *  them; `failed` the `<sha12>` builds it meant to delete and could not. */
export type GitCheckoutRemoval =
  | { ok: true; removed: string[]; kept: GitPinnedBuild[]; unreadable: string[]; notes: string[] }
  | {
      ok: false;
      message: string;
      removed: string[];
      failed: string[];
      kept: GitPinnedBuild[];
      notes: string[];
    };

/**
 * remove: delete every build of `namespace` that no file still pins (see
 * gitLiveness), under the git lock so no build is renaming into it and no
 * record is written meanwhile. The directory goes too once no pinned build is
 * left. When a source cannot be read, nothing is deleted.
 */
export async function removeGitCheckout(
  namespace: string,
  home: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<GitCheckoutRemoval> {
  const none = { removed: [], failed: [], kept: [], notes: [] };
  if (!NAMESPACE_RE.test(namespace)) return { ok: false, message: `"${namespace}" is not a namespace.`, ...none };
  const dir = gitCheckoutDir(namespace, home);
  if (!existsSync(dir)) return { ok: true, removed: [], kept: [], unreadable: [], notes: [] };
  const root = gitRoot(home);
  const release = acquireSidecarsLock(root, GIT_LOCK_NAME);
  if (release === null) return { ok: false, message: lockedMessage(root, "nothing was deleted."), ...none };
  try {
    const res = await collectLocked(namespace, [], home, opts);
    const kept = res.kept.filter((p) => existsSync(join(dir, p.sha12)));
    if (res.errors.length > 0) {
      return {
        ok: false,
        message: res.errors.join("; "),
        removed: res.removed,
        failed: res.failed,
        kept,
        notes: res.notes,
      };
    }
    if (kept.length === 0 && res.unreadable.length === 0) removeTree(dir);
    return { ok: true, removed: res.removed, kept, unreadable: res.unreadable, notes: res.notes };
  } catch (e) {
    return { ok: false, message: asciiLines((e as Error).message), ...none };
  } finally {
    release();
  }
}

// --- kept builds and GC (update) ------------------------------------------------

/** Was this build made for the machine reading it? A native addon is bound to
 *  the platform, the arch and the node major it was compiled under. */
export function buildMatchesHost(marker: GitBuildMarker, platform: NodeJS.Platform = process.platform): boolean {
  const major = (v: string): string => /^v?(\d+)/.exec(v)?.[1] ?? "";
  return marker.platform === platform && marker.arch === process.arch && major(marker.node) === major(process.version);
}

/** Every finished build of `namespace` on this machine, newest first. */
export function keptBuilds(namespace: string, home: string): Array<{ dir: string; marker: GitBuildMarker }> {
  const root = gitCheckoutDir(namespace, home);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: Array<{ dir: string; marker: GitBuildMarker }> = [];
  for (const n of names) {
    if (!/^[0-9a-f]{12}$/.test(n)) continue;
    const marker = readBuildMarker(join(root, n));
    if (marker) out.push({ dir: join(root, n), marker });
  }
  return out.sort((a, b) => String(b.marker.builtAt).localeCompare(String(a.marker.builtAt)));
}

/**
 * Delete every build of `namespace` except the commits in `keep` (the current
 * pin and the one before it) and every commit some file still pins (see
 * gitLiveness: nothing at all when one of those files cannot be read), plus the `.failed` records of commits not kept. Under the git
 * lock, so no build is renaming into the directory meanwhile. A build that
 * cannot be deleted -- a running server holding a native addon open on
 * Windows -- is left for the next run and named in `errors`.
 */
export async function gcGitBuilds(
  namespace: string,
  keep: string[],
  home: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<
  { removed: string[]; errors: string[]; unreadable: string[]; notes: string[] } | { locked: true; message: string }
> {
  const root = gitRoot(home);
  if (!NAMESPACE_RE.test(namespace) || !existsSync(gitCheckoutDir(namespace, home))) {
    return { removed: [], errors: [], unreadable: [], notes: [] };
  }
  const release = acquireSidecarsLock(root, GIT_LOCK_NAME);
  if (release === null) return { locked: true, message: lockedMessage(root, "old builds were left in place.") };
  try {
    const res = await collectLocked(namespace, keep, home, opts);
    return { removed: res.removed, errors: res.errors, unreadable: res.unreadable, notes: res.notes };
  } finally {
    release();
  }
}

/** Delete one build so it can be made again (a build for another machine),
 *  under the git lock. Liveness is read under that lock, like every other
 *  deletion: a source that cannot be read may pin this build, so nothing is
 *  deleted then -- `gitLivenessWarning` says so. A READABLE pin does not stop
 *  it, on purpose: the caller rebuilds this same commit straight after, so
 *  every file that pins it gets the build back. */
export async function discardBuild(
  namespace: string,
  commit: string,
  home: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: true } | GitFailure> {
  const root = gitRoot(home);
  const release = acquireSidecarsLock(root, GIT_LOCK_NAME);
  if (release === null) {
    return {
      ok: false,
      exitCode: 1,
      message: `another yaw-mcp is building git sources (pid ${lockHolderPid(root)}); try again shortly.`,
    };
  }
  try {
    const live = await gitLiveness(namespace, home, { ...opts, repair: true });
    if (live.unreadable.length > 0) {
      return { ok: false, exitCode: 1, message: gitLivenessWarning(namespace, live.unreadable) };
    }
    rmSync(builtMarkerPath(gitBuildDir(namespace, commit, home)), { force: true });
    removeTree(gitBuildDir(namespace, commit, home));
    return { ok: true };
  } catch (e) {
    return { ok: false, exitCode: 1, message: asciiLines((e as Error).message) };
  } finally {
    release();
  }
}

/**
 * Delete the build of `commit` when no file pins it: the one `add` made for an
 * entry it then refused to write, so nothing would ever name it again. Under
 * the git lock, with liveness read there like every other deletion. A build
 * some file pins is left alone (`removed: false`, no reason). A held lock or a
 * source that cannot be read leaves it too, and `reason` says which. The
 * namespace directory goes with it when that leaves it empty.
 */
export async function discardUnpinnedBuild(
  namespace: string,
  commit: string,
  home: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ removed: boolean; reason?: string }> {
  const root = gitRoot(home);
  const release = acquireSidecarsLock(root, GIT_LOCK_NAME);
  if (release === null) return { removed: false, reason: lockedMessage(root, "the build was left in place.") };
  try {
    const live = await gitLiveness(namespace, home, { ...opts, repair: false });
    if (live.unreadable.length > 0) {
      return { removed: false, reason: `yaw-mcp could not read ${live.unreadable.join(", ")}, which may pin it.` };
    }
    const sha12 = commit.slice(0, GIT_BUILD_SHA_LEN);
    if (live.pins.some((p) => p.sha12 === sha12)) return { removed: false };
    const dir = gitBuildDir(namespace, commit, home);
    rmSync(builtMarkerPath(dir), { force: true });
    removeTree(dir);
    try {
      rmdirSync(gitCheckoutDir(namespace, home));
    } catch {
      // Not empty (another build, refs.json) or already gone.
    }
    return { removed: true };
  } catch (e) {
    return { removed: false, reason: asciiLines((e as Error).message) };
  } finally {
    release();
  }
}

// --- update --check state ---------------------------------------------------------

export const GIT_STATE_FILENAME = "state.json";

/** The last ls-remote verdict for one entry. doctor reads it offline: a
 *  private SSH remote can prompt or hang, so doctor never asks the remote. */
export interface GitStateEntry {
  url: string;
  ref: string | null;
  kind: GitRefKind | null;
  pinned: string | null;
  /** What the tracked ref points at on the remote; null for a ref it lacks. */
  remote: string | null;
  newerTags: string[];
  checkedAt: string;
}

export function gitStatePath(home: string): string {
  return join(gitRoot(home), GIT_STATE_FILENAME);
}

export function readGitState(home: string): Record<string, GitStateEntry> {
  const entries = readJsonObject(gitStatePath(home))?.entries;
  return entries && typeof entries === "object" && !Array.isArray(entries)
    ? (entries as Record<string, GitStateEntry>)
    : {};
}

/** Merge `entries` (keyed by namespace) into state.json. */
export async function writeGitState(home: string, entries: Record<string, GitStateEntry>): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const merged = { ...readGitState(home), ...entries };
  await atomicWriteFile(
    gitStatePath(home),
    `${JSON.stringify({ version: 1, entries: merged }, null, 2)}\n`,
    "utf8",
    0o600,
    0o700,
  );
}
