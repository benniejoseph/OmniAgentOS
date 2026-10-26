import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const digest = z.string().regex(/^[a-f0-9]{64}$/), revision = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().min(1).max(240), time = z.string().datetime({ offset: true });
const path = z.string().min(1).max(500).refine(value => !value.startsWith("/") && !value.includes("\\") && !/[\u0000-\u001f\u007f]/.test(value) && value.split("/").every(part => part && part !== "." && part !== ".."));
export const SELF_IMPROVEMENT_NATIVE_PROFILE = "asael_macos_feature_v1" as const;
export const SELF_IMPROVEMENT_NATIVE_PROFILE_SHA256 = canonicalJsonSha256({ profile: SELF_IMPROVEMENT_NATIVE_PROFILE,
  commands: ["macos_analyze", "macos_test_focused", "macos_build"], network: "isolated_flutter_test_loopback", testConcurrency: 1, dds: false, testPort: "controller_reserved_exact_loopback", credentials: "none", architecture: "arm64", version: 1 });
export function nativeCommandPolicySha256(command: string, purpose: string | undefined, paths: readonly string[]) {
  return selfImprovementNativeSha("native_command_policy", { profile: SELF_IMPROVEMENT_NATIVE_PROFILE, profileSha256: SELF_IMPROVEMENT_NATIVE_PROFILE_SHA256, command, purpose: purpose ?? null, paths });
}
export function selfImprovementNativeSha(kind: string, value: unknown): string {
  return canonicalJsonSha256({ contract: "asael-self-improvement", version: 1, kind, value });
}
/** Native authority, credentials and update readiness remain on the manual path. */
function protectedNativeFeaturePath(value: string): boolean {
  const normalized = value.toLowerCase();
  return /\/(?:auth|self_improvement|settings|command|security|ambient_voice|computer_use|integrations)(?:\/|_)/.test(normalized) ||
    /(?:approval|consent|authority|governance|credential|permission|task_binding)/.test(normalized.split("/").at(-1) || "") ||
    /\/(?:talk\/talk|inbox\/(?:inbox|macos_inbox_view)|agents\/agent_control_view)(?:_test)?\.dart$/.test(normalized);
}
/** Ordinary Dart feature code only; core, routing, platform helpers and build controls are excluded. */
export function isSelfImprovementNativeSourcePath(value: string): boolean {
  return /^apps\/flutter\/lib\/features\/[a-z0-9_]+\/[A-Za-z0-9_/]+\.dart$/.test(value) && !protectedNativeFeaturePath(value);
}
export function isSelfImprovementNativeTestPath(value: string): boolean {
  return /^apps\/flutter\/test\/[A-Za-z0-9_/]+_test\.dart$/.test(value) && !protectedNativeFeaturePath(value);
}
export function isSelfImprovementNativePath(value: string): boolean {
  return isSelfImprovementNativeSourcePath(value) || isSelfImprovementNativeTestPath(value);
}
export const nativeChangedFileSchema = z.object({ path, beforeSha256: digest.nullable(), afterSha256: digest.nullable(), mode: z.enum(["100644", "100755"]) }).strict();
export const nativeSourceSnapshotBodySchema = z.object({ version: z.literal(1), cycleId: id, projectId: id, sessionId: id, checkpointId: id,
  baseRevision: revision, workspaceSha256: digest, changesSha256: digest, byteCount: z.number().int().min(1).max(4 * 1024 * 1024),
  files: z.array(nativeChangedFileSchema).min(1).max(30) }).strict();
export const nativeSourceSnapshotSchema = nativeSourceSnapshotBodySchema.extend({ snapshotSha256: digest }).superRefine((value, context) => {
  const { snapshotSha256, ...body } = value;
  if (snapshotSha256 !== selfImprovementNativeSha("native_source_snapshot", body)) context.addIssue({ code: "custom", message: "Native source snapshot fingerprint changed." });
  const paths = value.files.map(file => file.path);
  if (paths.join("\n") !== [...new Set(paths)].sort().join("\n") || value.files.some(file => !isSelfImprovementNativePath(file.path) || file.beforeSha256 === file.afterSha256)) context.addIssue({ code: "custom", message: "Native snapshot paths must be unique, changed and eligible." });
});
export type NativeSourceSnapshotDescriptor = z.infer<typeof nativeSourceSnapshotSchema>;
export const nativeSourceChangeSchema = nativeChangedFileSchema.extend({ content: z.string().max(1_048_576).nullable() }).strict();
export type NativeSourceChange = z.infer<typeof nativeSourceChangeSchema>;
export const nativeInstalledBaselineBodySchema = z.object({ bundleIdentifier: z.literal("app.omniagent.omniagent"), version: z.string().regex(/^\d+\.\d+\.\d+$/), buildNumber: z.string().regex(/^[1-9]\d{0,8}$/),
  bundleSha256: digest, sourceRevision: revision, signingIdentitySha256: digest, designatedRequirementSha256: digest }).strict();
export const nativeInstalledBaselineSchema = nativeInstalledBaselineBodySchema.extend({ baselineSha256: digest }).superRefine((value, context) => {
  const { baselineSha256, ...body } = value;
  if (baselineSha256 !== selfImprovementNativeSha("native_installed_baseline", body)) context.addIssue({ code: "custom", message: "Native installed baseline fingerprint changed." });
});
export const nativeArtifactBodySchema = z.object({ artifactId: id, unsignedBundleSha256: digest, bundleIdentifier: z.literal("app.omniagent.omniagent"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/), buildNumber: z.string().regex(/^[1-9]\d{0,8}$/), sourceManifestSha256: digest,
  toolchainSha256: digest, builderProfileSha256: digest, architecture: z.literal("arm64") }).strict();
export const nativeArtifactSchema = nativeArtifactBodySchema.extend({ artifactSha256: digest }).superRefine((value, context) => {
  const { artifactSha256, ...body } = value;
  if (artifactSha256 !== selfImprovementNativeSha("native_artifact", body)) context.addIssue({ code: "custom", message: "Native artifact fingerprint changed." });
});
export const nativePairedBaselineSchema = z.object({ webRevision: revision, workerRevision: revision, manifestSha256: digest }).strict().refine(value => value.webRevision === value.workerRevision, "The server pair must remain aligned.");
export const nativeValidationRequestBodySchema = z.object({ version: z.literal(1), requestId: z.string().regex(/^self_native_[a-f0-9]{64}$/),
  cycleId: id, tenantId: id, ownerActorId: id, projectId: id, sessionId: id, checkpointId: id, purpose: z.enum(["baseline", "candidate"]),
  releaseTarget: z.literal("macos_app"), profile: z.literal(SELF_IMPROVEMENT_NATIVE_PROFILE), profileSha256: z.literal(SELF_IMPROVEMENT_NATIVE_PROFILE_SHA256), policySha256: digest,
  snapshot: nativeSourceSnapshotSchema, focusedTestPaths: z.array(path).min(1).max(6), adjacentTestPaths: z.array(path).min(1).max(6), analyzePaths: z.array(path).min(1).max(20),
  createdAt: time, expiresAt: time }).strict();
export const nativeValidationRequestSchema = nativeValidationRequestBodySchema.extend({ requestSha256: digest }).superRefine((value, context) => {
  const { requestSha256, ...body } = value;
  if (requestSha256 !== selfImprovementNativeSha("native_validation_request", body)) context.addIssue({ code: "custom", message: "Native validation request fingerprint changed." });
  const allTests = [...value.focusedTestPaths, ...value.adjacentTestPaths];
  if (new Set(allTests).size !== allTests.length || new Set(value.analyzePaths).size !== value.analyzePaths.length) context.addIssue({ code: "custom", message: "Native test paths must be unique and disjoint." });
  if (value.snapshot.cycleId !== value.cycleId || value.snapshot.projectId !== value.projectId || value.snapshot.sessionId !== value.sessionId || value.snapshot.checkpointId !== value.checkpointId ||
      Date.parse(value.expiresAt) <= Date.parse(value.createdAt) || value.focusedTestPaths.some(item => !isSelfImprovementNativeTestPath(item)) || value.adjacentTestPaths.some(item => !isSelfImprovementNativeTestPath(item)) || value.analyzePaths.some(item => !isSelfImprovementNativePath(item))) context.addIssue({ code: "custom", message: "Native validation request scope or paths changed." });
});
export type NativeValidationRequest = z.infer<typeof nativeValidationRequestSchema>;
export const nativeValidationCheckSchema = z.object({ command: z.enum(["macos_analyze", "macos_test_focused", "macos_build"]), purpose: z.enum(["regression", "adjacent"]).optional(),
  paths: z.array(path).max(30), policySha256: digest, exitCode: z.number().int(), durationMs: z.number().finite().min(0).max(3_600_000), outputSha256: digest, outputTail: z.string().max(4_000).optional(),
  workspaceBeforeSha256: digest, workspaceAfterSha256: digest,
  testSummary: z.object({ totalTests: z.number().int().min(1).max(10_000), passedTests: z.number().int().min(0), failedTests: z.number().int().min(0), pendingTests: z.number().int().min(0), executedPaths: z.array(path).min(1).max(30) }).strict().optional(),
  startedAt: time, completedAt: time }).strict();
export type NativeValidationCheck = z.infer<typeof nativeValidationCheckSchema>;
export const nativeValidationReceiptBodySchema = z.object({ version: z.literal(1), requestId: id, requestSha256: digest, snapshotSha256: digest, controllerId: id,
  workspaceSha256: digest, toolchainSha256: digest, builderProfileSha256: z.literal(SELF_IMPROVEMENT_NATIVE_PROFILE_SHA256), checks: z.array(nativeValidationCheckSchema).min(1).max(4), artifact: nativeArtifactSchema.nullable(),
  installedBaseline: nativeInstalledBaselineSchema, pairedBaseline: nativePairedBaselineSchema, completedAt: time }).strict();
export const nativeValidationReceiptSchema = nativeValidationReceiptBodySchema.extend({ receiptSha256: digest }).superRefine((value, context) => {
  const { receiptSha256, ...body } = value;
  if (receiptSha256 !== selfImprovementNativeSha("native_validation_receipt", body)) context.addIssue({ code: "custom", message: "Native validation receipt fingerprint changed." });
});
export type NativeValidationReceipt = z.infer<typeof nativeValidationReceiptSchema>;
export const nativeValidationBindingSchema = z.object({ requestId: id, requestSha256: digest, snapshotSha256: digest, receiptSha256: digest,
  artifact: nativeArtifactSchema, installedBaseline: nativeInstalledBaselineSchema, pairedBaseline: nativePairedBaselineSchema }).strict();
export const nativeRequestStateSchema = z.object({ request: nativeValidationRequestSchema, status: z.enum(["queued", "claimed", "completed", "held"]),
  controllerId: id.nullable(), receipt: nativeValidationReceiptSchema.nullable(), holdCategory: z.string().regex(/^[a-z0-9_]{1,120}$/).nullable(), claimedAt: time.nullable() }).strict();
export const selfImprovementNativeRuntimeSchema = z.object({ version: z.literal(1), requests: z.array(nativeRequestStateSchema).max(3),
  activeRequestId: id.nullable(), baselineCheckpointId: id.nullable(), waitedMs: z.number().int().min(0).max(86_400_000), waitStartedAt: time.nullable() }).strict();
export function initialSelfImprovementNativeRuntime(): z.infer<typeof selfImprovementNativeRuntimeSchema> {
  return { version: 1, requests: [], activeRequestId: null, baselineCheckpointId: null, waitedMs: 0, waitStartedAt: null };
}
export function assertNativeValidationReceipt(request: NativeValidationRequest, receipt: NativeValidationReceipt): void {
  nativeValidationRequestSchema.parse(request); nativeValidationReceiptSchema.parse(receipt);
  const fail = (message: string): never => { throw new Error(message); };
  if (receipt.requestId !== request.requestId || receipt.requestSha256 !== request.requestSha256 || receipt.snapshotSha256 !== request.snapshot.snapshotSha256 || receipt.workspaceSha256 !== request.snapshot.workspaceSha256 || Date.parse(receipt.completedAt) < Date.parse(request.createdAt) || Date.parse(receipt.completedAt) > Date.now() || Date.parse(receipt.completedAt) > Date.parse(request.expiresAt)) fail("Native receipt does not bind its exact requested snapshot.");
  const expected = request.purpose === "baseline" ? [["macos_test_focused", "regression", request.focusedTestPaths] as const] : [
    ["macos_analyze", undefined, request.analyzePaths] as const, ["macos_test_focused", "regression", request.focusedTestPaths] as const,
    ["macos_test_focused", "adjacent", request.adjacentTestPaths] as const, ["macos_build", undefined, []] as const];
  if (receipt.checks.length !== expected.length) fail("Native receipt is missing a required fixed check.");
  receipt.checks.forEach((check, index) => {
    const [command, purpose, paths] = expected[index];
    if (check.command !== command || check.purpose !== purpose || JSON.stringify(check.paths) !== JSON.stringify(paths) || check.workspaceBeforeSha256 !== request.snapshot.workspaceSha256 || check.workspaceAfterSha256 !== request.snapshot.workspaceSha256 || check.policySha256 !== nativeCommandPolicySha256(command, purpose, paths) || Date.parse(check.startedAt) < Date.parse(request.createdAt) || Date.parse(check.completedAt) > Date.parse(receipt.completedAt) || Date.parse(check.completedAt) < Date.parse(check.startedAt)) fail("Native check paths, command, timing or source binding changed.");
    if (command === "macos_test_focused") {
      const summary = check.testSummary;
      if (!summary) throw new Error("Native test evidence has missing or unexecuted cases.");
      if (summary.totalTests !== summary.passedTests + summary.failedTests + summary.pendingTests || JSON.stringify([...summary.executedPaths].sort()) !== JSON.stringify([...paths].sort()) || summary.pendingTests !== 0) fail("Native test evidence has missing or unexecuted cases.");
      if ((check.exitCode === 0) !== (summary.failedTests === 0)) fail("Native test exit status disagrees with its executed counts.");
    }
  });
  if (receipt.artifact && (request.purpose !== "candidate" || receipt.artifact.sourceManifestSha256 !== request.snapshot.workspaceSha256 || receipt.artifact.toolchainSha256 !== receipt.toolchainSha256 || receipt.artifact.builderProfileSha256 !== receipt.builderProfileSha256 || Number(receipt.artifact.buildNumber) !== Number(receipt.installedBaseline.buildNumber) + 1 || receipt.artifact.version !== receipt.installedBaseline.version)) fail("Native artifact is stale or belongs to another source snapshot/toolchain.");
  if (request.purpose === "baseline" && receipt.artifact) fail("A baseline cannot publish an artifact.");
}

export function nativeCandidateValidationPassed(receipt: NativeValidationReceipt): boolean {
  return Boolean(receipt.artifact && receipt.checks.length === 4 && receipt.checks.every(check => check.exitCode === 0 && (!check.testSummary || check.testSummary.failedTests === 0 && check.testSummary.pendingTests === 0 && check.testSummary.passedTests === check.testSummary.totalTests)));
}

export const nativeReleaseBindingSchema = nativeValidationBindingSchema.extend({ approvalSha256: digest }).strict();
export const nativeInstallReceiptSchema = z.object({ artifactSha256: digest, baselineSha256: digest, unsignedBundleSha256: digest,
  installedBundleSha256: digest, version: z.string().regex(/^\d+\.\d+\.\d+$/), buildNumber: z.string().regex(/^[1-9]\d{0,8}$/),
  signingIdentitySha256: digest, designatedRequirementSha256: digest, codeSignatureSha256: digest, startupEvidenceSha256: digest,
  installationReceiptSha256: digest }).strict();
