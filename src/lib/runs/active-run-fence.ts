import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import type { RunLedger, RunStatus } from "@/lib/runs/types";
import { readJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

type SqlClient = ReturnType<typeof getSql>;

const RUN_STATUSES: ReadonlySet<string> = new Set<RunStatus>([
  "queued",
  "running",
  "waiting_clarification",
  "waiting_approval",
  "resuming",
  "completed",
  "failed",
  "canceled",
]);

export type TerminalAgentRunStatus = Extract<RunStatus, "completed" | "failed" | "canceled">;

export function isTerminalAgentRunStatus(
  status: RunStatus | undefined,
): status is TerminalAgentRunStatus {
  return status === "completed" || status === "failed" || status === "canceled";
}

/**
 * Raised when a tool effect is about to be recorded for an agent run that was
 * canceled, finished, or deleted. Nothing has been claimed or executed.
 */
export class AgentRunNotActiveError extends Error {
  readonly code = "agent_run_not_active";

  constructor(
    readonly runId: string,
    readonly runStatus: RunStatus | "missing",
  ) {
    super(
      runStatus === "missing"
        ? `Agent run ${runId} no longer exists, so the action was not started.`
        : `Agent run ${runId} is ${runStatus}, so the action was not started.`,
    );
    this.name = "AgentRunNotActiveError";
  }
}

/**
 * Reads a run's status in its tenant. Pass the caller's transaction to hold a
 * share lock on the run until that transaction ends, so a concurrent cancel
 * waits for it and the status cannot change underneath a claim.
 */
export async function readAgentRunStatus(input: {
  runId: string;
  tenantId?: string;
  sql?: SqlClient;
}): Promise<RunStatus | undefined> {
  const tenantId = normalizeRunTenantId(input.tenantId);
  if (hasDatabaseUrl()) {
    if (input.sql) {
      const rows = await input.sql`
        SELECT status
        FROM omni_agent_runs
        WHERE id = ${input.runId} AND tenant_id = ${tenantId}
        LIMIT 1
        FOR SHARE
      `;
      return parseRunStatus(rows[0]?.status);
    }
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT status
      FROM omni_agent_runs
      WHERE id = ${input.runId} AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    return parseRunStatus(rows[0]?.status);
  }

  const ledger = await readJsonFile<RunLedger>(getDataPath("runs.json"), {
    runs: [],
    events: [],
  });
  const run = ledger.runs.find(
    (item) => item.id === input.runId && normalizeRunTenantId(item.tenantId) === tenantId,
  );
  return parseRunStatus(run?.status);
}

/**
 * Refuses a tool effect for a run that is no longer active. In database mode
 * this must run inside the transaction that records the effect, before the
 * write, and it also refuses a run that does not exist. The file ledger trims
 * old runs, so file mode refuses only a run it knows is finished.
 */
export async function assertAgentRunAcceptsToolEffect(input: {
  runId: string;
  tenantId?: string;
  sql?: SqlClient;
}) {
  if (hasDatabaseUrl() && !input.sql) {
    throw new Error("The active-run check must run inside the claiming transaction.");
  }
  const status = await readAgentRunStatus(input);
  if (status === undefined) {
    if (hasDatabaseUrl()) {
      throw new AgentRunNotActiveError(input.runId, "missing");
    }
    return;
  }
  if (isTerminalAgentRunStatus(status)) {
    throw new AgentRunNotActiveError(input.runId, status);
  }
}

function parseRunStatus(value: unknown): RunStatus | undefined {
  return typeof value === "string" && RUN_STATUSES.has(value) ? (value as RunStatus) : undefined;
}

// Matches the tenant normalization of the run store.
function normalizeRunTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}
