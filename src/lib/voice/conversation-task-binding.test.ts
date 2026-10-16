import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendDomainEvent, listRecentActorEvents } from "@/lib/events/store";
import { appendThreadTurn, createThread } from "@/lib/threads/store";
import { bindConversationVoiceTask, resolveConversationVoiceTaskInput, recordConversationVoiceClarification,
  type ConversationVoiceClarification, type ConversationVoiceSession } from "./conversation-session";
import type { SecurityContext } from "@/lib/security/types";

const context: SecurityContext = { tenantId: "voice-owner-tenant", actorId: "voice-owner", role: "admin",
  source: "mobile", native: { deviceId: "mac-device-1", platform: "macos" } };
beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "asael-voice-binding-"));
  delete process.env.DATABASE_URL;
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const thread = await createThread({ tenantId: context.tenantId, actorId: context.actorId, title: "Voice", mode: "orchestrate" });
  const session: ConversationVoiceSession = { schemaVersion: 2, sessionId: randomUUID(), conversationId: thread.id,
    ownerActorId: context.actorId, nativeDeviceId: context.native!.deviceId, agentName: "ATLAS", model: "gpt-realtime",
    credentialSource: "deployment_environment", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    commandContext: { agentId: "atlas", mode: "orchestrate", computerUseTarget: "local_macos", contextScope: "session", contextReferences: [] } };
  const userInputItemId = "human-audio-1";
  const text = "Open YouTube and play the first video on 2819's channel.";
  const turn = await appendThreadTurn({ tenantId: context.tenantId, threadId: thread.id, role: "user", content: text });
  const receipt = { schemaVersion: 2, conversationId: thread.id, voiceSessionId: session.sessionId,
    inputItemId: userInputItemId, nativeDeviceId: session.nativeDeviceId, turnId: turn.id, role: "user",
    provenance: "client_observed_caption", providerVerified: false, interrupted: false,
    transcriptCharacters: text.length, transcriptSha256: createHash("sha256").update(text).digest("hex") };
  await appendDomainEvent({ streamId: `thread:${thread.id}`, type: "voice.conversation_turn_saved",
    tenantId: context.tenantId, actorId: context.actorId, payload: receipt });
  return { session, userInputItemId, text, receipt, requestId: "voice-request-1", context };
}

describe("exact native voice task binding", () => {
  it.each(["new_hold", "prior_hold", "ordinary"])("persists a server-derived clarification hold without weakening it (%s)", async scenario => {
    const input = await fixture();
    const prior: ConversationVoiceClarification | undefined = scenario === "prior_hold" ? {
      schemaVersion: 1, sessionId: input.session.sessionId, conversationId: input.session.conversationId,
      questionId: randomUUID(), userTurnId: randomUUID(), answerTurnIds: [], agentId: "atlas",
      definitionSha256: "a".repeat(64), principalSha256: "b".repeat(64), requireActionApproval: true, prompt: "Earlier question",
    } : undefined;
    await recordConversationVoiceClarification({ context, session: input.session, requestId: "clarification-held",
      questionId: randomUUID(), userTurnId: input.receipt.turnId, agentId: "atlas", definitionSha256: "a".repeat(64),
      principalSha256: "b".repeat(64), prior, requireActionApproval: scenario === "new_hold" });
    const events = await listRecentActorEvents({ tenantId: context.tenantId, actorId: context.actorId,
      types: ["voice.clarification_requested"], since: new Date(Date.now() - 60_000),
      payloadMatch: { key: "sessionId", value: input.session.sessionId }, limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].payload.requireActionApproval).toBe(scenario === "ordinary" ? undefined : true);
  });
  it("reads a clarification caption without a task claim or duplicate persistence", async () => {
    const input = await fixture();
    expect(await resolveConversationVoiceTaskInput(input)).toMatchObject({ objective: input.text });
    const events = () => listRecentActorEvents({ tenantId: context.tenantId, actorId: context.actorId,
      types: ["voice.task_input_bound"], since: new Date(Date.now() - 60_000),
      payloadMatch: { key: "sessionId", value: input.session.sessionId }, limit: 10 });
    expect(await events()).toHaveLength(0);
    // A later real task can still make its one original immutable claim.
    await expect(bindConversationVoiceTask({ ...input, requestId: "actual-task" })).resolves.toMatchObject({ requestId: "actual-task" });
    expect(await events()).toHaveLength(1);
  });
  it("validates Asael-only speech for narrowing without giving it Mac task authority", async () => {
    const input = await fixture();
    input.session.commandContext.computerUseTarget = undefined;
    await expect(resolveConversationVoiceTaskInput(input)).resolves.toMatchObject({ objective: input.text });
    await expect(bindConversationVoiceTask(input)).resolves.toBeUndefined();
    expect(await listRecentActorEvents({ tenantId: context.tenantId, actorId: context.actorId,
      types: ["voice.task_input_bound"], since: new Date(Date.now() - 60_000),
      payloadMatch: { key: "sessionId", value: input.session.sessionId }, limit: 10 })).toHaveLength(0);
  });
  it("binds saved human text and retries one immutable task claim", async () => {
    const input = await fixture();
    const bound = await bindConversationVoiceTask(input);
    expect(bound).toMatchObject({ objective: input.text, userInputItemId: input.userInputItemId,
      tenantId: context.tenantId, actorId: context.actorId, requestId: input.requestId });
    expect(await bindConversationVoiceTask(input)).toEqual(bound);
    await expect(bindConversationVoiceTask({ ...input, requestId: "another-model-function" })).rejects.toMatchObject({ code: "voice_input_unverified" });
  });
  it("allows only one racing function claim for the same human input", async () => {
    const input = await fixture();
    const results = await Promise.allSettled([
      bindConversationVoiceTask(input), bindConversationVoiceTask({ ...input, requestId: "other-request" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it("never grants legacy, web, other device or another target the native exception", async () => {
    const input = await fixture();
    for (const changed of [
      { ...input, userInputItemId: undefined },
      { ...input, context: { ...context, source: "session" as const } },
      { ...input, context: { ...context, native: { deviceId: "different-device", platform: "macos" as const } } },
      { ...input, session: { ...input.session, nativeDeviceId: undefined } },
      { ...input, session: { ...input.session, commandContext: { ...input.session.commandContext, computerUseTarget: undefined } } },
    ]) expect(await bindConversationVoiceTask(changed)).toBeUndefined();
  });
  it("rejects a missing input, owner/tenant/session mismatch and stale caption", async () => {
    const input = await fixture();
    for (const changed of [
      { ...input, userInputItemId: "different-input" },
      { ...input, context: { ...context, tenantId: "other-tenant" } },
      { ...input, session: { ...input.session, ownerActorId: "other-owner" } },
      { ...input, session: { ...input.session, sessionId: randomUUID() } },
      { ...input, session: { ...input.session, conversationId: randomUUID() } },
    ]) await expect(bindConversationVoiceTask(changed)).rejects.toMatchObject({ code: "voice_input_unverified" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
    await expect(bindConversationVoiceTask(input)).rejects.toMatchObject({ code: "voice_input_unverified" });
  });
  it.each([
    { inputItemId: "newer-human-input" }, { transcriptSha256: "b".repeat(64) },
    { interrupted: true }, { turnId: randomUUID() }, { nativeDeviceId: "other-device" },
  ])("refuses superseded, mismatched and incomplete saved input (%#)", async changed => {
    const input = await fixture();
    await appendDomainEvent({ streamId: `thread:${input.session.conversationId}`, type: "voice.conversation_turn_saved",
      tenantId: context.tenantId, actorId: context.actorId, payload: { ...input.receipt, ...changed } });
    await expect(bindConversationVoiceTask(input)).rejects.toMatchObject({ code: "voice_input_unverified" });
  });
});
