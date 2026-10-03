import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sql: vi.fn(), transaction: vi.fn(), memoryScope: vi.fn(), rows: [] as Record<string, unknown>[] }));
vi.mock("@/lib/db/client", () => ({ ensureDatabaseSchema: vi.fn(), hasDatabaseUrl: () => true,
  getDatabaseTenantContext: () => undefined, getSql: () => Object.assign(mocks.sql, { transaction: mocks.transaction }) }));
vi.mock("@/lib/db/memory-access-scope", async (importOriginal) => ({ ...await importOriginal<object>(), setTransactionLocalDatabaseMemoryAccessScope: mocks.memoryScope }));
import { searchOwnedThreadsPage } from "@/lib/threads/store";
import { searchPrivateMemoryPage } from "@/lib/memory/store";
import { searchOwnedWorkPage, resolveOwnedSearchWork } from "./work-reader";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { searchContext, searchTimestamp, searchThreadId } from "./test-fixtures";
const owner = { tenantId: searchContext.tenantId, actorId: searchContext.actorId, requestActorBinding: canonicalRequestActorBindingFromSecurityContext(searchContext) };
beforeEach(() => {
  vi.clearAllMocks(); mocks.rows = [];
  mocks.sql.mockImplementation(async () => mocks.rows);
  mocks.transaction.mockImplementation(async (operation: (sql: typeof mocks.sql) => Promise<unknown>) => operation(mocks.sql));
});
function statement() { return (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join("?"); }
describe("search storage boundaries", () => {
  it("requires owner predicates, escaped literal matching, UUID conversation destinations and precise keysets", async () => {
    mocks.rows = [{ id: searchThreadId, title: "Report 10%", updated_at: new Date(searchTimestamp), cursor_updated_at: searchTimestamp },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Later", updated_at: new Date(searchTimestamp), cursor_updated_at: searchTimestamp }];
    const page = await searchOwnedThreadsPage({ ...owner, query: "10%", limit: 1 });
    expect(page.next?.updatedAt).toBe(searchTimestamp); expect(statement()).toContain("actor_id IN");
    // postgres.js serializes timestamptz parameters through Date, losing
    // microseconds. Pin text parameters before PostgreSQL casts the cursor.
    expect(statement()).toContain("::text::timestamptz");
    expect(statement()).toContain("id ~"); expect(statement()).not.toContain("omni_thread_turns");
    expect(mocks.sql.mock.calls[0]).toContain("%10\\%%");
    expect(mocks.sql.mock.calls[0]).toContain(`actor:${searchContext.auth!.userId}`);
    await expect(searchOwnedThreadsPage({ ...owner, actorId: "", query: "report", limit: 8 })).rejects.toThrow("owner");
  });
  it("reads private memory inside its scope and excludes every legacy or inactive class in SQL", async () => {
    const access = requestMemoryAccessFromSecurityContext(searchContext, { purposeId: "memory.read.v1", auditPurpose: "search-test", correlationId: "search-test" })!;
    await searchPrivateMemoryPage({ tenantId: owner.tenantId, accessScope: access.databaseAccessScope, query: "report", limit: 8 });
    expect(mocks.transaction).toHaveBeenCalledTimes(1); expect(mocks.memoryScope).toHaveBeenCalledWith(mocks.sql, access.databaseAccessScope);
    for (const predicate of ["access_contract_version = 1", "access_state = 'scope_bound'", "visibility = 'user_private'", "owner_actor_id =", "claim_status = 'active'", "forgotten_at IS NULL", "archived_at IS NULL", "tier <> 'working'", "retention_expires_at > NOW()", "valid_to > NOW()", "valid_from <= NOW()"]) expect(statement()).toContain(predicate);
    expect(statement()).toContain("::text::timestamptz");
    expect(statement()).not.toContain("embedding"); expect(statement()).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(statement().slice(0, statement().indexOf("FROM"))).not.toContain("memory.content");
  });
  it("does not search any private memory after tenant/actor-purpose scope changes", async () => {
    const access = requestMemoryAccessFromSecurityContext(searchContext, { purposeId: "memory.read.v1", auditPurpose: "search-test", correlationId: "search-test" })!;
    await expect(searchPrivateMemoryPage({ tenantId: "other", accessScope: access.databaseAccessScope, query: "report", limit: 8 })).rejects.toThrow();
    await expect(searchPrivateMemoryPage({ tenantId: owner.tenantId, accessScope: { ...access.databaseAccessScope, purposeId: "memory.write.v1" }, query: "report", limit: 8 })).rejects.toThrow();
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it("joins active canonical mappings and memberships to current owned original records, without repair writes", async () => {
    await searchOwnedWorkPage({ ...owner, query: "report", limit: 8 });
    for (const predicate of ["workspace.state = 'active'", "membership.state = 'active'", "project_membership.state = 'active'", "mapping.state = 'active'", "original.actor_id = mapping.source_owner_actor_id", "original_task.project_id = project.original_project_id", "project.lifecycle_status <> 'archived'", "source_revision_sha256 = item.source_revision_sha256"]) expect(statement()).toContain(predicate);
    expect(statement()).toContain("::text::timestamptz");
    expect(statement()).not.toMatch(/INSERT|UPDATE|DELETE/);
    await expect(resolveOwnedSearchWork({ ...owner, requestActorBinding: undefined, projectId: "project" })).rejects.toThrow("canonical owner");
  });
});
