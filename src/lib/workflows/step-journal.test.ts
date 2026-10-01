import { describe, expect, it } from "vitest";

import {
  foldWorkflowJournal,
  planWorkflowJournalTransition,
  verifyWorkflowJournalReuse,
  WorkflowJournalFenceError,
  workflowJournalEntryId,
  workflowJournalEventType,
  workflowJournalNodeDigests,
  workflowJournalOutputSha256,
  type WorkflowJournal,
  type WorkflowJournalEntry,
  type WorkflowJournalEvent,
  type WorkflowJournalTransition,
} from "@/lib/workflows/step-journal";
import type { WorkflowPlanNodeExecutionRecord } from "@/lib/workflows/types";

const RUN = "workflow-journal-run";
const NODE = { workflowRunId: RUN, planId: "plan-1", nodeId: "draft" };
const INPUT = "a".repeat(64);
const START: WorkflowJournalTransition = { kind: "start", inputSha256: INPUT };

/** Applies transitions the way the executor does: fold, plan, append. */
function journalOf(
  steps: Array<{
    ref?: typeof NODE;
    transition: WorkflowJournalTransition;
    pass?: number;
  }>,
) {
  const events: WorkflowJournalEvent[] = [];
  let journal = foldWorkflowJournal(RUN, events);
  for (const step of steps) {
    const planned = planWorkflowJournalTransition(
      journal,
      step.ref || NODE,
      step.transition,
      step.pass,
    );
    events.push(...planned.entries.map((entry) => eventOf(events.length + 1, entry)));
    journal = foldWorkflowJournal(RUN, events);
  }
  return { journal, events };
}

function eventOf(seq: number, entry: WorkflowJournalEntry): WorkflowJournalEvent {
  return { seq, type: workflowJournalEventType(entry), payload: { ...entry } };
}

function settle(attempt: number, output: unknown = { ok: true }): WorkflowJournalTransition {
  return {
    kind: "settle",
    attempt,
    status: "completed",
    outputSha256: workflowJournalOutputSha256({ output: output as never }),
    errorSha256: null,
  };
}

function attempts(journal: WorkflowJournal, ref = NODE) {
  return journal.nodes.get(workflowJournalNodeDigests(ref).nodeSha256)?.attempts;
}

function row(
  overrides: Partial<WorkflowPlanNodeExecutionRecord> = {},
): WorkflowPlanNodeExecutionRecord {
  return {
    id: "row-1",
    tenantId: "tenant-1",
    workflowRunId: RUN,
    planId: NODE.planId,
    nodeId: NODE.nodeId,
    nodeLabel: "Draft",
    nodeKind: "research",
    status: "completed",
    policy: "auto",
    riskLevel: 0,
    approvalRequired: false,
    toolExecutionIds: [],
    input: {},
    output: { ok: true },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  } as WorkflowPlanNodeExecutionRecord;
}

describe("workflow step journal", () => {
  it("journals an attempt from start to settlement under its pass", () => {
    const { journal, events } = journalOf([
      { transition: START, pass: 2 },
      { transition: settle(1), pass: 2 },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "workflow.journal.node_started",
      "workflow.journal.node_settled",
    ]);
    expect(attempts(journal)).toEqual([{
      attempt: 1,
      pass: 2,
      state: "settled",
      status: "completed",
      outputSha256: workflowJournalOutputSha256({ output: { ok: true } as never }),
      errorSha256: null,
    }]);
    expect(journal.latestPassByPlan.get(workflowJournalNodeDigests(NODE).planSha256))
      .toBe(2);
    expect(journal.anomalies).toEqual([]);
  });

  it("keys entries by digest and never stores a model-chosen id", () => {
    const { events } = journalOf([{ transition: START, pass: 1 }]);
    const other = workflowJournalNodeDigests({ planId: "plan-2", nodeId: NODE.nodeId });

    expect(JSON.stringify(events)).not.toContain(NODE.nodeId);
    expect(JSON.stringify(events)).not.toContain(NODE.planId);
    expect(other.nodeSha256).not.toBe(workflowJournalNodeDigests(NODE).nodeSha256);
    expect(workflowJournalEntryId(events[0].payload as WorkflowJournalEntry))
      .toMatch(/^workflow-journal:[a-f0-9]{64}$/);
  });

  it("interrupts an attempt a lost pass left open before a newer pass starts", () => {
    const { journal, events } = journalOf([
      { transition: START, pass: 1 },
      { transition: START, pass: 2 },
    ]);

    expect(events.map((event) => event.payload.kind)).toEqual([
      "started",
      "interrupted",
      "started",
    ]);
    expect(attempts(journal)).toEqual([
      { attempt: 1, pass: 1, state: "interrupted", reason: "process_lost" },
      { attempt: 2, pass: 2, state: "open" },
    ]);
  });

  it("fences a stale pass out of a plan a newer pass has journaled", () => {
    const sibling = { ...NODE, nodeId: "review" };
    const { journal } = journalOf([{ ref: sibling, transition: START, pass: 3 }]);

    expect(() => planWorkflowJournalTransition(journal, NODE, START, 2))
      .toThrow(WorkflowJournalFenceError);
    expect(() => planWorkflowJournalTransition(journal, NODE, START, 3)).not.toThrow();
  });

  it("refuses a transition planned against another run's journal", () => {
    expect(() =>
      planWorkflowJournalTransition(foldWorkflowJournal("another-run", []), NODE, START, 1)
    ).toThrow("Workflow journal transition targets another run.");
  });

  it("refuses to restart an attempt its own pass still holds open", () => {
    const { journal } = journalOf([{ transition: START, pass: 2 }]);

    expect(() => planWorkflowJournalTransition(journal, NODE, START, 2))
      .toThrow(/still open in pass 2/);
  });

  it("settles only the open attempt of the pass that started it", () => {
    const { journal } = journalOf([
      { transition: START, pass: 1 },
      { transition: START, pass: 2 },
    ]);

    expect(() => planWorkflowJournalTransition(journal, NODE, settle(1), 2))
      .toThrow(WorkflowJournalFenceError);
    expect(() => planWorkflowJournalTransition(journal, NODE, settle(2), undefined))
      .toThrow(WorkflowJournalFenceError);
    expect(planWorkflowJournalTransition(journal, NODE, settle(2), 2).attempt).toBe(2);

    const { journal: settled } = journalOf([
      { transition: START, pass: 2 },
      { transition: settle(1), pass: 2 },
    ]);
    expect(() => planWorkflowJournalTransition(settled, NODE, settle(1), 2))
      .toThrow(WorkflowJournalFenceError);
  });

  it("journals a skipped node as a settled attempt", () => {
    const { journal } = journalOf([{
      transition: {
        kind: "skip",
        inputSha256: INPUT,
        outputSha256: workflowJournalOutputSha256({ output: { skipped: true } as never }),
        errorSha256: null,
      },
      pass: 1,
    }]);

    expect(attempts(journal)).toEqual([expect.objectContaining({
      attempt: 1,
      state: "settled",
      status: "skipped",
    })]);
  });

  it("keeps an attempt whose start retention pruned", () => {
    const { events } = journalOf([
      { transition: START, pass: 4 },
      { transition: settle(1), pass: 4 },
    ]);

    const journal = foldWorkflowJournal(RUN, events.slice(1));

    expect(attempts(journal)).toEqual([expect.objectContaining({
      attempt: 1,
      pass: null,
      state: "settled",
    })]);
    expect(journal.anomalies).toEqual([]);
  });

  it("records entries that contradict the journal as anomalies", () => {
    const { events } = journalOf([
      { transition: START, pass: 1 },
      { transition: settle(1), pass: 1 },
    ]);
    const [started, settled] = events;
    const foreign = { ...started.payload, workflowRunId: "another-run" };
    const otherPlan = {
      ...started.payload,
      planSha256: workflowJournalNodeDigests({ planId: "plan-2", nodeId: "x" }).planSha256,
    };

    const journal = foldWorkflowJournal(RUN, [
      ...events,
      { ...settled, seq: 3 },
      { ...started, seq: 4 },
      { seq: 5, type: started.type, payload: foreign },
      { seq: 6, type: settled.type, payload: started.payload },
      { seq: 7, type: started.type, payload: otherPlan },
    ]);

    expect(journal.anomalies).toEqual([
      "seq 3: attempt 1 is already settled",
      "seq 4: attempt 1 starts after attempt 1",
      "seq 5: not a journal entry of this run",
      "seq 6: not a journal entry of this run",
      "seq 7: a node entry names another plan",
    ]);
    expect(attempts(journal)).toHaveLength(1);
  });

  it("reuses a row only when it is the outcome the journal settled", () => {
    const { journal } = journalOf([
      { transition: START, pass: 1 },
      { transition: settle(1), pass: 1 },
    ]);
    const { journal: open } = journalOf([{ transition: START, pass: 1 }]);

    expect(verifyWorkflowJournalReuse(journal, row())).toEqual({ reusable: true });
    expect(verifyWorkflowJournalReuse(journal, row({ output: { ok: false } })))
      .toEqual({
        reusable: false,
        reason: "the row's output is not the output attempt 1 settled with",
      });
    expect(verifyWorkflowJournalReuse(journal, row({ status: "skipped" })))
      .toMatchObject({ reusable: false });
    expect(verifyWorkflowJournalReuse(journal, row({ error: "A forged error." })))
      .toEqual({
        reusable: false,
        reason: "the row's error is not the error attempt 1 settled with",
      });
    expect(verifyWorkflowJournalReuse(open, row())).toEqual({
      reusable: false,
      reason: "attempt 1 is open, but the row is completed",
    });
    expect(verifyWorkflowJournalReuse(foldWorkflowJournal(RUN, []), row()))
      .toEqual({ reusable: true });
  });
});
