import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@/lib/events/store";
import type { SecurityContext } from "@/lib/security/types";
import type { AgentRunRecord } from "@/lib/runs/types";
import type { ToolExecutionRecord } from "@/lib/tools/types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/events/store", () => ({ appendScopedDomainEvent: vi.fn(), listRecentActorEvents: vi.fn() }));
vi.mock("@/lib/runs/store", () => ({ findAgentRunWaitingForToolApproval: vi.fn() }));
vi.mock("@/lib/threads/store", () => ({ listThreadTurns: vi.fn() }));
vi.mock("@/lib/tools/audit-store", () => ({ getToolExecutionApprovalFingerprint: vi.fn(() => "contract"), openToolExecutionInput: vi.fn(record => record.input) }));
vi.mock("@/lib/voice/conversation-session", () => ({
  requireActiveConversationVoiceSession: vi.fn(), conversationVoiceStreamId: vi.fn(() => "voice-stream"),
  VoiceConversationError: class extends Error { constructor(readonly code: string, message: string, readonly status: number) { super(message); } },
}));
import { appendScopedDomainEvent, listRecentActorEvents } from "@/lib/events/store";
import { findAgentRunWaitingForToolApproval } from "@/lib/runs/store";
import { listThreadTurns } from "@/lib/threads/store";
import { requireActiveConversationVoiceSession } from "@/lib/voice/conversation-session";
import { bindVerbalApprovalDecision, prepareVoiceApprovalReview, voiceApprovalActionSha256 } from "./verbal-approval-server";

const context: SecurityContext = { tenantId: "tenant", actorId: "owner", source: "mobile", role: "admin",
  auth: { userId: "user", email: "owner@example.test", sessionId: "signed-in-session", tenantName: "Test" },
  native: { platform: "macos", deviceId: "mac" } };
const sessionId = "11111111-1111-4111-8111-111111111111", conversationId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const scope = { sessionId, conversationId, runId };
let record: ToolExecutionRecord;
let events: DomainEvent[];
let turns: Awaited<ReturnType<typeof listThreadTurns>>;
let run: AgentRunRecord;
let seq: number;
beforeEach(() => {
  vi.clearAllMocks(); seq = 1; events = []; turns = [];
  record = { id: "execution", tenantId: "tenant", actorId: "owner", toolId: "test.send", toolName: "Send", riskLevel: 2,
    input: { recipient: "client@example.test", message: "Reviewed message" }, status: "approval_required", dryRun: false,
    approvalRequired: true, createdAt: new Date().toISOString() };
  run = { id: runId, tenantId: "tenant", ownerActorId: "owner", threadId: conversationId, status: "waiting_approval",
    continuation: { pendingToolCall: { executionId: "execution" }, executionScope: { causationId: "voice-request" } },
  } as AgentRunRecord;
  events.push({ id: "dispatch", streamId: "thread:test", seq: seq++, tenantId: "tenant", actorId: "owner", type: "voice.command_dispatched", at: new Date().toISOString(),
    correlationId: "voice-request", payload: { voiceSessionId: sessionId, threadId: conversationId, submission: "continuous_conversation" } } as DomainEvent);
  vi.mocked(requireActiveConversationVoiceSession).mockResolvedValue({ sessionId, conversationId, ownerActorId: "owner",
    nativeDeviceId: "mac", expiresAt: new Date(Date.now() + 600000).toISOString() } as Awaited<ReturnType<typeof requireActiveConversationVoiceSession>>);
  vi.mocked(findAgentRunWaitingForToolApproval).mockImplementation(async () => run);
  vi.mocked(listRecentActorEvents).mockImplementation(async input => events.filter(event => input.types.includes(event.type) &&
    (!input.payloadMatch || event.payload[input.payloadMatch.key] === input.payloadMatch.value)).sort((a, b) => b.seq - a.seq));
  vi.mocked(listThreadTurns).mockImplementation(async () => turns);
  vi.mocked(appendScopedDomainEvent).mockImplementation(async input => {
    const event = { ...input, id: input.id!, seq: seq++, tenantId: input.executionScope.tenantId,
      actorId: input.executionScope.initiatingActorId!, at: new Date().toISOString(), payload: input.payload! };
    const old = events.find(value => value.id === input.id);
    if (old) {
      if (JSON.stringify(old.payload) !== JSON.stringify(event.payload)) throw new Error("Receipt already consumed");
      return old;
    }
    events.push(event); return event;
  });
});
async function present() {
  const prepared = await prepareVoiceApprovalReview(context, record, { ...scope, operation: "prepare" });
  return (await prepareVoiceApprovalReview(context, record, { ...scope, operation: "present", actionSha256: prepared.actionSha256 })).presentationId!;
}
function caption(text = "approve this action", itemId = "human", role = "user") {
  const turnId = `turn-${itemId}`;
  turns.push({ id: turnId, role, content: text } as (typeof turns)[number]);
  events.push({ id: `caption-${itemId}`, streamId: "thread:test", seq: seq++, tenantId: "tenant", actorId: "owner", type: "voice.conversation_turn_saved", at: new Date().toISOString(),
    payload: { voiceSessionId: sessionId, conversationId, role, inputItemId: itemId, turnId, nativeDeviceId: "mac",
      interrupted: false, provenance: "client_observed_caption", providerVerified: false,
      transcriptSha256: createHash("sha256").update(text).digest("hex") } } as DomainEvent);
}
describe("verbal approval receipt binding", () => {
  it.each([["yes", "approve"], ["reject this action", "reject"]] as const)("binds %s to one exact action without executing it", async (text, decision) => {
    const presentationId = await present(); caption(text);
    const key = await bindVerbalApprovalDecision(context, record, { ...scope, presentationId, userInputItemId: "human" }, decision);
    expect(key).toMatch(/^voice-approval:[a-f0-9]{64}$/);
    expect(events.at(-1)?.payload).toMatchObject({ decision, executionId: "execution", actionSha256: voiceApprovalActionSha256(record),
      provenance: "authenticated_client_microphone_caption", providerVerified: false });
    expect(record.status).toBe("approval_required");
  });
  it("prepare has no presentation side effect", async () => {
    await prepareVoiceApprovalReview(context, record, { ...scope, operation: "prepare" });
    expect(appendScopedDomainEvent).not.toHaveBeenCalled();
  });
  it.each(["changed-input", "changed-contract-time", "other-run", "other-owner", "other-auth-session", "other-device", "expired", "already-decided", "different-call"]) ("refuses %s", async failure => {
    const presentationId = await present(); caption();
    const changedContext = structuredClone(context);
    if (failure === "changed-input") record.input.message = "Unreviewed message";
    if (failure === "changed-contract-time") record.createdAt = new Date(Date.now() - 1000).toISOString();
    if (failure === "other-run") run.id = "different";
    if (failure === "other-owner") record.actorId = "intruder";
    if (failure === "other-auth-session") changedContext.auth!.sessionId = "different";
    if (failure === "other-device") changedContext.native!.deviceId = "other-mac";
    if (failure === "expired") events.find(event => event.id === presentationId)!.payload.expiresAt = new Date(Date.now() - 1).toISOString();
    if (failure === "already-decided") record.status = "executed";
    if (failure === "different-call") events[0].payload.voiceSessionId = "other-call";
    await expect(bindVerbalApprovalDecision(changedContext, record, { ...scope, presentationId, userInputItemId: "human" }, "approve")).rejects.toThrow();
    expect(events.some(event => event.type === "voice.approval_input_bound")).toBe(false);
  });
  it.each(["assistant", "ambiguous", "old-caption", "newer-caption", "edited-caption", "new-review", "wrong-decision", "interrupted"]) ("refuses %s evidence", async failure => {
    if (failure === "old-caption") caption();
    const presentationId = await present();
    if (failure !== "old-caption") caption(failure === "ambiguous" ? "yes to both" : "yes", "human", failure === "assistant" ? "assistant" : "user");
    if (failure === "newer-caption") caption("no", "later");
    if (failure === "edited-caption") turns[0].content = "approve";
    if (failure === "new-review") await present();
    if (failure === "interrupted") events.at(-1)!.payload.interrupted = true;
    await expect(bindVerbalApprovalDecision(context, record, { ...scope, presentationId, userInputItemId: "human" }, failure === "wrong-decision" ? "reject" : "approve")).rejects.toThrow();
    expect(events.some(event => event.type === "voice.approval_input_bound")).toBe(false);
  });
  it("one receipt cannot bind a second caption or changed decision", async () => {
    const presentationId = await present(); caption("yes");
    const proof = { ...scope, presentationId, userInputItemId: "human" };
    const key = await bindVerbalApprovalDecision(context, record, proof, "approve");
    expect(await bindVerbalApprovalDecision(context, record, proof, "approve")).toBe(key);
    caption("no", "second");
    await expect(bindVerbalApprovalDecision(context, record, { ...proof, userInputItemId: "second" }, "reject")).rejects.toThrow();
    expect(events.filter(event => event.type === "voice.approval_input_bound")).toHaveLength(1);
  });
  it("an intervening changed instruction invalidates a later yes on the server", async () => {
    const presentationId = await present();
    caption("Wait, change the recipient to Bob", "change"); caption("yes", "later");
    await expect(bindVerbalApprovalDecision(context, record, { ...scope, presentationId, userInputItemId: "later" }, "approve")).rejects.toThrow();
    expect(events.some(event => event.type === "voice.approval_input_bound")).toBe(false);
  });
  it("uses the real append-only store to make duplicate binding idempotent and reject conflicting input", async () => {
    const presentationId = await present(); caption("yes");
    const dir = await mkdtemp(path.join(tmpdir(), "asael-voice-approval-"));
    vi.stubEnv("OMNIAGENT_DATA_DIR", dir); vi.stubEnv("DATABASE_URL", "");
    try {
      const store = await vi.importActual<typeof import("@/lib/events/store")>("@/lib/events/store");
      vi.mocked(appendScopedDomainEvent).mockImplementation(store.appendScopedDomainEvent);
      const proof = { ...scope, presentationId, userInputItemId: "human" };
      const [first, replay] = await Promise.all([
        bindVerbalApprovalDecision(context, record, proof, "approve"),
        bindVerbalApprovalDecision(context, record, proof, "approve"),
      ]);
      expect(first).toBe(replay);
      const actual = await store.listStreamEvents("voice-stream", { tenantId: context.tenantId });
      expect(actual).toHaveLength(1);
      await expect(store.appendScopedDomainEvent({ id: actual[0].id, streamId: actual[0].streamId,
        type: actual[0].type, executionScope: actual[0].executionScope!,
        payload: { ...actual[0].payload, decision: "reject" } })).rejects.toThrow("already bound");
    } finally { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
  });
  it("requires the still-active session and its exact voice run", async () => {
    const presentationId = await present(); caption();
    vi.mocked(requireActiveConversationVoiceSession).mockRejectedValue(new Error("ended"));
    await expect(bindVerbalApprovalDecision(context, record, { ...scope, presentationId, userInputItemId: "human" }, "approve")).rejects.toThrow();
  });
});
