import { createHash } from "node:crypto";
import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { showProjectService } from "@/lib/app-services/projects";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  requestSharedMemoryAccessFromSecurityContext,
  type RequestSharedMemoryAccessV1,
} from "@/lib/memory/shared-context";
import { projectTaskIdForIdempotencyKey } from "@/lib/projects/events";
import {
  createProject,
  createProjectTasks,
} from "@/lib/projects/store";
import { redactSensitive } from "@/lib/security/context";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { workspaceTemplateDefinitionInputSchema } from "@/lib/workspace-templates/contracts";
import {
  findWorkspaceTemplateInstantiation,
  getWorkspaceTemplateVersion,
  listWorkspaceTemplates,
  publishWorkspaceTemplate,
  recordWorkspaceTemplateInstantiation,
  type WorkspaceTemplateAuthority,
} from "@/lib/workspace-templates/store";

export const workspaceTemplateListServiceInputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(240).optional(),
  includeHistory: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

export const workspaceTemplatePublishServiceInputSchema = workspaceTemplateDefinitionInputSchema.extend({
  workspaceId: z.string().trim().min(1).max(240).optional(),
}).strict();

export const workspaceTemplateInstantiateServiceInputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(240).optional(),
  templateId: z.string().trim().min(1).max(240),
  templateVersionId: z.string().trim().min(1).max(240).optional(),
  title: z.string().trim().min(1).max(180).optional(),
  objective: z.string().trim().min(1).max(2_000).optional(),
  status: z.enum(["draft", "active"]).optional(),
}).strict();

export async function listWorkspaceTemplatesService(
  caller: AppServiceCaller,
  input: z.input<typeof workspaceTemplateListServiceInputSchema>,
) {
  const value = workspaceTemplateListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.workspace_templates.list"),
  );
  const access = await templateAccess(caller, value.workspaceId, "read");
  const templates = await listWorkspaceTemplates({
    tenantId: caller.context.tenantId,
    workspaceId: access.authority.workspaceId,
    canonicalActorId: access.actorBinding.canonicalActorId,
  }, {
    activeOnly: !value.includeHistory,
    limit: value.limit,
  });
  return completeAppServiceCall(authorized, {
    context: publicTemplateContext(access),
    templates,
  }, { resourceCount: templates.length });
}

export async function publishWorkspaceTemplateService(
  caller: AppServiceCaller,
  input: z.input<typeof workspaceTemplatePublishServiceInputSchema>,
) {
  const value = redactSensitive(
    workspaceTemplatePublishServiceInputSchema.parse(input),
  ) as z.output<typeof workspaceTemplatePublishServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.workspace_templates.publish"),
  );
  const access = await templateAccess(caller, value.workspaceId, "write");
  requireTemplateWrite(access);
  const { workspaceId: _workspaceId, ...definition } = value;
  void _workspaceId;
  const template = await publishWorkspaceTemplate({
    authority: templateMutationAuthority(caller, access, "workspace.template.publish"),
    definition,
  });
  return completeAppServiceCall(authorized, {
    context: publicTemplateContext(access),
    template,
  });
}

export async function instantiateWorkspaceTemplateService(
  caller: AppServiceCaller,
  input: z.input<typeof workspaceTemplateInstantiateServiceInputSchema>,
) {
  const value = redactSensitive(
    workspaceTemplateInstantiateServiceInputSchema.parse(input),
  ) as z.output<typeof workspaceTemplateInstantiateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.workspace_templates.instantiate"),
  );
  const access = await templateAccess(caller, value.workspaceId, "write");
  requireTemplateWrite(access);
  const readAuthority = {
    tenantId: caller.context.tenantId,
    workspaceId: access.authority.workspaceId,
    canonicalActorId: access.actorBinding.canonicalActorId,
  };
  const replay = await findWorkspaceTemplateInstantiation({
    authority: readAuthority,
    idempotencyKey: caller.idempotencyKey!,
  });
  if (replay) {
    const project = (await showProjectService(caller, {
      projectId: replay.projectId,
      taskLimit: 100,
      artifactLimit: 100,
    })).data.project;
    if (!project) throw new Error("The instantiated project is unavailable.");
    return completeAppServiceCall(authorized, {
      context: publicTemplateContext(access),
      instantiation: replay,
      project,
    });
  }

  const template = await getWorkspaceTemplateVersion({
    authority: readAuthority,
    templateId: value.templateId,
    templateVersionId: value.templateVersionId,
  });
  if (!template) throw new WorkspaceTemplateNotFoundError();
  const rootDigest = canonicalJsonSha256({
    idempotencyKey: caller.idempotencyKey,
    templateVersionId: template.templateVersionId,
    templateSha256: template.templateSha256,
  });
  const projectIdempotencyKey = `template-project:${rootDigest}`;
  const projectScope = legacyProjectMutationScope(caller, access, "workspace.template.instantiate.project");
  const project = await createProject({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    title: value.title || template.project.title,
    objective: value.objective || template.project.objective,
    status: value.status || template.project.status,
    mutation: {
      executionScope: projectScope,
      idempotencyKey: projectIdempotencyKey,
    },
  });
  const taskIdByKey = new Map(template.project.tasks.map((task) => {
    const taskKey = taskIdempotencyKey(rootDigest, task.key);
    return [task.key, projectTaskIdForIdempotencyKey(
      caller.context.tenantId,
      project.id,
      taskKey,
    )] as const;
  }));
  const createdTasks = [];
  for (const task of template.project.tasks) {
    const taskKey = taskIdempotencyKey(rootDigest, task.key);
    const [created] = await createProjectTasks(project.id, [{
      title: task.title,
      detail: task.detail,
      priority: task.priority,
      agentId: task.agentId,
      origin: "manual",
      dependsOn: task.dependsOnKeys.map((key) => taskIdByKey.get(key)!),
    }], {
      tenantId: caller.context.tenantId,
      actorId: caller.context.actorId,
      mutation: {
        executionScope: legacyProjectMutationScope(
          caller,
          access,
          "workspace.template.instantiate.task",
          project.id,
        ),
        idempotencyKey: taskKey,
      },
    });
    if (!created || created.id !== taskIdByKey.get(task.key)) {
      throw new Error("Template task instantiation did not converge.");
    }
    createdTasks.push(created);
  }
  const projectSnapshot = Object.freeze({
    schemaVersion: 1,
    projectId: project.id,
    templateVersionId: template.templateVersionId,
    project: Object.freeze({
      title: project.title,
      objective: project.objective,
      status: project.status,
    }),
    tasks: Object.freeze(createdTasks.map((task) => Object.freeze({
      id: task.id,
      title: task.title,
      detail: task.detail,
      priority: task.priority,
      agentId: task.agentId,
      dependsOn: Object.freeze([...task.dependsOn]),
    }))),
  });
  const instantiation = await recordWorkspaceTemplateInstantiation({
    authority: templateMutationAuthority(
      caller,
      access,
      "workspace.template.instantiate",
    ),
    template,
    projectSnapshot,
  });
  const projectView = (await showProjectService(caller, {
    projectId: project.id,
    taskLimit: 100,
    artifactLimit: 100,
  })).data.project;
  if (!projectView) throw new Error("The instantiated project is unavailable.");
  return completeAppServiceCall(authorized, {
    context: publicTemplateContext(access),
    instantiation,
    project: projectView,
  });
}

export class WorkspaceTemplateWriteDeniedError extends Error {
  constructor() {
    super("Workspace template contributor access is required.");
    this.name = "WorkspaceTemplateWriteDeniedError";
  }
}

export class WorkspaceTemplateNotFoundError extends Error {
  constructor() {
    super("The selected workspace template version was not found.");
    this.name = "WorkspaceTemplateNotFoundError";
  }
}

function templateAccess(
  caller: AppServiceCaller,
  workspaceId: string | undefined,
  mode: "read" | "write",
) {
  return requestSharedMemoryAccessFromSecurityContext(caller.context, {
    scope: "workspace",
    workspaceId,
    correlationId:
      caller.executionScope?.correlationId || caller.idempotencyKey || crypto.randomUUID(),
    purposeId: mode === "write" ? MEMORY_PURPOSE_IDS.write : MEMORY_PURPOSE_IDS.read,
    auditPurpose: `${mode === "write" ? "Manage" : "List"} versioned workspace templates.`,
  });
}

function requireTemplateWrite(access: RequestSharedMemoryAccessV1) {
  if (!access.authority.canWrite) throw new WorkspaceTemplateWriteDeniedError();
}

function templateMutationAuthority(
  caller: AppServiceCaller,
  access: RequestSharedMemoryAccessV1,
  purpose: "workspace.template.publish" | "workspace.template.instantiate",
): WorkspaceTemplateAuthority {
  const source = caller.executionScope!;
  return {
    tenantId: caller.context.tenantId,
    workspaceId: access.authority.workspaceId,
    canonicalActorId: access.actorBinding.canonicalActorId,
    idempotencyKey: caller.idempotencyKey!,
    executionScope: createExecutionScope({
      tenantId: caller.context.tenantId,
      initiatingActorId: access.actorBinding.canonicalActorId,
      executingPrincipalType: source.executingPrincipalType,
      executingPrincipalId: source.executingPrincipalType === "user"
        ? access.actorBinding.canonicalActorId
        : source.executingPrincipalId,
      workspaceId: access.authority.workspaceId,
      correlationId: source.correlationId,
      causationId: source.causationId,
      delegationId: source.delegationId,
      contextGrantIds: source.contextGrantIds,
      capabilityGrantIds: source.capabilityGrantIds,
      purpose,
    }),
  };
}

function legacyProjectMutationScope(
  caller: AppServiceCaller,
  access: RequestSharedMemoryAccessV1,
  purpose: string,
  projectId?: string,
) {
  const source = caller.executionScope!;
  return createExecutionScope({
    tenantId: caller.context.tenantId,
    initiatingActorId: caller.context.actorId,
    executingPrincipalType: source.executingPrincipalType,
    executingPrincipalId: source.executingPrincipalType === "user"
      ? caller.context.actorId
      : source.executingPrincipalId,
    workspaceId: access.authority.workspaceId,
    projectId,
    correlationId: source.correlationId,
    causationId: source.causationId,
    delegationId: source.delegationId,
    contextGrantIds: source.contextGrantIds,
    capabilityGrantIds: source.capabilityGrantIds,
    purpose,
  });
}

function taskIdempotencyKey(rootDigest: string, taskKey: string) {
  return `template-task:${createHash("sha256")
    .update(`${rootDigest}:${taskKey}`, "utf8")
    .digest("hex")}`;
}

function publicTemplateContext(access: RequestSharedMemoryAccessV1) {
  return {
    workspaceId: access.authority.workspaceId,
    accessLevel: access.authority.accessLevel,
    canWrite: access.authority.canWrite,
    authoritySha256: access.authority.authoritySha256,
  };
}
