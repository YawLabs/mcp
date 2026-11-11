// `yaw-mcp import` on a Windows box whose %APPDATA% is redirected away from
// <home>\AppData\Roaming. These are the PRODUCTION-shaped calls: no `home` and
// no `appData` in the options, which is what the dispatcher passes. Every
// other import test overrides `home`, and an overridden home deliberately
// keeps %APPDATA% inside it (resolveAppDataDir), so none of them can see the
// ambient variable being ignored.
//
// `homedir()` is mocked to a temp dir so bundles.json and the rest of the run
// stay out of the real profile; that is the reason this is its own file.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = (): string => fake.home || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { tmpdir } from "node:os";
import { runImport } from "../import-cmd.js";

let root: string;
let redirected: string;
let cwd: string;
let savedAppData: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yaw-import-appdata-"));
  fake.home = join(root, "home");
  redirected = join(root, "redirected-roaming");
  cwd = join(root, "project");
  for (const d of [fake.home, redirected, cwd]) mkdirSync(d, { recursive: true });
  savedAppData = process.env.APPDATA;
  process.env.APPDATA = redirected;
});

afterEach(() => {
  if (savedAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = savedAppData;
  fake.home = "";
  rmSync(root, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

describe("runImport -- a redirected %APPDATA% is where the client's file is", () => {
  it("reads Claude Desktop's config from the ambient %APPDATA%, not from <home>/AppData/Roaming", async () => {
    mkdirSync(join(redirected, "Claude"), { recursive: true });
    const file = join(redirected, "Claude", "claude_desktop_config.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "gh"] } } }, null, 2));
    const cap = capture();
    const r = await runImport({ clientId: "claude-desktop", os: "windows", cwd, dryRun: true, ...cap });
    expect(cap.errText()).not.toMatch(/does not exist/);
    expect(r.exitCode).toBe(0);
    expect(cap.text()).toContain(file);
    expect(cap.text()).toContain("github");
  });

  it("searches the client's other scopes under the same %APPDATA%", async () => {
    // The broker sits in VS Code's USER file, which lives under %APPDATA%; the
    // servers are imported from a workspace file. The search that decides
    // whether removing the originals is safe has to look where VS Code does.
    mkdirSync(join(redirected, "Code", "User"), { recursive: true });
    writeFileSync(
      join(redirected, "Code", "User", "mcp.json"),
      JSON.stringify({ servers: { mcp: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] } } }, null, 2),
    );
    mkdirSync(join(cwd, ".vscode"), { recursive: true });
    writeFileSync(
      join(cwd, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { github: { command: "npx", args: ["-y", "gh"] } } }, null, 2),
    );
    const cap = capture();
    const r = await runImport({
      clientId: "vscode",
      scope: "project",
      projectDir: cwd,
      os: "windows",
      cwd,
      dryRun: true,
      removeOriginals: true,
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.errText()).not.toMatch(/Would not remove the originals/);
    expect(cap.text()).toMatch(/Would remove 1 entry/);
  });
});
