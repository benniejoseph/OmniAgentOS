import "server-only";

import { z } from "zod";
import { listRecentActorEvents } from "@/lib/events/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { getThread, listThreadTurns } from "@/lib/threads/store";

const EVENT_TYPE = "intent.clarification_requested";
const EVENT_LIMIT_PER_OWNER = 8;
const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  threadId: z.string().uuid(),
  questionTurnId: z.string().uuid(),
  userTurnId: z.string().uuid(),
  route: z.literal("clarify"),
  effectCount: z.literal(0),
  requireActionApproval: z.literal(true).optional(),
});

export class TypedClarificationApprovalHoldError extends Error {
  readonly code = "clarification_approval_hold_unavailable";
  readonly status = 503;

  constructor() {
    super("The earlier clarification's approval policy could not be verified. Please retry before continuing.");
    this.name = "TypedClarificationApprovalHoldError";
  }
}

/** Read before appending this request's user turn. The route admits only an
 * explicitly selected existing typed conversation, never voice or queued work.
 * Only the immediately unanswered server question can carry a narrowing hold;
 * user/model prose and older questions are not policy sources. This read does
 * not claim the question, grant authority, or change any stored state. */
export async function resolveTypedClarificationApprovalHold(input: {
  context: SecurityContext;
  threadId: string;
  currentRequestId: string;
}): Promise<boolean> {
  const { context, threadId, currentRequestId } = input;
  if (context.source !== "session" && context.source !== "mobile") return false;
  try {
    if (!z.string().uuid().safeParse(threadId).success ||
        !currentRequestId.trim() || currentRequestId !== currentRequestId.trim()) {
      throw new TypedClarificationApprovalHoldError();
    }
    const ownerIds = canonicalRequestActorBindingFromSecurityContext(context)?.readableOwnerActorIds ?? [context.actorId];
    const thread = await getThread(threadId, { tenantId: context.tenantId });
    if (!thread || thread.id !== threadId || thread.tenantId !== context.tenantId || !ownerIds.includes(thread.actorId)) {
      throw new TypedClarificationApprovalHoldError();
    }
    const turns = await listThreadTurns(threadId, { tenantId: context.tenantId, limit: 3 });
    if (turns.some(turn => turn.threadId !== threadId || turn.tenantId !== context.tenantId ||
        !Number.isFinite(Date.parse(turn.createdAt)))) throw new TypedClarificationApprovalHoldError();
    const latest = turns.at(-1);
    if (!latest || (latest.role !== "assistant" && latest.role !== "user")) return false;

    const pages = await Promise.all(ownerIds.map(actorId => listRecentActorEvents({
      tenantId: context.tenantId,
      actorId,
      types: [EVENT_TYPE],
      // The original input precedes the receipt, which preallocates its question
      // ID before that turn is appended. An unanswered hold has no time expiry.
      since: new Date(turns[0].createdAt),
      payloadMatch: { key: "threadId", value: threadId },
      limit: EVENT_LIMIT_PER_OWNER,
    })));
    if (pages.some(page => page.length >= EVENT_LIMIT_PER_OWNER)) throw new TypedClarificationApprovalHoldError();
    let held = false;
    for (const event of pages.flat()) {
      const matchesQuestion = latest.role === "assistant" && event.payload.questionTurnId === latest.id;
      const matchesUnansweredInput = latest.role === "user" && event.payload.userTurnId === latest.id;
      if (!matchesQuestion && !matchesUnansweredInput) continue;
      const receipt = receiptSchema.safeParse(event.payload);
      const scope = parsePersistedExecutionScope(event.executionScope);
      const original = matchesQuestion ? turns.at(-2) : latest;
      if (!receipt.success || event.type !== EVENT_TYPE ||
          event.tenantId !== context.tenantId || !ownerIds.includes(event.actorId) ||
          event.streamId !== `thread:${threadId}` ||
          receipt.data.threadId !== threadId ||
          !original || original.role !== "user" || receipt.data.userTurnId !== original.id ||
          !scope || scope.tenantId !== context.tenantId || scope.initiatingActorId !== event.actorId ||
          scope.purpose !== "agent.intent.clarification" ||
          scope.causationId !== original.id || event.causationId !== original.id ||
          !event.correlationId || scope.correlationId !== event.correlationId ||
          event.correlationId === currentRequestId ||
          !Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) < Date.parse(original.createdAt)) {
        throw new TypedClarificationApprovalHoldError();
      }
      if (receipt.data.requireActionApproval === true && (matchesUnansweredInput ||
          // The exact receipt cannot establish ordering when the store returns
          // tied newest turns. Do not affect ordinary conversations with no
          // matching clarification receipt.
          Date.parse(original.createdAt) >= Date.parse(latest.createdAt) ||
          Date.parse(event.at) > Date.parse(latest.createdAt))) {
        throw new TypedClarificationApprovalHoldError();
      }
      // A later duplicate with an absent flag cannot cancel an earlier true.
      held ||= receipt.data.requireActionApproval === true;
    }
    return held;
  } catch {
    // Store exceptions may contain private details; a failed lookup is never a
    // negative policy result and never permits the request to start effects.
    throw new TypedClarificationApprovalHoldError();
  }
}
