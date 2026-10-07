// SECRET VAULT -- the `plaintext:` block. Before it, the section listed the
// `${secret:NAME}` refs and the vault's entries and said nothing about a
// credential still written as a literal in bundles.json, so a half-done
// migration (TAILSCALE_API_KEY in the clear while the vault already held a
// `tailscale` entry) read as complete. Names only, never values; informational,
// like the rest of the section.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor as runDoctorUnstubbed } from "../doctor-cmd.js";
import { SECRETS_SCHEMA_VERSION } from "../secrets-vault.js";

/** Same stub as doctor-cmd.test.ts: never spawn the host's real oam. */
const oamNotInstalled = () => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});
const runDoctor: typeof runDoctorUnstubbed = (opts = {}) =>
  runDoctorUnstubbed({ ...opts, oamProbe: opts.oamProbe ?? oamNotInstalled, skipRegistryCheck: true });

const SALT_B64 = Buffer.alloc(16, 7).toString("base64");
// Long and distinctive, so a leak anywhere in the output is unmistakable.
const TS_KEY = "tskey-api-PLAINTEXT-must-not-leak-0001";
const GH_TOKEN = "ghp_PLAINTEXT_must_not_leak_0002";
const BEARER = "Bearer lin_api_PLAINTEXT_must_not_leak_0003";

let home: string;
let cwd: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "yaw-mcp-doctor-plaintext-")));
  cwd = realpathSync(mkdtempSync(join(home, "cwd-")));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeBundles(servers: unknown[]): void {
  mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
  writeFileSync(join(home, ".yaw-mcp", "bundles.json"), JSON.stringify({ version: 1, servers }));
}

function writeVault(names: string[]): void {
  mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
  const entries = Object.fromEntries(names.map((n) => [n, { iv: "x", ciphertext: "y", authTag: "z" }]));
  writeFileSync(
    join(home, ".yaw-mcp", "secrets.json"),
    JSON.stringify({ version: SECRETS_SCHEMA_VERSION, salt: SALT_B64, kdf: { N: 16384, r: 8, p: 1 }, entries }),
  );
}

async function text(): Promise<{ txt: string; exitCode: number }> {
  const lines: string[] = [];
  const r = await runDoctor({ cwd, home, env: {}, os: "linux", out: (s) => lines.push(s) });
  return { txt: lines.join(""), exitCode: r.exitCode };
}

async function json(): Promise<{ parsed: Record<string, unknown> & { vault: Record<string, unknown> }; raw: string }> {
  const r = await runDoctor({ cwd, home, env: {}, os: "linux", out: () => {}, json: true });
  return { parsed: JSON.parse(r.lines[0]), raw: r.lines[0] };
}

const tailscale = (env: Record<string, string>) => ({
  id: "ts-id",
  name: "Tailscale",
  namespace: "tailscale",
  type: "local",
  command: "npx",
  args: ["-y", "@yawlabs/tailscale-mcp"],
  env,
});

describe("SECRET VAULT -- plaintext credentials", () => {
  it("flags the half-migration: vault holds the namespace's entry, the server still sends the literal", async () => {
    writeVault(["tailscale"]);
    writeBundles([tailscale({ TAILSCALE_API_KEY: TS_KEY, TAILSCALE_TAILNET: "example.com" })]);
    const { txt, exitCode } = await text();
    expect(txt).toContain(
      `plaintext:  credentials stored IN THE CLEAR in ${join(home, ".yaw-mcp", "bundles.json")} (names only, never values):`,
    );
    expect(txt).toContain("    tailscale: env.TAILSCALE_API_KEY\n");
    expect(txt).toContain('the vault already holds "tailscale", but this server still sends the plaintext');
    // The entry exists, so the fix is the reference -- not a second copy.
    expect(txt).toContain("yaw-mcp set tailscale env.TAILSCALE_API_KEY='${secret:tailscale}'");
    expect(txt).not.toContain("      yaw-mcp secrets set tailscale\n");
    // --secret would REPLACE the stored entry; only the reference is missing.
    expect(txt).not.toContain("--secret");
    // Not credential-shaped by name, so not listed.
    expect(txt).not.toContain("TAILSCALE_TAILNET");
    expect(txt).not.toContain(TS_KEY);
    // Informational: a working literal is hygiene, not a failure.
    expect(exitCode).toBe(0);

    const { parsed, raw } = await json();
    expect(parsed.vault.plaintext).toEqual([
      { namespace: "tailscale", channel: "env", keys: ["TAILSCALE_API_KEY"], vaultEntries: ["tailscale"] },
    ]);
    expect(raw).not.toContain(TS_KEY);
  });

  it("renders the section with no vault at all, with the two-command move", async () => {
    writeBundles([
      {
        id: "gh-id",
        name: "GitHub",
        namespace: "gh",
        type: "local",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: GH_TOKEN },
      },
    ]);
    const { txt, exitCode } = await text();
    expect(txt).toContain("SECRET VAULT");
    expect(txt).toContain("(does not exist yet)");
    expect(txt).toContain("    gh: env.GITHUB_PERSONAL_ACCESS_TOKEN\n");
    expect(txt).toContain("      yaw-mcp secrets set gh\n");
    expect(txt).toContain("      yaw-mcp set gh env.GITHUB_PERSONAL_ACCESS_TOKEN='${secret:gh}'\n");
    expect(txt).toContain(
      "(or in one step: yaw-mcp set gh env.GITHUB_PERSONAL_ACCESS_TOKEN --secret --secret-name gh)",
    );
    expect(txt).not.toContain("already holds");
    expect(txt).not.toContain(GH_TOKEN);
    expect(exitCode).toBe(0);
  });

  it("skips refs, blank values, and non-credential names (no value sniffing)", async () => {
    writeBundles([
      tailscale({
        TAILSCALE_API_KEY: "${secret:tailscale}",
        // A malformed ref has its own line and remedy; not plaintext.
        OTHER_TOKEN: "${secret:bad name}",
        // Blank = read from the ambient env; nothing stored.
        BLANK_SECRET: "  ",
        DATABASE_URL: "postgres://user@localhost/db",
        TOKENIZER_PATH: "/opt/tok",
      }),
    ]);
    const { txt } = await text();
    expect(txt).not.toContain("plaintext:");
    const { parsed } = await json();
    expect(parsed.vault.plaintext).toEqual([]);
  });

  it("reads a remote server's headers (Authorization included), never its ignored env", async () => {
    writeBundles([
      {
        id: "linear-id",
        name: "Linear",
        namespace: "linear",
        type: "remote",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: BEARER, "X-Api-Key": "k-PLAINTEXT-0004", "X-Client": "doctor-test" },
        // Ignored on a remote by upstream, so not a credential in use.
        env: { LINEAR_API_KEY: "ignored-PLAINTEXT-0005" },
      },
    ]);
    const { txt } = await text();
    expect(txt).toContain("    linear: headers.Authorization, headers.X-Api-Key\n");
    expect(txt).not.toContain("X-Client");
    expect(txt).not.toContain("LINEAR_API_KEY");
    // Two keys: each gets its own namespace-qualified name -- the one
    // `set --secret` derives -- never the bare, cross-server key name.
    expect(txt).toContain("      yaw-mcp secrets set linear_authorization\n");
    expect(txt).toContain(
      'then make "headers"."Authorization" in bundles.json reference ${secret:linear_authorization}',
    );
    expect(txt).toContain("      yaw-mcp secrets set linear_x-api-key\n");
    // Bearer only where the header takes a scheme; X-Api-Key wants the bare key.
    expect(txt).toContain('(e.g. "Bearer ${secret:linear_authorization}")');
    expect(txt).toContain('(e.g. "${secret:linear_x-api-key}")');
    expect(txt).not.toContain('"Bearer ${secret:linear_x-api-key}"');
    expect(txt).not.toContain("secrets set Authorization");
    for (const leak of [BEARER, "lin_api_PLAINTEXT", "k-PLAINTEXT-0004", "ignored-PLAINTEXT-0005"]) {
      expect(txt).not.toContain(leak);
    }
    const { parsed, raw } = await json();
    expect(parsed.vault.plaintext).toEqual([
      { namespace: "linear", channel: "headers", keys: ["Authorization", "X-Api-Key"], vaultEntries: [] },
    ]);
    expect(raw).not.toContain("PLAINTEXT");
  });

  it("matches a vault entry named like the KEY, case-insensitively", async () => {
    writeVault(["tailscale_api_key"]);
    writeBundles([tailscale({ TAILSCALE_API_KEY: TS_KEY })]);
    const { txt } = await text();
    expect(txt).toContain('the vault already holds "tailscale_api_key"');
    expect(txt).toContain("yaw-mcp set tailscale env.TAILSCALE_API_KEY='${secret:tailscale_api_key}'");
  });

  it("never hands one server another server's generic-named entry", async () => {
    // linear already moved to ${secret:Authorization} / ${secret:X-Api-Key};
    // notion still sends both headers in the clear. Those entries are
    // linear's credentials -- pointing notion at them would send linear's token.
    writeVault(["Authorization", "X-Api-Key"]);
    writeBundles([
      {
        id: "linear-id",
        name: "Linear",
        namespace: "linear",
        type: "remote",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer ${secret:Authorization}", "X-Api-Key": "${secret:X-Api-Key}" },
      },
      {
        id: "notion-id",
        name: "Notion",
        namespace: "notion",
        type: "remote",
        url: "https://mcp.notion.com/mcp",
        headers: { Authorization: BEARER, "X-Api-Key": "k-PLAINTEXT-0006" },
      },
    ]);
    const { txt } = await text();
    expect(txt).toContain("    notion: headers.Authorization, headers.X-Api-Key\n");
    expect(txt).not.toContain("already holds");
    expect(txt).not.toContain("reference ${secret:Authorization}");
    expect(txt).not.toContain("reference ${secret:X-Api-Key}");
    expect(txt).toContain("      yaw-mcp secrets set notion_authorization\n");
    expect(txt).toContain("      yaw-mcp secrets set notion_x-api-key\n");
    for (const leak of [BEARER, "lin_api_PLAINTEXT", "k-PLAINTEXT-0006"]) expect(txt).not.toContain(leak);
    const { parsed } = await json();
    expect(parsed.vault.plaintext).toEqual([
      { namespace: "notion", channel: "headers", keys: ["Authorization", "X-Api-Key"], vaultEntries: [] },
    ]);
  });

  it("does not split a bare entry between two servers that both send the key in plaintext", async () => {
    writeVault(["Authorization"]);
    const remote = (ns: string) => ({
      id: `${ns}-id`,
      name: ns,
      namespace: ns,
      type: "remote",
      url: `https://${ns}.example.com/mcp`,
      headers: { Authorization: BEARER },
    });
    writeBundles([remote("alpha"), remote("beta")]);
    const { txt } = await text();
    expect(txt).not.toContain("already holds");
    // Lone key per server: the namespace is the fresh name, distinct per server.
    expect(txt).toContain("      yaw-mcp secrets set alpha\n");
    expect(txt).toContain("      yaw-mcp secrets set beta\n");
  });

  it("still matches a bare key entry nothing else owns, with the not-this-value caveat on a remote", async () => {
    writeVault(["X-Api-Key"]);
    writeBundles([
      {
        id: "notion-id",
        name: "Notion",
        namespace: "notion",
        type: "remote",
        url: "https://mcp.notion.com/mcp",
        headers: { "X-Api-Key": "k-PLAINTEXT-0007" },
      },
    ]);
    const { txt } = await text();
    expect(txt).toContain('the vault already holds "X-Api-Key"');
    expect(txt).toContain('      make "headers"."X-Api-Key" in bundles.json reference ${secret:X-Api-Key}\n');
    expect(txt).toContain('(e.g. "${secret:X-Api-Key}")');
    expect(txt).toContain("(first `yaw-mcp secrets set X-Api-Key` if the stored value is not this one)");
    expect(txt).not.toContain("k-PLAINTEXT-0007");
  });

  it("matches the <namespace>_<key> entry `set --secret` derives", async () => {
    writeVault(["linear_authorization"]);
    writeBundles([
      {
        id: "linear-id",
        name: "Linear",
        namespace: "linear",
        type: "remote",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: BEARER, "X-Api-Key": "k-PLAINTEXT-0008" },
      },
    ]);
    const { txt } = await text();
    expect(txt).toContain('the vault already holds "linear_authorization"');
    expect(txt).toContain(
      '      make "headers"."Authorization" in bundles.json reference ${secret:linear_authorization}\n',
    );
    expect(txt).toContain("      yaw-mcp secrets set linear_x-api-key\n");
  });

  it("does not claim a half-migration for an unrelated vault entry", async () => {
    writeVault(["gh"]);
    writeBundles([tailscale({ TAILSCALE_API_KEY: TS_KEY })]);
    const { txt } = await text();
    expect(txt).toContain("    tailscale: env.TAILSCALE_API_KEY\n");
    expect(txt).not.toContain("already holds");
    expect(txt).toContain("      yaw-mcp secrets set tailscale\n");
  });

  // `yaw-mcp set` / `yaw-mcp add` edit only the user-global bundles.json
  // (local-set-cmd.ts), but an approved PROJECT bundles.json wins the load.
  // `set` never creates an entry, so suggesting it for a project server either
  // failed ("no server named ...") or edited a same-namespace entry in the
  // global file; either way the plaintext the project file sends stayed put.
  it("names the user-global file and offers set commands when that is the file loaded", async () => {
    writeBundles([tailscale({ TAILSCALE_API_KEY: TS_KEY })]);
    const { txt } = await text();
    expect(txt).not.toContain("a PROJECT bundles.json");
    expect(txt).toContain("      yaw-mcp set tailscale env.TAILSCALE_API_KEY='${secret:tailscale}'\n");

    const { parsed } = await json();
    expect(parsed.vault.bundlesPath).toBe(join(home, ".yaw-mcp", "bundles.json"));
    expect(parsed.vault.bundlesUserGlobal).toBe(true);
  });

  it("names an approved PROJECT file and suggests a hand edit of it, never `set` or `add`", async () => {
    const projectPath = join(cwd, ".yaw-mcp", "bundles.json");
    mkdirSync(join(cwd, ".yaw-mcp"), { recursive: true });
    writeFileSync(
      projectPath,
      JSON.stringify({
        version: 1,
        servers: [
          tailscale({ TAILSCALE_API_KEY: TS_KEY }),
          {
            id: "lin-id",
            name: "Linear",
            namespace: "linear",
            type: "remote",
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: BEARER },
          },
        ],
      }),
    );
    const { grantTrust } = await import("../trust.js");
    await grantTrust(projectPath, readFileSync(projectPath), { home });

    const { txt, exitCode } = await text();
    expect(txt).toContain(`plaintext:  credentials stored IN THE CLEAR in ${projectPath} (names only, never values):`);
    expect(txt).toContain("a PROJECT bundles.json: `yaw-mcp set` and `yaw-mcp add` edit only the");
    expect(txt).toContain("      yaw-mcp secrets set tailscale\n");
    expect(txt).toContain(
      `      then make "env"."TAILSCALE_API_KEY" in ${projectPath} reference \${secret:tailscale}\n`,
    );
    expect(txt).toContain("      yaw-mcp secrets set linear\n");
    expect(txt).toContain(`      then make "headers"."Authorization" in ${projectPath} reference \${secret:linear}\n`);
    expect(txt).toContain('        (e.g. "Bearer ${secret:linear}")\n');
    // Neither verb edits the project file, so neither is offered.
    expect(txt).not.toContain("yaw-mcp set ");
    expect(txt).not.toContain("yaw-mcp add ");
    expect(txt).not.toContain(TS_KEY);
    expect(txt).not.toContain(BEARER);
    expect(exitCode).toBe(0);

    const { parsed, raw } = await json();
    expect(parsed.vault.bundlesPath).toBe(projectPath);
    expect(parsed.vault.bundlesUserGlobal).toBe(false);
    expect(raw).not.toContain(TS_KEY);
    expect(raw).not.toContain(BEARER);
  });
});
