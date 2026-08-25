export type ArsenalAgent = {
  id: string;
  name: string;
  role: string;
  description: string;
  status: "ready" | "learning" | "watching";
  accent: "emerald" | "blue" | "amber" | "violet" | "rose";
  capabilities: string[];
  tools: string[];
  learningSignals: string[];
  autonomy: string;
};

export const arsenalAgents: ArsenalAgent[] = [
  {
    id: "atlas", name: "Atlas", role: "Supervisor", status: "ready", accent: "emerald",
    description: "Turns outcomes into plans, selects specialists, checks acceptance criteria, and replans when evidence changes.",
    capabilities: ["Intent routing", "Plan decomposition", "Agent delegation", "Result synthesis"],
    tools: ["Workflow planner", "Approval gates", "Context compiler"],
    learningSignals: ["Task completion", "Replan frequency", "Your corrections"], autonomy: "Coordinates reversible work and requests approval before consequential actions.",
  },
  {
    id: "scout", name: "Scout", role: "Research", status: "watching", accent: "blue",
    description: "Finds source-backed information, compares alternatives, and separates evidence from inference.",
    capabilities: ["Web research", "Knowledge retrieval", "Source comparison", "Citation checks"],
    tools: ["Web search", "Memory graph", "Document OCR"],
    learningSignals: ["Citation precision", "Source usefulness", "Accepted findings"], autonomy: "Reads broadly, never performs external mutations.",
  },
  {
    id: "forge", name: "Forge", role: "Builder", status: "learning", accent: "amber",
    description: "Produces implementation-ready artifacts, executes governed tools, and verifies the result against the brief.",
    capabilities: ["Implementation", "Artifact creation", "Tool execution", "Verification"],
    tools: ["Code workspace", "Documents", "Governed actions"],
    learningSignals: ["Build success", "Test outcomes", "Revision count"], autonomy: "Executes bounded work; previews or pauses before risky side effects.",
  },
  {
    id: "sentinel", name: "Sentinel", role: "Critic", status: "ready", accent: "rose",
    description: "Challenges plans and outputs for unsupported claims, unsafe actions, missed edge cases, and weak verification.",
    capabilities: ["Adversarial review", "Safety checks", "Quality grading", "Failure analysis"],
    tools: ["Evaluation suites", "Audit ledger", "Grounding verifier"],
    learningSignals: ["Escaped defects", "False alarms", "Review acceptance"], autonomy: "Can block unsafe work but cannot execute external actions.",
  },
  {
    id: "mnemosyne", name: "Mnemosyne", role: "Memory", status: "learning", accent: "violet",
    description: "Consolidates durable knowledge, resolves contradictions, and retrieves the smallest useful context for each task.",
    capabilities: ["Claim extraction", "Entity resolution", "Contradiction tracking", "Context recall"],
    tools: ["Vector memory", "Knowledge graph", "Source provenance"],
    learningSignals: ["Recall usefulness", "Corrections", "Forget requests"], autonomy: "Suggests memories; identity and preference changes remain inspectable and correctable.",
  },
];
