import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CustomAgentReadConflictError extends Error {}
  return {
    CustomAgentReadConflictError,
    appendScopedDomainEvent: vi.fn(),
    authorizeRequest: vi.fn(),
    canonicalRequestActorBindingFromSecurityContext: vi.fn(),
    checkSharedRateLimit: vi.fn(),
    createOpenAISpeechStream: vi.fn(),
    getCustomAgentForRequest: vi.fn(),
    getOwnedThread: vi.fn(),
    recordAiUsageSafely: vi.fn(),
    recordRuntimeEventSafely: vi.fn(),
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));
vi.mock("@/lib/http/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http/rate-limit")>()),
  checkSharedRateLimit: mocks.checkSharedRateLimit,
}));
vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest,
}));
vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext:
    mocks.canonicalRequestActorBindingFromSecurityContext,
}));
vi.mock("@/lib/observability/store", () => ({
  recordRuntimeEventSafely: mocks.recordRuntimeEventSafely,
}));
vi.mock("@/lib/skills/store", () => ({
  CustomAgentReadConflictError: mocks.CustomAgentReadConflictError,
  getCustomAgentForRequest: mocks.getCustomAgentForRequest,
}));
vi.mock("@/lib/threads/store", () => ({
  getOwnedThread: mocks.getOwnedThread,
}));
vi.mock("@/lib/usage/ledger", () => ({
  recordAiUsageSafely: mocks.recordAiUsageSafely,
}));
vi.mock("@/lib/voice/openai-speech", () => ({
  createOpenAISpeechStream: mocks.createOpenAISpeechStream,
}));

import { POST } from "@/app/api/media/speech/route";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";

const auth = {
  tenantId: "tenant-one",
  actorId: "actor-one",
  role: "admin" as const,
  source: "session" as const,
};
const actorBinding = {
  version: 1 as const,
  kind: "auth_user" as const,
  authUserId: "11111111-1111-4111-8111-111111111111",
  canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
  legacyOwnerActorIds: ["actor-one"],
  readableOwnerActorIds: [
    "actor:11111111-1111-4111-8111-111111111111",
    "actor-one",
  ],
};
const threadId = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  mocks.appendScopedDomainEvent.mockReset().mockResolvedValue({});
  mocks.authorizeRequest.mockReset().mockResolvedValue(auth);
  mocks.canonicalRequestActorBindingFromSecurityContext.mockReset()
    .mockReturnValue(actorBinding);
  mocks.checkSharedRateLimit.mockReset().mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
  });
  mocks.createOpenAISpeechStream.mockReset().mockImplementation(() =>
    Promise.resolve(byteStream([new Uint8Array([1, 2]), new Uint8Array([3, 4])]))
  );
  mocks.getCustomAgentForRequest.mockReset();
  mocks.getOwnedThread.mockReset().mockResolvedValue({ id: threadId });
  mocks.recordAiUsageSafely.mockReset().mockResolvedValue(undefined);
  mocks.recordRuntimeEventSafely.mockReset().mockResolvedValue(undefined);
});

describe("P9.10 versioned streaming Agent speech", () => {
  it("streams exact PCM under the pinned Asael voice profile", async () => {
    const response = await POST(speechRequest({
      text: "Verified answer.",
      agentId: "scout",
      threadId,
      runId: "run:one",
      voiceProfileVersion: "asael-voice:1",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/pcm");
    expect(response.headers.get("x-asael-audio-sample-rate")).toBe("24000");
    expect(response.headers.get("x-asael-audio-encoding")).toBe("pcm_s16le");
    expect(response.headers.get("x-asael-voice-profile")).toBe("asael-voice:1");
    expect(response.headers.get("x-asael-voice-profile-sha256"))
      .toMatch(/^[a-f0-9]{64}$/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(mocks.getOwnedThread).toHaveBeenCalledWith(threadId, {
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      requestActorBinding: actorBinding,
    });
    expect(mocks.createOpenAISpeechStream).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Verified answer.",
        profile: expect.objectContaining({
          profileVersion: "asael-voice:1",
          agentId: "scout",
          model: "gpt-4o-mini-tts",
          voice: "cedar",
        }),
      }),
    );
    expect(mocks.recordAiUsageSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        provider: "openai",
        model: "gpt-4o-mini-tts",
        usage: { inputCharacters: 16, outputBytes: 4 },
      }),
    );
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `thread:${threadId}`,
        type: "voice.speech_streamed",
        payload: expect.not.objectContaining({ text: expect.anything() }),
      }),
    );
  });

  it("resolves an owned custom Agent definition before fixing its delivery digest", async () => {
    mocks.getCustomAgentForRequest.mockResolvedValue({
      id: "agent-one",
      name: "Evidence Guide",
      activeDefinitionVersion: 4,
      persona: {
        ...DEFAULT_CUSTOM_AGENT_PERSONA,
        voice: "Measured and evidence-led.",
      },
    });

    const response = await POST(speechRequest({
      text: "Source-backed answer.",
      agentId: "agent-one",
      voiceProfileVersion: "asael-voice:1",
    }));
    await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(mocks.getCustomAgentForRequest).toHaveBeenCalledWith("agent-one", {
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      requestActorBinding: actorBinding,
    });
    expect(mocks.createOpenAISpeechStream).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          agentId: "agent-one",
          agentDefinitionVersion: 4,
          instructions: expect.stringContaining("Measured and evidence-led."),
        }),
      }),
    );
  });

  it("rejects an unavailable conversation or Agent before provider use", async () => {
    mocks.getOwnedThread.mockResolvedValueOnce(null);
    const missingThread = await POST(speechRequest({
      text: "Do not speak this.",
      threadId,
      voiceProfileVersion: "asael-voice:1",
    }));
    mocks.getCustomAgentForRequest.mockResolvedValue(undefined);
    const missingAgent = await POST(speechRequest({
      text: "Do not speak this either.",
      agentId: "missing-agent",
      voiceProfileVersion: "asael-voice:1",
    }));

    expect(missingThread.status).toBe(404);
    expect(missingAgent.status).toBe(404);
    expect(mocks.createOpenAISpeechStream).not.toHaveBeenCalled();
  });

  it("records client cancellation as an interrupted stream without transcript text", async () => {
    const response = await POST(speechRequest({
      text: "Long answer that will be interrupted.",
      threadId,
      voiceProfileVersion: "asael-voice:1",
    }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("barge-in");

    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice.speech_interrupted" }),
    );
    expect(mocks.recordAiUsageSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        failureKind: "abort",
        retryable: false,
      }),
    );
    expect(JSON.stringify(mocks.appendScopedDomainEvent.mock.calls[0]?.[0]))
      .not.toContain("Long answer");
  });

  it("rejects unknown voice versions before provider use", async () => {
    const response = await POST(speechRequest({
      text: "Do not speak this.",
      voiceProfileVersion: "latest",
    }));

    expect(response.status).toBe(400);
    expect(mocks.createOpenAISpeechStream).not.toHaveBeenCalled();
  });
});

function speechRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/media/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function byteStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
