import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCallArgs, runCall } from "../call-cmd.js";
import { CONFIG_DIRNAME } from "../paths.js";
import { TransientConnectError } from "../transient-upstream.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";

const homes: string[] = [];

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** Throwaway home with a ~/.yaw-mcp/bundles.json, and optionally a config.json
 *  carrying the allow/deny lists the spawn gate reads. */
function makeHome(servers: unknown[], config?: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "yaw-call-"));
  homes.push(home);
  mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
  writeFileSync(join(home, CONFIG_DIRNAME, "bundles.json"), JSON.stringify({ version: 1, servers }, null, 2));
  if (config) writeFileSync(join(home, CONFIG_DIRNAME, "config.json"), JSON.stringify(config, null, 2));
  return home;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

/** A fake upstream that answers one tools/call. `result` is returned verbatim
 *  so a test can assert on the exact MCP envelope, isError included. */
function fakeConnect(opts: { tools?: string[]; result?: unknown; throwOnCall?: Error; connectError?: unknown }): {
  connect: NonNullable<Parameters<typeof runCall>[0]["connect"]>;
  calls: Array<{ name: string; arguments: unknown }>;
  connected: UpstreamServerConfig[];
  tornDown: number;
} {
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const connected: UpstreamServerConfig[] = [];
  const state = { tornDown: 0 };
  const connect = async <T>(
    config: UpstreamServerConfig,
    use: (connection: UpstreamConnection) => Promise<T>,
  ): Promise<T> => {
    if (opts.connectError !== undefined) throw new TransientConnectError(config.namespace, opts.connectError);
    connected.push(config);
    const connection = {
      config,
      client: {
        callTool: async (req: { name: string; arguments: unknown }) => {
          calls.push(req);
          if (opts.throwOnCall) throw opts.throwOnCall;
          return opts.result ?? { content: [{ type: "text", text: "ok" }] };
        },
      },
      tools: (opts.tools ?? ["search"]).map((name) => ({
        name,
        namespacedName: `${config.namespace}_${name}`,
        inputSchema: { type: "object" },
      })),
      resources: [],
      prompts: [],
      status: "connected",
    } as unknown as UpstreamConnection;
    try {
      return await use(connection);
    } finally {
      // The helper's own teardown is what the real path uses; this stands in
      // for it so a test can assert the call site never skips it.
      state.tornDown++;
    }
  };
  return {
    connect,
    calls,
    connected,
    get tornDown() {
      return state.tornDown;
    },
  };
}

const GH = { namespace: "gh", name: "GitHub", command: "npx", args: ["-y", "gh-mcp"] };

describe("parseCallArgs", () => {
  it("requires a namespace and a tool", () => {
    expect(parseCallArgs([]).ok).toBe(false);
    const r = parseCallArgs(["gh"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("<tool>");
  });

  it("parses the namespace, tool and positional JSON arguments", () => {
    const r = parseCallArgs(["gh", "search", '{"q":"mcp"}']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.namespace).toBe("gh");
      expect(r.options.tool).toBe("search");
      expect(r.options.argsJson).toBe('{"q":"mcp"}');
    }
  });

  it("accepts --args as the flag form of the positional", () => {
    const r = parseCallArgs(["gh", "search", "--args", '{"q":"mcp"}']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.argsJson).toBe('{"q":"mcp"}');
  });

  it("refuses --args together with the positional rather than picking one", () => {
    // Two spellings of the same argument, and no reading of "which wins" is
    // obviously right -- so neither is chosen. Silently preferring one is how
    // a script sends arguments the author cannot see in the command line.
    const r = parseCallArgs(["gh", "search", '{"a":1}', "--args", '{"b":2}']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--args");
  });

  it("rejects an unknown flag instead of treating it as an argument", () => {
    const r = parseCallArgs(["gh", "search", "--wat"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--wat");
  });

  it("routes --help to stdout with exit 0", () => {
    const r = parseCallArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.help).toBe(true);
  });
});

describe("runCall -- the policy gates", () => {
  it("refuses a DISABLED server without spawning it", async () => {
    // The gate has to run BEFORE the connect, not after: connecting is
    // spawning, and a server the user switched off must not run because a
    // shell asked it to.
    const home = makeHome([{ ...GH, isActive: false }]);
    const fake = fakeConnect({});
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "search", home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(2);
    expect(cap.errText()).toContain("disabled");
    expect(cap.errText()).toContain("yaw-mcp enable gh");
    expect(fake.connected).toEqual([]);
  });

  it("refuses a server the project profile blocks, without spawning it", async () => {
    const home = makeHome([GH], { blocked: ["gh"] });
    const fake = fakeConnect({});
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "search", home, cwd: home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(2);
    expect(cap.errText()).toContain("not allowed");
    expect(fake.connected).toEqual([]);
  });

  it("refuses a server below the compliance floor, without spawning it", async () => {
    const home = makeHome([{ ...GH, complianceGrade: "D" }]);
    const fake = fakeConnect({});
    const cap = capture();
    const r = await runCall({
      namespace: "gh",
      tool: "search",
      home,
      env: { YAW_MCP_MIN_COMPLIANCE: "B" },
      connect: fake.connect,
      ...cap,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.errText()).toContain("YAW_MCP_MIN_COMPLIANCE");
    expect(fake.connected).toEqual([]);
  });

  it("refuses a tool on the blockedTools deny list, without spawning it", async () => {
    // The whole reason this command shares the gate module with the broker: a
    // deny that the model cannot route around is worthless if a `yaw-mcp call`
    // in a git hook can. The wire name is `<namespace>_<tool>`, which is known
    // from the two arguments, so the refusal lands before the spawn.
    const home = makeHome([GH], { blockedTools: ["gh_search"] });
    const fake = fakeConnect({});
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "search", home, cwd: home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(2);
    expect(cap.errText()).toContain("blocked");
    expect(fake.connected).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("applies a blockedTools wildcard the same way the proxy does", async () => {
    const home = makeHome([GH], { blockedTools: ["gh_*"] });
    const fake = fakeConnect({});
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "search", home, cwd: home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(2);
    expect(fake.connected).toEqual([]);
  });

  it("denies a tool whose OWN name embeds the namespace, which needs the live list", async () => {
    // The case the pre-spawn check cannot answer. The server's tool is really
    // called `gh_status`, so its wire name is `gh_gh_status` -- but with no
    // tool list yet, normalizeToolName strips the `gh_` prefix and computes
    // `gh_status`, which this deny does not match. Only the check made AFTER
    // the inventory arrives sees the real name. It costs a spawn, which is why
    // it is the SECOND check and not the only one.
    const home = makeHome([GH], { blockedTools: ["gh_gh_status"] });
    const fake = fakeConnect({ tools: ["gh_status"] });
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "gh_status", home, cwd: home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(2);
    expect(cap.errText()).toContain("gh_gh_status");
    // It DID have to spawn to find out -- and it still never called the tool.
    expect(fake.connected).toHaveLength(1);
    expect(fake.calls).toEqual([]);
    expect(fake.tornDown).toBe(1);
  });

  it("denies the NAMESPACED spelling of a denied tool too", async () => {
    // `gh_search` and `search` name the same tool on `gh`, so accepting one
    // spelling and refusing the other is a deny anyone can step around by
    // retyping the argument.
    const home = makeHome([GH], { blockedTools: ["gh_search"] });
    const fake = fakeConnect({});
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "gh_search", home, cwd: home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(2);
    expect(fake.connected).toEqual([]);
  });
});

describe("runCall -- calling", () => {
  it("calls the tool and prints its text content", async () => {
    const home = makeHome([GH]);
    const fake = fakeConnect({ result: { content: [{ type: "text", text: "hello\nworld" }] } });
    const cap = capture();
    const r = await runCall({
      namespace: "gh",
      tool: "search",
      argsJson: '{"q":"mcp"}',
      home,
      connect: fake.connect,
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    expect(fake.calls).toEqual([{ name: "search", arguments: { q: "mcp" } }]);
    // Verbatim, and with no decoration: the point of this command is that a
    // shell script can consume the answer. A banner on stdout would land in
    // the middle of whatever the caller pipes it into.
    expect(cap.text()).toBe("hello\nworld\n");
  });

  it("tears the upstream down even when the call throws", async () => {
    const home = makeHome([GH]);
    const fake = fakeConnect({ throwOnCall: new Error("upstream exploded") });
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "search", home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toContain("upstream exploded");
    expect(fake.tornDown).toBe(1);
  });

  it("strips the namespace prefix so both spellings of the tool work", async () => {
    const home = makeHome([GH]);
    const fake = fakeConnect({ tools: ["search"] });
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "gh_search", home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(0);
    expect(fake.calls[0].name).toBe("search");
  });

  it("prefers an EXACT tool-name match over stripping the prefix", async () => {
    // A server really can expose a tool whose own name starts with the
    // namespace (`gh` + `gh_status`). Stripping blindly would call a
    // `status` that does not exist and report it missing.
    const home = makeHome([GH]);
    const fake = fakeConnect({ tools: ["gh_status"] });
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "gh_status", home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(0);
    expect(fake.calls[0].name).toBe("gh_status");
  });

  it("reports an unknown tool with the names the server does expose", async () => {
    const home = makeHome([GH]);
    const fake = fakeConnect({ tools: ["search", "create_issue"] });
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "nope", home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toContain("create_issue");
    expect(fake.calls).toEqual([]);
    expect(fake.tornDown).toBe(1);
  });

  it("exits 1 on an isError result and still prints the body", async () => {
    // An upstream error is a real answer -- the caller needs to see the text
    // that came back -- but a script must be able to tell it from success
    // without parsing, so the body goes to stdout and the code is non-zero.
    const home = makeHome([GH]);
    const fake = fakeConnect({ result: { content: [{ type: "text", text: "rate limited" }], isError: true } });
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "search", home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.text()).toContain("rate limited");
  });

  it("emits the raw MCP envelope under --json", async () => {
    const home = makeHome([GH]);
    const result = { content: [{ type: "text", text: "hi" }], structuredContent: { n: 1 } };
    const fake = fakeConnect({ result });
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "search", home, json: true, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(cap.text())).toEqual(result);
  });

  it("names a non-text content block instead of dropping it", async () => {
    // An image or an embedded resource carries no `text`, and printing nothing
    // for it would make an answer that DID arrive look like an empty one.
    const home = makeHome([GH]);
    const fake = fakeConnect({ result: { content: [{ type: "image", data: "...", mimeType: "image/png" }] } });
    const cap = capture();
    await runCall({ namespace: "gh", tool: "search", home, connect: fake.connect, ...cap });
    expect(cap.text()).toContain("image");
    expect(cap.text()).toContain("--json");
  });
});

describe("runCall -- arguments", () => {
  it("defaults to an empty argument object", async () => {
    const home = makeHome([GH]);
    const fake = fakeConnect({});
    await runCall({ namespace: "gh", tool: "search", home, connect: fake.connect, ...capture() });
    expect(fake.calls[0].arguments).toEqual({});
  });

  it("refuses malformed JSON before spawning anything", async () => {
    const home = makeHome([GH]);
    const fake = fakeConnect({});
    const cap = capture();
    const r = await runCall({
      namespace: "gh",
      tool: "search",
      argsJson: "{oops",
      home,
      connect: fake.connect,
      ...cap,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.errText()).toContain("JSON");
    expect(fake.connected).toEqual([]);
  });

  it("refuses JSON that is not an OBJECT", async () => {
    // MCP `arguments` is an object. A bare array or string would be handed
    // straight to the upstream, which rejects it with a schema error that
    // names neither the file nor the flag the user typed.
    const home = makeHome([GH]);
    const fake = fakeConnect({});
    for (const bad of ["[1,2]", '"text"', "42", "null"]) {
      const cap = capture();
      const r = await runCall({ namespace: "gh", tool: "search", argsJson: bad, home, connect: fake.connect, ...cap });
      expect(r.exitCode, bad).toBe(2);
      expect(cap.errText(), bad).toContain("object");
    }
    expect(fake.connected).toEqual([]);
  });

  it("reads the argument object from stdin under --args-stdin", async () => {
    // Shell quoting of a JSON object is the reason this exists: `--args
    // '{"body":"it'"'"'s fine"}'` is not something to ask anyone to type.
    const home = makeHome([GH]);
    const fake = fakeConnect({});
    const stdin = new PassThrough();
    stdin.end('{"q":"from stdin"}');
    await runCall({
      namespace: "gh",
      tool: "search",
      argsStdin: true,
      home,
      connect: fake.connect,
      stdin,
      ...capture(),
    });
    expect(fake.calls[0].arguments).toEqual({ q: "from stdin" });
  });
});

describe("runCall -- lookup failures", () => {
  it("reports an unknown namespace and points at list", async () => {
    const home = makeHome([GH]);
    const cap = capture();
    const fake = fakeConnect({});
    const r = await runCall({ namespace: "nope", tool: "search", home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toContain("yaw-mcp list");
    expect(fake.connected).toEqual([]);
  });

  it("reports a connect failure as a connect failure", async () => {
    const home = makeHome([GH]);
    const fake = fakeConnect({ connectError: new Error("ENOENT npx") });
    const cap = capture();
    const r = await runCall({ namespace: "gh", tool: "search", home, connect: fake.connect, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toContain("Could not connect");
    expect(cap.errText()).toContain("ENOENT npx");
  });

  it("surfaces bundles.json loader warnings on stderr", async () => {
    // Same posture as `audit` and `list`: a malformed entry that the loader
    // skipped must not be reported as a missing namespace with nothing
    // explaining why.
    const home = makeHome([GH, { namespace: "BAD UPPER", command: "x" }]);
    const cap = capture();
    const fake = fakeConnect({});
    await runCall({ namespace: "gh", tool: "search", home, connect: fake.connect, ...cap });
    expect(cap.errText()).toContain("warning:");
  });
});

describe("runCall -- the default connect really is the transient helper", () => {
  it("uses withTransientUpstream when no seam is injected", async () => {
    // The seam above is a test hook; this pins that the SHIPPED path goes
    // through the shared connect-and-teardown helper rather than its own copy
    // of connect/call/disconnect. Without it the tests could all pass against
    // a helper nothing in production uses.
    const helper = await import("../transient-upstream.js");
    const spy = vi.spyOn(helper, "withTransientUpstream").mockRejectedValue(new TransientConnectError("gh", "stub"));
    try {
      const home = makeHome([GH]);
      const cap = capture();
      const r = await runCall({ namespace: "gh", tool: "search", home, ...cap });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(r.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
