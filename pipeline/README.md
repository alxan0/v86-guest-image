# Manifest-driven course images (apko-based)

Course authors declare what their course needs, and CI turns that into a
v86-bootable Alpine i386 disk image. Same package set in, same image out: it's
content-addressed by digest, so identical sets collapse to a single build. The
only backend is CI, at *course-publish* time, which scales with teachers rather
than students.

The package/resolve/lock/hash/dedup layer is **not hand-rolled**. That part is
[apko](https://github.com/chainguard-dev/apko) plus an OCI registry.

---

## The split

```
course spec
  |
  +-- gen-apko.mjs --> apko.yaml --> apko lock --> apko.lock.json (commit)
  |                                      |
  |                                      v
  |                                 apko build --> OCI image @ sha256:DIGEST
  |                                      |         (reproducible, dedup key)
  |                                      v
  +-- course-meta.json ----------> LAST MILE (bespoke): rootfs --> raw .img
      (runtime, headroom;          kernel + initramfs + bootloader + serial
       NOT digest inputs)          console, all mount-free (mke2fs -d)
                                        |
                                        v
                          registry/images/<digest>.{img,json} --> CDN
                                        |
                                        v
                    v86  hda: { url, size, async }
```

- **Part A - packages -> rootfs: apko.** Declarative, no Dockerfile/RUN, `archs:
  [386]`, emits a lockfile with exact versions + checksums and an SPDX SBOM, and
  is bit-for-bit reproducible (pinned build-date => stable digest).
- **Part B - rootfs -> bootable `.img`: bespoke** (apko has no RUN steps and no
  bootability story). This is the proven mount-free assembly from the previous
  build, adapted to consume apko's rootfs.

### Why the digest is the identity

The apko image digest is content-addressed over the resolved package bytes + OCI
config, with a fixed build-date. So **identical (branch + package set) =>
identical digest**, regardless of course name, author, `runtime:`, or headroom.
Push it to an OCI registry (GHCR) and the storage is permanent, layers dedup
across images, and the digest is immutable.

This sidesteps Alpine's habit of **deleting old package versions even on stable
branches** ([abuild#9996](https://gitlab.alpinelinux.org/alpine/abuild/-/issues/9996)).
The built artifact lives permanently in the registry and is **never rebuilt**, so
re-resolution drift is harmless: it yields a *new* digest for *new* courses,
while existing courses keep booting the exact bytes they were published with.

**Rule enforced by the pipeline: never rebuild an existing digest; only add new ones.**

---

## The one deviation from the brief: kernel choice

The brief suggests `linux-virt`. I use **`linux-lts`**, and here's the evidence:

| kernel | `ata_piix` (v86's IDE disk) | `virtio_blk` | boots in v86 as `hda`? |
|---|---|---|---|
| `linux-virt` | ✗ (only `ata_generic`) | ✓ | **no** - can't see the disk |
| `linux-lts` | ✓ | ✓ | **yes** (verified) |

`linux-virt` is the right pick for *QEMU/virtio* VMs (the iximiuz article's
context), where the disk is `virtio-blk`. **v86's `hda` is an emulated IDE
(PIIX) disk**, and v86 has no virtio-blk - so the kernel needs `ata_piix`, which
only `linux-lts` ships. This was confirmed by inspecting both packages and by a
headless v86 boot test. The kernel is a platform-injected apk (`linux-lts` +
`linux-firmware-none`), so it's still fully declarative and part of the digest.

Two v86-specific kernel-cmdline flags are also required and baked into the
bootloader config: **`noapic nolapic`** (v86's IO-APIC emulation is incomplete;
without them the lts kernel panics in `setup_IO_APIC`) and `tsc=reliable`.

---

## Course spec (the whole teacher surface)

[`courses/cpp-101.course.yaml`](courses/cpp-101.course.yaml):

```yaml
name: cpp-101
description: Introduction to C++
branch: v3.20                 # pinned release; `edge` is rejected
packages: [gcc, g++, make, musl-dev, gdb, valgrind]
disk_headroom_mb: 256         # free space for student files
runtime:                      # v86 config - NOT part of the image digest
  memory_size_mb: 512
  vga_memory_size_mb: 8
```

The platform injects the base system (`alpine-base`, `openrc`, `agetty`, `bash`)
and the kernel; authors list only course tools.

### Validation is loud (never silent)

- `archs` is always `[386]`, not author-settable; 64-bit package names are rejected.
- `branch: edge` -> error; branch must be `vMAJOR.MINOR`.
- A package that doesn't exist **for 386** fails at **lock** time, not build time.
- Unknown top-level or `runtime:` fields -> error.
- Author-supplied kernel packages -> error (platform manages the kernel).

---

## Usage

```sh
npm install                                   # js-yaml + v86 (for verify)

# build + publish one course (idempotent; skips if the digest already exists)
bin/build-course.sh courses/cpp-101.course.yaml

# headless v86 boot + toolchain smoke test of a published image
# (self-contained: v86 from node_modules, BIOS auto-fetched + checksum-verified)
bin/verify-image.sh <sha256-digest>
```

Output lands in `registry/images/` (a local stand-in for GHCR + CDN):

- `<digest>.img` - the raw disk (`hda`).
- `<digest>.json` - byte size, package list, SBOM ref, `built_at`, and a
  ready-to-use `v86_hda: { url, size, async }` block for the frontend.

### Continuous builds (GitHub Actions)

[`.github/workflows/build-courses.yml`](../.github/workflows/build-courses.yml)
builds automatically. GitHub runs nothing until that file exists; once it does,
**pushing a new or edited `courses/*.course.yaml` to `main` builds just that
course** (a matrix leg per changed spec), boot-verifies it in v86, and - keyed
by the apko digest - publishes it, **skipping any digest already released**
(`workflow_dispatch` can rebuild `all`). It publishes the apko rootfs to GHCR and
the `.img` as a GitHub Release asset (a Range-capable URL for v86's `hda`).

Author flow for a new course:

```sh
# 1. write courses/<name>.course.yaml
# 2. generate + commit the lock (pins exact versions -> reproducible digest)
bin/build-course.sh courses/<name>.course.yaml    # writes courses/<name>.lock.json
# 3. commit BOTH the spec and the lock, push -> CI builds/verifies/publishes
```

CI builds from the **committed lock** (not a fresh resolve), so the digest is
stable over time even after Alpine revokes old package versions. `RELOCK=1`
(or the workflow's `relock` input) re-resolves on purpose.

## Operating this (for the one person who runs it)

You are probably the only maintainer, reading this months later. Here is what
you will actually need.

**Trigger a build and publish.** Two ways. Push a new or edited
`courses/*.course.yaml` (with its committed lock) to `main`, and that one course
builds. Or open Actions -> `build-course-images` -> **Run workflow**, set `all`
to true, which walks every course and skips the ones already released. The run
should end with the snapshot step passing, the publish step logging
`uploaded assets verified against manifest`, and a Release `image-<short>`
carrying four files: `<image_id>.img`, `<image_id>.state.zst`,
`<image_id>.manifest.json`, and the course lock. Re-running the same tag is safe;
the "Already published?" gate skips it, so nothing is duplicated or overwritten.

**Adding a course.** Write `courses/<name>.course.yaml`, run
`bin/build-course.sh` once to generate `courses/<name>.lock.json`, commit both,
push. CI takes it from there.

**When Alpine drifts.** Nothing happens unless you ask for it. The committed lock
pins exact versions, so a course keeps producing the same digest indefinitely,
independent of what Alpine's repos do. The day you `RELOCK=1` (a version bump, a
security fix), re-resolution picks up newer packages and the course gets a *new*
digest, hence a *new* image and a *new* Release. The old one is never touched.
The one hard failure mode: if you let a lock go stale long enough that Alpine has
deleted the pinned versions, the build breaks at package-fetch time. That is your
signal to `RELOCK=1` and cut a new image, or to fall back on a backup (below).

**Deprecating a published image.** An `image_id` is immutable and never rebuilt,
so you retire an image rather than change it. Point the frontend away from it,
and either mark its Release as a pre-release or delete it. Deleting the Release
removes the `.img` and `.state.zst`, so only do that once nothing references them.

### Back up the Release assets

The published `.img` and `.state.zst` are the only source of truth for an image.
Alpine deletes old package versions even on stable branches
([abuild#9996](https://gitlab.alpinelinux.org/alpine/abuild/-/issues/9996)), so
once the versions a lock pins are gone, that exact image cannot be rebuilt from
source. The committed lock and the GHCR rootfs help only while those versions
still exist upstream. If a course needs to keep working for years, copy its
Release assets somewhere durable (object storage, a second repo's releases) and
treat that copy as the real artifact.

### Permissions for a fresh setup

The workflow needs `contents: write` (to create Releases) and `packages: write`
(to push the rootfs to GHCR). Both are declared in the workflow's `permissions:`
block and satisfied by the built-in `GITHUB_TOKEN`; no personal access token is
involved. On a fresh clone or a new repo, the only setting to check is
**Settings -> Actions -> General -> Workflow permissions = Read and write**. The
GHCR package it creates starts private, which is fine for the rootfs; the
browser-served assets are the public Release downloads.

### Wire into v86

A release carries three files per image: the raw `<image_id>.img`, the compressed
boot snapshot `<image_id>.state.zst`, and `<image_id>.manifest.json`. The manifest
is the entry point. It pairs the two artifacts and hands you a v86 config block
under `m.v86` with the URLs (absolute release-download links) already filled in.

Read the manifest, refuse a mismatched pair, restore from the snapshot:

```js
const m = await fetch(manifestUrl).then((r) => r.json());
// a snapshot is a freeze of one exact image; restoring it against a different
// image, or a different memory_size, corrupts. Refuse the pair if it doesn't match.
if (m.snapshot.source_image_id !== m.image_id) throw new Error("image/snapshot mismatch");

new V86({
  wasm_path: wasmUrl,
  bios: { url: "/bios/seabios.bin" },
  vga_bios: { url: "/bios/vgabios.bin" },
  serial_console: { /* xterm.js */ },
  ...m.v86, // memory_size (bytes), vga_memory_size, hda { url, size, async }, initial_state { url }
});
```

`m.v86.initial_state.url` points at the `.state.zst`. v86 decompresses it and
wakes the VM at a ready prompt in about a second, so the student skips the ~23s
cold boot. The disk still rides along as `hda` with `async: true`: blocks fault in
over HTTP Range only when something reads them, like the first `gcc`. Leave
`m.v86.memory_size` alone. It is fixed at whatever the snapshot was captured with,
and a restore into a differently-sized VM is invalid (which is why memory_size is
folded into the image id).

Need the cold path instead, say for debugging? Drop `initial_state` and v86 boots
the `.img` from scratch.

---

## Prerequisites

- **podman** (or docker) that can run `linux/386`. On x86-64 this is native (no
  emulation); the whole build is unprivileged and mount-free (no loop devices).
- **apko** via its container image (`cgr.dev/chainguard/apko`) - no local install.
- **Node** for the generator + verify harness.

Or install none of it on your host: the repo's [`../.devcontainer/`](../.devcontainer/)
runs this entire pipeline inside a container with a nested podman (no host socket
mounted), so the Node/apko toolchain never touches your machine. See the top-level
README's "Develop inside a container".

---

## What's verified vs. not

Verified hands-on in this environment:

- apko builds a working Alpine **386** rootfs with gcc/g++/gdb/valgrind (the
  known-risk combo - it worked without a fight).
- `apko lock` pins 386 packages; missing-on-386 fails at lock.
- The published image **boots headlessly in v86** and compiles + runs a C
  program over the serial console.
- **Dedup + reproducibility**: re-running a course (and a differently-named
  course with different `runtime:`/headroom but identical packages) produces the
  **same digest** and skips the rebuild.

Not verified here: a real GHCR push (needs creds - the `oci.tar` is ready to
`apko publish`/`crane push`); booting in an actual browser tab (the harness uses
v86 under Node - identical emulator core, but the xterm.js/browser seam is
untested).

## Files

| Path | Role |
|---|---|
| `courses/*.course.yaml` | teacher specs (committed) |
| `courses/*.lock.json` | pinned apko locks (committed) |
| `bin/gen-apko.mjs` | course spec -> `apko.yaml` + `course-meta.json`, with validation |
| `bin/build-course.sh` | orchestrator: lock -> build -> digest -> dedup -> last-mile -> publish |
| `bin/verify-image.sh` | headless v86 boot test wrapper |
| `lastmile/Dockerfile` + `assemble.sh` | rootfs -> bootable `.img` (mount-free) |
| `keys/` | Alpine signing keys (committed, for reproducible locks) |
| `registry/images/` | local stand-in for GHCR + CDN (images gitignored) |
