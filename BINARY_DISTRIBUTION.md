# Single-binary distribution of `@yawlabs/mcp`

Proof-of-concept: ship the sidecar as ONE self-contained per-platform
executable that runs with no Node, no `node_modules`, and nothing on `PATH`.
This kills the install-store mess (npm-global / pnpm-global / bun-global / npx
/ local-node_modules / bundled-app) that `upgrade-cmd.ts` has to classify.

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

### One Windows caveat

`postject` invalidates the copied `node.exe` Authenticode signature
(`warning: The signature seems corrupted!`). Harmless for local runs;
**for distribution the binary must be re-signed** (`signtool` on Windows,
`codesign` on macOS) or Defender / Gatekeeper will flag it. That is a
release-pipeline step, out of scope for this PoC.

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
cross-compile -- the carrier is the host `node` binary). To produce
linux-x64 / darwin-arm64 / win32-x64 artifacts, run the same script on each
target (a CI matrix), or switch to `bun build --compile --target=...` /
`deno compile --target=...`, both of which cross-compile from one host.

## Files added by this PoC (no existing files touched)

- `scripts/build-binary.mjs` -- the build pipeline.
- `sea-config.json` -- Node SEA config.
- `bin/<platform>-<arch>/yaw-mcp(.exe)` -- the binary (gitignore-worthy; large).
- `build-tmp/` -- intermediate bundle + blob (gitignore-worthy).
- `BINARY_DISTRIBUTION.md` -- this file.
