import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Serialize read-modify-write cycles per file so concurrent request handlers
// cannot interleave and drop records in the JSON fallback stores.
const fileLocks = new Map<string, Promise<unknown>>();

export function withJsonFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(filePath) || Promise.resolve();
  const run = async () => {
    const release = await acquireCrossProcessLock(filePath);
    try {
      return await task();
    } finally {
      await release();
    }
  };
  const next = previous.then(run, run);
  fileLocks.set(
    filePath,
    next.catch(() => undefined),
  );
  return next;
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    // A file that exists but does not parse is corruption, not absence.
    // Quarantine it so the next write does not silently overwrite evidence.
    await quarantineCorruptFile(filePath);
    console.warn(`Corrupt JSON store quarantined: ${filePath}`);
    return fallback;
  }
}

export async function writeJsonFile<T>(filePath: string, value: T) {
  await writeJsonFileUnlocked(filePath, value);
}

export async function updateJsonFile<T>(
  filePath: string,
  fallback: T,
  mutate: (current: T) => T | Promise<T>,
): Promise<T> {
  return withJsonFileLock(filePath, async () => {
    const current = await readJsonFile(filePath, fallback);
    const next = await mutate(current);
    await writeJsonFileUnlocked(filePath, next);
    return next;
  });
}

async function writeJsonFileUnlocked<T>(filePath: string, value: T) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tmpPath, 0o600).catch(() => undefined);
  await rename(tmpPath, filePath);
  await chmod(filePath, 0o600).catch(() => undefined);
}

async function acquireCrossProcessLock(filePath: string) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const lockPath = `${filePath}.lock`;
  const ownerPath = path.join(lockPath, "owner.json");
  const token = randomUUID();
  const deadline = Date.now() + 10_000;

  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(ownerPath, JSON.stringify({
        pid: process.pid,
        token,
        acquiredAt: new Date().toISOString(),
      }), { encoding: "utf8", mode: 0o600 });
      return async () => {
        const owner = await readLockOwner(ownerPath);
        if (owner?.token === token) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        }
      };
    } catch (error) {
      if (!isAlreadyExists(error)) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
        const owner = await readLockOwner(ownerPath);
        if (!owner || !isProcessAlive(owner.pid)) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for JSON file lock: ${filePath}`);
      }
      await wait(15 + Math.floor(Math.random() * 35));
    }
  }
}

async function readLockOwner(ownerPath: string) {
  try {
    const parsed = JSON.parse(await readFile(ownerPath, "utf8")) as {
      pid?: unknown;
      token?: unknown;
    };
    return typeof parsed.pid === "number" && typeof parsed.token === "string"
      ? { pid: parsed.pid, token: parsed.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    );
  }
}

function isAlreadyExists(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST",
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function quarantineCorruptFile(filePath: string) {
  try {
    await rename(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch {
    // If quarantine fails (e.g. read-only FS) the fallback value still applies.
  }
}
