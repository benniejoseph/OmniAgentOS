import { AsyncLocalStorage } from "node:async_hooks";
import type { SecurityContext } from "@/lib/security/types";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { InspectionCompletionGate } from "./inspection-completion";
import type { ForgeHandoff, ForgePlan } from "./forge-handoff";
import type { ReviewCompletionGate } from "./review-completion";
import type { ReviewCompletionReceipt, ReviewManifest } from "./review-contracts";

export const SELF_IMPROVEMENT_BUILDER_TOOLS = Object.freeze([
  "app.projects.builder.show", "app.projects.builder.create", "app.projects.builder.tree",
  "app.projects.builder.search", "app.projects.builder.file.read", "app.projects.builder.file.update",
  "app.projects.builder.file.edit",
  "app.projects.builder.framework-doc.read",
  "app.projects.builder.file.delete", "app.projects.builder.command.run",
  "app.projects.builder.checkpoint.create", "app.projects.builder.verification.run",
  "app.projects.builder.verification.show", "app.projects.builder.sentinel.record",
  "app.projects.builder.repositories.list", "app.projects.builder.repository.bind",
  "app.projects.builder.repository.checkout", "app.projects.builder.delivery.create",
] as const);
export const SELF_IMPROVEMENT_READ_TOOLS = Object.freeze([
  "app.projects.builder.show", "app.projects.builder.tree", "app.projects.builder.search",
  "app.projects.builder.file.read", "app.projects.builder.verification.show",
  "app.projects.builder.framework-doc.read",
] as const);
const permitted = new Set<string>(SELF_IMPROVEMENT_BUILDER_TOOLS);
const reads = new Set<string>(SELF_IMPROVEMENT_READ_TOOLS);
const standingApproval = new Set([
  "app.projects.builder.create", "app.projects.builder.repository.checkout",
  "app.projects.builder.delivery.create",
]);

/** Ephemeral server authority. Never accepted in API/tool input or serialized. */
export type SelfImprovementExecutionAuthority = Readonly<{
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  repositoryId: string;
  cycleId: string;
  policySha256: string;
  /** Optional reduction copied from the cycle's immutable owner-admitted policy. */
  maxEngineeringTokensPerRun?: number;
  expiresAt: string;
  readOnly: boolean;
  /** Exact durable workspace for model tools; absent during supervised setup. */
  sessionId?: string;
  allowedToolIds?: readonly string[];
  /** Ephemeral Atlas inspection contract; never accepted from callers or resumed. */
  inspectionCompletion?: InspectionCompletionGate;
  forgePlan?: ForgePlan;
  forgeHandoff?: ForgeHandoff;
  reviewManifest?: ReviewManifest;
  reviewCompletion?: ReviewCompletionGate;
  reviewReceipt?: ReviewCompletionReceipt;
  writePaths?: readonly string[];
  /** Revalidates the durable lease, pause state, generation and daily reservation. */
  assertCurrent: () => Promise<void>;
}>;
const execution = new AsyncLocalStorage<SelfImprovementExecutionAuthority>();

export function withSelfImprovementExecution<T>(authority: SelfImprovementExecutionAuthority, work: () => Promise<T>): Promise<T> {
  return execution.run(Object.freeze({ ...authority }), work);
}

/** A server-owned coding allowance; never a request parameter or global default. */
export async function selfImprovementModelAllowance(input: { context?: SecurityContext; executionScope?: ExecutionScope }) {
  const authority = execution.getStore();
  if (!authority) return undefined;
  if (!input.context || !input.executionScope || input.context.tenantId !== authority.tenantId || input.context.actorId !== authority.ownerActorId ||
      input.executionScope.tenantId !== authority.tenantId || input.executionScope.initiatingActorId !== authority.ownerActorId ||
      input.executionScope.projectId !== authority.projectId || Date.now() >= Date.parse(authority.expiresAt)) throw new Error("Self-improvement model request is outside its live owner scope.");
  await authority.assertCurrent();
  if (authority.sessionId !== undefined && !/^app_build_[a-f0-9]{48}$/.test(authority.sessionId)) throw new Error("The bound improvement workspace ID is invalid.");
  if (authority.inspectionCompletion && (!authority.readOnly || authority.inspectionCompletion.runId !== input.executionScope.correlationId)) throw new Error("Inspection completion is outside its original run.");
  if (authority.forgeHandoff && (authority.readOnly || !authority.forgePlan || authority.forgeHandoff.runId !== input.executionScope.correlationId)) throw new Error("Forge handoff is outside its original run.");
  if (authority.reviewCompletion && (!authority.readOnly || !authority.reviewManifest || authority.reviewCompletion.runId !== input.executionScope.correlationId ||
      (["tenantId", "ownerActorId", "projectId", "cycleId", "policySha256", "sessionId"] as const).some(key => authority.reviewManifest![key] !== authority[key]))) throw new Error("Review completion is outside its original run and owner scope.");
  // Only an exact, live engineering phase receives this preference. Setup,
  // ordinary calls and ambiguous combinations keep their existing defaults.
  const boundPhase = authority.sessionId && [authority.inspectionCompletion, authority.forgeHandoff, authority.reviewCompletion].filter(Boolean).length === 1;
  const reasoningEffort = boundPhase
    ? authority.reviewCompletion ? "high" as const : "medium" as const
    : undefined;
  return { inspectionCompletion: authority.inspectionCompletion, forgeHandoff: authority.forgeHandoff, reviewCompletion: authority.reviewCompletion, maxToolSteps: 16, maxOutputTokens: authority.readOnly ? 4_000 : 8_000,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(authority.sessionId ? { toolBinding: Object.freeze({ projectId: authority.projectId, sessionId: authority.sessionId,
      readOnly: authority.readOnly, allowedToolIds: authority.allowedToolIds || (authority.readOnly ? SELF_IMPROVEMENT_READ_TOOLS : SELF_IMPROVEMENT_BUILDER_TOOLS),
      assertCurrent: authority.assertCurrent }) } : {}) };

}

/** Only the supervised recorder receives this server-owned receipt; never a tool parameter. */
export async function selfImprovementSentinelAuthorization(input: { tenantId: string; ownerActorId: string; projectId: string }) {
  const authority = execution.getStore();
  if (!authority) return undefined;
  if (authority.readOnly || authority.tenantId !== input.tenantId || authority.ownerActorId !== input.ownerActorId || authority.projectId !== input.projectId ||
      !authority.reviewReceipt || Date.now() >= Date.parse(authority.expiresAt)) throw new Error("Self-improvement Sentinel recording requires its exact criterion receipt.");
  await authority.assertCurrent();
  return authority.reviewReceipt;
}

/** Every tool, including reads and dry runs, is fenced before ordinary policy. */
export async function inspectSelfImprovementToolAuthority(input: {
  toolId: string;
  input: Record<string, unknown>;
  context?: SecurityContext;
  executionScope?: ExecutionScope;
  forceApproval?: boolean;
}): Promise<{ cycleId: string; policySha256: string; expiresAt: string; approved: boolean } | undefined> {
  const authority = execution.getStore();
  if (!authority) return undefined;
  if (!input.context || !input.executionScope ||
      input.context.tenantId !== authority.tenantId || input.context.actorId !== authority.ownerActorId ||
      input.executionScope.tenantId !== authority.tenantId || input.executionScope.initiatingActorId !== authority.ownerActorId ||
      input.executionScope.projectId !== authority.projectId ||
      input.input.projectId !== authority.projectId ||
      (authority.sessionId !== undefined && input.input.sessionId !== undefined && input.input.sessionId !== authority.sessionId) || !permitted.has(input.toolId) ||
      (authority.allowedToolIds !== undefined && !authority.allowedToolIds.includes(input.toolId)) ||
      (authority.readOnly && !reads.has(input.toolId)) || Date.now() >= Date.parse(authority.expiresAt)) {
    throw new Error("Self-improvement tool is outside the active owner, project, capability or time boundary.");
  }
  if (input.toolId === "app.projects.builder.repository.bind" && input.input.repositoryId !== authority.repositoryId) {
    throw new Error("Self-improvement cannot select a different repository.");
  }
  if (input.toolId === "app.projects.builder.command.run" &&
      !["lint_focused", "test_focused", "typecheck_direct"].includes(String(input.input.command))) {
    throw new Error("Self-improvement uses focused checks and typecheck; broad scripts and preview execution require separate review.");
  }
  if (["app.projects.builder.file.update", "app.projects.builder.file.edit", "app.projects.builder.file.delete"].includes(input.toolId) &&
      (!authority.writePaths || !authority.writePaths.includes(String(input.input.path)))) {
    throw new Error("The file is outside Atlas's exact phase plan.");
  }
  if (input.toolId === "app.projects.builder.delivery.create" && input.input.draft !== true) {
    throw new Error("Self-improvement delivers a draft for the independent release controller.");
  }
  await authority.assertCurrent();
  return { cycleId: authority.cycleId, policySha256: authority.policySha256, expiresAt: authority.expiresAt,
    approved: !input.forceApproval && !authority.readOnly && standingApproval.has(input.toolId) };
}

/** Internal bridge authority; never reconstructed from API input or a receipt ID. */
export async function requireSelfImprovementExecutionAuthority(input: { tenantId: string; ownerActorId: string; projectId: string }): Promise<SelfImprovementExecutionAuthority> {
  const authority = execution.getStore();
  if (!authority || authority.readOnly || authority.tenantId !== input.tenantId || authority.ownerActorId !== input.ownerActorId || authority.projectId !== input.projectId || Date.now() >= Date.parse(authority.expiresAt)) throw new Error("Native verification requires the live governed self-improvement execution authority.");
  await authority.assertCurrent();
  return authority;
}
