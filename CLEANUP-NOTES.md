# Cleanup notes (for a later deliberate pass)

Structural items noticed during the janitorial pass but intentionally **not**
acted on, because acting on them would be a refactor and/or would change the
built artifact / `image_id`. Each needs its own scoped change with a fresh
before/after `image_id` check.

## 1. An em dash is load-bearing (checksummed by the lock)

`gen-apko.mjs` emits an `apko.yaml` whose header comment contains an em-dash
character. `apko.lock.json` records a checksum of the whole generated `apko.yaml`,
so that byte is frozen: changing it makes every committed lock fail validation
(`checksum in the lock file does not match the original config`). It's guarded
with an inline comment now. A future pass that wants the header pure-ASCII must
change the string **and** regenerate every committed lock (`RELOCK=1`) in one
atomic commit. Packages don't change, so the rootfs digest / `image_id` stay the
same, but the committed `*.lock.json` bytes change.

## 2. Residual `.img` byte non-determinism

`image_id` is fully deterministic (a function of inputs) and is the identity we
guarantee. The raw `.img` bytes, however, still vary build-to-build in two
non-semantic spots: the initramfs cpio (mkinitfs's internal file ordering, which
it doesn't expose a knob for) and a few ext4 superblock housekeeping fields.
This is harmless under never-rebuild (each `image_id` maps to exactly one
published `.img`), but a future pass chasing bit-for-bit reproducibility would
need to tame mkinitfs (or rebuild the cpio deterministically) and pin the
remaining mke2fs fields.

## 3. `build-course.sh` does a lot in one script

gen -> lock -> apko build -> flatten -> last-mile -> publish -> metadata all live
in one script. It works and is easy to read top-to-bottom, but if it grows,
splitting publish/metadata into a separate step would help. Refactor, not tidy.

## 4. Naming wart: `SHORT`

In `build-course.sh`, `SHORT="${DIGEST#sha256:}"` is the **full** 64-char hex,
not a short id (the 12-char short is computed separately in the workflow).
Rename to `HEX` for clarity in a later pass.

## 5. Snapshot is validated but not wired into the pipeline

The `save_state` boot snapshot (23.8s cold boot -> 0.72s restore) is proven by
`verify/snapshot.mjs`, and the identity model already reserves a
`snapshot_version` slot in `image_id`. Actually shipping a per-course snapshot
(`.zst` + `initial_state` wiring + client caching of the ~172 MiB blob) is a
deliberate feature, gated on the download-size product decision - not a cleanup.
