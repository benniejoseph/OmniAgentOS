import "server-only";
import { createHash } from "node:crypto";
import type { AgentRunIdentityPinV1 } from "@/lib/agents/identity-contracts";
import { listRecentActorEvents, type DomainEvent } from "@/lib/events/store";
import { hasExplicitActionApprovalHold } from "@/lib/orchestration/action-approval-hold";
import { agentRequestRunId } from "@/lib/runs/request-admission";
import { getAgentRun, getAgentRunExecutionScope, getAgentRunIdentityPin, getAgentRunWorkflowHandoff } from "@/lib/runs/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { listThreadTurns } from "@/lib/threads/store";
import {
  conversationVoiceStreamId, VoiceConversationError, type ConversationVoiceSession,
} from "@/lib/voice/conversation-session";
import {
  voiceTaskBindingSchema, voiceTaskContinuationSchema, type VoiceTaskBinding,
} from "@/lib/voice/task-authority";

const INPUT_MAX_AGE_MS = 5 * 60_000;
const EVENT_LIMIT = 100;

/** Whole human utterances only: quoted examples, new goals and free-form
 * suffixes cannot ask the server to borrow an earlier objective. */
export function isSameGoalVoiceContinuation(caption: string): boolean {
  if (caption.length > 300) return false;
  const text = caption.trim().toLowerCase().replace(/\s+/g, " ");
  const approach = "(?:another|a different) (?:approach|way|method)";
  const retry = `try (?:again|${approach})`;
  const intent = `(?:${retry}|think of ${approach} and try it|go ahead(?: and ${retry})?|(?:proceed|continue)(?: with (?:that|it|the same task))?|try it)`;
  return new RegExp(`^(?:(?:asael|please|yes|okay|ok)[, ]+)*(?:(?:can|could|would) you (?:please )?)?${intent}(?:,? but (?:wait for my approval|ask me before acting))?(?: please)?[.!?]*$`).test(text);
}

const unavailable = () => new VoiceConversationError("voice_continuation_unavailable",
  "I could not safely match that follow-up to a recent completed task. Please say the complete task again, including any instruction to wait for approval.", 409);

function requireScopedEvent(event: DomainEvent, context: SecurityContext, actorIds: readonly string[],
  purpose: string, streamId: string) {
  if (event.tenantId !== context.tenantId || !actorIds.includes(event.actorId) ||
      event.streamId !== streamId || event.executionScope?.tenantId !== context.tenantId ||
      event.executionScope.initiatingActorId !== event.actorId || event.executionScope.purpose !== purpose ||
      event.executionScope.correlationId !== event.correlationId ||
      event.executionScope.causationId !== event.causationId) throw unavailable();
}

export type ConversationVoiceTaskContinuation = {
  binding: VoiceTaskBinding;
  sourceIdentity: AgentRunIdentityPinV1;
};

/** The client supplies no previous objective or authority. Resolve the latest
 * task in this exact call, then read its original immutable human caption.
 * A completed run is eligible for another attempt, not proof of task success. */
export async function resolveConversationVoiceTaskContinuation(input: {
  context: SecurityContext;
  session: ConversationVoiceSession;
  latestInput: VoiceTaskBinding;
}): Promise<ConversationVoiceTaskContinuation | undefined> {
  const { context, session, latestInput } = input;
  if (!isSameGoalVoiceContinuation(latestInput.objective)) return undefined;
  const now = Date.now();
  const actorIds = canonicalRequestActorBindingFromSecurityContext(context)?.readableOwnerActorIds ?? [context.actorId];
  if (context.source !== "mobile" || context.native?.platform !== "macos" ||
      !session.nativeDeviceId || session.nativeDeviceId !== context.native.deviceId ||
      session.commandContext.computerUseTarget !== "local_macos" ||
      !actorIds.includes(session.ownerActorId) || latestInput.tenantId !== context.tenantId ||
      latestInput.actorId !== context.actorId || latestInput.sessionId !== session.sessionId ||
      latestInput.conversationId !== session.conversationId || latestInput.continuation ||
      !(Date.parse(latestInput.expiresAt) > now) || !(Date.parse(session.expiresAt) > now)) throw unavailable();

  const pages = await Promise.all(actorIds.map(actorId => listRecentActorEvents({
    tenantId: context.tenantId, actorId, types: ["voice.command_dispatched"],
    since: new Date(now - INPUT_MAX_AGE_MS),
    payloadMatch: { key: "voiceSessionId", value: session.sessionId }, limit: EVENT_LIMIT,
  })));
  if (pages.some(page => page.length >= EVENT_LIMIT)) throw unavailable();
  const dispatched = pages.flat().sort((a, b) => b.seq - a.seq);
  const newest = dispatched[0];
  if (!newest) throw unavailable();
  // A transport replay may already have its dispatch receipt. Its original
  // predecessor must still be exact; never retarget the replay to a newer task.
  const replay = newest.correlationId === latestInput.requestId ? newest : undefined;
  const replayContinuation = replay ? voiceTaskContinuationSchema.safeParse(replay.payload.taskContinuation) : undefined;
  if (replay && !replayContinuation?.success) throw unavailable();
  const source = replayContinuation?.success
    ? dispatched.find(event => event.correlationId === replayContinuation.data.sourceRequestId)
    : newest;
  if (!source || source.correlationId === latestInput.requestId || !source.correlationId) throw unavailable();
  const prior = source.payload.taskContinuation === undefined
    ? undefined : voiceTaskContinuationSchema.safeParse(source.payload.taskContinuation);
  if (prior && !prior.success) throw unavailable();
  const priorContinuation = prior?.data;
  const objectiveDispatch = priorContinuation
    ? dispatched.find(event => event.correlationId === priorContinuation.objectiveRequestId)
    : source;
  if (!objectiveDispatch || !objectiveDispatch.correlationId || objectiveDispatch.payload.taskContinuation !== undefined) throw unavailable();
  for (const event of [source, objectiveDispatch, ...(replay ? [replay] : [])]) {
    requireScopedEvent(event, context, actorIds, "voice.command.dispatch", `thread:${session.conversationId}`);
    if (event.payload.schemaVersion !== 2 || event.payload.threadId !== session.conversationId ||
        event.payload.voiceSessionId !== session.sessionId || event.payload.submission !== "continuous_conversation" ||
        event.payload.reviewAttested !== false || event.payload.forceApprovalAboveRisk !== 1 ||
        !(Date.parse(String(event.payload.taskAuthorityExpiresAt)) > now)) throw unavailable();
  }
  const sourceRunId = agentRequestRunId(context.tenantId, source.actorId, source.correlationId);
  const objectiveRunId = agentRequestRunId(context.tenantId, objectiveDispatch.actorId, objectiveDispatch.correlationId);
  if (priorContinuation && (priorContinuation.objectiveRunId !== objectiveRunId ||
      priorContinuation.objectiveUserTurnId !== objectiveDispatch.payload.userTurnId ||
      priorContinuation.objectiveUserInputItemId !== objectiveDispatch.payload.userInputItemId ||
      priorContinuation.objectiveTranscriptSha256 !== objectiveDispatch.payload.taskInputSha256)) throw unavailable();
  if (replayContinuation?.success && replayContinuation.data.sourceRunId !== sourceRunId) throw unavailable();

  const [run, scope, identity, handoff, captions, claims, turns] = await Promise.all([
    getAgentRun(sourceRunId, { tenantId: context.tenantId }),
    getAgentRunExecutionScope(sourceRunId, { tenantId: context.tenantId }),
    getAgentRunIdentityPin(sourceRunId, { tenantId: context.tenantId }),
    getAgentRunWorkflowHandoff(sourceRunId, { tenantId: context.tenantId, actorId: source.actorId }),
    listRecentActorEvents({ tenantId: context.tenantId, actorId: session.ownerActorId,
      types: ["voice.conversation_turn_saved"], since: new Date(now - INPUT_MAX_AGE_MS),
      payloadMatch: { key: "voiceSessionId", value: session.sessionId }, limit: EVENT_LIMIT }),
    listRecentActorEvents({ tenantId: context.tenantId, actorId: session.ownerActorId,
      types: ["voice.task_input_bound"], since: new Date(now - INPUT_MAX_AGE_MS),
      payloadMatch: { key: "sessionId", value: session.sessionId }, limit: EVENT_LIMIT }),
    listThreadTurns(session.conversationId, { tenantId: context.tenantId, limit: EVENT_LIMIT }),
  ]);
  if (captions.length >= EVENT_LIMIT || claims.length >= EVENT_LIMIT || !run ||
      run.tenantId !== context.tenantId || run.ownerActorId !== source.actorId ||
      run.threadId !== session.conversationId || run.status !== "completed" || !run.completedAt || handoff ||
      run.mode !== session.commandContext.mode || !scope || scope.tenantId !== context.tenantId ||
      scope.initiatingActorId !== source.actorId || scope.correlationId !== sourceRunId ||
      scope.causationId !== source.correlationId || scope.purpose !== "agent.run" ||
      scope.missionId || scope.delegationId || scope.projectId !== source.executionScope!.projectId ||
      !identity || identity.runId !== sourceRunId || identity.tenantId !== context.tenantId ||
      !actorIds.includes(identity.actorId) || identity.logicalAgentId !== run.agentId ||
      identity.principalId !== scope.executingPrincipalId) throw unavailable();

  const humanCaptions = captions.filter(event => event.payload.role === "user").sort((a, b) => b.seq - a.seq);
  const latestCaption = humanCaptions[0];
  if (!latestCaption || latestCaption.payload.turnId !== latestInput.userTurnId ||
      latestCaption.payload.inputItemId !== latestInput.userInputItemId ||
      latestCaption.payload.transcriptSha256 !== latestInput.transcriptSha256 ||
      Date.parse(run.completedAt) > Date.parse(latestCaption.at) || source.seq >= latestCaption.seq) throw unavailable();
  // Only the first human follow-up can refer implicitly to this completed
  // task. An intervening unsent goal or hold must never be interpreted away.
  if (humanCaptions.some(event => event.seq < latestCaption.seq &&
      Date.parse(event.at) >= Date.parse(run.completedAt!))) throw unavailable();
  const originalCaption = humanCaptions.find(event => event.payload.turnId === objectiveDispatch.payload.userTurnId);
  const originalTurn = turns.find(turn => turn.id === objectiveDispatch.payload.userTurnId && turn.role === "user");
  if (!originalCaption || !originalTurn || !originalTurn.content.trim() || originalTurn.content.length > 8000 ||
      originalCaption.seq >= objectiveDispatch.seq ||
      originalCaption.payload.inputItemId !== objectiveDispatch.payload.userInputItemId ||
      originalCaption.payload.transcriptSha256 !== objectiveDispatch.payload.taskInputSha256 ||
      createHash("sha256").update(originalTurn.content).digest("hex") !== originalCaption.payload.transcriptSha256 ||
      isSameGoalVoiceContinuation(originalTurn.content)) throw unavailable();
  for (const caption of [latestCaption, originalCaption]) {
    requireScopedEvent(caption, context, [session.ownerActorId], "voice.conversation.caption", `thread:${session.conversationId}`);
    if (caption.payload.conversationId !== session.conversationId || caption.payload.voiceSessionId !== session.sessionId ||
        caption.payload.nativeDeviceId !== session.nativeDeviceId || caption.payload.interrupted !== false ||
        caption.payload.provenance !== "client_observed_caption" || caption.payload.providerVerified !== false) throw unavailable();
  }
  for (const event of [source, objectiveDispatch]) {
    const claim = claims.find(item => item.payload.requestId === event.correlationId);
    if (!claim) throw unavailable();
    requireScopedEvent(claim, context, [session.ownerActorId], "voice.task.input",
      conversationVoiceStreamId({ ...context, actorId: session.ownerActorId }, session.sessionId));
    if (claim.seq >= event.seq || claim.correlationId !== event.correlationId ||
        claim.causationId !== event.payload.userTurnId || claim.payload.schemaVersion !== 1 ||
        claim.payload.conversationId !== session.conversationId || claim.payload.userTurnId !== event.payload.userTurnId ||
        claim.payload.userInputItemId !== event.payload.userInputItemId ||
        claim.payload.transcriptSha256 !== event.payload.taskInputSha256 ||
        claim.payload.provenance !== "client_observed_caption" || claim.payload.providerVerified !== false ||
        !(Date.parse(String(claim.payload.expiresAt)) >= Date.parse(String(event.payload.taskAuthorityExpiresAt)))) throw unavailable();
  }
  const requireActionApproval = source.payload.requireActionApproval === true ||
    objectiveDispatch.payload.requireActionApproval === true || priorContinuation?.requireActionApproval === true ||
    hasExplicitActionApprovalHold(originalTurn.content) || hasExplicitActionApprovalHold(latestInput.objective);
  const continuation = voiceTaskContinuationSchema.parse({
    sourceRunId, sourceRequestId: source.correlationId, objectiveRunId,
    objectiveRequestId: objectiveDispatch.correlationId,
    objectiveUserInputItemId: objectiveDispatch.payload.userInputItemId,
    objectiveUserTurnId: originalTurn.id, objectiveTranscriptSha256: originalCaption.payload.transcriptSha256,
    ...(requireActionApproval ? { requireActionApproval: true } : {}),
  });
  if (replayContinuation?.success && JSON.stringify(replayContinuation.data) !== JSON.stringify(continuation)) throw unavailable();
  return { sourceIdentity: identity, binding: voiceTaskBindingSchema.parse({
    ...latestInput, objective: originalTurn.content, continuation,
    expiresAt: new Date(Math.min(Date.parse(latestInput.expiresAt), Date.parse(session.expiresAt),
      Date.parse(String(source.payload.taskAuthorityExpiresAt)),
      Date.parse(String(objectiveDispatch.payload.taskAuthorityExpiresAt)))).toISOString(),
  }) };
}
