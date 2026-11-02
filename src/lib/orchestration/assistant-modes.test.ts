import { describe, expect, it } from "vitest";
import { AGENT_MODES, ASSISTANT_MODES, assistantMode, assistantModeInstructions } from "./modes";
import { resolveAgentToolPolicy } from "./agent-tool-policy";
import { promptQueueCreateRequestSchema } from "@/lib/command/prompt-queue-contracts";
import { canonicalClientAgentMode } from "@/lib/command/client-projection";
import { nativeConversationRequestSchema, nativeConversationEventSchema } from "@/lib/mobile/contracts";
import { voiceConversationCommandContextSchema } from "@/lib/voice/conversation-contracts";
import { assistantEventForClient, assistantModeRequiresUpgrade } from "@/lib/mobile/assistant-mode-compatibility";
import { agentRequestFingerprint } from "@/lib/runs/request-admission";
import type { AgentEvent } from "./types";

describe("Assistant modes through durable and native contracts", () => {
  it.each(ASSISTANT_MODES)("retains %s in requests, queues, history and voice", mode => {
    const request = { message: "Work on the selected sources", mode, requestId: "mode-example" };
    expect(nativeConversationRequestSchema.parse(request).mode).toBe(mode);
    expect(canonicalClientAgentMode(mode)).toBe(mode);
    expect(promptQueueCreateRequestSchema.parse({ clientCorrelationId: "mode-queue", prompt: request.message, mode,
      target: { threadId: null, missionId: null, projectId: null, executionTarget: "asael" } }).mode).toBe(mode);
    expect(voiceConversationCommandContextSchema.parse({ mode, contextScope: "session", agentId: "atlas", contextReferences: [] }).mode).toBe(mode);
    expect(assistantModeInstructions(mode)).not.toBe("");
  });
  it("keeps old modes readable and does not relabel historical Act tasks as Coding", () => {
    for (const mode of AGENT_MODES) expect(canonicalClientAgentMode(mode)).toBe(mode);
    expect(assistantMode("execute")).toBe("cowork");
    expect(assistantMode("research")).toBe("cowork");
    expect(assistantMode("learn")).toBe("chat");
  });
  it("binds request replay to the selected behavior", () => {
    const hashes = ASSISTANT_MODES.map(mode => agentRequestFingerprint("tenant", "owner", "request", { message: "Do this", mode }));
    expect(new Set(hashes).size).toBe(3);
  });
  it("requires an older native queue to update instead of rewriting an immutable mode", () => {
    for (const mode of ASSISTANT_MODES) {
      expect(assistantModeRequiresUpgrade(mode, 62)).toBe(true);
      expect(assistantModeRequiresUpgrade(mode, 63)).toBe(false);
      expect(assistantModeRequiresUpgrade(mode)).toBe(false);
    }
    expect(assistantModeRequiresUpgrade("orchestrate", 62)).toBe(false);
  });
  it("narrows Chat without widening existing agent policies in other modes", () => {
    const input = { allowedToolIds: ["web.read", "app.projects.builder.file.edit"], approvalPolicy: "always" as const, autonomy: "execute" as const };
    expect(resolveAgentToolPolicy({ ...input, mode: "chat" })).toMatchObject({ readOnly: true, forceApprovalAboveRisk: 0 });
    for (const mode of ["cowork", "coding"] as const) {
      expect(resolveAgentToolPolicy({ ...input, mode })).toMatchObject({ readOnly: false, forceApprovalAboveRisk: 0 });
      expect(resolveAgentToolPolicy({ ...input, mode, approvalPolicy: "read_only" })).toMatchObject({ readOnly: true });
    }
  });
  it.each(ASSISTANT_MODES)("projects %s for older native event readers without changing stored evidence", mode => {
    const event = { type: "harness", version: 2, mode, publicEvidence: "retained" } as unknown as AgentEvent;
    const projected = assistantEventForClient(event, 62);
    expect(nativeConversationEventSchema.safeParse(event).success).toBe(true);
    expect(assistantEventForClient(event, 63)).toBe(event);
    expect(assistantEventForClient(event)).toBe(event);
    expect(projected).not.toBe(event);
    expect(event).toMatchObject({ mode });
    expect(projected).toMatchObject({ mode: mode === "chat" ? "learn" : mode === "coding" ? "execute" : "orchestrate", publicEvidence: "retained" });
  });
});
