import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserCommand,
  describeTtl,
  type LauncherSpawn,
  openInSystemBrowser,
  openSecretEntryPage,
  type SecretEntryOutcome,
  type SecretEntryPage,
} from "../secret-entry-page.js";

// The masked-entry page is the one place a vault passphrase is typed now, so
// these drive a REAL listener over real sockets: every refusal below is a
// status a browser (or an attacker's page) would actually get back.

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One HTTP request with full control of the Host header, which fetch() will
 *  not let a caller set -- and Host is the header the DNS-rebinding check
 *  reads. */
function raw(opts: {
  port: number;
  path: string;
  method?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const body = opts.body ?? "";
    const req = request(
      {
        host: "127.0.0.1",
        port: opts.port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers: {
          Host: opts.host ?? `127.0.0.1:${opts.port}`,
          ...(body.length > 0 ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

function parts(page: SecretEntryPage): { port: number; path: string; origin: string } {
  const u = new URL(page.url);
  return { port: Number(u.port), path: u.pathname, origin: u.origin };
}

/** Whether `result` has settled yet, without waiting on it. */
async function settled(result: Promise<SecretEntryOutcome>): Promise<SecretEntryOutcome | "pending"> {
  return Promise.race([result, new Promise<"pending">((r) => setTimeout(() => r("pending"), 25))]);
}

const pages: SecretEntryPage[] = [];
async function open(ttlMs = 60_000): Promise<SecretEntryPage> {
  const page = await openSecretEntryPage({
    title: "Unlock the test vault",
    intro: "Test intro <b>not markup</b>",
    fields: [{ name: "passphrase", label: "Vault passphrase" }],
    doneMessage: "Received for the test.",
    ttlMs,
  });
  pages.push(page);
  return page;
}

afterEach(() => {
  for (const p of pages.splice(0)) p.close();
  vi.restoreAllMocks();
});

describe("secret entry page: shape and headers", () => {
  it("listens on 127.0.0.1 with a 256-bit token as the whole path", async () => {
    const page = await open();
    const u = new URL(page.url);
    expect(u.protocol).toBe("http:");
    expect(u.hostname).toBe("127.0.0.1");
    expect(u.pathname).toMatch(/^\/[0-9a-f]{64}$/);
    expect(u.search).toBe("");
    // The elicitation id travels with the URL but is not the page's address.
    expect(u.pathname).not.toContain(page.elicitationId);
  });

  it("serves a masked form on GET, with no-store, no CORS and a locked-down CSP", async () => {
    const page = await open();
    const { port, path } = parts(page);
    const res = await raw({ port, path });
    expect(res.status).toBe(200);
    expect(res.body).toContain('type="password"');
    expect(res.body).not.toContain('type="text"');
    expect(res.body).toContain('name="passphrase"');
    // Caller text is escaped, never rendered as markup.
    expect(res.body).toContain("&lt;b&gt;not markup&lt;/b&gt;");
    expect(res.headers["cache-control"]).toBe("no-store");
    // No CORS header of any kind, not just the one a browser checks first.
    expect(Object.keys(res.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("default-src 'none'");
    // No script, pinned directly: the `default-src 'none'` check above still
    // passes with a `script-src` appended to the policy, which would let one run.
    expect(csp).not.toContain("script-src");
    expect(res.body).not.toMatch(/<script/i);
    expect(res.headers.connection).toBe("close");
    expect(await settled(page.result)).toBe("pending");
  });
});

describe("secret entry page: accepts and rejects", () => {
  it("accepts one form POST and resolves the values", async () => {
    const page = await open();
    const { port, path, origin } = parts(page);
    const res = await raw({
      port,
      path,
      method: "POST",
      headers: { ...FORM, Origin: origin },
      body: "passphrase=correct%20horse",
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Received for the test.");
    expect(res.body).not.toContain("correct horse");
    await expect(page.result).resolves.toEqual({ kind: "submitted", values: { passphrase: "correct horse" } });
  });

  it("decodes a browser's form encoding back to the exact value typed", async () => {
    const reserved = "p+w&d=100% off";
    const unicode = "café ünïcode 🔑";
    const cases: Array<{ body: string; expected: string }> = [
      // encodeURIComponent: every reserved byte escaped, a space as %20.
      { body: `passphrase=${encodeURIComponent(reserved)}`, expected: reserved },
      { body: `passphrase=${encodeURIComponent(unicode)}`, expected: unicode },
      // URLSearchParams serialises the way a browser form does: a space as
      // `+`, a typed `+` as %2B, non-ASCII as its UTF-8 bytes.
      { body: new URLSearchParams({ passphrase: reserved }).toString(), expected: reserved },
      { body: new URLSearchParams({ passphrase: unicode }).toString(), expected: unicode },
      // A bare `+` on the wire is a space, which is what a browser form sends.
      { body: "passphrase=correct+horse", expected: "correct horse" },
    ];
    for (const { body, expected } of cases) {
      // What crosses the socket is the encoded form, not the value.
      expect(body, body).not.toContain(expected);
      const page = await open();
      const { port, path, origin } = parts(page);
      const res = await raw({ port, path, method: "POST", headers: { ...FORM, Origin: origin }, body });
      expect(res.status, body).toBe(200);
      await expect(page.result, body).resolves.toEqual({ kind: "submitted", values: { passphrase: expected } });
    }
  });

  it("refuses a wrong token and stays open for the right one", async () => {
    const page = await open();
    const { port, path } = parts(page);
    const wrong = `/${"0".repeat(64)}`;
    expect((await raw({ port, path: wrong, method: "POST", headers: FORM, body: "passphrase=x" })).status).toBe(404);
    expect((await raw({ port, path: `${path}0`, method: "POST", headers: FORM, body: "passphrase=x" })).status).toBe(
      404,
    );
    expect((await raw({ port, path: "/", headers: FORM })).status).toBe(404);
    expect(await settled(page.result)).toBe("pending");

    expect((await raw({ port, path, method: "POST", headers: FORM, body: "passphrase=right" })).status).toBe(200);
    await expect(page.result).resolves.toEqual({ kind: "submitted", values: { passphrase: "right" } });
  });

  it("refuses a Host header that is not 127.0.0.1:<port> (DNS rebinding)", async () => {
    const page = await open();
    const { port, path } = parts(page);
    for (const host of [`evil.example:${port}`, `localhost:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`]) {
      const res = await raw({ port, path, method: "POST", host, headers: FORM, body: "passphrase=x" });
      expect(res.status, host).toBe(403);
    }
    expect((await raw({ port, path, host: `evil.example:${port}` })).status).toBe(403);
    expect(await settled(page.result)).toBe("pending");
  });

  it("never takes a value from a query string, on GET or POST", async () => {
    const page = await open();
    const { port, path } = parts(page);
    // A GET with the value in the URL just gets the form back.
    const get = await raw({ port, path: `${path}?passphrase=from-the-url` });
    expect(get.status).toBe(200);
    expect(get.body).not.toContain("from-the-url");
    expect(await settled(page.result)).toBe("pending");
    // A POST with the value only in the URL has an empty body: not a submission.
    const post = await raw({ port, path: `${path}?passphrase=from-the-url`, method: "POST", headers: FORM });
    expect(post.status).toBe(400);
    expect(await settled(page.result)).toBe("pending");
  });

  it("refuses methods other than GET and POST", async () => {
    const page = await open();
    const { port, path } = parts(page);
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await raw({ port, path, method, headers: FORM, body: "passphrase=x" });
      expect(res.status, method).toBe(405);
      expect(res.headers.allow).toBe("GET, POST");
    }
    expect(await settled(page.result)).toBe("pending");
  });

  it("refuses a cross-origin POST", async () => {
    const page = await open();
    const { port, path } = parts(page);
    const res = await raw({
      port,
      path,
      method: "POST",
      headers: { ...FORM, Origin: "http://evil.example" },
      body: "passphrase=x",
    });
    expect(res.status).toBe(403);
    expect(await settled(page.result)).toBe("pending");
  });

  it("refuses a body that is not a form post", async () => {
    const page = await open();
    const { port, path } = parts(page);
    const res = await raw({
      port,
      path,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: "x" }),
    });
    expect(res.status).toBe(415);
    expect(await settled(page.result)).toBe("pending");
  });

  it("treats an empty field as no submission and stays open", async () => {
    const page = await open();
    const { port, path } = parts(page);
    const res = await raw({ port, path, method: "POST", headers: FORM, body: "passphrase=" });
    expect(res.status).toBe(400);
    expect(res.body).toContain('type="password"');
    expect(await settled(page.result)).toBe("pending");
  });

  it("refuses an oversized body without taking it, and stays open", async () => {
    const page = await open();
    const { port, path } = parts(page);
    const res = await raw({ port, path, method: "POST", headers: FORM, body: `passphrase=${"a".repeat(20_000)}` });
    expect(res.status).toBe(413);
    expect(await settled(page.result)).toBe("pending");
  });
});

describe("secret entry page: single use, expiry, close", () => {
  it("takes exactly one submission; a second is refused and does not change the result", async () => {
    const page = await open();
    const { port, path } = parts(page);
    expect((await raw({ port, path, method: "POST", headers: FORM, body: "passphrase=first" })).status).toBe(200);
    // The listener is closed after the first reply, so the second either finds
    // no listener or, if it raced onto an open connection, gets 410.
    const second = await raw({ port, path, method: "POST", headers: FORM, body: "passphrase=second" }).then(
      (r) => r.status,
      (err: NodeJS.ErrnoException) => err.code,
    );
    expect([410, "ECONNREFUSED", "ECONNRESET"]).toContain(second);
    await expect(page.result).resolves.toEqual({ kind: "submitted", values: { passphrase: "first" } });
  });

  it("lets only one of two racing submissions through", async () => {
    const page = await open();
    const { port, path } = parts(page);
    const statuses = await Promise.all(
      ["a", "b"].map((v) =>
        raw({ port, path, method: "POST", headers: FORM, body: `passphrase=${v}` }).then(
          (r) => r.status,
          (err: NodeJS.ErrnoException) => err.code,
        ),
      ),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    const outcome = await page.result;
    expect(outcome.kind).toBe("submitted");
    const winner = statuses[0] === 200 ? "a" : "b";
    expect(outcome).toEqual({ kind: "submitted", values: { passphrase: winner } });
  });

  it("expires after its TTL and stops listening", async () => {
    const page = await open(150);
    const { port, path } = parts(page);
    await expect(page.result).resolves.toEqual({ kind: "expired" });
    const after = await raw({ port, path, method: "POST", headers: FORM, body: "passphrase=late" }).then(
      (r) => r.status,
      (err: NodeJS.ErrnoException) => err.code,
    );
    expect([410, "ECONNREFUSED", "ECONNRESET"]).toContain(after);
    await expect(page.result).resolves.toEqual({ kind: "expired" });
  });

  it("close() before a submission resolves 'closed' and stops listening", async () => {
    const page = await open();
    const { port, path } = parts(page);
    page.close();
    page.close(); // idempotent
    await expect(page.result).resolves.toEqual({ kind: "closed" });
    const after = await raw({ port, path }).then(
      (r) => r.status,
      (err: NodeJS.ErrnoException) => err.code,
    );
    expect([410, "ECONNREFUSED", "ECONNRESET"]).toContain(after);
  });

  it("close() straight after a submission does not cut off the reply", async () => {
    const page = await open();
    const { port, path } = parts(page);
    const reply = raw({ port, path, method: "POST", headers: FORM, body: "passphrase=x" });
    // The caller's `finally { page.close() }` runs as soon as the result
    // settles -- before the browser has necessarily read the reply.
    await page.result;
    page.close();
    const res = await reply;
    expect(res.status).toBe(200);
    expect(res.body).toContain("Received for the test.");
  });

  it("writes nothing to stdout and never logs the submitted value", async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const page = await open();
    const { port, path } = parts(page);
    await raw({ port, path });
    await raw({ port, path, method: "POST", headers: FORM, body: "passphrase=never-logged-s3cret" });
    await page.result;
    // stdout is the broker's JSON-RPC channel.
    expect(stdout).not.toHaveBeenCalled();
    const logged = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).not.toContain("never-logged-s3cret");
    // The token is the page's only credential; it is not logged either.
    expect(logged).not.toContain(path.slice(1));
  });

  it("rejects a page with no fields", async () => {
    await expect(
      openSecretEntryPage({ title: "t", intro: "i", fields: [], doneMessage: "d", ttlMs: 1000 }),
    ).rejects.toThrow(/at least one field/);
  });

  it("rejects two fields sharing a name, which would hand both the first value", async () => {
    await expect(
      openSecretEntryPage({
        title: "t",
        intro: "i",
        fields: [
          { name: "API_KEY", label: "API key" },
          { name: "API_KEY", label: "API key again" },
        ],
        doneMessage: "d",
        ttlMs: 1000,
      }),
    ).rejects.toThrow(/must be unique/);
  });
});

describe("describeTtl", () => {
  it("words whole minutes and anything else in seconds", () => {
    expect(describeTtl(3 * 60_000)).toBe("3 minutes");
    expect(describeTtl(60_000)).toBe("1 minute");
    expect(describeTtl(45_000)).toBe("45 seconds");
    expect(describeTtl(150)).toBe("1 second");
  });
});

describe("browserCommand", () => {
  const url = "http://127.0.0.1:1234/abc";

  it("uses rundll32's URL handler on Windows, by absolute path, so no shell or PATH lookup sees the URL", () => {
    expect(browserCommand(url, "win32", { SystemRoot: "D:\\Win" })).toEqual({
      command: "D:\\Win\\System32\\rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
    expect(browserCommand(url, "win32", {})?.command).toBe("C:\\Windows\\System32\\rundll32.exe");
  });

  it("uses /usr/bin/open on macOS", () => {
    expect(browserCommand(url, "darwin", {})).toEqual({ command: "/usr/bin/open", args: [url] });
  });

  it("uses xdg-open only when there is a graphical session", () => {
    // By bare name on purpose: xdg-open has no fixed path across distros (see
    // browserCommand).
    expect(browserCommand(url, "linux", { DISPLAY: ":0" })).toEqual({ command: "xdg-open", args: [url] });
    expect(browserCommand(url, "linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual({
      command: "xdg-open",
      args: [url],
    });
    // Headless: say "no browser" rather than launch a text-mode one with no
    // terminal to draw on.
    expect(browserCommand(url, "linux", {})).toBeNull();
    expect(browserCommand(url, "freebsd", {})).toBeNull();
  });
});

describe("openInSystemBrowser", () => {
  const url = "http://127.0.0.1:1234/0123456789abcdef";

  /** Run `fn` with `overrides` set in process.env, then put every touched
   *  key back the way it was (a key that was unset is deleted again). */
  async function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const before = new Map(Object.keys(overrides).map((k) => [k, process.env[k]]));
    Object.assign(process.env, overrides);
    try {
      return await fn();
    } finally {
      for (const [k, v] of before) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  // browserCommand reads process.env, and on Linux answers null when there is
  // no graphical session -- then nothing is spawned at all. Keep DISPLAY set
  // while these run so the spawn seam is reached on a headless Linux box too;
  // browserCommand does not read DISPLAY on win32 or darwin.
  const graphical = { DISPLAY: process.env.DISPLAY ?? ":0" };

  /** A child that reports "started" and is not a process. */
  class LauncherStub extends EventEmitter {
    unref(): void {}
  }

  it("resolves false, without throwing or writing to stdout, when the launcher cannot start", async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    // A launcher that does not exist: spawn reports ENOENT through the
    // child's "error" event, the same path a missing system launcher takes.
    const missing = join(tmpdir(), `yaw-mcp-test-${randomUUID()}`, "launcher");
    expect(existsSync(missing)).toBe(false);
    const spawnMissing: LauncherSpawn = (_command, args, options) => spawn(missing, args, options);
    await withEnv(graphical, async () => {
      // `resolves` fails on a rejection, and a synchronous throw fails the
      // test outright: nothing escapes either way.
      await expect(openInSystemBrowser(url, spawnMissing)).resolves.toBe(false);
    });
    // stdout is the broker's JSON-RPC channel.
    expect(stdout).not.toHaveBeenCalled();
    // The failure is logged with the command, never with the URL and its token.
    const logged = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).not.toContain(url);
  });

  it("hands the launcher an env without yaw-mcp's own secrets", async () => {
    const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const spawnCapturing: LauncherSpawn = (command, args, options) => {
      calls.push({ command, args, env: options.env });
      const child = new LauncherStub();
      process.nextTick(() => child.emit("spawn"));
      return child;
    };
    await withEnv(
      {
        ...graphical,
        YAW_MCP_VAULT_PASSPHRASE: "live-passphrase-s3cret",
        YAW_MCP_VAULT_PASSPHRASE_NEW: "next-passphrase-s3cret",
        SECRET_ENTRY_PAGE_TEST_UNRELATED: "still-here",
      },
      async () => {
        await expect(openInSystemBrowser(url, spawnCapturing)).resolves.toBe(true);
      },
    );
    expect(calls).toHaveLength(1);
    const { args, env } = calls[0];
    expect(args).toContain(url);
    // An env was passed at all: with `env` left undefined, spawn hands the
    // child this process's env, secrets included.
    expect(env).toBeDefined();
    const passed = env ?? {};
    // Windows env keys are case-insensitive, so the strip matches
    // case-insensitively too; check the same way, then check the values.
    const keys = Object.keys(passed).map((k) => k.toUpperCase());
    expect(keys).not.toContain("YAW_MCP_VAULT_PASSPHRASE");
    expect(keys).not.toContain("YAW_MCP_VAULT_PASSPHRASE_NEW");
    expect(Object.values(passed)).not.toContain("live-passphrase-s3cret");
    expect(Object.values(passed)).not.toContain("next-passphrase-s3cret");
    expect(passed.SECRET_ENTRY_PAGE_TEST_UNRELATED).toBe("still-here");
  });
});
