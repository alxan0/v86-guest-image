# The "last-mile" assembler: an i386/alpine image with exactly the tools needed
# to turn an apko-produced rootfs into a v86-bootable raw disk — all mount-free
# and unprivileged (no loop devices, no --privileged).
#
#   mkinitfs + kmod  : build the initramfs (apko can't run apk triggers)
#   e2fsprogs        : mke2fs -d  (populate ext4 from a dir, no mount)
#   dosfstools+mtools: FAT boot partition, populated without mounting
#   syslinux         : bootloader (mbr.bin + syslinux install to the FAT image)
#   util-linux       : sfdisk (partition table on a plain file)
FROM docker.io/i386/alpine:3.20@sha256:4ec3ead63e75e791660b5abc4dc3bd85ebb6fc24a10d649ba05991bf34b5e80e
RUN apk add --no-cache \
      bash coreutils \
      mkinitfs kmod \
      e2fsprogs dosfstools mtools syslinux util-linux
COPY assemble.sh /usr/local/bin/assemble.sh
RUN chmod +x /usr/local/bin/assemble.sh
ENTRYPOINT ["/usr/local/bin/assemble.sh"]
