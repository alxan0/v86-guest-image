// Headless v86 boot test for the Alpine i386 C/C++ guest image.
//
// Boots out/disk.img as an IDE `hda` under v86 in Node (no browser, no screen),
// waits for the serial shell, then runs the toolchain over the serial console
// and asserts gcc / g++ / gdb / valgrind all respond.
//
// Usage:
//   node verify/boot-test.mjs [path/to/disk.img]
// v86 is auto-resolved from node_modules and the BIOS is auto-fetched (pinned +
// checksummed) on first run - no manual setup, no sibling checkouts.
// Env overrides (all optional):
//   V86_MODULE  path to v86's libv86.mjs (default: auto-resolve from node_modules)
//   V86_WASM    path to v86.wasm         (default: alongside V86_MODULE)
//   BIOS_DIR    dir with seabios.bin + vgabios.bin (default: <verify>/bios)
//   BOOT_TIMEOUT_MS  overall timeout (default: 180000)

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { ensureBios } from "./fetch-bios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const diskPath = resolve(process.argv[2] ?? resolve(here, "../out/disk.img"));
const biosDir = resolve(process.env.BIOS_DIR ?? resolve(here, "bios"));
const timeoutMs = Number(process.env.BOOT_TIMEOUT_MS ?? 180000);

// Resolve the v86 package + its wasm from whichever sub-project ran
// `npm install` (the root build, or pipeline/). No hardcoded paths, no sibling
// checkouts. An explicit V86_MODULE still wins as an escape hatch.
function resolveV86() {
  if (process.env.V86_MODULE) {
    return {
      moduleUrl: pathToFileURL(process.env.V86_MODULE).href,
      wasm: process.env.V86_WASM ?? resolve(dirname(process.env.V86_MODULE), "v86.wasm"),
    };
  }
  for (const base of [here, resolve(here, ".."), resolve(here, "../pipeline")]) {
    try {
      const req = createRequire(resolve(base, "package.json"));
      return { moduleUrl: pathToFileURL(req.resolve("v86")).href, wasm: req.resolve("v86/build/v86.wasm") };
    } catch {
      /* try the next candidate node_modules */
    }
  }
  throw new Error(
    "cannot resolve the 'v86' package - run `npm install` (see README) or set V86_MODULE",
  );
}

const { moduleUrl: v86ModuleUrl, wasm: wasmPath } = resolveV86();
const { V86 } = await import(v86ModuleUrl);

// Ensure the pinned, checksum-verified BIOS blobs are present (fetched on first
// run; the v86 npm package doesn't ship them).
await ensureBios(biosDir);

const log = (...a) => console.log("[boot-test]", ...a);

let serial = "";
const emulator = new V86({
  wasm_path: wasmPath,
  memory_size: 512 * 1024 * 1024,
  vga_memory_size: 8 * 1024 * 1024,
  bios: { url: resolve(biosDir, "seabios.bin") },
  vga_bios: { url: resolve(biosDir, "vgabios.bin") },
  // exact ArrayBuffer for the file (Buffer.buffer can be a shared pool for small
  // reads; slice to this file's bytes so v86 never sees neighbour memory) - B3
  hda: { buffer: (() => { const b = readFileSync(diskPath); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })() },
  autostart: true,
  disable_speaker: true,
});

emulator.add_listener("serial0-output-byte", (byte) => {
  serial += String.fromCharCode(byte);
});

function waitFor(needle, label, ms) {
  return new Promise((res, rej) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (serial.includes(needle)) {
        clearInterval(iv);
        res();
      } else if (Date.now() - start > ms) {
        clearInterval(iv);
        rej(new Error(`timeout waiting for ${label} (${needle})`));
      }
    }, 200);
  });
}

const send = (s) => emulator.serial0_send(s);

async function run(cmd, needle, ms = 30000) {
  const marker = serial.length;
  send(cmd + "\n");
  await waitFor(needle, `"${needle}" from \`${cmd}\``, ms);
  log(`OK  ${cmd}  ->  matched "${needle}"`);
  return serial.slice(marker);
}

try {
  log(`disk = ${diskPath}`);
  log(`v86  = ${v86ModuleUrl}`);
  log("booting... (waiting for serial shell)");

  // MOTD prints "C/C++ lab" once autologin drops us at the bash prompt.
  await waitFor("C/C++ lab", "serial login / MOTD", timeoutMs);
  log("guest reached a shell");

  // Nudge for a fresh prompt, then exercise the toolchain.
  await run("uname -a", "Linux");
  await run("gcc --version", "gcc");
  await run("g++ --version", "g++");
  await run("gdb --version", "GNU gdb");
  await run("valgrind --version", "valgrind-3");

  // Compile + run a real program end-to-end.
  await run(
    "printf '#include <stdio.h>\\nint main(){puts(\"HELLO_FROM_GUEST\");return 0;}' > /tmp/t.c",
    "",
    5000,
  ).catch(() => {}); // empty needle: just settle
  await run("gcc /tmp/t.c -o /tmp/t && /tmp/t", "HELLO_FROM_GUEST");

  log("");
  log("========================================");
  log("PASS - image boots and the toolchain runs");
  log("========================================");
  await emulator.destroy();
  process.exit(0);
} catch (err) {
  log("");
  log("FAIL:", err.message);
  log("---- last 2 KB of serial output ----");
  console.log(serial.slice(-2048));
  log("------------------------------------");
  try {
    await emulator.destroy();
  } catch {}
  process.exit(1);
}
