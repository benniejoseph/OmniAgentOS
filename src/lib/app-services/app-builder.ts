import { createHash } from "node:crypto";
import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  builderCommandInputSchema,
  builderCheckpointCreateInputSchema,
  builderCheckpointRestoreInputSchema,
  builderFileReadInputSchema,
  builderFileUpdateInputSchema,
  builderProjectInputSchema,
  builderRepositoryBindInputSchema,
  builderRepositoryListInputSchema,
  builderDeliveryInputSchema,
  builderSentinelReviewInputSchema,
  builderSessionCreateInputSchema,
  builderSessionStopInputSchema,
  builderTreeInputSchema,
  builderVerificationInputSchema,
  builderVerificationShowInputSchema,
} from "@/lib/app-builder/contracts";
import {
  createBuilderSandbox,
  createBuilderSandboxCheckpoint,
  getBuilderPreviewUrl,
  getBuilderWorkspaceManifest,
  listBuilderFiles,
  readBuilderFile,
  readBuilderWorkspaceFiles,
  runBuilderCommand,
  restoreBuilderSandboxCheckpoint,
  stopBuilderSandbox,
  updateBuilderFile,
} from "@/lib/app-builder/sandbox";
import {
  createBuilderSessionRecord,
  getBuilderCheckpoint,
  getBuilderCheckpointForIdempotency,
  getBuilderSession,
  getBuilderVerification,
  getBuilderVerificationForIdempotency,
  getProjectBuilderSession,
  listBuilderActivity,
  listBuilderCheckpoints,
  listBuilderVerifications,
  recordBuilderCheckpoint,
  recordBuilderActivity,
  recordBuilderWorkspaceChange,
  recordBuilderVerification,
  setBuilderCurrentCheckpoint,
  transitionBuilderSession,
} from "@/lib/app-builder/store";
import {
  beginBuilderDelivery,
  bindBuilderRepository,
  completeBuilderDelivery,
  failBuilderDelivery,
  getBuilderRepositoryBinding,
  getBuilderRepositoryBindingById,
  listBuilderDeliveries,
} from "@/lib/app-builder/delivery-store";
import {
  deliverBuilderFilesToGithub,
  getBuilderGithubStatus,
  GitHubDeliveryPartialError,
  listBuilderGithubRepositories,
  resolveBuilderGithubRepository,
} from "@/lib/app-builder/github";
import { scanBuilderFilesForSecrets } from "@/lib/app-builder/secret-scan";
import { captureBuilderBrowserEvidence } from "@/lib/app-builder/verification";
import { getOwnedProject } from "@/lib/projects/store";
import { getAgentRun, getAgentRunExecutionScope } from "@/lib/runs/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";

export async function showProjectBuilderService(
  caller: AppServiceCaller,
  input: z.input<typeof builderProjectInputSchema>,
) {
  const value = builderProjectInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.show"));
  await requireProject(caller, value.projectId);
  const session = await getProjectBuilderSession(value.projectId, owner(caller));
  const github = getBuilderGithubStatus();
  if (!session) return completeAppServiceCall(authorized, { session: null, activity: [], checkpoints: [], verifications: [], repositoryBinding: null, deliveries: [], github, previewUrl: null }, { resourceCount: 0 });
  const [activity, checkpoints, verifications, repositoryBinding, deliveries, previewUrl] = await Promise.all([
    listBuilderActivity(session.id, owner(caller)),
    listBuilderCheckpoints(session.id, owner(caller)),
    listBuilderVerifications(session.id, owner(caller)),
    getBuilderRepositoryBinding(session.id, owner(caller)),
    listBuilderDeliveries(session.id, owner(caller)),
    session.status === "ready" || session.status === "running"
      ? getBuilderPreviewUrl({
          sandboxName: session.sandboxName,
          tenantId: session.tenantId,
          ownerActorId: session.ownerActorId,
          projectId: session.projectId,
          sessionId: session.id,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);
  return completeAppServiceCall(authorized, {
    session: publicSession(session),
    activity,
    checkpoints: checkpoints.map(publicCheckpoint),
    verifications: verifications.map(publicVerification),
    repositoryBinding: repositoryBinding ? publicRepositoryBinding(repositoryBinding) : null,
    deliveries: deliveries.map(publicDelivery),
    github,
    previewUrl,
  });
}

export async function createProjectBuilderService(
  caller: AppServiceCaller,
  input: z.input<typeof builderSessionCreateInputSchema>,
) {
  const value = builderSessionCreateInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.create"));
  await requireProject(caller, value.projectId);
  const idempotencyKey = requireIdempotency(caller);
  const { session, created } = await createBuilderSessionRecord({ ...owner(caller), projectId: value.projectId, idempotencyKey });
  if (!created) {
    const activity = await listBuilderActivity(session.id, owner(caller));
    const previewUrl = session.status === "ready" || session.status === "running"
      ? await getBuilderPreviewUrl({ sandboxName: session.sandboxName, tenantId: session.tenantId, ownerActorId: session.ownerActorId, projectId: session.projectId, sessionId: session.id }).catch(() => null)
      : null;
    const checkpoints = await listBuilderCheckpoints(session.id, owner(caller));
    const verifications = await listBuilderVerifications(session.id, owner(caller));
    return completeAppServiceCall(authorized, { session: publicSession(session), activity, checkpoints: checkpoints.map(publicCheckpoint), verifications: verifications.map(publicVerification), previewUrl, created: false });
  }
  try {
    const provisioned = await createBuilderSandbox({
      sandboxName: session.sandboxName,
      tenantId: session.tenantId,
      ownerActorId: session.ownerActorId,
      projectId: session.projectId,
      sessionId: session.id,
    });
    const ready = await transitionBuilderSession({
      ...owner(caller), session, status: "ready",
      eventType: "app_builder.session.ready", eventKey: idempotencyKey,
      detail: { installExitCode: provisioned.install.exitCode, installDurationMs: provisioned.install.durationMs },
    });
    const activity = await listBuilderActivity(ready.id, owner(caller));
    return completeAppServiceCall(authorized, { session: publicSession(ready), activity, checkpoints: [], verifications: [], previewUrl: provisioned.previewUrl, created: true });
  } catch (error) {
    const code = builderErrorCode(error);
    await transitionBuilderSession({
      ...owner(caller), session, status: "failed", lastErrorCode: code,
      eventType: "app_builder.session.failed", eventKey: idempotencyKey,
      detail: { errorCode: code },
    }).catch(() => undefined);
    throw new Error(`App Builder workspace could not be provisioned (${code}).`);
  }
}

export async function listProjectBuilderTreeService(caller: AppServiceCaller, input: z.input<typeof builderTreeInputSchema>) {
  const value = builderTreeInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.tree"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const entries = await listBuilderFiles(session.sandboxName);
  return completeAppServiceCall(authorized, { session: publicSession(session), entries }, { resourceCount: entries.length });
}

export async function readProjectBuilderFileService(caller: AppServiceCaller, input: z.input<typeof builderFileReadInputSchema>) {
  const value = builderFileReadInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.file.read"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const file = await readBuilderFile(session.sandboxName, value.path);
  return completeAppServiceCall(authorized, { file });
}

export async function updateProjectBuilderFileService(caller: AppServiceCaller, input: z.input<typeof builderFileUpdateInputSchema>) {
  const value = builderFileUpdateInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.file.update"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const result = await updateBuilderFile({ sandboxName: session.sandboxName, path: value.path, expectedSha256: value.expectedSha256, content: value.content });
  const current = await recordBuilderWorkspaceChange({
    ...owner(caller), session,
    eventKey: requireIdempotency(caller),
    detail: { path: result.path, previousSha256: result.previousSha256, sha256: result.sha256, size: result.size },
  });
  return completeAppServiceCall(authorized, { session: publicSession(current), update: result });
}

export async function runProjectBuilderCommandService(caller: AppServiceCaller, input: z.input<typeof builderCommandInputSchema>) {
  const value = builderCommandInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.command.run"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const result = await runBuilderCommand({
    sandboxName: session.sandboxName,
    command: value.command,
    previewIdentity: { tenantId: session.tenantId, ownerActorId: session.ownerActorId, projectId: session.projectId, sessionId: session.id },
  });
  await recordBuilderActivity({
    ...owner(caller), session, eventType: "app_builder.command.completed",
    eventKey: requireIdempotency(caller),
    detail: { command: value.command, exitCode: result.exitCode, durationMs: result.durationMs, outputSha256: createHash("sha256").update(`${result.stdout}\n${result.stderr}`).digest("hex") },
  });
  return completeAppServiceCall(authorized, { result });
}

export async function stopProjectBuilderService(caller: AppServiceCaller, input: z.input<typeof builderSessionStopInputSchema>) {
  const value = builderSessionStopInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.stop"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  await stopBuilderSandbox(session.sandboxName);
  const stopped = await transitionBuilderSession({
    ...owner(caller), session, status: "stopped",
    eventType: "app_builder.session.stopped", eventKey: requireIdempotency(caller), detail: {},
  });
  return completeAppServiceCall(authorized, { session: publicSession(stopped) });
}

export async function createProjectBuilderCheckpointService(
  caller: AppServiceCaller,
  input: z.input<typeof builderCheckpointCreateInputSchema>,
) {
  const value = builderCheckpointCreateInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.checkpoint.create"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  assertExpectedSessionRevision(session, value.expectedSessionRevision);
  if (value.reason === "after_forge" && !value.sourceRunId) {
    throw new Error("A Forge result checkpoint requires its exact completed Agent run.");
  }
  if (value.sourceRunId && value.reason !== "after_forge") {
    throw new Error("Only a Forge result checkpoint may bind an Agent run.");
  }
  if (value.sourceRunId) {
    await requireBuilderAgentRun(caller, value.projectId, value.sourceRunId, value.reason === "after_forge" ? "forge" : undefined);
  }
  const idempotencyKey = requireIdempotency(caller);
  let checkpoint = await getBuilderCheckpointForIdempotency({
    ...owner(caller),
    sessionId: session.id,
    idempotencyKey,
  });
  let current = session;
  let previewUrl: string | null = null;
  if (!checkpoint) {
    const captured = await createBuilderSandboxCheckpoint({
      sandboxName: session.sandboxName,
      tenantId: session.tenantId,
      ownerActorId: session.ownerActorId,
      projectId: session.projectId,
      sessionId: session.id,
    });
    checkpoint = await recordBuilderCheckpoint({
      ...owner(caller),
      session,
      idempotencyKey,
      providerSnapshotId: captured.providerSnapshotId,
      workspaceSha256: captured.workspaceSha256,
      fileCount: captured.fileCount,
      snapshotBytes: captured.snapshotBytes,
      reason: value.reason,
      label: value.label,
      sourceRunId: value.sourceRunId,
      expiresAt: captured.expiresAt,
    });
    previewUrl = captured.previewUrl;
  }
  if (session.currentCheckpointId !== checkpoint.id) {
    current = await setBuilderCurrentCheckpoint({
      ...owner(caller),
      session,
      checkpoint,
      eventType: "app_builder.checkpoint.created",
      eventKey: idempotencyKey,
    });
  }
  previewUrl ||= await getBuilderPreviewUrl({
    sandboxName: session.sandboxName,
    tenantId: session.tenantId,
    ownerActorId: session.ownerActorId,
    projectId: session.projectId,
    sessionId: session.id,
  }).catch(() => null);
  const [activity, checkpoints, verifications] = await Promise.all([
    listBuilderActivity(session.id, owner(caller)),
    listBuilderCheckpoints(session.id, owner(caller)),
    listBuilderVerifications(session.id, owner(caller)),
  ]);
  return completeAppServiceCall(authorized, {
    session: publicSession(current),
    activity,
    checkpoint: publicCheckpoint(checkpoint),
    checkpoints: checkpoints.map(publicCheckpoint),
    verifications: verifications.map(publicVerification),
    previewUrl,
  });
}

export async function restoreProjectBuilderCheckpointService(
  caller: AppServiceCaller,
  input: z.input<typeof builderCheckpointRestoreInputSchema>,
) {
  const value = builderCheckpointRestoreInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.checkpoint.restore"));
  let session = await requireSession(caller, value.projectId, value.sessionId);
  assertExpectedSessionRevision(session, value.expectedSessionRevision);
  const checkpoint = await getBuilderCheckpoint(value.checkpointId, session.id, owner(caller));
  if (!checkpoint) throw new Error("The selected App Builder checkpoint was not found.");
  if (checkpoint.expiresAt && Date.parse(checkpoint.expiresAt) <= Date.now()) {
    throw new Error("The selected App Builder checkpoint has expired.");
  }
  if (session.currentCheckpointId === checkpoint.id) {
    const [activity, checkpoints, verifications] = await Promise.all([
      listBuilderActivity(session.id, owner(caller)),
      listBuilderCheckpoints(session.id, owner(caller)),
      listBuilderVerifications(session.id, owner(caller)),
    ]);
    return completeAppServiceCall(authorized, {
      session: publicSession(session),
      activity,
      checkpoint: publicCheckpoint(checkpoint),
      checkpoints: checkpoints.map(publicCheckpoint),
      verifications: verifications.map(publicVerification),
      restored: false,
      previewUrl: await getBuilderPreviewUrl({
        sandboxName: session.sandboxName,
        tenantId: session.tenantId,
        ownerActorId: session.ownerActorId,
        projectId: session.projectId,
        sessionId: session.id,
      }).catch(() => null),
    });
  }
  const idempotencyKey = requireIdempotency(caller);
  const safetyKey = `${idempotencyKey}:before_restore`;
  let safetyCheckpoint = await getBuilderCheckpointForIdempotency({
    ...owner(caller), sessionId: session.id, idempotencyKey: safetyKey,
  });
  if (!safetyCheckpoint) {
    const safety = await createBuilderSandboxCheckpoint({
      sandboxName: session.sandboxName,
      tenantId: session.tenantId,
      ownerActorId: session.ownerActorId,
      projectId: session.projectId,
      sessionId: session.id,
    });
    safetyCheckpoint = await recordBuilderCheckpoint({
      ...owner(caller), session, idempotencyKey: safetyKey,
      providerSnapshotId: safety.providerSnapshotId,
      workspaceSha256: safety.workspaceSha256,
      fileCount: safety.fileCount,
      snapshotBytes: safety.snapshotBytes,
      reason: "before_restore",
      label: `Before restoring ${checkpoint.label}`.slice(0, 120),
      expiresAt: safety.expiresAt,
    });
  }
  if (session.currentCheckpointId !== safetyCheckpoint.id) {
    session = await setBuilderCurrentCheckpoint({
      ...owner(caller), session, checkpoint: safetyCheckpoint,
      eventType: "app_builder.checkpoint.created", eventKey: safetyKey,
    });
  }
  const restored = await restoreBuilderSandboxCheckpoint({
    sandboxName: session.sandboxName,
    providerSnapshotId: checkpoint.providerSnapshotId,
    tenantId: session.tenantId,
    ownerActorId: session.ownerActorId,
    projectId: session.projectId,
    sessionId: session.id,
  });
  if (restored.workspaceSha256 !== checkpoint.workspaceSha256) {
    throw new Error("The restored workspace did not match the sealed checkpoint digest.");
  }
  const current = await setBuilderCurrentCheckpoint({
    ...owner(caller), session, checkpoint,
    eventType: "app_builder.checkpoint.restored", eventKey: idempotencyKey,
  });
  const [activity, checkpoints, verifications] = await Promise.all([
    listBuilderActivity(session.id, owner(caller)),
    listBuilderCheckpoints(session.id, owner(caller)),
    listBuilderVerifications(session.id, owner(caller)),
  ]);
  return completeAppServiceCall(authorized, {
    session: publicSession(current),
    activity,
    checkpoint: publicCheckpoint(checkpoint),
    checkpoints: checkpoints.map(publicCheckpoint),
    verifications: verifications.map(publicVerification),
    restored: true,
    previewUrl: restored.previewUrl,
  });
}

export async function showProjectBuilderVerificationService(
  caller: AppServiceCaller,
  input: z.input<typeof builderVerificationShowInputSchema>,
) {
  const value = builderVerificationShowInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.verification.show"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const verification = await getBuilderVerification(value.verificationId, session.id, owner(caller));
  if (!verification) throw new Error("The selected App Builder verification was not found.");
  return completeAppServiceCall(authorized, { verification: publicVerification(verification) });
}

export async function runProjectBuilderVerificationService(
  caller: AppServiceCaller,
  input: z.input<typeof builderVerificationInputSchema>,
) {
  const value = builderVerificationInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.verification.run"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  assertExpectedSessionRevision(session, value.expectedSessionRevision);
  const checkpoint = await getBuilderCheckpoint(value.checkpointId, session.id, owner(caller));
  if (!checkpoint || session.currentCheckpointId !== checkpoint.id) {
    throw new Error("Verification requires the exact current App Builder checkpoint.");
  }
  const idempotencyKey = requireIdempotency(caller);
  const existing = await getBuilderVerificationForIdempotency({
    ...owner(caller), sessionId: session.id, idempotencyKey,
  });
  if (existing) return completeAppServiceCall(authorized, { verification: publicVerification(existing), created: false });
  const workspace = await getBuilderWorkspaceManifest(session.sandboxName);
  if (workspace.sha256 !== checkpoint.workspaceSha256) {
    throw new Error("The workspace changed after its checkpoint was sealed.");
  }
  const checks = [] as Array<{
    command: "lint" | "typecheck";
    status: "passed" | "failed";
    exitCode: number;
    durationMs: number;
    outputSha256: string;
  }>;
  for (const command of ["lint", "typecheck"] as const) {
    const result = await runBuilderCommand({ sandboxName: session.sandboxName, command });
    checks.push({
      command,
      status: result.exitCode === 0 ? "passed" : "failed",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputSha256: createHash("sha256").update(`${result.stdout}\n${result.stderr}`).digest("hex"),
    });
  }
  const previewUrl = await getBuilderPreviewUrl({
    sandboxName: session.sandboxName,
    tenantId: session.tenantId,
    ownerActorId: session.ownerActorId,
    projectId: session.projectId,
    sessionId: session.id,
  });
  const browserEvidence = await captureBuilderBrowserEvidence({
    tenantId: session.tenantId,
    actorId: session.ownerActorId,
    executionId: `app-builder-verification:${idempotencyKey}`,
    previewUrl,
  });
  const status = checks.some((check) => check.status === "failed")
    ? "failed" as const
    : browserEvidence.status === "captured"
      ? "passed" as const
      : "incomplete" as const;
  const verification = await recordBuilderVerification({
    ...owner(caller), session, checkpoint, idempotencyKey, status, checks, browserEvidence,
  });
  await recordBuilderActivity({
    ...owner(caller), session,
    eventType: "app_builder.verification.completed",
    eventKey: idempotencyKey,
    detail: {
      verificationId: verification.id,
      checkpointId: checkpoint.id,
      workspaceSha256: checkpoint.workspaceSha256,
      status,
      checks: checks.map((check) => ({ command: check.command, status: check.status, exitCode: check.exitCode, outputSha256: check.outputSha256 })),
      browserStatus: browserEvidence.status,
      captureCount: browserEvidence.captures.length,
    },
  });
  return completeAppServiceCall(authorized, { verification: publicVerification(verification), created: true });
}

export async function recordProjectBuilderSentinelReviewService(
  caller: AppServiceCaller,
  input: z.input<typeof builderSentinelReviewInputSchema>,
) {
  const value = builderSentinelReviewInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.sentinel.record"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const verification = await getBuilderVerification(value.verificationId, session.id, owner(caller));
  if (!verification) throw new Error("The App Builder verification was not found for Sentinel review.");
  const run = await requireBuilderAgentRun(caller, value.projectId, value.sourceRunId, "sentinel");
  if (!run.prompt.includes(verification.id) || !run.prompt.includes(verification.checkpointId)) {
    throw new Error("The Sentinel run is not bound to this verification checkpoint.");
  }
  await recordBuilderActivity({
    ...owner(caller), session,
    eventType: "app_builder.sentinel.reviewed",
    eventKey: requireIdempotency(caller),
    detail: {
      verificationId: verification.id,
      checkpointId: verification.checkpointId,
      sourceRunId: run.id,
      responseSha256: createHash("sha256").update(run.response || "").digest("hex"),
    },
  });
  return completeAppServiceCall(authorized, {
    verification: publicVerification(verification),
    sentinel: { runId: run.id, status: run.status },
  });
}

export async function listProjectBuilderRepositoriesService(
  caller: AppServiceCaller,
  input: z.input<typeof builderRepositoryListInputSchema>,
) {
  const value = builderRepositoryListInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.repositories.list"));
  await requireProject(caller, value.projectId);
  const repositories = await listBuilderGithubRepositories();
  return completeAppServiceCall(authorized, {
    github: getBuilderGithubStatus(),
    repositories,
  }, { resourceCount: repositories.length });
}

export async function bindProjectBuilderRepositoryService(
  caller: AppServiceCaller,
  input: z.input<typeof builderRepositoryBindInputSchema>,
) {
  const value = builderRepositoryBindInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.repository.bind"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const resolved = await resolveBuilderGithubRepository(value.repositoryId);
  if (!resolved.baseSha) throw new Error("GitHub did not return the repository default-branch revision.");
  const binding = await bindBuilderRepository({
    ...owner(caller),
    projectId: value.projectId,
    sessionId: session.id,
    repository: resolved.repository,
    baseSha: resolved.baseSha,
  });
  await recordBuilderActivity({
    ...owner(caller), session,
    eventType: "app_builder.repository.bound",
    eventKey: requireIdempotency(caller),
    detail: {
      repositoryBindingId: binding.id,
      repositoryId: binding.repositoryId,
      repositoryFullName: binding.repositoryFullName,
      defaultBranch: binding.defaultBranch,
      baseSha: binding.baseSha,
      revision: binding.revision,
    },
  });
  return completeAppServiceCall(authorized, {
    repositoryBinding: publicRepositoryBinding(binding),
  });
}

export async function deliverProjectBuilderPullRequestService(
  caller: AppServiceCaller,
  input: z.input<typeof builderDeliveryInputSchema>,
) {
  const value = builderDeliveryInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.delivery.create"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const binding = await getBuilderRepositoryBindingById(
    value.repositoryBindingId,
    session.id,
    owner(caller),
  );
  if (!binding || binding.revision !== value.expectedBindingRevision) {
    throw new Error("The GitHub repository binding changed. Refresh it before delivery.");
  }
  const checkpoint = await getBuilderCheckpoint(value.checkpointId, session.id, owner(caller));
  if (!checkpoint || session.currentCheckpointId !== checkpoint.id) {
    throw new Error("GitHub delivery requires the exact current App Builder checkpoint.");
  }
  const verification = await getBuilderVerification(value.verificationId, session.id, owner(caller));
  if (
    !verification ||
    verification.status !== "passed" ||
    verification.checkpointId !== checkpoint.id ||
    verification.workspaceSha256 !== checkpoint.workspaceSha256
  ) {
    throw new Error("GitHub delivery requires a passing verification for the exact current checkpoint.");
  }
  const workspace = await getBuilderWorkspaceManifest(session.sandboxName);
  if (workspace.sha256 !== checkpoint.workspaceSha256) {
    throw new Error("The workspace changed after verification. Seal and verify the current revision again.");
  }
  const files = await readBuilderWorkspaceFiles(session.sandboxName);
  const scan = scanBuilderFilesForSecrets(files);
  await recordBuilderActivity({
    ...owner(caller), session,
    eventType: "app_builder.secret_scan.completed",
    eventKey: `${requireIdempotency(caller)}:secret_scan`,
    detail: {
      contractVersion: scan.contractVersion,
      checkpointId: checkpoint.id,
      workspaceSha256: checkpoint.workspaceSha256,
      status: scan.status,
      fileCount: scan.fileCount,
      byteCount: scan.byteCount,
      findingCount: scan.findingCount,
      scanSha256: scan.scanSha256,
      findings: scan.findings,
    },
  });
  if (scan.status !== "passed") {
    throw new Error(`GitHub delivery is blocked by ${scan.findingCount} possible credential finding${scan.findingCount === 1 ? "" : "s"}. Review the reported file and line locations.`);
  }
  const idempotencyKey = requireIdempotency(caller);
  const claim = await beginBuilderDelivery({
    ...owner(caller), projectId: session.projectId, sessionId: session.id,
    repositoryBindingId: binding.id, checkpointId: checkpoint.id,
    verificationId: verification.id, workspaceSha256: checkpoint.workspaceSha256,
    baseSha: binding.baseSha, branchName: value.branchName,
    secretScanSha256: scan.scanSha256, secretFindingCount: scan.findingCount,
    idempotencyKey,
  });
  if (!claim.created) {
    if (claim.delivery.status === "pull_request_open") {
      return completeAppServiceCall(authorized, { delivery: publicDelivery(claim.delivery), created: false });
    }
    throw new Error(`This GitHub delivery attempt is already ${claim.delivery.status}. Use a fresh branch for a new reviewed attempt.`);
  }
  try {
    const delivered = await deliverBuilderFilesToGithub({
      repository: {
        repositoryId: binding.repositoryId,
        owner: binding.repositoryOwner,
        name: binding.repositoryName,
      },
      expectedBaseSha: binding.baseSha,
      defaultBranch: binding.defaultBranch,
      branchName: value.branchName,
      title: value.title,
      body: deliveryBody(value.body, {
        workspaceSha256: checkpoint.workspaceSha256,
        checkpointId: checkpoint.id,
        verificationId: verification.id,
        secretScanSha256: scan.scanSha256,
      }),
      draft: value.draft,
      files,
    });
    const delivery = await completeBuilderDelivery({
      ...owner(caller), delivery: claim.delivery,
      commitSha: delivered.commitSha,
      pullRequestNumber: delivered.pullRequestNumber,
      pullRequestUrl: delivered.pullRequestUrl,
    });
    await recordBuilderActivity({
      ...owner(caller), session,
      eventType: "app_builder.delivery.pull_request_open",
      eventKey: idempotencyKey,
      detail: {
        deliveryId: delivery.id,
        repositoryBindingId: binding.id,
        checkpointId: checkpoint.id,
        verificationId: verification.id,
        workspaceSha256: checkpoint.workspaceSha256,
        baseSha: binding.baseSha,
        branchName: delivery.branchName,
        commitSha: delivery.commitSha,
        pullRequestNumber: delivery.pullRequestNumber,
        pullRequestUrl: delivery.pullRequestUrl,
        secretScanSha256: scan.scanSha256,
      },
    });
    return completeAppServiceCall(authorized, { delivery: publicDelivery(delivery), created: true });
  } catch (error) {
    const failed = await failBuilderDelivery({
      ...owner(caller),
      delivery: claim.delivery,
      error,
      commitSha: error instanceof GitHubDeliveryPartialError ? error.partial.commitSha : undefined,
    });
    await recordBuilderActivity({
      ...owner(caller), session,
      eventType: "app_builder.delivery.failed",
      eventKey: idempotencyKey,
      detail: {
        deliveryId: failed.id,
        repositoryBindingId: binding.id,
        checkpointId: checkpoint.id,
        verificationId: verification.id,
        workspaceSha256: checkpoint.workspaceSha256,
        branchName: value.branchName,
        commitSha: failed.commitSha,
        failureCode: failed.failureCode,
      },
    }).catch(() => undefined);
    throw error;
  }
}

async function requireSession(caller: AppServiceCaller, projectId: string, sessionId: string) {
  await requireProject(caller, projectId);
  const session = await getBuilderSession(sessionId, projectId, owner(caller));
  if (!session) throw new Error("App Builder session was not found in this project.");
  if (session.status === "stopped" || session.status === "failed") throw new Error(`App Builder session is ${session.status}.`);
  return session;
}

async function requireProject(caller: AppServiceCaller, projectId: string) {
  const project = await getOwnedProject(projectId, {
    ...owner(caller),
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(caller.context),
  });
  if (!project) throw new Error("Project was not found.");
  return project;
}

function owner(caller: AppServiceCaller) {
  return { tenantId: caller.context.tenantId, actorId: caller.context.actorId };
}

function requireIdempotency(caller: AppServiceCaller) {
  if (!caller.idempotencyKey) throw new Error("App Builder mutation requires an idempotency key.");
  return caller.idempotencyKey;
}

function builderErrorCode(error: unknown) {
  return `builder_${createHash("sha256").update(error instanceof Error ? error.message : "unknown").digest("hex").slice(0, 12)}`;
}

function assertExpectedSessionRevision(session: { revision: number }, expected: number) {
  if (session.revision !== expected) {
    throw new Error("The App Builder session changed. Refresh before applying this operation.");
  }
}

async function requireBuilderAgentRun(
  caller: AppServiceCaller,
  projectId: string,
  runId: string,
  expectedAgentId?: string,
) {
  const [run, scope] = await Promise.all([
    getAgentRun(runId, { tenantId: caller.context.tenantId }),
    getAgentRunExecutionScope(runId, { tenantId: caller.context.tenantId }),
  ]);
  if (
    !run || run.ownerActorId !== caller.context.actorId ||
    !scope || scope.initiatingActorId !== caller.context.actorId ||
    scope.projectId !== projectId ||
    (expectedAgentId && (run.agentId !== expectedAgentId || run.status !== "completed"))
  ) {
    throw new Error("The Agent run is not bound to this App Builder project.");
  }
  return run;
}

function publicSession<T extends { tenantId: string; ownerActorId: string; sandboxName: string }>(session: T) {
  const { tenantId: _tenantId, ownerActorId: _ownerActorId, sandboxName: _sandboxName, ...safe } = session;
  return safe;
}

function publicCheckpoint<T extends { tenantId: string; ownerActorId: string; providerSnapshotId: string }>(checkpoint: T) {
  const { tenantId: _tenantId, ownerActorId: _ownerActorId, providerSnapshotId: _providerSnapshotId, ...safe } = checkpoint;
  return safe;
}

function publicVerification<T extends { tenantId: string; ownerActorId: string }>(verification: T) {
  const { tenantId: _tenantId, ownerActorId: _ownerActorId, ...safe } = verification;
  return safe;
}

function publicRepositoryBinding<T extends { tenantId: string; ownerActorId: string }>(binding: T) {
  const { tenantId: _tenantId, ownerActorId: _ownerActorId, ...safe } = binding;
  return safe;
}

function publicDelivery<T extends { tenantId: string; ownerActorId: string }>(delivery: T) {
  const { tenantId: _tenantId, ownerActorId: _ownerActorId, ...safe } = delivery;
  return safe;
}

function deliveryBody(
  requested: string,
  evidence: {
    workspaceSha256: string;
    checkpointId: string;
    verificationId: string;
    secretScanSha256: string;
  },
) {
  return [
    requested.trim(),
    "",
    "---",
    "Asael Build Studio evidence",
    `- Workspace: ${evidence.workspaceSha256}`,
    `- Checkpoint: ${evidence.checkpointId}`,
    `- Verification: ${evidence.verificationId}`,
    `- Secret scan: ${evidence.secretScanSha256}`,
  ].filter((line, index) => index > 0 || Boolean(line)).join("\n").slice(0, 8_000);
}
