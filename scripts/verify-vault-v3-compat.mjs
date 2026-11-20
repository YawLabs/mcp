#!/usr/bin/env node
/**
 * `node scripts/verify-vault-v3-compat.mjs` -- what do SHIPPED builds of
 * @yawlabs/mcp say when they meet a schema-v3 vault?
 *
 * A user who upgrades, runs `secrets rotate` (which writes v3), and then runs
 * an older yaw-mcp somewhere else -- a pinned MCP client entry, a second
 * machine sharing the file -- gets whatever that old build's loadVault/unlock
 * make of the file. Two eras matter:
 *
 *   >= 0.73.1  loadVault has a schema gate (added in 2e3cac3, #74, first
 *              tagged v0.73.1): a version above its own is refused with
 *              "was written by a newer yaw-mcp ...; upgrade yaw-mcp to read
 *              it". The gate runs AFTER the salt/entries shape check, which
 *              is why a v3 file keeps an inert top-level `salt`.
 *   <= 0.73.0  no gate: it scrypts the passphrase against that inert salt,
 *              the check marker fails to decrypt, and it reports "wrong
 *              passphrase for this vault (decryption failed)". Misleading;
 *              for this era the check below proves only that the run leaves
 *              the vault file byte-identical (sha256 before == after), exits
 *              non-zero and never prints the value -- nothing decryptable
 *              comes out and nothing is written. It does not, and cannot,
 *              prove the old build never read the bytes.
 *
 * This script proves both against the checked-in fixture
 * src/tests/fixtures/vault-v3.json (passphrase in src/tests/fixtures/README.md)
 * using the boundary build README.md and CHANGELOG.md name as ">= 0.73.1"
 * (0.73.1), the newest pre-v3 release (1.1.13), and the last release without
 * the gate (0.73.0). Each version is `npm pack`ed into its own empty directory,
 * installed into another empty directory with --omit=dev --ignore-scripts,
 * and driven through its own CLI (`yaw-mcp secrets get github`) with
 * HOME/USERPROFILE (and the app-data roots) pointed at a sandbox holding the
 * fixture as ~/.yaw-mcp/secrets.json. The published packages are bundled
 * (tsup), so loadVault/unlock are not importable on their own; the CLI's get
 * path is the shipped loadVault + unlock and nothing else of interest.
 *
 * Each version also runs a CONTROL first: in a fresh sandbox home, the build
 * itself writes a vault (`secrets set github --value ...`) and must read the
 * value back (`secrets get github`). Without it, a harness fault (wrong HOME,
 * passphrase not reaching the process) would read as the expected "wrong
 * passphrase" for 0.73.0. The control vault is written by the build under
 * test, not taken from src/tests/fixtures: vault-v1.json carries the AAD-bound
 * check marker of a later v1, which 0.73.0 (no AAD at all) cannot open.
 *
 * Needs the network (npm registry), so it is a script run by hand, not part
 * of vitest. Output: one `[verify:vault-v3-compat] OK -- ...` or `FAIL -- ...`
 * line per check, exit 0 only when every check passed. --keep leaves the temp
 * directory in place and prints its path.
 *
 * The run block is guarded by isMainModule so src/tests/verify-vault-compat.test.ts
 * can import the half that needs no network: TARGETS and its expected messages,
 * plus evaluateV3Run, the pure verdict over {run, before/after sha256} that
 * decides OK vs FAIL. Running `node scripts/verify-vault-v3-compat.mjs` is
 * unchanged by that.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const TAG = "[verify:vault-v3-compat]";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(REPO, "src", "tests", "fixtures");

export const WRONG_PASSPHRASE = "wrong passphrase for this vault (decryption failed)";

/** The schema-gate message for the v3 fixture: "<file version> > <this
 *  build's own max schema>", so it differs per build (measured: 0.73.1 says
 *  `3 > 1`, 1.1.13 says `3 > 2`), as a function of the vault path (the gated
 *  message names it). */
export const gateMessage = (path, ownMax) =>
  `vault at ${path} was written by a newer yaw-mcp (schema version 3 > ${ownMax}); upgrade yaw-mcp to read it`;

/** The versions to probe, each carrying the message it must give for the v3
 *  fixture. */
export const TARGETS = [
  { version: "0.73.1", expected: (path) => gateMessage(path, 1) },
  { version: "1.1.13", expected: (path) => gateMessage(path, 2) },
  { version: "0.73.0", expected: () => WRONG_PASSPHRASE },
];
const V3 = { fixture: "vault-v3.json", passphrase: "golden-v3-fixture-passphrase", value: "ghp_fixture_v3" };
const CONTROL = { passphrase: "control-fixture-passphrase-0001", value: "ghp_control_value" };

const isWin = process.platform === "win32";

/** Run npm in `cwd`. Every argument is a fixed string or a bare file name (no
 *  spaces, no shell metacharacters), so shell:true -- required to launch
 *  npm.cmd on win32 -- interprets nothing. */
function npm(cwd, args) {
  const r = spawnSync(isWin ? "npm.cmd" : "npm", args, { cwd, encoding: "utf8", shell: isWin, timeout: 300_000 });
  if (r.status !== 0) {
    throw new Error(
      `npm ${args.join(" ")} failed in ${cwd} (exit ${r.status}): ${(r.stderr || r.error?.message || "").trim()}`,
    );
  }
  return r.stdout;
}

/** npm pack `spec` into its own empty directory, install the tarball into
 *  another empty one, and return the installed CLI entry. */
function installVersion(root, version) {
  const packDir = join(root, `pack-${version}`);
  const installDir = join(root, `install-${version}`);
  mkdirSync(packDir);
  mkdirSync(installDir);
  npm(packDir, ["pack", `@yawlabs/mcp@${version}`, "--silent"]);
  const tgz = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
  if (tgz.length !== 1) throw new Error(`npm pack @yawlabs/mcp@${version} left ${tgz.length} tarballs in ${packDir}`);
  // A package.json of its own, so npm does not walk up to some ancestor's.
  writeFileSync(join(installDir, "package.json"), `${JSON.stringify({ name: "vault-compat-probe", private: true })}\n`);
  npm(installDir, [
    "install",
    `../pack-${version}/${tgz[0]}`,
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--silent",
  ]);
  return join(installDir, "node_modules", "@yawlabs", "mcp", "dist", "index.js");
}

/** A fresh sandbox home under `root`, with `fixture` (when given) copied in as
 *  its vault. */
function sandbox(root, label, fixture) {
  const home = join(root, `home-${label}`);
  const vaultDir = join(home, ".yaw-mcp");
  mkdirSync(vaultDir, { recursive: true });
  const vault = join(vaultDir, "secrets.json");
  if (fixture) copyFileSync(join(FIXTURES, fixture), vault);
  return { home, vault };
}

/** Run the CLI at `cli` with HOME (and every app-data root) inside `home`, the
 *  vault passphrase in the env, and stdin closed -- not a TTY, so no prompt
 *  can wait. */
function runCli(cli, home, passphrase, args) {
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    YAW_MCP_VAULT_PASSPHRASE: passphrase,
    YAW_MCP_AUTO_UPGRADE: "0",
    NO_COLOR: "1",
  };
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

const describe = (r) =>
  `exit ${r.status}${r.error ? ` (${r.error.message})` : ""}, stdout=${JSON.stringify(r.stdout.trim())} stderr=${JSON.stringify(r.stderr.trim())}`;

/** The vault file's sha256, hex. */
const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * The verdict for ONE probed build's v3 run -- pure, no IO of its own and no
 * printing, so src/tests/verify-vault-compat.test.ts can drive every branch.
 *
 * `before` is the vault's sha256 taken before the run; `read` re-reads the
 * vault file AFTER it and may throw (a probed build may delete or rename it) --
 * that counts as a failure here rather than an error escaping main(), which
 * would lose the report for the remaining TARGETS.
 *
 * Returns the whole line either way: `{ ok: true, message }` with the OK text
 * already carrying TAG, or `{ ok: false, message }` with the body main's `fail`
 * prefixes. The conditions are main's original ones verbatim: non-zero exit,
 * stderr carrying `expected(vault)`, no decrypted value in either stream, and
 * byte-identical vault.
 */
export function evaluateV3Run({ version, expected, vault, run, before, read, value = V3.value }) {
  let after;
  try {
    after = sha256Hex(read());
  } catch (err) {
    // A probed build may delete or rename the vault; a raw throw here would
    // escape main(), losing the report for the remaining TARGETS.
    return {
      ok: false,
      message: `${version} on v3: vault unreadable after the run (${err instanceof Error ? err.message : String(err)}); before: sha256 ${before}`,
    };
  }
  const want = expected(vault);
  const leaked = run.stdout.includes(value) || run.stderr.includes(value);
  const changed = before !== after;
  if (run.status !== 0 && run.stderr.includes(want) && !leaked && !changed) {
    return {
      ok: true,
      message: `${TAG} OK -- ${version} on v3: exit ${run.status}, vault bytes unchanged (sha256 ${before}), stderr: ${run.stderr.trim()}`,
    };
  }
  return {
    ok: false,
    message: `${version} on v3: expected a non-zero exit with stderr containing ${JSON.stringify(want)}, no decrypted value, and an unchanged vault file; got ${describe(run)}${changed ? `; vault changed: sha256 ${before} -> ${after}` : ""}`,
  };
}

function main() {
  const keep = process.argv.includes("--keep");
  const root = mkdtempSync(join(tmpdir(), "yaw-vault-v3-compat-"));
  let failures = 0;
  const fail = (msg) => {
    failures++;
    console.log(`${TAG} FAIL -- ${msg}`);
  };
  try {
    for (const t of TARGETS) {
      let cli;
      try {
        cli = installVersion(root, t.version);
      } catch (err) {
        fail(`${t.version}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const ctl = sandbox(root, `${t.version}-control`);
      const set = runCli(cli, ctl.home, CONTROL.passphrase, ["secrets", "set", "github", "--value", CONTROL.value]);
      const got = runCli(cli, ctl.home, CONTROL.passphrase, ["secrets", "get", "github"]);
      if (set.status === 0 && got.status === 0 && got.stdout.trim() === CONTROL.value) {
        console.log(`${TAG} OK -- ${t.version} control: its own vault round-trips (set, then get)`);
      } else {
        fail(`${t.version} control: set ${describe(set)}; get ${describe(got)}`);
        continue; // the v3 verdict means nothing if the harness cannot open a readable vault
      }

      const v3 = sandbox(root, `${t.version}-v3`, V3.fixture);
      const hashBefore = sha256Hex(readFileSync(v3.vault));
      const r = runCli(cli, v3.home, V3.passphrase, ["secrets", "get", "github"]);
      // The whole verdict lives in evaluateV3Run (above): same conditions,
      // same lines, just not welded to main's `fail`/`console.log`.
      const verdict = evaluateV3Run({
        version: t.version,
        expected: t.expected,
        vault: v3.vault,
        run: r,
        before: hashBefore,
        read: () => readFileSync(v3.vault),
      });
      if (verdict.ok) console.log(verdict.message);
      else fail(verdict.message);
    }
  } finally {
    if (keep) console.log(`${TAG} kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
  if (failures === 0) console.log(`${TAG} OK -- every check passed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

// Run only when invoked as a script, so the tests can import TARGETS and
// evaluateV3Run without the network probe starting (or an exit code landing on
// vitest's process).
// isMainModule realpaths both sides: through a junctioned or symlinked
// checkout a raw compare skipped this block and the script printed nothing and
// exited 0 -- a silence that reads as a pass.
if (isMainModule(process.argv[1], import.meta.url)) main();
