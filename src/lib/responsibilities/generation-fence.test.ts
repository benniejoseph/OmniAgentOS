import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/sql-types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { getGovernedTool } from "@/lib/tools/registry";
import { assertResponsibilityToolDispatch, RESPONSIBILITY_EXECUTION_PURPOSE, withResponsibilityDispatchAdmission, type ResponsibilityDispatchAdmission } from "./generation-fence";
import { reserveResponsibilityWake, verifyPilotConfiguration } from "./lifecycle-state";
import { runtimeConfiguration, runtimeHead, runtimeNow, runtimeOwner } from "./runtime-test-fixtures";

function fixture() {
  const tool = getGovernedTool("app.meetings.show")!;
  const { configurationSha256: _hash, ...body } = runtimeConfiguration; void _hash;
  const updated = { ...body, tool: { ...body.tool, contractSha256: canonicalJsonSha256(tool) } };
  const configuration = verifyPilotConfiguration({ ...updated, configurationSha256: canonicalJsonSha256(updated) });
  const reserved = reserveResponsibilityWake({ ...runtimeHead, configuration }, runtimeNow, null);
  const token = "test-lease";
  const wake = { ...reserved.wake, state: "running" as const, leaseGeneration: 1, leaseTokenSha256: canonicalJsonSha256(token), leaseExpiresAt: "2026-10-04T00:00:30.000Z", startedAt: runtimeNow, workflowRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  let live = reserved.current;
  const sql = Object.assign(vi.fn(async () => [{ lifecycle_snapshot: live, wake_snapshot: wake }]), { transactionScoped: true }) as unknown as SqlClient;
  const args = { tool, input: configuration.tool.input, requireReadOnly: true, dryRun: false, approved: false, forceApproval: false,
    context: { tenantId: runtimeOwner.tenantId, actorId: "owner@example.test", role: "operator" as const, source: "session" as const,
      auth: { userId: runtimeOwner.actorId.slice(6), email: "owner@example.test", sessionId: "fixture", tenantName: "Fixture" } },
    executionScope: createExecutionScope({ tenantId: runtimeOwner.tenantId, initiatingActorId: "owner@example.test", executingPrincipalType: "agent", executingPrincipalId: configuration.pins.agent.id,
      workspaceId: configuration.pins.work.workspaceId, projectId: configuration.pins.work.projectId, correlationId: wake.id, causationId: wake.id, purpose: RESPONSIBILITY_EXECUTION_PURPOSE }) };
  return { sql, wake, current: reserved.current, token, args, pause: () => { live = { ...live, revision: live.revision + 1, generation: live.generation + 1, state: "pausing", reason: "owner_paused", nextDueAt: null }; } };
}
describe("Responsibility governed dispatch fence", () => {
  it("rechecks the generation immediately before dispatch, after earlier admission", async () => {
    const f = fixture(); const dispatched = vi.fn();
    await withResponsibilityDispatchAdmission({ ...f, leaseToken: f.token, now: () => runtimeNow }, async (admission) => {
      await assertResponsibilityToolDispatch({ ...f.args, admission });
      f.pause();
      await expect(assertResponsibilityToolDispatch({ ...f.args, admission }).then(dispatched)).rejects.toMatchObject({ code: "responsibility_generation_fenced" });
    });
    expect(dispatched).not.toHaveBeenCalled();
  });
  it("refuses copied/expired admissions, approval continuations, drifted input and mutation tools", async () => {
    const f = fixture(); let expired: ResponsibilityDispatchAdmission | undefined;
    await withResponsibilityDispatchAdmission({ ...f, leaseToken: f.token, now: () => runtimeNow }, async (admission) => {
      expired = admission;
      for (const changes of [{ admission: {} as ResponsibilityDispatchAdmission }, { policyLeaseClaim: {} }, { approvalGrantClaim: {} }, { existingRecord: {} },
        { requireReadOnly: false }, { input: { ...f.args.input, meetingId: "foreign" } }, { tool: { ...f.args.tool, operationClass: "mutation" as const } }]) {
        await expect(assertResponsibilityToolDispatch({ ...f.args, admission, ...changes })).rejects.toMatchObject({ code: "responsibility_generation_fenced" });
      }
    });
    await expect(assertResponsibilityToolDispatch({ ...f.args, admission: expired })).rejects.toMatchObject({ code: "responsibility_generation_fenced" });
    await expect(assertResponsibilityToolDispatch(f.args)).rejects.toMatchObject({ code: "responsibility_generation_fenced" });
  });
  it("fences principal expiry between preflight and dispatch even when its identity pin is unchanged", async () => {
    const f = fixture(); let now = runtimeNow;
    await withResponsibilityDispatchAdmission({ ...f, leaseToken: f.token, authorityExpiresAt: "2026-10-04T00:00:10.000Z", now: () => now }, async (admission) => {
      await assertResponsibilityToolDispatch({ ...f.args, admission });
      now = "2026-10-04T00:00:10.000Z";
      await expect(assertResponsibilityToolDispatch({ ...f.args, admission })).rejects.toMatchObject({ code: "responsibility_generation_fenced" });
    });
  });
  it("refuses dispatch when the exact queued workflow no longer joins the locked wake", async () => {
    const f = fixture();
    await withResponsibilityDispatchAdmission({ ...f, leaseToken: f.token, now: () => runtimeNow }, async (admission) => {
      vi.mocked(f.sql).mockResolvedValueOnce([]);
      await expect(assertResponsibilityToolDispatch({ ...f.args, admission })).rejects.toMatchObject({ code: "responsibility_generation_fenced" });
    });
  });
});
