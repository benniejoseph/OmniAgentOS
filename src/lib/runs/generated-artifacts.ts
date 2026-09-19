import { generatedArtifactIdSchema } from "@/lib/artifacts/contracts";
import { presentationBlueprintSchema } from "@/lib/artifacts/presentation-spec";
import { getGeneratedArtifactVersion } from "@/lib/artifacts/store";
import { listStreamEvents } from "@/lib/events/store";
import { getToolExecutionsByIds } from "@/lib/tools/audit-store";

const MAX_RUN_FILE_ARTIFACTS = 64;
const PRESENTATION_TOOL_ID = "app.artifacts.presentations.create" as const;
const PRESENTATION_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export type RunFileArtifact = Readonly<{
  executionId: string;
  sequence: number;
  artifactId: string;
  version: number;
  kind: "presentation";
  title: string;
  filename: string;
  mediaType: typeof PRESENTATION_MIME_TYPE;
  byteCount: number;
  status: "ready";
  contentUrl: string;
  createdAt: string;
  slideCount?: number;
  theme?: "light" | "dark" | "aurora";
}>;

/**
 * Rebuild a client-safe file projection from governed run evidence.
 *
 * The run event identifies an execution, but does not authorize a file. The
 * execution must be an exact actor-owned, live invocation of the allowlisted
 * creator. Its output may only name an artifact/version; every displayed field
 * and the download URL are rebuilt from the canonical artifact store.
 */
export async function listRunGeneratedArtifacts(
  runId: string,
  owner: { tenantId: string; actorId: string },
): Promise<RunFileArtifact[]> {
  const events = await listStreamEvents(`run:${runId}`, {
    tenantId: owner.tenantId,
    limit: 2_000,
    order: "asc",
  });
  const references = new Map<string, {
    executionId: string;
    sequence: number;
    createdAt: string;
  }>();

  for (const event of events) {
    if (event.type !== "run.tool") continue;
    const executionId = exactString(event.payload.executionId, 240);
    if (
      !executionId ||
      event.payload.toolId !== PRESENTATION_TOOL_ID ||
      event.payload.status !== "executed" ||
      event.payload.dryRun === true ||
      references.has(executionId)
    ) {
      continue;
    }
    references.set(executionId, {
      executionId,
      sequence: event.seq,
      createdAt: event.at,
    });
    if (references.size >= MAX_RUN_FILE_ARTIFACTS) break;
  }
  if (!references.size) return [];

  const executions = await getToolExecutionsByIds([...references.keys()], {
    tenantId: owner.tenantId,
  });
  const executionById = new Map(
    executions.map((execution) => [execution.id, execution]),
  );
  const artifacts = await Promise.all([...references.values()].map(async (reference) => {
    const execution = executionById.get(reference.executionId);
    if (
      !execution ||
      execution.actorId !== owner.actorId ||
      execution.toolId !== PRESENTATION_TOOL_ID ||
      execution.status !== "executed" ||
      execution.dryRun
    ) {
      return null;
    }

    const outputArtifact = objectValue(objectValue(execution.output).artifact);
    const artifactId = generatedArtifactIdSchema.safeParse(
      outputArtifact.artifactId,
    );
    const artifactVersion = positiveInteger(outputArtifact.version);
    if (!artifactId.success || artifactVersion === undefined) return null;

    let canonical: Awaited<ReturnType<typeof getGeneratedArtifactVersion>>;
    try {
      canonical = await getGeneratedArtifactVersion({
        tenantId: owner.tenantId,
        ownerActorId: owner.actorId,
        artifactId: artifactId.data,
        artifactVersion,
      });
    } catch {
      canonical = undefined;
    }
    if (
      !canonical ||
      canonical.artifactId !== artifactId.data ||
      canonical.version !== artifactVersion ||
      canonical.kind !== "presentation" ||
      canonical.renderStatus !== "ready" ||
      canonical.mediaType !== PRESENTATION_MIME_TYPE ||
      canonical.byteCount === null ||
      canonical.byteCount < 1 ||
      canonical.contentSha256 === null
    ) {
      return null;
    }

    const blueprint = presentationBlueprintSchema.safeParse(canonical.spec);
    return {
      executionId: execution.id,
      sequence: reference.sequence,
      artifactId: canonical.artifactId,
      version: canonical.version,
      kind: "presentation",
      title: canonical.title,
      filename: presentationFilename(canonical.title),
      mediaType: PRESENTATION_MIME_TYPE,
      byteCount: canonical.byteCount,
      status: "ready",
      contentUrl: `/api/artifacts/${encodeURIComponent(canonical.artifactId)}/content?version=${canonical.version}`,
      createdAt: execution.completedAt || canonical.readyAt || reference.createdAt,
      ...(blueprint.success
        ? {
            slideCount: blueprint.data.slides.length,
            theme: blueprint.data.theme,
          }
        : {}),
    } satisfies RunFileArtifact;
  }));

  return artifacts
    .filter((artifact): artifact is RunFileArtifact => artifact !== null)
    .sort((left, right) => left.sequence - right.sequence);
}

function presentationFilename(title: string) {
  const basename = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/gu, "")
    .slice(0, 180) || "Asael presentation";
  return `${basename}.pptx`;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

function exactString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && text.length <= maxLength ? text : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
