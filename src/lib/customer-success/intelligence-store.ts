import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import {
  customerAccountRevisionSchema,
  customerFactRevisionSchema,
  projectCustomerAccount360,
  type CustomerAccountRevision,
} from "@/lib/customer-success/contracts";
import { customerHealthScoreSchema } from "@/lib/customer-success/health-contracts";
import type { CustomerSuccessIntelligenceSources } from "@/lib/customer-success/intelligence";
import { customerSuccessWorkflowRunRevisionSchema } from "@/lib/customer-success/workflow-contracts";
import type { CustomerAccountReadAuthority } from "@/lib/customer-success/store";
import { parseMeetingRevision } from "@/lib/meetings/contracts";

type ProjectionSourceSet = Omit<
  CustomerSuccessIntelligenceSources,
  "approvals" | "generatedAt" | "timelineLimit"
>;

export async function loadCustomerSuccessPortfolioSourceSets(
  authority: CustomerAccountReadAuthority,
  input: { limit?: number } = {},
): Promise<readonly ProjectionSourceSet[]> {
  requireDatabase();
  await ensureDatabaseSchema();
  assertAuthority(authority);
  const limit = Math.max(1, Math.min(200, input.limit || 100));
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const accountRows = await getSql()`
        SELECT account_snapshot
        FROM omni_customer_accounts
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
        ORDER BY
          CASE lifecycle
            WHEN 'at_risk' THEN 0
            WHEN 'onboarding' THEN 1
            WHEN 'active' THEN 2
            WHEN 'prospect' THEN 3
            ELSE 4
          END,
          revised_at DESC,
          account_id COLLATE "C"
        LIMIT ${limit}
      `;
      const accounts = accountRows.map((row) =>
        customerAccountRevisionSchema.parse(row.account_snapshot)
      );
      if (!accounts.length) return [];
      const accountIds = accounts.map((account) => account.accountId);
      const entityIds = [...new Set(accounts.flatMap((account) => [
        account.accountId,
        account.accountEntityId,
        ...(account.organizationEntityId ? [account.organizationEntityId] : []),
      ]))];
      const [factRows, historyRows, healthRows, workflowRows, meetingRows] = await Promise.all([
        getSql()`
          SELECT DISTINCT ON (account_id, fact_id) account_id, fact_snapshot
          FROM omni_customer_fact_revisions
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND account_id = ANY(${accountIds}::TEXT[])
            AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
          ORDER BY account_id COLLATE "C", fact_id COLLATE "C", revision DESC
        `,
        getSql()`
          SELECT account_id, sum(history_count)::INTEGER AS history_count
          FROM (
            SELECT account_id, count(*) AS history_count
            FROM omni_customer_account_revisions
            WHERE tenant_id = ${authority.tenantId}
              AND workspace_id = ${authority.workspaceId}
              AND account_id = ANY(${accountIds}::TEXT[])
            GROUP BY account_id
            UNION ALL
            SELECT account_id, count(*) AS history_count
            FROM omni_customer_fact_revisions
            WHERE tenant_id = ${authority.tenantId}
              AND workspace_id = ${authority.workspaceId}
              AND account_id = ANY(${accountIds}::TEXT[])
            GROUP BY account_id
          ) history
          GROUP BY account_id
        `,
        getSql()`
          SELECT account_id, score_snapshot
          FROM omni_customer_health_scores
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND account_id = ANY(${accountIds}::TEXT[])
            AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
        `,
        getSql()`
          SELECT account_id, run_snapshot
          FROM omni_customer_success_workflow_runs
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND account_id = ANY(${accountIds}::TEXT[])
            AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
          ORDER BY updated_at DESC, run_id COLLATE "C"
          LIMIT 2000
        `,
        getSql()`
          SELECT meeting_snapshot
          FROM omni_meetings
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                COALESCE(meeting_snapshot -> 'entityLinks', '[]'::JSONB)
              ) AS link
              WHERE link ->> 'entityId' = ANY(${entityIds}::TEXT[])
            )
          ORDER BY scheduled_start_at DESC, meeting_id COLLATE "C"
          LIMIT 1000
        `,
      ]);
      const facts = groupRows(factRows, "account_id", "fact_snapshot", (value) =>
        customerFactRevisionSchema.parse(value)
      );
      const health = new Map(healthRows.map((row) => [
        String(row.account_id),
        customerHealthScoreSchema.parse(row.score_snapshot),
      ]));
      const workflows = groupRows(workflowRows, "account_id", "run_snapshot", (value) =>
        customerSuccessWorkflowRunRevisionSchema.parse(value)
      );
      const history = new Map(historyRows.map((row) => [
        String(row.account_id),
        Number(row.history_count || 0),
      ]));
      const meetings = meetingRows.map((row) => requireMeeting(row.meeting_snapshot));
      const evaluatedAt = new Date().toISOString();
      return accounts.map((account) => {
        const accountFacts = facts.get(account.accountId) || [];
        const accountHealth = health.get(account.accountId) || null;
        const accountWorkflows = workflows.get(account.accountId) || [];
        return {
          account360: projectCustomerAccount360({
            account,
            currentFacts: accountFacts,
            historyCount: history.get(account.accountId) || 0,
            evaluatedAt,
          }),
          health: accountHealth,
          accountHistory: [account],
          factHistory: accountFacts,
          healthHistory: accountHealth ? [accountHealth] : [],
          workflowRuns: accountWorkflows,
          workflowHistory: accountWorkflows,
          meetings: meetings.filter((meeting) => accountOwnsMeeting(account, meeting)),
        };
      });
    },
  );
}

export async function loadCustomerSuccessAccountSourceSet(
  authority: CustomerAccountReadAuthority,
  accountId: string,
  input: { historyLimit?: number } = {},
): Promise<ProjectionSourceSet | undefined> {
  requireDatabase();
  await ensureDatabaseSchema();
  assertAuthority(authority);
  const historyLimit = Math.max(1, Math.min(250, input.historyLimit || 100));
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const accountRows = await getSql()`
        SELECT account_snapshot
        FROM omni_customer_accounts
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${accountId}
          AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
        LIMIT 1
      `;
      if (!accountRows[0]) return undefined;
      const account = customerAccountRevisionSchema.parse(accountRows[0].account_snapshot);
      const entityIds = [
        account.accountId,
        account.accountEntityId,
        ...(account.organizationEntityId ? [account.organizationEntityId] : []),
      ];
      const [currentFactRows, accountHistoryRows, factHistoryRows, healthRows, workflowRows, workflowHistoryRows, meetingRows] = await Promise.all([
        getSql()`
          SELECT DISTINCT ON (fact_id) fact_snapshot
          FROM omni_customer_fact_revisions
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND account_id = ${accountId}
            AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
          ORDER BY fact_id COLLATE "C", revision DESC
        `,
        getSql()`
          SELECT account_snapshot
          FROM omni_customer_account_revisions
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND account_id = ${accountId}
            AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
          ORDER BY revision DESC
          LIMIT ${historyLimit}
        `,
        getSql()`
          SELECT fact_snapshot
          FROM omni_customer_fact_revisions
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND account_id = ${accountId}
            AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
          ORDER BY recorded_at DESC, fact_id COLLATE "C", revision DESC
          LIMIT ${historyLimit}
        `,
        getSql()`
          SELECT score_snapshot
          FROM omni_customer_health_score_revisions
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND account_id = ${accountId}
            AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
          ORDER BY revision DESC
          LIMIT ${historyLimit}
        `,
        getSql()`
          SELECT run_snapshot
          FROM omni_customer_success_workflow_runs
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND account_id = ${accountId}
            AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
          ORDER BY updated_at DESC, run_id COLLATE "C"
          LIMIT 100
        `,
        getSql()`
          SELECT run_snapshot
          FROM omni_customer_success_workflow_run_revisions
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND account_id = ${accountId}
            AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
          ORDER BY recorded_at DESC, run_id COLLATE "C", revision DESC
          LIMIT ${historyLimit}
        `,
        getSql()`
          SELECT meeting_snapshot
          FROM omni_meetings
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                COALESCE(meeting_snapshot -> 'entityLinks', '[]'::JSONB)
              ) AS link
              WHERE link ->> 'entityId' = ANY(${entityIds}::TEXT[])
            )
          ORDER BY scheduled_start_at DESC, meeting_id COLLATE "C"
          LIMIT 250
        `,
      ]);
      const currentFacts = currentFactRows.map((row) =>
        customerFactRevisionSchema.parse(row.fact_snapshot)
      );
      const accountHistory = accountHistoryRows.map((row) =>
        customerAccountRevisionSchema.parse(row.account_snapshot)
      );
      const factHistory = factHistoryRows.map((row) =>
        customerFactRevisionSchema.parse(row.fact_snapshot)
      );
      const healthHistory = healthRows.map((row) =>
        customerHealthScoreSchema.parse(row.score_snapshot)
      );
      const workflowRuns = workflowRows.map((row) =>
        customerSuccessWorkflowRunRevisionSchema.parse(row.run_snapshot)
      );
      const workflowHistory = workflowHistoryRows.map((row) =>
        customerSuccessWorkflowRunRevisionSchema.parse(row.run_snapshot)
      );
      return {
        account360: projectCustomerAccount360({
          account,
          currentFacts,
          historyCount: accountHistory.length + factHistory.length,
        }),
        health: healthHistory[0] || null,
        accountHistory,
        factHistory,
        healthHistory,
        workflowRuns,
        workflowHistory,
        meetings: meetingRows.map((row) => requireMeeting(row.meeting_snapshot)),
      };
    },
  );
}

function groupRows<T>(
  rows: readonly Record<string, unknown>[],
  key: string,
  value: string,
  parse: (input: unknown) => T,
) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = String(row[key]);
    groups.set(id, [...(groups.get(id) || []), parse(row[value])]);
  }
  return groups;
}

function accountOwnsMeeting(
  account: CustomerAccountRevision,
  meeting: NonNullable<ReturnType<typeof parseMeetingRevision>>,
) {
  const entityIds = new Set([
    account.accountId,
    account.accountEntityId,
    ...(account.organizationEntityId ? [account.organizationEntityId] : []),
  ]);
  return meeting.entityLinks.some((link) => entityIds.has(link.entityId));
}

function requireMeeting(value: unknown) {
  const meeting = parseMeetingRevision(value);
  if (!meeting) throw new Error("Stored customer meeting projection is invalid.");
  return meeting;
}

function assertAuthority(authority: CustomerAccountReadAuthority) {
  if (
    !authority.tenantId || !authority.workspaceId || !authority.canonicalActorId ||
    !authority.readableActorIds.length || authority.purposeId !== "customer_success.account.read"
  ) {
    throw new Error("Customer-success intelligence read authority is invalid.");
  }
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new Error("Customer-success intelligence requires the canonical database authority.");
  }
}
