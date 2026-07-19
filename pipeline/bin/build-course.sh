#!/usr/bin/env bash
# build-course.sh - one course spec  ->  a published, content-addressed image.
#
#   generate apko.yaml  ->  apko lock  ->  apko build  ->  image digest
#     ->  (dedup: skip if that digest already exists)  ->  last-mile .img
#     ->  publish images/<digest>.{img,json}
#
# Design rules enforced here:
#   * the apko IMAGE DIGEST is the identity + dedup key
#   * an existing digest is NEVER rebuilt - only new digests are added
#   * runtime config + headroom are metadata, not digest inputs
#
# Usage: bin/build-course.sh courses/<course>.course.yaml
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PIPELINE="$(cd "$HERE/.." && pwd)"

# Resolve the spec to an absolute path *before* we cd, so this works no matter
# where it's invoked from (repo root, pipeline/, anywhere).
SPEC_ARG="${1:?usage: build-course.sh <course.yaml>}"
[ -f "$SPEC_ARG" ] || { echo "no such course spec: $SPEC_ARG"; exit 1; }
SPEC="$(cd "$(dirname "$SPEC_ARG")" && pwd)/$(basename "$SPEC_ARG")"

cd "$PIPELINE"

# Pinned by digest: apko's version is part of the reproducibility contract - a
# moving :latest can change the output image digest. Bump deliberately (and if
# Chainguard GCs this digest, that's a conscious bump, like updating a lock).
APKO_IMAGE="${APKO_IMAGE:-cgr.dev/chainguard/apko@sha256:79bcdb7a9a418056a8b416153b4aaacb36bbe1e97f7b20ae3cf7c6838c2a5a9d}" # was :latest
ENGINE="${ENGINE:-podman}"
PLATFORM=linux/386
REGISTRY_DIR="$PIPELINE/registry"          # local stand-in for an OCI registry
IMAGES_DIR="$REGISTRY_DIR/images"
# Fixed build date => reproducible apko digest for identical inputs.
BUILD_DATE="${BUILD_DATE:-2020-01-01T00:00:00Z}"
# Fixed epoch => byte-reproducible last-mile filesystems (mke2fs/mkfs.fat honour it).
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1577836800}" # 2020-01-01T00:00:00Z
# Snapshot format/version, folded into the image identity. Bumping it changes
# every image id, so a new snapshot recipe becomes a *new* image (never a silent
# rebuild of an existing id). "v1" = ships a tested boot snapshot (save_state).
SNAPSHOT_VERSION="${SNAPSHOT_VERSION:-v1}"
mkdir -p "$IMAGES_DIR"

# apko runs in a container; mount the pipeline dir as its workdir so it sees
# keys/, the generated apko.yaml, and writes the lock next to it.
apko() { "$ENGINE" run --rm --user 0 -v "$PIPELINE":/work -w /work "$APKO_IMAGE" "$@"; }

echo "### 1. generate apko.yaml from course spec"
node bin/gen-apko.mjs "$SPEC"
NAME="$(node -e "console.log(require('js-yaml').load(require('fs').readFileSync('$SPEC','utf8')).name)")"
WORK="build/$NAME"
REL="build/$NAME"   # path relative to /work inside the apko container

echo "### 2. apko lock (pins exact versions + checksums for arch 386)"
# Reproducibility: prefer the COMMITTED lock so the same spec always yields the
# same digest, even years later after Alpine has revoked package versions. Only
# (re)resolve when there's no lock yet, or when RELOCK=1 is set (author bumps).
if [ -f "courses/$NAME.lock.json" ] && [ "${RELOCK:-0}" != "1" ]; then
  echo "    using committed lock: courses/$NAME.lock.json"
  cp "courses/$NAME.lock.json" "$WORK/apko.lock.json"
else
  echo "    resolving a fresh lock (RELOCK=${RELOCK:-0})"
  apko lock --arch 386 "$REL/apko.yaml" --output "$REL/apko.lock.json"
  cp "$WORK/apko.lock.json" "courses/$NAME.lock.json"   # commit this alongside the spec
fi

echo "### 3. apko build (reproducible OCI image, pinned build-date)"
apko build --arch 386 --build-date "$BUILD_DATE" \
  --lockfile "$REL/apko.lock.json" \
  --sbom-path "$REL" \
  "$REL/apko.yaml" "v86guest/$NAME:latest" "$REL/oci.tar"

# The image digest is the identity. Pull it from apko's OCI index - selecting the
# 386 IMAGE manifest explicitly (not manifests[0]), so a future apko that also
# attaches an SBOM/attestation manifest can't hand us the wrong digest (B2).
# The tar path is passed as argv, not spliced into the JS string.
DIGEST="$(node -e '
  const { execSync } = require("child_process");
  const idx = JSON.parse(execSync("tar -xO -f " + JSON.stringify(process.argv[1]) + " index.json"));
  const ms = idx.manifests || [];
  const m =
    ms.find((x) => x.platform && x.platform.architecture === "386" && /image\.(manifest|index)/.test(x.mediaType || "")) ||
    ms.find((x) => x.platform && x.platform.architecture === "386") ||
    ms[0];
  if (!m || !m.digest) throw new Error("no 386 image manifest in apko OCI index");
  process.stdout.write(m.digest);
' "$WORK/oci.tar")"
SHORT="${DIGEST#sha256:}"
echo "    apko rootfs digest: $DIGEST"

# ---- image identity = apko rootfs digest FOLDED WITH the last-mile inputs -----
# INVARIANT (Phase 0): anything that changes the .img bytes must change the id.
# The apko digest covers the rootfs; the id also folds in everything the last mile
# contributes, all known BEFORE the last mile runs so skip-if-exists still works:
#   - lastmile/{assemble.sh,Dockerfile}: kernel cmdline, init config, disk layout,
#     strip logic, AND the mke2fs/mkfs.fat/syslinux tool versions
#   - per-course disk params (headroom)
#   - the snapshot format/version AND memory_size: a boot snapshot is a freeze of
#     a VM with a specific RAM size; restoring it into a differently-sized VM is
#     invalid. memory_size is otherwise "runtime config" (it does NOT change the
#     .img bytes), but it DOES change which snapshot is valid, so it must be part
#     of the (image + snapshot) identity. Two courses with identical packages but
#     different memory_size therefore get distinct image ids (and distinct
#     snapshots), even though their .img bytes are identical.
HEADROOM_MB="$(node -e "console.log(require('./$WORK/course-meta.json').disk_headroom_mb)")"
MEMORY_MB="$(node -e "console.log(require('./$WORK/course-meta.json').runtime.memory_size_mb)")"
LASTMILE_DIGEST="$(cat lastmile/assemble.sh lastmile/Dockerfile | sha256sum | cut -d' ' -f1)"
LM_HASH="$(printf 'lastmile=%s;headroom=%s;epoch=%s;snapshot=%s;mem=%s' \
  "$LASTMILE_DIGEST" "$HEADROOM_MB" "$SOURCE_DATE_EPOCH" "$SNAPSHOT_VERSION" "$MEMORY_MB" | sha256sum | cut -d' ' -f1)"
IMAGE_ID="$(printf '%s+%s' "$SHORT" "$LM_HASH" | sha256sum | cut -d' ' -f1)"
echo "$DIGEST"          > "$WORK/digest"     # apko rootfs digest (for GHCR push)
echo "sha256:$IMAGE_ID" > "$WORK/image_id"   # the .img identity (dedup + Release)
echo "    image id (rootfs + last-mile): sha256:$IMAGE_ID"

IMG="$IMAGES_DIR/$IMAGE_ID.img"
META="$IMAGES_DIR/$IMAGE_ID.json"

echo "### 4. dedup - never rebuild an existing image id (no force-rebuild override)"
if [ -f "$IMG" ] && [ -f "$META" ]; then
  echo "    OK image $IMAGE_ID already published ($(numfmt --to=iec "$(stat -c%s "$IMG")")). Skipping."
  echo "    (course '$NAME' now references this existing image.)"
  exit 0
fi

echo "### 5. flatten apko image -> rootfs dir"
"$ENGINE" load -i "$WORK/oci.tar" >/dev/null 2>&1 || true
LOADED="$("$ENGINE" images --format '{{.ID}} {{.Repository}}:{{.Tag}}' | grep "v86guest/$NAME" | head -1 | awk '{print $1}')"
CID="$("$ENGINE" create --platform "$PLATFORM" "$LOADED")"
rm -rf "$WORK/rootfs" && mkdir -p "$WORK/rootfs"
"$ENGINE" export "$CID" | tar -x -C "$WORK/rootfs"
"$ENGINE" rm "$CID" >/dev/null

echo "### 6. build last-mile assembler image (cached after first run)"
"$ENGINE" build --platform "$PLATFORM" -t v86guest/lastmile:latest lastmile/ >/dev/null

echo "### 7. last-mile: rootfs -> v86-bootable disk.img (mount-free)"
# HEADROOM_MB was read above (it feeds the image id). SOURCE_DATE_EPOCH makes the
# ext4/FAT byte-reproducible so identical inputs => identical bytes => identical id.
rm -rf "$WORK/out" && mkdir -p "$WORK/out"
"$ENGINE" run --rm --platform "$PLATFORM" \
  -e HEADROOM_MB="$HEADROOM_MB" \
  -e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
  -v "$PIPELINE/$WORK/rootfs":/in:ro \
  -v "$PIPELINE/$WORK/out":/out \
  v86guest/lastmile:latest

echo "### 8. publish images/<image_id>.{img,json}"
cp "$WORK/out/disk.img" "$IMG"
BYTES="$(cat "$WORK/out/disk.img.size")"
node -e "
  const fs=require('fs');
  const meta=require('./$WORK/course-meta.json');
  const out={
    image_id: 'sha256:$IMAGE_ID',          // identity of THESE .img bytes (rootfs + last-mile)
    rootfs_digest: '$DIGEST',              // apko OCI digest (the GHCR-pushed rootfs)
    last_mile: { assemble_and_tools_sha256: '$LASTMILE_DIGEST', source_date_epoch: Number('$SOURCE_DATE_EPOCH'), snapshot_version: '$SNAPSHOT_VERSION', memory_size_mb: Number('$MEMORY_MB') },
    image: '$IMAGE_ID.img',
    bytes: Number('$BYTES'),
    built_at: new Date().toISOString(),
    build_date_epoch: '$BUILD_DATE',
    alpine_branch: meta.branch,
    kernel: 'linux-lts',
    packages: meta.packages,
    course_packages: meta.course_packages,
    sbom: 'sbom-386.spdx.json',
    disk_headroom_mb: meta.disk_headroom_mb,
    // runtime config for v86 - NOT part of the image id:
    runtime: meta.runtime,
    v86_hda: { url: 'images/$IMAGE_ID.img', size: Number('$BYTES'), async: true },
  };
  fs.writeFileSync('$META', JSON.stringify(out,null,2)+'\n');
"
# park the SBOM next to the image too, if apko emitted it
cp "$WORK"/sbom-386.spdx.json "$IMAGES_DIR/$IMAGE_ID.sbom.spdx.json" 2>/dev/null || true

echo
echo "    OK published:"
echo "      $IMG ($(numfmt --to=iec "$BYTES"))"
echo "      $META"
echo
echo "    NB: push oci.tar (rootfs) to GHCR at $DIGEST; the .img identity is"
echo "    sha256:$IMAGE_ID. Never rebuild an existing id; only add new ones."
