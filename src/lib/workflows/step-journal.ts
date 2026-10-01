import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { WorkflowPlanNodeExecutionRecord } from "@/lib/workflows/types";

/**
 * Deterministic step journal for plan nodes, kept on the append-only event
 * log. Each node attempt is journaled as `started`, then as `settled` with
 * its outcome or `interrupted` with a reason, in the same transaction as the
 * node row. Folding a run's journal by sequence tells a later pass which
 * attempt a node is on, which attempt a lost process left open, and whether a
 * row it would reuse is the outcome the journal recorded.
 *
 * A pass is fenced by the attempt of the run step that executes the plan: it
 * settles only the attempt it started, and it starts nothing in a plan that a
 * newer pass has journaled. Plans and nodes are journaled by digest, so a
 * model-chosen node id is never stored, redacted or truncated as an event key.
 */

export const WORKFLOW_JOURNAL_SCHEMA_VERSION = 1 as const;

export const WORKFLOW_JOURNAL_EVENT_TYPES = Object.freeze({
  started: "workflow.journal.node_started",
  settled: "workflow.journal.node_settled",
  interrupted: "workflow.journal.node_interrupted",
} as const);

export const WORKFLOW_JOURNAL_MAX_ATTEMPTS = 1_000;

/** A run's journal is read whole; a longer journal fails closed. */
export const WORKFLOW_JOURNAL_READ_LIMIT = 5_000;

const SETTLED_STATUSES = [
  "completed",
  "failed",
  "blocked",
  "skipped",
  "waiting_approval",
] as const;

const INTERRUPT_REASONS = [
  "aborted",
  "effect_receipt_pending",
  "process_lost",
] as const;

export type WorkflowJournalSettledStatus = (typeof SETTLED_STATUSES)[number];
export type WorkflowJournalInterruptReason = (typeof INTERRUPT_REASONS)[number];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const entryBase = {
  schemaVersion: z.literal(WORKFLOW_JOURNAL_SCHEMA_VERSION),
  workflowRunId: z.string().min(1).max(240),
  planSha256: sha256Schema,
  nodeSha256: sha256Schema,
  attempt: z.number().int().min(1).max(WORKFLOW_JOURNAL_MAX_ATTEMPTS),
  pass: z.number().int().min(0).nullable(),
};

const workflowJournalEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    ...entryBase,
    kind: z.literal("started"),
    inputSha256: sha256Schema,
  }).strict(),
  z.object({
    ...entryBase,
    kind: z.literal("settled"),
    status: z.enum(SETTLED_STATUSES),
    outputSha256: sha256Schema,
    errorSha256: sha256Schema.nullable(),
  }).strict(),
  z.object({
    ...entryBase,
    kind: z.literal("interrupted"),
    reason: z.enum(INTERRUPT_REASONS),
  }).strict(),
]);

export type WorkflowJournalEntry = z.infer<typeof workflowJournalEntrySchema>;

export type WorkflowJournalAttempt = {
  attempt: number;
  /** The pass that started the attempt, or null when no start survives. */
  pass: number | null;
  state: "open" | "settled" | "interrupted";
  status?: WorkflowJournalSettledStatus;
  outputSha256?: string;
  errorSha256?: string | null;
  reason?: WorkflowJournalInterruptReason;
};

export type WorkflowNodeJournal = {
  planSha256: string;
  nodeSha256: string;
  attempts: WorkflowJournalAttempt[];
};

export type WorkflowJournal = {
  workflowRunId: string;
  /** Keyed by node digest. */
  nodes: ReadonlyMap<string, WorkflowNodeJournal>;
  /** The newest pass that journaled anything in each plan, by plan digest. */
  latestPassByPlan: ReadonlyMap<string, number>;
  /** Entries the fold ignored because they contradict the journal. */
  anomalies: readonly string[];
};

export type WorkflowJournalEvent = {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
};

export type WorkflowJournalNodeRef = {
  workflowRunId: string;
  planId: string;
  nodeId: string;
};

export type WorkflowJournalTransition =
  | { kind: "start"; inputSha256: string }
  | {
      kind: "skip";
      inputSha256: string;
      outputSha256: string;
      errorSha256: string | null;
    }
  | {
      kind: "settle";
      attempt: number;
      status: WorkflowJournalSettledStatus;
      outputSha256: string;
      errorSha256: string | null;
    }
  | {
      kind: "interrupt";
      attempt: number;
      reason: Exclude<WorkflowJournalInterruptReason, "process_lost">;
    };

export type WorkflowJournalReuseVerdict =
  | { reusable: true }
  | { reusable: false; reason: string };

/** A pass tried to journal work that a newer pass or attempt owns. */
export class WorkflowJournalFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowJournalFenceError";
  }
}

/** A row a pass would reuse is not the outcome the journal recorded. */
export class WorkflowJournalDivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowJournalDivergenceError";
  }
}

export function workflowJournalStreamId(workflowRunId: string) {
  return `workflow-journal:${workflowRunId}`;
}

export function workflowJournalEntryId(entry: WorkflowJournalEntry) {
  return `workflow-journal:${canonicalJsonSha256({
    workflowRunId: entry.workflowRunId,
    nodeSha256: entry.nodeSha256,
    attempt: entry.attempt,
    kind: entry.kind,
  })}`;
}

export function workflowJournalNodeDigests(ref: Pick<WorkflowJournalNodeRef, "planId" | "nodeId">) {
  return {
    planSha256: canonicalJsonSha256({ planId: ref.planId }),
    nodeSha256: canonicalJsonSha256({ planId: ref.planId, nodeId: ref.nodeId }),
  };
}

export function workflowJournalEventType(entry: WorkflowJournalEntry) {
  return WORKFLOW_JOURNAL_EVENT_TYPES[entry.kind];
}

/** The digest of a node row's output as a reader of the row sees it. */
export function workflowJournalOutputSha256(
  record: Pick<WorkflowPlanNodeExecutionRecord, "output">,
) {
  return canonicalJsonSha256(record.output ?? null);
}

export function workflowJournalErrorSha256(
  record: Pick<WorkflowPlanNodeExecutionRecord, "error">,
) {
  return record.error ? canonicalJsonSha256({ error: record.error }) : null;
}

export function isWorkflowJournalSettledStatus(
  status: string,
): status is WorkflowJournalSettledStatus {
  return (SETTLED_STATUSES as readonly string[]).includes(status);
}

/** Replays a run's journal in sequence order. */
export function foldWorkflowJournal(
  workflowRunId: string,
  events: readonly WorkflowJournalEvent[],
): WorkflowJournal {
  const nodes = new Map<string, WorkflowNodeJournal>();
  const latestPassByPlan = new Map<string, number>();
  const anomalies: string[] = [];

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const entry = parseWorkflowJournalEntry(event);
    if (!entry || entry.workflowRunId !== workflowRunId) {
      anomalies.push(`seq ${event.seq}: not a journal entry of this run`);
      continue;
    }
    const node = nodes.get(entry.nodeSha256) ||
      { planSha256: entry.planSha256, nodeSha256: entry.nodeSha256, attempts: [] };
    if (node.planSha256 !== entry.planSha256) {
      anomalies.push(`seq ${event.seq}: a node entry names another plan`);
      continue;
    }
    nodes.set(entry.nodeSha256, node);
    const latest = node.attempts.at(-1);

    if (entry.kind === "started") {
      if (latest && entry.attempt <= latest.attempt) {
        anomalies.push(
          `seq ${event.seq}: attempt ${entry.attempt} starts after attempt ${latest.attempt}`,
        );
        continue;
      }
      node.attempts.push({
        attempt: entry.attempt,
        pass: entry.pass,
        state: "open",
      });
    } else {
      // Retention prunes the oldest entries first, so an attempt's end can
      // outlive its start. Such an attempt is ended with an unknown pass.
      let attempt = node.attempts.find((item) => item.attempt === entry.attempt);
      if (!attempt) {
        if (latest && entry.attempt < latest.attempt) {
          anomalies.push(
            `seq ${event.seq}: attempt ${entry.attempt} ends after attempt ${latest.attempt}`,
          );
          continue;
        }
        attempt = { attempt: entry.attempt, pass: null, state: "open" };
        node.attempts.push(attempt);
      }
      if (attempt.state !== "open") {
        anomalies.push(
          `seq ${event.seq}: attempt ${entry.attempt} is already ${attempt.state}`,
        );
        continue;
      }
      if (entry.kind === "settled") {
        attempt.state = "settled";
        attempt.status = entry.status;
        attempt.outputSha256 = entry.outputSha256;
        attempt.errorSha256 = entry.errorSha256;
      } else {
        attempt.state = "interrupted";
        attempt.reason = entry.reason;
      }
    }
    if (entry.pass !== null) {
      latestPassByPlan.set(
        entry.planSha256,
        Math.max(latestPassByPlan.get(entry.planSha256) ?? 0, entry.pass),
      );
    }
  }

  return { workflowRunId, nodes, latestPassByPlan, anomalies };
}

/**
 * Plans the entries one node transition appends. It throws a fence error
 * when the pass no longer owns the node, so the caller's transaction, and the
 * node row it would write, roll back.
 */
export function planWorkflowJournalTransition(
  journal: WorkflowJournal,
  ref: WorkflowJournalNodeRef,
  transition: WorkflowJournalTransition,
  pass?: number,
): { attempt: number; entries: WorkflowJournalEntry[] } {
  if (ref.workflowRunId !== journal.workflowRunId) {
    throw new Error("Workflow journal transition targets another run.");
  }
  const digests = workflowJournalNodeDigests(ref);
  const newestPass = journal.latestPassByPlan.get(digests.planSha256);
  if (pass !== undefined && newestPass !== undefined && newestPass > pass) {
    throw new WorkflowJournalFenceError(
      `Workflow pass ${pass} is stale: pass ${newestPass} has journaled plan ${ref.planId}.`,
    );
  }
  const base = {
    schemaVersion: WORKFLOW_JOURNAL_SCHEMA_VERSION,
    workflowRunId: ref.workflowRunId,
    ...digests,
    pass: pass ?? null,
  };
  const latest = journal.nodes.get(digests.nodeSha256)?.attempts.at(-1);

  if (transition.kind === "start" || transition.kind === "skip") {
    const entries: WorkflowJournalEntry[] = [];
    if (latest?.state === "open") {
      if (pass !== undefined && latest.pass !== null && latest.pass >= pass) {
        throw new WorkflowJournalFenceError(
          `Attempt ${latest.attempt} of node ${ref.nodeId} is still open in pass ${latest.pass}.`,
        );
      }
      entries.push({
        ...base,
        kind: "interrupted",
        attempt: latest.attempt,
        reason: "process_lost",
      });
    }
    const attempt = (latest?.attempt ?? 0) + 1;
    if (attempt > WORKFLOW_JOURNAL_MAX_ATTEMPTS) {
      throw new Error(`Node ${ref.nodeId} has exhausted its journaled attempts.`);
    }
    entries.push({
      ...base,
      kind: "started",
      attempt,
      inputSha256: transition.inputSha256,
    });
    if (transition.kind === "skip") {
      entries.push({
        ...base,
        kind: "settled",
        attempt,
        status: "skipped",
        outputSha256: transition.outputSha256,
        errorSha256: transition.errorSha256,
      });
    }
    return { attempt, entries: entries.map(validEntry) };
  }

  if (
    !latest ||
    latest.attempt !== transition.attempt ||
    latest.state !== "open" ||
    latest.pass !== (pass ?? null)
  ) {
    throw new WorkflowJournalFenceError(
      `Attempt ${transition.attempt} of node ${ref.nodeId} is not the open attempt of this pass.`,
    );
  }
  const entry: WorkflowJournalEntry = transition.kind === "settle"
    ? {
        ...base,
        kind: "settled",
        attempt: transition.attempt,
        status: transition.status,
        outputSha256: transition.outputSha256,
        errorSha256: transition.errorSha256,
      }
    : {
        ...base,
        kind: "interrupted",
        attempt: transition.attempt,
        reason: transition.reason,
      };
  return { attempt: transition.attempt, entries: [validEntry(entry)] };
}

/**
 * Whether a pass may reuse a settled node row. A node the journal never saw
 * keeps the row; a journaled node is reused only when its latest attempt
 * settled with the row's status, output and error.
 */
export function verifyWorkflowJournalReuse(
  journal: WorkflowJournal,
  record: WorkflowPlanNodeExecutionRecord,
): WorkflowJournalReuseVerdict {
  const latest = journal.nodes
    .get(workflowJournalNodeDigests(record).nodeSha256)
    ?.attempts.at(-1);
  if (!latest) {
    return { reusable: true };
  }
  if (latest.state !== "settled") {
    return {
      reusable: false,
      reason: `attempt ${latest.attempt} is ${latest.state}, but the row is ${record.status}`,
    };
  }
  if (latest.status !== record.status) {
    return {
      reusable: false,
      reason: `attempt ${latest.attempt} settled ${latest.status}, but the row is ${record.status}`,
    };
  }
  if (latest.outputSha256 !== workflowJournalOutputSha256(record)) {
    return {
      reusable: false,
      reason: `the row's output is not the output attempt ${latest.attempt} settled with`,
    };
  }
  if (latest.errorSha256 !== workflowJournalErrorSha256(record)) {
    return {
      reusable: false,
      reason: `the row's error is not the error attempt ${latest.attempt} settled with`,
    };
  }
  return { reusable: true };
}

function parseWorkflowJournalEntry(event: WorkflowJournalEvent) {
  const { _executionScope: _scope, ...payload } = event.payload || {};
  void _scope;
  const parsed = workflowJournalEntrySchema.safeParse(payload);
  if (!parsed.success || WORKFLOW_JOURNAL_EVENT_TYPES[parsed.data.kind] !== event.type) {
    return undefined;
  }
  return parsed.data;
}

function validEntry(entry: WorkflowJournalEntry) {
  return workflowJournalEntrySchema.parse(entry);
}
