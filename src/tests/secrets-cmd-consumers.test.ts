// `yaw-mcp secrets set` -- naming the servers that consume the secret.
//
// A replace changes the vault on disk, but a yaw-mcp that is already running
// spawned its upstream children with the OLD value in their env and keeps it
// until they restart; the CLI cannot reach that process. Nothing used to say
// so (a Lemon Squeezy server kept failing auth until it was unloaded by hand),
// so `set` now reads bundles.json after the save and names who references the
// name, and what to do about the ones a running yaw-mcp already started.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSecrets } from "../secrets-cmd.js";
import { lock } from "../secrets-vault.js";

const PASS = "a-long-enough-passphrase";
const VALUE = "ls_live_value_123";
const NEW_VALUE = "ls_live_value_456";

describe("runSecrets set -- servers that reference the name", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;
  let cwd: string;

  const outText = (): string => io.out.mock.calls.map((c) => c[0] as string).join("");
  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");
  const bundlesPath = (): string => nodePath.join(home, ".yaw-mcp", "bundles.json");

  function writeBundles(content: unknown): void {
    mkdirSync(nodePath.join(home, ".yaw-mcp"), { recursive: true });
    writeFileSync(bundlesPath(), typeof content === "string" ? content : JSON.stringify(content));
  }

  /** Four shapes: a local env ref, a remote HEADER ref (both count), a remote
   *  whose ref sits in `env` (never sent -- must not count), and a server
   *  referencing a different name. */
  function writeMixedBundles(): void {
    writeBundles({
      version: 1,
      servers: [
        { namespace: "lemonsqueezy", name: "LS", command: "npx", args: ["x"], env: { LS_KEY: "${secret:LS}" } },
        {
          namespace: "billing",
          name: "Billing",
          type: "remote",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer ${secret:LS}" },
        },
        {
          namespace: "ignored-remote",
          name: "Ignored",
          type: "remote",
          url: "https://example.test/other",
          env: { LS_KEY: "${secret:LS}" },
        },
        { namespace: "github", name: "GH", command: "npx", args: ["y"], env: { GH: "${secret:GH}" } },
      ],
    });
  }

  async function seed(name = "LS"): Promise<void> {
    const r = await runSecrets({ action: "set", name, value: VALUE, passphrase: PASS, home, cwd }, io);
    expect(r.exitCode).toBe(0);
    lock();
    io.out.mockReset();
    io.err.mockReset();
  }

  async function set(name: string, json = false): Promise<number> {
    const r = await runSecrets(
      { action: "set", name, value: NEW_VALUE, passphrase: PASS, force: true, home, cwd, json },
      io,
    );
    return r.exitCode;
  }

  beforeEach(() => {
    io.out.mockReset();
    io.err.mockReset();
    home = mkdtempSync(nodePath.join(os.tmpdir(), "yaw-mcp-consumers-"));
    // cwd UNDER the fake home: the project walk stops just before $HOME, so
    // it can never climb out of the temp dir into the developer's real home
    // (a tmpdir sits under it on win32) and read a real bundles.json there.
    cwd = nodePath.join(home, "proj");
    mkdirSync(cwd);
  });

  afterEach(() => {
    lock();
    rmSync(home, { recursive: true, force: true });
  });

  it("a replace names the referencing servers and the restart, on stderr", async () => {
    await seed();
    writeMixedBundles();
    expect(await set("LS")).toBe(0);
    // stdout keeps the scripted signal exactly.
    expect(outText()).toBe('Replaced secret "LS".\n');
    const err = errText();
    expect(err).toContain("${secret:LS} is referenced by: billing, lemonsqueezy");
    expect(err).toContain(bundlesPath());
    expect(err).not.toContain("ignored-remote");
    expect(err).not.toContain("github");
    expect(err).toContain("OLD value");
    expect(err).toContain("mcp_connect_deactivate");
    expect(err).toContain("reconnect yaw-mcp");
    expect(err + outText()).not.toContain(VALUE);
    expect(err + outText()).not.toContain(NEW_VALUE);
  });

  // io.err only: the bundles loader logs through the process logger, which
  // this does not capture.
  it("--json puts the namespaces in the envelope and writes no notice to io.err", async () => {
    await seed();
    writeMixedBundles();
    expect(await set("LS", true)).toBe(0);
    expect(JSON.parse(outText())).toEqual({
      ok: true,
      name: "LS",
      fresh_vault: false,
      replaced: true,
      referenced_by: ["billing", "lemonsqueezy"],
      bundles_path: bundlesPath(),
      running_servers_stale: true,
    });
    expect(errText()).toBe("");
  });

  it("a first store names who picks it up, and the restart for a child started before a remove", async () => {
    await seed("OTHER");
    writeMixedBundles();
    expect(await set("LS")).toBe(0);
    expect(outText()).toBe('Stored secret "LS".\n');
    const err = errText();
    expect(err).toContain("referenced by: billing, lemonsqueezy");
    expect(err).toContain("next time they start");
    // remove-then-set is a first store too, and a child started before the
    // remove still holds the old value.
    expect(err).toContain("before an earlier `secrets remove`");
    expect(err).toContain("mcp_connect_deactivate");
    expect(err).not.toContain("OLD value");

    io.out.mockReset();
    lock();
    // The rotate-by-hand shape under --json: remove, then a first store.
    // A child spawned before the remove holds the old value, so the
    // envelope must not tell a wrapper to skip the reconnect.
    expect(await runSecrets({ action: "remove", name: "LS", passphrase: PASS, force: true, home, cwd }, io)).toEqual({
      exitCode: 0,
    });
    io.out.mockReset();
    lock();
    expect(await set("LS", true)).toBe(0);
    expect(JSON.parse(outText())).toMatchObject({
      replaced: false,
      referenced_by: ["billing", "lemonsqueezy"],
      running_servers_stale: true,
    });
  });

  it("a replace nothing references says so and shows the wiring command", async () => {
    await seed();
    writeBundles({ version: 1, servers: [{ namespace: "github", name: "GH", command: "npx", args: ["y"] }] });
    expect(await set("LS")).toBe(0);
    const err = errText();
    expect(err).toContain(`no server in ${bundlesPath()} references \${secret:LS}`);
    expect(err).toContain("yaw-mcp set <server> env.KEY='${secret:LS}'");
    // This file is not necessarily the one the client's yaw-mcp loaded, so a
    // replace keeps the restart advice even here.
    expect(err).toContain("launches yaw-mcp from another project");
    expect(err).toContain("OLD value");
  });

  it("a replace with no bundles.json at all still says nothing references it", async () => {
    await seed();
    expect(await set("LS", true)).toBe(0);
    expect(JSON.parse(outText())).toMatchObject({
      referenced_by: [],
      bundles_path: null,
      running_servers_stale: false,
    });
    io.out.mockReset();
    lock();
    expect(await set("LS")).toBe(0);
    expect(errText()).toContain("no server in bundles.json references ${secret:LS}");
  });

  it("a first store nothing references omits the other-project restart line", async () => {
    await runSecrets({ action: "set", name: "LS", value: VALUE, passphrase: PASS, home, cwd }, io);
    expect(errText()).toContain("no server in bundles.json references");
    expect(errText()).not.toContain("another project");
  });

  it("a first store nothing references stays silent in an existing vault", async () => {
    await seed("OTHER");
    expect(await set("LS")).toBe(0);
    expect(outText()).toBe('Stored secret "LS".\n');
    expect(errText()).toBe("");
  });

  it("a first store into a FRESH vault adds the wiring hint after the creation nudge", async () => {
    expect(await set("LS")).toBe(0);
    const err = errText();
    expect(err).toContain("created the vault");
    expect(err.indexOf("created the vault")).toBeLessThan(err.indexOf("yaw-mcp set <server>"));
  });

  it("an unreadable bundles.json is UNKNOWN, never reported as no references", async () => {
    await seed();
    writeBundles("{ not json");
    expect(await set("LS")).toBe(0);
    const err = errText();
    expect(err).toContain("could not read bundles.json");
    expect(err).toContain("mcp_connect_deactivate");
    expect(err).not.toContain("no server in");

    io.out.mockReset();
    io.err.mockReset();
    lock();
    expect(await set("LS", true)).toBe(0);
    // Unknown, never "not stale": a wrapper keying a reconnect on false
    // would skip the one prose mode advises.
    expect(JSON.parse(outText())).toMatchObject({ referenced_by: null, running_servers_stale: null });
  });

  // `set` re-reads bundles.json after every save. A file that fails to parse
  // because a credential sits in it unquoted must not echo any of that
  // credential: V8's JSON.parse message quotes the source around the bad
  // token, and the loader's log() line goes straight to process.stderr.
  it("an unquoted credential in a broken bundles.json reaches no output of set", async () => {
    const token = "zq9Xv7Kp2Lm4Rt8Wn3Yb6Hc1Jd5Fg0";
    await seed();
    writeBundles(`{ "servers": [ { "namespace": "gh", "command": "npx", "env": { "T": ${token} } } ] }`);
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(await set("LS")).toBe(0);
      io.out.mockReset();
      lock();
      expect(await set("LS", true)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const stderr = written.join("");
    // The loader DID warn (so the scan below covers a real line), with a position.
    expect(stderr).toContain("at line 1, column");
    const everything = `${stderr}\n${errText()}\n${outText()}`;
    for (let i = 0; i + 4 <= token.length; i++) {
      expect(everything).not.toContain(token.slice(i, i + 4));
    }
  });
});
