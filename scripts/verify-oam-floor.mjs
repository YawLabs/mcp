#!/usr/bin/env node
/**
 * `npm run verify:oam-floor` -- prove the oam floor on THIS machine's oam, and
 * (with --raise) move the floor to it.
 *
 * MIN_OAM_VERSION in src/oam-spawn.ts is the oldest oam yaw-mcp hosts sidecars
 * on; a machine below it gets node/npx with a warning. Until 1.0.11 the floor
 * tracked the LATEST oam release: release.sh read GitHub's /releases/latest and
 * moved the constant to it in a commit of its own, without running anything.
 * That put the floor at 0.16.1, 0.16.2 and 0.16.3 in five days, and each move
 * cost every machine that had not run `oam self-update` its oam hosting --
 * sidecars fell back to node, and install/heal wrote npx entries instead of oam
 * ones -- for releases that changed nothing the hosting mechanism depends on.
 *
 * So the floor is now the last VERIFIED release, and this script is the only
 * thing that raises it. Verified means: the installed oam hosts a real stdio
 * @modelcontextprotocol/sdk server (scripts/oam-floor-probe-server.mjs) through
 * `oam run`, and that server completes initialize, tools/list and tools/call --
 * the mechanism check the "MEASURED" note in src/oam-spawn.ts describes, which
 * release.sh used to skip. Nothing here reads GitHub, and nothing here installs
 * anything: a machine without oam fails, by name, and says where to get it.
 *
 * Modes:
 *   (none)    Verify. Passes when the installed oam hosts the probe AND is at
 *             or above the floor. An oam below the floor cannot vouch for it, so
 *             that fails with `oam self-update` as the fix. An oam above it
 *             passes and says the floor could be raised. release.sh runs this
 *             in step 1 beside lint, typecheck and tests.
 *   --raise   Verify, then move MIN_OAM_VERSION, the `const FLOOR` ratchet in
 *             src/tests/oam-spawn.test.ts and a CHANGELOG block to the installed
 *             version. Every target is validated before any is written. A
 *             prerelease is never a floor. Nothing is committed: the operator
 *             reviews the diff and commits it like any other change.
 *
 * Output: one `[verify:oam-floor] OK -- ...` line on success and one
 * `[verify:oam-floor] FAIL -- ...` line on failure, both on stdout, so
 * release.sh's run_npm_check can match them the way it matches vitest's
 * summary. Exit 0 / 1.
 *
 * Environment: OAM_BIN names the binary, as it does for the broker; otherwise
 * `oam` (`oam.exe` on Windows) is looked up on PATH. VERIFY_OAM_FLOOR_TIMEOUT_MS
 * bounds the whole probe (default 30000, a cold oam start included).
 *
 * The version helpers here duplicate parseOamVersion / compareVersions in
 * src/oam-spawn.ts on purpose: this runs from a checkout with no build step,
 * and node cannot import the .ts. verify-oam-floor.test.ts pins the two
 * comparators to each other so they cannot drift.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The three places a floor move touches, plus the server the probe hosts.
 *  Relative to the repo root, forward slashes, the way the release script and
 *  the changelog name them. */
export const FLOOR_SRC = "src/oam-spawn.ts";
export const FLOOR_TEST = "src/tests/oam-spawn.test.ts";
export const FLOOR_CHANGELOG = "CHANGELOG.md";
export const PROBE_SERVER = "scripts/oam-floor-probe-server.mjs";

export const TAG = "[verify:oam-floor]";
const DEFAULT_TIMEOUT_MS = 30_000;
const USAGE = `Usage: node scripts/verify-oam-floor.mjs [--raise]

Host a stdio @modelcontextprotocol/sdk server on this machine's oam through
\`oam run\` and complete initialize + tools/list + tools/call. Passes when the
installed oam is at or above MIN_OAM_VERSION (${FLOOR_SRC}).

  --raise   Also move MIN_OAM_VERSION, the ratchet literal in ${FLOOR_TEST} and
            a CHANGELOG.md block to the installed version. Writes nothing when
            the floor is already there. Never commits.
  --help    This text.

Env: OAM_BIN (the binary; otherwise oam on PATH), VERIFY_OAM_FLOOR_TIMEOUT_MS
(whole probe, default ${DEFAULT_TIMEOUT_MS}).
`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** @returns {{ ok: true, raise: boolean, help: boolean } | { ok: false, error: string }} */
export function parseArgs(argv) {
  let raise = false;
  for (const a of argv) {
    if (a === "--raise") raise = true;
    else if (a === "--help" || a === "-h") return { ok: true, raise: false, help: true };
    else return { ok: false, error: `${TAG} unknown option ${a}\n\n${USAGE}` };
  }
  return { ok: true, raise, help: false };
}

/** The first x.y.z[-pre][+build] in free text, or null. Mirrors
 *  parseOamVersion: `oam --version` prints "oam 0.16.3". */
export function parseVersion(text) {
  const m = /\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/.exec(text);
  return m ? m[0] : null;
}

function parseSemver(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?/.exec(s);
  if (!m) return null;
  const pre = m[4] === undefined ? [] : m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return { release: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

function comparePre(a, b) {
  if (a.length === 0 || b.length === 0) {
    if (a.length === b.length) return 0;
    return a.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** Semver compare, the same rules as compareVersions in src/oam-spawn.ts:
 *  negative when a < b, positive when a > b, 0 when equal or unparseable. */
export function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.release[i] !== pb.release[i]) return pa.release[i] < pb.release[i] ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

/** True for "1.2.3-rc.1"; the floor names releases only. */
export function isPrerelease(v) {
  const p = parseSemver(v);
  return p !== null && p.pre.length > 0;
}

const FLOOR_LINE = /^export const MIN_OAM_VERSION = "(\d+\.\d+\.\d+)";\r?$/gm;
const RATCHET_LINE = /^[ \t]*const FLOOR = "(\d+\.\d+\.\d+)";\r?$/gm;

/** The one MIN_OAM_VERSION line's version. Throws, naming the count, when the
 *  source does not hold exactly one -- a reshaped constant must stop the run,
 *  not verify a floor read from somewhere else. */
export function readFloor(srcText, srcName = FLOOR_SRC) {
  const hits = [...srcText.matchAll(FLOOR_LINE)];
  if (hits.length !== 1) {
    throw new Error(`${srcName}: expected exactly one MIN_OAM_VERSION line, found ${hits.length}`);
  }
  return hits[0][1];
}

/** Where the binary comes from, matching probeOamUncached in src/oam-spawn.ts:
 *  OAM_BIN wins, else the bare name PATH resolves. `explicit` changes what an
 *  ENOENT means -- see resolveOamBin's caller. */
export function resolveOamBin(env, platform = process.platform) {
  const explicit = Boolean(env.OAM_BIN);
  return { bin: env.OAM_BIN || (platform === "win32" ? "oam.exe" : "oam"), explicit };
}

/** The installer one-liner for this platform, as oamInstallCommand prints it. */
export function installCommand(platform = process.platform) {
  return platform === "win32"
    ? "irm https://oamjs.org/install.ps1 | iex"
    : "curl -fsSL https://oamjs.org/install.sh | sh";
}

// ---------------------------------------------------------------------------
// The two spawns
// ---------------------------------------------------------------------------

/**
 * `oam --version`, resolved to the version it printed. Rejects with the
 * spawn error (ENOENT for an absent binary) or an Error naming the exit code
 * or the unparseable output.
 * @param {string} bin
 * @param {{ spawn?: typeof spawn, timeoutMs?: number }} [deps]
 */
export function oamVersion(bin, deps = {}) {
  const doSpawn = deps.spawn ?? spawn;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let out = "";
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    let child;
    try {
      child = doSpawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      settle(() => reject(new Error(`\`${bin} --version\` did not answer within ${timeoutMs} ms`)));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d) => {
      out += d;
    });
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => {
      settle(() => {
        if (code !== 0) {
          reject(new Error(`\`${bin} --version\` exited ${code}`));
          return;
        }
        const v = parseVersion(out);
        if (v === null) {
          reject(new Error(`\`${bin} --version\` printed no version: ${JSON.stringify(out.trim().slice(0, 200))}`));
          return;
        }
        resolve(v);
      });
    });
  });
}

/**
 * The mechanism check: connect an SDK client to `command args...` over stdio
 * and run the three calls a sidecar has to survive. Resolves with what the
 * server answered; rejects with the SDK's error plus the child's stderr tail,
 * which under oam is where a boot failure explains itself.
 *
 * Deliberately unaware of oam: the caller passes `oam run <probe>` and the
 * tests pass `node <probe>`, which is how the probe itself gets verified on a
 * machine with no oam.
 *
 * @param {{ command: string, args: string[], cwd?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ tools: string[], reply: string, ms: number }>}
 */
export async function probeHosting(opts) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (d) => {
    // Bounded: a chatty server must not grow the tail without limit.
    stderr = (stderr + d).slice(-2000);
  });
  const client = new Client({ name: "verify-oam-floor", version: "0" });
  const nonce = `${process.pid}-${started}`;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the probe did not finish within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const run = (async () => {
      await client.connect(transport);
      const listed = await client.listTools();
      const tools = listed.tools.map((t) => t.name);
      if (!tools.includes("ping")) {
        throw new Error(`tools/list answered ${JSON.stringify(tools)}, not the probe's ["ping"]`);
      }
      const called = await client.callTool({ name: "ping", arguments: { nonce } });
      const text = Array.isArray(called.content)
        ? called.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("")
        : "";
      if (text !== `pong:${nonce}`) {
        throw new Error(`tools/call answered ${JSON.stringify(text)}, not "pong:${nonce}"`);
      }
      return { tools, reply: text, ms: Date.now() - started };
    })();
    return await Promise.race([run, deadline]);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const tail = stderr.trim();
    throw new Error(tail ? `${why}\n  server stderr (tail): ${tail.replace(/\r?\n/g, "\n    ")}` : why);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The raise
// ---------------------------------------------------------------------------

export const BLOCK_HEAD = "**Changed -- the oam floor moves to ";

/** The CHANGELOG block a raise writes. One template, so what the operator
 *  sees in the diff and what ships in the section are the same text. */
export function renderFloorBlock({ next, prev, day }) {
  return [
    `${BLOCK_HEAD}${next}**`,
    "",
    `\`npm run verify:oam-floor\` hosted a stdio \`@modelcontextprotocol/sdk\` server on oam v${next} through \`oam run\` on ${day} -- initialize, tools/list and tools/call all completed -- and raised \`MIN_OAM_VERSION\` to it; the floor was ${prev}. A machine whose oam is older hosts its node/npx sidecars on node instead, and logs a warning naming both versions, \`oam self-update\` as the fix, and that yaw-mcp needs a restart afterwards.`,
  ];
}

/** Exactly one line matching `re`, with the version in group 1 swapped for
 *  `next`. Nothing else on the line changes. */
function moveOne(name, text, re, what, next) {
  const hits = [...text.matchAll(re)];
  if (hits.length !== 1) throw new Error(`${name}: expected exactly one ${what} line, found ${hits.length}`);
  return text.replace(re, (line, v) => line.replace(`"${v}"`, `"${next}"`));
}

/**
 * The block goes at the END of the first ## section, which must be headed
 * ## Unreleased: any other first section is a changelog whose next release
 * has already been named, and a raise filed under a shipped release would
 * document it in the wrong place. A ## line inside a ``` or ~~~ fence is not a
 * heading, so fenced lines are skipped; a fence that never closes stops the
 * run, since every heading after it would read as fenced. A block already in
 * the section that names the same target is refused rather than doubled.
 */
function addFloorBlock(name, text, block, next) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const heads = [];
  let fence = null;
  lines.forEach((l, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence !== null) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && l.trim() === m[1]) fence = null;
      return;
    }
    if (m) {
      fence = m[1];
      return;
    }
    if (l.startsWith("## ")) heads.push(i);
  });
  if (fence !== null) {
    throw new Error(
      `${name}: a code fence opened with ${fence} never closes, so no heading can be trusted as a section boundary`,
    );
  }
  const first = heads.length > 0 ? heads[0] : -1;
  const heading = first === -1 ? "" : lines[first];
  if (!/^## [Uu]nreleased\b/.test(heading)) {
    throw new Error(
      `${name}: its first ## section is ${JSON.stringify(heading || "(none)")}, not ## Unreleased, so there is no section to record the floor move in`,
    );
  }
  let end = heads.find((i) => i > first);
  if (end === undefined) end = lines.length;
  if (lines.slice(first, end).some((l) => l.startsWith(`${BLOCK_HEAD}${next}**`))) {
    throw new Error(`${name}: the Unreleased section already holds a block for a floor of ${next}; edit it by hand`);
  }
  let at = end;
  while (at > first + 1 && lines[at - 1].trim() === "") at--;
  lines.splice(at, end - at, "", ...block, "");
  return lines.join(eol);
}

/**
 * The three rewritten texts, or a throw naming the first target that does not
 * validate. Pure: the caller decides whether to write, and writes all three or
 * none. `prev` is read out of the source rather than trusted from the caller,
 * so the changelog names the floor that was really there.
 * @param {{ src: string, test: string, changelog: string, next: string, day: string }} f
 */
export function raiseFloorText(f) {
  const prev = readFloor(f.src);
  const cmp = compareVersions(f.next, prev);
  if (cmp === 0) throw new Error(`the floor is already ${prev}`);
  if (cmp < 0)
    throw new Error(
      `refusing to LOWER the floor from ${prev} to ${f.next}: the ratchet test pins it from below, and a lower floor is a hand edit with a reason in the changelog, not a verification`,
    );
  if (isPrerelease(f.next))
    throw new Error(
      `refusing to raise the floor to ${f.next}: a prerelease is never a floor, and oamjs.org only ever installs releases`,
    );
  const src = moveOne(FLOOR_SRC, f.src, FLOOR_LINE, "MIN_OAM_VERSION", f.next);
  const test = moveOne(FLOOR_TEST, f.test, RATCHET_LINE, "const FLOOR", f.next);
  const block = renderFloorBlock({ next: f.next, prev, day: f.day });
  const changelog = addFloorBlock(FLOOR_CHANGELOG, f.changelog, block, f.next);
  return { src, test, changelog, prev };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Today as YYYY-MM-DD, local time -- the day the operator ran it. */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The whole run, with every side effect behind `deps` so the tests can drive
 * it without oam, a repo, or a clock. Returns the exit code; every outcome is
 * one OK or FAIL line on `out`, with detail lines above it.
 *
 * @param {{ raise?: boolean }} opts
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   cwd?: string,
 *   out?: (line: string) => void,
 *   oamVersion?: (bin: string) => Promise<string>,
 *   probeHosting?: (o: { command: string, args: string[], cwd: string, timeoutMs: number }) => Promise<{ tools: string[], reply: string, ms: number }>,
 *   readFile?: (p: string) => string,
 *   writeFile?: (p: string, text: string) => void,
 *   day?: string,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function verifyOamFloor(opts = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const cwd = deps.cwd ?? REPO_ROOT;
  const out = deps.out ?? ((l) => process.stdout.write(`${l}\n`));
  const readFile = deps.readFile ?? ((p) => readFileSync(join(cwd, p), "utf8"));
  const writeFile = deps.writeFile ?? ((p, t) => writeFileSync(join(cwd, p), t));
  const versionOf = deps.oamVersion ?? ((bin) => oamVersion(bin));
  const probe = deps.probeHosting ?? probeHosting;
  const fail = (why) => {
    out(`${TAG} FAIL -- ${why}`);
    return 1;
  };
  const timeoutRaw = env.VERIFY_OAM_FLOOR_TIMEOUT_MS;
  const timeoutMs =
    timeoutRaw !== undefined && /^\d+$/.test(timeoutRaw) && Number(timeoutRaw) > 0
      ? Number(timeoutRaw)
      : DEFAULT_TIMEOUT_MS;

  // The floor first: a source that cannot be read is a repo problem, and it
  // should stop the run before a process is spawned for nothing.
  let floor;
  try {
    floor = readFloor(readFile(FLOOR_SRC));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const { bin, explicit } = resolveOamBin(env, platform);
  let installed;
  try {
    installed = await versionOf(bin);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code === "ENOENT") {
      // The same split as the broker's probe: a bare `oam` missing from PATH
      // is "not installed", and the fix is the installer; an OAM_BIN that
      // does not exist is a wrong variable, and the installer cannot fix it.
      // Either way this script installs nothing -- the floor is a claim about
      // the operator's machine, and a binary fetched to make the claim pass
      // would not be that.
      if (explicit) {
        return fail(
          `OAM_BIN=${bin} does not exist, so the oam floor ${floor} cannot be verified on this machine. Fix or unset OAM_BIN. This script installs nothing.`,
        );
      }
      return fail(
        `oam is not installed on this machine (nothing named ${bin} on PATH, and OAM_BIN is unset), so the oam floor ${floor} cannot be verified. Install it -- ${installCommand(platform)} -- then re-run. This script installs nothing itself.`,
      );
    }
    return fail(`could not read the installed oam's version: ${err instanceof Error ? err.message : String(err)}`);
  }
  out(`${TAG} oam ${installed} at ${bin}; the floor is ${floor}`);

  // The mechanism check runs BEFORE the version comparison: an oam below the
  // floor that also cannot host the probe is two findings, and the second is
  // the one that matters more.
  let hosted;
  try {
    hosted = await probe({ command: bin, args: ["run", PROBE_SERVER], cwd, timeoutMs });
  } catch (err) {
    return fail(
      `oam ${installed} could not host a stdio @modelcontextprotocol/sdk server through \`oam run ${PROBE_SERVER}\`: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  out(
    `${TAG} oam ${installed} hosted ${PROBE_SERVER}: initialize + tools/list ${JSON.stringify(hosted.tools)} + tools/call -> ${JSON.stringify(hosted.reply)} in ${hosted.ms} ms`,
  );

  const cmp = compareVersions(installed, floor);
  if (cmp < 0) {
    return fail(
      `oam ${installed} on this machine is BELOW the floor ${floor}, so it cannot vouch for it: run \`oam self-update\` (then restart any yaw-mcp that is serving) and re-run. The floor stays where it is.`,
    );
  }

  if (!opts.raise) {
    if (cmp > 0) {
      out(
        `${TAG} note: oam ${installed} is above the floor ${floor}; \`npm run verify:oam-floor -- --raise\` would move the floor to it`,
      );
    }
    out(
      `${TAG} OK -- oam ${installed} hosts a stdio @modelcontextprotocol/sdk server (initialize + tools/list + tools/call); the floor ${floor} stands`,
    );
    return 0;
  }

  if (cmp === 0) {
    out(
      `${TAG} OK -- oam ${installed} hosts a stdio @modelcontextprotocol/sdk server (initialize + tools/list + tools/call); the floor is already ${floor}, nothing to raise`,
    );
    return 0;
  }
  let texts;
  try {
    texts = raiseFloorText({
      src: readFile(FLOOR_SRC),
      test: readFile(FLOOR_TEST),
      changelog: readFile(FLOOR_CHANGELOG),
      next: installed,
      day: deps.day ?? today(),
    });
  } catch (err) {
    return fail(
      `oam ${installed} is verified, but the floor cannot be raised to it: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // All three validated above; now all three are written. A write that fails
  // midway is reported as such -- the operator has a git diff to read.
  writeFile(FLOOR_SRC, texts.src);
  writeFile(FLOOR_TEST, texts.test);
  writeFile(FLOOR_CHANGELOG, texts.changelog);
  out(
    `${TAG} raised the oam floor ${texts.prev} -> ${installed} in ${FLOOR_SRC}, ${FLOOR_TEST} and ${FLOOR_CHANGELOG}; review the diff and commit it`,
  );
  out(
    `${TAG} OK -- oam ${installed} hosts a stdio @modelcontextprotocol/sdk server (initialize + tools/list + tools/call); the floor is now ${installed}`,
  );
  return 0;
}

// Run only when invoked as a script, so the tests can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stdout.write(parsed.error);
    process.exit(2);
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  process.exit(await verifyOamFloor({ raise: parsed.raise }));
}
