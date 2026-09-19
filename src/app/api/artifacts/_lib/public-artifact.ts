import type {
  GeneratedArtifactRecord,
  GeneratedArtifactVersionRecord,
} from "@/lib/artifacts/contracts";

export type PublicGeneratedArtifact = Readonly<{
  id: string;
  kind: GeneratedArtifactRecord["kind"];
  title: string;
  filename: string;
  currentVersion: number;
  projectId: string | null;
  missionId: string | null;
  workItemId: string | null;
  createdAt: string;
  updatedAt: string;
  current: Readonly<{
    version: number;
    status: GeneratedArtifactVersionRecord["renderStatus"];
    mediaType: string;
    byteCount: number | null;
    queuedAt: string;
    readyAt: string | null;
    failedAt: string | null;
    contentUrl: string | null;
  }>;
}>;

/**
 * Project canonical artifact records into the intentionally small API shape.
 * Specs, lineage/evidence internals, hashes, provider references, and execution
 * authority never cross this boundary.
 */
export function publicGeneratedArtifact(
  artifact: GeneratedArtifactRecord,
  version: GeneratedArtifactVersionRecord,
): PublicGeneratedArtifact {
  if (
    version.artifactId !== artifact.id ||
    version.version !== artifact.currentVersion ||
    version.kind !== artifact.kind
  ) {
    throw new Error("Generated artifact head and current version do not match.");
  }
  const ready = version.renderStatus === "ready";
  return Object.freeze({
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    filename: generatedArtifactFilename(artifact.title, artifact.kind),
    currentVersion: artifact.currentVersion,
    projectId: artifact.projectId,
    missionId: artifact.missionId,
    workItemId: artifact.workItemId,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    current: Object.freeze({
      version: version.version,
      status: version.renderStatus,
      mediaType: version.mediaType,
      byteCount: version.byteCount,
      queuedAt: version.queuedAt,
      readyAt: version.readyAt,
      failedAt: version.failedAt,
      contentUrl: ready
        ? generatedArtifactContentUrl(artifact.id, version.version)
        : null,
    }),
  });
}

export function generatedArtifactContentUrl(
  artifactId: string,
  version: number,
) {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/content?version=${version}`;
}

export function generatedArtifactFilename(
  title: string,
  kind: GeneratedArtifactRecord["kind"],
) {
  const extension = {
    document: "docx",
    presentation: "pptx",
    spreadsheet: "xlsx",
    pdf: "pdf",
  }[kind];
  const basename = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/gu, "")
    .slice(0, 180) || "Asael artifact";
  return `${basename}.${extension}`;
}

export function contentDispositionAttachment(filename: string) {
  const ascii = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/gu, "")
    .replace(/["\\]/gu, "_")
    .replace(/[;\r\n]/gu, "_")
    .trim()
    .slice(0, 200) || "asael-artifact";
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
