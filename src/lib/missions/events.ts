import { createHash } from "node:crypto";
import { z } from "zod";

export const MISSION_DOMAIN_EVENT_SCHEMA_VERSION = 1 as const;

export const missionDomainEventPayloadSchema = z.object({
  schemaVersion: z.literal(MISSION_DOMAIN_EVENT_SCHEMA_VERSION),
  eventType: z.string().trim().min(1).max(120),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  payloadFieldCount: z.number().int().min(0).max(10_000),
}).strict();

export function missionDomainEventPayloadV1(
  eventType: string,
  payload: Record<string, unknown>,
) {
  return missionDomainEventPayloadSchema.parse({
    schemaVersion: MISSION_DOMAIN_EVENT_SCHEMA_VERSION,
    eventType,
    payloadSha256: createHash("sha256")
      .update(canonicalJson(payload), "utf8")
      .digest("hex"),
    payloadFieldCount: Object.keys(payload).length,
  });
}

export function missionLifecycleEventId(input: {
  tenantId: string;
  missionId: string;
  eventType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}) {
  const digest = createHash("sha256")
    .update(canonicalJson(input), "utf8")
    .digest("hex");
  return `mission_mutation_event_${digest}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}
