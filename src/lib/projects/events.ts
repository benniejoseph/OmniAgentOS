import { createHash } from "node:crypto";
import { z } from "zod";

export const PROJECT_EVENT_SCHEMA_VERSION = 1 as const;

const projectEventIdSchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const projectMutationEventPayloadSchema = z.object({
  schemaVersion: z.literal(PROJECT_EVENT_SCHEMA_VERSION),
  projectId: projectEventIdSchema,
  taskId: projectEventIdSchema.nullable(),
  operation: z.enum([
    "project_created",
    "project_updated",
    "project_task_created",
    "project_task_updated",
  ]),
  priorStatus: projectEventIdSchema.nullable(),
  status: projectEventIdSchema,
  changedFieldIds: z.array(projectEventIdSchema).max(32),
  mutationInputSha256: sha256Schema,
  idempotencyKeySha256: sha256Schema,
}).strict();

export type ProjectMutationEventPayload = z.infer<
  typeof projectMutationEventPayloadSchema
>;

export function projectMutationSha256(value: unknown) {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function projectMutationEventId(input: {
  tenantId: string;
  operation: ProjectMutationEventPayload["operation"];
  idempotencyKey: string;
}) {
  const digest = projectMutationSha256({
    tenantId: input.tenantId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
  });
  return `project_mutation_event_${digest}`;
}

export function projectIdForIdempotencyKey(
  tenantId: string,
  idempotencyKey: string,
) {
  return `project_${projectMutationSha256({ tenantId, idempotencyKey }).slice(0, 40)}`;
}

export function projectTaskIdForIdempotencyKey(
  tenantId: string,
  projectId: string,
  idempotencyKey: string,
) {
  return `project_task_${projectMutationSha256({
    tenantId,
    projectId,
    idempotencyKey,
  }).slice(0, 40)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}
