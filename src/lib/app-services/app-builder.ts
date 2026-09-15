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
  builderFileDeleteInputSchema,
  builderFileUpdateInputSchema,
  builderProjectInputSchema,
  builderRepositoryBindInputSchema,
  builderRepositoryCheckoutInputSchema,
  builderRepositoryListInputSchema,
  builderSearchInputSchema,
  builderDeliveryInputSchema,
  builderPreviewDeploymentInputSchema,
  builderPreviewDeploymentRefreshInputSchema,
  builderProductionReleaseInputSchema,
  builderProductionReleasePreviewInputSchema,
  builderProductionReleaseRefreshInputSchema,
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
  checkoutBuilderRepositoryArchive,
  deleteBuilderFile,
  getBuilderPreviewUrl,
  getBuilderRepositoryWorkspace,
  getBuilderWorkspaceManifest,
  listBuilderFiles,
  readBuilderFile,
  readBuilderRepositoryChanges,
  readBuilderWorkspaceFiles,
  runBuilderCommand,
  restoreBuilderSandboxCheckpoint,
  searchBuilderFiles,
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
  recordBuilderWorkspaceReplacement,
  recordBuilderVerification,
  setBuilderCurrentCheckpoint,
  transitionBuilderSession,
} from "@/lib/app-builder/store";
import {
  beginBuilderDelivery,
  bindBuilderRepository,
  completeBuilderDelivery,
  failBuilderDelivery,
  getBuilderDelivery,
  getBuilderRepositoryBinding,
  getBuilderRepositoryBindingById,
  listBuilderDeliveries,
} from "@/lib/app-builder/delivery-store";
import {
  deliverBuilderFilesToGithub,
  downloadBuilderGithubRepositoryArchive,
  getBuilderGithubStatus,
  GitHubDeliveryPartialError,
  listBuilderGithubRepositories,
  resolveBuilderGithubRepository,
} from "@/lib/app-builder/github";
import {
  beginBuilderDeployment,
  failBuilderDeployment as failBuilderPreviewDeployment,
  getBuilderDeployment,
  listBuilderDeployments,
  queueBuilderDeployment,
  updateBuilderDeploymentEvidence,
} from "@/lib/app-builder/deployment-store";
import {
  builderVercelProjectName,
  createBuilderVercelPreview,
  discoverBuilderSmokeRoutes,
  ensureBuilderVercelProtectionBypass,
  getBuilderVercelDeployment,
  getBuilderVercelLogEvidence,
  getBuilderVercelStatus,
  runBuilderVercelRouteSmokes,
  createBuilderVercelProduction,
  getBuilderVercelProductionDeployment,
} from "@/lib/app-builder/vercel";
import {
  beginBuilderReleaseReview,
  claimBuilderProductionRelease,
  expireBuilderRelease,
  failBuilderRelease,
  getBuilderRelease,
  listBuilderReleases,
  queueBuilderProductionRelease,
  updateBuilderReleaseEvidence,
} from "@/lib/app-builder/release-store";
import { scanBuilderFilesForSecrets } from "@/lib/app-builder/secret-scan";
import {
  hasPassingAppBuilderSentinelReview,
  parseAppBuilderSentinelVerdict,
} from "@/lib/app-builder/sentinel-review";
import { captureBuilderBrowserEvidence } from "@/lib/app-builder/verification";
import { getOwnedProject } from "@/lib/projects/store";
import { getAgentRun, getAgentRunExecutionScope } from "@/lib/runs/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export async function showProjectBuilderService(
  caller: AppServiceCaller,
  input: z.input<typeof builderProjectInputSchema>,
) {
  const value = builderProjectInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.show"));
  await requireProject(caller, value.projectId);
  const session = await getProjectBuilderSession(value.projectId, owner(caller));
  const github = getBuilderGithubStatus();
  const vercel = getBuilderVercelStatus();
  if (!session) return completeAppServiceCall(authorized, { session: null, activity: [], checkpoints: [], verifications: [], repositoryBinding: null, repositoryWorkspace: null, deliveries: [], deployments: [], releases: [], github, vercel, previewUrl: null }, { resourceCount: 0 });
  const [activity, checkpoints, verifications, repositoryBinding, repositoryWorkspace, deliveries, deployments, releases, previewUrl] = await Promise.all([
    listBuilderActivity(session.id, owner(caller)),
    listBuilderCheckpoints(session.id, owner(caller)),
    listBuilderVerifications(session.id, owner(caller)),
    getBuilderRepositoryBinding(session.id, owner(caller)),
    session.status === "ready" || session.status === "running"
      ? getBuilderRepositoryWorkspace(session.sandboxName).catch(() => null)
      : Promise.resolve(null),
    listBuilderDeliveries(session.id, owner(caller)),
    listBuilderDeployments(session.id, owner(caller)),
    listBuilderReleases(session.id, owner(caller)),
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
    repositoryWorkspace,
    deliveries: deliveries.map(publicDelivery),
    deployments: deployments.map(publicDeployment),
    releases: releases.map(publicRelease),
    github,
    vercel,
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
  const range = value.startLine !== undefined || value.lineCount !== undefined
    ? { startLine: value.startLine ?? 1, lineCount: value.lineCount ?? 200 }
    : undefined;
  const file = await readBuilderFile(session.sandboxName, value.path, range);
  return completeAppServiceCall(authorized, { file });
}

export async function searchProjectBuilderFilesService(caller: AppServiceCaller, input: z.input<typeof builderSearchInputSchema>) {
  const value = builderSearchInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.search"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const entries = await searchBuilderFiles({ sandboxName: session.sandboxName, query: value.query });
  return completeAppServiceCall(authorized, { entries, query: value.query }, { resourceCount: entries.length });
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

export async function deleteProjectBuilderFileService(caller: AppServiceCaller, input: z.input<typeof builderFileDeleteInputSchema>) {
  const value = builderFileDeleteInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.file.delete"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const result = await deleteBuilderFile({ sandboxName: session.sandboxName, path: value.path, expectedSha256: value.expectedSha256 });
  const current = await recordBuilderWorkspaceChange({
    ...owner(caller), session,
    eventKey: requireIdempotency(caller),
    detail: { action: "delete", path: result.path, previousSha256: result.previousSha256 },
  });
  return completeAppServiceCall(authorized, { session: publicSession(current), deletion: result });
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
  const verdict = parseAppBuilderSentinelVerdict(run.response || "");
  await recordBuilderActivity({
    ...owner(caller), session,
    eventType: "app_builder.sentinel.reviewed",
    eventKey: requireIdempotency(caller),
    detail: {
      verificationId: verification.id,
      checkpointId: verification.checkpointId,
      workspaceSha256: verification.workspaceSha256,
      sourceRunId: run.id,
      verdict,
      responseSha256: createHash("sha256").update(run.response || "").digest("hex"),
    },
  });
  return completeAppServiceCall(authorized, {
    verification: publicVerification(verification),
    sentinel: { runId: run.id, status: run.status, verdict },
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

export async function checkoutProjectBuilderRepositoryService(
  caller: AppServiceCaller,
  input: z.input<typeof builderRepositoryCheckoutInputSchema>,
) {
  const value = builderRepositoryCheckoutInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.repository.checkout"));
  let session = await requireSession(caller, value.projectId, value.sessionId);
  assertExpectedSessionRevision(session, value.expectedSessionRevision);
  const binding = await getBuilderRepositoryBindingById(
    value.repositoryBindingId,
    session.id,
    owner(caller),
  );
  if (!binding || binding.revision !== value.expectedBindingRevision) {
    throw new Error("The GitHub repository binding changed. Refresh it before checkout.");
  }
  const idempotencyKey = requireIdempotency(caller);
  const recoveryKey = `${idempotencyKey}:before_repository_checkout`;
  let recovery = await getBuilderCheckpointForIdempotency({
    ...owner(caller), sessionId: session.id, idempotencyKey: recoveryKey,
  });
  if (!recovery) {
    const captured = await createBuilderSandboxCheckpoint({
      sandboxName: session.sandboxName,
      tenantId: session.tenantId,
      ownerActorId: session.ownerActorId,
      projectId: session.projectId,
      sessionId: session.id,
    });
    recovery = await recordBuilderCheckpoint({
      ...owner(caller), session, idempotencyKey: recoveryKey,
      providerSnapshotId: captured.providerSnapshotId,
      workspaceSha256: captured.workspaceSha256,
      fileCount: captured.fileCount,
      snapshotBytes: captured.snapshotBytes,
      reason: "before_restore",
      label: `Before importing ${binding.repositoryFullName}`.slice(0, 120),
      expiresAt: captured.expiresAt,
    });
  }
  if (session.currentCheckpointId !== recovery.id) {
    session = await setBuilderCurrentCheckpoint({
      ...owner(caller), session, checkpoint: recovery,
      eventType: "app_builder.checkpoint.created", eventKey: recoveryKey,
    });
  }
  const source = await downloadBuilderGithubRepositoryArchive({
    repository: {
      repositoryId: binding.repositoryId,
      owner: binding.repositoryOwner,
      name: binding.repositoryName,
    },
    baseSha: binding.baseSha,
  });
  const checkedOut = await checkoutBuilderRepositoryArchive({
    sandboxName: session.sandboxName,
    repositoryId: binding.repositoryId,
    repositoryFullName: binding.repositoryFullName,
    baseSha: binding.baseSha,
    archiveSha256: source.archiveSha256,
    archive: source.archive,
    previewIdentity: {
      tenantId: session.tenantId,
      ownerActorId: session.ownerActorId,
      projectId: session.projectId,
      sessionId: session.id,
    },
  });
  const current = await recordBuilderWorkspaceReplacement({
    ...owner(caller), session, eventKey: idempotencyKey,
    detail: {
      repositoryBindingId: binding.id,
      repositoryId: binding.repositoryId,
      repositoryFullName: binding.repositoryFullName,
      defaultBranch: binding.defaultBranch,
      baseSha: binding.baseSha,
      archiveSha256: source.archiveSha256,
      archiveByteCount: source.byteCount,
      workspaceSha256: checkedOut.workspace.workspaceSha256,
      fileCount: checkedOut.workspace.fileCount,
      recoveryCheckpointId: recovery.id,
      installExitCode: checkedOut.install.exitCode,
      installDurationMs: checkedOut.install.durationMs,
    },
  });
  return completeAppServiceCall(authorized, {
    session: publicSession(current),
    repositoryBinding: publicRepositoryBinding(binding),
    repositoryWorkspace: checkedOut.workspace,
    recoveryCheckpoint: publicCheckpoint(recovery),
    previewUrl: checkedOut.previewUrl,
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
  await requirePassingSentinelReview(session.id, verification, caller);
  const workspace = await getBuilderWorkspaceManifest(session.sandboxName);
  if (workspace.sha256 !== checkpoint.workspaceSha256) {
    throw new Error("The workspace changed after verification. Seal and verify the current revision again.");
  }
  const repositoryWorkspace = await getBuilderRepositoryWorkspace(session.sandboxName);
  const changes = repositoryWorkspace
    ? await readBuilderRepositoryChanges({
        sandboxName: session.sandboxName,
        repositoryId: binding.repositoryId,
        baseSha: binding.baseSha,
      })
    : (await readBuilderWorkspaceFiles(session.sandboxName)).map((file) => ({ kind: "upsert" as const, file }));
  if (!changes.length) throw new Error("The checked-out repository has no changes to deliver.");
  const files = changes.flatMap((change) => change.kind === "upsert" ? [change.file] : []);
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
      changes,
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

export async function createProjectBuilderPreviewDeploymentService(
  caller: AppServiceCaller,
  input: z.input<typeof builderPreviewDeploymentInputSchema>,
) {
  const value = builderPreviewDeploymentInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.deployment.preview"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const checkpoint = await getBuilderCheckpoint(value.checkpointId, session.id, owner(caller));
  if (!checkpoint || session.currentCheckpointId !== checkpoint.id) {
    throw new Error("Preview deployment requires the exact current App Builder checkpoint.");
  }
  const verification = await getBuilderVerification(value.verificationId, session.id, owner(caller));
  if (
    !verification || verification.status !== "passed" ||
    verification.checkpointId !== checkpoint.id ||
    verification.workspaceSha256 !== checkpoint.workspaceSha256
  ) {
    throw new Error("Preview deployment requires a passing verification for the exact current checkpoint.");
  }
  await requirePassingSentinelReview(session.id, verification, caller);
  const workspace = await getBuilderWorkspaceManifest(session.sandboxName);
  if (workspace.sha256 !== checkpoint.workspaceSha256) {
    throw new Error("The workspace changed after verification. Seal and verify the current revision again.");
  }
  if (await getBuilderRepositoryWorkspace(session.sandboxName)) {
    throw new Error("Repository-backed preview deployment must use its reviewed GitHub commit. Direct source upload remains limited to starter workspaces.");
  }
  let repositoryDelivery;
  if (value.repositoryDeliveryId) {
    repositoryDelivery = await getBuilderDelivery(value.repositoryDeliveryId, session.id, owner(caller));
    if (
      !repositoryDelivery || repositoryDelivery.status !== "pull_request_open" ||
      repositoryDelivery.checkpointId !== checkpoint.id ||
      repositoryDelivery.verificationId !== verification.id ||
      repositoryDelivery.workspaceSha256 !== checkpoint.workspaceSha256 ||
      !repositoryDelivery.commitSha
    ) {
      throw new Error("The selected pull request is not bound to this exact passing checkpoint.");
    }
  }
  const files = await readBuilderWorkspaceFiles(session.sandboxName);
  const scan = scanBuilderFilesForSecrets(files);
  const idempotencyKey = requireIdempotency(caller);
  await recordBuilderActivity({
    ...owner(caller), session,
    eventType: "app_builder.secret_scan.completed",
    eventKey: `${idempotencyKey}:preview_secret_scan`,
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
      purpose: "vercel_preview",
    },
  });
  if (scan.status !== "passed") {
    throw new Error(`Preview deployment is blocked by ${scan.findingCount} possible credential finding${scan.findingCount === 1 ? "" : "s"}. Review the reported file and line locations.`);
  }
  const fileManifestSha256 = createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.sha256}\0${file.size}`).join("\n"))
    .digest("hex");
  const smokeRoutes = discoverBuilderSmokeRoutes(files);
  const claim = await beginBuilderDeployment({
    ...owner(caller),
    projectId: session.projectId,
    sessionId: session.id,
    checkpointId: checkpoint.id,
    verificationId: verification.id,
    repositoryDeliveryId: repositoryDelivery?.id,
    commitSha: repositoryDelivery?.commitSha,
    workspaceSha256: checkpoint.workspaceSha256,
    fileManifestSha256,
    fileCount: files.length,
    byteCount: files.reduce((total, file) => total + file.size, 0),
    secretScanSha256: scan.scanSha256,
    smokeRoutes,
    idempotencyKey,
  });
  if (!claim.created) {
    if (claim.deployment.status !== "preparing") {
      return completeAppServiceCall(authorized, { deployment: publicDeployment(claim.deployment), created: false });
    }
    throw new Error("This preview deployment is already being prepared. Refresh its recorded state before retrying.");
  }
  try {
    const deployed = await createBuilderVercelPreview({
      deploymentReceiptId: claim.deployment.id,
      projectName: builderVercelProjectName(session.tenantId, session.ownerActorId, session.projectId),
      checkpointId: checkpoint.id,
      workspaceSha256: checkpoint.workspaceSha256,
      commitSha: repositoryDelivery?.commitSha,
      files,
    });
    const deployment = await queueBuilderDeployment({
      ...owner(caller),
      deployment: claim.deployment,
      providerProjectId: deployed.projectId,
      providerDeploymentId: deployed.deploymentId,
      providerState: deployed.state,
      deploymentUrl: deployed.url,
    });
    await recordBuilderActivity({
      ...owner(caller), session,
      eventType: "app_builder.deployment.preview_queued",
      eventKey: idempotencyKey,
      detail: {
        deploymentId: deployment.id,
        providerDeploymentId: deployment.providerDeploymentId,
        checkpointId: checkpoint.id,
        verificationId: verification.id,
        repositoryDeliveryId: repositoryDelivery?.id,
        commitSha: repositoryDelivery?.commitSha,
        workspaceSha256: checkpoint.workspaceSha256,
        fileManifestSha256,
        secretScanSha256: scan.scanSha256,
        smokeRouteCount: smokeRoutes.length,
      },
    });
    return completeAppServiceCall(authorized, { deployment: publicDeployment(deployment), created: true });
  } catch (error) {
    const failed = await failBuilderPreviewDeployment({ ...owner(caller), deployment: claim.deployment, error });
    await recordBuilderActivity({
      ...owner(caller), session,
      eventType: "app_builder.deployment.preview_failed",
      eventKey: idempotencyKey,
      detail: {
        deploymentId: failed.id,
        checkpointId: checkpoint.id,
        verificationId: verification.id,
        workspaceSha256: checkpoint.workspaceSha256,
        failureCode: failed.failureCode,
      },
    }).catch(() => undefined);
    throw error;
  }
}

export async function refreshProjectBuilderPreviewDeploymentService(
  caller: AppServiceCaller,
  input: z.input<typeof builderPreviewDeploymentRefreshInputSchema>,
) {
  const value = builderPreviewDeploymentRefreshInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.deployment.refresh"));
  const refreshIdempotencyKey = requireIdempotency(caller);
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const deployment = await getBuilderDeployment(value.deploymentId, session.id, owner(caller));
  if (!deployment) throw new Error("The selected preview deployment was not found.");
  if (deployment.status === "ready" || deployment.status === "failed") {
    return completeAppServiceCall(authorized, { deployment: publicDeployment(deployment), changed: false });
  }
  if (!deployment.providerProjectId || !deployment.providerDeploymentId || !deployment.deploymentUrl) {
    throw new Error("The preview deployment has no confirmed Vercel identity yet.");
  }
  const provider = await getBuilderVercelDeployment(deployment.providerDeploymentId);
  if (provider.deploymentId !== deployment.providerDeploymentId || provider.projectId !== deployment.providerProjectId) {
    throw new Error("Vercel returned a deployment outside the recorded preview identity.");
  }
  const state = provider.state.toUpperCase();
  if (state === "ERROR" || state === "CANCELED" || state.endsWith("_ERROR")) {
    const failed = await failBuilderPreviewDeployment({
      ...owner(caller), deployment,
      providerState: state,
      error: new Error(`Vercel preview entered terminal state ${state}.`),
    });
    await recordBuilderActivity({
      ...owner(caller), session,
      eventType: "app_builder.deployment.preview_failed",
      eventKey: refreshIdempotencyKey,
      detail: {
        deploymentId: failed.id,
        providerDeploymentId: failed.providerDeploymentId,
        providerState: state,
        workspaceSha256: failed.workspaceSha256,
        failureCode: failed.failureCode,
      },
    });
    return completeAppServiceCall(authorized, { deployment: publicDeployment(failed), changed: true });
  }
  if (state !== "READY") {
    const status = state === "BUILDING" || state === "INITIALIZING" ? "building" as const : "queued" as const;
    const logs = state === "BUILDING"
      ? await getBuilderVercelLogEvidence(deployment.providerDeploymentId)
      : deployment.logs;
    const current = await updateBuilderDeploymentEvidence({
      ...owner(caller), deployment, status, providerState: state, logs,
    });
    return completeAppServiceCall(authorized, { deployment: publicDeployment(current), changed: current.updatedAt !== deployment.updatedAt });
  }
  const verifying = await updateBuilderDeploymentEvidence({
    ...owner(caller), deployment, status: "verifying", providerState: state,
  });
  const protectionBypassSecret = await ensureBuilderVercelProtectionBypass(deployment.providerProjectId);
  const [logs, routeEvidence, browserEvidence] = await Promise.all([
    getBuilderVercelLogEvidence(deployment.providerDeploymentId),
    runBuilderVercelRouteSmokes(deployment.deploymentUrl, deployment.smokeRoutes, { protectionBypassSecret }),
    captureBuilderBrowserEvidence({
      tenantId: session.tenantId,
      actorId: session.ownerActorId,
      executionId: `app-builder-deployment:${deployment.id}:${refreshIdempotencyKey}`,
      previewUrl: deployment.deploymentUrl,
      protectionBypassSecret,
    }),
  ]);
  const status = logs.status === "captured" && routeEvidence.status === "passed" && browserEvidence.status === "captured"
    ? "ready" as const
    : "incomplete" as const;
  const current = await updateBuilderDeploymentEvidence({
    ...owner(caller), deployment: verifying, status, providerState: state,
    logs, routeEvidence, browserEvidence,
  });
  await recordBuilderActivity({
    ...owner(caller), session,
    eventType: status === "ready"
      ? "app_builder.deployment.preview_ready"
      : "app_builder.deployment.preview_incomplete",
    eventKey: refreshIdempotencyKey,
    detail: {
      deploymentId: current.id,
      providerDeploymentId: current.providerDeploymentId,
      checkpointId: current.checkpointId,
      verificationId: current.verificationId,
      commitSha: current.commitSha,
      workspaceSha256: current.workspaceSha256,
      deploymentUrl: current.deploymentUrl,
      logsStatus: logs.status,
      logsSha256: logs.sha256,
      logEventCount: logs.eventCount,
      routeStatus: routeEvidence.status,
      routeCount: routeEvidence.routes.length,
      browserStatus: browserEvidence.status,
      captureCount: browserEvidence.captures.length,
    },
  });
  return completeAppServiceCall(authorized, { deployment: publicDeployment(current), changed: true });
}

export async function previewProjectBuilderProductionReleaseService(
  caller: AppServiceCaller,
  input: z.input<typeof builderProductionReleasePreviewInputSchema>,
) {
  const value = builderProductionReleasePreviewInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.release.preview"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  const deployment = await getBuilderDeployment(value.deploymentId, session.id, owner(caller));
  if (
    !deployment || deployment.status !== "ready" ||
    !deployment.providerDeploymentId || !deployment.providerProjectId
  ) {
    throw new Error("Production review requires an exact preview with complete build, route, and visual evidence.");
  }
  const workspace = await getBuilderWorkspaceManifest(session.sandboxName);
  if (workspace.sha256 !== deployment.workspaceSha256) {
    throw new Error("The build workspace changed after this preview. Restore its checkpoint before preparing production review.");
  }
  const files = await readBuilderWorkspaceFiles(session.sandboxName);
  const migrationFiles = files.filter((file) => /(^|\/)(?:supabase\/migrations|prisma\/migrations|drizzle|migrations)(?:\/|$)/i.test(file.path));
  const migrationEvidence = {
    status: migrationFiles.length ? "declared" as const : "not_declared" as const,
    fileCount: migrationFiles.length,
    manifestSha256: createHash("sha256")
      .update(migrationFiles.map((file) => `${file.path}\0${file.sha256}`).join("\n"))
      .digest("hex"),
  };
  const currentProduction = await getBuilderVercelProductionDeployment(deployment.providerProjectId);
  const rollbackEvidence = currentProduction
    ? { status: "available" as const, providerDeploymentId: currentProduction.deploymentId, deploymentUrl: currentProduction.url }
    : { status: "first_release" as const };
  const previewEvidenceSha256 = canonicalJsonSha256({
    deploymentId: deployment.id,
    providerDeploymentId: deployment.providerDeploymentId,
    workspaceSha256: deployment.workspaceSha256,
    fileManifestSha256: deployment.fileManifestSha256,
    secretScanSha256: deployment.secretScanSha256,
    logs: deployment.logs,
    routeEvidence: deployment.routeEvidence,
    browserEvidence: deployment.browserEvidence,
  });
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const review = await beginBuilderReleaseReview({
    ...owner(caller),
    projectId: session.projectId,
    sessionId: session.id,
    deploymentId: deployment.id,
    previewProviderDeploymentId: deployment.providerDeploymentId,
    workspaceSha256: deployment.workspaceSha256,
    previewEvidenceSha256,
    migrationEvidence,
    rollbackEvidence,
    expiresAt,
    idempotencyKey: requireIdempotency(caller),
  });
  if (review.created) {
    await recordBuilderActivity({
      ...owner(caller), session,
      eventType: "app_builder.release.review_prepared",
      eventKey: requireIdempotency(caller),
      detail: {
        releaseId: review.release.id,
        deploymentId: deployment.id,
        previewProviderDeploymentId: deployment.providerDeploymentId,
        workspaceSha256: deployment.workspaceSha256,
        previewEvidenceSha256,
        releaseDigest: review.release.releaseDigest,
        migrationStatus: migrationEvidence.status,
        migrationFileCount: migrationEvidence.fileCount,
        migrationManifestSha256: migrationEvidence.manifestSha256,
        rollbackStatus: rollbackEvidence.status,
        rollbackProviderDeploymentId: rollbackEvidence.status === "available" ? rollbackEvidence.providerDeploymentId : undefined,
        expiresAt,
      },
    });
  }
  return completeAppServiceCall(authorized, { release: publicRelease(review.release), created: review.created });
}

export async function releaseProjectBuilderProductionService(
  caller: AppServiceCaller,
  input: z.input<typeof builderProductionReleaseInputSchema>,
) {
  const value = builderProductionReleaseInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.release.production"));
  const session = await requireSession(caller, value.projectId, value.sessionId);
  let release = await getBuilderRelease(value.releaseId, session.id, owner(caller));
  if (!release) throw new Error("The production release review was not found.");
  if (Date.parse(release.expiresAt) <= Date.now() && release.status === "review_pending") {
    release = await expireBuilderRelease({ ...owner(caller), release });
  }
  const resumableClaim = release.status === "releasing" && !release.providerDeploymentId;
  if ((!resumableClaim && release.status !== "review_pending") || release.releaseDigest !== value.releaseDigest) {
    throw new Error("The production release review changed or expired. Prepare a fresh review before releasing.");
  }
  if (release.migrationEvidence.status !== "not_declared") {
    throw new Error("Production release is blocked because this starter declares database migrations without an approved migration and rollback workflow.");
  }
  const deployment = await getBuilderDeployment(release.deploymentId, session.id, owner(caller));
  if (
    !deployment || deployment.status !== "ready" ||
    deployment.providerDeploymentId !== release.previewProviderDeploymentId ||
    deployment.workspaceSha256 !== release.workspaceSha256
  ) {
    throw new Error("The reviewed preview evidence no longer matches the production release candidate.");
  }
  const claimed = await claimBuilderProductionRelease({
    ...owner(caller), release, releaseDigest: value.releaseDigest,
  });
  try {
    const production = await createBuilderVercelProduction({
      releaseReceiptId: claimed.id,
      projectName: builderVercelProjectName(session.tenantId, session.ownerActorId, session.projectId),
      previewDeploymentId: claimed.previewProviderDeploymentId,
      workspaceSha256: claimed.workspaceSha256,
    });
    const queued = await queueBuilderProductionRelease({
      ...owner(caller), release: claimed,
      providerProjectId: production.projectId,
      providerDeploymentId: production.deploymentId,
      providerState: production.state,
      deploymentUrl: production.url,
    });
    await recordBuilderActivity({
      ...owner(caller), session,
      eventType: "app_builder.release.production_queued",
      eventKey: requireIdempotency(caller),
      detail: {
        releaseId: queued.id,
        deploymentId: queued.deploymentId,
        previewProviderDeploymentId: queued.previewProviderDeploymentId,
        productionProviderDeploymentId: queued.providerDeploymentId,
        workspaceSha256: queued.workspaceSha256,
        previewEvidenceSha256: queued.previewEvidenceSha256,
        releaseDigest: queued.releaseDigest,
        rollbackStatus: queued.rollbackEvidence.status,
        rollbackProviderDeploymentId: queued.rollbackEvidence.providerDeploymentId,
      },
    });
    return completeAppServiceCall(authorized, { release: publicRelease(queued), created: true });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Vercel rejected the deployment operation")) {
      const failed = await failBuilderRelease({ ...owner(caller), release: claimed, error });
      await recordBuilderActivity({
        ...owner(caller), session,
        eventType: "app_builder.release.production_failed",
        eventKey: requireIdempotency(caller),
        detail: {
          releaseId: failed.id,
          deploymentId: failed.deploymentId,
          workspaceSha256: failed.workspaceSha256,
          failureCode: failed.failureCode,
        },
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function refreshProjectBuilderProductionReleaseService(
  caller: AppServiceCaller,
  input: z.input<typeof builderProductionReleaseRefreshInputSchema>,
) {
  const value = builderProductionReleaseRefreshInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.release.refresh"));
  const refreshIdempotencyKey = requireIdempotency(caller);
  const session = await requireSession(caller, value.projectId, value.sessionId);
  let release = await getBuilderRelease(value.releaseId, session.id, owner(caller));
  if (!release) throw new Error("The selected production release was not found.");
  if (release.status === "review_pending" && Date.parse(release.expiresAt) <= Date.now()) {
    release = await expireBuilderRelease({ ...owner(caller), release });
  }
  if (new Set(["review_pending", "healthy", "failed", "expired"]).has(release.status)) {
    return completeAppServiceCall(authorized, { release: publicRelease(release), changed: false });
  }
  if (!release.providerDeploymentId || !release.deploymentUrl) {
    return completeAppServiceCall(authorized, { release: publicRelease(release), changed: false });
  }
  const provider = await getBuilderVercelDeployment(release.providerDeploymentId);
  if (provider.deploymentId !== release.providerDeploymentId || provider.projectId !== release.providerProjectId) {
    throw new Error("Vercel returned a deployment outside the recorded production identity.");
  }
  const state = provider.state.toUpperCase();
  if (state === "ERROR" || state === "CANCELED" || state.endsWith("_ERROR")) {
    const failed = await failBuilderRelease({
      ...owner(caller), release, providerState: state,
      error: new Error(`Vercel production deployment entered terminal state ${state}.`),
    });
    await recordBuilderActivity({
      ...owner(caller), session,
      eventType: "app_builder.release.production_failed",
      eventKey: requireIdempotency(caller),
      detail: {
        releaseId: failed.id,
        productionProviderDeploymentId: failed.providerDeploymentId,
        providerState: state,
        workspaceSha256: failed.workspaceSha256,
        failureCode: failed.failureCode,
      },
    });
    return completeAppServiceCall(authorized, { release: publicRelease(failed), changed: true });
  }
  if (state !== "READY") {
    const logs = state === "BUILDING"
      ? await getBuilderVercelLogEvidence(release.providerDeploymentId)
      : release.logs;
    const current = await updateBuilderReleaseEvidence({
      ...owner(caller), release, status: "building", providerState: state, logs,
    });
    return completeAppServiceCall(authorized, { release: publicRelease(current), changed: true });
  }
  const sourceDeployment = await getBuilderDeployment(release.deploymentId, session.id, owner(caller));
  if (!sourceDeployment) throw new Error("The reviewed preview receipt is missing from this release.");
  if (!release.providerProjectId) throw new Error("The production release has no confirmed Vercel project identity.");
  const protectionBypassSecret = await ensureBuilderVercelProtectionBypass(release.providerProjectId);
  const [logs, routeEvidence, browserEvidence] = await Promise.all([
    getBuilderVercelLogEvidence(release.providerDeploymentId),
    runBuilderVercelRouteSmokes(release.deploymentUrl, sourceDeployment.smokeRoutes, { protectionBypassSecret }),
    captureBuilderBrowserEvidence({
      tenantId: session.tenantId,
      actorId: session.ownerActorId,
      executionId: `app-builder-release:${release.id}:${refreshIdempotencyKey}`,
      previewUrl: release.deploymentUrl,
      protectionBypassSecret,
    }),
  ]);
  const status = logs.status === "captured" && routeEvidence.status === "passed" && browserEvidence.status === "captured"
    ? "healthy" as const
    : "incomplete" as const;
  const current = await updateBuilderReleaseEvidence({
    ...owner(caller), release, status, providerState: state,
    logs, routeEvidence, browserEvidence,
  });
  await recordBuilderActivity({
    ...owner(caller), session,
    eventType: status === "healthy"
      ? "app_builder.release.production_healthy"
      : "app_builder.release.production_incomplete",
    eventKey: refreshIdempotencyKey,
    detail: {
      releaseId: current.id,
      productionProviderDeploymentId: current.providerDeploymentId,
      workspaceSha256: current.workspaceSha256,
      previewEvidenceSha256: current.previewEvidenceSha256,
      releaseDigest: current.releaseDigest,
      deploymentUrl: current.deploymentUrl,
      logsStatus: logs.status,
      logsSha256: logs.sha256,
      logEventCount: logs.eventCount,
      routeStatus: routeEvidence.status,
      routeCount: routeEvidence.routes.length,
      browserStatus: browserEvidence.status,
      captureCount: browserEvidence.captures.length,
      rollbackStatus: current.rollbackEvidence.status,
      rollbackProviderDeploymentId: current.rollbackEvidence.providerDeploymentId,
    },
  });
  return completeAppServiceCall(authorized, { release: publicRelease(current), changed: true });
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

async function requirePassingSentinelReview(
  sessionId: string,
  verification: { id: string; checkpointId: string; workspaceSha256: string },
  caller: AppServiceCaller,
) {
  const activity = await listBuilderActivity(sessionId, owner(caller), 100);
  if (!hasPassingAppBuilderSentinelReview(activity, verification)) {
    throw new Error("Delivery requires an explicit passing Sentinel verdict bound to this exact checkpoint.");
  }
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

function publicDeployment<T extends { tenantId: string; ownerActorId: string }>(deployment: T) {
  const { tenantId: _tenantId, ownerActorId: _ownerActorId, ...safe } = deployment;
  return safe;
}

function publicRelease<T extends { tenantId: string; ownerActorId: string }>(release: T) {
  const { tenantId: _tenantId, ownerActorId: _ownerActorId, ...safe } = release;
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
