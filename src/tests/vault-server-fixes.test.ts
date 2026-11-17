// server.ts fixes from the vault-key full pass:
//   * a passphrase the vault gives nothing to check against is neither stored
//     nor latched (and the user is told why);
//   * mcp_connect_secrets reports the vault's own state instead of reading an
//     unreadable vault as an empty one;
//   * shutdown() locks secrets-vault's cached derived key;
//   * a verified passphrase that later stops working reads as a re-keyed
//     vault, without the activation-failure penalty;
//   * refusals name the map the refs live in (headers for a remote server).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sidecar-refresh.js", () => ({
  maybeRefreshSidecars: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn(async (c: UpstreamConnection) => {
      c.status = "disconnected";
    }),
    // The real one reads the developer's ~/.yaw-mcp/secrets.json.
    verifyVaultPassphrase: vi.fn(),
  };
});

vi.mock("../secrets-vault.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets-vault.js")>();
  return { ...actual, loadVault: vi.fn(actual.loadVault), lock: vi.fn(actual.lock) };
});

vi.mock("../secret-entry-page.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    openSecretEntryPage: vi.fn(async () => {
      throw new Error("fake the page (priv.openSecretPage)");
    }),
    openInSystemBrowser: vi.fn(async () => {
      throw new Error("fake the browser (priv.openBrowser)");
    }),
  };
});

import type { SecretEntryPageOptions } from "../secret-entry-page.js";
import { loadVault, lock } from "../secrets-vault.js";
import { ConnectServer } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import {
  clearSessionVaultPassphrase,
  connectToUpstream,
  VaultPassphraseRequiredError,
  vaultPassphrase,
  verifyVaultPassphrase,
} from "../upstream.js";

function makeServerConfig(overrides: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig {
  return {
    id: "1",
    name: "Test Server",
    namespace: "test",
    type: "local",
    command: "echo",
    isActive: true,
    ...overrides,
  };
}

function makeConnection(namespace: string, tools: string[] = []): UpstreamConnection {
  return {
    config: makeServerConfig({ namespace, name: namespace }),
    client: { callTool: vi.fn(), close: vi.fn() } as any,
    transport: {} as any,
    tools: tools.map((name) => ({ name, namespacedName: `${namespace}_${name}`, inputSchema: { type: "object" } })),
    resources: [],
    prompts: [],
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0, resultBytesUpstream: 0, resultBytesDownstream: 0 },
    status: "connected",
  } as UpstreamConnection;
}

function vaultError(
  namespace: string,
  reason: "missing" | "invalid" = "missing",
  subject = "server env",
  keys = ["GITHUB_TOKEN"],
): VaultPassphraseRequiredError {
  return new VaultPassphraseRequiredError(`vault locked (${reason})`, namespace, keys, reason, subject);
}

/** Fake masked-entry pages: the i-th page opened submits entries[i]. */
function passphrasePages(priv: any, ...entries: string[]): void {
  let n = 0;
  priv.openSecretPage = vi.fn(async (_opts: SecretEntryPageOptions) => {
    const entry = entries[n++];
    return {
      url: `http://127.0.0.1:5555/${String(n).repeat(64)}`,
      elicitationId: `elicit-${n}`,
      result: Promise.resolve(
        entry === undefined
          ? { kind: "expired" as const }
          : { kind: "submitted" as const, values: { passphrase: entry } },
      ),
      close: vi.fn(),
    };
  });
  priv.openBrowser = vi.fn().mockResolvedValue(true);
}

let server: ConnectServer;
let priv: any;

beforeEach(() => {
  vi.mocked(connectToUpstream).mockReset();
  vi.mocked(verifyVaultPassphrase).mockReset().mockResolvedValue("verified");
  vi.mocked(lock).mockClear();
  vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE", undefined);
  server = new ConnectServer();
  priv = server as any;
  priv.config = { servers: [makeServerConfig({ namespace: "gh", name: "GitHub" })], configVersion: "v1" };
  priv.server.getClientCapabilities = () => ({ elicitation: {} });
  priv.server.elicitInput = vi.fn().mockResolvedValue({ action: "accept" });
});

afterEach(async () => {
  await server.shutdown();
  clearSessionVaultPassphrase();
  vi.unstubAllEnvs();
});

describe("a passphrase with nothing to verify it against", () => {
  it("is not stored, does not latch, books no failure -- and the next activate asks again", async () => {
    passphrasePages(priv, "typed-before-the-vault-existed", "the-real-one");
    vi.mocked(verifyVaultPassphrase).mockResolvedValueOnce("unverifiable").mockResolvedValueOnce("verified");
    vi.mocked(connectToUpstream)
      .mockRejectedValueOnce(vaultError("gh"))
      .mockRejectedValueOnce(vaultError("gh"))
      .mockImplementationOnce(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace, ["t"]));

    const first = await priv.activateOne("gh");
    expect(first.ok).toBe(false);
    expect(first.message).toContain("nothing to check the passphrase entered against");
    expect(first.message).toContain("was not kept");
    // Only a vault that changed mid-prompt gets here: resolveServerEnv refuses
    // a missing, unreadable or empty vault before asking. Say that, not
    // "does not exist / holds no secrets yet".
    expect(first.message).toContain("while the prompt was open");
    expect(first.message).not.toContain("does not exist");
    expect(vaultPassphrase()).toBeUndefined();
    expect(priv.vaultPassphraseElicited).toBe(false);
    expect(priv.activationFailures.has("gh")).toBe(false);

    const second = await priv.activateOne("gh");
    expect(second.ok).toBe(true);
    expect(vaultPassphrase()).toBe("the-real-one");
    expect(priv.server.elicitInput).toHaveBeenCalledTimes(2);
  });
});

describe("a verified passphrase the vault later rejects (re-keyed)", () => {
  it("says the vault was re-keyed, books no activation-failure penalty, and does not re-prompt", async () => {
    priv.config.servers.push(makeServerConfig({ namespace: "linear", name: "Linear" }));
    passphrasePages(priv, "verified-at-the-time");
    vi.mocked(connectToUpstream)
      .mockRejectedValueOnce(vaultError("gh"))
      .mockImplementationOnce(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace, ["t"]))
      // Another process rotated the vault: the session passphrase no longer opens it.
      .mockRejectedValueOnce(vaultError("linear", "invalid"));

    expect((await priv.activateOne("gh")).ok).toBe(true);
    const later = await priv.activateOne("linear");

    expect(later.ok).toBe(false);
    expect(later.message).toContain("re-keyed");
    expect(later.message).toContain("Restart this MCP client");
    expect(later.message).toContain("its env (GITHUB_TOKEN)");
    expect(priv.activationFailures.has("linear")).toBe(false);
    expect(priv.server.elicitInput).toHaveBeenCalledTimes(1);
  });

  it("a latch set by a DECLINE still takes the plain give-up path", async () => {
    priv.server.elicitInput = vi.fn().mockResolvedValue({ action: "decline" });
    passphrasePages(priv);
    vi.mocked(connectToUpstream).mockRejectedValue(vaultError("gh", "invalid"));

    await priv.activateOne("gh");
    const again = await priv.activateOne("gh");
    expect(again.message).not.toContain("re-keyed");
    expect(priv.activationFailures.has("gh")).toBe(true);
  });
});

describe("refusals name the map the refs live in", () => {
  it("a remote server's rejected passphrase points at its headers, not its env", async () => {
    passphrasePages(priv, "typo");
    vi.mocked(verifyVaultPassphrase).mockResolvedValue("wrong");
    vi.mocked(connectToUpstream).mockRejectedValue(
      vaultError("gh", "missing", "remote server headers", ["Authorization"]),
    );

    const result = await priv.activateOne("gh");
    expect(result.message).toContain("which its headers (Authorization) references");
    expect(result.message).not.toContain("its env");
    // The prompt's own explanation says the same.
    const why = vi.mocked(priv.server.elicitInput).mock.calls[0][0].message as string;
    expect(why).toContain("its headers (Authorization)");
  });

  it("a remote server's unreachable page points at its headers too", async () => {
    passphrasePages(priv); // the page expires with nothing submitted
    vi.mocked(connectToUpstream).mockRejectedValue(
      vaultError("gh", "missing", "remote server headers", ["Authorization"]),
    );

    const result = await priv.activateOne("gh");
    expect(result.message).toContain("which its headers (Authorization) references, is still locked");
  });

  it("a local server keeps saying env", async () => {
    passphrasePages(priv, "typo");
    vi.mocked(verifyVaultPassphrase).mockResolvedValue("wrong");
    vi.mocked(connectToUpstream).mockRejectedValue(vaultError("gh"));

    const result = await priv.activateOne("gh");
    expect(result.message).toContain("which its env (GITHUB_TOKEN) references");
  });
});

describe("shutdown", () => {
  it("locks secrets-vault's cached derived key, not just the passphrase", async () => {
    await server.shutdown();
    expect(lock).toHaveBeenCalled();
  });
});

describe("mcp_connect_secrets -- vault status", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-vault-status-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    priv.config = {
      servers: [makeServerConfig({ namespace: "gh", env: { GITHUB_TOKEN: "${secret:gh}" } })],
      configVersion: "v1",
    };
  });

  afterEach(() => {
    vi.mocked(loadVault).mockClear();
    rmSync(home, { recursive: true, force: true });
  });

  it("an UNREADABLE vault is an error naming the cause, and claims no name is missing", async () => {
    vi.mocked(loadVault).mockRejectedValueOnce(new Error("Unexpected end of JSON input"));
    const result = await priv.handleSecretsReport();
    expect(result.isError).toBe(true);
    // Same layout as the absent case: JSON rows alone in content[0], prose in content[1].
    expect(JSON.parse(result.content[0].text)).toEqual([{ server: "gh", referenced: ["gh"], malformed: [] }]);
    const text = result.content[1].text as string;
    expect(text).toContain("Vault status: unreadable: Unexpected end of JSON input");
    expect(text).not.toContain('"missing"');
  });

  it("an ABSENT vault keeps the rows and adds a status line saying why every name is missing", async () => {
    vi.mocked(loadVault).mockResolvedValueOnce(null);
    const result = await priv.handleSecretsReport();
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([
      { server: "gh", injectedSecrets: [], missing: ["gh"], malformed: [] },
    ]);
    expect(result.content[1].text).toContain("Vault status: absent");
  });

  it("a PRESENT vault adds no status line", async () => {
    vi.mocked(loadVault).mockResolvedValueOnce({ version: 2, salt: "abc", entries: { gh: {} } } as any);
    const result = await priv.handleSecretsReport();
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0].text)[0].injectedSecrets).toEqual(["gh"]);
  });
});
