import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** One local operator/controller release across every checkout. A killed owner
 * leaves the lock for explicit production reconciliation; never auto-steal it. */
export function acquirePairedReleaseLock(root = path.join(homedir(), ".asael")) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const parent = lstatSync(root);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || parent.uid !== process.getuid?.()) throw new Error("Release lock directory must be private and owned by the release operator.");
  const directory = path.join(root, "production-release.lock");
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch { throw new Error("A paired release is active or needs reconciliation. Inspect ~/.asael/production-release.lock before another deployment."); }
  const marker = path.join(directory, "owner.json");
  const owner = { version: 1, token: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(marker, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
  let released = false;
  return () => {
    if (released) return;
    const current = JSON.parse(readFileSync(marker, "utf8"));
    if (current.token !== owner.token || current.pid !== owner.pid) throw new Error("Release lock owner changed; retained for reconciliation.");
    unlinkSync(marker); rmdirSync(directory); released = true;
  };
}
