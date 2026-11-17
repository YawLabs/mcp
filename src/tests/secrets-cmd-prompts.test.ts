// The interactive edges of `yaw-mcp secrets`: what the user is told when the
// prompt budget runs out at a terminal, where prompt text goes under --json,
// the `--` end-of-options marker, and reset's early refusal of an empty
// passphrase hook.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSecretsArgs, runSecrets, SECRETS_USAGE } from "../secrets-cmd.js";
import { lock, vaultPath } from "../secrets-vault.js";

/** A TTY stdin that hands out one queued chunk per resume(), the shape the
 *  raw-mode reader drives (same contract as the fake in secrets-cmd.test.ts). */
class FakeTTYStdin {
  isTTY = true;
  isRaw = false;
  resumes = 0;
  private listener: ((chunk: string) => void) | null = null;
  private queue: string[];
  setRawMode = (v: boolean): this => {
    this.isRaw = v;
    return this;
  };
  constructor(chunks: string[]) {
    this.queue = [...chunks];
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
    this.resumes++;
    const next = this.queue.shift();
    if (next !== undefined) queueMicrotask(() => this.listener?.(next));
    return this;
  }
  pause(): this {
    return this;
  }
  unshift(chunk: string): void {
    this.queue.unshift(chunk);
  }
}

type Sink = NodeJS.WritableStream & { isTTY: boolean; text: () => string; write: ReturnType<typeof vi.fn> };
function sink(isTTY: boolean): Sink {
  const write = vi.fn();
  return {
    isTTY,
    write,
    text: () => write.mock.calls.map((c) => String(c[0])).join(""),
  } as unknown as Sink;
}

const PASS = "a-long-enough-passphrase";
const io = { out: vi.fn(), err: vi.fn() };
const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");
let home: string;
let savedEnv: string | undefined;
let savedNew: string | undefined;
let savedMsys: string | undefined;

beforeEach(async () => {
  io.out.mockReset();
  io.err.mockReset();
  lock();
  savedEnv = process.env.YAW_MCP_VAULT_PASSPHRASE;
  savedNew = process.env.YAW_MCP_VAULT_PASSPHRASE_NEW;
  savedMsys = process.env.MSYSTEM;
  delete process.env.YAW_MCP_VAULT_PASSPHRASE;
  delete process.env.YAW_MCP_VAULT_PASSPHRASE_NEW;
  delete process.env.MSYSTEM;
  home = mkdtempSync(nodePath.join(os.tmpdir(), "yaw-mcp-cmd-prompts-"));
  await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  // `set` looks for a project bundles.json from process.cwd(); keep it inside
  // the throwaway HOME, never the repo or the real ~/.yaw-mcp.
  vi.spyOn(process, "cwd").mockImplementation(() => home);
});

afterEach(() => {
  vi.mocked(process.cwd).mockRestore();
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of [
    ["YAW_MCP_VAULT_PASSPHRASE", savedEnv],
    ["YAW_MCP_VAULT_PASSPHRASE_NEW", savedNew],
    ["MSYSTEM", savedMsys],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  lock();
});

async function seedVault(): Promise<void> {
  const r = await runSecrets({ action: "set", name: "GH", value: "ghp_abc", passphrase: PASS, home }, io);
  expect(r.exitCode).toBe(0);
  lock();
  io.out.mockReset();
  io.err.mockReset();
}

function ttyIo(stdin: FakeTTYStdin, stderr?: Sink): { stdin: NodeJS.ReadableStream; stdout: Sink; stderr?: Sink } {
  return { stdin: stdin as unknown as NodeJS.ReadableStream, stdout: sink(true), ...(stderr ? { stderr } : {}) };
}

// ---------------------------------------------------------------------------
// 1. A TTY user who used up the prompt budget is not told to "run from a TTY".
// ---------------------------------------------------------------------------
describe("an exhausted prompt at a terminal says what happened", () => {
  it("set on a fresh vault: three empty entries -> no passphrase was set, no TTY advice", async () => {
    const stdin = new FakeTTYStdin(["\r", "\r", "\r"]);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", home, io: ttyIo(stdin) }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Passphrase required. No passphrase was set after 3 attempts");
    expect(errText()).toContain("did not match");
    expect(errText()).not.toContain("run from a TTY");
    expect(existsSync(vaultPath(home))).toBe(false);
  });

  it("set on an existing vault: three empty unlock entries -> no passphrase was entered", async () => {
    await seedVault();
    const stdin = new FakeTTYStdin(["\r", "\r", "\r"]);
    const r = await runSecrets({ action: "set", name: "X", value: "v", home, io: ttyIo(stdin) }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("No passphrase was entered after 3 attempts.");
    expect(errText()).toContain("Run the command again, or set YAW_MCP_VAULT_PASSPHRASE.");
    expect(errText()).not.toContain("run from a TTY");
  });

  it("rotate's current passphrase: three empty entries", async () => {
    await seedVault();
    const stdin = new FakeTTYStdin(["\r", "\r", "\r"]);
    const r = await runSecrets({ action: "rotate", home, io: ttyIo(stdin) }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Current passphrase required. No passphrase was entered after 3 attempts.");
    expect(errText()).not.toContain("run from a TTY");
  });

  it("rotate's new passphrase: three mismatched pairs name YAW_MCP_VAULT_PASSPHRASE_NEW, no TTY advice", async () => {
    await seedVault();
    const before = readFileSync(vaultPath(home), "utf8");
    process.env.YAW_MCP_VAULT_PASSPHRASE = PASS;
    const stdin = new FakeTTYStdin([
      "one-pass\r",
      "two-pass\r",
      "one-pass\r",
      "two-pass\r",
      "one-pass\r",
      "two-pass\r",
    ]);
    const r = await runSecrets({ action: "rotate", home, io: ttyIo(stdin) }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("New passphrase required (and must be confirmed). No passphrase was set after 3");
    expect(errText()).toContain("or set YAW_MCP_VAULT_PASSPHRASE_NEW.");
    expect(errText()).not.toContain("run from a TTY");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("reset --force: three mismatched pairs -> did not match, vault untouched", async () => {
    await seedVault();
    const before = readFileSync(vaultPath(home), "utf8");
    const stdin = new FakeTTYStdin(["aaaa\r", "bbbb\r", "aaaa\r", "bbbb\r", "aaaa\r", "bbbb\r"]);
    const r = await runSecrets({ action: "reset", force: true, home, io: ttyIo(stdin) }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("No passphrase was set after 3 attempts");
    expect(errText()).not.toContain("run from a TTY");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("an embedder's empty passphrase hook is named as such, not as a missing TTY or used-up prompt", async () => {
    await seedVault();
    const r = await runSecrets(
      { action: "set", name: "X", value: "v", passphrase: "", home, io: ttyIo(new FakeTTYStdin([])) },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("The passphrase supplied by the caller is empty.");
    expect(errText()).not.toContain("attempts");
    expect(errText()).not.toContain("run from a TTY");
  });

  it("rotate with an empty newPassphrase hook says the same", async () => {
    await seedVault();
    const r = await runSecrets({ action: "rotate", passphrase: PASS, newPassphrase: "", home }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain(
      "New passphrase required (and must be confirmed). The passphrase supplied by the caller is empty.",
    );
  });

  it("off a TTY the advice is unchanged", async () => {
    await seedVault();
    const r = await runSecrets(
      {
        action: "set",
        name: "X",
        value: "v",
        home,
        io: { stdin: { isTTY: false } as unknown as NodeJS.ReadableStream, stdout: sink(false) },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain(
      "Set YAW_MCP_VAULT_PASSPHRASE or run from a TTY so we can prompt (neither stdin nor stdout is a TTY).",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Under --json, prompt text goes to stderr; stdout is the envelope only.
// ---------------------------------------------------------------------------
describe("--json at a terminal: prompts on stderr, stdout only the envelope", () => {
  /** Every line on the `err` callback is still a JSON object: prompt text
   *  goes to the stderr STREAM, never through `err`. */
  const errIsJson = (): void => {
    for (const line of errText()
      .split("\n")
      .filter((l) => l.length > 0))
      expect(() => JSON.parse(line)).not.toThrow();
  };

  it("set on a fresh vault: the prompts and the mismatch line land on stderr", async () => {
    const stderr = sink(true);
    const tty = ttyIo(new FakeTTYStdin(["one-pass-xxxxx\r", "two-pass-xxxxx\r", `${PASS}\r`, `${PASS}\r`]), stderr);
    const r = await runSecrets({ action: "set", name: "GH", value: "v", json: true, home, io: tty }, io);
    expect(r.exitCode).toBe(0);
    expect(stderr.text()).toContain("Vault passphrase: ");
    expect(stderr.text()).toContain("Passphrases did not match. Try again.");
    expect(tty.stdout.write).not.toHaveBeenCalled();
    const out = io.out.mock.calls.map((c) => c[0] as string).join("");
    expect(JSON.parse(out.trim())).toHaveProperty("ok", true);
    errIsJson();
  });

  it("the unlock prompt's 'cannot be empty' line lands on stderr", async () => {
    await seedVault();
    const stderr = sink(true);
    const tty = ttyIo(new FakeTTYStdin(["\r", `${PASS}\r`]), stderr);
    const r = await runSecrets({ action: "get", name: "GH", json: true, home, io: tty }, io);
    expect(r.exitCode).toBe(0);
    expect(stderr.text()).toContain("Passphrase cannot be empty.");
    expect(tty.stdout.write).not.toHaveBeenCalled();
    errIsJson();
  });

  it("the value prompt and its 'cannot be empty' line land on stderr", async () => {
    await seedVault();
    const stderr = sink(true);
    const tty = ttyIo(new FakeTTYStdin(["\r", "ghp_new\r"]), stderr);
    const r = await runSecrets({ action: "set", name: "X", json: true, passphrase: PASS, home, io: tty }, io);
    expect(r.exitCode).toBe(0);
    expect(stderr.text()).toContain("Secret value: ");
    expect(stderr.text()).toContain("Secret value cannot be empty.");
    expect(tty.stdout.write).not.toHaveBeenCalled();
  });

  it("remove's y/N question lands on stderr", async () => {
    await seedVault();
    const stderr = sink(true);
    const tty = ttyIo(new FakeTTYStdin(["n\r"]), stderr);
    const r = await runSecrets({ action: "remove", name: "GH", json: true, home, io: tty }, io);
    expect(r.exitCode).toBe(1);
    expect(stderr.text()).toContain("Permanently delete secret");
    expect(tty.stdout.write).not.toHaveBeenCalled();
    errIsJson();
  });

  it("reset's preamble and RESET prompt land on stderr", async () => {
    await seedVault();
    const stderr = sink(true);
    const tty = ttyIo(new FakeTTYStdin(["nope\r"]), stderr);
    const r = await runSecrets({ action: "reset", json: true, home, io: tty }, io);
    expect(r.exitCode).toBe(1);
    expect(stderr.text()).toContain("Type RESET to continue: ");
    expect(stderr.text()).toContain("GH");
    expect(tty.stdout.write).not.toHaveBeenCalled();
    errIsJson();
  });

  it("a stderr that is not a terminal makes the run non-interactive, and the refusal names stderr", async () => {
    await seedVault();
    const tty = ttyIo(new FakeTTYStdin(["y\r"]), sink(false));
    const r = await runSecrets({ action: "remove", name: "GH", json: true, home, io: tty }, io);
    expect(r.exitCode).toBe(2);
    expect(errText()).toContain("stderr is not a TTY");
    expect(tty.stdout.write).not.toHaveBeenCalled();
  });

  it("the value prompt is refused, naming stderr, when only stderr is redirected", async () => {
    await seedVault();
    const tty = ttyIo(new FakeTTYStdin(["ghp\r"]), sink(false));
    const r = await runSecrets({ action: "set", name: "X", json: true, passphrase: PASS, home, io: tty }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("stdin is a TTY but stderr is not a TTY");
  });

  /** stdin and stderr at the terminal, stdout redirected to a file: the
   *  `secrets get GH --json > out.json` shape the stderr routing exists for. */
  function redirectedStdoutIo(stdin: FakeTTYStdin, stderr: Sink) {
    return { stdin: stdin as unknown as NodeJS.ReadableStream, stdout: sink(false), stderr };
  }

  it("get --json > out.json still prompts for the passphrase on stderr", async () => {
    await seedVault();
    const stderr = sink(true);
    const tty = redirectedStdoutIo(new FakeTTYStdin([`${PASS}\r`]), stderr);
    const r = await runSecrets({ action: "get", name: "GH", json: true, home, io: tty }, io);
    expect(r.exitCode).toBe(0);
    expect(stderr.text()).toContain("Vault passphrase: ");
    expect(errText()).not.toContain("run from a TTY");
    expect(tty.stdout.write).not.toHaveBeenCalled();
    const out = io.out.mock.calls.map((c) => c[0] as string).join("");
    expect(JSON.parse(out.trim())).toMatchObject({ ok: true, name: "GH", value: "ghp_abc" });
  });

  it("set --json > out.json still prompts for the value on stderr", async () => {
    await seedVault();
    const stderr = sink(true);
    const tty = redirectedStdoutIo(new FakeTTYStdin(["ghp_new\r"]), stderr);
    const r = await runSecrets({ action: "set", name: "X", json: true, passphrase: PASS, home, io: tty }, io);
    expect(r.exitCode).toBe(0);
    expect(stderr.text()).toContain("Secret value: ");
    expect(tty.stdout.write).not.toHaveBeenCalled();
  });

  it("remove --json > out.json still asks its y/N question on stderr", async () => {
    await seedVault();
    const stderr = sink(true);
    const tty = redirectedStdoutIo(new FakeTTYStdin(["n\r"]), stderr);
    const r = await runSecrets({ action: "remove", name: "GH", json: true, home, io: tty }, io);
    expect(r.exitCode).toBe(1);
    expect(stderr.text()).toContain("Permanently delete secret");
    expect(errText()).not.toContain("not a TTY");
  });

  it("the passphrase refusal names the redirected stderr, not just 'run from a TTY'", async () => {
    await seedVault();
    const tty = ttyIo(new FakeTTYStdin([]), sink(false));
    const r = await runSecrets({ action: "get", name: "GH", json: true, home, io: tty }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("so we can prompt (stderr is not a TTY (--json writes the prompts there))");
  });

  it("the passphrase refusal without --json names a redirected stdout", async () => {
    await seedVault();
    const tty = { stdin: new FakeTTYStdin([]) as unknown as NodeJS.ReadableStream, stdout: sink(false) };
    const r = await runSecrets({ action: "get", name: "GH", home, io: tty }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("so we can prompt (stdout is not a TTY)");
  });

  it("without --json the prompts stay on stdout and stderr is ignored", async () => {
    await seedVault();
    const stderr = sink(false);
    const tty = ttyIo(new FakeTTYStdin(["n\r"]), stderr);
    const r = await runSecrets({ action: "remove", name: "GH", home, io: tty }, io);
    expect(r.exitCode).toBe(1);
    expect(String(tty.stdout.write.mock.calls[0]?.[0])).toContain("Permanently delete secret");
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it("the usage text says where the prompts go under --json", () => {
    expect(SECRETS_USAGE).toMatch(/interactive prompts[\s\S]*go to stderr instead/);
  });
});

// ---------------------------------------------------------------------------
// 3. `--` ends the options, so a dash-leading name can be addressed.
// ---------------------------------------------------------------------------
describe("parseSecretsArgs -- the `--` end-of-options marker", () => {
  it("get -- -name takes -name as the name", () => {
    const r = parseSecretsArgs(["get", "--", "-name"]);
    expect(r.ok && r.options).toMatchObject({ action: "get", name: "-name" });
  });

  it("flags before `--` still apply; after it they are positionals", () => {
    const r = parseSecretsArgs(["--json", "remove", "--force", "--", "--json"]);
    expect(r.ok && r.options).toMatchObject({ action: "remove", name: "--json", json: true, force: true });
  });

  it("a --json after `--` does not switch the error rendering to JSON", () => {
    const r = parseSecretsArgs(["get", "--", "-a", "--json"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('unexpected positional argument "--json"');
      expect(r.jsonError).toBeUndefined();
    }
  });

  it("the action itself may follow `--`, and a second `--` is a positional", () => {
    const r = parseSecretsArgs(["--", "set", "--"]);
    expect(r.ok && r.options).toMatchObject({ action: "set", name: "--" });
  });

  it("set -- -bad name is still validated against SECRET_NAME_RE", () => {
    const r = parseSecretsArgs(["set", "--", "-has space"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('invalid secret name "-has space"');
  });

  it("a dash-leading token where a name is expected gets the `--` hint", () => {
    const r = parseSecretsArgs(["get", "-name"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown flag "-name" -- for a name that starts with "-", put `--` before it');
  });

  it("no hint where no name is expected", () => {
    for (const argv of [
      ["list", "--bogus"],
      ["set", "X", "--bogus"],
    ]) {
      const r = parseSecretsArgs(argv);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toContain("put `--`");
    }
  });

  it("set / get / remove of a dash-leading name round-trips end to end", async () => {
    const parsed = (argv: string[]) => {
      const r = parseSecretsArgs(argv);
      if (!r.ok) throw new Error(r.error);
      return { ...r.options, home, passphrase: PASS };
    };
    expect((await runSecrets(parsed(["set", "--value", "v1", "--", "-dash"]), io)).exitCode).toBe(0);
    io.out.mockReset();
    expect((await runSecrets(parsed(["get", "--", "-dash"]), io)).exitCode).toBe(0);
    expect(io.out.mock.calls.map((c) => c[0]).join("")).toBe("v1\n");
    expect((await runSecrets(parsed(["remove", "--force", "--", "-dash"]), io)).exitCode).toBe(0);
  });

  it("the usage text documents `--`", () => {
    expect(SECRETS_USAGE).toMatch(/^ {2}-- {2,}End of options/m);
  });
});

// ---------------------------------------------------------------------------
// 4. reset refuses an empty passphrase hook before asking for RESET.
// ---------------------------------------------------------------------------
describe("reset with passphrase: ''", () => {
  it("is refused before the RESET confirmation, even with the env var set", async () => {
    await seedVault();
    const before = readFileSync(vaultPath(home), "utf8");
    process.env.YAW_MCP_VAULT_PASSPHRASE = "some-other-passphrase";
    const stdin = new FakeTTYStdin(["RESET\r"]);
    const tty = ttyIo(stdin);
    const r = await runSecrets({ action: "reset", passphrase: "", home, io: tty }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("New passphrase required. The passphrase supplied by the caller is empty.");
    // Nothing was asked: no preamble, no prompt, the RESET answer unread.
    expect(tty.stdout.write).not.toHaveBeenCalled();
    expect(stdin.resumes).toBe(0);
    expect(stdin.pending).toBe(1);
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("under --force and --json too, as one envelope", async () => {
    await seedVault();
    const r = await runSecrets({ action: "reset", passphrase: "", force: true, json: true, home }, io);
    expect(r.exitCode).toBe(1);
    const lines = errText()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(JSON.parse(lines[lines.length - 1] as string)).toMatchObject({ ok: false });
    expect(errText()).toContain("supplied by the caller is empty");
  });
});

// ---------------------------------------------------------------------------
// 5 and 6: source shape.
// ---------------------------------------------------------------------------
describe("secrets-cmd.ts source shape", () => {
  const src = readFileSync(
    nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "secrets-cmd.ts"),
    "utf8",
  );

  it("spells the opts.io-else-process stream fallback in exactly one place", () => {
    expect(src.match(/opts\.io\?\.stdin \?\? process\.stdin/g)?.length).toBe(1);
    expect(src.match(/opts\.io\?\.stdout \?\? process\.stdout/g)?.length).toBe(1);
    expect(src.match(/(?<!opts\.)\bio\?\.std(in|out) \?\? process/g)).toBeNull();
  });

  it("the header comment describes reset's confirmation gate alongside remove and set", () => {
    const header = src.slice(0, src.indexOf("import "));
    expect(header).toMatch(/flag to re-run with \(remove, and reset/);
  });
});
