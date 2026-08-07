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
import {
  collectNonRegistrySpecs,
  collectSidecarSpecs,
  installedVersion,
  isRegistrySpec,
  parseSidecarsArgs,
  runSidecarsInstall,
  sidecarsManifest,
  sidecarsNodeModules,
  sidecarsRoot,
} from "../sidecars-cmd.js";
import type { UpstreamServerConfig } from "../types.js";

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
    const runNpm = async (args: string[], cwd: string) => {
      expect(args[0]).toBe("install");
      expect(cwd).toBe(sidecarsRoot(home));
      const dir = join(sidecarsNodeModules(home), "@yawlabs", "fetch-mcp");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@yawlabs/fetch-mcp", version: "0.3.6" }));
      return 0;
    };

    const res = await runSidecarsInstall({ home, cwd: home, runNpm, out: () => {} });

    expect(res.exitCode).toBe(0);
    expect(res.installed).toEqual([{ pkg: "@yawlabs/fetch-mcp", version: "0.3.6", namespaces: ["fetch"] }]);
    const manifest = JSON.parse(readFileSync(join(sidecarsRoot(home), "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ "@yawlabs/fetch-mcp": "latest" });
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

    const res = await runSidecarsInstall({ home, cwd: home, runNpm: async () => 0, out: () => {} });

    expect(res.exitCode).toBe(1);
    expect(res.installed[0].version).toBeNull();
  });

  it("emits the same --json keys on every path", async () => {
    // The three exit paths used to emit three different objects, so a consumer
    // could not read `root` without first working out which path it hit. Pin
    // the shape: same keys whether the install worked, found nothing, or
    // failed.
    const KEYS = ["root", "installed", "reason", "error", "conflicts", "skipped"].sort();
    const npxServer = {
      id: "1",
      name: "F",
      namespace: "fetch",
      type: "local",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@yawlabs/fetch-mcp@latest"],
    };
    const capture = async (servers: unknown[], npmExit: number) => {
      writeBundles(servers);
      let out = "";
      await runSidecarsInstall({
        home,
        cwd: home,
        json: true,
        out: (s) => {
          out += s;
        },
        runNpm: async () => npmExit,
      });
      return JSON.parse(out);
    };

    // nothing to do / npm failed / npm succeeded but the tree is empty
    const empty = await capture([{ ...npxServer, command: "docker", args: ["run", "x"] }], 0);
    const failed = await capture([npxServer], 1);
    const ok = await capture([npxServer], 0);

    for (const doc of [empty, failed, ok]) {
      expect(Object.keys(doc).sort()).toEqual(KEYS);
      expect(typeof doc.root).toBe("string");
    }
    expect(empty.reason).toBe("no-npx-servers");
    expect(failed.error).toContain("npm exited 1");
    expect(ok.error).toBeNull();
  });

  it("reports which spec won when a package is configured at two versions", async () => {
    const base = { type: "local", transport: "stdio", command: "npx" };
    writeBundles([
      { ...base, id: "1", name: "A", namespace: "a", args: ["-y", "@yawlabs/postgres-mcp@1.0.0"] },
      { ...base, id: "2", name: "B", namespace: "b", args: ["-y", "@yawlabs/postgres-mcp@latest"] },
    ]);

    const res = await runSidecarsInstall({ home, cwd: home, runNpm: async () => 0, out: () => {} });

    const text = res.lines.join("\n");
    expect(text).toContain("@yawlabs/postgres-mcp@latest");
    expect(text).toContain("installing @yawlabs/postgres-mcp@1.0.0");
  });
});
