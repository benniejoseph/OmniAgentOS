import { describe, expect, it } from "vitest";

import { buildContract } from "@/lib/delegation/test-fixtures";
import {
  buildDelegationTaskV1,
  initialDelegationTaskEventV1,
  parseDelegationTaskV1,
  transitionDelegationTaskV1,
} from "@/lib/delegation/lifecycle";

const acceptedAt = "2026-09-07T06:00:10.000Z";
const workingAt = "2026-09-07T06:00:20.000Z";
const proposedAt = "2026-09-07T06:00:30.000Z";

describe("delegation task lifecycle", () => {
  it("keeps completed work proposed until the exact parent verifier accepts it", () => {
    const contract = buildContract();
    const proposed = buildDelegationTaskV1(contract);
    expect(initialDelegationTaskEventV1(proposed)).toMatchObject({
      from: null,
      to: "proposed",
      delegationId: contract.delegationId,
      parentExecutionId: contract.scope.parentExecutionId,
      delegateAgentId: contract.delegate.agentId,
    });
    const accepted = transitionDelegationTaskV1({
      task: proposed,
      transition: { to: "accepted" },
      at: acceptedAt,
    }).task;
    const working = transitionDelegationTaskV1({
      task: accepted,
      transition: { to: "working" },
      at: workingAt,
    }).task;
    const completion = transitionDelegationTaskV1({
      task: working,
      transition: {
        to: "completed_proposed",
        proposalReceiptSha256: "1".repeat(64),
        acceptanceChecksSha256: "2".repeat(64),
        artifactSha256s: ["3".repeat(64)],
        evidenceIds: ["evidence:one"],
        toolExecutionIds: ["tool-execution:one"],
      },
      at: proposedAt,
    });
    expect(completion.task).toMatchObject({ state: "completed_proposed", terminalAt: null });
    expect(completion.event).toMatchObject({
      from: "working",
      to: "completed_proposed",
      toolExecutionIds: ["tool-execution:one"],
    });
    const terminal = transitionDelegationTaskV1({
      task: completion.task,
      transition: {
        to: "result_accepted",
        evaluatorPrincipalId: contract.scope.parentPrincipalId,
        evaluatorAgentId: contract.verifier.agentId,
        evaluatorDefinitionVersion: contract.verifier.definitionVersion,
        score: 1,
      },
      at: "2026-09-07T06:00:40.000Z",
    }).task;
    expect(terminal).toMatchObject({
      state: "result_accepted",
      lifecycleRevision: 4,
      evaluation: { verdict: "accepted", proposalReceiptSha256: "1".repeat(64) },
    });
  });

  it("supports waiting, challenge, resume, and parent rejection", () => {
    let task = buildDelegationTaskV1(buildContract());
    task = transitionDelegationTaskV1({ task, transition: { to: "accepted" }, at: acceptedAt }).task;
    task = transitionDelegationTaskV1({ task, transition: { to: "working" }, at: workingAt }).task;
    const waiting = transitionDelegationTaskV1({
      task,
      transition: { to: "waiting", reason: "approval_required", toolExecutionId: "tool:one" },
      at: "2026-09-07T06:00:25.000Z",
    });
    expect(waiting.event.toolExecutionIds).toEqual(["tool:one"]);
    task = transitionDelegationTaskV1({
      task: waiting.task,
      transition: { to: "challenged", reason: "Approval was denied.", challengeSha256: "4".repeat(64) },
      at: "2026-09-07T06:00:26.000Z",
    }).task;
    task = transitionDelegationTaskV1({ task, transition: { to: "working" }, at: "2026-09-07T06:00:27.000Z" }).task;
    task = transitionDelegationTaskV1({
      task,
      transition: {
        to: "completed_proposed",
        proposalReceiptSha256: "5".repeat(64),
        acceptanceChecksSha256: "6".repeat(64),
      },
      at: proposedAt,
    }).task;
    task = transitionDelegationTaskV1({
      task,
      transition: {
        to: "rejected",
        evaluatorPrincipalId: "principal:atlas:1",
        evaluatorAgentId: "sentinel",
        evaluatorDefinitionVersion: 1,
        score: 0.2,
      },
      at: "2026-09-07T06:00:40.000Z",
    }).task;
    expect(task.state).toBe("rejected");
  });

  it("rejects skipped states, stale acceptance, early expiry, and verifier substitution", () => {
    const task = buildDelegationTaskV1(buildContract());
    expect(() => transitionDelegationTaskV1({
      task,
      transition: {
        to: "completed_proposed",
        proposalReceiptSha256: "1".repeat(64),
        acceptanceChecksSha256: "2".repeat(64),
      },
      at: proposedAt,
    })).toThrow(/invalid/);
    expect(() => transitionDelegationTaskV1({
      task,
      transition: { to: "accepted" },
      at: "2026-09-07T06:01:00.000Z",
    })).toThrow(/acceptance deadline/);
    expect(() => transitionDelegationTaskV1({
      task,
      transition: { to: "expired" },
      at: workingAt,
    })).toThrow(/before/);

    let completion = transitionDelegationTaskV1({ task, transition: { to: "accepted" }, at: acceptedAt }).task;
    completion = transitionDelegationTaskV1({ task: completion, transition: { to: "working" }, at: workingAt }).task;
    completion = transitionDelegationTaskV1({
      task: completion,
      transition: { to: "completed_proposed", proposalReceiptSha256: "1".repeat(64), acceptanceChecksSha256: "2".repeat(64) },
      at: proposedAt,
    }).task;
    expect(() => transitionDelegationTaskV1({
      task: completion,
      transition: {
        to: "result_accepted",
        evaluatorPrincipalId: "principal:other:1",
        evaluatorAgentId: "sentinel",
        evaluatorDefinitionVersion: 1,
        score: 1,
      },
      at: "2026-09-07T06:00:40.000Z",
    })).toThrow(/parent verifier/);
  });

  it("detects projection tampering", () => {
    const task = buildDelegationTaskV1(buildContract());
    expect(() => parseDelegationTaskV1({ ...task, delegateAgentId: "forge" })).toThrow(/integrity/);
  });
});
