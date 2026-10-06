// Runtime contracts yaw-mcp relies on, checked against the REAL oam on this
// machine rather than against the code's shape.
//
// Every other oam test in this repo mocks the binary, which is right for the
// probe and the spawn rewrite but blind to the runtime itself. That blindness
// cost a real leak: up to oam 0.17.x an explicit spawn `env` was laid over
// the environment oam started with, so a broker launched as `oam run ...
// dist/index.js` with the vault passphrase in its client env block handed it
// to every child -- while the spawn-shape scan in internal-secret-env.test.ts
// stayed green, because every call site DID pass the stripped env.
//
// The suite runs only where probeOam() finds a usable oam -- installed and at
// or above MIN_OAM_VERSION, the same gate the broker uses before hosting
// anything on it. Without one it skips: there is no runtime to check, and a
// below-floor oam is one the broker never hosts on.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stripInternalSecretsFromEnv } from "../internal-secret-env.js";
import { oamHeapOomHint, probeOam } from "../oam-spawn.js";

const probe = await probeOam();
const OAM = probe.bin;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runOam(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(OAM as string, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(OAM === null)(`oam runtime contracts (oam ${probe.version ?? "absent"})`, () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(nodePath.join(tmpdir(), "yaw-oam-contract-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a child spawned with the stripped env does not see the vault passphrase the oam-hosted parent started with", async () => {
    const SENTINEL = "oam-contract-sentinel-passphrase";
    const startEnv = { ...process.env, YAW_MCP_VAULT_PASSPHRASE: SENTINEL };

    const child = nodePath.join(dir, "child.mjs");
    writeFileSync(
      child,
      "process.stdout.write(JSON.stringify({ seen: process.env.YAW_MCP_VAULT_PASSPHRASE ?? null }));\n",
    );
    // The env the broker would hand a child, computed by the real helper from
    // the same start-up env the parent gets.
    const envFile = nodePath.join(dir, "child-env.json");
    writeFileSync(envFile, JSON.stringify(stripInternalSecretsFromEnv(startEnv)));

    // The parent runs ON oam and spawns its child the way the broker does: an
    // async spawn with an explicit env. A second child with no env option is
    // the control -- it must inherit the passphrase, or the first assertion
    // could pass because the passphrase never reached the parent at all.
    const parent = nodePath.join(dir, "parent.mjs");
    writeFileSync(
      parent,
      [
        'import { spawn } from "node:child_process";',
        'import { readFileSync } from "node:fs";',
        "const [childPath, envFile] = process.argv.slice(2);",
        "const run = (opts) => new Promise((resolve, reject) => {",
        '  const c = spawn(process.execPath, ["run", childPath], { stdio: ["ignore", "pipe", "pipe"], ...opts });',
        '  let out = ""; let err = "";',
        '  c.stdout.on("data", (d) => { out += d; });',
        '  c.stderr.on("data", (d) => { err += d; });',
        '  c.on("error", reject);',
        '  c.on("close", (code) => code === 0 ? resolve(JSON.parse(out).seen) : reject(new Error(`child exit ${code}: ${err}`)));',
        "});",
        'const explicit = JSON.parse(readFileSync(envFile, "utf8"));',
        "const result = {",
        "  parentSees: process.env.YAW_MCP_VAULT_PASSPHRASE ?? null,",
        "  inherited: await run({}),",
        "  stripped: await run({ env: explicit }),",
        "};",
        "process.stdout.write(JSON.stringify(result));",
        "",
      ].join("\n"),
    );

    const r = await runOam(["run", parent, "--", child, envFile], startEnv);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ parentSees: SENTINEL, inherited: SENTINEL, stripped: null });
  });

  it("a child that exhausts its heap cap exits 134 with OAM-RT-OOM on stderr, a clean stdout, and gets the heap hint", async () => {
    const script = nodePath.join(dir, "oom.mjs");
    writeFileSync(script, "const keep = [];\nfor (;;) keep.push(new Array(1e6).fill(Math.random()));\n");

    // A small cap keeps the run to a fraction of a second; the banner and the
    // exit code are the same at any cap.
    const r = await runOam(["run", script], { ...process.env, OAM_MAX_HEAP_MB: "64" });
    expect(r.code).toBe(134);
    expect(r.stderr).toContain("error[OAM-RT-OOM]");
    // stdout is the MCP protocol channel for a hosted sidecar; the death must
    // not write to it.
    expect(r.stdout).toBe("");
    const hint = oamHeapOomHint(r.stderr);
    expect(hint, `no hint for this stderr:\n${r.stderr}`).not.toBeNull();
    expect(hint).toContain("OAM_MAX_HEAP_MB");
  });
});
