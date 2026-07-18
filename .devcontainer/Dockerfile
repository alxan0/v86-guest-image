# Dev container for the guest-image build/verify pipeline.
#
# Based on Red Hat's purpose-built podman-in-podman image, so the whole pipeline
# — apko, the i386 assembler, image load/export, AND the v86 boot test — runs
# INSIDE the container using a NESTED podman. No host container socket is
# mounted, so a compromised npm dependency is confined to this container and its
# nested containers; it has no path to your host engine or filesystem (only the
# mounted workspace).
FROM quay.io/podman/stable@sha256:663e0dbf407987b7db3f20d3588c283a8228db17b282d2029a482d4d47e36964

# Node (for the generator + v86 verify harness) and the handful of CLI tools the
# scripts call. quay.io/podman/stable is Fedora-based (dnf) and already ships a
# rootless-nested podman setup (subuid/subgid, storage.conf).
RUN dnf -y install \
      nodejs npm git make findutils tar which \
    && dnf clean all \
    && node --version

WORKDIR /workspace
