#!/bin/bash
# =============================================================================
# Release Script -- Bump, tag, publish to npm + MCP registry.
#
# Single-machine flow: move the oam floor to the latest oam release when it
# is behind, lint + typecheck + tests, bump package.json +
# server.json in lockstep, commit + tag + push, publish to npm via
# ~/.npmrc, publish server.json to the MCP registry via mcp-publisher.
# No GitHub release creation, no per-platform build orchestration, no
# SEA binaries. Install story is `npm install -g @yawlabs/mcp` (or
# `npx -y @yawlabs/mcp`) -- see docs/v0.70.3-binary-track-decision.md
# for the rationale on dropping the SEA binary track.
# =============================================================================
# Replaces the earlier .github/workflows/release.yml-driven flow + the
# per-platform SEA build orchestration that briefly lived in
# scripts/build-platforms-all.sh (removed in v0.70.3). The script is
# the single source of truth: it runs the pre-flight gates (lint,
# typecheck, tests, build), bumps package.json + server.json in
# lockstep, commits and tags, publishes to npm via the ~/.npmrc
# automation token, publishes server.json to the MCP registry via
# mcp-publisher, and exits.
#
# Usage:
#   ./release.sh <version>           -- full release (the only mode)
#   ./release.sh -y <version>        -- skip the y/N confirm prompt
#
# Environment:
#   SKIP_CONFIRM=1                   skip the y/N confirm prompt
#   NO_COLOR=1                       disable ANSI colors
#   SKIP_LINT=1                      DISABLES THE LINT GATE -- an explicit last
#                                    resort, never a routine skip. There is no
#                                    CI (no .github/workflows; GitHub Actions is
#                                    disabled on the repo), so nothing
#                                    downstream re-checks formatting: a release
#                                    run with this set is published UNLINTED.
#                                    Origin: biome 2.5.4's native win32-arm64
#                                    binary dies (exit 139) on CHECK-shaped
#                                    runs -- the binary itself, not npm's
#                                    run-script; it answers `--version` with
#                                    exit 0, so "it starts" is not evidence the
#                                    gate works. That is a PER-VERSION defect,
#                                    not a standing arm64 one -- 2.4.16 and
#                                    2.5.13 both run correctly on this host
#                                    (measured 2026-09-11). v0.72.0
#                                    pinned 2.4.16 (66c48f3). `npm run lint` now
#                                    goes through scripts/lint.mjs, which runs
#                                    the x64 build of the INSTALLED version
#                                    under emulation on Windows ARM64, so this
#                                    should be unnecessary. Use it only
#                                    if scripts/lint.mjs cannot produce a
#                                    verdict at all, and treat that as a bug. A
#                                    failing lint is a real finding, or a broken
#                                    install (check node_modules is populated),
#                                    until proven otherwise. A lint CRASH fails
#                                    the release; it is never tolerated.
#                                    Typecheck + tests still gate the release.
#   ALLOW_STALE_REMOTE=1             Downgrade a failed pre-flight `git fetch`
#                                    from a hard stop to a warning. The
#                                    origin/main sync guard then runs against a
#                                    STALE remote-tracking ref. Deliberate
#                                    degraded runs only.
#   ALLOW_UNVERIFIED_VERSION=1       Proceed when `npm view` cannot read the
#                                    registry, skipping the backward-version
#                                    ordering guard for that run. Implied on a
#                                    resume, where the version was already
#                                    chosen by the earlier run.
#   ALLOW_STALE_OAM_FLOOR=1          Proceed when the latest oam release
#                                    cannot be read from GitHub, releasing on
#                                    the current MIN_OAM_VERSION unchecked.
#                                    Implied once v<version> is tagged or on
#                                    npm: the floor is not moved then, so an
#                                    unreadable GitHub only warns.
#   GITHUB_TOKEN=<pat>               GitHub token for the step-5 MCP-registry
#                                    login (needs publish rights on
#                                    io.github.YawLabs/*). Step 5 reads it only
#                                    when the persisted registry JWT is
#                                    missing/expired. The pre-flight's read of
#                                    the latest oam release also sends it (on
#                                    curl's stdin, not its command line), and
#                                    retries that read once without it if the
#                                    authenticated read fails.
#   MCP_REGISTRY_TOKEN=<pat>         second-choice spelling of the same token;
#                                    read only when GITHUB_TOKEN is unset. If
#                                    neither is set, `gh auth token` is tried.
#
# Required tools on PATH: node, npm, git, curl, tar, sha256sum (or shasum).
# Optional but load-bearing in practice: gh -- the step-5 registry-auth
# fallback, used whenever GITHUB_TOKEN and MCP_REGISTRY_TOKEN are unset, which
# is every release on this workstation, since the persisted registry JWT's
# 300-second TTL never survives steps 1-4. The same fallback supplies the token
# for the pre-flight's read of the latest oam release.
# The first run also needs `mcp-publisher` (downloaded to a temp dir on
# demand, sha256-verified against the registry's per-release
# `registry_<ver>_checksums.txt`) and a one-time `mcp-publisher login
# github` (interactive device flow) which persists a JWT at
# ~/.config/mcp-publisher/token.json for subsequent runs.
#
# If interrupted, re-run with the same version -- each step is idempotent.
#
# Branch protection: the script's `git push origin main --follow-tags`
# (step 3) bypasses the YawLabs/mcp "Protect default branch" ruleset
# (PR review, signed commits, status check "check") and the "Protect
# release tags" ruleset (block ref creation) under the ruleset's
# OrganizationAdmin bypass policy -- the SSH key registered to a YawLabs
# org admin (the `gh_woods` key on this workstation) is a configured
# bypass actor. If a different operator runs the script, the push will
# fail with rule-violation output and the operator must open a PR
# instead. Verified: rulesets #14941666 (default branch) and #14943288
# (refs/tags/v*), bypass_actors: [{actor_type: OrganizationAdmin,
# bypass_mode: always}].
# =============================================================================

# -E (errtrace) so the ERR trap below is inherited by functions and command
# substitutions -- without it a failure inside run_npm_check() or a $(...)
# never records its line number.
set -Eeuo pipefail
# Single EXIT trap: if we're exiting because of an error, print the failure
# banner; either way, clean up the mcp-publisher temp dir. (Two `trap` calls
# would override each other; bash only runs the most recent one.)
#
# FAIL_LINE is captured by a separate ERR trap rather than read from $LINENO
# inside cleanup(): $LINENO expands to the line where it is EVALUATED, so the
# banner used to report its own line ("line 60") for every failure in the
# script, which is worse than useless when a 500-line release dies mid-run.
# `fail()` sets it explicitly because an outright `exit 1` does not fire ERR.
WORKDIR=""
FAIL_LINE=""
trap 'FAIL_LINE=$LINENO' ERR
cleanup() {
  rc=$?
  if [ $rc -ne 0 ]; then
    echo -e "\n  ✗ Release failed at line ${FAIL_LINE:-unknown} (exit code $rc)\n" >&2
  fi
  if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
if [ "${NO_COLOR:-0}" = "1" ] || [ ! -t 1 ]; then
  # CYAN belongs in this list: step() and every banner below use it, so
  # omitting it emitted raw ANSI into pipes and CI logs even under NO_COLOR=1.
  RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
fi

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
# BASH_LINENO[0] is the line of the CALL to fail() -- an explicit `exit 1`
# never fires the ERR trap, so record the caller's line here instead.
fail() { FAIL_LINE="${BASH_LINENO[0]}"; echo -e "${RED}  ✗ $1${NC}"; exit 1; }

# MCP publisher version -- pinned like any other tool we shell out to. The
# sha256 is fetched at release time from the registry's per-release
# `registry_<ver>_checksums.txt` (NOT a hard-coded constant), so the script
# works for any host platform and any future version bump (just update
# MCP_PUBLISHER_VERSION; the checksums file is the source of truth for both
# tarball selection and verification).
#
# `login github-oidc` is GitHub-Actions-only (requires `id-token: write`), so
# the script's workstation path uses the regular `login github` OAuth device
# flow. One-time interactive setup: `mcp-publisher login github` -- the JWT
# persists at ~/.config/mcp-publisher/token.json for every subsequent run.
MCP_PUBLISHER_VERSION="v1.7.9"

# MINGW64 on Windows ARM64 intermittently segfaults in npm's exit cleanup AFTER
# a tool has finished and printed its report. Attributed to npm's WRAPPER rather
# than to any one tool because it fires after the tool's output is complete, and
# on subcommands that never invoke a linter (`npm version` in step 3, `npm
# publish` in step 4). That is an inference from the shape, not a measured root
# cause -- it has never been isolated the way the biome crash below was, so do
# not harden it into more than it is.
# DISTINCT from the biome 2.5.4 win32-arm64 binary crash that v0.72.0 pinned
# around (the @biomejs/biome pin in package.json): that one is a PER-VERSION
# fault in the tool's OWN executable and fires BEFORE any output -- 2.4.16 and
# 2.5.13 both run clean on this host. See the header and run_npm_check below for
# the measurements. Do not merge the two.
# Being intermittent, a clean run does not retire it. What the tool actually DID
# is authoritative, never npm's exit code -- and each tolerance site proves that
# its own way: run_npm_check on the tool's success marker in the captured output
# (or a direct re-run that bypasses the wrapper), step 2's build on a
# dist/index.js mtime newer than the step, step 3's bump on package.json reading
# the target version, step 4's publish on the registry answering with it. A
# 139/134 is tolerated only against one of those four, never on the exit code
# alone -- and never for lint at all, whose crash run_npm_check hard-fails before
# this tolerance can see it. Other platforms treat any non-zero as a hard failure.
IS_MINGW_ARM64=false
case "$(uname -s 2>/dev/null)" in
  MINGW*ARM64* | MSYS*ARM64* | CYGWIN*ARM64*) IS_MINGW_ARM64=true ;;
esac

# Run an npm-run-script tool that may segfault on this box. $1 label, $2 script,
# $3 ERE for real failures, $4 (opt) ERE proving the tool ran, $5 (opt) direct
# verify command (no npm-run wrapper) for tools that print no completion marker.
run_npm_check() {
  local label="$1" script="$2" fail_re="$3" done_re="${4:-}" verify_cmd="${5:-}" out rc=0
  # SKIP_LINT=1 escape hatch -- an explicit LAST RESORT, not a routine skip. It
  # takes lint out of the release entirely and nothing else re-checks
  # formatting: this repo has no CI (no .github/workflows, and GitHub Actions is
  # disabled on YawLabs/mcp), so a SKIP_LINT=1 release is published unlinted.
  #
  # HISTORY: the crash it was added for is in biome's native win32-arm64
  # EXECUTABLE, not in npm's run-script wrapper -- invoking the node_modules
  # binary directly, with no npm in the picture, died the same way. It is
  # VERSION-SPECIFIC, not a standing arm64 defect: 2.5.4 dies (139) on every
  # CHECK-shaped run on this host while answering `--version` with exit 0
  # (bc2076e, 2026-07-21 17:01), whereas 2.4.16 and 2.5.13 both run correctly
  # (measured 2026-09-11, direct and via npm).
  # 66c48f3 pinned biome to 2.4.16 exactly (an exact version, not a caret
  # range) about 78 minutes later; CHANGELOG 0.72.0
  # records it. And `npm run lint` now goes through scripts/lint.mjs, which runs
  # the x64 build of the INSTALLED version under emulation on Windows ARM64, so
  # an arm64 regression in a future biome cannot take the gate down. Types and
  # tests still gate the release when it is set.
  if [ "${SKIP_LINT:-}" = "1" ] && [[ "$script" == lint* ]]; then
    warn "SKIP_LINT=1 -- skipping '$label' (lint gate disabled by request; formatting goes unverified)"
    return 0
  fi
  # `|| rc=$?` is load-bearing: under `set -e` a bare `out=$(npm run ...)` whose
  # command substitution exits non-zero aborts the function THERE, before the
  # analysis below runs.
  out=$(npm run "$script" 2>&1) || rc=$?
  printf '%s\n' "$out"
  if echo "$out" | grep -qE "$fail_re"; then
    fail "$label failed"
  fi
  [ "$rc" -eq 0 ] && return 0
  # A lint CRASH is never tolerated, on any host. The ARM64 tolerance below
  # accepts a 139/134 when the tool's success marker was printed; for lint that
  # would pass a release on a verdict no process ever returned, and a crashing
  # biome is exactly the arm64-binary failure this hatch history is about. So
  # the done_re passed at the Lint call site no longer tolerates anything.
  # scripts/lint.mjs turns a biome crash into exit 1 with its own "[lint] biome
  # crashed with / killed by" line, so that shape is matched here as well.
  if [[ "$script" == lint* ]] && { [ "$rc" -eq 139 ] || [ "$rc" -eq 134 ] || echo "$out" | grep -qE '^\[lint\] biome (killed by|crashed with)'; }; then
    fail "$label crashed (exit $rc) -- no lint verdict was produced, so the release stops here. Fix the crash (scripts/lint.mjs honours YAWLABS_BIOME_BIN / YAWLABS_BIOME_NATIVE), or as an explicit last resort re-run with SKIP_LINT=1 ./release.sh ${VERSION} -- that publishes unlinted, and there is no CI to catch it."
  fi
  if [ "$IS_MINGW_ARM64" = true ] && { [ "$rc" -eq 139 ] || [ "$rc" -eq 134 ]; }; then
    if [ -n "$done_re" ] && echo "$out" | grep -qE "$done_re"; then
      warn "$label: npm exited $rc (ARM64 npm-run cleanup segfault) but the tool completed with no findings -- tolerating"
      return 0
    fi
    if [ -n "$verify_cmd" ] && $verify_cmd >/dev/null 2>&1; then
      warn "$label: npm exited $rc (ARM64 npm-run cleanup segfault); a direct re-run is clean -- tolerating"
      return 0
    fi
  fi
  # Refine the message when the failure is a toolchain that cannot resolve its
  # own executable: an empty node_modules (npm's cmd.exe wrapper prints
  # "'biome' is not recognized..."), or a missing OPTIONAL platform package
  # that leaves node_modules/.bin/<tool> in place while the binary it execs is
  # absent (@biomejs/cli-win32-arm64 backs lint, @rollup/rollup-win32-arm64-msvc
  # backs test). No fail_re or done_re matches those shapes, so they surfaced
  # as a bare "Lint failed (exit 1)" -- which is what sent the v0.80.0 release
  # down the segfault rabbit hole. Placed AFTER the ARM64 tolerance block so it
  # can only make an already-failing run legible, never turn a tolerated
  # segfault into a hard failure. Pattern notes: "Cannot find (module|package)"
  # covers CJS and ESM and both scoped and unscoped names; ": not found$" is
  # what /bin/sh prints on the linux release drivers (dash: "sh: 1: biome: not
  # found", busybox ash: "sh: biome: not found") since npm runs scripts through
  # sh, not bash. Both "not found" alternatives stay anchored -- to a leading
  # colon and to end-of-line -- because src/ carries 54 bare "not found"
  # strings that captured test output can echo verbatim; the same trap the test
  # fail_re comment documents. A false match here can only reword an
  # already-failing gate, never fail a passing one. The step-2 build gate is a
  # separate code path and is NOT covered here.
  if echo "$out" | grep -qE ': not found$|: command not found|is not recognized as an internal|Cannot find (module|package)|installed .* for another platform'; then
    fail "$label failed (exit $rc) -- the toolchain could not resolve its own executable (see the error above). node_modules is missing or only partially installed. Run \`npm ci\`, then re-run ./release.sh ${VERSION}."
  fi
  fail "$label failed (exit $rc)"
}

# Arg parsing -- manual loop. Flags: -y/--yes. Version is positional and
# required. (The --build-only + --upload-asset subcommands were removed in
# v0.70.3 when the SEA binary track was dropped -- npm install is the install
# story now; see docs/v0.70.3-binary-track-decision.md.)
# Env may pre-set SKIP_CONFIRM=1 to skip the y/N prompt (e.g. CI, scripted
# release). Default off. The -y/--yes arg below overrides the env to true.
# Normalized here because the gate below compares against the literal
# "true" -- without this, the documented SKIP_CONFIRM=1 spelling still
# prompted (commit 3cbe778 changed only the default line, not the gate).
case "${SKIP_CONFIRM:-}" in
  1|true|yes|TRUE|YES) SKIP_CONFIRM=true ;;
  *) SKIP_CONFIRM=false ;;
esac
REMAINING=()
i=0
while [ $i -lt $# ]; do
  arg="${@:$((i+1)):1}"
  case "$arg" in
    -y|--yes) SKIP_CONFIRM=true ;;
    --*) fail "Unrecognized flag: '$arg' (--build-only and --upload-asset were removed in v0.70.3; npm install is the install story now)" ;;
    *) REMAINING+=("$arg") ;;
  esac
  i=$((i+1))
done

VERSION=""
if [ "${#REMAINING[@]}" -gt 0 ]; then
  for arg in "${REMAINING[@]}"; do
    case "$arg" in
      [0-9]*.[0-9]*.[0-9]*)
        [ -n "$VERSION" ] && fail "Multiple versions passed: '$VERSION' and '$arg'"
        VERSION="$arg"
        ;;
      *) fail "Unrecognized argument: '$arg' (expected version X.Y.Z)" ;;
    esac
  done
fi

[ -n "$VERSION" ] || fail "Usage: ./release.sh [-y] <version>"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null || fail "node not installed"
command -v npm  >/dev/null || fail "npm not installed"
command -v git  >/dev/null || fail "git not installed"
# Step-5 tools (MCP registry publish), preflighted HERE: their first use is
# AFTER the tag push and the irreversible npm publish, so discovering one
# missing there strands the release at the registry step. sha256 accepts
# either binary -- macOS ships shasum, not sha256sum.
command -v curl >/dev/null || fail "curl not installed (needed for the oam floor check and for step 5, the MCP registry publish)"
command -v tar  >/dev/null || fail "tar not installed (needed for step 5, the MCP registry publish)"
{ command -v sha256sum >/dev/null || command -v shasum >/dev/null; } \
  || fail "sha256sum/shasum not installed (needed for step 5, the MCP registry publish)"

# --- Guard: the repo-local toolchain must actually be installed. The
# `command -v` checks above cover the PATH tools; these four live in
# node_modules/.bin and are exactly what package.json's scripts exec:
#   biome  -> "lint"      (step 1)   vitest -> "test"  (step 1)
#   tsc    -> "typecheck" (step 1)   tsup   -> "build" (step 2, and again via
#                                              prepublishOnly inside step 4)
# A present-but-EMPTY node_modules (npm ci never ran, or was interrupted)
# passes every other pre-flight check, survives the confirm prompt, and then
# dies in step 1 with npm's opaque "'biome' is not recognized as an internal
# or external command" plus a bare "Lint failed (exit 1)" -- after a git fetch
# and two npm view round-trips have already been paid for. Observed on the
# v0.80.0 release. These are O(1) stat calls, so they run ahead of all of it.
#
# The EXTENSIONLESS shim is the portable thing to test: npm's cmd-shim writes
# <bin>, <bin>.cmd and <bin>.ps1 as a set on Windows but only <bin> on POSIX,
# so testing <bin>.cmd would make this a silent no-op on the linux/darwin
# hosts step 5 supports. -e rather than -x: the question is "did the install
# happen", not "are the exec bits right" -- exec-bit reporting through MSYS on
# a Windows filesystem is not something to gate a release on.
MISSING_BINS=""
for REQUIRED_BIN in biome tsc vitest tsup; do
  # SKIP_LINT=1 takes biome out of the run entirely (see run_npm_check), so
  # do not block a release on a tool this run will never invoke.
  if [ "$REQUIRED_BIN" = "biome" ] && [ "${SKIP_LINT:-}" = "1" ]; then
    continue
  fi
  [ -e "node_modules/.bin/${REQUIRED_BIN}" ] || MISSING_BINS="${MISSING_BINS} ${REQUIRED_BIN}"
done
if [ -n "$MISSING_BINS" ]; then
  INSTALL_CMD="npm install"
  if [ -f package-lock.json ]; then INSTALL_CMD="npm ci"; fi
  fail "Dependencies are not installed -- missing node_modules/.bin/{${MISSING_BINS# }}. Step 1 would die with an opaque 'not recognized as an internal or external command'. Run \`${INSTALL_CMD}\`, then re-run ./release.sh ${VERSION}."
fi

# --- Guard: server.json must satisfy the MCP registry's own field limits
# BEFORE anything is built, committed, or published. The registry caps
# ServerDetail.description at 100 characters, caps name at 3-200, and requires
# name to match ^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$; a violation comes back as a
# 422 from `mcp-publisher publish` in STEP 5, which runs after the irreversible
# npm publish in step 4.
#
# That does NOT burn the version: a rejected publish registers nothing, so
# fixing server.json and re-running completes it -- which is exactly how
# v0.80.0 recovered. What it does cost is a version sitting live on npm with no
# registry entry until someone notices. Same class as the mcpName/version drift
# guards before the push in step 3.
#
# Checked HERE, ahead of every network probe and the whole gate block, because
# it is pure local computation over fields the script never rewrites. (It does
# rewrite server.json's version, via write_server_version on both the bump and
# the resume self-heal -- but never its description or name.)
#
# Observed on v0.80.0, which died at step 5 with
#   {"message":"expected length <= 100","location":"body.description"}
# against a 121-character description, after npm had already accepted 0.80.0.
# The schema is the source of truth for these numbers:
# https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
# Lengths are counted in CODE POINTS, which is what JSON Schema maxLength
# counts; String.length would double-count astral characters and reject a
# description the registry accepts.
REGISTRY_FIELD_ERRS=$(node -e '
const j = require("./server.json");
const errs = [];
const d = j.description;
const dLen = typeof d === "string" ? [...d].length : -1;
if (dLen < 1) {
  errs.push("description is missing or empty (registry requires 1-100 characters)");
} else if (dLen > 100) {
  errs.push("description is " + dLen + " characters, registry cap is 100 -- trim " + (dLen - 100));
}
const n = j.name;
const nLen = typeof n === "string" ? [...n].length : -1;
if (nLen < 3 || nLen > 200) {
  errs.push("name must be 3-200 characters, got " + (nLen < 0 ? typeof n : nLen));
} else if (!/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(n)) {
  errs.push("name " + JSON.stringify(n) + " does not match the registry pattern ^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$");
}
console.log(errs.join("; "));
') || fail "Could not read server.json to check the MCP-registry field limits -- is it valid JSON?"
if [ -n "$REGISTRY_FIELD_ERRS" ]; then
  fail "server.json violates the MCP registry schema: ${REGISTRY_FIELD_ERRS}. Fix server.json before releasing (package.json's description is meant to match it, so change both). Step 5 would otherwise 422 AFTER step 4's npm publish has gone out, leaving the version live on npm with no registry entry until a re-run."
fi
info "server.json passes the MCP-registry field limits"

# Re-read state from disk at every step boundary (per project rule: release
# scripts must not cache at script-start). Functions call these helpers to
# always reflect the current on-disk state.
current_pkg_version() { node -p "require('./package.json').version"; }
current_server_version() { node -p "require('./server.json').version"; }
# The registry-side identity pair: package.json's `mcpName` is what the MCP
# registry reads out of the published npm tarball to prove the publisher owns
# the server name in server.json. Drift between them is only discovered in
# step 5 -- after the irreversible npm publish.
current_pkg_mcp_name() { node -p "require('./package.json').mcpName || ''"; }
current_server_name() { node -p "require('./server.json').name || ''"; }
current_head_sha() { git rev-parse HEAD; }
current_branch() { git rev-parse --abbrev-ref HEAD; }

# The credential step 5's `mcp-publisher login github` actually runs on. The
# persisted registry JWT at ~/.config/mcp-publisher/token.json has a 300-second
# TTL (measured 2026-09-06: iat 14:35:51Z, exp 14:40:51Z), and no release gets
# through steps 1-4 inside five minutes, so the "reuse the persisted token"
# branch in step 5 is dead in practice and THIS is the load-bearing credential
# on every run. Kept as a helper so the pre-flight probe, the read of the latest
# oam release (latest_oam_release) and the step-5 call site resolve it
# identically and cannot drift.
#
# stdout must carry ONLY the token: every caller captures it in a command
# substitution, so any info()/warn() belongs at the call site, never in here.
mcp_registry_gh_token() {
  local t="${GITHUB_TOKEN:-${MCP_REGISTRY_TOKEN:-}}"
  if [ -z "$t" ] && command -v gh >/dev/null 2>&1; then
    t=$(gh auth token 2>/dev/null || echo "")
  fi
  printf %s "$t"
}

# Is $1 listed on the MCP registry for this server? Returns 0 when it is, 1
# otherwise. ONE spelling, shared by step 5's idempotence probe and the final
# verification, so the read that decides whether to publish and the read that
# reports what was published cannot drift.
#
# CACHE-BUSTED, and that is load-bearing rather than defensive. The registry
# answers with an X-Registry-Cache header (measured: MISS, then STALE on the
# same URL seconds later), so an un-busted read can serve a body from BEFORE
# this run's publish, and both call sites are harmed by that in different
# ways. Step 5: a resume reads a pre-publish body, believes the version is
# absent, and falls through to `mcp-publisher publish`, which the registry
# rejects as a duplicate (name, version) -- aborting the release at its final
# step under `set -Eeuo pipefail`, which is precisely the failure the probe
# exists to prevent. Final verification: the same stale body reports a channel
# nobody can actually see yet. A unique `_` parameter is what moves the cache
# key; the no-cache headers ride along because not every edge honours them on
# their own, and the API ignores an unknown query parameter (verified: 200
# with the correct body). $RANDOM rather than a nanosecond clock because BSD
# `date` has no %N and would emit a literal "N" on a macOS release host.
#
# Probe-only by design: any failure -- offline, API change, unparseable body,
# a busted read the edge refuses -- returns 1, which is exactly the behavior
# both call sites had before the probe existed.
registry_has_version() {
  local want="$1"
  local body
  body=$(curl -fsSL --max-time 20 -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
    "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.YawLabs/mcp&version=${want}&_=$(date +%s)${RANDOM}" 2>/dev/null || echo "")
  [ -n "$body" ] || return 1
  printf %s "$body" | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s);
        const hit = (j.servers || []).some((e) => e && e.server && e.server.version === process.argv[1]);
        process.exit(hit ? 0 : 1);
      } catch { process.exit(1); }
    });
  ' "$want"
}

# Rewrite server.json's version + packages[0].version to $1. Used by both the
# fresh-bump path and the resume self-heal, so the two can never drift.
# mcp-publisher's `publish` validates that server.json's version matches what
# npm reports for the referenced package -- the registry 400s on drift.
write_server_version() {
  node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('server.json','utf-8')); j.version=process.argv[1]; if(j.packages&&j.packages[0]) j.packages[0].version=process.argv[1]; fs.writeFileSync('server.json', JSON.stringify(j, null, 2) + '\n');" "$1"
}

# >>> oam floor helpers
# The oam floor. POLICY (the MIN_OAM_VERSION doc in src/oam-spawn.ts): it
# tracks the LATEST oam release and moves with every one, with no judgement
# about whether a given release "needs" the move. Moving it used to be a manual
# step, so nothing stopped a release from shipping on a stale floor. The
# pre-flight below reads the latest oam release, and unless v<version> is
# already tagged or on npm, the block ahead of step 1 moves the floor to it.
#
# Three things move together, or the ratchet test and the changelog drift from
# the constant: the constant, the one `const FLOOR = "X.Y.Z";` literal in
# src/tests/oam-spawn.test.ts that pins it from below, and a block in the
# changelog section this release ships under.
OAM_FLOOR_SRC="src/oam-spawn.ts"
OAM_FLOOR_TEST="src/tests/oam-spawn.test.ts"
OAM_RELEASES_API="https://api.github.com/repos/YawLabs/oam/releases/latest"

# stdout: the X.Y.Z of the ONE `export const MIN_OAM_VERSION = "X.Y.Z";` line.
# Returns non-zero, saying why on stderr, when there is not exactly one.
current_oam_floor() {
  node -e '
    const src = require("fs").readFileSync(process.argv[1], "utf8");
    const hits = [...src.matchAll(/^export const MIN_OAM_VERSION = "(\d+\.\d+\.\d+)";\r?$/gm)];
    if (hits.length !== 1) {
      console.error(process.argv[1] + ": expected exactly one MIN_OAM_VERSION line, found " + hits.length);
      process.exit(1);
    }
    process.stdout.write(hits[0][1]);
  ' "$OAM_FLOOR_SRC"
}

# stdout: "X.Y.Z YYYY-MM-DD" -- the latest oam release and the day it was
# published. GitHub's /releases/latest already leaves out drafts and
# prereleases; both are rejected here too, so a change on GitHub's side cannot
# hand the floor a prerelease. Any failure prints nothing on stdout and returns
# 1, and the pre-flight decides what that means. WHY it failed goes to stderr,
# which the pre-flight's $(...) does not capture, so it reaches the terminal:
# curl's own -S line for a request that failed (offline, a 403 or 429 rate
# limit), or one line from the parser for a body it rejects. Discarding that
# line left the pre-flight naming three possible causes with no way to tell
# which one it was.
#
# Authenticated when mcp_registry_gh_token resolves a token: GitHub allows 60
# unauthenticated reads an hour per IP, and a token lifts that to 5000
# (measured 2026-09-13), so a rate limit no longer means waiting out the hour.
# The token reaches curl as a config file on stdin (-K -), never on its command
# line, where the process list can show it. A token GitHub refuses (a bad Bearer
# token gets 401 even on this public repo, measured) must not turn a read that
# works unauthenticated into a hard stop, so a failed authenticated read is
# retried once without the token. Returns 1 when the parser rejects the body,
# whichever read fetched it (a rejected body is not retried: the read itself
# worked), when the read fails and there is no token, or when the authenticated
# read and the retry without the token both fail.
latest_oam_release() {
  local body="" t
  t=$(mcp_registry_gh_token)
  if [ -n "$t" ] && body=$(printf 'header = "Authorization: Bearer %s"\n' "$t" \
    | curl -fsSL --max-time 20 -K - -H 'Accept: application/vnd.github+json' "$OAM_RELEASES_API"); then
    :
  else
    if [ -n "$t" ]; then
      echo "  The authenticated read of ${OAM_RELEASES_API} failed (see above) -- retrying once without the token" >&2
    fi
    body=$(curl -fsSL --max-time 20 -H 'Accept: application/vnd.github+json' "$OAM_RELEASES_API") || return 1
  fi
  printf %s "$body" | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      const reject = (why) => {
        console.error("latest_oam_release: " + why);
        process.exit(1);
      };
      let j = null;
      try {
        j = JSON.parse(s);
      } catch {
        reject("the response from GitHub is not JSON");
      }
      if (j === null || typeof j !== "object") reject("the response from GitHub is not a JSON object");
      const tag = /^v?(\d+\.\d+\.\d+)$/.exec(typeof j.tag_name === "string" ? j.tag_name : "");
      if (!tag) reject("its tag_name " + JSON.stringify(j.tag_name) + " is not X.Y.Z or vX.Y.Z");
      if (j.draft) reject("v" + tag[1] + " is marked as a draft");
      if (j.prerelease) reject("v" + tag[1] + " is marked as a prerelease");
      const day = /^\d{4}-\d{2}-\d{2}/.exec(typeof j.published_at === "string" ? j.published_at : "");
      if (!day) reject("v" + tag[1] + " has no published_at date");
      process.stdout.write(tag[1] + " " + day[0]);
    });
  '
}

# stdout: -1, 0 or 1 as X.Y.Z $1 is below, equal to or above X.Y.Z $2,
# comparing each part as a number (0.10.0 is above 0.9.9).
semver_cmp() {
  node -e '
    const a = process.argv[1].split(".").map(Number);
    const b = process.argv[2].split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) {
        process.stdout.write(a[i] < b[i] ? "-1" : "1");
        process.exit(0);
      }
    }
    process.stdout.write("0");
  ' "$1" "$2"
}

# Returns 0 when HEAD is ahead of $1 (a commit HEAD descends from) ONLY by
# commits the oam floor move below makes: the subject "fix(oam): move the floor
# to X.Y.Z", touching exactly CHANGELOG.md and the two floor files. One or more
# of them, so an oam release landing between two failed runs still qualifies.
# Any commit ahead with another subject or another set of paths returns 1 (a
# merge lists no paths here, so it cannot match), as does nothing ahead at all.
# The origin/main sync guard uses it to let a re-run carry on over the floor
# commit an earlier failed run left on local main. That guard's diverged stop
# and the pre-flight's floor-ahead stop use it to decide when a bare
# git reset --keep origin/main would drop nothing but floor commits.
oam_floor_commits_only() {
  local base="$1" c subj paths n=0
  local subj_re='^fix\(oam\): move the floor to [0-9]+\.[0-9]+\.[0-9]+$'
  local want="CHANGELOG.md ${OAM_FLOOR_SRC} ${OAM_FLOOR_TEST} "
  for c in $(git rev-list "${base}..HEAD" 2>/dev/null); do
    n=$((n + 1))
    subj=$(git log -1 --format=%s "$c")
    [[ "$subj" =~ $subj_re ]] || return 1
    paths=$(git diff-tree --no-commit-id --name-only -r "$c" | LC_ALL=C sort | tr '\n' ' ')
    [ "$paths" = "$want" ] || return 1
  done
  [ "$n" -ge 1 ]
}

# Move the floor in all three places, or with --check, only prove all three can
# be moved. ONE script for both modes, so the pre-flight cannot pass a shape the
# write then trips over. --write validates every target before writing any of
# them, so a target that does not validate leaves all three files untouched.
# --check also prints, on stdout, the changelog block the write would put in
# place. The block is rendered by one function for that output and for both
# ways the write places it (appended, or replacing an earlier block), so the
# text the behaviour-change gate is shown and the text the move writes come
# from the same template. --write prints nothing on stdout.
#   $1 --check|--write  $2 source  $3 ratchet test  $4 changelog
#   $5 new floor  $6 old floor  $7 day the new release was published  $8 VERSION
oam_floor_rewrite() {
  node -e '
    const fs = require("fs");
    const [mode, srcPath, testPath, logPath, next, prev, day, version] = process.argv.slice(1);
    const problems = [];
    const read = (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch (e) {
        problems.push(p + ": " + e.message);
        return null;
      }
    };
    // Exactly one line matching `re` (flags gm, version in group 1), with that
    // version swapped for the new floor. Nothing else on the line changes.
    const moveOne = (p, text, re, what) => {
      if (text === null) return null;
      const hits = text.match(re) || [];
      if (hits.length !== 1) {
        problems.push(p + ": expected exactly one " + what + " line, found " + hits.length);
        return null;
      }
      return text.replace(re, (line, v) => line.replace("\"" + v + "\"", "\"" + next + "\""));
    };
    const src = moveOne(srcPath, read(srcPath), /^export const MIN_OAM_VERSION = "(\d+\.\d+\.\d+)";\r?$/gm, "MIN_OAM_VERSION");
    const test = moveOne(testPath, read(testPath), /^[ \t]*const FLOOR = "(\d+\.\d+\.\d+)";\r?$/gm, "const FLOOR");

    // The block goes at the END of the first ## section, which has to be the
    // section this release ships under: ## Unreleased, or ## <VERSION> when the
    // heading was already renamed. Any other first section is a changelog this
    // script does not understand, and guessing would file the move under a
    // release that already shipped.
    //
    // A floor block already in that section may be one a release SHIPPED:
    // this repo has tagged releases with the first section still headed
    // ## Unreleased (v1.0.0 and v1.0.1 both were). So git decides. A block
    // has shipped when its heading line is in the CHANGELOG.md of the most
    // recent v* tag reachable from HEAD. A shipped block is never rewritten.
    // When every floor block in the section has shipped, the new block is
    // added at the end of the section, naming the floor on disk as the one
    // before. ONE block that has not shipped -- the shape an earlier run of
    // this release leaves when it moves the floor, fails before its tag, and
    // oam releases again before the re-run -- is rewritten in place rather
    // than joined by a second one, and keeps the floor it names as the one
    // before. Two that have not shipped is not a shape this script leaves, so
    // it stops rather than guess which one is true. Matching on the heading
    // errs one way only: a new block whose heading an older release also used
    // reads as shipped, and is added to rather than rewritten. Git is asked
    // only when the section holds a floor block, and when it cannot answer,
    // the run stops. Blocks under any other section are never looked at.
    //
    // A ## line or a block heading inside a ``` or ~~~ code fence is not a
    // real one, so the scan skips fenced lines. A fence closes only on a line
    // of the same character at least as long as the one that opened it. A
    // fence that never closes stops the run wherever it opened: if it opened
    // in the first section, every heading after it would read as fenced, and
    // the block would land under the oldest release in the file.
    const BLOCK_HEAD = "**Changed -- the oam floor moves to ";
    const render = (was) => [
      BLOCK_HEAD + next + "**",
      "",
      "`MIN_OAM_VERSION` tracks the latest oam release as policy, and v" + next + " is now current (published " + day + "); the floor was " + was + ". A machine whose oam is older hosts its node/npx sidecars on node instead, and logs a warning naming both versions, `oam self-update` as the fix, and that yaw-mcp needs a restart afterwards. `release.sh` moved the floor and wrote this block; it did not re-run the oam hosting check that `src/oam-spawn.ts` describes.",
    ];
    // The heading lines a release already shipped, as { tag, lines } where
    // tag is null when no v* tag is reachable from HEAD. null, with a problem
    // pushed, when git cannot answer.
    const shippedLines = () => {
      const git = (args) => {
        const r = require("child_process").spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
        if (r.status === 0) return r.stdout;
        const why = r.error ? r.error.message : (r.stderr || "").trim() || "exit " + r.status;
        problems.push(logPath + ": cannot tell whether its oam floor block already shipped: git " + args.join(" ") + " failed: " + why);
        return null;
      };
      const tags = git(["tag", "--list", "v*", "--merged", "HEAD"]);
      if (tags === null) return null;
      if (tags.trim() === "") return { tag: null, lines: new Set() };
      const described = git(["describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD"]);
      if (described === null) return null;
      const tag = described.trim();
      const shipped = git(["show", tag + ":./" + logPath]);
      if (shipped === null) return null;
      return { tag, lines: new Set(shipped.split(/\r?\n/)) };
    };
    let block = null;
    let log = read(logPath);
    if (log !== null) {
      const eol = log.includes("\r\n") ? "\r\n" : "\n";
      const lines = log.split(/\r?\n/);
      const heads = [];
      const blocks = [];
      let fence = null;
      lines.forEach((l, i) => {
        const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
        if (fence !== null) {
          if (m && m[1][0] === fence[0] && m[1].length >= fence.length && l.trim() === m[1]) fence = null;
          return;
        }
        if (m) {
          fence = m[1];
          return;
        }
        if (l.startsWith("## ")) heads.push(i);
        if (l.startsWith(BLOCK_HEAD)) blocks.push(i);
      });
      const first = heads.length > 0 ? heads[0] : -1;
      const heading = first === -1 ? "" : lines[first];
      const ours = /^## [Uu]nreleased\b/.test(heading) || heading === "## " + version || heading.startsWith("## " + version + " ");
      if (fence !== null) {
        problems.push(logPath + ": a code fence opened with " + fence + " never closes, so no heading after it can be trusted as a section boundary; close the fence");
        log = null;
      } else if (!ours) {
        problems.push(logPath + ": its first ## section is " + JSON.stringify(heading || "(none)") + ", not ## Unreleased or ## " + version + ", so there is no section to record the floor move in");
        log = null;
      } else {
        let end = heads.find((i) => i > first);
        if (end === undefined) end = lines.length;
        const inSection = blocks.filter((i) => i > first && i < end);
        const shipped = inSection.length > 0 ? shippedLines() : { tag: null, lines: new Set() };
        const mine = shipped === null ? [] : inSection.filter((i) => !shipped.lines.has(lines[i]));
        if (shipped === null) {
          log = null;
        } else if (mine.length > 1) {
          const unshipped = shipped.tag === null ? "no v* tag reachable from HEAD has shipped" : "the CHANGELOG.md of " + shipped.tag + " does not hold";
          problems.push(logPath + ": " + mine.length + " oam floor blocks in " + JSON.stringify(heading) + " that " + unshipped + "; merge them by hand");
          log = null;
        } else if (mine.length === 1) {
          const h = mine[0];
          const was = h + 2 < end && lines[h + 1].trim() === "" ? /the floor was (\d+\.\d+\.\d+)\./.exec(lines[h + 2]) : null;
          if (!was) {
            problems.push(logPath + ": the oam floor block on line " + (h + 1) + " is not the shape this script writes (a blank line, then a paragraph naming the floor was X.Y.Z.), so it cannot be updated in place; move the floor by hand");
            log = null;
          } else {
            block = render(was[1]);
            lines.splice(h, 3, ...block);
            log = lines.join(eol);
          }
        } else {
          block = render(prev);
          let at = end;
          while (at > first + 1 && lines[at - 1].trim() === "") at--;
          lines.splice(at, end - at, "", ...block, "");
          log = lines.join(eol);
        }
      }
    }

    if (problems.length > 0) {
      for (const p of problems) console.error(p);
      process.exit(1);
    }
    if (mode === "--write") {
      fs.writeFileSync(srcPath, src);
      fs.writeFileSync(testPath, test);
      fs.writeFileSync(logPath, log);
    } else if (mode === "--check") {
      process.stdout.write(block.join("\n") + "\n");
    } else {
      console.error("oam_floor_rewrite: mode must be --check or --write, got " + JSON.stringify(mode));
      process.exit(1);
    }
  ' -- "$@"
  # `--` is load-bearing: without it node reads a leading --check as its OWN
  # `node --check` flag and refuses to run the script at all.
}
# <<< oam floor helpers

# ---------- Main path: full release -------------------------------------------
# 5 steps. The build is just `npm run build` (tsup -> dist/index.js); npm
# publish ships the tarball directly. Install method is
# `npm install -g @yawlabs/mcp` or `npx -y @yawlabs/mcp`. See
# docs/v0.70.3-binary-track-decision.md for the rationale and the
# install-store union follow-up.
TOTAL_STEPS=5

echo -e "${CYAN}Pre-flight checks...${NC}"
CURRENT_VERSION=$(current_pkg_version)
RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  # A resume is not a licence to publish a dirty tree. The legitimate resume
  # case -- died between the bump and the commit -- dirties exactly
  # package.json, package-lock.json and server.json, so gate on everything
  # ELSE. Without this, a re-run packed and published whatever happened to be
  # in the working tree while the tag pointed at a commit that did not contain
  # it, and step 5 then attested that version to the MCP registry. npm forbids
  # overwriting a published version, so the irreproducible tarball is permanent.
  #
  # Pathspec exclusion, not a grep over the status codes: porcelain is
  # "XY <path>", so the staged form ("M  package.json" -- an interrupt in the
  # window between `git add` and `commit`) and the mixed "MM " form must be
  # tolerated too, and a code-shaped regex misses both. -uno keeps a stray
  # untracked scratch file from hard-failing the resume; it is warned about
  # below instead, because pressuring the operator toward `git stash -u`
  # mid-release is its own way to lose work.
  RESUME_DIRT=$(git status --porcelain -uno -- . \
    ':(exclude)package.json' ':(exclude)package-lock.json' ':(exclude)server.json')
  if [ -n "$RESUME_DIRT" ]; then
    printf '%s\n' "$RESUME_DIRT" >&2
    fail "Working directory has changes outside the version bump (listed above) -- commit or stash them before resuming. The tag would not contain them; the published tarball would."
  fi
  RESUME_UNTRACKED=$(git ls-files --others --exclude-standard)
  if [ -n "$RESUME_UNTRACKED" ]; then
    warn "Untracked files present -- not in the tag, but anything under package.json's \"files\" allow-list (dist, schemas, README.md, CHANGELOG.md) still gets packed: $(printf '%s' "$RESUME_UNTRACKED" | tr '\n' ' ')"
  fi
  info "Already at v${VERSION} -- resuming"
else
  if [ -n "$(git status --porcelain)" ]; then
    fail "Working directory not clean. Commit or stash changes first."
  fi
  info "Current: v${CURRENT_VERSION} -> v${VERSION}"
fi

# --- Guard: refuse to START from anywhere but main. Step 3 re-checks the
# branch right before the push (it can change between steps), but that check
# used to be the ONLY one, and it runs AFTER the bump commit and the annotated
# tag have landed on whatever branch is checked out. A feature branch sitting
# exactly at origin/main passes the HEAD comparison above, collects the
# v${VERSION} commit + tag, and only then dies -- and the re-run on main is not
# a resume (main's package.json is still the old version) so it trips the
# tag-collision guard below, leaving the operator to delete the stray tag and
# commit by hand. Failing here, before anything is written, is the cheap fix.
PREFLIGHT_BRANCH=$(current_branch)
if [ "$PREFLIGHT_BRANCH" != "main" ]; then
  if [ "$PREFLIGHT_BRANCH" = "HEAD" ]; then
    fail "Detached HEAD -- refusing to release. Check out main (git checkout main) and re-run ./release.sh ${VERSION}."
  fi
  fail "On branch '${PREFLIGHT_BRANCH}', not main -- refusing to release. The bump commit and tag would land on this branch and the push in step 3 would then refuse. Check out main and re-run ./release.sh ${VERSION}."
fi

# Pull the latest remote tags + commits so we can detect a stale local view of
# HEAD (e.g. a previous interrupted run that already pushed the bump).
# A failed fetch was previously downgraded to a warning, which was worse than
# useless: the guard below reads refs/remotes/origin/main, a LOCAL ref the
# failed fetch never touched, so it compared HEAD against a stale snapshot and
# passed cleanly. The "offline?" rationale did not hold either -- this script
# cannot finish offline; it pushes in step 3, publishes to npm in step 4, and
# downloads mcp-publisher from github.com in step 5.
#
# But the EXIT CODE alone does not answer the question this guard asks.
# `--tags` makes the WHOLE fetch exit non-zero when ANY ref is rejected -- most
# often a divergent local tag ("would clobber existing tag"), precisely what
# the bump-past-a-dead-release recovery leaves behind -- while
# refs/remotes/origin/main updates cleanly in the same run. So re-probe the
# branch ref directly and decide on THAT, and always surface the fetch output:
# discarding it with >/dev/null 2>&1 hid the one line naming the cause, for
# genuine auth and connectivity failures as much as for the tag case.
# Set before the fetch so the sync guard below can prefer it over the local
# tracking ref, and so `set -u` is satisfied on the success path where the
# fetch never populates it.
REMOTE_MAIN_SHA=""
FETCH_RC=0
FETCH_OUT=$(git fetch --tags --prune origin 2>&1) || FETCH_RC=$?
if [ "$FETCH_RC" -ne 0 ]; then
  # `|| echo ""` is load-bearing: under `set -e` with `pipefail` an unreachable
  # remote makes ls-remote exit 128, which would abort the script HERE -- before
  # either branch below runs -- and the operator would get the bare failure
  # banner with none of the fetch output this block exists to surface.
  REMOTE_MAIN_SHA=$(git ls-remote origin refs/heads/main 2>/dev/null | awk '{print $1}' || echo "")
  LOCAL_TRACKING_SHA=$(git rev-parse origin/main 2>/dev/null || echo "")
  if [ -n "$REMOTE_MAIN_SHA" ] && [ "$REMOTE_MAIN_SHA" = "$LOCAL_TRACKING_SHA" ]; then
    warn "git fetch exited ${FETCH_RC}, but origin/main is confirmed current at ${REMOTE_MAIN_SHA:0:9} -- continuing. Fetch output:"
    printf '%s\n' "$FETCH_OUT" >&2
  elif [ "${ALLOW_STALE_REMOTE:-}" = "1" ]; then
    if [ -n "$REMOTE_MAIN_SHA" ]; then
      warn "git fetch failed and ALLOW_STALE_REMOTE=1 -- but ls-remote DID answer: origin/main is at ${REMOTE_MAIN_SHA:0:9} while the local tracking ref reads ${LOCAL_TRACKING_SHA:0:9}. The sync guard below will use the ls-remote value, not the stale ref. Fetch output:"
    else
      warn "git fetch failed and ALLOW_STALE_REMOTE=1, and ls-remote could not answer either -- the sync guard below is running against a possibly STALE remote-tracking ref. Fetch output:"
    fi
    printf '%s\n' "$FETCH_OUT" >&2
  else
    printf '%s\n' "$FETCH_OUT" >&2
    fail "git fetch origin failed AND origin/main could not be confirmed current (fetch output above) -- refusing to release on a stale view of origin/main. The sync guard below reads the local remote-tracking ref, so it would pass on stale data and step 3's push would then be rejected non-fast-forward AFTER the bump commit and the annotated tag already exist. Fix connectivity or auth and re-run. Override with ALLOW_STALE_REMOTE=1."
  fi
fi
LOCAL_HEAD=$(current_head_sha)
# Prefer the sha ls-remote actually returned over the local tracking ref. When
# the fetch failed we may be holding proof of where origin/main really is, and
# the tracking ref is precisely the stale value this guard exists to distrust.
# On the success path REMOTE_MAIN_SHA is empty and the tracking ref is fresh.
if [ -n "$REMOTE_MAIN_SHA" ]; then
  REMOTE_HEAD="$REMOTE_MAIN_SHA"
else
  REMOTE_HEAD=$(git rev-parse origin/main 2>/dev/null || echo "")
fi
if [ -n "$REMOTE_HEAD" ] && [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  # The subjects of the commits local main has and origin/main lacks. One with
  # the oam floor move's subject is, in the ordinary case, the floor commit an
  # earlier failed run left (see below), whose gates may never have passed, so
  # no stop here advises pushing it, and when main has diverged, pulling cannot
  # fast-forward over it. Its undo is git reset --keep origin/main, after which
  # the re-run's pre-flight moves the floor again if it is still behind. That
  # reset also DISCARDS every other commit origin/main lacks, so a stop that
  # names it while other commits are present lists them and says how to keep
  # them.
  LOCAL_ONLY_SUBJECTS=$(git log --format=%s "${REMOTE_HEAD}..HEAD" 2>/dev/null || echo "")
  LOCAL_ONLY_FLOOR=false
  if [[ $'\n'"$LOCAL_ONLY_SUBJECTS" == *$'\n''fix(oam): move the floor to '* ]]; then
    LOCAL_ONLY_FLOOR=true
  fi
  KEEP_MINE="To keep your own commits: git branch keep-mine HEAD, then git reset --keep origin/main, then cherry-pick your own commits back from keep-mine (leaving out every floor commit) and land them on origin/main before re-running ./release.sh ${VERSION}, which moves the floor again if it is still behind. A bare git reset --keep origin/main DISCARDS every commit listed."
  if [ "$RESUMING" = true ]; then
    info "Local HEAD differs from origin/main (resuming after a prior push) -- proceeding"
  elif git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD" 2>/dev/null; then
    # Strictly AHEAD: origin/main is an ancestor of HEAD, so there is nothing
    # to pull. Telling the operator to `git pull --ff-only` here is the wrong
    # instruction (it is a no-op) and hides the real state -- unpushed commits
    # that steps 3-5 would publish from a tree the remote has never seen.
    #
    # One shape of "ahead" is this script's own doing. The oam floor move
    # commits ahead of step 1, so a run that fails after it and before step 3's
    # bump commit leaves that commit on local main with package.json unbumped,
    # and the re-run -- fresh, not a resume -- lands here. Refusing it broke the
    # header's re-run-with-the-same-version promise, and advising a push would
    # put a commit whose gates just failed on protected main. So when
    # every commit ahead is a floor commit (oam_floor_commits_only), carry on:
    # step 1's gates run over it, and step 3's push carries it with the bump.
    if oam_floor_commits_only "$REMOTE_HEAD"; then
      warn "Local main is ahead of origin/main only by release.sh's own oam floor commit(s) from an earlier failed run -- continuing; the gates re-run over it and step 3 pushes it with the bump"
    elif [ "$LOCAL_ONLY_FLOOR" = true ]; then
      # A floor commit among OTHER unpushed commits is still refused, and the
      # stop does not advise a push: it would carry a floor commit whose gates
      # may never have passed. It names the undo and what the undo discards.
      fail "Local main is AHEAD of origin/main, and its unpushed commits include release.sh's oam floor commit from an earlier failed run, whose gates may not have passed -- do not push them as they are. Unpushed commits, newest first: ${LOCAL_ONLY_SUBJECTS//$'\n'/; }. ${KEEP_MINE}"
    else
      fail "Local main is AHEAD of origin/main (unpushed commits). Push them first: git push origin main"
    fi
  else
    # Behind or diverged. Local main still carrying a floor commit means it has
    # diverged (a branch that is only behind has no commits of its own) -- for
    # instance, the fix for the failed gate landed on origin/main through a PR.
    # git pull --ff-only cannot fast-forward over that, so its advice would
    # fail. The reset is named bare only when floor commits
    # (oam_floor_commits_only) are all local main has since the merge base.
    LOCAL_BASE=$(git merge-base "$REMOTE_HEAD" "$LOCAL_HEAD" 2>/dev/null || echo "")
    if [ "$LOCAL_ONLY_FLOOR" = true ] && [ -n "$LOCAL_BASE" ] && oam_floor_commits_only "$LOCAL_BASE"; then
      fail "Local main has diverged from origin/main, and the only commits origin/main lacks are release.sh's own oam floor commit(s) from an earlier failed run. git pull --ff-only cannot fast-forward over them: git reset --keep origin/main and re-run ./release.sh ${VERSION}, which moves the floor again if it is still behind."
    elif [ "$LOCAL_ONLY_FLOOR" = true ]; then
      fail "Local main has diverged from origin/main, and the commits origin/main lacks include release.sh's oam floor commit from an earlier failed run, whose gates may not have passed -- git pull --ff-only cannot fast-forward over them, and they should not be pushed as they are. Commits origin/main lacks, newest first: ${LOCAL_ONLY_SUBJECTS//$'\n'/; }. ${KEEP_MINE}"
    fi
    fail "Local main is not at origin/main (behind or diverged). Pull first: git pull --ff-only origin main"
  fi
fi

# --- Guard: refuse a backward or duplicate version, BEFORE the expensive
# lint/test/build. npm only rejects a below-latest version at publish time
# (step 4), with a cryptic "Cannot implicitly apply the latest tag" error, after
# a full build + tag + push has already happened. Catch it here with a clear
# message. A version that is ALREADY published is a legitimate resume (later
# steps skip it), so only a not-yet-published version at or below the current
# npm latest is blocked.
LATEST_NPM=$(npm view "@yawlabs/mcp" version 2>/dev/null || echo "")
# `npm view` cannot distinguish "the registry read failed" from "the package is
# unpublished" -- both yield an empty string -- and the ordering guard below is
# gated on LATEST_NPM being non-empty, so a transient 5xx, proxy hiccup or DNS
# blip silently turned the whole backward-version check into a no-op, with zero
# output saying so. @yawlabs/mcp has been published continuously since 2026-05,
# so an empty result here is ALWAYS a read failure, never a first publish.
#
# The gap this closes is narrow but real. A fat-finger onto a PREVIOUSLY
# RELEASED number is already caught by the tag-collision guard below, since the
# tag is local after the fetch above. What slips through is a version that is
# untagged AND unpublished AND <= latest -- precisely what the "bump past a
# dead release, then delete the stale tag" recovery leaves behind (0.79.3,
# 0.77.0 and 0.75.3 all sit in that state in this repo today). npm still
# rejects the backward publish in step 4, so nothing bad ships; the cost is a
# junk bump commit and tag on protected main plus a wasted gate cycle.
#
# warn rather than fail on a RESUME: the version was already chosen, and
# possibly already published, by the earlier run, so refusing to continue over
# an unrelated probe would block the recovery re-run -- the same carve-out the
# npm-auth guard below makes on ALREADY_PUBLISHED.
if [ -z "$LATEST_NPM" ]; then
  if [ "$RESUMING" = true ] || [ "${ALLOW_UNVERIFIED_VERSION:-}" = "1" ]; then
    warn "npm view returned nothing for @yawlabs/mcp -- the registry is unreadable, so the backward-version ordering guard is SKIPPED for this run"
  else
    fail "npm view returned nothing for @yawlabs/mcp -- cannot verify version ordering. The package IS published, so this is a registry read failure, not a first publish; continuing would silently disable the backward-version guard. Retry, or set ALLOW_UNVERIFIED_VERSION=1 to proceed deliberately."
  fi
fi
ALREADY_PUBLISHED=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
if [ -n "$LATEST_NPM" ] && [ "$ALREADY_PUBLISHED" != "$VERSION" ]; then
  if node -e 'const a=process.argv[1].split(".").map(Number),b=process.argv[2].split(".").map(Number);for(let i=0;i<3;i++){if((a[i]||0)>(b[i]||0))process.exit(0);if((a[i]||0)<(b[i]||0))process.exit(1);}process.exit(1);' "$VERSION" "$LATEST_NPM"; then
    info "Version ${VERSION} > published latest ${LATEST_NPM}"
  else
    fail "Version ${VERSION} is not greater than the published latest ${LATEST_NPM} -- npm will not move the 'latest' tag backward. This is almost always a fat-finger; pick a version > ${LATEST_NPM}."
  fi
fi

# --- Guard: the ~/.npmrc credential is not exercised until step 4's publish,
# which runs AFTER step 3 has committed, tagged and pushed v${VERSION} to
# protected main. The `npm view` calls above are public reads and prove nothing
# about auth. Probe it here -- but fail OPEN unless the output actually carries
# a definitive auth error. An unreachable registry and npm's ARM64 exit-cleanup
# segfault both match none of the auth patterns, so both land in the warn: the
# segfault in particular fires AFTER the tool has printed its report, which is
# this script's model of it everywhere else, so NPM_WHO is typically populated
# rather than empty.
#
# stderr goes to a FILE rather than through 2>&1: npm writes its update-notifier
# block to stderr on a SUCCESSFUL run, and merging the streams would print five
# "npm notice" lines as the operator's npm identity.
#
# The hard fail is conditioned on ALREADY_PUBLISHED (computed just above).
# When this version is already on npm, step 4 skips the publish outright, so a
# lapsed token blocks nothing and must not abort a resume that only needs
# step 5 -- the same carve-out the GitHub-token guard below is built around.
#
# Honest scope: this proves credential PRESENCE, not publish rights on
# @yawlabs/mcp. A read-only or wrong-scope granular token passes `npm whoami`
# and still E403s in step 4.
WHOAMI_RC=0
WHOAMI_ERR=$(mktemp)
NPM_WHO=$(npm whoami 2>"$WHOAMI_ERR") || WHOAMI_RC=$?
WHOAMI_DIAG=$(cat "$WHOAMI_ERR" 2>/dev/null || true)
rm -f "$WHOAMI_ERR"
if [ "$WHOAMI_RC" -eq 0 ] && [ -n "$NPM_WHO" ]; then
  info "npm auth: ${NPM_WHO}"
elif printf '%s\n%s' "$NPM_WHO" "$WHOAMI_DIAG" | grep -qE 'ENEEDAUTH|E401|need auth|log in'; then
  if [ "$ALREADY_PUBLISHED" = "$VERSION" ]; then
    warn "npm is not authenticated, but @yawlabs/mcp@${VERSION} is already published so step 4 will skip the publish -- continuing. Restore the ~/.npmrc automation token before the next release."
  else
    fail "npm is not authenticated -- step 4 would fail AFTER v${VERSION} is committed, tagged and pushed to main. Restore the ~/.npmrc automation token (see CLAUDE.md npm-token-restore); do NOT run 'npm login --auth-type=web' -- it overwrites the automation token."
  fi
else
  warn "npm whoami inconclusive (exit ${WHOAMI_RC}): ${WHOAMI_DIAG:-${NPM_WHO:-no output}} -- proceeding; step 4 will surface a real auth failure"
fi

# --- Guard: the same shape for the OTHER credential, the one step 5 needs.
# Resolving it is pure local computation (two env reads plus one `gh` call)
# that depends on nothing steps 1-4 produce, yet it first runs at the
# `mcp-publisher login github` call -- after the irreversible npm publish.
# warn and not fail, deliberately: on a legitimate resume where the registry
# already lists this version, step 5's own probe skips the entire auth block,
# so a hard failure here would block a run that succeeds today.
if [ -z "$(mcp_registry_gh_token)" ]; then
  warn "No GitHub token for the step-5 MCP-registry login (GITHUB_TOKEN and MCP_REGISTRY_TOKEN unset, \`gh auth token\` empty). The persisted JWT's 300-second TTL never survives steps 1-4, so step 5 will need one -- and it runs after the npm publish. Fix it now with \`gh auth login\`, or export GITHUB_TOKEN (a PAT with publish rights on io.github.YawLabs/*)."
fi

# --- Guard: on a FRESH bump, a tag v${VERSION} that already exists is a
# collision (e.g. a fat-finger reusing an old release number, as 0.8.0 did with
# the 2026-04 tag). Step 3's "tag already exists" branch would silently keep
# the OLD tag and ship the wrong commit. On a resume the tag legitimately
# already points at the bump commit, so this only fires on a fresh bump.
if [ "$RESUMING" != true ] && git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null 2>&1; then
  EXISTING_TAG_COMMIT=$(git rev-list -n1 "v${VERSION}")
  fail "Tag v${VERSION} already exists (at ${EXISTING_TAG_COMMIT:0:9}) -- refusing to reuse an existing release number on a new commit. Pick an unused version, or delete the stale tag if it is wrong."
fi

# >>> oam floor pre-flight
# --- Guard: the oam floor is the latest oam release (see the oam floor helpers
# above). Read-only: it only decides, and the block ahead of step 1 does the
# move. It runs HERE, before the confirm prompt, so the prompt can say the floor
# is about to move, and so a changelog or source shape the move cannot handle
# stops the run before any file is written.
#
# A release that can still move the floor fails CLOSED when GitHub cannot be
# read. The floor policy has no exceptions, and this is the only point in the
# release that checks it, so an unreadable API silently waving the release
# through would ship the stale floor the policy exists to prevent.
# ALLOW_STALE_OAM_FLOOR=1 is the deliberate way past it.
#
# Whether the floor can still move is OAM_FLOOR_LOCKED: the tag v${VERSION}
# exists, or ${VERSION} is already on npm. It is NOT RESUMING, which only means
# package.json already reads VERSION. A hand-run `npm version`, a bump committed
# to main ahead of the release (648fa15 did exactly that for 0.77.0), and a run
# that died in step 3 before tagging all look like a resume while nothing
# irreversible has happened, and keying on RESUMING shipped each of them on a
# stale floor with only a warning. Once the tag or the npm version exists, a
# move is wrong: with the tag at the bump commit and the version unpublished,
# the floor commit would sit between the tag and HEAD, which step 3 refuses;
# with the version published, step 4 packs nothing, so the move would never
# reach npm. The collision guard above already refuses an existing tag on a
# fresh run, so the tag half only decides anything on a resume.
#
# So on a locked release nothing GitHub reports stops the run: an unreadable
# API, a floor behind the latest oam release, and a floor ahead of it are all
# warnings. Reading MIN_OAM_VERSION out of the source still fails on a locked
# release, as does a comparison that errors: the first needs that line
# reshaped, and the second needs node itself to fail, since both sides are
# X.Y.Z by then.
OAM_FLOOR_TARGET=""
OAM_FLOOR_DATE=""
# The changelog block the move will write, as --check rendered it. The
# behaviour-change gate below reads it, because the block is not on disk until
# the move runs, after that gate.
OAM_FLOOR_BLOCK=""
OAM_FLOOR_LOCKED=false
if git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null 2>&1 || [ "${ALREADY_PUBLISHED:-}" = "$VERSION" ]; then
  OAM_FLOOR_LOCKED=true
fi
OAM_FLOOR_NOW=$(current_oam_floor) || fail "Could not read the oam floor out of ${OAM_FLOOR_SRC} (see above) -- expected exactly one line of the form: export const MIN_OAM_VERSION = \"X.Y.Z\";"
OAM_LATEST_READ=$(latest_oam_release || echo "")
if [ -z "$OAM_LATEST_READ" ]; then
  if [ "$OAM_FLOOR_LOCKED" = true ] || [ "${ALLOW_STALE_OAM_FLOOR:-}" = "1" ]; then
    warn "Could not read the latest oam release from GitHub (see above) -- the oam floor stays at ${OAM_FLOOR_NOW}, UNCHECKED, for this run"
  else
    fail "Could not read the latest oam release from ${OAM_RELEASES_API} (the curl or parser error above says why), so the oam floor (${OAM_FLOOR_NOW}) cannot be checked against it. Retry; for a 403 or 429 rate limit, give the read a token first (export GITHUB_TOKEN, or \`gh auth login\`). Or set ALLOW_STALE_OAM_FLOOR=1 to release on the current floor deliberately."
  fi
else
  OAM_LATEST="${OAM_LATEST_READ%% *}"
  OAM_LATEST_DAY="${OAM_LATEST_READ#* }"
  OAM_FLOOR_CMP=$(semver_cmp "$OAM_FLOOR_NOW" "$OAM_LATEST" || echo "")
  case "$OAM_FLOOR_CMP" in
    0)
      info "oam floor ${OAM_FLOOR_NOW} is the latest oam release"
      ;;
    -1)
      if [ "$OAM_FLOOR_LOCKED" = true ]; then
        warn "oam ${OAM_LATEST} is out and the oam floor is still ${OAM_FLOOR_NOW} -- v${VERSION} is already tagged or on npm, so this run does not move it. The next release moves it."
      else
        OAM_FLOOR_BLOCK=$(oam_floor_rewrite --check "$OAM_FLOOR_SRC" "$OAM_FLOOR_TEST" CHANGELOG.md "$OAM_LATEST" "$OAM_FLOOR_NOW" "$OAM_LATEST_DAY" "$VERSION") \
          || fail "oam ${OAM_LATEST} is out and the oam floor is ${OAM_FLOOR_NOW}, but this script cannot move it (see above). Fix what is named there, or move the floor by hand, then re-run."
        OAM_FLOOR_TARGET="$OAM_LATEST"
        OAM_FLOOR_DATE="$OAM_LATEST_DAY"
        info "oam floor ${OAM_FLOOR_NOW} is behind oam ${OAM_LATEST} (published ${OAM_LATEST_DAY}) -- it moves before step 1"
      fi
      ;;
    1)
      if [ "$OAM_FLOOR_LOCKED" = true ]; then
        warn "The oam floor ${OAM_FLOOR_NOW} is AHEAD of the latest oam release ${OAM_LATEST} -- v${VERSION} is already tagged or on npm, so this run does not change it. Before the next release, lower MIN_OAM_VERSION in ${OAM_FLOOR_SRC} and the const FLOOR literal in ${OAM_FLOOR_TEST}, or, if a lower release took GitHub's latest marker, re-mark v${OAM_FLOOR_NOW} as latest on YawLabs/oam."
      elif [ -n "${REMOTE_HEAD:-}" ] && oam_floor_commits_only "$REMOTE_HEAD"; then
        # The sync guard carried on because local main is ahead only by the
        # floor commit(s) an earlier failed run left, so one of them may be
        # what put the floor ahead (oam released, the run failed, and the
        # release was pulled or lost GitHub's latest marker before the re-run).
        # Lowering by hand, committing and pushing -- the advice below -- would
        # push those commits too, and their gates may never have passed.
        fail "The oam floor ${OAM_FLOOR_NOW} is AHEAD of the latest oam release ${OAM_LATEST}, and local main is ahead of origin/main only by release.sh's own unpushed oam floor commit(s) from an earlier failed run, which may be what moved it there. Do not push them. If a lower release took GitHub's latest marker by mistake, re-mark v${OAM_FLOOR_NOW}: gh release edit v${OAM_FLOOR_NOW} --repo YawLabs/oam --latest, then re-run. Otherwise drop the floor commit(s): git reset --keep origin/main (only those commits are ahead, so no other commit is lost) and re-run ./release.sh ${VERSION}, whose pre-flight then compares the floor origin/main holds with ${OAM_LATEST} instead."
      else
        fail "The oam floor ${OAM_FLOOR_NOW} is AHEAD of the latest oam release ${OAM_LATEST}, and oam's installer and self-update install that same latest release -- so a fresh or updated oam would count as too old and its sidecars would fall back to node. Either the floor was mistyped, oam ${OAM_FLOOR_NOW} was pulled, or a lower release took GitHub's latest marker (a backport, or ${OAM_FLOOR_NOW} published with make_latest=false). In that last case re-mark it rather than lowering the floor: gh release edit v${OAM_FLOOR_NOW} --repo YawLabs/oam --latest, then re-run. Otherwise lower MIN_OAM_VERSION in ${OAM_FLOOR_SRC} AND the const FLOOR literal in ${OAM_FLOOR_TEST} to ${OAM_LATEST} (the ratchet test fails if only the constant drops), add a note to CHANGELOG.md's Unreleased section saying the floor was lowered, then commit, push and re-run."
      fi
      ;;
    *)
      fail "Could not compare the oam floor ${OAM_FLOOR_NOW} with the latest oam release ${OAM_LATEST}"
      ;;
  esac
fi
# <<< oam floor pre-flight

if [ "$SKIP_CONFIRM" != "true" ] && [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  if [ -n "$OAM_FLOOR_TARGET" ]; then
    echo "  0. Move the oam floor ${OAM_FLOOR_NOW} -> ${OAM_FLOOR_TARGET} (MIN_OAM_VERSION, its test ratchet, a CHANGELOG block) and commit it"
  fi
  echo "  1. Run lint + typecheck + tests"
  echo "  2. Build the bundled CLI (npm run build)"
  echo "  3. Bump version in package.json + server.json, commit, tag, push"
  echo "  4. Publish to npm (using ~/.npmrc automation token)"
  echo "  5. Publish server.json to the MCP registry (mcp-publisher)"
  echo ""
  echo -e "  Install method is ${CYAN}npm install -g @yawlabs/mcp${NC} (or ${CYAN}npx -y @yawlabs/mcp${NC})."
  echo ""
  # The TTY check comes FIRST, ahead of both prompts. Without a terminal every
  # `read` below returns EOF instantly, so the behaviour-change gate would
  # "pass" on an empty answer and only then hit this abort -- a gate answering
  # itself, even though the release stopped anyway. Checking here means neither
  # prompt is ever reached without someone able to answer it.
  if [ ! -t 0 ]; then
    echo "Aborted: stdin is not a terminal, so the confirm prompt cannot be answered."
    echo "Re-run with -y (or SKIP_CONFIRM=1 ./release.sh ${VERSION}) to release non-interactively."
    exit 0
  fi
  # Behaviour-change prompt, deliberately BEFORE the release confirm rather
  # than folded into it. This package has real installs, and the failure it
  # guards is not a bug -- it is a default that changes without an opt-in, so
  # an already-working setup does something different on its next upgrade with
  # nothing in the user's own config having moved. Nothing else in this script
  # can detect that: it is a judgement about intent, not a property of the
  # diff, so the only place to catch it is a human answering out loud before
  # the irreversible steps.
  #
  # Answering "y" does not gate anything further; naming the off switch is the
  # whole point, because a default-on change with no documented way back is
  # the shape that costs users. It rides inside the same SKIP_CONFIRM branch,
  # so -y / SKIP_CONFIRM=1 skips it exactly like the confirm below.
  echo -e "${YELLOW}Does v${VERSION} change behaviour for an EXISTING user who opts into nothing?${NC}"
  echo "  A new default, a new ceiling, a changed threshold, a newly-enforced rule."
  # A floor move IS a changed threshold, so a truthful answer to the question
  # above is yes whenever one is planned. Say so, and say that its way back is
  # already covered, or the operator either answers no or is aborted for not
  # having documented what the script is about to document.
  if [ -n "$OAM_FLOOR_TARGET" ]; then
    echo "  This release also moves the oam floor ${OAM_FLOOR_NOW} -> ${OAM_FLOOR_TARGET}: a machine whose oam is older hosts its node/npx sidecars on node. That counts as a changed threshold; its way back (oam self-update) is in the CHANGELOG block the move writes, so naming it here is accepted."
  fi
  # A WHOLE LINE, not `read -n 1`. The sibling confirm below reads one
  # character safely because nothing reads after it; this one is followed by a
  # second prompt, and `-n 1` on an answer of "yes" leaves "es" in the buffer
  # for that second read to swallow as the off-switch name. "es" then matches
  # CHANGELOG.md as a substring of any word containing it, so the gate passed
  # itself -- the operator typing a NORMAL answer defeated the check.
  read -p "Behaviour change with no opt-in? (y/N) " -r BEHAVIOUR_REPLY || BEHAVIOUR_REPLY=""
  if [[ $BEHAVIOUR_REPLY =~ ^[Yy]([Ee][Ss])?$ ]]; then
    echo "  Then it needs an off switch, and CHANGELOG.md must name it."
    read -p "  Off switch (env var / flag), or blank to abort: " -r OFF_SWITCH || OFF_SWITCH=""
    OFF_SWITCH="${OFF_SWITCH#"${OFF_SWITCH%%[![:space:]]*}"}"
    OFF_SWITCH="${OFF_SWITCH%"${OFF_SWITCH##*[![:space:]]}"}"
    if [ -z "$OFF_SWITCH" ]; then
      echo "Aborted: a default-on behaviour change ships with a documented way back, or it does not ship."
      exit 0
    fi
    # Scoped to the UNRELEASED section, not the whole file. The point of the
    # gate is that THIS release documents the switch; an unscoped grep is
    # satisfied by a name mentioned three releases ago, which is exactly the
    # case where the operator most needs to be stopped.
    UNRELEASED_BODY=$(awk '/^## [Uu]nreleased/ { inside = 1; next } inside && /^## / { exit } inside { print }' CHANGELOG.md 2>/dev/null || true)
    # The floor move writes its CHANGELOG block AFTER this gate (the move block
    # ahead of step 1), so the file on disk does not have it yet. Add the block
    # the pre-flight's --check rendered, from the same template the move writes
    # with.
    if [ -n "$OAM_FLOOR_TARGET" ]; then
      UNRELEASED_BODY="${UNRELEASED_BODY}"$'\n'"${OAM_FLOOR_BLOCK}"
    fi
    # `-e` so a flag-shaped switch is a PATTERN, not an option. Without it
    # `grep -qF "--no-cap"` exits 2 with "unknown option", and the message
    # below then told the operator the name was absent from a file that
    # contains it -- an abort on the answer the prompt above asks for.
    if ! printf '%s\n' "$UNRELEASED_BODY" | grep -qF -e "$OFF_SWITCH"; then
      echo "Aborted: '${OFF_SWITCH}' does not appear in CHANGELOG.md's Unreleased section -- document it there first."
      exit 0
    fi
    echo -e "  ${CYAN}${OFF_SWITCH}${NC} found in the Unreleased section."
  fi
  echo ""
  # Non-interactive stdin (piped, nohup, an agent harness) gets EOF from
  # `read`, which returns non-zero -- under `set -e` that used to kill the run
  # with the generic "Release failed at line NNN" banner, as if a gate had
  # failed. Nothing has been mutated at this point, so say what happened and
  # exit the same clean way a declined prompt does. The `-t 0` guard that used
  # to sit here now runs at the top of this block, ahead of BOTH prompts --
  # see the comment there. `|| REPLY=""` still covers the EOF-on-a-tty case
  # (Ctrl-D), which no `-t 0` check can see.
  read -p "Continue? (y/N) " -n 1 -r || REPLY=""
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# >>> oam floor move
# The move the pre-flight planned, committed on its own AHEAD of step 1 so that
# lint, typecheck and the full suite run over the new floor. Step 3's push then
# carries this commit along with the version bump.
#
# The prompts sit between the pre-flight and here, so the three files are
# checked again before anything is written. Uncommitted changes in any of them
# stop the run: `git commit -- <paths>` commits each path's whole working-tree
# state, so a half-written edit would ride inside the floor commit, and the
# nothing-to-move branch would leave an uncommitted floor edit that the build
# packs and the tag does not contain. That check comes BEFORE the re-read so it
# covers that branch too.
#
# The floor is then re-read rather than trusted from the pre-flight, per the
# re-read-at-every-step-boundary rule, and it must still be BELOW the target: a
# floor that moved ahead of it since the pre-flight would otherwise be silently
# lowered, which the pre-flight refuses. `git commit -- <paths>` commits exactly
# the three files, whatever else the index holds.
if [ -n "$OAM_FLOOR_TARGET" ]; then
  echo -e "\n${CYAN}=== Move the oam floor to ${OAM_FLOOR_TARGET} (ahead of step 1, so its gates run over it) ===${NC}"
  OAM_FLOOR_DIRT=$(git status --porcelain -- "$OAM_FLOOR_SRC" "$OAM_FLOOR_TEST" CHANGELOG.md)
  if [ -n "$OAM_FLOOR_DIRT" ]; then
    printf '%s\n' "$OAM_FLOOR_DIRT" >&2
    fail "Uncommitted changes appeared in the oam floor files since the pre-flight (listed above) -- the floor commit would carry them. Commit or drop them, then re-run ./release.sh ${VERSION}."
  fi
  OAM_FLOOR_NOW=$(current_oam_floor) || fail "Could not re-read the oam floor out of ${OAM_FLOOR_SRC} (see above)"
  OAM_FLOOR_RECMP=$(semver_cmp "$OAM_FLOOR_NOW" "$OAM_FLOOR_TARGET" || echo "")
  if [ "$OAM_FLOOR_RECMP" = "0" ]; then
    info "oam floor already at ${OAM_FLOOR_TARGET} -- nothing to move"
  elif [ "$OAM_FLOOR_RECMP" != "-1" ]; then
    fail "The oam floor now reads ${OAM_FLOOR_NOW}, not below ${OAM_FLOOR_TARGET} as the pre-flight planned -- it changed during the run (or the comparison itself failed, see above). Re-run ./release.sh ${VERSION}."
  else
    oam_floor_rewrite --write "$OAM_FLOOR_SRC" "$OAM_FLOOR_TEST" CHANGELOG.md "$OAM_FLOOR_TARGET" "$OAM_FLOOR_NOW" "$OAM_FLOOR_DATE" "$VERSION" \
      || fail "Could not move the oam floor to ${OAM_FLOOR_TARGET} (see above)"
    OAM_FLOOR_WRITTEN=$(current_oam_floor) || fail "Could not re-read the oam floor out of ${OAM_FLOOR_SRC} after moving it (see above)"
    [ "$OAM_FLOOR_WRITTEN" = "$OAM_FLOOR_TARGET" ] \
      || fail "MIN_OAM_VERSION reads ${OAM_FLOOR_WRITTEN} after the move, not ${OAM_FLOOR_TARGET} -- refusing to commit"
    # Hook-free with MSYS_NO_PATHCONV=1, like step 3's bump (see there for why
    # the pin is load-bearing), so a local hook cannot rewrite or reject it.
    # Unlike the bump, step 1 has not run yet: its gates run over this commit
    # next, on a tree the pre-flight's dirty-tree guards have already checked.
    MSYS_NO_PATHCONV=1 git -c core.hooksPath=/dev/null commit -m "fix(oam): move the floor to ${OAM_FLOOR_TARGET}" -- "$OAM_FLOOR_SRC" "$OAM_FLOOR_TEST" CHANGELOG.md
    info "oam floor ${OAM_FLOOR_NOW} -> ${OAM_FLOOR_TARGET}, committed"
    warn "Not re-run by this script: the oam hosting check src/oam-spawn.ts describes for each floor move."
    warn "If a later step fails before step 3's push, this commit stays on local main. Re-running ./release.sh ${VERSION} carries on over it, provided nothing else is committed on top and origin/main has not moved; otherwise the re-run stops at the origin/main sync guard, which names git reset --keep origin/main and anything that reset would discard."
  fi
fi
# <<< oam floor move

step 1 "Lint + typecheck + tests"
run_npm_check "Lint" lint 'Found [0-9]+ error' 'Checked [0-9]+ files'  # done_re is inert -- run_npm_check's lint-crash guard hard-fails every 139/134 before the ARM64 tolerance block that would read it; kept so narrowing that guard re-arms it.
run_npm_check "Type check" typecheck 'error TS[0-9]' '' 'npx tsc --noEmit'
# Tests go through the same wrapper as lint/typecheck: `npm test` is an
# npm-run script on the same host that segfaults (139/134) in npm's exit
# cleanup AFTER the tool has printed its report, so a bare `npm test || fail`
# turned a green suite into a failed release. vitest's own summary line is the
# authority. The failure pattern is anchored to that summary rather than the
# looser 'FAIL|[0-9]+ failed': a test NAME containing "FAILS" already exists
# (foundry-routing.test.ts) and captured console output is echoed verbatim, so
# a loose pattern can hard-fail a passing run.
# `Errors +N error` is vitest's UNHANDLED-error summary line (an unhandled
# rejection or an error thrown outside any test). vitest prints it beside a
# fully-green `Test Files N passed` and exits 1, so without it in fail_re the
# ARM64 tolerance path above -- done_re matches, rc is the segfault -- would
# wave a red run through. Same one-or-more-space shape as the sibling summary
# rows; what keeps a test that echoes captured output from false-matching it
# is the trailing `[0-9]+ error` shape, not the spacing.
run_npm_check "Tests" test 'Test Files +[0-9]+ failed|Tests +[0-9]+ failed|Errors +[0-9]+ error' 'Test Files +[0-9]+ passed'
info "Lint + typecheck + tests passed"

step 2 "Build"
# This build is deliberately belt-and-braces: package.json's `prepublishOnly`
# rebuilds again inside step 4's `npm publish`. Keeping it here fails a broken
# build BEFORE the irreversible commit+tag+push of step 3, which is worth one
# extra tsup run (a couple of seconds).
#
# Same ARM64 tolerance as run_npm_check, applied to the ARTIFACT rather than to
# a log marker: MINGW64 on Windows ARM64 can segfault (139/134) in npm's exit
# cleanup AFTER tsup has already written dist/index.js. tsup prints no stable
# completion marker, so the freshly-rewritten artifact is the evidence -- if
# dist/index.js is not newer than the moment this step started, the build
# really did fail.
BUILD_STARTED_AT=$(date +%s)
BUILD_RC=0
npm run build || BUILD_RC=$?
if [ "$BUILD_RC" -ne 0 ]; then
  BUILD_TOLERATED=false
  if [ "$IS_MINGW_ARM64" = true ] && { [ "$BUILD_RC" -eq 139 ] || [ "$BUILD_RC" -eq 134 ]; }; then
    DIST_MTIME=$(node -e 'try { process.stdout.write(String(Math.floor(require("fs").statSync("dist/index.js").mtimeMs / 1000))); } catch { process.stdout.write("0"); }')
    if [ "$DIST_MTIME" -ge "$BUILD_STARTED_AT" ]; then
      warn "Build: npm exited $BUILD_RC (ARM64 npm-run cleanup segfault) but dist/index.js was rewritten during this step -- tolerating"
      BUILD_TOLERATED=true
    fi
  fi
  [ "$BUILD_TOLERATED" = true ] || fail "Build failed (exit $BUILD_RC)"
fi
info "Build complete"

step 3 "Bump version to $VERSION, commit, tag, and push"
# Re-read current version (the resume path can skip a bump that's already done).
CURRENT_VERSION=$(current_pkg_version)
if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "package.json already at v${VERSION} -- skipping bump"
  # ...but do NOT assume server.json came along. A tree where package.json was
  # bumped and server.json was not (an interrupted prior run, a hand-run
  # `npm version`, a bad merge) hits this branch, skips the bump entirely, and
  # then dies at the lockstep guard below with no way forward except editing
  # the file by hand. Re-read it here and self-heal.
  SERVER_VERSION=$(current_server_version)
  if [ "$SERVER_VERSION" = "$VERSION" ]; then
    info "server.json already at v${VERSION} -- skipping bump"
  else
    warn "server.json is at v${SERVER_VERSION} but package.json is v${VERSION} -- rewriting server.json to match"
    write_server_version "$VERSION"
    info "server.json bumped"
  fi
else
  # The one MUTATING npm call in the script, and the only one with no ARM64
  # segfault tolerance until now: `set -e` turned a 139 from npm's exit
  # cleanup into an abort AFTER package.json had already been rewritten. The
  # resume path recovers (package.json is excluded from the dirt check, and
  # server.json self-heals above), but the first run on the ARM box died here
  # every time. Same rule as run_npm_check: the tool's OUTPUT -- here the
  # version the file now carries -- is authoritative, not npm's exit code.
  bump_rc=0
  npm version "$VERSION" --no-git-tag-version || bump_rc=$?
  if [ "$bump_rc" -ne 0 ]; then
    BUMPED_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
    if [ "$IS_MINGW_ARM64" = true ] && { [ "$bump_rc" -eq 139 ] || [ "$bump_rc" -eq 134 ]; } && [ "$BUMPED_VERSION" = "$VERSION" ]; then
      warn "npm version exited $bump_rc (ARM64 npm exit-cleanup segfault) but package.json now reads v${VERSION} -- tolerating"
    else
      fail "npm version failed (exit $bump_rc); package.json reads '${BUMPED_VERSION:-unreadable}'"
    fi
  fi
  info "package.json bumped"
  # Keep server.json in lockstep. The script is the single source of truth
  # now; CI no longer rewrites server.json.
  write_server_version "$VERSION"
  info "server.json bumped"
fi

if [ -n "$(git status --porcelain package.json package-lock.json server.json 2>/dev/null)" ]; then
  git add package.json package-lock.json server.json
  # core.hooksPath is pointed at a path with no hooks in it, so the bump commit
  # cannot be rewritten or rejected by a local hook (the gates it would re-run
  # are step 1's, already green). MSYS_NO_PATHCONV=1 is load-bearing on this
  # script's primary host: Git Bash rewrites a Unix-shaped argument into a
  # Windows path before git.exe sees it, so `/dev/null` arrives as
  # C:/Users/<user>/scoop/apps/git/<ver>/dev/null. The effect happens to be the
  # same (both are hook-free), but the config value git records is not the one
  # written here -- pin it so the line means what it reads as on every host.
  MSYS_NO_PATHCONV=1 git -c core.hooksPath=/dev/null commit -m "v${VERSION}"
  info "Committed version bump"
else
  info "Nothing to commit (already at v${VERSION})"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  # A pre-existing tag is the normal resume shape, but "the tag exists" is not
  # the same as "the tag describes what step 4 is about to publish". If the
  # operator committed a fix on main after an interrupted run had already
  # tagged, HEAD has moved and `npm publish` would pack a working tree the
  # tagged commit does not contain -- and npm forbids re-publishing, so the
  # tarball and the tag disagree permanently. The resume dirt guard only covers
  # UNCOMMITTED changes; this covers committed ones.
  #
  # Conditioned on the publish still being PENDING, and deliberately so: when
  # the version is already on npm, step 4 packs nothing, so tag/HEAD drift is
  # harmless -- that is exactly the v0.80.0 recovery (tag at the bump commit, a
  # description fix committed after it, re-run to finish step 5), and failing
  # there would block a recovery that works. The npm read is fresh rather than
  # the pre-flight value, per the re-read-at-every-step-boundary rule; an
  # unreadable registry leaves it empty and therefore fails CLOSED, which is
  # the right default in front of an irreversible publish.
  EXISTING_TAG_SHA=$(git rev-list -n1 "v${VERSION}")
  HEAD_SHA=$(current_head_sha)
  if [ "$EXISTING_TAG_SHA" != "$HEAD_SHA" ]; then
    TAG_DRIFT_PUBLISHED=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
    if [ "$TAG_DRIFT_PUBLISHED" = "$VERSION" ]; then
      warn "Tag v${VERSION} points at ${EXISTING_TAG_SHA:0:9}, not HEAD (${HEAD_SHA:0:9}), but ${VERSION} is already on npm so step 4 will pack nothing -- continuing. The tag describes what was published; commits made since it are NOT in that tarball."
    else
      fail "Tag v${VERSION} exists at ${EXISTING_TAG_SHA:0:9} but HEAD is ${HEAD_SHA:0:9}, and ${VERSION} is not yet on npm -- refusing to publish a tree the tag does not describe. Either cut a new version, or, if the tag has NOT been pushed, move it onto HEAD: git tag -f -a v${VERSION} -m v${VERSION}. If it is already on origin, cut a new version instead; moving a published tag rewrites release history."
    fi
  else
    info "Tag v${VERSION} already exists at HEAD (${HEAD_SHA:0:9})"
  fi
else
  # Annotated (-a) so --follow-tags picks it up; lightweight tags are ignored
  # by --follow-tags and would silently fail to push.
  git tag -a "v${VERSION}" -m "v${VERSION}"
  info "Tag v${VERSION} created"
fi

# Re-verify package.json matches the tag BEFORE pushing -- catching a stale
# local index that was bumped-after-tag here prevents the "tag pushed without
# the matching version bump" failure mode.
PKG_NOW=$(current_pkg_version)
if [ "$PKG_NOW" != "$VERSION" ]; then
  fail "package.json shows $PKG_NOW but tag is v${VERSION} -- refusing to push"
fi
SERVER_NOW=$(current_server_version)
if [ "$SERVER_NOW" != "$VERSION" ]; then
  fail "server.json shows $SERVER_NOW but tag is v${VERSION} -- refusing to push (registry would 400 on drift)"
fi
# The other half of the registry contract, checked in the same place and for
# the same reason: mcp-publisher proves ownership by reading `mcpName` out of
# the published npm package and comparing it to server.json's `name`. A
# mismatch is only surfaced in step 5, which runs AFTER the irreversible npm
# publish -- stranding the release with a version on npm that can never be
# registered. Version drift already fails here; name drift now does too.
MCPNAME_NOW=$(current_pkg_mcp_name)
SERVER_NAME_NOW=$(current_server_name)
if [ "$MCPNAME_NOW" != "$SERVER_NAME_NOW" ]; then
  fail "package.json mcpName (${MCPNAME_NOW:-<unset>}) != server.json name (${SERVER_NAME_NOW:-<unset>}) -- refusing to push. The MCP registry would reject the ownership check in step 5, after npm publish has already gone out."
fi

# Re-read the branch here (not at script start -- it can change between steps)
# and refuse to run the push from anywhere but main. `git push origin main`
# pushes the LOCAL main ref, not HEAD: from a feature branch it would push a
# main that does not contain the bump commit, and --follow-tags would skip
# v${VERSION} because the tag is not reachable from the pushed ref. The push
# "succeeds", nothing lands, and steps 4-5 publish a version whose commit and
# tag exist only on this workstation.
CURRENT_BRANCH=$(current_branch)
if [ "$CURRENT_BRANCH" != "main" ]; then
  if [ "$CURRENT_BRANCH" = "HEAD" ]; then
    fail "Detached HEAD -- refusing to push. Check out main (git checkout main) and re-run ./release.sh ${VERSION}."
  fi
  fail "On branch '${CURRENT_BRANCH}', not main -- refusing to run 'git push origin main --follow-tags'. It would push the local main ref (which does NOT contain the v${VERSION} bump commit) and silently skip the tag. Merge or check out main, then re-run ./release.sh ${VERSION}."
fi

git push origin main --follow-tags
info "Pushed to origin"

step 4 "Publish to npm"
# The script is the publisher now. ~/.npmrc must carry the automation token
# (NOT a WebAuthn web session -- the npm publishing rule in CLAUDE.md is
# explicit on this: `npm login --auth-type=web` overwrites the automation
# token and the next publish EOTPs on WebAuthn).
PUBLISHED_VERSION=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
# Which branch ran decides how the final tarball-content check READS a
# mismatch: bytes on npm that differ from what THIS run packed are an anomaly,
# while bytes that differ from a tree whose version was already live are the
# documented post-tag-commit recovery. Same fact, opposite conclusions.
NPM_PUBLISHED_THIS_RUN=false
if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "@yawlabs/mcp@${VERSION} already on npm -- skipping"
else
  # Retry up to 3 times on EOTP/EAUTH/OTP (WebAuthn-fresh sessions sometimes
  # need ~30s for the auth backend to propagate); fail fast on everything else
  # so a packaging error or duplicate-version doesn't waste 60s spinning.
  ATTEMPT=1
  MAX_ATTEMPTS=3
  while true; do
    PUBLISH_LOG=$(mktemp)
    # `|| PUBLISH_RC=$?` rather than `if npm publish ...; then`: the exit code
    # itself is needed below, and under `set -o pipefail` the pipeline carries
    # npm's code, not tee's.
    PUBLISH_RC=0
    npm publish --access public 2>&1 | tee "$PUBLISH_LOG" || PUBLISH_RC=$?
    if [ "$PUBLISH_RC" -eq 0 ]; then
      rm -f "$PUBLISH_LOG"
      break
    fi
    # Same ARM64 tolerance the build and the step-1 gates get, applied to the
    # one command where a false failure is most expensive: npm can segfault
    # (139/134) in its exit cleanup AFTER the tarball has been accepted, and
    # npm forbids re-publishing a version, so a re-run of a "failed" publish
    # dies on EPUBLISHCONFLICT with the release half-done. The registry is the
    # authority -- ask it, with a short poll for the read path's lag.
    if [ "$IS_MINGW_ARM64" = true ] && { [ "$PUBLISH_RC" -eq 139 ] || [ "$PUBLISH_RC" -eq 134 ]; }; then
      PUBLISH_PROBE=""
      for PROBE_TRY in 1 2 3; do
        PUBLISH_PROBE=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
        [ "$PUBLISH_PROBE" = "$VERSION" ] && break
        sleep 6
      done
      if [ "$PUBLISH_PROBE" = "$VERSION" ]; then
        warn "npm publish exited $PUBLISH_RC (ARM64 npm exit-cleanup segfault) but @yawlabs/mcp@${VERSION} is live on npm -- tolerating"
        rm -f "$PUBLISH_LOG"
        break
      fi
    fi
    if ! grep -qE 'EOTP|EAUTH|one-time password|OTP' "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      fail "npm publish failed (non-OTP error -- see output above). If E401/E404, your ~/.npmrc session is stale: see CLAUDE.md npm-token-restore."
    fi
    rm -f "$PUBLISH_LOG"
    if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
      fail "npm publish failed after $MAX_ATTEMPTS OTP-class attempts. WebAuthn session may not be propagating."
    fi
    warn "npm publish attempt $ATTEMPT EOTPed -- waiting 30s for WebAuthn session to propagate"
    ATTEMPT=$((ATTEMPT + 1))
    sleep 30
  done
  NPM_PUBLISHED_THIS_RUN=true
  info "Published @yawlabs/mcp@${VERSION} to npm"
fi

step 5 "Publish server.json to MCP registry"
# Idempotence, per the header claim that every step is re-runnable: the
# registry rejects a duplicate (name, version), so a re-run after a COMPLETED
# step 5 died here. Ask the registry whether this exact version is already
# listed and skip the whole step (download, auth, publish) when it is.
# registry_has_version carries the cache-buster and the fail-open contract;
# see its header for why an un-busted read breaks exactly this guarantee.
REGISTRY_HAS_VERSION=false
if registry_has_version "$VERSION"; then
  REGISTRY_HAS_VERSION=true
fi

if [ "$REGISTRY_HAS_VERSION" = true ]; then
  info "io.github.YawLabs/mcp@${VERSION} already on the MCP registry -- skipping publish"
else
  # Check the published-npm first; mcp-publisher's `publish` validates that the
  # referenced npm package exists, and the registry mirror can lag the write
  # path by seconds.
  NPM_NOW=""
  for POLL_TRY in 1 2 3 4 5 6 7 8 9 10; do
    NPM_NOW=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
    [ "$NPM_NOW" = "$VERSION" ] && break
    sleep 6
  done
  if [ "$NPM_NOW" != "$VERSION" ]; then
    fail "npm does not show @yawlabs/mcp@${VERSION} after 60s -- refusing to publish to MCP registry (it would 400)"
  fi

  # Download + sha256-verify mcp-publisher to a temp dir. Pinned + digest-verified
  # the same way the old CI workflow did.
  WORKDIR=$(mktemp -d)
  # mcp-publisher ships a tarball per (platform, arch). Map the current host to
  # the matching tarball name so this works on a Linux, macOS, or Windows
  # release-driver machine.
  #
  # We use node (already a hard dep) rather than `uname` because MINGW64 on
  # Windows ARM64 reports x86_64 via `uname -m` even when the kernel is arm64,
  # which would pick the wrong Windows binary.
  HOST_INFO=$(node -e 'process.stdout.write(process.platform + " " + process.arch)')
  case "$HOST_INFO" in
    "linux x64")    GOOS=linux;   GOARCH=amd64 ;;
    "linux arm64")  GOOS=linux;   GOARCH=arm64 ;;
    "darwin x64")   GOOS=darwin;  GOARCH=amd64 ;;
    "darwin arm64") GOOS=darwin;  GOARCH=arm64 ;;
    "win32 x64")    GOOS=windows; GOARCH=amd64 ;;
    "win32 arm64")  GOOS=windows; GOARCH=arm64 ;;
    *) fail "Unsupported host for mcp-publisher: $HOST_INFO" ;;
  esac
  TARBALL="mcp-publisher_${GOOS}_${GOARCH}.tar.gz"
  info "Downloading mcp-publisher ${MCP_PUBLISHER_VERSION} (${GOOS}/${GOARCH})"
  curl -fsSL -o "${WORKDIR}/${TARBALL}" \
    "https://github.com/modelcontextprotocol/registry/releases/download/${MCP_PUBLISHER_VERSION}/${TARBALL}"

  # Verify against the registry's per-release checksums file. This is the
  # source of truth (signed via the release's attestation) and is the only
  # correct sha256 to check against for the per-platform tarball we picked.
  info "Verifying ${TARBALL} against the release's checksums.txt"
  curl -fsSL -o "${WORKDIR}/checksums.txt" \
    "https://github.com/modelcontextprotocol/registry/releases/download/${MCP_PUBLISHER_VERSION}/registry_${MCP_PUBLISHER_VERSION#v}_checksums.txt"
  # sha256sum on Linux/Git-Bash; shasum -a 256 is the macOS stock spelling.
  if command -v sha256sum >/dev/null; then
    (cd "$WORKDIR" && sha256sum -c --ignore-missing < checksums.txt) || fail "sha256 verification failed for ${TARBALL} -- refusing to run an unverified binary"
  else
    (cd "$WORKDIR" && shasum -a 256 -c --ignore-missing < checksums.txt) || fail "sha256 verification failed for ${TARBALL} -- refusing to run an unverified binary"
  fi

  # Windows tarballs extract to mcp-publisher.exe, POSIX ones to mcp-publisher.
  BIN_NAME="mcp-publisher"
  if [ "$GOOS" = "windows" ]; then BIN_NAME="mcp-publisher.exe"; fi
  tar -xzf "${WORKDIR}/${TARBALL}" -C "$WORKDIR" "$BIN_NAME"
  chmod +x "${WORKDIR}/${BIN_NAME}"
  "${WORKDIR}/${BIN_NAME}" --help >/dev/null
  info "mcp-publisher ${MCP_PUBLISHER_VERSION} ready (sha256 verified)"

  # Auth: the registry's `login github` accepts a pre-set GitHub token via
  # `MCP_GITHUB_TOKEN` (or `--token`) and skips the OAuth device flow -- it
  # exchanges the GitHub token for a fresh Registry JWT and writes it to
  # ~/.config/mcp-publisher/token.json.
  TOKEN_FILE="${HOME}/.config/mcp-publisher/token.json"
  # Return 0 (true in shell `if`) iff the persisted token is missing, unparseable,
  # or expired. Reads the JWT's `exp` claim via node so we don't reinvent the
  # JWT parser in bash.
  TOKEN_STATUS=$(mktemp)
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    if (!fs.existsSync(path)) { process.stdout.write("missing"); process.exit(0); }
    let t;
    try { t = JSON.parse(fs.readFileSync(path, "utf-8")); } catch { process.stdout.write("unparseable"); process.exit(0); }
    const p = (t.token || "").split(".")[1];
    if (!p) { process.stdout.write("unparseable"); process.exit(0); }
    let claims;
    try { claims = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { process.stdout.write("unparseable"); process.exit(0); }
    if (typeof claims.exp === "number" && claims.exp * 1000 > Date.now()) {
      process.stdout.write("valid");
    } else {
      process.stdout.write("expired");
    }
  ' "$TOKEN_FILE" > "$TOKEN_STATUS" 2>/dev/null || echo "unparseable" > "$TOKEN_STATUS"
  TOKEN_STATE=$(cat "$TOKEN_STATUS")
  rm -f "$TOKEN_STATUS"
  if [ "$TOKEN_STATE" != "valid" ]; then
    # Token refresh needs a GitHub token with publish rights on
    # `io.github.YawLabs/*` (per the prior release memory for the parallel
    # ssh-mcp repo, the MCP Registry `mcp-publisher` auth needs `read:org`).
    # Resolution order:
    #   1. $GITHUB_TOKEN (explicit env, takes priority -- the operator's
    #      workstation with a fine-grained PAT)
    #   2. $MCP_REGISTRY_TOKEN (an explicit override name some setups use)
    #   3. `gh auth token` (works on any host that has the `gh` CLI
    #      authenticated -- the established fallback for the parallel
    #      ssh-mcp / npmjs-mcp release scripts per their memory)
    # The mcp-publisher binary only needs a GitHub token at login time; it
    # persists its own registry JWT to ${TOKEN_FILE} afterward, so the
    # GitHub token does NOT need to be in env for subsequent releases.
    # Same resolution the pre-flight probe ran, through the shared helper so
    # the two cannot drift. The info() stays HERE rather than inside the
    # helper: the helper's stdout is captured, so anything printed in it would
    # be concatenated into the token itself.
    REGISTRY_GH_TOKEN=$(mcp_registry_gh_token)
    if [ -n "$REGISTRY_GH_TOKEN" ] && [ -z "${GITHUB_TOKEN:-}" ] && [ -z "${MCP_REGISTRY_TOKEN:-}" ]; then
      info "MCP-registry auth: using \`gh auth token\` (fallback)"
    fi
    if [ -z "$REGISTRY_GH_TOKEN" ]; then
      fail "mcp-publisher token ${TOKEN_STATE} and no GitHub token available. Set GITHUB_TOKEN (a PAT with publish rights on io.github.YawLabs/*), or run \`gh auth login\` so the \`gh auth token\` fallback works, or run once interactively: ${WORKDIR}/${BIN_NAME} login github"
    fi
    info "MCP-registry token ${TOKEN_STATE} -- refreshing via \`mcp-publisher login github\`"
    MCP_GITHUB_TOKEN="$REGISTRY_GH_TOKEN" "${WORKDIR}/${BIN_NAME}" login github
  else
    info "Reusing persisted mcp-publisher token at ${TOKEN_FILE}"
  fi

  "${WORKDIR}/${BIN_NAME}" publish
  info "Published server.json to MCP registry"
fi

# Final verification across the channels this script owns: npm (its version
# AND the CONTENT of the tarball it is serving), the MCP registry, the local
# package.json, and the local git tag.
#
# Two things this block used to claim rather than check. (1) It compared
# version STRINGS only, and a version string proves a push happened, not that
# what is being served is what this run built. (2) The comment named the MCP
# registry as one of the channels and the banner below says "released to npm +
# MCP registry", while nothing ever read the registry back -- its success was
# inferred from mcp-publisher's exit code alone, even though a parsed registry
# read already existed in step 5.
echo ""
echo -e "${CYAN}Verifying...${NC}"
NPM_FINAL=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$NPM_FINAL" = "$VERSION" ]; then
  info "npm: @yawlabs/mcp@${NPM_FINAL}"
else
  warn "npm shows ${NPM_FINAL:-nothing} (expected $VERSION)"
fi

# CONTENT, not the version string. An npm tarball is content-addressed: `npm
# pack` normalizes the metadata a tar carries per host (mtime, uid/gid, mode),
# so re-packing the same tree reproduces the exact sha512 integrity the
# registry reports for the published tarball. Measured on this package rather
# than assumed -- two `tsup` builds through `clean: true` plus two
# `npm pack --dry-run --json` runs gave byte-identical integrity across fresh
# mtimes. That makes this the one check that can answer "are the bytes on npm
# the bytes this run built?".
#
# --dry-run writes no tarball and runs no prepublishOnly rebuild, so it is
# cheap and side-effect free. The JSON on stdout is authoritative rather than
# npm's exit code -- the ARM64 exit-cleanup segfault lands AFTER the report,
# the same rule every other npm call in this script follows. Fail-OPEN
# throughout: an unreadable integrity on either side warns that the comparison
# could not run. Nothing here can fail the release, which has already gone out
# and cannot be taken back.
PUBLISHED_INTEGRITY=$(npm view "@yawlabs/mcp@${VERSION}" dist.integrity 2>/dev/null | tr -d '[:space:]' || echo "")
LOCAL_INTEGRITY=$(npm pack --dry-run --json 2>/dev/null | node -e '
  let s = "";
  process.stdin.on("data", (d) => { s += d; });
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(s);
      const first = Array.isArray(j) ? j[0] : j;
      process.stdout.write((first && first.integrity) || "");
    } catch { process.stdout.write(""); }
  });
' | tr -d '[:space:]' || echo "")
if [ -z "$PUBLISHED_INTEGRITY" ] || [ -z "$LOCAL_INTEGRITY" ]; then
  warn "Could not compare the published tarball to this build (npm reported '${PUBLISHED_INTEGRITY:-nothing}', local pack reported '${LOCAL_INTEGRITY:-nothing}') -- the version string above is the only npm evidence this run has."
elif [ "$PUBLISHED_INTEGRITY" = "$LOCAL_INTEGRITY" ]; then
  info "npm tarball: content matches this build"
elif [ "$NPM_PUBLISHED_THIS_RUN" = true ]; then
  warn "npm is serving a DIFFERENT tarball than this run packed for ${VERSION} (published ${PUBLISHED_INTEGRITY}, local ${LOCAL_INTEGRITY}). npm forbids re-publishing a version, so the recovery is a new version cut from the tree you intended to ship."
else
  warn "${VERSION} was already on npm and its tarball differs from the current tree (published ${PUBLISHED_INTEGRITY}, local ${LOCAL_INTEGRITY}) -- expected when commits landed after the tag that published it. The tag describes what shipped, not HEAD."
fi

# The MCP registry, read back rather than inferred from an exit code. Polled:
# mcp-publisher's write path returns before the read path lists the version,
# which is the same lag step 5 polls npm for, so a single miss here would warn
# on a healthy release.
REGISTRY_FINAL=false
for REGISTRY_TRY in 1 2 3; do
  if registry_has_version "$VERSION"; then
    REGISTRY_FINAL=true
    break
  fi
  if [ "$REGISTRY_TRY" -lt 3 ]; then sleep 5; fi
done
if [ "$REGISTRY_FINAL" = true ]; then
  info "MCP registry: io.github.YawLabs/mcp@${VERSION}"
else
  warn "The MCP registry does not list io.github.YawLabs/mcp@${VERSION} after 3 reads. Re-run ./release.sh ${VERSION} -- steps 1-4 no-op once published, and step 5 will re-publish if the version really is absent."
fi

PKG_FINAL=$(current_pkg_version)
if [ "$PKG_FINAL" = "$VERSION" ]; then
  info "package.json: ${PKG_FINAL}"
else
  warn "package.json shows ${PKG_FINAL} (expected $VERSION)"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "git tag: v${VERSION}"
else
  warn "git tag v${VERSION} not found"
fi

echo ""
# The banner reports what was VERIFIED, not what was attempted. Asserting
# "released to npm + MCP registry" three lines under a warning saying the
# registry does not list it is how a half-finished release gets closed out.
if [ "$REGISTRY_FINAL" = true ]; then
  echo -e "${GREEN}  v${VERSION} released to npm + MCP registry.${NC}"
else
  echo -e "${YELLOW}  v${VERSION} released to npm; the MCP registry did not confirm the listing (see above).${NC}"
fi
echo ""
echo -e "  npm:        https://www.npmjs.com/package/@yawlabs/mcp"
echo -e "  registry:   https://registry.modelcontextprotocol.io"
echo ""
echo -e "  Install:    ${CYAN}npm install -g @yawlabs/mcp${NC}"
echo -e "  Or run:     ${CYAN}npx -y @yawlabs/mcp${NC}"
echo ""
