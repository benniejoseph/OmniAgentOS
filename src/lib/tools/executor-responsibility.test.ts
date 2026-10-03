import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/sql-types";
import { withResponsibilityDispatchAdmission } from "@/lib/responsibilities/generation-fence";
import { reserveResponsibilityWake, verifyPilotConfiguration } from "@/lib/responsibilities/lifecycle-state";
import { runtimeExecutionAuthority } from "@/lib/responsibilities/runtime-state";
import { runtimeConfiguration, runtimeHead, runtimeNow, runtimeOwner } from "@/lib/responsibilities/runtime-test-fixtures";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { getGovernedTool } from "@/lib/tools/registry";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/app-services/tool-dispatcher", () => ({ executeFirstPartyAppTool: mocks.dispatch }));
vi.mock("@/lib/observability/store", async (original) => ({ ...await original<typeof import("@/lib/observability/store")>(), recordRuntimeEventSafely: mocks.event }));
vi.mock("@/lib/http/rate-limit", () => ({ checkSharedRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }) }));
import { executeGovernedTool } from "./executor";

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "responsibility-executor-"));
  mocks.dispatch.mockReset(); mocks.event.mockReset().mockResolvedValue(undefined);
});
describe("Governed responsibility final generation fence", () => {
  it("checks the generation again after intent admission and records failure before any app dispatch", async () => {
    const { configurationSha256: _digest, ...body } = runtimeConfiguration; void _digest;
    const updated = { ...body, tool: { ...body.tool, contractSha256: canonicalJsonSha256(getGovernedTool(body.tool.id)!) } };
    const configuration = verifyPilotConfiguration({ ...updated, configurationSha256: canonicalJsonSha256(updated) });
    const reserved = reserveResponsibilityWake({ ...runtimeHead, configuration }, runtimeNow, null);
    const wake = { ...reserved.wake, state: "running" as const, leaseGeneration: 1, startedAt: runtimeNow,
      workflowRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", leaseTokenSha256: canonicalJsonSha256("lease"), leaseExpiresAt: "2026-10-04T00:00:30.000Z" };
    let reads = 0;
    const sql = Object.assign(vi.fn(async () => [{ lifecycle_snapshot: ++reads >= 3 ? { ...reserved.current, generation: 2, state: "pausing", reason: "owner_paused", nextDueAt: null } : reserved.current,
      wake_snapshot: wake }]), { transactionScoped: true }) as unknown as SqlClient;
    const context = { tenantId: runtimeOwner.tenantId, actorId: "owner@example.test", role: "admin" as const, source: "session" as const,
      auth: { userId: runtimeOwner.actorId.slice(6), email: "owner@example.test", sessionId: "fixture", tenantName: "Fixture" } };
    const authority = runtimeExecutionAuthority(reserved.current, wake, context);
    await withResponsibilityDispatchAdmission({ sql, current: reserved.current, wake, leaseToken: "lease", now: () => runtimeNow }, async (admission) => {
      const result = await executeGovernedTool({ toolId: configuration.tool.id, input: configuration.tool.input, context,
        executionScope: authority.executionScope, dryRun: false, requireReadOnly: true, idempotencyKey: wake.id, responsibilityAdmission: admission });
      expect(result.record.status).toBe("failed"); expect(result.result).toBeNull();
      expect(result.record.reason).toContain("generation");
    });
    expect(reads).toBe(3); expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
