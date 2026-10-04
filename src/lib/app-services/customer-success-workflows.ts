import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { CustomerAccountWriteDeniedError } from "@/lib/app-services/customer-accounts";
import { showProjectService } from "@/lib/app-services/projects";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { getCustomerAccount360 } from "@/lib/customer-success/store";
import {
  buildCustomerSuccessOutcomeReceipt,
  buildCustomerSuccessWorkflowRunRevision,
  CUSTOMER_SUCCESS_WORKFLOW_PACK,
  customerSuccessProjectTaskIdempotencyKey,
  customerSuccessRunId,
  customerSuccessWorkflowInputSchema,
  getCustomerSuccessWorkflowDefinition,
  validateCompletedWorkflowArtifacts,
} from "@/lib/customer-success/workflow-contracts";
import {
  CustomerSuccessWorkflowConflictError,
  findCustomerSuccessWorkflowOutcomeReplay,
  getCustomerSuccessWorkflowRun,
  listCustomerSuccessWorkflowRuns,
  saveCustomerSuccessWorkflowOutcome,
  saveCustomerSuccessWorkflowStart,
} from "@/lib/customer-success/workflow-store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  requestSharedMemoryAccessFromSecurityContext,
  type RequestSharedMemoryAccessV1,
} from "@/lib/memory/shared-context";
import { projectTaskIdForIdempotencyKey } from "@/lib/projects/events";
import { createProject, createProjectTasks } from "@/lib/projects/store";
import { redactSensitive } from "@/lib/security/context";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  CUSTOMER_SUCCESS_WORKFLOW_NATIVE_READ_CONTRACT,
  customerSuccessWorkflowNativeStartRequestSchema, customerSuccessWorkflowNativeOutcomeRequestSchema,
  type CustomerSuccessWorkflowNativeRequest,
} from "@/lib/customer-success/workflow-mutation-contracts";
import {
  submitCustomerSuccessWorkflowNativeStart, submitCustomerSuccessWorkflowNativeOutcome,
  getCustomerSuccessWorkflowNativeRun, readCustomerSuccessWorkflowNativeAcceptance,
} from "@/lib/customer-success/workflow-native-store";
import {
  nativeCustomerWorkflowAcceptanceReadResponseForScopeSchema, nativeCustomerWorkflowMutationResponseForScopeSchema,
  nativeCustomerWorkflowProjectProgressSchema, nativeCustomerWorkflowReadQuerySchema, nativeCustomerWorkflowRunReadResponseForScopeSchema,
} from "@/lib/mobile/customer-workflow-mutation-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";

const workspaceSelectionSchema = z.object({
  workspaceId: z.string().trim().min(1).max(240).optional(),
}).strict();
const accountIdSchema = z.string().regex(/^customer-account:[a-f0-9]{64}$/);
const runIdSchema = z.string().regex(/^customer-success-run:[a-f0-9]{64}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const opaqueIdSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);

export const customerSuccessWorkflowListServiceInputSchema = workspaceSelectionSchema.extend({
  accountId: accountIdSchema,
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

export const customerSuccessWorkflowStartServiceInputSchema = workspaceSelectionSchema.extend({
  accountId: accountIdSchema,
  expectedAccountRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  expectedAccountSha256: sha256Schema,
  input: customerSuccessWorkflowInputSchema,
}).strict();

const artifactReceiptDraftSchema = z.object({
  artifactKey: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
  projectArtifactId: opaqueIdSchema,
  evidenceKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,79}$/)).max(20),
  evidenceRefs: z.array(opaqueIdSchema).max(100),
}).strict();

export const customerSuccessWorkflowOutcomeServiceInputSchema = workspaceSelectionSchema.extend({
  accountId: accountIdSchema,
  runId: runIdSchema,
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["completed", "blocked", "cancelled"]),
  summary: z.string().trim().min(1).max(4_000),
  artifactReceipts: z.array(artifactReceiptDraftSchema).max(20).default([]),
  nextAction: z.string().trim().min(1).max(500),
}).strict();

export const customerSuccessWorkflowNativeStartServiceInputSchema = customerSuccessWorkflowNativeStartRequestSchema.extend({ accountId: accountIdSchema }).strict();
export const customerSuccessWorkflowNativeOutcomeServiceInputSchema = customerSuccessWorkflowNativeOutcomeRequestSchema.extend({ accountId: accountIdSchema }).strict();
export const customerSuccessWorkflowNativeReadServiceInputSchema = nativeCustomerWorkflowReadQuerySchema.extend({ accountId: accountIdSchema, runId: runIdSchema }).strict();
export const customerSuccessWorkflowNativeAcceptanceReadServiceInputSchema = customerSuccessWorkflowNativeReadServiceInputSchema.extend({ keySha256: sha256Schema }).strict();

/** Native setup owns one atomic store admission; it never enters the legacy project/task loop. */
export async function startCustomerSuccessWorkflowNativeService(caller: AppServiceCaller,
  input: z.input<typeof customerSuccessWorkflowNativeStartServiceInputSchema>) {
  const { accountId, ...request } = customerSuccessWorkflowNativeStartServiceInputSchema.parse(input);
  return mutateNativeWorkflow(caller, accountId, request);
}

export async function recordCustomerSuccessWorkflowNativeOutcomeService(caller: AppServiceCaller,
  input: z.input<typeof customerSuccessWorkflowNativeOutcomeServiceInputSchema>) {
  const { accountId, ...request } = customerSuccessWorkflowNativeOutcomeServiceInputSchema.parse(input);
  return mutateNativeWorkflow(caller, accountId, request);
}

async function mutateNativeWorkflow(caller: AppServiceCaller, accountId: string, request: CustomerSuccessWorkflowNativeRequest) {
  const start = request.contract === "customer-success-workflow-start-request:1";
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract(start
    ? "app.customer_accounts.workflows.start" : "app.customer_accounts.workflows.outcome.record"));
  const canonicalActorId = nativeWorkflowCaller(caller, { workspaceId: request.workspaceId,
    causationId: start ? accountId : request.runId, operation: start ? "start" : "outcome" });
  if (canonicalJsonSha256(redactSensitive(request)) !== canonicalJsonSha256(request)) {
    throw new CustomerSuccessWorkflowConflictError("Workflow input contains sensitive material that cannot be saved as the exact reviewed request.");
  }
  const access = await workflowAccess(caller, request.workspaceId, "write");
  requireNativeWorkflowAccess(access, canonicalActorId, request.workspaceId);
  requireWorkflowWrite(access);
  const authority = { ...mutationAuthority(caller, access, start ? "customer.success.workflow.start" : "customer.success.workflow.outcome"),
    readableActorIds: [canonicalActorId] };
  const committed = request.contract === "customer-success-workflow-start-request:1"
    ? await submitCustomerSuccessWorkflowNativeStart({ authority, accountId, request })
    : await submitCustomerSuccessWorkflowNativeOutcome({ authority, accountId, request });
  const result = completeAppServiceCall(authorized, {
    contract: CUSTOMER_SUCCESS_WORKFLOW_NATIVE_READ_CONTRACT, context: publicWorkflowContext(access),
    currentAccount: committed.currentAccount, acceptance: committed.acceptance, replayed: committed.replayed,
  }, { resourceCount: 1 });
  nativeCustomerWorkflowMutationResponseForScopeSchema({ tenantId: caller.context.tenantId, workspaceId: request.workspaceId,
    canonicalActorId, requestActorId: caller.context.actorId, role: caller.context.role, accountId,
    executionScope: caller.executionScope!, idempotencyKey: caller.idempotencyKey!, request,
  }).parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}

export async function readCustomerSuccessWorkflowNativeAcceptanceService(caller: AppServiceCaller,
  input: z.input<typeof customerSuccessWorkflowNativeAcceptanceReadServiceInputSchema>) {
  const value = customerSuccessWorkflowNativeAcceptanceReadServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.customer_accounts.workflows.mutations.show"));
  const canonicalActorId = nativeWorkflowCaller(caller);
  const access = await workflowAccess(caller, value.workspaceId, "read");
  requireNativeWorkflowAccess(access, canonicalActorId, value.workspaceId);
  const current = await readCustomerSuccessWorkflowNativeAcceptance({ ...readAuthority(caller, access), readableActorIds: [canonicalActorId] }, value);
  if (!current) throw new CustomerSuccessWorkflowConflictError("Current owned Account workflow was not found.");
  const result = completeAppServiceCall(authorized, { contract: CUSTOMER_SUCCESS_WORKFLOW_NATIVE_READ_CONTRACT,
    context: publicWorkflowContext(access), currentAccount: current.currentAccount, acceptance: current.acceptance,
  }, { resourceCount: current.acceptance ? 1 : 0 });
  nativeCustomerWorkflowAcceptanceReadResponseForScopeSchema({ ...value, tenantId: caller.context.tenantId,
    canonicalActorId, requestActorId: caller.context.actorId, role: caller.context.role,
  }).parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}

export async function showCustomerSuccessWorkflowNativeService(caller: AppServiceCaller,
  input: z.input<typeof customerSuccessWorkflowNativeReadServiceInputSchema>) {
  const value = customerSuccessWorkflowNativeReadServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.customer_accounts.workflows.show"));
  const canonicalActorId = nativeWorkflowCaller(caller);
  const access = await workflowAccess(caller, value.workspaceId, "read");
  requireNativeWorkflowAccess(access, canonicalActorId, value.workspaceId);
  const current = await getCustomerSuccessWorkflowNativeRun({ ...readAuthority(caller, access), readableActorIds: [canonicalActorId] }, value);
  if (!current) throw new CustomerSuccessWorkflowConflictError("Current owned Account workflow was not found.");
  const candidate = getCustomerSuccessWorkflowDefinition(current.run.workflowId);
  const definition = candidate.definitionSha256 === current.run.definitionSha256 ? candidate : null;
  let projectProgress: z.infer<typeof nativeCustomerWorkflowProjectProgressSchema> = { state: "unavailable" };
  try {
    const project = (await showProjectService(caller, { projectId: current.run.projectId, taskLimit: 100, artifactLimit: 100 })).data.project;
    if (project) {
      const mapped = new Set(current.run.projectTaskIds.map((task) => task.projectTaskId));
      const progress = nativeCustomerWorkflowProjectProgressSchema.safeParse({
        state: "available", projectId: project.id, status: project.status, autonomyMode: project.autonomyMode, executionStatus: project.executionStatus,
        tasks: project.tasks.filter((task) => mapped.has(task.id)).map((task) => ({ id: task.id, title: task.title, status: task.status })),
        artifacts: project.artifacts.map((artifact) => ({ id: artifact.id, title: artifact.title, status: artifact.status, evidenceRefs: artifact.evidenceRefs })),
        artifactsMayBeIncomplete: project.artifacts.length >= 100,
      });
      if (progress.success && Buffer.byteLength(JSON.stringify(progress.data), "utf8") <= 512_000) projectProgress = progress.data;
    }
  } catch { /* Current project progress cannot erase the immutable workflow or its acceptance. */ }
  const result = completeAppServiceCall(authorized, { contract: CUSTOMER_SUCCESS_WORKFLOW_NATIVE_READ_CONTRACT,
    context: publicWorkflowContext(access), currentAccount: current.currentAccount, run: current.run,
    definition, definitionAvailability: definition ? "available" as const : "unavailable" as const, projectProgress,
  }, { resourceCount: 1 });
  nativeCustomerWorkflowRunReadResponseForScopeSchema({ ...value, tenantId: caller.context.tenantId,
    canonicalActorId, requestActorId: caller.context.actorId, role: caller.context.role,
  }).parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}

function nativeWorkflowCaller(caller: AppServiceCaller, mutation?: { workspaceId: string; causationId: string; operation: "start" | "outcome" }) {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context), scope = caller.executionScope;
  if (!canonical || (mutation ? !scope || !caller.idempotencyKey ||
    scope.tenantId !== caller.context.tenantId || scope.initiatingActorId !== caller.context.actorId ||
    scope.executingPrincipalType !== "user" || scope.executingPrincipalId !== caller.context.actorId ||
    scope.workspaceId !== mutation.workspaceId || scope.projectId !== null || scope.missionId !== null ||
    scope.delegationId !== null || scope.contextGrantIds.length > 0 || scope.capabilityGrantIds.length > 0 ||
    scope.causationId !== mutation.causationId || scope.purpose !== `api.customer-success-workflow.${mutation.operation}`
    : scope !== undefined || caller.idempotencyKey !== undefined)) throw new CustomerAccountWriteDeniedError();
  return canonical.actorId;
}
function requireNativeWorkflowAccess(access: RequestSharedMemoryAccessV1, canonicalActorId: string, workspaceId: string) {
  if (access.actorBinding.canonicalActorId !== canonicalActorId || access.authority.workspaceId !== workspaceId ||
    access.authority.initiatingActorId !== canonicalActorId) throw new CustomerAccountWriteDeniedError();
}

export async function listCustomerSuccessWorkflowsService(
  caller: AppServiceCaller,
  input: z.input<typeof customerSuccessWorkflowListServiceInputSchema>,
) {
  const value = customerSuccessWorkflowListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.workflows.list"),
  );
  const access = await workflowAccess(caller, value.workspaceId, "read");
  const authority = readAuthority(caller, access);
  const [account, runs] = await Promise.all([
    getCustomerAccount360(authority, value.accountId),
    listCustomerSuccessWorkflowRuns(authority, {
      accountId: value.accountId,
      limit: value.limit,
    }),
  ]);
  if (!account) throw new CustomerSuccessWorkflowConflictError("Customer account was not found.");
  return completeAppServiceCall(authorized, {
    context: publicWorkflowContext(access),
    pack: CUSTOMER_SUCCESS_WORKFLOW_PACK,
    runs,
  }, { resourceCount: runs.length });
}

export async function startCustomerSuccessWorkflowService(
  caller: AppServiceCaller,
  input: z.input<typeof customerSuccessWorkflowStartServiceInputSchema>,
) {
  const value = redactSensitive(
    customerSuccessWorkflowStartServiceInputSchema.parse(input),
  ) as z.output<typeof customerSuccessWorkflowStartServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.workflows.start"),
  );
  const access = await workflowAccess(caller, value.workspaceId, "write");
  requireWorkflowWrite(access);
  const read = readAuthority(caller, access);
  const runId = customerSuccessRunId({
    tenantId: caller.context.tenantId,
    workspaceId: access.authority.workspaceId,
    accountId: value.accountId,
    idempotencyKey: caller.idempotencyKey!,
  });
  const replay = await getCustomerSuccessWorkflowRun(read, runId);
  if (replay) {
    assertStartReplay(replay, value);
    const project = await requireProject(caller, replay.projectId);
    return completeAppServiceCall(authorized, {
      context: publicWorkflowContext(access),
      definition: getCustomerSuccessWorkflowDefinition(replay.workflowId),
      run: replay,
      project,
    });
  }
  const account360 = await getCustomerAccount360(read, value.accountId);
  if (!account360) throw new CustomerSuccessWorkflowConflictError("Customer account was not found.");
  const { account } = account360;
  if (
    account.revision !== value.expectedAccountRevision ||
    account.accountSha256 !== value.expectedAccountSha256
  ) {
    throw new CustomerSuccessWorkflowConflictError(
      "Account 360 changed before the workflow could start. Refresh and try again.",
    );
  }
  if (account.ownerActorId !== access.actorBinding.canonicalActorId) {
    throw new CustomerSuccessWorkflowConflictError(
      "Only the current Account 360 owner can start this workflow.",
    );
  }
  const definition = getCustomerSuccessWorkflowDefinition(value.input.workflowId);
  const projectIdempotencyKey = `csm-project:${canonicalJsonSha256({ runId })}`;
  const project = await createProject({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    title: `${account.name} · ${definition.name}`.slice(0, 180),
    objective: value.input.objective,
    status: definition.projectTemplate.status,
    ...(value.input.targetDate ? { targetDate: value.input.targetDate } : {}),
    mutation: {
      idempotencyKey: projectIdempotencyKey,
      executionScope: projectMutationScope(caller, access, "customer.success.workflow.project"),
    },
  });
  const taskIdByKey = new Map(definition.projectTemplate.tasks.map((task) => {
    const taskKey = customerSuccessProjectTaskIdempotencyKey(runId, task.key);
    return [task.key, projectTaskIdForIdempotencyKey(
      caller.context.tenantId,
      project.id,
      taskKey,
    )] as const;
  }));
  const projectTaskIds = [];
  for (const task of definition.projectTemplate.tasks) {
    const taskKey = customerSuccessProjectTaskIdempotencyKey(runId, task.key);
    const [created] = await createProjectTasks(project.id, [{
      title: task.title,
      detail: `${task.detail}\nCSM run: ${runId}`.slice(0, 1_000),
      priority: task.priority,
      agentId: task.agentId,
      origin: "manual",
      dependsOn: task.dependsOnKeys.map((dependency) => taskIdByKey.get(dependency)!),
    }], {
      tenantId: caller.context.tenantId,
      actorId: caller.context.actorId,
      mutation: {
        idempotencyKey: taskKey,
        executionScope: projectMutationScope(
          caller,
          access,
          "customer.success.workflow.task",
          project.id,
        ),
      },
    });
    if (!created || created.id !== taskIdByKey.get(task.key)) {
      throw new CustomerSuccessWorkflowConflictError(
        "Customer-success workflow tasks did not converge.",
      );
    }
    projectTaskIds.push({ taskKey: task.key, projectTaskId: created.id });
  }
  const recordedAt = new Date().toISOString();
  const run = buildCustomerSuccessWorkflowRunRevision({
    tenantId: caller.context.tenantId,
    workspaceId: access.authority.workspaceId,
    accountId: account.accountId,
    accountRevisionId: account.revisionId,
    accountRevision: account.revision,
    accountSha256: account.accountSha256,
    runId,
    revision: 1,
    workflowId: definition.workflowId,
    definitionSha256: definition.definitionSha256,
    input: value.input,
    owner: account.accountOwner,
    ownerActorId: account.ownerActorId,
    projectId: project.id,
    projectTaskIds,
    allowedPurposeIds: ["customer_success.account.read"],
    outcome: buildCustomerSuccessOutcomeReceipt({
      status: "in_progress",
      summary: "",
      artifactReceipts: [],
      nextAction: definition.defaultNextAction,
      recordedByActorId: access.actorBinding.canonicalActorId,
      recordedAt,
    }),
  });
  const saved = await saveCustomerSuccessWorkflowStart({
    authority: mutationAuthority(caller, access, "customer.success.workflow.start"),
    run,
  });
  return completeAppServiceCall(authorized, {
    context: publicWorkflowContext(access),
    definition,
    run: saved,
    project: await requireProject(caller, project.id),
  });
}

export async function recordCustomerSuccessWorkflowOutcomeService(
  caller: AppServiceCaller,
  input: z.input<typeof customerSuccessWorkflowOutcomeServiceInputSchema>,
) {
  const value = redactSensitive(
    customerSuccessWorkflowOutcomeServiceInputSchema.parse(input),
  ) as z.output<typeof customerSuccessWorkflowOutcomeServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.customer_accounts.workflows.outcome.record"),
  );
  const access = await workflowAccess(caller, value.workspaceId, "write");
  requireWorkflowWrite(access);
  const authority = mutationAuthority(caller, access, "customer.success.workflow.outcome");
  const replay = await findCustomerSuccessWorkflowOutcomeReplay({
    authority, accountId: value.accountId, runId: value.runId, expectedRevision: value.expectedRevision,
    status: value.status, summary: value.summary, artifactReceipts: value.artifactReceipts, nextAction: value.nextAction,
  });
  if (replay) {
    // The immutable acceptance precedes fresh artifact validation and timestamp
    // creation. Legacy callers still receive their established display shape.
    const definition = getCustomerSuccessWorkflowDefinition(replay.workflowId);
    if (definition.definitionSha256 !== replay.definitionSha256) {
      throw new CustomerSuccessWorkflowConflictError("The exact workflow definition is unavailable in this release.");
    }
    const project = await requireProject(caller, replay.projectId);
    return completeAppServiceCall(authorized, { context: publicWorkflowContext(access), definition, run: replay, project });
  }
  const current = await getCustomerSuccessWorkflowRun(
    readAuthority(caller, access),
    value.runId,
  );
  if (!current || current.accountId !== value.accountId) {
    throw new CustomerSuccessWorkflowConflictError("Customer-success workflow run was not found.");
  }
  const project = await requireProject(caller, current.projectId);
  assertArtifactReceipts(project.artifacts, value.artifactReceipts);
  const outcome = buildCustomerSuccessOutcomeReceipt({
    status: value.status,
    summary: value.summary,
    artifactReceipts: value.artifactReceipts,
    nextAction: value.nextAction,
    recordedByActorId: access.actorBinding.canonicalActorId,
    recordedAt: new Date().toISOString(),
  });
  const definition = getCustomerSuccessWorkflowDefinition(current.workflowId);
  if (definition.definitionSha256 !== current.definitionSha256) {
    throw new CustomerSuccessWorkflowConflictError(
      "The exact workflow definition is unavailable in this release.",
    );
  }
  validateCompletedWorkflowArtifacts({ definition, outcome });
  const run = await saveCustomerSuccessWorkflowOutcome({
    authority,
    runId: current.runId,
    expectedRevision: value.expectedRevision,
    outcome,
  });
  return completeAppServiceCall(authorized, {
    context: publicWorkflowContext(access),
    definition,
    run,
    project,
  });
}

async function workflowAccess(
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
    auditPurpose: `${mode === "write" ? "Manage" : "Read"} customer-success workflows.`,
  });
}

function requireWorkflowWrite(access: RequestSharedMemoryAccessV1) {
  if (
    !access.authority.canWrite ||
    access.authority.initiatingActorId !== access.actorBinding.canonicalActorId
  ) throw new CustomerAccountWriteDeniedError();
}

function readAuthority(caller: AppServiceCaller, access: RequestSharedMemoryAccessV1) {
  return {
    tenantId: caller.context.tenantId,
    workspaceId: access.authority.workspaceId,
    canonicalActorId: access.actorBinding.canonicalActorId,
    readableActorIds: access.actorBinding.readableOwnerActorIds,
    purposeId: "customer_success.account.read" as const,
  };
}

function mutationAuthority(
  caller: AppServiceCaller,
  access: RequestSharedMemoryAccessV1,
  purpose: "customer.success.workflow.start" | "customer.success.workflow.outcome",
) {
  const source = caller.executionScope!;
  const canonicalActorId = access.actorBinding.canonicalActorId;
  return {
    ...readAuthority(caller, access),
    purposeId: "customer_success.account.manage" as const,
    idempotencyKey: caller.idempotencyKey!,
    executionScope: createExecutionScope({
      tenantId: caller.context.tenantId,
      initiatingActorId: canonicalActorId,
      executingPrincipalType: source.executingPrincipalType,
      executingPrincipalId: source.executingPrincipalType === "user"
        ? canonicalActorId
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

function projectMutationScope(
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

async function requireProject(caller: AppServiceCaller, projectId: string) {
  const project = (await showProjectService(caller, {
    projectId,
    taskLimit: 100,
    artifactLimit: 100,
  })).data.project;
  if (!project) throw new CustomerSuccessWorkflowConflictError("Workflow project is unavailable.");
  return project;
}

function assertStartReplay(
  replay: NonNullable<Awaited<ReturnType<typeof getCustomerSuccessWorkflowRun>>>,
  value: z.output<typeof customerSuccessWorkflowStartServiceInputSchema>,
) {
  if (
    replay.accountId !== value.accountId ||
    replay.accountRevision !== value.expectedAccountRevision ||
    replay.accountSha256 !== value.expectedAccountSha256 ||
    replay.workflowId !== value.input.workflowId ||
    replay.inputSha256 !== canonicalJsonSha256(value.input)
  ) {
    throw new CustomerSuccessWorkflowConflictError(
      "Idempotency-Key is already bound to a different customer-success workflow start.",
    );
  }
}

function assertArtifactReceipts(
  artifacts: readonly { id: string; evidenceRefs: string[] }[],
  receipts: readonly z.infer<typeof artifactReceiptDraftSchema>[],
) {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  if (new Set(receipts.map((receipt) => receipt.artifactKey)).size !== receipts.length) {
    throw new CustomerSuccessWorkflowConflictError("Artifact receipt keys must be unique.");
  }
  for (const receipt of receipts) {
    const artifact = byId.get(receipt.projectArtifactId);
    if (!artifact) {
      throw new CustomerSuccessWorkflowConflictError(
        `Project artifact ${receipt.projectArtifactId} is unavailable.`,
      );
    }
    if (receipt.evidenceRefs.some((reference) => !artifact.evidenceRefs.includes(reference))) {
      throw new CustomerSuccessWorkflowConflictError(
        `Artifact ${receipt.projectArtifactId} does not contain every claimed evidence reference.`,
      );
    }
  }
}

function publicWorkflowContext(access: RequestSharedMemoryAccessV1) {
  return Object.freeze({
    scope: "workspace" as const,
    workspaceId: access.authority.workspaceId,
    accessLevel: access.authority.accessLevel,
    canWrite: access.authority.canWrite,
    authoritySha256: access.authority.authoritySha256,
  });
}
