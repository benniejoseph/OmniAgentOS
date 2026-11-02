/** Persisted modes include historical callers; never reinterpret their authority. */
export const AGENT_MODES = [
  "orchestrate", "research", "execute", "learn", "chat", "cowork", "coding",
] as const;
export type AgentMode = typeof AGENT_MODES[number];

export const ASSISTANT_MODES = ["chat", "cowork", "coding"] as const;
export type AssistantMode = typeof ASSISTANT_MODES[number];

export function assistantMode(mode: AgentMode): AssistantMode {
  if (mode === "chat" || mode === "learn") return "chat";
  if (mode === "coding") return "coding";
  return "cowork";
}

/** Older clients keep their original wire vocabulary without gaining authority. */
export function legacyAgentMode(mode: AgentMode) {
  if (mode === "chat") return "learn" as const;
  if (mode === "cowork") return "orchestrate" as const;
  if (mode === "coding") return "execute" as const;
  return mode;
}

export const ASSISTANT_MODE_DETAILS = {
  chat: {
    label: "Chat",
    title: "Let's think it through.",
    description: "Ask a question, explore an idea, or make sense of your sources.",
    placeholder: "What would you like to understand?",
    context: "Answers, sources, and plans. Switch to Cowork or Coding when you're ready to act.",
    prompts: ["Explain this document in plain language", "Compare the options and their trade-offs", "Help me think through an idea"],
  },
  cowork: {
    label: "Cowork",
    title: "What shall we get done?",
    description: "Bring a goal and your files. Asael will coordinate the work and return the results.",
    placeholder: "Describe the outcome you need…",
    context: "Documents, research, and connected work, with progress and results in this conversation.",
    prompts: ["Create an editable PowerPoint presentation", "Turn these notes into a client brief", "Research this topic and prepare a cited report"],
  },
  coding: {
    label: "Coding",
    title: "Let's build something useful.",
    description: "Choose a project, describe the change, and review the files and checks as Asael works.",
    placeholder: "What should we build, fix, or review?",
    context: "Use a project build workspace or an explicitly connected Mac folder. Changes and checks stay reviewable.",
    prompts: ["Explain this project's architecture", "Find and fix a bug, then run the relevant checks", "Build a working prototype for this project"],
  },
} as const;

export function assistantModeInstructions(mode: AgentMode): string {
  switch (mode) {
    case "chat":
      return "Assistant experience: Chat. Answer, explain, compare, research with admitted read-only tools, or develop a plan. This turn is read-only: do not create documents, edit files, start workflows, delegate effectful tasks, or make external changes. If the requested outcome requires actions, explain the useful plan and ask the user to switch to Cowork or Coding; do not claim the action happened. Chat history and existing consent-based memory remain governed separately.";
    case "cowork":
      return "Assistant experience: Cowork. Carry the user's authorized outcome through to usable results using Asael's own tools and specialists. For multi-step work, give a concise plan and public progress; delegate only where it helps. Deliver the actual document, artifact, or verified effect, not just instructions for the user. Read supplied sources, preserve project scope, disclose missing dependencies, and distinguish pending work from completed work. Use existing approvals for consequential effects.";
    case "coding":
      return "Assistant experience: Coding. Use Asael's authorized project build workspace or explicitly selected Mac command workspace. Inspect the repository, applicable instructions, relevant source and adjacent checks before editing. An existing Mac checkout is already connected to its configured Git remotes: inspect its branch, status and remotes with local commands; do not clone, initialize, fetch or change authentication merely to connect it. For multi-step work, share a short public plan and concise progress notes about the current action and observed result; never reveal private chain-of-thought. Preserve unrelated work. Make focused changes, inspect the actual diff/checkpoint, run relevant checks, and report actual results with file references. Source edits, validation, preview, delivery, deployment and installation are separate stages. Use Forge or Sentinel when their help is warranted. A selected project is not proof of a ready build workspace: inspect it, use admitted setup operations if authorized, and disclose missing access. Never install or delegate to external coding products as a substitute for Asael's tools.";
    default:
      return "";
  }
}
