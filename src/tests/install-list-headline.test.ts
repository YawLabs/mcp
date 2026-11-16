// `install --list` headline: "N/M client scopes have yaw-mcp configured".
// The table below it has one row per COPY of a slot's config (Cline: the
// shared file plus one per editor), but the headline counts (client, scope)
// slots, so a second copy must not add to either number.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInstall } from "../install-cmd.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-headline-"));
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

const BROKER = { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] };
const OTHER = { command: "npx", args: ["-y", "fs"] };

/** Cline's shared settings file, with the broker wired in. */
function writeShared(): void {
  const dir = join(synthHome, ".cline", "data", "settings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cline_mcp_settings.json"), JSON.stringify({ mcpServers: { mcp: BROKER } }));
}

/** Cline's VS Code copy (Linux layout), with or without the broker. */
function writeVsCodeCopy(withBroker: boolean): void {
  const dir = join(synthHome, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "cline_mcp_settings.json"),
    JSON.stringify({ mcpServers: withBroker ? { mcp: BROKER } : { fs: OTHER } }),
  );
}

/** The headline's [N, M] and how many Cline rows the table printed. */
async function list(): Promise<{ counts: [number, number]; clineRows: number }> {
  const r = await runInstall({
    os: "linux",
    home: synthHome,
    cwd: synthCwd,
    listOnly: true,
    io: {
      stdin: process.stdin,
      stdout: new PassThrough().resume(),
      stderr: new PassThrough().resume(),
      isTTY: false,
    },
  });
  expect(r.exitCode).toBe(0);
  const headline = r.messages.map((m) => /^(\d+)\/(\d+) client scopes have yaw-mcp configured on linux\./.exec(m));
  const m = headline.find((h) => h !== null);
  if (!m) throw new Error(`no headline in:\n${r.messages.join("\n")}`);
  return {
    counts: [Number(m[1]), Number(m[2])],
    clineRows: r.messages.filter((x) => /^\s+Cline\b/.test(x)).length,
  };
}

describe("install --list headline -- one count per (client, scope), not per config copy", () => {
  it("a second copy of a slot's config adds a row, and nothing to either number", async () => {
    writeShared();
    const one = await list();
    expect(one.clineRows).toBe(1);
    expect(one.counts[0]).toBe(1);

    writeVsCodeCopy(true);
    const two = await list();
    // The copy is listed...
    expect(two.clineRows).toBe(2);
    // ...and both copies hold the entry, yet it is still ONE configured scope
    // out of the same number of scopes.
    expect(two.counts).toEqual(one.counts);
  });

  it("a slot with a copy that lacks the entry is not counted as configured", async () => {
    writeShared();
    const [, total] = (await list()).counts;
    writeVsCodeCopy(false);
    expect((await list()).counts).toEqual([0, total]);
  });
});
