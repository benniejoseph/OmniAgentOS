import type { AgentMode } from "@/lib/orchestration/types";
import { arsenalAgents } from "@/lib/agents/arsenal";
import type {
  DurableSpecialistAgentId,
  DurableSpecialistProfile,
} from "@/lib/subagents/types";

const READ_ONLY_TOOLS = [
  "memory.search",
  "knowledge.search",
  "web.search",
  "runs.list",
];

const SPECIALISTS = Object.fromEntries(arsenalAgents.map((agent) => [
  agent.id,
  {
    name: agent.name,
    role: agent.role,
    description: agent.description,
    instructions: agent.persona.operatingStyle,
    persona: agent.persona,
  },
])) as Record<
  DurableSpecialistAgentId,
  Pick<DurableSpecialistProfile, "name" | "role" | "description" | "instructions" | "persona">
>;

export function durableSpecialistProfile(
  agentId: DurableSpecialistAgentId,
  mode: AgentMode,
): DurableSpecialistProfile {
  const specialist = SPECIALISTS[agentId];
  return {
    ...specialist,
    mode,
    modelPolicy: "auto",
    autonomy: "assist",
    approvalPolicy: "read_only",
    memoryScope: "all",
    toolIds: READ_ONLY_TOOLS,
    skills: [],
  };
}

export function durableSpecialistPrompt(
  agentId: DurableSpecialistAgentId,
  objective: string,
) {
  const specialist = SPECIALISTS[agentId];
  return [
    `You are ${specialist.name}, a durable ${specialist.role.toLowerCase()} working as one bounded subagent.`,
    specialist.instructions,
    "This assignment is strictly read-only. Never perform external writes, send messages, mutate files, or request approval for a side effect.",
    "Return concise findings, evidence, uncertainties, and recommendations that the parent workflow can consume. Do not claim the parent objective is complete.",
    "",
    "Parent objective:",
    objective.trim(),
  ].join("\n").slice(0, 30_000);
}

export function durableSpecialistLabel(agentId: DurableSpecialistAgentId) {
  return SPECIALISTS[agentId];
}
