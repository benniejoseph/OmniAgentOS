import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  getCaptureAssetForRequest,
  getCaptureAssetContentForRequest,
} from "@/lib/capture/assets";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import {
  deferOperationJob,
  completeOperationJob,
  leaseOperationJobByDedupeKey,
  requeueOperationJobByDedupeKey,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import { STUDIO_CAPABILITIES } from "./capabilities";
import { createStudioTemplate } from "./templates";
import {
  createStudioFlow,
  getStudioFlow,
  getStudioRun,
  quoteStudioFlow,
  submitStudioRun,
  updateStudioFlow,
  studioRunAction,
  listStudioRuns,
} from "./service";
import { executeStudioRunJob } from "./runner";
import { advanceStudioRun } from "./advance";
import { reserveStudioBudget } from "./budget";
import { studioOwner } from "./authority";
import { withStudioTransaction } from "./store";
import {
  studioJobKey,
  type StoredAttempt,
  type StoredRun,
} from "./server-types";
import { StudioProviderError } from "./provider-types";
import {
  readStudioAssetBytes,
  uploadStudioAsset,
  validateStudioMedia,
} from "./assets";
import {
  submitStudioProvider,
  materializeStudioProviderOutput,
} from "./providers";

vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    resolveStudioCapabilities: vi.fn(async () =>
      STUDIO_CAPABILITIES.filter((c) => c.demo),
    ),
    submitStudioProvider: vi.fn(actual.submitStudioProvider),
    materializeStudioProviderOutput: vi.fn(
      actual.materializeStudioProviderOutput,
    ),
  };
});
const context: SecurityContext = {
  tenantId: "studio-test-tenant",
  actorId: "owner@example.test",
  source: "session",
  role: "operator",
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.test",
    sessionId: "test-session",
    tenantName: "Studio test",
  },
};
let dataDir: string;
const scope = { mode: "flow" as const, regenerate: false };
const key = () => randomUUID();
beforeEach(async () => {
  dataDir = await mkdtemp(
    path.join(process.env.STUDIO_TEST_TEMP_DIR ?? os.tmpdir(), "backend-"),
  );
  vi.stubEnv("OMNIAGENT_DATA_DIR", dataDir);
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});
async function fixture(
  template: "image-to-video" | "two-directions" = "image-to-video",
) {
  const graph = createStudioTemplate(
    template,
    STUDIO_CAPABILITIES.filter((c) => c.demo),
  );
  const flow = await createStudioFlow(
    context,
    { name: "Synthetic studio flow", graph },
    key(),
  );
  const quote = await quoteStudioFlow(
    context,
    flow.id,
    { revision: flow.revision, scope },
    key(),
  );
  expect(quote.issues).toEqual([]);
  const input = {
    quoteId: quote.id,
    scope,
    maxCostUsd: null,
    allowUnknownCost: false,
    maxGenerations: 8,
  };
  return { flow, quote, input };
}
async function tick(runId: string) {
  await requeueOperationJobByDedupeKey(studioJobKey(runId), "Test step", {
    tenantId: context.tenantId,
  });
  const leased = await leaseOperationJobByDedupeKey(studioJobKey(runId), {
    tenantId: context.tenantId,
    type: "studio.run.tick",
    owner: `test:${randomUUID()}`,
    leaseSeconds: 120,
  });
  expect(leased.outcome).toBe("leased");
  if (leased.outcome !== "leased") throw new Error("job not leased");
  const result = await executeStudioRunJob(
    leased.job,
    new AbortController().signal,
  );
  if ("__deferOperation" in result)
    await deferOperationJob(leased.job.id, leased.job.leaseOwner!, {
      tenantId: context.tenantId,
      delaySeconds: 1,
    });
  else
    await completeOperationJob(
      leased.job.id,
      leased.job.leaseOwner!,
      context.tenantId,
    );
  return (await getStudioRun(context, runId)).run;
}
async function finish(runId: string) {
  for (let i = 0; i < 40; i++) {
    const run = (await getStudioRun(context, runId)).run;
    if (
      ["succeeded", "partial", "failed", "uncertain", "canceled"].includes(
        run.status,
      )
    )
      return run;
    await tick(runId);
  }
  throw new Error("studio did not settle in bounded steps");
}

describe("studio durable execution", () => {
  it("runs demo image→video through leased durable jobs, saves playable assets and reuses exact outputs", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(context, flow.id, input, key());
    const result = await finish(run.id);
    expect(result.status).toBe("succeeded");
    expect(vi.mocked(submitStudioProvider)).toHaveBeenCalledTimes(2);
    const image = result.nodes.find((n) => n.nodeId === "image")!
      .outputAssets[0];
    const video = result.nodes.find((n) => n.nodeId === "video")!;
    expect(video.inputAssets.map((a) => a.id)).toEqual([image.id]);
    expect(video.outputAssets[0].mediaType).toBe("video/mp4");
    const content = await readStudioAssetBytes(
      studioOwner(context),
      video.outputAssets[0].id,
      video.outputAssets[0].contentSha256,
    );
    expect(content.bytes.length).toBeGreaterThan(100);
    const uploadKey = key();
    const uploaded = await uploadStudioAsset(
      studioOwner(context),
      new File([content.bytes], "sample.mp4", { type: "video/mp4" }),
      uploadKey,
    );
    expect(
      (
        await uploadStudioAsset(
          studioOwner(context),
          new File([content.bytes], "sample.mp4", { type: "video/mp4" }),
          uploadKey,
        )
      ).id,
    ).toBe(uploaded.id);
    await expect(
      uploadStudioAsset(
        studioOwner(context),
        new File([content.bytes], "different-name.mp4", { type: "video/mp4" }),
        uploadKey,
      ),
    ).rejects.toMatchObject({ code: "studio_idempotency_conflict" });
    expect(video.outputAssets[0].metadata).toMatchObject({
      studioRunId: run.id,
      studioNodeId: "video",
      capabilityId: "demo-video-image",
      inputs: [
        {
          assetId: image.id,
          contentSha256: image.contentSha256,
          mediaType: image.mediaType,
          role: "start_frame",
        },
      ],
    });
    const requestOwner = {
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding:
        canonicalRequestActorBindingFromSecurityContext(context),
    };
    const downloaded = await getCaptureAssetContentForRequest(
      video.outputAssets[0].id,
      requestOwner,
    );
    expect(downloaded.bytes).toEqual(content.bytes);
    expect(
      (await getCaptureAssetForRequest(video.outputAssets[0].id, requestOwner))
        ?.contentAvailable,
    ).toBe(true);
    await expect(
      getCaptureAssetContentForRequest(video.outputAssets[0].id, {
        tenantId: context.tenantId,
        actorId: "foreign@example.test",
      }),
    ).rejects.toMatchObject({ status: 404 });
    const quote = await quoteStudioFlow(
      context,
      flow.id,
      { revision: 1, scope },
      key(),
    );
    expect(quote.generationCount).toBe(0);
    expect(quote.reusedNodeIds).toEqual(["image", "video"]);
    const reused = await submitStudioRun(
      context,
      flow.id,
      { ...input, quoteId: quote.id },
      key(),
    );
    expect(
      (await finish(reused.id)).nodes.find((n) => n.nodeId === "video")!
        .inputAssets,
    ).toEqual(video.inputAssets);
    expect(vi.mocked(submitStudioProvider)).toHaveBeenCalledTimes(2);
    const all = await getStudioRun(context, run.id);
    expect(all.events.map((e) => e.seq)).toEqual(
      [...all.events.map((e) => e.seq)].sort((a, b) => a - b),
    );
    expect(
      (await getStudioRun(context, run.id, all.events.at(-1)!.seq)).events,
    ).toEqual([]);
  });
  it("atomically deduplicates concurrent run admission and detects key reuse", async () => {
    const { flow, input } = await fixture();
    const idempotency = key();
    const [first, second] = await Promise.all([
      submitStudioRun(context, flow.id, input, idempotency),
      submitStudioRun(context, flow.id, input, idempotency),
    ]);
    expect(first.id).toBe(second.id);
    expect(await listStudioRuns(context, flow.id)).toHaveLength(1);
    await expect(
      submitStudioRun(
        context,
        flow.id,
        { ...input, maxGenerations: 7 },
        idempotency,
      ),
    ).rejects.toMatchObject({ code: "studio_idempotency_conflict" });
  });
  it("rejects stale quotes and optimistic revision conflicts without changing saved graph", async () => {
    const { flow, input } = await fixture();
    await updateStudioFlow(
      context,
      flow.id,
      { revision: 1, name: "Updated" },
      key(),
    );
    await expect(
      updateStudioFlow(
        context,
        flow.id,
        { revision: 1, name: "Lost write" },
        key(),
      ),
    ).rejects.toMatchObject({ code: "studio_revision_conflict" });
    await expect(
      submitStudioRun(context, flow.id, input, key()),
    ).rejects.toMatchObject({ code: "studio_revision_conflict" });
    expect((await getStudioFlow(context, flow.id)).name).toBe("Updated");
  });
  it("never resubmits an ambiguous request after worker restart", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(context, flow.id, input, key());
    vi.mocked(submitStudioProvider).mockRejectedValueOnce(
      new StudioProviderError(
        "network",
        "Provider acknowledgement lost.",
        "uncertain_submission",
      ),
    );
    const result = await finish(run.id);
    expect(result.status).toBe("uncertain");
    expect(result.nodes.find((n) => n.nodeId === "video")!.status).toBe(
      "blocked",
    );
    expect(submitStudioProvider).toHaveBeenCalledTimes(1);
    const saved = await withStudioTransaction(studioOwner(context), (tx) =>
      tx.get<StoredRun>("run", run.id),
    );
    expect(
      saved!.value.nodes.find((n) => n.nodeId === "image")!.attempts,
    ).toHaveLength(1);
  });
  it("treats a persisted submitting marker without a handle as uncertain and makes no paid call", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(context, flow.id, input, key());
    await tick(run.id); // prompt ready
    await withStudioTransaction(studioOwner(context), async (tx) => {
      const saved = (await tx.get<StoredRun>("run", run.id))!;
      const n = saved.value.nodes.find((n) => n.nodeId === "image")!;
      const attempt: StoredAttempt = {
        id: "studio_attempt_interrupted",
        runId: run.id,
        nodeId: n.nodeId,
        submissionKey: "interrupted",
        status: "submitting",
        persistedAssetIds: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      n.status = "submitting";
      n.attempts.push({
        id: attempt.id,
        submissionKey: attempt.submissionKey,
        status: "submitting",
      });
      await tx.put("attempt", attempt.id, attempt, { parentId: run.id });
      await tx.put("run", run.id, saved, { parentId: flow.id });
    });
    expect((await finish(run.id)).status).toBe("uncertain");
    expect(submitStudioProvider).not.toHaveBeenCalled();
  });
  it("retries saved output retrieval without a second generation", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(context, flow.id, input, key());
    vi.mocked(materializeStudioProviderOutput).mockRejectedValueOnce(
      new StudioProviderError(
        "retrieval",
        "Temporary storage problem.",
        "retrieval",
      ),
    );
    for (let i = 0; i < 6; i++) {
      const current = await tick(run.id);
      if (
        current.nodes.some((n) => n.errorCode === "studio_persistence_failed")
      )
        break;
    }
    expect(submitStudioProvider).toHaveBeenCalledTimes(1);
    const before = (await getStudioRun(context, run.id)).run;
    expect(before.nodes.find((n) => n.nodeId === "image")!.status).toBe(
      "persisting",
    );
    await tick(run.id);
    expect(submitStudioProvider).toHaveBeenCalledTimes(1);
    await studioRunAction(context, run.id, "retry-persistence");
    expect((await finish(run.id)).status).toBe("succeeded");
    expect(submitStudioProvider).toHaveBeenCalledTimes(2); // image once, video once
  });
  it("keeps unrelated branches progressing while output storage needs a retry", async () => {
    const { flow, input } = await fixture("two-directions");
    const run = await submitStudioRun(context, flow.id, input, key());
    vi.mocked(materializeStudioProviderOutput).mockRejectedValueOnce(
      new StudioProviderError(
        "retrieval",
        "Temporary storage problem.",
        "retrieval",
      ),
    );
    let current = run;
    for (let i = 0; i < 20; i++) {
      current = await tick(run.id);
      if (
        current.nodes.find((n) => n.nodeId === "output-b")?.status ===
        "succeeded"
      )
        break;
    }
    expect(current.nodes.find((n) => n.nodeId === "image")?.errorCode).toBe(
      "studio_persistence_failed",
    );
    expect(current.nodes.find((n) => n.nodeId === "output-b")?.status).toBe(
      "succeeded",
    );
    expect(submitStudioProvider).toHaveBeenCalledTimes(3);
    await studioRunAction(context, run.id, "retry-persistence");
    expect((await finish(run.id)).status).toBe("succeeded");
    expect(submitStudioProvider).toHaveBeenCalledTimes(4);
  });
  it("cancels a storage pause and can recover its saved receipt without restarting canceled work", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(context, flow.id, input, key());
    vi.mocked(materializeStudioProviderOutput).mockRejectedValueOnce(
      new StudioProviderError(
        "retrieval",
        "Temporary storage problem.",
        "retrieval",
      ),
    );
    for (let i = 0; i < 6; i++) {
      const current = await tick(run.id);
      if (
        current.nodes.some((n) => n.errorCode === "studio_persistence_failed")
      )
        break;
    }
    await studioRunAction(context, run.id, "cancel");
    const canceled = await finish(run.id);
    expect(canceled.status).toBe("canceled");
    expect(canceled.nodes.find((n) => n.nodeId === "image")?.errorCode).toBe(
      "studio_persistence_canceled",
    );
    expect(submitStudioProvider).toHaveBeenCalledTimes(1);
    await studioRunAction(context, run.id, "retry-persistence");
    const recovered = await finish(run.id);
    expect(recovered.status).toBe("canceled");
    expect(recovered.nodes.find((n) => n.nodeId === "image")?.status).toBe(
      "succeeded",
    );
    expect(recovered.nodes.find((n) => n.nodeId === "video")?.status).toBe(
      "canceled",
    );
    expect(submitStudioProvider).toHaveBeenCalledTimes(1);
  });
  it("fails a flow when only its prompt succeeds and the first provider request is rejected", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(context, flow.id, input, key());
    vi.mocked(submitStudioProvider).mockRejectedValueOnce(
      new StudioProviderError(
        "provider_http_400",
        "The provider returned HTTP 400.",
        "rejected",
      ),
    );
    const result = await finish(run.id);
    expect(result.status).toBe("failed");
    expect(result.nodes.find((n) => n.nodeId === "prompt")!.status).toBe(
      "succeeded",
    );
    expect(result.nodes.find((n) => n.nodeId === "image")).toMatchObject({
      status: "failed",
      error: "The provider returned HTTP 400.",
      errorCode: "studio_provider_rejected",
    });
    expect(result.nodes.find((n) => n.nodeId === "video")!.status).toBe(
      "blocked",
    );
    expect(result.nodes.find((n) => n.nodeId === "output")!.status).toBe(
      "blocked",
    );
    expect(result.nodes.flatMap((n) => n.outputAssets)).toEqual([]);
    expect(result.nodes.flatMap((n) => n.attempts)).toHaveLength(1);
    expect(submitStudioProvider).toHaveBeenCalledTimes(1);
    expect((await getStudioRun(context, run.id)).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run.completed", status: "failed" }),
      ]),
    );
  });
  it("persists a safe provider diagnosis while redacting actual credential labels", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(context, flow.id, input, key());
    const diagnosis =
      "Google reports an unsupported request setting. Settings: generation_config.max_output_tokens. HTTP 400.";
    const credentials = [
      ["Bearer ", "bearer-secret"],
      ["apiKey=", "key-secret"],
      ["API-KEY: ", "dash-secret"],
      ["api_key=", "underscore-secret"],
      ["api key=", "space-secret"],
      ["token=", "token-secret"],
      ["access_token=", "access-secret"],
      ["refresh-token=", "refresh-secret"],
      ["sessionToken=", "session-secret"],
      ["id_token=", "id-secret"],
      ["api_token=", "api-token-secret"],
      ["GEMINI_API_KEY=", "environment-key-secret"],
      ["X_AUTH_TOKEN=", "environment-token-secret"],
    ];
    vi.mocked(submitStudioProvider).mockRejectedValueOnce(
      new StudioProviderError(
        "provider_http_400",
        `${diagnosis} ${credentials.map(([label, value]) => label + value).join("; ")} https://provider.example/private?key=url-secret`,
        "rejected",
      ),
    );
    await finish(run.id);
    const saved = await getStudioRun(context, run.id);
    const image = saved.run.nodes.find((n) => n.nodeId === "image")!;
    const event = saved.events.find(
      (entry) => entry.nodeId === "image" && entry.type === "node.failed",
    );
    const storedAttempt = await withStudioTransaction(
      studioOwner(context),
      (tx) => tx.get<StoredAttempt>("attempt", image.attempts[0].id),
    );
    for (const message of [
      image.error,
      image.attempts[0].error,
      storedAttempt?.error,
      event?.message,
    ]) {
      expect(message).toContain(diagnosis);
      expect(message?.match(/\[credential\]/g)).toHaveLength(
        credentials.length,
      );
      for (const [, secret] of credentials)
        expect(message).not.toContain(secret);
      expect(message).not.toContain("url-secret");
      expect(message).toContain("[provider endpoint]");
    }
    expect(submitStudioProvider).toHaveBeenCalledTimes(1);
  });
  it("preserves independent successful branches when another generator fails", async () => {
    const { flow, input } = await fixture("two-directions");
    const run = await submitStudioRun(context, flow.id, input, key());
    vi.mocked(submitStudioProvider).mockRejectedValueOnce(
      new StudioProviderError(
        "moderation",
        "Provider rejected this request.",
        "rejected",
      ),
    );
    const result = await finish(run.id);
    expect(result.status).toBe("partial");
    expect(result.nodes.find((n) => n.nodeId === "image")!.status).toBe(
      "failed",
    );
    expect(result.nodes.find((n) => n.nodeId === "video")!.status).toBe(
      "blocked",
    );
    expect(result.nodes.find((n) => n.nodeId === "video-b")!.status).toBe(
      "succeeded",
    );
    expect(
      result.nodes.find((n) => n.nodeId === "output-b")!.outputAssets,
    ).toHaveLength(2);
  });
  it("cancels queued nodes without contacting a provider", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(context, flow.id, input, key());
    await studioRunAction(context, run.id, "cancel");
    expect((await finish(run.id)).status).toBe("canceled");
    expect(submitStudioProvider).not.toHaveBeenCalled();
  });
  it("keeps the immutable run snapshot when the draft changes", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(context, flow.id, input, key());
    const graph = structuredClone(flow.graph);
    graph.nodes.find((n) => n.id === "prompt")!.config.prompt =
      "A completely new scene";
    await updateStudioFlow(context, flow.id, { revision: 1, graph }, key());
    const result = await finish(run.id);
    expect(result.graph).toEqual(flow.graph);
    expect(result.flowRevision).toBe(1);
  });
  it("fences stale workers before any provider submission", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(context, flow.id, input, key());
    const job = {
      id: "missing",
      tenantId: context.tenantId,
      type: "studio.run.tick",
      payload: { actorId: studioOwner(context).actorId, runId: run.id },
      leaseOwner: "stale",
    } as unknown as OperationJobRecord;
    await expect(
      executeStudioRunJob(job, new AbortController().signal),
    ).rejects.toThrow("lease");
    expect(submitStudioProvider).not.toHaveBeenCalled();
  });
  it("rejects cross-owner flow, quote and run access", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(context, flow.id, input, key());
    const other = {
      ...context,
      actorId: "other@example.test",
      auth: {
        ...context.auth!,
        userId: "22222222-2222-4222-8222-222222222222",
        email: "other@example.test",
      },
    };
    await expect(getStudioFlow(other, flow.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(getStudioRun(other, run.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      submitStudioRun(other, flow.id, input, key()),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("requires canonical authenticated identity and bounds admission concurrency", async () => {
    await expect(
      createStudioFlow(
        { ...context, source: "service" },
        { name: "No" },
        key(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const { flow, input } = await fixture();
    await submitStudioRun(context, flow.id, input, key());
    await submitStudioRun(context, flow.id, input, key());
    await expect(
      submitStudioRun(context, flow.id, input, key()),
    ).rejects.toMatchObject({ code: "studio_concurrency_limit" });
  });
  it("accepts an explicit zero-cost cap and only advances due jobs", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(
      context,
      flow.id,
      { ...input, maxCostUsd: 0 },
      key(),
    );
    const first = await advanceStudioRun(
      context,
      run.id,
      new AbortController().signal,
    );
    const second = await advanceStudioRun(
      context,
      run.id,
      new AbortController().signal,
    );
    expect(second.nodes).toEqual(first.nodes);
    expect(submitStudioProvider).not.toHaveBeenCalled();
  });
  it("serializes tenant cost reservations across different owners", async () => {
    const second = {
      ...studioOwner(context),
      actorId: "actor:22222222-2222-4222-8222-222222222222",
    };
    const results = await Promise.allSettled([
      withStudioTransaction(studioOwner(context), (tx) =>
        reserveStudioBudget(tx, studioOwner(context), key(), 0.6, 1_000_000),
      ),
      withStudioTransaction(second, (tx) =>
        reserveStudioBudget(tx, second, key(), 0.6, 1_000_000),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("stops a changed capability contract before contacting its provider", async () => {
    const { flow, input } = await fixture();
    const run = await submitStudioRun(context, flow.id, input, key());
    await withStudioTransaction(studioOwner(context), async (tx) => {
      const saved = (await tx.get<StoredRun>("run", run.id))!;
      saved.capabilityPins.image.hash = "old-contract";
      await tx.put("run", run.id, saved, { parentId: flow.id });
    });
    const result = await finish(run.id);
    expect(result.nodes.find((n) => n.nodeId === "image")!.error).toContain(
      "contract changed",
    );
    expect(submitStudioProvider).not.toHaveBeenCalled();
  });
  it("validates uploaded media bytes and rejects mislabeled or oversized files", async () => {
    await expect(
      validateStudioMedia(
        new TextEncoder().encode("not an image"),
        "image/png",
      ),
    ).rejects.toMatchObject({ code: "studio_media_invalid" });
    await expect(
      uploadStudioAsset(
        studioOwner(context),
        new File([new Uint8Array(3 * 1024 * 1024 + 1)], "large.png", {
          type: "image/png",
        }),
        key(),
      ),
    ).rejects.toMatchObject({ code: "studio_upload_limit" });
  });
});
