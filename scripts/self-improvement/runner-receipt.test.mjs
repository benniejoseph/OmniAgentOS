import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { controllerReceiptPath, writeControllerRunnerReceipt } from "./runner-receipt.mjs";

test("controller receipt path cannot be supplied as an arbitrary write target", () => {
  for (const value of ["/etc/passwd", "./receipt.json", path.join(tmpdir(), "existing.json")]) assert.throws(() => controllerReceiptPath(value));
  assert.equal(controllerReceiptPath(undefined), undefined);
});
test("runner receipt is private, durable and never overwritten", async () => {
  const target = controllerReceiptPath(path.join(tmpdir(), `asael-release-controller-${randomUUID().replaceAll("-", "")}.json`));
  try {
    writeControllerRunnerReceipt(target, { outcome: "failed", candidateRevision: "a".repeat(40) });
    const result = JSON.parse(await readFile(target, "utf8"));
    assert.equal(result.outcome, "failed"); assert.equal(result.version, 1);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.throws(() => writeControllerRunnerReceipt(target, { outcome: "deployed" }));
  } finally { await rm(target, { force: true }); }
});
