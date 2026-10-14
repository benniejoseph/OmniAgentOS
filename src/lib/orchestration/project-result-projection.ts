import { createHash } from "node:crypto";
import { z } from "zod";
import { appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { projectTaskDueDateSchema, projectTaskDueTimeZoneSchema, projectTaskHumanOwnerSchema } from "@/lib/projects/task-commitments";
import { CANONICAL_STATUSES } from "@/lib/status/canonical";
import type { ReviewToolObservation } from "./review-evidence";

const identity = z.string().min(1).max(240);
const instant = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().max(200);
const cursor = z.string().min(1).max(2_048);
const project = z.object({
  id: identity, tenantId: identity, actorId: identity, title: z.string().min(1).max(180), objective: z.string().min(1).max(2_000),
  status: z.enum(["draft", "active", "completed", "archived"]),
  executionStatus: z.enum(["idle", "running", "paused", "waiting_approval", "completed", "failed"]),
  targetDate: instant.nullish(),
});
const task = z.object({
  id: identity, title: z.string().min(1).max(240), status: z.enum(["open", "doing", "done"]),
  priority: z.enum(["low", "medium", "high"]), dueAt: instant.nullable(),
  humanOwner: projectTaskHumanOwnerSchema.optional(), dueDate: projectTaskDueDateSchema.optional(), dueTimeZone: projectTaskDueTimeZoneSchema.nullish(),
  dependencyCount: count, canonicalStatus: z.enum(CANONICAL_STATUSES), sourceStatus: z.string().min(1).max(160),
  readLocator: z.object({ workspaceId: identity, projectId: identity, workItemId: identity }).nullable(),
}).superRefine((value, context) => {
  if ((value.dueDate && value.dueAt) || (value.dueTimeZone && !value.dueDate)) context.addIssue({ code: "custom", message: "Inconsistent inventory deadline." });
});
const summary = z.object({
  version: z.literal("project-commitment-summary:1"), readAt: instant,
  consistency: z.literal("current_read_not_snapshot"), coverage: z.enum(["complete", "partial"]),
  commitmentCount: count, openCount: count, closedUnverifiedCount: count, verifiedSuccessCount: count,
  failedCount: count, canceledCount: count, blockedCount: count, unassignedOpenCount: count,
  undatedOpenCount: count, dependencyCount: count, lastChangedAt: instant.nullable(), narrativeAssessment: z.literal("not_compared"),
});
const page = z.object({
  returnedCount: count, hasMore: z.boolean(), nextCursor: cursor.nullable(), requestedCursor: cursor.nullable().optional(),
  startsAtBeginning: z.boolean(), consistency: z.literal("current_read_not_snapshot"),
});
const inventory = z.object({
  project: project.extend({ tasks: z.array(task).max(200), commitmentSummary: summary }), taskPage: page,
  omissions: z.object({ taskDetails: z.literal(true), artifacts: z.literal(true), objective: z.boolean() }),
});
type Inventory = z.infer<typeof inventory>;

/** Opaque continuation tokens are equality pins, never reviewer tool inputs. */
export function projectPageReviewReceipt(value: Inventory["taskPage"]) {
  const pin = (value: string | null | undefined) => typeof value === "string"
    ? createHash("sha256").update(value).digest("hex") : value;
  return { ...value, cursorRepresentation: "sha256", nextCursor: pin(value.nextCursor), requestedCursor: pin(value.requestedCursor) };
}

export type ObservedProjectResult = {
  invalid: false;
  projection: "project_result";
  resultKind: "current_read" | "mutation_response";
  identity: { tenantId: string; ownerActorId: string; projectId: string };
  // Each governed call has its own causation-bound authority pin. It is an
  // observation receipt, not a stable project identity or renewed authority.
  authoritySha256: string;
  title: string; status: string; executionStatus: string; targetDate: string | null;
  objective: { text: string; sha256: string; writerIncludedCharacters: number; writerCoverage: "complete" | "excerpt" };
  inventory: Inventory | null;
  additionalFields: Record<string, unknown>;
};

/** A review-only view of the exact bounded envelope supplied to the writer. */
export function observedProjectResult(observation: ReviewToolObservation): ObservedProjectResult | { invalid: true } | undefined {
  if (!["app.projects.show", "app.projects.update", "app.projects.create"].includes(observation.toolId) || observation.status !== "executed" || observation.dryRun) return;
  const invalid = { invalid: true as const };
  if (observation.modelOutput.length > 8_000) return invalid;
  try {
    const envelope = JSON.parse(observation.modelOutput);
    const data = record(envelope?.data), result = record(data?.result);
    if (envelope?.provenance !== "tool_result" || envelope?.trust !== "untrusted_data" || data?.executionId !== observation.executionId ||
        data?.status !== "executed" || data.dryRun !== false || data.approvalRequired !== observation.approvalRequired || !result) return invalid;
    const receipt = appServiceReceiptSchema.safeParse(result.serviceReceipt);
    if (!receipt.success || receipt.data.operation !== observation.toolId || receipt.data.accessMode !== (observation.toolId === "app.projects.show" ? "read" : "mutation")) return invalid;
    // A null project is a real scoped miss, not evidence of an empty project.
    if (result.project === null) return;
    const parsed = project.safeParse(result.project);
    if (!parsed.success) return invalid;
    const read = observation.toolId === "app.projects.show" ? inventory.safeParse(result) : null;
    if (read && (!read.success || !validInventory(read.data) || read.data.project.commitmentSummary.readAt !== receipt.data.occurredAt ||
        receipt.data.resourceCount !== 1 + read.data.taskPage.returnedCount)) return invalid;
    const value = parsed.data, contents = read?.success ? read.data : null;
    const objective = value.objective;
    const rawProject = record(result.project)!;
    // Keep the original inventory/summary/page fields in the low-priority
    // supplemental excerpt as well, so future fields are not silently erased
    // when the narrow typed projection ignores them.
    const projectedFields = ["id", "tenantId", "actorId", "title", "objective", "status", "executionStatus", "targetDate"];
    return {
      invalid: false, projection: "project_result", resultKind: contents ? "current_read" : "mutation_response",
      identity: { tenantId: value.tenantId, ownerActorId: value.actorId, projectId: value.id }, authoritySha256: receipt.data.authoritySha256,
      title: value.title, status: value.status, executionStatus: value.executionStatus, targetDate: value.targetDate ?? null,
      objective: { text: objective, sha256: createHash("sha256").update(objective).digest("hex"), writerIncludedCharacters: objective.length,
        writerCoverage: contents?.omissions.objective ? "excerpt" : "complete" },
      inventory: contents,
      additionalFields: Object.fromEntries([
        ...Object.entries(rawProject).filter(([key]) => !projectedFields.includes(key)).map(([key, value]) => [`project.${key}`, value]),
        ...Object.entries(result).filter(([key]) => key !== "project"),
      ]),
    };
  } catch { return invalid; }
}

function validInventory({ project: { tasks, commitmentSummary: value }, taskPage }: Inventory) {
  if (taskPage.returnedCount !== tasks.length || new Set(tasks.map(task => task.id)).size !== tasks.length ||
      taskPage.hasMore !== (taskPage.nextCursor !== null) || (taskPage.hasMore && !tasks.length) ||
      (taskPage.requestedCursor !== undefined && taskPage.startsAtBeginning !== (taskPage.requestedCursor === null))) return false;
  const counts = { openCount: 0, closedUnverifiedCount: 0, verifiedSuccessCount: 0, failedCount: 0, canceledCount: 0,
    blockedCount: 0, unassignedOpenCount: 0, undatedOpenCount: 0, dependencyCount: 0 };
  for (const task of tasks) {
    const open = !["unverified", "succeeded", "failed", "canceled"].includes(task.canonicalStatus);
    if (open) {
      counts.openCount += 1;
      if (!task.humanOwner?.trim()) counts.unassignedOpenCount += 1;
      if (!task.dueAt && !task.dueDate) counts.undatedOpenCount += 1;
    }
    if (task.canonicalStatus === "unverified") counts.closedUnverifiedCount += 1;
    if (task.canonicalStatus === "succeeded") counts.verifiedSuccessCount += 1;
    if (task.canonicalStatus === "failed") counts.failedCount += 1;
    if (task.canonicalStatus === "canceled") counts.canceledCount += 1;
    if (task.canonicalStatus === "blocked") counts.blockedCount += 1;
    if (task.dependencyCount) counts.dependencyCount += 1;
  }
  return value.commitmentCount === tasks.length && Object.entries(counts).every(([key, count]) => value[key as keyof typeof counts] === count) &&
    value.coverage === (taskPage.startsAtBeginning && !taskPage.hasMore ? "complete" : "partial");
}

/** Validates delivery succession only; multiple current reads are not a snapshot. */
export function projectPageDelivery(projects: readonly (ReturnType<typeof observedProjectResult>)[]) {
  type Chain = { next: string | null; ids: Set<string>; observations: number[]; reasons: Set<string>; pages: Set<string> };
  const chains = new Map<string, Chain>();
  return projects.map((project, index) => {
    if (project?.invalid) { chains.clear(); return undefined; }
    if (!project) return undefined;
    const key = JSON.stringify(project.identity);
    if (!project.inventory) { chains.delete(key); return undefined; }
    const { taskPage, project: { tasks } } = project.inventory;
    let chain = chains.get(key);
    const pageKey = JSON.stringify(project.inventory);
    if (taskPage.startsAtBeginning || !chain) {
      chain = { next: null, ids: new Set(), observations: [], reasons: new Set(), pages: new Set() };
      if (!taskPage.startsAtBeginning) chain.reasons.add("missing_beginning");
      chains.set(key, chain);
    }
    if (!chain.pages.has(pageKey)) {
      if (chain.observations.length && (taskPage.requestedCursor === undefined || taskPage.requestedCursor !== chain.next || chain.next === null)) chain.reasons.add("noncontiguous_or_unknown_cursor_chain");
      for (const task of tasks) {
        if (chain.ids.has(task.id)) chain.reasons.add("repeated_task_identity");
        chain.ids.add(task.id);
      }
      chain.next = taskPage.nextCursor;
      chain.pages.add(pageKey);
    }
    chain.observations.push(index);
    const incompleteReasons = [...chain.reasons, ...(taskPage.hasMore ? ["missing_end"] : [])];
    return { consistency: "current_read_not_snapshot", pageChainReachedEnd: incompleteReasons.length === 0,
      observationIndexes: [...chain.observations], distinctTaskCount: chain.ids.size, incompleteReasons };
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
