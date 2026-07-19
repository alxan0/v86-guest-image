// build-snapshot.mjs: build + TEST a v86 boot snapshot for one exact .img.
//
//   node verify/build-snapshot.mjs <disk.img> <out.state.zst>
//
// 1. boots the EXACT .img headless, waits for the login shell (MOTD token), then
//    settles SNAPSHOT_SETTLE_MS with NO interaction -> that is the reproducible
//    capture point. save_state() -> zstd -> <out.state.zst>.
// 2. in a FRESH v86, restores from the COMPRESSED artifact and runs the same
//    acceptance sequence as the image (prompt responsive -> gcc -> ./hello prints
//    -> rootfs writable). Any failure exits non-zero: a dirty snapshot is worse
//    than none, so the build must fail rather than publish it.
// 3. prints one JSON metadata line (BUILD_SNAPSHOT_META=...) on success.
//
// Env: MEM_MB (must match the memory_size the image id was computed with),
//      SNAPSHOT_SETTLE_MS (default 2000), SNAPSHOT_VERSION (default v1),
//      SOURCE_IMAGE_ID (default: derived from the .img filename <hex>.img).

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import zlib from "node:zlib";
import { ensureBios } from "./fetch-bios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const diskPath = resolve(process.argv[2] ?? "");
const outZst = resolve(process.argv[3] ?? "");
if (!diskPath || !outZst) {
  console.error("usage: build-snapshot.mjs <disk.img> <out.state.zst>");
  process.exit(64);
}
const MEM = Number(process.env.MEM_MB ?? 512) * 1024 * 1024;
const SETTLE_MS = Number(process.env.SNAPSHOT_SETTLE_MS ?? 2000);
const SNAPSHOT_VERSION = process.env.SNAPSHOT_VERSION ?? "v1";
const SOURCE_IMAGE_ID =
  process.env.SOURCE_IMAGE_ID ?? "sha256:" + basename(diskPath).replace(/\.img$/, "");
const CAPTURE = `login shell ready (MOTD "C/C++ lab") + ${SETTLE_MS}ms settle, no interaction`;

// The pipeline runs on Node 24 (Active LTS). zstd landed in 22.15 and v86
// consumes a zstd-compressed state, so we never fall back to gzip; require the
// same >=24 floor the CI workflow pins, and fail loudly if the tools are missing.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 24) {
  console.error(`FATAL: Node ${process.versions.node} is below the pinned floor of 24. Cannot build a snapshot.`);
  process.exit(3);
}
if (typeof zlib.zstdCompressSync !== "function" || typeof zlib.zstdDecompressSync !== "function") {
  console.error("FATAL: this Node lacks zlib zstd. Cannot build a shippable snapshot.");
  process.exit(3);
}

const req = createRequire(resolve(here, "../pipeline/package.json"));
const { V86 } = await import(pathToFileURL(req.resolve("v86")).href);
const wasm = req.resolve("v86/build/v86.wasm");
const biosDir = resolve(process.env.BIOS_DIR ?? resolve(here, "bios"));
await ensureBios(biosDir);

const diskBytes = statSync(diskPath).size;
const diskFile = readFileSync(diskPath);
const diskBuf = () => diskFile.buffer.slice(diskFile.byteOffset, diskFile.byteOffset + diskFile.byteLength);
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");
const cfg = () => ({
  wasm_path: wasm, memory_size: MEM, vga_memory_size: 8 * 1024 * 1024,
  bios: { url: resolve(biosDir, "seabios.bin") }, vga_bios: { url: resolve(biosDir, "vgabios.bin") },
  autostart: true, disable_speaker: true,
});
let serial = "";
const attach = (em) => em.add_listener("serial0-output-byte", (b) => (serial += String.fromCharCode(b)));
const clean = (s) => s.replace(/\r/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
function waitFor(needle, ms, what) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (serial.includes(needle)) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for ${what || needle}`)); }
    }, 30);
  });
}
let N = 0;
// send cmd, wait for a unique completion token (split so the terminal echo of the
// command line can't false-match), return the command's output (ANSI-stripped)
async function step(em, cmd, ms = 60000) {
  const tok = `Z${++N}Z`;
  const from = serial.length;
  em.serial0_send(`${cmd}; echo "Z""${N}Z"\n`);
  await waitFor(tok, ms, `\`${cmd}\``);
  return clean(serial.slice(from, serial.lastIndexOf(tok)));
}
const die = (msg, out) => { console.error(`\nSNAPSHOT ACCEPTANCE FAILED: ${msg}`); if (out) console.error("--- output ---\n" + out.slice(-800)); process.exit(2); };

// ---------------------------------------------------------------- 1. capture
console.error(`[snap] boot ${basename(diskPath)} (mem=${MEM / 1048576} MiB) -> capture`);
let em = new V86({ ...cfg(), hda: { buffer: diskBuf() } });
attach(em);
const tBoot = Date.now();
await waitFor("C/C++ lab", 240000, "login shell (MOTD)").catch((e) => die(e.message, serial));
const bootMs = Date.now() - tBoot;
await new Promise((r) => setTimeout(r, SETTLE_MS)); // reproducible settle, no interaction
const rawState = Buffer.from(await em.save_state());
await em.destroy();

const zstd = zlib.zstdCompressSync(rawState);
writeFileSync(outZst, zstd);
const zstdSha = sha256hex(zstd);
console.error(`[snap] raw ${(rawState.length / 1048576).toFixed(1)} MiB -> zstd ${(zstd.length / 1048576).toFixed(1)} MiB  sha256:${zstdSha.slice(0, 12)}`);

// ---------------------------------------------------- 2. restore-from-compressed + acceptance
console.error(`[snap] restore from the COMPRESSED artifact + acceptance test`);
serial = "";
const tDec0 = Date.now();
const restored = zlib.zstdDecompressSync(readFileSync(outZst));
const decompressMs = Date.now() - tDec0;
if (sha256hex(zlib.zstdCompressSync(restored)) && restored.length !== rawState.length)
  die(`decompressed size ${restored.length} != raw ${rawState.length}`);
const tR0 = Date.now();
em = new V86({ ...cfg(), hda: { buffer: diskBuf() }, initial_state: { buffer: restored.buffer.slice(restored.byteOffset, restored.byteOffset + restored.byteLength) } });
attach(em);
await new Promise((res, rej) => { em.add_listener("emulator-loaded", res); setTimeout(() => rej(new Error("emulator-loaded timeout")), 60000); }).catch((e) => die(e.message));
const loadMs = Date.now() - tR0;
// prompt responsive
await step(em, "true", 20000).catch(() => die("restored VM did not respond to serial input"));
const restoreMs = Date.now() - tR0;
await step(em, "stty -echo", 15000);

// acceptance: gcc compile -> run -> expected output -> writable root
const build = await step(em, 'printf "%s\\n" "#include <stdio.h>" "int main(void){puts(\\"SNAP_OK_42\\");return 0;}" > sh.c; gcc sh.c -o sh 2>&1', 120000);
if (/error|warning/i.test(build)) die("gcc did not compile cleanly after restore", build);
const run = await step(em, "./sh", 30000);
if (!/SNAP_OK_42/.test(run)) die("compiled program did not print expected output after restore", run);
const wr = await step(em, "touch /root/.snap_wtest && echo WROTE_OK", 15000);
if (!/WROTE_OK/.test(wr)) die("rootfs not writable after restore", wr);
await em.destroy();

// ---------------------------------------------------------------- 3. metadata
const meta = {
  source_image_id: SOURCE_IMAGE_ID,
  source_image_sha256: "sha256:" + sha256hex(diskFile), // the EXACT .img bytes this snapshot froze
  snapshot_version: SNAPSHOT_VERSION,
  memory_size_mb: MEM / 1048576,
  capture_point: CAPTURE,
  cold_boot_ms: bootMs,
  raw_bytes: rawState.length,
  zstd_bytes: zstd.length,
  zstd_sha256: zstdSha,
  decompress_ms: decompressMs,
  restore_to_prompt_ms: restoreMs,
  loaded_ms: loadMs,
  acceptance: "pass (prompt responsive, gcc compile+run, rootfs writable)",
};
console.error(
  `[snap] PASS  restore ${(restoreMs / 1000).toFixed(2)}s (decompress ${(decompressMs / 1000).toFixed(2)}s + load ${(loadMs / 1000).toFixed(2)}s); acceptance OK`,
);
process.stdout.write("BUILD_SNAPSHOT_META=" + JSON.stringify(meta) + "\n");
process.exit(0);
