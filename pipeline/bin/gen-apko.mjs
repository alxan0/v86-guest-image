#!/usr/bin/env node
// course.yaml  ->  apko.yaml (+ course-meta.json)
//
// Turns the small teacher-facing course spec into:
//   - apko.yaml         : the DETERMINISTIC apko config. Identical (branch +
//                         package set) always yields byte-identical apko.yaml,
//                         hence the same image digest (the dedup key). Contains
//                         NO course name/description/runtime/headroom.
//   - course-meta.json  : everything that must NOT influence the image digest
//                         (name, description, runtime config) plus last-mile
//                         params (disk_headroom_mb). Carried into <digest>.json.
//
// Validation is LOUD: unknown fields, non-386 archs, and `edge` all hard-error.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = resolve(HERE, "..");

// ---- platform policy (constant across all courses) -------------------------

// The 32-bit target v86 requires. NOT teacher-settable.
const ARCH = "386";

// Base userland + kernel injected into every image so a course author only
// declares course-specific tools. linux-lts (NOT linux-virt) because v86's
// disk is emulated IDE - only lts ships ata_piix/libata (see README).
const PLATFORM_PACKAGES = [
  "alpine-base",
  "openrc",
  "agetty",
  "bash",
  "linux-lts",
  "linux-firmware-none",
];

// Alpine signing keys committed under pipeline/keys (referenced relative to the
// apko workdir, which is the pipeline dir when apko runs).
const KEYRING = [
  "keys/alpine-devel@lists.alpinelinux.org-4a6a0840.rsa.pub",
  "keys/alpine-devel@lists.alpinelinux.org-5243ef4b.rsa.pub",
  "keys/alpine-devel@lists.alpinelinux.org-5261cecb.rsa.pub",
  "keys/alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub",
  "keys/alpine-devel@lists.alpinelinux.org-61666e3f.rsa.pub",
];

const ALLOWED_TOP = new Set([
  "name",
  "description",
  "branch",
  "packages",
  "disk_headroom_mb",
  "runtime",
]);
const ALLOWED_RUNTIME = new Set(["memory_size_mb", "vga_memory_size_mb"]);

function die(msg) {
  console.error(`\n  ERROR: course spec invalid: ${msg}\n`);
  process.exit(1);
}

// ---- load + validate -------------------------------------------------------

const specPath = process.argv[2];
if (!specPath) die("usage: gen-apko.mjs <course.yaml> [--out-dir DIR]");
const outFlagIdx = process.argv.indexOf("--out-dir");
const rawText = readFileSync(specPath, "utf8");

let spec;
try {
  // js-yaml's default load is safe (no arbitrary code / custom-tag construction).
  // It does resolve anchors/aliases; course specs are authored by trusted users,
  // so that's acceptable here (a hostile spec is a CI-DoS concern at most).
  spec = yaml.load(rawText) ?? {};
} catch (e) {
  die(`not valid YAML: ${e.message}`);
}
if (typeof spec !== "object" || Array.isArray(spec)) die("top level must be a mapping");

// unknown top-level fields -> error (never silent)
for (const k of Object.keys(spec)) {
  if (!ALLOWED_TOP.has(k)) {
    die(`unknown field "${k}". Allowed: ${[...ALLOWED_TOP].join(", ")}`);
  }
}

// name
if (!spec.name || typeof spec.name !== "string") die(`"name" is required (string)`);
if (!/^[a-z0-9][a-z0-9._-]*$/.test(spec.name))
  die(`"name" must be a slug [a-z0-9._-], got "${spec.name}"`);

// branch - pinned release only, reject edge
if (!spec.branch || typeof spec.branch !== "string") die(`"branch" is required (e.g. v3.20)`);
if (spec.branch === "edge")
  die(`branch "edge" is not allowed - pin a stable release like v3.20 (edge deletes old package versions)`);
if (!/^v\d+\.\d+$/.test(spec.branch))
  die(`"branch" must look like vMAJOR.MINOR (e.g. v3.20), got "${spec.branch}"`);

// packages
if (!Array.isArray(spec.packages) || spec.packages.length === 0)
  die(`"packages" must be a non-empty list`);
for (const p of spec.packages) {
  if (typeof p !== "string" || !p.trim()) die(`"packages" entries must be non-empty strings`);
  // guard against a teacher smuggling an arch or a 64-bit kernel through here
  if (/^(arch|archs)\s*[:=]/i.test(p)) die(`packages may not set an arch`);
  if (/(^|-)(x86_64|amd64)($|-)/.test(p))
    die(`package "${p}" names a 64-bit arch - v86 is 32-bit (386) only`);
  if (/^linux-(?!lts\b)/.test(p) && p !== "linux-firmware-none")
    die(`kernel package "${p}" is platform-managed; the platform ships linux-lts (only lts has the IDE driver v86 needs). Remove it.`);
}
const dupBase = spec.packages.filter((p) => PLATFORM_PACKAGES.includes(p));
if (dupBase.length)
  die(`these are platform-provided, remove them from the course: ${dupBase.join(", ")}`);

// disk_headroom_mb
let headroom = 256;
if (spec.disk_headroom_mb !== undefined) {
  if (!Number.isInteger(spec.disk_headroom_mb) || spec.disk_headroom_mb < 0 || spec.disk_headroom_mb > 4096)
    die(`"disk_headroom_mb" must be an integer 0..4096`);
  headroom = spec.disk_headroom_mb;
}

// runtime (metadata only; unknown subfields error)
const runtime = { memory_size_mb: 512, vga_memory_size_mb: 8 };
if (spec.runtime !== undefined) {
  if (typeof spec.runtime !== "object" || Array.isArray(spec.runtime))
    die(`"runtime" must be a mapping`);
  for (const k of Object.keys(spec.runtime)) {
    if (!ALLOWED_RUNTIME.has(k))
      die(`unknown runtime field "${k}". Allowed: ${[...ALLOWED_RUNTIME].join(", ")}`);
    if (!Number.isInteger(spec.runtime[k]) || spec.runtime[k] <= 0)
      die(`runtime.${k} must be a positive integer`);
  }
  Object.assign(runtime, spec.runtime);
}

// ---- emit ------------------------------------------------------------------

// Deterministic package set: platform base + course packages, de-duped, sorted.
// Sorting + no course-identity fields => same package set == same apko.yaml
// bytes == same image digest, regardless of course name or author.
const packages = [...new Set([...PLATFORM_PACKAGES, ...spec.packages])].sort();

const apko = {
  contents: {
    keyring: KEYRING,
    repositories: [
      `https://dl-cdn.alpinelinux.org/alpine/${spec.branch}/main`,
      `https://dl-cdn.alpinelinux.org/alpine/${spec.branch}/community`,
    ],
    packages,
  },
  archs: [ARCH],
  entrypoint: { command: "/bin/bash" },
};

const outDir =
  outFlagIdx !== -1 && process.argv[outFlagIdx + 1]
    ? resolve(process.argv[outFlagIdx + 1])
    : resolve(PIPELINE_DIR, "build", spec.name);
mkdirSync(outDir, { recursive: true });

const apkoYaml =
  // NOTE: these emitted header bytes are checksummed by apko.lock.json — do not
  // "clean" the em dash below; changing it invalidates every committed lock.
  "# GENERATED by gen-apko.mjs — do not edit. Edit the course spec instead.\n" +
  "# Deterministic: identical (branch + package set) => identical bytes => same digest.\n" +
  yaml.dump(apko, { sortKeys: false, lineWidth: 120, quotingType: '"' });
writeFileSync(resolve(outDir, "apko.yaml"), apkoYaml);

const meta = {
  name: spec.name,
  description: spec.description ?? "",
  branch: spec.branch,
  // digest inputs, recorded for humans (authoritative source is apko.yaml):
  packages,
  course_packages: [...spec.packages].sort(),
  // NON-digest inputs:
  disk_headroom_mb: headroom,
  runtime,
};
writeFileSync(resolve(outDir, "course-meta.json"), JSON.stringify(meta, null, 2) + "\n");

console.log(`OK ${basename(specPath)} -> ${outDir}/`);
console.log(`  apko.yaml         (${packages.length} packages, arch ${ARCH}, branch ${spec.branch})`);
console.log(`  course-meta.json  (headroom ${headroom} MiB, runtime ${runtime.memory_size_mb} MiB RAM)`);
