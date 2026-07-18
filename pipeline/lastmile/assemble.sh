#!/bin/bash
# assemble.sh — apko rootfs (/in)  ->  v86-bootable raw disk (/out/disk.img)
#
# apko produces a reproducible package rootfs but, by design, runs no apk
# triggers/scripts and has no RUN steps. So this step adds everything that needs
# *execution*, deterministically and identically for every course:
#   1. fix up what triggers would have done (busybox applet symlinks, openrc
#      runlevels, /sbin/init)
#   2. constant guest config: serial autologin, empty root pw, no networking
#   3. generate the initramfs (with the IDE + ext4 drivers v86 needs)
#   4. assemble a partitioned raw disk MOUNT-FREE (mke2fs -d + mkfs.fat + syslinux)
#
# All of this is a constant function of the rootfs, so identical rootfs => identical
# image, preserving the apko digest as the dedup identity.
set -euo pipefail

HEADROOM_MB="${HEADROOM_MB:-256}"
BOOT_MB="${BOOT_MB:-48}"
ROOT=/work/root

echo "==> [1/6] copy rootfs (apko output is read-only input)"
rm -rf /work && mkdir -p /work /out
cp -a /in "$ROOT"

KVER="$(basename "$ROOT"/lib/modules/*)"
echo "    kernel: $KVER"
test -f "$ROOT/boot/vmlinuz-lts" || { echo "FATAL: no linux-lts kernel in rootfs"; exit 1; }

echo "==> [2/6] replay the apk triggers apko skipped"
# busybox applet symlinks (ls, sh, init, mount, ...): shipped as a post-install
# trigger, which apko does not run. Install them explicitly.
if [ -x "$ROOT/bin/busybox" ]; then
  chroot "$ROOT" /bin/busybox --install -s 2>/dev/null || true
fi
# /sbin/init must exist for the kernel to hand off. busybox --install makes it,
# but guard anyway.
[ -e "$ROOT/sbin/init" ] || ln -sf /bin/busybox "$ROOT/sbin/init"
# openrc runlevels (the symlinks `rc-update add` would create). Networking is
# deliberately omitted — this image has no guest network.
add_svc() { # <service> <runlevel>
  [ -f "$ROOT/etc/init.d/$1" ] && chroot "$ROOT" /sbin/rc-update add "$1" "$2" 2>/dev/null || true
}
for s in devfs dmesg mdev hwdrivers cgroups sysfs; do add_svc "$s" sysinit; done
for s in bootmisc hostname modules sysctl syslog urandom; do add_svc "$s" boot; done
for s in killprocs mount-ro savecache; do add_svc "$s" shutdown; done

echo "==> [3/6] constant guest config (serial autologin, no password, no net)"
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ SECURITY INVARIANT: passwordless root + autologin is safe ONLY because this │
# │ guest has NO network (v86 configures no NIC; net services are removed       │
# │ below). The whole VM is sandboxed inside the browser tab. If you EVER add a │
# │ guest network device or a net_device to the v86 config, revisit this — an   │
# │ empty root password on a reachable host is a real hole. (review S5)         │
# └───────────────────────────────────────────────────────────────────────────┘
# empty root password
sed -i 's#^root:[^:]*:#root::#' "$ROOT/etc/shadow"
# root shell -> bash
sed -i 's#^\(root:[^:]*:[^:]*:[^:]*:[^:]*:[^:]*:\).*#\1/bin/bash#' "$ROOT/etc/passwd"
# init: openrc phases + autologin gettys (serial first — that's what v86 drives)
cat > "$ROOT/etc/inittab" <<'EOF'
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default
ttyS0::respawn:/sbin/agetty --autologin root --noclear ttyS0 115200 vt100
tty1::respawn:/sbin/agetty --autologin root --noclear tty1 linux
::ctrlaltdel:/sbin/reboot
::shutdown:/sbin/openrc shutdown
EOF
printf 'ttyS0\ntty1\nconsole\n' > "$ROOT/etc/securetty"
printf '/dev/sda2  /  ext4  rw,relatime  0 1\n' > "$ROOT/etc/fstab"
echo 'v86guest' > "$ROOT/etc/hostname"
printf '\nv86 guest (Alpine i386) — client-side C/C++ lab.\nCompile: gcc/g++/make.  Debug: gdb/valgrind.  Edit: vi.\n\n' > "$ROOT/etc/motd"
# no guest network: v86 configures no NIC and these ensure nothing tries at boot
rm -f "$ROOT/etc/network/interfaces"

echo "==> [4/6] build the initramfs (IDE + ext4 drivers v86 needs)"
# apko ships a prebuilt modules.dep; refresh it just in case, then build a slim
# initramfs from OUTSIDE the rootfs with mkinitfs -b.
depmod -b "$ROOT" "$KVER" 2>/dev/null || true
echo 'features="base ata scsi ext4"' > /tmp/mkinitfs.conf
# normalize mtimes so the cpio mkinitfs builds is reproducible (it records them)
find "$ROOT" -exec touch -hcd "@$SOURCE_DATE_EPOCH" {} + 2>/dev/null || true
mkinitfs -b "$ROOT" -c /tmp/mkinitfs.conf -o "$ROOT/boot/initramfs-lts" "$KVER"

echo "==> [5/6] slim the rootfs"
# docs/man/info + apk cache + kernel maps; /lib/modules is safe to drop because
# the initramfs already carries the boot drivers (fixed virtual hardware).
rm -rf "$ROOT"/usr/share/man "$ROOT"/usr/share/doc "$ROOT"/usr/share/info \
       "$ROOT"/var/cache/apk/* "$ROOT"/boot/System.map-* "$ROOT"/boot/config-* \
       "$ROOT"/lib/modules
# stage the boot payload, then drop the big copies from the ext4 root
mkdir -p /work/stage
cp "$ROOT/boot/vmlinuz-lts"   /work/stage/vmlinuz-lts
cp "$ROOT/boot/initramfs-lts" /work/stage/initramfs-lts
rm -f "$ROOT/boot/vmlinuz-lts" "$ROOT/boot/initramfs-lts"
# mkinitfs gzips the cpio with the current time in the gzip header -> re-emit the
# header without an mtime so the initramfs (hence the FAT partition, hence the
# whole .img) is byte-reproducible for identical inputs.
if gzip -t /work/stage/initramfs-lts 2>/dev/null; then
  gzip -dc /work/stage/initramfs-lts | gzip -n9 > /work/stage/initramfs-lts.det
  mv /work/stage/initramfs-lts.det /work/stage/initramfs-lts
fi
cat > /work/stage/syslinux.cfg <<'EOF'
DEFAULT alpine
PROMPT 0
TIMEOUT 1
LABEL alpine
  LINUX /vmlinuz-lts
  INITRD /initramfs-lts
  APPEND modules=ata_piix,sd-mod,ext4 root=/dev/sda2 rootfstype=ext4 console=ttyS0 rw rootwait tsc=reliable noapic nolapic quiet
EOF
# noapic nolapic: v86's (IO-)APIC emulation is incomplete; without these the lts
# kernel panics in setup_IO_APIC. tsc=reliable: v86's TSC isn't monotonic.

echo "==> [6/6] assemble the raw disk (mount-free: mke2fs -d + mkfs.fat + sfdisk + dd)"
# Byte-reproducibility: pin every source of randomness so identical inputs yield
# identical bytes (SOURCE_DATE_EPOCH is exported by the caller). Without this the
# ext4 UUID + fs timestamps + FAT volume-id vary per build, and the image id
# (which is a function of inputs) would map to differing bytes.
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1577836800}"
# re-normalize mtimes (the strip step above bumped some dir mtimes) so the ext4
# mke2fs -d writes is byte-reproducible
find "$ROOT" -exec touch -hcd "@$SOURCE_DATE_EPOCH" {} + 2>/dev/null || true
ROOT_MB=$(( $(du -sm "$ROOT" | cut -f1) + HEADROOM_MB ))
mke2fs -q -F -t ext4 -L cs-root -d "$ROOT" -b 4096 \
  -U 5ca1ab1e-0000-4000-8000-00000000c0de \
  -E hash_seed=5ca1ab1e-0000-4000-8000-00000000c0de \
  /work/root.ext4 "${ROOT_MB}M"

mkfs.fat -F 16 -n CSBOOT -i cafef00d -C /work/boot.img $(( BOOT_MB * 1024 )) >/dev/null
syslinux --install /work/boot.img
# pin FAT directory-entry timestamps (mcopy takes them from the source mtime)
touch -d "@$SOURCE_DATE_EPOCH" /work/stage/vmlinuz-lts /work/stage/initramfs-lts /work/stage/syslinux.cfg /usr/share/syslinux/ldlinux.c32
mcopy -i /work/boot.img /usr/share/syslinux/ldlinux.c32 ::/ldlinux.c32 2>/dev/null || true
mcopy -i /work/boot.img /work/stage/vmlinuz-lts   ::/vmlinuz-lts
mcopy -i /work/boot.img /work/stage/initramfs-lts ::/initramfs-lts
mcopy -i /work/boot.img /work/stage/syslinux.cfg  ::/syslinux.cfg

ALIGN=2048
BOOT_SECTORS=$(( BOOT_MB * 2048 ))
ROOT_SECTORS=$(( ROOT_MB * 2048 ))
P1_START=$ALIGN
P2_START=$(( P1_START + BOOT_SECTORS ))
TOTAL_SECTORS=$(( P2_START + ROOT_SECTORS + ALIGN ))
truncate -s $(( TOTAL_SECTORS * 512 )) /out/disk.img
# fixed label-id => deterministic MBR disk signature (bytes 440-443); otherwise
# sfdisk writes a random one and every .img differs there.
printf 'label: dos\nlabel-id: 0xcafef00d\nunit: sectors\n%s,%s,6,*\n%s,%s,83\n' \
  "$P1_START" "$BOOT_SECTORS" "$P2_START" "$ROOT_SECTORS" | sfdisk /out/disk.img >/dev/null
dd if=/work/boot.img  of=/out/disk.img bs=512 seek="$P1_START" conv=notrunc status=none
dd if=/work/root.ext4 of=/out/disk.img bs=512 seek="$P2_START" conv=notrunc status=none
dd if=/usr/share/syslinux/mbr.bin of=/out/disk.img bs=440 count=1 conv=notrunc status=none

BYTES=$(stat -c%s /out/disk.img)
echo "==> disk.img = $(numfmt --to=iec "$BYTES") ($BYTES bytes)"
echo "$BYTES" > /out/disk.img.size
