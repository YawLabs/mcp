import { describe, expect, it } from "vitest";
import { isEphemeralMountPath, type StableSpellingDeps, stableSpellingOf } from "../stable-entry.js";

/** A fake tree: <parent>/1.0.0 is the real dir, <parent>/current links to it. */
function fakeDeps(over: Record<string, unknown> = {}): StableSpellingDeps {
  const VER = "C:\\app\\1.0.0";
  const CUR = "C:\\app\\current";
  const real = (p: string): string => (p.startsWith(CUR) ? VER + p.slice(CUR.length) : p);
  return {
    argv1: undefined,
    realpath: (p: string): string => {
      const r = real(p);
      if (
        r === "C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js" ||
        r === VER ||
        r === "C:\\app" ||
        r === `C:${String.fromCharCode(92)}`
      )
        return r;
      if (r.startsWith(VER)) return r;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    readdir: (p: string): string[] => (p === "C:\\app" ? ["1.0.0", "current"] : []),
    isSymlink: (p: string): boolean => p === CUR,
    ...over,
  };
}

describe("isEphemeralMountPath", () => {
  it("flags a macOS App Translocation path", () => {
    expect(isEphemeralMountPath("/private/var/folders/x/AppTranslocation/ABC-123/d/Yaw.app/Contents/Resources")).toBe(
      true,
    );
  });

  it("flags an AppImage runtime mount", () => {
    expect(isEphemeralMountPath("/tmp/.mount_Yaw8xKq1/resources/app")).toBe(true);
  });

  it("leaves an ordinary install alone", () => {
    expect(isEphemeralMountPath("C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js")).toBe(false);
  });
});

describe("stableSpellingOf", () => {
  it("prefers the argv[1] spelling when it names the same file", () => {
    // The bundled-app case: the launcher used the junction, so argv[1] already
    // carries the durable spelling while import.meta.url was realpathed.
    const deps = fakeDeps({ argv1: "C:\\app\\current\\node_modules\\@y\\m\\dist\\index.js" });
    expect(stableSpellingOf("C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js", deps)).toBe(
      "C:\\app\\current\\node_modules\\@y\\m\\dist\\index.js",
    );
  });

  it("ignores argv[1] when it names a DIFFERENT file", () => {
    const deps = fakeDeps({
      argv1: `C:${String.fromCharCode(92)}somewhere${String.fromCharCode(92)}else.js`,
    });
    // Falls through to the alias walk, which still finds the junction.
    expect(stableSpellingOf("C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js", deps)).toBe(
      "C:\\app\\current\\node_modules\\@y\\m\\dist\\index.js",
    );
  });

  describe("an argv[1] that names the same file through a per-session directory", () => {
    // fnm puts a fresh `fnm_multishells/<pid>_<ts>` link on PATH for every
    // shell, so a globally installed yaw-mcp is launched as
    // `<that dir>/bin/yaw-mcp` -- the same file, by realpath, as the durable
    // `node-versions/...` path, and gone when the shell's directory is
    // cleaned. Identity alone accepted it and it was persisted into a
    // machine-global client config.
    const DURABLE = "/home/u/.local/share/fnm/node-versions/v22.1.0/installation/lib/node_modules/@yawlabs/mcp";
    const ENTRY = `${DURABLE}/dist/index.js`;
    const CASES: Array<[string, string, string]> = [
      [
        "fnm on Linux, under $XDG_RUNTIME_DIR",
        "/run/user/1000/fnm_multishells/4242_1700000000000/bin/yaw-mcp",
        "/run/user/1000/fnm_multishells/4242_1700000000000",
      ],
      [
        "fnm on macOS, under its state dir",
        "/Users/u/.local/state/fnm_multishells/4242_1700000000000/bin/yaw-mcp",
        "/Users/u/.local/state/fnm_multishells/4242_1700000000000",
      ],
      [
        "fnm on Windows, a junction under %LOCALAPPDATA%",
        "C:\\Users\\u\\AppData\\Local\\fnm_multishells\\4242_1700000000000\\node_modules\\@yawlabs\\mcp\\dist\\index.js",
        "C:\\Users\\u\\AppData\\Local\\fnm_multishells\\4242_1700000000000",
      ],
      ["any link under /run/user/<uid>", "/run/user/1000/some-tool/bin/yaw-mcp", "/run/user/1000/some-tool"],
      ["an AppImage mount", "/tmp/.mount_Yaw8xKq1/bin/yaw-mcp", "/tmp/.mount_Yaw8xKq1"],
    ];
    for (const [name, argv1, sessionDir] of CASES) {
      // A drive-letter argv[1] is absolute only under win32 path rules. On a
      // POSIX host stableSpellingOf resolves it against the cwd, the stub
      // realpath below no longer maps it to ENTRY, and the case would pass
      // with or without the session-directory refusal -- so it runs only
      // where it can fail.
      const run = /^[A-Za-z]:\\/.test(argv1) ? it.runIf(process.platform === "win32") : it;
      run(`keeps the durable entry: ${name}`, () => {
        const deps: StableSpellingDeps = {
          argv1,
          // Everything under the session dir resolves to the one real file.
          realpath: (p: string): string => (p.startsWith(sessionDir) ? ENTRY : p),
          readdir: () => [],
          isSymlink: () => false,
        };
        expect(stableSpellingOf(ENTRY, deps)).toBe(ENTRY);
      });
    }

    it("still takes an argv[1] that is merely NEAR such a name", () => {
      // The refusal is for the session directories themselves, not for any
      // path that happens to contain the letters.
      const argv1 = "/opt/fnm_multishells_backup/current/dist/index.js";
      const deps: StableSpellingDeps = {
        argv1,
        realpath: (p: string): string => (p === argv1 ? ENTRY : p),
        readdir: () => [],
        isSymlink: () => false,
      };
      expect(stableSpellingOf(ENTRY, deps)).toBe(argv1);
    });
  });

  it("finds a sibling link pointing at an ancestor when argv[1] is useless", () => {
    const deps = fakeDeps({ argv1: undefined });
    expect(stableSpellingOf("C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js", deps)).toBe(
      "C:\\app\\current\\node_modules\\@y\\m\\dist\\index.js",
    );
  });

  it("is a no-op when no link resolves to any ancestor", () => {
    const deps = fakeDeps({ readdir: () => [], isSymlink: () => false, argv1: undefined });
    expect(stableSpellingOf("C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js", deps)).toBe(
      "C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js",
    );
  });

  it("never returns a path naming a different file", () => {
    // A sibling link exists but the rewritten path resolves elsewhere: the
    // realpath-identity gate must reject it rather than redirect the entry.
    const deps = fakeDeps({
      realpath: (p: string): string =>
        p.includes("current") ? `C:${String.fromCharCode(92)}totally${String.fromCharCode(92)}other.js` : p,
    });
    expect(stableSpellingOf("C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js", deps)).toBe(
      "C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js",
    );
  });

  it("is a no-op when the entry itself cannot be realpathed", () => {
    const deps = fakeDeps({
      realpath: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(stableSpellingOf("C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js", deps)).toBe(
      "C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js",
    );
  });

  it("survives a readdir that throws", () => {
    const deps = fakeDeps({
      argv1: undefined,
      readdir: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    });
    expect(stableSpellingOf("C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js", deps)).toBe(
      "C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js",
    );
  });
});

describe("stableSpellingOf -- regressions found on a real filesystem", () => {
  it("never aliases a non-version ancestor, even when realpath says it is the same file", () => {
    // Windows ships a hidden legacy junction: C:\Documents and Settings -> C:\Users.
    // It resolves to the same file, so realpath identity ACCEPTS it -- but its
    // ACL denies traversal to most processes, so persisting it hands the
    // client a path it cannot open. Only version-shaped segments may alias.
    const USERS = `C:${String.fromCharCode(92)}Users`;
    const LEGACY = `C:${String.fromCharCode(92)}Documents and Settings`;
    const entry =
      USERS +
      String.fromCharCode(92) +
      "me" +
      String.fromCharCode(92) +
      "app" +
      String.fromCharCode(92) +
      "dist" +
      String.fromCharCode(92) +
      "index.js";
    const deps: StableSpellingDeps = {
      argv1: undefined,
      realpath: (p: string): string => (p.startsWith(LEGACY) ? USERS + p.slice(LEGACY.length) : p),
      readdir: (p: string): string[] =>
        p === `C:${String.fromCharCode(92)}` ? ["Users", "Documents and Settings"] : [],
      isSymlink: (p: string): boolean => p === LEGACY,
    };
    expect(stableSpellingOf(entry, deps)).toBe(entry);
  });

  it("walks deepest-first so the nearest version alias wins", () => {
    const deps = fakeDeps({ argv1: undefined });
    const got = stableSpellingOf("C:\\app\\1.0.0\\node_modules\\@y\\m\\dist\\index.js", deps);
    expect(got).toContain("current");
  });

  it("keeps the caller's separator style instead of normalising", () => {
    // A forward-slash-spelled Windows path must come back forward-slashed:
    // the result is string-compared later by the heal recogniser.
    const VER = "C:/app/1.0.0";
    const CUR = "C:/app/current";
    const entry = `${VER}/dist/index.js`;
    const deps: StableSpellingDeps = {
      argv1: undefined,
      realpath: (p: string): string => (p.startsWith(CUR) ? VER + p.slice(CUR.length) : p),
      readdir: (p: string): string[] => (p === "C:/app" ? ["1.0.0", "current"] : []),
      isSymlink: (p: string): boolean => p === CUR,
    };
    expect(stableSpellingOf(entry, deps)).toBe(`${CUR}/dist/index.js`);
  });
});

describe("stableSpellingOf -- version directory at a filesystem root", () => {
  // dirname returns a ROOT with its separator attached ("C:\\", "/") and every
  // other directory without one, so the separator is not at index
  // parent.length. Getting that wrong read the first character of the segment
  // NAME as the separator -- "C:\\1.0.0" gave sep "1" and name ".0.0" -- which
  // failed the version test and built "C:\\1current", so a release directory
  // sitting at a root was silently never aliased.
  const deps: StableSpellingDeps = {
    argv1: undefined,
    realpath: (p: string): string => (p.startsWith("C:\\current") ? `C:\\1.0.0${p.slice("C:\\current".length)}` : p),
    readdir: (p: string): string[] => (p === "C:\\" ? ["1.0.0", "current"] : []),
    isSymlink: (p: string): boolean => p === "C:\\current",
  };

  it("aliases it to the sibling link rather than skipping it", () => {
    expect(stableSpellingOf("C:\\1.0.0\\dist\\index.js", deps)).toBe("C:\\current\\dist\\index.js");
  });

  it("does the same on a POSIX root", () => {
    const posix: StableSpellingDeps = {
      argv1: undefined,
      realpath: (p: string): string => (p.startsWith("/current") ? `/1.0.0${p.slice("/current".length)}` : p),
      readdir: (p: string): string[] => (p === "/" ? ["1.0.0", "current"] : []),
      isSymlink: (p: string): boolean => p === "/current",
    };
    expect(stableSpellingOf("/1.0.0/dist/index.js", posix)).toBe("/current/dist/index.js");
  });
});

describe("isEphemeralMountPath -- the supported install layouts", () => {
  // One row per shape we actually ship or that a supported host produces.
  // "ephemeral" means: the path carries a segment that is gone on the next
  // launch, so it must never be persisted and no later repair could converge.
  const CASES: Array<[string, string, boolean]> = [
    ["linux AppImage, FUSE mount", "/tmp/.mount_Yaw8xKq1/resources/app.asar.unpacked", true],
    ["linux AppImage, relocated TMPDIR", "/run/user/1000/.mount_YawAbc/resources/app", true],
    ["linux AppImage, extract-and-run (no FUSE)", "/tmp/appimage_extracted_9f2c1/resources/app", true],
    [
      "macOS translocated (quarantined)",
      "/private/var/folders/x/AppTranslocation/UUID/d/Yaw.app/Contents/Resources",
      true,
    ],
    ["macOS /Applications", "/Applications/Yaw.app/Contents/Resources/app.asar.unpacked", false],
    ["macOS homebrew cask target", "/opt/homebrew/Caskroom/yaw/2.1.5/Yaw.app/Contents/Resources", false],
    ["linux deb/rpm", "/opt/Yaw/resources/app.asar.unpacked", false],
    ["linux /usr/lib", "/usr/lib/yaw/resources/app.asar.unpacked", false],
    ["windows scoop", "C:\\Users\\j\\scoop\\apps\\yaw\\2.1.5\\resources", false],
    ["windows Program Files", "C:\\Program Files\\Yaw\\resources", false],
    ["ordinary /tmp checkout", "/tmp/build/yaw/node_modules", false],
    ["a dir merely CONTAINING mount_", "/opt/mount_data/yaw/node_modules", false],
  ];

  for (const [name, p, ephemeral] of CASES) {
    it(`${ephemeral ? "refuses" : "allows"}: ${name}`, () => {
      expect(isEphemeralMountPath(p)).toBe(ephemeral);
    });
  }
});
