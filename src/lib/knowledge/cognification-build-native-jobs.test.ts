import { beforeEach,describe,expect,it,vi } from "vitest";
import type { OperationJobRecord } from "@/lib/operations/job-queue";
const mocks = vi.hoisted(() => ({ load: vi.fn(),claim: vi.fn(),recheck: vi.fn(),commit: vi.fn(),generate: vi.fn() }));
vi.mock("@/lib/knowledge/cognification-build-native-store",() => ({ loadNativeCognitionBuildJob: mocks.load,claimNativeCognitionBuildEffect: mocks.claim,
  recheckNativeCognitionBuildEffect: mocks.recheck,commitNativeCognitionBuildEffect: mocks.commit }));
vi.mock("@/lib/knowledge/cognification-runtime",() => ({ cognifyKnowledgeBatch: mocks.generate }));
import { executeNativeCognitionBuildJob } from "@/lib/knowledge/cognification-build-native-jobs";
const accepted = { acceptance: { scope: { tenantId: "tenant",ownerActorId: "owner" } },intent: { request: { review: { generationId: "generation" } } } };
const job = { id: "job:one" } as OperationJobRecord;
beforeEach(() => { vi.resetAllMocks(); mocks.load.mockResolvedValue(accepted); mocks.claim.mockResolvedValue({ claimId: "claim",document: {},chunks: [],batchIndex: 0,executionScope: {} }); });
describe("native paid cognition job", () => {
  it("cannot repeat a provider call after a durable claim and lost response", async () => {
    mocks.generate.mockRejectedValueOnce(new Error("Lost provider response"));
    await expect(executeNativeCognitionBuildJob(job,new AbortController().signal)).rejects.toThrow("Lost provider response");
    mocks.claim.mockRejectedValueOnce(new Error("Exact recovery required"));
    await expect(executeNativeCognitionBuildJob(job,new AbortController().signal)).rejects.toThrow("Exact recovery required");
    expect(mocks.generate).toHaveBeenCalledTimes(1); expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("fences immediately before the provider and commits only through the rechecked output transaction", async () => {
    const candidate = { id: "candidate" };
    mocks.generate.mockImplementation(async (input) => { expect(input.singleAttempt).toBe(true); await input.beforeProvider(); return candidate; });
    mocks.commit.mockRejectedValueOnce(new Error("Current source changed after provider"));
    await expect(executeNativeCognitionBuildJob(job,new AbortController().signal)).rejects.toThrow("Current source changed after provider");
    expect(mocks.recheck).toHaveBeenCalledWith(accepted,job,"claim");
    expect(mocks.commit).toHaveBeenCalledWith(accepted,job,"claim",candidate);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
});
