import { z } from "zod";

import {
  GENERATED_ARTIFACT_SCHEMA_VERSION,
  generatedArtifactIdSchema,
  generatedArtifactKindSchema,
  generatedArtifactRenderStatusSchema,
  generatedArtifactVersionIdSchema,
  type GeneratedArtifactVersionRecord,
} from "@/lib/artifacts/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const GENERATED_ARTIFACT_EVENT_TYPES = Object.freeze({
  queued: "generated_artifact.version.queued",
  rendering: "generated_artifact.version.rendering",
  ready: "generated_artifact.version.ready",
  failed: "generated_artifact.version.failed",
} as const);

export type GeneratedArtifactEventType =
  (typeof GENERATED_ARTIFACT_EVENT_TYPES)[keyof typeof GENERATED_ARTIFACT_EVENT_TYPES];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const basePayloadShape = {
  schemaVersion: z.literal(GENERATED_ARTIFACT_SCHEMA_VERSION),
  artifactId: generatedArtifactIdSchema,
  artifactVersionId: generatedArtifactVersionIdSchema,
  artifactVersion: z.number().int().positive(),
  kind: generatedArtifactKindSchema,
  renderStatus: generatedArtifactRenderStatusSchema,
  specSha256: sha256Schema,
  mediaTypeSha256: sha256Schema,
  contentSha256: sha256Schema.nullable(),
  byteCount: z.number().int().positive().nullable(),
  projectId: z.string().max(240).nullable(),
  missionId: z.string().max(240).nullable(),
  workItemId: z.string().max(240).nullable(),
  lineageRefCount: z.number().int().min(0).max(64),
  evidenceRefCount: z.number().int().min(0).max(64),
  googleResourceType: z
    .enum(["document", "presentation", "spreadsheet"])
    .nullable(),
  idempotencyKeySha256: sha256Schema,
  requestSha256: sha256Schema,
  failureCode: z.string().regex(/^[a-z0-9_]{1,80}$/).nullable(),
};

export const generatedArtifactEventPayloadSchema = z.object(
  basePayloadShape,
).strict().superRefine((value, context) => {
  const outputPresent = value.contentSha256 !== null && value.byteCount !== null;
  if ((value.renderStatus === "ready") !== outputPresent) {
    context.addIssue({
      code: "custom",
      message: "Only ready artifact events may bind rendered output.",
      path: ["contentSha256"],
    });
  }
  if ((value.renderStatus === "failed") !== (value.failureCode !== null)) {
    context.addIssue({
      code: "custom",
      message: "Only failed artifact events may bind a failure code.",
      path: ["failureCode"],
    });
  }
});

export type GeneratedArtifactEventPayload = z.infer<
  typeof generatedArtifactEventPayloadSchema
>;

export function generatedArtifactEventPayload(input: {
  version: GeneratedArtifactVersionRecord;
  idempotencyKeySha256: string;
  requestSha256: string;
}) {
  return generatedArtifactEventPayloadSchema.parse({
    schemaVersion: GENERATED_ARTIFACT_SCHEMA_VERSION,
    artifactId: input.version.artifactId,
    artifactVersionId: input.version.id,
    artifactVersion: input.version.version,
    kind: input.version.kind,
    renderStatus: input.version.renderStatus,
    specSha256: input.version.specSha256,
    mediaTypeSha256: canonicalJsonSha256(input.version.mediaType),
    contentSha256: input.version.contentSha256,
    byteCount: input.version.byteCount,
    projectId: input.version.projectId,
    missionId: input.version.missionId,
    workItemId: input.version.workItemId,
    lineageRefCount: input.version.lineageRefs.length,
    evidenceRefCount: input.version.evidenceRefs.length,
    googleResourceType: input.version.googleResourceRef?.resourceType || null,
    idempotencyKeySha256: input.idempotencyKeySha256,
    requestSha256: input.requestSha256,
    failureCode: input.version.failureCode,
  });
}

export function generatedArtifactMutationEventId(input: {
  tenantId: string;
  ownerActorId: string;
  artifactVersionId: string;
  type: GeneratedArtifactEventType;
  idempotencyKeySha256: string;
}) {
  return `generated-artifact-event:${canonicalJsonSha256(input)}`;
}
