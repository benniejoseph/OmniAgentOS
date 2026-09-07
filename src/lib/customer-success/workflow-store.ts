import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import {
  buildCustomerSuccessWorkflowRunRevision,
  customerSuccessWorkflowRunRevisionSchema,
  CUSTOMER_SUCCESS_WORKFLOW_EVENT_TYPES,
  getCustomerSuccessWorkflowDefinition,
  type CustomerSuccessOutcomeReceipt,
  type CustomerSuccessWorkflowRunRevision,
} from "@/lib/customer-success/workflow-contracts";
import type {
  CustomerAccountMutationAuthority,
  CustomerAccountReadAuthority,
} from "@/lib/customer-success/store";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

type WorkflowSql = ReturnType<typeof getSql>;

export class CustomerSuccessWorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerSuccessWorkflowConflictError";
  }
}

export class CustomerSuccessWorkflowNotFoundError extends Error {
  constructor() {
    super("Customer-success workflow run was not found in this workspace.");
    this.name = "CustomerSuccessWorkflowNotFoundError";
  }
}

export async function listCustomerSuccessWorkflowRuns(
  authority: CustomerAccountReadAuthority,
  input: { accountId: string; limit?: number },
) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  const limit = Math.max(1, Math.min(100, input.limit || 50));
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT run_snapshot
        FROM omni_customer_success_workflow_runs
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${input.accountId}
          AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
        ORDER BY updated_at DESC, run_id COLLATE "C"
        LIMIT ${limit}
      `;
      return Object.freeze(rows.map((row) => parseRun(row.run_snapshot)));
    },
  );
}

export async function getCustomerSuccessWorkflowRun(
  authority: CustomerAccountReadAuthority,
  runId: string,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT run_snapshot
        FROM omni_customer_success_workflow_runs
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND run_id = ${runId}
          AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
        LIMIT 1
      `;
      return rows[0] ? parseRun(rows[0].run_snapshot) : undefined;
    },
  );
}

export async function saveCustomerSuccessWorkflowStart(input: {
  authority: CustomerAccountMutationAuthority;
  run: CustomerSuccessWorkflowRunRevision;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const authority = assertMutationAuthority(input.authority, "customer.success.workflow.start");
  const run = customerSuccessWorkflowRunRevisionSchema.parse(input.run);
  if (
    run.revision !== 1 || run.outcome.status !== "in_progress" ||
    run.tenantId !== authority.tenantId || run.workspaceId !== authority.workspaceId ||
    run.ownerActorId !== authority.canonicalActorId
  ) {
    throw new CustomerSuccessWorkflowConflictError("Workflow start snapshot is invalid for this authority.");
  }
  const requestSha256 = canonicalJsonSha256({
    accountId: run.accountId,
    accountRevisionId: run.accountRevisionId,
    accountSha256: run.accountSha256,
    workflowId: run.workflowId,
    definitionSha256: run.definitionSha256,
    inputSha256: run.inputSha256,
    projectId: run.projectId,
    projectTaskIds: run.projectTaskIds,
  });
  const idempotencySha256 = idempotencyKeySha256({
    tenantId: authority.tenantId,
    idempotencyKey: authority.idempotencyKey,
  });

  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    () => getSql().transaction(async (sql: WorkflowSql) => {
      await lockRun(sql, authority, run.runId);
      const replayRows = await sql`
        SELECT run_snapshot, start_request_sha256
        FROM omni_customer_success_workflow_runs
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND run_id = ${run.runId}
        LIMIT 1
      `;
      if (replayRows[0]) {
        if (String(replayRows[0].start_request_sha256) !== requestSha256) {
          throw new CustomerSuccessWorkflowConflictError(
            "Idempotency-Key is already bound to a different customer-success workflow start.",
          );
        }
        return parseRun(replayRows[0].run_snapshot);
      }
      const accountRows = await sql`
        SELECT current_revision, current_revision_id, account_sha256, owner_actor_id
        FROM omni_customer_accounts
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${run.accountId}
        FOR UPDATE
      `;
      const account = accountRows[0];
      if (!account) throw new CustomerSuccessWorkflowNotFoundError();
      if (
        Number(account.current_revision) !== run.accountRevision ||
        String(account.current_revision_id) !== run.accountRevisionId ||
        String(account.account_sha256) !== run.accountSha256
      ) {
        throw new CustomerSuccessWorkflowConflictError(
          "Account 360 changed before the workflow could start. Refresh and try again.",
        );
      }
      if (String(account.owner_actor_id) !== authority.canonicalActorId) {
        throw new CustomerSuccessWorkflowConflictError(
          "Only the current Account 360 owner can start this workflow.",
        );
      }
      await sql`
        INSERT INTO omni_customer_success_workflow_run_revisions (
          tenant_id, workspace_id, account_id, run_id, run_revision_id,
          revision, owner_actor_id, workflow_id, definition_sha256,
          input_sha256, project_id, outcome_status, outcome_receipt_sha256,
          run_sha256, run_snapshot, allowed_purpose_ids,
          mutation_idempotency_sha256, mutation_request_sha256, recorded_at
        ) VALUES (
          ${run.tenantId}, ${run.workspaceId}, ${run.accountId}, ${run.runId},
          ${run.runRevisionId}, ${run.revision}, ${run.ownerActorId},
          ${run.workflowId}, ${run.definitionSha256}, ${run.inputSha256},
          ${run.projectId}, ${run.outcome.status}, ${run.outcome.receiptSha256},
          ${run.runSha256}, ${run}::JSONB, ${run.allowedPurposeIds},
          ${idempotencySha256}, ${requestSha256}, ${run.outcome.recordedAt}
        )
      `;
      await sql`
        INSERT INTO omni_customer_success_workflow_runs (
          tenant_id, workspace_id, account_id, run_id, current_revision_id,
          current_revision, owner_actor_id, workflow_id, definition_sha256,
          input_sha256, project_id, outcome_status, outcome_receipt_sha256,
          run_sha256, run_snapshot, allowed_purpose_ids,
          start_request_sha256, created_at, updated_at
        ) VALUES (
          ${run.tenantId}, ${run.workspaceId}, ${run.accountId}, ${run.runId},
          ${run.runRevisionId}, ${run.revision}, ${run.ownerActorId},
          ${run.workflowId}, ${run.definitionSha256}, ${run.inputSha256},
          ${run.projectId}, ${run.outcome.status}, ${run.outcome.receiptSha256},
          ${run.runSha256}, ${run}::JSONB, ${run.allowedPurposeIds},
          ${requestSha256}, ${run.outcome.recordedAt}, ${run.outcome.recordedAt}
        )
      `;
      await appendScopedDomainEvent({
        id: `customer-success-workflow-started:${run.runSha256}`,
        streamId: run.accountId,
        type: CUSTOMER_SUCCESS_WORKFLOW_EVENT_TYPES.started,
        executionScope: authority.executionScope,
        payload: {
          schemaVersion: 1,
          accountId: run.accountId,
          accountRevisionId: run.accountRevisionId,
          runId: run.runId,
          runRevisionId: run.runRevisionId,
          workflowId: run.workflowId,
          definitionSha256: run.definitionSha256,
          inputSha256: run.inputSha256,
          projectId: run.projectId,
          projectTaskCount: run.projectTaskIds.length,
          outcomeStatus: run.outcome.status,
          outcomeReceiptSha256: run.outcome.receiptSha256,
          runSha256: run.runSha256,
        },
      }, { sql });
      return run;
    }) as Promise<CustomerSuccessWorkflowRunRevision>,
  );
}

export async function saveCustomerSuccessWorkflowOutcome(input: {
  authority: CustomerAccountMutationAuthority;
  runId: string;
  expectedRevision: number;
  outcome: CustomerSuccessOutcomeReceipt;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const authority = assertMutationAuthority(input.authority, "customer.success.workflow.outcome");
  const idempotencySha256 = idempotencyKeySha256({
    tenantId: authority.tenantId,
    idempotencyKey: authority.idempotencyKey,
  });
  const requestSha256 = canonicalJsonSha256({
    runId: input.runId,
    expectedRevision: input.expectedRevision,
    outcome: input.outcome,
  });
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    () => getSql().transaction(async (sql: WorkflowSql) => {
      await lockRun(sql, authority, input.runId);
      const replayRows = await sql`
        SELECT run_snapshot, mutation_request_sha256
        FROM omni_customer_success_workflow_run_revisions
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND owner_actor_id = ${authority.canonicalActorId}
          AND mutation_idempotency_sha256 = ${idempotencySha256}
        LIMIT 1
      `;
      if (replayRows[0]) {
        if (String(replayRows[0].mutation_request_sha256) !== requestSha256) {
          throw new CustomerSuccessWorkflowConflictError(
            "Idempotency-Key is already bound to a different workflow outcome.",
          );
        }
        return parseRun(replayRows[0].run_snapshot);
      }
      const currentRows = await sql`
        SELECT run_snapshot
        FROM omni_customer_success_workflow_runs
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND run_id = ${input.runId}
        FOR UPDATE
      `;
      if (!currentRows[0]) throw new CustomerSuccessWorkflowNotFoundError();
      const current = parseRun(currentRows[0].run_snapshot);
      if (current.ownerActorId !== authority.canonicalActorId) {
        throw new CustomerSuccessWorkflowConflictError(
          "Only the Account 360 owner can record this workflow outcome.",
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new CustomerSuccessWorkflowConflictError(
          "Workflow outcome changed. Refresh and try again.",
        );
      }
      if (["completed", "cancelled"].includes(current.outcome.status)) {
        throw new CustomerSuccessWorkflowConflictError(
          "A completed or cancelled workflow outcome is immutable.",
        );
      }
      const {
        schemaVersion: _schemaVersion,
        contractVersion: _contractVersion,
        runRevisionId: _runRevisionId,
        previousRunRevisionId: _previousRunRevisionId,
        inputSha256: _inputSha256,
        runSha256: _runSha256,
        ...currentBody
      } = current;
      void [_schemaVersion, _contractVersion, _runRevisionId, _previousRunRevisionId, _inputSha256, _runSha256];
      const next = buildCustomerSuccessWorkflowRunRevision({
        ...currentBody,
        revision: current.revision + 1,
        outcome: input.outcome,
      });
      const definition = getCustomerSuccessWorkflowDefinition(next.workflowId);
      if (definition.definitionSha256 !== next.definitionSha256) {
        throw new CustomerSuccessWorkflowConflictError(
          "The pinned workflow definition is unavailable in this release.",
        );
      }
      await sql`
        INSERT INTO omni_customer_success_workflow_run_revisions (
          tenant_id, workspace_id, account_id, run_id, run_revision_id,
          revision, owner_actor_id, workflow_id, definition_sha256,
          input_sha256, project_id, outcome_status, outcome_receipt_sha256,
          run_sha256, run_snapshot, allowed_purpose_ids,
          mutation_idempotency_sha256, mutation_request_sha256, recorded_at
        ) VALUES (
          ${next.tenantId}, ${next.workspaceId}, ${next.accountId}, ${next.runId},
          ${next.runRevisionId}, ${next.revision}, ${next.ownerActorId},
          ${next.workflowId}, ${next.definitionSha256}, ${next.inputSha256},
          ${next.projectId}, ${next.outcome.status}, ${next.outcome.receiptSha256},
          ${next.runSha256}, ${next}::JSONB, ${next.allowedPurposeIds},
          ${idempotencySha256}, ${requestSha256}, ${next.outcome.recordedAt}
        )
      `;
      const updated = await sql`
        UPDATE omni_customer_success_workflow_runs
        SET current_revision_id = ${next.runRevisionId},
            current_revision = ${next.revision},
            outcome_status = ${next.outcome.status},
            outcome_receipt_sha256 = ${next.outcome.receiptSha256},
            run_sha256 = ${next.runSha256},
            run_snapshot = ${next}::JSONB,
            updated_at = ${next.outcome.recordedAt}
        WHERE tenant_id = ${next.tenantId}
          AND workspace_id = ${next.workspaceId}
          AND run_id = ${next.runId}
          AND current_revision = ${current.revision}
        RETURNING run_id
      `;
      if (!updated[0]) throw new CustomerSuccessWorkflowConflictError("Workflow outcome update did not converge.");
      await appendScopedDomainEvent({
        id: `customer-success-workflow-outcome:${next.runSha256}`,
        streamId: next.accountId,
        type: CUSTOMER_SUCCESS_WORKFLOW_EVENT_TYPES.outcomeRecorded,
        executionScope: authority.executionScope,
        payload: {
          schemaVersion: 1,
          accountId: next.accountId,
          runId: next.runId,
          runRevisionId: next.runRevisionId,
          workflowId: next.workflowId,
          projectId: next.projectId,
          outcomeStatus: next.outcome.status,
          artifactReceiptCount: next.outcome.artifactReceipts.length,
          outcomeReceiptSha256: next.outcome.receiptSha256,
          runSha256: next.runSha256,
        },
      }, { sql });
      return next;
    }) as Promise<CustomerSuccessWorkflowRunRevision>,
  );
}

function parseRun(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return Object.freeze(customerSuccessWorkflowRunRevisionSchema.parse(parsed));
}

function lockRun(
  sql: WorkflowSql,
  authority: CustomerAccountMutationAuthority,
  runId: string,
) {
  return sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      ${`${authority.tenantId}:${authority.workspaceId}:${runId}`}, 0
    ))
  `;
}

function assertReadAuthority(authority: CustomerAccountReadAuthority) {
  if (
    authority.purposeId !== "customer_success.account.read" ||
    !authority.tenantId || !authority.workspaceId.startsWith("workspace:") ||
    !authority.readableActorIds.includes(authority.canonicalActorId)
  ) throw new CustomerSuccessWorkflowConflictError("Workflow read authority is invalid.");
}

function assertMutationAuthority(
  authority: CustomerAccountMutationAuthority,
  purpose: "customer.success.workflow.start" | "customer.success.workflow.outcome",
) {
  if (authority.purposeId !== "customer_success.account.manage" || !authority.idempotencyKey.trim()) {
    throw new CustomerSuccessWorkflowConflictError("Workflow mutation authority is invalid.");
  }
  const scope = parsePersistedExecutionScope(authority.executionScope);
  if (
    !scope || scope.tenantId !== authority.tenantId ||
    scope.workspaceId !== authority.workspaceId ||
    scope.initiatingActorId !== authority.canonicalActorId ||
    scope.projectId !== null || scope.missionId !== null ||
    scope.purpose !== purpose ||
    !authority.readableActorIds.includes(authority.canonicalActorId)
  ) throw new CustomerSuccessWorkflowConflictError("Workflow execution scope is invalid.");
  return { ...authority, executionScope: scope };
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new Error("Customer-success workflows require the canonical database.");
  }
}
