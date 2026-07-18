// fetch-bios.mjs — obtain the SeaBIOS + VGA BIOS blobs the v86 verify harness
// needs, from a PINNED v86 commit, verified by SHA-256.
//
// The v86 npm package deliberately does NOT ship these (they're LGPL BIOS
// binaries, not JS), so we fetch them on demand rather than vendoring third-
// party blobs into the repo. Pinned ref + checksum => reproducible and tamper-
// evident. Idempotent: a present, checksum-matching file is left untouched.
//
//   node verify/fetch-bios.mjs [dest-dir]     # default: <this dir>/bios
//   import { ensureBios } from "./fetch-bios.mjs"; await ensureBios(dir);

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Pinned v86 commit (copy/v86). Bump deliberately; update checksums to match.
export const V86_REF = "2f1346b0e7d88d4cbbbcc05fe15b4e369c3de23f";

// sha256 of each file at V86_REF (these exact bytes are verified to boot the
// generated images).
const FILES = {
  "seabios.bin": "73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98",
  "vgabios.bin": "a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880",
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const urlFor = (name) => `https://raw.githubusercontent.com/copy/v86/${V86_REF}/bios/${name}`;

/** Ensure both BIOS files exist and match their pinned checksums in `dir`. */
export async function ensureBios(dir = resolve(HERE, "bios")) {
  mkdirSync(dir, { recursive: true });
  for (const [name, want] of Object.entries(FILES)) {
    const dest = resolve(dir, name);
    if (existsSync(dest) && sha256(readFileSync(dest)) === want) {
      continue; // already present and valid
    }
    process.stderr.write(`[fetch-bios] downloading ${name} @ ${V86_REF.slice(0, 12)}…\n`);
    const res = await fetch(urlFor(name));
    if (!res.ok) throw new Error(`fetch ${name}: HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    if (got !== want) {
      throw new Error(`checksum mismatch for ${name}\n  expected ${want}\n  got      ${got}`);
    }
    writeFileSync(dest, buf);
    process.stderr.write(`[fetch-bios] ${name} ok (${buf.length} bytes)\n`);
  }
  return dir;
}

// CLI (robust run-as-main check: URL-encoded compare, handles spaces in paths) — B4
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, "bios");
  ensureBios(dir)
    .then((d) => console.log(`BIOS ready in ${d}`))
    .catch((e) => {
      console.error(`[fetch-bios] ${e.message}`);
      process.exit(1);
    });
}
