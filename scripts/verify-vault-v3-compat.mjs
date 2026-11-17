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
 *              passphrase for this vault (decryption failed)". Misleading,
 *              but it reads nothing and writes nothing.
 *
 * This script proves both against the checked-in fixture
 * src/tests/fixtures/vault-v3.json (passphrase in src/tests/fixtures/README.md)
 * using the newest pre-v3 release (1.1.13) and the last release without the
 * gate (0.73.0). Each version is `npm pack`ed into its own empty directory,
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
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TAG = "[verify:vault-v3-compat]";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(REPO, "src", "tests", "fixtures");

const WRONG_PASSPHRASE = "wrong passphrase for this vault (decryption failed)";

/** The versions to probe and the message each must give for the v3 fixture
 *  (a function of the vault path, since the gated message names it). */
const TARGETS = [
  {
    version: "1.1.13",
    expected: (path) =>
      `vault at ${path} was written by a newer yaw-mcp (schema version 3 > 2); upgrade yaw-mcp to read it`,
  },
  {
    version: "0.73.0",
    expected: () => WRONG_PASSPHRASE,
  },
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
      const r = runCli(cli, v3.home, V3.passphrase, ["secrets", "get", "github"]);
      const want = t.expected(v3.vault);
      const leaked = r.stdout.includes(V3.value) || r.stderr.includes(V3.value);
      if (r.status !== 0 && r.stderr.includes(want) && !leaked) {
        console.log(`${TAG} OK -- ${t.version} on v3: exit ${r.status}, stderr: ${r.stderr.trim()}`);
      } else {
        fail(
          `${t.version} on v3: expected a non-zero exit with stderr containing ${JSON.stringify(want)} and no decrypted value; got ${describe(r)}`,
        );
      }
    }
  } finally {
    if (keep) console.log(`${TAG} kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
  if (failures === 0) console.log(`${TAG} OK -- every check passed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
