import { describe, expect, it } from "vitest";
import { createVisualStudioRequestGate, readVisualStudioAssetReceipt, readVisualStudioIndexReceipt } from "./visual-studio-request";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("Visual Studio request receipts", () => {
  it("blocks duplicate creates and saving a retained result during another create", () => {
    const gate = createVisualStudioRequestGate();
    const first = gate.beginCreate()!;
    expect(gate.beginCreate()).toBeUndefined();
    const result = gate.acceptResult(first, "asset-a")!;
    gate.finish(first);
    const second = gate.beginCreate()!;
    expect(gate.beginSave(result)).toBeUndefined();
    expect(gate.isCurrentResult(result)).toBe(true);
    gate.finish(second);
    expect(gate.beginSave(result)).toBeDefined();
  });

  it("keeps a pending Save A from overlapping Create B and rejects its late receipt", async () => {
    const gate = createVisualStudioRequestGate();
    const createA = gate.beginCreate()!;
    const resultA = gate.acceptResult(createA, "asset-a")!;
    gate.finish(createA);
    const saveA = gate.beginSave(resultA)!;
    const response = deferred<string>();
    const receipt = response.promise.then(() => gate.canApplySave(saveA));
    expect(gate.beginCreate()).toBeUndefined();
    gate.finish(saveA);
    const createB = gate.beginCreate()!;
    const resultB = gate.acceptResult(createB, "asset-b")!;
    response.resolve("accepted-a");
    expect(await receipt).toBe(false);
    expect(gate.finish(saveA)).toBe(false);
    expect(gate.isCurrent(createB)).toBe(true);
    expect(gate.isCurrentResult(resultB)).toBe(true);
  });

  it("rejects a late create after disposal and reactivation without clearing the new request", async () => {
    const gate = createVisualStudioRequestGate();
    const old = gate.beginCreate()!;
    const response = deferred<string>();
    const receipt = response.promise.then((id) => gate.acceptResult(old, id));
    gate.dispose();
    gate.activate();
    const current = gate.beginCreate()!;
    response.resolve("late-asset");
    expect(await receipt).toBeUndefined();
    expect(gate.finish(old)).toBe(false);
    expect(gate.isCurrent(current)).toBe(true);
  });

  it("binds preview/save receipts to the request even if two results reuse the same asset id", () => {
    const gate = createVisualStudioRequestGate();
    const first = gate.beginCreate()!;
    const oldResult = gate.acceptResult(first, "same-asset")!;
    gate.finish(first);
    const next = gate.beginCreate()!;
    const newResult = gate.acceptResult(next, "same-asset")!;
    gate.finish(next);
    expect(gate.isCurrentResult(oldResult)).toBe(false);
    expect(gate.beginSave(oldResult)).toBeUndefined();
    expect(gate.beginSave({ ...newResult })).toBeUndefined();
    const save = gate.beginSave(newResult)!;
    expect(gate.canApplySave(save)).toBe(true);
  });

  it("does not turn a disposed save into a confirmed receipt", async () => {
    const gate = createVisualStudioRequestGate();
    const create = gate.beginCreate()!;
    const result = gate.acceptResult(create, "asset-a")!;
    gate.finish(create);
    const save = gate.beginSave(result)!;
    const response = deferred<void>();
    const receipt = response.promise.then(() => gate.canApplySave(save));
    gate.dispose();
    response.resolve();
    expect(await receipt).toBe(false);
    expect(gate.beginCreate()).toBeUndefined();
    expect(gate.beginSave(result)).toBeUndefined();
  });
});

describe("Visual Studio route receipt identity", () => {
  const context = { mode: "image", operation: "edit", sourceAssetId: "source-a" } as const;
  const receipt = {
    operation: "edit", provider: "fixture-provider", model: "fixture-model", sourceAssetIds: ["source-a"],
    asset: { id: "asset-a", filename: "edited.png", byteCount: 123, storageKind: "database" },
  };

  it("accepts the exact operation and owned source receipt without retaining provider URLs", () => {
    expect(readVisualStudioAssetReceipt({ ...receipt, image: "https://provider.invalid/file" }, context)).toEqual({ asset: receipt.asset, provider: receipt.provider, model: receipt.model });
  });

  it("refuses a mismatched operation, source, kind, or malformed stored asset", () => {
    for (const change of [
      { operation: "generate" }, { sourceAssetIds: ["source-b"] }, { sourceAssetIds: [] },
      { kind: "video" }, { model: undefined },
      { asset: { ...receipt.asset, id: "https://provider.invalid/file" } },
      { asset: { ...receipt.asset, filename: "" } },
      { asset: { ...receipt.asset, byteCount: 0 } },
      { asset: { ...receipt.asset, byteCount: 20 * 1024 * 1024 + 1 } },
      { asset: { ...receipt.asset, storageKind: "remote-url" } },
      { asset: { ...receipt.asset, mediaType: "video/mp4" } },
    ]) expect(readVisualStudioAssetReceipt({ ...receipt, ...change }, context)).toBeUndefined();
  });

  it("accepts the existing clip receipt without inventing generation metadata", () => {
    expect(readVisualStudioAssetReceipt({ operation: "clip", asset: receipt.asset }, { mode: "clip", operation: "clip", sourceAssetId: "source-video" })).toEqual({ asset: receipt.asset });
  });

  it("requires the exact saved asset and a known job state before accepting indexing", () => {
    const accepted = { asset: { id: "asset-a" }, job: { id: "job-a", status: "queued" } };
    expect(readVisualStudioIndexReceipt(accepted, "asset-a")).toEqual(accepted.job);
    expect(readVisualStudioIndexReceipt(accepted, "asset-b")).toBeUndefined();
    expect(readVisualStudioIndexReceipt({ job: accepted.job }, "asset-a")).toBeUndefined();
    expect(readVisualStudioIndexReceipt({ ...accepted, job: { id: "job-a", status: "unknown" } }, "asset-a")).toBeUndefined();
    expect(readVisualStudioIndexReceipt({ ...accepted, job: { id: "", status: "queued" } }, "asset-a")).toBeUndefined();
  });

  it("preserves additional returned job metadata for the existing Capture callback", () => {
    const job = { id: "job-a", status: "running", type: "capture.asset.process", attempts: 2, maxAttempts: 4, progress: { stage: "extracting" }, createdAt: "2026-10-03T00:00:00.000Z" };
    expect(readVisualStudioIndexReceipt({ asset: { id: "asset-a" }, job }, "asset-a")).toEqual(job);
  });
});
