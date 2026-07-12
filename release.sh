#!/bin/bash
# =============================================================================
# Release Script -- Bump, tag, publish to npm + MCP registry. Per-host
# build orchestration matches Yaw Terminal's `release.sh` shape: each
# host runs this script locally, the script builds that host's SEA
# binary, commits + tags + pushes, and publishes the two registry
# channels. NO GitHub release creation, NO `gh` calls in the main path.
# =============================================================================
# Replaces the previous .github/workflows/release.yml-driven flow. The
# .github/workflows/ directory is intentionally EMPTY (see the
# `gh` strip-out 2026-...) -- CI was already ripped out of the parent
# Yaw Terminal project; the MCP repo follows the same shape. The script
# is the single source of truth: it runs the pre-flight gates (lint,
# typecheck, tests, build), bumps package.json + server.json in
# lockstep, commits and tags, publishes to npm via the ~/.npmrc
# automation token, publishes server.json to the MCP registry via
# mcp-publisher, and prints the next-step handoff (asset attach to the
# GitHub release is a SEPARATE `./release.sh --upload-asset` step that
# the operator runs on a machine with $GITHUB_TOKEN, NOT on the
# per-host build machine).
#
# Usage:
#   ./release.sh <version>                  -- full release from the workstation
#   ./release.sh --build-only <version>     -- build this platform's SEA binary
#                                              to dist-release/; do not tag/push.
#                                              Run the upload step afterwards.
#   ./release.sh --upload-asset <path> <version>
#                                            -- attach <path> (and <path>.sha256
#                                              if present) to the GitHub Release
#                                              of <version>. Idempotent. Uses
#                                              curl + $GITHUB_TOKEN (NOT `gh`)
#                                              so it can run on any host with
#                                              the token in env, no `gh` install.
#
# Environment:
#   SKIP_CONFIRM=1                 skip the y/N confirm prompt
#   NO_COLOR=1                     disable ANSI colors
#   GITHUB_TOKEN                   required by --upload-asset (a fine-grained
#                                  PAT with `contents: write` on YawLabs/mcp).
#                                  Not required by the main release path or
#                                  --build-only.
#
# Required tools on PATH: node, npm, curl, tar, sha256sum, openssl.
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
# `gh` is intentionally NOT required on any path. The per-host legs
# run --build-only (which doesn't publish), the main release path
# commits+tags+pushes (regular git) and publishes to npm + the MCP
# registry, and the operator's workstation runs --upload-asset (curl
# + $GITHUB_TOKEN, no `gh`). No path needs the GitHub CLI.

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
# Attach a binary (and its .sha256 sidecar, if present) to an existing
# GitHub release. The per-host build machines do NOT run this -- they
# only run --build-only and produce dist-release/<asset>. The OPERATOR
# runs --upload-asset on the WORKSTATION (which has $GITHUB_TOKEN) after
# each per-host artifact arrives. Idempotent: the GitHub API returns a
# 422 "already_exists" for a re-upload, which we treat as success.
#
# Uses curl + $GITHUB_TOKEN against the GitHub REST API. NO `gh` CLI --
# the per-host machines don't have it installed, and a fine-grained PAT
# in env is enough on the workstation.
if [ "$SUBCOMMAND" = "upload-asset" ]; then
  : "${GITHUB_TOKEN:?GITHUB_TOKEN env var required for --upload-asset (fine-grained PAT with contents: write on YawLabs/mcp)}"
  command -v curl >/dev/null || fail "curl not installed (required for --upload-asset)"

  GH_REPO="YawLabs/mcp"
  GH_API="https://api.github.com"
  GH_AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")

  TOTAL_STEPS=3
  step 1 "Validate"
  [ -f "$UPLOAD_ASSET" ] || fail "--upload-asset path does not exist: $UPLOAD_ASSET"
  # Tag existence via plain git (no `gh`).
  if ! git ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | grep -qE 'refs/tags/v[0-9]'; then
    fail "Tag v${VERSION} not found on origin -- run the main release path on the release-driver machine first."
  fi
  # Release existence + capture release id (needed for the asset upload URL).
  # -f (--fail) surfaces HTTP 401/403/404 in curl's exit code; without it a
  # bad token / wrong repo / typo'd tag all return a 200 + HTML error body
  # and the empty-REL_ID check below would just say "release not found"
  # with no hint about why. --fail-with-body still prints the body so the
  # operator can see the GitHub error message.
  REL_JSON=$(curl -sS -f --fail-with-body "${GH_AUTH[@]}" "${GH_API}/repos/${GH_REPO}/releases/tags/v${VERSION}" 2>&1) || fail "could not read release v${VERSION} from GitHub -- check GITHUB_TOKEN, repo, and that the release exists (HTTP error above)"
  REL_ID=$(echo "$REL_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).id||""))}catch{process.stdout.write("")}})')
  if [ -z "$REL_ID" ]; then
    fail "GitHub release v${VERSION} does not exist -- create it first (curl -X POST ${GH_API}/repos/${GH_REPO}/releases ... or run the main release path on the release-driver machine which creates the empty release as a side effect of --upload-asset init)."
  fi
  info "Tag v${VERSION} and release id ${REL_ID} present on origin"

  step 2 "Upload asset"
  # Upload via the assets endpoint. -L follows the 422 redirect to a
  # useful error body; --fail-with-body surfaces 4xx/5xx in $? for the
  # "already exists" check below. -H "Content-Length: 0" is the
  # recommended probe pattern for the existence-only path.
  upload_asset() {
    local file="$1"
    local name
    name=$(basename "$file")
    local mime
    case "$name" in
      *.sha256) mime="text/plain" ;;
      *.exe)    mime="application/vnd.microsoft.portable-executable" ;;
      *)        mime="application/octet-stream" ;;
    esac
    info "Attaching $name to v${VERSION}"
    local resp
    resp=$(curl -sS -w "\n%{http_code}" -X POST \
      "${GH_AUTH[@]}" \
      -H "Content-Type: ${mime}" \
      --data-binary "@${file}" \
      "${GH_API}/repos/${GH_REPO}/releases/${REL_ID}/assets?name=${name}")
    local code
    code=$(echo "$resp" | tail -n1)
    local body
    body=$(echo "$resp" | sed '$d')
    case "$code" in
      201) return 0 ;;
      422)
        # 422 = validation failed; "already_exists" is one of the
        # well-known causes for asset upload. Treat as idempotent success.
        if echo "$body" | grep -qi 'already_exists'; then
          warn "$name already attached (treating as success)"
          return 0
        fi
        warn "$name upload returned 422: $body"
        return 1
        ;;
      *)
        warn "$name upload failed (HTTP $code): $body"
        return 1
        ;;
    esac
  }
  upload_asset "$UPLOAD_ASSET" || fail "asset upload failed -- see warnings above"
  if [ -f "${UPLOAD_ASSET}.sha256" ]; then
    upload_asset "${UPLOAD_ASSET}.sha256" || warn "sha256 sidecar upload failed (non-fatal)"
  fi

  step 3 "Verify"
  # -f surfaces HTTP errors in curl's exit code (the previous shape -- a
  # bare `curl -sS` -- would 200 an HTML error body on a 401/403/404 and
  # the empty-REL_ASSETS path would just say "asset not visible" with
  # no hint about the actual cause).
  REL_ASSETS=$(curl -sS -f --fail-with-body "${GH_AUTH[@]}" "${GH_API}/repos/${GH_REPO}/releases/${REL_ID}" 2>&1) || fail "could not read release v${VERSION} assets from GitHub (HTTP error above)"
  REL_ASSETS=$(echo "$REL_ASSETS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write((JSON.parse(d).assets||[]).map(a=>a.name).join("\n"))}catch{process.stdout.write("")}})')
  if echo "$REL_ASSETS" | grep -qxF "$(basename "$UPLOAD_ASSET")"; then
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

# `gh` is NOT required on the main release path -- the main path
# creates a git tag and pushes it (regular git commands), publishes to
# npm (npm CLI), and publishes server.json to the MCP registry
# (mcp-publisher). The GitHub *release* (with attached assets) is a
# SEPARATE step the operator runs via --upload-asset on a host that has
# $GITHUB_TOKEN; the per-host build machines never need to know about
# the release. (node/npm pre-flighted at 186-187; no need to re-check here.)

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
  echo "  8. Hand off this platform's binary for GitHub release attach (operator runs ./release.sh --upload-asset on the workstation)"
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
# mcp-publisher ships a tarball per (platform, arch). Map the current host to
# the matching tarball name so this works on a Linux, macOS, or Windows
# release-driver machine -- the old CI workflow was Linux-only.
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
(cd "$WORKDIR" && sha256sum -c --ignore-missing < checksums.txt) || fail "sha256 verification failed for ${TARBALL} -- refusing to run an unverified binary"

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
# ~/.config/mcp-publisher/token.json. The old CI used `login github-oidc`
# which mints a GitHub Actions OIDC token (requires `id-token: write` --
# Actions only); the workstation path uses
# `MCP_GITHUB_TOKEN=$GITHUB_TOKEN` directly, which is equivalent for our
# purposes since GITHUB_TOKEN is a YawLabs maintainer PAT with publish
# rights to the io.github.YawLabs/* namespace. No `gh` CLI required.
TOKEN_FILE="${HOME}/.config/mcp-publisher/token.json"
TOKEN_REFRESHED=false
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
  # Refresh via $GITHUB_TOKEN (regular env var, not `gh auth token`) so
  # the per-host build machines that don't have the gh CLI installed
  # can still publish the MCP-registry side. The operator exports
  # GITHUB_TOKEN once on the workstation; per-host machines that need
  # to publish server.json get it via the release orchestrator's env.
  if [ -z "${GITHUB_TOKEN:-}" ]; then
    fail "mcp-publisher token ${TOKEN_STATE} and GITHUB_TOKEN is not set. Export GITHUB_TOKEN (a GitHub PAT with publish rights to the io.github.YawLabs/* MCP namespace) and re-run, or run once interactively: ${WORKDIR}/${BIN_NAME} login github"
  fi
  info "MCP-registry token ${TOKEN_STATE} -- refreshing via \`mcp-publisher login github\` (non-interactive: GITHUB_TOKEN is set)"
  MCP_GITHUB_TOKEN="$GITHUB_TOKEN" "${WORKDIR}/${BIN_NAME}" login github
  TOKEN_REFRESHED=true
else
  info "Reusing persisted mcp-publisher token at ${TOKEN_FILE}"
fi

"${WORKDIR}/${BIN_NAME}" publish
info "Published server.json to MCP registry"

step 8 "Hand off per-platform binary uploads"
# Re-read dist-release/ at this point -- a re-run after a partial failure
# shouldn't fail because the asset is "already there".
ASSET=$(ls dist-release/ 2>/dev/null | grep -v '\.sha256$' | head -1)
SHA_SIDE=$(ls dist-release/*.sha256 2>/dev/null | head -1)
[ -n "$ASSET" ] || fail "No asset in dist-release/ to attach"

# The GitHub release + asset attach is NOT this script's job (no `gh`,
# no GHA). The per-host build machine produced dist-release/<asset>;
# the operator's workstation (with $GITHUB_TOKEN in env) attaches it
# via the SEPARATE `./release.sh --upload-asset` subcommand once all
# five per-host artifacts have arrived. Print the exact next-step
# command so the transcript records what to run, then leave the
# artifact in dist-release/ for the operator to scp/collect.
if [ -n "$ASSET" ]; then
  info "Per-host artifact: dist-release/${ASSET}"
  info "Attach it from the workstation with:"
  info "  ./release.sh --upload-asset dist-release/${ASSET} ${VERSION}"
fi
# Don't rm -rf dist-release/ here -- the operator needs the artifact
# to run --upload-asset. The per-host --build-only subcommand does the
# cleanup at its own exit (see that branch's rm of dist-release/).

# Final verification across the channels this script owns: npm, the
# MCP registry, and the local git tag. GitHub release verification is
# the operator's job once they finish --upload-asset for all five
# platforms.
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

echo ""
echo -e "${GREEN}  v${VERSION} released to npm + MCP registry.${NC}"
echo ""
echo -e "  npm:        https://www.npmjs.com/package/@yawlabs/mcp"
echo -e "  registry:   https://registry.modelcontextprotocol.io"
echo ""
echo -e "  ${CYAN}This platform's${NC} binary is in dist-release/ on this machine."
echo -e "  Move it to the workstation (which has \$GITHUB_TOKEN) and run:"
echo -e "    ${CYAN}./release.sh --upload-asset dist-release/<asset> ${VERSION}${NC}"
echo -e "  Repeat on each of the other 4 build hosts; the same ./release.sh"
echo -e "  --upload-asset call attaches each artifact to the same release."
echo -e "  This is the only step that needs the GitHub token (curl +\$GITHUB_TOKEN, no \`gh\`)."
echo ""
