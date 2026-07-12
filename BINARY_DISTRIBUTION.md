# Single-binary distribution of `@yawlabs/mcp`

Ship the sidecar as ONE self-contained per-platform executable that runs with
no Node, no `node_modules`, and nothing on `PATH`. This kills the install-store
mess (npm-global / pnpm-global / bun-global / npx / local-node_modules /
bundled-app) that `upgrade-cmd.ts` has to classify.

> **Status: SHIPPED, with one operational change.** Each `@yawlabs/mcp` release
> builds its per-platform binary on a release-driver machine (the script
> runs `node scripts/build-binary.mjs` for the host's platform/arch, then
> `node scripts/stage-release-asset.mjs`, then attaches the result to the
> GitHub Release). To ship binaries for all 5 platforms, run the build on
> each platform machine and use `release.sh --upload-asset <path> <version>`
> to attach the artifact to the same GitHub Release. The npm package and
> the MCP-registry `server.json` are published from the release-driver
> machine's main `release.sh` invocation. Installable now via
> `scoop install mcp` (YawLabs/scoop-yaw) and
> `brew install yawlabs/yaw/yaw-mcp` (YawLabs/homebrew-yaw). The sections
> below document the build internals; some originally-PoC notes (e.g. the
> single win32-arm64 build, "re-sign for distribution is out of scope") are
> superseded by the build script + the macOS ad-hoc-codesign step now in
> `build-binary.mjs`.

## TL;DR

```
node scripts/build-binary.mjs
```

Produces `bin/<platform>-<arch>/yaw-mcp(.exe)` -- a real OS executable that
embeds the Node runtime plus the entire bundled CLI. Verified on
**win32-arm64** at v0.60.3: 76.37 MB, runs `--version` / `doctor --json` /
`upgrade --json` from a clean directory with Node stripped from `PATH` and no
`node_modules` anywhere in the tree.

## Which compiler worked, and why

**Node 21+ SEA (Single Executable Application).** This is the path that built
cleanly here.

| Candidate | Status | Reason |
|---|---|---|
| `deno compile` | not attempted -- unavailable | `deno --version` -> command not found on the build host. The project is conceptually Deno-friendly (clean ESM, zero native addons), but its `node:` builtin imports are **bare** (`fs`, `crypto`, `path` -- not `node:fs`), which Deno rejects without a compat shim or an import rewrite. That rewrite would mean touching `src/`, which the collision rule forbids. See "deno fallback" below. |
| **Node SEA** | **WORKS** | Node 22 was already on the box. esbuild bundles everything into one CJS file; `node --experimental-sea-config` makes a blob; `postject` injects it into a copy of `node.exe`. No `src/`, `package.json`, or `node_modules` mutation. |
| `bun build --compile` | not attempted -- unavailable | `bun --version` -> command not found. Would also work in principle (see "bun fallback"). |

### Why esbuild first, not the existing `dist/`

`tsup` (the project's builder) keeps `dependencies` **external**. The shipped
`dist/index.js` still imports `@modelcontextprotocol/sdk` and `undici` as bare
specifiers -- it needs `node_modules` at runtime, so it is NOT self-contained
and cannot be fed straight to a compiler.

The build script runs `esbuild --bundle` over `src/index.ts` with **no
externals**, inlining the MCP SDK and undici into a single 2.17 MB CJS file
with zero remaining `node_modules` resolution. esbuild also auto-hoists the
top-level `await` in `index.ts` into an async wrapper, so a CJS target builds
without complaint. THAT bundle is what SEA embeds.

This step only **reads** `node_modules` (via esbuild's resolver). It writes
only to `build-tmp/` and `bin/`.

## Build pipeline (`scripts/build-binary.mjs`)

1. `esbuild src/index.ts --bundle --platform=node --format=cjs --target=node20`
   `--define:__VERSION__="<pkg version>"` -> `build-tmp/yaw-mcp.cjs` (2.17 MB,
   externals included).
2. `node --experimental-sea-config sea-config.json` -> `build-tmp/yaw-mcp.blob`
   (2.62 MB; `useCodeCache: true`, `useSnapshot: false`).
3. Copy the running `node` binary to `bin/<platform>-<arch>/yaw-mcp(.exe)`.
4. `postject <exe> NODE_SEA_BLOB build-tmp/yaw-mcp.blob --sentinel-fuse ...`
   (on macOS also `--macho-segment-name NODE_SEA`).

`postject` is fetched on demand via `npx --yes` into the **global npx cache**,
NOT the project `node_modules` -- so the collision rule holds (no
`npm install`, no project-tree mutation). The script invokes esbuild's and
npx's JS entrypoints directly through `process.execPath` to dodge the Windows
`.cmd`-shim `EINVAL` that `execFileSync` hits on `node_modules/.bin/*.cmd`.

### sea-config.json

```json
{
  "main": "build-tmp/yaw-mcp.cjs",
  "output": "build-tmp/yaw-mcp.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true
}
```

## Binary size

| Artifact | Size |
|---|---|
| esbuild CJS bundle | 2.17 MB |
| SEA blob (bundle + V8 code cache) | 2.62 MB |
| **final `yaw-mcp.exe`** (node.exe + blob) | **76.37 MB** |

The bulk is the embedded Node runtime; the app code is ~3 MB of it. Same
ballpark across SEA / Deno / Bun -- you are always shipping a JS engine.

## The no-Node proof

Verification run (win32-arm64, v0.60.3). The `.exe` was copied to a fresh temp
dir with **no `node_modules`**, and run with `nodejs` + `scoop\shims` removed
from `PATH` (`Get-Command node` returns nothing):

```
# from C:\...\Temp\yaw-mcp-binary-test  (only the .exe, no node_modules)
> yaw-mcp.exe --version
yaw-mcp 0.60.3                       # exit 0

> yaw-mcp.exe doctor --json
{ ... "diagnosis": { "exitCode": 0,
   "summary": "Local mode (Free) -- fully functional, no account needed." } }

> yaw-mcp.exe upgrade --json         # exercises undici network fetch (bundled)
{ "current": "0.60.3", "latest": "0.60.3", "stale": false, ... }
```

`doctor --json` exercises real code paths -- config loading, `fs` / `path` /
`crypto`, client detection, and a live registry fetch via the **bundled**
undici -- all with no Node and no `node_modules`. It also runs from an
unrelated cwd (`C:\Windows`), confirming it is location-independent.

### Windows SmartScreen posture

The pipeline has no `signtool` signing step, so the binary carries no
Authenticode signature. The user experience depends on the install path:

- **Scoop install (supported path):** the Scoop manifest runs
  `Get-ChildItem "$dir\*.exe" | Unblock-File` as a `post_install` step,
  which strips the Mark-of-the-Web (MotW) zone identifier that Windows
  attaches to downloaded files. SmartScreen does **not** fire on the
  installed binary because MotW is already cleared before first launch.

- **Direct browser download of the raw `.exe`:** the downloaded file
  carries MotW, so SmartScreen shows its "unrecognized app" warning on
  first run. Users can click "More info -> Run anyway". This is expected
  behavior for an unsigned binary and will remain until the release
  pipeline is extended with an Authenticode code-signing certificate
  (future work -- needs a cert acquisition and a `signtool` step in
  `release.sh`).

macOS: `codesign` / notarization is similarly absent; Gatekeeper will
quarantine a direct download. Homebrew install clears the quarantine
attribute via `xattr -d com.apple.quarantine` (Homebrew does this
automatically for `using: :nounzip` formula bottles).

## How this kills the install-store classification + the `upgrade-cmd.ts` saga

`upgrade-cmd.ts` carries an 8-way `InstallMethod` union --
`global-npm | pnpm-global | bun-global | npx | local-node-modules |
bundled-app | dev-checkout | unknown` -- and `detectInstallMethod()` reverse-
engineers which one applies by pattern-matching `argv[1]` against
`/_npx/`, `/app.asar.unpacked/`, `/npm/node_modules/@yawlabs/mcp/`, and a
half-dozen more path markers, just to print the right upgrade command. A
single binary collapses all of that: there is no package manager and no
install tree, so the upgrade is "download the new `.exe`" regardless of
platform. The detection heuristic, the `--run` spawn matrix (which shells out
to `npm install` / `pnpm add -g` / `bun add -g`), and the whole store
taxonomy become a no-op for binary installs.

**Concrete gap this PoC surfaced (follow-up for whoever owns `src/`):** a
binary install currently classifies as `method: "unknown"` and `upgrade
--json` still suggests `npm install -g @yawlabs/mcp@latest` -- which is wrong
for a binary (there is no npm install to bump; you swap the file). A
`"binary"` (or `"standalone"`) case in `InstallMethod` + a
`process.execPath`-is-a-SEA check in `detectInstallMethod()` would close it.
I did NOT edit `upgrade-cmd.ts` (collision rule); noting it here instead.

## Fallbacks (if Node SEA is ever unsuitable)

### deno compile

```
# Requires node: import rewrite OR `--unstable-byonm` + deno's node-compat.
deno compile --allow-all --node-modules-dir=auto \
  --output bin/<platform>/yaw-mcp src/index.ts
```

Deno uses its OWN npm cache (`~/.cache/deno`), independent of the project
`node_modules`. Blocker here: the bare `fs` / `crypto` imports. Either add a
`deno.json` `imports` map aliasing them to `node:*`, or run esbuild first (as
this script does) and `deno compile` the bundled CJS, which sidesteps the
specifier issue entirely.

### bun build --compile

```
bun build src/index.ts --compile --target=bun-windows-arm64 \
  --outfile bin/<platform>/yaw-mcp
```

Bun bundles + compiles in one step and handles bare node builtins. Cross-
compiles to other platforms via `--target`. Untested here (bun not installed).

## Cross-platform builds

`scripts/build-binary.mjs` targets the **host** platform/arch (Node SEA cannot
cross-compile -- the carrier is the host `node` binary). The `release.sh` flow
handles this by:
1. **Release driver** (any platform): runs the full release (`release.sh <v>`).
   It builds the host's platform binary, attaches it to the GitHub Release,
   and publishes npm + the MCP registry.
2. **Per-platform machines** (Linux x64, macOS arm64/x64, Windows x64/arm64):
   `release.sh --build-only <v>` to build the host's binary into
   `dist-release/`, then `release.sh --upload-asset dist-release/<asset> <v>`
   to attach it to the same GitHub Release. Idempotent: re-running the upload
   on an already-attached asset is a no-op.

If you need to ship all 5 platforms in one shot, this is the path. The
trade-off vs. the old 5-platform CI matrix: builds are now manual/serial
instead of parallel, but you avoid CI runner minutes and the brittle tag-push
hand-off that broke v0.70.0.

## Files in the pipeline

- `release.sh` -- the single source of truth. Runs lint, typecheck, tests,
  build (host platform), bump, tag, push, npm publish, MCP-registry publish,
  GitHub Release creation, asset attach. Also accepts `--build-only` and
  `--upload-asset PATH` for per-platform machine runs.
- `scripts/build-binary.mjs` -- esbuild (JS API) -> SEA blob -> postject (JS
  API) -> macOS ad-hoc codesign. Builds the host platform only.
- `scripts/stage-release-asset.mjs` -- rename to `yaw-mcp-<platform>-<arch>`
  + sha256 sidecar.
- `scripts/update-manifests.mjs` -- regenerate the Scoop + Homebrew manifests
  from a release's hashes.
- `sea-config.json` -- Node SEA config.
- `bin/` + `build-tmp/` + `dist-release/` -- build artifacts (gitignored).

## Manifest bump: local script

After a release, run

```
node scripts/update-manifests.mjs --version <X.Y.Z> --push
```

which pulls the release's `.sha256` sidecars, rewrites both manifests, and
pushes to the sibling repos over SSH (`gh_woods`). This mirrors Yaw Terminal's
`release.sh` and needs no cross-repo CI secret. The script is the same
generator whether you're on the release-driver machine or a per-platform one.

The binary BUILD is per-workstation (driven by `release.sh`); the manifest
BUMP is still local-and-after-the-fact. To make it fully automatic, the
script would need a cross-repo PAT (the default `GITHUB_TOKEN` is scoped to
this repo only) with write to scoop-yaw + homebrew-yaw. That's a deliberate
secret/scope decision; until it's made, the local `--push` is the supported path.

## Adopting this pipeline in another `@yawlabs/*` server

The same four files drop into any sibling MCP server that is a public,
pure-JS CLI (a `bin` entry, no native addons). Per a survey of
`mcp_servers/`, the candidates are:

> aws-mcp, caddy-mcp, ctxlint, electron-mcp, fetch-mcp, lemonsqueezy-mcp,
> mcp-compliance, nol-mcp, npmjs-mcp, postgres-mcp, redis-mcp, ssh-mcp,
> tailscale-mcp, vew-mcp (14 public pure-JS CLIs).

**Blocked:** `lemonsqueezy-webhook-sink` ships a native dep (`better-sqlite3`);
Node SEA can't embed a `.node` addon, so it needs the addon shipped alongside
the binary (or a different packager) -- not a clean single-binary target.
**Skipped:** `ctxlint-bench`, `postgres-mcp-smoke` (private/internal).

Checklist to adopt:

1. Copy the three build files AS-IS -- `scripts/build-binary.mjs`,
   `scripts/stage-release-asset.mjs`, `sea-config.json`. They derive the
   binary name from the package's `bin` field, so **no rename is needed**.
2. Add `postject` as a devDep (`esbuild` is already one on these servers).
3. Confirm `src/index.ts` (the target's entry) bundles clean under esbuild
   with all deps inlined (no native addons). `node scripts/build-binary.mjs`
   locally is the check.
4. Copy `scripts/update-manifests.mjs` and edit its per-repo values: the
   `REPO` URL (`YawLabs/<repo>`), the `ASSETS` names, and the Scoop/Homebrew
   command name -- it targets scoop-yaw `bucket/<name>.json` + homebrew-yaw
   `Formula/<name>.rb`.
5. `chmod +x` the build artifacts via the scripts (already handled); gitignore
   `bin/ build-tmp/ dist-release/`.
6. Wire `release.sh` (or an equivalent) for the bump + tag + npm + registry
   + GitHub Release flow. The release-driver machine runs the full path; per-
   platform machines use `--build-only` and `--upload-asset` to attach their
   binaries.

This is the copy-paste path that closes the "make the JS sidecars bundle like
the Go `micro` editor" goal for each server.
