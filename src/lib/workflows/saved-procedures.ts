import { createHash } from "node:crypto";
import { z } from "zod";
import { listMemories } from "@/lib/memory/store";
import type { MemoryRecord } from "@/lib/memory/types";
import type { SupervisorKnownProcedure } from "@/lib/orchestration/supervisor";

export const SAVED_PROCEDURE_V1_TAG = "asael:saved-procedure:v1";

const canonicalIdSchema = z.string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);

const toolBindingSchema = z.object({
  toolId: canonicalIdSchema,
  input: z.record(z.string(), z.unknown()),
}).strict();

const savedProcedureContractSchema = z.object({
  schemaVersion: z.literal(1),
  id: canonicalIdSchema,
  aliases: z.array(z.string().trim().min(1).max(240)).min(1).max(24),
  toolBindings: z.array(toolBindingSchema).min(1).max(12),
}).strict();

const workflowProcedureSnapshotBodySchema = z.object({
  schemaVersion: z.literal(1),
  id: canonicalIdSchema,
  matchedAlias: z.string().trim().min(1).max(240),
  sourceMemoryId: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(240)).min(1).max(24),
  toolBindings: z.array(toolBindingSchema).min(1).max(12),
}).strict();

const workflowProcedureSnapshotSchema = workflowProcedureSnapshotBodySchema.extend({
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type SavedProcedureToolBinding = Readonly<{
  toolId: string;
  input: Readonly<Record<string, unknown>>;
}>;

export type SavedProcedure = Readonly<{
  id: string;
  aliases: readonly string[];
  requiredToolIds: readonly string[];
  toolBindings: readonly SavedProcedureToolBinding[];
  sourceMemoryId: string;
}>;

export type WorkflowProcedureSnapshot = Readonly<{
  schemaVersion: 1;
  id: string;
  matchedAlias: string;
  sourceMemoryId: string;
  aliases: readonly string[];
  toolBindings: readonly SavedProcedureToolBinding[];
  snapshotSha256: string;
}>;

export async function listSavedProcedures(input: {
  tenantId: string;
  actorId: string;
}): Promise<readonly SavedProcedure[]> {
  const tenantId = requiredScopeId(input.tenantId, "tenant");
  requiredScopeId(input.actorId, "actor");
  const records = await listMemories({
    tenantId,
    type: "procedure",
    limit: 128,
  });
  const procedures = records.flatMap((record) => {
    const parsed = parseSavedProcedureMemory(record, tenantId);
    return parsed ? [parsed] : [];
  }).sort((left, right) => left.id.localeCompare(right.id));
  const ids = procedures.map((procedure) => procedure.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Saved procedure IDs must be unique within a tenant.");
  }
  return Object.freeze(procedures);
}

export function toSupervisorKnownProcedures(
  procedures: readonly SavedProcedure[],
): readonly SupervisorKnownProcedure[] {
  return procedures.map((procedure) => Object.freeze({
    id: procedure.id,
    aliases: procedure.aliases,
    requiredToolIds: procedure.requiredToolIds,
  }));
}

export function buildWorkflowProcedureSnapshot(
  procedure: SavedProcedure,
  matchedAlias: string,
): WorkflowProcedureSnapshot {
  const body = workflowProcedureSnapshotBodySchema.parse({
    schemaVersion: 1,
    id: procedure.id,
    matchedAlias,
    sourceMemoryId: procedure.sourceMemoryId,
    aliases: procedure.aliases,
    toolBindings: procedure.toolBindings,
  });
  return freezeSnapshot({
    ...body,
    snapshotSha256: sha256(body),
  });
}

export function parseWorkflowProcedureSnapshot(
  value: unknown,
): WorkflowProcedureSnapshot | undefined {
  const parsed = workflowProcedureSnapshotSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { snapshotSha256, ...body } = parsed.data;
  if (sha256(body) !== snapshotSha256) return undefined;
  if (!body.aliases.includes(body.matchedAlias)) return undefined;
  return freezeSnapshot(parsed.data);
}

export function parseSavedProcedureContractV1(
  value: unknown,
  sourceMemoryId: string,
): SavedProcedure | undefined {
  const parsed = savedProcedureContractSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const aliases = unique(parsed.data.aliases.map(normalizeAlias));
  const toolBindings = parsed.data.toolBindings.map((binding) => Object.freeze({
    toolId: binding.toolId,
    input: Object.freeze(binding.input),
  }));
  if (
    aliases.length !== parsed.data.aliases.length ||
    new Set(toolBindings.map((binding) => binding.toolId)).size !== toolBindings.length ||
    Buffer.byteLength(JSON.stringify(toolBindings), "utf8") > 64_000
  ) return undefined;
  const boundedMemoryId = sourceMemoryId.trim();
  if (!boundedMemoryId || boundedMemoryId.length > 200) return undefined;
  return Object.freeze({
    id: parsed.data.id,
    aliases: Object.freeze(aliases),
    requiredToolIds: Object.freeze(toolBindings.map((binding) => binding.toolId).sort()),
    toolBindings: Object.freeze(toolBindings),
    sourceMemoryId: boundedMemoryId,
  });
}

function parseSavedProcedureMemory(
  record: MemoryRecord,
  tenantId: string,
): SavedProcedure | undefined {
  if (
    record.tenantId !== tenantId ||
    record.type !== "procedure" ||
    record.scope !== "workspace" ||
    !record.tags.includes(SAVED_PROCEDURE_V1_TAG) ||
    (record.assertedBy !== "user" && record.assertedBy !== "system")
  ) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(record.content);
  } catch {
    return undefined;
  }
  return parseSavedProcedureContractV1(value, record.id);
}

function freezeSnapshot(value: z.infer<typeof workflowProcedureSnapshotSchema>): WorkflowProcedureSnapshot {
  return Object.freeze({
    ...value,
    aliases: Object.freeze([...value.aliases]),
    toolBindings: Object.freeze(value.toolBindings.map((binding) => Object.freeze({
      toolId: binding.toolId,
      input: Object.freeze(binding.input),
    }))),
  });
}

function normalizeAlias(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function requiredScopeId(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error(`Saved procedure ${label} scope is required.`);
  }
  return normalized;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function sha256(value: unknown) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}
