import { getCaptureAsset } from "@/lib/capture/assets";
import type { CaptureAssetStatus } from "@/lib/capture/types";
import { listStreamEvents } from "@/lib/events/store";
import { getToolExecutionsByIds } from "@/lib/tools/audit-store";

const MAX_RUN_MEDIA_ARTIFACTS = 64;
const assetIdPattern = /^[a-zA-Z0-9_-]{1,200}$/;

const mediaToolKinds = {
  "media.image.generate": { kind: "image", operation: "generate" },
  "media.image.edit": { kind: "image", operation: "edit" },
  "media.video.generate": { kind: "video", operation: "generate" },
  "media.video.edit": { kind: "video", operation: "edit" },
  "media.video.clip": { kind: "video", operation: "clip" },
} as const;

type RunMediaToolId = keyof typeof mediaToolKinds;

export type RunMediaArtifact = Readonly<{
  executionId: string;
  sequence: number;
  kind: "image" | "video";
  operation: "generate" | "edit" | "clip";
  assetId: string;
  filename: string;
  mediaType: string;
  byteCount: number;
  status: CaptureAssetStatus;
  contentUrl: string;
  createdAt: string;
}>;

/**
 * Rebuild the durable, client-safe media projection for one exact run owner.
 *
 * Run events supply only governed execution references. The matching execution
 * must belong to the same actor, name the same allowlisted media tool, and have
 * completed live. Capture metadata is then resolved through the exact
 * tenant/actor boundary. Raw tool input/output, binary content, provider URLs,
 * and arbitrary stored URLs never enter the projection.
 */
export async function listRunMediaArtifacts(
  runId: string,
  owner: { tenantId: string; actorId: string },
): Promise<RunMediaArtifact[]> {
  const events = await listStreamEvents(`run:${runId}`, {
    tenantId: owner.tenantId,
    limit: 2_000,
    order: "asc",
  });
  const references = new Map<string, {
    executionId: string;
    sequence: number;
    toolId: RunMediaToolId;
    createdAt: string;
  }>();

  for (const event of events) {
    if (event.type !== "run.tool") continue;
    const executionId = exactString(event.payload.executionId, 240);
    const toolId = mediaToolId(event.payload.toolId);
    if (
      !executionId ||
      !toolId ||
      event.payload.status !== "executed" ||
      event.payload.dryRun === true ||
      references.has(executionId)
    ) {
      continue;
    }
    references.set(executionId, {
      executionId,
      sequence: event.seq,
      toolId,
      createdAt: event.at,
    });
    if (references.size >= MAX_RUN_MEDIA_ARTIFACTS) break;
  }
  if (!references.size) return [];

  const executions = await getToolExecutionsByIds([...references.keys()], {
    tenantId: owner.tenantId,
  });
  const executionById = new Map(executions.map((execution) => [execution.id, execution]));

  const artifacts = await Promise.all([...references.values()].map(async (reference) => {
    const execution = executionById.get(reference.executionId);
    if (
      !execution ||
      execution.actorId !== owner.actorId ||
      execution.toolId !== reference.toolId ||
      execution.status !== "executed" ||
      execution.dryRun
    ) {
      return null;
    }
    const output = objectValue(execution.output);
    const assetId = exactString(objectValue(output.asset).id, 200);
    if (!assetId || !assetIdPattern.test(assetId)) return null;

    const expected = mediaToolKinds[reference.toolId];
    let asset: Awaited<ReturnType<typeof getCaptureAsset>>;
    try {
      asset = await getCaptureAsset(assetId, owner);
    } catch {
      asset = undefined;
    }
    if (
      !asset ||
      !asset.mediaType.startsWith(`${expected.kind}/`) ||
      exactString(asset.metadata.internalKind, 120)
    ) {
      return null;
    }

    return {
      executionId: execution.id,
      sequence: reference.sequence,
      kind: expected.kind,
      operation: expected.operation,
      assetId,
      filename: asset.filename,
      mediaType: asset.mediaType,
      byteCount: asset.byteCount,
      status: asset.status,
      contentUrl: `/api/capture/assets/${encodeURIComponent(asset.id)}?content=1`,
      createdAt: execution.completedAt || reference.createdAt,
    } satisfies RunMediaArtifact;
  }));

  return artifacts
    .filter((artifact): artifact is RunMediaArtifact => artifact !== null)
    .sort((left, right) => left.sequence - right.sequence);
}

function mediaToolId(value: unknown): RunMediaToolId | undefined {
  if (typeof value !== "string") return undefined;
  return Object.hasOwn(mediaToolKinds, value)
    ? value as RunMediaToolId
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
