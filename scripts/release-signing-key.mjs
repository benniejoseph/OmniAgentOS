#!/usr/bin/env node

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateReleaseSigningKey } from "./release-manifest.mjs";

// Writes a new release signing key. The private key stays on this machine,
// outside the repository; only the public key it prints is committed.
const target = process.argv[2]?.trim();
if (!target || !path.isAbsolute(target)) {
  fail("Usage: npm run release:signing-key -- <absolute path outside the repository>");
}
const repository = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const outsideRepository =
  "The signing key must live outside the repository, where no deploy uploads it.";
if (isInsideRepository(path.resolve(target))) fail(outsideRepository);
mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
// Checked again through any symbolic links on the way.
const file = path.join(realpathSync(path.dirname(target)), path.basename(target));
if (isInsideRepository(file)) fail(outsideRepository);

const key = generateReleaseSigningKey();
try {
  // Never replaces a key: a lost key is rotated, not overwritten.
  writeFileSync(file, key.privateKeyPem, { flag: "wx", mode: 0o600 });
} catch (error) {
  fail(
    error?.code === "EEXIST"
      ? `${file} already exists; choose a new path to rotate the key.`
      : `Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

console.log(`Wrote release signing key ${key.keyId} to ${file}.`);
console.log("Add its public key to RELEASE_SIGNING_PUBLIC_KEYS in scripts/release-manifest.mjs:");
console.log(`  "${key.publicKey}",`);
console.log(`Then set OMNIAGENT_RELEASE_SIGNING_KEY_FILE=${file} for releases, and back the file up.`);

/** @param {string} candidate */
function isInsideRepository(candidate) {
  const relative = path.relative(repository, candidate);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(message);
  process.exit(1);
}
