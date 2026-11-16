// A git entry names a vault secret OUTSIDE env and headers: the bare NAME in
// `git.tokenSecret`, read at clone time. `secrets set` already counts it as a
// reference; doctor's vault section and mcp_connect_secrets did not, so a
// token the vault does not hold was reported as nothing missing, and the
// server as needing no secrets.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../doctor-cmd.js";
import { computeSecretsReport } from "../meta-tools.js";

const GIT = {
  url: "https://example.test/acme/server.git",
  commit: "0123456789abcdef0123456789abcdef01234567",
  entry: "dist/index.js",
  tokenSecret: "GIT_TOKEN",
};

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

describe("computeSecretsReport -- git.tokenSecret", () => {
  it("reports the token name as missing when the vault lacks it, and as held when it has it", () => {
    const servers = [{ namespace: "privrepo", type: "local", git: { tokenSecret: "GIT_TOKEN" } }];
    expect(computeSecretsReport(servers, new Set())).toEqual([
      { server: "privrepo", injectedSecrets: [], missing: ["GIT_TOKEN"], malformed: [] },
    ]);
    expect(computeSecretsReport(servers, new Set(["GIT_TOKEN"]))).toEqual([
      { server: "privrepo", injectedSecrets: ["GIT_TOKEN"], missing: [], malformed: [] },
    ]);
  });

  it("still omits a git entry with no token", () => {
    expect(computeSecretsReport([{ namespace: "pub", type: "local", git: {} }], new Set())).toEqual([]);
  });
});

describe("doctor vault section -- git.tokenSecret", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-git-token-"));
    cwd = mkdtempSync(join(home, "cwd-"));
    mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
    writeFileSync(
      join(home, ".yaw-mcp", "bundles.json"),
      JSON.stringify({ version: 1, servers: [{ namespace: "privrepo", name: "Private repo", git: GIT }] }),
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function doctor(json: boolean): Promise<string> {
    const lines: string[] = [];
    await runDoctor({
      cwd,
      home,
      env: {},
      os: "linux",
      out: (s: string) => lines.push(s),
      err: () => {},
      oamProbe: oamNotInstalled,
      json,
      skipRegistryCheck: true,
    });
    return lines.join("");
  }

  it("lists the entry under refs and the token under missing, in --json and in text", async () => {
    const parsed = JSON.parse(await doctor(true));
    expect(parsed.vault.refs).toEqual([
      { namespace: "privrepo", secretNames: ["GIT_TOKEN"], gitTokenSecret: "GIT_TOKEN" },
    ]);
    // No vault file: nothing is stored, so the token is missing.
    expect(parsed.vault.missing).toEqual(["GIT_TOKEN"]);

    const body = await doctor(false);
    expect(body).toContain("SECRET VAULT");
    expect(body).toContain("missing:    referenced but not stored -- GIT_TOKEN");
    expect(body).not.toContain("no server references ${secret:NAME}");
  });

  it("spells the token as the bare name it is, and does not say the server fails to start", async () => {
    // The entry holds no `${secret:GIT_TOKEN}` placeholder, and the vault is
    // read for the token only to clone or update: a built entry starts with
    // the vault locked, so the locked-vault note does not apply to it.
    const body = await doctor(false);
    expect(body).toContain("    privrepo: git.tokenSecret: GIT_TOKEN (needed to clone or update)");
    expect(body).not.toContain("${secret:GIT_TOKEN}");
    expect(body).not.toContain("TO START OR CONNECT while the vault is locked");
  });

  it("keeps the locked-vault note for the servers that do need the vault to start, by name", async () => {
    writeFileSync(
      join(home, ".yaw-mcp", "bundles.json"),
      JSON.stringify({
        version: 1,
        servers: [
          { namespace: "privrepo", name: "Private repo", git: GIT },
          { namespace: "gh", name: "GitHub", command: "npx", env: { GITHUB_TOKEN: "${secret:gh}" } },
          // The same name in env too: a start-time reference like any other.
          {
            namespace: "both",
            name: "Both",
            git: { ...GIT, tokenSecret: "SHARED" },
            env: { TOKEN: "${secret:SHARED}" },
          },
        ],
      }),
    );
    const parsed = JSON.parse(await doctor(true));
    expect(parsed.vault.refs).toEqual([
      { namespace: "privrepo", secretNames: ["GIT_TOKEN"], gitTokenSecret: "GIT_TOKEN" },
      { namespace: "gh", secretNames: ["gh"] },
      { namespace: "both", secretNames: ["SHARED"] },
    ]);
    expect(parsed.vault.missing).toEqual(["GIT_TOKEN", "SHARED", "gh"]);

    const body = await doctor(false);
    expect(body).toContain("    both: ${secret:SHARED}");
    expect(body).toContain("note:       gh, both FAIL TO START OR CONNECT while the vault is locked");
  });
});
