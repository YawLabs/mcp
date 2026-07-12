#!/usr/bin/env bash
# Ephemeral win32-x64 build: spin up a Windows 2022 GCP VM, build the
# @yawlabs/mcp SEA binary on it, attach it to the GitHub release, and
# ALWAYS delete the VM (even on Ctrl-C). The Windows VM is the most
# expensive idle resource in our fleet -- a forgotten n2-standard-2 is
# ~$50/mo. The EXIT trap makes "I forgot to delete it" structurally
# impossible.
#
# Why a wrapper around the existing orchestrator (scripts/build-platforms-all.sh)
# instead of a new build path: the orchestrator already handles tar+scp
# + remote leg + artifact verification. The only thing missing for
# win32-x64 is the BUILD HOST itself. So this script's job is narrower:
# (1) create VM, (2) wait for ready, (3) run the orchestrator with
# --only win32-x64, (4) attach, (5) delete. Nothing else.
#
# Headless bootstrap (no RDP, no serial console, no password reset):
# we use a Windows startup-script-ps1 metadata entry to install
# OpenSSH, drop the GCP ssh pubkey into authorized_keys, open the
# firewall, and start sshd. The script runs as SYSTEM on first boot,
# before any user session. After it completes, `gcloud compute ssh
# --tunnel-through-iap` works normally.
#
# Quota prerequisite: the GCP project must have at least 2 vCPUs
# headroom in CPUS_ALL_REGIONS. Current usage is 12/12 (linux-builder
# + GKE nodes); bump to 16 via the GCP console before running this
# script. If quota is exhausted, gcloud create fails with
# ZONE_RESOURCE_POOL_EXHAUSTED or QUOTA_EXCEEDED -- the script surfaces
# that error verbatim rather than masking it.
#
# Usage:
#   scripts/build-win-x64-ephemeral.sh <version>
#
# Example:
#   scripts/build-win-x64-ephemeral.sh 0.70.2
#
# Idempotency: re-running with the VM already up is treated as a
# "resume" (uses the existing VM instead of creating a new one). This
# matters because a Ctrl-C between build-start and attach leaves the VM
# up; re-running attaches without burning a second create/delete cycle.
#
# Environment:
#   GCP_PROJECT        override project (default: yaw-labs-prod, the
#                      same project the linux-builder lives in)
#   GCP_ZONE           override zone (default: us-central1-a, same as
#                      yaw-linux-builder for network locality)
#   WIN_INSTANCE_NAME  override VM name (default: yaw-win-x64-builder)
#   WIN_MACHINE_TYPE   override machine type (default: n2-standard-2)
#                      bump to n2-standard-4 if the build OOMs (rare;
#                      the SEA build is mostly CPU-bound)
#   SKIP_DELETE=1      keep the VM up after the script exits (for
#                      debugging). The trap honors this; the next
#                      normal run will resume the existing VM.
#   GITHUB_TOKEN       required for the attach step. If unset, falls
#                      back to `gh auth token` like release.sh does.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>" >&2
  exit 64
fi
VERSION="$1"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid version: $VERSION (expected X.Y.Z)" >&2
  exit 64
fi

GCP_PROJECT="${GCP_PROJECT:-yaw-labs-prod}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
WIN_INSTANCE_NAME="${WIN_INSTANCE_NAME:-yaw-win-x64-builder}"
WIN_MACHINE_TYPE="${WIN_MACHINE_TYPE:-n2-standard-2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGING_DIR="$REPO_ROOT/.build-staging"

# ---- Pre-flight ----
command -v gcloud >/dev/null || { echo "gcloud CLI not installed" >&2; exit 1; }
command -v ssh    >/dev/null || { echo "ssh not installed" >&2; exit 1; }
command -v scp    >/dev/null || { echo "scp not installed" >&2; exit 1; }

# Confirm gcloud is authed (a stale credential silently produces
# cryptic errors later; better to fail fast here).
if ! gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | grep -q .; then
  echo "gcloud has no active account -- run: gcloud auth login" >&2
  exit 1
fi

# Tag v${VERSION} must exist on origin (mirrors the orchestrator's gate).
if ! git -C "$REPO_ROOT" ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | grep -qE 'refs/tags/v[0-9]'; then
  echo "Tag v${VERSION} not found on origin -- push the tag first" >&2
  exit 1
fi

# ---- VM lifecycle: create-or-resume, with unconditional delete ----
# The VM is the expensive resource. Anything that exits non-zero from
# this point MUST delete the VM. The trap fires on EXIT (success,
# failure, Ctrl-C, SIGTERM) and on ERR (a command inside the trap's
# caller). We track VM_CREATED so the trap only deletes if WE created
# (resumed VMs the user wants to keep around are out of scope -- the
# next run will reuse them). We also track STARTUP_SCRIPT so the trap
# cleans up the temp file. ONE trap, both concerns -- chaining traps
# would clobber the earlier one.
VM_CREATED=0
STARTUP_SCRIPT=""
delete_vm() {
  local rc=$?
  # Clean up the temp file first (cheap, no I/O wait).
  if [ -n "$STARTUP_SCRIPT" ] && [ -f "$STARTUP_SCRIPT" ]; then
    rm -f "$STARTUP_SCRIPT"
  fi
  if [ "${SKIP_DELETE:-0}" = "1" ]; then
    echo "[ephemeral-win] SKIP_DELETE=1 -- leaving $WIN_INSTANCE_NAME running" >&2
    return 0
  fi
  if [ "$VM_CREATED" -eq 0 ]; then
    # We didn't create it (resumed an existing VM); don't delete what
    # isn't ours. The next run reuses it.
    return 0
  fi
  echo "[ephemeral-win] EXIT trap: deleting $WIN_INSTANCE_NAME (release rc=$rc)" >&2
  gcloud compute instances delete "$WIN_INSTANCE_NAME" \
    --project="$GCP_PROJECT" --zone="$GCP_ZONE" --quiet 2>&1 | tail -5 >&2 || \
    echo "[ephemeral-win] WARNING: VM delete failed -- check GCP console" >&2
}
trap delete_vm EXIT

# Check if the VM already exists (resume path).
if gcloud compute instances describe "$WIN_INSTANCE_NAME" \
     --project="$GCP_PROJECT" --zone="$GCP_ZONE" >/dev/null 2>&1; then
  echo "[ephemeral-win] reusing existing VM $WIN_INSTANCE_NAME (resume)" >&2
  VM_CREATED=0
else
  echo "[ephemeral-win] creating $WIN_INSTANCE_NAME ($WIN_MACHINE_TYPE) in $GCP_ZONE" >&2

  # Windows startup script: install OpenSSH, drop the GCP ssh pubkey,
  # open the firewall, start the service. Runs as SYSTEM on first
  # boot, before any user session. The pubkey path matches what
  # `gcloud compute ssh` writes when --metadata=enable-oslogin=FALSE
  # is set: C:\Users\<user>\.ssh\authorized_keys for the user
  # matching the SSH client username.
  STARTUP_SCRIPT=$(mktemp --suffix=.ps1)
  SSH_PUBKEY=$(cat ~/.ssh/google_compute_engine.pub)
  cat > "$STARTUP_SCRIPT" <<PS1_EOF
# Auto-installed by scripts/build-win-x64-ephemeral.sh on first boot.
\$ErrorActionPreference = 'Stop'

# Install OpenSSH Server (the windows-2022 image ships the capability
# but does not install it by default).
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null

# Start sshd + persist across reboots
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'

# Open the firewall. IAP tunnel doesn't need a public IP, but the SSH
# port must accept inbound on the VM's NIC. Default rule name matches
# what the OpenSSH feature install creates.
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}

# Drop the GCP ssh pubkey into the orchestrator user's authorized_keys.
# gcloud compute ssh defaults to the local username (jeff on this box);
# match it on the Windows side.
\$UserName = [System.Environment]::UserName
# On first boot the script runs as SYSTEM; the target user is the
# one gcloud will connect as. For jeff@, the path is
# C:\Users\jeff\.ssh\authorized_keys.
\$TargetUser = 'jeff'
\$SshDir = "C:\\Users\\\$TargetUser\\.ssh"
if (-not (Test-Path \$SshDir)) {
  New-Item -Path \$SshDir -ItemType Directory -Force | Out-Null
}
\$AuthKeys = Join-Path \$SshDir 'authorized_keys'
Set-Content -Path \$AuthKeys -Value '$SSH_PUBKEY' -Encoding UTF8

# Mark the boot complete so the wait loop in the wrapper can detect
# readiness. A sentinel file is more reliable than parsing serial-port
# output (which can lag by 30s+). The wrapper polls for this file
# via gcloud compute ssh --command.
\$DoneDir = "C:\\ProgramData\\mcp-build"
if (-not (Test-Path \$DoneDir)) {
  New-Item -Path \$DoneDir -ItemType Directory -Force | Out-Null
}
Set-Content -Path "\$DoneDir\\startup-script-complete" -Value (Get-Date -Format o) -Encoding UTF8
PS1_EOF

  # Create the VM. We pass --metadata-from-file=windows-startup-script-ps1=
  # so the script is run as SYSTEM on first boot. --scopes=cloud-platform
  # lets gcloud compute ssh work without a separate service-account key.
  # enable-oslogin=FALSE so the standard authorized_keys path is used
  # (OS Login's path is C:\Users\<user>\.ssh\google_authorized_keys, which
  # is harder to set up headlessly).
  #
  # --network-tier=PREMIUM + an implicit ephemeral external IP: the
  # orchestrator's plain `ssh -i ~/.ssh/google_compute_engine` call
  # needs a route to the VM. The IAP tunnel only works with
  # `gcloud compute ssh --tunnel-through-iap`; the orchestrator uses
  # raw SSH. Two alternatives we considered: (a) a ProxyCommand in
  # ~/.ssh/config that wraps the IAP tunnel (more config sprawl), or
  # (b) an external IP (one extra network route for a 10-minute build
  # VM). The build VM carries no user data, only the sshd port, and
  # the pubkey is the only auth -- a public IP is acceptable here.
  if ! gcloud compute instances create "$WIN_INSTANCE_NAME" \
      --project="$GCP_PROJECT" --zone="$GCP_ZONE" \
      --machine-type="$WIN_MACHINE_TYPE" \
      --image-family=windows-2022 --image-project=windows-cloud \
      --boot-disk-size=50GB \
      --scopes=cloud-platform \
      --network-tier=PREMIUM \
      --labels=purpose=mcp-release,ephemeral=true \
      --metadata=enable-oslogin=FALSE \
      --metadata-from-file="windows-startup-script-ps1=$STARTUP_SCRIPT" \
      --tags=mcp-build 2>&1; then
    echo "" >&2
    echo "[ephemeral-win] VM create FAILED. Common causes:" >&2
    echo "  - CPUS_ALL_REGIONS quota exhausted: bump in GCP console" >&2
    echo "  - zone out of resources: try GCP_ZONE=us-central1-b" >&2
    echo "  - windows-cloud image not API-enabled: enable compute API" >&2
    exit 1
  fi
  VM_CREATED=1
  rm -f "$STARTUP_SCRIPT"
  STARTUP_SCRIPT=""
fi

# ---- Wait for Windows sysprep + startup script to finish ----
# The startup script can take 2-5 minutes (Add-WindowsCapability pulls
# from Windows Update, which can be slow on a fresh VM). We poll
# for the sentinel file via `gcloud compute ssh --command` instead of
# parsing serial-port output (the serial port can lag by 30s+ and
# the hostname line appears before sshd is actually ready).
echo "[ephemeral-win] waiting for $WIN_INSTANCE_NAME to finish booting + startup script" >&2
WAIT_START=$(date +%s)
WAIT_MAX=600  # 10 min ceiling; if it's not up by then, something is wrong
while true; do
  ELAPSED=$(( $(date +%s) - WAIT_START ))
  if [ "$ELAPSED" -gt "$WAIT_MAX" ]; then
    echo "[ephemeral-win] VM did not become ready within ${WAIT_MAX}s -- check GCP console serial port output" >&2
    echo "  gcloud compute instances get-serial-port-output $WIN_INSTANCE_NAME --zone=$GCP_ZONE --project=$GCP_PROJECT" >&2
    exit 1
  fi
  # The startup script writes a sentinel file when it finishes. If
  # gcloud compute ssh can read it, the VM is ready for the build.
  if gcloud compute ssh "$WIN_INSTANCE_NAME" \
       --project="$GCP_PROJECT" --zone="$GCP_ZONE" \
       --tunnel-through-iap \
       --command="powershell -NoProfile -Command \"if (Test-Path 'C:\\ProgramData\\mcp-build\\startup-script-complete') { exit 0 } else { exit 1 }\"" \
       >/dev/null 2>&1; then
    echo "[ephemeral-win] $WIN_INSTANCE_NAME ready after ${ELAPSED}s" >&2
    break
  fi
  printf "." >&2
  sleep 10
done

# ---- Update bin/platforms.json with the new VM ----
# The orchestrator reads host/ssh_user/ssh_key from bin/platforms.json;
# we need to point win32-x64 at the new VM. Backup the existing file
# (should already have an empty host + explanatory comment) and rewrite
# only the win32-x64 entry. The user can revert the change after the
# release.
PLATFORMS_JSON="$REPO_ROOT/bin/platforms.json"
if [ ! -f "$PLATFORMS_JSON" ]; then
  echo "[ephemeral-win] bin/platforms.json not found -- cannot wire win32-x64" >&2
  exit 1
fi
echo "[ephemeral-win] updating $PLATFORMS_JSON win32-x64 entry" >&2
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const cfg = JSON.parse(fs.readFileSync(p, "utf-8"));
  cfg["win32-x64"] = {
    host: process.argv[2],
    ssh_user: "jeff",
    ssh_key: "~/.ssh/google_compute_engine",
    ssh_port: 22,
  };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
' "$PLATFORMS_JSON" "$WIN_INSTANCE_NAME"

# ---- Build ----
# The orchestrator's ssh call will go through gcloud's SSH config
# (~/.ssh/config entries from `gcloud compute ssh` set up IAP
# tunneling automatically), so we don't need to override SSH_CMD.
echo "[ephemeral-win] running orchestrator for win32-x64" >&2
mkdir -p "$STAGING_DIR"
if ! LOCAL_CI_ARTIFACTS_DIR="$STAGING_DIR" \
     "$SCRIPT_DIR/build-platforms-all.sh" "$VERSION" --only win32-x64; then
  echo "[ephemeral-win] build FAILED -- check $STAGING_DIR/_logs/win32-x64.log" >&2
  exit 1
fi

# ---- Attach ----
ASSET="$STAGING_DIR/win32-x64/yaw-mcp-win32-x64.exe"
if [ ! -f "$ASSET" ]; then
  echo "[ephemeral-win] build reported success but $ASSET not found" >&2
  exit 1
fi
echo "[ephemeral-win] attaching $ASSET to v${VERSION}" >&2
if ! "$REPO_ROOT/release.sh" --upload-asset "$ASSET" "$VERSION"; then
  echo "[ephemeral-win] attach FAILED -- VM will still be deleted by EXIT trap" >&2
  exit 1
fi

echo "[ephemeral-win] win32-x64 binary attached to v${VERSION}" >&2
echo "[ephemeral-win] EXIT trap will delete $WIN_INSTANCE_NAME" >&2
