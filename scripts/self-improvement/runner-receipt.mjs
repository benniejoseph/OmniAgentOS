import { constants, closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function controllerReceiptPath(value) {
  if (!value) return undefined;
  const target = path.resolve(value);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !/^asael-release-controller-[a-f0-9]{32}\.json$/.test(path.basename(target))) throw new Error("Controller receipt requires a new fixed-name file in the system temporary directory.");
  return target;
}

export function writeControllerRunnerReceipt(target, value) {
  if (!target) return;
  const descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify({ version: 1, ...value, recordedAt: new Date().toISOString() })}\n`); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}
