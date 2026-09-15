import { z } from "zod";
import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  bindProjectBuilderRepositoryService,
  createProjectBuilderService,
  createProjectBuilderCheckpointService,
  deliverProjectBuilderPullRequestService,
  createProjectBuilderPreviewDeploymentService,
  refreshProjectBuilderPreviewDeploymentService,
  listProjectBuilderRepositoriesService,
  listProjectBuilderTreeService,
  readProjectBuilderFileService,
  recordProjectBuilderSentinelReviewService,
  runProjectBuilderCommandService,
  runProjectBuilderVerificationService,
  restoreProjectBuilderCheckpointService,
  showProjectBuilderService,
  showProjectBuilderVerificationService,
  stopProjectBuilderService,
  updateProjectBuilderFileService,
} from "@/lib/app-services/app-builder";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
const sessionIdSchema = z.string().regex(/^app_build_[a-f0-9]{48}$/);
const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create") }).strict(),
  z.object({ action: z.literal("file.update"), sessionId: sessionIdSchema, path: z.string().trim().min(1).max(240), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), content: z.string().max(500_000) }).strict(),
  z.object({ action: z.literal("command.run"), sessionId: sessionIdSchema, command: z.enum(["lint", "typecheck", "test", "build", "start_preview"]) }).strict(),
  z.object({ action: z.literal("checkpoint.create"), sessionId: sessionIdSchema, expectedSessionRevision: z.number().int().positive(), reason: z.enum(["manual", "before_forge", "after_forge", "before_sentinel"]), label: z.string().trim().min(1).max(120), sourceRunId: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal("checkpoint.restore"), sessionId: sessionIdSchema, checkpointId: z.string().regex(/^app_build_checkpoint_[a-f0-9]{48}$/), expectedSessionRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("verification.run"), sessionId: sessionIdSchema, checkpointId: z.string().regex(/^app_build_checkpoint_[a-f0-9]{48}$/), expectedSessionRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("sentinel.record"), sessionId: sessionIdSchema, verificationId: z.string().regex(/^app_build_verification_[a-f0-9]{48}$/), sourceRunId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("repository.bind"), sessionId: sessionIdSchema, repositoryId: z.string().regex(/^\d{1,24}$/) }).strict(),
  z.object({ action: z.literal("delivery.create"), sessionId: sessionIdSchema, repositoryBindingId: z.string().regex(/^app_build_repository_[a-f0-9]{48}$/), expectedBindingRevision: z.number().int().positive(), checkpointId: z.string().regex(/^app_build_checkpoint_[a-f0-9]{48}$/), verificationId: z.string().regex(/^app_build_verification_[a-f0-9]{48}$/), branchName: z.string().trim().min(1).max(120), title: z.string().trim().min(3).max(180), body: z.string().trim().max(8_000).default(""), draft: z.boolean().default(true) }).strict(),
  z.object({ action: z.literal("deployment.preview"), sessionId: sessionIdSchema, checkpointId: z.string().regex(/^app_build_checkpoint_[a-f0-9]{48}$/), verificationId: z.string().regex(/^app_build_verification_[a-f0-9]{48}$/), repositoryDeliveryId: z.string().regex(/^app_build_delivery_[a-f0-9]{48}$/).optional() }).strict(),
  z.object({ action: z.literal("deployment.refresh"), sessionId: sessionIdSchema, deploymentId: z.string().regex(/^app_build_deployment_[a-f0-9]{48}$/) }).strict(),
  z.object({ action: z.literal("stop"), sessionId: sessionIdSchema }).strict(),
]);

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "app_builder_session", resourceId: id });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "session";
  const sessionId = url.searchParams.get("sessionId") || "";
  try {
    const caller = createAppServiceCaller({ context });
    const result = view === "tree"
      ? await listProjectBuilderTreeService(caller, { projectId: id, sessionId })
      : view === "file"
        ? await readProjectBuilderFileService(caller, { projectId: id, sessionId, path: url.searchParams.get("path") || "" })
        : view === "verification"
          ? await showProjectBuilderVerificationService(caller, { projectId: id, sessionId, verificationId: url.searchParams.get("verificationId") || "" })
        : view === "github.repositories"
          ? await listProjectBuilderRepositoriesService(caller, { projectId: id })
        : await showProjectBuilderService(caller, { projectId: id });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "App Builder could not be read." }, { status: 404, headers: privateNoStoreHeaders });
  }
}

async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = mutationSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid App Builder operation.", details: parsed.error.flatten() }, { status: 400 });
  const action = parsed.data.action;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: action === "file.update" ? "app_builder_file" : action === "command.run" ? "app_builder_command" : action.startsWith("checkpoint.") ? "app_builder_checkpoint" : action === "verification.run" || action === "sentinel.record" ? "app_builder_verification" : action === "repository.bind" ? "app_builder_repository" : action === "delivery.create" ? "app_builder_delivery" : action.startsWith("deployment.") ? "app_builder_deployment" : "app_builder_session",
      resourceId: id,
      riskLevel: action === "create" || action === "stop" || action === "checkpoint.restore" || action === "delivery.create" || action === "deployment.preview" ? 2 : 1,
      nativeMutationCapability: "workspaces.update",
      metadata: { action },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const caller = createRequestMutationAppServiceCaller(request, context, { projectId: id, purpose: `project.builder.${action}` });
    const result = action === "create"
      ? await createProjectBuilderService(caller, { projectId: id })
      : action === "file.update"
        ? await updateProjectBuilderFileService(caller, { projectId: id, sessionId: parsed.data.sessionId, path: parsed.data.path, expectedSha256: parsed.data.expectedSha256, content: parsed.data.content })
        : action === "command.run"
          ? await runProjectBuilderCommandService(caller, { projectId: id, sessionId: parsed.data.sessionId, command: parsed.data.command })
          : action === "checkpoint.create"
            ? await createProjectBuilderCheckpointService(caller, { projectId: id, sessionId: parsed.data.sessionId, expectedSessionRevision: parsed.data.expectedSessionRevision, reason: parsed.data.reason, label: parsed.data.label, sourceRunId: parsed.data.sourceRunId })
            : action === "checkpoint.restore"
              ? await restoreProjectBuilderCheckpointService(caller, { projectId: id, sessionId: parsed.data.sessionId, checkpointId: parsed.data.checkpointId, expectedSessionRevision: parsed.data.expectedSessionRevision })
              : action === "verification.run"
                ? await runProjectBuilderVerificationService(caller, { projectId: id, sessionId: parsed.data.sessionId, checkpointId: parsed.data.checkpointId, expectedSessionRevision: parsed.data.expectedSessionRevision })
              : action === "sentinel.record"
                ? await recordProjectBuilderSentinelReviewService(caller, { projectId: id, sessionId: parsed.data.sessionId, verificationId: parsed.data.verificationId, sourceRunId: parsed.data.sourceRunId })
                : action === "repository.bind"
                  ? await bindProjectBuilderRepositoryService(caller, { projectId: id, sessionId: parsed.data.sessionId, repositoryId: parsed.data.repositoryId })
                  : action === "delivery.create"
                    ? await deliverProjectBuilderPullRequestService(caller, { projectId: id, sessionId: parsed.data.sessionId, repositoryBindingId: parsed.data.repositoryBindingId, expectedBindingRevision: parsed.data.expectedBindingRevision, checkpointId: parsed.data.checkpointId, verificationId: parsed.data.verificationId, branchName: parsed.data.branchName, title: parsed.data.title, body: parsed.data.body, draft: parsed.data.draft })
                  : action === "deployment.preview"
                    ? await createProjectBuilderPreviewDeploymentService(caller, { projectId: id, sessionId: parsed.data.sessionId, checkpointId: parsed.data.checkpointId, verificationId: parsed.data.verificationId, repositoryDeliveryId: parsed.data.repositoryDeliveryId })
                  : action === "deployment.refresh"
                    ? await refreshProjectBuilderPreviewDeploymentService(caller, { projectId: id, sessionId: parsed.data.sessionId, deploymentId: parsed.data.deploymentId })
                  : await stopProjectBuilderService(caller, { projectId: id, sessionId: parsed.data.sessionId });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "App Builder operation failed." }, { status: 409, headers: privateNoStoreHeaders });
  }
}
