import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { createReindexGate, freezeReindexSubmission, readReindexReceipt, reindexReceiptLabel, runReindexBatch } from "./reindex-state";

const owner = { tenantId: "tenant-a", actorId: "owner-a" };
const target = { ...owner, id: "asset-a", filename: "Exact bytes.txt", contentSha256: "a".repeat(64), byteCount: 10, mediaType: "text/plain" };
const submission = () => freezeReindexSubmission(target, owner, "capture-reindex-exact-key");
function receipt(status = "queued", flags: { duplicate?: boolean; repaired?: boolean } = {}) {
  const data = { asset: { ...target, status: flags.repaired ? "indexed" : "queued", ingestJobId: "job-a" },
    job: { id: "job-a", type: "capture.asset.process", status }, ...flags };
  const body = { schemaVersion: 1, receiptKind: "app_service_receipt", boundaryVersion: "p9.1-app-service-boundary:1", operation: "app.assets.index",
    action: "write.memory", resourceType: "capture_asset", accessMode: "mutation", eventContract: "capture-events.v1", authoritySha256: "b".repeat(64),
    idempotencyKeySha256: createHash("sha256").update(`${owner.tenantId}\u0000${submission().key}`).digest("hex"), outcomeSha256: canonicalJsonSha256(data),
    resourceCount: 1, occurredAt: "2026-10-04T10:00:00.000Z" };
  return { ...data, serviceReceipt: { ...body, receiptSha256: canonicalJsonSha256(body) } };
}

describe("exact reindex receipts", () => {
  it("verifies the existing server canonical digests and preserves actual accepted status", async () => {
    const value = await readReindexReceipt(receipt(), submission());
    expect(value).toMatchObject({ assetId: "asset-a", jobId: "job-a", status: "queued", duplicate: false });
    expect(reindexReceiptLabel(value)).toBe("Accepted job · Queued");
  });
  it("distinguishes duplicate running, completed repair and terminal failure from new queued work", async () => {
    expect(reindexReceiptLabel(await readReindexReceipt(receipt("running", { duplicate: true }), submission()))).toBe("Existing job · Running");
    expect(reindexReceiptLabel(await readReindexReceipt(receipt("completed", { duplicate: true, repaired: true }), submission()))).toBe("Existing completed job · source index repaired");
    expect(reindexReceiptLabel(await readReindexReceipt(receipt("failed", { duplicate: true }), submission()))).toBe("Existing job · Failed");
  });
  it("does not accept changed source bytes, foreign ownership, unrelated jobs or an unbound key", async () => {
    const original = receipt();
    for (const value of [
      { ...original, asset: { ...original.asset, actorId: "other" } },
      { ...original, asset: { ...original.asset, contentSha256: "c".repeat(64) } },
      { ...original, asset: { ...original.asset, filename: "different.txt" } },
      { ...original, job: { ...original.job, id: "other" } },
      { ...original, serviceReceipt: { ...original.serviceReceipt, idempotencyKeySha256: "c".repeat(64) } },
      { ...original, serviceReceipt: { ...original.serviceReceipt, receiptSha256: "c".repeat(64) } },
      { ...original, serviceReceipt: { ...original.serviceReceipt, unexpectedAuthority: true } },
      { asset: original.asset, job: original.job },
    ]) await expect(readReindexReceipt(value, submission())).rejects.toThrow("could not be verified");
  });
  it("rejects internally false repair receipts even when the server-style digests match", async () => {
    await expect(readReindexReceipt(receipt("queued", { duplicate: true, repaired: true }), submission())).rejects.toThrow();
    await expect(readReindexReceipt(receipt("completed", { repaired: true }), submission())).rejects.toThrow();
  });
  it("freezes the original body, key and source rather than reading a later mutable row", () => {
    const source = { ...target };
    const frozen = freezeReindexSubmission(source, owner, "exact-key");
    source.contentSha256 = "c".repeat(64);
    expect(frozen.target.contentSha256).toBe("a".repeat(64));
    expect(frozen.body).toBe("{}");
    expect(Object.isFrozen(frozen.target)).toBe(true);
    expect(() => freezeReindexSubmission({ ...source, actorId: "other" }, owner, "exact-key")).toThrow();
    expect(() => freezeReindexSubmission(source, owner, "x".repeat(201))).toThrow();
  });
});

describe("bounded reindex admission", () => {
  it("preserves uncertainty through same-scope verification without exposing it while unverified", () => {
    const gate = createReindexGate();
    gate.enter("owner-a");
    const first = gate.begin("owner-a")!;
    const sent = submission();
    gate.hold(first, { submission: sent, state: "unconfirmed" });
    gate.dispose(); gate.enter("");
    expect(gate.current(first)).toBe(false);
    expect(gate.begin("owner-a")).toBeUndefined();
    expect(gate.heldRows("owner-a")).toEqual([]);
    expect(gate.heldRows("")).toEqual([]);
    expect(gate.held("", target.id)).toBe(false);
    gate.dispose(); gate.enter("owner-a");
    expect(gate.heldRows("owner-a")[0].submission).toBe(sent);
    gate.dispose(); gate.enter("owner-b");
    expect(gate.heldRows("owner-b")).toEqual([]);
    gate.dispose(); gate.enter("owner-a");
    expect(gate.heldRows("owner-a")).toEqual([]);
  });
  it("retains an unknown original/key after completion and across later source batches until scope disposal", () => {
    const gate = createReindexGate();
    gate.enter("owner-a");
    const first = gate.begin("owner-a")!;
    const sent = submission();
    gate.hold(first, { submission: sent, state: "unconfirmed", message: "Response lost" });
    gate.finish(first);
    // Source refresh is independently fallible and cannot prove this key's receipt.
    expect(gate.held("owner-a", target.id)).toBe(true);
    const second = gate.begin("owner-a")!;
    expect(gate.heldRows("owner-a")[0].submission).toBe(sent);
    gate.finish(second);
    expect(gate.held("owner-a", target.id)).toBe(true);
    expect(gate.heldRows("other")).toEqual([]);
    gate.dispose();
    expect(gate.heldRows("owner-a")).toEqual([]);
  });
  it("excludes synchronous overlap and invalidates an earlier owner A after A → B → A", () => {
    const gate = createReindexGate();
    gate.enter("owner-a");
    const first = gate.begin("owner-a")!;
    expect(gate.begin("owner-a")).toBeUndefined();
    gate.enter("owner-b");
    gate.enter("owner-a");
    const latest = gate.begin("owner-a")!;
    expect(gate.current(first)).toBe(false);
    gate.finish(first);
    expect(gate.current(latest)).toBe(true);
    gate.dispose();
    expect(gate.current(latest)).toBe(false);
  });
  it("stops later batch requests after disposal while already-sent requests settle independently", async () => {
    const gate = createReindexGate();
    gate.enter("owner-a");
    const token = gate.begin("owner-a")!;
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const result = runReindexBatch([0, 1, 2, 3, 4], () => gate.current(token), async (item) => {
      started.push(item);
      await new Promise<void>((resolve) => releases.push(resolve));
      return item;
    });
    expect(started).toEqual([0, 1, 2]);
    gate.dispose();
    releases.forEach((release) => release());
    const settled = await result;
    expect(started).toEqual([0, 1, 2]);
    expect(settled.slice(0, 3)).toEqual([0, 1, 2]);
    expect(settled[3]).toBeUndefined();
  });
});
