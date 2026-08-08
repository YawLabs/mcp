// `yaw-mcp sidecars install` -- the managed sidecar install.
//
// npm is injected everywhere below (`runNpm`), so nothing here touches the
// network or the host's real home. The one thing that genuinely has to be
// exercised against the filesystem is the manifest that gets written, since
// that is the contract npm consumes.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRegistrySpec, type OamProbe } from "../oam-spawn.js";
import {
  collectNonRegistrySpecs,
  collectSidecarSpecs,
  installedVersion,
  parseSidecarsArgs,
  runSidecarsInstall,
  sidecarsManifest,
  sidecarsNodeModules,
  sidecarsRoot,
} from "../sidecars-cmd.js";
import type { UpstreamServerConfig } from "../types.js";

/** A stand-in oam probe. Injected so the "will anything READ this tree" note
 *  does not depend on whether the machine running the suite has oam -- and so
 *  no unit test here spawns the real `oam --version` that probeOam defaults to. */
const probeWith = (bin: string | null): OamProbe => ({
  bin,
  binPath: bin,
  version: bin === null ? null : "9.9.9",
  belowMin: false,
  failure: null,
  failureDetail: null,
});

/** The common case: no oam on this machine. */
const noOam = async () => probeWith(null);

const local = (over: Partial<UpstreamServerConfig>): Partial<UpstreamServerConfig> => ({
  type: "local",
  transport: "stdio",
  ...over,
});

describe("collectSidecarSpecs", () => {
  it("takes npx launches and leaves every other command alone", () => {
    // docker/uvx/native are not npm packages, and `node <abs>` already names a
    // real file -- installing anything for those would be inventing work.
    const specs = collectSidecarSpecs([
      local({ namespace: "fetch", command: "npx", args: ["-y", "@yawlabs/fetch-mcp@latest"] }),
      local({ namespace: "gh", command: "docker", args: ["run", "img"] }),
      local({ namespace: "py", command: "uvx", args: ["some-server"] }),
      local({ namespace: "abs", command: "node", args: ["/srv/index.js"] }),
      { type: "remote", namespace: "rem", command: "npx", args: ["-y", "x"] } as Partial<UpstreamServerConfig>,
    ]);

    expect(specs.map((s) => s.pkg)).toEqual(["@yawlabs/fetch-mcp"]);
  });

  it("de-duplicates a package backing several namespaces", () => {
    // One package can be configured twice under different namespaces (two
    // Postgres servers, different DSNs). Installing it twice is not a thing.
    const specs = collectSidecarSpecs([
      local({ namespace: "pg1", command: "npx", args: ["-y", "@yawlabs/postgres-mcp@latest"] }),
      local({ namespace: "pg2", command: "npx", args: ["-y", "@yawlabs/postgres-mcp@latest"] }),
    ]);

    expect(specs).toHaveLength(1);
    expect(specs[0].namespaces).toEqual(["pg1", "pg2"]);
    // Same spec twice is not a conflict -- that would put a note on the most
    // ordinary configuration there is.
    expect(specs[0].conflicting).toEqual([]);
  });

  it("records the losing spec when one package is configured at two versions", () => {
    // A flat node_modules holds ONE version, so a loser is unavoidable. What
    // is avoidable is a server pinned to an exact version silently starting on
    // something else, so the discarded spec has to survive to be reported.
    const specs = collectSidecarSpecs([
      local({ namespace: "a", command: "npx", args: ["-y", "@yawlabs/postgres-mcp@1.0.0"] }),
      local({ namespace: "b", command: "npx", args: ["-y", "@yawlabs/postgres-mcp@latest"] }),
    ]);

    expect(specs).toHaveLength(1);
    expect(specs[0].spec).toBe("@yawlabs/postgres-mcp@1.0.0");
    expect(specs[0].conflicting).toEqual(["@yawlabs/postgres-mcp@latest"]);
  });

  it("skips an npx launch whose first positional is a flag", () => {
    // Same guard rewriteForOam applies: with an unparsed npx flag present the
    // first positional is not reliably the package, and guessing would install
    // something the user never named.
    const specs = collectSidecarSpecs([
      local({ namespace: "weird", command: "npx", args: ["-y", "--package=a", "b"] }),
    ]);

    expect(specs).toEqual([]);
  });
});

describe("sidecarsManifest", () => {
  it("turns a bare package into `latest`, matching what npx resolved", () => {
    // `npx -y <pkg>` with no tag fetches latest, so pinning it to nothing (or
    // to "*") would change which version the server gets.
    const json = JSON.parse(
      sidecarsManifest(collectSidecarSpecs([local({ command: "npx", args: ["-y", "some-mcp"] })])),
    );

    expect(json.dependencies).toEqual({ "some-mcp": "latest" });
  });

  it("preserves an explicit version and keeps the manifest private", () => {
    const json = JSON.parse(
      sidecarsManifest(collectSidecarSpecs([local({ command: "npx", args: ["-y", "@scope/name@1.2.3"] })])),
    );

    expect(json.dependencies).toEqual({ "@scope/name": "1.2.3" });
    expect(json.private).toBe(true);
  });

  it("is byte-identical regardless of the order servers appear in", () => {
    // The sort is what keeps a re-run from rewriting package.json and churning
    // the lockfile -- npm sees no change and no-ops. Without it, reordering
    // bundles.json would silently produce a different file every time.
    const a = collectSidecarSpecs([
      local({ command: "npx", args: ["-y", "z-mcp@1.0.0"] }),
      local({ command: "npx", args: ["-y", "a-mcp@2.0.0"] }),
    ]);
    const b = collectSidecarSpecs([
      local({ command: "npx", args: ["-y", "a-mcp@2.0.0"] }),
      local({ command: "npx", args: ["-y", "z-mcp@1.0.0"] }),
    ]);

    expect(sidecarsManifest(a)).toBe(sidecarsManifest(b));
  });
});

// The predicate itself lives in oam-spawn.ts and is imported, not copied --
// see the note above collectSidecarSpecs in sidecars-cmd.ts. oam-spawn.test.ts
// pins the same function for the LOOKUP-KEY contract; this block pins the
// MANIFEST-KEY contract that sidecars-cmd depends on, which is a separate
// promise about the same code and is what the two tests below are actually
// about. Both matter: one function now answers both questions.
describe("isRegistrySpec", () => {
  it("accepts the registry forms and rejects git/path targets", () => {
    // npx takes git and path specs too, and packageName passes those through
    // whole (no `@version` to cut at). As a dependency KEY that yields
    // {"github:owner/repo": "latest"}, which npm rejects -- failing the whole
    // install, so ONE oddly-configured server would block every other package.
    for (const ok of ["@yawlabs/fetch-mcp@latest", "@scope/n@1.2.3", "plain", "some-mcp@next"]) {
      expect(isRegistrySpec(ok), ok).toBe(true);
    }
    for (const bad of ["github:owner/repo", "./local-server", "file:../x", "git+ssh://h/r.git", "/abs/path"]) {
      expect(isRegistrySpec(bad), bad).toBe(false);
    }
  });

  it("keeps a git-spec server out of the manifest entirely", () => {
    const specs = collectSidecarSpecs([
      local({ namespace: "gitsrv", command: "npx", args: ["-y", "github:owner/repo"] }),
      local({ namespace: "fetch", command: "npx", args: ["-y", "@yawlabs/fetch-mcp@latest"] }),
    ]);

    expect(specs.map((s) => s.pkg)).toEqual(["@yawlabs/fetch-mcp"]);
    expect(JSON.parse(sidecarsManifest(specs)).dependencies).toEqual({ "@yawlabs/fetch-mcp": "latest" });
  });

  it("reports the skipped server rather than dropping it silently", () => {
    // A server missing from the install list with no explanation reads as a
    // bug in the command.
    const skipped = collectNonRegistrySpecs([
      local({ namespace: "gitsrv", command: "npx", args: ["-y", "github:owner/repo"] }),
      local({ namespace: "fetch", command: "npx", args: ["-y", "@yawlabs/fetch-mcp@latest"] }),
    ]);

    expect(skipped).toEqual([{ namespace: "gitsrv", spec: "github:owner/repo" }]);
  });
});

describe("installedVersion", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "instver-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const writePkg = (json: unknown) => {
    const dir = join(sidecarsNodeModules(home), "@yawlabs", "fetch-mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(json));
  };

  it("returns null for a package.json carrying no version", () => {
    // Doctor renders null identically to "not installed", so a present-but-odd
    // package reads as absent and sends the user to re-run an install that
    // will not change anything. Pin the shape so that stays a deliberate
    // choice rather than an accident of the `typeof` check.
    writePkg({ name: "@yawlabs/fetch-mcp" });

    expect(installedVersion("@yawlabs/fetch-mcp", home)).toBeNull();
  });

  it("returns null for an unparseable package.json rather than throwing", () => {
    // A half-written file (an install killed midway) must not take down the
    // command that is trying to report on it.
    const dir = join(sidecarsNodeModules(home), "@yawlabs", "fetch-mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{ not json");

    expect(installedVersion("@yawlabs/fetch-mcp", home)).toBeNull();
  });

  it("reads the version when one is present", () => {
    writePkg({ name: "@yawlabs/fetch-mcp", version: "0.3.6" });

    expect(installedVersion("@yawlabs/fetch-mcp", home)).toBe("0.3.6");
  });
});

describe("parseSidecarsArgs", () => {
  it("requires the install verb rather than defaulting to it", () => {
    // A bare `yaw-mcp sidecars` must not start installing packages; the verb
    // is what makes a network-and-minutes action explicit.
    expect(parseSidecarsArgs([])).toMatchObject({ ok: false });
    expect(parseSidecarsArgs(["install"])).toMatchObject({ ok: true, options: { json: false } });
    expect(parseSidecarsArgs(["install", "--json"])).toMatchObject({ ok: true, options: { json: true } });
  });

  it("reports help and unknown arguments distinctly", () => {
    expect(parseSidecarsArgs(["--help"])).toMatchObject({ ok: false, help: true });
    const bad = parseSidecarsArgs(["install", "--wat"]);
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { error: string }).error).toContain("--wat");
  });
});

describe("runSidecarsInstall", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecars-"));
    mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const writeBundles = (servers: unknown[]) =>
    writeFileSync(join(home, ".yaw-mcp", "bundles.json"), JSON.stringify({ version: 1, servers }));

  it("does nothing and succeeds when no server is npx-launched", async () => {
    // Exit 0, not an error: a docker-only config is a perfectly good config.
    writeBundles([
      { id: "1", name: "D", namespace: "d", type: "local", transport: "stdio", command: "docker", args: ["run", "x"] },
    ]);
    let npmRan = false;

    const res = await runSidecarsInstall({
      home,
      cwd: home,
      runNpm: async () => {
        npmRan = true;
        return 0;
      },
    });

    expect(res.exitCode).toBe(0);
    expect(npmRan, "npm was spawned with nothing to install").toBe(false);
    // The docker case: the config is fine and the servers still run, so say
    // which commands this command covers rather than implying something is
    // wrong.
    expect(res.lines.join("\n")).toContain("only npx servers are installed here");
  });

  it("tells a user with no config at all to add a server first", async () => {
    // Distinct from the case above: with no bundles.json anywhere, "no
    // npx-launched servers in bundles.json" describes a file that does not
    // exist, and leaves a first-time user with no next step.
    const res = await runSidecarsInstall({ home, cwd: home, runNpm: async () => 0, out: () => {} });

    const text = res.lines.join("\n");
    expect(res.exitCode).toBe(0);
    expect(text).toContain("No servers configured yet");
    expect(text).toContain("yaw-mcp add");
    expect(text, "must not describe a bundles.json that does not exist").not.toContain("in bundles.json");
  });

  it("reports a bundles.json it cannot parse as broken, not as an empty machine", async () => {
    // loadLocalBundles returns config=null for BOTH "no file anywhere" and
    // "a file that is there and unusable" (invalid JSON, a non-array `servers`,
    // an EACCES read), telling them apart by leaving `path` set. Collapsing the
    // two told the user to add a server to a file whose actual problem is that
    // it cannot be parsed, and handed a scripted caller `reason: "no-config",
    // error: null` -- a broken machine read as a fresh one, in the document
    // whose whole job is to be the success/failure discriminator.
    writeFileSync(join(home, ".yaw-mcp", "bundles.json"), "{ not json");
    const warnings: string[] = [];
    let out = "";

    const res = await runSidecarsInstall({
      home,
      cwd: home,
      json: true,
      out: (s) => {
        out += s;
      },
      err: (s) => warnings.push(s),
      runNpm: async () => 0,
    });

    const doc = JSON.parse(out);
    expect(res.exitCode, "nothing was installed and the cause is a defect to fix").toBe(1);
    expect(doc.reason).toBe("unreadable-config");
    expect(doc.error, "a consumer branching on `error` must not read this as clean").toContain("invalid JSON");
    // The loader's own diagnostic is what names the defect; every sibling
    // command prints it and this one used to drop it on the floor.
    expect(warnings.join("\n")).toContain("invalid JSON");
    // Same keys as every other path, so the document stays uniform.
    expect(Object.keys(doc).sort()).toEqual(
      ["root", "installed", "reason", "error", "updateError", "unhosted", "conflicts", "skipped"].sort(),
    );
  });

  it("does not offer `yaw-mcp add` when the config exists but is broken", async () => {
    // The text-mode half: "No servers configured yet" describes a machine with
    // no bundles.json, which is precisely what this one is not.
    writeFileSync(join(home, ".yaw-mcp", "bundles.json"), JSON.stringify({ version: 1, servers: "not-an-array" }));

    const res = await runSidecarsInstall({ home, cwd: home, runNpm: async () => 0, out: () => {}, err: () => {} });

    const text = res.lines.join("\n");
    expect(res.exitCode).toBe(1);
    expect(text).toContain("Could not read");
    expect(text).not.toContain("No servers configured yet");
  });

  it("leads with the skips when every npx server is a git or path target", async () => {
    // Reporting "no npx-launched servers" would flatly contradict the config
    // the user is looking at, which reads as a bug rather than an explanation.
    writeBundles([
      {
        id: "1",
        name: "G",
        namespace: "gitsrv",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "github:owner/repo"],
      },
    ]);

    const res = await runSidecarsInstall({ home, cwd: home, runNpm: async () => 0, out: () => {} });

    const text = res.lines.join("\n");
    expect(res.exitCode).toBe(0);
    expect(text).toContain("git or path target");
    expect(text).toContain("gitsrv");
  });

  it("distinguishes the three empty states in --json", async () => {
    // A scripted caller should be able to tell "you have no config" from "your
    // config has nothing installable" without parsing prose.
    const capture = async (servers: unknown[] | null) => {
      if (servers !== null) writeBundles(servers);
      let out = "";
      await runSidecarsInstall({
        home,
        cwd: home,
        json: true,
        out: (s) => {
          out += s;
        },
        runNpm: async () => 0,
      });
      return JSON.parse(out);
    };
    const base = { id: "1", name: "N", namespace: "n", type: "local", transport: "stdio" };

    expect((await capture(null)).reason).toBe("no-config");
    expect((await capture([{ ...base, command: "docker", args: ["run", "x"] }])).reason).toBe("no-npx-servers");
    expect((await capture([{ ...base, command: "npx", args: ["-y", "github:o/r"] }])).reason).toBe(
      "only-non-registry-specs",
    );
  });

  it("writes the manifest and runs npm in the managed directory", async () => {
    writeBundles([
      {
        id: "1",
        name: "F",
        namespace: "fetch",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp@latest"],
      },
    ]);
    // Stand in for what npm would have produced, so the version read-back has
    // something to find.
    const cwds: string[] = [];
    const runNpm = async (_args: string[], cwd: string) => {
      cwds.push(cwd);
      const dir = join(sidecarsNodeModules(home), "@yawlabs", "fetch-mcp");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@yawlabs/fetch-mcp", version: "0.3.6" }));
      return 0;
    };

    const res = await runSidecarsInstall({ home, cwd: home, runNpm, out: () => {}, oamProbe: noOam });

    expect(res.exitCode).toBe(0);
    expect(res.installed).toEqual([{ pkg: "@yawlabs/fetch-mcp", version: "0.3.6", namespaces: ["fetch"] }]);
    // Every npm step runs in the managed directory, never in the caller's cwd.
    expect(new Set(cwds)).toEqual(new Set([sidecarsRoot(home)]));
    const manifest = JSON.parse(readFileSync(join(sidecarsRoot(home), "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ "@yawlabs/fetch-mcp": "latest" });
  });

  it("runs `npm update` after `npm install` so a re-run moves a @latest server forward", async () => {
    // THE reason this command exists. `npm install` cannot re-resolve a
    // dist-tag against an existing tree: with a lockfile present, arborist's
    // dep-valid treats a `tag` spec as satisfied by any node that already has a
    // `resolved` URL, so the locked version stays and npm prints "up to date".
    // Measured against real npm -- install left the old version, update moved
    // it. Without the second step "Re-run this command to move them forward"
    // is a promise the command cannot keep, and a @latest sidecar pins itself
    // permanently the first time it is installed.
    writeBundles([
      {
        id: "1",
        name: "F",
        namespace: "fetch",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp@latest"],
      },
    ]);
    const calls: Array<{ args: string[]; cwd: string }> = [];

    await runSidecarsInstall({
      home,
      cwd: home,
      out: () => {},
      oamProbe: noOam,
      runNpm: async (args, cwd) => {
        calls.push({ args, cwd });
        return 0;
      },
    });

    expect(calls.map((c) => c.args)).toEqual([
      ["install", "--no-audit", "--no-fund"],
      ["update", "--no-audit", "--no-fund"],
    ]);
    // Fixed literals only, in both steps -- the Windows shell in defaultRunNpm
    // is safe ONLY while no user-controlled string reaches these args.
    for (const c of calls) {
      expect(c.cwd).toBe(sidecarsRoot(home));
      expect(c.args.join(" ")).not.toContain(home);
    }
  });

  it("does not run the refresh step when the install itself failed", async () => {
    // Nothing to move forward, and npm has already printed why it failed --
    // a second command on a broken tree only adds noise.
    writeBundles([
      {
        id: "1",
        name: "F",
        namespace: "fetch",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp@latest"],
      },
    ]);
    const verbs: string[] = [];

    const res = await runSidecarsInstall({
      home,
      cwd: home,
      out: () => {},
      runNpm: async (args) => {
        verbs.push(args[0]);
        return 1;
      },
    });

    expect(res.exitCode).toBe(1);
    expect(verbs).toEqual(["install"]);
  });

  it("keeps a failed refresh non-fatal but reports it in --json", async () => {
    // The install succeeded, so the packages ARE on disk and usable -- exiting
    // non-zero would make a scripted caller discard a good tree. What the
    // caller does need to know is that the versions may not have moved, which
    // is why `updateError` is separate from `error`.
    writeBundles([
      {
        id: "1",
        name: "F",
        namespace: "fetch",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp@latest"],
      },
    ]);
    let out = "";

    const res = await runSidecarsInstall({
      home,
      cwd: home,
      json: true,
      out: (s) => {
        out += s;
      },
      oamProbe: noOam,
      runNpm: async (args) => {
        if (args[0] === "install") {
          const dir = join(sidecarsNodeModules(home), "@yawlabs", "fetch-mcp");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@yawlabs/fetch-mcp", version: "0.3.6" }));
          return 0;
        }
        return 7;
      },
    });

    const doc = JSON.parse(out);
    expect(res.exitCode, "a usable tree is not a failure").toBe(0);
    expect(doc.error, "the install itself worked").toBeNull();
    expect(doc.updateError).toContain("npm update exited 7");
    expect(doc.installed[0].version).toBe("0.3.6");
  });

  it("fails when npm fails, and says resolution falls back rather than breaking", async () => {
    // The whole feature is an optimization over the npx cache -- a failed
    // install must not read as "your servers are broken".
    writeBundles([
      {
        id: "1",
        name: "F",
        namespace: "fetch",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp@latest"],
      },
    ]);

    const res = await runSidecarsInstall({ home, cwd: home, runNpm: async () => 1, out: () => {} });

    expect(res.exitCode).toBe(1);
    expect(res.lines.join("\n")).toContain("npx cache");
  });

  it("fails when npm claims success but nothing landed", async () => {
    // A tree that resolved zero of the requested packages is not a success a
    // script should act on, even though npm exited 0.
    writeBundles([
      {
        id: "1",
        name: "F",
        namespace: "fetch",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp@latest"],
      },
    ]);

    const res = await runSidecarsInstall({ home, cwd: home, runNpm: async () => 0, out: () => {}, oamProbe: noOam });

    expect(res.exitCode).toBe(1);
    expect(res.installed[0].version).toBeNull();
  });

  it("succeeds on a PARTIAL install, and says which package did not land", async () => {
    // Every other case here is all-or-nothing, but the exit code turns on
    // `missing.length === installed.length` -- so a partial install is the
    // only input that distinguishes 0 from 1, and an edit to `> 0` would turn
    // every partial install into a hard failure with nothing to catch it.
    const base = { type: "local", transport: "stdio", command: "npx" };
    writeBundles([
      { ...base, id: "1", name: "F", namespace: "fetch", args: ["-y", "@yawlabs/fetch-mcp@latest"] },
      { ...base, id: "2", name: "G", namespace: "gone", args: ["-y", "@yawlabs/not-installed@latest"] },
    ]);
    // npm succeeds but only one of the two packages materialises.
    const runNpm = async () => {
      const dir = join(sidecarsNodeModules(home), "@yawlabs", "fetch-mcp");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@yawlabs/fetch-mcp", version: "0.3.6" }));
      return 0;
    };

    const res = await runSidecarsInstall({ home, cwd: home, runNpm, out: () => {}, oamProbe: noOam });

    expect(res.exitCode, "a partial install is not a failure").toBe(0);
    expect(res.installed.map((i) => i.version)).toEqual(["0.3.6", null]);
    expect(res.lines.join("\n")).toContain("1 package(s) did not land");
  });

  it("emits the same --json keys on every path", async () => {
    // The three exit paths used to emit three different objects, so a consumer
    // could not read `root` without first working out which path it hit. Pin
    // the shape: same keys whether the install worked, found nothing, or
    // failed.
    const KEYS = ["root", "installed", "reason", "error", "updateError", "unhosted", "conflicts", "skipped"].sort();
    const npxServer = {
      id: "1",
      name: "F",
      namespace: "fetch",
      type: "local",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@yawlabs/fetch-mcp@latest"],
    };
    const capture = async (servers: unknown[], npmExit: number, onNpm?: () => void) => {
      writeBundles(servers);
      let out = "";
      await runSidecarsInstall({
        home,
        cwd: home,
        json: true,
        out: (s) => {
          out += s;
        },
        oamProbe: noOam,
        runNpm: async () => {
          onNpm?.();
          return npmExit;
        },
      });
      return JSON.parse(out);
    };
    // Stand in for what npm would have produced, so one capture is a REAL
    // success. Without it every "ok" case here was actually the tree-is-empty
    // path, which is how `error: null` on an exit-1 result stayed pinned.
    const landPackage = () => {
      const dir = join(sidecarsNodeModules(home), "@yawlabs", "fetch-mcp");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@yawlabs/fetch-mcp", version: "0.3.6" }));
    };

    // nothing to do / npm failed / npm exited 0 but nothing landed / installed
    const empty = await capture([{ ...npxServer, command: "docker", args: ["run", "x"] }], 0);
    const failed = await capture([npxServer], 1);
    const emptyTree = await capture([npxServer], 0);
    const ok = await capture([npxServer], 0, landPackage);

    for (const doc of [empty, failed, emptyTree, ok]) {
      expect(Object.keys(doc).sort()).toEqual(KEYS);
      expect(typeof doc.root).toBe("string");
    }
    expect(empty.reason).toBe("no-npx-servers");
    expect(failed.error).toContain("npm exited 1");
    // Exit 1, so `error` has to say so -- a consumer branching on `error`
    // would otherwise read a tree that resolved nothing as a clean install.
    expect(emptyTree.error).toContain("no requested package resolved");
    // Only a genuine install reports no error.
    expect(ok.error).toBeNull();
    expect(ok.installed[0].version).toBe("0.3.6");
  });

  it("says so when nothing will read the tree it just filled", async () => {
    // collectSidecarSpecs filters on `command === "npx"` and nothing else, but
    // the managed tree is read ONLY by resolveNpmEntry on the oam rewrite path.
    // A server pinned to the node runtime spawns through npx and never looks
    // there, so "These versions are now fixed" on its own tells the user their
    // servers are pinned when nothing has changed. `runtime: "node"` is checked
    // before any probe, so this case is deterministic on any machine -- and the
    // probe below is deliberately a WORKING oam, to show the note is about
    // configuration, not about oam being missing.
    writeBundles([
      {
        id: "1",
        name: "F",
        namespace: "fetch",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp@latest"],
        runtime: "node",
      },
    ]);

    const res = await runSidecarsInstall({
      home,
      cwd: home,
      out: () => {},
      runNpm: async () => 0,
      oamProbe: async () => probeWith("oam"),
    });

    const text = res.lines.join("\n");
    expect(text).toContain("Nothing reads these copies yet");
    // The reason comes from describeServerRuntime, so this note and doctor's
    // runtime section cannot drift apart.
    expect(text).toContain('per-server runtime:"node"');
    expect(text).toContain("the managed copies are read only");
  });

  it("stays quiet about the runtime when oam will host the servers", async () => {
    writeBundles([
      {
        id: "1",
        name: "F",
        namespace: "fetch",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp@latest"],
        runtime: "oam",
      },
    ]);

    const res = await runSidecarsInstall({
      home,
      cwd: home,
      out: () => {},
      runNpm: async () => 0,
      oamProbe: async () => probeWith("oam"),
    });

    expect(res.lines.join("\n")).not.toContain("Nothing reads these copies");
  });

  it("says so when oam is not installed at all", async () => {
    // The other half of the same blind spot: nothing about the config is wrong,
    // the machine just has no oam, so every spawn still goes through npx. Only
    // the headline is asserted -- the exact reason string also depends on
    // YAW_MCP_DEFAULT_RUNTIME, which belongs to whoever runs the suite.
    writeBundles([
      {
        id: "1",
        name: "F",
        namespace: "fetch",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp@latest"],
      },
    ]);

    const res = await runSidecarsInstall({
      home,
      cwd: home,
      out: () => {},
      runNpm: async () => 0,
      oamProbe: async () => probeWith(null),
    });

    expect(res.lines.join("\n")).toContain("Nothing reads these copies yet");
  });

  it("carries the unhosted verdict in --json, where `print` cannot reach", async () => {
    // The whole note goes through `print`, which is SUPPRESSED under --json, and
    // no field carried it -- so the Yaw Terminal MCP panel, which shells out to
    // `sidecars install --json`, read a full `installed` array with
    // `error: null` and reported a clean install on a machine where every server
    // in fact still resolves through the npx cache and the managed tree is dead
    // weight. The probe was being paid for and then thrown away.
    writeBundles([
      {
        id: "1",
        name: "F",
        namespace: "fetch",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp@latest"],
        runtime: "node",
      },
    ]);
    let out = "";

    const res = await runSidecarsInstall({
      home,
      cwd: home,
      json: true,
      out: (s) => {
        out += s;
      },
      // A genuine success, which is the point: this is the shape a consumer
      // mistakes for healthy.
      runNpm: async () => {
        const dir = join(sidecarsNodeModules(home), "@yawlabs", "fetch-mcp");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@yawlabs/fetch-mcp", version: "0.3.6" }));
        return 0;
      },
      oamProbe: async () => probeWith("oam"),
    });

    const doc = JSON.parse(out);
    expect(res.exitCode, "the install itself worked -- this is a note, not a failure").toBe(0);
    expect(doc.error).toBeNull();
    expect(doc.installed[0].version).toBe("0.3.6");
    // Same verdicts as the human note, so the two surfaces cannot disagree.
    expect(doc.unhosted).toHaveLength(1);
    expect(doc.unhosted[0]).toContain('per-server runtime:"node"');
    // stdout carries the document and nothing else; the prose really is gone.
    expect(out).not.toContain("Nothing reads these copies yet");
  });

  it("reports an empty unhosted array when oam will host the servers", async () => {
    // The healthy case has to be distinguishable from the note-suppressed one by
    // the FIELD, not by its absence -- an absent key and a key meaning "all
    // good" are the same read for a consumer that only checks truthiness.
    writeBundles([
      {
        id: "1",
        name: "F",
        namespace: "fetch",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp@latest"],
        runtime: "oam",
      },
    ]);
    let out = "";

    await runSidecarsInstall({
      home,
      cwd: home,
      json: true,
      out: (s) => {
        out += s;
      },
      runNpm: async () => 0,
      oamProbe: async () => probeWith("oam"),
    });

    expect(JSON.parse(out).unhosted).toEqual([]);
  });

  it("reports which spec won when a package is configured at two versions", async () => {
    const base = { type: "local", transport: "stdio", command: "npx" };
    writeBundles([
      { ...base, id: "1", name: "A", namespace: "a", args: ["-y", "@yawlabs/postgres-mcp@1.0.0"] },
      { ...base, id: "2", name: "B", namespace: "b", args: ["-y", "@yawlabs/postgres-mcp@latest"] },
    ]);

    const res = await runSidecarsInstall({ home, cwd: home, runNpm: async () => 0, out: () => {}, oamProbe: noOam });

    const text = res.lines.join("\n");
    expect(text).toContain("@yawlabs/postgres-mcp@latest");
    expect(text).toContain("installing @yawlabs/postgres-mcp@1.0.0");
  });
});
