import { describe, expect, it } from "vitest";

import {
  cliToNamespaces,
  formatShadowLine,
  installTargetForCli,
  resolveShadowedClis,
  SHADOW_INSTALL_TARGETS,
} from "../cli-shadows.js";

describe("resolveShadowedClis", () => {
  it("returns the registered shadow for a catalog slug", () => {
    const shadows = resolveShadowedClis({ namespace: "tailscale" });
    expect(shadows).toEqual([{ cli: "tailscale" }]);
  });

  it("returns npmjs's restricted npm subcommand list", () => {
    const shadows = resolveShadowedClis({ namespace: "npmjs" });
    expect(shadows).toHaveLength(1);
    expect(shadows[0].cli).toBe("npm");
    expect(shadows[0].subcommands).toContain("audit");
    expect(shadows[0].subcommands).toContain("deprecate");
    // npmjs-mcp is read/admin only — `install` should NOT appear.
    expect(shadows[0].subcommands).not.toContain("install");
  });

  it("returns multiple shadows for postgres", () => {
    const shadows = resolveShadowedClis({ namespace: "postgres" });
    expect(shadows.map((s) => s.cli).sort()).toEqual(["pg_dump", "psql"]);
  });

  it("resolves common alias namespaces (k8s → kubectl)", () => {
    expect(resolveShadowedClis({ namespace: "k8s" })).toEqual([{ cli: "kubectl" }]);
    expect(resolveShadowedClis({ namespace: "kubectl" })).toEqual([{ cli: "kubectl" }]);
  });

  it("is case-insensitive on namespace", () => {
    expect(resolveShadowedClis({ namespace: "GitHub" })).toEqual([{ cli: "gh" }]);
  });

  it("does not resolve inherited Object.prototype keys as registered namespaces", () => {
    // `constructor` is a fully VALID namespace -- local-bundles' NAMESPACE_RE
    // (^[a-z][a-z0-9_]{0,29}$) accepts it -- so a repo's bundles.json can
    // name a server that way. A bare registry index walked the prototype
    // chain and returned Object.prototype.constructor (a function, not
    // undefined), so `[...direct]` threw "direct is not iterable" inside
    // discover's output builder and failed the whole tool call.
    // The lookup lowercases first, so `constructor` is the one NAMESPACE_RE
    // lets through; `__proto__` is barred there but must not depend on that.
    for (const namespace of ["constructor", "__proto__"]) {
      expect(() => resolveShadowedClis({ namespace })).not.toThrow();
      expect(resolveShadowedClis({ namespace })).toEqual([]);
      expect(formatShadowLine({ namespace })).toBeNull();
    }
  });

  it("returns [] for a registered no-CLI service", () => {
    // Linear, Notion, Firecrawl etc. are known catalog entries with no
    // widely-used CLI. Registering them explicitly keeps the heuristic
    // from inferring a bogus shadow from their tool-name prefix.
    expect(resolveShadowedClis({ namespace: "linear" })).toEqual([]);
    expect(resolveShadowedClis({ namespace: "notion" })).toEqual([]);
  });

  // The three heuristic cases below are the ONLY reachers of the
  // KNOWN_CLI_PREFIXES branch. No production caller passes a `toolCache`
  // (local-bundles.ts validateEntry whitelists fields and drops it), so the
  // branch cannot fire on a real run -- these assertions pin the intended
  // behavior for whenever a callsite starts supplying the cache, not
  // behavior a user sees today. See the KNOWN_CLI_PREFIXES comment in
  // cli-shadows.ts. Do not read a green run here as "custom namespaces get
  // shadow hints"; they do not.
  it("falls back to the tool-prefix heuristic for unknown namespaces", () => {
    // A user who named their server "my-npm-proxy" isn't in the registry,
    // but its tool cache shares the `npm` prefix across ≥3 entries — infer.
    const shadows = resolveShadowedClis({
      namespace: "my-npm-proxy",
      toolCache: [{ name: "npm_search" }, { name: "npm_audit" }, { name: "npm_view" }],
    });
    expect(shadows).toEqual([{ cli: "npm" }]);
  });

  it("refuses the heuristic when fewer than 3 tools share a prefix", () => {
    const shadows = resolveShadowedClis({
      namespace: "unknown",
      toolCache: [{ name: "npm_search" }, { name: "npm_audit" }],
    });
    expect(shadows).toEqual([]);
  });

  it("refuses the heuristic for unlisted prefixes (no false positives)", () => {
    // Three tools share the prefix `get` — but `get` isn't in the
    // KNOWN_CLI_PREFIXES list, so we don't invent a "get" CLI.
    const shadows = resolveShadowedClis({
      namespace: "unknown",
      toolCache: [{ name: "get_user" }, { name: "get_repo" }, { name: "get_file" }],
    });
    expect(shadows).toEqual([]);
  });
});

describe("formatShadowLine", () => {
  it("formats a simple shadow", () => {
    expect(formatShadowLine({ namespace: "tailscale" })).toBe("prefer over local CLI: `tailscale`");
  });

  it("includes subcommand hints when restricted", () => {
    const line = formatShadowLine({ namespace: "npmjs" });
    expect(line).toContain("`npm` (");
    expect(line).toContain("deprecate");
  });

  it("returns null for servers that shadow nothing", () => {
    expect(formatShadowLine({ namespace: "linear" })).toBeNull();
    expect(formatShadowLine({ namespace: "unknown-xyz" })).toBeNull();
  });
});

describe("SHADOW_INSTALL_TARGETS / installTargetForCli", () => {
  it("resolves each of the seven first-party CLI targets", () => {
    expect(installTargetForCli("aws")).toEqual({ package: "@yawlabs/aws-mcp", namespace: "aws", name: "AWS" });
    expect(installTargetForCli("caddy")).toEqual({ package: "@yawlabs/caddy-mcp", namespace: "caddy", name: "Caddy" });
    expect(installTargetForCli("curl")).toEqual({ package: "@yawlabs/fetch-mcp", namespace: "fetch", name: "Fetch" });
    expect(installTargetForCli("wget")).toEqual({ package: "@yawlabs/fetch-mcp", namespace: "fetch", name: "Fetch" });
    expect(installTargetForCli("psql")).toEqual({
      package: "@yawlabs/postgres-mcp",
      namespace: "postgres",
      name: "Postgres",
    });
    expect(installTargetForCli("pg_dump")).toEqual({
      package: "@yawlabs/postgres-mcp",
      namespace: "postgres",
      name: "Postgres",
    });
    expect(installTargetForCli("tailscale")).toEqual({
      package: "@yawlabs/tailscale-mcp",
      namespace: "tailscale",
      name: "Tailscale",
    });
  });

  it("returns undefined for CLIs with no first-party target", () => {
    // These are in NAMESPACE_REGISTRY (so they shadow installed servers)
    // but are deliberately NOT install-nudge targets — we never push
    // npm/ssh/gh/kubectl/docker unprompted.
    for (const cli of ["npm", "ssh", "gh", "kubectl", "docker", "scp", "wrangler", "stripe"]) {
      expect(installTargetForCli(cli)).toBeUndefined();
    }
  });

  it("is the exact seven-entry first-party allowlist (no accidental additions)", () => {
    expect(Object.keys(SHADOW_INSTALL_TARGETS).sort()).toEqual(
      ["aws", "caddy", "curl", "pg_dump", "psql", "tailscale", "wget"].sort(),
    );
    // Every target package is under the @yawlabs scope.
    for (const target of Object.values(SHADOW_INSTALL_TARGETS)) {
      expect(target.package.startsWith("@yawlabs/")).toBe(true);
    }
  });

  it("matches the CLI name exactly (no path/case fuzzing here)", () => {
    expect(installTargetForCli("AWS")).toBeUndefined();
    expect(installTargetForCli("/usr/bin/aws")).toBeUndefined();
  });

  it("returns undefined for inherited Object.prototype keys", () => {
    // The CLI name arrives from a shell-history line, so a bare index could
    // hand back Object.prototype.constructor and be reported as an install
    // target whose `.package` is undefined.
    for (const cli of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(installTargetForCli(cli)).toBeUndefined();
    }
  });
});

describe("cliToNamespaces", () => {
  it("maps npm back to the npmjs + npm namespaces", () => {
    const reverse = cliToNamespaces();
    const namespaces = reverse.get("npm") ?? [];
    expect(namespaces).toContain("npmjs");
    expect(namespaces).toContain("npm");
  });

  it("maps kubectl back to every namespace that shadows it", () => {
    const reverse = cliToNamespaces();
    const namespaces = reverse.get("kubectl") ?? [];
    // Sort a COPY. Sorting in place used to reorder module state through the
    // returned reference; the leak is fixed, but sorting the copy keeps this
    // assertion from depending on the isolation it isn't testing.
    expect([...namespaces].sort()).toEqual(["k8s", "kubectl", "kubernetes"]);
  });

  it("returns an equal-but-independent Map on repeat calls", () => {
    // Equality, not identity: the lazily built index is process-wide module
    // state, so it is copied out rather than aliased (doctor embeds
    // `get(cli)` straight into its ShadowHit rows). The build-once cache is
    // still there -- it just isn't the object callers get back.
    expect(cliToNamespaces()).toEqual(cliToNamespaces());
    expect(cliToNamespaces()).not.toBe(cliToNamespaces());
  });

  it("does not let a caller mutate the shared index", () => {
    const first = cliToNamespaces();
    first.get("kubectl")?.push("bogus_namespace");
    first.delete("npm");
    const second = cliToNamespaces();
    expect(second.get("kubectl")).not.toContain("bogus_namespace");
    expect(second.get("npm")).toContain("npmjs");
  });
});
