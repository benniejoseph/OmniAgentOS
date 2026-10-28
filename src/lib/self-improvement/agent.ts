import { randomUUID } from "node:crypto";
import { arsenalAgents } from "@/lib/agents/arsenal";
import { resolveAgentIdentityForExecution } from "@/lib/agents/identity-store";
import { resolveDelegationOwnerAuthority } from "@/lib/delegation/custom-profile";
import { runAgent } from "@/lib/orchestration/agent-runner";
import { getAgentRun, appendRunEvent } from "@/lib/runs/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { redactSensitive } from "@/lib/security/context";
import { getToolExecutionsByIds } from "@/lib/tools/audit-store";
import { getToolExecutionScopeBinding, assertToolExecutionBindingMatchesRequest, toolInputSha256 } from "@/lib/tools/execution-scope";
import { executeGovernedTool } from "@/lib/tools/executor";
import { createInspectionCompletionGate, inspectionCompletionReceiptSchema, inspectionContextReadSchema, isInspectionImplementationPath, isInspectionTestPath, type InspectionCompletionReceipt, type InspectionReadReceipt, type InspectionToolObservation } from "./inspection-completion";
import { SELF_IMPROVEMENT_BUILDER_TOOLS, SELF_IMPROVEMENT_READ_TOOLS, withSelfImprovementExecution, type SelfImprovementExecutionAuthority } from "./authority";
import { createForgeHandoff, forgeEffectSchema, forgeHandoffReceiptSchema, type ForgeEffect, type ForgeHandoffReceipt } from "./forge-handoff";
import { selfImprovementRunBudgetLimits, type SelfImprovementBudgetProfile } from "./engineering-budget";
import { createReviewCompletionGate } from "./review-completion";
import { reviewCompletionReceiptSchema, type ReviewCompletionReceipt, type ReviewRead } from "./review-contracts";
import { getProjectBuilderSession } from "@/lib/app-builder/store";
import { getBuilderWorkspaceManifest } from "@/lib/app-builder/sandbox";

const objectRecord = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const forgeMutationTools = new Set(["app.projects.builder.file.update", "app.projects.builder.file.edit", "app.projects.builder.file.delete"]);

export async function improvementExecutionContext(authority: SelfImprovementExecutionAuthority, agentId: "atlas" | "forge" | "sentinel", runId: string) {
  await authority.assertCurrent();
  const owner = await resolveDelegationOwnerAuthority(authority.tenantId, authority.ownerActorId);
  // The live authority checks administrator membership. Delegated execution
  // deliberately retains the narrower operator role.
  if (!owner || owner.role === "viewer") throw new Error("The self-improvement owner no longer has execution authority.");
  const identity = await resolveAgentIdentityForExecution({ tenantId: authority.tenantId, actorId: authority.ownerActorId, agentId });
  return {
    identity, requestActorBinding: owner.binding,
    context: { tenantId: authority.tenantId, actorId: authority.ownerActorId, role: owner.role, source: "service" as const },
    scope: createExecutionScope({ tenantId: authority.tenantId, initiatingActorId: authority.ownerActorId,
      executingPrincipalType: "agent", executingPrincipalId: identity.principal.principalId,
      projectId: authority.projectId, correlationId: runId, purpose: "self_improvement.cycle.v1", causationId: authority.cycleId }),
  };
}

export async function executeImprovementTool(input: {
  authority: SelfImprovementExecutionAuthority; toolId: string; parameters: Record<string, unknown>;
  idempotencyKey: string; abortSignal?: AbortSignal;
}) {
  const bound = await improvementExecutionContext(input.authority, "atlas", input.authority.cycleId);
  return withSelfImprovementExecution(input.authority, async () => {
    const result = await executeGovernedTool({ toolId: input.toolId,
      input: { ...input.parameters, projectId: input.authority.projectId }, dryRun: false,
      context: bound.context, requestActorBinding: bound.requestActorBinding, executionScope: bound.scope,
      idempotencyKey: input.idempotencyKey, abortSignal: input.abortSignal });
    if (result.record.status !== "executed") {
      const savedOutput = result.record.output;
      const savedError = savedOutput && typeof savedOutput === "object" && !Array.isArray(savedOutput)
        ? (savedOutput as Record<string, unknown>).error : undefined;
      const reason = typeof savedError === "string" ? savedError : result.record.reason;
      // Only the durable receipt supplies diagnostics. Redact before shortening
      // so a partial private key or credential cannot escape its full pattern.
      const detail = typeof reason === "string"
        ? String(redactSensitive(reason)).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 400) : "";
      throw new Error(`Improvement operation did not execute: ${input.toolId} (${result.record.status}).${detail ? ` Recorded tool error: ${JSON.stringify(detail)}` : ""}`);
    }
    const output = result.result as Record<string, unknown>;
    return { executionId: result.record.id, data: output && typeof output === "object" && "data" in output ? output.data as Record<string, unknown> : output };
  });
}

export async function runImprovementAgent(input: {
  authority: SelfImprovementExecutionAuthority; agentId: "atlas" | "forge" | "sentinel";
  prompt: string; costCeilingUsd: number; abortSignal: AbortSignal;
  onRunStarted: (runId: string) => Promise<void>;
}) {
  const runId = randomUUID();
  const bound = await improvementExecutionContext(input.authority, input.agentId, runId);
  const agent = arsenalAgents.find((item) => item.id === input.agentId)!;
  await input.onRunStarted(runId);
  const fileReadIds = new Set<string>();
  const mutationIds = new Set<string>();
  const observations = new Map<string, InspectionToolObservation>();
  const verifiedReads = new Map<string, InspectionReadReceipt>();
  const verifiedReviewReads = new Map<string, ReviewRead>();
  const readReceipts = async () => {
    const ids = [...fileReadIds];
    const records = await getToolExecutionsByIds(ids, { tenantId: input.authority.tenantId });
    if (records.length !== ids.length) throw new Error("Inspection read receipt is unavailable.");
    const checked = new Map<string, InspectionReadReceipt>();
    const reviewReads = new Map<string, ReviewRead>();
    for (const record of records) {
      const binding = await getToolExecutionScopeBinding(record.id, { tenantId: input.authority.tenantId });
      if (record.status !== "executed" || record.dryRun || record.toolId !== "app.projects.builder.file.read" ||
          record.tenantId !== input.authority.tenantId || record.actorId !== input.authority.ownerActorId || record.input.projectId !== input.authority.projectId ||
          record.input.sessionId !== input.authority.sessionId || binding?.executionScope.correlationId !== runId ||
          binding.executionScope.tenantId !== input.authority.tenantId || binding.executionScope.initiatingActorId !== input.authority.ownerActorId || binding.executionScope.projectId !== input.authority.projectId ||
          typeof record.input.path !== "string") throw new Error("Inspection read receipt scope changed.");
      assertToolExecutionBindingMatchesRequest({ binding, record, toolInput: record.input });
      const observed = observations.get(record.id);
      const output = record.output && typeof record.output === "object" && !Array.isArray(record.output) ? record.output as Record<string, unknown> : undefined;
      const savedFile = output?.file && typeof output.file === "object" && !Array.isArray(output.file) ? output.file as Record<string, unknown> : undefined;
      const visible = observed ? JSON.parse(observed.modelOutput)?.data?.result?.file : undefined;
      if (!savedFile || !visible || visible.path !== record.input.path || visible.sha256 !== savedFile.sha256 ||
          typeof visible.content !== "string" || !visible.content.length || typeof savedFile.content !== "string" ||
          !savedFile.content.startsWith(visible.content) || !Number.isSafeInteger(visible.lineRange?.endLine) ||
          visible.lineRange.startLine !== record.input.startLine ||
          visible.content.split("\n").length !== visible.lineRange.endLine - visible.lineRange.startLine + 1) throw new Error("Inspection read did not deliver verifiable source lines.");
      checked.set(record.id, { executionId: record.id, path: record.input.path, inputSha256: binding.inputSha256, scopeSha256: toolInputSha256({ ...binding.executionScope }) });
      if (input.authority.reviewManifest?.fileHashes[record.input.path]) reviewReads.set(record.id, {
        executionId: record.id, path: record.input.path, sha256: String(savedFile.sha256), startLine: visible.lineRange.startLine, endLine: visible.lineRange.endLine,
        inputSha256: binding.inputSha256, scopeSha256: toolInputSha256({ ...binding.executionScope }),
      });
    }
    verifiedReads.clear();
    for (const [id, receipt] of checked) verifiedReads.set(id, receipt);
    verifiedReviewReads.clear();
    for (const [id, receipt] of reviewReads) verifiedReviewReads.set(id, receipt);
    return [...verifiedReads.values()];
  };
  const contextReads = async () => {
    // Paths come only from real model-visible discoveries in this exact run.
    const records = await getToolExecutionsByIds([...observations.keys()], { tenantId: input.authority.tenantId });
    if (records.length !== observations.size) throw new Error("Inspection discovery receipt is unavailable.");
    const checked: Array<{ record: typeof records[number]; result: Record<string, unknown>; delivered: Record<string, unknown> }> = [];
    const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    for (const record of records) {
      const observation = observations.get(record.id)!;
      const binding = await getToolExecutionScopeBinding(record.id, { tenantId: input.authority.tenantId });
      if (record.status !== "executed" || record.dryRun || record.toolId !== observation.toolId ||
          record.tenantId !== input.authority.tenantId || record.actorId !== input.authority.ownerActorId ||
          record.input.projectId !== input.authority.projectId || record.input.sessionId !== input.authority.sessionId ||
          binding?.executionScope.correlationId !== runId || binding.executionScope.initiatingActorId !== input.authority.ownerActorId ||
          binding.executionScope.projectId !== input.authority.projectId) throw new Error("Inspection discovery scope changed.");
      assertToolExecutionBindingMatchesRequest({ binding, record, toolInput: record.input });
      const envelope = object(JSON.parse(observation.modelOutput)), data = object(envelope?.data);
      const delivered = object(data?.result), result = object(record.output);
      if (!delivered || !result || data?.executionId !== record.id || data.status !== "executed") throw new Error("Inspection observation changed.");
      checked.push({ record, result, delivered });
    }
    for (const source of [...checked].reverse()) {
      if (source.record.toolId !== "app.projects.builder.file.read" || typeof source.record.input.path !== "string" || !isInspectionImplementationPath(source.record.input.path)) continue;
      const savedFile = object(source.result.file), file = object(source.delivered.file);
      if (!savedFile || !file || file.path !== source.record.input.path || file.sha256 !== savedFile.sha256 ||
          typeof file.content !== "string" || typeof savedFile.content !== "string" || !savedFile.content.startsWith(file.content) || !file.content.length) continue;
      for (const discovery of checked) {
        if (!["app.projects.builder.search", "app.projects.builder.tree"].includes(discovery.record.toolId) || !Array.isArray(discovery.delivered.entries) || !Array.isArray(discovery.result.entries)) continue;
        const saved = new Set(discovery.result.entries.flatMap(item => { const entry = object(item); return entry?.kind === "file" && typeof entry.path === "string" ? [entry.path] : []; }));
        const paths = discovery.delivered.entries.flatMap(item => { const entry = object(item); return entry?.kind === "file" && typeof entry.path === "string" && saved.has(entry.path) ? [entry.path] : []; });
        if (!paths.includes(source.record.input.path)) continue;
        const parent = source.record.input.path.slice(0, source.record.input.path.lastIndexOf("/") + 1);
        const stem = source.record.input.path.slice(parent.length).replace(/\.[^.]+$/, "");
        const nativeTest = source.record.input.path.startsWith("apps/flutter/lib/")
          ? source.record.input.path.replace("apps/flutter/lib/", "apps/flutter/test/").replace(/\.dart$/, "_test.dart") : undefined;
        const candidates = paths.filter(path => isInspectionTestPath(path) && (path.startsWith(parent) || path === nativeTest));
        const adjacent = candidates.sort((left, right) => {
          const exact = (path: string) => path === nativeTest || path.startsWith(`${parent}${stem}.test.`) || path.startsWith(`${parent}${stem}.spec.`);
          return Number(exact(right)) - Number(exact(left)) || left.localeCompare(right);
        })[0];
        if (!adjacent) continue;
        const provenance = { sourceExecutionId: source.record.id, discoveryExecutionId: discovery.record.id };
        const requests = [inspectionContextReadSchema.parse({ ...provenance, kind: "adjacent_test", path: adjacent, startLine: 1, lineCount: 200 })];
        const next = object(object(file.projection)?.nextRead), visibleRange = object(file.lineRange), savedRange = object(savedFile.lineRange);
        if (next && next.path === source.record.input.path && Number.isSafeInteger(visibleRange?.endLine) &&
            next.startLine === Number(visibleRange?.endLine) + 1 && Number(next.startLine) <= Number(savedRange?.endLine)) {
          requests.push(inspectionContextReadSchema.parse({ ...provenance, ...next, kind: "source_continuation" }));
        }
        return requests;
      }
    }
    return [];
  };
  const inspectionCompletion = input.agentId === "atlas" && input.authority.readOnly && input.authority.sessionId
    ? createInspectionCompletionGate({ runId, sessionId: input.authority.sessionId, assertCurrent: input.authority.assertCurrent, readReceipts, contextReads,
      observeTool: observation => {
        if (["app.projects.builder.search", "app.projects.builder.tree", "app.projects.builder.file.read"].includes(observation.toolId) && observation.modelOutput.length <= 8_000 && observations.size < 48) {
          const envelope = JSON.parse(observation.modelOutput);
          if (envelope?.data?.status === "executed" && envelope.data.dryRun === false) observations.set(observation.executionId, observation);
        }
      } }) : undefined;
  const forgeHandoff = input.agentId === "forge" && !input.authority.readOnly && input.authority.sessionId && input.authority.forgePlan
    ? createForgeHandoff({ runId, sessionId: input.authority.sessionId, plan: input.authority.forgePlan, assertCurrent: input.authority.assertCurrent,
      verifyRead: async (request, observation) => {
        const records = await getToolExecutionsByIds([observation.executionId], { tenantId: input.authority.tenantId });
        const record = records[0], binding = record && await getToolExecutionScopeBinding(record.id, { tenantId: input.authority.tenantId });
        if (records.length !== 1 || record.id !== observation.executionId || record.status !== "executed" || record.dryRun || record.toolId !== "app.projects.builder.file.read" ||
            record.tenantId !== input.authority.tenantId || record.actorId !== input.authority.ownerActorId || record.input.projectId !== input.authority.projectId || record.input.sessionId !== input.authority.sessionId ||
            record.input.path !== request.path || record.input.startLine !== request.startLine || record.input.lineCount !== request.lineCount ||
            binding?.executionScope.correlationId !== runId || binding.executionScope.projectId !== input.authority.projectId || binding.executionScope.initiatingActorId !== input.authority.ownerActorId ||
            binding.executionScope.purpose !== "agent.tool.execute") throw new Error("Forge context receipt scope changed.");
        assertToolExecutionBindingMatchesRequest({ binding, record, toolInput: record.input });
        const saved = objectRecord(objectRecord(record.output)?.file), envelope = objectRecord(JSON.parse(observation.modelOutput)), data = objectRecord(envelope?.data);
        const visible = objectRecord(objectRecord(data?.result)?.file), range = objectRecord(visible?.lineRange), savedRange = objectRecord(saved?.lineRange);
        if (data?.executionId !== record.id || data.status !== "executed" || data.dryRun !== false || !saved || !visible || visible.path !== request.path || visible.sha256 !== saved.sha256 ||
            (request.expectedSha256 && saved.sha256 !== request.expectedSha256) || typeof visible.content !== "string" || !visible.content.length || typeof saved.content !== "string" || !saved.content.startsWith(visible.content) ||
            range?.startLine !== request.startLine || !Number.isSafeInteger(range.endLine) || !Number.isSafeInteger(range.totalLines) || range.totalLines !== savedRange?.totalLines || Number(range.endLine) > Number(savedRange?.endLine) ||
            visible.content.split("\n").length !== Number(range.endLine) - request.startLine + 1) throw new Error("Forge context did not deliver the recorded source range.");
        return { executionId: record.id, path: request.path, sha256: String(saved.sha256), startLine: request.startLine, endLine: Number(range.endLine), totalLines: Number(range.totalLines),
          inputSha256: binding.inputSha256, scopeSha256: toolInputSha256({ ...binding.executionScope }) };
      } }) : undefined;
  const mutationReceipts = async (): Promise<ForgeEffect[]> => {
    const records = await getToolExecutionsByIds([...mutationIds], { tenantId: input.authority.tenantId });
    if (records.length !== mutationIds.size) throw new Error("Forge mutation receipt is unavailable.");
    const byId = new Map(records.map(record => [record.id, record]));
    const effects: ForgeEffect[] = [];
    for (const id of mutationIds) {
      const record = byId.get(id)!;
      const binding = await getToolExecutionScopeBinding(id, { tenantId: input.authority.tenantId });
      // A failed mutation can have an uncertain partial effect. A later write
      // does not erase it; this phase remains incomplete for reconciliation.
      if (record.status !== "executed" || record.dryRun || !forgeMutationTools.has(record.toolId) ||
          record.tenantId !== input.authority.tenantId || record.actorId !== input.authority.ownerActorId || record.input.projectId !== input.authority.projectId || record.input.sessionId !== input.authority.sessionId ||
          typeof record.input.path !== "string" || !input.authority.writePaths?.includes(record.input.path) ||
          binding?.executionScope.correlationId !== runId || binding.executionScope.projectId !== input.authority.projectId || binding.executionScope.initiatingActorId !== input.authority.ownerActorId || binding.executionScope.purpose !== "agent.tool.execute") throw new Error("Forge mutation receipt scope changed.");
      assertToolExecutionBindingMatchesRequest({ binding, record, toolInput: record.input });
      const output = objectRecord(record.output), deleted = record.toolId.endsWith(".delete");
      const change = objectRecord(deleted ? output?.deletion : output?.update);
      if (!change || change.path !== record.input.path || change.previousSha256 !== record.input.expectedSha256) throw new Error("Forge mutation result changed.");
      const effect = forgeEffectSchema.parse({ executionId: id, toolId: record.toolId, path: record.input.path,
        previousSha256: change.previousSha256, sha256: deleted ? null : change.sha256, inputSha256: binding.inputSha256, scopeSha256: toolInputSha256({ ...binding.executionScope }) });
      const previous = effects.findLast(item => item.path === effect.path);
      if (previous && previous.sha256 !== effect.previousSha256) throw new Error("Forge mutation chain changed.");
      // An executed no-op is a receipt, but not an application or test effect.
      if (effect.previousSha256 !== effect.sha256) effects.push(effect);
    }
    return effects;
  };
  const reviewManifest = input.agentId === "sentinel" && input.authority.readOnly ? input.authority.reviewManifest : undefined;
  const reviewCompletion = reviewManifest ? createReviewCompletionGate({ runId, manifest: reviewManifest,
    assertCurrent: input.authority.assertCurrent,
    assertEvidenceCurrent: async () => {
      const current = await getProjectBuilderSession(input.authority.projectId, { tenantId: input.authority.tenantId, actorId: input.authority.ownerActorId });
      if (!current || current.id !== reviewManifest.sessionId || (await getBuilderWorkspaceManifest(current.sandboxName)).sha256 !== reviewManifest.workspaceSha256) throw new Error("The reviewed workspace changed.");
    },
    readReceipts: async () => { await readReceipts(); return [...verifiedReviewReads.values()]; },
    observeTool: observation => { if (observation.toolId === "app.projects.builder.file.read") observations.set(observation.executionId, observation); },
  }) : undefined;
  const boundWorkspace = /^app_build_[a-f0-9]{48}$/.test(input.authority.sessionId || "");
  let budgetProfile: SelfImprovementBudgetProfile = "ordinary";
  if (boundWorkspace && forgeHandoff) budgetProfile = "edit";
  else if (boundWorkspace && input.authority.readOnly && !input.authority.forgePlan) {
    if (inspectionCompletion) budgetProfile = "inspect";
    else if (input.agentId === "sentinel") budgetProfile = "review";
  }
  return withSelfImprovementExecution({ ...input.authority, inspectionCompletion, forgeHandoff, reviewCompletion }, async () => {
    await input.authority.assertCurrent();
    let measuredCostUsd = 0, metered = true, modelEvents = 0;
    let completion: "complete" | "requested_actions_unfinished" | "answer_cut_off" | "tool_calls_refused" | "inspection_evidence_unavailable" | "inspection_incomplete" | "forge_incomplete" | "review_incomplete" = "complete";
    let inspectionReceipt: InspectionCompletionReceipt | undefined;
    let forgeReceipt: ForgeHandoffReceipt | undefined, budgetFinal = false;
    let reviewReceipt: ReviewCompletionReceipt | undefined;
    for await (const event of runAgent({ runId, messages: [{ role: "user", content: input.prompt }],
      executionScope: bound.scope, securityContext: bound.context, requestActorBinding: bound.requestActorBinding,
      agentIdentity: bound.identity, agentId: input.agentId, tenantId: input.authority.tenantId,
      actorId: input.authority.ownerActorId, role: bound.context.role, mode: "execute", liveWebPolicy: "disabled",
      memoryFormation: "withheld", specialistIds: [], maxToolSteps: 16,
      budgetLimits: selfImprovementRunBudgetLimits({
        profile: budgetProfile,
        costCeilingUsd: input.costCeilingUsd,
      }),
      agentProfile: { name: agent.name, role: agent.role, description: agent.description, instructions: agent.persona.operatingStyle,
        persona: agent.persona, modelPolicy: "auto", autonomy: "execute", approvalPolicy: input.authority.readOnly ? "read_only" : "risk_based",
        memoryScope: "session", toolIds: [...(input.authority.allowedToolIds || (input.authority.readOnly ? SELF_IMPROVEMENT_READ_TOOLS : SELF_IMPROVEMENT_BUILDER_TOOLS))], skills: [] },
    }, input.abortSignal)) {
      if (event.type === "status") {
        if (event.reviewCompletion) {
          const parsed = reviewCompletionReceiptSchema.safeParse(event.reviewCompletion);
          if (parsed.success && parsed.data.runId === runId && parsed.data.sessionId === input.authority.sessionId && parsed.data.receiptSha256 === reviewCompletion?.receipt()?.receiptSha256) reviewReceipt = parsed.data;
          else completion = "review_incomplete";
        }
        if (event.forgeHandoff) {
          const parsed = forgeHandoffReceiptSchema.safeParse(event.forgeHandoff);
          if (parsed.success && parsed.data.runId === runId && parsed.data.sessionId === input.authority.sessionId && parsed.data.receiptSha256 === forgeHandoff?.receipt()?.receiptSha256) forgeReceipt = parsed.data;
          else completion = "forge_incomplete";
        }
        if (event.label === "finishing within budget" ||
            event.toolLimit?.reason === "run_tool_rounds" && event.toolLimit.remainingToolRounds === 0 ||
            event.toolLimit?.reason === "run_tool_calls" && event.toolLimit.remainingToolCalls === 0) budgetFinal = true;
        if (event.inspectionCompletion) {
          const parsed = inspectionCompletionReceiptSchema.safeParse(event.inspectionCompletion);
          if (parsed.success && parsed.data.runId === runId && parsed.data.sessionId === input.authority.sessionId) inspectionReceipt = parsed.data;
          else completion = "inspection_evidence_unavailable";
        }
        if ((event.toolLimit?.unresolvedCalls || 0) > 0) completion = "requested_actions_unfinished";
        else if (event.label === "answer cut off") completion = "answer_cut_off";
        else if (event.label === "tool calls refused") completion = "tool_calls_refused";
      }
      if (event.type === "tool" && event.toolId === "app.projects.builder.file.read" && event.status === "executed" && event.executionId) fileReadIds.add(event.executionId);
      if (event.type === "tool" && forgeMutationTools.has(event.toolId) && event.executionId) mutationIds.add(event.executionId);
      if (event.type === "model") {
        modelEvents++;
        if (event.costKnown !== true || !Number.isFinite(event.estimatedCostUsd)) metered = false;
        else measuredCostUsd += event.estimatedCostUsd!;
      }
    }
    const run = await getAgentRun(runId, { tenantId: input.authority.tenantId });
    if (!run || (run.status !== "completed" && !(forgeHandoff && run.status === "waiting_approval"))) throw new Error(`Self-improvement ${input.agentId} run ${run?.status || "missing"}; inspect its retained receipt.`);
    if (inspectionCompletion && (inspectionReceipt?.outcome !== "accepted" || inspectionReceipt.receiptSha256 !== inspectionCompletion.accepted()?.receiptSha256)) {
      if (completion === "complete") completion = inspectionReceipt?.reason === "evidence_unavailable" ? "inspection_evidence_unavailable" : "inspection_incomplete";
    }
    const accepted = completion === "complete" && inspectionReceipt?.outcome === "accepted" ? inspectionReceipt : undefined;
    if (reviewCompletion) {
      if (!reviewReceipt || reviewReceipt.receiptSha256 !== reviewCompletion.receipt()?.receiptSha256 || reviewReceipt.outcome === "rejected") completion = "review_incomplete";
      if (reviewReceipt) {
        try {
          const saved = await appendRunEvent(runId, { type: "status", label: "Sentinel criterion review retained", reviewCompletion: reviewReceipt }, { tenantId: input.authority.tenantId, executionScope: bound.scope });
          const parsed = reviewCompletionReceiptSchema.safeParse(objectRecord(saved.payload)?.reviewCompletion);
          if (!parsed.success || parsed.data.receiptSha256 !== reviewReceipt.receiptSha256) completion = "review_incomplete";
        } catch { completion = "review_incomplete"; }
      }
    }
    if (forgeHandoff) {
      let effects: ForgeEffect[] = [], reason: ForgeHandoffReceipt["reason"] | undefined;
      if (!forgeReceipt || forgeReceipt.receiptSha256 !== forgeHandoff.receipt()?.receiptSha256) reason = "evidence_unavailable";
      else if (run.status === "waiting_approval") reason = "pending_approval";
      else if (completion !== "complete") reason = "incomplete_run";
      else {
        try { await input.authority.assertCurrent(); effects = await mutationReceipts(); }
        catch { reason = "evidence_unavailable"; }
        if (!reason && !effects.length) reason = budgetFinal ? "budget_before_effect" : "no_changes";
      }
      forgeReceipt = forgeHandoff.finish(effects, reason);
      const saved = await appendRunEvent(runId, { type: "status", label: forgeReceipt.outcome === "completed" ? "Forge effects recorded" : "Forge phase incomplete", forgeHandoff: forgeReceipt }, { tenantId: input.authority.tenantId, executionScope: bound.scope });
      const parsed = forgeHandoffReceiptSchema.safeParse(objectRecord(saved.payload)?.forgeHandoff);
      if (!parsed.success || parsed.data.receiptSha256 !== forgeReceipt.receiptSha256 || forgeReceipt.outcome !== "completed") completion = "forge_incomplete";
    }
    return { runId, response: run.response || "", completion, inspectedPaths: [...verifiedReads.values()].map(item => item.path),
      inspectionResult: accepted?.result, inspectionReceipt: accepted, forgeReceipt, reviewReceipt,
      forgeResult: completion === "complete" && forgeReceipt?.outcome === "completed" ? { effects: forgeReceipt.effects } : undefined,
      measuredCostUsd: metered && (modelEvents > 0 || (forgeHandoff && !forgeHandoff.modelAttempted() && forgeReceipt?.outcome === "incomplete")) ? measuredCostUsd : null };
  });
}
