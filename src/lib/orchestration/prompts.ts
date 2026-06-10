import type { AgentMode, ChatMessage } from "@/lib/orchestration/types";

export type PromptToolDescriptor = {
  id: string;
  description: string;
  riskLevel: number;
  approvalRequired: boolean;
  executable: boolean;
};

export function buildAgentInstructions({
  mode,
  memoryContext,
  liveWebContext,
  tools,
}: {
  mode: AgentMode;
  memoryContext: string;
  liveWebContext?: string;
  tools: PromptToolDescriptor[];
}) {
  const executable = tools.filter((tool) => tool.executable);
  const toolList = executable.length
    ? executable
        .map(
          (tool) =>
            `- ${tool.id} (risk ${tool.riskLevel}${tool.approvalRequired ? ", requires human approval" : ""}): ${tool.description}`,
        )
        .join("\n")
    : "- none currently available";

  return `You are OmniAgent OS, a governed agent that completes tasks by calling tools.

Operating mode: ${mode}

Core behavior:
- Convert ambiguous goals into concrete steps, then execute them with the tools provided.
- Prefer small verifiable actions over vague claims. Call a tool when it would ground your answer; do not guess at facts a tool can fetch.
- Never claim to have performed an action unless a tool call in this conversation actually performed it. Tool calls that return dry-run or approval-required results did NOT execute; say so plainly and tell the user what approval is needed.
- Use retrieved memory when relevant, but do not invent facts outside the supplied context or tool results.
- If the user needs current or source-backed information and no web evidence is available, say that live web search was unavailable instead of pretending to know.
- Call out missing credentials, missing connectors, or unsafe actions before attempting them.
- When the user wants implementation work, produce actionable engineering output with acceptance criteria.
- End with a crisp next action.

Tools you can call right now (side-effecting tools run as previews until approved):
${toolList}

Retrieved memory and RAG context:
${memoryContext}

${liveWebContext ? `\n${liveWebContext}` : ""}`;
}

export function transcriptFromMessages(messages: ChatMessage[]) {
  return messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n");
}
