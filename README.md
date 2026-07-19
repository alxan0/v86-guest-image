# v86-guest-image

Build **v86-bootable Alpine i386 disk images**, one per course. A course author
lists the packages their lesson needs, and the pipeline turns that into a
content-addressed, deduplicated `.img` that boots in a browser tab (via
[v86](https://github.com/copy/v86)) straight into a passwordless root shell over
the serial console. No backend at runtime.

That last part is the whole point. It's built for a client-side coding-education
platform, so image builds happen once per unique package set at course-publish
time (cost scales with teachers), and students fetch a static `.img` (cost scales
with students, but it's a CDN GET).

The real system lives in **[`pipeline/`](pipeline/)** - start there.

---

## Layout

| Path | What |
|---|---|
| [`pipeline/`](pipeline/) | the manifest-driven builder: course spec -> apko rootfs -> bootable `.img`, keyed by digest ([pipeline/README.md](pipeline/README.md)) |
| [`verify/`](verify/) | shared headless-v86 boot/toolchain test harness (`boot-test.mjs`) + pinned BIOS fetch (`fetch-bios.mjs`) |
| [`.devcontainer/`](.devcontainer/) | develop + build + verify entirely inside a container (nested podman) |
| [`.github/workflows/`](.github/workflows/) | CI: build/verify/publish a course image on every changed spec |
| `NOTICE.md` | the produced images bundle GPL/LGPL software - read this before distributing them |

## Quick start

```sh
npm install                                   # shared verify harness deps (v86)
npm --prefix pipeline install                 # generator + verify deps

# build a course image (apko -> last-mile -> registry/images/<digest>.img)
pipeline/bin/build-course.sh pipeline/courses/cpp-101.course.yaml

# headless boot + toolchain smoke test (auto-fetches BIOS, resolves v86)
pipeline/bin/verify-image.sh <sha256-digest>

# deep verification with timings + in-guest checks
node verify/student-flow.mjs pipeline/registry/images/<digest>.img
```

## Develop inside a container (recommended)

Open the folder in VS Code -> **"Reopen in Container"** (with
`"dev.containers.dockerPath": "podman"`), or:

```sh
devcontainer up --workspace-folder . --docker-path podman
```

The container runs its own **nested podman** - the whole pipeline (apko, the
i386 assembler, image export) and the v86 boot test run *inside* it, so the
Node/apko toolchain never touches your host and no host container socket is
exposed. A compromised npm dependency is boxed in.

> ### WARNING: Open this devcontainer only on a **rootless** container host (rootless podman)
> The container runs `--privileged`, which is **required** for nested podman
> (the inner engine must mount `/proc`; narrow caps like `--device /dev/fuse`
> alone are not enough - verified). On a *rootless* host, "privileged" is still
> confined to your user namespace and cannot become real host root, so the
> isolation argument holds. **On a rootful engine (e.g. Docker Desktop as root),
> `--privileged` is real host root** - a malicious dependency could escape to the
> host, defeating the point. The threat model is load-bearing on the rootless
> host; don't run it rootful.

## What these images are (and aren't)

- **32-bit x86 only** (`i386/alpine` + `linux-lts`) - v86 cannot boot 64-bit
  kernels, and only `linux-lts` ships the `ata_piix` IDE driver v86's `hda`
  disk needs (`linux-virt` does not).
- Boot to a **passwordless root shell** over `ttyS0`, writable ext4 root, **no
  guest network** (sandboxed inside the browser tab). The empty-password design
  is safe *only* because there is no network - see the invariant note in
  `pipeline/lastmile/assemble.sh`.
- **Reproducible**: identical (branch + package set) -> identical image digest
  (apko pinned by digest, fixed build-date, committed locks).

## Verified

`verify/student-flow.mjs` boots a real image headlessly and drives the student
sequence. On the reference `cpp-101` image: boot->shell ~24 s, `gcc` ~1.7 s,
`valgrind` ~6 s (0 leaks, 0 errors), root is `rw`, binaries are `ELF 32-bit
Intel 80386`, only `lo` exists.

> **Known limitation:** `gdb` on a **dynamically-linked** program SIGSEGVs inside
> musl's loader under v86 (a v86 CPU/ptrace emulation bug, not fixable via kernel
> cmdline - `vdso32=0`/ASLR toggles don't help). `gcc -static` + `gdb` works
> perfectly. A course that teaches `gdb` should compile with `-static`.

## License

Code: BSD-3-Clause ([`LICENSE`](LICENSE)). Produced images bundle third-party
GPL/LGPL software under its own terms - see [`NOTICE.md`](NOTICE.md).
