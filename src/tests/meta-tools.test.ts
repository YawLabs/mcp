import { describe, expect, it } from "vitest";
import { MAX_EXEC_STEPS } from "../exec-engine.js";
import { PENALTY_RATE_THRESHOLD } from "../learning.js";
import {
  computeSecretsReport,
  LITE_META_TOOL_NAMES,
  META_TOOL_NAMES,
  META_TOOLS,
  SERVER_INSTRUCTIONS,
} from "../meta-tools.js";
import { buildToolList } from "../proxy.js";
import { MALFORMED_REF_MARKER, MALFORMED_REF_MAX_CHARS, SECRET_REF_RE } from "../secrets-vault.js";

/** The tools/list wire JSON a client receives before any upstream is
 *  activated, at the given exposure -- exactly what the server's handler
 *  builds, serialized the way the SDK sends it. */
function wire(exposure: "gateway" | "lite" | "full"): { total: number; perTool: Map<string, number> } {
  const tools = buildToolList(new Map(), [], undefined, exposure, new Set());
  return {
    total: JSON.stringify({ tools }).length,
    perTool: new Map(tools.map((t) => [t.name, JSON.stringify(t).length])),
  };
}

describe("meta-tool wire size (tools/list before any activation)", () => {
  // Measured 2026-09-21 on a bundle of src/meta-tools.ts: BEFORE the routing
  // prose moved into SERVER_INSTRUCTIONS the eleven meta-tools were 17,929
  // chars of tools/list wire JSON (~5.1k tokens at 3.5 chars/token), 10,849
  // of them description text, exec alone 3,897 (2,162 description). AFTER:
  // 11,590 total, 5,456 description, exec 2,806 (1,493 description), and the
  // lite surface 4,567. These ceilings sit just above the AFTER numbers on
  // purpose: a description is paid on every tools/list, and on a client
  // with no deferred loading it is inlined into every request, so a
  // sentence added to one "for clarity" is a per-turn tax nothing else
  // would flag. Raise a ceiling only with a measurement in the commit.
  const GATEWAY_WIRE_CEILING = 12_000;
  const LITE_WIRE_CEILING = 4_800;
  const EXEC_WIRE_CEILING = 2_900;
  const EXEC_DESCRIPTION_CEILING = 1_500;
  const DESCRIPTION_TOTAL_CEILING = 5_600;
  const INSTRUCTIONS_CEILING = 600;

  it("keeps the whole gateway surface under the ceiling", () => {
    expect(wire("gateway").total).toBeLessThanOrEqual(GATEWAY_WIRE_CEILING);
  });

  it("keeps the lite surface under its ceiling", () => {
    expect(wire("lite").total).toBeLessThanOrEqual(LITE_WIRE_CEILING);
  });

  it("keeps exec, the largest tool, under its own ceiling", () => {
    // Exec is a third of the surface by itself and the one tool every
    // exposure lists, so it gets a per-tool pin the others do not need.
    expect(wire("gateway").perTool.get(META_TOOLS.exec.name)).toBeLessThanOrEqual(EXEC_WIRE_CEILING);
    expect(META_TOOLS.exec.description.length).toBeLessThanOrEqual(EXEC_DESCRIPTION_CEILING);
  });

  it("keeps the summed description text under the ceiling", () => {
    const total = Object.values(META_TOOLS).reduce((n, m) => n + m.description.length, 0);
    expect(total).toBeLessThanOrEqual(DESCRIPTION_TOTAL_CEILING);
  });

  it("keeps the server instructions short: they land in the system prompt of every session", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_CEILING);
  });

  it("gateway and full list the same meta-tools; full differs only in upstream placeholders", () => {
    expect(wire("full").total).toBe(wire("gateway").total);
  });
});

describe("SERVER_INSTRUCTIONS carries the routing advice the descriptions no longer repeat", () => {
  it("names the three routing entry points, the per-session unload, and the guide", () => {
    for (const needle of [
      META_TOOLS.dispatch.name,
      META_TOOLS.discover.name,
      META_TOOLS.exec.name,
      META_TOOLS.deactivate.name,
      "yaw-mcp://guide",
    ]) {
      expect(SERVER_INSTRUCTIONS).toContain(needle);
    }
  });

  it("is the ONLY home of the guide pointer and the dispatch-vs-discover routing rule", () => {
    // The regression this guards is the prose creeping back: before the
    // split discover, dispatch and exec each carried "read the guide first"
    // and "prefer dispatch when the task is concrete" in their own words.
    for (const meta of Object.values(META_TOOLS)) {
      expect(meta.description, meta.name).not.toContain("yaw-mcp://guide");
      expect(meta.description, meta.name).not.toMatch(/PREFERRED entry point/i);
      expect(meta.description, meta.name).not.toMatch(/prefer `mcp_connect_dispatch`/);
    }
  });
});

describe("LITE_META_TOOL_NAMES", () => {
  it("is exactly the exec-route three, and every one is a real meta-tool", () => {
    // typed-cli's yawGatewayCapPriority keeps exactly these three when it
    // has to cap; lite is that choice applied at the source, so the set
    // must not drift from it in either direction.
    expect([...LITE_META_TOOL_NAMES].sort()).toEqual(
      [META_TOOLS.exec.name, META_TOOLS.findTool.name, META_TOOLS.read_tool.name].sort(),
    );
    // Cast as server.ts does: META_TOOL_NAMES is typed over the literal names.
    for (const name of LITE_META_TOOL_NAMES) expect((META_TOOL_NAMES as Set<string>).has(name)).toBe(true);
  });
});

describe("mcp_connect_secrets meta-tool definition", () => {
  it("is registered with values-free annotations", () => {
    expect(META_TOOLS.secrets.name).toBe("mcp_connect_secrets");
    expect(META_TOOLS.secrets.annotations.readOnlyHint).toBe(true);
    expect(META_TOOLS.secrets.annotations.openWorldHint).toBe(false);
  });

  it("is included in META_TOOL_NAMES", () => {
    expect(META_TOOL_NAMES.has("mcp_connect_secrets")).toBe(true);
  });
});

describe("mcp_connect_dispatch inputSchema", () => {
  it("declares routeEffort so the advertised schema matches what the handler reads", () => {
    // server.ts reads args.routeEffort ahead of YAW_MCP_ROUTE_EFFORT; a
    // client that filters arguments against the advertised schema strips
    // undeclared params, so the per-call dial was dead code until declared.
    const props = META_TOOLS.dispatch.inputSchema.properties;
    expect(props.routeEffort).toBeDefined();
    expect(props.routeEffort.enum).toEqual(["off", "auto", "aggressive"]);
    // It stays optional -- omitting it falls back to the env var.
    expect(META_TOOLS.dispatch.inputSchema.required).toEqual(["intent"]);
  });
});

describe("META_TOOL_NAMES", () => {
  // server.ts gates exec steps on this set: a name missing from it is a
  // meta-tool that becomes callable from inside an exec pipeline. It used to
  // be a hand-maintained re-list of META_TOOLS, so an 11th meta-tool added
  // without touching it silently opened that hole. Derived now -- these pin
  // the derivation so it can't regress to a copy.
  it("covers EVERY meta-tool, with no gap and no extras", () => {
    const declared = Object.values(META_TOOLS).map((m) => m.name);
    expect(META_TOOL_NAMES.size).toBe(declared.length);
    expect([...META_TOOL_NAMES].sort()).toEqual([...declared].sort());
  });
});

describe("meta-tool descriptions quote the constants that enforce them", () => {
  it("renders exec's step cap from MAX_EXEC_STEPS", () => {
    // The description sells a hard cap to the model; validateExecRequest is
    // what actually enforces it. A hardcoded number here goes stale silently
    // the first time the cap moves.
    expect(META_TOOLS.exec.description).toContain(`Max ${MAX_EXEC_STEPS} steps per exec.`);
  });

  it("renders health's reliability floor from PENALTY_RATE_THRESHOLD", () => {
    // learning.ts promises that moving this threshold moves every surface
    // that renders it -- this description is one of those surfaces.
    expect(META_TOOLS.health.description).toContain(`<${Math.round(PENALTY_RATE_THRESHOLD * 100)}%`);
  });

  it("does not retype the idle-unload threshold in deactivate's description", () => {
    // The real threshold is adaptive (ADAPTIVE_MIN..ADAPTIVE_MAX around a
    // YAW_MCP_IDLE_THRESHOLD baseline, idle-ttl.ts), so any literal here is
    // wrong for most servers most of the time. Name the knob, never a number.
    const d = META_TOOLS.deactivate.description;
    expect(d).not.toMatch(/\d+\+? tool calls/);
    expect(d).toContain("YAW_MCP_IDLE_THRESHOLD");
  });
});

describe("mcp_connect_exec description matches what handleExec does", () => {
  it("no longer claims exec never auto-activates", () => {
    // Tripwire, not coverage: handleExec routes each step through
    // handleToolCall, which lazy-loads a deferred (cached-but-not-connected)
    // server on first use exactly as a direct tools/call would. The old
    // parenthetical told the model to spend an mcp_connect_activate
    // round-trip first -- the very round-trip exec exists to save.
    expect(META_TOOLS.exec.description).not.toContain("does not auto-activate");
    expect(META_TOOLS.exec.inputSchema.properties.steps.items.properties.tool.description).not.toContain(
      "currently loaded",
    );
  });

  it("tells the model which refusals cost a side effect and which do not", () => {
    // Drift tripwire for the spawn-gate preflight in handleExec. The two
    // refusals land in different SHAPES on purpose -- a policy refusal is
    // decided before step 0 and returns plain `exec: ...` text meaning nothing
    // ran, a cap refusal fails mid-pipeline and returns the envelope with
    // `partial` -- and the difference is exactly what tells the model whether
    // re-running is free or files a second issue. A description that still
    // said a compliance refusal "fails the step" would be teaching it the
    // wrong recovery.
    const d = META_TOOLS.exec.description;
    expect(d).toContain("decided before step 0 runs and refuses the whole pipeline with nothing done");
    expect(d).toContain("a server-cap refusal is only knowable when the step is reached");
  });

  it("declares the step item schema closed so a misspelled `arguments` key is not silently legal", () => {
    // Without this a step written as {tool, arguments:{...}} reads as a legal
    // extension and dispatches the tool with no arguments at all.
    expect(META_TOOLS.exec.inputSchema.properties.steps.items.additionalProperties).toBe(false);
  });
});

describe("computeSecretsReport (names only, never values)", () => {
  it("partitions referenced names into injected vs missing", () => {
    const servers = [
      {
        namespace: "gh",
        env: { GITHUB_TOKEN: "${secret:gh}", AUTH: "Bearer ${secret:missing_one}" },
      },
    ];
    const rows = computeSecretsReport(servers, new Set(["gh"]));
    expect(rows).toEqual([{ server: "gh", injectedSecrets: ["gh"], missing: ["missing_one"], malformed: [] }]);
  });

  it("reads a REMOTE server's credentials from headers, not env", () => {
    // The only channel a remote server has. It spawns no process, so
    // upstream.ts warns and ignores its `env` -- but it resolves `headers`
    // through the SAME fail-closed resolveServerEnv immediately before it
    // builds the transport. Scanning `env` for one omitted the server
    // entirely, which reads as "needs no secrets" about the exact server
    // whose connect is about to be refused for a missing name.
    const servers = [
      {
        namespace: "notion",
        type: "remote",
        headers: { Authorization: "Bearer ${secret:NOTION_TOKEN}" },
      },
    ];
    const rows = computeSecretsReport(servers, new Set(["OTHER"]));
    expect(rows).toEqual([{ server: "notion", injectedSecrets: [], missing: ["NOTION_TOKEN"], malformed: [] }]);
  });

  it("sees a url+headers entry that omits `type`, which validateEntry calls local", () => {
    // isRemoteEntry does not read `type` alone, and this is the case that
    // forced the fallback: validateEntry defaults a missing `"type"` to
    // "local", so a hand-written url+headers entry looks local and its only
    // credential looks like a channel nothing uses. The report reaches the
    // predicate through the caller's projection, so this also pins that
    // `command` and `url` are actually threaded through -- passing neither
    // leaves the fallback permanently false and the row silently absent.
    const servers = [
      {
        namespace: "notype",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer ${secret:LINEAR_TOKEN}" },
      },
    ];
    const rows = computeSecretsReport(servers, new Set());
    expect(rows).toEqual([{ server: "notype", injectedSecrets: [], missing: ["LINEAR_TOKEN"], malformed: [] }]);
  });

  it("ignores a remote server's env, which is never sent anywhere", () => {
    // Not merely unused -- reporting it would promise a credential the
    // transport will never carry.
    const servers = [{ namespace: "notion", type: "remote", env: { TOKEN: "${secret:NEVER_SENT}" } }];
    expect(computeSecretsReport(servers, new Set())).toEqual([]);
  });

  it("still reads env for a local server that also carries headers", () => {
    // `headers` is meaningless on a local entry, and reading it there would
    // invent a requirement the spawn does not have.
    const servers = [
      {
        namespace: "gh",
        type: "local",
        env: { GITHUB_TOKEN: "${secret:gh}" },
        headers: { Authorization: "Bearer ${secret:IGNORED}" },
      },
    ];
    const rows = computeSecretsReport(servers, new Set(["gh"]));
    expect(rows).toEqual([{ server: "gh", injectedSecrets: ["gh"], missing: [], malformed: [] }]);
  });

  it("names a malformed ref in a remote server's headers", () => {
    const servers = [{ namespace: "notion", type: "remote", headers: { A: "${secret:notion token}" } }];
    const rows = computeSecretsReport(servers, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.malformed.length).toBeGreaterThan(0);
  });

  it("names a reference the strict regex cannot parse in its own `malformed` column", () => {
    // resolveServerEnv refuses the spawn over a malformed ref exactly as over
    // a missing name, but the report scans with the strict regex, so until
    // this column it said "gh: injected, nothing missing" about a server that
    // will not start -- and a server whose ONLY ref is the typo got no row at
    // all, reading as "needs no secrets".
    const servers: Array<{ namespace: string; env?: Record<string, string> }> = [
      { namespace: "typo-only", env: { T: "${secret:gh token}" } },
      { namespace: "mixed", env: { A: "${secret:gh}", B: "${secret:absent}", C: "${secret:gh" } },
    ];
    const rows = computeSecretsReport(servers, new Set(["gh"]));
    expect(rows).toEqual([
      {
        server: "typo-only",
        injectedSecrets: [],
        missing: [],
        malformed: [`${MALFORMED_REF_MARKER} \${secret:gh ...`],
      },
      {
        server: "mixed",
        injectedSecrets: ["gh"],
        missing: ["absent"],
        malformed: [`${MALFORMED_REF_MARKER} \${secret:gh`],
      },
    ]);
  });

  it("quotes a malformed reference in secrets-vault's bounded display form, never the raw env value", () => {
    // An unterminated ref runs to the end of the env value, which can carry
    // anything the user put after the typo. This report goes to the model,
    // so it gets the same control-stripped, capped form the refusal uses.
    const servers = [
      { namespace: "db", env: { URL: `\${secret:DB_PASS@db.internal:5432/prod?x=y&pw=${"z".repeat(200)}` } },
    ];
    const rows = computeSecretsReport(servers, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].malformed).toHaveLength(1);
    const [quoted] = rows[0].malformed;
    expect(quoted.startsWith(`${MALFORMED_REF_MARKER} \${secret:DB_PASS`)).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(MALFORMED_REF_MARKER.length + 1 + MALFORMED_REF_MAX_CHARS + 3);
    expect(JSON.stringify(rows)).not.toContain("pw=");
  });

  it("reports only the vault keys this server references, never the whole key list", () => {
    // injectedSecrets is referenced ∩ vaultKeys, in that direction. Leaking
    // the vault's other key NAMES here would turn a per-server preview into
    // an inventory of every credential the user holds.
    const servers = [{ namespace: "gh", env: { T: "${secret:gh}" } }];
    const rows = computeSecretsReport(servers, new Set(["gh", "aws", "slack"]));
    expect(rows).toEqual([{ server: "gh", injectedSecrets: ["gh"], missing: [], malformed: [] }]);
    expect(JSON.stringify(rows)).not.toContain("aws");
    expect(JSON.stringify(rows)).not.toContain("slack");
  });

  it("omits servers with no ${secret:...} references", () => {
    const servers: Array<{ namespace: string; env?: Record<string, string> }> = [
      { namespace: "plain", env: { FOO: "bar" } },
      { namespace: "none", env: undefined },
      { namespace: "gh", env: { T: "${secret:gh}" } },
    ];
    const rows = computeSecretsReport(servers, new Set(["gh"]));
    expect(rows.map((r) => r.server)).toEqual(["gh"]);
  });

  it("dedupes multiple references to the same name within one server", () => {
    const servers = [{ namespace: "x", env: { A: "${secret:tok}", B: "pre-${secret:tok}-post" } }];
    const rows = computeSecretsReport(servers, new Set(["tok"]));
    expect(rows[0].injectedSecrets).toEqual(["tok"]);
    expect(rows[0].missing).toEqual([]);
  });

  it("everything missing when the vault is empty", () => {
    const servers = [{ namespace: "gh", env: { T: "${secret:gh}", U: "${secret:aws}" } }];
    const rows = computeSecretsReport(servers, new Set());
    expect(rows[0].injectedSecrets).toEqual([]);
    expect(rows[0].missing).toEqual(["aws", "gh"]); // sorted
  });

  it("is immune to a stale lastIndex on the shared SECRET_REF_RE", () => {
    // SECRET_REF_RE is /g and module-shared. matchAll seeds its internal
    // clone from the SOURCE's lastIndex, so scanning with the shared object
    // would skip leading matches once any other caller left lastIndex behind
    // (a `.exec()`/`.test()` anywhere) -- and a skipped reference drops the
    // server's row entirely, reading as "needs no secrets".
    const saved = SECRET_REF_RE.lastIndex;
    SECRET_REF_RE.lastIndex = 5;
    try {
      const rows = computeSecretsReport([{ namespace: "gh", env: { T: "${secret:gh}" } }], new Set(["gh"]));
      expect(rows).toEqual([{ server: "gh", injectedSecrets: ["gh"], missing: [], malformed: [] }]);
    } finally {
      SECRET_REF_RE.lastIndex = saved;
    }
  });

  it("returns no value anywhere in the output -- only names", () => {
    const servers = [{ namespace: "gh", env: { T: "${secret:gh}" } }];
    const rows = computeSecretsReport(servers, new Set(["gh"]));
    const serialized = JSON.stringify(rows);
    // The only string that should appear is the NAME "gh", never a value.
    expect(serialized).toContain("gh");
    // No env value content (the literal placeholder) leaks into the report
    // for a WELL-FORMED ref. (The `malformed` column is the deliberate
    // exception: it quotes the unparseable span, bounded, because the typo
    // IS the diagnostic -- see the malformed cases above.)
    expect(serialized).not.toContain("${secret:");
  });
});
