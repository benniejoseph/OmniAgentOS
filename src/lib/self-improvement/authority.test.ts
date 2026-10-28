import { describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { inspectSelfImprovementToolAuthority, selfImprovementModelAllowance, withSelfImprovementExecution, type SelfImprovementExecutionAuthority } from "./authority";
import { createInspectionCompletionGate } from "./inspection-completion";
import { createReviewCompletionGate } from "./review-completion";
import { reviewFixture } from "./review-test-fixtures";
import { createForgeHandoff, type ForgePlan } from "./forge-handoff";

const context = { tenantId: "t", actorId: "actor:a", role: "operator" as const, source: "service" as const };
const executionScope = createExecutionScope({ tenantId: "t", initiatingActorId: "actor:a", executingPrincipalType: "agent", executingPrincipalId: "forge", projectId: "p", correlationId: "r", purpose: "self_improvement.cycle.v1" });
function authority(change: Partial<SelfImprovementExecutionAuthority> = {}): SelfImprovementExecutionAuthority {
  return { tenantId: "t", ownerActorId: "actor:a", projectId: "p", repositoryId: "12", cycleId: "cycle", policySha256: "a".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), readOnly: false, assertCurrent: vi.fn(async () => undefined), ...change };
}
const call = (toolId: string, input: Record<string, unknown> = {}) => inspectSelfImprovementToolAuthority({ toolId, input: { projectId: "p", ...input }, context, executionScope });

describe("self-improvement standing authority", () => {
  it("selects engineering effort only for an exact live workspace phase", async () => {
    const f = reviewFixture();
    const inspection = createInspectionCompletionGate({ runId: f.runId, sessionId: f.manifest.sessionId, assertCurrent: async () => undefined, readReceipts: async () => [] });
    const review = createReviewCompletionGate({ runId: f.runId, manifest: f.manifest, assertCurrent: async () => undefined, readReceipts: async () => f.reads });
    const forgePlan: ForgePlan = { phase: "reproduce", plan: { summary: "Synthetic", sourcePaths: ["src/a.ts"], newSourcePaths: [], adjacentTestPaths: ["src/a.test.ts"], focusedTestPaths: ["src/regression.test.ts"], acceptanceCriteria: ["Synthetic"] }, expectedHashes: { "src/a.ts": "a".repeat(64) } };
    const forge = createForgeHandoff({ runId: f.runId, sessionId: f.manifest.sessionId, plan: forgePlan, assertCurrent: async () => undefined, verifyRead: async () => { throw new Error("No read requested by this authority test."); } });
    const bound = authority({ tenantId: f.manifest.tenantId, ownerActorId: f.manifest.ownerActorId, projectId: f.manifest.projectId, cycleId: f.manifest.cycleId, policySha256: f.manifest.policySha256, sessionId: f.manifest.sessionId });
    const ctx = { ...context, tenantId: bound.tenantId, actorId: bound.ownerActorId };
    const scope = { ...executionScope, tenantId: ctx.tenantId, initiatingActorId: ctx.actorId, projectId: bound.projectId, correlationId: f.runId };
    const allowance = (change: Partial<SelfImprovementExecutionAuthority>) => withSelfImprovementExecution({ ...bound, ...change }, () => selfImprovementModelAllowance({ context: ctx, executionScope: scope }));
    expect((await allowance({ readOnly: true, inspectionCompletion: inspection }))?.reasoningEffort).toBe("medium");
    expect((await allowance({ forgePlan, forgeHandoff: forge }))?.reasoningEffort).toBe("medium");
    expect((await allowance({ readOnly: true, reviewManifest: f.manifest, reviewCompletion: review }))?.reasoningEffort).toBe("high");
    expect((await allowance({ readOnly: true }))?.reasoningEffort).toBeUndefined();
    expect((await allowance({ readOnly: true, sessionId: undefined, inspectionCompletion: inspection }))?.reasoningEffort).toBeUndefined();
    expect((await allowance({ readOnly: true, inspectionCompletion: inspection, reviewManifest: f.manifest, reviewCompletion: review }))?.reasoningEffort).toBeUndefined();
    await expect(allowance({ readOnly: true, inspectionCompletion: inspection, assertCurrent: async () => { throw new Error("revoked"); } })).rejects.toThrow("revoked");
  });
  it.each(["tenantId", "ownerActorId", "projectId", "cycleId", "policySha256", "sessionId"] as const)("never accepts a criterion manifest with another %s", async key => {
    const f = reviewFixture(), bound = authority({ tenantId: f.manifest.tenantId, ownerActorId: f.manifest.ownerActorId, projectId: f.manifest.projectId, cycleId: f.manifest.cycleId,
      policySha256: f.manifest.policySha256, sessionId: f.manifest.sessionId, readOnly: true, reviewManifest: { ...f.manifest, [key]: "foreign" },
      reviewCompletion: createReviewCompletionGate({ runId: f.runId, manifest: f.manifest, assertCurrent: async () => undefined, readReceipts: async () => f.reads }) });
    const ctx = { ...context, tenantId: bound.tenantId, actorId: bound.ownerActorId };
    const scope = createExecutionScope({ tenantId: ctx.tenantId, initiatingActorId: ctx.actorId, executingPrincipalType: "agent", executingPrincipalId: "sentinel", projectId: bound.projectId, correlationId: f.runId, purpose: "self_improvement.cycle.v1" });
    await expect(withSelfImprovementExecution(bound, () => selfImprovementModelAllowance({ context: ctx, executionScope: scope }))).rejects.toThrow("owner scope");
  });
  it("leaves ordinary calls unchanged, and narrows standing authority to exact configured effects", async () => {
    expect(await call("app.projects.builder.create")).toBeUndefined();
    await withSelfImprovementExecution(authority(), async () => {
      expect((await call("app.projects.builder.create"))?.approved).toBe(true);
      expect((await call("app.projects.builder.file.read"))?.approved).toBe(false);
      await expect(call("app.projects.builder.release.production")).rejects.toThrow("boundary");
      await expect(call("app.self_improvement.review")).rejects.toThrow("boundary");
      await expect(call("app.projects.builder.create", { projectId: "foreign" })).rejects.toThrow("boundary");
      await expect(call("app.projects.builder.repository.bind", { repositoryId: "99" })).rejects.toThrow("repository");
    });
  });
  it("revalidates live pause/lease state and never turns a forced human review into automatic authority", async () => {
    const check = vi.fn(async () => { throw new Error("paused"); });
    await expect(withSelfImprovementExecution(authority({ assertCurrent: check }), () => call("app.projects.builder.create"))).rejects.toThrow("paused");
    expect(check).toHaveBeenCalledOnce();
    await withSelfImprovementExecution(authority(), async () => {
      expect((await inspectSelfImprovementToolAuthority({ toolId: "app.projects.builder.create", input: { projectId: "p" }, context, executionScope, forceApproval: true }))?.approved).toBe(false);
    });
  });
  it("restricts Forge to the exact phase paths and Sentinel to reads", async () => {
    await withSelfImprovementExecution(authority({ writePaths: ["src/app/[id]/page.tsx"] }), async () => {
      await expect(call("app.projects.builder.file.update", { path: "src/app/[id]/page.tsx" })).resolves.toBeDefined();
      await expect(call("app.projects.builder.file.update", { path: "scripts/deploy-production.mjs" })).rejects.toThrow("phase plan");
      await expect(call("app.projects.builder.command.run", { command: "build" })).rejects.toThrow("focused");
      await expect(call("app.projects.builder.delivery.create", { draft: false })).rejects.toThrow("draft");
    });
    await expect(withSelfImprovementExecution(authority({ readOnly: true }), () => call("app.projects.builder.file.update", { path: "src/app/[id]/page.tsx" }))).rejects.toThrow("boundary");
  });
  it("does not leak authority to another async request", async () => {
    const seen = await Promise.all([withSelfImprovementExecution(authority(), () => call("app.projects.builder.create")), call("app.projects.builder.create")]);
    expect(seen[0]?.approved).toBe(true); expect(seen[1]).toBeUndefined();
  });
  it("admits bounded coding output only inside the current owner authority", async () => {
    expect(await selfImprovementModelAllowance({ context, executionScope })).toBeUndefined();
    await withSelfImprovementExecution(authority(), async () => {
      expect(await selfImprovementModelAllowance({ context, executionScope })).toEqual({ maxToolSteps: 16, maxOutputTokens: 8_000 });
      await expect(selfImprovementModelAllowance({ context: { ...context, actorId: "foreign" }, executionScope })).rejects.toThrow(/owner scope/);
    });
    await expect(withSelfImprovementExecution(authority({ assertCurrent: async () => { throw new Error("revoked"); } }), () => selfImprovementModelAllowance({ context, executionScope }))).rejects.toThrow("revoked");
  });
  it("keeps inspection completion within its original read-only run", async () => {
    const gate = createInspectionCompletionGate({ runId: "11111111-1111-4111-8111-111111111111", sessionId: `app_build_${"a".repeat(48)}`,
      assertCurrent: async () => undefined, readReceipts: async () => [] });
    const scope = { ...executionScope, correlationId: gate.runId };
    await withSelfImprovementExecution(authority({ readOnly: true, inspectionCompletion: gate }), async () => {
      expect((await selfImprovementModelAllowance({ context, executionScope: scope }))?.inspectionCompletion).toBe(gate);
      await expect(selfImprovementModelAllowance({ context, executionScope })).rejects.toThrow("original run");
    });
    await expect(withSelfImprovementExecution(authority({ inspectionCompletion: gate }), () => selfImprovementModelAllowance({ context, executionScope: scope }))).rejects.toThrow("original run");
    expect(await selfImprovementModelAllowance({ context, executionScope: scope })).toBeUndefined();
  });
});
