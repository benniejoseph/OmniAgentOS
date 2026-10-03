import { describe, expect, it } from "vitest";
import { reserveResponsibilityWake } from "./lifecycle-state";
import { assertRuntimeWorkflow, runtimeExecutionAuthority, runtimeWorkflowBinding } from "./runtime-state";
import { runtimeHead, runtimeNow, runtimeOwner } from "./runtime-test-fixtures";

const context = { tenantId: runtimeOwner.tenantId, actorId: "owner@example.test", role: "operator" as const, source: "session" as const,
  auth: { userId: runtimeOwner.actorId.slice(6), email: "owner@example.test", sessionId: "fixture", tenantName: "Fixture" } };
describe("Responsibility exact workflow attribution", () => {
  it("retains the canonical owner while binding the exact current request email", () => {
    const { current, wake: reserved } = reserveResponsibilityWake(runtimeHead, runtimeNow, null);
    const wake = { ...reserved, workflowRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const authority = runtimeExecutionAuthority(current, wake, context);
    const binding = runtimeWorkflowBinding(current, wake);
    expect(binding.ownerActorId).toBe(runtimeOwner.actorId);
    expect(authority.executionScope.initiatingActorId).toBe(context.actorId);
    expect(() => assertRuntimeWorkflow(current, wake, { runId: wake.workflowRunId, binding, authority, context })).not.toThrow();
    const renamed = { ...context, actorId: "renamed@example.test", auth: { ...context.auth, email: "renamed@example.test" } };
    expect(() => assertRuntimeWorkflow(current, wake, { runId: wake.workflowRunId, binding, authority, context: renamed })).toThrow();
    // A newly resolved mapping can bind a future authorized wake, never rewrite
    // the immutable authority of work that was already queued.
    expect(runtimeExecutionAuthority(current, wake, renamed).executionScope.initiatingActorId).toBe(renamed.actorId);
  });
  it("rejects arbitrary aliases, foreign actors, replaced runs and changed binding generations", () => {
    const { current, wake: reserved } = reserveResponsibilityWake(runtimeHead, runtimeNow, null);
    const wake = { ...reserved, workflowRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const authority = runtimeExecutionAuthority(current, wake, context); const binding = runtimeWorkflowBinding(current, wake);
    expect(() => runtimeExecutionAuthority(current, wake, { ...context, actorId: "unvalidated@example.test" })).toThrow();
    expect(() => runtimeExecutionAuthority(current, wake, { ...context, tenantId: "other" })).toThrow();
    for (const patch of [{ runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { binding: { ...binding, generation: 2 } },
      { binding: { ...binding, ownerActorId: "other" } }, { authority: undefined }]) {
      expect(() => assertRuntimeWorkflow(current, wake, { runId: wake.workflowRunId, binding, authority, context, ...patch })).toThrow();
    }
  });
});
