import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { request } from "undici";
import { ConfigError, fetchConfig } from "../config.js";
import { NAMESPACE_RE } from "../local-bundles.js";

// ---------------------------------------------------------------------------
// Helper: build an async iterable body that yields the given chunks.
// ---------------------------------------------------------------------------
function makeBody(
  chunks: Buffer[],
): { [Symbol.asyncIterator](): AsyncIterator<Buffer> } & { text: () => Promise<string>; destroy?: () => void } {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
    text: vi.fn().mockResolvedValue(""),
    destroy: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helper: build a minimal valid ConnectConfig JSON body.
// ---------------------------------------------------------------------------
function makeValidBody(servers: object[] = []): Buffer {
  return Buffer.from(JSON.stringify({ configVersion: "v1", servers }), "utf8");
}

describe("ConfigError", () => {
  it("has fatal property", () => {
    const err = new ConfigError("bad token", true);
    expect(err.fatal).toBe(true);
    expect(err.message).toBe("bad token");
    expect(err.name).toBe("ConfigError");
  });

  it("non-fatal error", () => {
    const err = new ConfigError("network issue", false);
    expect(err.fatal).toBe(false);
    expect(err instanceof Error).toBe(true);
  });
});

describe("namespace validation regex", () => {
  it("accepts valid namespaces", () => {
    expect(NAMESPACE_RE.test("gh")).toBe(true);
    expect(NAMESPACE_RE.test("slack")).toBe(true);
    expect(NAMESPACE_RE.test("my_server_1")).toBe(true);
    expect(NAMESPACE_RE.test("a")).toBe(true);
  });

  it("rejects namespaces starting with number", () => {
    expect(NAMESPACE_RE.test("1server")).toBe(false);
  });

  it("rejects namespaces starting with underscore", () => {
    expect(NAMESPACE_RE.test("_server")).toBe(false);
  });

  it("rejects namespaces with uppercase", () => {
    expect(NAMESPACE_RE.test("GitHub")).toBe(false);
  });

  it("rejects namespaces with special characters", () => {
    expect(NAMESPACE_RE.test("my-server")).toBe(false);
    expect(NAMESPACE_RE.test("my.server")).toBe(false);
    expect(NAMESPACE_RE.test("my/server")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(NAMESPACE_RE.test("")).toBe(false);
  });

  it("rejects namespaces longer than 30 chars", () => {
    expect(NAMESPACE_RE.test("a".repeat(31))).toBe(false);
  });

  it("accepts exactly 30 chars", () => {
    expect(NAMESPACE_RE.test("a".repeat(30))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchConfig
// ---------------------------------------------------------------------------

describe("fetchConfig", () => {
  const API = "https://yaw.sh/mcp";
  const TOKEN = "mcp_pat_test";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("304 response returns null (conditional GET / ETag)", async () => {
    vi.mocked(request).mockResolvedValue({
      statusCode: 304,
      body: { text: vi.fn().mockResolvedValue("") },
    } as any);

    const result = await fetchConfig(API, TOKEN, "v1");
    expect(result).toBeNull();
  });

  it("401 response throws ConfigError with fatal=true", async () => {
    vi.mocked(request).mockResolvedValue({
      statusCode: 401,
      body: { text: vi.fn().mockResolvedValue("") },
    } as any);

    await expect(fetchConfig(API, TOKEN)).rejects.toMatchObject({
      name: "ConfigError",
      fatal: true,
    });
  });

  it("403 response throws ConfigError with fatal=true", async () => {
    vi.mocked(request).mockResolvedValue({
      statusCode: 403,
      body: { text: vi.fn().mockResolvedValue("") },
    } as any);

    await expect(fetchConfig(API, TOKEN)).rejects.toMatchObject({
      name: "ConfigError",
      fatal: true,
    });
  });

  it("non-200 non-auth response throws ConfigError with fatal=false", async () => {
    vi.mocked(request).mockResolvedValue({
      statusCode: 503,
      body: makeBody([Buffer.from("Service Unavailable", "utf8")]),
    } as any);

    await expect(fetchConfig(API, TOKEN)).rejects.toMatchObject({
      name: "ConfigError",
      fatal: false,
      message: expect.stringContaining("Service Unavailable"),
    });
  });

  it("caps the error-path body instead of buffering it whole", async () => {
    // A 1 MB error page (proxy interstitial / HTML 500) on a non-200: the
    // message must carry a truncated prefix, not the entire body, and the
    // body must be abandoned rather than drained to completion.
    const huge = Buffer.alloc(1024 * 1024, "E");
    const body = makeBody([huge]);
    vi.mocked(request).mockResolvedValue({ statusCode: 500, body } as any);

    const err = await fetchConfig(API, TOKEN).catch((e) => e);
    expect(err).toMatchObject({ name: "ConfigError", fatal: false });
    expect(err.message).toContain("HTTP 500");
    expect(err.message).toContain("(truncated)");
    // 8 KB cap + the "Config fetch failed (HTTP 500): " prefix + the
    // truncation marker -- nowhere near the 1 MB the server sent.
    expect(err.message.length).toBeLessThan(16 * 1024);
    expect(body.destroy).toHaveBeenCalled();
  });

  it("body larger than MAX_CONFIG_BODY_BYTES (6 MB) throws ConfigError with fatal=false", async () => {
    // 6 MB > the 5 MB hard cap in config.ts
    const bigChunk = Buffer.alloc(6 * 1024 * 1024, "x");
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      body: makeBody([bigChunk]),
    } as any);

    await expect(fetchConfig(API, TOKEN)).rejects.toMatchObject({
      name: "ConfigError",
      fatal: false,
      message: expect.stringContaining(">5 MB"),
    });
  });

  it("non-JSON response body throws ConfigError with fatal=false", async () => {
    const badJson = Buffer.from("this is not json", "utf8");
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      body: makeBody([badJson]),
    } as any);

    await expect(fetchConfig(API, TOKEN)).rejects.toMatchObject({
      name: "ConfigError",
      fatal: false,
      message: expect.stringContaining("not valid JSON"),
    });
  });

  it("servers missing required fields (id, name, namespace, type) are filtered out", async () => {
    const servers = [
      // valid server
      { id: "s1", name: "Server One", namespace: "sone", type: "local" },
      // missing id
      { name: "No ID", namespace: "noid", type: "local" },
      // missing name
      { id: "s3", namespace: "noname", type: "local" },
      // missing namespace
      { id: "s4", name: "No NS", type: "local" },
      // missing type
      { id: "s5", name: "No Type", namespace: "notype" },
    ];
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      body: makeBody([makeValidBody(servers)]),
    } as any);

    const config = await fetchConfig(API, TOKEN);
    expect(config).not.toBeNull();
    expect(config!.servers).toHaveLength(1);
    expect(config!.servers[0].id).toBe("s1");
  });

  it("servers with invalid namespace format are filtered out", async () => {
    const servers = [
      // valid
      { id: "a1", name: "Good", namespace: "good_ns", type: "remote" },
      // starts with number
      { id: "a2", name: "Bad1", namespace: "1bad", type: "remote" },
      // starts with underscore
      { id: "a3", name: "Bad2", namespace: "_bad", type: "remote" },
      // contains uppercase
      { id: "a4", name: "Bad3", namespace: "BadNs", type: "remote" },
      // contains hyphen
      { id: "a5", name: "Bad4", namespace: "bad-ns", type: "remote" },
    ];
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      body: makeBody([makeValidBody(servers)]),
    } as any);

    const config = await fetchConfig(API, TOKEN);
    expect(config).not.toBeNull();
    expect(config!.servers).toHaveLength(1);
    expect(config!.servers[0].id).toBe("a1");
  });

  it("servers with a type outside the local|remote union are filtered out", async () => {
    // Presence of `type` is not enough -- upstream.ts switches on the
    // union, so an unrecognized value is unroutable and must be dropped
    // rather than half-loaded.
    const servers = [
      { id: "t1", name: "Local", namespace: "loc", type: "local" },
      { id: "t2", name: "Remote", namespace: "rem", type: "remote" },
      // legacy / drifted value the backend must never send
      { id: "t3", name: "Mcp", namespace: "mcpns", type: "mcp" },
      // case variant is still not the union member
      { id: "t4", name: "Upper", namespace: "upns", type: "Local" },
      // non-string truthy value
      { id: "t5", name: "Numeric", namespace: "numns", type: 1 },
    ];
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      body: makeBody([makeValidBody(servers)]),
    } as any);

    const config = await fetchConfig(API, TOKEN);
    expect(config).not.toBeNull();
    expect(config!.servers.map((s) => s.id)).toEqual(["t1", "t2"]);
  });
});
