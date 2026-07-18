#!/usr/bin/env bash
# verify-image.sh - headless v86 boot + toolchain smoke test for a published image.
#
#   bin/verify-image.sh <sha256-digest-or-path-to.img>
#
# Reuses the shared harness at ../verify/boot-test.mjs, which self-resolves the
# v86 package (installed here as a devDep) and auto-fetches the BIOS. No manual
# setup, no sibling checkouts.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PIPELINE="$(cd "$HERE/.." && pwd)"

ARG="${1:?usage: verify-image.sh <digest|path.img>}"
if [ -f "$ARG" ]; then
  IMG="$ARG"
else
  IMG="$PIPELINE/registry/images/${ARG#sha256:}.img"
fi
test -f "$IMG" || { echo "no image at $IMG"; exit 1; }

export BOOT_TIMEOUT_MS="${BOOT_TIMEOUT_MS:-200000}"
exec node "$PIPELINE/../verify/boot-test.mjs" "$IMG"
