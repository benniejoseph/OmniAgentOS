import { createHash } from "node:crypto";
import { z } from "zod";

export const WORKFLOW_DOMAIN_EVENT_SCHEMA_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const workflowDomainEventPayloadSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_DOMAIN_EVENT_SCHEMA_VERSION),
  eventType: z.string().trim().min(1).max(160),
  payloadSha256: sha256Schema,
  payloadFieldCount: z.number().int().min(0).max(10_000),
}).strict();

export function workflowDomainEventPayloadV1(
  eventType: string,
  payload: Record<string, unknown>,
) {
  return workflowDomainEventPayloadSchema.parse({
    schemaVersion: WORKFLOW_DOMAIN_EVENT_SCHEMA_VERSION,
    eventType: eventType.replace(/^workflow\./, "workflow."),
    payloadSha256: createHash("sha256")
      .update(canonicalJson(payload), "utf8")
      .digest("hex"),
    payloadFieldCount: Object.keys(payload).length,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}
