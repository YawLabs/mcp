// Full-pass regressions for server.ts policy surfaces: the refusal Note under
// a broken policy file, the connected-path identity wording, and the
// empty-state answers of find_tool / secrets report. Setup copied from
// policy-hardening.test.ts ("the broker applies the policy on every path").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sidecar-refresh.js", () => ({
  maybeRefreshSidecars: vi.fn().mockResolvedValue(undefined),
}));

import { ConnectServer } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";

function local(namespace: string, command: string, args: string[] = []): UpstreamServerConfig {
  return { id: namespace, name: namespace, namespace, type: "local", command, args, isActive: true };
}

const SSH = local("ssh", "npx", ["-y", "@example/ssh-mcp@1.0.0"]);
const SSH2 = local("ssh2", "npx", ["-y", "@example/ssh-mcp@2.0.0"]);

describe("spawn-gate refusal Note under a broken policy file", () => {
  let priv: any;
  const message = "/cfg/config.json: invalid JSON at line 1. Fix it.";

  beforeEach(() => {
    priv = new ConnectServer() as any;
    priv.profile = {
      path: "/cfg/config.json",
      policyErrors: [{ path: "/cfg/config.json", message }],
      // What config-loader's fold produces.
      policyWarnings: [message],
    };
  });

  it("still names the policy error on a DISABLED server's refusal", async () => {
    // spawnGateVerdict returns "disabled" before it checks policyErrors, and
    // the disabled sentence carries no policy message -- so the Note is the
    // only place the broken file is mentioned. It must not be deduped away.
    priv.config = { servers: [{ ...SSH, isActive: false }], configVersion: "" };
    const text = priv.spawnGateRefusal(priv.config.servers[0], "activate") as string;
    expect(text).toContain("is installed but disabled");
    expect(text.split(message).length - 1).toBe(1);
  });

  it("does so through mcp_connect_activate too", async () => {
    priv.config = { servers: [{ ...SSH, isActive: false }], configVersion: "" };
    const activate = await priv.handleToolCall("mcp_connect_activate", { server: "ssh" });
    expect(activate.isError).toBe(true);
    const text = activate.content[0].text as string;
    expect(text).toContain("disabled");
    expect(text).toContain(message);
  });

  it("prints the message once on a policy-invalid refusal", () => {
    priv.config = { servers: [SSH], configVersion: "" };
    const text = priv.spawnGateRefusal(SSH, "activate") as string;
    expect(text.split(message).length - 1).toBe(1);
  });

  it("names the server before the purpose, so 'its' has an antecedent", () => {
    priv.config = { servers: [SSH], configVersion: "" };
    expect(priv.spawnGateRefusal(SSH, "inspect its tools")).toMatch(/^"ssh": cannot inspect its tools\. /);
    expect(priv.spawnGateRefusal(SSH, "activate")).not.toContain("Cannot activate for");
  });
});

describe("connected-path refusal names the identity block", () => {
  let priv: any;
  let callTool: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    priv = new ConnectServer() as any;
    callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "SECRET" }] });
    priv.config = { servers: [SSH, SSH2], configVersion: "" };
    priv.connections.set("ssh2", {
      config: SSH2,
      client: { callTool, close: vi.fn() },
      transport: {},
      tools: [{ name: "run", namespacedName: "ssh2_run", inputSchema: { type: "object" } }],
      resources: [],
      prompts: [],
      health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0, resultBytesUpstream: 0, resultBytesDownstream: 0 },
      status: "connected",
    } as unknown as UpstreamConnection);
    priv.rebuildRoutes();
  });

  it("tells the model which blocked entry to remove", async () => {
    priv.profile = { path: "/cfg/config.json", blocked: ["ssh"] };
    const result = await priv.handleToolCall("ssh2_run", {});
    expect(result.isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
    const text = JSON.stringify(result);
    expect(text).toContain("not allowed by the project profile");
    expect(text).toContain('the same server as a \\"blocked\\" entry');
  });

  it("adds no identity clause for a plain block", () => {
    priv.profile = { path: "/cfg/config.json", blocked: ["ssh2"] };
    const text = priv.serverPolicyRefusal("ssh2") as string;
    expect(text).toContain("not allowed by the project profile");
    expect(text).not.toContain('blocked" entry');
  });
});

describe("empty-state answers name the real state, flagged as errors", () => {
  let priv: any;

  beforeEach(() => {
    priv = new ConnectServer() as any;
  });

  it("find_tool with every server disabled says so, with isError", async () => {
    priv.config = { servers: [{ ...SSH, isActive: false }], configVersion: "" };
    const result = await priv.handleFindTool("run a command");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(priv.noServersEnabledText());
  });

  it("secrets report without a server arg does not claim 'no references' when nothing is usable", async () => {
    priv.config = {
      servers: [{ ...SSH, isActive: false, env: { TOKEN: "${secret:ssh}" } }],
      configVersion: "",
    };
    const result = await priv.handleSecretsReport();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("references any");
    expect(result.content[0].text).toBe(priv.noServersEnabledText());
  });

  it("secrets report under a broken policy file reports the policy error", async () => {
    const message = "/cfg/config.json: invalid JSON at line 1. Fix it.";
    priv.profile = { path: "/cfg/config.json", policyErrors: [{ path: "/cfg/config.json", message }] };
    priv.config = { servers: [{ ...SSH, env: { TOKEN: "${secret:ssh}" } }], configVersion: "" };
    const result = await priv.handleSecretsReport();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(message);
  });
});

describe("pre-warm skips a server the compliance floor refuses", () => {
  const saved = process.env.YAW_MCP_MIN_COMPLIANCE;
  afterEach(() => {
    if (saved === undefined) delete process.env.YAW_MCP_MIN_COMPLIANCE;
    else process.env.YAW_MCP_MIN_COMPLIANCE = saved;
  });

  it("is not counted as still learning", () => {
    process.env.YAW_MCP_MIN_COMPLIANCE = "B";
    const priv = new ConnectServer() as any;
    priv.config = {
      servers: [
        { ...SSH, complianceGrade: "F" },
        { ...SSH2, complianceGrade: "A" },
      ],
      configVersion: "",
    };
    const learning = priv.serversPrewarmIsLearning().map((s: UpstreamServerConfig) => s.namespace);
    expect(learning).toEqual(["ssh2"]);
    delete process.env.YAW_MCP_MIN_COMPLIANCE;
    expect(
      priv
        .serversPrewarmIsLearning()
        .map((s: UpstreamServerConfig) => s.namespace)
        .sort(),
    ).toEqual(["ssh", "ssh2"]);
  });
});

describe("discover's already-connected shortcut honours the cap on a prewarm claim", () => {
  it("leaves the prewarm claim and says why when the cap refuses", async () => {
    const priv = new ConnectServer() as any;
    priv.config = { servers: [SSH], configVersion: "" };
    priv.connections.set("ssh", {
      config: SSH,
      client: { close: vi.fn() },
      transport: {},
      tools: [{ name: "run", namespacedName: "ssh_run", inputSchema: { type: "object" } }],
      resources: [],
      prompts: [],
      health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0, resultBytesUpstream: 0, resultBytesDownstream: 0 },
      status: "connected",
    } as unknown as UpstreamConnection);
    priv.prewarmNamespaces.add("ssh");
    priv.routingCandidates = async () => [{ namespace: "ssh", score: 100, coverage: 1 }];
    priv.evaluateCapFor = () => ({ allow: false, message: "server cap reached" });
    const onWarmed = vi.fn();
    const result = await priv.handleDiscoverWithAutoWarm("run a command", undefined, undefined, onWarmed);
    expect(priv.prewarmNamespaces.has("ssh")).toBe(true);
    expect(priv.sessionActivated.has("ssh")).toBe(false);
    expect(onWarmed).not.toHaveBeenCalled();
    const text = result.content.map((c: { text: string }) => c.text).join("\n");
    expect(text).toContain('Could not auto-load "ssh"');
    expect(text).toContain("server cap reached");
  });
});
