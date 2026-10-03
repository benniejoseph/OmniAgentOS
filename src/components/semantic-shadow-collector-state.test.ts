import { describe, expect, it, vi } from "vitest";
import {
  collectSemanticShadowBatch,
  createSemanticCollectionGate,
  createSemanticPollGate,
  mergeSemanticShadowJobs,
  parseSemanticEnqueueReceipt,
  parseSemanticPoll,
  parseSemanticThreadIds,
  semanticShadowBatchSize,
  semanticShadowReadState,
  type SemanticEnqueueReceipt,
  type SemanticShadowJob,
} from "@/components/semantic-shadow-collector-state";

function publicJob(id = "job-1", status = "queued", outcome?: string) {
  return { id, type: "conversation.summary.enrich", status, progress: { stage: status === "completed" ? "completed" : "queued", shadowOnly: true, ...(outcome ? { outcome } : {}) } };
}
function receipt(jobs: unknown[] = [publicJob()], status = "queued") {
  return {
    deterministicSummariesActive: true,
    semanticEnrichment: { status, shadowOnly: true },
    jobs,
    eligibleEpisodeCount: 1,
    queuedJobCount: status === "queued" ? jobs.length : 0,
    upToDateCount: 0,
    staleEpisodeCount: 0,
    skippedEpisodeCount: 0,
    remainingEpisodeCount: 0,
  };
}
function stats() {
  return {
    currentEpisodeCount: 24, distinctThreadCount: 6,
    minimumEpisodeTarget: 24 as const, minimumThreadTarget: 6 as const,
    sampleReadyForHumanReview: true, activationReady: false as const,
    deterministicSummariesActive: true as const, shadowOnly: true as const,
    rankingEffect: "none" as const,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
function confirmed(threadId: string): SemanticEnqueueReceipt {
  return parseSemanticEnqueueReceipt(receipt([publicJob(`job-${threadId}`)]), threadId);
}

describe("semantic collector read and receipt truth", () => {
  it("does not mistake missing or invalid counts for completed targets", () => {
    expect(semanticShadowBatchSize(undefined)).toBe(0);
    expect(semanticShadowReadState(undefined, true)).toBe("loading");
    expect(semanticShadowReadState(undefined, false, "Unavailable")).toBe("unavailable");
    expect(semanticShadowReadState(stats(), true)).toBe("stale");
    expect(semanticShadowReadState(stats(), false, "Refresh failed")).toBe("stale");
    expect(semanticShadowReadState(stats(), false)).toBe("ready");
    expect(semanticShadowReadState({ ...stats(), currentEpisodeCount: NaN }, false)).toBe("unavailable");
  });

  it("keeps actual terminal outcomes and the exact requested thread identity", () => {
    const parsed = parseSemanticEnqueueReceipt(receipt([{ ...publicJob("job-1", "completed", "already_current"), threadId: "untrusted-thread", payload: { private: true } }], "up_to_date"), "requested-thread");
    expect(parsed.issue).toBeUndefined();
    expect(parsed.jobs).toEqual([{ id: "job-1", status: "completed", threadId: "requested-thread", progress: { stage: "completed", shadowOnly: true, outcome: "already_current" } }]);
  });

  it("retains an independently valid job when part of its receipt is malformed", () => {
    const parsed = parseSemanticEnqueueReceipt({ ...receipt(), remainingEpisodeCount: "unknown" }, "thread-1");
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.issue).toContain("could not be verified");
  });

  it("treats missing queued receipts and malformed successful bodies as unconfirmed", () => {
    expect(parseSemanticEnqueueReceipt({ ...receipt([]), queuedJobCount: 1 }, "thread-1").issue).toBeTruthy();
    expect(parseSemanticEnqueueReceipt(undefined, "thread-1").issue).toBeTruthy();
    expect(parseSemanticEnqueueReceipt({ jobs: [] }, "thread-1").status).toBeUndefined();
  });

  it("does not pick an arbitrary state from duplicate or excess limit-one receipts", () => {
    const duplicate = parseSemanticEnqueueReceipt(receipt([publicJob("job-1"), publicJob("job-1", "completed", "enriched")]), "thread-1");
    expect(duplicate.jobs).toEqual([]);
    expect(duplicate.issue).toBeTruthy();
    expect(parseSemanticEnqueueReceipt(receipt([publicJob("job-1"), publicJob("job-2")]), "thread-1").jobs).toEqual([]);
  });

  it("requires semantic-only jobs and rejects unsupported public progress", () => {
    const wrongType = { ...publicJob(), type: "another.operation" };
    const wrongProgress = { ...publicJob(), progress: { stage: "private-new-stage", shadowOnly: true } };
    for (const job of [wrongType, wrongProgress]) {
      const parsed = parseSemanticEnqueueReceipt(receipt([job]), "thread-1");
      expect(parsed.jobs).toEqual([]);
      expect(parsed.issue).toBeTruthy();
    }
  });

  it("keeps a valid empty no-op separate from an unconfirmed receipt", () => {
    expect(parseSemanticEnqueueReceipt(receipt([], "waiting_for_sealed_episode"), "thread-1")).toMatchObject({ status: "waiting_for_sealed_episode", jobs: [] });
    expect(parseSemanticEnqueueReceipt(receipt([], "not_configured"), "thread-1").issue).toBeUndefined();
  });

  it("updates only requested unambiguous jobs and reports missing or malformed rows", () => {
    const parsed = parseSemanticPoll({ jobs: [publicJob("a", "completed", "superseded"), publicJob("unrequested"), { ...publicJob("b"), status: "unknown" }] }, ["a", "b", "missing"]);
    expect(parsed.jobs.map((job) => job.id)).toEqual(["a"]);
    expect(parsed.unconfirmedIds).toEqual(["b", "missing"]);
    expect(parsed.unexpected).toBe(true);
    expect(parseSemanticPoll({ jobs: [publicJob("a"), publicJob("a", "completed", "enriched")] }, ["a"]).unconfirmedIds).toEqual(["a"]);
    expect(parseSemanticPoll(undefined, ["a"]).unconfirmedIds).toEqual(["a"]);
  });

  it("protects terminal receipts from polls while allowing a fresh enqueue to reopen the same ID", () => {
    const terminal: SemanticShadowJob = { id: "a", status: "failed", failureCode: "semantic_enrichment_failed", threadId: "thread-1" };
    const queued: SemanticShadowJob = { id: "a", status: "queued" };
    expect(mergeSemanticShadowJobs([terminal], [queued])).toEqual([terminal]);
    expect(mergeSemanticShadowJobs([terminal], [queued], "enqueue")).toEqual([{ ...queued, threadId: "thread-1" }]);
  });

  it("distinguishes malformed thread reads from an empty bounded list", () => {
    expect(parseSemanticThreadIds({ threads: [] })).toEqual([]);
    expect(parseSemanticThreadIds({ threads: [{ noId: true }] })).toBeUndefined();
    const ids = parseSemanticThreadIds({ threads: Array.from({ length: 60 }, (_, index) => ({ id: `thread-${index}` })) });
    expect(ids).toHaveLength(48);
    expect(parseSemanticThreadIds({ threads: [{ id: "a" }, { id: "a" }] })).toEqual(["a"]);
  });
});

describe("semantic collector lifecycle", () => {
  it("admits only one mounted attempt and prevents old completion from releasing a new one", () => {
    const gate = createSemanticCollectionGate();
    expect(gate.begin()).toBeUndefined();
    gate.mount();
    const old = gate.begin()!;
    expect(gate.begin()).toBeUndefined();
    gate.dispose();
    gate.mount();
    const current = gate.begin()!;
    gate.finish(old);
    expect(gate.isCurrent(old)).toBe(false);
    expect(gate.isCurrent(current)).toBe(true);
    expect(gate.begin()).toBeUndefined();
    gate.finish(current);
    expect(gate.begin()).toBeDefined();
  });

  it("rejects an old held poll after retry, collection invalidation or replacement", async () => {
    const gate = createSemanticPollGate();
    const held = deferred<void>();
    const commits: string[] = [];
    const old = gate.begin();
    const pending = held.promise.then(() => { if (old()) commits.push("obsolete running"); });
    gate.invalidate();
    const next = gate.begin();
    if (next()) commits.push("confirmed terminal");
    held.resolve();
    await pending;
    expect(commits).toEqual(["confirmed terminal"]);
    gate.invalidate();
    expect(next()).toBe(false);
  });

  it("retains successful sibling receipts when transport fails and stops later batches", async () => {
    const enqueue = vi.fn(async (id: string) => { if (id === "b") throw new Error("Network failed"); return confirmed(id); });
    const onBatch = vi.fn();
    const result = await collectSemanticShadowBatch({ threadIds: ["a", "b", "c", "d", "e"], batchSize: 24, isCurrent: () => true, canContinue: () => true, enqueue, onBatch });
    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(result.jobCount).toBe(3);
    expect(result.receipts.find((row) => row.threadId === "b")?.issue).toContain("may have reached the server");
    expect(onBatch).toHaveBeenCalledTimes(1);
  });

  it("does not deliver stale receipts or begin another batch after disposal", async () => {
    const gate = createSemanticCollectionGate();
    gate.mount();
    const token = gate.begin()!;
    const held = deferred<void>();
    const enqueue = vi.fn(async (id: string) => { await held.promise; return confirmed(id); });
    const onBatch = vi.fn();
    const pending = collectSemanticShadowBatch({ threadIds: ["a", "b", "c", "d", "e"], batchSize: 24, isCurrent: () => gate.isCurrent(token), canContinue: () => true, enqueue, onBatch });
    expect(enqueue).toHaveBeenCalledTimes(4);
    gate.dispose();
    held.resolve();
    await pending;
    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(onBatch).not.toHaveBeenCalled();
  });

  it("keeps first-batch receipts but stops later work when permission becomes unavailable", async () => {
    let permitted = true;
    const enqueue = vi.fn(async (id: string) => confirmed(id));
    const result = await collectSemanticShadowBatch({ threadIds: ["a", "b", "c", "d", "e"], batchSize: 24, isCurrent: () => true, canContinue: () => permitted, enqueue, onBatch: () => { permitted = false; } });
    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(result.jobCount).toBe(4);
    expect(result.stopped).toBe(true);
  });

  it("respects 48 inspected conversations and concurrency four for confirmed no-ops", async () => {
    let inFlight = 0;
    let maximum = 0;
    const enqueue = vi.fn(async (id: string) => {
      inFlight += 1; maximum = Math.max(maximum, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return parseSemanticEnqueueReceipt(receipt([], "waiting_for_sealed_episode"), id);
    });
    const result = await collectSemanticShadowBatch({ threadIds: Array.from({ length: 100 }, (_, index) => `thread-${index}`), batchSize: 24, isCurrent: () => true, canContinue: () => true, enqueue, onBatch: () => undefined });
    expect(enqueue).toHaveBeenCalledTimes(48);
    expect(maximum).toBe(4);
    expect(result.inspected).toBe(48);
    expect(result.jobCount).toBe(0);
  });

  it("caps successful job collection at 24 even when given a larger target", async () => {
    const enqueue = vi.fn(async (id: string) => confirmed(id));
    const result = await collectSemanticShadowBatch({ threadIds: Array.from({ length: 100 }, (_, index) => `thread-${index}`), batchSize: 100, isCurrent: () => true, canContinue: () => true, enqueue, onBatch: () => undefined });
    expect(enqueue).toHaveBeenCalledTimes(24);
    expect(result.jobCount).toBe(24);
  });
});
