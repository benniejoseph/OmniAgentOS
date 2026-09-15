import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

export const APP_BUILDER_CONTRACT_VERSION = "app-builder-session:1" as const;
export const APP_BUILDER_CHECKPOINT_CONTRACT_VERSION = "app-builder-checkpoint:1" as const;
export const APP_BUILDER_VERIFICATION_CONTRACT_VERSION = "app-builder-verification:1" as const;
export const APP_BUILDER_REPOSITORY_CONTRACT_VERSION = "app-builder-repository:1" as const;
export const APP_BUILDER_DELIVERY_CONTRACT_VERSION = "app-builder-delivery:1" as const;
export const APP_BUILDER_SECRET_SCAN_CONTRACT_VERSION = "app-builder-secret-scan:1" as const;
export const APP_BUILDER_DEPLOYMENT_CONTRACT_VERSION = "app-builder-deployment:1" as const;
export const APP_BUILDER_RELEASE_CONTRACT_VERSION = "app-builder-release:1" as const;
export const APP_BUILDER_TEMPLATE_ID = "nextjs-starter-v1" as const;
export const APP_BUILDER_ROOT = "/vercel/sandbox/app" as const;
export const APP_BUILDER_PREVIEW_PORT = 3000 as const;
export const APP_BUILDER_APP_PORT = 3001 as const;

export const appBuilderSessionStatusSchema = z.enum([
  "provisioning",
  "ready",
  "running",
  "failed",
  "stopped",
]);
export type AppBuilderSessionStatus = z.infer<typeof appBuilderSessionStatusSchema>;

export const appBuilderCommandKindSchema = z.enum([
  "lint",
  "typecheck",
  "test",
  "build",
  "start_preview",
]);
export type AppBuilderCommandKind = z.infer<typeof appBuilderCommandKindSchema>;

export type AppBuilderSession = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  contractVersion: typeof APP_BUILDER_CONTRACT_VERSION;
  templateId: typeof APP_BUILDER_TEMPLATE_ID;
  sandboxName: string;
  status: AppBuilderSessionStatus;
  revision: number;
  currentCheckpointId?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
}>;

export type AppBuilderCheckpoint = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  sessionId: string;
  contractVersion: typeof APP_BUILDER_CHECKPOINT_CONTRACT_VERSION;
  providerSnapshotId: string;
  workspaceSha256: string;
  fileCount: number;
  snapshotBytes: number;
  reason: "manual" | "before_forge" | "after_forge" | "before_sentinel" | "before_restore";
  label: string;
  sourceRunId?: string;
  sessionRevision: number;
  createdAt: string;
  expiresAt?: string;
}>;

export type AppBuilderActivity = Readonly<{
  id: string;
  sessionId: string;
  eventType: string;
  detail: Record<string, unknown>;
  payloadSha256: string;
  occurredAt: string;
}>;

export type AppBuilderVerification = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  sessionId: string;
  checkpointId: string;
  contractVersion: typeof APP_BUILDER_VERIFICATION_CONTRACT_VERSION;
  workspaceSha256: string;
  status: "passed" | "failed" | "incomplete";
  checks: ReadonlyArray<Readonly<{
    command: "lint" | "typecheck";
    status: "passed" | "failed";
    exitCode: number;
    durationMs: number;
    outputSha256: string;
  }>>;
  browserEvidence: Readonly<{
    status: "captured" | "unavailable" | "failed";
    captures: ReadonlyArray<Readonly<{
      viewport: "desktop" | "mobile";
      width: number;
      height: number;
      screenshotSha256: string;
      mimeType: string;
      byteLength: number;
    }>>;
    errorCode?: string;
  }>;
  createdAt: string;
}>;

export type AppBuilderFile = Readonly<{
  path: string;
  content: string;
  sha256: string;
  size: number;
}>;

export type AppBuilderTreeEntry = Readonly<{
  path: string;
  kind: "file" | "directory";
  size?: number;
}>;

export type AppBuilderRepository = Readonly<{
  repositoryId: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
}>;

export type AppBuilderRepositoryBinding = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  sessionId: string;
  contractVersion: typeof APP_BUILDER_REPOSITORY_CONTRACT_VERSION;
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryFullName: string;
  private: boolean;
  defaultBranch: string;
  baseSha: string;
  revision: number;
  boundAt: string;
  updatedAt: string;
}>;

export type AppBuilderDelivery = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  sessionId: string;
  repositoryBindingId: string;
  contractVersion: typeof APP_BUILDER_DELIVERY_CONTRACT_VERSION;
  checkpointId: string;
  verificationId: string;
  workspaceSha256: string;
  baseSha: string;
  branchName: string;
  commitSha?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  secretScanSha256: string;
  secretFindingCount: number;
  status: "preparing" | "pull_request_open" | "failed";
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type AppBuilderGithubStatus = Readonly<{
  configured: boolean;
  missing: readonly string[];
  appSlug?: string;
  installUrl?: string;
}>;

export type AppBuilderVercelStatus = Readonly<{
  configured: boolean;
  missing: readonly string[];
}>;

export type AppBuilderDeployment = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  sessionId: string;
  contractVersion: typeof APP_BUILDER_DEPLOYMENT_CONTRACT_VERSION;
  checkpointId: string;
  verificationId: string;
  repositoryDeliveryId?: string;
  commitSha?: string;
  workspaceSha256: string;
  fileManifestSha256: string;
  fileCount: number;
  byteCount: number;
  secretScanSha256: string;
  smokeRoutes: readonly string[];
  providerProjectId?: string;
  providerDeploymentId?: string;
  providerState?: string;
  deploymentUrl?: string;
  status: "preparing" | "queued" | "building" | "verifying" | "ready" | "incomplete" | "failed";
  logs: Readonly<{
    status: "pending" | "captured" | "unavailable";
    sha256?: string;
    eventCount: number;
  }>;
  routeEvidence: Readonly<{
    status: "pending" | "passed" | "failed";
    routes: ReadonlyArray<Readonly<{
      path: string;
      status: "passed" | "failed";
      statusCode?: number;
      durationMs: number;
      bodySha256?: string;
      errorCode?: string;
    }>>;
  }>;
  browserEvidence: AppBuilderVerification["browserEvidence"] | Readonly<{
    status: "pending";
    captures: readonly [];
  }>;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type AppBuilderRelease = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  sessionId: string;
  deploymentId: string;
  contractVersion: typeof APP_BUILDER_RELEASE_CONTRACT_VERSION;
  previewProviderDeploymentId: string;
  workspaceSha256: string;
  previewEvidenceSha256: string;
  releaseDigest: string;
  migrationEvidence: Readonly<{
    status: "not_declared" | "declared";
    fileCount: number;
    manifestSha256: string;
  }>;
  rollbackEvidence: Readonly<{
    status: "available" | "first_release";
    providerDeploymentId?: string;
    deploymentUrl?: string;
  }>;
  status: "review_pending" | "releasing" | "building" | "healthy" | "incomplete" | "failed" | "expired";
  providerProjectId?: string;
  providerDeploymentId?: string;
  providerState?: string;
  deploymentUrl?: string;
  logs: AppBuilderDeployment["logs"];
  routeEvidence: AppBuilderDeployment["routeEvidence"];
  browserEvidence: AppBuilderDeployment["browserEvidence"];
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  releasedAt?: string;
}>;

export const builderProjectInputSchema = z.object({
  projectId: z.string().trim().min(1).max(200),
}).strict();

export const builderSessionCreateInputSchema = builderProjectInputSchema;

export const builderTreeInputSchema = builderProjectInputSchema.extend({
  sessionId: z.string().regex(/^app_build_[a-f0-9]{48}$/),
}).strict();

export const builderFileReadInputSchema = builderTreeInputSchema.extend({
  path: z.string().trim().min(1).max(240),
}).strict();

export const builderFileUpdateInputSchema = builderFileReadInputSchema.extend({
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  content: z.string().max(500_000),
}).strict();

export const builderCommandInputSchema = builderTreeInputSchema.extend({
  command: appBuilderCommandKindSchema,
}).strict();

export const builderSessionStopInputSchema = builderTreeInputSchema;

export const builderCheckpointReasonSchema = z.enum([
  "manual",
  "before_forge",
  "after_forge",
  "before_sentinel",
  "before_restore",
]);

export const builderCheckpointCreateInputSchema = builderTreeInputSchema.extend({
  expectedSessionRevision: z.number().int().positive(),
  reason: builderCheckpointReasonSchema,
  label: z.string().trim().min(1).max(120),
  sourceRunId: z.string().uuid().optional(),
}).strict();

export const builderCheckpointRestoreInputSchema = builderTreeInputSchema.extend({
  checkpointId: z.string().regex(/^app_build_checkpoint_[a-f0-9]{48}$/),
  expectedSessionRevision: z.number().int().positive(),
}).strict();

export const builderVerificationInputSchema = builderTreeInputSchema.extend({
  checkpointId: z.string().regex(/^app_build_checkpoint_[a-f0-9]{48}$/),
  expectedSessionRevision: z.number().int().positive(),
}).strict();

export const builderVerificationShowInputSchema = builderTreeInputSchema.extend({
  verificationId: z.string().regex(/^app_build_verification_[a-f0-9]{48}$/),
}).strict();

export const builderSentinelReviewInputSchema = builderVerificationShowInputSchema.extend({
  sourceRunId: z.string().uuid(),
}).strict();

export const builderRepositoryListInputSchema = builderProjectInputSchema;

export const builderRepositoryBindInputSchema = builderTreeInputSchema.extend({
  repositoryId: z.string().regex(/^\d{1,24}$/),
}).strict();

export const builderDeliveryInputSchema = builderTreeInputSchema.extend({
  repositoryBindingId: z.string().regex(/^app_build_repository_[a-f0-9]{48}$/),
  expectedBindingRevision: z.number().int().positive(),
  checkpointId: z.string().regex(/^app_build_checkpoint_[a-f0-9]{48}$/),
  verificationId: z.string().regex(/^app_build_verification_[a-f0-9]{48}$/),
  branchName: z.string().trim().min(1).max(120).transform(assertBuilderBranchName),
  title: z.string().trim().min(3).max(180),
  body: z.string().trim().max(8_000).default(""),
  draft: z.boolean().default(true),
}).strict();

export const builderPreviewDeploymentInputSchema = builderTreeInputSchema.extend({
  checkpointId: z.string().regex(/^app_build_checkpoint_[a-f0-9]{48}$/),
  verificationId: z.string().regex(/^app_build_verification_[a-f0-9]{48}$/),
  repositoryDeliveryId: z.string().regex(/^app_build_delivery_[a-f0-9]{48}$/).optional(),
}).strict();

export const builderPreviewDeploymentRefreshInputSchema = builderTreeInputSchema.extend({
  deploymentId: z.string().regex(/^app_build_deployment_[a-f0-9]{48}$/),
}).strict();

export const builderProductionReleasePreviewInputSchema = builderTreeInputSchema.extend({
  deploymentId: z.string().regex(/^app_build_deployment_[a-f0-9]{48}$/),
}).strict();

export const builderProductionReleaseInputSchema = builderTreeInputSchema.extend({
  releaseId: z.string().regex(/^app_build_release_[a-f0-9]{48}$/),
  releaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal("RELEASE"),
}).strict();

export const builderProductionReleaseRefreshInputSchema = builderTreeInputSchema.extend({
  releaseId: z.string().regex(/^app_build_release_[a-f0-9]{48}$/),
}).strict();

const deniedSegments = new Set([
  ".git",
  ".next",
  "node_modules",
  ".env",
  ".vercel",
  "coverage",
]);

export function safeBuilderRelativePath(input: string) {
  const normalizedInput = input.trim().replaceAll("\\", "/");
  if (!normalizedInput || normalizedInput.includes("\0") || normalizedInput.startsWith("/")) {
    throw new Error("Builder file path must be a non-empty relative path.");
  }
  const normalized = path.posix.normalize(normalizedInput);
  const segments = normalized.split("/");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    segments.some((segment) => segment === ".." || deniedSegments.has(segment))
  ) {
    throw new Error("Builder file path is outside the editable application boundary.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@+ -]*(?:\/[A-Za-z0-9][A-Za-z0-9._/@+ -]*)*$/.test(normalized)) {
    throw new Error("Builder file path contains unsupported characters.");
  }
  return normalized.slice(0, 240);
}

export function builderFileSha256(content: string | Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

export function boundedBuilderOutput(value: string, limit = 32_000) {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}\n… output truncated by Asael`;
}

export function assertBuilderBranchName(value: string) {
  const branch = value.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.startsWith("refs/") ||
    branch === "HEAD"
  ) {
    throw new Error("Use a normal Git branch name without refs/, traversal, repeated slashes, or a trailing slash or dot.");
  }
  return branch;
}
