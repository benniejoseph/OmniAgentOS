import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { appendScopedDomainEvent, listRecentActorEvents } from "@/lib/events/store";
import { findAgentRunWaitingForToolApproval } from "@/lib/runs/store";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { listThreadTurns } from "@/lib/threads/store";
import { getToolExecutionApprovalFingerprint, openToolExecutionInput } from "@/lib/tools/audit-store";
import { approvalSha256 } from "@/lib/tools/approval-events";
import { toolApprovalExpired } from "@/lib/tools/approval-expiry";
import type { ToolExecutionRecord } from "@/lib/tools/types";
import { conversationVoiceStreamId, requireActiveConversationVoiceSession, VoiceConversationError } from "@/lib/voice/conversation-session";
import { verbalApprovalDecision, type VoiceApprovalProof, type VoiceApprovalReview } from "@/lib/voice/verbal-approval";

const REVIEW_AGE_MS = 90_000;
const fail = () => new VoiceConversationError("voice_approval_needs_review",
  "This spoken decision could not be matched to the current action. Review the action again, then say approve this action or reject this action.", 409);

export function voiceApprovalActionSha256(record: ToolExecutionRecord) {
  return approvalSha256({ domain: "asael.voice.approval-action.v1", executionId: record.id,
    tenantId: record.tenantId, actorId: record.actorId, toolId: record.toolId,
    input: openToolExecutionInput(record), fingerprint: getToolExecutionApprovalFingerprint(record) ?? null,
    riskLevel: record.riskLevel, dryRun: record.dryRun, createdAt: record.createdAt });
}

async function requireVoiceApprovalScope(context: SecurityContext, record: ToolExecutionRecord,
  input: Pick<VoiceApprovalProof, "sessionId" | "conversationId" | "runId">) {
  if (!context.auth?.sessionId || !["mobile", "session"].includes(context.source) ||
      record.tenantId !== context.tenantId || record.status !== "approval_required" || toolApprovalExpired(record)) throw fail();
  const session = await requireActiveConversationVoiceSession({ context, sessionId: input.sessionId, conversationId: input.conversationId });
  const run = await findAgentRunWaitingForToolApproval(record.id, { tenantId: context.tenantId });
  if (!run || run.id !== input.runId || run.status !== "waiting_approval" || run.threadId !== input.conversationId ||
      ![context.actorId, session.ownerActorId].includes(run.ownerActorId) ||
      ![context.actorId, session.ownerActorId].includes(record.actorId || "") ||
      run.continuation?.pendingToolCall.executionId !== record.id) throw fail();
  const dispatched = await listRecentActorEvents({ tenantId: context.tenantId, actorId: run.ownerActorId,
    types: ["voice.command_dispatched"], since: new Date(Date.now() - 30 * 60_000),
    payloadMatch: { key: "voiceSessionId", value: session.sessionId }, limit: 100 });
  if (!dispatched.some(event => event.tenantId === context.tenantId && event.actorId === run.ownerActorId &&
      event.payload.threadId === input.conversationId && event.payload.submission === "continuous_conversation" &&
      event.correlationId === run.continuation?.executionScope?.causationId)) throw fail();
  return { session, owner: { ...context, actorId: session.ownerActorId }, actionSha256: voiceApprovalActionSha256(record) };
}

function sessionBinding(context: SecurityContext) {
  return approvalSha256({ actorId: context.actorId, sessionId: context.auth?.sessionId,
    source: context.source, deviceId: context.native?.deviceId ?? null });
}

/** Called only after the client has rendered the exact prepare response. This
 * is a client presentation attestation, never proof of attention or identity. */
export async function prepareVoiceApprovalReview(context: SecurityContext, record: ToolExecutionRecord, input: VoiceApprovalReview) {
  const { session, owner, actionSha256 } = await requireVoiceApprovalScope(context, record, input);
  if (input.operation === "prepare") return { actionSha256 };
  if (input.actionSha256 !== actionSha256) throw fail();
  const presentationId = randomUUID();
  const expiresAt = new Date(Math.min(Date.now() + REVIEW_AGE_MS, Date.parse(session.expiresAt))).toISOString();
  const event = await appendScopedDomainEvent({
    id: presentationId, streamId: conversationVoiceStreamId(owner, session.sessionId), type: "voice.approval_presented",
    executionScope: executionScopeFromSecurityContext(owner, { correlationId: input.runId, causationId: record.id, purpose: "voice.approval.present" }),
    payload: { schemaVersion: 1, sessionId: session.sessionId, conversationId: input.conversationId, runId: input.runId,
      executionId: record.id, actionSha256, requestSessionSha256: sessionBinding(context), expiresAt,
      presentation: "client_visible_action", providerVerified: false },
  });
  return { presentationId, actionSha256, expiresAt, presentedAt: event.at };
}

/** Authenticated client-observed microphone captions are not voice biometrics.
 * The model supplies none of this evidence; ordinary approval gates still run. */
export async function bindVerbalApprovalDecision(context: SecurityContext, record: ToolExecutionRecord,
  input: VoiceApprovalProof, decision: "approve" | "reject") {
  const { session, owner, actionSha256 } = await requireVoiceApprovalScope(context, record, input);
  const reviews = await listRecentActorEvents({ tenantId: context.tenantId, actorId: session.ownerActorId,
    types: ["voice.approval_presented"], since: new Date(Date.now() - REVIEW_AGE_MS),
    payloadMatch: { key: "sessionId", value: session.sessionId }, limit: 100 });
  const presented = reviews.sort((a, b) => b.seq - a.seq)[0];
  if (!presented || presented.tenantId !== context.tenantId || presented.actorId !== session.ownerActorId ||
      presented.id !== input.presentationId || presented.payload.executionId !== record.id ||
      presented.payload.actionSha256 !== actionSha256 || presented.payload.runId !== input.runId ||
      presented.payload.conversationId !== input.conversationId ||
      presented.payload.requestSessionSha256 !== sessionBinding(context) ||
      !(Date.parse(String(presented.payload.expiresAt)) > Date.now())) throw fail();
  const captions = await listRecentActorEvents({ tenantId: context.tenantId, actorId: session.ownerActorId,
    types: ["voice.conversation_turn_saved"], since: new Date(Date.now() - REVIEW_AGE_MS),
    payloadMatch: { key: "voiceSessionId", value: session.sessionId }, limit: 100 });
  const caption = captions.filter(event => event.payload.role === "user").sort((a, b) => b.seq - a.seq)[0];
  const humanTurnsAfterReview = captions.filter(event => event.payload.role === "user" && event.seq > presented.seq);
  if (humanTurnsAfterReview.length !== 1 || !caption || caption.tenantId !== context.tenantId || caption.actorId !== session.ownerActorId ||
      caption.seq <= presented.seq || caption.payload.inputItemId !== input.userInputItemId ||
      caption.payload.conversationId !== input.conversationId || caption.payload.interrupted !== false ||
      caption.payload.provenance !== "client_observed_caption" || caption.payload.providerVerified !== false ||
      (session.nativeDeviceId && caption.payload.nativeDeviceId !== session.nativeDeviceId)) throw fail();
  const turns = await listThreadTurns(input.conversationId, { tenantId: context.tenantId, limit: 100 });
  const turn = turns.find(turn => turn.id === caption.payload.turnId && turn.role === "user");
  // Caption hashes use raw SHA-256, rather than the canonical JSON digest.
  if (!turn || createHash("sha256").update(turn.content).digest("hex") !== caption.payload.transcriptSha256 ||
      verbalApprovalDecision(turn.content) !== decision) throw fail();
  const idempotencyKey = `voice-approval:${approvalSha256([context.tenantId, context.actorId, input.sessionId, input.presentationId])}`;
  try {
    await appendScopedDomainEvent({ id: idempotencyKey,
      streamId: conversationVoiceStreamId(owner, session.sessionId), type: "voice.approval_input_bound",
      executionScope: executionScopeFromSecurityContext(owner, { correlationId: input.runId, causationId: record.id, purpose: "voice.approval.input" }),
      payload: { schemaVersion: 1, sessionId: session.sessionId, conversationId: input.conversationId,
        runId: input.runId, executionId: record.id, presentationId: input.presentationId,
        actionSha256, userInputItemId: input.userInputItemId, userTurnId: turn.id,
        transcriptSha256: caption.payload.transcriptSha256, decision,
        provenance: "authenticated_client_microphone_caption", providerVerified: false },
    });
  } catch { throw fail(); }
  return idempotencyKey;
}
