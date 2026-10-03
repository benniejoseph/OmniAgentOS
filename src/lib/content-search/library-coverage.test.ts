import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sql: vi.fn(), transaction: vi.fn(), files: new Map<string, unknown>(), database: false }));
vi.mock("@/lib/db/client", () => ({ ensureDatabaseSchema: vi.fn(), hasDatabaseUrl: () => mocks.database,
  getSql: () => Object.assign(mocks.sql, { transaction: mocks.transaction }) }));
vi.mock("@/lib/storage/json", () => ({ readJsonFile: async (file: string, fallback: unknown) => mocks.files.get(file) ?? fallback }));
vi.mock("@/lib/storage/paths", () => ({ getDataPath: (...parts: string[]) => parts.join("/") }));
import { listWorkspaceLibrary } from "@/lib/library/store";
const time = "2026-10-04T00:00:00.000Z";
beforeEach(() => { vi.clearAllMocks(); mocks.files.clear(); mocks.database = false; mocks.sql.mockResolvedValue([]); mocks.transaction.mockImplementation(async (operation: (sql: typeof mocks.sql) => Promise<unknown>) => operation(mocks.sql)); });
describe("Library search coverage before pagination", () => {
  it("restricts every database source candidate lane before the window", async () => {
    mocks.database = true;
    await listWorkspaceLibrary({ tenantId: "tenant", actorId: "owner", query: "report", sourceAuthorities: ["capture_asset"], limit: 8 });
    const sql = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join("?");
    for (const lane of ["capture_result_ids", "capture_facet_ids", "recording_result_ids", "recording_facet_ids", "project_result_ids", "project_facet_ids", "mission_result_ids", "mission_facet_ids", "source_result_ids", "source_facet_ids"]) {
      const section = sql.slice(sql.indexOf(`${lane} AS`)).split("LIMIT")[0];
      expect(section).toMatch(/WHERE [\w.]+ = \?\s+AND \?/);
    }
  });
  it("returns empty when no authorities are allowed, before slicing results", async () => {
    mocks.files.set("capture-assets.json", { assets: [{ id: "asset", tenantId: "tenant", actorId: "owner", filename: "Report.txt", mediaType: "text/plain", byteCount: 10,
      contentSha256: "a".repeat(64), status: "stored", extractionStatus: "pending", metadata: {}, tags: [], createdAt: time, updatedAt: time }] });
    expect((await listWorkspaceLibrary({ tenantId: "tenant", actorId: "owner", query: "report", sourceAuthorities: [], limit: 8 })).items).toEqual([]);
    expect((await listWorkspaceLibrary({ tenantId: "tenant", actorId: "other", query: "report", sourceAuthorities: ["capture_asset"], limit: 8 })).items).toEqual([]);
    expect((await listWorkspaceLibrary({ tenantId: "tenant", actorId: "owner", query: "report", sourceAuthorities: ["capture_asset"], limit: 8 })).items).toHaveLength(1);
  });
});
