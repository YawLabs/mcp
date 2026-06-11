#!/usr/bin/env node
// Build a self-contained single-file binary of the @yawlabs/mcp sidecar.
//
// Strategy: esbuild bundles src/index.ts + ALL its dependencies (including
// the externals tsup leaves out -- @modelcontextprotocol/sdk and undici)
// into ONE CommonJS file with zero remaining node_modules resolution, then
// Node's Single Executable Application (SEA) feature embeds that bundle as a
// resource inside a copy of the node binary. The result runs with no Node,
// no node_modules, and no PATH dependency.
//
// Why not `deno compile`? Deno was not installed on the build host at authoring
// time (`deno --version` -> command not found). The project itself is fully
// Deno-compatible in principle (clean ESM, no native addons), but the node:
// builtin imports in the bundle are bare (`fs`, not `node:fs`), which Deno
// rejects without a compat shim. Node SEA needs no such rewrite and ships with
// the Node already on the box, so it is the zero-friction path here. See
// BINARY_DISTRIBUTION.md for the deno/bun fallbacks.
//
// This script ONLY reads node_modules (via esbuild's resolver) and writes to
// build-tmp/ and bin/<platform>-<arch>/. It does NOT mutate package.json,
// package-lock.json, src/, or node_modules, and it never runs `npm install`.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const platformDir = `${process.platform}-${process.arch}`;
const binDir = join(repoRoot, 'bin', platformDir);
const tmpDir = join(repoRoot, 'build-tmp');
const bundlePath = join(tmpDir, 'yaw-mcp.cjs');
const blobPath = join(tmpDir, 'yaw-mcp.blob');
const exeName = isWin ? 'yaw-mcp.exe' : 'yaw-mcp';
const outExe = join(binDir, exeName);

const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
}

function fmtSize(p) {
  const bytes = statSync(p).size;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes} bytes)`;
}

mkdirSync(tmpDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

// 1. Bundle everything into one CJS file (externals included).
// Call esbuild's JS entry directly with the running node binary. This avoids
// the .cmd shim (EINVAL under execFileSync on Windows) AND a shell, so the
// --define value's inner quotes survive verbatim instead of being eaten by
// cmd.exe quote-mangling.
const esbuildEntry = join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild');
run(process.execPath, [
  esbuildEntry,
  'src/index.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node20',
  `--define:__VERSION__="${version}"`,
  `--outfile=${bundlePath}`,
]);
console.log(`bundle: ${fmtSize(bundlePath)}`);

// 2. Generate the SEA blob from sea-config.json.
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);
console.log(`blob:   ${fmtSize(blobPath)}`);

// 3. Copy the running node binary as the carrier.
rmSync(outExe, { force: true });
copyFileSync(process.execPath, outExe);

// macOS: strip the carrier node binary's existing signature BEFORE injecting,
// so postject doesn't leave a CORRUPT signature (which is worse than none --
// arm64 SIGKILLs a bad-sig binary at exec). We ad-hoc re-sign after step 4.
if (process.platform === 'darwin') {
  run('codesign', ['--remove-signature', outExe]);
}

// 4. Inject the blob with postject (fetched on demand into the global npx
//    cache -- does NOT touch the project node_modules). Invoke npm's npx-cli.js
//    via the running node binary so no .cmd shim or shell is involved.
const postjectArgs = [
  outExe,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (process.platform === 'darwin') {
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}
const npxCli = resolve(
  dirname(process.execPath),
  'node_modules/npm/bin/npx-cli.js',
);
run(process.execPath, [npxCli, '--yes', 'postject', ...postjectArgs]);

// 5. macOS: ad-hoc re-sign AFTER injection. Apple Silicon refuses to exec a
//    Mach-O with no/invalid signature ("killed: 9"); `--sign -` is the free
//    ad-hoc identity (no cert, no notarization). Distribution is via the
//    Homebrew TAP (a formula), whose curl fetch sets no com.apple.quarantine,
//    so Gatekeeper never blocks it -- ad-hoc is sufficient. `--force` replaces
//    any residual signature; `--timestamp=none` keeps it offline/reproducible.
if (process.platform === 'darwin') {
  run('codesign', ['--sign', '-', '--force', '--timestamp=none', outExe]);
  run('codesign', ['--verify', '--verbose', outExe]);
  // --verify proves the signature is intact, NOT that the binary launches.
  // arm64 SIGKILLs a bad-sig Mach-O only at exec, so actually run it -- this
  // is the real check the whole remove/re-sign dance defends. (CI also smoke-
  // tests, but a standalone `node scripts/build-binary.mjs` on a Mac should
  // catch a non-launching binary too.)
  run(outExe, ['--version']);
}

console.log('');
console.log(`OK  ${outExe}`);
console.log(`    ${fmtSize(outExe)}`);
console.log('');
console.log('Verify with:');
console.log(`    "${outExe}" --version`);
console.log(`    "${outExe}" doctor --json`);
