import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { z } from "zod";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const PORTABLE_ARCHIVE_FORMAT = "asael-portable-archive" as const;
export const PORTABLE_ARCHIVE_VERSION = 2 as const;
export const PORTABLE_ARCHIVE_CONTRACT_ID = "asael.portable.archive.v2" as const;
export const PORTABLE_RESTORE_RECEIPT_CONTRACT_ID = "asael.portable.restore.v1" as const;
export const PORTABLE_ASSET_ENCRYPTION_ALGORITHM = "aes-256-gcm" as const;
export const PORTABLE_ASSET_KDF = "scrypt" as const;
export const PORTABLE_ASSET_SCRYPT_COST = 16_384 as const;
export const PORTABLE_ASSET_SCRYPT_BLOCK_SIZE = 8 as const;
export const PORTABLE_ASSET_SCRYPT_PARALLELIZATION = 1 as const;
export const PORTABLE_ASSET_KEY_LENGTH = 32 as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nullableTimestampSchema = z.string().datetime().nullable();
const base64urlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const portableArchiveSectionNames = [
  "knowledge",
  "memories",
  "threads",
  "today",
  "projects",
  "connections",
  "skills",
  "agents",
  "assets",
] as const;

export type PortableArchiveSectionName = typeof portableArchiveSectionNames[number];

const portableKnowledgeV2Schema = z.object({
  sourceId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(240),
  content: z.string().max(900_000),
  contentSha256: sha256Schema,
  source: z.string().max(2_000),
  sourceType: z.enum(["manual", "text", "file", "url", "api"]),
  tags: z.array(z.string().trim().min(1).max(100)).max(50),
  sourceContentSha256: sha256Schema.nullable(),
  sourceRevisionIdSha256: sha256Schema.nullable(),
  updatedAt: nullableTimestampSchema,
}).strict();

const portableMemoryV2Schema = z.object({
  sourceId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(240),
  content: z.string().max(200_000),
  contentSha256: sha256Schema,
  type: z.enum(["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"]),
  tier: z.enum(["working", "episodic", "semantic", "procedural", "preference", "decision", "commitment", "summary"]).optional(),
  tierPolicyVersion: z.literal(1).optional(),
  formationReason: z.enum([
    "manual_user_entry", "explicit_user_request",
    "canonical_source_observation", "verified_effect", "agent_shared_artifact",
    "assistant_inference_candidate", "correction", "project_reflection",
    "project_artifact", "workflow_output", "maintenance_promotion", "source_cognition",
    "portable_restore",
    "legacy_record",
  ]).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50),
  scope: z.enum(["user", "workspace", "project"]),
  source: z.string().max(2_000),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  claimStatus: z.enum(["active", "candidate", "superseded", "contradicted"]),
  assertedBy: z.enum(["user", "agent", "system", "import"]),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(100),
  validFrom: nullableTimestampSchema,
  validTo: nullableTimestampSchema,
  retentionExpiresAt: nullableTimestampSchema.optional(),
  lastUsedAt: nullableTimestampSchema.optional(),
  useCount: z.number().int().min(0).optional(),
  promotedFromTier: z.enum(["working", "episodic", "semantic", "procedural", "preference", "decision", "commitment", "summary"]).nullable().optional(),
  promotedAt: nullableTimestampSchema.optional(),
  supersedesId: z.string().trim().min(1).max(200).nullable(),
  contradictionOfId: z.string().trim().min(1).max(200).nullable(),
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
}).strict();

const portableThreadTurnV2Schema = z.object({
  index: z.number().int().min(0).max(99),
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(40_000),
  contentSha256: sha256Schema,
  createdAt: nullableTimestampSchema,
}).strict();

const portableThreadV2Schema = z.object({
  sourceIdSha256: sha256Schema,
  title: z.string().trim().min(1).max(90),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]),
  turns: z.array(portableThreadTurnV2Schema).max(100),
}).strict();

const portableTodayV2Schema = z.object({
  sourceIdSha256: sha256Schema,
  title: z.string().trim().min(1).max(280),
  kind: z.enum(["task", "reminder"]),
  priority: z.enum(["low", "medium", "high"]),
  status: z.enum(["open", "done"]),
  dueAt: nullableTimestampSchema,
}).strict();

const portableProjectTaskV2Schema = z.object({
  sourceIdSha256: sha256Schema,
  title: z.string().trim().min(1).max(240),
  detail: z.string().max(1_000),
  priority: z.enum(["low", "medium", "high"]),
  agentId: z.enum(["atlas", "scout", "forge", "sentinel", "mnemosyne"]),
  origin: z.enum(["manual", "agent"]),
  dueAt: nullableTimestampSchema,
}).strict();

const portableProjectV2Schema = z.object({
  sourceIdSha256: sha256Schema,
  title: z.string().trim().min(1).max(180),
  objective: z.string().trim().min(1).max(2_000),
  status: z.enum(["draft", "active", "completed", "archived"]),
  targetDate: nullableTimestampSchema,
  tasks: z.array(portableProjectTaskV2Schema).max(20),
}).strict();

const portableConnectionV2Schema = z.object({
  provider: z.string().trim().min(1).max(80),
  scopes: z.array(z.string().trim().min(1).max(240)).max(100),
  configurationSha256: sha256Schema,
  reauthorizationRequired: z.literal(true),
}).strict();

const portableSkillV2Schema = z.object({
  sourceId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(10).max(12_000),
  category: z.enum(["research", "creation", "analysis", "memory", "automation", "personal"]),
  status: z.enum(["active", "disabled"]),
  toolIds: z.array(z.string().trim().min(1).max(120)).max(50),
  tags: z.array(z.string().trim().min(1).max(120)).max(30),
  knowledgeTags: z.array(z.string().trim().min(1).max(120)).max(30),
}).strict();

const portableAgentV2Schema = z.object({
  sourceId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(700),
  instructions: z.string().trim().min(10).max(12_000),
  status: z.enum(["ready", "learning", "paused"]),
  accent: z.enum(["emerald", "blue", "amber", "violet", "rose"]),
  modelPolicy: z.enum(["auto", "openai_fast", "openai_reasoning", "gemini_fast", "anthropic_fast", "anthropic_reasoning"]),
  autonomy: z.enum(["assist", "governed", "execute"]),
  approvalPolicy: z.enum(["always", "risk_based", "read_only"]),
  memoryScope: z.enum(["session", "project", "all"]),
  skillIds: z.array(z.string().trim().min(1).max(120)).max(30),
  toolIds: z.array(z.string().trim().min(1).max(120)).max(50),
}).strict();

export const portableEncryptedAssetV2Schema = z.object({
  sourceIdSha256: sha256Schema,
  filename: z.string().trim().min(1).max(240),
  mediaType: z.string().trim().min(1).max(200),
  extension: z.string().max(32),
  byteCount: z.number().int().min(1).max(20 * 1024 * 1024),
  contentSha256: sha256Schema,
  tags: z.array(z.string().trim().min(1).max(80)).max(50),
  createdAt: nullableTimestampSchema,
  aadSha256: sha256Schema,
  ivBase64url: base64urlSchema,
  authTagBase64url: base64urlSchema,
  ciphertextBase64url: base64urlSchema,
  ciphertextSha256: sha256Schema,
}).strict();

export const portableArchiveDataV2Schema = z.object({
  knowledge: z.array(portableKnowledgeV2Schema).max(5_000),
  memories: z.array(portableMemoryV2Schema).max(20_000),
  threads: z.array(portableThreadV2Schema).max(100),
  today: z.array(portableTodayV2Schema).max(250),
  projects: z.array(portableProjectV2Schema).max(100),
  connections: z.array(portableConnectionV2Schema).max(100),
  skills: z.array(portableSkillV2Schema).max(250),
  agents: z.array(portableAgentV2Schema).max(100),
  assets: z.array(portableEncryptedAssetV2Schema).max(25),
}).strict();

const portableAssetEncryptionV2Schema = z.object({
  algorithm: z.literal(PORTABLE_ASSET_ENCRYPTION_ALGORITHM),
  kdf: z.literal(PORTABLE_ASSET_KDF),
  saltBase64url: base64urlSchema,
  cost: z.literal(PORTABLE_ASSET_SCRYPT_COST),
  blockSize: z.literal(PORTABLE_ASSET_SCRYPT_BLOCK_SIZE),
  parallelization: z.literal(PORTABLE_ASSET_SCRYPT_PARALLELIZATION),
  keyLength: z.literal(PORTABLE_ASSET_KEY_LENGTH),
}).strict();

const portableManifestSectionSchema = z.object({
  includedCount: z.number().int().min(0),
  excludedCount: z.number().int().min(0).nullable(),
  contentSha256: sha256Schema,
  restoreDisposition: z.enum(["restore", "reauthorization_required", "encrypted_restore", "not_included"]),
}).strict();

const portableExclusionSchema = z.object({
  category: z.string().regex(/^[a-z0-9_]{1,80}$/),
  reason: z.string().regex(/^[a-z0-9_]{1,80}$/),
  count: z.number().int().min(0).nullable(),
}).strict();

const portableArchiveManifestV2Schema = z.object({
  schemaVersion: z.literal(1),
  contractId: z.literal(PORTABLE_ARCHIVE_CONTRACT_ID),
  sections: z.object(Object.fromEntries(
    portableArchiveSectionNames.map((name) => [name, portableManifestSectionSchema]),
  ) as Record<PortableArchiveSectionName, typeof portableManifestSectionSchema>).strict(),
  exclusions: z.array(portableExclusionSchema).max(100),
  totals: z.object({
    includedCount: z.number().int().min(0),
    excludedCount: z.number().int().min(0).nullable(),
  }).strict(),
  secretsExcluded: z.literal(true),
  connectorCredentialsExcluded: z.literal(true),
  connectorsRequireReauthorization: z.literal(true),
  manifestSha256: sha256Schema,
}).strict();

const portableArchiveV2BaseSchema = z.object({
  format: z.literal(PORTABLE_ARCHIVE_FORMAT),
  version: z.literal(PORTABLE_ARCHIVE_VERSION),
  exportedAt: z.string().datetime(),
  provenance: z.object({
    sourceOwnerActorIdSha256: sha256Schema,
    sourceTenantIdSha256: sha256Schema,
    exporterId: z.literal("asael"),
  }).strict(),
  assetEncryption: portableAssetEncryptionV2Schema.nullable(),
  data: portableArchiveDataV2Schema,
  manifest: portableArchiveManifestV2Schema,
  archiveSha256: sha256Schema,
}).strict();

const portableSectionCountsSchema = z.object(Object.fromEntries(
  portableArchiveSectionNames.map((name) => [name, z.number().int().min(0)]),
) as Record<PortableArchiveSectionName, z.ZodNumber>).strict();

const portableSectionHashesSchema = z.object(Object.fromEntries(
  portableArchiveSectionNames.map((name) => [name, sha256Schema]),
) as Record<PortableArchiveSectionName, typeof sha256Schema>).strict();

const portableRestoredCountsSchema = portableSectionCountsSchema.extend({
  turns: z.number().int().min(0),
}).strict();

const portableRestoreReceiptV1BaseSchema = z.object({
  schemaVersion: z.literal(1),
  contractId: z.literal(PORTABLE_RESTORE_RECEIPT_CONTRACT_ID),
  archiveSha256: sha256Schema,
  manifestSha256: sha256Schema,
  sourceOwnerActorIdSha256: sha256Schema,
  sourceTenantIdSha256: sha256Schema,
  targetOwnerActorIdSha256: sha256Schema,
  targetTenantIdSha256: sha256Schema,
  ownershipRebound: z.literal(true),
  provenancePreserved: z.literal(true),
  archiveIntegrityVerified: z.literal(true),
  countsVerified: z.literal(true),
  hashesVerified: z.literal(true),
  declaredCounts: portableSectionCountsSchema,
  restoredCounts: portableRestoredCountsSchema,
  declaredSectionSha256: portableSectionHashesSchema,
  restoredInputSha256: portableSectionHashesSchema,
  connectionsReauthorizationRequired: z.number().int().min(0),
  verifiedAt: z.string().datetime(),
  receiptSha256: sha256Schema,
}).strict();

export const portableRestoreReceiptV1Schema = portableRestoreReceiptV1BaseSchema.superRefine(
  (value, context) => {
    for (const name of portableArchiveSectionNames) {
      const expectedRestoredCount = name === "connections"
        ? 0
        : value.declaredCounts[name];
      if (value.restoredCounts[name] !== expectedRestoredCount) {
        context.addIssue({
          code: "custom",
          message: `${name} restored count does not match its declared disposition.`,
          path: ["restoredCounts", name],
        });
      }
      if (value.restoredInputSha256[name] !== value.declaredSectionSha256[name]) {
        context.addIssue({
          code: "custom",
          message: `${name} restored input digest does not match.`,
          path: ["restoredInputSha256", name],
        });
      }
    }
    if (
      value.connectionsReauthorizationRequired !==
      value.declaredCounts.connections
    ) {
      context.addIssue({
        code: "custom",
        message: "Connector reauthorization count does not match.",
        path: ["connectionsReauthorizationRequired"],
      });
    }
    const { receiptSha256, ...body } = value;
    if (portableJsonSha256(body) !== receiptSha256) {
      context.addIssue({
        code: "custom",
        message: "Portable restore receipt digest does not match.",
        path: ["receiptSha256"],
      });
    }
  },
);

export const portableArchiveV2Schema = portableArchiveV2BaseSchema.superRefine((value, context) => {
  addUniquePortableFieldIssues(context, value.data.knowledge, "sourceId", ["data", "knowledge"]);
  addUniquePortableFieldIssues(context, value.data.memories, "sourceId", ["data", "memories"]);
  addUniquePortableFieldIssues(context, value.data.threads, "sourceIdSha256", ["data", "threads"]);
  addUniquePortableFieldIssues(context, value.data.today, "sourceIdSha256", ["data", "today"]);
  addUniquePortableFieldIssues(context, value.data.projects, "sourceIdSha256", ["data", "projects"]);
  addUniquePortableFieldIssues(context, value.data.connections, "provider", ["data", "connections"]);
  addUniquePortableFieldIssues(context, value.data.skills, "sourceId", ["data", "skills"]);
  addUniquePortableFieldIssues(context, value.data.skills, "name", ["data", "skills"]);
  addUniquePortableFieldIssues(context, value.data.agents, "sourceId", ["data", "agents"]);
  addUniquePortableFieldIssues(context, value.data.agents, "name", ["data", "agents"]);
  addUniquePortableFieldIssues(context, value.data.assets, "sourceIdSha256", ["data", "assets"]);
  value.data.projects.forEach((project, projectIndex) => {
    addUniquePortableFieldIssues(
      context,
      project.tasks,
      "sourceIdSha256",
      ["data", "projects", projectIndex, "tasks"],
    );
  });
  for (const name of portableArchiveSectionNames) {
    const section = value.manifest.sections[name];
    if (section.includedCount !== value.data[name].length) {
      context.addIssue({ code: "custom", message: `${name} manifest count does not match.`, path: ["manifest", "sections", name, "includedCount"] });
    }
    if (section.contentSha256 !== portableJsonSha256(value.data[name])) {
      context.addIssue({ code: "custom", message: `${name} manifest digest does not match.`, path: ["manifest", "sections", name, "contentSha256"] });
    }
  }
  const includedCount = portableArchiveSectionNames.reduce(
    (sum, name) => sum + value.manifest.sections[name].includedCount,
    0,
  );
  const excludedCounts = portableArchiveSectionNames.map(
    (name) => value.manifest.sections[name].excludedCount,
  );
  const excludedCount = excludedCounts.some((count) => count === null)
    ? null
    : excludedCounts.reduce<number>((sum, count) => sum + (count || 0), 0);
  if (value.manifest.totals.includedCount !== includedCount || value.manifest.totals.excludedCount !== excludedCount) {
    context.addIssue({ code: "custom", message: "Archive manifest totals do not match its sections.", path: ["manifest", "totals"] });
  }
  const { manifestSha256, ...manifestBody } = value.manifest;
  if (portableJsonSha256(manifestBody) !== manifestSha256) {
    context.addIssue({ code: "custom", message: "Archive manifest digest does not match.", path: ["manifest", "manifestSha256"] });
  }
  const { archiveSha256, ...archiveBody } = value;
  if (portableJsonSha256(archiveBody) !== archiveSha256) {
    context.addIssue({ code: "custom", message: "Archive digest does not match.", path: ["archiveSha256"] });
  }
  for (const [index, item] of value.data.knowledge.entries()) {
    if (portableTextSha256(item.content) !== item.contentSha256) {
      context.addIssue({ code: "custom", message: "Knowledge content digest does not match.", path: ["data", "knowledge", index, "contentSha256"] });
    }
  }
  for (const [index, item] of value.data.memories.entries()) {
    if (portableTextSha256(item.content) !== item.contentSha256) {
      context.addIssue({ code: "custom", message: "Memory content digest does not match.", path: ["data", "memories", index, "contentSha256"] });
    }
  }
  for (const [threadIndex, thread] of value.data.threads.entries()) {
    thread.turns.forEach((turn, turnIndex) => {
      if (turn.index !== turnIndex || portableTextSha256(turn.content) !== turn.contentSha256) {
        context.addIssue({ code: "custom", message: "Thread turn order or digest does not match.", path: ["data", "threads", threadIndex, "turns", turnIndex] });
      }
    });
  }
  for (const [index, item] of value.data.assets.entries()) {
    const ciphertext = Buffer.from(item.ciphertextBase64url, "base64url");
    if (portableBytesSha256(ciphertext) !== item.ciphertextSha256) {
      context.addIssue({ code: "custom", message: "Encrypted asset digest does not match.", path: ["data", "assets", index, "ciphertextSha256"] });
    }
  }
  if (value.data.assets.length > 0 && !value.assetEncryption) {
    context.addIssue({ code: "custom", message: "Encrypted assets require encryption metadata.", path: ["assetEncryption"] });
  }
  if (value.data.assets.length === 0 && value.assetEncryption) {
    context.addIssue({ code: "custom", message: "Encryption metadata requires at least one encrypted asset.", path: ["assetEncryption"] });
  }
});

function addUniquePortableFieldIssues<
  Item extends Record<Field, string>,
  Field extends keyof Item & string,
>(
  context: z.RefinementCtx,
  items: Item[],
  field: Field,
  path: (string | number)[],
) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const value = item[field];
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `Portable archive ${field} values must be unique.`,
        path: [...path, index, field],
      });
    }
    seen.add(value);
  });
}

export type PortableArchiveDataV2 = z.infer<typeof portableArchiveDataV2Schema>;
export type PortableArchiveV2 = z.infer<typeof portableArchiveV2Schema>;
export type PortableEncryptedAssetV2 = z.infer<typeof portableEncryptedAssetV2Schema>;
export type PortableRestoreReceiptV1 = z.infer<typeof portableRestoreReceiptV1Schema>;

export type PortableArchiveExclusion = z.infer<typeof portableExclusionSchema>;

export function buildPortableArchiveV2(input: {
  exportedAt: string;
  sourceOwnerActorId: string;
  sourceTenantId: string;
  data: PortableArchiveDataV2;
  assetEncryption?: PortableArchiveV2["assetEncryption"];
  exclusions?: PortableArchiveExclusion[];
  excludedCounts?: Partial<Record<PortableArchiveSectionName, number | null>>;
}) {
  const data = portableArchiveDataV2Schema.parse(input.data);
  const sections = Object.fromEntries(portableArchiveSectionNames.map((name) => {
    const disposition = name === "connections"
      ? "reauthorization_required" as const
      : name === "assets"
        ? data.assets.length
          ? "encrypted_restore" as const
          : "not_included" as const
        : "restore" as const;
    return [name, {
      includedCount: data[name].length,
      excludedCount: input.excludedCounts &&
          Object.prototype.hasOwnProperty.call(input.excludedCounts, name)
        ? input.excludedCounts[name] ?? null
        : 0,
      contentSha256: portableJsonSha256(data[name]),
      restoreDisposition: disposition,
    }];
  })) as PortableArchiveV2["manifest"]["sections"];
  const excludedValues = portableArchiveSectionNames.map((name) => sections[name].excludedCount);
  const manifestBody = {
    schemaVersion: 1 as const,
    contractId: PORTABLE_ARCHIVE_CONTRACT_ID,
    sections,
    exclusions: input.exclusions || [],
    totals: {
      includedCount: portableArchiveSectionNames.reduce((sum, name) => sum + sections[name].includedCount, 0),
      excludedCount: excludedValues.some((count) => count === null)
        ? null
        : excludedValues.reduce<number>((sum, count) => sum + (count || 0), 0),
    },
    secretsExcluded: true as const,
    connectorCredentialsExcluded: true as const,
    connectorsRequireReauthorization: true as const,
  };
  const body = {
    format: PORTABLE_ARCHIVE_FORMAT,
    version: PORTABLE_ARCHIVE_VERSION,
    exportedAt: input.exportedAt,
    provenance: {
      sourceOwnerActorIdSha256: portableTextSha256(input.sourceOwnerActorId),
      sourceTenantIdSha256: portableTextSha256(input.sourceTenantId),
      exporterId: "asael" as const,
    },
    assetEncryption: input.assetEncryption || null,
    data,
    manifest: {
      ...manifestBody,
      manifestSha256: portableJsonSha256(manifestBody),
    },
  };
  return portableArchiveV2Schema.parse({
    ...body,
    archiveSha256: portableJsonSha256(body),
  });
}

export function verifyPortableArchiveV2(value: unknown) {
  const parsed = portableArchiveV2Schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Portable archive v2 failed manifest or content verification.");
  }
  return parsed.data;
}

export function buildPortableRestoreReceiptV1(input: {
  archive: PortableArchiveV2;
  targetOwnerActorId: string;
  targetTenantId: string;
  restoredCounts: PortableRestoreReceiptV1["restoredCounts"];
  verifiedAt?: string;
}) {
  const declaredCounts = Object.fromEntries(portableArchiveSectionNames.map(
    (name) => [name, input.archive.manifest.sections[name].includedCount],
  )) as PortableRestoreReceiptV1["declaredCounts"];
  const declaredSectionSha256 = Object.fromEntries(portableArchiveSectionNames.map(
    (name) => [name, input.archive.manifest.sections[name].contentSha256],
  )) as PortableRestoreReceiptV1["declaredSectionSha256"];
  const restoredInputSha256 = Object.fromEntries(portableArchiveSectionNames.map(
    (name) => [name, portableJsonSha256(input.archive.data[name])],
  )) as PortableRestoreReceiptV1["restoredInputSha256"];
  const body = {
    schemaVersion: 1 as const,
    contractId: PORTABLE_RESTORE_RECEIPT_CONTRACT_ID,
    archiveSha256: input.archive.archiveSha256,
    manifestSha256: input.archive.manifest.manifestSha256,
    sourceOwnerActorIdSha256: input.archive.provenance.sourceOwnerActorIdSha256,
    sourceTenantIdSha256: input.archive.provenance.sourceTenantIdSha256,
    targetOwnerActorIdSha256: portableTextSha256(input.targetOwnerActorId),
    targetTenantIdSha256: portableTextSha256(input.targetTenantId),
    ownershipRebound: true as const,
    provenancePreserved: true as const,
    archiveIntegrityVerified: true as const,
    countsVerified: true as const,
    hashesVerified: true as const,
    declaredCounts,
    restoredCounts: input.restoredCounts,
    declaredSectionSha256,
    restoredInputSha256,
    connectionsReauthorizationRequired: declaredCounts.connections,
    verifiedAt: new Date(input.verifiedAt || Date.now()).toISOString(),
  };
  return portableRestoreReceiptV1Schema.parse({
    ...body,
    receiptSha256: portableJsonSha256(body),
  });
}

export function createPortableAssetEncryption() {
  return {
    algorithm: PORTABLE_ASSET_ENCRYPTION_ALGORITHM,
    kdf: PORTABLE_ASSET_KDF,
    saltBase64url: randomBytes(16).toString("base64url"),
    cost: PORTABLE_ASSET_SCRYPT_COST,
    blockSize: PORTABLE_ASSET_SCRYPT_BLOCK_SIZE,
    parallelization: PORTABLE_ASSET_SCRYPT_PARALLELIZATION,
    keyLength: PORTABLE_ASSET_KEY_LENGTH,
  } satisfies NonNullable<PortableArchiveV2["assetEncryption"]>;
}

export function encryptPortableAssetBytes(input: {
  metadata: Omit<PortableEncryptedAssetV2, "aadSha256" | "ivBase64url" | "authTagBase64url" | "ciphertextBase64url" | "ciphertextSha256">;
  bytes: Uint8Array;
  passphrase: string;
  encryption: NonNullable<PortableArchiveV2["assetEncryption"]>;
}) {
  const metadata = portableEncryptedAssetV2Schema
    .omit({ aadSha256: true, ivBase64url: true, authTagBase64url: true, ciphertextBase64url: true, ciphertextSha256: true })
    .parse(input.metadata);
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength !== metadata.byteCount || portableBytesSha256(bytes) !== metadata.contentSha256) {
    throw new Error("Portable asset bytes do not match their metadata.");
  }
  const key = portableAssetEncryptionKey(input.passphrase, input.encryption);
  const iv = randomBytes(12);
  const aadSha256 = portableJsonSha256(metadata);
  const cipher = createCipheriv(PORTABLE_ASSET_ENCRYPTION_ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aadSha256, "hex"));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return portableEncryptedAssetV2Schema.parse({
    ...metadata,
    aadSha256,
    ivBase64url: iv.toString("base64url"),
    authTagBase64url: cipher.getAuthTag().toString("base64url"),
    ciphertextBase64url: ciphertext.toString("base64url"),
    ciphertextSha256: portableBytesSha256(ciphertext),
  });
}

export function decryptPortableAssetBytes(input: {
  asset: PortableEncryptedAssetV2;
  passphrase: string;
  encryption: NonNullable<PortableArchiveV2["assetEncryption"]>;
}) {
  const asset = portableEncryptedAssetV2Schema.parse(input.asset);
  const {
    aadSha256,
    ivBase64url,
    authTagBase64url,
    ciphertextBase64url,
    ciphertextSha256: _ciphertextSha256,
    ...metadata
  } = asset;
  if (portableJsonSha256(metadata) !== aadSha256) {
    throw new Error("Encrypted asset metadata failed verification.");
  }
  try {
    const key = portableAssetEncryptionKey(input.passphrase, input.encryption);
    const decipher = createDecipheriv(
      PORTABLE_ASSET_ENCRYPTION_ALGORITHM,
      key,
      Buffer.from(ivBase64url, "base64url"),
    );
    decipher.setAAD(Buffer.from(aadSha256, "hex"));
    decipher.setAuthTag(Buffer.from(authTagBase64url, "base64url"));
    const bytes = Buffer.concat([
      decipher.update(Buffer.from(ciphertextBase64url, "base64url")),
      decipher.final(),
    ]);
    if (bytes.byteLength !== asset.byteCount || portableBytesSha256(bytes) !== asset.contentSha256) {
      throw new Error("decrypted_asset_integrity_mismatch");
    }
    return bytes;
  } catch {
    throw new Error("Encrypted asset could not be opened or verified.");
  }
}

export function portableJsonSha256(value: unknown) {
  return sourceContractSha256(JSON.parse(JSON.stringify(value)) as unknown);
}

export function portableTextSha256(value: string) {
  return portableBytesSha256(Buffer.from(value, "utf8"));
}

export function portableBytesSha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function portableAssetEncryptionKey(
  passphrase: string,
  encryption: NonNullable<PortableArchiveV2["assetEncryption"]>,
) {
  const normalizedPassphrase = passphrase.normalize("NFKC");
  if (normalizedPassphrase.length < 12 || normalizedPassphrase.length > 256) {
    throw new Error("Encrypted portable assets require a 12-256 character passphrase.");
  }
  return scryptSync(
    normalizedPassphrase,
    Buffer.from(encryption.saltBase64url, "base64url"),
    encryption.keyLength,
    {
      N: encryption.cost,
      r: encryption.blockSize,
      p: encryption.parallelization,
      maxmem: 64 * 1024 * 1024,
    },
  );
}
