// What a re-add, a remove preview, `list --json` and `set`/`enable`/`disable`
// do with state that was already in bundles.json: the grade and optional-env
// marker of a replaced launch, a --description on a catalog add, the env
// values a conversion to remote deletes, a credential hand-edited into a
// stored git url, and a target only deriveNamespace could match.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogServer } from "../catalog.js";
import { runAdd, runList, runRemove } from "../local-add-cmd.js";
import { updateGitPin, upsertUserBundle } from "../local-bundles.js";
import { runEnableDisable } from "../local-set-cmd.js";
import { CONFIG_DIRNAME } from "../paths.js";
import type { UpstreamServerConfig } from "../types.js";

let home: string;
let cwd: string;
let out: string[];
let err: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-merge-fixes-"));
  cwd = mkdtempSync(join(home, "cwd-"));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const bundlesFile = (): string => join(home, CONFIG_DIRNAME, "bundles.json");

function writeBundles(content: unknown): void {
  mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
  writeFileSync(bundlesFile(), typeof content === "string" ? content : JSON.stringify(content));
}

function stored(): Array<Record<string, unknown>> {
  return (JSON.parse(readFileSync(bundlesFile(), "utf8")) as { servers: Array<Record<string, unknown>> }).servers;
}

const CATALOG: CatalogServer[] = [
  {
    slug: "fetch",
    name: "Fetch",
    description: "The catalog's words",
    install: { command: "npx -y @yawlabs/fetch-mcp", runtime: "node" },
    complianceGrade: "A",
  } as CatalogServer,
];

function io() {
  return {
    home,
    cwd,
    env: {},
    fetchCatalog: async (): Promise<CatalogServer[]> => CATALOG,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
  };
}

const COMMIT = "a".repeat(40);

describe("a launch swap does not keep the replaced program's grade", () => {
  it("add <slug> --command over a graded catalog entry drops the catalog's grade", async () => {
    expect((await runAdd({ ...io(), slug: "fetch" })).exitCode).toBe(0);
    expect(stored()[0]).toMatchObject({ namespace: "fetch", complianceGrade: "A" });

    expect((await runAdd({ ...io(), slug: "fetch", command: "node evil.js" })).exitCode).toBe(0);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ command: "node", args: ["evil.js"] });
    expect(stored()[0]).not.toHaveProperty("complianceGrade");
  });

  it("add <slug> --url over a graded entry drops it too", async () => {
    await runAdd({ ...io(), slug: "fetch" });
    expect((await runAdd({ ...io(), slug: "fetch", url: "https://c.test/mcp" })).exitCode).toBe(0);
    expect(stored()[0]).toMatchObject({ url: "https://c.test/mcp" });
    expect(stored()[0]).not.toHaveProperty("complianceGrade");
  });

  it("a conversion to git drops the grade and the replaced launch's optionalEnvKeys", async () => {
    writeBundles({
      version: 1,
      servers: [
        {
          id: "local-fx",
          name: "fx",
          namespace: "fx",
          slug: "fx",
          type: "local",
          transport: "stdio",
          command: "npx",
          args: ["-y", "fx-mcp"],
          env: { OPTIONAL_KEY: "", KEPT: "value" },
          optionalEnvKeys: ["OPTIONAL_KEY"],
          complianceGrade: "B",
          isActive: true,
        },
      ],
    });
    const res = await upsertUserBundle(
      {
        id: "local-fx",
        name: "fx",
        namespace: "fx",
        slug: "fx",
        type: "local",
        transport: "stdio",
        git: { url: "https://git.test/acme/fx.git", ref: "main", commit: COMMIT, entry: "dist/index.js" },
        isActive: true,
      } as Partial<UpstreamServerConfig>,
      { home, origin: "custom" },
    );
    expect(res.launchChanged).toBeDefined();
    const [entry] = stored();
    expect(entry).not.toHaveProperty("complianceGrade");
    expect(entry).not.toHaveProperty("optionalEnvKeys");
    expect(entry).not.toHaveProperty("command");
    // The stored VALUE survives; only the blank seed and its marker go.
    expect(entry?.env).toEqual({ KEPT: "value" });
  });

  it("a re-add with the same launch keeps a grade the incoming entry does not restate", async () => {
    await runAdd({ ...io(), slug: "fetch" });
    const res = await upsertUserBundle(
      {
        id: "local-fetch",
        name: "Fetch",
        namespace: "fetch",
        slug: "fetch",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp"],
        isActive: true,
      } as Partial<UpstreamServerConfig>,
      { home },
    );
    expect(res.launchChanged).toBeUndefined();
    expect(stored()[0]).toMatchObject({ complianceGrade: "A" });
  });
});

describe("add <slug> --description on a catalog add", () => {
  it("writes the flag's text, not the catalog's", async () => {
    const r = await runAdd({ ...io(), slug: "fetch", description: "my notes" });
    expect(r.exitCode).toBe(0);
    expect(stored()[0]).toMatchObject({ description: "my notes" });
  });

  it("keeps the catalog's text when the flag is absent", async () => {
    await runAdd({ ...io(), slug: "fetch" });
    expect(stored()[0]).toMatchObject({ description: "The catalog's words" });
  });
});

describe("add <name> --url over a stdio entry names the env values it deletes", () => {
  const seed = (): void =>
    writeBundles({
      version: 1,
      servers: [
        {
          id: "local-crm",
          name: "crm",
          namespace: "crm",
          slug: "crm",
          type: "local",
          transport: "stdio",
          command: "npx",
          args: ["-y", "crm-mcp"],
          env: { CRM_TOKEN: "s3cr3t-value", BLANK_SEED: "" },
          isActive: true,
        },
      ],
    });

  it("the real run says which keys went, by name only", async () => {
    seed();
    const r = await runAdd({ ...io(), slug: "crm", url: "https://crm.test/mcp" });
    expect(r.exitCode).toBe(0);
    expect(stored()[0]).not.toHaveProperty("env");
    const text = err.join("");
    expect(text).toContain("the env value stored on the entry (CRM_TOKEN) was deleted");
    expect(text).not.toContain("BLANK_SEED");
    expect(out.join("") + text).not.toContain("s3cr3t-value");
  });

  it("--dry-run says the same in the conditional, and writes nothing", async () => {
    seed();
    const before = readFileSync(bundlesFile(), "utf8");
    const r = await runAdd({ ...io(), slug: "crm", url: "https://crm.test/mcp", dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(err.join("")).toContain("this would DELETE the env value stored on the entry (CRM_TOKEN)");
    expect(readFileSync(bundlesFile(), "utf8")).toBe(before);
  });

  it("says nothing when the add deletes no stored value", async () => {
    seed();
    await runAdd({ ...io(), slug: "crm", command: "npx -y crm-mcp@2" });
    expect(err.join("")).not.toContain("deleted");
    expect(stored()[0]?.env).toMatchObject({ CRM_TOKEN: "s3cr3t-value" });
  });
});

describe("a credential hand-edited into a stored git url is not printed", () => {
  const TOKEN = "ghp_handEditedToken123";
  const seed = (): void =>
    writeBundles({
      version: 1,
      servers: [
        {
          id: "local-fx",
          name: "fx",
          namespace: "fx",
          slug: "fx",
          type: "local",
          transport: "stdio",
          git: {
            url: `https://user:${TOKEN}@git.test/acme/fx.git`,
            ref: "main",
            commit: COMMIT,
            entry: "dist/index.js",
          },
          isActive: true,
        },
      ],
    });

  it("remove's preview shows the url with the userinfo scrubbed", async () => {
    seed();
    const r = await runRemove({ ...io(), target: "fx", isTTY: false });
    expect(r.exitCode).toBe(2);
    const text = out.join("") + err.join("");
    expect(text).toContain("git https://***@git.test/acme/fx.git");
    expect(text).not.toContain(TOKEN);
  });

  it("list --json reports the git block with the userinfo scrubbed", async () => {
    seed();
    const r = await runList({ ...io(), json: true, gradesReader: async () => ({}) });
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(out.join("")) as {
      servers: Array<{ namespace: string; git?: { url: string; commit: string } }>;
    };
    const fx = doc.servers.find((s) => s.namespace === "fx");
    expect(fx?.git).toMatchObject({ url: "https://***@git.test/acme/fx.git", commit: COMMIT });
    expect(out.join("")).not.toContain(TOKEN);
  });

  it("a re-add's launch-change note scrubs the stored half", async () => {
    seed();
    const r = await runAdd({ ...io(), slug: "fx", command: "node server.js" });
    expect(r.exitCode).toBe(0);
    const text = err.join("");
    expect(text).toContain("from: git https://***@git.test/acme/fx.git");
    expect(text).not.toContain(TOKEN);
  });
});

describe("enable / disable do not resolve a target only deriveNamespace matches", () => {
  const seed = (): void =>
    writeBundles({
      version: 1,
      servers: [
        { namespace: "server", name: "Fallback", command: "npx", args: ["a"], isActive: true },
        { namespace: "github", name: "Hub", command: "npx", args: ["b"], isActive: true },
        { namespace: "bravesearch", name: "Brave Search", slug: "brave-search", command: "npx", args: ["c"] },
      ],
    });

  it('disable "???" is a usage error, not an edit of namespace "server"', async () => {
    seed();
    const before = readFileSync(bundlesFile(), "utf8");
    const r = await runEnableDisable({
      target: "???",
      enabled: false,
      home,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(r.exitCode).toBe(2);
    expect(err.join("")).toContain('yaw-mcp disable: "???" is not a valid server name.');
    expect(readFileSync(bundlesFile(), "utf8")).toBe(before);
  });

  it("disable GitHub does not land on namespace github when no entry carries that name", async () => {
    seed();
    const before = readFileSync(bundlesFile(), "utf8");
    const r = await runEnableDisable({
      target: "GitHub",
      enabled: false,
      home,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(r.exitCode).toBe(2);
    expect(readFileSync(bundlesFile(), "utf8")).toBe(before);
  });

  it("a stored display name and a slug-shaped target still resolve", async () => {
    seed();
    const sink = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    expect((await runEnableDisable({ target: "Brave Search", enabled: false, home, ...sink })).exitCode).toBe(0);
    expect(stored()[2]).toMatchObject({ isActive: false });
    // The slug derives the namespace: "brave-search" -> "bravesearch".
    writeBundles({
      version: 1,
      servers: [{ namespace: "bravesearch", name: "Imported", command: "npx", args: ["c"], isActive: true }],
    });
    expect((await runEnableDisable({ target: "brave-search", enabled: false, home, ...sink })).exitCode).toBe(0);
    expect(stored()[0]).toMatchObject({ isActive: false });
  });
});

describe("updateGitPin on a bundles.json that stopped parsing", () => {
  it("throws a position, never a fragment of the source", async () => {
    const token = "zq9Xv7Kp2Lm4Rt8Wn3Yb6Hc1Jd5Fg0";
    writeBundles(`{\n  "servers": [\n    { "namespace": "fx", "env": { "T": ${token} } }\n  ]\n}\n`);
    let message = "";
    try {
      await updateGitPin("fx", COMMIT, { commit: "b".repeat(40) }, { home });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("is not valid JSON at line 3, column");
    expect(message).toContain("nothing was written");
    for (let i = 0; i + 4 <= token.length; i++) expect(message).not.toContain(token.slice(i, i + 4));
  });
});
