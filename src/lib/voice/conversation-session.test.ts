import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientSecretCreateParams } from "openai/resources/realtime/client-secrets";
const mocks = vi.hoisted(() => ({ create: vi.fn(), getOwnedThread: vi.fn(), resolveCommandContextReferences: vi.fn() }));
vi.mock("@/lib/openai/client", () => ({ getOpenAIClient: () => ({ realtime: { clientSecrets: { create: mocks.create } } }) }));
vi.mock("@/lib/agents/identity-store", () => ({ resolveAgentIdentityForExecution: async () => ({
  definition: { name: "ATLAS", role: "Assistant", instructions: "Help the owner.", persona: { voice: "Concise" } },
}) }));
vi.mock("@/lib/threads/store", () => ({ getOwnedThread: mocks.getOwnedThread, listThreadTurns: async () => [] }));
vi.mock("@/lib/command/context-reference-runtime", () => ({ resolveCommandContextReferences: mocks.resolveCommandContextReferences }));
vi.mock("@/lib/personal-context/runtime", () => ({ resolveAuthenticatedPersonalProfile: async () => undefined }));
vi.mock("@/lib/companion/language-style-resolver", () => ({ resolveAuthenticatedCompanionLanguageStyle: async () => ({
  version: "companion-language:1", source: "default", intensity: "balanced", preferenceRevision: 0,
}) }));
import { buildConversationVoiceInstructions, issueConversationVoiceSecret } from "./conversation-session";
import { conversationProviderConfiguration, conversationProviderConfigurationSha256 } from "./conversation-provider";

beforeEach(() => {
  mocks.getOwnedThread.mockReset().mockResolvedValue({ id: "owned-thread" });
  mocks.resolveCommandContextReferences.mockReset().mockImplementation(() => {
    throw new Error("A current-turn voice conversation must not resolve saved context.");
  });
  mocks.create.mockReset().mockImplementation(async (body: ClientSecretCreateParams) => ({
    session: { ...body.session, model: "gpt-realtime-2025-08-28", id: "token-config-id" },
    value: "ek_test_short_lived", expires_at: Math.floor(Date.now() / 1000) + 60,
  }));
});
const input = { model: "gpt-realtime", instructions: "Use the work tool for actions.", correlationId: "voice:test" };

describe("continuous voice secret admission", () => {
  it("returns nonsecret effective expectations only after validating provider configuration", async () => {
    const result = await issueConversationVoiceSecret(input);
    const body = mocks.create.mock.calls[0][0];
    expect(body.session.tools[0].description).toContain("search YouTube and play a video");
    expect(result.providerConfiguration.model).toBe("gpt-realtime-2025-08-28");
    expect(result.requestedProviderConfigurationSha256).toBe(conversationProviderConfigurationSha256(conversationProviderConfiguration(body.session)!));
    expect(result).not.toHaveProperty("session");
    expect(mocks.create).toHaveBeenCalledWith(expect.any(Object), { maxRetries: 0, timeout: 40_000 });
  });

  it.each(["tools", "instructions", "audio", "model", "secret", "expiry"])("refuses a returned key when %s is invalid", async field => {
    mocks.create.mockImplementationOnce(async (body: ClientSecretCreateParams) => {
      const session = { ...body.session } as Record<string, unknown>;
      if (field === "tools") session.tools = [];
      if (field === "instructions") session.instructions = "Generic assistant with no tools.";
      if (field === "audio") session.audio = {};
      if (field === "model") session.model = "other-family";
      return { session, value: field === "secret" ? "long_lived_key" : "ek_test_short_lived",
        expires_at: Math.floor(Date.now() / 1000) + (field === "expiry" ? -1 : 60) };
    });
    await expect(issueConversationVoiceSecret(input)).rejects.toMatchObject({ code: "voice_provider_contract_invalid", status: 503 });
  });
});

describe("continuous voice action instructions", () => {
  it.each(["local_macos", "local_android", undefined] as const)("states the selected target and routes action requests through the work tool (%s)", async target => {
    const result = await buildConversationVoiceInstructions({
      context: { tenantId: "tenant-a", actorId: "owner-a", role: "admin", source: "session" }, conversationId: "owned-thread",
      commandContext: { agentId: "atlas", mode: "orchestrate", contextScope: "current_turn", contextReferences: [], computerUseTarget: target },
    });
    expect(mocks.resolveCommandContextReferences).not.toHaveBeenCalled();
    expect(result.instructions).toContain("call ask_asael before claiming inability or giving manual instructions");
    expect(result.instructions).toContain("Preserve the user's names, numbers and destinations exactly");
    expect(result.instructions).toContain("only after it presents one exact action and arms spoken review");
    expect(result.instructions).toContain("wait for the app’s decision_recorded result");
    expect(result.instructions).toContain("Do not call ask_asael to approve actions");
    if (target === "local_macos") {
      expect(result.instructions).toContain("search YouTube and play a requested video");
      expect(result.instructions).toContain("navigate Asael");
      expect(result.instructions).toContain("Selecting this target does not approve consequential actions");
    } else if (target === "local_android") expect(result.instructions).toContain("only this authenticated Android phone");
    else expect(result.instructions).toContain("This call uses Asael app tools only");
  });
});
