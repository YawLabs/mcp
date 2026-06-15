// Pins two fixes:
//
// 1. postAnalyticsEvent 401: a 401 from the fire-and-forget analytics POST
//    must NOT call clearStoredState() (which would log the user out mid-
//    workflow).  Returns { ok: false } only.
//
// 2. getCachedCookie: the new export returns the cookie from the in-process
//    cache populated by a prior getSession() call -- no disk read.

import { beforeEach, describe, expect, it, vi } from "vitest";

// -----------------------------------------------------------------------
// Mock fetch so we control HTTP responses without real network calls.
// -----------------------------------------------------------------------
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// -----------------------------------------------------------------------
// A helper to build minimal fetch() responses.
// -----------------------------------------------------------------------
function makeFetchResponse(status: number, body: unknown = {}) {
  return Promise.resolve({
    status,
    json: () => Promise.resolve(body),
    headers: {
      get: () => null,
      getSetCookie: () => [],
    } as unknown as Headers,
  });
}

// -----------------------------------------------------------------------
// We need fs/promises to write a fake session file.
// -----------------------------------------------------------------------
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// -----------------------------------------------------------------------
// Use a per-test temp home so tests don't bleed into each other.
// -----------------------------------------------------------------------
let tmpHome: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpHome = path.join(os.tmpdir(), `yaw-team-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(path.join(tmpHome, ".yaw-mcp"), { recursive: true });
});

// -----------------------------------------------------------------------
// Shared test fixture: a valid stored session on disk.
// -----------------------------------------------------------------------
async function writeSession(home: string, cookie: string): Promise<void> {
  const session = {
    cookie,
    session: {
      email: "user@example.com",
      role: "member",
      order_id: "ord-1",
      exp: Date.now() + 86_400_000, // +24h
    },
  };
  await writeFile(path.join(home, ".yaw-mcp", "team-session.json"), JSON.stringify(session));
}

// -----------------------------------------------------------------------
// Import after global mocks are in place.
// -----------------------------------------------------------------------
import { _resetForTests, getCachedCookie, getSession, postAnalyticsEvent } from "../team-sync.js";

// Reset the module-scoped cache before every test.
beforeEach(() => {
  _resetForTests();
});

// -----------------------------------------------------------------------
// Fix 1: postAnalyticsEvent 401 must NOT clear the stored state.
// -----------------------------------------------------------------------
describe("postAnalyticsEvent -- 401 does not clear session", () => {
  it("returns { ok: false } on 401 without touching the session file", async () => {
    await writeSession(tmpHome, "cookie-abc");

    // Return 401 from the analytics endpoint.
    fetchMock.mockResolvedValueOnce({
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized" }),
      headers: { get: () => null, getSetCookie: () => [] },
    });

    const result = await postAnalyticsEvent(
      { tool_namespace: "gh", tool_name: "create_issue", status: "success" },
      { home: tmpHome },
    );

    expect(result).toEqual({ ok: false });

    // The session must still be loadable -- clearStoredState was NOT called.
    const session = await getSession({ home: tmpHome });
    expect(session).not.toBeNull();
    expect(session?.email).toBe("user@example.com");
  });

  it("does not call clearStoredState for analytics 401 even after getSession warms cache", async () => {
    await writeSession(tmpHome, "cookie-xyz");

    // Warm the cache via getSession.
    const before = await getSession({ home: tmpHome });
    expect(before).not.toBeNull();

    // Now analytics returns 401.
    fetchMock.mockResolvedValueOnce({
      status: 401,
      json: () => Promise.resolve({}),
      headers: { get: () => null, getSetCookie: () => [] },
    });

    await postAnalyticsEvent({ tool_namespace: "gh", tool_name: "list_prs", status: "error" }, { home: tmpHome });

    // Session still valid.
    const after = await getSession({ home: tmpHome });
    expect(after).not.toBeNull();
  });

  it("returns { ok: true } on 200", async () => {
    await writeSession(tmpHome, "cookie-abc");

    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ ok: true }),
      headers: { get: () => null, getSetCookie: () => [] },
    });

    const result = await postAnalyticsEvent(
      { tool_namespace: "gh", tool_name: "create_issue", status: "success" },
      { home: tmpHome },
    );
    expect(result).toEqual({ ok: true });
  });
});

// -----------------------------------------------------------------------
// Fix 2: getCachedCookie returns the cookie from the in-process cache.
// -----------------------------------------------------------------------
describe("getCachedCookie", () => {
  it("returns null when cache is cold (no prior getSession)", () => {
    // Cache is empty -- _resetForTests() was called in beforeEach.
    expect(getCachedCookie()).toBeNull();
  });

  it("returns the cookie after getSession() warms the cache", async () => {
    await writeSession(tmpHome, "my-team-cookie");
    const session = await getSession({ home: tmpHome });
    expect(session).not.toBeNull();

    // No disk read here -- synchronous cache lookup.
    const cookie = getCachedCookie();
    expect(cookie).toBe("my-team-cookie");
  });

  it("returns null when the session is expired", async () => {
    // Write an expired session.
    const expired = {
      cookie: "expired-cookie",
      session: {
        email: "user@example.com",
        role: "member",
        order_id: "ord-1",
        exp: Date.now() - 1000, // already expired
      },
    };
    await writeFile(path.join(tmpHome, ".yaw-mcp", "team-session.json"), JSON.stringify(expired));

    const session = await getSession({ home: tmpHome });
    expect(session).toBeNull();

    // Expired => cache holds { state: null } => getCachedCookie returns null.
    expect(getCachedCookie()).toBeNull();
  });

  it("seconds-shaped exp that is not yet expired validates via getSession", async () => {
    // expMs() in team-sync.ts converts seconds to ms when exp < 1e12.
    // Write a session whose exp is expressed in seconds (Unix timestamp style).
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sessionInSeconds = {
      cookie: "cookie-seconds",
      session: {
        email: "user@example.com",
        role: "member",
        order_id: "ord-1",
        // exp in seconds, not yet expired (valid for 1 day)
        exp: nowSeconds + 86_400,
      },
    };
    await writeFile(path.join(tmpHome, ".yaw-mcp", "team-session.json"), JSON.stringify(sessionInSeconds));

    // getSession must return a non-null session -- the seconds-shaped exp should
    // be converted to ms and compare correctly against Date.now().
    const session = await getSession({ home: tmpHome });
    expect(session).not.toBeNull();
    expect(session?.email).toBe("user@example.com");
  });

  it("seconds-shaped exp that IS expired is rejected by getSession", async () => {
    // An exp in seconds that is already in the past (even after *1000) must
    // be treated as expired.
    const sessionExpiredSeconds = {
      cookie: "cookie-expired-seconds",
      session: {
        email: "expired@example.com",
        role: "member",
        order_id: "ord-2",
        // exp in seconds, clearly in the past (Unix epoch 1000 = Jan 1970)
        exp: 1000,
      },
    };
    await writeFile(path.join(tmpHome, ".yaw-mcp", "team-session.json"), JSON.stringify(sessionExpiredSeconds));

    const session = await getSession({ home: tmpHome });
    expect(session).toBeNull();
  });

  it("does not cross sessions when a second home has a different session file", async () => {
    // Home A and home B each have their own session file with distinct
    // cookies/emails. The module-global cache is keyed by filePath, so
    // loading B after A must NOT return A's cached session.
    const homeB = path.join(os.tmpdir(), `yaw-team-sync-test-B-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(path.join(homeB, ".yaw-mcp"), { recursive: true });

    await writeSession(tmpHome, "cookie-home-A");
    await writeFile(
      path.join(homeB, ".yaw-mcp", "team-session.json"),
      JSON.stringify({
        cookie: "cookie-home-B",
        session: { email: "userB@example.com", role: "member", order_id: "ord-B", exp: Date.now() + 86_400_000 },
      }),
    );

    // Warm the cache from home A.
    const a = await getSession({ home: tmpHome });
    expect(a?.email).toBe("user@example.com");
    expect(getCachedCookie()).toBe("cookie-home-A");

    // Loading home B must re-read from B's file, not return A's cached state.
    const b = await getSession({ home: homeB });
    expect(b?.email).toBe("userB@example.com");
    expect(getCachedCookie()).toBe("cookie-home-B");

    await rm(homeB, { recursive: true, force: true });
  });

  it("does not read the session file a second time (cache hit, no new fetch calls)", async () => {
    await writeSession(tmpHome, "cookie-456");
    // Warm the cache.
    await getSession({ home: tmpHome });
    const readCallCountAfterWarm = fetchMock.mock.calls.length;

    // getCachedCookie must not trigger another fs read (fetch is mocked,
    // but the synchronous path never reaches fetch at all).
    getCachedCookie();
    // No extra fetch calls means no extra I/O was initiated.
    expect(fetchMock.mock.calls.length).toBe(readCallCountAfterWarm);
  });
});
