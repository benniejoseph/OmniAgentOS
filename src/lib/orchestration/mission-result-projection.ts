import { z } from "zod";

const identifier = z.string().min(1).max(240);
const instant = z.string().datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.object({
  taskId: identifier,
  attemptId: identifier,
  executorType: z.enum(["workflow_run", "agent_run"]),
  attemptStatus: z.string().min(1).max(80),
  updatedAt: instant,
  read: z.discriminatedUnion("toolId", [
    z.object({ toolId: z.literal("app.workflows.show"), input: z.object({ workflowId: identifier }).strict() }).strict(),
    z.object({ toolId: z.literal("app.runs.show"), input: z.object({ runId: identifier }).strict() }).strict(),
  ]),
}).strict().refine(value => value.executorType === "workflow_run"
  ? value.read.toolId === "app.workflows.show"
  : value.read.toolId === "app.runs.show");
const inspection = z.object({
  schemaVersion: z.literal(1),
  rootExecution: z.literal("aggregate_milestone"),
  interpretation: z.string().min(1).max(1_000),
  coverage: z.object({
    attemptsRead: z.number().int().min(0).max(200),
    attemptReadLimit: z.number().int().min(1).max(200),
    linkedExecutionsOmitted: z.number().int().min(0).max(200),
    historyMayBeIncomplete: z.boolean(),
  }).strict(),
  linkedExecutions: z.array(reference).max(20),
}).strict().refine(value => value.coverage.attemptsRead <= value.coverage.attemptReadLimit &&
  value.linkedExecutions.length + value.coverage.linkedExecutionsOmitted <= value.coverage.attemptsRead);
const resultSchema = z.object({
  mission: z.object({
    id: identifier,
    title: z.string().min(1).max(240),
    status: z.string().min(1).max(80),
    updatedAt: instant,
  }),
  executionInspection: inspection,
  serviceReceipt: z.object({ operation: z.literal("missions.show"), receiptSha256: digest }).optional(),
});

export const MISSION_RESULT_CHARACTERS = 6_000;

/** Model-only continuation view. Omit whole references when necessary so
 * generic string compaction cannot turn execution IDs into unusable prefixes. */
export function projectMissionToolResult(toolId: string, result: unknown): unknown {
  if (toolId !== "mission.show") return result;
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success) return result;
  if (JSON.stringify(result).length <= MISSION_RESULT_CHARACTERS) return result;
  const value = parsed.data;
  const linkedExecutions = [...value.executionInspection.linkedExecutions];
  const originalReferenceCount = linkedExecutions.length;
  const projected = () => ({
    executionInspection: {
      ...value.executionInspection,
      coverage: {
        ...value.executionInspection.coverage,
        linkedExecutionsOmitted: value.executionInspection.coverage.linkedExecutionsOmitted +
          originalReferenceCount - linkedExecutions.length,
      },
      linkedExecutions,
    },
    mission: value.mission,
    projection: {
      kind: "mission_execution_summary",
      schemaVersion: 1,
      includedExecutions: linkedExecutions.length,
      fullMissionDetailIncluded: false,
      fullResultInExecutionReceipt: true,
      ...(value.serviceReceipt ? { serviceReceiptSha256: value.serviceReceipt.receiptSha256 } : {}),
    },
  });
  // Preserve source order; never promote one latest child to mission status.
  while (JSON.stringify(projected()).length > MISSION_RESULT_CHARACTERS && linkedExecutions.length) {
    linkedExecutions.pop();
  }
  const projection = projected();
  return JSON.stringify(projection).length <= MISSION_RESULT_CHARACTERS ? projection : result;
}
