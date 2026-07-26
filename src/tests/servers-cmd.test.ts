import { describe, expect, it } from "vitest";
import { parseServersArgs, runServersCommand, SERVERS_DEPRECATED_MESSAGE } from "../servers-cmd.js";

function captureIO(): { out: string[]; err: string[]; push: (s: string) => void; pushErr: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    push: (s: string) => {
      out.push(s);
    },
    pushErr: (s: string) => {
      err.push(s);
    },
  };
}

describe("parseServersArgs", () => {
  it("defaults to json=false with no args", () => {
    expect(parseServersArgs([])).toEqual({ ok: true, options: { json: false } });
  });

  it("accepts --json", () => {
    expect(parseServersArgs(["--json"])).toEqual({ ok: true, options: { json: true } });
  });

  it("rejects unknown flags", () => {
    const r = parseServersArgs(["--wat"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown argument "--wat"');
  });

  it("--help returns the usage string as an error", () => {
    const r = parseServersArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Usage: yaw-mcp servers");
  });

  it("--help usage marks the command deprecated and points at `list`", () => {
    const r = parseServersArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("DEPRECATED");
      expect(r.error).toContain("yaw-mcp list");
    }
  });

  it("accepts a positional namespace filter", () => {
    const r = parseServersArgs(["github"]);
    expect(r).toEqual({ ok: true, options: { json: false, filter: "github" } });
  });

  it("accepts filter combined with --json in any order", () => {
    expect(parseServersArgs(["git", "--json"])).toEqual({
      ok: true,
      options: { json: true, filter: "git" },
    });
    expect(parseServersArgs(["--json", "git"])).toEqual({
      ok: true,
      options: { json: true, filter: "git" },
    });
  });

  it("rejects a second positional arg", () => {
    const r = parseServersArgs(["git", "hub"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('extra argument "hub"');
  });
});

describe("runServersCommand (deprecated stub)", () => {
  it("always exits non-zero", async () => {
    const io = captureIO();
    const r = await runServersCommand({ out: io.push, err: io.pushErr });
    expect(r.exitCode).not.toBe(0);
    expect(r.exitCode).toBe(1);
  });

  it("explains that account mode is gone and points at `yaw-mcp list` on stderr", async () => {
    const io = captureIO();
    await runServersCommand({ out: io.push, err: io.pushErr });
    const combinedErr = io.err.join("");
    expect(combinedErr).toContain("account mode has been removed");
    expect(combinedErr).toContain("yaw-mcp list");
    // Message goes to stderr only in text mode -- stdout stays empty so a
    // script piping stdout gets nothing rather than a pseudo-listing.
    expect(io.out).toEqual([]);
  });

  it("still exits non-zero under --json (the panel's signed-in signal)", async () => {
    const io = captureIO();
    const r = await runServersCommand({ json: true, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(1);
  });

  it("emits parseable JSON on stdout under --json, with the reason on stderr", async () => {
    const io = captureIO();
    await runServersCommand({ json: true, out: io.push, err: io.pushErr });
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.ok).toBe(false);
    expect(parsed.deprecated).toBe(true);
    expect(parsed.error).toBe(SERVERS_DEPRECATED_MESSAGE);
    expect(io.err.join("")).toContain("account mode has been removed");
  });

  it("does NOT emit a servers array in any mode", async () => {
    const io = captureIO();
    await runServersCommand({ json: true, out: io.push, err: io.pushErr });
    // Yaw Terminal's sidecar reads `signedIn` from `servers --json`. A
    // servers array here (even empty) plus a zero exit would read as an
    // account; the non-zero exit above is what routes it to local mode.
    expect(JSON.parse(io.out.join("\n")).servers).toBeUndefined();
  });

  it("ignores a namespace filter rather than erroring on it", async () => {
    const io = captureIO();
    const r = await runServersCommand({ filter: "github", out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(1);
    expect(io.err.join("")).toContain("account mode has been removed");
  });
});
