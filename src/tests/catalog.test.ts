import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CatalogServer,
  DEFAULT_CATALOG_URL,
  defaultFetchCatalog,
  type FetchCatalog,
  resolveCatalogSlug,
  tokenizeCommand,
} from "../catalog.js";

describe("tokenizeCommand", () => {
  it("parses a simple command with no quotes", () => {
    expect(tokenizeCommand("npx -y server")).toEqual(["npx", "-y", "server"]);
  });

  it("handles single-quoted args", () => {
    expect(tokenizeCommand("cmd 'hello world'")).toEqual(["cmd", "hello world"]);
  });

  it("handles double-quoted args", () => {
    expect(tokenizeCommand('cmd "hello world"')).toEqual(["cmd", "hello world"]);
  });

  it("throws on unterminated single quote", () => {
    expect(() => tokenizeCommand("cmd 'hello")).toThrow("Unbalanced quote");
  });

  it("throws on unterminated double quote", () => {
    expect(() => tokenizeCommand('cmd "hello')).toThrow("Unbalanced quote");
  });

  it("trims leading and trailing whitespace between tokens", () => {
    expect(tokenizeCommand("  npx   -y   server  ")).toEqual(["npx", "-y", "server"]);
  });
});

describe("resolveCatalogSlug", () => {
  const makeFetch =
    (servers: CatalogServer[]): FetchCatalog =>
    async () =>
      servers;

  it("returns the matching resolved server for a known slug", async () => {
    const servers: CatalogServer[] = [
      {
        slug: "my-server",
        name: "My Server",
        install: { command: "npx -y my-server" },
        requiredEnv: [{ key: "MY_API_KEY", label: "API key" }],
        repo: "https://github.com/example/my-server",
      },
    ];
    const result = await resolveCatalogSlug("my-server", { fetchCatalog: makeFetch(servers) });
    expect(result.slug).toBe("my-server");
    expect(result.name).toBe("My Server");
    expect(result.command).toBe("npx");
    expect(result.args).toEqual(["-y", "my-server"]);
    expect(result.requiredEnvKeys).toEqual(["MY_API_KEY"]);
  });

  it("throws for an unknown slug", async () => {
    const servers: CatalogServer[] = [{ slug: "existing-server", install: { command: "npx existing-server" } }];
    await expect(resolveCatalogSlug("no-such-slug", { fetchCatalog: makeFetch(servers) })).rejects.toThrow(
      'no server with slug "no-such-slug"',
    );
  });

  // -------------------------------------------------------------------------
  // Remote-server refusal. A remote/HTTP entry has no stdio spawn command, so
  // tokenizing its URL would write a broken bundles.json entry that fails at
  // spawn time with a far less obvious error. Mirrors the app's resolveSlug.
  // -------------------------------------------------------------------------

  it.each([
    ["install.url set", { url: "https://mcp.example.com/sse" }],
    ["install.type remote", { type: "remote", command: "npx -y ignored" }],
    ["runtime remote", { runtime: "remote", command: "npx -y ignored" }],
    ["runtime http", { runtime: "http", command: "npx -y ignored" }],
    ["runtime https", { runtime: "HTTPS", command: "npx -y ignored" }],
    ["runtime sse", { runtime: "sse", command: "npx -y ignored" }],
    ["runtime url", { runtime: "url", command: "npx -y ignored" }],
  ])("refuses a remote server (%s)", async (_label, install) => {
    const servers: CatalogServer[] = [{ slug: "remote-one", install }];
    await expect(resolveCatalogSlug("remote-one", { fetchCatalog: makeFetch(servers) })).rejects.toThrow(
      '"remote-one" is a remote server -- add it from the Yaw MCP dashboard, not the local CLI.',
    );
  });

  it("does not treat a runtime that merely contains 'http' as remote", async () => {
    // The refusal regex is anchored, so `httpie`-style runtimes stay local.
    const servers: CatalogServer[] = [{ slug: "local-one", install: { runtime: "httpie", command: "npx -y local" } }];
    const result = await resolveCatalogSlug("local-one", { fetchCatalog: makeFetch(servers) });
    expect(result.command).toBe("npx");
  });

  // -------------------------------------------------------------------------
  // Missing / empty install command.
  // -------------------------------------------------------------------------

  it.each([
    ["no install block at all", undefined],
    ["install with no command", {}],
    ["empty command string", { command: "" }],
    ["whitespace-only command", { command: "   \t  " }],
    ["non-string command", { command: 42 as unknown as string }],
  ])("throws when the entry has no usable install command (%s)", async (_label, install) => {
    const servers: CatalogServer[] = [{ slug: "broken", install }];
    await expect(resolveCatalogSlug("broken", { fetchCatalog: makeFetch(servers) })).rejects.toThrow(
      'catalog entry "broken" has no install command.',
    );
  });

  it("propagates an unbalanced-quote tokenize failure rather than swallowing it", async () => {
    const servers: CatalogServer[] = [{ slug: "quoted", install: { command: `npx -y "unterminated` } }];
    await expect(resolveCatalogSlug("quoted", { fetchCatalog: makeFetch(servers) })).rejects.toThrow(
      "Unbalanced quote",
    );
  });

  // -------------------------------------------------------------------------
  // requiredEnv key filtering. Only well-formed shell identifiers survive:
  // the keys go on to be written into a config and exported into a spawned
  // process env, so a key with a dash / leading digit / whitespace is dropped
  // rather than propagated into a launch that would fail opaquely.
  // -------------------------------------------------------------------------

  it("keeps only valid env identifiers and drops malformed requiredEnv entries", async () => {
    const servers: CatalogServer[] = [
      {
        slug: "envy",
        install: { command: "npx envy" },
        requiredEnv: [
          { key: "GOOD_KEY" },
          { key: "_LEADING_UNDERSCORE" },
          { key: "Mixed9Case" },
          { key: "HAS-DASH" },
          { key: "1LEADING_DIGIT" },
          { key: "HAS SPACE" },
          { key: "" },
          { key: 5 as unknown as string },
          {} as never,
          null as never,
          "GOOD_KEY_BUT_A_STRING" as never,
        ],
      },
    ];
    const result = await resolveCatalogSlug("envy", { fetchCatalog: makeFetch(servers) });
    expect(result.requiredEnvKeys).toEqual(["GOOD_KEY", "_LEADING_UNDERSCORE", "Mixed9Case"]);
  });

  it("returns an empty requiredEnvKeys list when requiredEnv is absent or not an array", async () => {
    const servers: CatalogServer[] = [
      { slug: "none", install: { command: "npx none" } },
      { slug: "bogus", install: { command: "npx bogus" }, requiredEnv: "NOT_AN_ARRAY" as never },
    ];
    const fetchCatalog = makeFetch(servers);
    expect((await resolveCatalogSlug("none", { fetchCatalog })).requiredEnvKeys).toEqual([]);
    expect((await resolveCatalogSlug("bogus", { fetchCatalog })).requiredEnvKeys).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Name / source fallbacks.
  // -------------------------------------------------------------------------

  it("falls back to the slug when name is missing or blank, and to homepage when repo is absent", async () => {
    const servers: CatalogServer[] = [
      { slug: "no-name", install: { command: "npx x" }, homepage: "https://example.com/home" },
      { slug: "blank-name", name: "   ", install: { command: "npx x" } },
    ];
    const fetchCatalog = makeFetch(servers);
    const noName = await resolveCatalogSlug("no-name", { fetchCatalog });
    expect(noName.name).toBe("no-name");
    expect(noName.source).toBe("https://example.com/home");
    expect(noName.docUrl).toBe("https://example.com/home");
    expect((await resolveCatalogSlug("blank-name", { fetchCatalog })).name).toBe("blank-name");
  });

  it("passes the catalog URL through to the injected fetcher", async () => {
    const fetchCatalog = vi.fn<FetchCatalog>().mockResolvedValue([{ slug: "s", install: { command: "npx s" } }]);
    await resolveCatalogSlug("s", { fetchCatalog, catalogUrl: "https://mirror.example/catalog.json" });
    expect(fetchCatalog).toHaveBeenCalledWith("https://mirror.example/catalog.json");
    await resolveCatalogSlug("s", { fetchCatalog });
    expect(fetchCatalog).toHaveBeenLastCalledWith(DEFAULT_CATALOG_URL);
  });
});

describe("defaultFetchCatalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(impl: (...args: unknown[]) => unknown): ReturnType<typeof vi.fn> {
    const f = vi.fn(impl);
    vi.stubGlobal("fetch", f);
    return f;
  }

  it("returns the servers array and requests JSON from the default URL", async () => {
    const f = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ servers: [{ slug: "a" }, { slug: "b", name: "B" }] }),
    }));
    const servers = await defaultFetchCatalog();
    expect(servers.map((s) => s.slug)).toEqual(["a", "b"]);
    const [url, init] = f.mock.calls[0] as [string, { headers: Record<string, string>; signal: AbortSignal }];
    expect(url).toBe(DEFAULT_CATALOG_URL);
    expect(init.headers.accept).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("drops entries that are not objects or carry no string slug", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ servers: [{ slug: "keep" }, null, "nope", 7, { name: "no slug" }, { slug: 12 }] }),
    }));
    expect((await defaultFetchCatalog()).map((s) => s.slug)).toEqual(["keep"]);
  });

  it("throws a friendly error on a non-2xx response", async () => {
    stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(defaultFetchCatalog("https://cat.example/c.json")).rejects.toThrow(
      "the Yaw MCP catalog at https://cat.example/c.json returned HTTP 503.",
    );
  });

  it.each([
    ["a bare array", []],
    ["an object with no servers key", { data: [] }],
    ["servers as a non-array", { servers: { a: 1 } }],
    ["null", null],
  ])("throws a shape error when the payload is %s", async (_label, payload) => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => payload }));
    await expect(defaultFetchCatalog("https://cat.example/c.json")).rejects.toThrow(
      "the Yaw MCP catalog at https://cat.example/c.json was not in the expected shape.",
    );
  });

  it("reports an abort as a timeout, not as a raw AbortError", async () => {
    stubFetch(async () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    await expect(defaultFetchCatalog("https://cat.example/c.json")).rejects.toThrow(
      "timed out fetching the Yaw MCP catalog at https://cat.example/c.json.",
    );
  });

  it("aborts the request once FETCH_TIMEOUT_MS elapses", async () => {
    vi.useFakeTimers();
    try {
      let captured: AbortSignal | undefined;
      stubFetch(
        (_url: unknown, init: unknown) =>
          new Promise((_resolve, reject) => {
            captured = (init as { signal: AbortSignal }).signal;
            captured.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const p = defaultFetchCatalog("https://cat.example/c.json");
      const assertion = expect(p).rejects.toThrow("timed out fetching");
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(captured?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rethrows a transport failure as an Error", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(defaultFetchCatalog()).rejects.toThrow("fetch failed");
  });

  it("wraps a non-Error rejection in an Error", async () => {
    stubFetch(async () => {
      throw "string rejection";
    });
    await expect(defaultFetchCatalog()).rejects.toThrow("string rejection");
  });
});
