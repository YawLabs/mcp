import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPLIANCE_USAGE, projectForPublish, runComplianceCommand } from "../compliance-cmd.js";

// Only the pre-spawn arg paths are exercised here (--help and missing
// <target>). Both return before spawning the mcp-compliance child, so these
// tests never touch the network or npx.
describe("runComplianceCommand arg handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--help prints usage to stdout and exits 0 (does not spawn the sub-tool)", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await runComplianceCommand(["--help"]);
    expect(code).toBe(0);
    expect(out).toHaveBeenCalledWith(COMPLIANCE_USAGE);
    expect(err).not.toHaveBeenCalled();
  });

  it("-h behaves like --help", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = await runComplianceCommand(["-h"]);
    expect(code).toBe(0);
    expect(out).toHaveBeenCalledWith(COMPLIANCE_USAGE);
  });

  it("missing <target> prints usage to stderr and exits 2 (arg-error convention)", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await runComplianceCommand([]);
    expect(code).toBe(2);
    expect(err).toHaveBeenCalledWith(COMPLIANCE_USAGE);
    expect(out).not.toHaveBeenCalled();
  });

  it("--publish alone (no target) still exits 2, not 1", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await runComplianceCommand(["--publish"]);
    expect(code).toBe(2);
  });
});

describe("projectForPublish allowlist", () => {
  it("strips extra top-level fields and per-test fields not on the allowlist", () => {
    const raw = {
      grade: "A",
      score: 91.5,
      url: "https://example.com/mcp",
      summary: { total: 10, passed: 9, failed: 1, required: 5, requiredPassed: 5 },
      tests: [
        {
          name: "tools/list",
          status: "pass",
          required: true,
          message: "ok",
          // Fields the suite might echo back -- must NOT survive projection.
          env: { SECRET_TOKEN: "leak-me" },
          argv: ["--secret", "value"],
          stack: "Error: at /home/user/secret/path",
        },
      ],
      // Extra top-level junk that must be dropped.
      rawEnv: { AWS_SECRET_ACCESS_KEY: "leak" },
      argv: ["npx", "-y", "thing"],
    } as unknown as Parameters<typeof projectForPublish>[0];

    const out = projectForPublish(raw);

    expect(Object.keys(out).sort()).toEqual(["grade", "score", "summary", "tests", "url"]);
    expect(out.tests).toHaveLength(1);
    expect(Object.keys(out.tests[0]).sort()).toEqual(["message", "name", "required", "status"]);

    // No leaked values anywhere in the serialized body.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("leak");
    expect(serialized).not.toContain("SECRET_TOKEN");
    expect(serialized).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(serialized).not.toContain("stack");
  });

  it("tolerates a non-array tests field and malformed test entries", () => {
    const raw = {
      grade: "F",
      score: 0,
      url: "https://example.com/mcp",
      summary: { total: 0, passed: 0, failed: 0, required: 0, requiredPassed: 0 },
      tests: "not-an-array",
    } as unknown as Parameters<typeof projectForPublish>[0];

    const out = projectForPublish(raw);
    expect(out.tests).toEqual([]);
  });
});
