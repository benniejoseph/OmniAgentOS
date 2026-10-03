import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/sql-types";
import { ResponsibilityError } from "./state";
import { runtimeNow, runtimeOwner } from "./runtime-test-fixtures";
const mocks = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock("@/lib/db/memory-access-scope", async (original) => ({ ...await original<typeof import("@/lib/db/memory-access-scope")>(), setTransactionLocalDatabaseMemoryAccessScope: mocks.install }));
import { readOwnedResponsibilityProcedures } from "./procedure-reference";
const content = JSON.stringify({ schemaVersion: 1, id: "observe-meeting", aliases: ["Observe meeting"], toolBindings: [{ toolId: "app.meetings.show", input: { workspaceId: "workspace:owner", meetingId: "meeting-a" } }] });
function fixture(input: { rows?: { id: string; content: string }[]; archived?: string[]; failure?: Error; cleanup?: "throw" | "nonempty" } = {}) {
  const clear = vi.fn();
  const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    if (query.includes("set_config")) { clear(); if (input.cleanup === "throw") throw new Error("scope cleanup failed"); return []; }
    if (query.includes("current_setting")) return [{ memory_scope: input.cleanup === "nonempty" ? "not cleared" : null }];
    if (query.includes("FROM omni_memory_lifecycle_states")) return [{ archived_at: input.archived?.includes(String(values[1])) ? runtimeNow : null }];
    if (input.failure) throw input.failure;
    return input.rows ?? [{ id: "memory-private", content }];
  }), { transactionScoped: true }) as unknown as SqlClient;
  return { sql, clear };
}
beforeEach(() => vi.clearAllMocks());
describe("Responsibility private procedure scope lifetime", () => {
  it("excludes archived/malformed candidates and retains unambiguous source identity while clearing scope", async () => {
    const f = fixture({ rows: [{ id: "memory-private", content }, { id: "archived", content }, { id: "invalid", content: "{}" }], archived: ["archived"] });
    const result = await readOwnedResponsibilityProcedures(f.sql, runtimeOwner, { lock: true, now: runtimeNow });
    expect(result).toHaveLength(1); expect(result[0].sourceMemoryId).toBe("memory-private"); expect(f.clear).toHaveBeenCalledTimes(1);
    expect(mocks.install).toHaveBeenCalledWith(f.sql, expect.objectContaining({ tenantId: runtimeOwner.tenantId, initiatingActorId: runtimeOwner.actorId,
      executingPrincipalType: "user", executingPrincipalId: runtimeOwner.actorId, purposeId: "memory.read.v1", contextGrantIds: [], capabilityGrantIds: [] }));
  });
  it("clears scope on read refusal and does not silently choose duplicate procedure IDs", async () => {
    const failure = new ResponsibilityError("Unavailable", 409, "fixture-unavailable"); const failed = fixture({ failure });
    await expect(readOwnedResponsibilityProcedures(failed.sql, runtimeOwner, { lock: true, now: runtimeNow })).rejects.toBe(failure);
    expect(failed.clear).toHaveBeenCalledTimes(1);
    const duplicate = fixture({ rows: [{ id: "a", content }, { id: "b", content }] });
    expect((await readOwnedResponsibilityProcedures(duplicate.sql, runtimeOwner, { lock: false, now: runtimeNow })).map((value) => value.sourceMemoryId)).toEqual(["a", "b"]);
  });
  it.each(["throw", "nonempty"] as const)("treats %s cleanup as infrastructure failure, never a committable authority refusal", async (cleanup) => {
    const f = fixture({ cleanup, failure: new ResponsibilityError("Unavailable", 409, "fixture-unavailable") });
    const failure = await readOwnedResponsibilityProcedures(f.sql, runtimeOwner, { lock: true, now: runtimeNow }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(ResponsibilityError); expect(f.clear).toHaveBeenCalledTimes(1);
  });
  it("refuses non-transaction callbacks and oversized inventory before returning any candidate", async () => {
    await expect(readOwnedResponsibilityProcedures(Object.assign(vi.fn(), { transactionScoped: false }) as unknown as SqlClient, runtimeOwner, { lock: false, now: runtimeNow })).rejects.toMatchObject({ status: 409 });
    expect(mocks.install).not.toHaveBeenCalled();
    const f = fixture({ rows: Array.from({ length: 129 }, (_, id) => ({ id: String(id), content })) });
    await expect(readOwnedResponsibilityProcedures(f.sql, runtimeOwner, { lock: false, now: runtimeNow })).rejects.toMatchObject({ status: 409 });
    expect(f.clear).toHaveBeenCalledTimes(1);
  });
});
