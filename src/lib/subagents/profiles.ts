import type { AgentMode } from "@/lib/orchestration/types";
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

const SPECIALISTS: Record<
  DurableSpecialistAgentId,
  { name: string; role: string; description: string; instructions: string }
> = {
  atlas: {
    name: "Atlas",
    role: "Planning specialist",
    description: "Decomposes complex outcomes into a reliable execution strategy.",
    instructions: "Clarify dependencies, sequencing, acceptance criteria, and likely blockers.",
  },
  scout: {
    name: "Scout",
    role: "Research specialist",
    description: "Finds evidence, competing explanations, and missing facts.",
    instructions: "Research the objective, distinguish facts from inference, and cite useful evidence.",
  },
  forge: {
    name: "Forge",
    role: "Implementation specialist",
    description: "Designs practical implementation paths without performing writes.",
    instructions: "Produce an implementation-ready approach, interfaces, tests, and operational risks. Do not modify systems.",
  },
  sentinel: {
    name: "Sentinel",
    role: "Verification specialist",
    description: "Challenges assumptions and defines evidence needed for a safe result.",
    instructions: "Audit the objective for correctness, safety, failure modes, and verification gaps.",
  },
  mnemosyne: {
    name: "Mnemosyne",
    role: "Memory specialist",
    description: "Connects durable context, prior decisions, and contradictions.",
    instructions: "Surface relevant prior context, contradictions, and reusable learning without writing memory.",
  },
};

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
