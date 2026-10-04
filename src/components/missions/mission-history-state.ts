import { z } from "zod";
import {
  canonicalStatusForMission,
  canonicalStatusForMissionAttempt,
  canonicalStatusForMissionTask,
} from "@/lib/status/canonical";
import { canonicalWorkItemSurfaceSchema } from "@/lib/workspaces/surface";

export const HISTORY_LIMITS = { missions: 50, tasks: 30, attempts: 100, artifacts: 50, events: 25 } as const;
const id = z.string().uuid();
const reference = z.string().min(1).max(240);
const timestamp = z.string().datetime({ offset: true });
const priority = z.enum(["low", "normal", "high", "urgent"]);
const lifecycle = { createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp.optional(), terminalAt: timestamp.optional() };
const statusProjection = z.object({ schemaVersion: z.literal(1), status: z.string(), domain: z.string(), basis: z.string(), source: z.string(), sourceStatus: z.string(), verificationState: z.string() });
const surface = canonicalWorkItemSurfaceSchema;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const summarySchema = z.object({
  id, title: z.string().min(1).max(240), objective: z.string().max(4_000),
  status: z.enum(["draft", "queued", "running", "waiting", "succeeded", "failed", "canceled", "archived"]),
  canonicalStatus: statusProjection, priority, source: z.string().min(1).max(80), ...lifecycle,
  detailAvailable: z.boolean(), manageable: z.boolean(), runnable: z.boolean(),
  workItemStatus: surface.shape.status, workItem: surface,
}).superRefine((value, context) => {
  const expected = canonicalStatusForMission(value.status);
  if (!same(value.canonicalStatus, expected) || !same(value.workItemStatus, value.workItem.status) ||
      value.workItem.status.sourceAuthority !== "legacy_mission" || value.workItem.status.sourceId !== value.id ||
      value.workItem.status.projectId !== `mission_project:${value.id}` || value.workItem.status.workItemId !== `mission_root:${value.id}` ||
      (!value.detailAvailable && (value.manageable || value.runnable))) {
    context.addIssue({ code: "custom", message: "Mission history identity or authority is inconsistent." });
  }
  if (Date.parse(value.createdAt) > Date.parse(value.updatedAt) ||
      (value.startedAt && (Date.parse(value.startedAt) < Date.parse(value.createdAt) || Date.parse(value.startedAt) > Date.parse(value.updatedAt))) ||
      (value.terminalAt && (Date.parse(value.terminalAt) < Date.parse(value.createdAt) || Date.parse(value.terminalAt) > Date.parse(value.updatedAt))) ||
      (value.startedAt && value.terminalAt && Date.parse(value.startedAt) > Date.parse(value.terminalAt)) ||
      (value.status === "running" && !value.startedAt) ||
      (["draft", "queued"].includes(value.status) && value.startedAt) ||
      (["succeeded", "failed", "canceled", "archived"].includes(value.status) !== Boolean(value.terminalAt))) {
    context.addIssue({ code: "custom", message: "Mission history dates are inconsistent." });
  }
});
const taskSchema = z.object({
  id, missionId: id, parentTaskId: id.optional(), title: z.string().min(1).max(240),
  instructions: z.string().max(20_000), definitionOfDone: z.string().max(20_000),
  status: z.enum(["triage", "pending", "running", "blocked", "review", "succeeded", "failed", "canceled"]),
  canonicalStatus: statusProjection, priority, position: z.number().finite(), dependencyIds: z.array(reference).max(200),
  metadata: z.record(z.string(), z.unknown()), ...lifecycle, workItemStatus: surface.shape.status, workItem: surface,
  execution: z.object({ schemaVersion: z.literal(1), authority: z.literal("governed_execution_v1"), attemptId: id,
    executorType: z.string(), agentRunId: reference.optional(), workflowRunId: reference.optional(),
    sourceStatus: z.string(), canonicalStatus: statusProjection, startedAt: timestamp.optional(), terminalAt: timestamp.optional(), updatedAt: timestamp }).optional(),
});
const attemptSchema = z.object({ id, missionId: id, taskId: id, executorType: z.string().max(160),
  status: z.enum(["queued", "running", "waiting", "succeeded", "failed", "canceled"]), canonicalStatus: statusProjection,
  agentRunId: reference.optional(), workflowRunId: reference.optional(), error: z.string().max(20_000).optional(), ...lifecycle });
const artifactSchema = z.object({ id, missionId: id, taskId: id.optional(), attemptId: id.optional(),
  kind: z.string().max(160), title: z.string().max(4_000), uri: z.string().max(8_000).optional(),
  mimeType: z.string().max(240).optional(), data: z.record(z.string(), z.unknown()).optional(), createdAt: timestamp, updatedAt: timestamp });
export type HistoryMission = z.infer<typeof summarySchema>;
export type HistoryDetail = { mission: HistoryMission; tasks: z.infer<typeof taskSchema>[]; attempts: z.infer<typeof attemptSchema>[]; artifacts: z.infer<typeof artifactSchema>[] };
export type HistoryEvent = { seq: number; type: string; at: string };
export type HistoryEvents = { cursor: number; changed: boolean; mission: { status: string; updatedAt: string }; events: HistoryEvent[] };

function unique(items: { id: string }[]) {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("History contains duplicate identities.");
}
export function parseHistoryList(value: unknown): HistoryMission[] {
  const result = z.object({ requestReadContracts: z.object({ missions: z.literal("readable_v1") }), missions: z.array(summarySchema).max(HISTORY_LIMITS.missions) }).parse(value);
  unique(result.missions);
  return result.missions;
}
export function parseHistorySummary(value: unknown, expectedId: string): HistoryMission {
  const result = z.object({ requestReadContracts: z.object({ missionSummary: z.literal("readable_v1") }), mission: summarySchema }).parse(value);
  if (result.mission.id !== expectedId) throw new Error("History returned a different mission.");
  return result.mission;
}
export function parseHistoryDetail(value: unknown, expectedId: string): HistoryDetail {
  const result = z.object({ mission: summarySchema, tasks: z.array(taskSchema).max(HISTORY_LIMITS.tasks),
    attempts: z.array(attemptSchema).max(HISTORY_LIMITS.attempts), artifacts: z.array(artifactSchema).max(HISTORY_LIMITS.artifacts) }).parse(value);
  if (result.mission.id !== expectedId || !result.mission.detailAvailable) throw new Error("Exact mission detail was not confirmed.");
  for (const items of [result.tasks, result.attempts, result.artifacts]) {
    unique(items);
    if (items.some((item) => item.missionId !== expectedId)) throw new Error("History contains evidence for another mission.");
  }
  for (const task of result.tasks) {
    if (!same(task.canonicalStatus, canonicalStatusForMissionTask(task.status)) || !same(task.workItemStatus, task.workItem.status) ||
        task.workItem.status.sourceAuthority !== "legacy_mission_task" || task.workItem.status.sourceId !== task.id ||
        task.workItem.status.workItemId !== task.id || task.workItem.status.projectId !== `mission_project:${expectedId}`) {
      throw new Error("Task history identity or status is inconsistent.");
    }
  }
  if (result.attempts.some((item) => !same(item.canonicalStatus, canonicalStatusForMissionAttempt(item.status)))) throw new Error("Attempt status is inconsistent.");
  return result;
}
export function parseHistoryEvents(value: unknown, afterSeq: number): HistoryEvents {
  const result = z.object({ cursor: z.number().int().nonnegative(), changed: z.boolean(),
    mission: z.object({ status: z.enum(["draft", "queued", "running", "waiting", "succeeded", "failed", "canceled", "archived"]), updatedAt: timestamp }),
    events: z.array(z.object({ seq: z.number().int().positive(), type: z.string().min(1).max(240), at: timestamp })).max(HISTORY_LIMITS.events),
  }).parse(value);
  if (result.changed !== Boolean(result.events.length) || result.cursor < afterSeq ||
      result.cursor > (result.events.at(-1)?.seq ?? afterSeq) ||
      (result.cursor !== afterSeq && !result.events.some((event) => event.seq === result.cursor)) ||
      result.events.some((event, index) => event.seq <= (result.events[index - 1]?.seq ?? afterSeq))) throw new Error("Event history cursor is inconsistent.");
  return result;
}
export function historyId(value: string | undefined) { return value && id.safeParse(value).success ? value : undefined; }
export function historyReturnTo(value: string | null) {
  if (!value || !/^\/app\/(?:projects|results|activity)(?:\?|$)/.test(value) || /[\\\r\n]/.test(value)) return "/app/projects?view=execution";
  return value;
}
export function historyHref(missionId: string | undefined, query: string) {
  const params = new URLSearchParams(query);
  params.set("legacy", "1");
  return `${missionId ? `/app/missions/${encodeURIComponent(missionId)}` : "/app/missions"}?${params}`;
}
export function historyEvidenceHref(value: string | undefined) {
  if (!value || /[\u0000-\u0020\\]/.test(value)) return undefined;
  if (/^\/app\//.test(value) || /^\/api\//.test(value)) return value;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export function historyLiteral(value: unknown) {
  const rendered = JSON.stringify(value, null, 2);
  return rendered === undefined ? "No public evidence fields were returned." : rendered.length <= 262_144 ? rendered : "The public evidence exceeds the display limit. Its identity and source reference remain available.";
}

/** Each mounted resource owns one cancellable request. A replacement instance
 * cannot accept a previous A response after A → B → A navigation. */
export class HistoryReadGate {
  private live = false;
  private epoch = 0;
  private controller?: AbortController;
  activate() { this.live = true; }
  cancel() { this.epoch++; this.controller?.abort(); this.controller = undefined; }
  dispose() { this.live = false; this.cancel(); }
  begin() {
    if (!this.live) return undefined;
    this.cancel();
    const epoch = this.epoch;
    const controller = new AbortController();
    this.controller = controller;
    return { signal: controller.signal, current: () => this.live && this.epoch === epoch && !controller.signal.aborted };
  }
}
