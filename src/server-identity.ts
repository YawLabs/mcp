// What a configured server IS, independent of the namespace it is filed under.
//
// A namespace is only a label in bundles.json: the same program can be
// registered again as `ssh2`, and every deny written against `ssh` would miss
// it. The `blocked` and `blockedTools` lists therefore also match on the launch
// identity computed here: the package a runner fetches, the script an
// interpreter runs, the exact launch of any other command, or the URL contacted.
//
// Two different questions are answered, and they fail in different directions:
//
//   - "Is this the same server as that denied namespace?" (sharedIdentity) has
//     to be precise, because a wrong yes takes an unrelated server down. A
//     command we know nothing about (java, dotnet, ssh, a server binary) only
//     counts as the same server when its arguments match too.
//   - "Does this launch match the identity the user named?" (`all`) is broad,
//     because the user asked for it: `command:java` means every java launch.
//
// A runner flag with no table entry is ambiguous: the next token is either its
// value or the package. Both readings are kept, the value reading as `weak`, so
// an unknown flag cannot hide a package from a deny.
//
// This is a guard against re-registration, not a proof of what a server does.
// A wrapper script, a renamed copy of a binary, a fork published under another
// name and a shell-string launch all have a different identity (or none).

import { posix } from "node:path";
import { launcherBasename } from "./oam-spawn.js";
import { isRemoteEntry, type UpstreamServerConfig } from "./types.js";

export interface ServerIdentity {
  /** The launch's definite identity, or null when it names nothing specific:
   *  binding a deny to bare `npx` or `bash` would take down every unrelated
   *  server launched the same way. */
  primary: string | null;
  /** Identities this launch definitely has. */
  strong: string[];
  /** Identities it may have: an ambiguous flag value, or the bare name of a
   *  command given by path. Two launches never match on these alone. */
  weak: string[];
  /** Everything an explicit `package:` / `command:` / `url:` entry may match. */
  all: string[];
}

interface FlagTable {
  /** Flags followed by a value that is not the target. */
  value: ReadonlySet<string>;
  /** Flags that take no value. */
  bool: ReadonlySet<string>;
  /** Flags whose value IS the target. */
  target?: ReadonlySet<string>;
  /** Flags that replace the target with inline code or a shell string. */
  stop?: ReadonlySet<string>;
  /** Treat an unlisted flag as taking no value (interpreters, whose first
   *  positional is the script) rather than as ambiguous. */
  unknownIsBool?: boolean;
}

const IDENTITY_ENTRY_RE = /^(package|command|url):(.+)$/;
const WIN_EXE_EXT = /\.(?:exe|cmd|bat)$/i;
/** Separates a command from its arguments inside an exact-launch identity. */
const ARGS_SEPARATOR = "\0";

const flags = (list: string): ReadonlySet<string> => new Set(list.split(" ").filter(Boolean));

const SHELLS = flags("sh bash zsh dash fish cmd powershell pwsh");
/** Launchers that say nothing about the server when no target can be parsed. */
const GENERIC_LAUNCHERS = flags("npx bunx pnpx uvx pipx uv npm pnpm yarn docker podman");

const NODE_RUNNER: FlagTable = {
  value: flags("--registry --cache --userconfig --prefix --workspace -w --loglevel --node-options --shell"),
  bool: flags("-y --yes --no -q --quiet --silent --bun --ignore-existing --prefer-offline --prefer-online --offline"),
  target: flags("-p --package"),
  stop: flags("-c --call"),
};
const UV_RUNNER: FlagTable = {
  value: flags(
    "--python -p --with --with-editable --with-requirements --index --default-index --index-url -i " +
      "--extra-index-url --find-links -f --cache-dir --color --config-file --directory --project " +
      "--constraints -c --overrides --build-constraints -b --exclude-newer --index-strategy " +
      "--keyring-provider --resolution --prerelease --refresh-package --upgrade-package -P " +
      "--reinstall-package --python-preference --python-platform --env-file --allow-insecure-host",
  ),
  bool: flags(
    "-q --quiet -v --verbose -n --no-cache --offline --isolated --refresh -U --upgrade --reinstall " +
      "--no-config --no-progress --native-tls --managed-python --no-managed-python --no-python-downloads " +
      "--no-env-file --preview --no-preview --compile-bytecode --no-sources",
  ),
  target: flags("--from"),
};
const PIPX_RUNNER: FlagTable = {
  value: flags("--python --pip-args --index-url -i --backend"),
  bool: flags("-q --quiet -v --verbose --no-cache --path --pypackages --system-site-packages"),
  target: flags("--spec"),
};
const CONTAINER_RUNNER: FlagTable = {
  value: flags(
    "-a --attach --add-host --annotation --blkio-weight --blkio-weight-device --cap-add --cap-drop " +
      "--cgroup-parent --cgroupns --cidfile --cpu-count --cpu-percent --cpu-period --cpu-quota " +
      "--cpu-rt-period --cpu-rt-runtime -c --cpu-shares --cpus --cpuset-cpus --cpuset-mems " +
      "--detach-keys --device --device-cgroup-rule --device-read-bps --device-read-iops " +
      "--device-write-bps --device-write-iops --dns --dns-option --dns-search --domainname " +
      "--entrypoint -e --env --env-file --expose --gpus --group-add --health-cmd --health-interval " +
      "--health-retries --health-start-interval --health-start-period --health-timeout -h --hostname " +
      "--io-maxbandwidth --io-maxiops --ip --ip6 --ipc --isolation --kernel-memory -l --label " +
      "--label-file --link --link-local-ip --log-driver --log-opt --mac-address -m --memory " +
      "--memory-reservation --memory-swap --memory-swappiness --mount --name --net --network " +
      "--net-alias --network-alias --oom-score-adj --pid --pids-limit --platform -p --publish --pull " +
      "--restart --runtime --security-opt --shm-size --stop-signal --stop-timeout --storage-opt " +
      "--sysctl --tmpfs --ulimit -u --user --userns --uts -v --volume --volume-driver --volumes-from " +
      "-w --workdir",
  ),
  bool: flags(
    "-d --detach --disable-content-trust --init -i --interactive --no-healthcheck --oom-kill-disable " +
      "--privileged -P --publish-all -q --quiet --read-only --rm --sig-proxy -t --tty --use-api-socket",
  ),
};
const NODE_INTERPRETER: FlagTable = {
  value: flags(
    "-r --require --import --loader --experimental-loader -C --conditions --env-file --input-type --title " +
      "--preload --tsconfig --tsconfig-override",
  ),
  bool: flags(""),
  stop: flags("-e --eval -p --print"),
  unknownIsBool: true,
};
const DENO_INTERPRETER: FlagTable = {
  ...NODE_INTERPRETER,
  value: new Set([...NODE_INTERPRETER.value, "-c", "--config", "--import-map", "--lock"]),
};
const PYTHON_INTERPRETER: FlagTable = {
  value: flags("-W -X"),
  bool: flags(""),
  target: flags("-m"),
  stop: flags("-c"),
  unknownIsBool: true,
};
const OTHER_INTERPRETER: FlagTable = {
  value: flags("-I -r -d -c"),
  bool: flags(""),
  stop: flags("-e"),
  unknownIsBool: true,
};

function interpreterFlags(launcher: string): FlagTable | null {
  if (/^(?:python[\d.]*|pypy[\d.]*|py)$/.test(launcher)) return PYTHON_INTERPRETER;
  if (launcher === "deno") return DENO_INTERPRETER;
  if (launcher === "node" || launcher === "bun" || launcher === "tsx" || launcher === "ts-node") {
    return NODE_INTERPRETER;
  }
  return launcher === "ruby" || launcher === "php" ? OTHER_INTERPRETER : null;
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\.git$/i, "");
  try {
    const u = new URL(trimmed);
    // Credentials, query and fragment are dropped so that `?x=1` cannot turn
    // one endpoint into a "different" server.
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function normalizeCommand(raw: string): string {
  const unified = raw.trim().replace(/\\/g, "/");
  if (!unified.includes("/")) return launcherBasename(unified);
  return posix.normalize(unified.replace(WIN_EXE_EXT, "").toLowerCase());
}

/** One spelling for every way of naming the same package or image: without the
 *  npm `@version`, the Python `==version` / `[extra]`, or the image `:tag` /
 *  `@digest`, and with Python's `-`, `_` and `.` treated as the same. */
function normalizePackage(raw: string): string {
  const spec = raw.trim().replace(/\\/g, "/").toLowerCase().replace(/^npm:/, "");
  if (/^(?:\.{0,2}\/|~\/|[a-z]:\/)/.test(spec)) return posix.normalize(spec);
  if (/^(?:file|link|workspace|git(?:\+[a-z]+)?|github|gitlab|bitbucket|https?|ssh):/.test(spec)) {
    return spec.replace(/#.*$/, "").replace(/\.git$/, "");
  }
  const at = spec.indexOf("@", 1);
  const name = (at === -1 ? spec : spec.slice(0, at))
    .replace(/\[[^\]]*\]/, "")
    .replace(/[=<>!~;\s].*$/, "")
    .replace(/(^|\/)([^/:]+):[^/]*$/, "$1$2")
    .replace(/^(?:index\.)?docker\.io\//, "")
    .replace(/^library\//, "");
  return name.includes("/") ? name : name.replace(/[-_.]+/g, "-");
}

const packageId = (spec: string): string => `package:${normalizePackage(spec)}`;

/** The canonical spelling of a `package:` / `command:` / `url:` entry, or null
 *  when `entry` is not one. */
export function normalizeIdentityEntry(entry: string): string | null {
  const m = IDENTITY_ENTRY_RE.exec(entry.trim());
  if (!m) return null;
  const [, kind, value] = m;
  if (kind === "package") return packageId(value);
  if (kind === "command") return `command:${normalizeCommand(value)}`;
  return `url:${normalizeUrl(value)}`;
}

/** The identity two launches have in common, or null when they are different
 *  servers. A `weak` identity counts only against a `strong` one: two launches
 *  sharing just a flag value or a basename (`/a/index.js`, `/b/index.js`) are
 *  not thereby the same server. */
export function sharedIdentity(a: ServerIdentity, b: ServerIdentity): string | null {
  return (
    a.strong.find((id) => b.strong.includes(id) || b.weak.includes(id)) ??
    a.weak.find((id) => b.strong.includes(id)) ??
    null
  );
}

/** An identity as a refusal may print it: the arguments of an exact-launch
 *  identity are left out, since they can hold a credential. */
export function displayIdentity(identity: string): string {
  const at = identity.indexOf(ARGS_SEPARATOR);
  return at === -1 ? identity : `${identity.slice(0, at)} with the same arguments`;
}

/** The arguments following a package runner's own verb and the flags they use,
 *  or null when this launch is not a package runner. */
function runnerArgs(launcher: string, args: readonly string[]): { rest: readonly string[]; table: FlagTable } | null {
  const after = (n: number, table: FlagTable) => ({ rest: args.slice(n), table });
  switch (launcher) {
    case "npx":
    case "bunx":
    case "pnpx":
      return after(0, NODE_RUNNER);
    case "uvx":
      return after(0, UV_RUNNER);
    case "pipx":
      return args[0] === "run" ? after(1, PIPX_RUNNER) : null;
    case "uv":
      return args[0] === "tool" && args[1] === "run" ? after(2, UV_RUNNER) : null;
    case "pnpm":
    case "yarn":
      return args[0] === "dlx" ? after(1, NODE_RUNNER) : null;
    case "npm":
      return args[0] === "exec" || args[0] === "x" ? after(1, NODE_RUNNER) : null;
    case "bun":
      return args[0] === "x" ? after(1, NODE_RUNNER) : null;
    case "docker":
    case "podman":
      if (args[0] === "run") return after(1, CONTAINER_RUNNER);
      return args[0] === "container" && args[1] === "run" ? after(2, CONTAINER_RUNNER) : null;
    default:
      return null;
  }
}

interface ParsedTarget {
  target: string | null;
  /** True when `target` came from a flag in `table.target`. */
  viaFlag: boolean;
  ambiguous: string[];
}

/** Walk a launcher's own flags to the thing it launches. */
function parseTarget(args: readonly string[], table: FlagTable): ParsedTarget {
  const ambiguous: string[] = [];
  const done = (target: string | null, viaFlag = false): ParsedTarget => ({ target, viaFlag, ambiguous });
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return done(args[i + 1] ?? null);
    if (!a.startsWith("-") || a === "-") return done(a);
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (table.stop?.has(name)) return done(null);
    if (table.target?.has(name)) {
      const value = eq === -1 ? args[i + 1] : a.slice(eq + 1);
      if (value) return done(value, true);
    }
    if (eq !== -1 || table.bool.has(a)) continue;
    if (table.value.has(a)) {
      i++;
      continue;
    }
    if (/^-[A-Za-z]{2,}$/.test(a) && [...a.slice(1)].every((c) => table.bool.has(`-${c}`))) continue;
    if (table.unknownIsBool) continue;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      ambiguous.push(next);
      i++;
    }
  }
  return done(null);
}

/** The ids of a command or script: its own spelling, plus (when given by path)
 *  its bare name, which is only weak evidence of being the same program. */
function commandIds(raw: string, suffix = ""): { strong: string; weak: string[] } {
  const full = normalizeCommand(raw);
  const base = launcherBasename(full);
  return { strong: `command:${full}${suffix}`, weak: base === full ? [] : [`command:${base}${suffix}`] };
}

function identity(strong: string[], weak: string[], launchers: string[] = []): ServerIdentity {
  return { primary: strong[0] ?? null, strong, weak, all: [...strong, ...weak, ...launchers] };
}

function localIdentity(command: string, args: readonly string[]): ServerIdentity {
  const launcher = launcherBasename(command);
  // `cmd /c npx pkg` is how npx is launched on Windows: look through it.
  if (launcher === "cmd") {
    const at = args.findIndex((a) => !/^\/[a-z]$/i.test(a));
    if (at > 0) {
      const inner = at === args.length - 1 ? args[at].trim().split(/\s+/) : args.slice(at);
      if (inner[0]) return localIdentity(inner[0], inner.slice(1));
    }
  }
  const self = commandIds(command);
  const launchers = [self.strong, ...self.weak];

  const runner = runnerArgs(launcher, args);
  if (runner) {
    const { target, ambiguous } = parseTarget(runner.rest, runner.table);
    return identity(target ? [packageId(target)] : [], ambiguous.map(packageId), launchers);
  }
  const table = interpreterFlags(launcher);
  if (table) {
    const scriptArgs = (launcher === "deno" || launcher === "bun") && args[0] === "run" ? args.slice(1) : args;
    // `python -um pkg` is `-u -m pkg`.
    const expanded =
      table === PYTHON_INTERPRETER
        ? scriptArgs.flatMap((a) => (/^-[bBdEiIOPqRsSuvx]+m$/.test(a) ? [a.slice(0, -1), "-m"] : [a]))
        : scriptArgs;
    const { target, viaFlag } = parseTarget(expanded, table);
    if (!target) return identity([], [], launchers);
    if (viaFlag) return identity([packageId(target)], [], launchers);
    const script = commandIds(target);
    return identity([script.strong], script.weak, launchers);
  }
  if (SHELLS.has(launcher) || GENERIC_LAUNCHERS.has(launcher)) return identity([], [], launchers);
  // Any other command may host many different servers (java, dotnet, ssh, a
  // wrapper), so only the same command with the same arguments is the same
  // server. `command:<name>` in `all` still matches every launch of it.
  const suffix = args.length > 0 ? `${ARGS_SEPARATOR}${JSON.stringify(args)}` : "";
  const exact = commandIds(command, suffix);
  return { ...identity([exact.strong], exact.weak), all: launchers };
}

export function serverIdentity(server: UpstreamServerConfig): ServerIdentity {
  if (server.git?.url) return identity([`url:${normalizeUrl(server.git.url)}`], []);
  if (isRemoteEntry(server)) return server.url ? identity([`url:${normalizeUrl(server.url)}`], []) : identity([], []);
  if (!server.command) return identity([], []);
  return localIdentity(server.command, server.args ?? []);
}
