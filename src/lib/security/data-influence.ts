import { z } from "zod";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const DATA_INFLUENCE_MANIFEST_SCHEMA_VERSION = 1 as const;

export const dataInfluenceAuthorityKindSchema = z.enum([
  "authenticated_intent",
  "explicit_approval",
  "standing_grant",
]);

export const untrustedDataInfluenceKindSchema = z.enum([
  "memory",
  "web",
  "connector",
  "computer",
  "model",
]);

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);

const authorityReferenceSchema = z.object({
  kind: dataInfluenceAuthorityKindSchema,
  referenceId: opaqueIdSchema,
  evidenceSha256: sha256Schema,
}).strict();

const untrustedInfluenceSchema = z.object({
  kind: untrustedDataInfluenceKindSchema,
  referenceId: opaqueIdSchema,
  contentSha256: sha256Schema,
}).strict();

const noAuthorityInvariantSchema = z.object({
  manifestGrantsAuthority: z.literal(false),
  untrustedDataGrantsAuthority: z.literal(false),
  authorizationRequiresExternalValidation: z.literal(true),
}).strict();

const manifestBodySchema = z.object({
  schemaVersion: z.literal(DATA_INFLUENCE_MANIFEST_SCHEMA_VERSION),
  manifestKind: z.literal("data_influence"),
  tenantId: opaqueIdSchema,
  runId: opaqueIdSchema,
  executionId: opaqueIdSchema,
  principalId: opaqueIdSchema,
  createdAt: canonicalTimestampSchema,
  authorityReferences: z.array(authorityReferenceSchema).max(32),
  untrustedInfluences: z.array(untrustedInfluenceSchema).max(128),
  authorityInvariant: noAuthorityInvariantSchema,
}).strict().superRefine((manifest, context) => {
  requireCanonicalSet(
    manifest.authorityReferences,
    (entry) => `${entry.kind}\u0000${entry.referenceId}\u0000${entry.evidenceSha256}`,
    ["authorityReferences"],
    context,
  );
  requireCanonicalSet(
    manifest.untrustedInfluences,
    (entry) => `${entry.kind}\u0000${entry.referenceId}\u0000${entry.contentSha256}`,
    ["untrustedInfluences"],
    context,
  );
});

export const dataInfluenceManifestV1Schema = manifestBodySchema.extend({
  manifestSha256: sha256Schema,
}).strict().superRefine((manifest, context) => {
  const { manifestSha256, ...body } = manifest;
  if (manifestSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({
      code: "custom",
      path: ["manifestSha256"],
      message: "Data-influence manifest digest does not match its body.",
    });
  }
});

export type DataInfluenceAuthorityReferenceV1 = Readonly<
  z.infer<typeof authorityReferenceSchema>
>;
export type UntrustedDataInfluenceV1 = Readonly<
  z.infer<typeof untrustedInfluenceSchema>
>;
export type DataInfluenceManifestV1 = Readonly<
  z.infer<typeof dataInfluenceManifestV1Schema>
>;

export type BuildDataInfluenceManifestV1Input = Readonly<{
  tenantId: string;
  runId: string;
  executionId: string;
  principalId: string;
  createdAt: string;
  authorityReferences: readonly DataInfluenceAuthorityReferenceV1[];
  untrustedInfluences: readonly UntrustedDataInfluenceV1[];
}>;

/**
 * Builds a provider-neutral, content-free description of what influenced one
 * execution. The manifest can point at separately validated authority evidence,
 * but neither the manifest nor any untrusted input is itself authorization.
 */
export function buildDataInfluenceManifestV1(
  input: BuildDataInfluenceManifestV1Input,
): DataInfluenceManifestV1 {
  const body = manifestBodySchema.parse({
    schemaVersion: DATA_INFLUENCE_MANIFEST_SCHEMA_VERSION,
    manifestKind: "data_influence",
    tenantId: input.tenantId,
    runId: input.runId,
    executionId: input.executionId,
    principalId: input.principalId,
    createdAt: input.createdAt,
    authorityReferences: sortEntries(input.authorityReferences, (entry) =>
      `${entry.kind}\u0000${entry.referenceId}\u0000${entry.evidenceSha256}`),
    untrustedInfluences: sortEntries(input.untrustedInfluences, (entry) =>
      `${entry.kind}\u0000${entry.referenceId}\u0000${entry.contentSha256}`),
    authorityInvariant: {
      manifestGrantsAuthority: false,
      untrustedDataGrantsAuthority: false,
      authorizationRequiresExternalValidation: true,
    },
  });
  return Object.freeze(dataInfluenceManifestV1Schema.parse({
    ...body,
    manifestSha256: canonicalJsonSha256(body),
  }));
}

export function parseDataInfluenceManifestV1(
  value: unknown,
): DataInfluenceManifestV1 {
  return Object.freeze(dataInfluenceManifestV1Schema.parse(value));
}

function sortEntries<T>(entries: readonly T[], key: (entry: T) => string) {
  return [...entries].sort((left, right) => compareCanonicalKeys(key(left), key(right)));
}

function requireCanonicalSet<T>(
  entries: readonly T[],
  key: (entry: T) => string,
  path: (string | number)[],
  context: z.RefinementCtx,
) {
  const keys = entries.map(key);
  const sorted = [...keys].sort(compareCanonicalKeys);
  if (keys.some((value, index) => value !== sorted[index])) {
    context.addIssue({
      code: "custom",
      path,
      message: "Data-influence entries must be in canonical order.",
    });
  }
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      path,
      message: "Duplicate data-influence entries are not permitted.",
    });
  }
}

function compareCanonicalKeys(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
