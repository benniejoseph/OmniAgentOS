import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acquirePairedReleaseLock } from "./deploy-lock.mjs";

test("operator and controller share an exclusive lock and release only their own attempt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asael-paired-lock-"));
  try {
    const release = acquirePairedReleaseLock(root);
    assert.throws(() => acquirePairedReleaseLock(root), /active or needs reconciliation/);
    release(); release();
    acquirePairedReleaseLock(root)();
  } finally { await rm(root, { recursive: true, force: true }); }
});
