// Phase-1 boot profiler: timestamps every serial line (wall-clock ms from v86
// start) and extracts the kernel's own [N.NNNNNN] timestamps, to attribute the
// boot time to SeaBIOS/handoff, kernel init, device probe, initramfs, root
// mount, and each OpenRC service.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { ensureBios } from "./fetch-bios.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const disk = resolve(process.argv[2]);
const biosDir = resolve(here, "bios");
const req = createRequire(resolve(here, "../pipeline/package.json"));
const { V86 } = await import(pathToFileURL(req.resolve("v86")).href);
await ensureBios(biosDir);

const lines = []; // { t, text }
let cur = "";
let t0 = 0;
let firstByteT = 0;

const b = readFileSync(disk);
const emulator = new V86({
  wasm_path: req.resolve("v86/build/v86.wasm"),
  memory_size: 512 * 1024 * 1024, vga_memory_size: 8 * 1024 * 1024,
  bios: { url: resolve(biosDir, "seabios.bin") }, vga_bios: { url: resolve(biosDir, "vgabios.bin") },
  hda: { buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) },
  autostart: true, disable_speaker: true,
});
t0 = Date.now();
emulator.add_listener("serial0-output-byte", (byte) => {
  if (!firstByteT) firstByteT = Date.now();
  const c = String.fromCharCode(byte);
  if (c === "\n") { lines.push({ t: Date.now() - t0, text: cur.replace(/\r/g, "") }); cur = ""; }
  else cur += c;
});

const off = (ms) => (ms / 1000).toFixed(2).padStart(6);
function waitFor(n, ms) { return new Promise((res, rej) => { const s = Date.now(); const iv = setInterval(() => { if (lines.some(l => l.text.includes(n)) || cur.includes(n)) { clearInterval(iv); res(); } else if (Date.now() - s > ms) { clearInterval(iv); rej(new Error("timeout " + n)); } }, 50); }); }

try {
  await waitFor("C/C++ lab", 240000);
  const shellT = lines.find(l => l.text.includes("C/C++ lab"))?.t ?? (Date.now() - t0);

  console.log(`\n================ ANNOTATED BOOT LOG (wall-clock s from v86 start) ================`);
  for (const l of lines) if (l.text.trim()) console.log(`${off(l.t)}  ${l.text}`);

  // --- kernel internal timestamps ---
  const kre = /\[\s*(\d+\.\d+)\]\s*(.*)$/;
  const kmsgs = lines.map(l => { const m = l.text.match(kre); return m ? { kt: parseFloat(m[1]), wall: l.t, msg: m[2] } : null; }).filter(Boolean);
  const lastK = kmsgs.length ? kmsgs[kmsgs.length - 1] : null;

  const find = (re) => lines.find(l => re.test(l.text));
  const marker = (label, re) => { const l = find(re); return { label, t: l ? l.t : null, text: l ? l.text.slice(0, 70) : "(not seen)" }; };

  console.log(`\n================ PHASE MARKERS (wall-clock) ================`);
  const M = [
    marker("first serial byte", /.*/),
    marker("kernel entry (Linux version)", /Linux version/),
    marker("ATA/IDE probe (ata_piix|sd 0)", /ata_piix|scsi host|sd \d|\bsda\b/),
    marker("initramfs / nlplug-findfs", /nlplug|initramfs|Loading|mounting root|Alpine Init/i),
    marker("root ext4 mounted", /EXT4-fs.*mounted|Freeing unused/),
    marker("openrc sysinit begins", /openrc.*sysinit|Starting.*sysinit|\* Mounting/i),
    marker("openrc boot phase", /Setting hostname|\* Starting.*bootmisc|sysctl/i),
    marker("openrc default / getty", /Starting.*default|autologin|login\[/i),
    { label: "SHELL READY (C/C++ lab)", t: shellT, text: "MOTD printed" },
  ];
  M.forEach(m => console.log(`${m.t == null ? "  --  " : off(m.t)}  ${m.label}  | ${m.text}`));
  M[0].t = firstByteT - t0;

  console.log(`\n================ ATTRIBUTED PHASES ================`);
  const seg = (a, b, label) => { if (a?.t == null || b?.t == null) { console.log(`   --   ${label}`); return; } console.log(`${off(b.t - a.t)}s  ${label}`); };
  console.log(`${off(firstByteT - t0)}s  v86 start → first serial byte (SeaBIOS/handoff/decompress)`);
  seg(M[1], M[8], "kernel entry → shell (total in-guest)");
  seg(M[1], M[4], "  kernel entry → root mounted (kernel init + probe + initramfs)");
  seg(M[4], M[5], "  root mounted → openrc sysinit");
  seg(M[5], M[8], "  openrc (sysinit+boot+default) → shell");
  console.log(`${off(shellT)}s  TOTAL: v86 start → shell`);
  if (lastK) console.log(`\nkernel's last internal timestamp: [${lastK.kt}] (kernel spent ~${lastK.kt}s before handing to userspace-ish)`);

  await emulator.destroy(); process.exit(0);
} catch (e) {
  console.log("PROFILE ERROR:", e.message, "\n", lines.slice(-30).map(l => off(l.t) + " " + l.text).join("\n"));
  try { await emulator.destroy(); } catch {} process.exit(2);
}
