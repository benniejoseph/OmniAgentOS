import { z } from "zod";

import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const GENERATED_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const GENERATED_ARTIFACT_CONTRACT_VERSION =
  "asael.generated-artifact:1" as const;
export const MAX_GENERATED_ARTIFACT_SPEC_BYTES = 512 * 1024;
export const MAX_GENERATED_ARTIFACT_REFERENCE_COUNT = 64;

export const generatedArtifactKindSchema = z.enum([
  "document",
  "presentation",
  "spreadsheet",
  "pdf",
]);
export type GeneratedArtifactKind = z.infer<
  typeof generatedArtifactKindSchema
>;

export const generatedArtifactRenderStatusSchema = z.enum([
  "queued",
  "rendering",
  "ready",
  "failed",
]);
export type GeneratedArtifactRenderStatus = z.infer<
  typeof generatedArtifactRenderStatusSchema
>;

const boundedIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const generatedArtifactIdSchema = z
  .string()
  .regex(/^generated_artifact_[a-f0-9]{48}$/);
export const generatedArtifactVersionIdSchema = z
  .string()
  .regex(/^generated_artifact_[a-f0-9]{48}:v[1-9][0-9]*$/);

export const googleArtifactResourceRefSchema = z.object({
  provider: z.literal("google_workspace"),
  resourceType: z.enum(["document", "presentation", "spreadsheet"]),
  resourceId: boundedIdSchema,
  revisionId: boundedIdSchema.nullable().default(null),
}).strict();
export type GoogleArtifactResourceRef = z.infer<
  typeof googleArtifactResourceRefSchema
>;

export type GeneratedArtifactSpec = Readonly<Record<string, unknown>>;

export type GeneratedArtifactMutationContext = Readonly<{
  executionScope: ExecutionScope;
  idempotencyKey: string;
}>;

export type GeneratedArtifactRecord = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  kind: GeneratedArtifactKind;
  title: string;
  currentVersion: number;
  currentVersionId: string;
  projectId: string | null;
  missionId: string | null;
  workItemId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type GeneratedArtifactVersionRecord = Readonly<{
  schemaVersion: typeof GENERATED_ARTIFACT_SCHEMA_VERSION;
  contractVersion: typeof GENERATED_ARTIFACT_CONTRACT_VERSION;
  id: string;
  artifactId: string;
  tenantId: string;
  ownerActorId: string;
  version: number;
  kind: GeneratedArtifactKind;
  title: string;
  renderStatus: GeneratedArtifactRenderStatus;
  spec: GeneratedArtifactSpec;
  specSha256: string;
  mediaType: string;
  contentSha256: string | null;
  byteCount: number | null;
  lineageRefs: readonly string[];
  evidenceRefs: readonly string[];
  projectId: string | null;
  missionId: string | null;
  workItemId: string | null;
  googleResourceRef: GoogleArtifactResourceRef | null;
  failureCode: string | null;
  executionScope: ExecutionScope;
  queuedAt: string;
  renderingStartedAt: string | null;
  readyAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export function parseGeneratedArtifactSpec(
  value: unknown,
): GeneratedArtifactSpec {
  const budget = { nodes: 0 };
  assertBoundedJsonValue(value, 0, budget, true);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_GENERATED_ARTIFACT_SPEC_BYTES) {
    throw new Error("Generated artifact spec exceeds the 512 KiB limit.");
  }
  return structuredClone(value) as GeneratedArtifactSpec;
}

export function generatedArtifactSpecSha256(value: unknown) {
  return canonicalJsonSha256(parseGeneratedArtifactSpec(value));
}

export function normalizeGeneratedArtifactRefs(
  values: readonly string[] | undefined,
  label: string,
) {
  const normalized = [...new Set((values || []).map((value) =>
    boundedIdSchema.parse(value)
  ))].sort();
  if (normalized.length > MAX_GENERATED_ARTIFACT_REFERENCE_COUNT) {
    throw new Error(
      `${label} cannot contain more than ${MAX_GENERATED_ARTIFACT_REFERENCE_COUNT} references.`,
    );
  }
  return Object.freeze(normalized);
}

export function parseGoogleArtifactResourceRef(
  value: unknown,
): GoogleArtifactResourceRef | null {
  if (value === null || value === undefined) return null;
  return Object.freeze(googleArtifactResourceRefSchema.parse(value));
}

export function assertGeneratedArtifactSha256(value: unknown, label: string) {
  try {
    return sha256Schema.parse(value);
  } catch {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertBoundedJsonValue(
  value: unknown,
  depth: number,
  budget: { nodes: number },
  requireObject = false,
) {
  budget.nodes += 1;
  if (budget.nodes > 50_000 || depth > 40) {
    throw new Error("Generated artifact spec is too deeply nested or complex.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (requireObject) {
      throw new Error("Generated artifact spec must be a JSON object.");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Generated artifact spec contains a non-finite number.");
    }
    if (requireObject) {
      throw new Error("Generated artifact spec must be a JSON object.");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (requireObject) {
      throw new Error("Generated artifact spec must be a JSON object.");
    }
    for (const item of value) assertBoundedJsonValue(item, depth + 1, budget);
    return;
  }
  if (typeof value !== "object") {
    throw new Error("Generated artifact spec must contain only JSON values.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Generated artifact spec must contain only plain JSON objects.");
  }
  for (const [key, item] of Object.entries(value)) {
    if (!key || Array.from(key).length > 240) {
      throw new Error("Generated artifact spec contains an invalid object key.");
    }
    assertBoundedJsonValue(item, depth + 1, budget);
  }
}
