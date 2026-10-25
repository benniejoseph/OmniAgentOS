import { runWithDatabaseActorScope } from "@/lib/db/client";
import {
  getCaptureAsset,
  getCaptureAssetContent,
  listCaptureAssets,
  saveCaptureAsset,
} from "@/lib/capture/assets";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import type { CaptureAsset } from "@/lib/capture/types";
import { createHash } from "node:crypto";
import { loadImage } from "@napi-rs/canvas";
import { imageSize } from "image-size";
import { spawn } from "node:child_process";
import { resolveFfmpegPath } from "@/lib/media/clip";
import { studioAssetUrl, type StudioAsset } from "./contracts";
import { StudioError, type StudioOwner } from "./server-types";
import { withStudioTransaction } from "./store";
import { verifyStudioAuthority } from "./authority";
export function studioAsset(asset: CaptureAsset): StudioAsset {
  const m = asset.metadata;
  return {
    id: asset.id,
    filename: asset.filename,
    mediaType: asset.mediaType,
    byteCount: asset.byteCount,
    contentSha256: asset.contentSha256,
    contentUrl: studioAssetUrl(asset.id),
    createdAt: asset.createdAt,
    metadata: studioAssetMetadata(m),
    origin: typeof m.studioRunId === "string" ? "studio" : "capture",
    demo: m.studioDemo === true,
    ...(typeof m.width === "number" ? { width: m.width } : {}),
    ...(typeof m.height === "number" ? { height: m.height } : {}),
    ...(typeof m.durationSeconds === "number"
      ? { durationSeconds: m.durationSeconds }
      : {}),
  };
}
/** Public lineage only; provider response bodies, URLs and arbitrary capture metadata stay private. */
function studioAssetMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const publicMetadata: Record<string, unknown> = {};
  for (const key of [
    "provider",
    "model",
    "providerRequestId",
    "capabilityId",
    "capabilityHash",
    "studioFlowId",
    "studioRunId",
    "studioNodeId",
    "studioAttemptId",
  ]) {
    const value = metadata[key];
    if (typeof value === "string" && value.length <= 500)
      publicMetadata[key] = value;
  }
  for (const key of ["capabilitySchemaVersion", "studioOutputIndex"]) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      publicMetadata[key] = value;
  }
  for (const key of ["effectivePrompt", "providerPrompt"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.length <= 20_000)
      publicMetadata[key] = value;
  }
  if (
    metadata.parameters &&
    typeof metadata.parameters === "object" &&
    !Array.isArray(metadata.parameters)
  ) {
    publicMetadata.parameters = Object.fromEntries(
      Object.entries(metadata.parameters).filter(
        ([key, value]) =>
          /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key) &&
          (typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)) ||
            (typeof value === "string" && value.length <= 500)),
      ),
    );
  }
  if (Array.isArray(metadata.inputs)) {
    publicMetadata.inputs = metadata.inputs.slice(0, 32).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const { assetId, contentSha256, mediaType, role } = value as Record<
        string,
        unknown
      >;
      return typeof assetId === "string" &&
        assetId.length <= 200 &&
        typeof contentSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(contentSha256) &&
        typeof mediaType === "string" &&
        mediaType.length <= 100 &&
        typeof role === "string" &&
        role.length <= 100
        ? [{ assetId, contentSha256, mediaType, role }]
        : [];
    });
  }
  return publicMetadata;
}
async function readStudioAssetInScope(
  owner: StudioOwner,
  id: string,
  expectedHash?: string,
) {
  for (const actorId of [
    owner.actorId,
    ...(owner.legacyActorId ? [owner.legacyActorId] : []),
  ]) {
    const asset = await getCaptureAsset(id, {
      tenantId: owner.tenantId,
      actorId,
    });
    if (!asset) continue;
    if (
      !/^(image\/(png|jpeg|webp)|video\/(mp4|webm)|audio\/(mpeg|wav|ogg|mp4))$/.test(
        asset.mediaType,
      )
    )
      throw new StudioError(
        "This asset is not supported studio media.",
        400,
        "studio_asset_type",
      );
    if (expectedHash && asset.contentSha256 !== expectedHash)
      throw new StudioError(
        "A referenced asset changed; quote the flow again.",
        409,
        "studio_asset_changed",
      );
    return { asset, actorId };
  }
  throw new StudioError(
    "A referenced asset is unavailable or belongs to another account.",
    404,
    "studio_asset_unavailable",
  );
}
async function readStudioAssetBytesInScope(
  owner: StudioOwner,
  id: string,
  expectedHash?: string,
) {
  const result = await readStudioAsset(owner, id, expectedHash);
  const content = await getCaptureAssetContent(id, {
    tenantId: owner.tenantId,
    actorId: result.actorId,
  });
  if (
    expectedHash &&
    createHash("sha256").update(content.bytes).digest("hex") !== expectedHash
  )
    throw new StudioError(
      "The reference failed content verification.",
      409,
      "studio_asset_integrity",
    );
  return { ...content, view: studioAsset(result.asset) };
}
export async function listStudioAssets(context: SecurityContext) {
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  const actorIds = binding
    ? [...binding.readableOwnerActorIds]
    : [context.actorId];
  return runWithDatabaseActorScope(context.tenantId, actorIds, async () => {
    const pages = await Promise.all(
      actorIds.map((actorId) =>
        listCaptureAssets({ tenantId: context.tenantId, actorId }, 100),
      ),
    );
    const unique = new Map(
      pages
        .flat()
        .filter(
          (a) =>
            /^(image|video|audio)\//.test(a.mediaType) && a.contentAvailable,
        )
        .map((a) => [a.id, a]),
    );
    return [...unique.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100)
      .map(studioAsset);
  });
}
async function uploadStudioAssetInScope(
  owner: StudioOwner,
  file: File,
  key: string,
) {
  if (file.size < 1 || file.size > 3 * 1024 * 1024)
    throw new StudioError(
      "Upload a media file of 3 MB or smaller.",
      413,
      "studio_upload_limit",
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  const media = await validateStudioMedia(bytes, file.type);
  const requestId = `upload:${hash(key)}`;
  const requestHash = hash(
    JSON.stringify([file.name, media.mediaType, hash(bytes)]),
  );
  await withStudioTransaction(owner, async (tx) => {
    await verifyStudioAuthority(tx, owner);
    const prior = await tx.get<{ requestHash: string }>("request", requestId);
    if (prior && prior.requestHash !== requestHash)
      throw new StudioError(
        "This upload key was already used for a different file.",
        409,
        "studio_idempotency_conflict",
      );
    if (!prior) await tx.put("request", requestId, { requestHash });
  });
  const asset = await saveCaptureAsset({
    tenantId: owner.tenantId,
    actorId: owner.actorId,
    executionScope: createExecutionScope({
      tenantId: owner.tenantId,
      initiatingActorId: owner.actorId,
      executingPrincipalType: "user",
      executingPrincipalId: owner.actorId,
      correlationId: `studio-upload:${hash(key)}`,
      purpose: "studio.asset.upload",
    }),
    filename: file.name,
    mediaType: media.mediaType,
    bytes,
    tags: ["studio"],
    metadata: media,
  });
  return studioAsset(asset);
}
export async function validateStudioMedia(
  bytes: Uint8Array,
  declared: string,
): Promise<{
  mediaType: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}> {
  const b = Buffer.from(bytes);
  let mediaType = "";
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    mediaType = "image/png";
  else if (b[0] === 255 && b[1] === 216 && b[2] === 255)
    mediaType = "image/jpeg";
  else if (
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  )
    mediaType = "image/webp";
  else if (b.toString("ascii", 4, 8) === "ftyp")
    mediaType = declared.startsWith("audio/") ? "audio/mp4" : "video/mp4";
  else if (b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    mediaType = "video/webm";
  else if (
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WAVE"
  )
    mediaType = "audio/wav";
  else if (b.toString("ascii", 0, 4) === "OggS") mediaType = "audio/ogg";
  else if (
    b.toString("ascii", 0, 3) === "ID3" ||
    (b[0] === 255 && (b[1] & 224) === 224)
  )
    mediaType = "audio/mpeg";
  if (!mediaType)
    throw new StudioError(
      "Use a valid PNG, JPEG, WebP, MP4, WebM, WAV, Ogg or MP3 file.",
      415,
      "studio_media_invalid",
    );
  if (
    declared &&
    declared !== "application/octet-stream" &&
    declared !== mediaType &&
    !(declared === "audio/x-wav" && mediaType === "audio/wav")
  )
    throw new StudioError(
      "The file content does not match its media type.",
      415,
      "studio_media_mismatch",
    );
  if (mediaType.startsWith("image/")) {
    try {
      const dimensions = imageSize(b);
      if (
        !dimensions.width ||
        !dimensions.height ||
        dimensions.width * dimensions.height > 40_000_000
      )
        throw new Error("size");
      const image = await loadImage(b);
      if (image.width * image.height > 40_000_000) throw new Error("size");
      return { mediaType, width: image.width, height: image.height };
    } catch {
      throw new StudioError(
        "The image is invalid or exceeds 40 megapixels.",
        415,
        "studio_image_invalid",
      );
    }
  }
  let executablePath: string;
  try {
    executablePath = resolveFfmpegPath();
  } catch {
    throw new StudioError(
      "Media validation is temporarily unavailable.",
      503,
      "studio_media_validator_unavailable",
    );
  }
  let metadata = "";
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      executablePath,
      [
        "-hide_banner",
        "-loglevel",
        "info",
        "-protocol_whitelist",
        "pipe",
        "-i",
        "pipe:0",
        "-t",
        "2",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(
        new StudioError(
          "Media validation timed out.",
          415,
          "studio_media_invalid",
        ),
      );
    }, 15000);
    p.stderr.on("data", (v) => {
      metadata = (metadata + String(v)).slice(0, 16000);
    });
    p.on("error", () => {
      clearTimeout(timer);
      reject(new StudioError("Media validation is unavailable.", 503));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new StudioError(
            "The audio or video could not be decoded.",
            415,
            "studio_media_invalid",
          ),
        );
    });
    p.stdin.on("error", () => undefined);
    p.stdin.end(b);
  });
  const duration = metadata.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const size = metadata.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return {
    mediaType,
    ...(duration
      ? {
          durationSeconds:
            Number(duration[1]) * 3600 +
            Number(duration[2]) * 60 +
            Number(duration[3]),
        }
      : {}),
    ...(size ? { width: Number(size[1]), height: Number(size[2]) } : {}),
  };
}
function hash(v: string | Uint8Array) {
  return createHash("sha256").update(v).digest("hex");
}

function assetOwnerScope<T>(owner: StudioOwner, work: () => Promise<T>) {
  return runWithDatabaseActorScope(
    owner.tenantId,
    [owner.actorId, ...(owner.legacyActorId ? [owner.legacyActorId] : [])],
    work,
  );
}
export function readStudioAsset(
  owner: StudioOwner,
  id: string,
  expectedHash?: string,
) {
  return assetOwnerScope(owner, () =>
    readStudioAssetInScope(owner, id, expectedHash),
  );
}
export function readStudioAssetBytes(
  owner: StudioOwner,
  id: string,
  expectedHash?: string,
) {
  return assetOwnerScope(owner, () =>
    readStudioAssetBytesInScope(owner, id, expectedHash),
  );
}
export function uploadStudioAsset(owner: StudioOwner, file: File, key: string) {
  return assetOwnerScope(owner, () =>
    uploadStudioAssetInScope(owner, file, key),
  );
}
