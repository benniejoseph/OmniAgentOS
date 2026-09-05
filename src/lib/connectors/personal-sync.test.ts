import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimLease: vi.fn(), getSecrets: vi.fn(), saveGrant: vi.fn(), updateState: vi.fn(), refresh: vi.fn(), ingest: vi.fn(), remove: vi.fn(), observeDrive: vi.fn(), observeCanonicalDrive: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/lib/connectors/oauth-store", () => ({
  claimOAuthSyncLease: mocks.claimLease,
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
    mocks.claimLease.mockResolvedValue({
      status: "claimed",
      lease: {
        ownerId: "sync-owner",
        generation: 1,
        expiresAt: "2026-09-05T22:00:00.000Z",
      },
    });
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
    expect(mocks.updateState).toHaveBeenCalledTimes(4);
    expect(mocks.updateState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "healthy",
        lease: expect.objectContaining({
          ownerId: "sync-owner",
          generation: 1,
        }),
        releaseLease: true,
      }),
    );
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

  it("commits successful source cursors when a sibling source fails", async () => {
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("gmail.googleapis.com")) {
        throw new Error("Gmail is temporarily unavailable.");
      }
      if (url.includes("calendar")) {
        return json({
          nextSyncToken: "calendar-partial",
          items: [{
            id: "event-partial",
            etag: "event-partial-v1",
            created: "2026-08-26T08:00:00Z",
            updated: "2026-08-26T09:00:00Z",
            summary: "Independent settlement",
            status: "confirmed",
            start: { dateTime: "2026-08-26T10:00:00Z" },
            end: { dateTime: "2026-08-26T11:00:00Z" },
          }],
        });
      }
      if (url.includes("/drive/v3/files")) {
        return json({
          files: [{
            id: "drive-partial",
            name: "Independent source.txt",
            mimeType: "text/plain",
            createdTime: "2026-08-25T10:00:00Z",
            modifiedTime: "2026-08-26T10:00:00Z",
            version: "2",
            size: "0",
          }],
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await syncPersonalProvider({
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
    });

    expect(result).toMatchObject({
      status: "partial",
      imported: 2,
      removed: 0,
      cursorAdvanced: true,
      sources: [
        { source: "mail", status: "error", imported: 0 },
        { source: "calendar", status: "healthy", imported: 1 },
        { source: "drive", status: "healthy", imported: 1 },
      ],
    });
    expect(mocks.ingest).not.toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(":mail:"),
      }),
    );
    expect(mocks.updateState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "error",
        cursor: expect.stringContaining("calendar-partial"),
        error: expect.stringContaining("mail:"),
      }),
    );
    const finalCursor = JSON.parse(
      mocks.updateState.mock.calls.at(-1)?.[0].cursor,
    ) as Record<string, unknown>;
    expect(finalCursor).toMatchObject({ calendar: "calendar-partial" });
    expect(finalCursor.driveModifiedAfter).toEqual(expect.any(String));
    expect(finalCursor).not.toHaveProperty("gmailHistoryId");
  });

  it("does not advance a source cursor past a failed item page", async () => {
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/messages?")) return json({ messages: [] });
      if (url.endsWith("/profile")) return json({ historyId: "mail-safe" });
      if (url.includes("calendar")) {
        return json({ nextSyncToken: "calendar-safe", items: [] });
      }
      if (url.includes("/drive/v3/files")) {
        return json({
          files: [{
            id: "drive-fails",
            name: "Failing item.txt",
            mimeType: "text/plain",
            createdTime: "2026-08-25T10:00:00Z",
            modifiedTime: "2026-08-26T10:00:00Z",
            version: "4",
            size: "0",
          }],
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    mocks.ingest.mockImplementation(async (input: { idempotencyKey: string }) => {
      if (input.idempotencyKey.endsWith(":drive:drive-fails")) {
        throw new Error("Injected mid-page failure.");
      }
      return {};
    });

    const result = await syncPersonalProvider({
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
    });

    expect(result).toMatchObject({
      status: "partial",
      sources: [
        { source: "mail", status: "healthy" },
        { source: "calendar", status: "healthy" },
        { source: "drive", status: "error" },
      ],
    });
    const finalCursor = JSON.parse(
      mocks.updateState.mock.calls.at(-1)?.[0].cursor,
    ) as Record<string, unknown>;
    expect(finalCursor).toMatchObject({
      gmailHistoryId: "mail-safe",
      calendar: "calendar-safe",
    });
    expect(finalCursor).not.toHaveProperty("driveModifiedAfter");
    expect(finalCursor).not.toHaveProperty("drivePageToken");
  });

  it("persists independent continuation tokens after one bounded page", async () => {
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/messages?")) {
        return json({ messages: [], nextPageToken: "gmail-page-2" });
      }
      if (url.endsWith("/profile")) return json({ historyId: "gmail-fence" });
      if (url.includes("calendar")) {
        return json({ items: [], nextPageToken: "calendar-page-2" });
      }
      if (url.includes("/drive/v3/files")) {
        return json({ files: [], nextPageToken: "drive-page-2" });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    await syncPersonalProvider({
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
    });

    const finalCursor = JSON.parse(
      mocks.updateState.mock.calls.at(-1)?.[0].cursor,
    ) as Record<string, unknown>;
    expect(finalCursor).toMatchObject({
      gmailBackfillPageToken: "gmail-page-2",
      gmailBackfillHistoryId: "gmail-fence",
      calendarPageToken: "calendar-page-2",
      drivePageToken: "drive-page-2",
    });
    expect(finalCursor.calendarTimeMin).toEqual(expect.any(String));
    expect(finalCursor.calendarTimeMax).toEqual(expect.any(String));
    expect(finalCursor.driveWindowStart).toEqual(expect.any(String));
    expect(finalCursor.driveWindowEnd).toEqual(expect.any(String));
    expect(finalCursor).not.toHaveProperty("gmailHistoryId");
    expect(finalCursor).not.toHaveProperty("calendar");
    expect(finalCursor).not.toHaveProperty("driveModifiedAfter");
  });
});

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
