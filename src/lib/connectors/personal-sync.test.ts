import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimLease: vi.fn(), getSecrets: vi.fn(), saveGrant: vi.fn(), updateState: vi.fn(), refresh: vi.fn(), ingest: vi.fn(), remove: vi.fn(), getDocument: vi.fn(), projectCalendar: vi.fn(), cancelCalendar: vi.fn(), mapInbound: vi.fn(), observeDrive: vi.fn(), observeCanonicalDrive: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/lib/connectors/oauth-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/connectors/oauth-store")>(),
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
vi.mock("@/lib/rag/store", () => ({ deleteKnowledgeDocumentByIdempotencyKey: mocks.remove, getKnowledgeDocumentByIdempotencyKey: mocks.getDocument }));
vi.mock("@/lib/meetings/google-calendar-projection", () => ({ projectGoogleCalendarMeeting: mocks.projectCalendar, cancelGoogleCalendarMeeting: mocks.cancelCalendar }));
vi.mock("@/lib/communications/store", () => ({ mapInboundCommunication: mocks.mapInbound }));

import { syncPersonalProvider } from "@/lib/connectors/personal-sync";
import { getDatabaseActorContext } from "@/lib/db/client";

const GOOGLE_SYNC_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
];

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
        scopes: GOOGLE_SYNC_SCOPES,
      },
      tokens: { access_token: "access" },
      credentialState: "active",
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
    mocks.ingest.mockResolvedValue({}); mocks.remove.mockResolvedValue("removed"); mocks.getDocument.mockResolvedValue(undefined); mocks.projectCalendar.mockResolvedValue({}); mocks.cancelCalendar.mockResolvedValue({});
  });

  it("imports Google mail, calendar, and Drive updates and persists sync health", async () => {
    mocks.ingest.mockImplementation(async () => {
      expect(getDatabaseActorContext()).toEqual(["owner"]);
      return {};
    });
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/messages?")) return json({ messages: [{ id: "m1" }] });
      if (url.endsWith("/profile")) return json({ historyId: "h2" });
      if (url.includes("/messages/m1")) return json({ id: "m1", threadId: "thread-1", historyId: "h1", internalDate: "1787695200000", snippet: "Decision made", payload: { headers: [{ name: "Subject", value: "Project decision" }, { name: "From", value: "a@example.com" }, { name: "To", value: "owner@example.com" }] } });
      if (url.includes("calendar")) return json({ nextSyncToken: "c2", items: [{ id: "e1", etag: "event-v1", created: "2026-08-25T10:00:00Z", updated: "2026-08-26T09:00:00Z", summary: "Planning", status: "confirmed", start: { dateTime: "2026-08-26T10:00:00Z" }, end: { dateTime: "2026-08-26T11:00:00Z" } }, { id: "e0", status: "cancelled" }] });
      if (url.includes("/drive/v3/files")) return json({ files: [{ id: "d1", name: "Project brief.pdf", mimeType: "application/pdf", createdTime: "2026-08-24T10:00:00Z", modifiedTime: "2026-08-25T10:00:00Z", version: "7", webViewLink: "https://drive.google.com/file/d1" }] });
      throw new Error(`Unexpected URL ${url}`);
    });
    const result = await syncPersonalProvider({ tenantId: "personal", actorId: "owner", provider: "google" });
    expect(result).toMatchObject({ imported: 3, removed: 1, cursorAdvanced: true });
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "oauth:google:mail:m1",
      deferMemoryGraphIndex: true,
    }));
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "oauth:google:calendar:e1" }));
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "oauth:google:drive:d1" }));
    expect(mocks.mapInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: "m1",
        externalThreadId: "thread-1",
        fromAddress: "a@example.com",
        toAddress: "owner@example.com",
        content: "Decision made",
      }),
      expect.objectContaining({ tenantId: "personal", actorId: "owner" }),
    );
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
    expect(mocks.remove).toHaveBeenCalledWith(
      "oauth:google:calendar:e0",
      expect.objectContaining({
        tenantId: "personal",
        executionScope: expect.objectContaining({
          initiatingActorId: "owner",
          executingPrincipalType: "system",
          executingPrincipalId: "connector.google.personal_sync",
        }),
      }),
    );
    expect(mocks.updateState).toHaveBeenCalledTimes(4);
    expect(mocks.updateState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "healthy",
        lease: expect.objectContaining({
          ownerId: "sync-owner",
          generation: 1,
        }),
        releaseLease: true,
        sourceSettlements: expect.arrayContaining([
          expect.objectContaining({ source: "mail", status: "healthy", backfillState: "complete" }),
          expect.objectContaining({ source: "calendar", status: "healthy", backfillState: "complete" }),
          expect.objectContaining({ source: "drive", status: "healthy", backfillState: "complete" }),
        ]),
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
      executionScope: expect.objectContaining({
        initiatingActorId: "owner",
        executingPrincipalType: "system",
        executingPrincipalId: "connector.google.personal_sync",
      }),
    });
    expect(mocks.updateState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "healthy" }),
    );
  });

  it("replaces a changed provider revision after an immutable document conflict", async () => {
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/messages?")) return json({ messages: [] });
      if (url.endsWith("/profile")) return json({ historyId: "h-replace" });
      if (url.includes("calendar")) {
        return json({
          nextSyncToken: "calendar-replace",
          items: [{
            id: "event-replace",
            etag: "event-v2",
            created: "2026-08-25T10:00:00Z",
            updated: "2026-08-26T09:00:00Z",
            summary: "Changed event",
            status: "confirmed",
            start: { dateTime: "2026-08-26T10:00:00Z" },
            end: { dateTime: "2026-08-26T11:00:00Z" },
          }],
        });
      }
      if (url.includes("/drive/v3/files")) return json({ files: [] });
      throw new Error(`Unexpected URL ${url}`);
    });
    mocks.ingest
      .mockRejectedValueOnce(new Error(
        "Knowledge document idempotency key is already bound to different content.",
      ))
      .mockResolvedValue({});

    await expect(syncPersonalProvider({
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
    })).resolves.toMatchObject({ imported: 1, removed: 0 });

    expect(mocks.remove).toHaveBeenCalledWith(
      "oauth:google:calendar:event-replace",
      expect.objectContaining({
        tenantId: "personal",
        executionScope: expect.objectContaining({
          initiatingActorId: "owner",
          executingPrincipalType: "system",
          executingPrincipalId: "connector.google.personal_sync",
        }),
      }),
    );
    expect(mocks.ingest).toHaveBeenCalledTimes(2);
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
    expect(mocks.updateState).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "syncing",
      releaseLease: true,
    }));
    expect(mocks.observeCanonicalDrive).toHaveBeenCalledTimes(1);
    expect(mocks.observeDrive).toHaveBeenCalledTimes(1);
    expect(mocks.observeCanonicalDrive.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.updateState.mock.invocationCallOrder.at(-1) || 0,
    );
    expect(mocks.observeDrive.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.observeCanonicalDrive.mock.invocationCallOrder[0],
    );
  });

  it("uses small provider pages so maintenance backfills remain resumable", async () => {
    const requestedUrls: string[] = [];
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/messages?")) return json({ messages: [] });
      if (url.endsWith("/profile")) return json({ historyId: "bounded-mail" });
      if (url.includes("calendar")) {
        return json({ nextSyncToken: "bounded-calendar", items: [] });
      }
      if (url.includes("/drive/v3/files")) return json({ files: [] });
      throw new Error(`Unexpected URL ${url}`);
    });

    await syncPersonalProvider({
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
    });

    const gmailUrl = new URL(
      requestedUrls.find((url) => url.includes("/messages?"))!,
    );
    const calendarUrl = new URL(
      requestedUrls.find((url) => url.includes("calendar"))!,
    );
    const driveUrl = new URL(
      requestedUrls.find((url) => url.includes("/drive/v3/files"))!,
    );
    expect(gmailUrl.searchParams.get("maxResults")).toBe("5");
    expect(calendarUrl.searchParams.get("maxResults")).toBe("10");
    expect(driveUrl.searchParams.get("pageSize")).toBe("3");
  });

  it("persists oversized Gmail history work as bounded encrypted-cursor input", async () => {
    mocks.getSecrets.mockResolvedValue({
      grant: {
        id: "google-grant",
        tenantId: "personal",
        actorId: "owner",
        provider: "google",
        status: "active",
        authorizationGeneration: 1,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: GOOGLE_SYNC_SCOPES,
      },
      tokens: { access_token: "access" },
      credentialState: "active",
      syncCursor: JSON.stringify({ gmailHistoryId: "history-start" }),
    });
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/history?")) {
        expect(new URL(url).searchParams.get("maxResults")).toBe("10");
        return json({
          historyId: "history-fence",
          history: [{
            messagesAdded: Array.from({ length: 7 }, (_, index) => ({
              message: { id: `mail-${index + 1}` },
            })),
            messagesDeleted: [{ message: { id: "mail-deleted" } }],
          }],
        });
      }
      if (url.includes("/messages/mail-")) {
        const id = url.match(/messages\/(mail-\d+)/)?.[1] || "mail";
        return json({
          id,
          threadId: `thread-${id}`,
          historyId: "history-fence",
          internalDate: "1787695200000",
          snippet: id,
          payload: { headers: [] },
        });
      }
      if (url.includes("calendar")) {
        return json({ nextSyncToken: "calendar-complete", items: [] });
      }
      if (url.includes("/drive/v3/files")) return json({ files: [] });
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await syncPersonalProvider({
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
    });

    expect(result.sources[0]).toMatchObject({
      source: "mail",
      status: "syncing",
      imported: 5,
    });
    const finalCursor = JSON.parse(
      mocks.updateState.mock.calls.at(-1)?.[0].cursor,
    ) as Record<string, unknown>;
    expect(finalCursor).toMatchObject({
      gmailHistoryId: "history-start",
      gmailPendingHistoryId: "history-fence",
      gmailPendingAddedIds: ["mail-6", "mail-7"],
      gmailPendingDeletedIds: ["mail-deleted"],
    });
    expect(mocks.ingest).toHaveBeenCalledTimes(5);

    mocks.getSecrets.mockResolvedValue({
      grant: {
        id: "google-grant",
        tenantId: "personal",
        actorId: "owner",
        provider: "google",
        status: "active",
        authorizationGeneration: 1,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: GOOGLE_SYNC_SCOPES,
      },
      tokens: { access_token: "access" },
      credentialState: "active",
      syncCursor: JSON.stringify(finalCursor),
    });
    mocks.ingest.mockClear();
    mocks.remove.mockClear();
    mocks.updateState.mockClear();

    const resumed = await syncPersonalProvider({
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
    });

    expect(resumed.sources[0]).toMatchObject({
      source: "mail",
      status: "healthy",
      imported: 2,
      removed: 1,
    });
    const resumedCursor = JSON.parse(
      mocks.updateState.mock.calls.at(-1)?.[0].cursor,
    ) as Record<string, unknown>;
    expect(resumedCursor).toMatchObject({ gmailHistoryId: "history-fence" });
    expect(resumedCursor).not.toHaveProperty("gmailPendingHistoryId");
    expect(resumedCursor).not.toHaveProperty("gmailPendingAddedIds");
    expect(resumedCursor).not.toHaveProperty("gmailPendingDeletedIds");
    expect(mocks.ingest).toHaveBeenCalledTimes(2);
    expect(mocks.remove).toHaveBeenCalledWith(
      "oauth:google:mail:mail-deleted",
      expect.objectContaining({
        tenantId: "personal",
        executionScope: expect.objectContaining({
          initiatingActorId: "owner",
          executingPrincipalId: "connector.google.personal_sync",
        }),
      }),
    );
  });

  it("settles the legacy sync lease before running Drive sidecars serially", async () => {
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/messages?")) return json({ messages: [] });
      if (url.endsWith("/profile")) return json({ historyId: "mail-settled" });
      if (url.includes("calendar")) {
        return json({ nextSyncToken: "calendar-settled", items: [] });
      }
      if (url.includes("/drive/v3/files")) return json({ files: [] });
      throw new Error(`Unexpected URL ${url}`);
    });
    let finishCanonical!: () => void;
    mocks.observeCanonicalDrive.mockReturnValue(new Promise((resolve) => {
      finishCanonical = () => resolve({ status: "canonical_settled" });
    }));

    const syncing = syncPersonalProvider({
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
    });

    await vi.waitFor(() => {
      expect(mocks.observeCanonicalDrive).toHaveBeenCalledTimes(1);
    });
    expect(mocks.updateState).toHaveBeenLastCalledWith(
      expect.objectContaining({ releaseLease: true }),
    );
    expect(mocks.observeCanonicalDrive.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.updateState.mock.invocationCallOrder.at(-1) || 0,
    );
    expect(mocks.observeDrive).not.toHaveBeenCalled();

    finishCanonical();
    await syncing;

    expect(mocks.observeDrive).toHaveBeenCalledTimes(1);
    expect(mocks.observeDrive.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.observeCanonicalDrive.mock.invocationCallOrder[0],
    );
  });

  it("calls only the Google sources granted to this connection", async () => {
    mocks.getSecrets.mockResolvedValue({
      grant: {
        id: "google-grant",
        tenantId: "personal",
        actorId: "owner",
        provider: "google",
        status: "active",
        authorizationGeneration: 1,
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      },
      tokens: { access_token: "access" },
      credentialState: "active",
      syncCursor: undefined,
    });
    const requestedUrls: string[] = [];
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/profile")) return json({ historyId: "mail-only" });
      if (url.includes("/messages?")) return json({ messages: [] });
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(syncPersonalProvider({
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
    })).resolves.toMatchObject({
      status: "healthy",
      sources: [{ source: "mail", status: "healthy" }],
    });
    expect(requestedUrls.some((url) => url.includes("calendar"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("/drive/"))).toBe(false);
    expect(mocks.observeCanonicalDrive).not.toHaveBeenCalled();
    expect(mocks.observeDrive).not.toHaveBeenCalled();
  });

  it("replays existing Calendar events once before returning to incremental tokens", async () => {
    mocks.getSecrets.mockResolvedValue({
      grant: {
        id: "google-grant",
        tenantId: "personal",
        actorId: "owner",
        provider: "google",
        status: "active",
        authorizationGeneration: 1,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: GOOGLE_SYNC_SCOPES,
      },
      tokens: { access_token: "access" },
      credentialState: "active",
      syncCursor: JSON.stringify({ calendar: "old-incremental-token" }),
    });
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("www.googleapis.com");
      expect(url.pathname).toContain("/calendar/v3/");
      expect(url.searchParams.has("syncToken")).toBe(false);
      expect(url.searchParams.has("timeMin")).toBe(true);
      return json({ nextSyncToken: "fresh-incremental-token", items: [] });
    });

    await expect(syncPersonalProvider({
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
      sources: ["calendar"],
    })).resolves.toMatchObject({ status: "healthy", imported: 0 });

    expect(mocks.updateState).toHaveBeenCalledWith(expect.objectContaining({
      cursor: expect.stringContaining('"calendarMeetingProjectionVersion":1'),
    }));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("projects existing Calendar evidence before the heavier knowledge refresh", async () => {
    mocks.getDocument.mockResolvedValue({
      sourceItemId: "source-item-existing",
      sourceRevisionId: "source-revision-existing",
    });
    mocks.fetch.mockResolvedValue(json({
      nextSyncToken: "calendar-complete",
      items: [{
        id: "event-existing",
        etag: "event-existing-v1",
        created: "2026-09-10T10:00:00Z",
        updated: "2026-09-11T09:00:00Z",
        summary: "Existing calendar meeting",
        status: "confirmed",
        start: { dateTime: "2026-09-12T10:00:00Z" },
        end: { dateTime: "2026-09-12T11:00:00Z" },
      }],
    }));
    const order: string[] = [];
    mocks.projectCalendar.mockImplementation(async () => {
      order.push("project");
      return {};
    });
    mocks.ingest.mockImplementation(async () => {
      order.push("ingest");
      return {
        document: {
          sourceItemId: "source-item-existing",
          sourceRevisionId: "source-revision-existing",
        },
      };
    });

    await syncPersonalProvider({
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
      sources: ["calendar"],
    });

    expect(order[0]).toBe("project");
    expect(mocks.projectCalendar).toHaveBeenCalledWith(expect.objectContaining({
      sourceItemId: "source-item-existing",
      sourceRevisionId: "source-revision-existing",
      providerRevisionId: "event-existing-v1",
    }));
  });

  it("releases an interrupted lease without converting progress into an auth error", async () => {
    const abortController = new AbortController();
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/profile")) return json({ historyId: "mail-interrupted" });
      if (url.includes("/messages?")) return json({ messages: [{ id: "m1" }] });
      if (url.includes("/messages/m1")) return json({
        id: "m1",
        internalDate: "1787695200000",
        snippet: "interrupted",
        payload: { headers: [] },
      });
      if (url.includes("calendar")) return json({ nextSyncToken: "calendar-interrupted", items: [] });
      if (url.includes("/drive/v3/files")) return json({ files: [] });
      throw new Error(`Unexpected URL ${url}`);
    });
    mocks.ingest.mockImplementation(async () => {
      abortController.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    await expect(syncPersonalProvider({
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
      abortSignal: abortController.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.updateState).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "syncing",
      error: undefined,
      releaseLease: true,
      sourceSettlements: [],
    }));
  });
});

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
