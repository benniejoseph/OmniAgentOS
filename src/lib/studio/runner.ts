import { randomUUID } from "node:crypto";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import { saveCaptureAsset } from "@/lib/capture/assets";
import {
  getOperationJob,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  readStudioAsset,
  readStudioAssetBytes,
  studioAsset,
  validateStudioMedia,
} from "./assets";
import { verifyStudioAuthority } from "./authority";
import {
  getStudioCapability,
  renderStudioProviderPrompt,
} from "./capabilities";
import {
  STUDIO_TERMINAL_NODE_STATES,
  STUDIO_TERMINAL_RUN_STATES,
  type StudioAsset,
  type StudioNode,
  type StudioNodeRun,
} from "./contracts";
import {
  cancelStudioProvider,
  getStudioProviderStatus,
  materializeStudioProviderOutput,
  submitStudioProvider,
  recordStudioProviderUsage,
} from "./providers";
import {
  StudioProviderError,
  type StudioProviderContext,
  type StudioProviderReference,
  type StudioProviderResult,
} from "./provider-types";
import { studioCapabilityPin } from "./request-contract";
import { requireRun } from "./service";
import {
  StudioError,
  type StoredAttempt,
  type StoredRun,
  type StudioOwner,
} from "./server-types";
import { withStudioTransaction, type StudioTransaction } from "./store";

const now = () => new Date().toISOString();
const MAX_POLL_COUNT = 120;
const MAX_PROVIDER_AGE_MS = 30 * 60 * 1000;
const deferred = (
  id: string,
  delaySeconds = 2,
  reason = "Studio will continue from its saved state.",
) => ({
  __deferOperation: true as const,
  delaySeconds,
  reason,
  resourceId: id,
});

/** One bounded durable step. The operation queue owns polling and restart recovery. */
export async function executeStudioRunJob(
  job: OperationJobRecord,
  signal: AbortSignal,
) {
  const runId = typeof job.payload.runId === "string" ? job.payload.runId : "";
  const actorId =
    typeof job.payload.actorId === "string" ? job.payload.actorId : "";
  if (!runId || !/^actor:[a-f0-9-]{36}$/.test(actorId))
    throw new StudioError("Studio job is missing its owner binding.", 403);
  const owner: StudioOwner = { tenantId: job.tenantId, actorId };
  signal.throwIfAborted();
  let snapshot: StoredRun;
  try {
    snapshot = await withStudioTransaction(owner, async (tx) => {
      await assertLease(tx, job);
      const run = await requireRun(tx, runId);
      if (STUDIO_TERMINAL_RUN_STATES.includes(run.value.status)) return run;
      owner.legacyActorId = run.legacyActorId;
      const authority = await verifyStudioAuthority(
        tx,
        owner,
        run.workspaceId,
        run.projectId,
      );
      owner.legacyActorId = authority.legacyActorId;
      // A changed identity cannot silently redirect an accepted paid request to a new account.
      if (run.legacyActorId && authority.legacyActorId !== run.legacyActorId)
        throw new StudioError(
          "The provider account identity changed. Make a new quote.",
          403,
          "studio_identity_changed",
        );
      if (run.value.status === "queued") {
        run.value.status = "running";
        await tx.event(
          runId,
          "run.started",
          "Running the saved flow revision.",
          { status: "running" },
        );
      }
      await settleDependents(tx, run);
      await saveRun(tx, run);
      return run;
    });
  } catch (error) {
    if (!(error instanceof StudioError) || error.status !== 403) throw error;
    return stopForRevokedAuthority(owner, runId, error.code, job);
  }
  if (STUDIO_TERMINAL_RUN_STATES.includes(snapshot.value.status))
    return { runId, status: snapshot.value.status };
  owner.legacyActorId = snapshot.legacyActorId;
  return runWithDatabaseActorScope(
    owner.tenantId,
    [owner.actorId, ...(owner.legacyActorId ? [owner.legacyActorId] : [])],
    () => executeSnapshot(owner, job, snapshot, signal),
  );
}

async function executeSnapshot(
  owner: StudioOwner,
  job: OperationJobRecord,
  snapshot: StoredRun,
  signal: AbortSignal,
) {
  const runId = snapshot.value.id;
  const node = snapshot.value.nodes.find(
    (n) =>
      !STUDIO_TERMINAL_NODE_STATES.includes(n.status) &&
      !(n.status === "persisting" && n.error) &&
      dependenciesReady(snapshot, n.nodeId),
  );
  if (!node)
    return snapshot.value.nodes.some(
      (n) => n.status === "persisting" && n.error,
    )
      ? deferred(
          runId,
          300,
          "Provider output is saved; waiting for an explicit storage retry.",
        )
      : deferred(runId, 10);
  const definition = snapshot.value.graph.nodes.find(
    (n) => n.id === node.nodeId,
  )!;
  const context = providerRunContext(owner, snapshot, signal);

  if (node.status === "submitting") {
    // A durable submitting marker without its receipt is deliberately not replayable.
    await mutateNode(
      owner,
      job,
      runId,
      node.nodeId,
      async (tx, run, current) => {
        const attempt = await lastAttempt(tx, current);
        if (!attempt || attempt.status !== "submitting") return;
        attempt.status = "uncertain";
        attempt.error =
          "The worker stopped before the provider receipt was saved. No automatic resubmission was made.";
        current.status = "uncertain";
        current.error = attempt.error;
        current.errorCode = "studio_submission_uncertain";
        await saveAttempt(tx, run, current, attempt);
        await tx.event(runId, "node.uncertain", attempt.error, {
          nodeId: node.nodeId,
          status: "uncertain",
        });
      },
    );
    return deferred(runId);
  }
  if (node.status === "running")
    return pollProvider(owner, job, snapshot, node, context);
  if (node.status === "persisting") {
    if (node.error)
      return deferred(
        runId,
        300,
        "Provider output is saved; waiting for an explicit storage retry.",
      );
    return persistProviderOutputs(owner, job, snapshot, node, context);
  }
  if (node.status !== "queued") return deferred(runId);
  if (definition.type !== "image" && definition.type !== "video") {
    try {
      const assets =
        definition.type === "asset" && definition.config.assetId
          ? [
              studioAsset(
                (
                  await readStudioAsset(
                    owner,
                    definition.config.assetId,
                    snapshot.assetPins[definition.config.assetId]
                      ?.contentSha256,
                  )
                ).asset,
              ),
            ]
          : definition.type === "output"
            ? inputBindings(snapshot, definition).map((v) => v.asset)
            : [];
      await mutateNode(
        owner,
        job,
        runId,
        node.nodeId,
        async (tx, run, current) => {
          if (current.status !== "queued") return;
          if (run.value.cancellationRequestedAt) {
            current.status = "canceled";
            current.completedAt = now();
            return;
          }
          current.outputAssets = assets;
          current.inputAssets = definition.type === "output" ? assets : [];
          current.status = "succeeded";
          current.completedAt = now();
          await tx.event(
            runId,
            "node.succeeded",
            definition.type === "output"
              ? "Collected the connected outputs."
              : "Input is ready.",
            { nodeId: node.nodeId, status: "succeeded" },
          );
        },
      );
    } catch (error) {
      await failNode(
        owner,
        job,
        snapshot,
        node,
        publicFailure(error, "A required input is unavailable."),
      );
    }
    return deferred(runId);
  }

  try {
    const pin = studioCapabilityPin(
      definition.config.capabilityId!,
      definition.config.parameters,
    );
    if (pin.hash !== snapshot.capabilityPins?.[definition.id]?.hash)
      throw new StudioError(
        "The model's request contract changed after this quote. Make a new quote before generating.",
        409,
        "studio_capability_changed",
      );
  } catch (error) {
    await failNode(
      owner,
      job,
      snapshot,
      node,
      publicFailure(
        error,
        "The accepted model capability changed. Quote again.",
      ),
    );
    return deferred(runId);
  }
  let references: StudioProviderReference[];
  try {
    references = await Promise.all(
      inputBindings(snapshot, definition).map(async ({ asset, role }) => {
        const { bytes } = await readStudioAssetBytes(
          owner,
          asset.id,
          asset.contentSha256,
        );
        return {
          assetId: asset.id,
          contentSha256: asset.contentSha256,
          mediaType: asset.mediaType,
          role,
          bytes,
        };
      }),
    );
  } catch (error) {
    await failNode(
      owner,
      job,
      snapshot,
      node,
      publicFailure(error, "A required reference is no longer available."),
    );
    return deferred(runId);
  }
  signal.throwIfAborted();
  const attempt = await mutateNode(
    owner,
    job,
    runId,
    node.nodeId,
    async (tx, run, current) => {
      if (current.status !== "queued" || run.value.cancellationRequestedAt)
        return null;
      const at = now();
      const value: StoredAttempt = {
        id: `studio_attempt_${randomUUID()}`,
        runId,
        nodeId: node.nodeId,
        submissionKey: `${runId}:${node.nodeId}:1`,
        providerPrompt: renderStudioProviderPrompt(
          definition.config.capabilityId!,
          current.effectivePrompt,
        ),
        status: "submitting",
        persistedAssetIds: [],
        startedAt: at,
        updatedAt: at,
      };
      current.status = "submitting";
      current.startedAt = at;
      current.inputAssets = inputBindings(run, definition).map((v) => v.asset);
      current.attempts.push({
        id: value.id,
        submissionKey: value.submissionKey,
        status: "submitting",
        startedAt: at,
      });
      await tx.put("attempt", value.id, value, {
        parentId: runId,
        state: "submitting",
      });
      await tx.event(
        runId,
        "node.submitting",
        "Submitting one bounded generation request.",
        { nodeId: node.nodeId, status: "submitting" },
      );
      return value;
    },
  );
  if (!attempt) return deferred(runId);
  let result: StudioProviderResult;
  try {
    result = await submitStudioProvider(
      {
        capabilityId: definition.config.capabilityId!,
        prompt: node.effectivePrompt,
        parameters: definition.config.parameters,
        references,
        submissionKey: attempt.submissionKey,
        route: snapshot.routes[node.nodeId],
      },
      context,
    );
  } catch (error) {
    const rejected =
      error instanceof StudioProviderError && error.disposition === "rejected";
    const message = publicFailure(
      error,
      rejected
        ? "The provider rejected this request."
        : "The provider may have accepted this request, but no durable receipt was obtained. It will not be submitted again automatically.",
    );
    await mutateNode(
      owner,
      job,
      runId,
      node.nodeId,
      async (tx, run, current) => {
        const saved = await lastAttempt(tx, current);
        if (saved?.id !== attempt.id || saved.status !== "submitting") return;
        saved.status = rejected ? "failed" : "uncertain";
        saved.error = message;
        current.status = saved.status;
        current.error = message;
        current.errorCode = rejected
          ? "studio_provider_rejected"
          : "studio_submission_uncertain";
        await saveAttempt(tx, run, current, saved);
        await tx.event(runId, `node.${saved.status}`, message, {
          nodeId: node.nodeId,
          status: saved.status,
        });
      },
    );
    return deferred(runId);
  }
  await recordProviderResult(
    owner,
    job,
    runId,
    node.nodeId,
    attempt.id,
    result,
    context,
  );
  return deferred(runId);
}

async function pollProvider(
  owner: StudioOwner,
  job: OperationJobRecord,
  snapshot: StoredRun,
  node: StudioNodeRun,
  context: StudioProviderContext,
) {
  const attempt = await withStudioTransaction(owner, (tx) =>
    lastAttempt(tx, node),
  );
  if (!attempt?.handle) {
    await failNode(
      owner,
      job,
      snapshot,
      node,
      "The saved provider receipt is missing; automatic regeneration is disabled.",
      "uncertain",
    );
    return deferred(snapshot.value.id);
  }
  if (
    (attempt.pollCount ?? 0) >= MAX_POLL_COUNT ||
    Date.now() - Date.parse(attempt.startedAt) > MAX_PROVIDER_AGE_MS
  ) {
    await failNode(
      owner,
      job,
      snapshot,
      node,
      "The provider did not finish within the bounded monitoring window. Its receipt is retained; no replacement request was sent.",
      "uncertain",
    );
    return deferred(snapshot.value.id);
  }
  let cancel = false;
  if (snapshot.value.cancellationRequestedAt && !attempt.cancellationSent) {
    cancel = await mutateNode(
      owner,
      job,
      snapshot.value.id,
      node.nodeId,
      async (tx, run, current) => {
        const saved = await lastAttempt(tx, current);
        if (!saved || saved.id !== attempt.id || saved.cancellationSent)
          return false;
        saved.cancellationSent = true;
        saved.cancellationRequestedAt = run.value.cancellationRequestedAt;
        await saveAttempt(tx, run, current, saved);
        await tx.event(
          run.value.id,
          "node.cancellation_requested",
          "Asked the provider to cancel. Completion can still win the race.",
          { nodeId: node.nodeId },
        );
        return true;
      },
    );
  }
  try {
    const result = cancel
      ? await cancelStudioProvider(attempt.handle, context)
      : await getStudioProviderStatus(attempt.handle, context);
    await recordProviderResult(
      owner,
      job,
      snapshot.value.id,
      node.nodeId,
      attempt.id,
      result,
      context,
    );
  } catch (error) {
    context.signal?.throwIfAborted();
    await mutateNode(
      owner,
      job,
      snapshot.value.id,
      node.nodeId,
      async (tx, run, current) => {
        if (
          current.attempts.at(-1)?.id !== attempt.id ||
          current.status !== "running"
        )
          return;
        run.pollCount++;
        const saved = await lastAttempt(tx, current);
        if (saved) {
          saved.pollCount = (saved.pollCount ?? 0) + 1;
          await saveAttempt(tx, run, current, saved);
        }
        if (run.pollCount === 1 || run.pollCount % 12 === 0)
          await tx.event(
            run.value.id,
            "node.poll_delayed",
            publicFailure(
              error,
              "Provider status is temporarily unavailable; the existing receipt will be checked again.",
            ),
            { nodeId: node.nodeId },
          );
      },
    );
  }
  return deferred(snapshot.value.id, 5);
}

async function recordProviderResult(
  owner: StudioOwner,
  job: OperationJobRecord,
  runId: string,
  nodeId: string,
  attemptId: string,
  result: StudioProviderResult,
  context: StudioProviderContext,
) {
  await mutateNode(owner, job, runId, nodeId, async (tx, run, node) => {
    const attempt = await lastAttempt(tx, node);
    if (
      attempt?.id !== attemptId ||
      !["submitting", "running"].includes(attempt.status)
    )
      return;
    const firstReceipt = !attempt.handle;
    // Handles and full output descriptors are committed before any remote download or asset copy.
    attempt.handle = result.handle;
    attempt.result = result;
    run.pollCount++;
    attempt.pollCount = (attempt.pollCount ?? 0) + 1;
    if (result.status === "running") {
      attempt.status = "running";
      node.status = "running";
    } else if (result.status === "completed") {
      attempt.status = "persisting";
      node.status = "persisting";
    } else {
      attempt.status = result.status;
      node.status = result.status;
      node.error = safeMessage(result.error);
      node.errorCode = `studio_provider_${result.status}`;
      node.completedAt = now();
    }
    await saveAttempt(tx, run, node, attempt);
    if (result.status !== "running" || firstReceipt)
      await tx.event(
        runId,
        `node.${node.status}`,
        result.status === "completed"
          ? "Generation completed. Copying outputs into private durable storage."
          : result.status === "running"
            ? "Provider accepted the request. Waiting for its result."
            : node.error || "Provider stopped the request.",
        { nodeId, status: node.status },
      );
  });
  await recordStudioProviderUsage(result, context);
}

async function persistProviderOutputs(
  owner: StudioOwner,
  job: OperationJobRecord,
  snapshot: StoredRun,
  node: StudioNodeRun,
  context: StudioProviderContext,
) {
  const attempt = await withStudioTransaction(owner, (tx) =>
    lastAttempt(tx, node),
  );
  if (attempt?.result?.status !== "completed") {
    await failNode(
      owner,
      job,
      snapshot,
      node,
      "The saved provider result is missing. No new generation was requested.",
      "uncertain",
    );
    return deferred(snapshot.value.id);
  }
  const definition = snapshot.value.graph.nodes.find(
    (n) => n.id === node.nodeId,
  )!;
  const capabilityPin = snapshot.capabilityPins?.[node.nodeId];
  try {
    await recordStudioProviderUsage(attempt.result, context);
    const assets: StudioAsset[] = [];
    for (let index = 0; index < attempt.result.outputs.length; index++) {
      context.signal?.throwIfAborted();
      const existingId = attempt.persistedAssetIds[index];
      if (existingId) {
        assets.push(
          studioAsset((await readStudioAsset(owner, existingId)).asset),
        );
        continue;
      }
      const output = await materializeStudioProviderOutput(
        attempt.result.outputs[index],
        context,
      );
      const verified = await validateStudioMedia(
        output.bytes,
        output.mediaType,
      );
      const saved = await saveCaptureAsset({
        tenantId: owner.tenantId,
        actorId: owner.actorId,
        executionScope: createExecutionScope({
          ...snapshot.executionScope,
          correlationId: `${attempt.id}:output:${index}`,
          causationId: snapshot.value.id,
          purpose: "studio.output.persist",
        }),
        filename: output.filename,
        mediaType: output.mediaType,
        bytes: output.bytes,
        tags: ["studio", ...(output.demo ? ["demo"] : [])],
        metadata: {
          studioRunId: snapshot.value.id,
          studioFlowId: snapshot.value.flowId,
          studioNodeId: node.nodeId,
          studioAttemptId: attempt.id,
          studioOutputIndex: index,
          studioDemo: output.demo,
          provider: attempt.handle?.provider,
          model: attempt.handle?.model,
          providerRequestId: attempt.handle?.requestId,
          capabilityId: definition.config.capabilityId,
          capabilitySchemaVersion: capabilityPin?.schemaVersion,
          capabilityHash: capabilityPin?.hash,
          effectivePrompt: node.effectivePrompt,
          providerPrompt: attempt.providerPrompt,
          parameters: definition.config.parameters ?? {},
          inputs: inputBindings(snapshot, definition).map(
            ({ asset, role }) => ({
              assetId: asset.id,
              contentSha256: asset.contentSha256,
              mediaType: asset.mediaType,
              role,
            }),
          ),
          ...(verified.width || output.width
            ? { width: verified.width ?? output.width }
            : {}),
          ...(verified.height || output.height
            ? { height: verified.height ?? output.height }
            : {}),
          ...(verified.durationSeconds || output.durationSeconds
            ? {
                durationSeconds:
                  verified.durationSeconds ?? output.durationSeconds,
              }
            : {}),
        },
      });
      await mutateNode(
        owner,
        job,
        snapshot.value.id,
        node.nodeId,
        async (tx, run, current) => {
          const stored = await lastAttempt(tx, current);
          if (stored?.id !== attempt.id || stored.status !== "persisting")
            throw new Error(
              "Studio attempt changed during output persistence.",
            );
          stored.persistedAssetIds[index] = saved.id;
          await saveAttempt(tx, run, current, stored);
        },
      );
      assets.push(studioAsset(saved));
    }
    await mutateNode(
      owner,
      job,
      snapshot.value.id,
      node.nodeId,
      async (tx, run, current) => {
        const stored = await lastAttempt(tx, current);
        if (stored?.id !== attempt.id || stored.status !== "persisting") return;
        stored.status = "succeeded";
        current.status = "succeeded";
        current.outputAssets = assets;
        current.error = undefined;
        current.errorCode = undefined;
        current.completedAt = now();
        await saveAttempt(tx, run, current, stored);
        await tx.event(
          run.value.id,
          "node.succeeded",
          run.value.cancellationRequestedAt
            ? "The provider completed before cancellation; its output has been preserved."
            : `Saved ${assets.length} output${assets.length === 1 ? "" : "s"}.`,
          { nodeId: node.nodeId, status: "succeeded" },
        );
      },
    );
  } catch (error) {
    context.signal?.throwIfAborted();
    await mutateNode(
      owner,
      job,
      snapshot.value.id,
      node.nodeId,
      async (tx, run, current) => {
        if (
          current.attempts.at(-1)?.id !== attempt.id ||
          current.status !== "persisting"
        )
          return;
        current.error = publicFailure(
          error,
          "Generation is complete, but its output could not be saved. Retry storage to use the same result without another generation charge.",
        );
        current.errorCode = "studio_persistence_failed";
        await tx.event(run.value.id, "node.persistence_failed", current.error, {
          nodeId: node.nodeId,
          status: "persisting",
        });
      },
    );
    return deferred(
      snapshot.value.id,
      300,
      "Output storage needs an explicit retry.",
    );
  }
  return deferred(snapshot.value.id);
}

function inputBindings(
  run: StoredRun,
  node: StudioNode,
): Array<{ asset: StudioAsset; role: string }> {
  const bindings: Array<{ asset: StudioAsset; role: string }> = [];
  const capability = node.config.capabilityId
    ? getStudioCapability(node.config.capabilityId)
    : undefined;
  for (const edge of run.value.graph.edges
    .filter((e) => e.target === node.id && e.targetPort !== "prompt")
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const source = run.value.graph.nodes.find((n) => n.id === edge.source);
    if (!source?.enabled)
      throw new StudioError("A required source is missing or disabled.");
    let assets =
      source.type === "asset"
        ? [run.assetPins[source.config.assetId ?? ""]].filter(Boolean)
        : (run.value.nodes.find((n) => n.nodeId === source.id)?.outputAssets ??
          run.reusable[source.id]?.outputAssets ??
          []);
    if (
      (edge.sourcePort === "selected" || edge.sourcePort === "video") &&
      assets.length > 1
    )
      assets = assets.filter((a) => a.id === source.config.selectedOutputId);
    if (
      !assets.length ||
      ((edge.sourcePort === "selected" || edge.sourcePort === "video") &&
        assets.length !== 1)
    )
      throw new StudioError(
        "Select a fresh upstream output before using this input.",
        409,
        "studio_input_unavailable",
      );
    const role =
      capability?.inputRoles.find((r) => r.portId === edge.targetPort)?.role ??
      edge.targetPort;
    for (const asset of assets) bindings.push({ asset, role });
  }
  return bindings;
}
function dependenciesReady(run: StoredRun, nodeId: string) {
  return (run.dependencies[nodeId] ?? []).every((id) => {
    const scheduled = run.value.nodes.find((n) => n.nodeId === id);
    if (scheduled) return scheduled.status === "succeeded";
    const n = run.value.graph.nodes.find((n) => n.id === id);
    return (
      !!n?.enabled &&
      ((n.type === "prompt" && !!n.config.prompt?.trim()) ||
        (n.type === "asset" && !!run.assetPins[n.config.assetId ?? ""]) ||
        !!run.reusable[id]?.outputAssets.length)
    );
  });
}
async function settleDependents(tx: StudioTransaction, run: StoredRun) {
  if (run.value.cancellationRequestedAt) {
    for (const node of run.value.nodes.filter(
      (n) => n.status === "persisting" && n.error,
    )) {
      node.status = "canceled";
      node.errorCode = "studio_persistence_canceled";
      node.error =
        "Storage retries were stopped. The completed provider result is retained and can be recovered without regenerating.";
      node.completedAt = now();
      await tx.event(run.value.id, "node.canceled", node.error, {
        nodeId: node.nodeId,
        status: "canceled",
      });
    }
  }
  for (const node of run.value.nodes.filter((n) => n.status === "queued")) {
    if (run.value.cancellationRequestedAt) {
      node.status = "canceled";
      node.completedAt = now();
      await tx.event(
        run.value.id,
        "node.canceled",
        "Canceled before submission.",
        { nodeId: node.nodeId, status: "canceled" },
      );
      continue;
    }
    const blocked = (run.dependencies[node.nodeId] ?? []).filter((id) => {
      const source = run.value.nodes.find((n) => n.nodeId === id);
      return (
        source &&
        STUDIO_TERMINAL_NODE_STATES.includes(source.status) &&
        source.status !== "succeeded"
      );
    });
    if (blocked.length) {
      node.status = "blocked";
      node.blockedBy = blocked;
      node.completedAt = now();
      node.error =
        "A required upstream node did not succeed. Independent branches can still run.";
      await tx.event(run.value.id, "node.blocked", node.error, {
        nodeId: node.nodeId,
        status: "blocked",
      });
    }
  }
  if (
    run.value.nodes.every((n) => STUDIO_TERMINAL_NODE_STATES.includes(n.status))
  ) {
    const states = run.value.nodes.map((n) => n.status);
    // Ready prompts and references are prerequisites, not completed media work.
    const hasSavedResult = run.value.nodes.some((node) => {
      if (node.status !== "succeeded" || !node.outputAssets.length)
        return false;
      const type = run.value.graph.nodes.find(
        (definition) => definition.id === node.nodeId,
      )?.type;
      return type === "image" || type === "video" || type === "output";
    });
    run.value.status = states.every((s) => s === "succeeded")
      ? "succeeded"
      : states.includes("uncertain")
        ? "uncertain"
        : run.value.cancellationRequestedAt
          ? "canceled"
          : hasSavedResult
            ? "partial"
            : "failed";
    if (!run.value.completedAt) {
      run.value.completedAt = now();
      await tx.event(
        run.value.id,
        "run.completed",
        `Flow ${run.value.status}.`,
        { status: run.value.status },
      );
    }
  }
}
async function mutateNode<T>(
  owner: StudioOwner,
  job: OperationJobRecord,
  id: string,
  nodeId: string,
  update: (
    tx: StudioTransaction,
    run: StoredRun,
    node: StudioNodeRun,
  ) => Promise<T>,
) {
  return withStudioTransaction(owner, async (tx) => {
    await assertLease(tx, job);
    const run = await requireRun(tx, id);
    await verifyStudioAuthority(tx, owner, run.workspaceId, run.projectId);
    const node = run.value.nodes.find((n) => n.nodeId === nodeId);
    if (!node) throw new Error("Studio node is absent from the immutable run.");
    const result = await update(tx, run, node);
    await settleDependents(tx, run);
    await saveRun(tx, run);
    return result;
  });
}
async function assertLease(tx: StudioTransaction, job: OperationJobRecord) {
  if (!job.leaseOwner)
    throw new Error("Studio execution requires a leased operation job.");
  if (tx.sql) {
    const rows =
      await tx.sql`SELECT id FROM omni_operation_jobs WHERE tenant_id=${job.tenantId} AND id=${job.id} AND status='running' AND lease_owner=${job.leaseOwner} AND lease_expires_at>clock_timestamp() FOR SHARE`;
    if (rows.length !== 1)
      throw new Error("Studio operation lease is no longer current.");
  } else {
    const live = await getOperationJob(job.id, { tenantId: job.tenantId });
    if (
      !live ||
      live.status !== "running" ||
      live.leaseOwner !== job.leaseOwner ||
      !live.leaseExpiresAt ||
      Date.parse(live.leaseExpiresAt) <= Date.now()
    )
      throw new Error("Studio operation lease is no longer current.");
  }
}
async function lastAttempt(tx: StudioTransaction, node: StudioNodeRun) {
  return tx.get<StoredAttempt>("attempt", node.attempts.at(-1)?.id ?? "");
}
async function saveAttempt(
  tx: StudioTransaction,
  run: StoredRun,
  node: StudioNodeRun,
  attempt: StoredAttempt,
) {
  attempt.updatedAt = now();
  const view = node.attempts.find((a) => a.id === attempt.id);
  if (view)
    Object.assign(view, {
      status: attempt.status,
      ...(attempt.handle
        ? { providerRequestId: attempt.handle.requestId }
        : {}),
      ...(attempt.error ? { error: attempt.error } : {}),
      ...(attempt.cancellationRequestedAt
        ? { cancellationRequestedAt: attempt.cancellationRequestedAt }
        : {}),
      ...(STUDIO_TERMINAL_NODE_STATES.includes(attempt.status)
        ? { completedAt: now() }
        : {}),
    });
  await tx.put("attempt", attempt.id, attempt, {
    parentId: run.value.id,
    state: attempt.status,
  });
}
async function saveRun(tx: StudioTransaction, run: StoredRun) {
  run.value.updatedAt = now();
  run.revision++;
  await tx.put("run", run.value.id, run, {
    parentId: run.value.flowId,
    state: run.value.status,
  });
}
async function failNode(
  owner: StudioOwner,
  job: OperationJobRecord,
  run: StoredRun,
  node: StudioNodeRun,
  message: string,
  status: "failed" | "uncertain" = "failed",
) {
  await mutateNode(
    owner,
    job,
    run.value.id,
    node.nodeId,
    async (tx, current, view) => {
      if (STUDIO_TERMINAL_NODE_STATES.includes(view.status)) return;
      view.status = status;
      view.error = message;
      view.completedAt = now();
      const attempt = await lastAttempt(tx, view);
      if (attempt) {
        attempt.status = status;
        attempt.error = message;
        await saveAttempt(tx, current, view, attempt);
      }
      await tx.event(run.value.id, `node.${status}`, message, {
        nodeId: node.nodeId,
        status,
      });
    },
  );
}
async function stopForRevokedAuthority(
  owner: StudioOwner,
  runId: string,
  code: string,
  job: OperationJobRecord,
) {
  return withStudioTransaction(owner, async (tx) => {
    await assertLease(tx, job);
    const run = await requireRun(tx, runId);
    for (const n of run.value.nodes.filter(
      (n) => !STUDIO_TERMINAL_NODE_STATES.includes(n.status),
    )) {
      n.status = n.status === "queued" ? "blocked" : "uncertain";
      n.error =
        "Execution stopped because the owner's workspace or provider authority changed. Active provider work may still finish.";
      n.errorCode = code;
      n.completedAt = now();
    }
    await settleDependents(tx, run);
    await saveRun(tx, run);
    return { runId, status: run.value.status };
  });
}
function providerRunContext(
  owner: StudioOwner,
  run: StoredRun,
  signal: AbortSignal,
): StudioProviderContext {
  const actorId = owner.legacyActorId ?? owner.actorId;
  return {
    tenantId: owner.tenantId,
    actorId,
    signal,
    sourceStreamId: `studio:${run.value.id}`,
    executionScope: createExecutionScope({
      ...run.executionScope,
      initiatingActorId: actorId,
      executingPrincipalId: actorId,
      purpose: "studio.provider.generate",
    }),
  };
}
function safeMessage(value: string) {
  return value
    .replace(/https?:\/\/\S+/g, "[provider endpoint]")
    .replace(/(?:bearer|api[_ -]?key|token)\b\s*[:=]?\s*\S+/gi, "[credential]")
    .slice(0, 600);
}
function publicFailure(error: unknown, fallback: string) {
  return error instanceof StudioError || error instanceof StudioProviderError
    ? safeMessage(error.message)
    : fallback;
}
