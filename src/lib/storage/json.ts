import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Serialize read-modify-write cycles per file so concurrent request handlers
// cannot interleave and drop records in the JSON fallback stores.
const fileLocks = new Map<string, Promise<unknown>>();

export function withJsonFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(filePath) || Promise.resolve();
  const next = previous.then(task, task);
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
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

export async function updateJsonFile<T>(
  filePath: string,
  fallback: T,
  mutate: (current: T) => T | Promise<T>,
): Promise<T> {
  return withJsonFileLock(filePath, async () => {
    const current = await readJsonFile(filePath, fallback);
    const next = await mutate(current);
    await writeJsonFile(filePath, next);
    return next;
  });
}

async function quarantineCorruptFile(filePath: string) {
  try {
    await rename(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch {
    // If quarantine fails (e.g. read-only FS) the fallback value still applies.
  }
}
