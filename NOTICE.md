# NOTICE

The **code** in this repository (the pipeline, generator, verify harness, CI, and
devcontainer) is licensed under the terms in [`LICENSE`](LICENSE) (BSD 3-Clause).

The **disk images this project produces** are a different matter. They bundle
third-party software that is redistributed under its own license, **not** BSD-3.
Notably:

| Component | License |
|---|---|
| Linux kernel (`linux-lts`) | GPL-2.0-only |
| GNU toolchain in course images (`gcc`, `g++`, `binutils`, `gdb`, `make`) | GPL-3.0 (+ GCC Runtime Library Exception) |
| `valgrind` | GPL-2.0 |
| `busybox` | GPL-2.0 |
| Alpine base, `musl` | MIT / others |
| SeaBIOS / VGABIOS (used only by the verify harness, fetched at test time) | LGPL-3.0 |

If you **distribute** a generated `.img` (e.g. serving it from a CDN to
browsers), you are distributing GPL/LGPL software and take on those licenses'
obligations — principally offering the corresponding source. In practice this is
easy to satisfy: every package is an unmodified Alpine `apk`, and the exact
versions are pinned in the course's committed `courses/<name>.lock.json` (name,
version, and upstream URL per package), which is your bill of materials. Each
published image also ships an SPDX SBOM.

This project does not modify any of that upstream software; it only assembles
unmodified packages into a bootable disk.
