// Phase-1 verification harness: drives the exact student sequence over the
// serial console in headless v86 and TIMES every step (wall-clock), then runs
// the extra in-guest checks the static review couldn't (writable root, binary
// arch, network isolation, strip). Prints a timings table + a checks table.
//
//   node verify/student-flow.mjs [path/to/disk.img]
//
// Marker scheme: each command is followed by `echo "MA""RK<n>z"`. The command
// text ("echo \"MA\"\"RK5z\"") never contains the output token ("MARK5z"), so
// waiting for the token can't false-match the terminal's input echo — no stty
// games needed, timings are honest.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { ensureBios } from "./fetch-bios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const diskPath = resolve(process.argv[2] ?? resolve(here, "../pipeline/registry/images"));
const biosDir = resolve(process.env.BIOS_DIR ?? resolve(here, "bios"));
const BOOT_MS = Number(process.env.BOOT_TIMEOUT_MS ?? 240000);

function resolveV86() {
  if (process.env.V86_MODULE)
    return {
      moduleUrl: pathToFileURL(process.env.V86_MODULE).href,
      wasm: process.env.V86_WASM ?? resolve(dirname(process.env.V86_MODULE), "v86.wasm"),
    };
  for (const base of [here, resolve(here, ".."), resolve(here, "../pipeline")]) {
    try {
      const req = createRequire(resolve(base, "package.json"));
      return { moduleUrl: pathToFileURL(req.resolve("v86")).href, wasm: req.resolve("v86/build/v86.wasm") };
    } catch {}
  }
  throw new Error("cannot resolve v86 — run npm install");
}

const { moduleUrl, wasm } = resolveV86();
const { V86 } = await import(moduleUrl);
await ensureBios(biosDir);

let serial = "";
const emulator = new V86({
  wasm_path: wasm,
  memory_size: 512 * 1024 * 1024,
  vga_memory_size: 8 * 1024 * 1024,
  bios: { url: resolve(biosDir, "seabios.bin") },
  vga_bios: { url: resolve(biosDir, "vgabios.bin") },
  hda: { buffer: (() => { const b = readFileSync(diskPath); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })() },
  autostart: true,
  disable_speaker: true,
});
emulator.add_listener("serial0-output-byte", (b) => (serial += String.fromCharCode(b)));

function waitFor(needle, ms) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (serial.includes(needle)) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for ${JSON.stringify(needle)}`)); }
    }, 50);
  });
}

let N = 0;
// send `cmd`, wait for its unique completion marker, return {ms, out}
async function step(cmd, ms = 60000) {
  const tok = `MARK${++N}z`;
  const from = serial.length;
  const t0 = Date.now();
  emulator.serial0_send(`${cmd}; echo "MA""RK${N}z"\n`);
  await waitFor(tok, ms);
  const dt = Date.now() - t0;
  const out = serial
    .slice(from, serial.lastIndexOf(tok))
    .replace(/\r/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""); // strip ANSI/bracketed-paste sequences
  return { ms: dt, out };
}

const timings = [];
const checks = [];
const t = (label, ms) => timings.push({ label, ms });
const check = (label, pass, detail) => checks.push({ label, pass, detail });

try {
  const tStart = Date.now();
  await waitFor("C/C++ lab", BOOT_MS); // MOTD => autologin reached the shell
  t("boot → passwordless root shell", Date.now() - tStart);
  // settle the prompt, then turn off terminal echo so captured output is clean
  await step("true", 15000);
  await step("stty -echo", 15000);

  // identity: autologin as root, no password was asked
  const id = await step("id -un");
  check("autologin as root (no login/password)", /root/.test(id.out), id.out.trim());

  // writable root — this is the ro-vs-rw landmine
  const mnt = await step("grep ' / ' /proc/mounts");
  const rootRW = /\/dev\/\S+ \/ ext4 rw/.test(mnt.out) || / \/ ext4 rw,/.test(mnt.out);
  check("root filesystem mounted rw (not ro)", rootRW, mnt.out.trim());
  const tw = await step("touch /tmp/x && echo WRITE_OK");
  check("rootfs writable (touch)", /WRITE_OK/.test(tw.out), tw.out.trim().split("\n").pop());

  // arch of the running kernel + the gcc binary (bytes, since `file` isn't installed)
  const un = await step("uname -m");
  check("kernel arch 32-bit (uname -m)", /i[3-6]86/.test(un.out), un.out.trim());
  const elf = await step("head -c5 /usr/bin/gcc | od -An -tx1");
  check("gcc is ELFCLASS32 (byte 5 == 01)", /7f 45 4c 46 01/.test(elf.out), elf.out.trim());

  // network isolation — no NIC configured; only loopback must exist
  const nets = await step("ls /sys/class/net");
  const onlyLo = nets.out.split(/\s+/).filter(Boolean).join(",") === "lo";
  check("no network device (only lo)", onlyLo, nets.out.trim());
  const route = await step("wget -T 3 -q -O- http://1.1.1.1 2>&1; echo RC=$?");
  check("no route out (wget fails)", /RC=[^0]/.test(route.out), route.out.trim().split("\n").pop());

  // strip actually happened
  const man = await step("ls /usr/share/man 2>&1; echo RC=$?");
  check("man pages stripped", /RC=[^0]/.test(man.out), man.out.trim().split("\n").pop());

  // ---- the headline student sequence, timed ----
  // Build hello.c line-by-line with heredoc-free appends (no %-specifiers pass
  // through the shell). Real malloc/free so valgrind actually tracks heap.
  await step("rm -f hello.c hello", 10000);
  for (const line of [
    "#include <stdio.h>",
    "#include <stdlib.h>",
    "int main(void){",
    "  char *b = malloc(32);",
    '  snprintf(b, 32, "HELLO_FROM_GUEST_42");',
    '  puts(b);',
    "  free(b);",
    "  return 0;",
    "}",
  ]) {
    await step(`printf '%s\\n' ${JSON.stringify(line)} >> hello.c`, 10000);
  }
  const wc = await step("wc -l hello.c");
  check("wrote hello.c (real program)", /9 hello.c/.test(wc.out), wc.out.trim());

  const gcc = await step("time gcc hello.c -o hello", 120000);
  t("gcc hello.c -o hello", gcc.ms);
  check("gcc compiles clean (no errors)", !/error|warning/i.test(gcc.out), (gcc.out.match(/real\s+\S+/)||[""])[0]);

  const runHello = await step("./hello", 30000);
  t("./hello", runHello.ms);
  check("./hello prints expected output", /HELLO_FROM_GUEST_42/.test(runHello.out), runHello.out.trim());

  const gdb = await step("gdb -batch -ex run -ex quit ./hello 2>&1", 120000);
  t("gdb (launch + run + quit)", gdb.ms);
  check("gdb runs the program & exits cleanly",
        /HELLO_FROM_GUEST_42/.test(gdb.out) && /(exited normally|exited with code|Inferior)/.test(gdb.out),
        (gdb.out.match(/\[Inferior[^\]]*\]/) || [gdb.out.replace(/\n/g," ").slice(0,80)])[0]);
  process.stdout.write("---- raw gdb (dynamic) ----\n" + gdb.out + "\n---------------------------\n");

  // DIAGNOSTIC: is the SIGSEGV tied to musl's dynamic linker under v86?
  await step("gcc -static hello.c -o hello_s 2>&1", 120000);
  const gdbStatic = await step("gdb -batch -ex run -ex quit ./hello_s 2>&1", 120000);
  check("gdb runs a STATIC binary cleanly",
        /HELLO_FROM_GUEST_42/.test(gdbStatic.out) && !/SIGSEGV/.test(gdbStatic.out),
        (gdbStatic.out.match(/\[Inferior[^\]]*\]|SIGSEGV/) || ["?"])[0]);
  process.stdout.write("---- raw gdb (static) ----\n" + gdbStatic.out + "\n--------------------------\n");
  // DIAGNOSTIC: does a breakpoint + stepping work at all?
  const gdbBreak = await step('gdb -batch -ex "break main" -ex run -ex "bt" -ex "info locals" -ex quit ./hello 2>&1', 120000);
  check("gdb breakpoint at main hits",
        /Breakpoint 1.*main|in main/.test(gdbBreak.out),
        (gdbBreak.out.match(/Breakpoint 1[^\n]*/) || ["(no breakpoint hit)"])[0]);
  process.stdout.write("---- raw gdb (break main) ----\n" + gdbBreak.out + "\n------------------------------\n");

  const val = await step("valgrind ./hello 2>&1", 180000);
  t("valgrind ./hello", val.ms);
  const errSummary = (val.out.match(/ERROR SUMMARY:.*/)||[""])[0].trim();
  const leakLine = (val.out.match(/(All heap blocks were freed[^\n]*|in use at exit:[^\n]*|no leaks are possible)/)||[""])[0].trim();
  check("valgrind runs on 386 & reports leaks",
        /ERROR SUMMARY:\s*0 errors/.test(val.out) || /no leaks are possible/.test(val.out) || /in use at exit: 0 bytes/.test(val.out),
        `${leakLine} | ${errSummary}`);

  // ---- report ----
  const pad = (s,n)=>String(s).padEnd(n);
  console.log("\n================ TIMINGS (wall-clock) ================");
  console.log(pad("step",36)+"seconds");
  console.log("-".repeat(48));
  for (const {label,ms} of timings) console.log(pad(label,36)+(ms/1000).toFixed(1));
  console.log("\n================ CHECKS ================");
  let allPass = true;
  for (const {label,pass,detail} of checks) {
    if(!pass) allPass=false;
    console.log(`${pass?"PASS":"FAIL"}  ${pad(label,42)} ${detail?("| "+detail):""}`);
  }
  console.log("\nvalgrind raw tail:\n" + val.out.split("\n").slice(-8).join("\n"));
  console.log("\n" + (allPass ? "ALL CHECKS PASS" : "SOME CHECKS FAILED"));
  await emulator.destroy();
  process.exit(allPass ? 0 : 1);
} catch (err) {
  console.log("\nHARNESS ERROR:", err.message);
  console.log("---- last 3KB serial ----\n" + serial.slice(-3072));
  try { await emulator.destroy(); } catch {}
  process.exit(2);
}
