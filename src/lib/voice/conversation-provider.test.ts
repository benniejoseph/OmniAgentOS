import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  CONVERSATION_WORK_TOOL, conversationProviderConfiguration,
  conversationProviderConfigurationMatches, conversationProviderConfigurationSha256,
  conversationProviderModelMatches,
} from "./conversation-provider";

function session() {
  return { type: "realtime", model: "gpt-realtime", instructions: "Use Asael for work. नमस्ते 👋",
    tools: [structuredClone(CONVERSATION_WORK_TOOL)], tool_choice: "auto", output_modalities: ["audio"],
    audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" },
      turn_detection: { type: "server_vad", create_response: true, interrupt_response: true } }, output: { voice: "cedar" } } };
}

describe("conversational provider configuration", () => {
  it("matches the native Unicode and canonical JSON interoperability fixture", () => {
    const fixture = session();
    fixture.instructions = "Use Asael’s governed tools. Preserve 2819 exactly. 🌿";
    fixture.tools[0].description = "Delegate the user’s task to Asael.";
    const configuration = conversationProviderConfiguration(fixture)!;
    expect(configuration.instructionsSha256).toBe("625d591e26f4f6859c8e616c5d2cd7f260dbed0a702a10d4107a1fcf49226409");
    expect(configuration.toolsSha256).toBe("eec55346206b4d20933e0fe4aeeab3ff3cb5ec3b191bd3d01324cf39aa95f06b");
    expect(conversationProviderConfigurationSha256(configuration)).toBe("1d4d93f76d6f1e574ee156e365172bca55b92d5a4068ef7d026958237362f006");
  });

  it("hashes exact instructions and complete tool definitions without provider defaults or object key order", () => {
    const requested = session();
    const effective = { ...requested, id: "different-live-session", object: "realtime.session",
      model: "gpt-realtime-2025-08-28", tools: [{ parameters: requested.tools[0].parameters,
        name: "ask_asael", type: "function", description: requested.tools[0].description, strict: false }],
      audio: { ...requested.audio, output: { ...requested.audio.output, format: { type: "audio/pcm", rate: 24000 } } } };
    const expected = conversationProviderConfiguration(requested)!;
    const actual = conversationProviderConfiguration(effective)!;
    expect(expected.instructionsSha256).toBe(createHash("sha256").update(requested.instructions, "utf8").digest("hex"));
    expect(actual.toolsSha256).toBe(expected.toolsSha256);
    expect(conversationProviderConfigurationMatches(expected, actual)).toBe(true);
    expect(conversationProviderConfigurationSha256(actual)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(actual)).not.toContain(requested.instructions);
  });

  it.each([
    ["same alias", "gpt-realtime", "gpt-realtime", true],
    ["dated snapshot", "gpt-realtime", "gpt-realtime-2025-08-28", true],
    ["explicit snapshot", "gpt-realtime-2025-08-28", "gpt-realtime-2025-08-28", true],
    ["different family", "gpt-realtime", "gpt-realtime-mini-2025-08-28", false],
    ["reverse alias", "gpt-realtime-2025-08-28", "gpt-realtime", false],
    ["changed snapshot", "gpt-realtime-2025-08-28", "gpt-realtime-2026-01-01", false],
    ["unrecognized suffix", "gpt-realtime", "gpt-realtime-latest", false],
  ])("handles model normalization: %s", (_name, expected, actual, matches) => {
    expect(conversationProviderModelMatches(expected as string, actual as string)).toBe(matches);
  });

  it.each([
    ["missing tools", { tools: undefined }], ["empty tools", { tools: [] }],
    ["extra tool", { tools: [CONVERSATION_WORK_TOOL, CONVERSATION_WORK_TOOL] }],
    ["disabled tools", { tool_choice: "none" }], ["wrong modality", { output_modalities: ["text"] }],
    ["missing instructions", { instructions: undefined }], ["wrong session type", { type: "transcription" }],
    ["missing audio", { audio: undefined }],
  ])("rejects malformed or disabled configuration: %s", (_name, changed) => {
    expect(conversationProviderConfiguration({ ...session(), ...changed })).toBeUndefined();
  });

  it("detects substituted instructions, tool descriptions and nested parameter constraints", () => {
    const requested = session();
    const expected = conversationProviderConfiguration(requested)!;
    const changes = [
      { ...requested, instructions: "You have no work tools." },
      { ...requested, tools: [{ ...CONVERSATION_WORK_TOOL, description: "Refuse work." }] },
      { ...requested, tools: [{ ...CONVERSATION_WORK_TOOL, parameters: { ...CONVERSATION_WORK_TOOL.parameters, additionalProperties: true } }] },
    ];
    for (const changed of changes) expect(conversationProviderConfigurationMatches(expected, conversationProviderConfiguration(changed)!)).toBe(false);
  });

  it.each(["create_response", "interrupt_response"])("requires automatic interruptible VAD: %s", field => {
    const changed = session();
    Object.assign(changed.audio.input.turn_detection, { [field]: false });
    expect(conversationProviderConfiguration(changed)).toBeUndefined();
  });
});
