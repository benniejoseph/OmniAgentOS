import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-voice-gate-"));
  delete process.env.DATABASE_URL;
});

const tenantId = "tenant-voice";
const actorId = "owner@example.test";

async function seedLifecycle(input: {
  type: string;
  sessionId: string;
  threadId: string;
  tenantId?: string;
  actorId?: string;
}) {
  const { appendDomainEvent } = await import("@/lib/events/store");
  return appendDomainEvent({
    streamId: `voice:scoped:${input.sessionId}`,
    type: input.type,
    tenantId: input.tenantId ?? tenantId,
    actorId: input.actorId ?? actorId,
    correlationId: `voice:${input.sessionId}`,
    payload: { schemaVersion: 1, conversationId: input.threadId },
  });
}

async function seedCommand(
  type: "voice.command_reviewed" | "voice.command_inferred",
  threadId: string,
  sessionIds: string[],
) {
  const { appendDomainEvent } = await import("@/lib/events/store");
  return appendDomainEvent({
    streamId: `thread:${threadId}`,
    type,
    tenantId,
    actorId,
    correlationId: randomUUID(),
    payload: type === "voice.command_reviewed"
      ? { schemaVersion: 1, threadId, voiceSessionId: sessionIds[0] }
      : { schemaVersion: 1, threadId, voiceSessionIds: sessionIds },
  });
}

async function gateFor(threadId: string | undefined, options: {
  declaredSessionId?: string;
  actorId?: string;
  now?: Date;
} = {}) {
  const { resolveVoiceCommandGate } = await import("@/lib/voice/command-gate");
  return resolveVoiceCommandGate({
    tenantId,
    actorId: options.actorId ?? actorId,
    threadId,
    declaredSessionId: options.declaredSessionId,
    now: options.now,
  });
}

describe("voice command gate", () => {
  it("infers voice for open and sent sessions on the same conversation", async () => {
    const threadId = randomUUID();
    const open = randomUUID();
    const sent = randomUUID();
    await seedLifecycle({ type: "voice.realtime_started", sessionId: open, threadId });
    await seedLifecycle({ type: "voice.realtime_started", sessionId: sent, threadId });
    await seedLifecycle({ type: "voice.realtime_sent", sessionId: sent, threadId });

    await expect(gateFor(threadId)).resolves.toEqual({
      state: "inferred",
      sessionIds: [sent, open],
      inference: "pending_voice_session",
    });
  });

  it("never gates on canceled or failed sessions", async () => {
    const threadId = randomUUID();
    const canceled = randomUUID();
    const failed = randomUUID();
    await seedLifecycle({ type: "voice.realtime_started", sessionId: canceled, threadId });
    await seedLifecycle({ type: "voice.realtime_canceled", sessionId: canceled, threadId });
    await seedLifecycle({ type: "voice.realtime_started", sessionId: failed, threadId });
    await seedLifecycle({ type: "voice.realtime_failed", sessionId: failed, threadId });

    await expect(gateFor(threadId)).resolves.toEqual({ state: "none" });
  });

  it("treats a session as consumed once a reviewed or inferred command names it", async () => {
    const reviewedThread = randomUUID();
    const reviewed = randomUUID();
    await seedLifecycle({ type: "voice.realtime_started", sessionId: reviewed, threadId: reviewedThread });
    await seedLifecycle({ type: "voice.realtime_sent", sessionId: reviewed, threadId: reviewedThread });
    await seedCommand("voice.command_reviewed", reviewedThread, [reviewed]);
    await expect(gateFor(reviewedThread)).resolves.toEqual({ state: "none" });

    const inferredThread = randomUUID();
    const inferred = randomUUID();
    await seedLifecycle({ type: "voice.realtime_started", sessionId: inferred, threadId: inferredThread });
    await seedCommand("voice.command_inferred", inferredThread, [inferred]);
    await seedLifecycle({ type: "voice.realtime_sent", sessionId: inferred, threadId: inferredThread });
    await expect(gateFor(inferredThread)).resolves.toEqual({ state: "none" });

    const otherThread = randomUUID();
    const unconsumed = randomUUID();
    await seedLifecycle({ type: "voice.realtime_started", sessionId: unconsumed, threadId: otherThread });
    await seedCommand("voice.command_reviewed", randomUUID(), [unconsumed]);
    await expect(gateFor(otherThread)).resolves.toMatchObject({
      state: "inferred",
      sessionIds: [unconsumed],
    });
  });

  it("re-arms a consumed session when it reconnects", async () => {
    const threadId = randomUUID();
    const sessionId = randomUUID();
    await seedLifecycle({ type: "voice.realtime_started", sessionId, threadId });
    await seedCommand("voice.command_inferred", threadId, [sessionId]);
    await seedLifecycle({ type: "voice.realtime_reconnected", sessionId, threadId });

    await expect(gateFor(threadId)).resolves.toEqual({
      state: "inferred",
      sessionIds: [sessionId],
      inference: "pending_voice_session",
    });
  });

  it("ignores other conversations, actors, tenants, and sessions outside the window", async () => {
    const threadId = randomUUID();
    await seedLifecycle({ type: "voice.realtime_started", sessionId: randomUUID(), threadId: randomUUID() });
    await seedLifecycle({ type: "voice.realtime_started", sessionId: randomUUID(), threadId, actorId: "sibling@example.test" });
    await seedLifecycle({ type: "voice.realtime_started", sessionId: randomUUID(), threadId, tenantId: "tenant-other" });
    await expect(gateFor(threadId)).resolves.toEqual({ state: "none" });

    const staleThread = randomUUID();
    await seedLifecycle({ type: "voice.realtime_sent", sessionId: randomUUID(), threadId: staleThread });
    const { VOICE_COMMAND_SESSION_WINDOW_MS } = await import("@/lib/voice/command-gate");
    await expect(gateFor(staleThread, {
      now: new Date(Date.now() + VOICE_COMMAND_SESSION_WINDOW_MS + 60_000),
    })).resolves.toEqual({ state: "none" });
    await expect(gateFor(staleThread)).resolves.toMatchObject({ state: "inferred" });
  });

  it("records whether a declared session was minted on the conversation", async () => {
    const threadId = randomUUID();
    const minted = randomUUID();
    const elsewhere = randomUUID();
    await seedLifecycle({ type: "voice.realtime_started", sessionId: minted, threadId });
    await seedLifecycle({ type: "voice.realtime_sent", sessionId: minted, threadId });
    await seedLifecycle({ type: "voice.realtime_started", sessionId: elsewhere, threadId: randomUUID() });

    await expect(gateFor(threadId, { declaredSessionId: minted.toUpperCase() }))
      .resolves.toEqual({ state: "declared", sessionId: minted, sessionEvidence: "minted" });
    await expect(gateFor(threadId, { declaredSessionId: elsewhere }))
      .resolves.toEqual({ state: "declared", sessionId: elsewhere, sessionEvidence: "not_found" });
    await expect(gateFor(threadId, { declaredSessionId: minted, actorId: "sibling@example.test" }))
      .resolves.toEqual({ state: "declared", sessionId: minted, sessionEvidence: "not_found" });
  });

  it("fails closed when the lifecycle page is full", async () => {
    const threadId = randomUUID();
    for (let index = 0; index < 250; index += 1) {
      const sessionId = randomUUID();
      await seedLifecycle({ type: "voice.realtime_started", sessionId, threadId });
      await seedLifecycle({ type: "voice.realtime_canceled", sessionId, threadId });
    }

    await expect(gateFor(threadId)).resolves.toEqual({
      state: "inferred",
      sessionIds: [],
      inference: "voice_history_truncated",
    });
  });

  it("stays out of commands without a conversation", async () => {
    await expect(gateFor(undefined)).resolves.toEqual({ state: "none" });
    const sessionId = randomUUID();
    await expect(gateFor(undefined, { declaredSessionId: sessionId }))
      .resolves.toEqual({ state: "declared", sessionId, sessionEvidence: "not_found" });
  });
});
