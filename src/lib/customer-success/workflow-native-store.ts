import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";
import { customerAccountRevisionSchema, type CustomerAccountRevision } from "@/lib/customer-success/contracts";
import type { CustomerAccountMutationAuthority, CustomerAccountReadAuthority } from "@/lib/customer-success/store";
import {
  buildCustomerSuccessOutcomeReceipt, buildCustomerSuccessWorkflowRunRevision, customerSuccessProjectTaskIdempotencyKey,
  customerSuccessWorkflowRunRevisionSchema, getCustomerSuccessWorkflowDefinition, validateCompletedWorkflowArtifacts,
} from "@/lib/customer-success/workflow-contracts";
import {
  CUSTOMER_SUCCESS_WORKFLOW_NATIVE_REVISION_MAX, buildCustomerSuccessWorkflowNativeAcceptance,
  buildCustomerSuccessWorkflowNativeIntent, customerSuccessWorkflowNativeAccountIdSchema,
  customerSuccessWorkflowNativeCurrentAccountSchema, customerSuccessWorkflowNativeIntentSchema,
  customerSuccessWorkflowNativeRunIdSchema, type CustomerSuccessWorkflowNativeAcceptance,
  type CustomerSuccessWorkflowNativeCurrentAccount,
  type CustomerSuccessWorkflowNativeIntent, type CustomerSuccessWorkflowNativeOutcomeRequest,
  type CustomerSuccessWorkflowNativeStartRequest,
} from "@/lib/customer-success/workflow-mutation-contracts";
import {
  CustomerSuccessWorkflowConflictError, CustomerSuccessWorkflowNotFoundError,
  saveCustomerSuccessWorkflowOutcome, saveCustomerSuccessWorkflowStart,
} from "@/lib/customer-success/workflow-store";
import { projectIdForIdempotencyKey, projectTaskIdForIdempotencyKey } from "@/lib/projects/events";
import { createProject, createProjectTasks } from "@/lib/projects/store";
import { redactSensitive } from "@/lib/security/context";
import { deriveExecutionScope, parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type Sql = ReturnType<typeof getSql>;
type Authority = CustomerAccountReadAuthority | CustomerAccountMutationAuthority;
type Row = Record<string, unknown>;
type MutationResult = { currentAccount: CustomerSuccessWorkflowNativeCurrentAccount; acceptance: CustomerSuccessWorkflowNativeAcceptance; replayed: boolean };

function assertAuthority(authority: Authority, accountId: string, operation?: "start" | "outcome", runId?: string) {
  customerSuccessWorkflowNativeAccountIdSchema.parse(accountId);
  if (!/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(authority.canonicalActorId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(authority.tenantId) || authority.workspaceId.length > 240 ||
    !/^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(authority.workspaceId) ||
    authority.readableActorIds.length !== 1 || authority.readableActorIds[0] !== authority.canonicalActorId ||
    authority.purposeId !== (operation ? "customer_success.account.manage" : "customer_success.account.read")) {
    throw new CustomerSuccessWorkflowConflictError("Current canonical Account workflow authority is required.");
  }
  if (operation) {
    const scope = parsePersistedExecutionScope((authority as CustomerAccountMutationAuthority).executionScope);
    if (!scope || scope.tenantId !== authority.tenantId || scope.workspaceId !== authority.workspaceId ||
      scope.initiatingActorId !== authority.canonicalActorId || scope.executingPrincipalType !== "user" ||
      scope.executingPrincipalId !== authority.canonicalActorId || scope.projectId !== null || scope.missionId !== null ||
      scope.delegationId !== null || scope.contextGrantIds.length || scope.capabilityGrantIds.length ||
      scope.purpose !== `customer.success.workflow.${operation}` || scope.causationId !== (operation === "start" ? accountId : runId)) {
      throw new CustomerSuccessWorkflowConflictError("Direct user workflow authority must name the exact Account or run.");
    }
  }
}

async function ready() {
  if (!hasDatabaseUrl()) throw new CustomerSuccessWorkflowConflictError("Native Account workflows require durable database storage.");
  await ensureDatabaseSchema();
}

function currentAccount(account: CustomerAccountRevision, acceptance: CustomerSuccessWorkflowNativeAcceptance | null = null) {
  const current = customerSuccessWorkflowNativeCurrentAccountSchema.parse({ accountId: account.accountId,
    revisionId: account.revisionId, revision: account.revision, accountSha256: account.accountSha256 });
  if (acceptance && (current.revision < acceptance.reviewedAccountRevision ||
    (current.revision === acceptance.reviewedAccountRevision && current.accountSha256 !== acceptance.reviewedAccountSha256))) {
    throw new CustomerSuccessWorkflowConflictError("Current Account lineage precedes this accepted workflow request.");
  }
  return current;
}

function accountFromRow(row: Row, authority: Authority, accountId: string) {
  const account = customerAccountRevisionSchema.parse(row.account_snapshot);
  if (account.tenantId !== authority.tenantId || account.workspaceId !== authority.workspaceId ||
    account.accountId !== accountId || account.ownerActorId !== authority.canonicalActorId) throw new CustomerSuccessWorkflowNotFoundError();
  return account;
}

function acceptanceFromRow(row: Row, authority: Authority, accountId: string, runId: string) {
  if (row.native_intent == null && row.native_intent_sha256 == null) return null;
  const intent = customerSuccessWorkflowNativeIntentSchema.parse(row.native_intent);
  const digest = canonicalJsonSha256(intent);
  if (row.native_intent_sha256 !== digest || row.mutation_request_sha256 !== digest ||
    row.mutation_idempotency_sha256 !== intent.idempotencyKeySha256 || row.revision_owner_actor_id !== authority.canonicalActorId ||
    intent.tenantId !== authority.tenantId || intent.workspaceId !== authority.workspaceId || intent.accountId !== accountId ||
    intent.runId !== runId || intent.canonicalActorId !== authority.canonicalActorId) {
    throw new CustomerSuccessWorkflowConflictError("The immutable workflow revision does not bind this exact native owner and request.");
  }
  return buildCustomerSuccessWorkflowNativeAcceptance(intent, customerSuccessWorkflowRunRevisionSchema.parse(row.run_snapshot));
}

/** One statement binds the current authorized Account to a possibly absent
 * immutable key. Mutation lookup deliberately detects keys used by another run
 * or Account; exact recovery restricts both and reports no invented receipt.
 */
async function anchoredAcceptance(sql: Sql, authority: Authority, input: {
  accountId: string; runId: string; keySha256: string; mutation: boolean;
}) {
  const rows = await sql`SELECT account.account_snapshot,revision.run_snapshot,revision.native_intent,revision.native_intent_sha256,
    revision.mutation_idempotency_sha256,revision.mutation_request_sha256,revision.owner_actor_id AS revision_owner_actor_id
    FROM omni_customer_accounts account
    JOIN omni_tenant_workspaces workspace ON workspace.tenant_id=account.tenant_id AND workspace.workspace_id=account.workspace_id AND workspace.state='active'
    JOIN omni_tenant_workspace_memberships membership ON membership.tenant_id=workspace.tenant_id AND membership.workspace_id=workspace.workspace_id
      AND membership.subject_kind='user' AND membership.subject_actor_id=${authority.canonicalActorId} AND membership.state='active'
      AND (membership.access_level IN ('contributor','manager') OR (${input.mutation}=FALSE AND membership.access_level='reader'))
    LEFT JOIN omni_customer_success_workflow_run_revisions revision ON revision.tenant_id=account.tenant_id AND revision.workspace_id=account.workspace_id
      AND revision.owner_actor_id=${authority.canonicalActorId} AND revision.mutation_idempotency_sha256=${input.keySha256}
      AND (${input.mutation}=TRUE OR (revision.account_id=account.account_id AND revision.run_id=${input.runId}))
      AND revision.allowed_purpose_ids @> ARRAY['customer_success.account.read']::TEXT[]
    WHERE account.tenant_id=${authority.tenantId} AND account.workspace_id=${authority.workspaceId} AND account.account_id=${input.accountId}
      AND account.owner_actor_id=${authority.canonicalActorId} AND account.allowed_purpose_ids @> ARRAY['customer_success.account.read']::TEXT[]
      AND (${input.mutation}=FALSE OR account.allowed_purpose_ids @> ARRAY['customer_success.account.manage']::TEXT[]) LIMIT 2`;
  if (rows.length !== 1) return null;
  return { row: rows[0], account: accountFromRow(rows[0], authority, input.accountId) };
}

export async function readCustomerSuccessWorkflowNativeAcceptance(authority: CustomerAccountReadAuthority, input: {
  accountId: string; runId: string; keySha256: string;
}) {
  assertAuthority(authority, input.accountId); customerSuccessWorkflowNativeRunIdSchema.parse(input.runId);
  if (!/^[a-f0-9]{64}$/.test(input.keySha256)) throw new CustomerSuccessWorkflowConflictError("Exact workflow acceptance key is invalid.");
  await ready();
  return runWithDatabaseActorScope(authority.tenantId, [authority.canonicalActorId], async () => {
    const value = await anchoredAcceptance(getSql(), authority, { ...input, mutation: false });
    if (!value) return null;
    const acceptance = value.row.run_snapshot ? acceptanceFromRow(value.row, authority, input.accountId, input.runId) : null;
    return { currentAccount: currentAccount(value.account, acceptance), acceptance };
  });
}

export async function getCustomerSuccessWorkflowNativeRun(authority: CustomerAccountReadAuthority, input: { accountId: string; runId: string }) {
  assertAuthority(authority, input.accountId); customerSuccessWorkflowNativeRunIdSchema.parse(input.runId); await ready();
  return runWithDatabaseActorScope(authority.tenantId, [authority.canonicalActorId], async () => {
    const rows = await getSql()`SELECT account.account_snapshot,run.run_snapshot
      FROM omni_customer_accounts account
      JOIN omni_tenant_workspaces workspace ON workspace.tenant_id=account.tenant_id AND workspace.workspace_id=account.workspace_id AND workspace.state='active'
      JOIN omni_tenant_workspace_memberships membership ON membership.tenant_id=workspace.tenant_id AND membership.workspace_id=workspace.workspace_id
        AND membership.subject_kind='user' AND membership.subject_actor_id=${authority.canonicalActorId}
        AND membership.state='active' AND membership.access_level IN ('reader','contributor','manager')
      JOIN omni_customer_success_workflow_runs run ON run.tenant_id=account.tenant_id AND run.workspace_id=account.workspace_id
        AND run.account_id=account.account_id AND run.run_id=${input.runId} AND run.owner_actor_id=${authority.canonicalActorId}
        AND run.allowed_purpose_ids @> ARRAY['customer_success.account.read']::TEXT[]
      WHERE account.tenant_id=${authority.tenantId} AND account.workspace_id=${authority.workspaceId} AND account.account_id=${input.accountId}
        AND account.owner_actor_id=${authority.canonicalActorId} AND account.allowed_purpose_ids @> ARRAY['customer_success.account.read']::TEXT[] LIMIT 2`;
    if (rows.length !== 1) return null;
    const account = accountFromRow(rows[0], authority, input.accountId), run = customerSuccessWorkflowRunRevisionSchema.parse(rows[0].run_snapshot);
    if (run.accountId !== account.accountId || run.ownerActorId !== authority.canonicalActorId || run.tenantId !== authority.tenantId ||
      run.workspaceId !== authority.workspaceId || run.runId !== input.runId || run.accountRevision > account.revision ||
      (run.accountRevision === account.revision && run.accountSha256 !== account.accountSha256)) {
      throw new CustomerSuccessWorkflowConflictError("Current run and Account lineage are inconsistent.");
    }
    return { currentAccount: currentAccount(account), run };
  });
}

async function mutation(input: {
  authority: CustomerAccountMutationAuthority; accountId: string;
  request: CustomerSuccessWorkflowNativeStartRequest | CustomerSuccessWorkflowNativeOutcomeRequest;
}): Promise<MutationResult> {
  const { authority, accountId } = input;
  const intent = buildCustomerSuccessWorkflowNativeIntent({ ...authority, accountId, request: input.request });
  assertAuthority(authority, accountId, intent.operation, intent.runId); await ready();
  return runWithDatabaseActorScope(authority.tenantId, [authority.canonicalActorId], () => getSql().transaction(async (sql: Sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-workflow-key:${authority.tenantId}:${authority.workspaceId}:${authority.canonicalActorId}:${intent.idempotencyKeySha256}`},0))`;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${authority.tenantId}:${authority.workspaceId}:${intent.runId}`},0))`;
    const accounts = await sql`SELECT account_id FROM omni_customer_accounts
      WHERE tenant_id=${authority.tenantId} AND workspace_id=${authority.workspaceId} AND account_id=${accountId}
        AND owner_actor_id=${authority.canonicalActorId}
        AND allowed_purpose_ids @> ARRAY['customer_success.account.read','customer_success.account.manage']::TEXT[] FOR UPDATE`;
    if (accounts.length !== 1) throw new CustomerSuccessWorkflowNotFoundError();
    const anchored = await anchoredAcceptance(sql, authority, { accountId, runId: intent.runId, keySha256: intent.idempotencyKeySha256, mutation: true });
    if (!anchored) throw new CustomerSuccessWorkflowNotFoundError();
    if (anchored.row.run_snapshot) {
      const acceptance = acceptanceFromRow(anchored.row, authority, accountId, intent.runId);
      if (!acceptance || acceptance.requestSha256 !== canonicalJsonSha256(intent)) {
        throw new CustomerSuccessWorkflowConflictError("This key has no matching exact native workflow acceptance.");
      }
      return { currentAccount: currentAccount(anchored.account, acceptance), acceptance, replayed: true };
    }
    const account = anchored.account;
    if (account.revision !== intent.request.expectedAccountRevision || account.accountSha256 !== intent.request.expectedAccountSha256) {
      throw new CustomerSuccessWorkflowConflictError("The reviewed Account changed before workflow admission.");
    }
    // Normalized requests are frozen by the client. Never accept their digest
    // and then silently act on a redacted or otherwise different payload.
    if (canonicalJsonSha256(redactSensitive(intent.request)) !== canonicalJsonSha256(intent.request)) {
      throw new CustomerSuccessWorkflowConflictError("This workflow request would change during redaction. Review the exact safe content first.");
    }
    return runWithManagedDatabaseTransaction(sql, async () => {
      const joined = getSql();
      const run = intent.operation === "start"
        ? await startInTransaction(joined, authority, account, intent)
        : await outcomeInTransaction(joined, authority, account, intent);
      const accepted = await anchoredAcceptance(joined, authority, { accountId, runId: intent.runId, keySha256: intent.idempotencyKeySha256, mutation: true });
      if (!accepted || accepted.account.revision !== account.revision || accepted.account.accountSha256 !== account.accountSha256) {
        throw new CustomerSuccessWorkflowConflictError("Current Account or workspace authority changed before commit.");
      }
      const acceptance = acceptanceFromRow(accepted.row, authority, accountId, intent.runId);
      if (!acceptance || acceptance.runSha256 !== run.runSha256 || acceptance.requestSha256 !== canonicalJsonSha256(intent)) {
        throw new Error("Atomic workflow admission did not persist its exact acceptance.");
      }
      return { currentAccount: currentAccount(accepted.account, acceptance), acceptance, replayed: false };
    });
  }) as Promise<MutationResult>);
}

export function submitCustomerSuccessWorkflowNativeStart(input: {
  authority: CustomerAccountMutationAuthority; accountId: string; request: CustomerSuccessWorkflowNativeStartRequest;
}) { return mutation(input); }
export function submitCustomerSuccessWorkflowNativeOutcome(input: {
  authority: CustomerAccountMutationAuthority; accountId: string; request: CustomerSuccessWorkflowNativeOutcomeRequest;
}) { return mutation(input); }

async function startInTransaction(sql: Sql, authority: CustomerAccountMutationAuthority, account: CustomerAccountRevision,
  intent: Extract<CustomerSuccessWorkflowNativeIntent, { operation: "start" }>) {
  const definition = getCustomerSuccessWorkflowDefinition(intent.request.input.workflowId);
  if (definition.definitionSha256 !== intent.request.expectedDefinitionSha256) throw new CustomerSuccessWorkflowConflictError("The reviewed workflow definition changed.");
  const projectKey = `csm-project:${canonicalJsonSha256({ runId: intent.runId })}`;
  const projectId = projectIdForIdempotencyKey(authority.tenantId, projectKey);
  const existing = await sql`SELECT run_id FROM omni_customer_success_workflow_runs
    WHERE tenant_id=${authority.tenantId} AND workspace_id=${authority.workspaceId} AND run_id=${intent.runId}`;
  if (existing[0]) throw new CustomerSuccessWorkflowConflictError("Existing setup cannot be adopted without its native acceptance.");
  const project = await createProject({ tenantId: authority.tenantId, actorId: authority.canonicalActorId,
    title: `${account.name} · ${definition.name}`.slice(0, 180), objective: intent.request.input.objective,
    status: definition.projectTemplate.status, ...(intent.request.input.targetDate ? { targetDate: intent.request.input.targetDate } : {}),
    requireNew: true, mutation: { idempotencyKey: projectKey,
      executionScope: deriveExecutionScope(authority.executionScope, { purpose: "customer.success.workflow.project" }) } });
  if (project.id !== projectId || project.autonomyMode !== "manual" || project.executionStatus !== "idle" || project.tasksDispatched !== 0 || !project.requireApproval) {
    throw new Error("Workflow setup must create the exact idle governed project.");
  }
  const taskIds = new Map(definition.projectTemplate.tasks.map((task) => [task.key, projectTaskIdForIdempotencyKey(
    authority.tenantId, project.id, customerSuccessProjectTaskIdempotencyKey(intent.runId, task.key))]));
  const projectTaskIds: { taskKey: string; projectTaskId: string }[] = [];
  for (const task of definition.projectTemplate.tasks) {
    const [created] = await createProjectTasks(project.id, [{ title: task.title, detail: `${task.detail}\nCSM run: ${intent.runId}`.slice(0, 1_000),
      priority: task.priority, agentId: task.agentId, origin: "manual", dependsOn: task.dependsOnKeys.map((key) => taskIds.get(key)!) }], {
      tenantId: authority.tenantId, actorId: authority.canonicalActorId, requireNew: true,
      mutation: { idempotencyKey: customerSuccessProjectTaskIdempotencyKey(intent.runId, task.key),
        executionScope: deriveExecutionScope(authority.executionScope, { purpose: "customer.success.workflow.task", projectId: project.id }) },
    });
    if (!created || created.id !== taskIds.get(task.key) || created.status !== "open" || created.dispatchAttempt !== 0) {
      throw new Error("Workflow setup must create each exact open task without dispatch.");
    }
    projectTaskIds.push({ taskKey: task.key, projectTaskId: created.id });
  }
  const recordedAt = new Date().toISOString();
  const run = buildCustomerSuccessWorkflowRunRevision({ tenantId: authority.tenantId, workspaceId: authority.workspaceId,
    accountId: account.accountId, accountRevisionId: account.revisionId, accountRevision: account.revision, accountSha256: account.accountSha256,
    runId: intent.runId, revision: 1, workflowId: definition.workflowId, definitionSha256: definition.definitionSha256,
    input: intent.request.input, owner: account.accountOwner, ownerActorId: authority.canonicalActorId,
    projectId: project.id, projectTaskIds, allowedPurposeIds: ["customer_success.account.read"],
    outcome: buildCustomerSuccessOutcomeReceipt({ status: "in_progress", summary: "", artifactReceipts: [],
      nextAction: definition.defaultNextAction, recordedByActorId: authority.canonicalActorId, recordedAt }),
  });
  return saveCustomerSuccessWorkflowStart({ authority, run, nativeIntent: intent });
}

async function outcomeInTransaction(sql: Sql, authority: CustomerAccountMutationAuthority, account: CustomerAccountRevision,
  intent: Extract<CustomerSuccessWorkflowNativeIntent, { operation: "outcome" }>) {
  const rows = await sql`SELECT run_snapshot FROM omni_customer_success_workflow_runs
    WHERE tenant_id=${authority.tenantId} AND workspace_id=${authority.workspaceId} AND account_id=${account.accountId}
      AND owner_actor_id=${authority.canonicalActorId} AND run_id=${intent.runId} FOR UPDATE`;
  if (rows.length !== 1) throw new CustomerSuccessWorkflowNotFoundError();
  const run = customerSuccessWorkflowRunRevisionSchema.parse(rows[0].run_snapshot), request = intent.request;
  if (run.revision !== request.expectedRunRevision || run.runSha256 !== request.expectedRunSha256 ||
    run.definitionSha256 !== request.expectedDefinitionSha256 || run.revision >= CUSTOMER_SUCCESS_WORKFLOW_NATIVE_REVISION_MAX ||
    run.accountRevision > account.revision || (run.accountRevision === account.revision && run.accountSha256 !== account.accountSha256) ||
    ["completed", "cancelled"].includes(run.outcome.status)) {
    throw new CustomerSuccessWorkflowConflictError("The reviewed workflow run changed or cannot accept another outcome.");
  }
  const definition = getCustomerSuccessWorkflowDefinition(run.workflowId);
  if (definition.definitionSha256 !== run.definitionSha256) throw new CustomerSuccessWorkflowConflictError("The pinned workflow definition is unavailable.");
  const projects = await sql`SELECT id FROM omni_projects WHERE tenant_id=${authority.tenantId} AND actor_id=${authority.canonicalActorId} AND id=${run.projectId} FOR SHARE`;
  if (projects.length !== 1) throw new CustomerSuccessWorkflowConflictError("The exact owned workflow project is unavailable.");
  const ids = [...new Set(request.artifactReceipts.map((receipt) => receipt.projectArtifactId))].sort();
  const artifacts = ids.length ? await sql`SELECT id,evidence_refs FROM omni_project_artifacts
    WHERE tenant_id=${authority.tenantId} AND project_id=${run.projectId} AND id=ANY(${ids}::TEXT[]) ORDER BY id COLLATE "C" FOR SHARE` : [];
  const byId = new Map(artifacts.map((row) => [String(row.id), row]));
  for (const receipt of request.artifactReceipts) {
    const artifact = byId.get(receipt.projectArtifactId);
    const evidenceRefs = artifact?.evidence_refs;
    if (!Array.isArray(evidenceRefs) || receipt.evidenceRefs.some((reference) => !evidenceRefs.includes(reference))) {
      throw new CustomerSuccessWorkflowConflictError("A claimed workflow artifact or evidence reference is not currently available in this project.");
    }
  }
  // The head requires strictly increasing time, including requests within the
  // same millisecond. Timestamp creation occurs only after stable-key replay.
  const recordedAt = new Date(Math.max(Date.now(), Date.parse(run.outcome.recordedAt) + 1)).toISOString();
  const outcome = buildCustomerSuccessOutcomeReceipt({ status: request.status, summary: request.summary,
    artifactReceipts: request.artifactReceipts, nextAction: request.nextAction, recordedByActorId: authority.canonicalActorId, recordedAt });
  validateCompletedWorkflowArtifacts({ definition, outcome });
  return saveCustomerSuccessWorkflowOutcome({ authority, runId: run.runId, expectedRevision: run.revision, outcome, nativeIntent: intent });
}
