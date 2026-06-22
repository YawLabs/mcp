import { describe, expect, it } from "vitest";
import { computeSecretsReport, META_TOOL_NAMES, META_TOOLS } from "../meta-tools.js";

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
