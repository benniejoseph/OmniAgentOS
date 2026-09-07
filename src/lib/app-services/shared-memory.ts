import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { publicMemoryServiceRecord } from "@/lib/app-services/memory";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  buildProjectSharedMemoryAccessBindingV1,
  buildWorkspaceSharedMemoryAccessBindingV1,
  MEMORY_PURPOSE_IDS,
} from "@/lib/memory/access-binding";
import {
  requestSharedMemoryAccessFromSecurityContext,
  type RequestSharedMemoryAccessV1,
} from "@/lib/memory/shared-context";
import { listMemories, saveMemory } from "@/lib/memory/store";
import type { MemoryType } from "@/lib/memory/types";
import { embedTexts } from "@/lib/openai/client";
import { redactSensitive } from "@/lib/security/context";
import type { AiUsageScope } from "@/lib/usage/types";

const sharedMemoryScopeFields = {
  scope: z.enum(["project", "workspace"]),
  projectId: z.string().trim().min(1).max(240).optional(),
  workspaceId: z.string().trim().min(1).max(240).optional(),
};

export const sharedMemoryListServiceInputSchema = z.object({
  ...sharedMemoryScopeFields,
  limit: z.number().int().min(1).max(100).default(50),
}).strict().superRefine(requireProjectCoordinate);

export const sharedMemoryWriteServiceInputSchema = z.object({
  ...sharedMemoryScopeFields,
  title: z.string().trim().min(1).max(240),
  content: z.string().min(1).max(200_000),
  type: z.enum([
    "preference",
    "fact",
    "episode",
    "procedure",
    "knowledge",
    "decision",
    "task",
  ]).optional(),
  tier: z.enum([
    "working",
    "episodic",
    "semantic",
    "procedural",
    "preference",
    "decision",
    "commitment",
    "summary",
  ]).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
}).strict().superRefine(requireProjectCoordinate);

type SharedMemoryServiceOptions = Readonly<{
  abortSignal?: AbortSignal;
  usageScope?: AiUsageScope;
}>;

export class SharedContextWriteDeniedError extends Error {
  constructor() {
    super("Shared context write access is required.");
    this.name = "SharedContextWriteDeniedError";
  }
}

export async function listSharedMemoryService(
  caller: AppServiceCaller,
  input: z.input<typeof sharedMemoryListServiceInputSchema>,
) {
  const value = sharedMemoryListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.memory.shared.list"),
  );
  const access = await sharedMemoryAccess(caller, value, {
    purposeId: MEMORY_PURPOSE_IDS.read,
    auditPurpose: `List explicitly selected ${value.scope} knowledge.`,
  });
  const memories = (await listMemories({
    tenantId: caller.context.tenantId,
    includeInactive: true,
    limit: value.limit,
    accessScope: access.databaseAccessScope,
  })).map(publicMemoryServiceRecord);
  return completeAppServiceCall(authorized, {
    context: publicSharedContext(access),
    memories,
  }, { resourceCount: memories.length });
}

export async function writeSharedMemoryService(
  caller: AppServiceCaller,
  input: z.input<typeof sharedMemoryWriteServiceInputSchema>,
  options: SharedMemoryServiceOptions = {},
) {
  const value = redactSensitive(
    sharedMemoryWriteServiceInputSchema.parse(input),
  ) as z.output<typeof sharedMemoryWriteServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.memory.shared.write"),
  );
  const access = await sharedMemoryAccess(caller, value, {
    purposeId: MEMORY_PURPOSE_IDS.write,
    auditPurpose: `Write explicitly selected ${value.scope} knowledge.`,
  });
  if (!access.authority.canWrite) {
    throw new SharedContextWriteDeniedError();
  }
  const embedding = (await embedTexts(
    [`${value.title}\n\n${value.content}`],
    options.abortSignal,
    options.usageScope || sharedMemoryUsageScope(caller, access),
  ))?.[0];
  const bindingInput = {
    tenantId: caller.context.tenantId,
    ownerActorId: access.actorBinding.canonicalActorId,
    workspaceId: access.authority.workspaceId,
    originPurpose: "app.memory.shared.write",
  };
  const accessBinding = access.authority.scope === "project"
    ? buildProjectSharedMemoryAccessBindingV1({
        ...bindingInput,
        projectId: access.authority.projectId!,
      })
    : buildWorkspaceSharedMemoryAccessBindingV1(bindingInput);
  const record = await saveMemory({
    title: value.title,
    content: value.content,
    tenantId: caller.context.tenantId,
    type: value.type as MemoryType | undefined,
    tier: value.tier,
    tags: value.tags,
    importance: value.importance,
    confidence: value.confidence,
    evidenceRefs: value.evidenceRefs,
    validFrom: value.validFrom,
    validTo: value.validTo,
    source: "manual",
    scope: access.authority.scope,
    assertedBy: "user",
    embedding,
    accessBinding,
    databaseAccessScope: access.databaseAccessScope,
    executionScope: access.executionScope,
  });
  return completeAppServiceCall(authorized, {
    context: publicSharedContext(access),
    record: publicMemoryServiceRecord(record),
  }, { resourceCount: 1 });
}

function requireProjectCoordinate(
  value: { scope: "project" | "workspace"; projectId?: string },
  context: z.RefinementCtx,
) {
  if (value.scope === "project" && !value.projectId) {
    context.addIssue({
      code: "custom",
      path: ["projectId"],
      message: "A project ID is required for project shared context.",
    });
  }
}

function sharedMemoryAccess(
  caller: AppServiceCaller,
  value: { scope: "project" | "workspace"; projectId?: string; workspaceId?: string },
  purpose: {
    purposeId: typeof MEMORY_PURPOSE_IDS.read | typeof MEMORY_PURPOSE_IDS.write;
    auditPurpose: string;
  },
) {
  return requestSharedMemoryAccessFromSecurityContext(caller.context, {
    scope: value.scope,
    projectId: value.projectId,
    workspaceId: value.workspaceId,
    correlationId:
      caller.executionScope?.correlationId ||
      caller.idempotencyKey ||
      crypto.randomUUID(),
    ...purpose,
  });
}

function publicSharedContext(access: RequestSharedMemoryAccessV1) {
  return {
    policyVersion: access.authority.policyVersion,
    scope: access.authority.scope,
    workspaceId: access.authority.workspaceId,
    projectId: access.authority.projectId,
    accessLevel: access.authority.accessLevel,
    canWrite: access.authority.canWrite,
    authoritySha256: access.authority.authoritySha256,
  };
}

function sharedMemoryUsageScope(
  caller: AppServiceCaller,
  access: RequestSharedMemoryAccessV1,
): AiUsageScope {
  const sourceId = caller.idempotencyKey || access.executionScope.correlationId;
  return {
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    sourceStreamId: `app-service:${sourceId}`,
    operation: "embedding",
    purpose: "app.memory.shared.write",
    correlationId: access.executionScope.correlationId,
    causationId: caller.executionScope?.causationId || undefined,
    executionScope: access.executionScope,
    credentialSource: "deployment_environment",
  };
}
