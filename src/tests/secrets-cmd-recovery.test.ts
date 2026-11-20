// The CLI half of vault recovery codes (spec section 4): issuing a code at
// creation (display + confirm, the alternate screen, the agent-session and
// no-terminal suppression), `recover`, `recovery new` / `recovery remove`,
// rotate's recovery-slot rules, reset's pointer at recover, and the rule that
// a code reaches ONLY the prompt stream -- never io.out, io.err, a --json
// envelope, the audit log or the logger.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatRecoveryCode,
  generateRecoverySecret,
  RECOVERY_CODE_TYPO_ERROR,
  RECOVERY_CODE_WRONG_VAULT_ERROR,
  recoveryCodeGroups,
} from "../recovery-code.js";
import { auditLogPath } from "../secrets-audit.js";
import { parseSecretsArgs, runSecrets, SECRETS_USAGE } from "../secrets-cmd.js";
import {
  createVaultV3,
  getSecret,
  loadVault,
  lock,
  newVault,
  recoveryStatus,
  SECRETS_SCHEMA_VERSION,
  saveVault,
  setSecret,
  unlock,
  unlockWithRecoveryCode,
  VAULT_NO_RECOVERY_ERROR,
  type VaultFile,
  vaultPath,
} from "../secrets-vault.js";

// The default for every test here is "an agent drives this process", pinned
// in process.env, so a vault created at a fake terminal never waits on a code
// confirmation the test did not script. The display tests inject `env: {}` --
// which also proves the agent check reads the INJECTED env, not process.env.
let savedAiAgent: string | undefined;
beforeAll(() => {
  savedAiAgent = process.env.AI_AGENT;
  process.env.AI_AGENT = "secrets-cmd-recovery.test";
});
afterAll(() => {
  if (savedAiAgent === undefined) delete process.env.AI_AGENT;
  else process.env.AI_AGENT = savedAiAgent;
});

const CODE_RE = /YAWR(?:-[0-9A-Z]{4}){7}/g;
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";

/** One answer the fake terminal gives: fixed text, or text computed from
 *  everything shown on the prompt stream so far (so a test can answer "type
 *  group N" for a code it only learns at run time). */
type Answer = string | ((screen: string) => string);

/** A TTY stdin that hands out one queued answer per resume(), the shape the
 *  raw-mode reader drives (same contract as the fakes in secrets-cmd.test.ts),
 *  with answers evaluated lazily against the screen. */
class ScriptedTTY {
  isTTY = true;
  isRaw = false;
  /** Set once the scripted answers run out: a drained queue is a CLOSED
   *  stdin, not a prompt waiting on a human. tty-reader resolves every read
   *  after it as ANSWER_EOF ("") straight from this flag, without waiting --
   *  so a test that queues fewer answers than prompts exercises a genuine
   *  deliver-nothing stdin, and a confirm loop that forgot its empty-bound
   *  would resolve "" forever (the test times out) instead of passing. */
  readableEnded = false;
  private listener: ((chunk: string) => void) | null = null;
  private queue: Answer[];
  setRawMode = (v: boolean): this => {
    this.isRaw = v;
    return this;
  };
  constructor(
    answers: Answer[],
    private screen: () => string,
  ) {
    this.queue = [...answers];
  }
  get pending(): number {
    return this.queue.length;
  }
  setEncoding(): this {
    return this;
  }
  on(event: string, cb: (chunk: string) => void): this {
    if (event === "data") this.listener = cb;
    return this;
  }
  removeListener(event: string, cb: (chunk: string) => void): this {
    if (event === "data" && this.listener === cb) this.listener = null;
    return this;
  }
  resume(): this {
    const next = this.queue.shift();
    if (next !== undefined) {
      queueMicrotask(() => this.listener?.(typeof next === "function" ? next(this.screen()) : next));
    } else {
      // Nothing left to hand out: the writer is gone. The flag is checked by
      // tty-reader after resume(), so this read still settles (as ""), while
      // every later one is already "ended" on entry.
      this.readableEnded = true;
    }
    return this;
  }
  pause(): this {
    return this;
  }
  unshift(chunk: string): void {
    this.queue.unshift(chunk);
  }
}

type Sink = NodeJS.WritableStream & { isTTY: boolean; text: () => string };
function sink(isTTY: boolean): Sink {
  const write = vi.fn();
  return {
    isTTY,
    write,
    text: () => write.mock.calls.map((c) => String(c[0])).join(""),
  } as unknown as Sink;
}

/** The codes shown on a screen, in order. */
function codesOn(screen: string): string[] {
  return screen.match(CODE_RE) ?? [];
}

/** Occurrences of `needle` in `s`. Counting is REQUIRED wherever two
 *  wordings overlap: the confirm's final attempt prints "That does not match
 *  the code above." as a whole line, while the earlier attempts print that
 *  SAME text as a prefix of "… try again.", so `toContain` cannot tell one
 *  occurrence from three -- only an occurrence count pins which variant
 *  printed how often. */
const occurrences = (s: string, needle: string): number => s.split(needle).length - 1;

/** The answer to the latest "Type group N" prompt, for the latest code shown. */
const rightGroup: Answer = (screen) => {
  const codes = codesOn(screen);
  const asked = [...screen.matchAll(/Type group (\d) of 7/g)];
  const n = Number(asked[asked.length - 1][1]);
  return `${recoveryCodeGroups(codes[codes.length - 1])[n - 1].toLowerCase()}\r`;
};
/** A wrong answer to it: the right group with its first symbol changed. */
const wrongGroup: Answer = (screen) => {
  const right = (rightGroup as (s: string) => string)(screen).toUpperCase();
  return `${right[0] === "0" ? "1" : "0"}${right.slice(1)}`;
};

const PASS = "the-original-passphrase";
const NEW_PASS = "a-brand-new-passphrase";
const io = { out: vi.fn(), err: vi.fn() };
const outText = (): string => io.out.mock.calls.map((c) => c[0] as string).join("");
const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");
const errJson = (): Array<Record<string, unknown>> =>
  errText()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
let home: string;
let processWrites: string[];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  io.out.mockReset();
  io.err.mockReset();
  lock();
  for (const k of ["YAW_MCP_VAULT_PASSPHRASE", "YAW_MCP_VAULT_PASSPHRASE_NEW", "MSYSTEM"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(nodePath.join(os.tmpdir(), "yaw-mcp-recovery-cli-"));
  await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  vi.spyOn(process, "cwd").mockImplementation(() => home);
  // Everything the process itself writes (the logger, a stray console line)
  // is captured, so a test can assert no code ever reached it.
  processWrites = [];
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
      processWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return true;
    }) as typeof stream.write);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  lock();
});

/** A terminal: a scripted stdin and a TTY stdout (the prompt stream). */
function terminal(answers: Answer[], json = false): { io: SecretsIoStreams; screen: Sink; stdin: ScriptedTTY } {
  const screen = sink(true);
  const stdin = new ScriptedTTY(answers, () => screen.text());
  return json
    ? {
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout: sink(false), stderr: screen },
        screen,
        stdin,
      }
    : { io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout: screen }, screen, stdin };
}
type SecretsIoStreams = { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr?: NodeJS.WritableStream };

function noTerminal(): SecretsIoStreams {
  return {
    stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    stdout: { isTTY: false, write: vi.fn() } as unknown as NodeJS.WritableStream,
    stderr: { isTTY: false, write: vi.fn() } as unknown as NodeJS.WritableStream,
  };
}

/** Write a v3 vault with `entries` straight through the vault module, with or
 *  without a recovery slot; returns its code. */
async function seedV3(recovery: boolean, entries: Record<string, string> = { GH: "ghp_one", NPM: "npm_two" }) {
  const built = await createVaultV3(PASS, { recovery });
  let vault = built.vault;
  const key = await unlock(vault, PASS);
  for (const [n, v] of Object.entries(entries)) vault = setSecret(vault, key, n, v);
  key.fill(0);
  lock();
  await saveVault(vaultPath(home), vault);
  return built.recoveryCode as string;
}

async function onDisk(path = vaultPath(home)): Promise<VaultFile> {
  const v = await loadVault(path);
  if (!v) throw new Error(`no vault at ${path}`);
  return v;
}

async function opensWith(passphrase: string, path = vaultPath(home)): Promise<boolean> {
  lock();
  try {
    (await unlock(await onDisk(path), passphrase)).fill(0);
    return true;
  } catch {
    return false;
  } finally {
    lock();
  }
}

async function codeOpens(code: string, path = vaultPath(home)): Promise<boolean | string> {
  try {
    unlockWithRecoveryCode(await onDisk(path), code).fill(0);
    return true;
  } catch (err) {
    return (err as Error).message;
  }
}

function auditText(): string {
  return existsSync(auditLogPath(home)) ? readFileSync(auditLogPath(home), "utf8") : "";
}

function auditKinds(): string[] {
  return auditText()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => (JSON.parse(l) as { event: string }).event);
}

/** The code may appear on the prompt stream and nowhere else. */
function expectCodeOnlyOnScreen(codes: string[]): void {
  expect(codes.length).toBeGreaterThan(0);
  const elsewhere = [outText(), errText(), auditText(), processWrites.join("")];
  for (const code of codes) {
    for (const g of recoveryCodeGroups(code)) {
      // Every 4-symbol group, not just the whole code: a partial leak counts.
      for (const text of elsewhere) expect(text).not.toContain(g);
    }
  }
}

// ---------------------------------------------------------------------------
describe("parseSecretsArgs -- recover / recovery", () => {
  it("parses recover, recover --file, and recovery new / remove", () => {
    expect(parseSecretsArgs(["recover"])).toMatchObject({ ok: true, options: { action: "recover" } });
    expect(parseSecretsArgs(["recover", "--file", "x.json", "--force"])).toMatchObject({
      ok: true,
      options: { action: "recover", file: "x.json", force: true },
    });
    expect(parseSecretsArgs(["recovery", "new"])).toMatchObject({
      ok: true,
      options: { action: "recovery", recoverySub: "new" },
    });
    expect(parseSecretsArgs(["recovery", "remove", "--force"])).toMatchObject({
      ok: true,
      options: { action: "recovery", recoverySub: "remove", force: true },
    });
    expect(parseSecretsArgs(["set", "GH", "--no-recovery"])).toMatchObject({ ok: true, options: { noRecovery: true } });
  });

  it.each([
    [["recovery"], /recovery needs a subcommand/],
    [["recovery", "rotate"], /unknown recovery subcommand "rotate"/],
    [["recovery", "new", "GH"], /recovery new takes no <name>/],
    [["recover", "GH"], /recover takes no <name>/],
    [["get", "GH", "--no-recovery"], /--no-recovery applies to `set`, `reset`, `rotate` and `recover` only/],
    [["recovery", "new", "--no-recovery"], /--no-recovery applies to/],
    [["set", "GH", "--file", "x"], /--file applies to `recover` only/],
    [["recover", "--file"], /--file requires a path/],
    [["recover", "--file", "--json"], /--file requires a path/],
  ])("refuses %j", (argv, re) => {
    const r = parseSecretsArgs(argv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });
});

// ---------------------------------------------------------------------------
describe("creating a vault issues a recovery code at a terminal", () => {
  it("set: passphrase, then the code on the alternate screen, two groups typed back, then the save", async () => {
    const t = terminal([`${PASS}\r`, `${PASS}\r`, rightGroup, rightGroup]);
    const r = await runSecrets({ action: "set", name: "GH", value: "ghp_one", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(0);
    const screen = t.screen.text();
    const [code] = codesOn(screen);
    expect(code).toBeDefined();
    // Shown inside the alternate screen, which is left again afterwards.
    expect(screen.indexOf(ALT_ON)).toBeLessThan(screen.indexOf(code));
    expect(screen.lastIndexOf(ALT_OFF)).toBeGreaterThan(screen.lastIndexOf("Type group"));
    expect(t.stdin.pending).toBe(0);
    // The vault is v3 with a slot the shown code opens.
    const v = await onDisk();
    expect(v.version).toBe(SECRETS_SCHEMA_VERSION);
    expect(recoveryStatus(v).state).toBe("set");
    expect(await codeOpens(code)).toBe(true);
    expect(outText()).toBe('Created vault and Stored secret "GH".\n');
    expect(auditKinds()).toEqual(["recovery-issued"]);
    expectCodeOnlyOnScreen([code]);
  });

  it("under --json the code goes to the prompt end (stderr), never the envelope or io.err", async () => {
    const t = terminal([`${PASS}\r`, `${PASS}\r`, rightGroup, rightGroup], true);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: {}, json: true }, io);
    expect(r.exitCode).toBe(0);
    const [code] = codesOn(t.screen.text());
    expect(JSON.parse(outText())).toMatchObject({ ok: true, fresh_vault: true, recovery: "set" });
    // io.err stays one JSON object per line, none of them about a missing code.
    expect(errJson().map((l) => l.warning)).toEqual(["vault-created"]);
    expectCodeOnlyOnScreen([code]);
  });

  it("three wrong confirmations: nothing is saved, exit 1, and the message names --no-recovery", async () => {
    const t = terminal([`${PASS}\r`, `${PASS}\r`, wrongGroup, wrongGroup, wrongGroup]);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toBe(
      "yaw-mcp secrets set: Aborted -- nothing was saved. Re-run, or pass --no-recovery to create the vault without a recovery code.\n",
    );
    expect(existsSync(vaultPath(home))).toBe(false);
    expect(t.screen.text().endsWith(ALT_OFF)).toBe(true);
    expect(auditText()).toBe("");
    expectCodeOnlyOnScreen(codesOn(t.screen.text()));
  });

  it("a wrong group, then the right ones, is accepted on the second attempt", async () => {
    const t = terminal([`${PASS}\r`, `${PASS}\r`, wrongGroup, rightGroup, rightGroup]);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(0);
    expect(t.screen.text()).toContain("That does not match the code above.");
    expect(recoveryStatus(await onDisk()).state).toBe("set");
  });

  it("an empty answer at a group prompt re-prompts without burning an attempt", async () => {
    // Three bare Enters (\r with nothing typed: what tty-reader folds to ""):
    // under the old counting they were three mismatches, so the 3 attempts
    // died before the right groups were ever asked. An empty entry is nothing
    // typed -- re-prompt the same group instead.
    const t = terminal([`${PASS}\r`, `${PASS}\r`, "\r", "\r", "\r", rightGroup, rightGroup]);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(0);
    expect(t.screen.text()).not.toContain("That does not match");
    expect(recoveryStatus(await onDisk()).state).toBe("set");
  });

  it("empty answers alone still end the confirm (a closed stdin must not spin)", async () => {
    // A closed/EOF'd stdin yields an empty read forever; the empty-bound (not
    // the attempt count, which empties no longer touch) is what terminates.
    // Eight empties are fed: the confirm must stop after exactly the bound's
    // five re-prompts, not after the three MISMATCH attempts the old counting
    // turned empties into (that would be three prompts, not five).
    const t = terminal([`${PASS}\r`, `${PASS}\r`, "\r", "\r", "\r", "\r", "\r", "\r", "\r", "\r"]);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(1);
    // The REASON, on the prompt stream: the "That does not match" line never
    // prints for empties, so the empty-bound exit carries its own sentence --
    // without it the user (and this test) would see only the caller's generic
    // "Aborted -- nothing was saved." with no cause.
    expect(t.screen.text()).toContain("No group was entered -- the prompt was left empty 5 times in a row.");
    expect(errText()).toContain("Aborted -- nothing was saved.");
    expect(existsSync(vaultPath(home))).toBe(false);
    expect(t.screen.text().match(/Type group \d of 7/g)).toHaveLength(5);
  });

  it("a stdin that delivers nothing at the group prompt ends the confirm (no infinite loop)", async () => {
    // Deliberately NOT scripted past the two passphrase lines: once they are
    // consumed the fake stdin has nothing left and closes (readableEnded), so
    // every group read folds to "" -- the shape a pipe whose writer exited
    // actually has, which the scripted test above cannot produce (its queue
    // answers forever). The empty-bound is the only thing that can end this
    // loop; if it regressed the reader would resolve "" forever and this test
    // would TIME OUT rather than pass.
    const t = terminal([`${PASS}\r`, `${PASS}\r`]);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(1);
    // Terminated after exactly the bound's five prompts, with the reason.
    expect(t.screen.text().match(/Type group \d of 7/g)).toHaveLength(5);
    expect(t.screen.text()).toContain("No group was entered -- the prompt was left empty 5 times in a row.");
    expect(errText()).toContain("Aborted -- nothing was saved.");
    expect(existsSync(vaultPath(home))).toBe(false);
    // The alternate screen was still left exactly once the confirm was done.
    expect(t.screen.text().endsWith(ALT_OFF)).toBe(true);
  });

  it("^C at the confirmation: exit 130, nothing saved, the alternate screen left", async () => {
    const t = terminal([`${PASS}\r`, `${PASS}\r`, "\x03"]);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(130);
    expect(existsSync(vaultPath(home))).toBe(false);
    expect(t.screen.text().endsWith(ALT_OFF)).toBe(true);
  });

  it.each([
    ["CLAUDECODE"],
    ["AI_AGENT"],
  ])("an agent session (%s in the injected env) never sees a code: no slot, and the nudge", async (agentVar) => {
    const t = terminal([`${PASS}\r`, `${PASS}\r`]);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: { [agentVar]: "1" } }, io);
    expect(r.exitCode).toBe(0);
    expect(codesOn(t.screen.text())).toEqual([]);
    expect(t.screen.text()).not.toContain(ALT_ON);
    expect(recoveryStatus(await onDisk()).state).toBe("none");
    expect(errText()).toContain(
      "yaw-mcp secrets: No recovery code was created (an AI agent session). Run `yaw-mcp secrets recovery new` in a terminal to add one.\n",
    );
  });

  it("off a terminal: no slot, one nudge line (a JSON warning under --json)", async () => {
    const r = await runSecrets(
      { action: "set", name: "GH", value: "v", passphrase: PASS, home, io: noTerminal(), env: {} },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(recoveryStatus(await onDisk()).state).toBe("none");
    expect(errText()).toContain(
      "yaw-mcp secrets: No recovery code was created (no terminal). Run `yaw-mcp secrets recovery new` in a terminal to add one.\n",
    );

    rmSync(vaultPath(home));
    io.err.mockReset();
    io.out.mockReset();
    lock();
    const j = await runSecrets(
      { action: "set", name: "GH", value: "v", passphrase: PASS, home, io: noTerminal(), env: {}, json: true },
      io,
    );
    expect(j.exitCode).toBe(0);
    expect(JSON.parse(outText())).toMatchObject({ recovery: "none" });
    expect(errJson()).toContainEqual({
      warning: "no-recovery-code",
      reason: "no-terminal",
      hint: "Run `yaw-mcp secrets recovery new` in a terminal to add one.",
    });
  });

  it('--json on an un-upgraded v2 vault reports recovery: "unsupported", the state doctor reports', async () => {
    // The old field collapsed RecoveryState to "set" | "none", so a v1/v2
    // vault -- which has no slot to hold a code -- read as a plain "none",
    // disagreeing with doctor's vault.recovery ("unsupported").
    const legacy = newVault();
    const key = await unlock(legacy, PASS);
    await saveVault(vaultPath(home), setSecret(legacy, key, "GH", "v"));
    key.fill(0);
    lock();
    const r = await runSecrets(
      { action: "set", name: "NPM", value: "v", passphrase: PASS, home, io: noTerminal(), env: {}, json: true },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(outText())).toMatchObject({ recovery: "unsupported" });
    // Same read, same vocabulary on the doctor side of the pair.
    expect(recoveryStatus(await onDisk()).state).toBe("unsupported");
  });

  it("--no-recovery at a terminal: no code, no slot, and no nudge (it was asked for)", async () => {
    const t = terminal([`${PASS}\r`, `${PASS}\r`]);
    const r = await runSecrets(
      { action: "set", name: "GH", value: "v", home, io: t.io, env: {}, noRecovery: true },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(codesOn(t.screen.text())).toEqual([]);
    expect(recoveryStatus(await onDisk()).state).toBe("none");
    expect(errText()).not.toContain("No recovery code");
  });

  it("a planted empty check-less v2 vault is replaced by a v3 one on the first set", async () => {
    writeFileSync(
      vaultPath(home),
      JSON.stringify({
        version: 2,
        salt: Buffer.alloc(16, 3).toString("base64"),
        kdf: { N: 16384, r: 8, p: 1 },
        entries: {},
      }),
    );
    const r = await runSecrets({ action: "set", name: "GH", value: "v", passphrase: PASS, home, io: noTerminal() }, io);
    expect(r.exitCode).toBe(0);
    const v = await onDisk();
    expect(v.version).toBe(SECRETS_SCHEMA_VERSION);
    expect(await opensWith(PASS)).toBe(true);
    // The run's own output agrees with what it did: no "no other command
    // upgrades the file" notice, and the upgrade line rotate prints instead.
    expect(errText()).not.toContain("is schema v2");
    expect(errText()).not.toContain("No other command upgrades the file");
    expect(errText()).toContain(
      `yaw-mcp secrets: upgraded the vault at ${vaultPath(home)} from schema v2 to v${SECRETS_SCHEMA_VERSION}; restart any running yaw-mcp`,
    );
  });

  it("set --stdin at a terminal creates the vault WITHOUT a code: stdin is spent, so nothing could confirm one", async () => {
    // A TTY stdin whose value read runs to EOF (as `--stdin` does): the
    // confirmation prompts after it would read an ended stream.
    class SpentTTY extends ScriptedTTY {
      readableEnded = false;
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        yield "ghp_piped\n";
        this.readableEnded = true;
      }
    }
    const screen = sink(true);
    const stdin = new SpentTTY([`${PASS}\r`, `${PASS}\r`], () => screen.text());
    const r = await runSecrets(
      {
        action: "set",
        name: "GH",
        fromStdin: true,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout: screen },
        env: {},
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(codesOn(screen.text())).toEqual([]);
    expect(screen.text()).not.toContain(ALT_ON);
    const v = await onDisk();
    expect(recoveryStatus(v).state).toBe("none");
    const key = await unlock(v, PASS);
    expect(getSecret(v, key, "GH")).toBe("ghp_piped");
    key.fill(0);
    expect(errText()).toContain(
      "yaw-mcp secrets: No recovery code was created (no terminal). Run `yaw-mcp secrets recovery new` in a terminal to add one.\n",
    );
  });

  it.each([
    ["SIGINT"],
    ["SIGTERM"],
    ["SIGHUP"],
  ] as const)("a %s during the confirmation leaves the alternate screen before the signal is re-raised", async (signal) => {
    // Node's default handler would kill the process without a `finally`;
    // other listeners are set aside so the re-raise path is the one taken.
    const others = process.listeners(signal);
    for (const l of others) process.removeListener(signal, l);
    const exitBaseline = process.listenerCount("exit");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const t = terminal([
        `${PASS}\r`,
        `${PASS}\r`,
        (screen) => {
          process.emit(signal, signal);
          return (rightGroup as (s: string) => string)(screen);
        },
        rightGroup,
      ]);
      const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: {} }, io);
      expect(r.exitCode).toBe(0);
      const screen = t.screen.text();
      const [code] = codesOn(screen);
      // Left right at the signal: after the code, before the next prompt.
      const off = screen.indexOf(ALT_OFF);
      expect(off).toBeGreaterThan(screen.indexOf(code));
      expect(off).toBeLessThan(screen.lastIndexOf("Type group"));
      expect(kill).toHaveBeenCalledWith(process.pid, signal);
      // Every listener is gone again.
      expect(process.listenerCount(signal)).toBe(0);
      expect(process.listenerCount("exit")).toBe(exitBaseline);
    } finally {
      kill.mockRestore();
      for (const l of others) process.on(signal, l as (...args: unknown[]) => void);
    }
  });
});

// ---------------------------------------------------------------------------
// issueRecoveryCode runs TWO independent counters: `attempt` (wrong groups,
// three allowed) and `empty` (blank answers, five allowed). They are
// asymmetric by design -- an empty answer spends no attempt -- and `empty` is
// never reset, so it bounds a CONTIGUOUS run of blanks, not a total. Neither
// fact is visible in a run that is all empties or all wrongs; these tests mix
// them on the scripted TTY, where every prompt and every answer is countable.
// ---------------------------------------------------------------------------
describe("the recovery confirm counts wrong groups and empty groups separately", () => {
  it("empties interleaved with wrong groups spend no attempts; three wrong answers still end it", async () => {
    // Every attempt's FIRST group is answered with a bare Enter, its second
    // with a wrong one. Under counting that charged attempts for empties, the
    // three attempts would be gone after the first wrong answer -- two wrong
    // groups would still sit in the queue, `pending` would not be 0, and the
    // vault would never be reached at all. As implemented, six answers are
    // consumed (3 blanks + 3 wrongs) and the loop exits on `attempt`.
    const t = terminal([
      `${PASS}\r`,
      `${PASS}\r`,
      "\r",
      wrongGroup,
      "\r",
      wrongGroup,
      "\r",
      wrongGroup,
      rightGroup,
      rightGroup,
    ]);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(1);
    const screen = t.screen.text();
    // One mismatch line per WRONG answer, none per blank.
    expect(occurrences(screen, "That does not match the code above.")).toBe(3);
    // 6 reads, each preceded by its own prompt: a blank re-asks the SAME
    // group, a wrong one ends its attempt. Nothing after the third wrong was
    // touched -- the two right answers queued behind it are still unread,
    // which is what separates "ended on the attempt budget" from "ended
    // because the answers ran out".
    expect(occurrences(screen, "Type group ")).toBe(6);
    expect(t.stdin.pending).toBe(2);
    // The `empty` counter never resets, so the three blanks -- one per
    // attempt, never five in a row -- must NOT reach the empty bound. Ending
    // on the mismatch wording rather than the "5 times in a row" reason is
    // what separates a run length from an accumulator.
    expect(screen).not.toContain("No group was entered");
    expect(errText()).toContain("Aborted -- nothing was saved.");
    expect(existsSync(vaultPath(home))).toBe(false);
    expect(screen.endsWith(ALT_OFF)).toBe(true);
    expectCodeOnlyOnScreen(codesOn(screen));
  });

  it("one wrong group, then a drained stdin: the mismatch line AND the empty-bound reason, no hang", async () => {
    // Exactly one wrong group is queued, then nothing: the next resume finds
    // the queue empty, sets readableEnded, and every later read folds to ""
    // straight away. This is the real shape of "typed it wrong, then the
    // connection dropped", and it terminates only because BOTH counters are
    // bounded -- one attempt spent (the mismatch line the user is owed) and
    // five blanks hit (the reason line, since the mismatch wording never
    // prints for an empty). A loop with only one of the two either hangs on
    // the endless "" or exits having never said why.
    const t = terminal([`${PASS}\r`, `${PASS}\r`, wrongGroup]);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(1);
    const screen = t.screen.text();
    expect(occurrences(screen, "That does not match the code above.")).toBe(1);
    expect(screen).toContain("No group was entered -- the prompt was left empty 5 times in a row.");
    // Finite, and it got to the BOUND's fifth empty prompt -- one prompt for
    // the wrong answer plus five for the blanks (1 + 5, not 1 + 3: empties do
    // not spend attempts, so the attempt budget could not end this run).
    expect(occurrences(screen, "Type group ")).toBe(6);
    expect(t.stdin.pending).toBe(0);
    expect(errText()).toContain("Aborted -- nothing was saved.");
    expect(existsSync(vaultPath(home))).toBe(false);
    expect(screen.endsWith(ALT_OFF)).toBe(true);
  });

  it("the last attempt prints the bare mismatch sentence: three wrongs, counted not contained", async () => {
    const t = terminal([`${PASS}\r`, `${PASS}\r`, wrongGroup, wrongGroup, wrongGroup]);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(1);
    const screen = t.screen.text();
    // Attempts 1 and 2 invite another try; attempt 3 only states the fact.
    expect(occurrences(screen, "That does not match the code above. Check what you wrote down and try again.")).toBe(2);
    // The bare sentence, terminated by its own newline: exactly once, on the
    // last attempt. Counting BOTH variants (2 + 1 = 3) is the only honest
    // assertion -- the bare sentence is a prefix of the retry wording, so
    // `toContain("That does not match the code above.")` passes on the retry
    // wording alone and would say nothing about the final attempt at all.
    expect(occurrences(screen, "That does not match the code above.\n")).toBe(1);
    expect(occurrences(screen, "That does not match the code above.")).toBe(3);
    expect(screen.endsWith(ALT_OFF)).toBe(true);
    expect(errText()).toBe(
      "yaw-mcp secrets set: Aborted -- nothing was saved. Re-run, or pass --no-recovery to create the vault without a recovery code.\n",
    );
    expect(existsSync(vaultPath(home))).toBe(false);
    expectCodeOnlyOnScreen(codesOn(screen));
  });

  it("a full-width group typed at the confirm is accepted (NFKC through the real TTY comparison)", async () => {
    // A CJK IME hands back full-width forms ("０", "Ａ"). The comparison is
    // normalizeRecoveryGroup(answer) !== groups[g], so the fold has to happen
    // on the path a TTY answer actually takes -- not only in parseRecoveryCode
    // -- or a user who typed the RIGHT code correctly is told it does not
    // match. Every symbol of a Crockford group has a full-width form, so the
    // whole first group is mapped (char + 0xFEE0) and nothing else in the run
    // changes.
    const fullwidthGroup: Answer = (screen) => {
      const ascii = (rightGroup as (s: string) => string)(screen);
      const group = ascii.slice(0, -1); // drop the trailing \r
      const wide = [...group].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join("");
      return `${wide}\r`;
    };
    const t = terminal([`${PASS}\r`, `${PASS}\r`, fullwidthGroup, rightGroup]);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(0);
    const screen = t.screen.text();
    // Accepted as the RIGHT group: no mismatch line, and not counted as a
    // blank either (which would have re-prompted the same group and shown the
    // empty-bound reason instead of saving).
    expect(screen).not.toContain("That does not match");
    expect(screen).not.toContain("No group was entered");
    expect(occurrences(screen, "Type group ")).toBe(2);
    expect(t.stdin.pending).toBe(0);
    expect(recoveryStatus(await onDisk()).state).toBe("set");
  });
});

// ---------------------------------------------------------------------------
describe("secrets recover", () => {
  it("happy path: code, new passphrase, a NEW code; every entry kept; old passphrase and old code dead", async () => {
    const oldCode = await seedV3(true);
    const backup = `${vaultPath(home)}.copy`;
    copyFileSync(vaultPath(home), backup);
    // YAW_MCP_VAULT_PASSPHRASE is the LOST passphrase's slot; recover must
    // never take it as the new one.
    process.env.YAW_MCP_VAULT_PASSPHRASE = "the-env-passphrase-never-used";
    const t = terminal([`${oldCode}\r`, `${NEW_PASS}\r`, `${NEW_PASS}\r`, rightGroup, rightGroup]);
    const r = await runSecrets({ action: "recover", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(0);
    const codes = codesOn(t.screen.text());
    expect(codes).toHaveLength(1);
    const newCode = codes[0];
    expect(newCode).not.toBe(oldCode);

    expect(await opensWith(NEW_PASS)).toBe(true);
    expect(await opensWith(PASS)).toBe(false);
    expect(await opensWith("the-env-passphrase-never-used")).toBe(false);
    expect(await codeOpens(oldCode)).toBe(RECOVERY_CODE_WRONG_VAULT_ERROR);
    expect(await codeOpens(newCode)).toBe(true);
    // The old backup still opens only the old file: under the new code it is
    // a different vault.
    expect(await codeOpens(newCode, backup)).toBe(RECOVERY_CODE_WRONG_VAULT_ERROR);
    expect(await opensWith(NEW_PASS, backup)).toBe(false);
    const v = await onDisk();
    const key = await unlock(v, NEW_PASS);
    expect(getSecret(v, key, "GH")).toBe("ghp_one");
    expect(getSecret(v, key, "NPM")).toBe("npm_two");
    key.fill(0);

    expect(outText()).toContain(
      `Recovered the vault at ${vaultPath(home)}: 2 secrets kept, now under the new passphrase and a fresh data key.`,
    );
    // rotate's nudge: the env var in this shell still holds the old value.
    expect(errText()).toContain("re-keyed under a new passphrase");
    expect(errText()).toContain("YAW_MCP_VAULT_PASSPHRASE in THIS shell still holds the OLD passphrase");
    expect(auditKinds()).toEqual(["recovery-used", "vault-rekeyed", "recovery-issued"]);
    expectCodeOnlyOnScreen([oldCode, newCode]);
    // The typed code is read with echo OFF: never written back to the screen.
    expect(t.screen.text()).not.toContain(oldCode);
  });

  it("takes the new passphrase from YAW_MCP_VAULT_PASSPHRASE_NEW, and --json carries no code", async () => {
    const oldCode = await seedV3(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "the-env-passphrase-never-used";
    process.env.YAW_MCP_VAULT_PASSPHRASE_NEW = NEW_PASS;
    const t = terminal([`${oldCode}\r`, rightGroup, rightGroup], true);
    const r = await runSecrets({ action: "recover", home, io: t.io, env: {}, json: true }, io);
    expect(r.exitCode).toBe(0);
    expect(t.stdin.pending).toBe(0);
    expect(await opensWith(NEW_PASS)).toBe(true);
    expect(JSON.parse(outText())).toEqual({
      ok: true,
      recovered: true,
      path: vaultPath(home),
      source: vaultPath(home),
      secret_count: 2,
      recovery: "set",
    });
    expect(errJson().map((l) => l.warning)).toEqual(["vault-recovered"]);
    expectCodeOnlyOnScreen([oldCode, ...codesOn(t.screen.text())]);
  });

  it("a typo gets another try; a code for ANOTHER vault ends it with nothing changed", async () => {
    const code = await seedV3(true);
    const syms = code.split("");
    const i = code.length - 1;
    syms[i] = syms[i] === "0" ? "1" : "0";
    const typo = syms.join("");
    const t = terminal([`${typo}\r`, `${code}\r`, `${NEW_PASS}\r`, `${NEW_PASS}\r`]);
    const r = await runSecrets({ action: "recover", home, io: t.io, env: {}, noRecovery: true }, io);
    expect(r.exitCode).toBe(0);
    expect(t.screen.text()).toContain(`That is a ${RECOVERY_CODE_TYPO_ERROR}. Check it and try again.`);
    expect(recoveryStatus(await onDisk()).state).toBe("none");

    // A well-formed code that belongs to some other vault.
    const other = (await createVaultV3("x", { recovery: true })).recoveryCode as string;
    const before = readFileSync(vaultPath(home), "utf8");
    await seedV3(true);
    const seeded = readFileSync(vaultPath(home), "utf8");
    expect(seeded).not.toBe(before);
    io.err.mockReset();
    const t2 = terminal([`${other}\r`]);
    const r2 = await runSecrets({ action: "recover", home, io: t2.io, env: {} }, io);
    expect(r2.exitCode).toBe(1);
    expect(errText()).toBe(`yaw-mcp secrets recover: ${RECOVERY_CODE_WRONG_VAULT_ERROR}. Nothing was changed.\n`);
    expect(readFileSync(vaultPath(home), "utf8")).toBe(seeded);
  });

  it("refuses off a terminal (exit 2), before reading the vault", async () => {
    // A vault that does not parse: had the vault been read first, this would
    // be the corrupt-vault failure (exit 1), not the terminal refusal.
    writeFileSync(vaultPath(home), "{ not json");
    const r = await runSecrets({ action: "recover", home, io: noTerminal(), env: {} }, io);
    expect(r.exitCode).toBe(2);
    expect(errText()).toBe(
      "yaw-mcp secrets recover: recover needs a terminal: the recovery code is typed at a no-echo prompt, never read from argv or the env (neither stdin nor stdout is a TTY).\n",
    );
  });

  it("refuses a vault with no recovery code -- v3 without a slot, and v2 -- exit 1", async () => {
    await seedV3(false);
    const t = terminal([]);
    const r = await runSecrets({ action: "recover", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toBe(`yaw-mcp secrets recover: ${VAULT_NO_RECOVERY_ERROR}\n`);

    const legacy = newVault();
    const key = await unlock(legacy, PASS);
    await saveVault(vaultPath(home), setSecret(legacy, key, "GH", "v"));
    key.fill(0);
    lock();
    io.err.mockReset();
    const r2 = await runSecrets({ action: "recover", home, io: terminal([]).io, env: {} }, io);
    expect(r2.exitCode).toBe(1);
    expect(errText()).toContain(VAULT_NO_RECOVERY_ERROR);
  });

  it("^C at the code prompt: exit 130, nothing written", async () => {
    await seedV3(true);
    const before = readFileSync(vaultPath(home), "utf8");
    const r = await runSecrets({ action: "recover", home, io: terminal(["\x03"]).io, env: {} }, io);
    expect(r.exitCode).toBe(130);
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it.each([
    ["without --force", false],
    ["with --force too", true],
  ])("--file refuses (exit 2) over an existing vault %s, before any prompt, naming move-aside and reset", async (_l, force) => {
    const code = await seedV3(true);
    const aside = `${vaultPath(home)}.reset-copy`;
    copyFileSync(vaultPath(home), aside);
    // A new (different) vault now sits at the path, as after a reset.
    await seedV3(false, { OTHER: "x" });
    const current = readFileSync(vaultPath(home), "utf8");
    const before = readdirSync(nodePath.dirname(vaultPath(home))).sort();

    const t = terminal([`${code}\r`, `${NEW_PASS}\r`, `${NEW_PASS}\r`]);
    const r = await runSecrets(
      { action: "recover", file: aside, force, home, io: t.io, env: {}, noRecovery: true },
      io,
    );
    expect(r.exitCode).toBe(2);
    expect(errText()).toContain(`a vault already exists at ${vaultPath(home)}`);
    expect(errText()).toContain("Move it aside first");
    expect(errText()).toContain("`yaw-mcp secrets reset`");
    expect(errText()).not.toContain("--force");
    expect(t.stdin.pending).toBe(3);
    expect(readFileSync(vaultPath(home), "utf8")).toBe(current);
    // Nothing moved aside, nothing new next to the vault.
    expect(readdirSync(nodePath.dirname(vaultPath(home))).sort()).toEqual(before);
    expect(await codeOpens(code, aside)).toBe(true);
  });

  it("--file with no vault at the path just writes the recovered one there", async () => {
    const code = await seedV3(true);
    const aside = `${vaultPath(home)}.reset-copy`;
    copyFileSync(vaultPath(home), aside);
    const sourceBefore = readFileSync(aside, "utf8");
    rmSync(vaultPath(home));
    const t = terminal([`${code}\r`, `${NEW_PASS}\r`, `${NEW_PASS}\r`]);
    const r = await runSecrets({ action: "recover", file: aside, home, io: t.io, env: {}, noRecovery: true }, io);
    expect(r.exitCode).toBe(0);
    expect(await opensWith(NEW_PASS)).toBe(true);
    // fromCopy: the source is untouched, so the code just used still opens
    // IT -- the old blanket "no longer opens it" was wrong for this branch.
    expect(outText()).toContain(
      `The source copy at ${aside} is unchanged and still opens under the recovery code you used`,
    );
    expect(outText()).toContain("the recovered vault at");
    expect(outText()).not.toContain("The recovery code you used no longer opens it.");
    // The source itself is byte-identical to before the recover.
    expect(readFileSync(aside, "utf8")).toBe(sourceBefore);
    expect(await codeOpens(code, aside)).toBe(true);
  });

  it("--file fromCopy WITH a code issued: the fresh code is named, and the old code is never declared dead", async () => {
    // The pair of sentences either side of the `fromCopy ?` ternary used to
    // be one blanket claim: "the recovery code you used no longer opens it"
    // also printed on a recover from a copy, where the SOURCE is untouched
    // and still opens under it -- sending whoever holds the copy after a vault
    // that is fine. The `not.toContain` below was the only pin on that side;
    // what the copy run DOES say about its fresh code (issued but never
    // shown to stdout) was not asserted anywhere.
    const code = await seedV3(true);
    const aside = `${vaultPath(home)}.reset-copy`;
    copyFileSync(vaultPath(home), aside);
    const sourceBefore = readFileSync(aside, "utf8");
    rmSync(vaultPath(home));
    const t = terminal([`${code}\r`, `${NEW_PASS}\r`, `${NEW_PASS}\r`, rightGroup, rightGroup]);
    const r = await runSecrets({ action: "recover", file: aside, home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(0);
    const out = outText();
    expect(out).toContain(
      "and a fresh recovery code (shown on the confirmation screen just now -- write it down; that screen has cleared)",
    );
    expect(out).not.toContain("A new recovery code replaced it.");
    expect(out).not.toContain("The recovery code you used no longer opens it.");
    // The confirm DID run: the code was on screen, two groups of it were
    // typed back (the answers the queued `rightGroup`s produce), and the new
    // code -- read off that screen, the way every other test here captures it
    // -- is what opens the recovered vault now.
    const codes = codesOn(t.screen.text());
    expect(codes).toHaveLength(1);
    expect(occurrences(t.screen.text(), "Type group ")).toBe(2);
    expect(await codeOpens(codes[0])).toBe(true);
    expect(await opensWith(NEW_PASS)).toBe(true);
    // The copy itself is byte-identical, and its own code still opens IT.
    expect(readFileSync(aside, "utf8")).toBe(sourceBefore);
    expect(await codeOpens(code, aside)).toBe(true);
    expectCodeOnlyOnScreen([code, ...codes]);
  });

  it("an in-place recover with a code issued says BOTH the old code is dead and a new one replaced it", async () => {
    // Positive pin on the other arm of the ternary: the fromCopy test above
    // carries only `not.toContain` for these two sentences, so a run that
    // dropped them entirely would still be green. Here the vault at the path
    // IS what was recovered, so both halves are true and both must print.
    const oldCode = await seedV3(true);
    const t = terminal([`${oldCode}\r`, `${NEW_PASS}\r`, `${NEW_PASS}\r`, rightGroup, rightGroup]);
    const r = await runSecrets({ action: "recover", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(0);
    const out = outText();
    expect(out).toContain("The recovery code you used no longer opens it.");
    expect(out).toContain("A new recovery code replaced it.");
    expect(out).not.toContain("shown on the confirmation screen just now");
    const codes = codesOn(t.screen.text());
    expect(codes).toHaveLength(1);
    expect(codes[0]).not.toBe(oldCode);
    expect(await codeOpens(oldCode)).toBe(RECOVERY_CODE_WRONG_VAULT_ERROR);
    expect(await codeOpens(codes[0])).toBe(true);
    expect(await opensWith(NEW_PASS)).toBe(true);
    expectCodeOnlyOnScreen([oldCode, ...codes]);
  });

  it.each([
    ["CLAUDECODE"],
    ["AI_AGENT"],
  ])("in an agent session (%s) recover refuses (exit 2) before any prompt, so the vault keeps its code", async (agentVar) => {
    const code = await seedV3(true);
    const before = readFileSync(vaultPath(home), "utf8");
    const t = terminal([`${code}\r`, `${NEW_PASS}\r`, `${NEW_PASS}\r`]);
    const r = await runSecrets({ action: "recover", home, io: t.io, env: { [agentVar]: "1" } }, io);
    expect(r.exitCode).toBe(2);
    expect(errText()).toContain(`an AI agent session (${agentVar} is set) never displays a recovery code`);
    expect(errText()).toContain("--no-recovery");
    expect(t.stdin.pending).toBe(3);
    expect(t.screen.text()).toBe("");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
    expect(await codeOpens(code)).toBe(true);
  });

  it("in an agent session --no-recovery recovers without a new code, and no nudge (it was asked for)", async () => {
    const code = await seedV3(true);
    const t = terminal([`${code}\r`, `${NEW_PASS}\r`, `${NEW_PASS}\r`]);
    const r = await runSecrets({ action: "recover", home, io: t.io, env: { CLAUDECODE: "1" }, noRecovery: true }, io);
    expect(r.exitCode).toBe(0);
    expect(codesOn(t.screen.text())).toEqual([]);
    expect(recoveryStatus(await onDisk()).state).toBe("none");
    expect(await opensWith(NEW_PASS)).toBe(true);
    expect(errText()).not.toContain("No recovery code was created");
  });
});

// ---------------------------------------------------------------------------
describe("secrets recovery new / remove", () => {
  it("new on an emptied check-less legacy vault confirms the passphrase twice: it becomes the vault's", async () => {
    // Nothing in such a vault verifies a passphrase, so whatever is typed
    // becomes the new v3 slot's -- a typo would lock the user out.
    writeFileSync(
      vaultPath(home),
      JSON.stringify({
        version: 2,
        salt: Buffer.alloc(16, 3).toString("base64"),
        kdf: { N: 16384, r: 8, p: 1 },
        entries: {},
      }),
    );
    const t = terminal([`${PASS}\r`, "a-typo\r", `${PASS}\r`, `${PASS}\r`, rightGroup, rightGroup]);
    const r = await runSecrets({ action: "recovery", recoverySub: "new", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(0);
    const screen = t.screen.text();
    expect(screen).toContain("is empty, so it has no passphrase: the one you enter now becomes its passphrase.");
    expect(screen.indexOf("is empty")).toBeLessThan(screen.indexOf("Vault passphrase: "));
    expect(screen).toContain("Confirm passphrase: ");
    expect(screen).toContain("Passphrases did not match.");
    expect(t.stdin.pending).toBe(0);
    expect(await opensWith(PASS)).toBe(true);
    expect(await opensWith("a-typo")).toBe(false);
    expect(recoveryStatus(await onDisk()).state).toBe("set");
  });

  it("new: adds a code to a slot-less vault (fresh data key), and a second new replaces it", async () => {
    await seedV3(false);
    const before = await onDisk();
    const t = terminal([rightGroup, rightGroup]);
    const r = await runSecrets(
      { action: "recovery", recoverySub: "new", passphrase: PASS, home, io: t.io, env: {} },
      io,
    );
    expect(r.exitCode).toBe(0);
    const [first] = codesOn(t.screen.text());
    const after = await onDisk();
    expect(after.vault_id).not.toBe(before.vault_id);
    expect(await codeOpens(first)).toBe(true);
    expect(await opensWith(PASS)).toBe(true);
    expect(outText()).toContain("Any earlier code no longer opens it.");
    expect(auditKinds()).toEqual(["recovery-issued", "vault-rekeyed"]);

    io.out.mockReset();
    const t2 = terminal([rightGroup, rightGroup]);
    const r2 = await runSecrets(
      { action: "recovery", recoverySub: "new", passphrase: PASS, home, io: t2.io, env: {} },
      io,
    );
    expect(r2.exitCode).toBe(0);
    const [second] = codesOn(t2.screen.text());
    expect(await codeOpens(first)).toBe(RECOVERY_CODE_WRONG_VAULT_ERROR);
    expect(await codeOpens(second)).toBe(true);
    expect(outText()).toContain("The previous code no longer opens it.");
    expectCodeOnlyOnScreen([first, second]);
  });

  it("new upgrades a v2 vault to v3 and says to restart a running yaw-mcp", async () => {
    const legacy = newVault();
    const key = await unlock(legacy, PASS);
    await saveVault(vaultPath(home), setSecret(legacy, key, "GH", "ghp_one"));
    key.fill(0);
    lock();
    const t = terminal([rightGroup, rightGroup]);
    const r = await runSecrets(
      { action: "recovery", recoverySub: "new", passphrase: PASS, home, io: t.io, env: {} },
      io,
    );
    expect(r.exitCode).toBe(0);
    const v = await onDisk();
    expect(v.version).toBe(SECRETS_SCHEMA_VERSION);
    expect(recoveryStatus(v).state).toBe("set");
    expect(errText()).toContain(`from schema v2 to v${SECRETS_SCHEMA_VERSION}`);
    expect(errText()).toContain("restart any running yaw-mcp (Yaw Terminal or your MCP client)");
    // It IS the upgrade: no "schema-behind" nag.
    expect(errText()).not.toContain("is schema v2");
  });

  it.each([
    ["off a terminal", noTerminal(), {}],
    ["in an agent session", undefined, { AI_AGENT: "1" }],
  ] as const)("new refuses %s (exit 2) and writes nothing", async (_label, streams, env) => {
    await seedV3(false);
    const before = readFileSync(vaultPath(home), "utf8");
    const r = await runSecrets(
      { action: "recovery", recoverySub: "new", passphrase: PASS, home, io: streams ?? terminal([]).io, env },
      io,
    );
    expect(r.exitCode).toBe(2);
    expect(errText()).toContain("a recovery code has to be shown on a terminal");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("remove: refused off a TTY without --force; with --force the slot is gone and the old code dead", async () => {
    const code = await seedV3(true);
    const before = readFileSync(vaultPath(home), "utf8");
    const refused = await runSecrets(
      { action: "recovery", recoverySub: "remove", passphrase: PASS, home, io: noTerminal(), env: {} },
      io,
    );
    expect(refused.exitCode).toBe(2);
    expect(errText()).toContain("Re-run with --force to remove it.");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);

    io.err.mockReset();
    const r = await runSecrets(
      { action: "recovery", recoverySub: "remove", force: true, passphrase: PASS, home, io: noTerminal(), json: true },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(outText())).toMatchObject({ ok: true, removed: true, secret_count: 2, recovery: "none" });
    expect(recoveryStatus(await onDisk()).state).toBe("none");
    expect(await codeOpens(code)).toBe(VAULT_NO_RECOVERY_ERROR);
    expect(await opensWith(PASS)).toBe(true);
    expect(auditKinds()).toEqual(["recovery-removed", "vault-rekeyed"]);
  });

  it("remove at a terminal asks first; n leaves the vault alone", async () => {
    await seedV3(true);
    const before = readFileSync(vaultPath(home), "utf8");
    const r = await runSecrets(
      { action: "recovery", recoverySub: "remove", passphrase: PASS, home, io: terminal(["n\r"]).io },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Aborted.");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("remove on a vault without a code: exit 1", async () => {
    await seedV3(false);
    const r = await runSecrets(
      { action: "recovery", recoverySub: "remove", force: true, passphrase: PASS, home, io: noTerminal() },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("this vault has no recovery code to remove.");
  });
});

// ---------------------------------------------------------------------------
describe("secrets rotate and the recovery slot", () => {
  it.each([
    ["CLAUDECODE"],
    ["AI_AGENT"],
  ])("a vault WITH a code at a real terminal in an agent session (%s): exit 2, byte-identical, no code shown", async (agentVar) => {
    await seedV3(true);
    const before = readFileSync(vaultPath(home), "utf8");
    const t = terminal([rightGroup, rightGroup]);
    const r = await runSecrets(
      { action: "rotate", passphrase: PASS, newPassphrase: NEW_PASS, home, io: t.io, env: { [agentVar]: "1" } },
      io,
    );
    expect(r.exitCode).toBe(2);
    expect(errText()).toContain(`an AI agent session (${agentVar} is set) never displays a recovery code`);
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
    expect(t.screen.text()).toBe("");
    expect(t.stdin.pending).toBe(2);
  });

  it("a vault WITH a code, off a terminal: exit 2 before any change, naming --no-recovery", async () => {
    await seedV3(true);
    const before = readFileSync(vaultPath(home), "utf8");
    const r = await runSecrets(
      { action: "rotate", passphrase: PASS, newPassphrase: NEW_PASS, home, io: noTerminal(), env: {} },
      io,
    );
    expect(r.exitCode).toBe(2);
    expect(errText()).toContain("this vault has a recovery code, and rotating replaces it");
    expect(errText()).toContain("--no-recovery");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("--no-recovery rotates and DROPS the code, with a warning", async () => {
    const code = await seedV3(true);
    const r = await runSecrets(
      {
        action: "rotate",
        passphrase: PASS,
        newPassphrase: NEW_PASS,
        home,
        io: noTerminal(),
        noRecovery: true,
        json: true,
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(outText())).toEqual({ ok: true, rotated: true, secret_count: 2, recovery: "none" });
    expect(errJson().map((l) => l.warning)).toEqual(["vault-rotated", "recovery-dropped"]);
    expect(await codeOpens(code)).toBe(VAULT_NO_RECOVERY_ERROR);
    expect(await opensWith(NEW_PASS)).toBe(true);
    expect(auditKinds()).toEqual(["vault-rekeyed", "recovery-removed"]);
  });

  it("at a terminal a NEW code replaces the old one; the old code and old passphrase are dead", async () => {
    const oldCode = await seedV3(true);
    const t = terminal([rightGroup, rightGroup]);
    const r = await runSecrets(
      { action: "rotate", passphrase: PASS, newPassphrase: NEW_PASS, home, io: t.io, env: {} },
      io,
    );
    expect(r.exitCode).toBe(0);
    const [newCode] = codesOn(t.screen.text());
    expect(await codeOpens(oldCode)).toBe(RECOVERY_CODE_WRONG_VAULT_ERROR);
    expect(await codeOpens(newCode)).toBe(true);
    expect(await opensWith(PASS)).toBe(false);
    expect(outText()).toContain("A new recovery code replaced the old one");
    expectCodeOnlyOnScreen([oldCode, newCode]);
  });

  it("an exhausted confirmation leaves the vault byte-identical", async () => {
    await seedV3(true);
    const before = readFileSync(vaultPath(home), "utf8");
    const t = terminal([wrongGroup, wrongGroup, wrongGroup]);
    const r = await runSecrets(
      { action: "rotate", passphrase: PASS, newPassphrase: NEW_PASS, home, io: t.io, env: {} },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Aborted -- nothing was saved.");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("a vault without a code rotates off a terminal as before", async () => {
    await seedV3(false);
    const r = await runSecrets(
      { action: "rotate", passphrase: PASS, newPassphrase: NEW_PASS, home, io: noTerminal(), env: {} },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(recoveryStatus(await onDisk()).state).toBe("none");
  });
});

// ---------------------------------------------------------------------------
describe("reset and the wrong-passphrase hint point at recover when there is a code", () => {
  it("reset --force on a vault with a code: the pointer, then the moved-aside line names recover --file", async () => {
    await seedV3(true);
    const created = recoveryStatus(await onDisk()).created as string;
    const r = await runSecrets(
      { action: "reset", force: true, passphrase: NEW_PASS, home, io: noTerminal(), env: {} },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(errText()).toContain(
      `yaw-mcp secrets reset: this vault has a recovery code (created ${created.slice(0, 10)}): \`yaw-mcp secrets recover\` keeps all 2 entries.\n`,
    );
    const aside = readdirSync(nodePath.dirname(vaultPath(home))).find((f) => f.includes(".reset-")) as string;
    expect(outText()).toContain(
      `Its recovery code still opens that copy: move the new (empty) vault at ${vaultPath(home)} aside, then \`yaw-mcp secrets recover --file ${nodePath.join(nodePath.dirname(vaultPath(home)), aside)}\` brings it back with every entry.\n`,
    );
    expect(outText()).not.toContain("--force");
  });

  it("reset --json: the pointer is a recovery-available warning line", async () => {
    await seedV3(true);
    const r = await runSecrets(
      { action: "reset", force: true, passphrase: NEW_PASS, home, io: noTerminal(), json: true },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(errJson()[0]).toMatchObject({ warning: "recovery-available", entries: 2 });
  });

  it("reset at a terminal issues the new vault's code, and a vault without one gets no pointer", async () => {
    await seedV3(false);
    const t = terminal(["RESET\r", `${NEW_PASS}\r`, `${NEW_PASS}\r`, rightGroup, rightGroup]);
    const r = await runSecrets({ action: "reset", home, io: t.io, env: {} }, io);
    expect(r.exitCode).toBe(0);
    expect(errText()).not.toContain("this vault has a recovery code");
    const [code] = codesOn(t.screen.text());
    expect(await codeOpens(code)).toBe(true);
    expect(await opensWith(NEW_PASS)).toBe(true);
    expectCodeOnlyOnScreen([code]);
  });

  it("reset with a damaged passphrase slot goes ahead, but says the passphrase could not be checked", async () => {
    await seedV3(true);
    const raw = JSON.parse(readFileSync(vaultPath(home), "utf8"));
    raw.keyslots.passphrase.digest = Buffer.alloc(32, 9).toString("base64");
    writeFileSync(vaultPath(home), JSON.stringify(raw));
    const r = await runSecrets({ action: "reset", force: true, passphrase: PASS, home, io: noTerminal(), env: {} }, io);
    expect(r.exitCode).toBe(0);
    expect(errText()).toContain("passphrase slot of the vault at");
    expect(errText()).toContain("could not be checked against it; it has a recovery code: `yaw-mcp secrets recover`");
  });

  it("a wrong passphrase names recover only when the vault has a code", async () => {
    await seedV3(true);
    const r = await runSecrets({ action: "list", home }, io);
    expect(r.exitCode).toBe(0);
    io.err.mockReset();
    const withCode = await runSecrets({ action: "get", name: "GH", passphrase: "wrong-passphrase-xyz", home }, io);
    expect(withCode.exitCode).toBe(1);
    expect(errText()).toContain("`yaw-mcp secrets recover` sets a new one with the vault's recovery code");

    await seedV3(false);
    io.err.mockReset();
    lock();
    const without = await runSecrets({ action: "get", name: "GH", passphrase: "wrong-passphrase-xyz", home }, io);
    expect(without.exitCode).toBe(1);
    expect(errText()).not.toContain("secrets recover");
    expect(errText()).toContain("`yaw-mcp secrets reset` moves this vault aside");
  });
});

// ---------------------------------------------------------------------------
describe("secrets audit renders vault events", () => {
  it("shows a vault-level event with no server or secret", async () => {
    await seedV3(false);
    await runSecrets(
      {
        action: "recovery",
        recoverySub: "new",
        passphrase: PASS,
        home,
        io: terminal([rightGroup, rightGroup]).io,
        env: {},
      },
      io,
    );
    io.out.mockReset();
    const r = await runSecrets({ action: "audit", home }, io);
    expect(r.exitCode).toBe(0);
    expect(outText()).toMatch(/ {2}recovery-issued {2}\(vault\)\n/);
    expect(outText()).toMatch(/ {2}vault-rekeyed {2}\(vault\)\n/);
  });
});

// ---------------------------------------------------------------------------
describe("an argument refusal never echoes a recovery code", () => {
  const code = formatRecoveryCode(generateRecoverySecret());
  const groups = recoveryCodeGroups(code);
  const bare = groups.join("").toLowerCase();
  const typo = `${code.slice(0, -1)}${code.endsWith("0") ? "1" : "0"}`;
  const cases: string[][] = [
    ["recover", code],
    ["recover", "YAWR", ...groups],
    ["recover", ...groups],
    ["recover", "--file", "x.json", code],
    ["recovery", "new", code],
    ["recovery", "remove", "--force", code],
    ["recovery", code],
    [code],
    ["get", code],
    ["get", bare],
    ["get", typo],
    ["remove", code, "--force"],
    ["set", code, "--value", "v"],
    ["set", `YAWR ${groups.join(" ")}`],
    ["get", "GH", code],
    ["list", code],
    ["audit", code],
    ["lock", typo],
    ["get", "--", code],
  ];
  it.each(cases.flatMap((argv) => [[argv], [[...argv, "--json"]]]))("%j", (argv) => {
    const r = parseSecretsArgs(argv);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const shown = [r.error.replace(SECRETS_USAGE, ""), r.jsonError ?? ""].join("\n").toUpperCase();
    for (const g of groups) expect(shown).not.toContain(g);
  });

  it("names the shell-history risk when it held a code back, and still echoes an ordinary token", () => {
    const r = parseSecretsArgs(["recover", code, "--json"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.jsonError).toBe(
        "recover takes no <name> or other argument -- the recovery code is typed at a no-echo prompt, never passed on the command line. A recovery code is never passed on the command line -- `yaw-mcp secrets recover` asks for it at a no-echo prompt -- and one typed there is now in your shell history",
      );
    }
    const plain = parseSecretsArgs(["get", "GH", "OTHER"]);
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.error).toContain('unexpected positional argument "OTHER"');
    // A real secret name that merely starts with the prefix still parses.
    expect(parseSecretsArgs(["set", "YAWR_TOKEN"])).toMatchObject({ ok: true, options: { name: "YAWR_TOKEN" } });
  });
});
