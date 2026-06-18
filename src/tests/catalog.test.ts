import { describe, expect, it } from "vitest";
import { type CatalogServer, type FetchCatalog, resolveCatalogSlug, tokenizeCommand } from "../catalog.js";

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
});
