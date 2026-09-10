export type CommandMediaArtifact = Readonly<{
  executionId: string;
  sequence: number;
  kind: "image" | "video";
  operation: "generate" | "edit" | "clip";
  assetId: string;
  filename: string;
  mediaType: string;
  byteCount: number;
  status: "stored" | "queued" | "indexed" | "unsupported" | "failed";
  createdAt: string;
}>;

const captureAssetIdPattern = /^[a-zA-Z0-9_-]{1,200}$/;
const mediaLinkPattern = /^!?\[([^\]\n]{1,160})\]\((\/api\/capture\/assets\/[^)\s]+)\)$/;
const statuses = new Set<CommandMediaArtifact["status"]>([
  "stored",
  "queued",
  "indexed",
  "unsupported",
  "failed",
]);

/**
 * Treat the run response as untrusted. Only the documented, bounded media
 * projection crosses into the Command renderer; provider URLs are ignored.
 */
export function projectCommandMediaArtifacts(payload: unknown): CommandMediaArtifact[] {
  const rawArtifacts = record(payload).mediaArtifacts;
  if (!Array.isArray(rawArtifacts)) return [];

  const seen = new Set<string>();
  return rawArtifacts.slice(0, 64).flatMap((candidate) => {
    const artifact = record(candidate);
    const executionId = boundedText(artifact.executionId, 240);
    const assetId = boundedText(artifact.assetId, 200);
    const kind = artifact.kind;
    const operation = artifact.operation;
    const status = artifact.status;
    const sequence = artifact.sequence;
    const byteCount = artifact.byteCount;
    const filename = boundedText(artifact.filename, 512);
    const mediaType = boundedText(artifact.mediaType, 160).toLowerCase();
    const createdAt = boundedText(artifact.createdAt, 100);

    if (
      !executionId ||
      !assetId ||
      !captureAssetIdPattern.test(assetId) ||
      seen.has(assetId) ||
      (kind !== "image" && kind !== "video") ||
      (operation !== "generate" && operation !== "edit" && operation !== "clip") ||
      (kind === "image" && operation === "clip") ||
      !statuses.has(status as CommandMediaArtifact["status"]) ||
      !Number.isSafeInteger(sequence) ||
      (sequence as number) < 0 ||
      !Number.isSafeInteger(byteCount) ||
      (byteCount as number) < 0 ||
      !filename ||
      !mediaType.startsWith(`${kind}/`)
    ) {
      return [];
    }

    seen.add(assetId);
    return [{
      executionId,
      sequence: sequence as number,
      kind,
      operation,
      assetId,
      filename,
      mediaType,
      byteCount: byteCount as number,
      status: status as CommandMediaArtifact["status"],
      createdAt,
    }];
  });
}

/**
 * Older completed turns stored a safe Capture content link inside prose before
 * Command had a first-class artifact contract. Recover only an exact, relative
 * owner-scoped link on its own line and remove that raw Markdown from the copy.
 */
export function extractLegacyCommandMedia(content: unknown): {
  content: string;
  artifacts: CommandMediaArtifact[];
} {
  if (typeof content !== "string") return { content: "", artifacts: [] };
  const artifacts: CommandMediaArtifact[] = [];
  const seen = new Set<string>();
  const retainedLines: string[] = [];

  for (const line of content.replaceAll("\r\n", "\n").split("\n")) {
    const match = mediaLinkPattern.exec(line.trim());
    const recovered = match
      ? legacyArtifactFromLink(match[1], match[2], artifacts.length)
      : undefined;
    if (!recovered || seen.has(recovered.assetId)) {
      retainedLines.push(line);
      continue;
    }
    seen.add(recovered.assetId);
    artifacts.push(recovered);
  }

  return {
    content: retainedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    artifacts,
  };
}

export function mergeCommandMediaArtifacts(
  projected: readonly CommandMediaArtifact[],
  recovered: readonly CommandMediaArtifact[],
) {
  const byAssetId = new Map<string, CommandMediaArtifact>();
  for (const artifact of [...recovered, ...projected]) {
    if (captureAssetIdPattern.test(artifact.assetId)) {
      byAssetId.set(artifact.assetId, artifact);
    }
  }
  return [...byAssetId.values()].sort((left, right) => left.sequence - right.sequence);
}

function legacyArtifactFromLink(
  label: string,
  target: string,
  sequence: number,
): CommandMediaArtifact | undefined {
  const kind = mediaKindFromLabel(label);
  if (!kind || !target.startsWith("/")) return undefined;

  try {
    const url = new URL(target, "https://command.invalid");
    if (url.origin !== "https://command.invalid" || url.searchParams.get("content") !== "1") {
      return undefined;
    }
    const pathMatch = /^\/api\/capture\/assets\/([^/]+)$/.exec(url.pathname);
    if (!pathMatch) return undefined;
    const assetId = decodeURIComponent(pathMatch[1]);
    if (!captureAssetIdPattern.test(assetId)) return undefined;
    const operation = operationFromLabel(label, kind);
    return {
      executionId: `legacy-link:${assetId}`,
      sequence,
      kind,
      operation,
      assetId,
      filename: `Generated ${kind}`,
      mediaType: `${kind}/*`,
      byteCount: 0,
      status: "stored",
      createdAt: "",
    };
  } catch {
    return undefined;
  }
}

function mediaKindFromLabel(label: string): CommandMediaArtifact["kind"] | undefined {
  const normalized = label.toLowerCase();
  if (/\b(video|clip|movie|animation)\b/.test(normalized)) return "video";
  if (/\b(image|photo|picture|portrait|illustration|render)\b/.test(normalized)) return "image";
  return undefined;
}

function operationFromLabel(
  label: string,
  kind: CommandMediaArtifact["kind"],
): CommandMediaArtifact["operation"] {
  const normalized = label.toLowerCase();
  if (kind === "video" && /\bclip(?:ped)?\b/.test(normalized)) return "clip";
  return /\b(edit|edited|retouch|retouched)\b/.test(normalized) ? "edit" : "generate";
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
