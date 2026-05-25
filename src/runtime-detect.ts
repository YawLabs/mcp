import { spawn } from "node:child_process";
import { request } from "undici";
import { log } from "./logger.js";

// Probe the user's machine for runtimes that catalog servers depend on
// (node, python, uvx, docker). The dashboard uses the snapshot to warn
// before adding a server whose runtime is missing locally — fewer
// "command not found" surprises at first activation.
//
// We deliberately don't require any of these — yaw-mcp itself runs on
// Node, but a user might only run JS-based servers, so missing python
// is just informational. The detection is best-effort: if a probe
// hangs or errors, we record the runtime as absent and move on.

const PROBE_TIMEOUT_MS = 3_000;
const RUNTIME_REPORT_PATH = "/api/connect/runtimes";

let apiUrl = "";
let token = "";

export function initRuntimeDetect(url: string, tok: string): void {
  apiUrl = url;
  token = tok;
}

interface Probe {
  bin: string;
  args: string[];
  // Parser pulls the first version-shaped token out of the command
  // output. Returns true (binary present, no version captured) when the
  // probe succeeded but the output didn't include a parseable version.
  parse?: (output: string) => string | true;
}

const PROBES: Record<string, Probe> = {
  node: {
    bin: "node",
    args: ["--version"],
    parse: (out) => out.trim().replace(/^v/, "") || true,
  },
  npx: {
    bin: "npx",
    args: ["--version"],
    parse: (out) => out.trim() || true,
  },
  python: {
    bin: process.platform === "win32" ? "python" : "python3",
    args: ["--version"],
    parse: (out) => {
      const m = out.match(/Python\s+(\d+\.\d+\.\d+)/);
      return m ? m[1] : true;
    },
  },
  uvx: {
    bin: "uvx",
    args: ["--version"],
    parse: (out) => {
      const m = out.match(/(\d+\.\d+\.\d+)/);
      return m ? m[1] : true;
    },
  },
  docker: {
    bin: "docker",
    args: ["--version"],
    parse: (out) => {
      const m = out.match(/Docker version (\d+\.\d+\.\d+)/);
      return m ? m[1] : true;
    },
  },
};

// Run one probe with a hard timeout. Resolves to a version string,
// `true` (present without parseable version), or `false` (absent /
// errored / timed out). Never throws.
async function probe(name: string, p: Probe): Promise<string | boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: string | boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(p.bin, p.args, {
        stdio: ["ignore", "pipe", "pipe"],
        // Windows needs a shell for PATH lookup of .cmd/.bat shims —
        // node/npx/uvx arrive as `npx.cmd` in PATH, and native spawn
        // with shell:false only resolves .exe. Without this, probes
        // falsely report `npx: false` on every Windows machine and
        // mcp.hosting's Test button pre-flight short-circuits with
        // "npx not detected" even though upstream activation (which
        // goes through cross-spawn in the MCP SDK) would work fine.
        // All probe args are fixed `--version` strings with no shell
        // metacharacters, so cmd.exe quoting is a non-issue.
        shell: process.platform === "win32",
        windowsHide: process.platform === "win32",
      });
    } catch {
      settle(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      settle(false);
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.on("error", () => {
      clearTimeout(timer);
      settle(false);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle(false);
        return;
      }
      // Some tools (older python) print to stderr instead of stdout.
      const text = stdout || stderr;
      if (p.parse) {
        const parsed = p.parse(text);
        settle(parsed);
      } else {
        settle(true);
      }
    });

    void name; // reserved for future per-probe logging
  });
}

// Detect every known runtime in parallel, build a flat snapshot. Each
// value is the version string when known, `true` for "present without
// a version we could parse", or `false` for absent. Optional runtimes
// stay in the snapshot as `false` so the dashboard can render the
// negative case ("docker: not detected") rather than guessing.
export async function detectRuntimes(): Promise<Record<string, string | boolean>> {
  const entries = await Promise.all(
    Object.entries(PROBES).map(async ([name, p]) => [name, await probe(name, p)] as const),
  );
  const out: Record<string, string | boolean> = {};
  for (const [name, value] of entries) out[name] = value;
  return out;
}

// Detect locally then POST to mcp.hosting. Failure is non-fatal — the
// dashboard simply doesn't show a runtime warning, which is the same
// behavior as the user never having installed a recent yaw-mcp version.
export async function reportRuntimes(): Promise<void> {
  if (!apiUrl || !token) return;
  let runtimes: Record<string, string | boolean>;
  try {
    runtimes = await detectRuntimes();
  } catch (err: any) {
    log("warn", "Runtime detection failed", { error: err?.message });
    return;
  }
  try {
    const res = await request(`${apiUrl.replace(/\/$/, "")}${RUNTIME_REPORT_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runtimes }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    await res.body.text().catch(() => {});
    if (res.statusCode >= 400 && res.statusCode !== 404) {
      log("warn", "Runtime report failed", { status: res.statusCode });
    } else {
      log("info", "Reported runtimes to mcp.hosting", { runtimes });
    }
  } catch (err: any) {
    log("warn", "Runtime report error", { error: err?.message });
  }
}
