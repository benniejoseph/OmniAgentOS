import { z } from "zod";

import {
  LOOP_V2_CONTEXT_SCOPES,
  loopV2ExecutionScopeSha256,
} from "@/lib/orchestration/loop-v2";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import {
  sourceContractIdSchema,
  sourceContractSha256,
  sourceContractSha256Schema,
  sourceTimestampSchema,
} from "@/lib/sources/contracts";

export const LOOP_V2_CONTEXT_BINDING_POLICY_VERSION =
  "loop-v2-context-binding-v1" as const;

export const loopV2ContextAuthorityKindSchema = z.enum([
  "conversation",
  "agent_identity",
  "shared_membership",
  "personal_standing_consent",
  "reviewed_selection",
]);

const loopV2ContextBindingBodySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(LOOP_V2_CONTEXT_BINDING_POLICY_VERSION),
  tenantId: sourceContractIdSchema,
  runId: sourceContractIdSchema,
  ownerActorId: sourceContractIdSchema,
  agentPrincipalId: sourceContractIdSchema,
  contextScope: z.enum(LOOP_V2_CONTEXT_SCOPES),
  authorityKind: loopV2ContextAuthorityKindSchema,
  authoritySha256: sourceContractSha256Schema,
  executionScopeSha256: sourceContractSha256Schema,
  querySha256: sourceContractSha256Schema,
  conversationSha256: sourceContractSha256Schema,
  contextManifestSha256: sourceContractSha256Schema,
  compiledContextSha256: sourceContractSha256Schema,
  selectedEvidenceSetSha256: sourceContractSha256Schema,
  selectedItemCount: z.number().int().min(0).max(8),
  contextBudgetReceiptSha256: sourceContractSha256Schema.nullable(),
  selectionSha256: sourceContractSha256Schema.nullable(),
  boundAt: sourceTimestampSchema,
}).strict().superRefine((binding, context) => {
  const expectedAuthorityKind = authorityKindForScope(binding.contextScope);
  if (binding.authorityKind !== expectedAuthorityKind) {
    context.addIssue({
      code: "custom",
      path: ["authorityKind"],
      message: "Loop v2 context authority does not match the selected scope.",
    });
  }
  if (
    (binding.contextScope === "explicit_selection") !==
      (binding.selectionSha256 !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["selectionSha256"],
      message: "Only explicit selection carries a reviewed selection digest.",
    });
  }
  const durableScope = [
    "agent_private",
    "mission",
    "project",
    "workspace",
    "personal",
    "explicit_selection",
  ].includes(binding.contextScope);
  if (durableScope !== (binding.contextBudgetReceiptSha256 !== null)) {
    context.addIssue({
      code: "custom",
      path: ["contextBudgetReceiptSha256"],
      message: "Durable context requires its exact budget receipt.",
    });
  }
  if (!durableScope && binding.selectedItemCount !== 0) {
    context.addIssue({
      code: "custom",
      path: ["selectedItemCount"],
      message: "Conversation-only context cannot claim retrieved evidence.",
    });
  }
});

export const loopV2ContextBindingV1Schema =
  loopV2ContextBindingBodySchema.extend({
    bindingSha256: sourceContractSha256Schema,
  }).strict();

export type LoopV2ContextAuthorityKind = z.infer<
  typeof loopV2ContextAuthorityKindSchema
>;
export type LoopV2ContextBindingV1 = Readonly<z.infer<
  typeof loopV2ContextBindingV1Schema
>>;

export function buildLoopV2ContextBindingV1(input: {
  tenantId: string;
  runId: string;
  ownerActorId: string;
  agentPrincipalId: string;
  contextScope: (typeof LOOP_V2_CONTEXT_SCOPES)[number];
  authoritySha256: string;
  executionScope: ExecutionScope;
  querySha256: string;
  conversationSha256: string;
  contextManifestSha256: string;
  compiledContextSha256: string;
  selectedEvidenceIds: readonly string[];
  contextBudgetReceiptSha256?: string;
  selectionSha256?: string;
  boundAt?: string;
}): LoopV2ContextBindingV1 {
  const body = loopV2ContextBindingBodySchema.parse({
    schemaVersion: 1,
    policyVersion: LOOP_V2_CONTEXT_BINDING_POLICY_VERSION,
    tenantId: input.tenantId,
    runId: input.runId,
    ownerActorId: input.ownerActorId,
    agentPrincipalId: input.agentPrincipalId,
    contextScope: input.contextScope,
    authorityKind: authorityKindForScope(input.contextScope),
    authoritySha256: input.authoritySha256,
    executionScopeSha256: loopV2ExecutionScopeSha256(input.executionScope),
    querySha256: input.querySha256,
    conversationSha256: input.conversationSha256,
    contextManifestSha256: input.contextManifestSha256,
    compiledContextSha256: input.compiledContextSha256,
    selectedEvidenceSetSha256: sourceContractSha256(
      [...new Set(input.selectedEvidenceIds)].sort(),
    ),
    selectedItemCount: new Set(input.selectedEvidenceIds).size,
    contextBudgetReceiptSha256: input.contextBudgetReceiptSha256 || null,
    selectionSha256: input.selectionSha256 || null,
    boundAt: input.boundAt || new Date().toISOString(),
  });
  return Object.freeze(loopV2ContextBindingV1Schema.parse({
    ...body,
    bindingSha256: sourceContractSha256(body),
  }));
}

export function parseLoopV2ContextBindingV1(
  value: unknown,
): LoopV2ContextBindingV1 {
  const parsed = loopV2ContextBindingV1Schema.parse(value);
  const { bindingSha256, ...body } = parsed;
  if (sourceContractSha256(body) !== bindingSha256) {
    throw new Error("Loop v2 context binding digest does not match.");
  }
  return Object.freeze(parsed);
}

function authorityKindForScope(
  scope: (typeof LOOP_V2_CONTEXT_SCOPES)[number],
): LoopV2ContextAuthorityKind {
  if (scope === "agent_private") return "agent_identity";
  if (["mission", "project", "workspace"].includes(scope)) {
    return "shared_membership";
  }
  if (scope === "personal") return "personal_standing_consent";
  if (scope === "explicit_selection") return "reviewed_selection";
  return "conversation";
}
