// doctor and `install --list` report EVERY copy of a slot's config that this
// machine has, not the first site alone. Cline is the one client with more
// than one: a shared file plus a copy per editor its extension has run in.
// install and uninstall act on all of them, so a report of the shared file
// alone hid a copy holding no entry (or a stale one).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeClientsAsync, runDoctor } from "../doctor-cmd.js";
import { runInstall } from "../install-cmd.js";

/** probeOam's answer when oam is not installed: keeps the real probe (a spawn
 *  of `oam --version`) out of the suite. */
const oamNotInstalled = () => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-sites-"));
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

const BROKER = { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] };

/** Cline's shared settings file, with the broker wired in. */
function writeShared(): string {
  const dir = join(synthHome, ".cline", "data", "settings");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "cline_mcp_settings.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { mcp: BROKER } }));
  return file;
}

/** The VS Code copy (Linux layout): the extension's globalStorage dir exists,
 *  and its settings file holds another server but NOT the broker. */
function writeVsCodeCopy(): string {
  const dir = join(synthHome, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "cline_mcp_settings.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "fs"] } } }));
  return file;
}

const probe = () => ({ home: synthHome, os: "linux" as const, cwd: synthCwd });

describe("client probes -- one row per copy of a slot's config", () => {
  it("probes only the first site by default, and every present one with allSites", async () => {
    const shared = writeShared();
    const copy = writeVsCodeCopy();
    const first = (await probeClientsAsync(probe())).filter((p) => p.clientId === "cline");
    expect(first.map((p) => p.path)).toEqual([shared]);
    expect(first[0].site).toBeUndefined();

    const all = (await probeClientsAsync({ ...probe(), allSites: true })).filter((p) => p.clientId === "cline");
    expect(all.map((p) => [p.site, p.path, p.hasMcpEntry])).toEqual([
      ["shared settings", shared, true],
      ["VS Code", copy, false],
    ]);
  });

  it("leaves a slot with one copy on this machine exactly as it was: no `site`, one row", async () => {
    writeShared();
    const withAll = await probeClientsAsync({ ...probe(), allSites: true });
    expect(withAll).toEqual(await probeClientsAsync(probe()));
    expect(withAll.every((p) => p.site === undefined)).toBe(true);
  });

  it("doctor --json and the text CLIENTS section carry the editor copy", async () => {
    writeShared();
    const copy = writeVsCodeCopy();
    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: {},
      os: "linux",
      out,
      err: () => {},
      oamProbe: oamNotInstalled,
      json: true,
      skipRegistryCheck: true,
    });
    const parsed = JSON.parse(lines.join(""));
    const cline = (parsed.clients as Array<{ clientId: string; site?: string; path: string; hasMcpEntry: boolean }>)
      .filter((c) => c.clientId === "cline")
      .map((c) => [c.site, c.path, c.hasMcpEntry]);
    expect(cline).toContainEqual(["VS Code", copy, false]);
    expect(cline.length).toBe(2);

    const text: string[] = [];
    await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: {},
      os: "linux",
      out: (s: string) => text.push(s),
      err: () => {},
      oamProbe: oamNotInstalled,
      skipRegistryCheck: true,
    });
    const body = text.join("");
    expect(body).toMatch(/Cline \(user, shared settings\): /);
    expect(body).toMatch(/Cline \(user, VS Code\): /);
  });

  it("install --list prints a row for the editor copy, named by its label", async () => {
    writeShared();
    writeVsCodeCopy();
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
    const shared = r.messages.find((m) => m.includes("Cline (shared settings)"));
    const copy = r.messages.find((m) => m.includes("Cline (VS Code)"));
    expect(shared).toMatch(/installed/);
    expect(copy).toMatch(/other-entries/);
    expect(copy).toContain("globalStorage");
  });
});
