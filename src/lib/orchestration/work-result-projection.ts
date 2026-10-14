import { createHash } from "node:crypto";
import { z } from "zod";
import { projectTaskDueDateSchema, projectTaskDueTimeZoneSchema, projectTaskHumanOwnerSchema } from "@/lib/projects/task-commitments";
import { CANONICAL_STATUSES } from "@/lib/status/canonical";
import { canonicalWorkItemV1Schema } from "@/lib/workspaces/contracts";
import { canonicalWorkItemSurfaceSchema } from "@/lib/workspaces/surface";

const TOOL_IDS = ["app.work_items.show", "app.work_items.create", "app.work_items.update"] as const;
const identity = z.string().min(1).max(240);
const instant = z.string().datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const dependency = z.discriminatedUnion("state", [
  z.object({ id: identity, state: z.literal("available"), canonicalStatus: z.enum(CANONICAL_STATUSES), sourceStatus: z.string().min(1).max(160) }).strict(),
  z.object({ id: identity, state: z.enum(["unavailable", "not_read"]) }).strict(),
]);
const dependencyRead = z.discriminatedUnion("state", [
  dependency.options[0].extend({ projectionSha256: digest, updatedAt: instant }),
  z.object({ id: identity, state: z.literal("unavailable") }).strict(),
]);
const readResult = z.object({ workItem: canonicalWorkItemV1Schema, dependencies: z.array(dependencyRead).max(128),
  projectionSha256: digest, revisionSha256: digest, checkedAt: instant });
const savedTask = z.object({
  id: identity, tenantId: identity, projectId: identity, title: z.string().min(1).max(240), detail: z.string().max(1_000),
  status: z.enum(["open", "doing", "done"]), humanOwner: projectTaskHumanOwnerSchema.nullish(),
  dueDate: projectTaskDueDateSchema.nullish(), dueAt: instant.nullish(), dueTimeZone: projectTaskDueTimeZoneSchema.nullish(),
  dependsOn: z.array(identity).max(128), updatedAt: instant,
  workItem: canonicalWorkItemSurfaceSchema,
}).superRefine((task, context) => {
  const status = task.workItem.status;
  if (status.workItemId !== task.id || status.projectId !== task.projectId || status.sourceId !== task.id ||
      status.sourceAuthority !== "legacy_project_task" || (task.dueDate && task.dueAt) || (task.dueTimeZone && !task.dueDate) ||
      new Set(task.dependsOn).size !== task.dependsOn.length || task.dependsOn.includes(task.id)) {
    context.addIssue({ code: "custom", message: "Saved task identity or commitment fields are inconsistent." });
  }
});

/** A model-only view, never a replacement for the governed result or canonical record. */
export const workResultProjectionSchema = z.object({
  projection: z.literal("work_item_result"), schemaVersion: z.literal(1), toolId: z.enum(TOOL_IDS),
  resultKind: z.enum(["current_read", "mutation_response"]),
  identity: z.object({ tenantId: identity, workspaceId: identity.nullable(), projectId: identity, workItemId: identity }).strict(),
  title: z.string().min(1).max(240), canonicalStatus: z.enum(CANONICAL_STATUSES), sourceStatus: z.string().min(1).max(160),
  humanOwner: projectTaskHumanOwnerSchema.nullable(),
  deadline: z.object({ precision: z.enum(["none", "date", "instant"]), dueDate: projectTaskDueDateSchema.nullable(), dueAt: instant.nullable(), timeZone: z.string().min(1).max(80).nullable() }).strict(),
  dependencies: z.object({ totalCount: count.max(128), omittedCount: count.max(128), items: z.array(dependency).max(128) }).strict(),
  assignedAgents: z.object({ totalCount: count.max(32), omittedCount: count.max(32), ids: z.array(identity).max(32) }).strict(),
  updatedAt: instant, checkedAt: instant.nullable(),
  additionalFields: z.record(z.string().min(1).max(120), z.unknown()),
  omittedFields: z.array(z.string().min(1).max(120)).max(128),
  detail: z.object({ totalCharacters: count.max(4_000), sha256: digest, includedCharacters: count.max(4_000), truncated: z.boolean(), text: z.string().max(4_000) }).strict(),
}).strict().superRefine((value, context) => {
  const date = value.deadline;
  if (value.resultKind !== (value.toolId === "app.work_items.show" ? "current_read" : "mutation_response") ||
      (value.resultKind === "current_read") !== (value.checkedAt !== null) ||
      date.precision !== (date.dueDate !== null ? "date" : date.dueAt !== null ? "instant" : "none") ||
      (date.dueDate !== null && date.dueAt !== null) ||
      value.dependencies.totalCount !== value.dependencies.items.length + value.dependencies.omittedCount ||
      new Set(value.dependencies.items.map((item) => item.id)).size !== value.dependencies.items.length ||
      value.dependencies.items.some((item) => item.id === value.identity.workItemId || (value.resultKind === "current_read" ? item.state === "not_read" : item.state !== "not_read")) ||
      value.assignedAgents.totalCount !== value.assignedAgents.ids.length + value.assignedAgents.omittedCount ||
      new Set(value.assignedAgents.ids).size !== value.assignedAgents.ids.length ||
      new Set(value.omittedFields).size !== value.omittedFields.length || value.omittedFields.some((path) => path in value.additionalFields) ||
      value.detail.includedCharacters !== value.detail.text.length || value.detail.includedCharacters > value.detail.totalCharacters ||
      value.detail.truncated !== (value.detail.includedCharacters < value.detail.totalCharacters) ||
      (!value.detail.truncated && value.detail.sha256 !== textDigest(value.detail.text))) {
    context.addIssue({ code: "custom", message: "Work result coverage is inconsistent." });
  }
});
export type WorkResultProjection = z.infer<typeof workResultProjectionSchema>;
export const WORK_RESULT_CHARACTERS = 6_000;

/** Reserve exact field values before prose within the existing 8k tool envelope. */
export function projectWorkToolResult(toolId: string, result: unknown): unknown {
  try { return workProjection(toolId, result, true); } catch { return result; }
}

function workProjection(toolId: string, result: unknown, compact: boolean): unknown {
  if (!TOOL_IDS.includes(toolId as typeof TOOL_IDS[number])) return result;
  const input = record(result);
  const receipt = record(input?.serviceReceipt);
  if (!input || (receipt?.operation !== undefined && receipt.operation !== toolId)) return result;
  let value: WorkResultProjection;
  if (toolId === "app.work_items.show") {
    const parsed = readResult.safeParse(input);
    if (!parsed.success) return result;
    const { workItem: item, dependencies, checkedAt } = parsed.data;
    if (JSON.stringify(dependencies.map((item) => item.id)) !== JSON.stringify(item.dependencyWorkItemIds)) return result;
    value = {
      projection: "work_item_result", schemaVersion: 1, toolId, resultKind: "current_read",
      identity: { tenantId: item.tenantId, workspaceId: item.workspaceId, projectId: item.projectId, workItemId: item.workItemId },
      title: item.title, canonicalStatus: item.canonicalStatus, sourceStatus: item.sourceStatus, humanOwner: item.humanOwner ?? null,
      deadline: deadline(item.schedule.dueDate, item.schedule.dueAt, item.schedule.timeZone),
      dependencies: { totalCount: dependencies.length, omittedCount: 0, items: dependencies.map((item) => item.state === "available"
        ? { id: item.id, state: item.state, canonicalStatus: item.canonicalStatus, sourceStatus: item.sourceStatus }
        : { id: item.id, state: item.state }) },
      assignedAgents: { totalCount: item.assignedAgents.length, omittedCount: 0, ids: item.assignedAgents.map((agent) => agent.agentId) },
      updatedAt: item.updatedAt, checkedAt, detail: detail(record(input.workItem)!.detail as string),
      additionalFields: remainingFields(input, item, ["tenantId", "workspaceId", "projectId", "workItemId", "title", "detail", "canonicalStatus", "sourceStatus", "humanOwner", "dependencyWorkItemIds", "updatedAt"]), omittedFields: [],
    };
  } else {
    const parsed = savedTask.safeParse(input.workItem);
    if (!parsed.success) return result;
    const item = parsed.data, surface = item.workItem;
    value = {
      projection: "work_item_result", schemaVersion: 1, toolId: toolId as "app.work_items.create" | "app.work_items.update", resultKind: "mutation_response",
      identity: { tenantId: item.tenantId, workspaceId: surface.status.workspaceId, projectId: item.projectId, workItemId: item.id },
      title: item.title, canonicalStatus: surface.status.status, sourceStatus: surface.status.sourceStatus, humanOwner: item.humanOwner ?? null,
      deadline: deadline(item.dueDate, item.dueAt, item.dueTimeZone),
      dependencies: { totalCount: item.dependsOn.length, omittedCount: 0, items: item.dependsOn.map((id) => ({ id, state: "not_read" })) },
      assignedAgents: { totalCount: surface.assignment.agents.length, omittedCount: 0, ids: surface.assignment.agents.map((agent) => agent.agentId) },
      updatedAt: item.updatedAt, checkedAt: null, detail: detail(item.detail),
      additionalFields: remainingFields(input, record(input.workItem)!, ["id", "tenantId", "projectId", "title", "detail", "status", "humanOwner", "dueDate", "dueAt", "dueTimeZone", "dependsOn", "updatedAt"]), omittedFields: [],
    };
  }
  if (!compact) {
    const parsed = workResultProjectionSchema.safeParse(value);
    return parsed.success ? parsed.data : result;
  }
  // The hash compares observed text for equality; it does not verify its claims.
  const originalDetail = value.detail.text;
  value.detail = { ...value.detail, text: "", includedCharacters: 0, truncated: originalDetail.length > 0 };
  const size = () => JSON.stringify(value).length;
  // Keep the most compact supplemental fields first. An omitted field is
  // explicitly outside delivered coverage; repeating show is not pagination.
  const additional = Object.entries(value.additionalFields).sort((left, right) => JSON.stringify(right[1]).length - JSON.stringify(left[1]).length || left[0].localeCompare(right[0]));
  for (const [path] of additional) {
    if (size() <= WORK_RESULT_CHARACTERS) break;
    delete value.additionalFields[path];
    value.omittedFields.push(path);
  }
  while (size() > WORK_RESULT_CHARACTERS && value.assignedAgents.ids.length) { value.assignedAgents.ids.pop(); value.assignedAgents.omittedCount += 1; }
  while (size() > WORK_RESULT_CHARACTERS && value.dependencies.items.length) { value.dependencies.items.pop(); value.dependencies.omittedCount += 1; }
  if (size() > WORK_RESULT_CHARACTERS) return result;
  let low = 0, high = originalDetail.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    value.detail = { ...value.detail, text: originalDetail.slice(0, middle), includedCharacters: middle, truncated: middle < originalDetail.length };
    if (size() <= WORK_RESULT_CHARACTERS) low = middle; else high = middle - 1;
  }
  value.detail = { ...value.detail, text: originalDetail.slice(0, low), includedCharacters: low, truncated: low < originalDetail.length };
  const parsed = workResultProjectionSchema.safeParse(value);
  return parsed.success ? parsed.data : result;
}

/** Only parse the same bounded, untrusted envelope already given to the writer. */
export function observedWorkResult(observation: {
  toolId: string; executionId: string; status: string; dryRun: boolean; approvalRequired: boolean; modelOutput: string;
}): (WorkResultProjection & { writerResultShape: "full_result" | "bounded_projection" }) | undefined {
  if (!TOOL_IDS.includes(observation.toolId as typeof TOOL_IDS[number]) || observation.status !== "executed" || observation.dryRun || observation.modelOutput.length > 8_000) return;
  let envelope;
  try { envelope = JSON.parse(observation.modelOutput); } catch { return; }
  const data = record(envelope?.data);
  if (envelope?.provenance !== "tool_result" || envelope?.trust !== "untrusted_data" || data?.executionId !== observation.executionId ||
      data?.status !== "executed" || data.dryRun !== false || data.approvalRequired !== observation.approvalRequired) return;
  const bounded = record(data.result)?.projection === "work_item_result";
  try {
    const parsed = workResultProjectionSchema.safeParse(bounded ? data.result : workProjection(observation.toolId, data.result, false));
    if (!parsed.success || parsed.data.toolId !== observation.toolId || (bounded && JSON.stringify(parsed.data).length > WORK_RESULT_CHARACTERS)) return;
    return { ...parsed.data, writerResultShape: bounded ? "bounded_projection" : "full_result" };
  } catch { return; }
}

function deadline(dueDate?: string | null, dueAt?: string | null, timeZone?: string | null): WorkResultProjection["deadline"] {
  return { precision: dueDate ? "date" : dueAt ? "instant" : "none", dueDate: dueDate ?? null, dueAt: dueAt ?? null, timeZone: timeZone ?? null };
}
function detail(text: string): WorkResultProjection["detail"] {
  return { totalCharacters: text.length, sha256: textDigest(text), includedCharacters: text.length, truncated: false, text };
}
function textDigest(text: string) { return createHash("sha256").update(text).digest("hex"); }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function remainingFields(input: Record<string, unknown>, item: Record<string, unknown>, represented: readonly string[]) {
  return Object.fromEntries([
    ...Object.entries(item).filter(([key, value]) => !represented.includes(key) && value !== undefined).map(([key, value]) => [`workItem.${key}`, value]),
    ...Object.entries(input).filter(([key, value]) => key !== "workItem" && key !== "checkedAt" && value !== undefined),
  ]);
}
