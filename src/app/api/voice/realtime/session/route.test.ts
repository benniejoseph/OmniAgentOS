import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
  authorizeRequest: vi.fn(),
  checkSharedRateLimit: vi.fn(),
  createThread: vi.fn(),
  getOwnedThread: vi.fn(),
  issueRealtimeTranscriptionSecret: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: routeMocks.appendScopedDomainEvent,
}));

vi.mock("@/lib/http/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http/rate-limit")>()),
  checkSharedRateLimit: routeMocks.checkSharedRateLimit,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/threads/store", () => ({
  createThread: routeMocks.createThread,
  getOwnedThread: routeMocks.getOwnedThread,
}));

vi.mock("@/lib/voice/realtime-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice/realtime-session")>()),
  issueRealtimeTranscriptionSecret:
    routeMocks.issueRealtimeTranscriptionSecret,
}));

import { PATCH, POST } from "@/app/api/voice/realtime/session/route";

const actorId = "voice-owner@example.test";
const authUserId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const context = {
  tenantId: "tenant-a",
  actorId,
  role: "member" as const,
  source: "session" as const,
  auth: {
    userId: authUserId,
    email: actorId,
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const thread = {
  id: conversationId,
  tenantId: context.tenantId,
  actorId,
  title: "Voice conversation",
  mode: "orchestrate" as const,
  createdAt: "2026-09-07T12:00:00.000Z",
  updatedAt: "2026-09-07T12:00:00.000Z",
};

beforeEach(() => {
  routeMocks.appendScopedDomainEvent.mockReset().mockResolvedValue({});
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.checkSharedRateLimit.mockReset().mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
  });
  routeMocks.createThread.mockReset().mockResolvedValue(thread);
  routeMocks.getOwnedThread.mockReset().mockResolvedValue(thread);
  routeMocks.issueRealtimeTranscriptionSecret.mockReset().mockResolvedValue({
    clientSecret: "ek_test_ephemeral",
    clientSecretExpiresAt: 1_800_000_000,
    providerSessionId: "sess_test",
    providerSessionExpiresAt: 1_800_000_600,
    model: "gpt-4o-mini-transcribe",
  });
});

describe("realtime voice session route", () => {
  it("creates an attributed conversation and returns only a short-lived transcription credential", async () => {
    const response = await POST(request("POST", {
      providerConsent: true,
      audioRetention: "not_stored_by_asael",
      language: "hi",
      mode: "orchestrate",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.createThread).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId,
      title: "Voice conversation",
      mode: "orchestrate",
    });
    expect(routeMocks.issueRealtimeTranscriptionSecret).toHaveBeenCalledWith({
      language: "hi",
    });
    const body = await response.json();
    expect(body).toMatchObject({
      conversationId,
      clientSecret: "ek_test_ephemeral",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      language: "hi",
      turnDetection: "server_vad",
      audioRetention: "not_stored_by_asael",
      transcriptRetention: "command_draft_until_sent",
      reconnectAttempt: 0,
    });
    expect(body).not.toHaveProperty("providerSessionId");
    expect(routeMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "voice.realtime_started",
        payload: expect.objectContaining({ conversationId, language: "hi" }),
      }),
    );
  });

  it("reconnects only to an owned conversation and retains the app session identity", async () => {
    const response = await POST(request("POST", {
      sessionId,
      conversationId,
      providerConsent: true,
      audioRetention: "not_stored_by_asael",
      reconnectAttempt: 2,
    }));

    expect(response.status).toBe(200);
    expect(routeMocks.createThread).not.toHaveBeenCalled();
    expect(routeMocks.getOwnedThread).toHaveBeenCalledWith(
      conversationId,
      expect.objectContaining({
        tenantId: context.tenantId,
        actorId,
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      sessionId,
      conversationId,
      reconnectAttempt: 2,
    });
    expect(routeMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice.realtime_reconnected" }),
    );
  });

  it("rejects silent provider consent and malformed reconnects before minting a credential", async () => {
    const noConsent = await POST(request("POST", {
      providerConsent: false,
      audioRetention: "not_stored_by_asael",
    }));
    const badReconnect = await POST(request("POST", {
      providerConsent: true,
      audioRetention: "not_stored_by_asael",
      reconnectAttempt: 1,
    }));

    expect(noConsent.status).toBe(400);
    expect(badReconnect.status).toBe(400);
    expect(routeMocks.issueRealtimeTranscriptionSecret).not.toHaveBeenCalled();
  });

  it("records content-free completion metadata against the owned conversation", async () => {
    const response = await PATCH(request("PATCH", {
      sessionId,
      conversationId,
      outcome: "sent",
      durationMilliseconds: 12_500,
      turnCount: 2,
      reconnectCount: 1,
      transcriptCharacters: 84,
      confidenceBand: "high",
      confidenceMean: 0.92,
      confidenceMinimum: 0.71,
      confidenceSampleCount: 12,
      reviewRequired: false,
      reviewAttested: true,
    }));

    expect(response.status).toBe(200);
    expect(routeMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "voice.realtime_sent",
        payload: expect.objectContaining({
          conversationId,
          durationMilliseconds: 12_500,
          turnCount: 2,
          reconnectCount: 1,
          transcriptCharacters: 84,
          confidenceBand: "high",
          confidenceMean: 0.92,
          confidenceMinimum: 0.71,
          confidenceSampleCount: 12,
          reviewRequired: false,
          reviewAttested: true,
        }),
      }),
    );
    const event = routeMocks.appendScopedDomainEvent.mock.calls[0]?.[0];
    expect(JSON.stringify(event)).not.toContain("transcript\":");
  });

  it("rejects a sent command without the required review attestation", async () => {
    const response = await PATCH(request("PATCH", {
      sessionId,
      conversationId,
      outcome: "sent",
      durationMilliseconds: 1_000,
      turnCount: 1,
      reconnectCount: 0,
      transcriptCharacters: 20,
      confidenceBand: "low",
      confidenceMean: 0.4,
      confidenceMinimum: 0.08,
      confidenceSampleCount: 3,
      reviewRequired: true,
      reviewAttested: false,
    }));

    expect(response.status).toBe(400);
    expect(routeMocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });

  it("fails closed when the shared cost limiter is unavailable", async () => {
    const { RateLimitStoreUnavailableError } = await import("@/lib/http/rate-limit");
    routeMocks.checkSharedRateLimit.mockRejectedValue(
      new RateLimitStoreUnavailableError(),
    );

    const response = await POST(request("POST", {
      providerConsent: true,
      audioRetention: "not_stored_by_asael",
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(routeMocks.issueRealtimeTranscriptionSecret).not.toHaveBeenCalled();
  });
});

function request(method: "POST" | "PATCH", body: Record<string, unknown>) {
  return new Request("http://localhost/api/voice/realtime/session", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
