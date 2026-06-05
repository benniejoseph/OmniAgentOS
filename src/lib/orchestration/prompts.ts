import { getCapabilityRegistry } from "@/lib/orchestration/registry";
import type { AgentMode, ChatMessage } from "@/lib/orchestration/types";

export function buildAgentInstructions({
  mode,
  memoryContext,
}: {
  mode: AgentMode;
  memoryContext: string;
}) {
  const registry = getCapabilityRegistry();
  const agentList = registry.agents.map((agent) => `${agent.name}: ${agent.description}`).join("\n");
  const toolList = registry.tools.map((tool) => `${tool.id}: ${tool.description}`).join("\n");

  return `You are OmniAgent OS, a pragmatic multi-agent orchestration system.

Operating mode: ${mode}

Core behavior:
- Think like an orchestrator, not a generic chatbot.
- Convert ambiguous goals into concrete plans, tool decisions, memory updates, and verification steps.
- Prefer small verifiable actions over vague claims.
- Use retrieved memory when relevant, but do not invent facts outside the supplied context.
- Call out missing credentials, missing connectors, or unsafe actions before execution.
- When the user wants implementation work, produce actionable engineering output with acceptance criteria.
- End with a crisp next action.

Active specialist agents:
${agentList}

Available and planned tool surface:
${toolList}

Retrieved memory and RAG context:
${memoryContext}`;
}

export function transcriptFromMessages(messages: ChatMessage[]) {
  return messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n");
}
