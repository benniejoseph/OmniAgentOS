import { z } from "zod";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const a2aTaskMappingV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal("p8.6-a2a-task-mapping:1"),
  mappingId: idSchema,
  mappingSha256: sha256Schema,
  tenantId: idSchema,
  ownerActorId: idSchema,
  peerId: idSchema,
  rolloutId: idSchema,
  rolloutSha256: sha256Schema,
  direction: z.enum(["inbound", "outbound"]),
  externalTaskId: idSchema,
  externalContextId: idSchema,
  internalTaskId: idSchema,
  internalDelegationId: idSchema,
  internalContractSha256: sha256Schema,
  localAgentId: z.enum(["atlas", "scout", "forge", "sentinel", "mnemosyne"]),
  localAgentDefinitionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  remoteSkillId: idSchema,
  createdAt: timestampSchema,
}).strict().superRefine((value, context) => {
  const { mappingId, mappingSha256, ...body } = value;
  if (
    mappingId !== a2aTaskMappingIdV1(body) ||
    mappingSha256 !== canonicalJsonSha256(body)
  ) {
    context.addIssue({
      code: "custom",
      path: ["mappingSha256"],
      message: "A2A task mapping integrity is invalid.",
    });
  }
});

export type A2ATaskMappingV1 = Readonly<
  z.infer<typeof a2aTaskMappingV1Schema>
>;

export function buildA2ATaskMappingV1(
  input: Omit<A2ATaskMappingV1, "schemaVersion" | "version" | "mappingId" | "mappingSha256">,
) {
  const body = {
    schemaVersion: 1 as const,
    version: "p8.6-a2a-task-mapping:1" as const,
    ...input,
  };
  return parseA2ATaskMappingV1({
    ...body,
    mappingId: a2aTaskMappingIdV1(body),
    mappingSha256: canonicalJsonSha256(body),
  });
}

export function a2aTaskMappingIdV1(input: {
  tenantId: string;
  ownerActorId: string;
  peerId: string;
  direction: "inbound" | "outbound";
  externalTaskId: string;
}) {
  return `a2a-task-map:${canonicalJsonSha256({
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    peerId: input.peerId,
    direction: input.direction,
    externalTaskId: input.externalTaskId,
  })}`;
}

export function parseA2ATaskMappingV1(value: unknown) {
  return deepFreeze(a2aTaskMappingV1Schema.parse(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
