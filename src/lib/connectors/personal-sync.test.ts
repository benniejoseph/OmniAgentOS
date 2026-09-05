import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSecrets: vi.fn(), saveGrant: vi.fn(), updateState: vi.fn(), refresh: vi.fn(), ingest: vi.fn(), remove: vi.fn(), observeDrive: vi.fn(), observeCanonicalDrive: vi.fn(), fetch: vi.fn(),
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
vi.mock("@/lib/connectors/google-drive-shadow", () => ({
  observeGoogleDriveShadow: mocks.observeDrive,
}));
vi.mock("@/lib/connectors/google-drive-canonical", () => ({
  observeGoogleDriveCanonicalMetadata: mocks.observeCanonicalDrive,
}));
vi.mock("@/lib/rag/retriever", () => ({ ingestTextDocument: mocks.ingest }));
vi.mock("@/lib/rag/store", () => ({ deleteKnowledgeDocumentByIdempotencyKey: mocks.remove }));

import { syncPersonalProvider } from "@/lib/connectors/personal-sync";

describe("personal OAuth synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.getSecrets.mockResolvedValue({
      grant: {
        id: "google-grant",
        tenantId: "personal",
        actorId: "owner",
        provider: "google",
        status: "active",
        authorizationGeneration: 1,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: [],
      },
      tokens: { access_token: "access" },
      syncCursor: undefined,
    });
    mocks.updateState.mockResolvedValue({ syncStatus: "healthy" });
    mocks.observeDrive.mockResolvedValue({ status: "shadow_observed" });
    mocks.observeCanonicalDrive.mockResolvedValue({ status: "settled" });
    mocks.ingest.mockResolvedValue({}); mocks.remove.mockResolvedValue("removed");
  });

  it("imports Google mail, calendar, and Drive updates and persists sync health", async () => {
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/messages?")) return json({ messages: [{ id: "m1" }] });
      if (url.endsWith("/profile")) return json({ historyId: "h2" });
      if (url.includes("/messages/m1")) return json({ id: "m1", historyId: "h1", internalDate: "1787695200000", snippet: "Decision made", payload: { headers: [{ name: "Subject", value: "Project decision" }, { name: "From", value: "a@example.com" }] } });
      if (url.includes("calendar")) return json({ nextSyncToken: "c2", items: [{ id: "e1", etag: "event-v1", created: "2026-08-25T10:00:00Z", updated: "2026-08-26T09:00:00Z", summary: "Planning", status: "confirmed", start: { dateTime: "2026-08-26T10:00:00Z" }, end: { dateTime: "2026-08-26T11:00:00Z" } }, { id: "e0", status: "cancelled" }] });
      if (url.includes("/drive/v3/files")) return json({ files: [{ id: "d1", name: "Project brief.pdf", mimeType: "application/pdf", createdTime: "2026-08-24T10:00:00Z", modifiedTime: "2026-08-25T10:00:00Z", version: "7", webViewLink: "https://drive.google.com/file/d1" }] });
      throw new Error(`Unexpected URL ${url}`);
    });
    const result = await syncPersonalProvider({ tenantId: "personal", actorId: "owner", provider: "google" });
    expect(result).toMatchObject({ imported: 3, removed: 1, cursorAdvanced: true });
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "oauth:google:mail:m1" }));
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "oauth:google:calendar:e1" }));
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "oauth:google:drive:d1" }));
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "oauth:google:mail:m1",
        sourceLineage: expect.objectContaining({
          connectionId: "google-grant",
          adapterId: "google.personal_sync.mail",
          externalItemId: "mail:m1",
          providerRevisionId: "h1",
          sourceKind: "email",
          capturedAt: "2026-08-25T22:00:00.000Z",
        }),
      }),
    );
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "oauth:google:calendar:e1",
        sourceLineage: expect.objectContaining({
          adapterId: "google.personal_sync.calendar",
          providerRevisionId: "event-v1",
          sourceKind: "calendar_event",
          capturedAt: "2026-08-26T09:00:00.000Z",
        }),
      }),
    );
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "oauth:google:drive:d1",
        sourceLineage: expect.objectContaining({
          adapterId: "google.personal_sync.drive",
          providerRevisionId: "7",
          sourceKind: "file",
          capturedAt: "2026-08-25T10:00:00.000Z",
        }),
      }),
    );
    expect(mocks.remove).toHaveBeenCalledWith("oauth:google:calendar:e0", { tenantId: "personal" });
    expect(mocks.updateState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "healthy", syncedItems: 3 }));
  });

  it("reconciles a removed Gmail message without failing the full sync", async () => {
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/messages?")) return json({ messages: [{ id: "gone" }] });
      if (url.endsWith("/profile")) return json({ historyId: "h3" });
      if (url.includes("/messages/gone")) return json({}, 404);
      if (url.includes("calendar")) return json({ nextSyncToken: "c3", items: [] });
      if (url.includes("/drive/v3/files")) return json({ files: [] });
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(
      syncPersonalProvider({ tenantId: "personal", actorId: "owner", provider: "google" }),
    ).resolves.toMatchObject({ imported: 0, removed: 1 });
    expect(mocks.remove).toHaveBeenCalledWith("oauth:google:mail:gone", {
      tenantId: "personal",
    });
    expect(mocks.updateState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "healthy" }),
    );
  });

  it("keeps Drive metadata when a listed Google document cannot be exported", async () => {
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/messages?")) return json({ messages: [] });
      if (url.endsWith("/profile")) return json({ historyId: "h4" });
      if (url.includes("calendar")) return json({ nextSyncToken: "c4", items: [] });
      if (url.includes("/drive/v3/files?")) return json({ files: [{ id: "d404", name: "Moved brief", mimeType: "application/vnd.google-apps.document", createdTime: "2026-08-25T10:00:00Z", modifiedTime: "2026-08-26T10:00:00Z", version: "3" }] });
      if (url.includes("/drive/v3/files/d404/export")) return new Response("missing", { status: 404 });
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(
      syncPersonalProvider({ tenantId: "personal", actorId: "owner", provider: "google" }),
    ).resolves.toMatchObject({ imported: 1, removed: 0 });
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "oauth:google:drive:d404",
        content: expect.stringContaining("File: Moved brief"),
      }),
    );
  });
});

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
