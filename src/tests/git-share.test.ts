// `yaw-mcp share`: the paste-able add line. No network: the "build" is a
// plain clone of a file:// fixture placed where a real build would be, so
// the manifest and the ref kind come from it exactly as they would.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseGitSpec } from "../git-source.js";
import { localBundlesPath } from "../local-bundles.js";
import { CONFIG_DIRNAME, gitBuildDir, userConfigDir } from "../paths.js";
import { otherProtocolUrl, parseShareArgs, runShare } from "../share-cmd.js";
import { TRUST_BYPASS_ENV } from "../trust.js";
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

async function share(argv: string[], over: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const parsed = parseShareArgs(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  return runShare({
    ...parsed.options,
    home,
    cwd: over.cwd ?? home,
    env: over.env ?? ENV,
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
    expect(text).toContain("Replace <set this> in any --env flag below with the real value before running this.");
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

  it("treats a malformed secret reference as a plain value, as the vault does", async () => {
    // `${secret:gh token}` is not a reference to the vault (a space is outside
    // its name class), so it resolves to nothing there. share must not print
    // it as one or tell coworkers they will be asked for "gh token".
    const commit = builtRepo("crm", FILES);
    writeEntry(
      entry(
        "crm",
        commit,
        { entry: "src/server.js", subdir: undefined },
        { env: { BAD: "${secret:gh token}", GOOD: "${secret:crm_token}" } },
      ),
    );
    const r = await share(["crm"]);
    expect(r.exitCode, err.join("")).toBe(0);
    const text = out.join("");
    expect(text).toContain("'BAD=<set this>'");
    expect(text).not.toContain("gh token");
    expect(text).toContain("'GOOD=${secret:crm_token}'");
    expect(text).toContain("They will be asked for: crm_token (GOOD)");
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

  it("says how to run an apostrophe word in PowerShell, and only then", async () => {
    // REGRESSION: the quoting was documented as serving PowerShell too, but an
    // apostrophe is written '"'"' -- which PowerShell 5.1 splits into three
    // arguments. No single spelling serves both shells, so the POSIX one stays
    // on the line and a note carries the PowerShell rewrite. No build needed:
    // an unbuilt entry spells out every flag.
    const commit = "a".repeat(40);
    writeEntry(entry("crm", commit, {}, { description: "it's a tool" }));
    expect((await share(["crm"])).exitCode, err.join("")).toBe(0);
    expect(out.join("")).toContain(`--description 'it'"'"'s a tool'`);
    expect(out.join("")).toContain(
      `Note: The command is quoted for bash and zsh. It contains an apostrophe, written '"'"'; in PowerShell replace each '"'"' with two single quotes ('').`,
    );

    out = [];
    expect((await share(["crm", "--json"])).exitCode).toBe(0);
    expect((JSON.parse(out.join("")).notes as string[]).some((n) => n.includes("in PowerShell replace"))).toBe(true);

    writeEntry(entry("crm", commit, {}, { description: "a plain tool" }));
    out = [];
    expect((await share(["crm"])).exitCode).toBe(0);
    expect(out.join("")).toContain("--description 'a plain tool'");
    expect(out.join("")).not.toContain("PowerShell");
  }, 60_000);

  it("never leaves a word starting with @ bare, since PowerShell would splat it", async () => {
    const commit = "a".repeat(40);
    writeEntry(entry("crm", commit, {}, { description: "@acme" }));
    expect((await share(["crm"])).exitCode, err.join("")).toBe(0);
    expect(out.join("")).toContain("--description '@acme'");
    // An @ past the first character is inert in both shells and stays bare.
    expect(out.join("")).toContain(`--git ${SCP}#v1.4.0`);
  }, 60_000);

  it("says so when a non-ASCII character was replaced, and --json carries it exactly", async () => {
    // REGRESSION: the terminal sanitizer turned the paste line's "café"
    // into "caf?" with no note, and did the same to the --json document, so a
    // script read corrupted data.
    const commit = "a".repeat(40);
    const description = "café tools \u{1f600}";
    writeEntry(entry("crm", commit, {}, { description }));
    expect((await share(["crm"])).exitCode, err.join("")).toBe(0);
    expect(out.join("")).toContain("--description 'caf? tools ??'");
    expect(out.join("")).toContain('Note: The command holds characters outside printable ASCII, shown here as "?".');
    expect(out.join("")).toContain("yaw-mcp share crm --json prints the command exactly");

    out = [];
    expect((await share(["crm", "--json"])).exitCode).toBe(0);
    const raw = out.join("");
    // Still pure ASCII on the wire: escaped, not replaced.
    expect(/^[\x20-\x7e\n]*$/.test(raw)).toBe(true);
    const doc = JSON.parse(raw);
    expect(doc.command).toContain(`--description '${description}'`);
    expect((doc.notes as string[]).some((n) => n.includes("printable ASCII"))).toBe(false);

    // An all-ASCII command earns no note.
    writeEntry(entry("crm", commit, {}, { description: "a plain tool" }));
    out = [];
    expect((await share(["crm"])).exitCode).toBe(0);
    expect(out.join("")).not.toContain("printable ASCII");
  }, 60_000);

  it("drops the sharer's https username and names a non-git ssh one", async () => {
    // REGRESSION: the stored URL went out verbatim, so coworkers pasted a
    // command that authenticated as the sharer's account.
    const commit = "a".repeat(40);
    writeEntry(entry("crm", commit, { url: "https://jeff@gitea.example/org/repo.git" }));
    expect((await share(["crm", "--json"])).exitCode, err.join("")).toBe(0);
    let doc = JSON.parse(out.join(""));
    expect(doc.command).toContain("--git https://gitea.example/org/repo.git#v1.4.0");
    expect(doc.commands.https).toContain("--git https://gitea.example/org/repo.git#v1.4.0");
    expect(JSON.stringify(doc)).not.toContain("jeff");

    // An ssh username can be the account the host requires, so it stays on
    // the line and a note names it.
    writeEntry(entry("crm", commit, { url: "jeff@gitea.example:org/repo.git" }));
    out = [];
    expect((await share(["crm", "--json"])).exitCode).toBe(0);
    doc = JSON.parse(out.join(""));
    expect(doc.command).toContain("--git jeff@gitea.example:org/repo.git#v1.4.0");
    expect((doc.notes as string[]).some((n) => n.startsWith('The SSH URL logs in as "jeff".'))).toBe(true);

    // The conventional "git" user earns no note.
    writeEntry(entry("crm", commit));
    out = [];
    expect((await share(["crm", "--json"])).exitCode).toBe(0);
    expect((JSON.parse(out.join("")).notes as string[]).some((n) => n.includes("logs in as"))).toBe(false);
  }, 60_000);

  it("keeps an https username that git sends beside the vault token, and says so", async () => {
    // REGRESSION: every https username was stripped. With --git-token-secret
    // the URL username is what git sends with the token on any host but
    // github.com / gitlab.* (tokenUsername), so Bitbucket's x-token-auth went
    // out as a command that authenticates as "git".
    const commit = "a".repeat(40);
    const url = "https://x-token-auth@bitbucket.org/ws/repo.git";
    writeEntry(entry("crm", commit, { url, tokenSecret: "bb_read" }));
    expect((await share(["crm", "--json"])).exitCode, err.join("")).toBe(0);
    let doc = JSON.parse(out.join(""));
    expect(doc.command).toContain(`--git ${url}#v1.4.0`);
    expect(doc.command).toContain("--git-token-secret bb_read");
    expect(doc.commands.https).toContain(`--git ${url}#v1.4.0`);
    expect(doc.notes as string[]).toContain(
      'The HTTPS URL keeps the username "x-token-auth": git sends it with the token on this host. Coworkers whose token needs a different username replace it.',
    );

    // No token secret: the username is the sharer's own login, still dropped.
    writeEntry(entry("crm", commit, { url }));
    out = [];
    expect((await share(["crm", "--json"])).exitCode).toBe(0);
    doc = JSON.parse(out.join(""));
    expect(doc.command).toContain("--git https://bitbucket.org/ws/repo.git#v1.4.0");
    expect(JSON.stringify(doc)).not.toContain("x-token-auth");

    // github.com sends a fixed token username whatever the URL says, so a
    // username there is dropped even with a token secret.
    writeEntry(entry("crm", commit, { url: "https://jeff@github.com/acme/crm-mcp.git", tokenSecret: "gh_read" }));
    out = [];
    expect((await share(["crm", "--json"])).exitCode).toBe(0);
    doc = JSON.parse(out.join(""));
    expect(doc.command).toContain("--git https://github.com/acme/crm-mcp.git#v1.4.0");
    expect(JSON.stringify(doc)).not.toContain("jeff");
  }, 60_000);

  it("never leaves a word starting with # bare, since both shells would read a comment", async () => {
    // REGRESSION: `--description #crm` went out bare; bash and PowerShell both
    // drop it and every word after it.
    const commit = "a".repeat(40);
    writeEntry(entry("crm", commit, {}, { description: "#crm" }));
    expect((await share(["crm"])).exitCode, err.join("")).toBe(0);
    expect(out.join("")).toContain("--description '#crm'");
    // A # past the first character is inert and stays bare (the ref).
    expect(out.join("")).toContain(`--git ${SCP}#v1.4.0`);
  }, 60_000);

  it("says a double quote is dropped by Windows PowerShell 5.1, and only then", async () => {
    const commit = "a".repeat(40);
    writeEntry(entry("crm", commit, {}, { description: 'say "hi" now' }));
    expect((await share(["crm"])).exitCode, err.join("")).toBe(0);
    expect(out.join("")).toContain(`--description 'say "hi" now'`);
    expect(out.join("")).toContain(
      'Note: The command is quoted for bash and zsh. It contains a double quote ("), which Windows PowerShell 5.1 drops when it runs the command; there, write each one as \\".',
    );
    expect(out.join("")).not.toContain("apostrophe");
  }, 60_000);

  it("reads a manifest subdir as a directory, so ./server and server are not a difference", async () => {
    // REGRESSION: the stored subdir is the tidy spelling while the manifest's
    // is read as typed, so a string compare printed a redundant --subdir and a
    // note that the entry departs from the repo's yaw-mcp.json.
    const manifest = JSON.stringify({ version: 1, namespace: "acme_crm", entry: "dist/index.js", subdir: "./server" });
    const commit = builtRepo("acme_crm", { ...FILES, "yaw-mcp.json": manifest });
    writeEntry(entry("acme_crm", commit, { subdir: "server" }));
    expect((await share(["acme_crm"])).exitCode, err.join("")).toBe(0);
    expect(out.join("")).not.toContain("--subdir");
    expect(out.join("")).not.toContain("differently from the repo's yaw-mcp.json");

    // A subdir that really is another directory is still spelled out.
    writeEntry(entry("acme_crm", commit, { subdir: "other" }));
    out = [];
    expect((await share(["acme_crm"])).exitCode).toBe(0);
    expect(out.join("")).toContain("--subdir other");
    expect(out.join("")).toContain(
      "Coworkers' command includes --subdir because this entry sets it differently from the repo's yaw-mcp.json.",
    );
  }, 60_000);

  it("names --project in the non-ASCII note's re-run hint when the entry is a project one", async () => {
    const proj = join(home, "proj");
    mkdirSync(join(proj, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(
      localBundlesPath(join(proj, CONFIG_DIRNAME)),
      JSON.stringify({
        version: 1,
        servers: [entry("crm", "a".repeat(40), {}, { description: `caf${String.fromCharCode(0xe9)}` })],
      }),
    );
    const r = await share(["crm", "--project"], { cwd: proj, env: { ...ENV, [TRUST_BYPASS_ENV]: "1" } });
    expect(r.exitCode, err.join("")).toBe(0);
    expect(out.join("")).toContain("yaw-mcp share crm --project --json prints the command exactly");
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

  it("--pin on an entry with no pinned commit refuses instead of printing a command", async () => {
    writeEntry(entry("crm", "", { ref: "main", commit: undefined }));
    const r = await share(["crm", "--pin"]);
    expect(r.exitCode).toBe(1);
    expect(err.join("")).toContain('yaw-mcp share: "crm" has no pinned commit. Pin one with: yaw-mcp update crm');
    expect(out.join("")).toBe("");
    expect(out.join("")).not.toContain("yaw-mcp add");
  }, 60_000);

  it("a miss says no server named it, and adds the --project hint when --project was not passed", async () => {
    // pro_only exists ONLY in a project bundles.json; the user file has no
    // entry at all. Sharing it without --project reads the user file, misses,
    // and gets the hint pointing at the flag. Sharing with --project reads the
    // project file -- a name missing from THAT too still misses, with no hint
    // (the flag was already passed) and the project file named in the message.
    const projRoot = join(home, "proj");
    const projDir = join(projRoot, CONFIG_DIRNAME);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      localBundlesPath(projDir),
      JSON.stringify({ version: 1, servers: [entry("pro_only", "1111111111111111111111111111111111111111")] }),
    );

    expect((await share(["pro_only"])).exitCode).toBe(1);
    expect(err.join("")).toContain(`no server named "pro_only" in ${localBundlesPath(userConfigDir(home))}.`);
    expect(err.join("")).toContain("For a project entry add --project.");

    out = [];
    err = [];
    // The bypass makes share honour the project file here (a real run would
    // `yaw-mcp trust` it first); it exists so --project reads THAT file.
    expect(
      (await share(["nothere", "--project"], { cwd: projRoot, env: { ...ENV, [TRUST_BYPASS_ENV]: "1" } })).exitCode,
    ).toBe(1);
    expect(err.join("")).toContain(`no server named "nothere" in ${localBundlesPath(projDir)}.`);
    expect(err.join("")).not.toContain("For a project entry add --project.");
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

describe("share --json refusals", () => {
  it("a name that misses leaves a document on stdout and the message on stderr", async () => {
    // stdout used to be zero bytes on this refusal, which a script piping to
    // a JSON parser reads as an empty/invalid document.
    writeEntry(entry("acme_crm", "1111111111111111111111111111111111111111"));
    const r = await share(["nope", "--json"]);
    expect(r.exitCode).toBe(1);
    const doc = JSON.parse(out.join(""));
    expect(doc.ok).toBe(false);
    expect(doc.exitCode).toBe(1);
    expect(String(doc.error)).toContain("yaw-mcp share:");
    expect(String(doc.error)).toContain("no server named");
    expect(err.join("")).toContain("yaw-mcp share:");
  });
});
