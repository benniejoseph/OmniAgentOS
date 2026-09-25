import "server-only";

import { listRecentActorEvents, type DomainEvent } from "@/lib/events/store";

/**
 * How long a realtime voice session this server minted can still arrive as an
 * unmarked command. Sessions last at most ten minutes; the rest is review time.
 */
export const VOICE_COMMAND_SESSION_WINDOW_MS = 30 * 60_000;

const voiceLifecycleTypes = [
  "voice.realtime_started",
  "voice.realtime_reconnected",
  "voice.realtime_sent",
  "voice.realtime_canceled",
  "voice.realtime_failed",
] as const;
const voiceConsumptionTypes = [
  "voice.command_reviewed",
  "voice.command_inferred",
] as const;
const voiceOpenTypes: ReadonlySet<string> = new Set([
  "voice.realtime_started",
  "voice.realtime_reconnected",
]);
const voiceClosedTypes: ReadonlySet<string> = new Set([
  "voice.realtime_canceled",
  "voice.realtime_failed",
]);
const lifecycleReadLimit = 500;
const consumptionReadLimit = 500;
const maxInferredSessionIds = 16;
const voiceCorrelationPattern =
  /^voice:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type VoiceCommandGate =
  | Readonly<{ state: "none" }>
  | Readonly<{
      state: "declared";
      sessionId: string;
      /** Whether this server minted the declared session on this conversation. */
      sessionEvidence: "minted" | "not_found";
    }>
  | Readonly<{
      state: "inferred";
      /** Unconsumed sessions the unmarked command is assumed to come from. */
      sessionIds: readonly string[];
      inference: "pending_voice_session" | "voice_history_truncated";
    }>;

/**
 * Decides whether one agent command runs under the voice policy. A client can
 * declare reviewed voice input, but an unmarked command that arrives while
 * this server still holds an unconsumed realtime voice session on the same
 * conversation is treated as voice too, so an older or modified client cannot
 * skip forced approval by leaving the declaration out. A session is consumed
 * once a reviewed or inferred command event names it after its latest start or
 * reconnect; canceled and failed sessions never gate. The reads stay inside
 * the tenant and initiating actor, and any read failure is the caller's to
 * fail closed on.
 */
export async function resolveVoiceCommandGate(input: {
  tenantId: string;
  actorId: string;
  threadId?: string;
  declaredSessionId?: string;
  now?: Date;
}): Promise<VoiceCommandGate> {
  const threadId = input.threadId?.trim();
  const declaredSessionId = input.declaredSessionId?.trim().toLowerCase();
  if (!threadId) {
    return declaredSessionId
      ? { state: "declared", sessionId: declaredSessionId, sessionEvidence: "not_found" }
      : { state: "none" };
  }

  const now = (input.now ?? new Date()).getTime();
  const [lifecycle, consumption] = await Promise.all([
    listRecentActorEvents({
      tenantId: input.tenantId,
      actorId: input.actorId,
      types: voiceLifecycleTypes,
      since: new Date(now - VOICE_COMMAND_SESSION_WINDOW_MS),
      payloadMatch: { key: "conversationId", value: threadId },
      limit: lifecycleReadLimit,
    }),
    declaredSessionId
      ? Promise.resolve([] as DomainEvent[])
      : listRecentActorEvents({
          tenantId: input.tenantId,
          actorId: input.actorId,
          types: voiceConsumptionTypes,
          // A consumption always follows the start it consumes; the wider
          // window only absorbs clock skew between instances.
          since: new Date(now - 2 * VOICE_COMMAND_SESSION_WINDOW_MS),
          payloadMatch: { key: "threadId", value: threadId },
          limit: consumptionReadLimit,
        }),
  ]);

  const sessions = voiceSessionsFromLifecycle(lifecycle);
  if (declaredSessionId) {
    return {
      state: "declared",
      sessionId: declaredSessionId,
      sessionEvidence: (sessions.get(declaredSessionId)?.lastOpenSeq ?? 0) > 0
        ? "minted"
        : "not_found",
    };
  }

  const consumedThrough = new Map<string, number>();
  for (const event of consumption) {
    for (const sessionId of consumedVoiceSessionIds(event)) {
      consumedThrough.set(
        sessionId,
        Math.max(consumedThrough.get(sessionId) ?? 0, event.seq),
      );
    }
  }
  const pending = [...sessions.entries()]
    .filter(([sessionId, session]) =>
      !voiceClosedTypes.has(session.latestType) &&
      (consumedThrough.get(sessionId) ?? 0) <= session.lastOpenSeq
    )
    .sort(([, left], [, right]) => right.latestSeq - left.latestSeq)
    .slice(0, maxInferredSessionIds)
    .map(([sessionId]) => sessionId);

  if (pending.length) {
    return { state: "inferred", sessionIds: pending, inference: "pending_voice_session" };
  }
  // The newest-first read may have cut off an older session that is still
  // open, so a full page is treated as voice rather than guessed away.
  if (lifecycle.length >= lifecycleReadLimit) {
    return { state: "inferred", sessionIds: [], inference: "voice_history_truncated" };
  }
  return { state: "none" };
}

function voiceSessionsFromLifecycle(events: readonly DomainEvent[]) {
  const sessions = new Map<
    string,
    { latestSeq: number; latestType: string; lastOpenSeq: number }
  >();
  for (const event of events) {
    const sessionId = voiceCorrelationPattern
      .exec(event.correlationId || "")?.[1]
      ?.toLowerCase();
    if (!sessionId) continue;
    const session = sessions.get(sessionId) ?? {
      latestSeq: -1,
      latestType: "",
      lastOpenSeq: 0,
    };
    if (event.seq > session.latestSeq) {
      session.latestSeq = event.seq;
      session.latestType = event.type;
    }
    if (voiceOpenTypes.has(event.type)) {
      session.lastOpenSeq = Math.max(session.lastOpenSeq, event.seq);
    }
    sessions.set(sessionId, session);
  }
  return sessions;
}

function consumedVoiceSessionIds(event: DomainEvent): string[] {
  const values = event.type === "voice.command_reviewed"
    ? [event.payload.voiceSessionId]
    : Array.isArray(event.payload.voiceSessionIds)
      ? event.payload.voiceSessionIds
      : [];
  return values
    .filter((value): value is string =>
      typeof value === "string" && uuidPattern.test(value)
    )
    .map((value) => value.toLowerCase());
}
