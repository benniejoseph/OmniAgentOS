import path from "node:path";
import { chmod, mkdir } from "node:fs/promises";

export function getDataRoot() {
  if (process.env.OMNIAGENT_DATA_DIR?.trim()) {
    return process.env.OMNIAGENT_DATA_DIR.trim();
  }

  if (process.env.VERCEL) {
    return path.join("/tmp", "omniagent");
  }

  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".omniagent");
}

export function getDataPath(...parts: string[]) {
  return path.join(/*turbopackIgnore: true*/ getDataRoot(), ...parts);
}

export async function ensureDataDir(...parts: string[]) {
  const dir = getDataPath(...parts);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  return dir;
}
