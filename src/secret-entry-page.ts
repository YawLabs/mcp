// A one-shot loopback page for typing a secret into a MASKED field.
//
// Why this exists: the broker's in-session vault-passphrase prompt used a
// FORM-mode MCP elicitation with a string field, and a client renders that as
// an ordinary visible text input -- the passphrase sat on screen, in plain
// text, while it was typed. The MCP spec (2025-11-25, client/elicitation)
// says servers MUST NOT use form mode for passwords, API keys or tokens, and
// MUST use URL mode for them; the spec's form field schema has no masked or
// password type to ask for either. So the secret is collected OUTSIDE the
// client: on a page this process serves on 127.0.0.1, in an
// <input type="password">, reached either by a URL-mode elicitation (the
// client opens the link) or, on a client that only speaks form mode, by the
// broker opening the system browser after the user consents
// (openInSystemBrowser below). server.ts owns that choice; this module is the
// page and the browser launcher, and knows nothing about vaults, so the same
// page can take a missing child credential later.
//
// Hardening, each item because of a specific attack or leak:
//   * 127.0.0.1 only, random port. Nothing off this machine can reach it.
//   * A 256-bit random token is the whole path, compared in constant time.
//     Knowing the port is not enough to submit, and the token is minted per
//     page, so a URL from an earlier prompt is dead.
//   * The Host header must be exactly 127.0.0.1:<port>. A DNS-rebinding page
//     (evil.example resolving to 127.0.0.1) sends its own name as Host and is
//     refused before the path is even looked at.
//   * An Origin header, when the browser sends one, must be this page's own
//     origin -- a cross-origin form POST is refused. Referrer-Policy is
//     same-origin rather than no-referrer on purpose: no-referrer makes a
//     browser send `Origin: null` on the page's OWN form POST, and that would
//     be refused.
//   * The secret is read from a POST body only. A query string is never
//     read, on any method, so a value can never be taken from a URL that
//     lands in browser history or a log.
//   * One submission. The first accepted POST closes the page; everything
//     after it gets 410 or a refused connection.
//   * A TTL: a page nobody submits closes itself.
//   * No CORS headers at all, Cache-Control: no-store, a CSP that allows
//     inline style and nothing else (no script, no framing, form posts only
//     to itself), and Connection: close on every response so no keep-alive
//     socket outlives its request.
//
// What never happens here: the request body is never logged, and nothing is
// written to stdout -- in the stdio broker stdout IS the JSON-RPC channel, and
// a stray write corrupts the session. Log lines carry the port, never the
// token or a value.
//
// Lifetime: every path through the handler answers the request, and every
// exit (submission, expiry, close()) closes the listener. Both matter under
// the oam runtime, which the broker can run on: its http.Server has no
// unref() (probed on oam 0.16.3), so a listener left open keeps the process
// alive, and a request left unanswered can keep it alive after close().

import { type SpawnOptions, spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { win32 } from "node:path";
import { stripInternalSecretsFromEnv } from "./internal-secret-env.js";
import { log } from "./logger.js";

/** How long a page stays usable when the caller does not say. Long enough to
 *  answer the client's consent prompt (the SDK's own request timeout bounds
 *  that at 60s), switch to the browser and type a passphrase; short enough
 *  that a forgotten tab is not a standing way in. */
export const SECRET_ENTRY_PAGE_TTL_MS = 3 * 60_000;

/** Largest POST body the page reads. A passphrase or a handful of tokens is a
 *  few hundred bytes; anything past this is refused with 413 without being
 *  buffered. */
const MAX_BODY_BYTES = 16 * 1024;

/** Once a submission is accepted the listener stops taking connections at
 *  once, and the connection carrying the "Received" reply is left to finish.
 *  This bounds how long a client that never reads that reply can hold it. */
const REPLY_DRAIN_MS = 2_000;

const LOOPBACK_HOST = "127.0.0.1";

export interface SecretEntryField {
  /** Form field name, and the key the value is returned under. */
  name: string;
  /** Visible label. The value itself is never visible: every field is a
   *  password input. */
  label: string;
}

export interface SecretEntryPageOptions {
  /** Page heading and <title>. */
  title: string;
  /** One paragraph under the heading: what this is for and what happens to
   *  the value. */
  intro: string;
  fields: readonly SecretEntryField[];
  /** Shown after an accepted submission. */
  doneMessage: string;
  /** Defaults to SECRET_ENTRY_PAGE_TTL_MS. */
  ttlMs?: number;
}

export type SecretEntryOutcome =
  | { kind: "submitted"; values: Record<string, string> }
  | { kind: "expired" }
  | { kind: "closed" };

export interface SecretEntryPage {
  /** http://127.0.0.1:<port>/<token>. Carries no secret of its own -- only
   *  the single-use token that addresses the page. */
  readonly url: string;
  /** A fresh id for a URL-mode elicitation of this page. Distinct from the
   *  token, so the id the protocol echoes around (in the completion
   *  notification too) cannot be turned into the page's address. */
  readonly elicitationId: string;
  /** Settles exactly once: the submitted values, the TTL running out, or
   *  close() being called first. Never rejects. */
  readonly result: Promise<SecretEntryOutcome>;
  /** Stop the page. Idempotent. Resolves `result` with "closed" when nothing
   *  was submitted yet; after a submission it leaves the "Received" reply to
   *  finish rather than cutting it off. */
  close(): void;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  Connection: "close",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "3 minutes", "1 minute", "45 seconds" -- for the page's own expiry line. */
export function describeTtl(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const m = ms / 60_000;
    return `${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  const s = Math.max(1, Math.ceil(ms / 1000));
  return `${s} ${s === 1 ? "second" : "seconds"}`;
}

function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1rem; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  label { display: block; font-weight: 600; margin: 1rem 0 .25rem; }
  input { box-sizing: border-box; width: 100%; font: inherit; padding: .5rem; }
  button { margin-top: 1.25rem; font: inherit; padding: .5rem 1.25rem; }
  .err { color: #b00020; font-weight: 600; }
  .fine { font-size: .9rem; opacity: .75; }
</style>
</head>
<body><main>
${body}
</main></body>
</html>
`;
}

/** The launch command for the platform's default browser, or null when this
 *  machine has no way to show one. Exported for tests. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } | null {
  // rundll32's URL handler, not `cmd /c start`: there is no shell in the
  // path, so nothing in the URL is ever parsed as a command. By absolute
  // path, because the argument carries the page's token: a PATH lookup would
  // hand it to whatever rundll32.exe sits earliest on PATH. It also makes the
  // lookup the same on both runtimes -- oam's spawn searches System32 even
  // when PATH omits it, node's does not (both probed on this box).
  if (platform === "win32") {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR ?? "C:\\Windows";
    return { command: win32.join(systemRoot, "System32", "rundll32.exe"), args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") return { command: "/usr/bin/open", args: [url] };
  // Linux and the BSDs. Without a graphical session xdg-open falls back to a
  // text-mode browser, and with stdio ignored (it must be -- see
  // openInSystemBrowser) that browser has no terminal to draw on. Report
  // "no browser" instead, so the caller can say so rather than wait out the
  // page's TTL on a tab nobody can see.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return { command: "xdg-open", args: [url] };
}

/** What openInSystemBrowser needs from the process it starts: the "spawn" or
 *  "error" event that says whether the launcher started, and unref() to let
 *  go of it afterwards. node's ChildProcess satisfies it. */
export interface LauncherChild {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  unref(): void;
}

/** The one spawn overload openInSystemBrowser calls. The `spawn` imported
 *  above is the default; a test passes a stand-in to watch the failure path
 *  and the env the launcher receives without a browser being opened. */
export type LauncherSpawn = (command: string, args: readonly string[], options: SpawnOptions) => LauncherChild;

/** Ask the OS to open `url` in the default browser. True when the launcher
 *  started, false when there is no launcher or it failed to start -- which
 *  is all that can be known: whether a window actually appeared is not
 *  observable from here, and the page's TTL covers a launcher that "worked"
 *  without showing anything.
 *
 *  stdio is ignored rather than inherited because the broker's stdout is the
 *  JSON-RPC channel: a launcher that prints anything would corrupt it. The
 *  env is stripped of yaw-mcp's own secrets like every other child the
 *  broker spawns -- the "invalid passphrase" prompt runs while
 *  YAW_MCP_VAULT_PASSPHRASE is set.
 *
 *  `spawnLauncher` is a test seam (see LauncherSpawn). server.ts calls this
 *  with the URL alone, so the launch there goes through the `spawn` imported
 *  above. */
export function openInSystemBrowser(url: string, spawnLauncher: LauncherSpawn = spawn): Promise<boolean> {
  const launch = browserCommand(url);
  if (!launch) {
    log("info", "No graphical session to open the secret entry page in");
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let child: LauncherChild;
    try {
      child = spawnLauncher(launch.command, launch.args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
        env: stripInternalSecretsFromEnv(process.env),
      });
    } catch (err) {
      log("warn", "Could not launch a browser for the secret entry page", {
        command: launch.command,
        error: err instanceof Error ? err.message : String(err),
      });
      resolve(false);
      return;
    }
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
    child.once("error", (err) => {
      log("warn", "Could not launch a browser for the secret entry page", {
        command: launch.command,
        error: err.message,
      });
      resolve(false);
    });
  });
}

/** Start a page and resolve once it is listening. Rejects only when the
 *  listener cannot be started (no loopback interface, no free port). */
export function openSecretEntryPage(opts: SecretEntryPageOptions): Promise<SecretEntryPage> {
  if (opts.fields.length === 0) return Promise.reject(new Error("a secret entry page needs at least one field"));
  const ttlMs = opts.ttlMs ?? SECRET_ENTRY_PAGE_TTL_MS;
  const token = randomBytes(32).toString("hex");
  const expectedPath = Buffer.from(`/${token}`, "utf8");
  const elicitationId = randomUUID();

  let port = 0;
  // "open" until the first accepted submission, the TTL, or close().
  let state: "open" | "done" = "open";
  // Set when a submission was accepted, so close() leaves its reply alone.
  let replying = false;
  let listenerClosed = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let settle: (outcome: SecretEntryOutcome) => void = () => {};
  const result = new Promise<SecretEntryOutcome>((resolve) => {
    settle = resolve;
  });

  const server = createServer((req, res) => handle(req, res));

  /** Stop listening. `hard` also destroys every open connection -- the TTL
   *  and close() paths, where nothing in flight is worth finishing. */
  const closeListener = (hard: boolean): void => {
    if (!listenerClosed) {
      listenerClosed = true;
      server.close();
    }
    if (hard) server.closeAllConnections?.();
    else server.closeIdleConnections?.();
  };

  const end = (outcome: SecretEntryOutcome): void => {
    if (state === "done") return;
    state = "done";
    if (expiry) clearTimeout(expiry);
    closeListener(true);
    settle(outcome);
  };

  const send = (
    res: ServerResponse,
    status: number,
    body: string,
    extra: Record<string, string> = {},
    type = "text/html; charset=utf-8",
  ): void => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...extra });
    res.end(body);
  };

  const formPage = (error?: string): string => {
    const fields = opts.fields
      .map(
        (f, i) =>
          `<label for="f${i}">${escapeHtml(f.label)}</label>\n<input id="f${i}" name="${escapeHtml(f.name)}" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required${i === 0 ? " autofocus" : ""}>`,
      )
      .join("\n");
    return htmlDocument(
      opts.title,
      `<h1>${escapeHtml(opts.title)}</h1>
<p>${escapeHtml(opts.intro)}</p>
${error ? `<p class="err">${escapeHtml(error)}</p>\n` : ""}<form method="post" autocomplete="off">
${fields}
<button type="submit">Submit</button>
</form>
<p class="fine">Served by yaw-mcp on this computer only (${LOOPBACK_HOST}). This page takes one submission, and stops working after ${describeTtl(ttlMs)}.</p>`,
    );
  };

  const gonePage = (): string =>
    htmlDocument(
      opts.title,
      `<h1>This page has expired</h1>\n<p>It already took a submission, or its time ran out. Return to your MCP client.</p>`,
    );

  const pathMatches = (path: string): boolean => {
    const got = Buffer.from(path, "utf8");
    return got.length === expectedPath.length && timingSafeEqual(got, expectedPath);
  };

  const accept = (values: Record<string, string>, res: ServerResponse): void => {
    state = "done";
    replying = true;
    if (expiry) clearTimeout(expiry);
    // Stop taking connections NOW -- a second submission racing this one must
    // not find a listener -- but let this reply go out before anything is
    // destroyed. A browser preconnect socket is idle, so it goes here too.
    closeListener(false);
    let drained = false;
    const drain = (): void => {
      if (drained) return;
      drained = true;
      closeListener(true);
    };
    res.once("finish", drain);
    res.once("close", drain);
    setTimeout(drain, REPLY_DRAIN_MS).unref?.();
    send(res, 200, htmlDocument(opts.title, `<h1>Received</h1>\n<p>${escapeHtml(opts.doneMessage)}</p>`));
    settle({ kind: "submitted", values });
  };

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // Every branch below answers. See the lifetime note at the top of the file.
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `${LOOPBACK_HOST}:${port}`) {
      send(res, 403, "Forbidden\n", {}, "text/plain; charset=utf-8");
      return;
    }
    const rawUrl = req.url ?? "";
    const q = rawUrl.indexOf("?");
    if (!pathMatches(q === -1 ? rawUrl : rawUrl.slice(0, q))) {
      send(res, 404, "Not found\n", {}, "text/plain; charset=utf-8");
      return;
    }
    if (state !== "open") {
      send(res, 410, gonePage());
      return;
    }
    if (req.method === "GET") {
      send(res, 200, formPage());
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, "Method not allowed\n", { Allow: "GET, POST" }, "text/plain; charset=utf-8");
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${LOOPBACK_HOST}:${port}`) {
      send(res, 403, "Forbidden\n", {}, "text/plain; charset=utf-8");
      return;
    }
    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") {
      send(res, 415, "Unsupported media type\n", {}, "text/plain; charset=utf-8");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => {
      // The socket is gone; there is nobody left to answer.
    });
    req.on("end", () => {
      if (tooLarge) {
        send(res, 413, "Payload too large\n", {}, "text/plain; charset=utf-8");
        return;
      }
      // Lost a race with another submission, or the TTL ran out while this
      // body was still arriving.
      if (state !== "open") {
        chunks.length = 0;
        send(res, 410, gonePage());
        return;
      }
      const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      chunks.length = 0;
      const values: Record<string, string> = {};
      for (const field of opts.fields) {
        const value = params.get(field.name);
        if (value === null || value.length === 0) {
          // Not a submission: the page stays open for a real one.
          send(res, 400, formPage("Every field is required."));
          return;
        }
        values[field.name] = value;
      }
      accept(values, res);
    });
  }

  const close = (): void => {
    if (state === "open") {
      end({ kind: "closed" });
      return;
    }
    // Already settled. After an accepted submission the drain above owns the
    // hard close, so the "Received" reply is not cut off mid-write.
    if (!replying) closeListener(true);
  };

  return new Promise<SecretEntryPage>((resolve, reject) => {
    const onListenError = (err: Error): void => {
      state = "done";
      reject(err);
    };
    server.once("error", onListenError);
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      server.removeListener("error", onListenError);
      server.on("error", (err: Error) => {
        log("warn", "Secret entry page listener failed; closing it", { port, error: err.message });
        end({ kind: "closed" });
      });
      port = (server.address() as AddressInfo).port;
      // Optional: oam's http.Server has no unref(). Where it exists it keeps
      // a page from holding the process open; where it does not, the close on
      // every exit path above is what does.
      (server as { unref?: () => void }).unref?.();
      expiry = setTimeout(() => end({ kind: "expired" }), ttlMs);
      expiry.unref?.();
      log("info", "Secret entry page listening", { port, ttlMs });
      resolve({ url: `http://${LOOPBACK_HOST}:${port}/${token}`, elicitationId, result, close });
    });
  });
}
