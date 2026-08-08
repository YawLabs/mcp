import { describe, expect, it } from "vitest";
import { computeSecretsReport, META_TOOL_NAMES, META_TOOLS } from "../meta-tools.js";
import { SECRET_REF_RE } from "../secrets-vault.js";

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

  it("has an entry for every key of META_TOOLS", () => {
    for (const key of Object.keys(META_TOOLS) as Array<keyof typeof META_TOOLS>) {
      expect((META_TOOL_NAMES as Set<string>).has(META_TOOLS[key].name)).toBe(true);
    }
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
    expect(rows).toEqual([{ server: "gh", injectedSecrets: ["gh"], missing: ["missing_one"] }]);
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
      expect(rows).toEqual([{ server: "gh", injectedSecrets: ["gh"], missing: [] }]);
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
    // No env value content (the literal placeholder) leaks into the report.
    expect(serialized).not.toContain("${secret:");
  });
});
