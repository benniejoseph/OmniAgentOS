import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSecrets: vi.fn(), saveGrant: vi.fn(), updateState: vi.fn(), refresh: vi.fn(), ingest: vi.fn(), remove: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/lib/connectors/oauth-store", () => ({
  getOAuthGrantSecrets: mocks.getSecrets,
  saveOAuthGrant: mocks.saveGrant,
  updateOAuthSyncState: mocks.updateState,
}));
vi.mock("@/lib/connectors/oauth-providers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/connectors/oauth-providers")>(),
  refreshOAuthAccess: mocks.refresh,
}));
vi.mock("@/lib/rag/retriever", () => ({ ingestTextDocument: mocks.ingest }));
vi.mock("@/lib/rag/store", () => ({ deleteKnowledgeDocumentByIdempotencyKey: mocks.remove }));

import { syncPersonalProvider } from "@/lib/connectors/personal-sync";

describe("personal OAuth synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.getSecrets.mockResolvedValue({
      grant: { expiresAt: new Date(Date.now() + 3600_000).toISOString(), scopes: [] },
      tokens: { access_token: "access" },
      syncCursor: undefined,
    });
    mocks.updateState.mockResolvedValue({ syncStatus: "healthy" });
    mocks.ingest.mockResolvedValue({}); mocks.remove.mockResolvedValue("removed");
  });

  it("imports Google mail, calendar, and Drive updates and persists sync health", async () => {
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/messages?")) return json({ messages: [{ id: "m1" }] });
      if (url.endsWith("/profile")) return json({ historyId: "h2" });
      if (url.includes("/messages/m1")) return json({ id: "m1", snippet: "Decision made", payload: { headers: [{ name: "Subject", value: "Project decision" }, { name: "From", value: "a@example.com" }] } });
      if (url.includes("calendar")) return json({ nextSyncToken: "c2", items: [{ id: "e1", summary: "Planning", status: "confirmed", start: { dateTime: "2026-08-26T10:00:00Z" }, end: { dateTime: "2026-08-26T11:00:00Z" } }, { id: "e0", status: "cancelled" }] });
      if (url.includes("/drive/v3/files")) return json({ files: [{ id: "d1", name: "Project brief.pdf", mimeType: "application/pdf", modifiedTime: "2026-08-25T10:00:00Z", webViewLink: "https://drive.google.com/file/d1" }] });
      throw new Error(`Unexpected URL ${url}`);
    });
    const result = await syncPersonalProvider({ tenantId: "personal", actorId: "owner", provider: "google" });
    expect(result).toMatchObject({ imported: 3, removed: 1, cursorAdvanced: true });
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "oauth:google:mail:m1" }));
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "oauth:google:calendar:e1" }));
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "oauth:google:drive:d1" }));
    expect(mocks.remove).toHaveBeenCalledWith("oauth:google:calendar:e0", { tenantId: "personal" });
    expect(mocks.updateState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "healthy", syncedItems: 3 }));
  });
});

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
