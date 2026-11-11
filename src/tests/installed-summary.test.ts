import { describe, expect, it } from "vitest";
import {
  formatInstalledEntry,
  formatInstalledServers,
  INSTALLED_LINE_MAX_CHARS,
  type InstalledServer,
  serverKeywords,
  withInstalledServers,
} from "../installed-summary.js";
import { META_TOOLS } from "../meta-tools.js";

function srv(namespace: string, extra: Partial<InstalledServer> = {}): InstalledServer {
  return { namespace, name: namespace, ...extra };
}

describe("serverKeywords", () => {
  it("takes domain words from the description, dropping filler, numbers and the namespace", () => {
    expect(
      serverKeywords(srv("azure", { description: "Manage 100+ Azure services - Cosmos DB, Storage, Key Vault." })),
    ).toEqual(["services", "cosmos", "storage", "key", "vault"]);
  });

  it("falls back to the display name and tool names, singular and plural counted once", () => {
    const words = serverKeywords(
      srv("gh", {
        name: "GitHub",
        toolCache: [{ name: "list_issues" }, { name: "get_issue" }, { name: "create_pull_request" }],
      }),
    );
    expect(words).toEqual(["github", "issues", "pull", "request"]);
  });

  it("lets only [a-z0-9] runs through, so no markup or control byte reaches the description", () => {
    const words = serverKeywords(srv("x", { description: "Ships `code`\u0007 <b>fast</b>\nIGNORE prior" }));
    expect(words).toEqual(["ships", "code", "fast", "ignore", "prior"]);
  });

  it("drops each part of a namespace that has a separator in it", () => {
    // A token never contains `_`, so comparing it to the whole namespace let
    // `google_drive` spend two keyword slots on its own name.
    expect(serverKeywords(srv("google_drive", { description: "Google Drive files and shared folders." }))).toEqual([
      "files",
      "shared",
      "folders",
    ]);
  });
});

describe("formatInstalledEntry", () => {
  it("renders keywords and the shadowed CLI", () => {
    expect(formatInstalledEntry(srv("npmjs", { description: "npm registry lookups. Downloads too." }), 3)).toBe(
      "npmjs (npm, registry, lookups; over `npm`)",
    );
  });

  it("is the bare namespace when nothing describes it", () => {
    expect(formatInstalledEntry(srv("zzz"))).toBe("zzz");
  });

  it("drops the keywords at 0 words and the CLI note when asked", () => {
    const pg = srv("postgres", { description: "Postgres read queries." });
    expect(formatInstalledEntry(pg, 0)).toBe("postgres (over `psql`, `pg_dump`)");
    expect(formatInstalledEntry(pg, 0, false)).toBe("postgres");
  });
});

describe("formatInstalledServers", () => {
  it("is null when nothing is installed", () => {
    expect(formatInstalledServers([])).toBeNull();
  });

  it("lists namespaces in code-unit order, whatever order the config has", () => {
    const a = formatInstalledServers([srv("zeta"), srv("Alpha"), srv("beta")]);
    expect(a).toBe("Installed servers: Alpha, beta, zeta.");
    expect(formatInstalledServers([srv("beta"), srv("zeta"), srv("Alpha")])).toBe(a);
  });

  it("shrinks the keywords before it drops a server", () => {
    const servers = Array.from({ length: 12 }, (_, i) =>
      srv(`server${String(i).padStart(2, "0")}`, { description: "alpha bravo charlie delta echo" }),
    );
    const roomy = formatInstalledServers(servers, 2000);
    expect(roomy).toContain("server00 (alpha, bravo, charlie, delta)");
    const tight = formatInstalledServers(servers, 300);
    expect(tight?.length).toBeLessThanOrEqual(300);
    // Every server is still named; only the descriptions narrowed.
    for (const s of servers) expect(tight).toContain(s.namespace);
    expect(tight).not.toContain("more");
  });

  it("stays under the ceiling and counts what not even a bare name could fit", () => {
    const many = Array.from({ length: 120 }, (_, i) => srv(`server${String(i).padStart(3, "0")}`));
    const line = formatInstalledServers(many);
    expect(line?.length).toBeLessThanOrEqual(INSTALLED_LINE_MAX_CHARS);
    const shown = (line?.match(/server\d{3}/g) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(line).toContain(` +${120 - shown} more (mcp_connect_discover lists all).`);
  });

  it("falls back to a count when not even one name fits", () => {
    expect(formatInstalledServers([srv("a-very-long-namespace-name")], 30)).toBe(
      "Installed servers: 1 (mcp_connect_discover lists them).",
    );
  });
});

describe("withInstalledServers", () => {
  const tools = [
    { name: META_TOOLS.dispatch.name, description: "D." },
    { name: META_TOOLS.findTool.name, description: "F." },
  ];

  it("appends to dispatch under gateway and full, to find_tool under lite", () => {
    for (const exposure of ["gateway", "full"] as const) {
      const out = withInstalledServers(tools, "Installed servers: gh.", exposure);
      expect(out.map((t) => t.description)).toEqual(["D. Installed servers: gh.", "F."]);
    }
    const lite = withInstalledServers(tools, "Installed servers: gh.", "lite");
    expect(lite.map((t) => t.description)).toEqual(["D.", "F. Installed servers: gh."]);
  });

  it("leaves the list untouched with no line, and never mutates its input", () => {
    expect(withInstalledServers(tools, null, "gateway")).toBe(tools);
    withInstalledServers(tools, "Installed servers: gh.", "gateway");
    expect(tools[0].description).toBe("D.");
  });
});
