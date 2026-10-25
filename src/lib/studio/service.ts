import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  enqueueOperationJob,
  requeueOperationJobByDedupeKey,
} from "@/lib/operations/job-queue";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { hasDatabaseUrl } from "@/lib/db/client";
import {
  studioCapabilityPin,
  type StudioCapabilityPin,
} from "./request-contract";
import { reserveStudioBudget } from "./budget";
import type { SecurityContext } from "@/lib/security/types";
import { studioOwner, verifyStudioAuthority } from "./authority";
import { studioAsset, readStudioAsset } from "./assets";
import {
  studioCanonicalJson,
  studioGraphSchema,
  studioViewportSchema,
  studioScopeSchema,
  emptyStudioGraph,
  STUDIO_TERMINAL_RUN_STATES,
  type StudioFlow,
  type StudioRun,
  type StudioQuote,
  type StudioAsset,
} from "./contracts";
import { executionIdentity, planExecution, validateGraph } from "./graph";
import {
  estimateStudioProviderCost,
  validateStudioProviderInputs,
} from "./capabilities";
import {
  resolveStudioCapabilities,
  resolveStudioProviderRoute,
} from "./providers";
import type { StudioProviderRoute } from "./provider-types";
import { withStudioTransaction, type StudioTransaction } from "./store";
import {
  StudioError,
  STUDIO_MAX_GENERATIONS,
  STUDIO_MAX_ACTIVE_RUNS,
  studioJobKey,
  type StudioOwner,
  type StoredQuote,
  type StoredRun,
  type StoredRequest,
  type StoredAttempt,
} from "./server-types";

export const createFlowSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().max(4000).default(""),
    graph: studioGraphSchema.default(emptyStudioGraph()),
    viewport: studioViewportSchema.default({ x: 0, y: 0, zoom: 1 }),
    workspaceId: z.string().min(1).max(240).optional(),
    projectId: z.string().min(1).max(240).nullable().optional(),
  })
  .strict();
export const patchFlowSchema = z
  .object({
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(4000).optional(),
    graph: studioGraphSchema.optional(),
    viewport: studioViewportSchema.optional(),
  })
  .strict();
export const quoteSchema = z
  .object({ revision: z.number().int().positive(), scope: studioScopeSchema })
  .strict();
export const submitRunSchema = z
  .object({
    quoteId: z.string().min(1).max(180),
    scope: studioScopeSchema,
    maxCostUsd: z.number().min(0).max(100).nullable(),
    allowUnknownCost: z.boolean().default(false),
    maxGenerations: z.number().int().min(1).max(STUDIO_MAX_GENERATIONS),
  })
  .strict();
const now = () => new Date().toISOString();
export const studioHash = (v: unknown) =>
  createHash("sha256").update(studioCanonicalJson(v)).digest("hex");
function requestId(owner: StudioOwner, action: string, key: string) {
  return `studio_request_${studioHash([owner.tenantId, owner.actorId, action, key])}`;
}
async function replay(tx: StudioTransaction, id: string, requestHash: string) {
  const r = await tx.get<StoredRequest>("request", id);
  if (r && r.requestHash !== requestHash)
    throw new StudioError(
      "This request key already belongs to a different action.",
      409,
      "studio_idempotency_conflict",
    );
  return r;
}
export async function listStudioFlows(context: SecurityContext) {
  const owner = studioOwner(context);
  return withStudioTransaction(owner, async (tx) => {
    await verifyStudioAuthority(tx, owner);
    const visible: StudioFlow[] = [];
    for (const flow of (await tx.list<StudioFlow>("flow")).filter(
      (f) => !f.archived,
    )) {
      try {
        await verifyStudioAuthority(
          tx,
          owner,
          flow.workspaceId,
          flow.projectId,
        );
        visible.push(flow);
      } catch (error) {
        if (!(error instanceof StudioError) || error.status !== 403)
          throw error;
      }
    }
    return visible;
  });
}
export async function getStudioFlow(context: SecurityContext, id: string) {
  const owner = studioOwner(context);
  return withStudioTransaction(owner, async (tx) => {
    const flow = await requireFlow(tx, id);
    await verifyStudioAuthority(tx, owner, flow.workspaceId, flow.projectId);
    return flow;
  });
}
export async function createStudioFlow(
  context: SecurityContext,
  body: unknown,
  key: string,
) {
  const owner = studioOwner(context),
    input = createFlowSchema.parse(body),
    digest = studioHash(input),
    rid = requestId(owner, "flow.create", key);
  const capabilities = await resolveStudioCapabilities(providerContext(owner));
  const issues = validateGraph(input.graph, capabilities, {
    checkRequired: false,
  });
  if (issues.length)
    throw new StudioError(
      "Repair the flow connections before saving.",
      400,
      "studio_graph_invalid",
      issues,
    );
  return withStudioTransaction(owner, async (tx) => {
    const previous = await replay(tx, rid, digest);
    if (previous) {
      const saved = await requireFlow(tx, previous.targetId);
      await verifyStudioAuthority(
        tx,
        owner,
        saved.workspaceId,
        saved.projectId,
      );
      return saved;
    }
    const authority = await verifyStudioAuthority(
      tx,
      owner,
      input.workspaceId,
      input.projectId,
    );
    if ((await tx.list("flow", undefined, 200)).length >= 200)
      throw new StudioError(
        "Archive or reuse an existing flow; the workspace flow limit is 200.",
        429,
        "studio_flow_limit",
      );
    const at = now();
    const flow: StudioFlow = {
      id: `studio_flow_${randomUUID()}`,
      name: input.name,
      description: input.description,
      graph: input.graph,
      viewport: input.viewport,
      workspaceId: authority.workspaceId,
      projectId: input.projectId ?? null,
      revision: 1,
      archived: false,
      createdAt: at,
      updatedAt: at,
    };
    await tx.put("flow", flow.id, flow);
    await tx.put("request", rid, {
      requestHash: digest,
      kind: "flow",
      targetId: flow.id,
    });
    return flow;
  });
}
export async function updateStudioFlow(
  context: SecurityContext,
  id: string,
  body: unknown,
  key: string,
) {
  const owner = studioOwner(context),
    input = patchFlowSchema.parse(body),
    digest = studioHash([id, input]),
    rid = requestId(owner, "flow.update", key);
  const caps = input.graph
    ? await resolveStudioCapabilities(providerContext(owner))
    : [];
  if (input.graph) {
    const issues = validateGraph(input.graph, caps, { checkRequired: false });
    if (issues.length)
      throw new StudioError(
        "Repair invalid connections before saving.",
        400,
        "studio_graph_invalid",
        issues,
      );
  }
  return withStudioTransaction(owner, async (tx) => {
    const previous = await replay(tx, rid, digest);
    if (previous) {
      const saved = await requireFlow(tx, previous.targetId);
      await verifyStudioAuthority(
        tx,
        owner,
        saved.workspaceId,
        saved.projectId,
      );
      return saved;
    }
    const flow = await requireFlow(tx, id);
    await verifyStudioAuthority(tx, owner, flow.workspaceId, flow.projectId);
    assertRevision(flow, input.revision);
    const { revision: _revision, ...patch } = input;
    const next = {
      ...flow,
      ...patch,
      revision: flow.revision + 1,
      updatedAt: now(),
    };
    await tx.put("flow", id, next);
    await tx.put("request", rid, {
      requestHash: digest,
      kind: "flow",
      targetId: id,
    });
    return next;
  });
}
export async function studioFlowAction(
  context: SecurityContext,
  id: string,
  input: { action: "duplicate" | "archive"; revision: number },
  key: string,
) {
  const owner = studioOwner(context),
    digest = studioHash([id, input]),
    rid = requestId(owner, "flow.action", key);
  return withStudioTransaction(owner, async (tx) => {
    const previous = await replay(tx, rid, digest);
    if (previous) {
      const saved = await requireFlow(tx, previous.targetId);
      await verifyStudioAuthority(
        tx,
        owner,
        saved.workspaceId,
        saved.projectId,
      );
      return saved;
    }
    const flow = await requireFlow(tx, id);
    await verifyStudioAuthority(tx, owner, flow.workspaceId, flow.projectId);
    assertRevision(flow, input.revision);
    const at = now();
    const next: StudioFlow =
      input.action === "archive"
        ? {
            ...flow,
            archived: true,
            revision: flow.revision + 1,
            updatedAt: at,
          }
        : {
            ...flow,
            id: `studio_flow_${randomUUID()}`,
            name: `${flow.name.slice(0, 153)} copy`,
            revision: 1,
            archived: false,
            createdAt: at,
            updatedAt: at,
          };
    await tx.put("flow", next.id, next, {
      state: next.archived ? "archived" : "active",
    });
    await tx.put("request", rid, {
      requestHash: digest,
      kind: "flow",
      targetId: next.id,
    });
    return next;
  });
}
export async function quoteStudioFlow(
  context: SecurityContext,
  id: string,
  body: unknown,
  key: string,
) {
  const owner = studioOwner(context),
    input = quoteSchema.parse(body),
    flow = await getStudioFlow(context, id);
  assertRevision(flow, input.revision);
  if (flow.archived)
    throw new StudioError(
      "Restore or duplicate this archived flow before running.",
      409,
      "studio_flow_archived",
    );
  const caps = await resolveStudioCapabilities(providerContext(owner));
  const prior = await withStudioTransaction(owner, (tx) =>
    tx.list<StoredRun>("run", id, 100),
  );
  const routes: Record<string, StudioProviderRoute> = {},
    reusable: StoredQuote["reusable"] = {},
    capabilityPins: Record<string, StudioCapabilityPin> = {},
    assetPins: Record<string, StudioAsset> = {};
  for (const n of flow.graph.nodes.filter(
    (n) => ["image", "video"].includes(n.type) && n.config.capabilityId,
  )) {
    try {
      capabilityPins[n.id] = studioCapabilityPin(
        n.config.capabilityId!,
        n.config.parameters,
      );
      routes[n.id] = await resolveStudioProviderRoute(
        n.config.capabilityId!,
        providerContext(owner),
      );
    } catch {
      continue;
    }
    const old = prior.find(
      (r) =>
        r.value.nodes.some(
          (p) =>
            p.nodeId === n.id &&
            p.status === "succeeded" &&
            p.configurationHash === executionIdentity(flow.graph, n.id),
        ) &&
        r.capabilityPins?.[n.id]?.hash === capabilityPins[n.id].hash &&
        studioCanonicalJson(r.routes[n.id]) ===
          studioCanonicalJson(routes[n.id]),
    );
    const result = old?.value.nodes.find(
      (p) => p.nodeId === n.id && p.status === "succeeded",
    );
    if (result?.outputAssets.length) {
      try {
        for (const a of result.outputAssets)
          await readStudioAsset(owner, a.id, a.contentSha256);
        reusable[n.id] = {
          configurationHash: result.configurationHash,
          inputAssets: result.inputAssets,
          outputAssets: result.outputAssets,
          runId: old!.value.id,
        };
      } catch {
        /* Missing historical media cannot be reused; new generation remains possible. */
      }
    }
  }
  const plan = planExecution(flow.graph, input.scope, caps, reusable);
  const relevant = new Set(plan.nodeIds);
  for (const parents of Object.values(plan.dependencies))
    parents.forEach((p) => relevant.add(p));
  const issues = [...plan.issues];
  for (const n of flow.graph.nodes.filter((n) => relevant.has(n.id))) {
    if (n.type === "asset" && n.config.assetId) {
      try {
        const found = await readStudioAsset(
          owner,
          n.config.assetId,
          n.config.assetVersion,
        );
        if (
          n.config.assetMediaType &&
          n.config.assetMediaType !== found.asset.mediaType
        )
          throw new StudioError("The reference media type changed.");
        assetPins[n.config.assetId] = studioAsset(found.asset);
      } catch (e) {
        issues.push({
          code: "asset_unavailable",
          message: e instanceof Error ? e.message : "Reference unavailable.",
          nodeId: n.id,
          severity: "error",
        });
      }
    }
    for (const asset of reusable[n.id]?.outputAssets ?? [])
      assetPins[asset.id] = asset;
    if (
      plan.nodeIds.includes(n.id) &&
      (n.type === "image" || n.type === "video")
    ) {
      const capability = caps.find((c) => c.id === n.config.capabilityId);
      const refs = flow.graph.edges
        .filter((e) => e.target === n.id && e.targetPort !== "prompt")
        .map((e) => {
          const parent = flow.graph.nodes.find((p) => p.id === e.source)!;
          return {
            role:
              capability?.inputRoles.find((r) => r.portId === e.targetPort)
                ?.role ?? e.targetPort,
            mediaType:
              parent.type === "asset"
                ? (parent.config.assetMediaType ?? "image/png")
                : parent.type === "video"
                  ? "video/mp4"
                  : "image/png",
          };
        });
      const validated = validateStudioProviderInputs({
        capabilityId: n.config.capabilityId ?? "",
        prompt: plan.effectivePrompts[n.id] ?? "",
        parameters: n.config.parameters,
        references: refs,
      });
      issues.push(...validated.issues.map((v) => ({ ...v, nodeId: n.id })));
    }
  }
  const generate = flow.graph.nodes.filter(
    (n) =>
      plan.nodeIds.includes(n.id) &&
      ["image", "video"].includes(n.type) &&
      !plan.reusedNodeIds.includes(n.id),
  );
  const estimates = generate.map((n) =>
    estimateStudioProviderCost(
      n.config.capabilityId ?? "",
      n.config.parameters,
    ),
  );
  const unknown = estimates.some((e) => e.status === "unknown");
  const minimum = estimates.reduce(
      (sum, e) => sum + (e.minimumUsd ?? e.estimatedUsd ?? 0),
      0,
    ),
    maximum = estimates.reduce(
      (sum, e) => sum + (e.maximumUsd ?? e.estimatedUsd ?? 0),
      0,
    );
  const generationCount = generate.reduce(
    (sum, n) => sum + Number(n.config.parameters.outputCount ?? 1),
    0,
  );
  if (generationCount > STUDIO_MAX_GENERATIONS)
    issues.push({
      code: "generation_limit",
      message: `A run can generate at most ${STUDIO_MAX_GENERATIONS} outputs. Run a smaller branch.`,
      severity: "error",
    });
  const requestHash = studioHash([id, input]);
  const snapshotHash = studioHash({
    graph: flow.graph,
    revision: flow.revision,
    scope: input.scope,
    reusable,
    assetPins,
    routes,
    capabilityPins,
  });
  const quote: StudioQuote = {
    id: `studio_quote_${studioHash([owner.tenantId, owner.actorId, key])}`,
    flowId: id,
    flowRevision: flow.revision,
    snapshotHash,
    scope: input.scope,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    estimate: {
      currency: "USD",
      status: unknown ? "unknown" : minimum === maximum ? "known" : "range",
      estimatedUsd: unknown ? null : maximum,
      ...(!unknown ? { minimumUsd: minimum, maximumUsd: maximum } : {}),
      explanation: unknown
        ? "Some provider costs are unknown; explicit consent and generation limits are required."
        : "Maximum documented provider cost, before any account-specific taxes or discounts.",
    },
    generationCount,
    reusedNodeIds: plan.reusedNodeIds,
    nodeIds: plan.nodeIds,
    issues,
    effectivePrompts: plan.effectivePrompts,
    requiresUnknownCostConsent: unknown,
  };
  return withStudioTransaction(owner, async (tx) => {
    const existing = await tx.get<StoredQuote>("quote", quote.id);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new StudioError(
          "This quote key was used for a different request.",
          409,
          "studio_idempotency_conflict",
        );
      const authorizedFlow = await requireFlow(tx, id);
      await verifyStudioAuthority(
        tx,
        owner,
        authorizedFlow.workspaceId,
        authorizedFlow.projectId,
      );
      return existing.value;
    }
    const current = await requireFlow(tx, id);
    assertRevision(current, input.revision);
    await verifyStudioAuthority(
      tx,
      owner,
      current.workspaceId,
      current.projectId,
    );
    await tx.put(
      "quote",
      quote.id,
      {
        value: quote,
        configurationHashes: plan.configurationHashes,
        dependencies: plan.dependencies,
        reusable,
        assetPins,
        requestHash,
        routes,
        capabilityPins,
      } satisfies StoredQuote,
      { parentId: id },
    );
    return quote;
  });
}
export async function submitStudioRun(
  context: SecurityContext,
  flowId: string,
  body: unknown,
  key: string,
) {
  const owner = studioOwner(context),
    input = submitRunSchema.parse(body),
    digest = studioHash([flowId, input]),
    rid = requestId(owner, "run.create", key);
  const result = await withStudioTransaction(owner, async (tx) => {
    const previous = await replay(tx, rid, digest);
    if (previous) {
      const r = await requireRun(tx, previous.targetId);
      await verifyStudioAuthority(tx, owner, r.workspaceId, r.projectId);
      return { run: r.value, queued: r.value.status === "queued" };
    }
    const flow = await requireFlow(tx, flowId);
    const authority = await verifyStudioAuthority(
      tx,
      owner,
      flow.workspaceId,
      flow.projectId,
    );
    const q = await tx.get<StoredQuote>("quote", input.quoteId);
    if (!q || q.value.flowId !== flowId)
      throw new StudioError(
        "Generate a quote for this flow first.",
        400,
        "studio_quote_required",
      );
    assertRevision(flow, q.value.flowRevision);
    if (flow.archived)
      throw new StudioError(
        "The flow is archived.",
        409,
        "studio_flow_archived",
      );
    if (Date.parse(q.value.expiresAt) <= Date.now())
      throw new StudioError(
        "This quote expired. Validate the flow again.",
        409,
        "studio_quote_expired",
      );
    if (studioCanonicalJson(q.value.scope) !== studioCanonicalJson(input.scope))
      throw new StudioError(
        "Run scope changed. Validate it again.",
        409,
        "studio_quote_changed",
      );
    if (q.value.issues.some((i) => i.severity === "error"))
      throw new StudioError(
        "Resolve the flow validation errors before running.",
        400,
        "studio_graph_invalid",
        q.value.issues,
      );
    if (q.value.requiresUnknownCostConsent && !input.allowUnknownCost)
      throw new StudioError(
        "Explicitly accept unknown provider cost before running.",
        400,
        "studio_cost_consent_required",
      );
    if (q.value.requiresUnknownCostConsent && input.maxCostUsd !== null)
      throw new StudioError(
        "A monetary cap cannot be guaranteed for an unknown price. Choose a priced model or accept unknown cost with a generation-count cap.",
        400,
        "studio_unknown_cost_cap",
      );
    const maximum =
      q.value.estimate.maximumUsd ?? q.value.estimate.estimatedUsd;
    if (
      maximum !== null &&
      maximum > 0 &&
      (input.maxCostUsd === null || maximum > input.maxCostUsd)
    )
      throw new StudioError(
        "This quote exceeds the accepted provider budget.",
        400,
        "studio_budget_exceeded",
      );
    if (q.value.generationCount > input.maxGenerations)
      throw new StudioError(
        "The run exceeds your generation-count cap.",
        400,
        "studio_generation_limit",
      );
    if (
      (await tx.count("run", ["queued", "running"])) >= STUDIO_MAX_ACTIVE_RUNS
    )
      throw new StudioError(
        "Two studio runs are already active. Wait or cancel one first.",
        429,
        "studio_concurrency_limit",
      );
    for (const asset of Object.values(q.assetPins)) {
      if (tx.sql) {
        const rows =
          await tx.sql`SELECT id FROM omni_capture_assets WHERE tenant_id=${owner.tenantId} AND (actor_id=${owner.actorId} OR actor_id=${authority.legacyActorId ?? owner.actorId}) AND id=${asset.id} AND content_sha256=${asset.contentSha256} AND media_type=${asset.mediaType} FOR SHARE`;
        if (rows.length !== 1)
          throw new StudioError(
            "A referenced asset changed or is unavailable. Quote the flow again.",
            409,
            "studio_asset_unavailable",
          );
      } else
        await readStudioAsset(
          { ...owner, legacyActorId: authority.legacyActorId },
          asset.id,
          asset.contentSha256,
        );
    }
    const id = `studio_run_${randomUUID()}`,
      at = now();
    const run: StudioRun = {
      id,
      flowId,
      flowRevision: flow.revision,
      graph: structuredClone(flow.graph),
      scope: input.scope,
      status: "queued",
      nodes: q.value.nodeIds.map((nodeId) => ({
        nodeId,
        status: q.value.reusedNodeIds.includes(nodeId) ? "succeeded" : "queued",
        configurationHash: q.configurationHashes[nodeId],
        effectivePrompt: q.value.effectivePrompts[nodeId] ?? "",
        inputAssets: q.value.reusedNodeIds.includes(nodeId)
          ? q.reusable[nodeId].inputAssets
          : [],
        outputAssets: q.value.reusedNodeIds.includes(nodeId)
          ? q.reusable[nodeId].outputAssets
          : [],
        attempts: [],
        ...(q.value.reusedNodeIds.includes(nodeId)
          ? { reusedFrom: q.reusable[nodeId].runId, completedAt: at }
          : {}),
      })),
      estimate: q.value.estimate,
      maxCostUsd: input.maxCostUsd,
      maxGenerations: input.maxGenerations,
      requestedBy: owner.actorId,
      createdAt: at,
      updatedAt: at,
    };
    await reserveStudioBudget(tx, owner, id, maximum);
    const stored: StoredRun = {
      value: run,
      dependencies: q.dependencies,
      assetPins: q.assetPins,
      executionScope: createExecutionScope({
        tenantId: owner.tenantId,
        initiatingActorId: owner.actorId,
        executingPrincipalType: "user",
        executingPrincipalId: owner.actorId,
        workspaceId: flow.workspaceId,
        projectId: flow.projectId ?? undefined,
        correlationId: id,
        purpose: "studio.run",
      }),
      revision: 1,
      lastEventSeq: 0,
      quoteId: q.value.id,
      requestHash: digest,
      legacyActorId: authority.legacyActorId,
      workspaceId: flow.workspaceId,
      projectId: flow.projectId,
      generationCount: q.value.generationCount,
      pollCount: 0,
      routes: q.routes,
      capabilityPins: q.capabilityPins,
      reusable: q.reusable,
    };
    await tx.put("run", id, stored, { parentId: flowId, state: run.status });
    await tx.put("request", rid, {
      requestHash: digest,
      kind: "run",
      targetId: id,
    });
    await tx.event(
      id,
      "run.queued",
      `Queued ${q.value.generationCount} generation output${q.value.generationCount === 1 ? "" : "s"}.`,
      { status: "queued" },
    );
    if (tx.sql) await enqueueStudioJob(owner, id, tx);
    return { run, queued: true };
  });
  if (result.queued) await enqueueStudioJob(owner, result.run.id);
  return result.run;
}
export async function listStudioRuns(context: SecurityContext, flowId: string) {
  await getStudioFlow(context, flowId);
  const runs = await withStudioTransaction(studioOwner(context), async (tx) =>
    (await tx.list<StoredRun>("run", flowId, 40)).map((r) => r.value),
  );
  if (!hasDatabaseUrl())
    for (const run of runs.filter(
      (r) => !STUDIO_TERMINAL_RUN_STATES.includes(r.status),
    ))
      await enqueueStudioJob(studioOwner(context), run.id);
  return runs;
}
export async function getStudioRun(
  context: SecurityContext,
  id: string,
  afterSeq = 0,
) {
  const owner = studioOwner(context);
  const result = await withStudioTransaction(owner, async (tx) => {
    const run = await requireRun(tx, id);
    await verifyStudioAuthority(tx, owner, run.workspaceId, run.projectId);
    return { run: run.value, events: await tx.events(id, afterSeq) };
  });
  if (
    !hasDatabaseUrl() &&
    !STUDIO_TERMINAL_RUN_STATES.includes(result.run.status)
  )
    await enqueueStudioJob(owner, id);
  return result;
}
export async function studioRunAction(
  context: SecurityContext,
  id: string,
  action: "cancel" | "retry-persistence",
) {
  const owner = studioOwner(context);
  const value = await withStudioTransaction(owner, async (tx) => {
    const run = await requireRun(tx, id);
    await verifyStudioAuthority(tx, owner, run.workspaceId, run.projectId);
    if (action === "cancel") {
      if (STUDIO_TERMINAL_RUN_STATES.includes(run.value.status))
        return run.value;
      if (!run.value.cancellationRequestedAt) {
        run.value.cancellationRequestedAt = now();
        await tx.event(
          id,
          "run.cancellation_requested",
          "Cancellation requested. Active providers may still complete.",
        );
      }
    } else {
      let found = false;
      for (const n of run.value.nodes.filter(
        (n) =>
          n.status === "persisting" ||
          n.errorCode === "studio_persistence_canceled",
      )) {
        const a = await tx.get<StoredAttempt>(
          "attempt",
          n.attempts.at(-1)?.id ?? "",
        );
        if (a?.result?.status === "completed") {
          n.status = "persisting";
          n.completedAt = undefined;
          n.error = undefined;
          n.errorCode = undefined;
          found = true;
        }
      }
      if (!found)
        throw new StudioError(
          "This run has no saved result waiting for persistence.",
          409,
          "studio_no_persistence_retry",
        );
      run.value.status = "running";
      run.value.completedAt = undefined;
      await tx.event(
        id,
        "run.persistence_retry",
        "Retrying storage of the existing provider result; no new generation.",
      );
    }
    run.value.updatedAt = now();
    run.revision++;
    await tx.put("run", id, run, {
      parentId: run.value.flowId,
      state: run.value.status,
    });
    if (tx.sql && action === "retry-persistence")
      await enqueueStudioJob(owner, id, tx, true);
    return run.value;
  });
  await enqueueStudioJob(owner, id, undefined, action === "retry-persistence");
  await requeueOperationJobByDedupeKey(
    studioJobKey(id),
    "Studio action requested.",
    { tenantId: owner.tenantId },
  );
  return value;
}
export async function enqueueStudioJob(
  owner: StudioOwner,
  id: string,
  tx?: StudioTransaction,
  recoverCompleted = false,
) {
  return enqueueOperationJob(
    {
      tenantId: owner.tenantId,
      type: "studio.run.tick",
      payload: { actorId: owner.actorId, runId: id },
      dedupeKey: studioJobKey(id),
      dedupeMode: recoverCompleted ? "coalesce" : "idempotent",
      requeueTerminal: recoverCompleted,
      maxAttempts: 5,
    },
    tx?.sql ? { sql: tx.sql } : {},
  );
}
export async function requireFlow(tx: StudioTransaction, id: string) {
  const f = await tx.get<StudioFlow>("flow", id);
  if (!f)
    throw new StudioError("Flow not found.", 404, "studio_flow_not_found");
  return f;
}
export async function requireRun(tx: StudioTransaction, id: string) {
  const r = await tx.get<StoredRun>("run", id);
  if (!r) throw new StudioError("Run not found.", 404, "studio_run_not_found");
  return r;
}
function assertRevision(flow: StudioFlow, revision: number) {
  if (flow.revision !== revision)
    throw new StudioError(
      "A newer draft was saved in another tab. Reload it or duplicate your local draft.",
      409,
      "studio_revision_conflict",
    );
}
export function providerContext(owner: StudioOwner) {
  return {
    tenantId: owner.tenantId,
    actorId: owner.legacyActorId ?? owner.actorId,
  };
}
