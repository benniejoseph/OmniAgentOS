import { z } from "zod";

import {
  parseDelegationContractV1,
  type DelegationContractV1,
} from "@/lib/delegation/contracts";
import type { DelegationTaskV1 } from "@/lib/delegation/lifecycle";
import {
  buildDelegatedPrincipalV1,
  delegatedPrincipalV1Schema,
} from "@/lib/delegation/principal";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import {
  openCredentialBundle,
  sealCredentialBundle,
  type SealedCredentialPayload,
} from "@/lib/settings/credential-vault";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  A2A_ADAPTER_ARTIFACT_SHA256,
  assertA2APeerRolloutActive,
  type A2APeerRolloutV1,
} from "@/lib/a2a/rollout";

export const A2A_DELEGATED_TOKEN_VERSION =
  "p8.6-a2a-delegated-token:1" as const;
export const A2A_DELEGATED_TOKEN_AUDIENCE =
  "asael-a2a-delegated-tool-gateway" as const;

const TOKEN_PREFIX = "asael_dpt1.";
const TOKEN_BINDING =
  `asael:a2a:delegated-token:v1:${A2A_ADAPTER_ARTIFACT_SHA256}`;
const MAX_TOKEN_BYTES = 96_000;
const MAX_TRANSPORT_TOKEN_CHARS = 8_192;
const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const a2aDelegatedTokenEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(A2A_DELEGATED_TOKEN_VERSION),
  tokenId: idSchema,
  tokenSha256: sha256Schema,
  audience: z.literal(A2A_DELEGATED_TOKEN_AUDIENCE),
  principal: delegatedPrincipalV1Schema,
  parentExecutionId: idSchema,
  workspaceId: idSchema.nullable(),
  projectId: idSchema.nullable(),
  missionId: idSchema.nullable(),
  internalTaskId: idSchema,
  rolloutId: idSchema,
  rolloutSha256: sha256Schema,
  peerId: idSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  credentialMaterialIncluded: z.literal(false),
}).strict().superRefine((value, context) => {
  const { tokenId, tokenSha256, ...body } = value;
  if (
    tokenSha256 !== canonicalJsonSha256(body) ||
    tokenId !== `a2a-delegated-token:${tokenSha256}`
  ) {
    context.addIssue({
      code: "custom",
      path: ["tokenSha256"],
      message: "The delegated A2A token integrity is invalid.",
    });
  }
  if (
    value.principal.audience !== "asael-governed-tool-executor" ||
    Date.parse(value.issuedAt) >= Date.parse(value.expiresAt) ||
    Date.parse(value.expiresAt) > Date.parse(value.principal.expiresAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "The delegated A2A token authority window is invalid.",
    });
  }
});

export type A2ADelegatedTokenEnvelopeV1 = Readonly<
  z.infer<typeof a2aDelegatedTokenEnvelopeV1Schema>
>;

export function issueDelegatedA2ATokenV1(input: {
  contract: DelegationContractV1;
  internalTask: DelegationTaskV1;
  rollout: A2APeerRolloutV1;
  parentExecutionScope: ExecutionScope;
  issuedAt?: string;
}) {
  const contract = parseDelegationContractV1(input.contract);
  const rollout = assertA2APeerRolloutActive({
    rollout: input.rollout,
    direction: "outbound",
  });
  const principal = buildDelegatedPrincipalV1({
    contract,
    parentExecutionScope: input.parentExecutionScope,
  });
  const issuedAt = input.issuedAt || new Date().toISOString();
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Math.min(
    Date.parse(contract.deadline.completeBy),
    issuedAtMs + rollout.maxTaskDurationMs,
  );
  assertTaskBinding(input.internalTask, contract);
  if (
    !Number.isFinite(issuedAtMs) ||
    issuedAtMs < Date.parse(contract.deadline.createdAt) ||
    issuedAtMs >= expiresAtMs
  ) {
    throw new Error("The delegated A2A token cannot be issued outside its contract window.");
  }
  const body = {
    schemaVersion: 1 as const,
    version: A2A_DELEGATED_TOKEN_VERSION,
    audience: A2A_DELEGATED_TOKEN_AUDIENCE,
    principal,
    parentExecutionId: contract.scope.parentExecutionId,
    workspaceId: contract.scope.workspaceId,
    projectId: contract.scope.projectId,
    missionId: contract.scope.missionId,
    internalTaskId: input.internalTask.taskId,
    rolloutId: rollout.rolloutId,
    rolloutSha256: rollout.rolloutSha256,
    peerId: rollout.peerId,
    issuedAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
    credentialMaterialIncluded: false as const,
  };
  const tokenSha256 = canonicalJsonSha256(body);
  const envelope = parseA2ADelegatedTokenEnvelopeV1({
    ...body,
    tokenId: `a2a-delegated-token:${tokenSha256}`,
    tokenSha256,
  });
  const sealed = sealCredentialBundle(
    { envelope: JSON.stringify(envelope) },
    TOKEN_BINDING,
  );
  const token = `${TOKEN_PREFIX}${Buffer.from(JSON.stringify(sealed), "utf8").toString("base64url")}`;
  if (token.length > MAX_TRANSPORT_TOKEN_CHARS) {
    throw new Error("The delegated A2A authority exceeds its transport boundary.");
  }
  return Object.freeze({
    token,
    envelope,
  });
}

export function openDelegatedA2ATokenV1(
  token: string,
  options: { now?: string } = {},
) {
  if (
    typeof token !== "string" ||
    !token.startsWith(TOKEN_PREFIX) ||
    token.length > MAX_TOKEN_BYTES
  ) {
    throw new Error("The delegated A2A token is invalid.");
  }
  try {
    const encoded = token.slice(TOKEN_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid encoding");
    const bytes = Buffer.from(encoded, "base64url");
    if (!bytes.length || bytes.toString("base64url") !== encoded) {
      throw new Error("invalid encoding");
    }
    const sealed = JSON.parse(bytes.toString("utf8")) as SealedCredentialPayload;
    const credentials = openCredentialBundle(sealed, TOKEN_BINDING);
    const envelope = parseA2ADelegatedTokenEnvelopeV1(
      JSON.parse(credentials.envelope || "null"),
    );
    const nowMs = Date.parse(options.now || new Date().toISOString());
    if (!Number.isFinite(nowMs) || nowMs >= Date.parse(envelope.expiresAt)) {
      throw new Error("expired");
    }
    return envelope;
  } catch {
    throw new Error("The delegated A2A token is invalid or expired.");
  }
}

export function parseA2ADelegatedTokenEnvelopeV1(value: unknown) {
  return deepFreeze(a2aDelegatedTokenEnvelopeV1Schema.parse(value));
}

function assertTaskBinding(
  task: DelegationTaskV1,
  contract: DelegationContractV1,
) {
  if (
    task.taskId !== `delegation-task:${contract.delegationId}` ||
    task.tenantId !== contract.scope.tenantId ||
    task.ownerActorId !== contract.scope.initiatingActorId ||
    task.parentExecutionId !== contract.scope.parentExecutionId ||
    task.delegationId !== contract.delegationId ||
    task.contractSha256 !== contract.contractSha256 ||
    task.delegatePrincipalId !== contract.delegate.principalId ||
    !["accepted", "working", "waiting"].includes(task.state)
  ) {
    throw new Error("The delegated A2A token does not match an active canonical task.");
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
