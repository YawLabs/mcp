// `yaw-mcp share`: the paste-able add line. No network: the "build" is a
// plain clone of a file:// fixture placed where a real build would be, so
// the manifest and the ref kind come from it exactly as they would.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseGitSpec } from "../git-source.js";
import { localBundlesPath } from "../local-bundles.js";
import { gitBuildDir, userConfigDir } from "../paths.js";
import { otherProtocolUrl, parseShareArgs, runShare } from "../share-cmd.js";
import { ENV, git, makeRepo, NPM_FILES, newTmp } from "./git-fixture.js";

const SCP = "git@github.com:acme/crm-mcp.git";
const MANIFEST = JSON.stringify({
  version: 1,
  namespace: "acme_crm",
  entry: "dist/index.js",
  env: { CRM_TOKEN: { secret: "crm_token", required: true }, CRM_REGION: { default: "us" } },
});
const FILES = { ...NPM_FILES, "dist/index.js": "// built\n" };

let home: string;
let out: string[];
let err: string[];

beforeEach(() => {
  home = newTmp("yaw git share-");
  out = [];
  err = [];
});

/** A repo whose clone sits where `ns`'s build of HEAD would. */
function builtRepo(ns: string, files: Record<string, string>, url = SCP): string {
  const repo = makeRepo(files);
  const commit = git(repo.work, ["rev-parse", "HEAD"]);
  git(repo.work, ["tag", "v1.4.0"]);
  git(repo.work, ["push", "-q", "origin", "--tags"]);
  const dir = gitBuildDir(ns, commit, home);
  mkdirSync(dirname(dir), { recursive: true });
  git(home, ["clone", "-q", repo.bare, dir]);
  const marker = {
    url,
    commit,
    entry: "dist/index.js",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pm: "npm",
    pmVersion: "10.9.0",
    builtAt: new Date().toISOString(),
  };
  const entry = join(dir, "dist", "index.js");
  if (!existsSync(entry)) {
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "");
  }
  writeFileSync(`${dir}.built`, JSON.stringify(marker));
  return commit;
}

function writeEntry(entry: Record<string, unknown>): void {
  mkdirSync(userConfigDir(home), { recursive: true });
  writeFileSync(localBundlesPath(userConfigDir(home)), JSON.stringify({ version: 1, servers: [entry] }, null, 2));
}

function entry(ns: string, commit: string, git: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    namespace: ns,
    name: ns,
    type: "local",
    transport: "stdio",
    git: { url: SCP, ref: "v1.4.0", commit, entry: "dist/index.js", ...git },
    ...extra,
  };
}

async function share(argv: string[]) {
  const parsed = parseShareArgs(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  return runShare({
    ...parsed.options,
    home,
    cwd: home,
    env: ENV,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
}

describe("share", () => {
  it("prints the one-liner in both protocols when the manifest covers everything", async () => {
    const commit = builtRepo("acme_crm", { ...FILES, "yaw-mcp.json": MANIFEST });
    writeEntry(entry("acme_crm", commit, {}, { env: { CRM_TOKEN: "${secret:crm_token}", CRM_REGION: "us" } }));
    const r = await share(["acme_crm"]);
    expect(r.exitCode, err.join("")).toBe(0);
    const text = out.join("");
    expect(text).toContain("Send this to coworkers with read access to github.com/acme/crm-mcp:");
    expect(text).toContain(`  SSH:   yaw-mcp add --git ${SCP}#v1.4.0\n`);
    expect(text).toContain("  HTTPS: yaw-mcp add --git https://github.com/acme/crm-mcp.git#v1.4.0\n");
    expect(text).toContain("They will be asked for: crm_token (CRM_TOKEN)");
    expect(text).not.toContain("Note:");
  }, 60_000);

  it("never prints env values, args or local paths, and notes the flags the manifest lacks", async () => {
    const commit = builtRepo("acme_crm", { ...FILES, "yaw-mcp.json": MANIFEST });
    writeEntry(
      entry(
        "acme_crm",
        commit,
        {},
        {
          env: {
            CRM_TOKEN: "${secret:crm_token}",
            CRM_REGION: "eu-literal-value",
            DATA_DIR: "C:/Users/someone/private/data",
            EXTRA: "${secret:extra_key}",
          },
          args: ["--root", "/home/someone/private"],
        },
      ),
    );
    const r = await share(["acme_crm"]);
    expect(r.exitCode, err.join("")).toBe(0);
    const text = out.join("");
    expect(text).not.toContain("eu-literal-value");
    expect(text).not.toContain("someone");
    expect(text).not.toContain(home);
    expect(text).toContain("'CRM_REGION=<set this>'");
    expect(text).toContain("'DATA_DIR=<set this>'");
    expect(text).toContain("'EXTRA=${secret:extra_key}'");
    expect(text).toContain("They will be asked for: crm_token (CRM_TOKEN), extra_key (EXTRA)");
    expect(text).toContain(
      "Coworkers' command includes --env DATA_DIR, --env EXTRA because the repo's yaw-mcp.json does not declare them.",
    );
    expect(text).toContain(
      "Coworkers' command includes --env CRM_REGION because this entry sets it differently from the repo's yaw-mcp.json.",
    );
    expect(text).not.toContain("--env CRM_REGION because the repo's yaw-mcp.json does not declare");
    expect(text).toContain("also passes 2 server arguments, not shown here");
  }, 60_000);

  it("with no manifest, prints the full-flag form as the primary command with no drift note", async () => {
    const commit = builtRepo("crm", FILES);
    writeEntry(
      entry(
        "crm",
        commit,
        { entry: "src/server.js", subdir: undefined },
        { env: { CRM_TOKEN: "${secret:crm_token}" } },
      ),
    );
    const r = await share(["crm"]);
    expect(r.exitCode, err.join("")).toBe(0);
    const text = out.join("");
    expect(text).toContain(
      `  SSH:   yaw-mcp add crm --git ${SCP}#v1.4.0 --entry src/server.js --env 'CRM_TOKEN=\${secret:crm_token}'\n`,
    );
    expect(text).not.toContain("yaw-mcp.json does not declare");
    expect(text).not.toContain("tracks the branch");
  }, 60_000);

  it("spells out --description when there is no manifest, and only when the manifest's differs", async () => {
    const commit = builtRepo("crm", FILES);
    writeEntry(entry("crm", commit, { entry: "src/server.js" }, { description: "Acme CRM: accounts, deals" }));
    expect((await share(["crm"])).exitCode, err.join("")).toBe(0);
    expect(out.join("")).toContain("--description 'Acme CRM: accounts, deals'");
    expect(out.join("")).not.toContain("yaw-mcp.json does not declare");

    out = [];
    expect((await share(["crm", "--json"])).exitCode).toBe(0);
    const doc = JSON.parse(out.join(""));
    expect(doc.flags).toContain("--description");
    expect(doc.command).toContain("--description 'Acme CRM: accounts, deals'");

    const withManifest = builtRepo("acme_crm", {
      ...FILES,
      "yaw-mcp.json": JSON.stringify({ version: 1, namespace: "acme_crm", entry: "dist/index.js", description: "CRM" }),
    });
    writeEntry(entry("acme_crm", withManifest, {}, { description: "CRM" }));
    out = [];
    expect((await share(["acme_crm"])).exitCode).toBe(0);
    expect(out.join("")).not.toContain("--description");

    writeEntry(entry("acme_crm", withManifest, {}, { description: "Acme CRM, mine" }));
    out = [];
    expect((await share(["acme_crm"])).exitCode).toBe(0);
    expect(out.join("")).toContain("--description 'Acme CRM, mine'");
    expect(out.join("")).toContain(
      "Coworkers' command includes --description because this entry sets it differently from the repo's yaw-mcp.json.",
    );
  }, 60_000);

  it("warns when the entry tracks a branch, and --pin prints the exact commit instead", async () => {
    const commit = builtRepo("crm", FILES);
    writeEntry(entry("crm", commit, { ref: "main" }));
    expect((await share(["crm"])).exitCode).toBe(0);
    expect(out.join("")).toContain("#main");
    expect(out.join("")).toContain("crm tracks the branch main");

    out = [];
    expect((await share(["crm", "--pin"])).exitCode).toBe(0);
    expect(out.join("")).toContain(`#${commit}`);
    expect(out.join("")).not.toContain("tracks the branch");
  }, 60_000);

  it("puts --git-token-secret on the HTTPS line only, and --json carries no values", async () => {
    const https = "https://github.com/acme/crm-mcp.git";
    const commit = builtRepo("crm", FILES, https);
    writeEntry(entry("crm", commit, { url: https, tokenSecret: "gh_read" }, { env: { K: "plain-value" } }));
    expect((await share(["crm"])).exitCode).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/HTTPS: .*--git-token-secret gh_read/);
    expect(text).not.toMatch(/SSH: .*--git-token-secret/);
    expect(text).toContain("yaw-mcp secrets set gh_read");

    out = [];
    expect((await share(["crm", "--json"])).exitCode).toBe(0);
    const raw = out.join("");
    expect(raw).not.toContain("plain-value");
    const doc = JSON.parse(raw);
    expect(doc).toMatchObject({ ok: true, namespace: "crm", repo: "github.com/acme/crm-mcp", kind: "tag" });
    expect(doc.commands.ssh).toContain(`git@github.com:acme/crm-mcp.git#v1.4.0`);
    expect(doc.tokenSecret).toBe("gh_read");
  }, 60_000);

  it("refuses a file:// repository coworkers cannot clone, and a server that is not git", async () => {
    const repo = makeRepo(FILES);
    const commit = git(repo.work, ["rev-parse", "HEAD"]);
    mkdirSync(userConfigDir(home), { recursive: true });
    writeFileSync(
      localBundlesPath(userConfigDir(home)),
      JSON.stringify({
        version: 1,
        servers: [
          entry("fx", commit, { url: repo.url }),
          { namespace: "plain", name: "plain", command: "node", args: ["x.js"] },
        ],
      }),
    );
    expect((await share(["fx"])).exitCode).toBe(1);
    expect(err.join("")).toContain("cannot clone");
    expect(err.join("")).not.toContain(repo.bare);
    expect((await share(["plain"])).exitCode).toBe(2);
  }, 60_000);
});

describe("otherProtocolUrl", () => {
  const conv = (u: string): string | null => {
    const s = parseGitSpec(u);
    if (!s.ok) throw new Error(s.error);
    return otherProtocolUrl(s.spec);
  };
  it("converts only when nothing has to be guessed", () => {
    expect(conv("git@gitlab.example:org/sub/repo.git")).toBe("https://gitlab.example/org/sub/repo.git");
    expect(conv("ssh://git@host.example/org/repo")).toBe("https://host.example/org/repo");
    expect(conv("https://host.example/org/repo.git")).toBe("git@host.example:org/repo.git");
    expect(conv("ssh://git@host.example:2222/org/repo")).toBeNull();
    expect(conv("deploy@host.example:org/repo")).toBeNull();
    expect(conv("https://git@host.example/org/repo")).toBe("git@host.example:org/repo");
    expect(conv("ssh://git@host.example:22/org/repo")).toBe("https://host.example/org/repo");
    expect(conv("https://host.example:8443/org/repo")).toBeNull();
  });

  it("converts a well-known forge URL that carries a username or the default ssh port", () => {
    expect(conv("https://git@github.com/acme/x.git")).toBe("git@github.com:acme/x.git");
    expect(conv("ssh://git@github.com:22/acme/x.git")).toBe("https://github.com/acme/x.git");
    expect(conv("ssh://deploy@gitlab.com/acme/x.git")).toBe("https://gitlab.com/acme/x.git");
    expect(conv("ssh://git@github.com:2222/acme/x.git")).toBeNull();
  });
});
