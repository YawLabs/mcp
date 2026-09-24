import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INTERNAL_SECRET_ENV_KEYS,
  isInternalSecretEnvKey,
  scrubInternalSecretsFromProcessEnv,
  stripInternalSecretsFromEnv,
} from "../internal-secret-env.js";
import { sourceFiles } from "./source-files.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isInternalSecretEnvKey", () => {
  it("matches every internal key in any letter case, and nothing else", () => {
    // Windows env lookups are case-insensitive, so a lowercase
    // `yaw_mcp_vault_passphrase` unlocks the vault there -- a byte-exact
    // `.has(key)` would then miss it and hand the passphrase to a child.
    for (const key of INTERNAL_SECRET_ENV_KEYS) {
      expect(isInternalSecretEnvKey(key), key).toBe(true);
      expect(isInternalSecretEnvKey(key.toLowerCase()), key.toLowerCase()).toBe(true);
      const mixed = [...key].map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c)).join("");
      expect(isInternalSecretEnvKey(mixed), mixed).toBe(true);
    }
    for (const key of ["PATH", "Path", "HOME", "YAW_MCP_VAULT", "YAW_MCP_VAULT_PASSPHRASE_OLD", "", "YAW_MCP_TOKEN "]) {
      expect(isInternalSecretEnvKey(key), JSON.stringify(key)).toBe(false);
    }
  });
});

describe("stripInternalSecretsFromEnv / scrubInternalSecretsFromProcessEnv", () => {
  it("strip drops the internal keys in any case and keeps everything else, spelling intact", () => {
    const out = stripInternalSecretsFromEnv({
      YAW_MCP_VAULT_PASSPHRASE: "a",
      yaw_mcp_vault_passphrase_new: "b",
      Yaw_Mcp_Token: "c",
      Path: "/usr/bin",
      OTHER: "kept",
    });
    expect(out).toEqual({ Path: "/usr/bin", OTHER: "kept" });
  });

  it("scrub deletes the internal keys from process.env in place", () => {
    vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE", "hunter2");
    vi.stubEnv("YAW_MCP_TOKEN", "stale");
    scrubInternalSecretsFromProcessEnv();
    expect(process.env.YAW_MCP_VAULT_PASSPHRASE).toBeUndefined();
    expect(process.env.YAW_MCP_TOKEN).toBeUndefined();
    expect(process.env.PATH ?? process.env.Path).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Every spawn strips yaw-mcp's own secrets from the child's env.
//
// README tells the user to put YAW_MCP_VAULT_PASSPHRASE in yaw-mcp's env
// block, and promises it is stripped from the env of every child. That
// promise was broken, found, and fixed at one spawn site after another
// (sidecars-cmd.ts, oam-spawn.ts, auto-upgrade.ts, then the two taskkill
// escape hatches in compliance-cmd.ts and upgrade-cmd.ts), each time because
// the new spawn copied the obvious shape -- `spawn(cmd, args, { stdio })`,
// inheriting process.env whole. A scan catches that shape at the next site;
// a test per site does not.
//
// What it sees: in every source file that imports node:child_process, each
// call to a spawn-family function -- the child_process names, plus any
// identifier starting with `spawn` (the injected `spawnImpl` / `spawnFn` /
// `spawnLauncher` defaults) -- whose argument list does not mention
// stripInternalSecretsFromEnv. It narrows the obvious shape; it does not prove
// the leak absent. It does NOT see options built in a variable elsewhere (that
// call is flagged, and the fix is to pass the strip inline), a spawn reached
// through a file that does not import node:child_process itself (upstream.ts
// hands its env to the MCP SDK's transport), or parentheses inside string
// literals, which can throw the argument-list balancing off. Comment lines are
// skipped: prose quoting the old shape is not a call.
// ---------------------------------------------------------------------------

/** A call to a spawn-family function. Not preceded by `.` or an identifier
 *  character (so `/re/.exec(` and `child.spawn(` do not count), nor by
 *  `function ` (a declaration, not a call). */
const SPAWN_CALL = /(?<![\w$.])(?<!function\s)(spawn\w*|exec|execSync|execFile|execFileSync|fork)\s*\(/g;

/** `//` line comments and the body lines of block / JSDoc comments. */
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;

const IMPORTS_CHILD_PROCESS = /from\s+["']node:child_process["']/;

/** The text between the `(` at `open` and its matching `)`. */
function argumentList(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

/** 1-based line and callee of every spawn-family call in `source` whose
 *  arguments never mention stripInternalSecretsFromEnv. */
function unstrippedSpawnCalls(source: string): Array<{ line: number; callee: string }> {
  const code = source
    .split("\n")
    .map((line) => (COMMENT_LINE.test(line) ? "" : line))
    .join("\n");
  const out: Array<{ line: number; callee: string }> = [];
  for (const m of code.matchAll(SPAWN_CALL)) {
    const index = m.index ?? 0;
    const open = index + m[0].length - 1;
    if (argumentList(code, open).includes("stripInternalSecretsFromEnv(")) continue;
    out.push({ line: code.slice(0, index).split("\n").length, callee: m[1] });
  }
  return out;
}

describe("no spawn in src inherits yaw-mcp's own secrets", () => {
  it("recognises the shapes it exists to catch, and not the ones it must not", () => {
    // Pins the scanner itself: a scan that matches nothing proves nothing.
    const flagged = [
      'const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });',
      'spawnImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});',
      "child = spawn(cmd, args, opts);",
      'execFile("git", ["status"], (err) => {});',
      "const c = fork(modulePath);",
      ["child = spawn(", "  cmd,", "  args,", '  { stdio: "ignore" },', ");"].join("\n"),
    ];
    for (const src of flagged) expect(unstrippedSpawnCalls(src), src).toHaveLength(1);
    const clean = [
      'spawn("taskkill", args, { stdio: "ignore", env: stripInternalSecretsFromEnv(process.env) });',
      [
        "const child = spawnFn(",
        '  "npm",',
        "  args,",
        "  { env: stripInternalSecretsFromEnv(process.env) },",
        ");",
      ].join("\n"),
      "const m = /(\\d+)/.exec(text);", // RegExp#exec
      "child.spawn(x);", // a method, not the import
      "export function spawnServer(opts) {", // a declaration
      "  // spawn(cmd, args, { stdio })  quoted in prose",
      '   * `spawn("npx.cmd", args)` quoted in a JSDoc body',
      'child.once("spawn", () => {});',
    ];
    for (const src of clean) expect(unstrippedSpawnCalls(src), src).toEqual([]);
  });

  it("finds none -- every spawn passes env: stripInternalSecretsFromEnv(process.env)", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of sourceFiles()) {
      if (!IMPORTS_CHILD_PROCESS.test(file.text)) continue;
      scanned++;
      const lines = file.text.split("\n");
      for (const { line, callee } of unstrippedSpawnCalls(file.text)) {
        offenders.push(`${file.path}:${line}  ${callee}(...)  ${lines[line - 1].trim().slice(0, 100)}`);
      }
    }
    // The scan has to be looking at something: the self-upgrade, the probes,
    // the compliance suite and the browser launcher all spawn.
    expect(scanned).toBeGreaterThanOrEqual(5);
    expect(
      offenders,
      "These spawn a child without stripping yaw-mcp's own secrets (the vault " +
        "passphrase above all) from its env. Pass `env: stripInternalSecretsFromEnv(process.env)` " +
        "(internal-secret-env.ts) in the options:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
