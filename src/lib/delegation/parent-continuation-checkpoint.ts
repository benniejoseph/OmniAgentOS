import { z } from "zod";
import { agentPersonaV1Schema } from "@/lib/agents/persona";
import { commandModelSelectionRequestSchema } from "@/lib/models/command-selection";
import { canonicalActorIdFromExactRequestBinding } from "@/lib/security/canonical-actor";
import { appendScopedDomainEvent } from "@/lib/events/store";
import type { AgentRunRequest } from "@/lib/orchestration/types";
import type { RunBudgetCountersV1 } from "@/lib/runs/budgets";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";

/** Server-created request authority. It is metadata, never an approval or a
 * reusable source grant. Scoped memory grants are not widened by a worker. */
export function parentContinuationAuthority(request: AgentRunRequest) {
  const binding = request.requestActorBinding || (request.securityContext && canonicalRequestActorBindingFromSecurityContext(request.securityContext));
  if (!binding) return undefined;
  const conversationScope = request.contextScope === "none" || request.contextScope === "current_turn" || request.contextScope === "session"
    ? request.contextScope : undefined;
  return {
    actorBinding: binding, role: request.role || "operator",
    resumable: !request.contextSelection && !request.commandContext && (!request.contextScope || Boolean(conversationScope)) &&
      !request.promptMemoryAccess && !request.promptSharedMemoryAccess && !request.promptPersonalMemoryAccess && !request.promptEntityGraphAccess,
    ...(conversationScope ? { contextScope: conversationScope } : {}),
    profile: request.agentProfile || null,
    commandModelSelection: request.commandModelSelection || null,
    requireActionApproval: request.requireActionApproval === true,
  };
}
export type ParentContinuationAuthority = NonNullable<ReturnType<typeof parentContinuationAuthority>>;

/** Non-refundable remaining authority is saved before the terminal commit.
 * The worker cannot use it until that commit and every child have settled. */
export async function recordParentContinuationCheckpoint(input: {
  runId: string; scope: ExecutionScope; authority?: ParentContinuationAuthority; remaining: RunBudgetCountersV1;
}) {
  if (!input.authority) return;
  await appendScopedDomainEvent({
    id: `parent-continuation:${input.runId}`, streamId: `run:${input.runId}`,
    type: "delegation.parent_checkpoint", executionScope: input.scope,
    payload: { schemaVersion: 1, runId: input.runId, remaining: { ...input.remaining, tokens: undefined, tokenCount: input.remaining.tokens }, ...input.authority },
  });
}

const profileSchema = z.object({ name: z.string(), role: z.string(), description: z.string(), instructions: z.string(),
  persona: agentPersonaV1Schema, modelPolicy: z.enum(["auto", "openai_fast", "openai_reasoning", "gemini_fast", "anthropic_fast", "anthropic_reasoning"]),
  autonomy: z.enum(["assist", "governed", "execute"]), approvalPolicy: z.enum(["always", "risk_based", "read_only"]),
  memoryScope: z.enum(["session", "project", "all"]), toolIds: z.array(z.string()).max(200),
  skills: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), instructions: z.string(), toolIds: z.array(z.string()) }).strict()).max(100),
}).strict();
const authoritySchema = z.object({ actorBinding: z.object({ version: z.literal(1), kind: z.literal("auth_user"), authUserId: z.string(),
  canonicalActorId: z.string(), legacyOwnerActorIds: z.array(z.string()).length(1), readableOwnerActorIds: z.array(z.string()).length(2) }).strict(),
  role: z.enum(["viewer", "operator", "admin"]), resumable: z.boolean(), profile: profileSchema.nullable(),
  contextScope: z.enum(["none", "current_turn", "session"]).optional(),
  commandModelSelection: commandModelSelectionRequestSchema.nullable(), requireActionApproval: z.boolean(),
}).strict();
export function parseParentContinuationAuthority(value: unknown): ParentContinuationAuthority | undefined {
  const parsed = authoritySchema.safeParse(value);
  if (!parsed.success || !canonicalActorIdFromExactRequestBinding(parsed.data.actorBinding.legacyOwnerActorIds[0], parsed.data.actorBinding)) return undefined;
  return parsed.data;
}
