import type { MemoryRecord } from "@/lib/memory/types";

type MemoryScopeSource = Pick<MemoryRecord, "scope" | "accessBinding">;

export function memoryScopePresentation(memory: MemoryScopeSource) {
  const binding = memory.accessBinding;
  if (!binding) {
    return {
      visibility: "Legacy compatibility",
      boundary: memory.scope === "user"
        ? "Personal"
        : memory.scope === "project"
          ? "Project"
          : "Workspace",
      sensitivity: "Not classified",
      explanation: "This older memory keeps its original compatibility scope.",
    };
  }

  const visibility = {
    user_private: "Only you",
    agent_private: "One agent",
    mission_shared: "Mission members",
    project_shared: "Project members",
    workspace_shared: "Workspace members",
  }[binding.visibility];
  const boundary = {
    user_private: "Personal",
    agent_private: "Agent",
    mission_shared: "Mission",
    project_shared: "Project",
    workspace_shared: "Workspace",
  }[binding.visibility];

  return {
    visibility,
    boundary,
    sensitivity: sentenceCase(binding.sensitivity),
    explanation: binding.visibility === "user_private"
      ? "This memory is bound to your account and excluded from sibling users."
      : `This memory is bound to its ${boundary.toLowerCase()} authority.`,
  };
}

export function portableArchiveFilename(
  contentDisposition: string | null,
  date = new Date(),
) {
  const encoded = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
    } catch {
      // Fall through to the plain filename or deterministic fallback.
    }
  }
  return contentDisposition?.match(/filename="?([^";]+)"?/i)?.[1]
    || `asael-${date.toISOString().slice(0, 10)}-v2.json`;
}

function sentenceCase(value: string) {
  const normalized = value.replaceAll("_", " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
