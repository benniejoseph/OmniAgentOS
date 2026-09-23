export type ClientThreadTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  runId?: string;
};

export type ClientThreadSummary<Mode extends string = string> = {
  id: string;
  title: string;
  updatedAt: string;
  mode: Mode;
};

export type ClientAgentMode = "orchestrate" | "research" | "execute" | "learn";

/**
 * Canonicalize persisted or API-sourced modes before they enter controlled
 * Command state. Historical rows may contain an empty or retired mode.
 */
export function canonicalClientAgentMode(value: unknown): ClientAgentMode {
  switch (value) {
    case "orchestrate":
    case "research":
    case "execute":
    case "learn":
      return value;
    default:
      return "orchestrate";
  }
}

/**
 * Treat API and replay payloads as untrusted at the client boundary. A single
 * malformed historical row must not be able to crash the whole Command tree.
 */
export function projectClientThreadTurns(value: unknown): ClientThreadTurn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    const record = plainRecord(candidate);
    const role = record.role;
    const content = text(record.content);
    if ((role !== "user" && role !== "assistant") || !content) return [];
    const createdAt = text(record.createdAt);
    const id = text(record.id) || `${role}-turn-${index}`;
    const runId = text(record.runId);
    return [{
      id,
      role,
      content,
      createdAt,
      ...(runId ? { runId } : {}),
    }];
  });
}

export function projectClientThreadSummaries<Mode extends string>(
  value: unknown,
  allowedModes: readonly Mode[],
  fallbackMode: Mode,
): ClientThreadSummary<Mode>[] {
  if (!Array.isArray(value)) return [];
  const modes = new Set<string>(allowedModes);
  return value.flatMap((candidate) => {
    const record = plainRecord(candidate);
    const id = text(record.id);
    const title = text(record.title);
    if (!id || !title) return [];
    const requestedMode = text(record.mode);
    const mode = modes.has(requestedMode) ? requestedMode as Mode : fallbackMode;
    return [{ id, title, updatedAt: text(record.updatedAt), mode }];
  });
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}
