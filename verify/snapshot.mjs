// Phase-2: boot once, snapshot the post-boot VM (save_state), then measure how
// fast restore_state wakes it to a usable prompt - and confirm gcc still works.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import zlib from "node:zlib";
import { ensureBios } from "./fetch-bios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const disk = resolve(process.argv[2]);
const biosDir = resolve(here, "bios");
const MEM = Number(process.env.MEM_MB ?? 512) * 1024 * 1024;
const req = createRequire(resolve(here, "../pipeline/package.json"));
const { V86 } = await import(pathToFileURL(req.resolve("v86")).href);
await ensureBios(biosDir);
const wasm = req.resolve("v86/build/v86.wasm");
const b = readFileSync(disk);
const diskBuf = () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const cfg = () => ({
  wasm_path: wasm, memory_size: MEM, vga_memory_size: 8 * 1024 * 1024,
  bios: { url: resolve(biosDir, "seabios.bin") }, vga_bios: { url: resolve(biosDir, "vgabios.bin") },
  autostart: true, disable_speaker: true,
});
let serial = "";
const mkWait = () => (n, ms) => new Promise((res, rej) => { const s = Date.now(); const iv = setInterval(() => { if (serial.includes(n)) { clearInterval(iv); res(); } else if (Date.now() - s > ms) { clearInterval(iv); rej(new Error("timeout " + n)); } }, 30); });

// ---------- 1. boot + snapshot ----------
console.log("[snap] booting to shell to take the snapshot...");
let em = new V86({ ...cfg(), hda: { buffer: diskBuf() } });
em.add_listener("serial0-output-byte", (x) => (serial += String.fromCharCode(x)));
let waitFor = mkWait();
const tBoot0 = Date.now();
await waitFor("C/C++ lab", 240000);
const bootMs = Date.now() - tBoot0;
console.log(`[snap] booted in ${(bootMs / 1000).toFixed(1)}s; dropping page cache to shrink the snapshot...`);
em.serial0_send("sync; echo 3 > /proc/sys/vm/drop_caches\n");
await new Promise((r) => setTimeout(r, 2500));
const state = await em.save_state();
const raw = Buffer.from(state);
await em.destroy();

const gz = zlib.gzipSync(raw, { level: 9 });
let zstdLine = "  (zstd not available in this Node)";
try { const z = zlib.zstdCompressSync(raw); zstdLine = `  zstd:        ${(z.length / 1048576).toFixed(1)} MiB`; } catch {}
console.log(`\n================ SNAPSHOT SIZE (memory_size=${MEM / 1048576} MiB) ================`);
console.log(`  raw:         ${(raw.length / 1048576).toFixed(1)} MiB`);
console.log(`  gzip -9:     ${(gz.length / 1048576).toFixed(1)} MiB`);
console.log(zstdLine);
writeFileSync("/tmp/state.bin", raw);

// ---------- 2. restore + measure wake-to-prompt ----------
console.log(`\n[snap] restoring from snapshot...`);
serial = "";
const tR0 = Date.now();
em = new V86({ ...cfg(), hda: { buffer: diskBuf() }, initial_state: { buffer: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) } });
em.add_listener("serial0-output-byte", (x) => (serial += String.fromCharCode(x)));
waitFor = mkWait();
// the VM is live once the state finishes loading; input before that is dropped
await new Promise((res) => em.add_listener("emulator-loaded", res));
const loadedMs = Date.now() - tR0;
// wake-to-usable = state loaded + first serial input round-trips to a fresh prompt
em.serial0_send('echo WOKE_"UP"_MARK\n');
await waitFor("WOKE_UP_MARK", 60000);
const restoreMs = Date.now() - tR0;
console.log(`[snap] state loaded: ${(loadedMs / 1000).toFixed(2)}s;  restore -> responsive prompt: ${(restoreMs / 1000).toFixed(2)}s`);

// ---------- 3. verify gcc still works after restore ----------
serial = "";
em.serial0_send("stty -echo\n");
await new Promise((r) => setTimeout(r, 300));
serial = "";
const tG = Date.now();
em.serial0_send('printf "%s\\n" "int main(void){return 0;}" > s.c; gcc s.c -o s && ./s && echo GCC_"OK"_$?\n');
await waitFor("GCC_OK_0", 60000);
console.log(`[snap] post-restore gcc compile+run: OK (${((Date.now() - tG) / 1000).toFixed(1)}s)`);
await em.destroy();

console.log(`\n================ PHASE 2 RESULT ================`);
console.log(`  cold boot -> shell:          ${(bootMs / 1000).toFixed(1)} s`);
console.log(`  snapshot state loaded:      ${(loadedMs / 1000).toFixed(2)} s`);
console.log(`  snapshot -> responsive prompt: ${(restoreMs / 1000).toFixed(2)} s   (${(bootMs / restoreMs).toFixed(0)}x faster than cold boot)`);
console.log(`  snapshot ship size (gzip):  ${(gz.length / 1048576).toFixed(1)} MiB  (raw ${(raw.length / 1048576).toFixed(0)} MiB, mem=${MEM / 1048576} MiB)`);
console.log(`  gcc works after restore:    yes`);
process.exit(0);
