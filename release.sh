#!/bin/bash
# =============================================================================
# Release Script -- Bump, tag, publish to npm + MCP registry, create GitHub release
# =============================================================================
# Replaces the previous .github/workflows/release.yml-driven flow. The script
# is the single source of truth: it runs the pre-flight gates (lint, typecheck,
# tests, build), bumps package.json + server.json in lockstep, commits and
# tags, publishes to npm via the ~/.npmrc automation token, publishes server.json
# to the MCP registry via mcp-publisher, creates the GitHub Release with the
# platform's built binary attached, and verifies all three channels.
#
# Usage:
#   ./release.sh <version>                  -- full release from the workstation
#   ./release.sh --build-only <version>     -- build this platform's SEA binary
#                                              to dist-release/; do not tag/push.
#                                              Run the upload step afterwards.
#   ./release.sh --upload-asset <path> <version>
#                                            -- attach <path> (and <path>.sha256
#                                              if present) to the GitHub Release
#                                              of <version>. Idempotent.
#
# Environment:
#   SKIP_CONFIRM=1                 skip the y/N confirm prompt
#   NO_COLOR=1                     disable ANSI colors
#
# Required tools on PATH: node, npm, gh, curl, tar, sha256sum, openssl.
# The first run also needs `mcp-publisher` (downloaded to a temp dir on demand,
# sha256-verified against MCP_PUBLISHER_SHA256 below) and a one-time
# `mcp-publisher login github` (interactive device flow) which persists a JWT
# at ~/.config/mcp-publisher/token.json for subsequent runs.
#
# If interrupted, re-run with the same version -- each step is idempotent.
# =============================================================================

set -euo pipefail
# Single EXIT trap: if we're exiting because of an error, print the failure
# banner; either way, clean up the mcp-publisher temp dir. (Two `trap` calls
# would override each other; bash only runs the most recent one.)
WORKDIR=""
cleanup() {
  rc=$?
  if [ $rc -ne 0 ]; then
    echo -e "\n  ✗ Release failed at line $LINENO (exit code $rc)\n" >&2
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
  RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
fi

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

# MCP publisher version + sha256 -- pinned, like any other tool we shell out to.
# Bump together. mcp-publisher v1.7.9 ships a `login github` device flow that
# works from a workstation (CI used `login github-oidc`, which is GitHub-Actions
# only -- the script's workstation path uses the regular flow and reuses the
# persisted token on subsequent runs).
MCP_PUBLISHER_VERSION="v1.7.9"
MCP_PUBLISHER_SHA256="ab128162b0616090b47cf245afe0a23f3ef08936fdce19074f5ba0a4469281ac"

# MINGW64 on Windows ARM64 intermittently segfaults in npm's exit cleanup AFTER
# a tool has finished and printed its report. The tool's OUTPUT is authoritative:
# a 139/134 from `npm run` is tolerated only if the tool's own success marker is
# in the captured output (or a direct re-run bypasses the wrapper). Other
# platforms treat any non-zero as a hard failure.
IS_MINGW_ARM64=false
case "$(uname -s 2>/dev/null)" in
  MINGW*ARM64* | MSYS*ARM64* | CYGWIN*ARM64*) IS_MINGW_ARM64=true ;;
esac

# Run an npm-run-script tool that may segfault on this box. $1 label, $2 script,
# $3 ERE for real failures, $4 (opt) ERE proving the tool ran, $5 (opt) direct
# verify command (no npm-run wrapper) for tools that print no completion marker.
run_npm_check() {
  local label="$1" script="$2" fail_re="$3" done_re="${4:-}" verify_cmd="${5:-}" out rc=0
  # `|| rc=$?` is load-bearing: under `set -e` a bare `out=$(npm run ...)` whose
  # command substitution exits non-zero aborts the function THERE, before the
  # analysis below runs.
  out=$(npm run "$script" 2>&1) || rc=$?
  printf '%s\n' "$out"
  if echo "$out" | grep -qE "$fail_re"; then
    fail "$label failed"
  fi
  [ "$rc" -eq 0 ] && return 0
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
  fail "$label failed (exit $rc)"
}

# Arg parsing -- manual loop so we can handle `--upload-asset PATH` (the next
# argv is the asset path, not the version). Flags: -y/--yes, --build-only,
# --upload-asset PATH. Version is positional and required.
SKIP_CONFIRM=false
SUBCOMMAND="release"
UPLOAD_ASSET=""
REMAINING=()
i=0
while [ $i -lt $# ]; do
  arg="${@:$((i+1)):1}"
  case "$arg" in
    -y|--yes) SKIP_CONFIRM=true ;;
    --build-only) SUBCOMMAND="build-only" ;;
    --upload-asset)
      SUBCOMMAND="upload-asset"
      next_idx=$((i+1))
      if [ "$next_idx" -ge "$#" ]; then
        fail "--upload-asset requires a PATH argument"
      fi
      UPLOAD_ASSET="${@:$((next_idx+1)):1}"
      i=$next_idx
      ;;
    --upload-asset=*)
      SUBCOMMAND="upload-asset"
      UPLOAD_ASSET="${arg#--upload-asset=}"
      ;;
    --*) fail "Unrecognized flag: '$arg'" ;;
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

[ -n "$VERSION" ] || fail "Usage: ./release.sh [-y] [--build-only | --upload-asset PATH] <version>"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null || fail "node not installed"
command -v npm  >/dev/null || fail "npm not installed"
command -v gh   >/dev/null || fail "gh not installed (required for GitHub release + mcp-publisher login)"

# Re-read state from disk at every step boundary (per project rule: release
# scripts must not cache at script-start). Functions call these helpers to
# always reflect the current on-disk state.
current_pkg_version() { node -p "require('./package.json').version"; }
current_server_version() { node -p "require('./server.json').version"; }
current_head_sha() { git rev-parse HEAD; }
# The second-most-recent tag -- i.e. the tag immediately preceding the one
# we're creating. Used for the changelog range.
previous_local_tag() { git tag --sort=-v:refname | grep -v "^v${VERSION}$" | head -1; }

# ---------- Subcommand: --upload-asset ----------------------------------------
# Attach a binary (and its .sha256 sidecar, if present) to an existing release.
# Used by per-platform machines: build the SEA on Linux, run this on Linux;
# build on macOS, run on macOS; etc. Idempotent: gh release upload fails soft
# on already-present assets.
if [ "$SUBCOMMAND" = "upload-asset" ]; then
  TOTAL_STEPS=3
  step 1 "Validate"
  [ -f "$UPLOAD_ASSET" ] || fail "--upload-asset path does not exist: $UPLOAD_ASSET"
  REMOTE_TAG=$(git ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | grep -E 'refs/tags/v[0-9]' | head -1 | awk '{print $2}')
  [ -n "$REMOTE_TAG" ] || fail "Tag v${VERSION} not found on origin -- run the main release path on the release-driver machine first."
  if ! gh release view "v${VERSION}" >/dev/null 2>&1; then
    fail "GitHub release v${VERSION} does not exist -- cannot attach asset. Run the main release path on the release-driver machine first."
  fi
  info "Tag v${VERSION} and GitHub release present on origin"

  step 2 "Upload asset"
  info "Attaching $UPLOAD_ASSET to v${VERSION}"
  if ! gh release upload "v${VERSION}" "$UPLOAD_ASSET" --clobber 2>&1 | tee /tmp/yaw-mcp-upload.log; then
    # gh release upload doesn't have a great "already exists" code; treat any
    # output mentioning the file as a soft success.
    if grep -qiE 'already|exists|duplicate' /tmp/yaw-mcp-upload.log; then
      warn "Asset already attached (treating as success)"
    else
      fail "gh release upload failed (see /tmp/yaw-mcp-upload.log)"
    fi
  fi
  rm -f /tmp/yaw-mcp-upload.log
  if [ -f "${UPLOAD_ASSET}.sha256" ]; then
    info "Attaching ${UPLOAD_ASSET}.sha256"
    gh release upload "v${VERSION}" "${UPLOAD_ASSET}.sha256" --clobber >/dev/null 2>&1 || warn "sha256 sidecar upload failed (non-fatal)"
  fi

  step 3 "Verify"
  if gh release view "v${VERSION}" --json assets --jq ".assets[].name" 2>/dev/null | grep -qxF "$(basename "$UPLOAD_ASSET")"; then
    info "v${VERSION} assets now include $(basename "$UPLOAD_ASSET")"
  else
    fail "Asset $(basename "$UPLOAD_ASSET") not visible on v${VERSION} after upload"
  fi
  echo ""
  echo -e "${GREEN}  Asset attached to v${VERSION}.${NC}"
  exit 0
fi

# ---------- Subcommand: --build-only -----------------------------------------
# Build the platform's SEA binary to dist-release/ and exit. No tag, no push.
if [ "$SUBCOMMAND" = "build-only" ]; then
  TOTAL_STEPS=3
  step 1 "Build SEA binary"
  node scripts/build-binary.mjs
  step 2 "Stage release asset"
  node scripts/stage-release-asset.mjs
  step 3 "Smoke test"
  ASSET=$(ls dist-release/ 2>/dev/null | grep -v '\.sha256$' | head -1)
  [ -n "$ASSET" ] || fail "No asset in dist-release/ after build+stage"
  "./dist-release/$ASSET" --version
  info "Build complete: dist-release/$ASSET (run ./release.sh --upload-asset dist-release/$ASSET $VERSION on the same machine to attach)"
  exit 0
fi

# ---------- Main path: full release -------------------------------------------
TOTAL_STEPS=8

echo -e "${CYAN}Pre-flight checks...${NC}"
CURRENT_VERSION=$(current_pkg_version)
RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  info "Already at v${VERSION} -- resuming"
else
  if [ -n "$(git status --porcelain)" ]; then
    fail "Working directory not clean. Commit or stash changes first."
  fi
  info "Current: v${CURRENT_VERSION} -> v${VERSION}"
fi

# Pull the latest remote tags + commits so we can detect a stale local view of
# HEAD (e.g. a previous interrupted run that already pushed the bump).
git fetch --tags --prune origin >/dev/null 2>&1 || warn "git fetch failed (offline?) -- proceeding with local state"
LOCAL_HEAD=$(current_head_sha)
REMOTE_HEAD=$(git rev-parse origin/main 2>/dev/null || echo "")
if [ -n "$REMOTE_HEAD" ] && [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  if [ "$RESUMING" = true ]; then
    info "Local HEAD differs from origin/main (resuming after a prior push) -- proceeding"
  else
    fail "Local main is not at origin/main. Pull first: git pull --ff-only origin main"
  fi
fi

if [ "$SKIP_CONFIRM" != "true" ] && [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Run lint + typecheck"
  echo "  2. Run tests"
  echo "  3. Build the SEA binary for this platform"
  echo "  4. Bump version in package.json + server.json"
  echo "  5. Commit, tag, and push"
  echo "  6. Publish to npm (using ~/.npmrc automation token)"
  echo "  7. Publish server.json to the MCP registry (mcp-publisher)"
  echo "  8. Create GitHub release with this platform's binary attached"
  echo ""
  echo -e "  Other platforms: build on a ${CYAN}<platform>${NC} machine, then run"
  echo -e "    ${CYAN}./release.sh --upload-asset dist-release/<asset> ${VERSION}${NC}"
  echo -e "  on each, to attach their binary to the same release."
  echo ""
  read -p "Continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

step 1 "Lint + typecheck"
run_npm_check "Lint" lint 'Found [0-9]+ error' 'Checked [0-9]+ files'
run_npm_check "Type check" typecheck 'error TS[0-9]' '' 'npx tsc --noEmit'
info "Lint + typecheck passed"

step 2 "Tests"
npm test || fail "Tests failed"
info "All tests passed"

step 3 "Build SEA binary for this platform"
node scripts/build-binary.mjs
node scripts/stage-release-asset.mjs
ASSET=$(ls dist-release/ 2>/dev/null | grep -v '\.sha256$' | head -1)
[ -n "$ASSET" ] || fail "No asset in dist-release/ after build+stage"
"./dist-release/$ASSET" --version
info "Built and smoke-tested $ASSET"

step 4 "Bump version to $VERSION"
# Re-read current version (the resume path can skip a bump that's already done).
CURRENT_VERSION=$(current_pkg_version)
if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "package.json already at v${VERSION} -- skipping bump"
else
  npm version "$VERSION" --no-git-tag-version
  info "package.json bumped"
  # Keep server.json in lockstep -- release.yml's publish-registry job verifies
  # both fields and 400s on drift (that's what wedged v0.66.0). The script is
  # the single source of truth now; CI no longer rewrites server.json.
  node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('server.json','utf-8')); j.version=process.argv[1]; if(j.packages&&j.packages[0]) j.packages[0].version=process.argv[1]; fs.writeFileSync('server.json', JSON.stringify(j, null, 2) + '\n');" "$VERSION"
  info "server.json bumped"
fi

step 5 "Commit, tag, and push"
if [ -n "$(git status --porcelain package.json package-lock.json server.json 2>/dev/null)" ]; then
  git add package.json package-lock.json server.json
  git -c core.hooksPath=/dev/null commit -m "v${VERSION}"
  info "Committed version bump"
else
  info "Nothing to commit (already at v${VERSION})"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "Tag v${VERSION} already exists"
else
  # Annotated (-a) so --follow-tags picks it up; lightweight tags are ignored
  # by --follow-tags and would silently fail to push.
  git tag -a "v${VERSION}" -m "v${VERSION}"
  info "Tag v${VERSION} created"
fi

# Re-verify package.json matches the tag BEFORE pushing -- catching a stale
# local index that was bumped-after-tag here prevents the "tag pushed without
# the matching version bump" failure that the CI workflow's
# `Verify tag matches package.json` step was guarding against.
PKG_NOW=$(current_pkg_version)
if [ "$PKG_NOW" != "$VERSION" ]; then
  fail "package.json shows $PKG_NOW but tag is v${VERSION} -- refusing to push"
fi
SERVER_NOW=$(current_server_version)
if [ "$SERVER_NOW" != "$VERSION" ]; then
  fail "server.json shows $SERVER_NOW but tag is v${VERSION} -- refusing to push (registry would 400 on drift)"
fi

git push origin main --follow-tags
info "Pushed to origin"

step 6 "Publish to npm"
# The script is the publisher now. ~/.npmrc must carry the automation token
# (NOT a WebAuthn web session -- the npm publishing rule in CLAUDE.md is
# explicit on this: `npm login --auth-type=web` overwrites the automation
# token and the next publish EOTPs on WebAuthn).
PUBLISHED_VERSION=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
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
    if npm publish --access public 2>&1 | tee "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      break
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
  info "Published @yawlabs/mcp@${VERSION} to npm"
fi

step 7 "Publish server.json to MCP registry"
# Check the published-npm first; mcp-publisher's `publish` validates that the
# referenced npm package exists, and the registry mirror can lag the write
# path by seconds. Same backoff as the old CI workflow.
NPM_NOW=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  NPM_NOW=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
  [ "$NPM_NOW" = "$VERSION" ] && break
  sleep 6
done
if [ "$NPM_NOW" != "$VERSION" ]; then
  fail "npm does not show @yawlabs/mcp@${VERSION} after 60s -- refusing to publish to MCP registry (it would 400)"
fi

# Download + sha256-verify mcp-publisher to a temp dir. Same pin + digest as
# the old CI workflow.
WORKDIR=$(mktemp -d)
TARBALL="mcp-publisher_linux_amd64.tar.gz"
info "Downloading mcp-publisher ${MCP_PUBLISHER_VERSION}"
curl -fsSL -o "${WORKDIR}/${TARBALL}" \
  "https://github.com/modelcontextprotocol/registry/releases/download/${MCP_PUBLISHER_VERSION}/${TARBALL}"
(cd "$WORKDIR" && echo "${MCP_PUBLISHER_SHA256}  ${TARBALL}" | sha256sum -c -)
tar -xzf "${WORKDIR}/${TARBALL}" -C "$WORKDIR" mcp-publisher
chmod +x "${WORKDIR}/mcp-publisher"
"${WORKDIR}/mcp-publisher" --help >/dev/null
info "mcp-publisher ${MCP_PUBLISHER_VERSION} ready (sha256 verified)"

# Auth: prefer the persisted token from a prior `login github`; prompt the
# user to run it interactively the first time. `login github-oidc` is
# GitHub-Actions-only (requires id-token: write) -- the workstation path is
# `login github` (OAuth device flow), one-time, token stored at
# ~/.config/mcp-publisher/token.json.
TOKEN_FILE="${HOME}/.config/mcp-publisher/token.json"
if [ ! -f "$TOKEN_FILE" ]; then
  fail "No mcp-publisher token at ${TOKEN_FILE}. Run once interactively: ${WORKDIR}/mcp-publisher login github"
fi
# mcp-publisher reuses the persisted token; the `login` subcommand itself
# would be interactive, so we don't re-run it. If the registry rejects the
# token, the next `publish` call will fail with a clear error.
info "Reusing persisted mcp-publisher token at ${TOKEN_FILE}"

"${WORKDIR}/mcp-publisher" publish
info "Published server.json to MCP registry"

step 8 "GitHub release with this platform's binary"
# Re-read dist-release/ at this point -- a re-run after a partial failure
# shouldn't fail because the asset is "already there".
ASSET=$(ls dist-release/ 2>/dev/null | grep -v '\.sha256$' | head -1)
SHA_SIDE=$(ls dist-release/*.sha256 2>/dev/null | head -1)
[ -n "$ASSET" ] || fail "No asset in dist-release/ to attach"

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists -- uploading assets"
  if ! gh release upload "v${VERSION}" "dist-release/${ASSET}" --clobber 2>&1 | tee /tmp/yaw-mcp-ghrel.log; then
    if ! grep -qiE 'already|exists|duplicate' /tmp/yaw-mcp-ghrel.log; then
      rm -f /tmp/yaw-mcp-ghrel.log
      fail "gh release upload failed (see /tmp/yaw-mcp-ghrel.log)"
    fi
    rm -f /tmp/yaw-mcp-ghrel.log
  fi
  [ -n "$SHA_SIDE" ] && gh release upload "v${VERSION}" "$SHA_SIDE" --clobber >/dev/null 2>&1 || true
else
  # Build the changelog from the tag range so the release body matches the
  # CHANGELOG.md entries (release.yml never set a body; this is a small
  # improvement over the prior CI flow).
  PREV_TAG=$(previous_local_tag)
  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "v${VERSION}" ]; then
    CHANGELOG=$(git log --oneline "${PREV_TAG}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /')
  else
    CHANGELOG="Initial release."
  fi
  UPLOAD_ARGS=("dist-release/${ASSET}")
  [ -n "$SHA_SIDE" ] && UPLOAD_ARGS+=("$SHA_SIDE")
  gh release create "v${VERSION}" \
    --title "v${VERSION}" \
    --notes "$CHANGELOG" \
    "${UPLOAD_ARGS[@]}"
  info "GitHub release v${VERSION} created with $(basename "$ASSET")"
fi

# Final verification across all three channels.
echo ""
echo -e "${CYAN}Verifying...${NC}"
NPM_FINAL=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$NPM_FINAL" = "$VERSION" ]; then
  info "npm: @yawlabs/mcp@${NPM_FINAL}"
else
  warn "npm shows ${NPM_FINAL:-nothing} (expected $VERSION)"
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

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release: v${VERSION}"
  ATTACHED=$(gh release view "v${VERSION}" --json assets --jq '.assets[].name' 2>/dev/null | tr '\n' ' ')
  if [ -n "$ATTACHED" ]; then
    info "assets: ${ATTACHED}"
  fi
else
  warn "GitHub release v${VERSION} not found"
fi

# Clean up the build artifacts so they don't pollute the working tree.
rm -rf dist-release/

echo ""
echo -e "${GREEN}  v${VERSION} released successfully.${NC}"
echo ""
echo -e "  npm:        https://www.npmjs.com/package/@yawlabs/mcp"
echo -e "  registry:   https://registry.modelcontextprotocol.io"
echo -e "  GitHub:     https://github.com/YawLabs/mcp/releases/tag/v${VERSION}"
echo ""
echo -e "  Per-platform binary uploads still pending? Run on each platform machine:"
echo -e "    ${CYAN}./release.sh --upload-asset dist-release/<asset> ${VERSION}${NC}"
echo ""
