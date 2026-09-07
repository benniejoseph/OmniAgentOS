import { z } from "zod";

import { A2A_PROTOCOL_VERSION } from "@/lib/a2a/v1-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const A2A_ADAPTER_RELEASE = "p8.6-a2a-adapter:1" as const;
export const A2A_ADAPTER_ARTIFACT_SHA256 = canonicalJsonSha256({
  release: A2A_ADAPTER_RELEASE,
  protocolVersion: A2A_PROTOCOL_VERSION,
  binding: "HTTP+JSON",
  inboundAuthentication: "asael_service_api_key",
  outboundNetworkPolicy: "public_http_url_v1",
  internalTaskAuthority: "p8.3-delegation-task:1",
  internalMessageAuthority: "p8.4-delegation-message:1",
  internalArtifactAuthority: "p8.4-shared-mission-artifact:1",
  remoteCompletionDisposition: "observation_until_parent_verification",
  credentialForwarding: false,
});

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const peerDirectionSchema = z.enum(["inbound", "outbound", "bidirectional"]);
const peerModeSchema = z.enum(["shadow", "enabled"]);
const peerStatusSchema = z.enum(["registered", "active", "paused", "revoked"]);
const inboundAgentIdSchema = z.enum([
  "atlas",
  "scout",
  "forge",
  "sentinel",
  "mnemosyne",
]);

export const a2aPeerRolloutV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal("p8.6-a2a-peer-rollout:1"),
  rolloutId: idSchema,
  rolloutSha256: sha256Schema,
  tenantId: idSchema,
  ownerActorId: idSchema,
  peerId: idSchema,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  direction: peerDirectionSchema,
  mode: peerModeSchema,
  status: peerStatusSchema,
  interfaceUrl: z.string().url().max(2_048),
  agentCardSha256: sha256Schema,
  protocolVersion: z.literal(A2A_PROTOCOL_VERSION),
  protocolBinding: z.literal("HTTP+JSON"),
  adapterRelease: z.literal(A2A_ADAPTER_RELEASE),
  adapterArtifactSha256: z.literal(A2A_ADAPTER_ARTIFACT_SHA256),
  inboundServiceApiKeyId: idSchema.nullable(),
  outboundCredentialConfigured: z.boolean(),
  allowedSkillIds: z.array(idSchema).min(1).max(64).refine(
    (values) => new Set(values).size === values.length,
    "A2A allowed skills must be unique.",
  ),
  allowedInboundAgentIds: z.array(inboundAgentIdSchema).max(5).refine(
    (values) => new Set(values).size === values.length,
    "A2A inbound Agent IDs must be unique.",
  ),
  maxTaskDurationMs: z.number().int().min(1_000).max(3_600_000),
  maxInputBytes: z.number().int().min(1).max(1_000_000),
  maxOutputBytes: z.number().int().min(1).max(2_000_000),
  lifecycleRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  const { rolloutId, rolloutSha256, ...body } = value;
  if (
    rolloutId !== a2aPeerRolloutId({
      tenantId: value.tenantId,
      ownerActorId: value.ownerActorId,
      peerId: value.peerId,
      generation: value.generation,
    }) ||
    rolloutSha256 !== canonicalJsonSha256(body)
  ) {
    context.addIssue({
      code: "custom",
      path: ["rolloutSha256"],
      message: "A2A peer rollout integrity is invalid.",
    });
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    context.addIssue({
      code: "custom",
      path: ["updatedAt"],
      message: "A2A rollout time cannot move backwards.",
    });
  }
  if ((value.status === "registered") !== (value.lifecycleRevision === 0)) {
    context.addIssue({
      code: "custom",
      path: ["lifecycleRevision"],
      message: "A2A rollout lifecycle revision does not match its status.",
    });
  }
  const requiresInbound = value.direction !== "outbound";
  if (requiresInbound !== Boolean(value.inboundServiceApiKeyId)) {
    context.addIssue({
      code: "custom",
      path: ["inboundServiceApiKeyId"],
      message: "A2A inbound rollouts require one exact service API key.",
    });
  }
  if (requiresInbound !== (value.allowedInboundAgentIds.length > 0)) {
    context.addIssue({
      code: "custom",
      path: ["allowedInboundAgentIds"],
      message: "A2A inbound rollouts require explicitly allowed local Agents.",
    });
  }
  const requiresOutbound = value.direction !== "inbound";
  if (requiresOutbound !== value.outboundCredentialConfigured) {
    context.addIssue({
      code: "custom",
      path: ["outboundCredentialConfigured"],
      message: "A2A outbound rollouts require an endpoint-bound credential.",
    });
  }
  const url = safeUrl(value.interfaceUrl);
  if (!url || url.protocol !== "https:" || url.username || url.password) {
    context.addIssue({
      code: "custom",
      path: ["interfaceUrl"],
      message: "A2A peer interfaces must use credential-free HTTPS URLs.",
    });
  }
});

export type A2APeerRolloutV1 = Readonly<
  z.infer<typeof a2aPeerRolloutV1Schema>
>;

export function buildA2APeerRolloutV1(input: {
  tenantId: string;
  ownerActorId: string;
  peerId: string;
  generation: number;
  direction: A2APeerRolloutV1["direction"];
  mode: A2APeerRolloutV1["mode"];
  interfaceUrl: string;
  agentCardSha256: string;
  inboundServiceApiKeyId?: string | null;
  outboundCredentialConfigured?: boolean;
  allowedSkillIds: readonly string[];
  allowedInboundAgentIds?: readonly A2APeerRolloutV1["allowedInboundAgentIds"][number][];
  maxTaskDurationMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  createdAt?: string;
}) {
  const createdAt = input.createdAt || new Date().toISOString();
  const body = {
    schemaVersion: 1 as const,
    version: "p8.6-a2a-peer-rollout:1" as const,
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    peerId: input.peerId,
    generation: input.generation,
    direction: input.direction,
    mode: input.mode,
    status: "registered" as const,
    interfaceUrl: normalizeInterfaceUrl(input.interfaceUrl),
    agentCardSha256: input.agentCardSha256,
    protocolVersion: A2A_PROTOCOL_VERSION,
    protocolBinding: "HTTP+JSON" as const,
    adapterRelease: A2A_ADAPTER_RELEASE,
    adapterArtifactSha256: A2A_ADAPTER_ARTIFACT_SHA256,
    inboundServiceApiKeyId: input.inboundServiceApiKeyId || null,
    outboundCredentialConfigured:
      input.outboundCredentialConfigured === true,
    allowedSkillIds: [...new Set(input.allowedSkillIds)].sort(),
    allowedInboundAgentIds: [...new Set(input.allowedInboundAgentIds || [])].sort(),
    maxTaskDurationMs: input.maxTaskDurationMs || 300_000,
    maxInputBytes: input.maxInputBytes || 65_536,
    maxOutputBytes: input.maxOutputBytes || 262_144,
    lifecycleRevision: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const rolloutSha256 = canonicalJsonSha256(body);
  return parseA2APeerRolloutV1({
    ...body,
    rolloutId: a2aPeerRolloutId(input),
    rolloutSha256,
  });
}

export function transitionA2APeerRolloutV1(input: {
  rollout: A2APeerRolloutV1;
  to: "active" | "paused" | "revoked";
  at?: string;
}) {
  const current = parseA2APeerRolloutV1(input.rollout);
  const allowed: Record<A2APeerRolloutV1["status"], readonly A2APeerRolloutV1["status"][]> = {
    registered: ["active", "revoked"],
    active: ["paused", "revoked"],
    paused: ["active", "revoked"],
    revoked: [],
  };
  if (!allowed[current.status].includes(input.to)) {
    throw new Error(`A2A rollout transition ${current.status} -> ${input.to} is invalid.`);
  }
  const updatedAt = input.at || new Date().toISOString();
  if (Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error("A2A rollout transition time cannot move backwards.");
  }
  const { rolloutId: _rolloutId, rolloutSha256: _rolloutSha256, ...previous } = current;
  const body = {
    ...previous,
    status: input.to,
    lifecycleRevision: current.lifecycleRevision + 1,
    updatedAt,
  };
  const rolloutSha256 = canonicalJsonSha256(body);
  return parseA2APeerRolloutV1({
    ...body,
    rolloutId: current.rolloutId,
    rolloutSha256,
  });
}

export function assertA2APeerRolloutActive(input: {
  rollout: A2APeerRolloutV1;
  direction: "inbound" | "outbound";
  serviceApiKeyId?: string;
}) {
  const rollout = parseA2APeerRolloutV1(input.rollout);
  if (rollout.status !== "active" || rollout.mode !== "enabled") {
    throw new Error("The A2A peer rollout is not enabled and active.");
  }
  if (
    (input.direction === "inbound" && rollout.direction === "outbound") ||
    (input.direction === "outbound" && rollout.direction === "inbound")
  ) {
    throw new Error(`The A2A peer rollout does not allow ${input.direction} traffic.`);
  }
  if (
    input.direction === "inbound" &&
    rollout.inboundServiceApiKeyId !== input.serviceApiKeyId
  ) {
    throw new Error("The A2A caller is not bound to this peer rollout.");
  }
  return rollout;
}

export function parseA2APeerRolloutV1(value: unknown) {
  return deepFreeze(a2aPeerRolloutV1Schema.parse(value));
}

export function a2aPeerRolloutId(input: {
  tenantId: string;
  ownerActorId: string;
  peerId: string;
  generation: number;
}) {
  return `a2a-rollout:${canonicalJsonSha256({
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    peerId: input.peerId,
    generation: input.generation,
  })}`;
}

function normalizeInterfaceUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function safeUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
