import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(), authorizeRequest: vi.fn(), checkSharedRateLimit: vi.fn(),
  createThread: vi.fn(), getOwnedThread: vi.fn(), getLocalComputerDevice: vi.fn(),
  buildConversationVoiceInstructions: vi.fn(), issueConversationVoiceSecret: vi.fn(),
  requireActiveConversationVoiceSession: vi.fn(), resolveConversationVoiceRuntime: vi.fn(),
}));
vi.mock("@/lib/db/client", async original => ({ ...(await original<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope: (handler: (...args: never[]) => Promise<Response>) => handler }));
vi.mock("@/lib/events/store", async original => ({ ...(await original<typeof import("@/lib/events/store")>()),
  appendScopedDomainEvent: mocks.appendScopedDomainEvent }));
vi.mock("@/lib/http/rate-limit", async original => ({ ...(await original<typeof import("@/lib/http/rate-limit")>()),
  checkSharedRateLimit: mocks.checkSharedRateLimit }));
vi.mock("@/lib/security/guard", async original => ({ ...(await original<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest }));
vi.mock("@/lib/threads/store", async original => ({ ...(await original<typeof import("@/lib/threads/store")>()),
  createThread: mocks.createThread, getOwnedThread: mocks.getOwnedThread }));
vi.mock("@/lib/local-computer/store", async original => ({ ...(await original<typeof import("@/lib/local-computer/store")>()),
  getLocalComputerDevice: mocks.getLocalComputerDevice }));
vi.mock("@/lib/voice/conversation-session", async original => ({ ...(await original<typeof import("@/lib/voice/conversation-session")>()),
  buildConversationVoiceInstructions: mocks.buildConversationVoiceInstructions,
  issueConversationVoiceSecret: mocks.issueConversationVoiceSecret,
  requireActiveConversationVoiceSession: mocks.requireActiveConversationVoiceSession,
  resolveConversationVoiceRuntime: mocks.resolveConversationVoiceRuntime }));
import { PATCH, POST } from "./route";
import { conversationProviderConfigurationSha256 } from "@/lib/voice/conversation-provider";
import { VoiceConversationError } from "@/lib/voice/conversation-session";
import type { VoiceConversationProviderConfiguration } from "@/lib/voice/conversation-contracts";

const actorId = "voice-owner@example.test";
const conversationId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const context = { tenantId: "tenant-a", actorId, role: "member" as const, source: "session" as const,
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: actorId, sessionId: "login-a", tenantName: "Tenant A" } };
const instructions = "Use the selected work agent.";
const providerConfiguration: VoiceConversationProviderConfiguration = {
  schemaVersion: 1, instructionsSha256: createHash("sha256").update(instructions).digest("hex"), toolsSha256: "b".repeat(64),
  model: "gpt-realtime-2025-08-28", voice: "cedar", transcriptionModel: "gpt-4o-mini-transcribe", turnDetection: "server_vad",
  createResponse: true, interruptResponse: true, toolChoice: "auto", outputModalities: ["audio"],
};
const configurationSha256 = conversationProviderConfigurationSha256(providerConfiguration);
const start = { schemaVersion: 2, conversationId, providerConsent: true, continuousConsent: true,
  audioRetention: "not_stored_by_asael", transcriptRetention: "conversation_history" };
const finish = { schemaVersion: 2, conversationId, sessionId, outcome: "ended", durationMilliseconds: 5000, turnCount: 2, reconnectCount: 0 };
const acknowledgement = { schemaVersion: 1, verified: true, configurationSha256, observedBy: "client" };
function request(method: "POST" | "PATCH", body: unknown) {
  return new Request("http://asael.test/api/voice/conversation/session", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(context);
  mocks.appendScopedDomainEvent.mockResolvedValue({});
  mocks.checkSharedRateLimit.mockResolvedValue({ allowed: true });
  mocks.getOwnedThread.mockResolvedValue({ id: conversationId, tenantId: context.tenantId, actorId });
  mocks.getLocalComputerDevice.mockResolvedValue({ enabled: true, online: true });
  mocks.buildConversationVoiceInstructions.mockResolvedValue({ agentName: "ATLAS", instructions, contextReceiptSha256: null });
  mocks.issueConversationVoiceSecret.mockResolvedValue({ clientSecret: "ek_test_ephemeral", clientSecretExpiresAt: 1_800_000_000,
    providerConfiguration, requestedProviderConfigurationSha256: "c".repeat(64) });
  mocks.resolveConversationVoiceRuntime.mockResolvedValue({ model: "gpt-realtime", credentialSource: "deployment_environment",
    withApiKey: (operation: (key?: string) => Promise<unknown>) => operation(undefined) });
  mocks.requireActiveConversationVoiceSession.mockResolvedValue({ ownerActorId: actorId, providerConfigurationSha256: configurationSha256,
    commandContext: { agentId: "atlas", mode: "orchestrate", contextScope: "session", contextReferences: [] } });
});

describe("continuous voice verified configuration contract", () => {
  it.each(["web", 58, 59] as const)("returns expectations only for compatible consumers (%s)", async client => {
    if (client !== "web") mocks.authorizeRequest.mockResolvedValue({ ...context, source: "mobile",
      native: { deviceId: "this-mac", platform: "macos", clientContractVersion: client } });
    const response = await POST(request("POST", { ...start, ...(client === "web" ? {} : { computerUseTarget: "local_macos" }) }));
    expect(response.status).toBe(200);
    const body = await response.json();
    if (client === 58) expect(body).not.toHaveProperty("providerConfiguration");
    else expect(body.providerConfiguration).toEqual(providerConfiguration);
    expect(body).not.toHaveProperty("requestedProviderConfigurationSha256");
    expect(body).not.toHaveProperty("instructions");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "voice.conversation_started",
      payload: expect.objectContaining({ instructionsSha256: providerConfiguration.instructionsSha256,
        effectiveInstructionsSha256: providerConfiguration.instructionsSha256, toolsSha256: providerConfiguration.toolsSha256,
        providerConfigurationSha256: configurationSha256, requestedProviderConfigurationSha256: "c".repeat(64),
        effectiveProviderModel: providerConfiguration.model,
        ...(client === "web" ? {} : { commandContext: expect.objectContaining({ computerUseTarget: "local_macos" }), nativeDeviceId: "this-mac" }),
      }) }));
    const saved = JSON.stringify(mocks.appendScopedDomainEvent.mock.calls);
    expect(saved).not.toContain("ek_test_ephemeral");
    expect(saved).not.toContain(instructions);
  });

  it("does not record a ready lifecycle when the returned provider configuration is rejected", async () => {
    mocks.issueConversationVoiceSecret.mockRejectedValueOnce(new VoiceConversationError("voice_provider_contract_invalid", "Try again.", 503));
    const response = await POST(request("POST", start));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "voice_provider_contract_invalid" });
    expect(mocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });

  it("pins reconnect context before minting another secret", async () => {
    const response = await POST(request("POST", { ...start, sessionId, reconnectAttempt: 1, agentId: "different-agent" }));
    expect(response.status).toBe(409);
    expect(mocks.issueConversationVoiceSecret).not.toHaveBeenCalled();
  });

  it("records successful active-session verification explicitly as client-observed metadata", async () => {
    const response = await PATCH(request("PATCH", { ...finish, providerConfigurationAcknowledgement: acknowledgement }));
    expect(response.status).toBe(200);
    expect(mocks.requireActiveConversationVoiceSession).toHaveBeenCalledWith({ context, sessionId, conversationId });
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "voice.conversation_ended",
      payload: expect.objectContaining({ observedBy: "client", providerConfigurationAcknowledgement: acknowledgement }) }));
  });

  it.each(["changed", "legacy"])("refuses an acknowledgement for another configuration (%s)", async scenario => {
    if (scenario === "legacy") mocks.requireActiveConversationVoiceSession.mockResolvedValueOnce({ ownerActorId: actorId });
    const response = await PATCH(request("PATCH", { ...finish, providerConfigurationAcknowledgement: {
      ...acknowledgement, configurationSha256: scenario === "changed" ? "d".repeat(64) : configurationSha256 } }));
    expect(response.status).toBe(409);
    expect(mocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });

  it("accepts legacy completion and failure metadata without fabricating active-session verification", async () => {
    const response = await PATCH(request("PATCH", { ...finish, outcome: "failed", providerErrorCode: "voice_provider_configuration_mismatch" }));
    expect(response.status).toBe(200);
    expect(mocks.appendScopedDomainEvent.mock.calls[0][0].payload).not.toHaveProperty("providerConfigurationAcknowledgement");
  });
});
