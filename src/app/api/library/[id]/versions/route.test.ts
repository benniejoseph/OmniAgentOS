import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/db/client", async (original) => ({ ...(await original<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope: (handler: (...args: never[]) => Promise<Response>) => handler }));
vi.mock("@/lib/security/guard", async (original) => ({ ...(await original<typeof import("@/lib/security/guard")>()), authorizeRequest: mocks.authorize }));
vi.mock("@/lib/app-services/library-history", () => ({ listWorkspaceLibraryVersionsService: mocks.list }));
import { GET } from "./route";
import { LibraryHistoryError } from "@/lib/library/history-contracts";
import { SecurityPolicyError } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";
const context: SecurityContext = { tenantId: "tenant-a", actorId: "owner@example.test", role: "viewer", source: "session" };
const id = "library:source_item:source:with/colons", head = "version:source_item:source:with/colons:revision:head";
const responseData = { versions: [], currentVersionId: head, authorityEffect: "none" };
const receipt = { operation: "app.library.versions.list", outcomeSha256: "a".repeat(64) };
function request(query = "", target = id) {
  return GET(new Request(`http://localhost/api/library/${encodeURIComponent(target)}/versions${query}`), { params: Promise.resolve({ id: target }) });
}
beforeEach(() => {
  mocks.authorize.mockReset().mockResolvedValue(context);
  mocks.list.mockReset().mockResolvedValue({ data: responseData, receipt });
});
describe("Library history list route", () => {
  it("authorizes exact private Library reads and passes the default bounded query", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ action: "read", resourceType: "workspace_library_item", resourceId: id }));
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ context }), { libraryItemId: id, query: { limit: 40 } });
    expect(await response.json()).toEqual({ ...responseData, serviceReceipt: receipt });
  });
  it("preserves exact encoded continuation and head identities", async () => {
    const before = "version:source_item:source:with/colons:revision:before/+";
    const response = await request(`?limit=100&before=${encodeURIComponent(before)}&currentVersionId=${encodeURIComponent(head)}`);
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), { libraryItemId: id, query: { limit: 100, before, currentVersionId: head } });
  });
  it("rejects unknown, repeated, malformed and unpinned query inputs without reading history", async () => {
    for (const query of ["?limit=101", "?limit=0", "?limit=1e2", "?limit=2.5", "?limit=", "?limit=1&limit=2",
      "?before=bad", `?before=${encodeURIComponent(head)}`, `?currentVersionId=${encodeURIComponent(head)}`,
      "?tenantId=other", "?offset=0", "?currentVersionId=a&currentVersionId=b"]) {
      const response = await request(query);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect((await request("", "library:mission_artifact:unsupported")).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("rechecks current authentication on every read and gives private denial responses", async () => {
    for (const status of [401, 403]) {
      mocks.authorize.mockRejectedValueOnce(new SecurityPolicyError("Current access unavailable.", status));
      const response = await request();
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: status === 401 ? "Unauthorized" : "Forbidden", message: "Current access unavailable." });
    }
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("distinguishes inaccessible sources and stale page heads without returning stale metadata", async () => {
    for (const error of [new LibraryHistoryError("library_history_unavailable", 404, "Current source unavailable."),
      new LibraryHistoryError("library_history_changed", 409, "Reload current history.")]) {
      mocks.list.mockRejectedValueOnce(error);
      const response = await request();
      expect(response.status).toBe(error.status);
      expect(await response.json()).toEqual({ error: error.message, code: error.code, ...(error.status === 409 ? { reload: true } : {}) });
    }
  });
  it("does not expose database details or a previous success when storage is unavailable", async () => {
    await request();
    mocks.list.mockRejectedValueOnce(new Error("PRIVATE_DATABASE_DETAIL"));
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Library history is temporarily unavailable.", code: "library_history_read_unavailable" });
  });
});
