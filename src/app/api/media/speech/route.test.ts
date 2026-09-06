import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CustomAgentReadConflictError extends Error {}
  return {
    CustomAgentReadConflictError,
    authorizeRequest: vi.fn(),
    canonicalRequestActorBindingFromSecurityContext: vi.fn(),
    getCustomAgentForRequest: vi.fn(),
    recordRuntimeEventSafely: vi.fn(),
    synthesizeGoogleSpeech: vi.fn(),
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest,
}));
vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext:
    mocks.canonicalRequestActorBindingFromSecurityContext,
}));
vi.mock("@/lib/google/ai", () => ({
  synthesizeGoogleSpeech: mocks.synthesizeGoogleSpeech,
}));
vi.mock("@/lib/observability/store", () => ({
  recordRuntimeEventSafely: mocks.recordRuntimeEventSafely,
}));
vi.mock("@/lib/skills/store", () => ({
  CustomAgentReadConflictError: mocks.CustomAgentReadConflictError,
  getCustomAgentForRequest: mocks.getCustomAgentForRequest,
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

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue(auth);
  mocks.canonicalRequestActorBindingFromSecurityContext.mockReset()
    .mockReturnValue(actorBinding);
  mocks.getCustomAgentForRequest.mockReset();
  mocks.recordRuntimeEventSafely.mockReset().mockResolvedValue(undefined);
  mocks.synthesizeGoogleSpeech.mockReset().mockResolvedValue(
    Buffer.from("audio"),
  );
});

describe("P7.2 agent voice identity", () => {
  it("attributes built-in speech to the exact central persona", async () => {
    const response = await POST(speechRequest({
      text: "Verified answer.",
      agentId: "scout",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition"))
      .toBe("inline; filename=scout-response.mp3");
    expect(mocks.getCustomAgentForRequest).not.toHaveBeenCalled();
    expect(mocks.recordRuntimeEventSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: "scout",
        metadata: expect.objectContaining({
          agentId: "scout",
          voiceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it("resolves an owned custom Agent before synthesizing its voice", async () => {
    mocks.getCustomAgentForRequest.mockResolvedValue({
      id: "agent-one",
      name: "Evidence Guide",
      persona: {
        ...DEFAULT_CUSTOM_AGENT_PERSONA,
        voice: "Measured and evidence-led.",
      },
    });

    const response = await POST(speechRequest({
      text: "Source-backed answer.",
      agentId: "agent-one",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition"))
      .toBe("inline; filename=evidence-guide-response.mp3");
    expect(mocks.getCustomAgentForRequest).toHaveBeenCalledWith("agent-one", {
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      requestActorBinding: actorBinding,
    });
  });

  it("does not synthesize speech for an unavailable custom Agent", async () => {
    mocks.getCustomAgentForRequest.mockResolvedValue(undefined);

    const response = await POST(speechRequest({
      text: "Do not speak this.",
      agentId: "missing-agent",
    }));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.synthesizeGoogleSpeech).not.toHaveBeenCalled();
  });
});

function speechRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/media/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
