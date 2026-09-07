import { z } from "zod";

import {
  a2aArtifactV1Schema,
  a2aMessageV1Schema,
  a2aTaskStatusV1Schema,
} from "@/lib/a2a/v1-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

const exchangePayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), message: a2aMessageV1Schema }).strict(),
  z.object({ type: z.literal("artifact"), artifact: a2aArtifactV1Schema }).strict(),
  z.object({ type: z.literal("status"), status: a2aTaskStatusV1Schema }).strict(),
]);

export const a2aExchangeV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal("p8.6-a2a-exchange:1"),
  exchangeId: idSchema,
  exchangeSha256: sha256Schema,
  tenantId: idSchema,
  ownerActorId: idSchema,
  peerId: idSchema,
  mappingId: idSchema,
  externalTaskId: idSchema,
  direction: z.enum(["inbound", "outbound"]),
  payload: exchangePayloadSchema,
  payloadSha256: sha256Schema,
  untrusted: z.literal(true),
  authorityImpact: z.literal("none"),
  createdAt: timestampSchema,
}).strict().superRefine((value, context) => {
  const { exchangeId, exchangeSha256, ...body } = value;
  if (
    value.payloadSha256 !== canonicalJsonSha256(value.payload) ||
    exchangeId !== `a2a-exchange:${exchangeSha256}` ||
    exchangeSha256 !== canonicalJsonSha256(body)
  ) {
    context.addIssue({
      code: "custom",
      path: ["exchangeSha256"],
      message: "A2A exchange integrity is invalid.",
    });
  }
});

export type A2AExchangeV1 = Readonly<z.infer<typeof a2aExchangeV1Schema>>;

export function buildA2AExchangeV1(
  input: Omit<
    A2AExchangeV1,
    | "schemaVersion"
    | "version"
    | "exchangeId"
    | "exchangeSha256"
    | "payloadSha256"
    | "untrusted"
    | "authorityImpact"
  >,
) {
  const body = {
    schemaVersion: 1 as const,
    version: "p8.6-a2a-exchange:1" as const,
    ...input,
    payload: exchangePayloadSchema.parse(input.payload),
    payloadSha256: canonicalJsonSha256(input.payload),
    untrusted: true as const,
    authorityImpact: "none" as const,
  };
  const exchangeSha256 = canonicalJsonSha256(body);
  return parseA2AExchangeV1({
    ...body,
    exchangeId: `a2a-exchange:${exchangeSha256}`,
    exchangeSha256,
  });
}

export function parseA2AExchangeV1(value: unknown) {
  return deepFreeze(a2aExchangeV1Schema.parse(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
