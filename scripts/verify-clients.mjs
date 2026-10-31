#!/usr/bin/env node
/**
 * `npm run verify:clients` -- install THIS build into every client yaw-mcp
 * supports, inside a throwaway home, and prove each written entry starts the
 * broker and completes an MCP session.
 *
 * The unit suite locks each row's path and container key (install-targets,
 * client-config-matrix); nothing there runs what install WRITES. This does,
 * end to end, against the built dist/:
 *
 *   1. Sandbox. A fresh temp dir becomes HOME / USERPROFILE / APPDATA /
 *      LOCALAPPDATA / XDG_* / CODEX_HOME, with its own ~/.npmrc and npm cache,
 *      so no real client config, npm cache or token is read or written.
 *   2. Local registry. `npm pack` of this checkout is served as
 *      @yawlabs/mcp@latest by a 127.0.0.1 registry that ~/.npmrc routes the
 *      @yawlabs scope to (everything else it proxies to registry.npmjs.org).
 *      The entries install writes therefore stay byte-for-byte what a user
 *      gets -- `npx -y @yawlabs/mcp@latest`, `cmd /c` wrap included -- and
 *      still launch this build. The served version is a per-run prerelease
 *      that does not exist on npmjs.org, so a launch that resolved anything
 *      else cannot reach the tarball counter this checks.
 *   3. Install. Every client id the built CLI's usage line names, at every
 *      scope it accepts (an unsupported scope is how install says "n/a"), each
 *      id in its own project dir. OAM_BIN points at nothing so install writes
 *      the npx entry rather than an oam one aimed at a GLOBAL install, which
 *      would test the wrong build.
 *   4. Entry. Each file install reports writing is re-parsed in its own format
 *      (JSON, JSONC or TOML) and the `mcp` entry located under the row's
 *      container key.
 *   5. Launch. Each distinct entry is spawned the way the client spawns it --
 *      raw CreateProcess/execvp for `cmd /c npx` and posix entries, PATHEXT
 *      shim resolution only for a bare `npx` on Windows (the rows whose client
 *      resolves the .cmd itself) -- and must answer initialize, tools/list
 *      (with the mcp_connect_* meta-tools) and one tools/call.
 *   6. Real clients. Where the client's own CLI is on PATH it reads the
 *      sandbox, one scope at a time so a same-named entry in another scope
 *      cannot answer for it: `claude mcp get mcp` must report the scope under
 *      test and connect (its health check), `gemini mcp list` must list the
 *      entry, and `codex mcp get --json` must parse it. A missing CLI is a
 *      SKIP line, not a failure. GUI clients (Claude Desktop, Cursor, VS Code,
 *      Windsurf, Zed, Cline, Continue) have no headless mode, so step 5 is
 *      their launch check.
 *   7. Uninstall. Every (client, scope) is uninstalled and every file
 *      re-parsed: the entry is gone and the file still parses.
 *
 * Output: one line per check, then exactly one `[verify:clients] OK -- ...` or
 * `[verify:clients] FAIL -- ...` line on stdout, so release.sh can match it the
 * way it matches vitest's summary. Exit 0 / 1.
 *
 * Env: VERIFY_CLIENTS_TIMEOUT_MS bounds each launch and each client CLI call
 * (default 120000; the first launch includes npx installing the tarball's
 * dependencies into the empty sandbox cache). VERIFY_CLIENTS_KEEP=1 keeps the
 * sandbox dir after a pass; after any FAIL it is always kept, and its path is
 * on the first line the script prints.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { isMainModule } from "./verify-oam-floor.mjs";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TAG = "[verify:clients]";

const DIST = join(REPO_ROOT, "dist", "index.js");
const IS_WIN = process.platform === "win32";
const TIMEOUT_MS = Number(process.env.VERIFY_CLIENTS_TIMEOUT_MS) || 120_000;
const SCOPES = ["user", "project", "local"];
/** Ids that are a second name for a (client, scope) row. An alias's scope is
 *  only a DEFAULT -- an explicit --scope beside it wins -- so an alias is
 *  installed once, with no --scope, to test the name and the scope it pins. */
export const ALIASES = new Set(["mcp"]);
/** Container keys the rows use, in lookup order. */
const CONTAINERS = ["mcpServers", "servers", "context_servers", "mcp_servers"];
/** Meta-tools a broker with no servers configured must still advertise. */
const REQUIRED_TOOLS = [
  "mcp_connect_discover",
  "mcp_connect_dispatch",
  "mcp_connect_activate",
  "mcp_connect_deactivate",
];
const PROTOCOL = "2025-11-25";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** The client ids from the CLI's usage line, `install <a|b|c> [...]`. */
export function parseClientIds(usage) {
  const m = /install <([a-z0-9|-]+)>/.exec(usage);
  return m ? m[1].split("|") : [];
}

/** Every path install reports writing (`Wrote <path>`, one per file; Cline
 *  writes several). */
export function parseWrotePaths(out) {
  return [...out.matchAll(/^Wrote (.+?)\s*$/gm)]
    .map((m) => m[1])
    .filter((p) => !/ \(added .* to permissions\.allow\)$/.test(p));
}

/** The `mcp` entry in a parsed config, or null. `local` scope is Claude Code's
 *  `projects[<abs dir>].mcpServers`; every other scope is top-level. */
export function findEntry(root, scope, projectDir) {
  if (!root || typeof root !== "object") return null;
  if (scope === "local" && root.projects && typeof root.projects === "object") {
    const want = norm(projectDir);
    for (const [dir, proj] of Object.entries(root.projects)) {
      if (norm(dir) === want) return findEntry(proj, "user", projectDir);
    }
    return null;
  }
  for (const key of CONTAINERS) {
    const entry = root[key]?.mcp;
    if (entry && typeof entry === "object") return entry;
  }
  return null;
}

function norm(p) {
  const r = resolve(p).replace(/[\\/]+$/, "");
  return IS_WIN || process.platform === "darwin" ? r.toLowerCase() : r;
}

/** Parse a config file in the syntax its extension names. Strict JSON for
 *  `.json` would reject the JSONC files some rows own, so JSONC parsing with
 *  errors surfaced is the common denominator; TOML for `.toml`. */
export function parseConfig(path, text) {
  if (extname(path) === ".toml") return parseToml(text);
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`${errors.length} JSONC parse error(s), first at offset ${errors[0].offset}`);
  return value;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function secs(t0) {
  return ` (${((performance.now() - t0) / 1000).toFixed(1)}s)`;
}

/** Run a command to completion. ASYNC on purpose: the local registry is served
 *  from this process, so a spawnSync would block its event loop and every
 *  child that resolves @yawlabs/mcp@latest would hang on it. */
function run(cmd, args, { env, cwd, timeout = TIMEOUT_MS, windowsVerbatimArguments = false } = {}) {
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, {
        env,
        cwd,
        windowsVerbatimArguments,
        detached: !IS_WIN,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      done({ rc: null, out: String(error), error });
      return;
    }
    child.stdout.setEncoding("utf8").on("data", (d) => {
      out += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d) => {
      out += d;
    });
    const timer = setTimeout(() => {
      out += `\n(killed after ${timeout} ms)`;
      killTree(child);
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ rc: null, out: `${out}${error}`, error });
    });
    child.on("close", (rc) => {
      clearTimeout(timer);
      done({ rc, out });
    });
  });
}

/** Absolute path of a bare command via PATH (+PATHEXT on Windows), or null. */
function which(cmd, env = process.env) {
  const exts = IS_WIN ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Run a CLI that may be a .cmd shim on Windows. */
async function runCli(name, args, opts) {
  const bin = which(name, opts.env);
  if (!bin) return null;
  if (IS_WIN && /\.(cmd|bat)$/i.test(bin))
    return run("cmd.exe", ["/d", "/s", "/c", `"${[bin, ...args].map(quoteCmd).join(" ")}"`], {
      ...opts,
      windowsVerbatimArguments: true,
    });
  return run(bin, args, opts);
}

function quoteCmd(a) {
  return /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

/** Kill a child and everything it started. An entry is a launcher chain --
 *  `cmd /c npx`, or npx -> sh -> node on posix -- and killing only the direct
 *  child leaves the broker running. Posix children are spawned `detached`, so
 *  each leads its own process group and the negative pid reaches all of it. */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
}

/** Spawn an entry exactly as a client would and run initialize, tools/list
 *  and one tools/call over newline-delimited JSON-RPC. */
async function mcpSession(entry, { env, cwd }) {
  let command = entry.command;
  let args = entry.args ?? [];
  const opts = {
    env: { ...env, ...(entry.env ?? {}) },
    cwd: entry.cwd ?? cwd,
    detached: !IS_WIN,
    stdio: ["pipe", "pipe", "pipe"],
  };
  if (IS_WIN && command === "npx") {
    // A bare `npx` row: its client resolves the .cmd shim itself (the row's
    // `windowsLaunch.broker: "bare"`), which node's spawn does not, so do it
    // the way those clients do -- PATHEXT lookup, then cmd.exe.
    const shim = which("npx", opts.env);
    if (!shim) throw new Error("bare npx entry: npx is not on PATH");
    args = ["/d", "/c", shim, ...args];
    command = "cmd.exe";
  }
  const child = spawn(command, args, opts);
  // A broker that answers and then dies turns the next write into EPIPE; with
  // no listener that is an uncaught exception that kills the gate before it
  // can print a FAIL line. The `exited` race below reports the death instead.
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (!line.startsWith("{")) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const exited = new Promise((r) => child.on("close", (code) => r(code)));
  const spawnErr = new Promise((_, rej) => child.on("error", rej));
  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    const reply = new Promise((res) => pending.set(id, res));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return Promise.race([
      reply,
      spawnErr,
      exited.then((code) => {
        throw new Error(`exited (${code}) before answering ${method}`);
      }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`no answer to ${method} within ${TIMEOUT_MS} ms`)), TIMEOUT_MS),
      ),
    ]).then((msg) => {
      if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
      return msg.result;
    });
  };
  try {
    const init = await request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "verify-clients", version: "1" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const { tools } = await request("tools/list", {});
    const names = tools.map((t) => t.name);
    const missing = REQUIRED_TOOLS.filter((t) => !names.includes(t));
    if (missing.length) throw new Error(`tools/list lacks ${missing.join(", ")}`);
    const call = await request("tools/call", { name: "mcp_connect_health", arguments: {} });
    if (!Array.isArray(call?.content)) throw new Error("tools/call mcp_connect_health returned no content");
    if (call.isError)
      throw new Error(`tools/call mcp_connect_health returned an error: ${JSON.stringify(call.content).slice(0, 300)}`);
    return `${init.serverInfo?.name} ${init.serverInfo?.version}, ${names.length} tools, tools/call ok`;
  } catch (e) {
    throw new Error(`${e.message}${stderr ? ` | stderr: ${stderr.trim().split("\n").slice(-3).join(" / ")}` : ""}`);
  } finally {
    child.stdin.end();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    killTree(child);
  }
}

// ---------------------------------------------------------------------------
// Local registry
// ---------------------------------------------------------------------------

/** Serve `tarball` as @yawlabs/mcp@`version`; proxy every other path to
 *  registry.npmjs.org. Resolves to { base, hits, close }. */
export function startRegistry(tarball, manifest, version) {
  const bytes = readFileSync(tarball);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const shasum = createHash("sha1").update(bytes).digest("hex");
  const hits = { packument: 0, tarball: 0 };
  const server = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const path = decodeURIComponent(req.url.split("?")[0]);
    if (path === "/@yawlabs/mcp") {
      hits.packument++;
      const v = { ...manifest, version, dist: { tarball: `${base}/-/local.tgz`, integrity, shasum } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "@yawlabs/mcp", "dist-tags": { latest: version }, versions: { [version]: v } }));
      return;
    }
    if (path === "/-/local.tgz") {
      hits.tarball++;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
      res.end(bytes);
      return;
    }
    try {
      const up = await fetch(`https://registry.npmjs.org${req.url}`, {
        headers: { accept: req.headers.accept ?? "application/json" },
      });
      const body = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/octet-stream" });
      res.end(body);
    } catch (e) {
      res.writeHead(502);
      res.end(String(e));
    }
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({ base: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function sandboxEnv(home, source = process.env) {
  const overrides = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    YAW_MCP_AUTO_UPGRADE: "0",
    YAW_MCP_AUTO_HEAL: "0",
    ...(IS_WIN ? { APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") } : {}),
  };
  // Compared upper-cased: Windows environment names are case-insensitive and
  // arrive in whatever case the parent used (under vitest they come through as
  // NPM_CONFIG_USERCONFIG), and a copied `Codex_Home` beside our CODEX_HOME
  // would leave the child with two values and no saying which wins.
  const drop = new Set(["CLAUDE_CONFIG_DIR", "OAM_BIN", ...Object.keys(overrides)]);
  const env = {};
  for (const [k, v] of Object.entries(source)) {
    // npm run exports npm_config_userconfig / npm_config_cache pointing at the
    // REAL ~/.npmrc and cache; a child that inherited them would bypass the
    // sandbox registry. Same for a real CLAUDE_CONFIG_DIR / CODEX_HOME and any
    // YAW_MCP_* tuning the operator has set.
    if (/^(npm_|YAW_MCP_)/i.test(k) || drop.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  return Object.assign(env, overrides);
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Ids whose rows write a file another id's row also writes, so their installs
 *  and uninstalls must not interleave: claude-code's user scope and typed both
 *  patch `~/.claude/settings.json` (claude-code's local scope patches the
 *  project's `.claude/settings.local.json` instead, but shares `~/.claude.json`
 *  with its user scope, which one lane already serializes). Every other id
 *  gets its own lane. */
export const SHARED_FILE_LANE = new Set(["claude-code", "typed"]);
const CONCURRENCY = 6;

export function lanes(ids) {
  const shared = ids.filter((id) => SHARED_FILE_LANE.has(id));
  return [...(shared.length ? [shared] : []), ...ids.filter((id) => !SHARED_FILE_LANE.has(id)).map((id) => [id])];
}

async function main() {
  const started = performance.now();
  const counts = { failed: 0, skipped: 0, warned: 0 };
  /** A check's outcome, printed in a deterministic order once its phase ends. */
  const ok = (m) => ({ kind: "ok", m });
  const bad = (m) => ({ kind: "FAIL", m });
  const skip = (m) => ({ kind: "skip", m });
  const warn = (m) => ({ kind: "warn", m });
  const print = (results) => {
    for (const r of results.flat(2).filter(Boolean)) {
      if (r.kind === "FAIL") counts.failed++;
      else if (r.kind === "skip") counts.skipped++;
      else if (r.kind === "warn") counts.warned++;
      console.log(`  ${r.kind.padEnd(5)} ${r.m}`);
    }
  };

  if (!existsSync(DIST)) {
    console.log(`${TAG} FAIL -- ${DIST} is missing; run \`npm run build\` first`);
    return 1;
  }
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const sandbox = mkdtempSync(join(tmpdir(), "yaw-mcp-clients-"));
  const home = join(sandbox, "home");
  for (const d of ["AppData/Roaming", "AppData/Local", ".config", "proj"])
    mkdirSync(join(home, d), { recursive: true });
  const env = sandboxEnv(home);
  let registry;
  let passed = false;
  console.log(`${TAG} sandbox ${sandbox}`);
  try {
    // --- pack + registry -----------------------------------------------------
    const packDir = join(sandbox, "pack");
    mkdirSync(packDir);
    // runCli, not a shell: it quotes each argument for cmd.exe, and packDir
    // sits under the user profile, which can hold a space.
    const npm = await runCli("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], {
      env: process.env,
      cwd: REPO_ROOT,
    });
    const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
    if (npm?.rc !== 0 || !tgz) {
      console.log(
        `${TAG} FAIL -- npm pack failed (${npm ? `rc ${npm.rc}: ${npm.out.trim().slice(-500)}` : "npm not on PATH"})`,
      );
      return 1;
    }
    const version = `${pkg.version}-clientmatrix.${randomBytes(4).toString("hex")}`;
    registry = await startRegistry(join(packDir, tgz), pkg, version);
    writeFileSync(
      join(home, ".npmrc"),
      [
        `@yawlabs:registry=${registry.base}/`,
        `cache=${join(sandbox, "npm-cache")}`,
        "update-notifier=false",
        "fund=false",
        "audit=false",
        "",
      ].join("\n"),
    );
    console.log(`${TAG} serving ${tgz} as @yawlabs/mcp@${version}`);

    // --- install every (client, scope) --------------------------------------
    const help = await run(process.execPath, [DIST, "install", "--help"], { env, cwd: home });
    const ids = parseClientIds(help.out);
    if (ids.length === 0) {
      console.log(`${TAG} FAIL -- could not read the client ids from \`install --help\``);
      return 1;
    }
    const installEnv = { ...env, OAM_BIN: join(sandbox, "no-oam", IS_WIN ? "oam.exe" : "oam") };
    /** @type {{ id: string, scope: string, projectDir: string, files: string[], entries: object[] }[]} */
    const installs = [];
    const installOne = async (id) => {
      const projectDir = join(home, "proj", id);
      mkdirSync(projectDir, { recursive: true });
      const results = [];
      let refused = 0;
      const scopes = ALIASES.has(id) ? ["alias"] : SCOPES;
      for (const scope of scopes) {
        const t0 = performance.now();
        const args = ["install", id];
        if (scope !== "alias") args.push("--scope", scope);
        if (scope !== "user") args.push("--project-dir", projectDir);
        const r = await run(process.execPath, [DIST, ...args], { env: installEnv, cwd: projectDir });
        if (r.rc !== 0 && /does not support scope|is not supported yet/.test(r.out)) {
          refused++;
          continue;
        }
        if (r.rc !== 0) {
          results.push(bad(`${id} ${scope}: install exited ${r.rc}: ${tail(r.out)}`));
          continue;
        }
        const files = parseWrotePaths(r.out);
        if (files.length === 0) {
          results.push(bad(`${id} ${scope}: install exited 0 but reported no "Wrote" file`));
          continue;
        }
        const entries = [];
        for (const f of files) {
          try {
            const entry = findEntry(parseConfig(f, readFileSync(f, "utf8")), scope, projectDir);
            if (!entry) throw new Error("no `mcp` entry under a known container key");
            const line = [entry.command, ...(entry.args ?? [])].join(" ");
            if (!line.includes("@yawlabs/mcp@latest")) throw new Error(`entry is not the npx shape: ${line}`);
            entries.push(entry);
          } catch (e) {
            results.push(bad(`${id} ${scope}: ${f}: ${e.message}`));
          }
        }
        if (entries.length === files.length)
          results.push(ok(`${id} ${scope}: install wrote ${files.length} file(s), entry parses${secs(t0)}`));
        installs.push({ id, scope, projectDir, files, entries });
      }
      if (refused === scopes.length) results.push(skip(`${id}: install supports no scope on ${process.platform}`));
      return results;
    };
    print(
      await pool(lanes(ids), CONCURRENCY, async (lane) => {
        const out = [];
        for (const id of lane) out.push(await installOne(id));
        return out;
      }),
    );
    // Stable order for everything downstream, whatever order the lanes finished in.
    installs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id) || SCOPES.indexOf(a.scope) - SCOPES.indexOf(b.scope));

    // --- launch each distinct entry the way its client spawns it -------------
    // Sequential: the first launch fills the empty npm cache, and a second one
    // racing it would fetch the same dependencies twice.
    const shapes = new Map();
    for (const i of installs)
      for (const e of i.entries) {
        const key = JSON.stringify([e.command, e.args ?? [], e.env ?? {}, e.cwd ?? null]);
        if (!shapes.has(key)) shapes.set(key, { entry: e, users: [] });
        shapes.get(key).users.push(`${i.id}/${i.scope}`);
      }
    const launched = [];
    for (const { entry, users } of shapes.values()) {
      const line = [entry.command, ...(entry.args ?? [])].join(" ");
      const t0 = performance.now();
      try {
        const summary = await mcpSession(entry, { env, cwd: home });
        launched.push(ok(`launch \`${line}\` -> ${summary} [${users.join(", ")}]${secs(t0)}`));
      } catch (e) {
        launched.push(bad(`launch \`${line}\` [${users.join(", ")}]: ${e.message}`));
      }
    }
    if (registry.hits.tarball === 0)
      launched.push(bad("no launch fetched the local tarball -- the entries did not run this build"));
    else
      launched.push(
        ok(`local build served: ${registry.hits.packument} packument / ${registry.hits.tarball} tarball request(s)`),
      );
    print(launched);

    // --- real client CLIs ----------------------------------------------------
    print(await Promise.all(clientCliChecks(installs, { env, home, sandbox })));

    // --- uninstall -----------------------------------------------------------
    const uninstallOne = async (i) => {
      const args = ["uninstall", i.id, "--force"];
      if (i.scope !== "alias") args.push("--scope", i.scope);
      if (i.scope !== "user") args.push("--project-dir", i.projectDir);
      const r = await run(process.execPath, [DIST, ...args], { env, cwd: i.projectDir });
      if (r.rc !== 0) return bad(`${i.id} ${i.scope}: uninstall exited ${r.rc}: ${tail(r.out)}`);
      const left = [];
      for (const f of i.files) {
        if (!existsSync(f)) continue;
        try {
          if (findEntry(parseConfig(f, readFileSync(f, "utf8")), i.scope, i.projectDir)) left.push(f);
        } catch (e) {
          left.push(`${f} (no longer parses: ${e.message})`);
        }
      }
      if (left.length) return bad(`${i.id} ${i.scope}: uninstall left an entry in ${left.join(", ")}`);
      return ok(`${i.id} ${i.scope}: uninstall removed the entry`);
    };
    print(
      await pool(lanes(ids), CONCURRENCY, async (lane) => {
        const out = [];
        for (const i of installs.filter((x) => lane.includes(x.id))) out.push(await uninstallOne(i));
        return out;
      }),
    );

    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    const summary = `${installs.length} client scopes over ${ids.length} client ids, ${shapes.size} launch shape(s), ${counts.warned} warned, ${counts.skipped} skipped, ${elapsed}s`;
    if (counts.failed) {
      console.log(`${TAG} FAIL -- ${counts.failed} check(s) failed; ${summary}; sandbox kept at ${sandbox}`);
      return 1;
    }
    console.log(`${TAG} OK -- ${summary}`);
    passed = true;
    return 0;
  } finally {
    registry?.close();
    // Only a pass removes it: every FAIL -- a failed check, an early return, a
    // throw -- leaves the sandbox for the operator, at the path printed first.
    if (passed && process.env.VERIFY_CLIENTS_KEEP !== "1") {
      try {
        rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // A just-exited child can still hold a handle on Windows; the sandbox
        // is under the OS temp dir, so a leftover is harmless.
      }
    }
  }

  /** The checks a client's OWN CLI can run against the sandbox, as promises,
   *  plus a skip line for every client that has no such CLI. */
  function clientCliChecks(installs, { env, home, sandbox }) {
    const checks = [];
    const of = (id) => installs.filter((i) => i.id === id);
    const cwdOf = (i) => (i.scope === "user" ? home : i.projectDir);
    let isolated = 0;
    /** A fresh HOME holding only the sandbox ~/.npmrc, so the entry still
     *  resolves this build while no other scope's file is in reach. */
    const isolatedHome = () => {
      const h = join(sandbox, "iso", String(isolated++));
      for (const d of ["AppData/Roaming", "AppData/Local", ".config"]) mkdirSync(join(h, d), { recursive: true });
      writeFileSync(join(h, ".npmrc"), readFileSync(join(home, ".npmrc")));
      return h;
    };

    // Claude Code shows ONE entry per name, and the same-named `mcp` entries
    // install wrote at other scopes outrank or shadow the one under test (user
    // beats project; local beats both), so each scope runs against its own
    // CLAUDE_CONFIG_DIR holding only what install wrote for THAT scope, and
    // `claude mcp get mcp` must report that scope. A project-scope .mcp.json
    // server stays "Pending approval" until a person approves it, so its
    // config carries the approval Claude records when they do.
    const claudeLike = [...of("claude-code"), ...of("mcp")];
    const SCOPE_LABEL = {
      user: "User config",
      local: "Local config",
      project: "Project config",
      alias: "Project config",
    };
    if (claudeLike.length && !which("claude", env))
      checks.push(skip("claude CLI not on PATH -- claude-code checked by launch only"));
    else
      for (const i of claudeLike) {
        checks.push(
          (async () => {
            const who = `${i.id}/${i.scope}`;
            const configDir = isolatedHome();
            let claudeJson;
            if (i.scope === "user" || i.scope === "local") {
              const written = parseConfig(i.files[0], readFileSync(i.files[0], "utf8"));
              if (i.scope === "user") claudeJson = { mcpServers: written.mcpServers };
              else {
                const key = Object.keys(written.projects ?? {}).find((k) => norm(k) === norm(i.projectDir));
                claudeJson = { projects: { [key]: written.projects[key] } };
              }
            } else {
              const key = IS_WIN ? i.projectDir.replace(/\\/g, "/") : i.projectDir;
              claudeJson = { projects: { [key]: { enabledMcpjsonServers: ["mcp"], hasTrustDialogAccepted: true } } };
            }
            writeFileSync(join(configDir, ".claude.json"), JSON.stringify(claudeJson, null, 2));
            const t0 = performance.now();
            const r = await runCli("claude", ["mcp", "get", "mcp"], {
              env: { ...env, CLAUDE_CONFIG_DIR: configDir },
              cwd: cwdOf(i),
            });
            const scope = /Scope: (.+)/.exec(r.out)?.[1]?.trim() ?? "";
            const status = /Status: (.+)/.exec(r.out)?.[1]?.trim() ?? "";
            if (!scope.startsWith(SCOPE_LABEL[i.scope]))
              return bad(
                `claude mcp get [${who}]: expected scope "${SCOPE_LABEL[i.scope]}", got "${scope || tail(r.out)}"`,
              );
            if (/Connected/.test(status))
              return ok(`claude mcp get [${who}]: ${scope.replace(/ \(.*/, "")}, ${status}${secs(t0)}`);
            return bad(`claude mcp get [${who}]: ${scope.replace(/ \(.*/, "")}, ${status || tail(r.out)}`);
          })(),
        );
      }

    if (of("gemini-cli").length && !which("gemini", env))
      checks.push(skip("gemini CLI not on PATH -- gemini-cli checked by launch only"));
    else
      for (const i of of("gemini-cli")) {
        checks.push(
          (async () => {
            // `gemini mcp list` needs an auth method configured to start at
            // all; it never calls the model, so a placeholder key does.
            let gEnv = env.GEMINI_API_KEY ? env : { ...env, GEMINI_API_KEY: "verify-clients-placeholder" };
            // Gemini merges ~/.gemini/settings.json under the project's, so a
            // project check with the user file in reach could be answered by
            // it. Run that one from a HOME without it.
            if (i.scope !== "user") {
              const h = isolatedHome();
              gEnv = { ...gEnv, HOME: h, USERPROFILE: h };
              if (IS_WIN)
                Object.assign(gEnv, {
                  APPDATA: join(h, "AppData", "Roaming"),
                  LOCALAPPDATA: join(h, "AppData", "Local"),
                });
            }
            const t0 = performance.now();
            const r = await runCli("gemini", ["mcp", "list"], { env: gEnv, cwd: cwdOf(i) });
            const line = (r.out.split(/\r?\n/).find((l) => /\bmcp: /.test(l)) ?? "").trim();
            const want = [i.entries[0].command, ...(i.entries[0].args ?? [])].join(" ");
            if (!line.includes(want))
              return bad(
                `gemini mcp list [gemini-cli/${i.scope}]: entry not listed as \`${want}\`: ${line || tail(r.out)}`,
              );
            if (/Connected/.test(line))
              return ok(`gemini mcp list [gemini-cli/${i.scope}]: parsed, Connected${secs(t0)}`);
            // Gemini's `mcp list` gives a server a hard-coded 5 s to connect
            // (commands/mcp/list.js, `client.connect(transport, { timeout:
            // 5000 })`), and an npx launch that re-resolves @latest routinely
            // takes longer on Windows -- the same entry pointed at node
            // directly connects. The launch step is what proves the entry
            // starts, so a parsed-but-slow entry here is a warning, not a FAIL.
            return warn(
              `gemini mcp list [gemini-cli/${i.scope}]: parsed, but Disconnected within gemini's 5 s list-only connect budget${secs(t0)}`,
            );
          })(),
        );
      }

    const codexUser = of("codex-cli").find((i) => i.scope === "user");
    if (codexUser && !which("codex", env))
      checks.push(skip("codex CLI not on PATH -- codex-cli checked by launch only"));
    else if (codexUser)
      checks.push(
        (async () => {
          // `codex mcp` has no health check, so this proves Codex parses the
          // file into the launch the launch step ran. Project scope is read
          // only once Codex trusts the project, so it is checked by launch.
          const r = await runCli("codex", ["mcp", "get", "mcp", "--json"], { env, cwd: home });
          try {
            const got = JSON.parse(r.out.slice(r.out.indexOf("{")));
            const want = codexUser.entries[0];
            const t = got.transport;
            if (t.command !== want.command || JSON.stringify(t.args) !== JSON.stringify(want.args))
              return bad(`codex mcp get [codex-cli/user]: codex reads \`${t.command} ${t.args.join(" ")}\``);
            return ok(`codex mcp get [codex-cli/user]: parsed, enabled=${got.enabled}`);
          } catch (e) {
            return bad(`codex mcp get [codex-cli/user]: ${e.message}: ${tail(r.out)}`);
          }
        })(),
      );

    const withCli = new Set(["claude-code", "mcp", "gemini-cli", "codex-cli"]);
    for (const id of new Set(installs.map((i) => i.id)))
      if (!withCli.has(id)) checks.push(skip(`${id}: no headless client CLI -- checked by launch only`));
    return checks;
  }
}

function tail(out) {
  return out.trim().split(/\r?\n/).slice(-2).join(" / ").slice(-400);
}

// isMainModule realpaths both sides: from a junctioned or symlinked checkout
// node realpaths import.meta.url but leaves argv[1] as typed, and a plain
// comparison would exit 0 having printed nothing.
if (isMainModule(process.argv[1], import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.log(`${TAG} FAIL -- ${e?.stack ?? e}`);
      process.exit(1);
    },
  );
}
