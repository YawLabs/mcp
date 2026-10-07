// `yaw-mcp set <server> env.KEY --secret` -- the one-step vault write. The
// two-step form (`secrets set NAME`, then `set <server> env.KEY='${secret:NAME}'`)
// let a user store the secret and forget the second command, leaving the
// vault entry unused and the plaintext in bundles.json. These tests pin that
// one run does both halves, refuses before any prompt when it cannot, and
// never prints the value.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLES_LOCK_NAME } from "../local-bundles.js";
import { parseSetArgs, runSet, SET_USAGE, type SetCommandOptions } from "../local-set-cmd.js";
import { runSecrets } from "../secrets-cmd.js";
import { lock } from "../secrets-vault.js";

const PASS = "correct-horse-battery";
const VALUE = "ghp_new_value_123";

let synthHome: string;

beforeEach(() => {
  lock();
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-set-secret-"));
});

afterEach(() => {
  lock();
  rmSync(synthHome, { recursive: true, force: true });
});

const bundlesPath = (): string => join(synthHome, ".yaw-mcp", "bundles.json");
const vaultFile = (): string => join(synthHome, ".yaw-mcp", "secrets.json");

function writeBundles(body: string): void {
  mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
  writeFileSync(bundlesPath(), body);
}

const SAMPLE = `{
  // my servers -- keep this comment
  "version": 1,
  "servers": [
    { "namespace": "gh", "name": "GitHub", "command": "npx", "args": ["-y", "gh-mcp"], "env": { "OTHER": "o" } },
    { "namespace": "pg", "name": "Postgres", "command": "npx", "args": ["-y", "pg-mcp"], "env": { "PGPASSWORD": "plain" } },
    { "namespace": "rot", "name": "Rotating", "command": "npx", "args": ["-y", "r-mcp"], "env": { "TOKEN": "\${secret:mytok}" } },
    { "namespace": "far", "name": "Far", "url": "https://example.test/mcp" }
  ]
}
`;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

function read(): { servers: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(bundlesPath(), "utf8").replace(/^\s*\/\/.*$/gm, ""));
}

function envOf(ns: string): Record<string, unknown> | undefined {
  return read().servers.find((s) => s.namespace === ns)?.env as Record<string, unknown> | undefined;
}

/** A piped (non-TTY) stdin carrying `value`, the way `echo v | yaw-mcp set ...`
 *  delivers it. The value is read by runSecrets's own piped-stdin path. */
function pipedIo(value: string): SetCommandOptions["io"] {
  const stdin = new PassThrough();
  stdin.end(value);
  return { stdin, stdout: new PassThrough() };
}

async function secretSet(
  target: string,
  assignment: string,
  extra: Partial<SetCommandOptions> = {},
  value = `${VALUE}\n`,
): Promise<{ exitCode: number; out: string; err: string }> {
  const c = capture();
  const r = await runSet({
    target,
    assignments: [assignment],
    secret: true,
    home: synthHome,
    cwd: synthHome,
    env: {},
    passphrase: PASS,
    isTTY: false,
    io: pipedIo(value),
    out: c.out,
    err: c.err,
    ...extra,
  });
  return { exitCode: r.exitCode, out: c.text(), err: c.errText() };
}

/** Read one vault entry back with a fresh derivation. */
async function readBack(name: string): Promise<string | undefined> {
  lock();
  const out: string[] = [];
  const r = await runSecrets(
    { action: "get", name, passphrase: PASS, home: synthHome, json: true },
    { out: (s) => out.push(s), err: () => {} },
  );
  lock();
  if (r.exitCode !== 0) return undefined;
  return JSON.parse(out.join("").trim()).value as string;
}

describe("parseSetArgs -- --secret", () => {
  it("accepts a bare env.KEY with --secret, and --secret-name NAME", () => {
    const r = parseSetArgs(["gh", "env.GITHUB_TOKEN", "--secret", "--secret-name", "gh_pat"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.secret).toBe(true);
      expect(r.options.secretName).toBe("gh_pat");
      expect(r.options.assignments).toEqual(["env.GITHUB_TOKEN"]);
    }
  });

  it("accepts --stdin with --secret only", () => {
    const r = parseSetArgs(["gh", "env.GITHUB_TOKEN", "--secret", "--stdin"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.fromStdin).toBe(true);
    const bare = parseSetArgs(["gh", "description=x", "--stdin"]);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).toContain("--stdin only applies with --secret");
  });

  it("refuses an inline =value with --secret, so the value never rides argv", () => {
    const r = parseSetArgs(["gh", "env.GITHUB_TOKEN=ghp_x", "--secret"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("never from the command line");
      // The refusal names the key, not the value it refused.
      expect(r.error).not.toContain("ghp_x");
    }
  });

  it("refuses every other malformed --secret shape before any prompt", () => {
    const cases: Array<[string[], string]> = [
      [["gh", "env.A", "env.B", "--secret"], "exactly one env.KEY"],
      [["gh", "isActive", "--secret"], "env.KEY only"],
      [["gh", "env.9X", "--secret"], "not a valid environment variable name"],
      [["gh", "env.A", "--secret", "--secret-name", "has space"], "invalid secret name"],
      [["gh", "env.A", "--secret-name", "n"], "only applies with --secret"],
      [["gh", "env.A", "--secret", "--secret-name"], "--secret-name requires a name"],
      [["gh", "env.A", "--secret", "--secret-name", "--json"], "--secret-name requires a name"],
    ];
    for (const [argv, msg] of cases) {
      const r = parseSetArgs(argv);
      expect(r.ok, argv.join(" ")).toBe(false);
      if (!r.ok) expect(r.error, argv.join(" ")).toContain(msg);
    }
  });

  it("documents the flag and the naming rule in the usage text", () => {
    expect(SET_USAGE).toContain("env.KEY --secret");
    expect(SET_USAGE).toContain("--secret-name NAME");
    expect(SET_USAGE).toContain("<namespace>_<KEY>, lowercased");
  });
});

describe("runSet --secret", () => {
  it("stores the value in the vault and writes the reference, in one run", async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("gh", "env.GITHUB_TOKEN");
    expect(r.exitCode).toBe(0);
    expect(envOf("gh")).toEqual({ OTHER: "o", GITHUB_TOKEN: "${secret:gh_github_token}" });
    // Spliced, not rewritten: the user's comment survives.
    expect(readFileSync(bundlesPath(), "utf8")).toContain("// my servers -- keep this comment");
    expect(await readBack("gh_github_token")).toBe(VALUE);
    // One summary line naming the secret and the reference.
    const first = r.out.split("\n")[0];
    expect(first).toContain('secret "gh_github_token"');
    expect(first).toContain("env.GITHUB_TOKEN to ${secret:gh_github_token}");
    expect(first).toContain("Created the vault");
    // The value appears nowhere.
    expect(r.out).not.toContain(VALUE);
    expect(r.err).not.toContain(VALUE);
    // runSecrets's "no server references it yet -- run `set <server>
    // env.KEY=...`" notice is the step this run just did; it is not passed on.
    expect(r.err).not.toContain("references ${secret:gh_github_token} yet");
    expect(r.err).not.toContain("yaw-mcp set <server>");
  });

  it("uses --secret-name when given", async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("gh", "env.GITHUB_TOKEN", { secretName: "work.gh-pat" });
    expect(r.exitCode).toBe(0);
    expect(envOf("gh")?.GITHUB_TOKEN).toBe("${secret:work.gh-pat}");
    expect(await readBack("work.gh-pat")).toBe(VALUE);
  });

  it("re-running on a key that already references a secret rotates THAT entry", async () => {
    writeBundles(SAMPLE);
    const first = await secretSet("rot", "env.TOKEN", {}, "v1\n");
    expect(first.exitCode).toBe(0);
    expect(first.out).toContain('stored secret "mytok"; env.TOKEN on "rot" already references it.');
    const before = readFileSync(bundlesPath(), "utf8");
    const second = await secretSet("rot", "env.TOKEN", {}, "v2\n");
    expect(second.exitCode).toBe(0);
    // Scripted replace proceeds and says so, the `secrets set` semantics.
    expect(second.out).toContain('Replaced secret "mytok"');
    expect(readFileSync(bundlesPath(), "utf8")).toBe(before);
    expect(await readBack("mytok")).toBe("v2");
  });

  it("replaces an existing vault name on a scripted run and says Replaced", async () => {
    writeBundles(SAMPLE);
    expect((await secretSet("gh", "env.GITHUB_TOKEN", {}, "old\n")).exitCode).toBe(0);
    // A second key on the same server pointed at the same vault name.
    const r = await secretSet("gh", "env.SECOND", { secretName: "gh_github_token" });
    expect(r.exitCode).toBe(0);
    expect(r.out.split("\n")[0]).toContain('Replaced secret "gh_github_token" and set env.SECOND');
    expect(await readBack("gh_github_token")).toBe(VALUE);
  });

  it("refuses to overwrite a stored plaintext off a TTY without --force, before touching the vault", async () => {
    writeBundles(SAMPLE);
    const before = readFileSync(bundlesPath(), "utf8");
    const r = await secretSet("pg", "env.PGPASSWORD");
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain("refusing to overwrite PGPASSWORD");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(before);
    expect(existsSync(vaultFile())).toBe(false);
  });

  it("moves a stored plaintext into the vault with --force", async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("pg", "env.PGPASSWORD", { force: true });
    expect(r.exitCode).toBe(0);
    expect(envOf("pg")).toEqual({ PGPASSWORD: "${secret:pg_pgpassword}" });
    expect(readFileSync(bundlesPath(), "utf8")).not.toContain('"plain"');
    expect(await readBack("pg_pgpassword")).toBe(VALUE);
  });

  it("a declined overwrite confirmation leaves both stores untouched", async () => {
    writeBundles(SAMPLE);
    const before = readFileSync(bundlesPath(), "utf8");
    const r = await secretSet("pg", "env.PGPASSWORD", { isTTY: undefined, promptAnswer: "n" });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("Aborted.");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(before);
    expect(existsSync(vaultFile())).toBe(false);
  });

  it("refuses a remote server before any vault write", async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("far", "env.API_KEY");
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("is a remote server");
    expect(existsSync(vaultFile())).toBe(false);
  });

  it("refuses an unknown server before any vault write", async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("nosuch", "env.API_KEY");
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('no server named "nosuch"');
    expect(existsSync(vaultFile())).toBe(false);
  });

  it("refuses an inline value from a programmatic caller too", async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("gh", "env.GITHUB_TOKEN=ghp_inline");
    expect(r.exitCode).toBe(2);
    expect(r.err).not.toContain("ghp_inline");
    expect(existsSync(vaultFile())).toBe(false);
  });

  it("asks for --secret-name when the namespace cannot form a vault name", async () => {
    writeBundles(`{ "version": 1, "servers": [
      { "namespace": "my server", "name": "Odd", "command": "npx", "args": ["x"] }
    ] }`);
    const r = await secretSet("my server", "env.TOKEN");
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain("--secret-name NAME");
    expect(existsSync(vaultFile())).toBe(false);
  });

  it("an empty value fails in the vault step and writes nothing to bundles.json", async () => {
    writeBundles(SAMPLE);
    const before = readFileSync(bundlesPath(), "utf8");
    const r = await secretSet("gh", "env.GITHUB_TOKEN", {}, "\n");
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("Secret value cannot be empty.");
    expect(r.err).toContain("Nothing was written to");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(before);
  });

  it("--json: stdout is the one set envelope, carrying the secret name and ref but no value", async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("gh", "env.GITHUB_TOKEN", { json: true });
    expect(r.exitCode).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines, lines.map((l) => l.slice(0, 160)).join(" // ")).toHaveLength(1);
    const env = JSON.parse(lines[0]);
    expect(env).toMatchObject({
      ok: true,
      namespace: "gh",
      changed: true,
      changes: [{ field: "env", key: "GITHUB_TOKEN", action: "set" }],
      secret: { name: "gh_github_token", ref: "${secret:gh_github_token}", replaced: false, fresh_vault: true },
    });
    expect(r.out).not.toContain(VALUE);
    expect(r.err).not.toContain(VALUE);
  });

  it("--stdin reads the value from stdin whole even when stdin is a TTY", async () => {
    writeBundles(SAMPLE);
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    stdin.end(`${VALUE}\n`);
    const r = await secretSet("gh", "env.GITHUB_TOKEN", { fromStdin: true, io: { stdin, stdout: new PassThrough() } });
    expect(r.exitCode).toBe(0);
    expect(await readBack("gh_github_token")).toBe(VALUE);
  });

  it("a TTY stdin with a redirected stdout names the remedy `set` accepts, under its own verb", async () => {
    writeBundles(SAMPLE);
    const before = readFileSync(bundlesPath(), "utf8");
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const r = await secretSet("gh", "env.GITHUB_TOKEN", { io: { stdin, stdout: new PassThrough() } });
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("yaw-mcp set: cannot prompt for the value");
    expect(r.err).toContain("Pipe the value in with --stdin.");
    expect(r.err).not.toContain("--value");
    expect(r.err).not.toContain("yaw-mcp secrets set:");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(before);
  });

  it("a wrong passphrase on an existing vault writes nothing to bundles.json", async () => {
    writeBundles(SAMPLE);
    expect((await secretSet("gh", "env.GITHUB_TOKEN")).exitCode).toBe(0);
    lock();
    const before = readFileSync(bundlesPath(), "utf8");
    const r = await secretSet("pg", "env.NEWKEY", { passphrase: "not-the-passphrase" });
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("Nothing was written to");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(before);
  });

  it("--force over a non-string stored value is not misread as a concurrent change", async () => {
    writeBundles(`{ "version": 1, "servers": [
      { "namespace": "js", "name": "Js", "command": "npx", "args": ["x"], "env": { "CFG": { "a": 1 } } }
    ] }`);
    const r = await secretSet("js", "env.CFG", { force: true });
    expect(r.err).not.toContain("while you were entering the secret");
    expect(r.exitCode).toBe(0);
    expect(envOf("js")).toEqual({ CFG: "${secret:js_cfg}" });
    expect(await readBack("js_cfg")).toBe(VALUE);
  });

  it("refuses a derived name another key already references, before any vault write", async () => {
    // GITHUB_TOKEN and github_token both derive gh_github_token; namespace
    // "a_b" + C and "a" + B_C both derive a_b_c.
    writeBundles(`{ "version": 1, "servers": [
      { "namespace": "gh", "name": "GitHub", "command": "npx", "args": ["x"], "env": { "GITHUB_TOKEN": "\${secret:gh_github_token}" } },
      { "namespace": "a", "name": "A", "command": "npx", "args": ["x"], "env": { "B_C": "\${secret:a_b_c}" } },
      { "namespace": "a_b", "name": "AB", "command": "npx", "args": ["x"] }
    ] }`);
    const before = readFileSync(bundlesPath(), "utf8");
    const same = await secretSet("gh", "env.github_token");
    expect(same.exitCode).toBe(2);
    expect(same.err).toContain('"gh_github_token" is already referenced by gh env.GITHUB_TOKEN');
    expect(same.err).toContain("--secret-name NAME");
    const cross = await secretSet("a_b", "env.C");
    expect(cross.exitCode).toBe(2);
    expect(cross.err).toContain("referenced by a env.B_C");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(before);
    expect(existsSync(vaultFile())).toBe(false);
    // An explicit --secret-name is a deliberate share and proceeds.
    const shared = await secretSet("a_b", "env.C", { secretName: "a_b_c" });
    expect(shared.exitCode).toBe(0);
  });

  /** A stdin that runs `hook` at the moment runSecrets reads the value --
   *  after the pre-checks and the vault unlock, before the bundles write --
   *  then yields `value`. */
  function hookedIo(hook: () => void, value = `${VALUE}\n`): SetCommandOptions["io"] {
    let done = false;
    const stdin = new Readable({
      read() {
        if (done) return;
        done = true;
        hook();
        this.push(value);
        this.push(null);
      },
    });
    return { stdin, stdout: new PassThrough() };
  }

  const PG_HINT = "finish with `yaw-mcp set pg env.PGPASSWORD='${secret:pg_pgpassword}'`";

  it("refuses when env.KEY changed while the value was entered, and says the secret is stored", async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("pg", "env.PGPASSWORD", {
      force: true,
      io: hookedIo(() => writeBundles(SAMPLE.replace('"plain"', '"plain2"'))),
    });
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("while you were entering the secret");
    expect(r.err).toContain(PG_HINT);
    expect(envOf("pg")).toEqual({ PGPASSWORD: "plain2" });
    expect(await readBack("pg_pgpassword")).toBe(VALUE);
  });

  it("an entry gone after the vault write still prints the finish command", async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("pg", "env.PGPASSWORD", {
      force: true,
      io: hookedIo(() => writeBundles(SAMPLE.replace('"namespace": "pg"', '"namespace": "pg2"'))),
    });
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain(PG_HINT);
    expect(await readBack("pg_pgpassword")).toBe(VALUE);
  });

  /** The failure envelope under --json, parsed. Every stderr line must be
   *  JSON (no prose leaks); the vault's own `vault-created` warning line may
   *  precede it, but exactly one line is an `ok: false` envelope. */
  function jsonErr(err: string): Record<string, unknown> {
    const parsed = err
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const fails = parsed.filter((p) => p.ok === false);
    expect(fails).toHaveLength(1);
    return fails[0];
  }

  it("--json: a change while entering emits one envelope saying the secret is stored", async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("pg", "env.PGPASSWORD", {
      force: true,
      json: true,
      io: hookedIo(() => writeBundles(SAMPLE.replace('"plain"', '"plain2"'))),
    });
    expect(r.exitCode).toBe(1);
    expect(r.out).toBe("");
    const env = jsonErr(r.err);
    expect(env.ok).toBe(false);
    expect(env.stored).toBe(true);
    expect(env.error).toContain("while you were entering the secret");
    expect(env.hint).toContain("yaw-mcp set pg env.PGPASSWORD='${secret:pg_pgpassword}'");
    expect(env.secret).toEqual({
      name: "pg_pgpassword",
      ref: "${secret:pg_pgpassword}",
      replaced: false,
      fresh_vault: true,
    });
    expect(r.err).not.toContain(VALUE);
    expect(envOf("pg")).toEqual({ PGPASSWORD: "plain2" });
    expect(await readBack("pg_pgpassword")).toBe(VALUE);
  });

  it("--json: an entry gone after the vault write emits one envelope carrying the refusal", async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("pg", "env.PGPASSWORD", {
      force: true,
      json: true,
      io: hookedIo(() => writeBundles(SAMPLE.replace('"namespace": "pg"', '"namespace": "pg2"'))),
    });
    expect(r.exitCode).not.toBe(0);
    const env = jsonErr(r.err);
    expect(env.ok).toBe(false);
    expect(env.stored).toBe(true);
    expect(typeof env.error).toBe("string");
    expect(env.error).not.toBe("");
    expect((env.secret as Record<string, unknown>).name).toBe("pg_pgpassword");
    expect(r.err).not.toContain(VALUE);
    expect(await readBack("pg_pgpassword")).toBe(VALUE);
  });

  it("--json: a held bundles lock after the vault write emits one envelope", { timeout: 20_000 }, async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("pg", "env.PGPASSWORD", {
      force: true,
      json: true,
      io: hookedIo(() => writeFileSync(join(synthHome, ".yaw-mcp", BUNDLES_LOCK_NAME), `${process.pid}\n`)),
    });
    expect(r.exitCode).toBe(1);
    const env = jsonErr(r.err);
    expect(env.stored).toBe(true);
    expect(env.error).toContain("is locked by another yaw-mcp process");
    expect(await readBack("pg_pgpassword")).toBe(VALUE);
  });

  it("a held bundles lock after the vault write fails with the finish command", { timeout: 20_000 }, async () => {
    writeBundles(SAMPLE);
    const r = await secretSet("pg", "env.PGPASSWORD", {
      force: true,
      // This live process's pid: the lock is not stale, so the wait runs out.
      io: hookedIo(() => writeFileSync(join(synthHome, ".yaw-mcp", BUNDLES_LOCK_NAME), `${process.pid}\n`)),
    });
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("is locked by another yaw-mcp process");
    expect(r.err).toContain(PG_HINT);
    expect(envOf("pg")).toEqual({ PGPASSWORD: "plain" });
    expect(await readBack("pg_pgpassword")).toBe(VALUE);
  });
});
