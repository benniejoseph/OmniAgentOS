import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), exact: vi.fn() }));
vi.mock("@/lib/db/client", async (original) => ({ ...(await original<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope: (handler: (...args: never[]) => Promise<Response>) => handler }));
vi.mock("@/lib/security/guard", async (original) => ({ ...(await original<typeof import("@/lib/security/guard")>()), authorizeRequest: mocks.authorize }));
vi.mock("@/lib/app-services/library-history", () => ({ showWorkspaceLibraryVersionService: mocks.exact }));
import { GET } from "./route";
import { LibraryHistoryError } from "@/lib/library/history-contracts";
import { SecurityPolicyError } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";
const context: SecurityContext = { tenantId: "tenant-a", actorId: "owner@example.test", role: "viewer", source: "session" };
const id = "library:source_item:source:one", versionId = "version:source_item:source:one:revision:older/+";
const data = { version: { versionId }, authorityEffect: "none" }, receipt = { operation: "app.library.versions.show" };
function request(query = "", targetVersion = versionId) {
  return GET(new Request(`http://localhost/api/library/${encodeURIComponent(id)}/versions/${encodeURIComponent(targetVersion)}${query}`),
    { params: Promise.resolve({ id, versionId: targetVersion }) });
}
beforeEach(() => {
  mocks.authorize.mockReset().mockResolvedValue(context);
  mocks.exact.mockReset().mockResolvedValue({ data, receipt });
});
describe("Library exact historical metadata route", () => {
  it("preserves the full source and version keys with a dedicated read receipt", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ action: "read", resourceType: "workspace_library_item", resourceId: id }));
    expect(mocks.exact).toHaveBeenCalledWith(expect.objectContaining({ context }), { libraryItemId: id, versionId, query: {} });
    expect(await response.json()).toEqual({ ...data, serviceReceipt: receipt });
  });
  it("passes an optional exact current-head pin without treating it as historical attachment authority", async () => {
    const currentVersionId = "version:source_item:source:one:revision:current";
    expect((await request(`?currentVersionId=${encodeURIComponent(currentVersionId)}`)).status).toBe(200);
    expect(mocks.exact).toHaveBeenCalledWith(expect.anything(), { libraryItemId: id, versionId, query: { currentVersionId } });
  });
  it("rejects unsupported and repeated queries, malformed IDs and attachment flags", async () => {
    for (const query of ["?limit=1", "?currentVersionId=bad", "?currentVersionId=a&currentVersionId=b", "?download=true", "?attach=true", "?actorId=other"]) {
      expect((await request(query)).status, query).toBe(400);
    }
    expect((await request("", "revision-without-source-binding")).status).toBe(400);
    expect(mocks.exact).not.toHaveBeenCalled();
  });
  it("returns current authorization failures before accessing historical metadata", async () => {
    for (const status of [401, 403]) {
      mocks.authorize.mockRejectedValueOnce(new SecurityPolicyError("Current access unavailable.", status));
      const response = await request();
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.exact).not.toHaveBeenCalled();
  });
  it("does not substitute the current version for a missing historical version", async () => {
    mocks.exact.mockRejectedValueOnce(new LibraryHistoryError("library_version_not_found", 404, "Exact version unavailable."));
    const response = await request();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Exact version unavailable.", code: "library_version_not_found" });
  });
  it("returns explicit reload on a head race and a private generic failure for storage uncertainty", async () => {
    mocks.exact.mockRejectedValueOnce(new LibraryHistoryError("library_history_changed", 409, "Reload current history."));
    const changed = await request();
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: "library_history_changed", reload: true });
    mocks.exact.mockRejectedValueOnce(new Error("PRIVATE_HISTORY_DETAIL"));
    const unavailable = await request();
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("private, no-store");
    expect(await unavailable.json()).toEqual({ error: "Library version is temporarily unavailable.", code: "library_history_read_unavailable" });
  });
});
