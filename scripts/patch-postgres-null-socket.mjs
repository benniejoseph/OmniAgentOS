import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const POSTGRES_VERSION = "3.4.9";
const CONNECTION_SOURCES = Object.freeze([
  "src/connection.js",
  "cjs/src/connection.js",
]);
// postgres.js schedules small writes with setImmediate. In 3.4.9 a socket can
// close before that callback runs, so an unguarded write terminates the process.
// A null-only guard prevents the crash but leaves the query pending forever.
// This is the exact settling guard from upstream PR #1209; keep the version and
// source-pattern fences until a release containing that fix replaces this patch.
const VULNERABLE_NEXT_WRITE = `  function nextWrite(fn) {
    const x = socket.write(chunk, fn)
    nextWriteTimer !== null && clearImmediate(nextWriteTimer)
    chunk = nextWriteTimer = null
    return x
  }`;
const NON_SETTLING_NEXT_WRITE = `  function nextWrite(fn) {
    const x = socket ? socket.write(chunk, fn) : false
    nextWriteTimer !== null && clearImmediate(nextWriteTimer)
    chunk = nextWriteTimer = null
    return x
  }`;
const SETTLING_NEXT_WRITE = `  function nextWrite(fn) {
    if (!socket) {
      // closed() nulls the socket and reconnect() only recreates it on a later
      // timer. write() is also reached from the 'data' handler, so a throw here
      // has no query to reject and escapes as an uncaughtException. Settle the
      // pending queries rather than dropping the write, or the caller hangs.
      nextWriteTimer !== null && clearImmediate(nextWriteTimer)
      chunk = nextWriteTimer = null
      error(Errors.connection('CONNECTION_CLOSED', options, socket))
      return false
    }
    const x = socket.write(chunk, fn)
    nextWriteTimer !== null && clearImmediate(nextWriteTimer)
    chunk = nextWriteTimer = null
    return x
  }`;

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
    const vulnerableCount = countOccurrences(source, VULNERABLE_NEXT_WRITE);
    const nonSettlingCount = countOccurrences(source, NON_SETTLING_NEXT_WRITE);
    const settlingCount = countOccurrences(source, SETTLING_NEXT_WRITE);

    if (
      vulnerableCount === 0 &&
      nonSettlingCount === 0 &&
      settlingCount === 1
    ) {
      results.push({ relativePath, state: "already_patched" });
      continue;
    }
    const patchableCount = vulnerableCount + nonSettlingCount;
    if (patchableCount !== 1 || settlingCount !== 0) {
      throw new Error(
        `Refusing to patch ${relativePath}: expected exactly one reviewed postgres.js nextWrite pattern.`,
      );
    }
    if (check) {
      throw new Error(
        `${relativePath} still contains the postgres.js null-socket nextWrite race.`,
      );
    }

    const reviewedSource = vulnerableCount === 1
      ? VULNERABLE_NEXT_WRITE
      : NON_SETTLING_NEXT_WRITE;
    await writeFile(
      sourcePath,
      source.replace(reviewedSource, SETTLING_NEXT_WRITE),
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
