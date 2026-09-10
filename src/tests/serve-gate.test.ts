import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideServeMode, STDIO_OVERRIDE_ENV } from "../serve-gate.js";

// A bare `yaw-mcp` is two commands sharing one name: the MCP server launch
// (stdin on a pipe, JSON-RPC arriving) and the first thing a new user types
// (stdin on a terminal, nothing arriving ever). These pin the split.
//
// index.ts dispatches at import time and cannot be imported, which is why the
// decision lives in its own module -- and why the two source-shape checks at
// the bottom are here: they are the only thing proving the dispatcher
// actually calls it.

const INDEX_SRC = fileURLToPath(new URL("../index.ts", import.meta.url));

describe("decideServeMode", () => {
  it("serves when stdin is a pipe -- the MCP client launch path", () => {
    // Node leaves isTTY UNDEFINED for a pipe, which is what
    // StdioClientTransport gives the child. This is the case that must never
    // change: an explain here is a broken client launch for every user.
    expect(decideServeMode({}, {})).toEqual({ kind: "serve" });
  });

  it("serves when stdin is a file or /dev/null (isTTY undefined again)", () => {
    // `yaw-mcp < requests.jsonl` and a supervisor spawning with stdin on
    // /dev/null both land here. Same undefined, same answer.
    expect(decideServeMode({ isTTY: undefined }, {})).toEqual({ kind: "serve" });
  });

  it("serves when stdin is missing entirely", () => {
    // Defensive: an embedding host can substitute a stdio stub with no isTTY
    // at all. Serving is the pre-existing behaviour, so an unknown stdin must
    // not start refusing.
    expect(decideServeMode(undefined, {})).toEqual({ kind: "serve" });
  });

  it("explains instead of blocking when stdin is a terminal", () => {
    const decision = decideServeMode({ isTTY: true }, {});
    expect(decision.kind).toBe("explain");
    if (decision.kind !== "explain") return;
    // The three things the user needs: what this command is, that nothing
    // started, and where to go next.
    expect(decision.text).toContain("MCP server");
    expect(decision.text).toContain("the server was not started");
    expect(decision.text).toContain("yaw-mcp --help");
    expect(decision.text).toContain("yaw-mcp install claude-code");
    // And the escape hatch, or the refusal is a dead end for the one case
    // the heuristic gets wrong on purpose.
    expect(decision.text).toContain(`${STDIO_OVERRIDE_ENV}=1`);
  });

  it("serves on a terminal when YAW_MCP_STDIO=1 overrides the gate", () => {
    expect(decideServeMode({ isTTY: true }, { [STDIO_OVERRIDE_ENV]: "1" })).toEqual({ kind: "serve" });
  });

  it("honors an override that arrived with cmd.exe's trailing space", () => {
    // `set YAW_MCP_STDIO=1 && yaw-mcp` keeps the space before `&&`, so the
    // value is "1 ". An exact match would drop an override the user did set
    // -- the same trap isAutoLoadEnabled documents in server.ts.
    expect(decideServeMode({ isTTY: true }, { [STDIO_OVERRIDE_ENV]: "1 " })).toEqual({ kind: "serve" });
  });

  it("does not treat any other override value as opt-in", () => {
    // "0" is what a user sets to turn something OFF; an empty string is a
    // declared-but-unset CI variable. Neither may force the server on.
    for (const value of ["0", "", "true", "yes"]) {
      expect(decideServeMode({ isTTY: true }, { [STDIO_OVERRIDE_ENV]: value }).kind).toBe("explain");
    }
  });
});

describe("index.ts wiring", () => {
  it("routes the bare-yaw-mcp branch through decideServeMode", async () => {
    // Without this the module could be perfectly correct and never called:
    // the dispatcher runs at import time, so no behavioural test can reach
    // that branch from inside the suite.
    const src = await readFile(INDEX_SRC, "utf8");
    expect(src).toContain("decideServeMode(process.stdin, process.env)");
  });

  it("documents YAW_MCP_STDIO in the --help environment block", async () => {
    // The env-coverage guard in index-dispatch.test.ts scans for literal
    // `process.env.NAME` reads and cannot see this one (it is read off an
    // injected `env` bag through a const), so the doc line needs its own
    // guard or it silently rots.
    const src = await readFile(INDEX_SRC, "utf8");
    const start = src.indexOf("Environment variables:");
    const end = src.indexOf("Config resolution");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).toContain(STDIO_OVERRIDE_ENV);
  });
});
