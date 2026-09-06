import "server-only";

import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

const CONTEXT_SELECTION_LOCK_TTL_MS = 30 * 60 * 1_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceIdSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?:memory|knowledge|graph):[^\s]+$/);
const evidenceIdsSchema = z.array(evidenceIdSchema)
  .max(24)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Context evidence IDs must be unique.",
  });

const previewTokenPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("context_selection_preview"),
  previewId: z.string().uuid(),
  tenantRefSha256: sha256Schema,
  actorRefSha256: sha256Schema,
  querySha256: sha256Schema,
  candidateEvidenceIds: evidenceIdsSchema,
  candidateSetSha256: sha256Schema,
  contextPackSha256: sha256Schema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

const lockTokenPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("context_selection_lock"),
  lockId: z.string().uuid(),
  previewId: z.string().uuid(),
  tenantRefSha256: sha256Schema,
  actorRefSha256: sha256Schema,
  querySha256: sha256Schema,
  candidateEvidenceIds: evidenceIdsSchema,
  includedEvidenceIds: evidenceIdsSchema,
  excludedEvidenceIds: evidenceIdsSchema,
  candidateSetSha256: sha256Schema,
  contextPackSha256: sha256Schema,
  previewReceiptSha256: sha256Schema,
  selectionSha256: sha256Schema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export const contextSelectionRequestSchema = z.object({
  query: z.string().trim().min(1).max(4_000),
  evidenceIds: evidenceIdsSchema,
  lockToken: z.string().min(80).max(24_000).regex(TOKEN_PATTERN),
}).strict();

export type ContextSelectionRequest = z.infer<typeof contextSelectionRequestSchema>;

export type ContextSelectionLockBinding = Readonly<{
  schemaVersion: 1;
  lockId: string;
  previewId: string;
  query: string;
  querySha256: string;
  candidateEvidenceIds: string[];
  evidenceIds: string[];
  excludedEvidenceIds: string[];
  candidateSetSha256: string;
  contextPackSha256: string;
  previewReceiptSha256: string;
  selectionSha256: string;
  issuedAt: string;
  expiresAt: string;
}>;

export const contextSelectionLockBindingSchema = z.object({
  schemaVersion: z.literal(1),
  lockId: z.string().uuid(),
  previewId: z.string().uuid(),
  query: z.string().trim().min(1).max(4_000),
  querySha256: sha256Schema,
  candidateEvidenceIds: evidenceIdsSchema,
  evidenceIds: evidenceIdsSchema,
  excludedEvidenceIds: evidenceIdsSchema,
  candidateSetSha256: sha256Schema,
  contextPackSha256: sha256Schema,
  previewReceiptSha256: sha256Schema,
  selectionSha256: sha256Schema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export function parseContextSelectionLockBinding(
  value: unknown,
): ContextSelectionLockBinding {
  const binding = contextSelectionLockBindingSchema.parse(value);
  if (binding.querySha256 !== querySha256(binding.query)) {
    throw new Error("The persisted context query digest is invalid.");
  }
  if (
    binding.candidateSetSha256 !==
      sha256CanonicalJson(binding.candidateEvidenceIds)
  ) {
    throw new Error("The persisted context candidate digest is invalid.");
  }
  const included = new Set(binding.evidenceIds);
  const excluded = new Set(binding.excludedEvidenceIds);
  if (
    binding.candidateEvidenceIds.some((id) => !included.has(id) && !excluded.has(id)) ||
    binding.evidenceIds.some((id) => !binding.candidateEvidenceIds.includes(id) || excluded.has(id)) ||
    binding.excludedEvidenceIds.some((id) => !binding.candidateEvidenceIds.includes(id))
  ) {
    throw new Error("The persisted context candidate partition is invalid.");
  }
  const expectedSelectionSha256 = sha256CanonicalJson({
    querySha256: binding.querySha256,
    candidateEvidenceIds: binding.candidateEvidenceIds,
    includedEvidenceIds: binding.evidenceIds,
    excludedEvidenceIds: binding.excludedEvidenceIds,
    previewReceiptSha256: binding.previewReceiptSha256,
  });
  if (expectedSelectionSha256 !== binding.selectionSha256) {
    throw new Error("The persisted context selection digest is invalid.");
  }
  return Object.freeze({
    ...binding,
    candidateEvidenceIds: [...binding.candidateEvidenceIds],
    evidenceIds: [...binding.evidenceIds],
    excludedEvidenceIds: [...binding.excludedEvidenceIds],
  });
}

export function issueContextSelectionPreview(input: {
  tenantId: string;
  actorId: string;
  query: string;
  candidateEvidenceIds: readonly string[];
  contextPackSha256: string;
  now?: Date;
}) {
  const now = input.now || new Date();
  const issuedAt = now.toISOString();
  const candidateEvidenceIds = evidenceIdsSchema.parse(
    uniqueInOrder(input.candidateEvidenceIds),
  );
  const payload = previewTokenPayloadSchema.parse({
    schemaVersion: 1,
    kind: "context_selection_preview",
    previewId: randomUUID(),
    tenantRefSha256: referenceSha256(input.tenantId),
    actorRefSha256: referenceSha256(input.actorId),
    querySha256: querySha256(input.query),
    candidateEvidenceIds,
    candidateSetSha256: sha256CanonicalJson(candidateEvidenceIds),
    contextPackSha256: sha256Schema.parse(input.contextPackSha256),
    issuedAt,
    expiresAt: new Date(now.getTime() + CONTEXT_SELECTION_LOCK_TTL_MS).toISOString(),
  });
  const previewReceiptSha256 = sha256CanonicalJson(payload);
  return Object.freeze({
    schemaVersion: 1 as const,
    previewId: payload.previewId,
    candidateEvidenceIds: [...payload.candidateEvidenceIds],
    candidateSetSha256: payload.candidateSetSha256,
    contextPackSha256: payload.contextPackSha256,
    previewReceiptSha256,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    token: signToken(payload),
  });
}

export function lockContextSelection(input: {
  tenantId: string;
  actorId: string;
  query: string;
  evidenceIds: readonly string[];
  previewToken: string;
  now?: Date;
}) {
  const now = input.now || new Date();
  const preview = verifyToken(input.previewToken, previewTokenPayloadSchema);
  assertLiveAndBound(preview, input, now);
  const includedEvidenceIds = evidenceIdsSchema.parse(
    uniqueInOrder(input.evidenceIds),
  );
  const candidates = new Set(preview.candidateEvidenceIds);
  if (includedEvidenceIds.some((id) => !candidates.has(id))) {
    throw new Error("The context selection contains an item outside this preview.");
  }
  const included = new Set(includedEvidenceIds);
  const excludedEvidenceIds = preview.candidateEvidenceIds.filter((id) => !included.has(id));
  const issuedAt = now.toISOString();
  const previewReceiptSha256 = sha256CanonicalJson(preview);
  const selectionSha256 = sha256CanonicalJson({
    querySha256: preview.querySha256,
    candidateEvidenceIds: preview.candidateEvidenceIds,
    includedEvidenceIds,
    excludedEvidenceIds,
    previewReceiptSha256,
  });
  const payload = lockTokenPayloadSchema.parse({
    schemaVersion: 1,
    kind: "context_selection_lock",
    lockId: randomUUID(),
    previewId: preview.previewId,
    tenantRefSha256: preview.tenantRefSha256,
    actorRefSha256: preview.actorRefSha256,
    querySha256: preview.querySha256,
    candidateEvidenceIds: preview.candidateEvidenceIds,
    includedEvidenceIds,
    excludedEvidenceIds,
    candidateSetSha256: preview.candidateSetSha256,
    contextPackSha256: preview.contextPackSha256,
    previewReceiptSha256,
    selectionSha256,
    issuedAt,
    expiresAt: new Date(Math.min(
      Date.parse(preview.expiresAt),
      now.getTime() + CONTEXT_SELECTION_LOCK_TTL_MS,
    )).toISOString(),
  });
  return Object.freeze({
    binding: publicBinding(payload, input.query.trim()),
    token: signToken(payload),
  });
}

export function verifyContextSelectionLock(input: {
  tenantId: string;
  actorId: string;
  selection: ContextSelectionRequest;
  now?: Date;
}): ContextSelectionLockBinding {
  const selection = contextSelectionRequestSchema.parse(input.selection);
  const now = input.now || new Date();
  const payload = verifyToken(selection.lockToken, lockTokenPayloadSchema);
  assertLiveAndBound(payload, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    query: selection.query,
  }, now);
  if (!sameOrderedValues(payload.includedEvidenceIds, selection.evidenceIds)) {
    throw new Error("The reviewed context changed after it was locked.");
  }
  const expectedSelectionSha256 = sha256CanonicalJson({
    querySha256: payload.querySha256,
    candidateEvidenceIds: payload.candidateEvidenceIds,
    includedEvidenceIds: payload.includedEvidenceIds,
    excludedEvidenceIds: payload.excludedEvidenceIds,
    previewReceiptSha256: payload.previewReceiptSha256,
  });
  if (expectedSelectionSha256 !== payload.selectionSha256) {
    throw new Error("The context lock selection digest is invalid.");
  }
  return publicBinding(payload, selection.query.trim());
}

function publicBinding(
  payload: z.infer<typeof lockTokenPayloadSchema>,
  query: string,
): ContextSelectionLockBinding {
  return Object.freeze({
    schemaVersion: 1 as const,
    lockId: payload.lockId,
    previewId: payload.previewId,
    query,
    querySha256: payload.querySha256,
    candidateEvidenceIds: [...payload.candidateEvidenceIds],
    evidenceIds: [...payload.includedEvidenceIds],
    excludedEvidenceIds: [...payload.excludedEvidenceIds],
    candidateSetSha256: payload.candidateSetSha256,
    contextPackSha256: payload.contextPackSha256,
    previewReceiptSha256: payload.previewReceiptSha256,
    selectionSha256: payload.selectionSha256,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });
}

function assertLiveAndBound(
  payload: Pick<
    z.infer<typeof previewTokenPayloadSchema>,
    "tenantRefSha256" | "actorRefSha256" | "querySha256" | "issuedAt" | "expiresAt"
  >,
  input: { tenantId: string; actorId: string; query: string },
  now: Date,
) {
  if (
    payload.tenantRefSha256 !== referenceSha256(input.tenantId) ||
    payload.actorRefSha256 !== referenceSha256(input.actorId)
  ) {
    throw new Error("The context lock belongs to another workspace actor.");
  }
  if (payload.querySha256 !== querySha256(input.query)) {
    throw new Error("The context lock does not match this task.");
  }
  const nowMs = now.getTime();
  if (
    !Number.isFinite(nowMs) ||
    Date.parse(payload.issuedAt) > nowMs + 5_000 ||
    Date.parse(payload.expiresAt) <= nowMs
  ) {
    throw new Error("The context lock expired. Refresh and review context again.");
  }
}

function signToken(payload: object) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingKey())
    .update(encoded, "utf8")
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyToken<T>(token: string, schema: z.ZodType<T>): T {
  if (!TOKEN_PATTERN.test(token)) throw new Error("The context lock token is invalid.");
  const [encoded, suppliedSignature] = token.split(".");
  const expectedSignature = createHmac("sha256", signingKey())
    .update(encoded, "utf8")
    .digest("base64url");
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("The context lock signature is invalid.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("The context lock payload is invalid.");
  }
  return schema.parse(decoded);
}

function signingKey() {
  const secret = process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("OMNIAGENT_INTERNAL_AUTH_SECRET is required for context locks.");
  }
  return createHmac("sha256", secret)
    .update("asael-context-selection-lock:v1", "utf8")
    .digest();
}

function referenceSha256(value: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error("Context lock scope is required.");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function querySha256(value: string) {
  const normalized = normalizeTaskQuery(value);
  if (!normalized) throw new Error("Context lock query is required.");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function sha256CanonicalJson(value: unknown) {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeTaskQuery(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueInOrder(values: readonly string[]) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function sameOrderedValues(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
