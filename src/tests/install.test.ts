import { describe, expect, it } from "vitest";
import { buildInstallPayload, META_TOOL_NAMES, META_TOOLS } from "../meta-tools.js";

describe("META_TOOLS.install — tool definition", () => {
  it("is registered under the mcp_connect_install name", () => {
    expect(META_TOOLS.install.name).toBe("mcp_connect_install");
    expect(META_TOOL_NAMES.has("mcp_connect_install")).toBe(true);
  });

  it("requires name, namespace, and type", () => {
    expect(META_TOOLS.install.inputSchema.required).toEqual(["name", "namespace", "type"]);
  });

  it("advertises install as non-readonly and open-world", () => {
    expect(META_TOOLS.install.annotations.readOnlyHint).toBe(false);
    expect(META_TOOLS.install.annotations.openWorldHint).toBe(true);
  });
});

describe("buildInstallPayload — happy paths", () => {
  it("accepts a minimal local server", () => {
    const r = buildInstallPayload({
      name: "GitHub",
      namespace: "gh",
      type: "local",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toEqual({
      name: "GitHub",
      namespace: "gh",
      type: "local",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
  });

  it("accepts a minimal remote server", () => {
    const r = buildInstallPayload({
      name: "Notion",
      namespace: "notion",
      type: "remote",
      url: "https://mcp.notion.com/mcp",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.type).toBe("remote");
    expect(r.payload.url).toBe("https://mcp.notion.com/mcp");
  });

  it("passes env through when valid", () => {
    const r = buildInstallPayload({
      name: "GitHub",
      namespace: "gh",
      type: "local",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "ghp_x" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.env).toEqual({ GITHUB_TOKEN: "ghp_x" });
  });

  it("trims name and namespace whitespace", () => {
    const r = buildInstallPayload({
      name: "  GitHub  ",
      namespace: "  gh  ",
      type: "local",
      command: "npx",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.name).toBe("GitHub");
    expect(r.payload.namespace).toBe("gh");
  });

  it("preserves description when provided", () => {
    const r = buildInstallPayload({
      name: "GitHub",
      namespace: "gh",
      type: "local",
      command: "npx",
      description: "Issues, PRs, repos.",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.description).toBe("Issues, PRs, repos.");
  });

  it("drops description that trims to empty", () => {
    const r = buildInstallPayload({
      name: "GitHub",
      namespace: "gh",
      type: "local",
      command: "npx",
      description: "   ",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.description).toBeUndefined();
  });
});

describe("buildInstallPayload — rejects invalid input", () => {
  it("rejects missing name", () => {
    const r = buildInstallPayload({ namespace: "gh", type: "local", command: "npx" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/name/i);
  });

  it("rejects name > 100 chars", () => {
    const r = buildInstallPayload({
      name: "a".repeat(101),
      namespace: "gh",
      type: "local",
      command: "npx",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/100/);
  });

  it("rejects missing namespace", () => {
    const r = buildInstallPayload({ name: "GH", type: "local", command: "npx" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/namespace/i);
  });

  it("rejects namespace that violates the regex", () => {
    const r = buildInstallPayload({ name: "GH", namespace: "My-Server", type: "local", command: "npx" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/namespace/i);
  });

  it("rejects namespace longer than 30 chars", () => {
    const r = buildInstallPayload({ name: "GH", namespace: "a".repeat(31), type: "local", command: "npx" });
    expect(r.ok).toBe(false);
  });

  it("rejects missing type", () => {
    const r = buildInstallPayload({ name: "GH", namespace: "gh" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/type/i);
  });

  it("rejects unknown type values", () => {
    const r = buildInstallPayload({ name: "GH", namespace: "gh", type: "proxy" });
    expect(r.ok).toBe(false);
  });

  it("rejects local without command", () => {
    const r = buildInstallPayload({ name: "GH", namespace: "gh", type: "local" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/command/i);
  });

  it("rejects remote without url", () => {
    const r = buildInstallPayload({ name: "Notion", namespace: "notion", type: "remote" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/url/i);
  });

  it("rejects remote with non-URL garbage", () => {
    const r = buildInstallPayload({ name: "Notion", namespace: "notion", type: "remote", url: "not a url" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/url/i);
  });

  it("rejects remote with a non-http scheme", () => {
    const r = buildInstallPayload({ name: "Notion", namespace: "notion", type: "remote", url: "ftp://foo/bar" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/http/i);
  });

  it("rejects remote with plaintext http:// for a public host (credential leak)", () => {
    const r = buildInstallPayload({
      name: "Notion",
      namespace: "notion",
      type: "remote",
      url: "http://mcp.notion.com/sse",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/https:/);
  });

  it("accepts http://localhost for dev servers", () => {
    const r = buildInstallPayload({
      name: "Dev",
      namespace: "dev",
      type: "remote",
      url: "http://localhost:3000/sse",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts http://127.0.0.1 for dev servers", () => {
    const r = buildInstallPayload({
      name: "Dev",
      namespace: "dev",
      type: "remote",
      url: "http://127.0.0.1:3000/sse",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts http://[::1] for dev servers", () => {
    const r = buildInstallPayload({
      name: "Dev",
      namespace: "dev",
      type: "remote",
      url: "http://[::1]:3000/sse",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects args that isn't an array", () => {
    const r = buildInstallPayload({
      name: "GH",
      namespace: "gh",
      type: "local",
      command: "npx",
      args: "not-an-array",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects args with non-string entries", () => {
    const r = buildInstallPayload({
      name: "GH",
      namespace: "gh",
      type: "local",
      command: "npx",
      args: ["-y", 42],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects more than 50 args", () => {
    const r = buildInstallPayload({
      name: "GH",
      namespace: "gh",
      type: "local",
      command: "npx",
      args: Array.from({ length: 51 }, (_, i) => `a${i}`),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/50/);
  });

  it("rejects env that isn't a plain object", () => {
    const r = buildInstallPayload({
      name: "GH",
      namespace: "gh",
      type: "local",
      command: "npx",
      env: ["GITHUB_TOKEN=x"],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects env with non-string values", () => {
    const r = buildInstallPayload({
      name: "GH",
      namespace: "gh",
      type: "local",
      command: "npx",
      env: { GITHUB_TOKEN: 42 },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects more than 50 env keys", () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 51; i++) env[`K${i}`] = "v";
    const r = buildInstallPayload({
      name: "GH",
      namespace: "gh",
      type: "local",
      command: "npx",
      env,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects description > 500 chars", () => {
    const r = buildInstallPayload({
      name: "GH",
      namespace: "gh",
      type: "local",
      command: "npx",
      description: "x".repeat(501),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/500/);
  });
});

describe("buildInstallPayload — JSON serialization contract", () => {
  // The payload is JSON.stringified into the POST body. Verify it
  // round-trips cleanly (no undefined keys leaking, no functions).
  it("serializes cleanly with no extra keys", () => {
    const r = buildInstallPayload({
      name: "GitHub",
      namespace: "gh",
      type: "local",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(JSON.stringify(r.payload));
    expect(parsed).toEqual({
      name: "GitHub",
      namespace: "gh",
      type: "local",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
  });

  it("omits optional fields when not provided", () => {
    const r = buildInstallPayload({ name: "Notion", namespace: "notion", type: "remote", url: "https://ex.com" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const serialized = JSON.stringify(r.payload);
    expect(serialized).not.toContain("env");
    expect(serialized).not.toContain("args");
    expect(serialized).not.toContain("description");
    expect(serialized).not.toContain("command");
  });
});
