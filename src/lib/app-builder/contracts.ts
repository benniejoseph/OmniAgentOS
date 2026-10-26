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
export const APP_BUILDER_REPOSITORY_WORKSPACE_CONTRACT_VERSION = "app-builder-repository-workspace:1" as const;
export const APP_BUILDER_TEMPLATE_ID = "nextjs-starter-v1" as const;
export const APP_BUILDER_ROOT = "/vercel/sandbox/app" as const;
export const APP_BUILDER_PREVIEW_PORT = 3000 as const;
export const APP_BUILDER_APP_PORT = 3001 as const;
export const APP_BUILDER_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const APP_BUILDER_MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
export const APP_BUILDER_MAX_WORKSPACE_FILES = 10_000;
export const APP_BUILDER_MAX_INSPECT_BYTES = 8 * 1024 * 1024;
export const APP_BUILDER_COMMAND_POLICY_VERSION = "app-builder-command:2" as const;

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
  "typecheck_direct",
  "test",
  "build",
  "start_preview",
  "lint_focused",
  "test_focused",
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
  workspaceMode?: AppBuilderWorkspaceMode;
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

export type AppBuilderDeterministicReadinessEvidence = Readonly<{
  mode: "deterministic";
  version: 1;
  phase: "checkpoint" | "preview" | "release";
  status: "pending" | "passed" | "failed";
  summary: string;
  signals: ReadonlyArray<Readonly<{
    name: "lint" | "typecheck" | "regression_tests" | "adjacent_tests" | "build_logs" | "route_smokes";
    status: "pending" | "passed" | "failed";
  }>>;
}>;

/**
 * Historical visual evidence remains readable through this field. New records
 * mark it as retired and carry the deterministic readiness receipt that
 * replaced browser capture; visual evidence is not a readiness authority.
 */
export type AppBuilderBrowserEvidence = Readonly<{
  status: "pending" | "captured" | "unavailable" | "failed" | "retired";
  captures: ReadonlyArray<Readonly<{
    viewport: "desktop" | "mobile";
    width: number;
    height: number;
    screenshotSha256: string;
    mimeType: string;
    byteLength: number;
  }>>;
  errorCode?: string;
  legacyField?: true;
  summary?: string;
  replacement?: AppBuilderDeterministicReadinessEvidence;
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
    command: "lint" | "typecheck" | "typecheck_direct" | "lint_focused" | "test_focused";
    paths?: readonly string[];
    policySha256?: string;
    purpose?: "regression" | "adjacent";
    sourceActivityId?: string;
    testSummary?: AppBuilderTestSummary;
    status: "passed" | "failed";
    exitCode: number;
    durationMs: number;
    outputSha256: string;
  }>>;
  browserEvidence: AppBuilderBrowserEvidence;
  createdAt: string;
}>;

export type AppBuilderTestSummary = Readonly<{
  totalTests: number;
  passedTests: number;
  failedTests: number;
  pendingTests: number;
  executedPaths: readonly string[];
  success: boolean;
}>;

export type AppBuilderCommandResult = Readonly<{
  command: AppBuilderCommandKind;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  specification?: ReturnType<typeof resolveBuilderCommandSpecification>;
  testSummary?: AppBuilderTestSummary;
  workspaceBeforeSha256?: string;
  workspaceAfterSha256?: string;
  workspaceUnchanged?: boolean;
}>;

export type AppBuilderFile = Readonly<{
  path: string;
  content: string;
  sha256: string;
  size: number;
  mode?: "100644" | "100755";
  lineRange?: Readonly<{
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
    characterLimitReached?: boolean;
    characterLimit?: number;
  }>;
}>;

export const APP_BUILDER_FILE_SLICE_CHARACTER_LIMIT = 24_000;

export function sliceAppBuilderFileContent(
  content: string,
  range?: Readonly<{ startLine: number; lineCount: number }>,
): Pick<AppBuilderFile, "content" | "lineRange"> {
  if (!range) return { content };
  const lines = content.split(/\r?\n/);
  if (range.startLine > lines.length) {
    throw new Error(`Builder file has ${lines.length} lines; startLine ${range.startLine} is out of bounds.`);
  }
  const requestedEndLine = Math.min(lines.length, range.startLine + range.lineCount - 1);
  const requestedContent = lines.slice(range.startLine - 1, requestedEndLine).join("\n");
  const characterLimitReached = requestedContent.length > APP_BUILDER_FILE_SLICE_CHARACTER_LIMIT;
  const slicedContent = characterLimitReached
    ? requestedContent.slice(0, APP_BUILDER_FILE_SLICE_CHARACTER_LIMIT)
    : requestedContent;
  const returnedEndLine = characterLimitReached
    ? range.startLine + (slicedContent.match(/\n/g)?.length || 0)
    : requestedEndLine;
  return {
    content: slicedContent,
    lineRange: {
      startLine: range.startLine,
      endLine: returnedEndLine,
      totalLines: lines.length,
      truncated: range.startLine > 1 || requestedEndLine < lines.length || characterLimitReached,
      ...(characterLimitReached
        ? {
            characterLimitReached: true,
            characterLimit: APP_BUILDER_FILE_SLICE_CHARACTER_LIMIT,
          }
        : {}),
    },
  };
}

export type AppBuilderRepositoryWorkspace = Readonly<{
  contractVersion: typeof APP_BUILDER_REPOSITORY_WORKSPACE_CONTRACT_VERSION;
  repositoryId: string;
  repositoryFullName: string;
  baseSha: string;
  archiveSha256: string;
  workspaceSha256: string;
  fileCount: number;
  importedAt: string;
}>;

export type AppBuilderDeliveryChange = Readonly<
  | { kind: "upsert"; file: AppBuilderFile; previousSha256?: string | null; previousMode?: "100644" | "100755" }
  | { kind: "delete"; path: string; previousSha256: string }
>;

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
  browserEvidence: AppBuilderBrowserEvidence;
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

export const builderWorkspaceModeSchema = z.enum(["interactive", "source_only"]);
export type AppBuilderWorkspaceMode = z.infer<typeof builderWorkspaceModeSchema>;
export const builderSessionCreateInputSchema = builderProjectInputSchema.extend({ workspaceMode: builderWorkspaceModeSchema.default("interactive") });

export const builderTreeInputSchema = builderProjectInputSchema.extend({
  sessionId: z.string().regex(/^app_build_[a-f0-9]{48}$/),
}).strict();

export const builderTreePageInputSchema = builderTreeInputSchema.extend({
  cursor: z.string().regex(/^[a-f0-9]{64}:[0-9]{1,5}$/).optional(),
  limit: z.number().int().min(1).max(500).default(200),
}).strict();

export const builderFileReadInputSchema = builderTreeInputSchema.extend({
  path: z.string().trim().min(1).max(240),
  startLine: z.number().int().positive().optional(),
  lineCount: z.number().int().min(1).max(400).optional(),
}).strict();

export function safeBuilderFrameworkDocPath(input: string): string {
  if (!input || input.length > 240 || input.trim() !== input || !/^[A-Za-z0-9_()[\]@./-]+\.md$/.test(input) || input.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Select a normalized markdown path inside the installed Next.js documentation.");
  return input;
}
export const builderFrameworkDocReadInputSchema = builderTreeInputSchema.extend({
  path: z.string().min(1).max(240).refine((value) => { try { safeBuilderFrameworkDocPath(value); return true; } catch { return false; } }, "Select an installed Next.js markdown guide."),
  startLine: z.number().int().min(1).max(100_000).default(1),
  lineCount: z.number().int().min(1).max(200).default(120),
}).strict();

export const builderFileUpdateInputSchema = builderTreeInputSchema.extend({
  path: z.string().trim().min(1).max(240),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  content: z.string().max(500_000),
}).strict();

export const builderTextEditsSchema = z.array(z.object({
  oldText: z.string().min(1).max(16_000),
  newText: z.string().max(16_000),
}).strict()).min(1).max(20).superRefine((edits, context) => {
  if (edits.reduce((bytes, edit) => bytes + Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText), 0) > 64_000) context.addIssue({ code: "custom", message: "Literal replacements must contain at most 64 KB of text." });
  if (edits.some((edit) => edit.oldText === edit.newText)) context.addIssue({ code: "custom", message: "Each literal replacement must change the selected text." });
});
export type AppBuilderTextEdit = z.infer<typeof builderTextEditsSchema>[number];
export const builderFileEditInputSchema = builderTreeInputSchema.extend({
  path: z.string().min(1).max(240),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  edits: builderTextEditsSchema,
}).strict();

/** Match every edit against the same inspected source; inserted text is never a later target. */
export function applyBuilderTextEdits(content: string, input: readonly AppBuilderTextEdit[]) {
  const edits = builderTextEditsSchema.parse(input).map((edit) => {
    const start = content.indexOf(edit.oldText);
    if (start === -1 || content.indexOf(edit.oldText, start + 1) !== -1) throw new Error("Each oldText must match exactly once in the inspected file. Read a wider, unique context before editing.");
    return { ...edit, start, end: start + edit.oldText.length };
  }).sort((left, right) => left.start - right.start);
  if (edits.some((edit, index) => index > 0 && edits[index - 1].end > edit.start)) throw new Error("Literal replacements must not overlap in the inspected file.");
  let cursor = 0, result = "";
  for (const edit of edits) { result += content.slice(cursor, edit.start) + edit.newText; cursor = edit.end; }
  result += content.slice(cursor);
  if (result === content) throw new Error("Literal replacements did not change the inspected file.");
  if (Buffer.byteLength(result) > 500_000) throw new Error("Builder source updates must be at most 500 KB.");
  return result;
}

export const builderFileDeleteInputSchema = builderTreeInputSchema.extend({
  path: z.string().trim().min(1).max(240),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const builderSearchInputSchema = builderTreeInputSchema.extend({
  query: z.string().trim().min(2).max(120),
}).strict();

export const builderCommandInputSchema = builderTreeInputSchema.extend({
  command: appBuilderCommandKindSchema,
  paths: z.array(z.string().min(1).max(240)).min(1).max(30).optional(),
}).strict().superRefine((value, context) => {
  try { resolveBuilderCommandSpecification(value); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid builder command." }); }
});

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
  focusedTestPaths: z.array(z.string().min(1).max(240)).min(1).max(30).optional(),
  adjacentTestPaths: z.array(z.string().min(1).max(240)).min(1).max(30).optional(),
  lintPaths: z.array(z.string().min(1).max(240)).min(1).max(30).optional(),
  requireCompletedChecks: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.focusedTestPaths === undefined && value.adjacentTestPaths === undefined && value.lintPaths === undefined) return;
  try {
    const regression = resolveBuilderCommandSpecification({ command: "test_focused", paths: value.focusedTestPaths });
    const adjacent = resolveBuilderCommandSpecification({ command: "test_focused", paths: value.adjacentTestPaths });
    resolveBuilderCommandSpecification({ command: "lint_focused", paths: value.lintPaths });
    if (regression.paths.some((file) => adjacent.paths.includes(file))) throw new Error("Regression and adjacent test selections must be disjoint.");
  } catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid focused verification profile." }); }
});

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

export const builderRepositoryCheckoutInputSchema = builderTreeInputSchema.extend({
  repositoryBindingId: z.string().regex(/^app_build_repository_[a-f0-9]{48}$/),
  expectedBindingRevision: z.number().int().positive(),
  expectedSessionRevision: z.number().int().positive(),
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

export const APP_BUILDER_EXCLUDED_SEGMENTS = [
  ".git", ".next", "node_modules", ".vercel", "coverage", ".turbo",
  ".dart_tool", ".gradle", "pods", ".build", ".ssh", ".aws", ".azure",
  ".gnupg", ".kube",
] as const;

/** Explicit generated/credential exclusions are shared by indexing and direct access. */
export function isBuilderExcludedPath(input: string) {
  const segments = input.replaceAll("\\", "/").split("/");
  return segments.some((segment) => {
    const name = segment.toLowerCase();
    return (APP_BUILDER_EXCLUDED_SEGMENTS as readonly string[]).includes(name) ||
      name === ".env" || name.startsWith(".env.") ||
      [".npmrc", ".netrc", ".pypirc", ".git-credentials", "credentials.json", "credentials", "id_rsa", "id_ed25519"].includes(name) ||
      /\.(?:pem|p12|pfx|key|keystore|jks)$/i.test(name) || name.endsWith(".tsbuildinfo");
  }) || input === "next-env.d.ts" || /(?:^|\/)\.config\/gcloud(?:\/|$)/i.test(segments.join("/"));
}

export function safeBuilderRelativePath(input: string) {
  const normalized = input.trim().replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || normalized !== input.replaceAll("\\", "/") || normalized.length > 240 || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) ||
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
      !/^[A-Za-z0-9._@+ ():\[\]-]+(?:\/[A-Za-z0-9._@+ ():\[\]-]+)*$/.test(normalized)) {
    throw new Error("Builder file path must be a bounded relative source path without traversal or control characters.");
  }
  if (isBuilderExcludedPath(normalized)) {
    throw new Error("Builder file path is outside the editable application boundary.");
  }
  return normalized;
}

export function resolveBuilderCommandSpecification(input: {
  command: AppBuilderCommandKind;
  paths?: readonly string[];
}) {
  const focused = input.command === "lint_focused" || input.command === "test_focused";
  if (focused && (!input.paths?.length || input.paths.length > 30)) {
    throw new Error("Focused validation requires 1-30 exact source file paths.");
  }
  if (!focused && input.paths !== undefined) throw new Error("Only focused validation commands accept file paths.");
  const paths = (input.paths || []).map(safeBuilderRelativePath);
  if (new Set(paths).size !== paths.length) throw new Error("Focused validation paths must be unique.");
  if (paths.some((value) => input.command === "test_focused"
    ? !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(value)
    : !/\.[cm]?[jt]sx?$/.test(value))) {
    throw new Error("Focused validation requires exact JavaScript/TypeScript source files; tests must use .test or .spec names.");
  }
  const fixed = {
    lint: ["npm", ["run", "lint"]],
    typecheck: ["npm", ["run", "typecheck"]],
    typecheck_direct: ["node", ["--max-old-space-size=6144", "node_modules/typescript/bin/tsc", "--noEmit"]],
    test: ["npm", ["test"]],
    build: ["npm", ["run", "build"]],
    start_preview: ["npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(APP_BUILDER_APP_PORT)]],
    lint_focused: ["node", ["node_modules/eslint/bin/eslint.js", "--max-warnings=0", "--no-warn-ignored", "--", ...paths.map((value) => `./${value}`)]],
    test_focused: ["node", ["node_modules/vitest/vitest.mjs", "run", "--reporter=json", ...paths.map((value) => `./${value}`)]],
  } satisfies Record<AppBuilderCommandKind, readonly [string, readonly string[]]>;
  const definition = fixed[input.command];
  if (!definition) throw new Error("Unsupported builder command.");
  const [cmd, args] = definition;
  const preparation = input.command === "typecheck_direct" ? { cmd: "node", args: ["node_modules/next/dist/bin/next", "typegen"] } : undefined;
  const policy = { version: APP_BUILDER_COMMAND_POLICY_VERSION, cmd, args, paths, ...(preparation ? { preparation } : {}) };
  return { ...policy, policySha256: createHash("sha256").update(JSON.stringify(policy)).digest("hex") };
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
