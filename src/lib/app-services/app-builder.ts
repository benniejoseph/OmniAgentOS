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
  builderFileReadInputSchema,
  builderFileUpdateInputSchema,
  builderProjectInputSchema,
  builderSessionCreateInputSchema,
  builderSessionStopInputSchema,
  builderTreeInputSchema,
} from "@/lib/app-builder/contracts";
import {
  createBuilderSandbox,
  getBuilderPreviewUrl,
  listBuilderFiles,
  readBuilderFile,
  runBuilderCommand,
  stopBuilderSandbox,
  updateBuilderFile,
} from "@/lib/app-builder/sandbox";
import {
  createBuilderSessionRecord,
  getBuilderSession,
  getProjectBuilderSession,
  listBuilderActivity,
  recordBuilderActivity,
  transitionBuilderSession,
} from "@/lib/app-builder/store";
import { getOwnedProject } from "@/lib/projects/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";

export async function showProjectBuilderService(
  caller: AppServiceCaller,
  input: z.input<typeof builderProjectInputSchema>,
) {
  const value = builderProjectInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.builder.show"));
  await requireProject(caller, value.projectId);
  const session = await getProjectBuilderSession(value.projectId, owner(caller));
  if (!session) return completeAppServiceCall(authorized, { session: null, activity: [], previewUrl: null }, { resourceCount: 0 });
  const [activity, previewUrl] = await Promise.all([
    listBuilderActivity(session.id, owner(caller)),
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
  return completeAppServiceCall(authorized, { session: publicSession(session), activity, previewUrl });
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
    return completeAppServiceCall(authorized, { session: publicSession(session), activity, previewUrl, created: false });
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
    return completeAppServiceCall(authorized, { session: publicSession(ready), activity, previewUrl: provisioned.previewUrl, created: true });
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
  await recordBuilderActivity({
    ...owner(caller), session, eventType: "app_builder.file.updated",
    eventKey: requireIdempotency(caller),
    detail: { path: result.path, previousSha256: result.previousSha256, sha256: result.sha256, size: result.size },
  });
  return completeAppServiceCall(authorized, { update: result });
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

function publicSession<T extends { tenantId: string; ownerActorId: string; sandboxName: string }>(session: T) {
  const { tenantId: _tenantId, ownerActorId: _ownerActorId, sandboxName: _sandboxName, ...safe } = session;
  return safe;
}
