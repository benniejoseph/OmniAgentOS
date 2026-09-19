export type CommandFileArtifact = Readonly<{
  executionId: string;
  sequence: number;
  artifactId: string;
  version: number;
  kind: "document" | "presentation" | "spreadsheet" | "pdf";
  title: string;
  filename: string;
  mediaType: string;
  byteCount: number;
  status: "ready";
  createdAt: string;
  slideCount?: number;
  theme?: "light" | "dark" | "aurora";
}>;

export type CommandFileArtifactState =
  | "pending"
  | "ready"
  | "none"
  | "unavailable";

const artifactIdPattern = /^generated_artifact_[a-f0-9]{48}$/;
const mediaTypes: Readonly<Record<CommandFileArtifact["kind"], string>> = {
  document: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  spreadsheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};
const themes = new Set<NonNullable<CommandFileArtifact["theme"]>>([
  "light",
  "dark",
  "aurora",
]);

/**
 * Project the run response through a narrow public contract. In particular,
 * never trust a tool/provider URL; the client derives its own same-origin URL
 * from the verified artifact identity and immutable version.
 */
export function projectCommandFileArtifacts(payload: unknown): CommandFileArtifact[] {
  const rawArtifacts = record(payload).fileArtifacts;
  if (!Array.isArray(rawArtifacts)) return [];

  const seen = new Set<string>();
  return rawArtifacts.slice(0, 64).flatMap((candidate) => {
    const artifact = record(candidate);
    const executionId = boundedText(artifact.executionId, 240);
    const artifactId = boundedText(artifact.artifactId, 80);
    const kind = artifact.kind;
    const sequence = artifact.sequence;
    const version = artifact.version;
    const title = boundedText(artifact.title, 240);
    const filename = safeFilename(artifact.filename);
    const mediaType = boundedText(artifact.mediaType, 160).toLowerCase();
    const byteCount = artifact.byteCount;
    const createdAt = boundedIsoDate(artifact.createdAt);
    const slideCount = artifact.slideCount;
    const theme = artifact.theme;
    const identity = `${artifactId}:v${String(version)}`;

    if (
      !executionId ||
      !artifactIdPattern.test(artifactId) ||
      seen.has(identity) ||
      !isArtifactKind(kind) ||
      artifact.status !== "ready" ||
      !Number.isSafeInteger(sequence) ||
      (sequence as number) < 0 ||
      !Number.isSafeInteger(version) ||
      (version as number) < 1 ||
      !title ||
      !filename ||
      mediaType !== mediaTypes[kind] ||
      !Number.isSafeInteger(byteCount) ||
      (byteCount as number) < 1 ||
      !createdAt ||
      (slideCount !== undefined && (
        kind !== "presentation" ||
        !Number.isSafeInteger(slideCount) ||
        (slideCount as number) < 1 ||
        (slideCount as number) > 24
      )) ||
      (theme !== undefined && (
        kind !== "presentation" ||
        !themes.has(theme as NonNullable<CommandFileArtifact["theme"]>)
      ))
    ) {
      return [];
    }

    seen.add(identity);
    return [{
      executionId,
      sequence: sequence as number,
      artifactId,
      version: version as number,
      kind,
      title,
      filename,
      mediaType,
      byteCount: byteCount as number,
      status: "ready" as const,
      createdAt,
      ...(slideCount === undefined ? {} : { slideCount: slideCount as number }),
      ...(theme === undefined ? {} : {
        theme: theme as NonNullable<CommandFileArtifact["theme"]>,
      }),
    }];
  }).sort((left, right) => left.sequence - right.sequence);
}

export function projectCommandFileArtifactState(
  payload: unknown,
): CommandFileArtifactState {
  const state = record(payload).fileArtifactState;
  return state === "pending" ||
      state === "ready" ||
      state === "none" ||
      state === "unavailable"
    ? state
    : "none";
}

export function commandArtifactContentUrl(
  artifactId: string,
  version: number,
  options: { download?: boolean } = {},
) {
  if (!artifactIdPattern.test(artifactId) || !Number.isSafeInteger(version) || version < 1) {
    throw new Error("Invalid generated artifact identity.");
  }
  const search = new URLSearchParams({ version: String(version) });
  if (options.download) search.set("download", "1");
  return `/api/artifacts/${encodeURIComponent(artifactId)}/content?${search.toString()}`;
}

function isArtifactKind(value: unknown): value is CommandFileArtifact["kind"] {
  return value === "document" ||
    value === "presentation" ||
    value === "spreadsheet" ||
    value === "pdf";
}

function safeFilename(value: unknown) {
  const filename = boundedText(value, 512);
  if (!filename || /[\u0000-\u001f\u007f/\\]/.test(filename) || filename === "." || filename === "..") {
    return "";
  }
  return filename;
}

function boundedIsoDate(value: unknown) {
  const text = boundedText(value, 100);
  return text && Number.isFinite(Date.parse(text)) ? text : "";
}

function boundedText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length <= maxLength ? text : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
