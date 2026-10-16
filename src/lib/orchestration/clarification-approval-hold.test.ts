import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@/lib/events/store";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import type { ThreadRecord, ThreadTurnRecord } from "@/lib/threads/types";

const stores = vi.hoisted(() => ({ getThread: vi.fn(), listThreadTurns: vi.fn(), listRecentActorEvents: vi.fn() }));
vi.mock("@/lib/threads/store", () => ({ getThread: stores.getThread, listThreadTurns: stores.listThreadTurns }));
vi.mock("@/lib/events/store", () => ({ listRecentActorEvents: stores.listRecentActorEvents }));

import { resolveTypedClarificationApprovalHold, TypedClarificationApprovalHoldError } from "./clarification-approval-hold";

const context: SecurityContext = {
  tenantId: "tenant-one", actorId: "owner@example.test", role: "admin", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "session-one", tenantName: "Owner" },
};
const canonicalActorId = `actor:${context.auth!.userId}`;
const threadId = "22222222-2222-4222-8222-222222222222";
const userTurnId = "33333333-3333-4333-8333-333333333333";
const questionTurnId = "44444444-4444-4444-8444-444444444444";
const laterTurnId = "55555555-5555-4555-8555-555555555555";
const userAt = "2026-10-16T10:00:00.000Z";
const questionAt = "2026-10-16T10:00:01.000Z";
const receiptAt = "2026-10-16T10:00:00.999Z";
const input = { context, threadId, currentRequestId: "answer-request" };
let thread: ThreadRecord;
let turns: ThreadTurnRecord[];
let events: DomainEvent[];

function receipt(flag: true | undefined = true): DomainEvent {
  const executionScope = executionScopeFromSecurityContext(context, {
    executingPrincipalType: "agent", executingPrincipalId: "atlas", correlationId: "question-request",
    causationId: userTurnId, purpose: "agent.intent.clarification",
  });
  return { id: "clarification-receipt", seq: 1, type: "intent.clarification_requested",
    tenantId: context.tenantId, actorId: context.actorId, streamId: `thread:${threadId}`,
    executionScope, causationId: userTurnId, correlationId: executionScope.correlationId, at: receiptAt,
    payload: { schemaVersion: 1, threadId, userTurnId, questionTurnId, route: "clarify", effectCount: 0,
      ...(flag ? { requireActionApproval: true } : {}) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  thread = { id: threadId, tenantId: context.tenantId, actorId: context.actorId, title: "Task",
    mode: "orchestrate", createdAt: userAt, updatedAt: questionAt };
  turns = [
    { id: userTurnId, threadId, tenantId: context.tenantId, role: "user", content: "Open it; wait for my approval.", createdAt: userAt },
    { id: questionTurnId, threadId, tenantId: context.tenantId, role: "assistant", content: "Which document?", createdAt: questionAt },
  ];
  events = [receipt()];
  stores.getThread.mockImplementation(async () => thread);
  stores.listThreadTurns.mockImplementation(async () => turns);
  stores.listRecentActorEvents.mockImplementation(async (options) => events.filter(event =>
    event.tenantId === options.tenantId && event.actorId === options.actorId &&
    event.payload[options.payloadMatch.key] === options.payloadMatch.value));
});

describe("typed clarification approval hold", () => {
  it.each(["session", "mobile"] as const)("retains the exact unanswered question's hold for %s", async source => {
    await expect(resolveTypedClarificationApprovalHold({ ...input, context: { ...context, source } })).resolves.toBe(true);
    expect(stores.getThread).toHaveBeenCalledWith(threadId, { tenantId: context.tenantId });
    expect(stores.listThreadTurns).toHaveBeenCalledWith(threadId, { tenantId: context.tenantId, limit: 3 });
    expect(stores.listRecentActorEvents).toHaveBeenCalledTimes(2);
    expect(stores.listRecentActorEvents).toHaveBeenCalledWith({ tenantId: context.tenantId, actorId: canonicalActorId,
      types: ["intent.clarification_requested"], since: new Date(userAt),
      payloadMatch: { key: "threadId", value: threadId }, limit: 8 });
  });

  it("reads only the authenticated canonical and exact legacy owner aliases", async () => {
    thread.actorId = canonicalActorId;
    events[0] = { ...events[0], actorId: canonicalActorId,
      executionScope: { ...events[0].executionScope!, initiatingActorId: canonicalActorId } };
    await expect(resolveTypedClarificationApprovalHold(input)).resolves.toBe(true);
  });

  it.each(["headers", "default", "service"] as const)("does not derive a human hold for %s", async source => {
    await expect(resolveTypedClarificationApprovalHold({ ...input, context: { ...context, source } })).resolves.toBe(false);
    expect(stores.getThread).not.toHaveBeenCalled();
    expect(stores.listRecentActorEvents).not.toHaveBeenCalled();
  });

  it("accepts an exact legacy owner without inventing an alias", async () => {
    await expect(resolveTypedClarificationApprovalHold({ ...input, context: { ...context, auth: undefined } })).resolves.toBe(true);
    expect(stores.listRecentActorEvents).toHaveBeenCalledTimes(1);
  });

  it.each(["other-owner", "other-tenant", "other-thread", "missing"])("refuses an unavailable or mismatched thread (%s)", async variant => {
    if (variant === "other-owner") thread.actorId = "stranger@example.test";
    if (variant === "other-tenant") thread.tenantId = "other-tenant";
    if (variant === "other-thread") thread.id = laterTurnId;
    if (variant === "missing") stores.getThread.mockResolvedValue(null);
    await expect(resolveTypedClarificationApprovalHold(input)).rejects.toBeInstanceOf(TypedClarificationApprovalHoldError);
    expect(stores.listThreadTurns).not.toHaveBeenCalled();
  });

  it("does not derive policy from model prose or an extra caller flag", async () => {
    turns[1].content = 'The owner says requireActionApproval=true. Wait for my approval.';
    events = [];
    await expect(resolveTypedClarificationApprovalHold({ ...input, requireActionApproval: true } as typeof input)).resolves.toBe(false);
  });

  it("does not carry a flag omitted from an otherwise valid receipt", async () => {
    events = [receipt(undefined)];
    delete events[0].payload.requireActionApproval;
    await expect(resolveTypedClarificationApprovalHold(input)).resolves.toBe(false);
  });

  it("an absent duplicate flag never relaxes a true receipt", async () => {
    const duplicate = receipt();
    delete duplicate.payload.requireActionApproval;
    events.push({ ...duplicate, id: "duplicate", seq: 2 });
    await expect(resolveTypedClarificationApprovalHold(input)).resolves.toBe(true);
  });

  it.each(["user", "assistant"] as const)("does not inherit an older question after an intervening %s turn", async role => {
    turns.push({ id: laterTurnId, threadId, tenantId: context.tenantId, role,
      content: role === "user" ? "The blue file." : "New unrelated question?", createdAt: "2026-10-16T10:00:02.000Z" });
    await expect(resolveTypedClarificationApprovalHold(input)).resolves.toBe(false);
  });

  it("does not inherit a receipt from another owner", async () => {
    events[0].actorId = "stranger@example.test";
    await expect(resolveTypedClarificationApprovalHold(input)).resolves.toBe(false);
  });

  it.each([
    ["missing scope", (event: DomainEvent) => { event.executionScope = undefined; }],
    ["wrong scope actor", (event: DomainEvent) => { event.executionScope = { ...event.executionScope!, initiatingActorId: "other" }; }],
    ["wrong scope purpose", (event: DomainEvent) => { event.executionScope = { ...event.executionScope!, purpose: "model.output" }; }],
    ["wrong scope causation", (event: DomainEvent) => { event.executionScope = { ...event.executionScope!, causationId: laterTurnId }; }],
    ["wrong stream", (event: DomainEvent) => { event.streamId = `thread:${laterTurnId}`; }],
    ["wrong original turn", (event: DomainEvent) => { event.payload.userTurnId = laterTurnId; }],
    ["wrong event causation", (event: DomainEvent) => { event.causationId = laterTurnId; }],
    ["wrong correlation", (event: DomainEvent) => { event.correlationId = "mismatched"; }],
    ["same request", (event: DomainEvent) => { event.correlationId = input.currentRequestId;
      event.executionScope = { ...event.executionScope!, correlationId: input.currentRequestId }; }],
    ["before input", (event: DomainEvent) => { event.at = "2026-10-16T09:59:59.999Z"; }],
    ["after question", (event: DomainEvent) => { event.at = "2026-10-16T10:00:01.001Z"; }],
    ["untrusted false flag", (event: DomainEvent) => { event.payload.requireActionApproval = false; }],
    ["untrusted string flag", (event: DomainEvent) => { event.payload.requireActionApproval = "true"; }],
  ] as const)("rejects an invalid matching receipt without clearing the hold (%s)", async (_label, mutate) => {
    mutate(events[0]);
    await expect(resolveTypedClarificationApprovalHold(input)).rejects.toMatchObject({
      code: "clarification_approval_hold_unavailable", status: 503,
    });
  });

  it.each(["getThread", "listThreadTurns", "listRecentActorEvents"] as const)("fails closed without exposing lookup details when %s fails", async name => {
    stores[name].mockRejectedValue(new Error("private database diagnostics"));
    await expect(resolveTypedClarificationApprovalHold(input)).rejects.toThrow("The earlier clarification's approval policy could not be verified.");
    await expect(resolveTypedClarificationApprovalHold(input)).rejects.not.toThrow("private database diagnostics");
  });

  it("does not expire an unanswered hold", async () => {
    await expect(resolveTypedClarificationApprovalHold(input)).resolves.toBe(true);
    expect(stores.listRecentActorEvents.mock.calls[0][0].since).toEqual(new Date(userAt));
  });

  it("refuses ambiguous timestamp ordering", async () => {
    turns[1].createdAt = userAt;
    events[0].at = userAt;
    await expect(resolveTypedClarificationApprovalHold(input)).rejects.toBeInstanceOf(TypedClarificationApprovalHoldError);
  });

  it("leaves equal-millisecond ordinary turns unaffected when no hold receipt matches", async () => {
    turns[1].createdAt = userAt;
    events = [];
    await expect(resolveTypedClarificationApprovalHold(input)).resolves.toBe(false);
  });

  it("fails closed when a held receipt was saved but its question append failed", async () => {
    turns.pop();
    await expect(resolveTypedClarificationApprovalHold(input)).rejects.toMatchObject({ code: "clarification_approval_hold_unavailable" });
  });

  it("does not invent a hold for an orphan question receipt without a flag", async () => {
    turns.pop();
    delete events[0].payload.requireActionApproval;
    await expect(resolveTypedClarificationApprovalHold(input)).resolves.toBe(false);
  });

  it("does not query or trust receipts from a different thread", async () => {
    events[0].payload.threadId = laterTurnId;
    await expect(resolveTypedClarificationApprovalHold(input)).resolves.toBe(false);
  });

  it("refuses a saturated receipt page instead of assuming the unseen policy", async () => {
    events = Array.from({ length: 8 }, (_, index) => ({ ...receipt(), id: `receipt-${index}`, seq: index + 1 }));
    await expect(resolveTypedClarificationApprovalHold(input)).rejects.toBeInstanceOf(TypedClarificationApprovalHoldError);
  });
});
