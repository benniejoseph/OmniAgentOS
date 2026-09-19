export type CommandWorkspaceArtifact = Readonly<{
  executionId: string;
  sequence: number;
  provider: "google_workspace";
  kind: "document" | "spreadsheet" | "presentation";
  resourceId: string;
  title: string;
  createdAt: string;
}>;

export type CommandWorkspaceArtifactState =
  | "pending"
  | "ready"
  | "none"
  | "unavailable";

const executionIdPattern = /^[A-Za-z0-9_.:@-]{1,240}$/;
const googleResourceIdPattern = /^[A-Za-z0-9_-]{10,240}$/;

/**
 * Project Google Workspace results through a narrow public contract. Provider
 * URLs are deliberately ignored: the UI derives the canonical Google editor
 * URL from the verified resource kind and identifier.
 */
export function projectCommandWorkspaceArtifacts(
  payload: unknown,
): CommandWorkspaceArtifact[] {
  const rawArtifacts = record(payload).workspaceArtifacts;
  if (!Array.isArray(rawArtifacts)) return [];

  const seen = new Set<string>();
  return rawArtifacts.slice(0, 64).flatMap((candidate) => {
    const artifact = record(candidate);
    const executionId = singleLineText(artifact.executionId, 240);
    const sequence = artifact.sequence;
    const kind = artifact.kind;
    const resourceId = singleLineText(artifact.resourceId, 240);
    const title = singleLineText(artifact.title, 240);
    const createdAt = isoDate(artifact.createdAt);

    if (
      !executionIdPattern.test(executionId) ||
      !Number.isSafeInteger(sequence) ||
      (sequence as number) < 0 ||
      (sequence as number) > 100_000 ||
      artifact.provider !== "google_workspace" ||
      !isWorkspaceArtifactKind(kind) ||
      !googleResourceIdPattern.test(resourceId) ||
      !title ||
      !createdAt ||
      seen.has(resourceId)
    ) {
      return [];
    }

    seen.add(resourceId);
    return [{
      executionId,
      sequence: sequence as number,
      provider: "google_workspace" as const,
      kind,
      resourceId,
      title,
      createdAt,
    }];
  }).sort((left, right) => left.sequence - right.sequence);
}

export function projectCommandWorkspaceArtifactState(
  payload: unknown,
): CommandWorkspaceArtifactState {
  const state = record(payload).workspaceArtifactState;
  return state === "pending" ||
      state === "ready" ||
      state === "none" ||
      state === "unavailable"
    ? state
    : "none";
}

export function commandWorkspaceArtifactUrl(
  kind: CommandWorkspaceArtifact["kind"],
  resourceId: string,
) {
  if (!isWorkspaceArtifactKind(kind) || !googleResourceIdPattern.test(resourceId)) {
    throw new Error("Invalid Google Workspace resource identity.");
  }
  const product = kind === "document"
    ? "document"
    : kind === "spreadsheet"
      ? "spreadsheets"
      : "presentation";
  return `https://docs.google.com/${product}/d/${encodeURIComponent(resourceId)}/edit`;
}

function isWorkspaceArtifactKind(
  value: unknown,
): value is CommandWorkspaceArtifact["kind"] {
  return value === "document" || value === "spreadsheet" || value === "presentation";
}

function isoDate(value: unknown) {
  const text = singleLineText(value, 100);
  if (!text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) {
    return "";
  }
  return Number.isFinite(Date.parse(text)) ? text : "";
}

function singleLineText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && text.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(text)
    ? text
    : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
