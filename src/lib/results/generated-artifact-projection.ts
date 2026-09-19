export type ResultsGeneratedArtifact = Readonly<{
  id: string;
  kind: "document" | "presentation" | "spreadsheet" | "pdf";
  title: string;
  filename: string;
  currentVersion: number;
  status: "queued" | "rendering" | "ready" | "failed";
  mediaType: string;
  byteCount: number | null;
  createdAt: string;
  updatedAt: string;
  queuedAt: string;
  readyAt: string | null;
  failedAt: string | null;
  downloadUrl: string | null;
}>;

const artifactIdPattern = /^generated_artifact_[a-f0-9]{48}$/u;
const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const expectedMediaType = Object.freeze({
  document:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  presentation:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  spreadsheet:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
} satisfies Record<ResultsGeneratedArtifact["kind"], string>);
const expectedExtension = Object.freeze({
  document: ".docx",
  presentation: ".pptx",
  spreadsheet: ".xlsx",
  pdf: ".pdf",
} satisfies Record<ResultsGeneratedArtifact["kind"], string>);

/**
 * Treat the artifact listing as an untrusted transport contract. Only complete,
 * internally consistent current versions survive, and download URLs are always
 * rebuilt on this origin instead of accepting a server- or provider-supplied URL.
 */
export function projectResultsGeneratedArtifacts(
  payload: unknown,
): ResultsGeneratedArtifact[] {
  const candidates = record(payload).artifacts;
  if (!Array.isArray(candidates)) return [];

  const seen = new Set<string>();
  return candidates.slice(0, 12).flatMap((candidate) => {
    const artifact = record(candidate);
    const current = record(artifact.current);
    const id = boundedText(artifact.id, 80);
    const kind = artifact.kind;
    const title = boundedDisplayText(artifact.title, 240);
    const filename = safeFilename(artifact.filename);
    const currentVersion = positiveInteger(artifact.currentVersion);
    const version = positiveInteger(current.version);
    const status = current.status;
    const mediaType = boundedText(current.mediaType, 160).toLowerCase();
    const byteCount = nullableNonNegativeInteger(current.byteCount);
    const createdAt = isoTimestamp(artifact.createdAt);
    const updatedAt = isoTimestamp(artifact.updatedAt);
    const queuedAt = isoTimestamp(current.queuedAt);
    const readyAt = nullableIsoTimestamp(current.readyAt);
    const failedAt = nullableIsoTimestamp(current.failedAt);

    if (
      !artifactIdPattern.test(id) ||
      seen.has(id) ||
      !isArtifactKind(kind) ||
      !title ||
      !filename ||
      !filename.toLowerCase().endsWith(expectedExtension[kind]) ||
      currentVersion === undefined ||
      version !== currentVersion ||
      !isArtifactStatus(status) ||
      mediaType !== expectedMediaType[kind] ||
      byteCount === undefined ||
      !createdAt ||
      !updatedAt ||
      !queuedAt ||
      readyAt === undefined ||
      failedAt === undefined ||
      (status === "ready"
        ? byteCount === null || byteCount < 1 || !readyAt || failedAt !== null
        : byteCount !== null) ||
      (status === "failed" ? !failedAt || readyAt !== null : failedAt !== null) ||
      ((status === "queued" || status === "rendering") && readyAt !== null)
    ) {
      return [];
    }

    seen.add(id);
    return [Object.freeze({
      id,
      kind,
      title,
      filename,
      currentVersion,
      status,
      mediaType,
      byteCount,
      createdAt,
      updatedAt,
      queuedAt,
      readyAt,
      failedAt,
      downloadUrl: status === "ready"
        ? resultsGeneratedArtifactDownloadUrl(id, currentVersion)
        : null,
    })];
  });
}

export function resultsGeneratedArtifactDownloadUrl(
  artifactId: string,
  version: number,
) {
  if (
    !artifactIdPattern.test(artifactId) ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new Error("Invalid generated artifact identity.");
  }
  const query = new URLSearchParams({
    version: String(version),
    download: "1",
  });
  return `/api/artifacts/${encodeURIComponent(artifactId)}/content?${query.toString()}`;
}

function isArtifactKind(
  value: unknown,
): value is ResultsGeneratedArtifact["kind"] {
  return value === "document" ||
    value === "presentation" ||
    value === "spreadsheet" ||
    value === "pdf";
}

function isArtifactStatus(
  value: unknown,
): value is ResultsGeneratedArtifact["status"] {
  return value === "queued" ||
    value === "rendering" ||
    value === "ready" ||
    value === "failed";
}

function positiveInteger(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

function nullableNonNegativeInteger(value: unknown) {
  if (value === null) return null;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function nullableIsoTimestamp(value: unknown) {
  if (value === null) return null;
  const parsed = isoTimestamp(value);
  return parsed || undefined;
}

function isoTimestamp(value: unknown) {
  const text = boundedText(value, 100);
  return text &&
    isoTimestampPattern.test(text) &&
    Number.isFinite(Date.parse(text))
    ? text
    : "";
}

function safeFilename(value: unknown) {
  const filename = boundedText(value, 512);
  return filename &&
    !/[\u0000-\u001f\u007f/\\]/u.test(filename) &&
    filename !== "." &&
    filename !== ".."
    ? filename
    : "";
}

function boundedText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && text.length <= maxLength ? text : "";
}

function boundedDisplayText(value: unknown, maxLength: number) {
  const text = boundedText(value, maxLength);
  return text && !/[\u0000-\u001f\u007f]/u.test(text) ? text : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
