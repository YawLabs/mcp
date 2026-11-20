// The allow/deny policy as a security control: a project config cannot widen
// the user's allow-list, a damaged policy file refuses spawns, denies follow a
// server across namespaces, and every path to an upstream honors them.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sidecar-refresh.js", () => ({
  maybeRefreshSidecars: vi.fn().mockResolvedValue(undefined),
}));

import { runCall } from "../call-cmd.js";
import {
  CONFIG_FILENAME,
  isAllowed,
  LOCAL_CONFIG_FILENAME,
  loadYawMcpConfig,
  type Profile,
  toProfile,
} from "../config-loader.js";
import { CONFIG_DIRNAME } from "../paths.js";
import { ConnectServer } from "../server.js";
import { serverIdentity } from "../server-identity.js";
import { effectiveProfile, isToolDenied, spawnGateVerdict } from "../spawn-gate.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";

function local(namespace: string, command: string, args: string[] = []): UpstreamServerConfig {
  return { id: namespace, name: namespace, namespace, type: "local", command, args, isActive: true };
}

function remote(namespace: string, url: string): UpstreamServerConfig {
  return { id: namespace, name: namespace, namespace, type: "remote", url, isActive: true };
}

const SSH = local("ssh", "npx", ["-y", "@example/ssh-mcp@1.0.0"]);
const SSH2 = local("ssh2", "npx", ["-y", "@example/ssh-mcp@2.0.0"]);
const OTHER = local("other", "npx", ["-y", "@example/other-mcp"]);

let home: string;
let cwd: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "yaw-policy-")));
  cwd = realpathSync(mkdtempSync(join(home, "cwd-")));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeRaw(dir: string, filename: string, text: string): string {
  const cfgDir = join(dir, CONFIG_DIRNAME);
  mkdirSync(cfgDir, { recursive: true });
  const file = join(cfgDir, filename);
  writeFileSync(file, text);
  return file;
}

const write = (dir: string, filename: string, value: unknown): string => writeRaw(dir, filename, JSON.stringify(value));

const load = () => loadYawMcpConfig({ cwd, home, env: {} });

describe("a project config can only narrow the global allow-list", () => {
  it("drops a server the global list leaves out, and says so", async () => {
    const globalFile = write(home, CONFIG_FILENAME, { servers: ["postgres"] });
    const projectFile = write(cwd, CONFIG_FILENAME, { servers: ["ssh"] });
    const r = await load();
    expect(r.servers).toEqual([]);
    expect(isAllowed(r, "ssh")).toBe(false);
    expect(isAllowed(r, "postgres")).toBe(false);
    const w = r.warnings.find((x) => x.includes("'ssh'"));
    expect(w).toContain(projectFile);
    expect(w).toContain(globalFile);
  });

  it("keeps the overlap, so narrowing works", async () => {
    write(home, CONFIG_FILENAME, { servers: ["postgres", "gh"] });
    write(cwd, CONFIG_FILENAME, { servers: ["gh"] });
    const r = await load();
    expect(r.servers).toEqual(["gh"]);
    expect(r.warnings).toEqual([]);
  });

  it("holds config.local.json to the same limit", async () => {
    write(home, CONFIG_FILENAME, { servers: ["postgres"] });
    write(cwd, LOCAL_CONFIG_FILENAME, { servers: ["ssh", "postgres"] });
    expect((await load()).servers).toEqual(["postgres"]);
  });

  it("leaves a project list alone when there is no global list", async () => {
    write(cwd, CONFIG_FILENAME, { servers: ["ssh"] });
    expect((await load()).servers).toEqual(["ssh"]);
  });
});

describe("a damaged policy fails closed", () => {
  it("treats an explicit empty allow-list as allow nothing", async () => {
    write(home, CONFIG_FILENAME, { servers: [] });
    const profile = toProfile(await load());
    expect(spawnGateVerdict(SSH, profile, null)?.kind).toBe("profile");
  });

  it.each([
    ["truncated JSON", '{ "servers": ["gh"', "invalid JSON"],
    ["a non-object root", "[1]", "JSON object"],
    ["a string allow-list", '{ "servers": "gh" }', "'servers' must be an array"],
    ["a non-string entry", '{ "servers": ["gh", 1] }', "non-string or empty"],
    ["a wrong-typed deny-list", '{ "blocked": "gh" }', "'blocked' must be an array"],
    ["a wrong-typed tool deny", '{ "blockedTools": 1 }', "'blockedTools' must be an array"],
  ])("refuses every spawn on %s, naming the file and the fix", async (_name, text, problem) => {
    const file = writeRaw(home, CONFIG_FILENAME, text);
    const config = await load();
    const refusal = spawnGateVerdict(SSH, toProfile(config), null);
    expect(refusal?.kind).toBe("policy-invalid");
    const message = refusal?.kind === "policy-invalid" ? refusal.errors[0].message : "";
    expect(message).toContain(file);
    expect(message).toContain(problem);
    expect(message).toContain("yaw-mcp doctor");
    expect(config.warnings).toContain(message);
  });

  it("refuses when the file exists but cannot be read", async () => {
    mkdirSync(join(home, CONFIG_DIRNAME, CONFIG_FILENAME), { recursive: true });
    expect(spawnGateVerdict(SSH, toProfile(await load()), null)?.kind).toBe("policy-invalid");
  });

  it("a broken project file is not rescued by a valid global one", async () => {
    write(home, CONFIG_FILENAME, { servers: ["ssh"] });
    writeRaw(cwd, CONFIG_FILENAME, "{");
    expect(spawnGateVerdict(SSH, toProfile(await load()), null)?.kind).toBe("policy-invalid");
  });

  it("a missing file still means no policy", async () => {
    const config = await load();
    expect(config.policyErrors).toBeUndefined();
    expect(toProfile(config)).toBeNull();
    expect(spawnGateVerdict(SSH, null, null)).toBeNull();
  });
});

describe("serverIdentity", () => {
  it.each([
    [local("a", "npx", ["-y", "@s/p@1.2.3"]), "package:@s/p"],
    [local("a", "npx", ["--package=@s/p", "bin"]), "package:@s/p"],
    [local("a", "cmd", ["/c", "npx", "-y", "@s/p"]), "package:@s/p"],
    [local("a", "uvx", ["--from", "mcp-x", "run-x"]), "package:mcp-x"],
    [local("a", "uv", ["tool", "run", "mcp-x"]), "package:mcp-x"],
    [local("a", "pnpm", ["dlx", "mcp-x"]), "package:mcp-x"],
    [local("a", "docker", ["run", "--rm", "-e", "K=V", "img/x"]), "package:img/x"],
    [local("a", "python", ["-m", "mcp_x"]), "package:mcp-x"],
    [local("a", "python3.12", ["-um", "mcp_x"]), "package:mcp-x"],
    [local("a", "docker", ["run", "-it", "--cap-drop", "ALL", "--pull", "always", "img/x:1"]), "package:img/x"],
    [local("a", "podman", ["container", "run", "docker.io/library/alpine:3"]), "package:alpine"],
    [local("a", "uvx", ["--python", "3.12", "mcp-x==1.0"]), "package:mcp-x"],
    [local("a", "uvx", ["mcp_x[extra]>=1"]), "package:mcp-x"],
    [local("a", "npx", ["-y", "--registry", "https://r.example.test", "@s/p@1"]), "package:@s/p"],
    [local("a", "node", ["-r", "dotenv/config", "/opt/a.js"]), "command:/opt/a.js"],
    [local("a", "node", ["--inspect", "/opt/a.js"]), "command:/opt/a.js"],
    [local("a", "node", ["/opt/x/index.js"]), "command:/opt/x/index.js"],
    [local("a", "C:\\tools\\Ssh-Mcp.EXE"), "command:c:/tools/ssh-mcp"],
    [local("a", "ssh-mcp.exe"), "command:ssh-mcp"],
    [remote("a", "https://user:pw@Example.com:443/mcp/?t=1#f"), "url:https://example.com/mcp"],
  ])("%#", (server, expected) => {
    expect(serverIdentity(server).primary).toBe(expected);
  });

  it.each([
    [local("a", "npx", [])],
    [local("a", "bash", ["-c", "ssh-mcp"])],
    [local("a", "node", [])],
    [local("a", "npm", ["start"])],
    [local("a", "node", ["-e", "code"])],
    [local("a", "python", ["-c", "code"])],
    [local("a", "npx", ["-c", "some-cli"])],
  ])("gives a generic launch no identity to bind a deny to (%#)", (server) => {
    expect(serverIdentity(server).primary).toBeNull();
  });
});

describe("denies follow the server, not its label", () => {
  const profile = (over: Partial<Profile>): Profile => ({ path: "/cfg/config.json", ...over });
  const all = [SSH, SSH2, OTHER];

  it("a namespace deny on a tool covers the same server under another namespace", () => {
    const tools = effectiveProfile(profile({ blockedTools: ["ssh_ssh_exec"] }), all)?.blockedTools;
    expect(isToolDenied("ssh2_ssh_exec", tools)).toBe(true);
    expect(isToolDenied("ssh_ssh_exec", tools)).toBe(true);
    expect(isToolDenied("other_ssh_exec", tools)).toBe(false);
    expect(isToolDenied("ssh2_ssh_list", tools)).toBe(false);
  });

  it("carries a wildcard across", () => {
    const tools = effectiveProfile(profile({ blockedTools: ["ssh_ssh_*"] }), all)?.blockedTools;
    expect(isToolDenied("ssh2_ssh_exec", tools)).toBe(true);
  });

  it("a namespace deny on a server covers the same server under another namespace", () => {
    const p = profile({ blocked: ["ssh"] });
    const refusal = spawnGateVerdict(SSH2, p, null, all);
    expect(refusal).toMatchObject({ kind: "profile", namespace: "ssh2", identity: "package:@example/ssh-mcp" });
    expect(spawnGateVerdict(OTHER, p, null, all)).toBeNull();
  });

  it("an identity entry still holds once the original namespace is gone", () => {
    const p = profile({ blocked: ["package:@example/ssh-mcp@9"] });
    expect(spawnGateVerdict(SSH2, p, null, [SSH2, OTHER])?.kind).toBe("profile");
    expect(spawnGateVerdict(OTHER, p, null, [SSH2, OTHER])).toBeNull();
  });

  it("an identity tool entry applies under any namespace", () => {
    const tools = effectiveProfile(profile({ blockedTools: ["package:@example/ssh-mcp#ssh_exec"] }), [
      SSH2,
      OTHER,
    ])?.blockedTools;
    expect(isToolDenied("ssh2_ssh_exec", tools)).toBe(true);
    expect(isToolDenied("other_ssh_exec", tools)).toBe(false);
  });

  it("matches url and command identities, ignoring a query string", () => {
    const a = remote("a", "https://mcp.example.test/x");
    const b = remote("b", "https://mcp.example.test/x/?v=2");
    expect(spawnGateVerdict(b, profile({ blocked: ["a"] }), null, [a, b])?.kind).toBe("profile");
    const c = local("c", "/opt/bin/ssh-mcp");
    expect(spawnGateVerdict(c, profile({ blocked: ["command:ssh-mcp"] }), null, [c])?.kind).toBe("profile");
  });

  it("does not let a deny on one npx server take down the others", () => {
    const blocked = effectiveProfile(profile({ blocked: ["other"] }), all)?.blocked;
    expect(blocked).toEqual(["other"]);
  });

  it("accepts identity entries in config without a warning", async () => {
    write(home, CONFIG_FILENAME, {
      blocked: ["package:@example/ssh-mcp", "url:https://mcp.example.test/x", "command:ssh-mcp"],
      blockedTools: ["package:@example/ssh-mcp#ssh_exec"],
    });
    expect((await load()).warnings).toEqual([]);
  });
});

describe("a deny does not spread to unrelated servers", () => {
  const profile = (over: Partial<Profile>): Profile => ({ path: "/cfg/config.json", ...over });

  it.each([
    ["java with different jars", local("a", "java", ["-jar", "a.jar"]), local("b", "java", ["-jar", "b.jar"])],
    ["dotnet with different dlls", local("a", "dotnet", ["a.dll"]), local("b", "dotnet", ["b.dll"])],
    ["echo with different args", local("a", "echo", ["a"]), local("b", "echo", ["b"])],
    ["ssh to different hosts", local("a", "ssh", ["h1", "mcp"]), local("b", "ssh", ["h2", "mcp"])],
    ["wsl with different commands", local("a", "wsl", ["a"]), local("b", "wsl", ["b"])],
    ["env with different commands", local("a", "env", ["X=1", "a"]), local("b", "env", ["X=1", "b"])],
    ["python3.12 scripts", local("a", "python3.12", ["a.py"]), local("b", "python3.12", ["b.py"])],
    ["same-named binaries in two directories", local("a", "/x/srv"), local("b", "/y/srv")],
    ["same-named scripts in two directories", local("a", "node", ["/x/index.js"]), local("b", "node", ["/y/index.js"])],
    [
      "uvx sharing --python",
      local("a", "uvx", ["--python", "3.12", "a"]),
      local("b", "uvx", ["--python", "3.12", "b"]),
    ],
    [
      "images sharing --cap-drop",
      local("a", "docker", ["run", "--cap-drop", "ALL", "img/a"]),
      local("b", "docker", ["run", "--cap-drop", "ALL", "img/b"]),
    ],
    [
      "images sharing an unknown flag's value",
      local("a", "docker", ["run", "--new-flag", "v", "img/a"]),
      local("b", "docker", ["run", "--new-flag", "v", "img/b"]),
    ],
    [
      "node sharing -r",
      local("a", "node", ["-r", "dotenv/config", "a.js"]),
      local("b", "node", ["-r", "dotenv/config", "b.js"]),
    ],
  ])("%s", (_name, a, b) => {
    expect(spawnGateVerdict(b, profile({ blocked: ["a"] }), null, [a, b])).toBeNull();
    const tools = effectiveProfile(profile({ blockedTools: ["a_probe", "a*"] }), [a, b])?.blockedTools;
    expect(isToolDenied("b_probe", tools)).toBe(false);
  });

  it("an explicit command entry still means every launch of that command", () => {
    const a = local("a", "java", ["-jar", "a.jar"]);
    const b = local("b", "/usr/bin/java", ["-jar", "b.jar"]);
    const p = profile({ blocked: ["command:java"] });
    expect(spawnGateVerdict(a, p, null, [a, b])?.kind).toBe("profile");
    expect(spawnGateVerdict(b, p, null, [a, b])?.kind).toBe("profile");
  });

  it("never prints the arguments of an exact launch", () => {
    const a = local("a", "srv", ["--token", "s3cret"]);
    const b = local("b", "/opt/srv", ["--token", "s3cret"]);
    const refusal = spawnGateVerdict(b, profile({ blocked: ["a"] }), null, [a, b]);
    expect(refusal).toMatchObject({ kind: "profile", identity: "command:srv with the same arguments" });
    expect(JSON.stringify(refusal)).not.toContain("s3cret");
  });
});

describe("a deny is not escaped by respelling the launch", () => {
  const profile = (over: Partial<Profile>): Profile => ({ path: "/cfg/config.json", ...over });

  it.each([
    ["an unknown runner flag", local("a", "bunx", ["fake.cjs"]), local("b", "bunx", ["--title", "x", "fake.cjs"])],
    ["a known runner flag", local("a", "npx", ["p"]), local("b", "npx", ["-y", "--registry", "https://r.test", "p"])],
    ["an image tag", local("a", "docker", ["run", "i/x"]), local("b", "docker", ["run", "-i", "--rm", "i/x:1.2"])],
    ["an image digest", local("a", "docker", ["run", "i/x"]), local("b", "docker", ["run", "i/x@sha256:abc"])],
    ["a Python version pin", local("a", "uvx", ["m-x"]), local("b", "uvx", ["m_x==1.0"])],
    ["a uv flag", local("a", "uvx", ["m-x"]), local("b", "uvx", ["--python", "3.12", "m-x"])],
    ["a bare name for a path", local("a", "/opt/srv"), local("b", "srv")],
    ["a relative spelling", local("a", "node", ["./x/a.js"]), local("b", "node", ["x/../x/a.js"])],
    ["an interpreter flag", local("a", "node", ["/x/a.js"]), local("b", "node", ["--title", "t", "/x/a.js"])],
    ["a one-string cmd launch", local("a", "npx", ["p"]), local("b", "cmd", ["/c", "npx -y p"])],
  ])("namespace deny: %s", (_name, a, b) => {
    expect(spawnGateVerdict(b, profile({ blocked: ["a"] }), null, [a, b])?.kind).toBe("profile");
    expect(spawnGateVerdict(a, profile({ blocked: ["b"] }), null, [a, b])?.kind).toBe("profile");
  });

  it.each([
    ["package:ghcr.io/acme/ssh-mcp", local("a", "docker", ["run", "-i", "--rm", "ghcr.io/acme/ssh-mcp:1.2"])],
    ["package:ghcr.io/acme/ssh-mcp:9", local("a", "docker", ["run", "ghcr.io/acme/ssh-mcp@sha256:abc"])],
    ["package:mcp-server-git", local("a", "uvx", ["mcp-server-git==1.0"])],
    ["package:mcp-server-git", local("a", "uvx", ["--python", "3.12", "mcp-server-git"])],
    ["package:@example/ssh-mcp", local("a", "npx", ["-y", "--registry", "https://r.test", "@example/ssh-mcp"])],
    ["package:C:\\tools\\fake.cjs", local("a", "bunx", ["--title", "x", "C:/tools/fake.cjs"])],
    ["package:hidden", local("a", "bunx", ["--unknown", "hidden", "other"])],
  ])("explicit %s (%#)", (entry, server) => {
    expect(spawnGateVerdict(server, profile({ blocked: [entry] }), null, [server])?.kind).toBe("profile");
  });
});

describe("a wildcard deny follows the server", () => {
  const a = local("ssh", "node", ["/x/a.js"]);
  const b = local("zed", "node", ["/x/a.js"]);
  const c = local("other", "node", ["/x/c.js"]);

  it.each(["ssh*", "ss*", "ssh_*"])("%s covers the same server's tools elsewhere", (entry) => {
    const tools = effectiveProfile({ path: "/c", blockedTools: [entry] }, [a, b, c])?.blockedTools;
    expect(isToolDenied("zed_probe", tools)).toBe(true);
    expect(isToolDenied("other_probe", tools)).toBe(false);
  });

  it("survives loading from config.json", async () => {
    write(home, CONFIG_FILENAME, { blockedTools: ["ssh*"] });
    const config = await load();
    expect(config.warnings).toEqual([]);
    const tools = effectiveProfile(toProfile(config), [a, b, c])?.blockedTools;
    expect(isToolDenied("ssh_probe", tools)).toBe(true);
    expect(isToolDenied("zed_probe", tools)).toBe(true);
  });

  it("a narrower wildcard stays narrow", () => {
    const tools = effectiveProfile({ path: "/c", blockedTools: ["ssh_drop*"] }, [a, b])?.blockedTools;
    expect(isToolDenied("zed_drop_all", tools)).toBe(true);
    expect(isToolDenied("zed_list", tools)).toBe(false);
  });
});

describe("yaw-mcp call applies the same policy", () => {
  function setup(config: string): { spawned: string[]; called: string[]; connect: any; err: () => string; opts: any } {
    write(home, "bundles.json", {
      version: 1,
      servers: [SSH, SSH2].map(({ namespace, name, type, command, args, isActive }) => ({
        namespace,
        name,
        type,
        command,
        args,
        isActive,
      })),
    });
    writeRaw(home, CONFIG_FILENAME, config);
    const spawned: string[] = [];
    const called: string[] = [];
    const connect = async (cfg: UpstreamServerConfig, use: (c: UpstreamConnection) => Promise<unknown>) => {
      spawned.push(cfg.namespace);
      return use({
        config: cfg,
        client: {
          callTool: async (req: { name: string }) => {
            called.push(req.name);
            return { content: [] };
          },
        },
        tools: [{ name: "ssh_exec", namespacedName: `${cfg.namespace}_ssh_exec`, inputSchema: {} }],
      } as unknown as UpstreamConnection);
    };
    let errText = "";
    return {
      spawned,
      called,
      connect,
      err: () => errText,
      opts: { home, cwd: home, env: {}, out: () => {}, err: (s: string) => (errText += s) },
    };
  }

  it("refuses a tool denied under the server's other namespace, before spawning", async () => {
    const t = setup('{ "blockedTools": ["ssh_ssh_exec"] }');
    const r = await runCall({ namespace: "ssh2", tool: "ssh_exec", connect: t.connect, ...t.opts });
    expect(r.exitCode).toBe(2);
    expect(t.spawned).toEqual([]);
    expect(t.called).toEqual([]);
  });

  it("refuses a server blocked under its other namespace, naming the identity", async () => {
    const t = setup('{ "blocked": ["ssh"] }');
    const r = await runCall({ namespace: "ssh2", tool: "ssh_exec", connect: t.connect, ...t.opts });
    expect(r.exitCode).toBe(2);
    expect(t.spawned).toEqual([]);
    expect(t.err()).toContain("package:@example/ssh-mcp");
  });

  it("refuses when the policy file is broken, naming it", async () => {
    const t = setup('{ "servers": [');
    const r = await runCall({ namespace: "ssh", tool: "ssh_exec", connect: t.connect, ...t.opts });
    expect(r.exitCode).toBe(2);
    expect(t.spawned).toEqual([]);
    expect(t.err()).toContain(join(home, CONFIG_DIRNAME, CONFIG_FILENAME));
  });
});

describe("the broker applies the policy on every path to an upstream", () => {
  let priv: any;
  let readResource: ReturnType<typeof vi.fn>;
  let getPrompt: ReturnType<typeof vi.fn>;
  let callTool: ReturnType<typeof vi.fn>;
  let handlers: Map<string, (request: unknown, ctx?: unknown) => Promise<any>>;

  beforeEach(() => {
    priv = new ConnectServer() as any;
    readResource = vi.fn().mockResolvedValue({ contents: [{ uri: "db://t", text: "SECRET" }] });
    getPrompt = vi.fn().mockResolvedValue({ messages: [] });
    callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "SECRET" }] });
    priv.config = { servers: [SSH, SSH2], configVersion: "" };
    priv.connections.set("ssh2", {
      config: SSH2,
      client: { readResource, getPrompt, callTool, close: vi.fn() },
      transport: {},
      tools: [{ name: "run", namespacedName: "ssh2_run", inputSchema: { type: "object" } }],
      resources: [{ uri: "db://t", namespacedUri: "connect://ssh2/db://t", name: "t" }],
      prompts: [{ name: "p", namespacedName: "ssh2_p" }],
      health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0, resultBytesUpstream: 0, resultBytesDownstream: 0 },
      status: "connected",
    } as unknown as UpstreamConnection);
    priv.rebuildRoutes();
    handlers = new Map();
    priv.installHandlers(
      {
        setRequestHandler: (method: string, fn: (r: unknown, c?: unknown) => Promise<any>) => handlers.set(method, fn),
      },
      undefined,
    );
  });

  const read = () => handlers.get("resources/read")?.({ params: { uri: "connect://ssh2/db://t" } });
  const prompt = () => handlers.get("prompts/get")?.({ params: { name: "ssh2_p", arguments: {} } });

  it("still serves an allowed server", async () => {
    priv.profile = { path: "/cfg/config.json", blocked: ["unrelated"] };
    await read();
    await prompt();
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(getPrompt).toHaveBeenCalledTimes(1);
  });

  it("refuses resources/read and prompts/get on a blocked server", async () => {
    priv.profile = { path: "/cfg/config.json", blocked: ["ssh2"] };
    expect(JSON.stringify(await read())).toContain("not allowed by the project profile");
    expect(JSON.stringify(await prompt())).toContain("not allowed by the project profile");
    expect(readResource).not.toHaveBeenCalled();
    expect(getPrompt).not.toHaveBeenCalled();
  });

  it("refuses them for a server blocked through its identity", async () => {
    priv.profile = { path: "/cfg/config.json", blocked: ["ssh"] };
    await read();
    await prompt();
    expect(readResource).not.toHaveBeenCalled();
    expect(getPrompt).not.toHaveBeenCalled();
  });

  it("withholds a blocked server from the resource and prompt lists", async () => {
    // Activated, so that the default gateway exposure would otherwise list it.
    priv.sessionActivated.add("ssh2");
    priv.profile = { path: "/cfg/config.json", blocked: ["unrelated"] };
    expect(JSON.stringify(await handlers.get("resources/list")?.({}))).toContain("connect://ssh2/");
    expect(JSON.stringify(await handlers.get("prompts/list")?.({}))).toContain("ssh2_p");
    priv.profile = { path: "/cfg/config.json", blocked: ["ssh"] };
    const resources = await handlers.get("resources/list")?.({});
    const prompts = await handlers.get("prompts/list")?.({});
    expect(JSON.stringify(resources)).not.toContain("connect://ssh2/");
    expect(JSON.stringify(prompts)).not.toContain("ssh2_p");
  });

  it("refuses tools/call on a connected server that is blocked", async () => {
    priv.profile = { path: "/cfg/config.json", blocked: ["ssh"] };
    const result = await priv.handleToolCall("ssh2_run", {});
    expect(result.isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("re-reads identities when the server list changes", () => {
    priv.profile = { path: "/cfg/config.json", blockedTools: ["ssh_run"] };
    priv.config = { servers: [SSH], configVersion: "" };
    expect(priv.isToolDenied("ssh2_run")).toBe(false);
    priv.config = { servers: [SSH, SSH2], configVersion: "" };
    expect(priv.isToolDenied("ssh2_run")).toBe(true);
  });

  it("keeps the meta-tools working under a broken policy, and they explain it", async () => {
    const message = "/cfg/config.json: invalid JSON at line 1. Fix it.";
    priv.profile = { path: "/cfg/config.json", policyErrors: [{ path: "/cfg/config.json", message }] };

    expect(priv.handleHealth().content[0].text).toContain(message);
    const discover = await priv.handleToolCall("mcp_connect_discover", {});
    expect(discover.isError).toBeFalsy();
    expect(discover.content[0].text).toContain(message);

    const activate = await priv.handleToolCall("mcp_connect_activate", { server: "ssh" });
    expect(activate.isError).toBe(true);
    expect(activate.content[0].text).toContain(message);
    expect(JSON.stringify(await read())).toContain(message);
  });

  it("shows an empty allow-list in health instead of hiding it", () => {
    priv.profile = { path: "/cfg/config.json", servers: [] };
    expect(priv.handleHealth().content[0].text).toContain("allow: (nothing)");
  });

  it("names the entry to remove when a server is blocked through its identity", async () => {
    priv.profile = { path: "/cfg/config.json", blocked: ["ssh"] };
    const text = (await priv.handleToolCall("mcp_connect_discover", { server: "ssh2" })).content[0].text;
    expect(text).toContain('the same server as a "blocked" entry, so remove that entry');
    expect(text).toContain("mcp_connect_health");
    expect(text).not.toContain("project profile in effect");
    // The all-blocked summary sends the identity block to the entry, not to "servers".
    priv.profile = { path: "/cfg/config.json", blocked: ["ssh"] };
    priv.config = { servers: [SSH, SSH2], configVersion: "" };
    const summary = priv.noServersEnabledText();
    expect(summary).toContain('remove "ssh" from its "blocked" list');
    expect(summary).toContain('remove the "blocked" entry that names the same launch as "ssh2"');
    expect(summary).not.toContain('add "ssh2" to its "servers" allow list');
  });

  it("names a broken policy file, not the allow-list, when discover is asked for a refused server", async () => {
    const message = "/cfg/config.json: invalid JSON at line 1. Fix it.";
    priv.profile = { path: "/cfg/config.json", policyErrors: [{ path: "/cfg/config.json", message }] };
    const text = (await priv.handleToolCall("mcp_connect_discover", { server: "ssh2" })).content[0].text;
    expect(text).toContain(message);
  });

  it("shows a namespace blocked only through its launch identity in health", () => {
    // `block:` prints the RAW list, but the gate enforces the identity-expanded
    // set -- ssh2 never appears in `blocked` and was excluded by it invisibly.
    priv.profile = { path: "/cfg/config.json", blocked: ["ssh"] };
    priv.config = { servers: [SSH, SSH2], configVersion: "" };
    const text = priv.handleHealth().content[0].text;
    expect(text).toContain("block: ssh");
    expect(text).toContain("also blocked via identity: ssh2");
    // A namespace blocked DIRECTLY is the raw `block:` line, not this one.
    priv.profile = { path: "/cfg/config.json", blocked: ["ssh", "ssh2"] };
    const both = priv.handleHealth().content[0].text;
    expect(both).toContain("block: ssh, ssh2");
    expect(both).not.toContain("also blocked via identity:");
  });

  it("repeats a misspelled policy key in health and in a refusal", async () => {
    const warning = "/cfg/config.json: unknown key 'blokced' ignored";
    priv.profile = { path: "/cfg/config.json", servers: [], policyWarnings: [warning] };
    expect(priv.handleHealth().content[0].text).toContain(`POLICY WARNING: ${warning}`);
    const activate = await priv.handleToolCall("mcp_connect_activate", { server: "ssh" });
    expect(activate.isError).toBe(true);
    expect(activate.content[0].text).toContain(warning);
  });
});

describe("a misspelled policy key is reported, not silently ignored", () => {
  it("names the key, suggests the right one, and keeps it out of enforcement", async () => {
    const file = write(home, CONFIG_FILENAME, { blokced: ["ssh"] });
    const config = await load();
    expect(config.policyWarnings).toHaveLength(1);
    expect(config.policyWarnings?.[0]).toContain(file);
    expect(config.policyWarnings?.[0]).toContain("'blokced' -> 'blocked'");
    const profile = toProfile(config);
    expect(profile?.policyWarnings).toEqual(config.policyWarnings);
    // Shown, not enforced: a key a newer release reads must not refuse every server.
    expect(spawnGateVerdict(SSH, profile, null)).toBeNull();
  });

  it("adds nothing for a clean file", async () => {
    write(home, CONFIG_FILENAME, { blocked: ["ssh"] });
    const config = await load();
    expect(config.policyWarnings).toBeUndefined();
    expect(toProfile(config)?.policyWarnings).toBeUndefined();
  });
});
