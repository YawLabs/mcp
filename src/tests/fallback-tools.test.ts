import { describe, expect, it } from "vitest";
import { fallbackToolsFor } from "../fallback-tools.js";

// fallback-tools.ts: the bundled tool lists for well-known servers whose tool
// list is often never learned. What is pinned here is the identity match --
// the image or binary the entry runs, never the namespace -- and the shape of
// the lists themselves. When the server ranks on them is server.ts's business
// (tool-guidance.test.ts).

const docker = (...rest: string[]) => ({ command: "docker", args: ["run", "-i", "--rm", ...rest] });

describe("fallbackToolsFor", () => {
  it("matches the three docker images by repository, with or without a tag or digest", () => {
    const gh = fallbackToolsFor(docker("-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"));
    expect(gh?.some((t) => t.name === "issue_write")).toBe(true);
    expect(fallbackToolsFor(docker("ghcr.io/github/github-mcp-server:v2.1.0"))).toBe(gh);
    expect(fallbackToolsFor(docker("ghcr.io/github/github-mcp-server@sha256:abc"))).toBe(gh);

    const tf = fallbackToolsFor(docker("-e", "TFE_TOKEN", "hashicorp/terraform-mcp-server"));
    expect(tf?.map((t) => t.name)).toContain("search_modules");
    expect(fallbackToolsFor(docker("docker.io/hashicorp/terraform-mcp-server:1.4.1"))).toBe(tf);

    const vault = fallbackToolsFor({ command: "podman", args: ["run", "-i", "hashicorp/vault-mcp-server"] });
    expect(vault?.map((t) => t.name)).toContain("read_secret");
  });

  it("matches the server's own binary, by basename and without .exe", () => {
    expect(fallbackToolsFor({ command: "C:\\tools\\vault-mcp-server.exe", args: ["stdio"] })).toBe(
      fallbackToolsFor(docker("hashicorp/vault-mcp-server")),
    );
    expect(fallbackToolsFor({ command: "/usr/local/bin/github-mcp-server", args: ["stdio"] })).toBe(
      fallbackToolsFor(docker("ghcr.io/github/github-mcp-server")),
    );
  });

  it("never matches on a name the user chose, an env var, another image or a remote entry", () => {
    // A fork's image, the old npm server (a different tool set), and the
    // image name passed to something that is not a container runtime.
    expect(fallbackToolsFor(docker("-e", "GITHUB_TOKEN", "someone/github-mcp-fork"))).toBeUndefined();
    expect(fallbackToolsFor({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] })).toBeUndefined();
    expect(fallbackToolsFor({ command: "node", args: ["ghcr.io/github/github-mcp-server"] })).toBeUndefined();
    expect(fallbackToolsFor({})).toBeUndefined();
  });

  it("lists names and one-line descriptions, unique per server, at the sizes read from upstream", () => {
    const lists = [
      [docker("ghcr.io/github/github-mcp-server"), 44],
      [docker("hashicorp/terraform-mcp-server"), 9],
      [docker("hashicorp/vault-mcp-server"), 16],
    ] as const;
    for (const [launch, size] of lists) {
      const tools = fallbackToolsFor(launch) ?? [];
      expect(tools).toHaveLength(size);
      expect(new Set(tools.map((t) => t.name)).size).toBe(size);
      for (const t of tools) {
        expect(t.name).toMatch(/^[a-z0-9_]+$/);
        expect(t.description.length).toBeGreaterThan(0);
        expect(t.description).not.toContain("\n");
      }
    }
    // ui_get is registered for MCP App views only, so the model never sees it.
    expect(fallbackToolsFor(docker("ghcr.io/github/github-mcp-server"))?.map((t) => t.name)).not.toContain("ui_get");
  });
});
