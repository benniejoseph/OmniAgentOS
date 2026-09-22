import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const POSTGRES_VERSION = "3.4.9";
const CONNECTION_SOURCES = Object.freeze([
  "src/connection.js",
  "cjs/src/connection.js",
]);
// postgres.js schedules small writes with setImmediate. In 3.4.9 a socket can
// close before that callback runs, so its unguarded write escapes request-level
// error handling and terminates the process. This is the exact reviewed change
// from upstream PR #1168; keep the version and source-pattern fences until a
// release containing that fix replaces this temporary install patch.
const VULNERABLE_WRITE = "    const x = socket.write(chunk, fn)";
const GUARDED_WRITE = "    const x = socket ? socket.write(chunk, fn) : false";

export async function patchPostgresNullSocketRace({
  rootDirectory = process.cwd(),
  check = false,
} = {}) {
  const packageDirectory = path.join(rootDirectory, "node_modules", "postgres");
  const manifestPath = path.join(packageDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== "postgres" || manifest.version !== POSTGRES_VERSION) {
    throw new Error(
      `Refusing to patch unexpected postgres package ${String(manifest.name)}@${String(manifest.version)}; expected postgres@${POSTGRES_VERSION}.`,
    );
  }

  const results = [];
  for (const relativePath of CONNECTION_SOURCES) {
    const sourcePath = path.join(packageDirectory, relativePath);
    const source = await readFile(sourcePath, "utf8");
    const vulnerableCount = countOccurrences(source, VULNERABLE_WRITE);
    const guardedCount = countOccurrences(source, GUARDED_WRITE);

    if (vulnerableCount === 0 && guardedCount === 1) {
      results.push({ relativePath, state: "already_patched" });
      continue;
    }
    if (vulnerableCount !== 1 || guardedCount !== 0) {
      throw new Error(
        `Refusing to patch ${relativePath}: expected exactly one reviewed postgres.js nextWrite pattern.`,
      );
    }
    if (check) {
      throw new Error(
        `${relativePath} still contains the postgres.js null-socket nextWrite race.`,
      );
    }

    await writeFile(
      sourcePath,
      source.replace(VULNERABLE_WRITE, GUARDED_WRITE),
      "utf8",
    );
    results.push({ relativePath, state: "patched" });
  }
  return Object.freeze(results);
}

function countOccurrences(source, pattern) {
  return source.split(pattern).length - 1;
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isMainModule()) {
  const check = process.argv.slice(2).includes("--check");
  try {
    const results = await patchPostgresNullSocketRace({ check });
    const states = results.map((result) => `${result.relativePath}:${result.state}`);
    console.log(`postgres.js null-socket guard verified (${states.join(", ")})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
