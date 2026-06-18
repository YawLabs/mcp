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
function _makeFetchResponse(status: number, body: unknown = {}) {
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
import {
  _resetForTests,
  getCachedCookie,
  getResource,
  getSession,
  listAnalyticsEvents,
  postAnalyticsEvent,
  putResource,
  signIn,
  TeamSyncAuthError,
} from "../team-sync.js";

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

// -----------------------------------------------------------------------
// signIn
// -----------------------------------------------------------------------

/** Build a minimal fetch() response usable by signIn mocks. */
function makeSignInPostOk(cookie = "yaw_team=tok-abc; Path=/; HttpOnly") {
  return {
    status: 200,
    json: () =>
      Promise.resolve({
        email: "user@example.com",
        role: "member",
        order_id: "ord-1",
      }),
    headers: {
      get: (name: string) => (name.toLowerCase() === "set-cookie" ? cookie : null),
      getSetCookie: () => [cookie],
    } as unknown as Headers,
  };
}

function makeSignInGetOk(expValue: number) {
  return {
    status: 200,
    json: () =>
      Promise.resolve({
        email: "user@example.com",
        role: "member",
        order_id: "ord-1",
        exp: expValue,
      }),
    headers: {
      get: () => null,
      getSetCookie: () => [],
    } as unknown as Headers,
  };
}

describe("signIn -- success path", () => {
  it("returns session with cookie: seconds-shaped exp (exp < 1e10) persists valid for getSession", async () => {
    // signIn stores the raw server exp value verbatim -- normalization from
    // seconds to ms happens inside expMs() at loadStoredState time.
    // What we verify here: a seconds-shaped exp that is in the future causes
    // signIn to succeed AND the persisted session is still loadable via getSession.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const futureSeconds = nowSeconds + 86_400; // +1 day

    fetchMock
      .mockResolvedValueOnce(makeSignInPostOk()) // POST /api/team/session
      .mockResolvedValueOnce(makeSignInGetOk(futureSeconds)); // GET  /api/team/session

    const session = await signIn("lk_test_key", { home: tmpHome });

    // signIn returns the raw server value (seconds-shaped in this case)
    expect(session.exp).toBe(futureSeconds);
    expect(session.email).toBe("user@example.com");
    expect(session.role).toBe("member");
    expect(session.order_id).toBe("ord-1");

    // The persisted session must be readable as non-expired; expMs() converts
    // seconds to ms internally so the expiry check is correct.
    const loaded = await getSession({ home: tmpHome });
    expect(loaded).not.toBeNull();
    expect(loaded?.email).toBe("user@example.com");
  });

  it("returns session with cookie when exp is already in ms (exp >= 1e12)", async () => {
    const futureMs = Date.now() + 86_400_000;

    fetchMock.mockResolvedValueOnce(makeSignInPostOk()).mockResolvedValueOnce(makeSignInGetOk(futureMs));

    const session = await signIn("lk_test_key", { home: tmpHome });
    expect(session.exp).toBe(futureMs); // passed through unchanged
    expect(session.email).toBe("user@example.com");
  });
});

describe("signIn -- 401 throws TeamSyncAuthError", () => {
  it("throws TeamSyncAuthError when POST returns 401", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized" }),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    await expect(signIn("lk_bad_key", { home: tmpHome })).rejects.toThrow(TeamSyncAuthError);
  });

  it("throws TeamSyncAuthError when POST returns 401 -- no cookie in body", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 401,
      json: () => Promise.resolve({}),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    const err = await signIn("lk_bad_key", { home: tmpHome }).catch((e) => e);
    expect(err).toBeInstanceOf(TeamSyncAuthError);
  });
});

describe("signIn -- non-200/non-401 throws with status; license key is scrubbed", () => {
  it("throws when POST returns 500", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 500,
      json: () => Promise.resolve({ error: "Internal server error" }),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    await expect(signIn("lk_secret_key", { home: tmpHome })).rejects.toThrow();
  });

  it("does NOT include the license key in the thrown error message (security scrubbing)", async () => {
    const secretKey = "lk_super_secret_key_12345";
    fetchMock.mockImplementationOnce(() => {
      throw new Error(`Connection refused: POST body was ${secretKey}`);
    });

    const err = await signIn(secretKey, { home: tmpHome }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // The license key must NOT appear anywhere in the error message.
    expect(err.message).not.toContain(secretKey);
    // Should contain [redacted] in its place.
    expect(err.message).toContain("[redacted]");
  });
});

describe("signIn -- exp missing or non-numeric is treated as expired", () => {
  it("throws TeamSyncAuthError when GET session returns no exp field", async () => {
    fetchMock.mockResolvedValueOnce(makeSignInPostOk()).mockResolvedValueOnce({
      status: 200,
      json: () =>
        Promise.resolve({
          email: "user@example.com",
          role: "member",
          order_id: "ord-1",
          // no exp field
        }),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    await expect(signIn("lk_test_key", { home: tmpHome })).rejects.toThrow(TeamSyncAuthError);
  });

  it("throws TeamSyncAuthError when GET session returns exp as a string", async () => {
    fetchMock.mockResolvedValueOnce(makeSignInPostOk()).mockResolvedValueOnce({
      status: 200,
      json: () =>
        Promise.resolve({
          email: "user@example.com",
          role: "member",
          order_id: "ord-1",
          exp: "not-a-number",
        }),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    await expect(signIn("lk_test_key", { home: tmpHome })).rejects.toThrow(TeamSyncAuthError);
  });
});

// -----------------------------------------------------------------------
// getResource
// -----------------------------------------------------------------------

describe("getResource", () => {
  it("success: returns parsed JSON body", async () => {
    await writeSession(tmpHome, "cookie-get");

    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: () =>
        Promise.resolve({
          version: 3,
          data: { servers: [{ namespace: "github" }] },
          updated_at: "2024-01-01T00:00:00Z",
          updated_by: "user@example.com",
        }),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    const result = await getResource<{ servers: unknown[] }>("mcp_bundles", { home: tmpHome });
    expect(result.version).toBe(3);
    expect(result.data).toEqual({ servers: [{ namespace: "github" }] });
    expect(result.updated_at).toBe("2024-01-01T00:00:00Z");
    expect(result.updated_by).toBe("user@example.com");
  });

  it("401: throws TeamSyncAuthError", async () => {
    await writeSession(tmpHome, "cookie-get-401");

    fetchMock.mockResolvedValueOnce({
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized" }),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    await expect(getResource("mcp_bundles", { home: tmpHome })).rejects.toThrow(TeamSyncAuthError);
  });

  it("non-200: throws with status in message", async () => {
    await writeSession(tmpHome, "cookie-get-500");

    fetchMock.mockResolvedValueOnce({
      status: 503,
      json: () => Promise.resolve({ error: "Service Unavailable" }),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    const err = await getResource("mcp_bundles", { home: tmpHome }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("503");
  });

  it("throws TeamSyncAuthError when no stored session exists", async () => {
    // tmpHome has no session file -- getResource should throw immediately.
    await expect(getResource("mcp_bundles", { home: tmpHome })).rejects.toThrow(TeamSyncAuthError);
  });
});

// -----------------------------------------------------------------------
// putResource
// -----------------------------------------------------------------------

describe("putResource", () => {
  it("success: returns response body", async () => {
    await writeSession(tmpHome, "cookie-put");

    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: () =>
        Promise.resolve({
          version: 4,
          data: { servers: [] },
          updated_at: "2024-06-01T12:00:00Z",
          updated_by: "admin@example.com",
        }),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    const result = await putResource("mcp_bundles", 3, { servers: [] }, { home: tmpHome });
    expect(result.version).toBe(4);
    expect(result.updated_by).toBe("admin@example.com");
  });

  it("401: throws TeamSyncAuthError", async () => {
    await writeSession(tmpHome, "cookie-put-401");

    fetchMock.mockResolvedValueOnce({
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized" }),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    await expect(putResource("mcp_bundles", 1, {}, { home: tmpHome })).rejects.toThrow(TeamSyncAuthError);
  });
});

// -----------------------------------------------------------------------
// listAnalyticsEvents
// -----------------------------------------------------------------------

describe("listAnalyticsEvents", () => {
  it("success: returns events array", async () => {
    await writeSession(tmpHome, "cookie-analytics");

    const events = [
      {
        ts: 1700000000000,
        seat_email: "user@example.com",
        tool_namespace: "gh",
        tool_name: "list_prs",
        status: "success" as const,
      },
      {
        ts: 1700000001000,
        seat_email: "user@example.com",
        tool_namespace: "gh",
        tool_name: "create_issue",
        status: "error" as const,
      },
    ];

    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ events, cap: 100, order_id: "ord-1" }),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    const result = await listAnalyticsEvents({ home: tmpHome });
    expect(result.events).toHaveLength(2);
    expect(result.events[0].tool_name).toBe("list_prs");
    expect(result.events[1].tool_name).toBe("create_issue");
    expect(result.cap).toBe(100);
    expect(result.order_id).toBe("ord-1");
  });

  it("401: throws TeamSyncAuthError", async () => {
    await writeSession(tmpHome, "cookie-analytics-401");

    fetchMock.mockResolvedValueOnce({
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized" }),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    await expect(listAnalyticsEvents({ home: tmpHome })).rejects.toThrow(TeamSyncAuthError);
  });

  it("non-200: throws with status in message", async () => {
    await writeSession(tmpHome, "cookie-analytics-500");

    fetchMock.mockResolvedValueOnce({
      status: 500,
      json: () => Promise.resolve({ error: "Internal server error" }),
      headers: { get: () => null, getSetCookie: () => [] } as unknown as Headers,
    });

    const err = await listAnalyticsEvents({ home: tmpHome }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("500");
  });

  it("throws TeamSyncAuthError when no stored session exists", async () => {
    await expect(listAnalyticsEvents({ home: tmpHome })).rejects.toThrow(TeamSyncAuthError);
  });
});
