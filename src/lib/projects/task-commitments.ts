import { z } from "zod";

/** A named person is commitment metadata, never an authentication principal. */
export const projectTaskHumanOwnerSchema = z.string().trim().min(1).max(160);
export const projectTaskDueDateSchema = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}, { message: "The deadline must be a real calendar date in YYYY-MM-DD format." });
export const projectTaskDueTimeZoneSchema = z.string().trim().min(1).max(80).refine((value) => {
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; }
  catch { return false; }
}, { message: "The deadline time zone must be a supported IANA time zone." });
export const projectTaskDependenciesSchema = z.array(z.string().trim().min(1).max(200)).max(20).refine(
  (ids) => new Set(ids).size === ids.length,
  { message: "Dependency identifiers must be unique." },
);
export const projectTaskCommitmentFields = {
  humanOwner: projectTaskHumanOwnerSchema.nullable().optional(),
  dueDate: projectTaskDueDateSchema.nullable().optional(),
  dueTimeZone: projectTaskDueTimeZoneSchema.nullable().optional(),
  dependsOn: projectTaskDependenciesSchema.optional(),
};
export type ProjectTaskCommitmentInput = {
  humanOwner?: string | null;
  dueDate?: string | null;
  dueTimeZone?: string | null;
  dependsOn?: string[];
};
type DeadlinePatch = Pick<ProjectTaskCommitmentInput, "dueDate" | "dueTimeZone"> & { dueAt?: string | null };
export function refineProjectTaskDeadlinePatch(value: DeadlinePatch, context: z.RefinementCtx) {
  if (value.dueAt && value.dueDate) context.addIssue({ code: "custom", path: ["dueDate"], message: "Choose a calendar date or an exact time, not both." });
  if (value.dueTimeZone && (value.dueDate === null || value.dueAt)) context.addIssue({ code: "custom", path: ["dueTimeZone"], message: "A deadline time zone belongs to a calendar-date deadline." });
}
const deadlinePatchSchema = z.object({
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  dueDate: projectTaskDueDateSchema.nullable().optional(),
  dueTimeZone: projectTaskDueTimeZoneSchema.nullable().optional(),
}).superRefine(refineProjectTaskDeadlinePatch);

/** A date carries no implied midnight, end-of-day clock time or guessed zone. */
export function applyProjectTaskDeadlinePatch(current: { dueAt?: string; dueDate?: string; dueTimeZone?: string }, raw: DeadlinePatch) {
  const patch = deadlinePatchSchema.parse(raw);
  let { dueAt, dueDate, dueTimeZone } = current;
  if (patch.dueAt !== undefined) {
    dueAt = patch.dueAt === null ? undefined : new Date(patch.dueAt).toISOString();
    if (patch.dueAt !== null) { dueDate = undefined; dueTimeZone = undefined; }
  }
  if (patch.dueDate !== undefined) {
    dueDate = patch.dueDate ?? undefined;
    if (patch.dueDate !== null) dueAt = undefined;
    if (patch.dueDate === null) dueTimeZone = undefined;
  }
  if (patch.dueTimeZone !== undefined) dueTimeZone = patch.dueTimeZone ?? undefined;
  if (dueTimeZone && !dueDate) throw new Error("A deadline time zone requires a calendar-date deadline.");
  return { dueAt, dueDate, dueTimeZone };
}

/** Validates the complete resulting graph; callers serialize writes per project. */
export function assertProjectTaskDependencyGraph(tasks: readonly { id: string; dependsOn: readonly string[] }[]) {
  if (tasks.length > 10_000) throw new Error("The project has too many tasks to validate dependencies safely.");
  const byId = new Map(tasks.map((task) => [task.id, task.dependsOn]));
  if (byId.size !== tasks.length) throw new Error("Task identifiers must be unique within the dependency graph.");
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) throw new Error("A task cannot depend on itself.");
      if (!byId.has(dependency)) throw new Error("Every dependency must be an existing task in this project.");
    }
  }
  // Kahn's algorithm avoids recursive stack limits for long project chains.
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn).size]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) for (const id of new Set(task.dependsOn)) {
    const next = dependents.get(id) || []; next.push(task.id); dependents.set(id, next);
  }
  const ready = tasks.filter((task) => !remaining.get(task.id)).map((task) => task.id);
  for (let index = 0; index < ready.length; index += 1) {
    for (const id of dependents.get(ready[index]) || []) {
      const count = remaining.get(id)! - 1; remaining.set(id, count);
      if (count === 0) ready.push(id);
    }
  }
  if (ready.length !== tasks.length) throw new Error("Task dependencies cannot contain a cycle.");
}
