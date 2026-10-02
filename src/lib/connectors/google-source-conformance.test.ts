import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every Google source the personal sync reads keeps the same contract. It
// pages through a listing and then follows changes from where the listing
// ended. It refuses a page larger than it asked for, retires what the provider
// deleted, and reads only what the connection was granted. It keeps each item
// under one key, bounds what it reads and keeps, fails without failing the
// others, and stops when its connection is revoked. An item that keeps failing
// is set aside, so its source moves on, and is read again later. A source that
// starts over checks again the documents it held, and retires those whose
// item left it meanwhile.

const mocks = vi.hoisted(() => ({
  claimLease: vi.fn(), getSecrets: vi.fn(), updateState: vi.fn(), refresh: vi.fn(), ingest: vi.fn(), remove: vi.fn(), getDocument: vi.fn(), projectCalendar: vi.fn(), cancelCalendar: vi.fn(), mapInbound: vi.fn(), observeDrive: vi.fn(), observeCanonicalDrive: vi.fn(), appendEvent: vi.fn(), listDocuments: vi.fn(),
}));
vi.mock("@/lib/events/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/events/store")>(),
  appendScopedDomainEvent: mocks.appendEvent,
}));
vi.mock("@/lib/connectors/oauth-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/connectors/oauth-store")>(),
  claimOAuthSyncLease: mocks.claimLease,
  getOAuthGrantSecrets: mocks.getSecrets,
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
vi.mock("@/lib/rag/store", async (importOriginal) => ({
  knowledgeDocumentId: (await importOriginal<typeof import("@/lib/rag/store")>()).knowledgeDocumentId,
  deleteKnowledgeDocumentByIdempotencyKey: mocks.remove,
  getKnowledgeDocumentByIdempotencyKey: mocks.getDocument,
  listKnowledgeDocumentsBySourcePrefix: mocks.listDocuments,
}));
vi.mock("@/lib/meetings/google-calendar-projection", () => ({ projectGoogleCalendarMeeting: mocks.projectCalendar, cancelGoogleCalendarMeeting: mocks.cancelCalendar }));
vi.mock("@/lib/communications/store", () => ({ mapInboundCommunication: mocks.mapInbound }));

import { GOOGLE_SOURCE_ADAPTERS } from "@/lib/connectors/google-source-adapters";
import { syncPersonalProvider } from "@/lib/connectors/personal-sync";
import { knowledgeDocumentId } from "@/lib/rag/store";

type SourceId = "mail" | "calendar" | "drive";

const SCOPES: Record<SourceId, string> = {
  mail: "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar.events",
  drive: "https://www.googleapis.com/auth/drive",
};

/**
 * A Google that answers each source from the listing pages and changes a test
 * sets, and serves an item by its id once it was listed or served. A listing's
 * page tokens are `<source>-page-<n>`.
 */
const google = {
  mail: { pages: [[]] as string[][], changes: [] as unknown[], messages: new Map<string, Record<string, unknown>>(), status: 0 },
  calendar: { pages: [[]] as Record<string, unknown>[][], changes: [] as unknown[], items: new Map<string, Record<string, unknown>>(), status: 0 },
  drive: { pages: [[]] as Record<string, unknown>[][], changes: [] as unknown[], items: new Map<string, Record<string, unknown>>(), exports: new Map<string, () => Response>(), downloads: new Map<string, () => Response>(), status: 0 },
};
let requests: URL[] = [];
// Sources whose provider refuses the change position the sync kept.
const refused = new Set<SourceId>();

type SourceCase = {
  source: SourceId;
  /** The most items a listing page may hold, since the sync asks for no more. */
  pageLimit: number;
  /** The cursor field holding the listing's next page. */
  pageTokenKey: string;
  /** The cursor field a finished listing sets, from which changes are followed. */
  changesKey: string;
  /** The cursor a finished listing leaves. */
  changesCursor: Record<string, unknown>;
  followsChanges: (url: URL) => boolean;
  list: (pages: string[][]) => void;
  /** The change feed reports this item deleted. */
  deleteItem: (id: string) => void;
  /** Serves one item, `long`, whose free text is `text`. */
  serveText: (text: string) => void;
  /** Serves an item by its id, without listing it. */
  serve: (id: string) => void;
  /** The revision Google gives an item it serves. */
  revisionOf: (id: string) => string;
};

const SOURCES: SourceCase[] = [
  {
    source: "mail",
    pageLimit: GOOGLE_SOURCE_ADAPTERS.mail.pageLimit,
    pageTokenKey: "gmailBackfillPageToken",
    changesKey: "gmailHistoryId",
    changesCursor: { gmailHistoryId: "mail-history-1" },
    followsChanges: (url) =>
      url.pathname === "/gmail/v1/users/me/history" &&
      url.searchParams.get("startHistoryId") === "mail-history-1",
    list: (pages) => {
      google.mail.pages = pages;
      for (const id of pages.flat()) google.mail.messages.set(id, gmailMessage(id));
    },
    deleteItem: (id) => {
      google.mail.changes = [{ id: "7", messagesDeleted: [{ message: { id } }] }];
    },
    serveText: (text) => {
      google.mail.pages = [["long"]];
      google.mail.messages.set("long", gmailMessage("long", text));
    },
    serve: (id) => {
      google.mail.messages.set(id, gmailMessage(id));
    },
    revisionOf: () => "mail-history-1",
  },
  {
    source: "calendar",
    pageLimit: GOOGLE_SOURCE_ADAPTERS.calendar.pageLimit,
    pageTokenKey: "calendarPageToken",
    changesKey: "calendar",
    changesCursor: { calendar: "calendar-sync", calendarMeetingProjectionVersion: 1 },
    followsChanges: (url) => url.searchParams.get("syncToken") === "calendar-sync",
    list: (pages) => {
      google.calendar.pages = pages.map((ids) => ids.map((id) => calendarEvent(id)));
      for (const id of pages.flat()) google.calendar.items.set(id, calendarEvent(id));
    },
    deleteItem: (id) => {
      google.calendar.changes = [{ id, status: "cancelled" }];
    },
    serveText: (text) => {
      google.calendar.pages = [[calendarEvent("long", text)]];
    },
    serve: (id) => {
      google.calendar.items.set(id, calendarEvent(id));
    },
    revisionOf: (id) => `etag-${id}`,
  },
  {
    source: "drive",
    pageLimit: GOOGLE_SOURCE_ADAPTERS.drive.pageLimit,
    pageTokenKey: "drivePageToken",
    changesKey: "driveChangesStartPageToken",
    changesCursor: { driveChangesStartPageToken: "drive-changes" },
    followsChanges: (url) =>
      url.pathname === "/drive/v3/changes" &&
      url.searchParams.get("pageToken") === "drive-changes",
    list: (pages) => {
      google.drive.pages = pages.map((ids) => ids.map((id) => driveFile(id)));
      for (const id of pages.flat()) google.drive.items.set(id, driveFile(id));
    },
    deleteItem: (id) => {
      // Removal wins over whatever file state the change still carries.
      google.drive.changes = [{
        changeType: "file",
        fileId: id,
        removed: true,
        file: driveFile(id),
      }];
    },
    serveText: (text) => {
      google.drive.pages = [[driveFile("long")]];
      google.drive.exports.set("long", () => new Response(text));
    },
    serve: (id) => {
      google.drive.items.set(id, driveFile(id));
    },
    revisionOf: () => "2",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  google.mail = { pages: [[]], changes: [], messages: new Map(), status: 0 };
  google.calendar = { pages: [[]], changes: [], items: new Map(), status: 0 };
  google.drive = { pages: [[]], changes: [], items: new Map(), exports: new Map(), downloads: new Map(), status: 0 };
  requests = [];
  refused.clear();
  vi.stubGlobal("fetch", fakeGoogle);
  connect({});
  mocks.claimLease.mockResolvedValue({
    status: "claimed",
    lease: { ownerId: "sync-owner", generation: 1, expiresAt: "2026-09-05T22:00:00.000Z" },
  });
  mocks.updateState.mockResolvedValue({ syncStatus: "healthy" });
  mocks.ingest.mockResolvedValue({}); mocks.remove.mockResolvedValue("removed"); mocks.getDocument.mockResolvedValue(undefined); mocks.projectCalendar.mockResolvedValue({}); mocks.cancelCalendar.mockResolvedValue({});
  mocks.observeDrive.mockResolvedValue({ status: "shadow_observed" });
  mocks.observeCanonicalDrive.mockResolvedValue({ status: "settled" });
  mocks.appendEvent.mockResolvedValue({});
  mocks.listDocuments.mockResolvedValue([]);
});

describe.each(SOURCES)("the Google $source source", (c) => {
  it("pages through its listing, then follows changes from where the listing ended", async () => {
    c.list([["one", "two"], ["three"]]);
    await sync({ sources: [c.source] });
    expect(ingestedIds()).toEqual(["one", "two"]);
    expect(savedCursor()).toHaveProperty(c.pageTokenKey, `${c.source}-page-1`);
    expect(savedCursor()).not.toHaveProperty(c.changesKey);

    connect({ cursor: savedCursor() });
    mocks.ingest.mockClear();
    await sync({ sources: [c.source] });
    expect(requests.some((url) =>
      url.searchParams.get("pageToken") === `${c.source}-page-1`
    )).toBe(true);
    expect(ingestedIds()).toEqual(["three"]);
    expect(savedCursor()).toMatchObject(c.changesCursor);
    expect(savedCursor()).not.toHaveProperty(c.pageTokenKey);

    connect({ cursor: savedCursor() });
    requests = [];
    await sync({ sources: [c.source] });
    expect(requests.some(c.followsChanges)).toBe(true);
  });

  it("ingests each item under the adapter it declares", async () => {
    c.list([[`${c.source}-item`]]);

    await sync({ sources: [c.source] });

    expect(mocks.ingest.mock.calls[0][0].sourceLineage).toMatchObject({
      connectionId: "google-grant",
      adapterId: GOOGLE_SOURCE_ADAPTERS[c.source].adapterId,
      adapterVersionId: GOOGLE_SOURCE_ADAPTERS[c.source].adapterVersionId,
      externalItemId: `${c.source}:${c.source}-item`,
      sourceKind: GOOGLE_SOURCE_ADAPTERS[c.source].sourceKind,
    });
  });

  it("refuses a listing page larger than it asked for, and keeps its place", async () => {
    c.list([Array.from({ length: c.pageLimit + 1 }, (_, index) => `item${index}`)]);
    const result = await sync({ sources: [c.source] });
    expect(result.sources).toMatchObject([{
      source: c.source,
      status: "error",
      error: expect.stringContaining("exceeds the requested item limit"),
    }]);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(savedCursor()).toEqual({});
  });

  it("retires an item the provider reports deleted", async () => {
    connect({ cursor: c.changesCursor });
    c.deleteItem("gone");
    mocks.getDocument.mockResolvedValue({
      id: "document-gone",
      sourceItemId: "item-gone",
      sourceRevisionId: "revision-gone",
      metadata: {},
    });
    await expect(sync({ sources: [c.source] })).resolves.toMatchObject({
      imported: 0,
      removed: 1,
    });
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(
      `oauth:google:${c.source}:gone`,
      expect.objectContaining({ tenantId: "personal" }),
    );
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("reads only the source its connection was granted", async () => {
    for (const other of SOURCES) other.list([[`${other.source}-item`]]);
    connect({ scopes: [SCOPES[c.source]] });
    const result = await sync();
    expect(result.sources.map((source) => source.source)).toEqual([c.source]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((url) => sourceOf(url) !== c.source)).toEqual([]);
    expect(ingestedIds()).toEqual([`${c.source}-item`]);
  });

  it("ingests an item under one key and revision on every sync", async () => {
    c.list([["same"]]);
    await sync({ sources: [c.source] });
    await sync({ sources: [c.source] });
    expect(mocks.ingest).toHaveBeenCalledTimes(2);
    const [[first], [second]] = mocks.ingest.mock.calls;
    expect(first).toMatchObject({
      idempotencyKey: `oauth:google:${c.source}:same`,
      source: `google:${c.source}:same`,
      reuseExactCommittedRevision: true,
      sourceLineage: { externalItemId: `${c.source}:same` },
    });
    expect(second).toMatchObject({
      idempotencyKey: first.idempotencyKey,
      source: first.source,
      content: first.content,
      reuseExactCommittedRevision: true,
      sourceLineage: {
        externalItemId: first.sourceLineage.externalItemId,
        providerRevisionId: first.sourceLineage.providerRevisionId,
      },
    });
  });

  it("keeps a long text field to 100,000 characters", async () => {
    // Each of these characters takes three bytes in UTF-8.
    c.serveText("€".repeat(150_000));
    await sync({ sources: [c.source] });
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(occurrences(mocks.ingest.mock.calls[0][0].content, "€")).toBe(100_000);
  });

  it.each([
    [429, "provider_rate_limited"],
    [503, "provider_unavailable"],
  ])("fails alone and keeps its place when Google answers %i", async (status, failureCode) => {
    for (const other of SOURCES) other.list([[`${other.source}-item`]]);
    google[c.source].status = status;
    const result = await sync();
    expect(result.sources.filter((source) => source.status === "error")).toEqual([
      expect.objectContaining({ source: c.source, failureCode }),
    ]);
    expect(ingestedIds()).toEqual(SOURCES
      .filter((other) => other !== c)
      .map((other) => `${other.source}-item`));
    expect(savedCursor()).not.toHaveProperty(c.changesKey);
    for (const other of SOURCES.filter((other) => other !== c)) {
      expect(savedCursor()).toHaveProperty(other.changesKey);
    }
    // A sync that reached any source holds nothing back.
    expect(mocks.updateState).toHaveBeenLastCalledWith(expect.objectContaining({
      releaseLease: true,
      attempt: "succeeded",
    }));
  });

  it("fails alone on an item it cannot ingest, and keeps its place", async () => {
    for (const other of SOURCES) other.list([[`${other.source}-item`]]);
    c.list([[`${c.source}-item`, "poison"]]);
    mocks.ingest.mockImplementation(async (input: { idempotencyKey: string }) => {
      if (input.idempotencyKey.endsWith(":poison")) {
        throw new Error("Embedding request failed.");
      }
      return {};
    });
    const result = await sync();
    expect(result.sources.filter((source) => source.status === "error")).toEqual([
      expect.objectContaining({
        source: c.source,
        failureCode: "processing_failed",
        imported: 1,
      }),
    ]);
    expect(savedCursor()).not.toHaveProperty(c.changesKey);
    for (const other of SOURCES.filter((other) => other !== c)) {
      expect(savedCursor()).toHaveProperty(other.changesKey);
    }
  });
});

describe.each(SOURCES)("the Google $source source, with an item that keeps failing", (c) => {
  const T0 = Date.parse("2026-10-01T00:00:00.000Z");
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const iso = (time: number) => new Date(time).toISOString();
  const quarantine = (cursor = savedCursor()) =>
    (cursor.itemQuarantine as Record<string, unknown> | undefined)?.[c.source];
  // Syncs as of `time`, from `cursor`.
  const syncAt = (time: number, cursor?: Record<string, unknown>) => {
    vi.setSystemTime(time);
    connect({ cursor });
    return sync({ sources: [c.source] });
  };
  const held = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...c.changesCursor,
    itemQuarantine: {
      [c.source]: {
        held: [{
          id: "poison",
          revision: "revision-old",
          since: iso(T0 - 7 * HOUR),
          retryAt: iso(T0),
          redrives: 0,
          ...fields,
        }],
      },
    },
  });
  const failedTwice = () => ({
    itemQuarantine: {
      [c.source]: { failing: { id: "poison", attempts: 2, since: iso(T0 - HOUR) } },
    },
  });
  const readsById = () => requests.filter((url) => url.pathname.endsWith("/poison"));
  const savedCursors = () => mocks.updateState.mock.calls
    .filter(([update]) => typeof update.cursor === "string");
  const storeDocument = () => mocks.getDocument.mockResolvedValue({
    id: "document-poison",
    sourceItemId: "item-poison",
    sourceRevisionId: "revision-poison",
    metadata: {},
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mocks.ingest.mockImplementation(async (input: { idempotencyKey: string }) => {
      if (input.idempotencyKey.endsWith(":poison")) {
        throw new Error("Embedding request failed.");
      }
      return {};
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds its place while the item fails within the hour, then sets it aside and moves on", async () => {
    c.list([[`${c.source}-item`, "poison"]]);
    let cursor: Record<string, unknown> | undefined;
    for (const minutes of [0, 1, 2]) {
      const result = await syncAt(T0 + minutes * MINUTE, cursor);
      expect(result.sources).toMatchObject([{ source: c.source, status: "error" }]);
      // Counting the item's failures does not move the source.
      expect(result.cursorAdvanced).toBe(false);
      cursor = savedCursor();
      expect(cursor).not.toHaveProperty(c.changesKey);
    }
    expect(quarantine(cursor)).toEqual({
      failing: { id: "poison", attempts: 3, since: iso(T0) },
    });
    expect(mocks.appendEvent).not.toHaveBeenCalled();

    const result = await syncAt(T0 + HOUR, cursor);

    expect(result.sources).toMatchObject([{ source: c.source, status: "healthy" }]);
    expect(result.cursorAdvanced).toBe(true);
    expect(savedCursor()).toMatchObject(c.changesCursor);
    expect(quarantine()).toEqual({
      held: [{
        id: "poison",
        revision: c.revisionOf("poison"),
        since: iso(T0),
        retryAt: iso(T0 + 7 * HOUR),
        redrives: 0,
      }],
    });
    expect(mocks.appendEvent).toHaveBeenCalledTimes(1);
    const [event] = mocks.appendEvent.mock.calls[0];
    expect(event).toEqual({
      id: expect.stringMatching(/^source_item_event_[0-9a-f]{56}$/),
      streamId: "connector:google-grant",
      type: "connector.source_item.quarantined",
      executionScope: expect.objectContaining({ tenantId: "personal" }),
      payload: {
        schemaVersion: 1,
        connectionId: "google-grant",
        source: c.source,
        adapterId: GOOGLE_SOURCE_ADAPTERS[c.source].adapterId,
        adapterVersionId: GOOGLE_SOURCE_ADAPTERS[c.source].adapterVersionId,
        itemSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        attempts: 4,
        failureCode: "processing_failed",
      },
    });
    // The record names the item only by its digest.
    expect(JSON.stringify(event)).not.toContain("poison");
  });

  it("holds its place while the item has failed fewer than three times, however long ago", async () => {
    c.list([["poison"]]);
    await syncAt(T0);
    await syncAt(T0 + 90 * MINUTE, savedCursor());
    expect(savedCursor()).not.toHaveProperty(c.changesKey);
    expect(quarantine()).toEqual({
      failing: { id: "poison", attempts: 2, since: iso(T0) },
    });

    await syncAt(T0 + 91 * MINUTE, savedCursor());

    expect(savedCursor()).toMatchObject(c.changesCursor);
    expect(quarantine()).toMatchObject({ held: [{ id: "poison", since: iso(T0) }] });
  });

  it("never sets an item aside for a provider failure", async () => {
    c.list([["poison"]]);
    mocks.ingest.mockRejectedValue(new Error("Connected source returned 429."));
    let cursor: Record<string, unknown> | undefined;
    for (const hours of [0, 1, 2, 3]) {
      const result = await syncAt(T0 + hours * HOUR, cursor);
      expect(result.sources).toMatchObject([{
        source: c.source,
        status: "error",
        failureCode: "provider_rate_limited",
      }]);
      cursor = savedCursor();
    }
    expect(cursor).toEqual({});
  });

  it("holds its place when it already set aside as many items as it keeps", async () => {
    c.list([["poison"]]);
    const full = Array.from({ length: 20 }, (_, index) => ({
      id: `held-${index}`,
      since: iso(T0 - 7 * HOUR),
      retryAt: iso(T0 + HOUR),
      redrives: 0,
    }));
    await syncAt(T0, {
      itemQuarantine: {
        [c.source]: {
          failing: { id: "poison", attempts: 2, since: iso(T0 - 2 * HOUR) },
          held: full,
        },
      },
    });

    expect(savedCursor()).not.toHaveProperty(c.changesKey);
    expect(quarantine()).toEqual({
      failing: { id: "poison", attempts: 3, since: iso(T0 - 2 * HOUR) },
      held: full,
    });
  });

  it("frees due quarantine capacity while a failing item holds the source in place", async () => {
    c.list([["poison"]]);
    const full = Array.from({ length: 20 }, (_, index) => {
      const id = `held-${index}`;
      c.serve(id);
      return {
        id,
        since: iso(T0 - 7 * HOUR),
        retryAt: iso(T0),
        redrives: 0,
      };
    });

    const blocked = await syncAt(T0, {
      itemQuarantine: {
        [c.source]: {
          failing: { id: "poison", attempts: 2, since: iso(T0 - 2 * HOUR) },
          held: full,
        },
      },
    });

    expect(blocked).toMatchObject({ status: "error", imported: 2, cursorAdvanced: false });
    expect(ingestedIds()).toEqual(["poison", "held-0", "held-1"]);
    expect(quarantine()).toEqual({
      failing: { id: "poison", attempts: 3, since: iso(T0 - 2 * HOUR) },
      held: full.slice(2),
    });
    expect(mocks.appendEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "connector.source_item.released",
      "connector.source_item.released",
    ]);

    const recovered = await syncAt(T0 + MINUTE, savedCursor());

    expect(recovered).toMatchObject({ status: "healthy", cursorAdvanced: true });
    expect(savedCursor()).toMatchObject(c.changesCursor);
    expect(quarantine()).toMatchObject({ held: expect.arrayContaining([
      expect.objectContaining({ id: "poison" }),
    ]) });
    expect(quarantine()).not.toHaveProperty("failing");
  });

  it("reads a set-aside item again once it is due, and lets it go once it ingests", async () => {
    c.serve("poison");
    mocks.ingest.mockResolvedValue({});
    await syncAt(T0 - 1, held());
    expect(readsById()).toEqual([]);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(quarantine()).toEqual(quarantine(held()));

    const result = await syncAt(T0, held());

    expect(readsById()).toHaveLength(1);
    expect(result).toMatchObject({ imported: 1, removed: 0 });
    expect(ingestedIds()).toEqual(["poison"]);
    expect(savedCursor()).not.toHaveProperty("itemQuarantine");
    expect(mocks.appendEvent).toHaveBeenCalledTimes(1);
    expect(mocks.appendEvent.mock.calls[0][0]).toMatchObject({
      type: "connector.source_item.released",
      payload: { source: c.source, outcome: "ingested", redrives: 0 },
    });
  });

  it("retires a set-aside item its source no longer has", async () => {
    storeDocument();

    const result = await syncAt(T0, held({ redrives: 2 }));

    expect(readsById()).toHaveLength(1);
    expect(result).toMatchObject({ imported: 0, removed: 1 });
    expect(mocks.remove).toHaveBeenCalledWith(
      `oauth:google:${c.source}:poison`,
      expect.objectContaining({ tenantId: "personal" }),
    );
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(savedCursor()).not.toHaveProperty("itemQuarantine");
    expect(mocks.appendEvent.mock.calls[0][0]).toMatchObject({
      type: "connector.source_item.released",
      payload: { outcome: "removed", redrives: 2 },
    });
  });

  it("waits twice as long for a set-aside item that fails again, without failing its source", async () => {
    c.serve("poison");

    const result = await syncAt(T0, held({ redrives: 1 }));

    expect(result.sources).toMatchObject([{ source: c.source, status: "healthy" }]);
    expect(savedCursor()).toHaveProperty(c.changesKey);
    expect(quarantine()).toEqual({
      held: [{
        id: "poison",
        revision: c.revisionOf("poison"),
        since: iso(T0 - 7 * HOUR),
        retryAt: iso(T0 + 24 * HOUR),
        redrives: 2,
      }],
    });
    expect(mocks.appendEvent).not.toHaveBeenCalled();
  });

  it("reads a set-aside item again as soon as its source changes it", async () => {
    c.list([["poison"]]);
    mocks.ingest.mockResolvedValue({});
    const cursor = held({ retryAt: iso(T0 + HOUR) });
    delete cursor[c.changesKey];

    const result = await syncAt(T0, cursor);

    expect(result).toMatchObject({ imported: 1 });
    expect(ingestedIds()).toEqual(["poison"]);
    expect(savedCursor()).toMatchObject(c.changesCursor);
    expect(savedCursor()).not.toHaveProperty("itemQuarantine");
    expect(mocks.appendEvent.mock.calls[0][0]).toMatchObject({
      type: "connector.source_item.released",
      payload: { outcome: "ingested" },
    });
  });

  it("moves past a set-aside item its source reports unchanged", async () => {
    c.list([["poison", `${c.source}-item`]]);
    const cursor = held({ revision: c.revisionOf("poison"), retryAt: iso(T0 + HOUR) });
    delete cursor[c.changesKey];

    await syncAt(T0, cursor);

    expect(ingestedIds()).toEqual([`${c.source}-item`]);
    expect(savedCursor()).toMatchObject(c.changesCursor);
    expect(quarantine()).toEqual(quarantine(cursor));
  });

  it("reads a set-aside item again as soon as its source reports it removed", async () => {
    c.deleteItem("poison");
    storeDocument();

    const result = await syncAt(T0, held({ revision: undefined, retryAt: iso(T0 + HOUR) }));

    expect(readsById()).toHaveLength(1);
    expect(result).toMatchObject({ removed: 1 });
    expect(savedCursor()).not.toHaveProperty("itemQuarantine");
    expect(mocks.appendEvent.mock.calls[0][0]).toMatchObject({
      type: "connector.source_item.released",
      payload: { outcome: "removed" },
    });
  });

  it("forgets an item's failure once the item ingests", async () => {
    c.list([["poison"]]);
    await syncAt(T0);
    expect(quarantine()).toMatchObject({ failing: { id: "poison", attempts: 1 } });
    mocks.ingest.mockResolvedValue({});

    await syncAt(T0 + MINUTE, savedCursor());

    expect(savedCursor()).toMatchObject(c.changesCursor);
    expect(savedCursor()).not.toHaveProperty("itemQuarantine");
  });

  it("keeps an item it set aside, and records it, when its source fails later", async () => {
    c.list([["poison", "later"]]);
    mocks.ingest.mockImplementation(async (input: { idempotencyKey: string }) => {
      if (input.idempotencyKey.endsWith(":poison")) {
        throw new Error("Embedding request failed.");
      }
      throw new Error("Connected source returned 429.");
    });

    const result = await syncAt(T0, failedTwice());

    expect(result.sources).toMatchObject([{
      source: c.source,
      status: "error",
      failureCode: "provider_rate_limited",
    }]);
    expect(result.cursorAdvanced).toBe(false);
    expect(savedCursor()).not.toHaveProperty(c.changesKey);
    expect(quarantine()).toEqual({
      held: [expect.objectContaining({ id: "poison", since: iso(T0 - HOUR) })],
    });
    expect(mocks.appendEvent).toHaveBeenCalledTimes(1);
    expect(mocks.appendEvent.mock.calls[0][0]).toMatchObject({
      type: "connector.source_item.quarantined",
      payload: { attempts: 3 },
    });
  });

  it("records an item it set aside once its place is saved, though the sync then loses its lease", async () => {
    c.list([["poison"]]);
    mocks.updateState.mockImplementation(async (update: { releaseLease?: boolean }) =>
      update.releaseLease ? undefined : { syncStatus: "syncing" }
    );

    await expect(syncAt(T0, failedTwice())).rejects.toThrow("lost its lease");

    expect(mocks.appendEvent).toHaveBeenCalledTimes(1);
    expect(mocks.appendEvent.mock.calls[0][0]).toMatchObject({
      type: "connector.source_item.quarantined",
    });
  });

  it("records nothing it set aside when its place is not saved", async () => {
    c.list([["poison"]]);
    mocks.updateState.mockImplementation(async (update: { releaseLease?: boolean }) =>
      update.releaseLease ? { syncStatus: "error" } : undefined
    );

    await expect(syncAt(T0, failedTwice())).rejects.toThrow("revoked during synchronization");

    expect(mocks.appendEvent).not.toHaveBeenCalled();
  });

  it("names each time it sets an item aside, the same however often it records it", async () => {
    c.list([["poison"]]);
    const failedSince = (since: number) => ({
      itemQuarantine: {
        [c.source]: { failing: { id: "poison", attempts: 2, since: iso(since) } },
      },
    });

    await syncAt(T0, failedSince(T0 - HOUR));
    await syncAt(T0, failedSince(T0 - HOUR));
    await syncAt(T0, failedSince(T0 - 2 * HOUR));

    const [first, again, later] = mocks.appendEvent.mock.calls.map(([event]) => event.id);
    expect(again).toBe(first);
    expect(later).not.toBe(first);
  });

  it("never sets an item aside when the sync is interrupted", async () => {
    c.list([["poison"]]);
    const caller = new AbortController();
    mocks.ingest.mockImplementation(async () => {
      caller.abort();
      throw caller.signal.reason;
    });
    vi.setSystemTime(T0);
    connect({ cursor: failedTwice() });

    await expect(sync({ sources: [c.source], abortSignal: caller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });

    expect(savedCursors()).toEqual([]);
    expect(mocks.appendEvent).not.toHaveBeenCalled();
  });

  it("leaves a set-aside item as it was when the sync is interrupted reading it again", async () => {
    const caller = new AbortController();
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/poison")) {
        caller.abort();
        throw caller.signal.reason;
      }
      return fakeGoogle(input);
    });
    vi.setSystemTime(T0);
    connect({ cursor: held() });

    await expect(sync({ sources: [c.source], abortSignal: caller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });

    expect(savedCursors()).toEqual([]);
  });

  it.each(["present", "removed", "missing-id"])(
    "keeps a set-aside item when its read answers for another or unidentified item (%s)",
    async (answer) => {
      const id = answer === "missing-id" ? undefined : "other";
      if (c.source === "mail") {
        google.mail.messages.set("poison", {
          ...gmailMessage("other"),
          id,
          ...(answer === "removed" ? { labelIds: ["TRASH"] } : {}),
        });
      }
      if (c.source === "calendar") {
        google.calendar.items.set("poison", {
          ...calendarEvent("other"),
          id,
          ...(answer === "removed" ? { status: "cancelled" } : {}),
        });
      }
      if (c.source === "drive") {
        google.drive.items.set("poison", {
          ...driveFile("other", { trashed: answer === "removed" }),
          id,
        });
      }
      storeDocument();
      mocks.ingest.mockResolvedValue({});

      await syncAt(T0, held());

      expect(mocks.ingest).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.cancelCalendar).not.toHaveBeenCalled();
      expect(mocks.projectCalendar).not.toHaveBeenCalled();
      expect(quarantine()).toMatchObject({ held: [{ id: "poison", redrives: 1 }] });
      expect(mocks.appendEvent).not.toHaveBeenCalled();
    },
  );

  if (c.source === "calendar") {
    it("retires a set-aside event Google reports gone", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request) =>
        new URL(String(input)).pathname.endsWith("/events/poison")
          ? json({ error: { code: 410 } }, 410)
          : fakeGoogle(input)
      );
      storeDocument();

      const result = await syncAt(T0, held());

      expect(result).toMatchObject({ imported: 0, removed: 1 });
      expect(savedCursor()).not.toHaveProperty("itemQuarantine");
    });
  }

  if (c.source === "drive") {
    it.each([{ trashed: true }, { ownedByMe: false }])(
      "retires a set-aside file Drive reports as %o",
      async (fields) => {
        google.drive.items.set("poison", driveFile("poison", fields));
        storeDocument();

        const result = await syncAt(T0, held());

        expect(result).toMatchObject({ imported: 0, removed: 1 });
        expect(mocks.ingest).not.toHaveBeenCalled();
        expect(savedCursor()).not.toHaveProperty("itemQuarantine");
      },
    );
  }
});

describe.each(SOURCES)("the Google $source source, once it starts over", (c) => {
  const T0 = Date.parse("2026-10-01T00:00:00.000Z");
  const HOUR = 60 * 60_000;
  const iso = (time: number) => new Date(time).toISOString();
  // What the source's check of an item asks for: only the fields that tell.
  const [checkParam, checkValue] = {
    mail: ["format", "minimal"],
    calendar: ["fields", "id,status"],
    drive: ["fields", "id,trashed,ownedByMe"],
  }[c.source];
  const isCheck = (url: URL) => url.searchParams.get(checkParam) === checkValue;
  const checkedIds = () => requests
    .filter(isCheck)
    .map((url) => decodeURIComponent(url.pathname.split("/").at(-1) ?? ""))
    .sort();
  // Knowledge holds these documents, and lists them as its store does: in id
  // order, after a position, up to a limit.
  const holdDocuments = (documents: Array<{ id: string; source: string }>) => {
    const listed = [...documents].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );
    mocks.listDocuments.mockImplementation(async (
      _prefix: string,
      options: { after?: string; limit: number },
    ) => listed
      .filter((document) => document.id > (options.after ?? ""))
      .slice(0, options.limit));
    return listed;
  };
  // Knowledge holds a document this connection's sync wrote for each item.
  const hold = (...ids: string[]) => holdDocuments(ids.map((id) => ({
    id: knowledgeDocumentId("personal", `oauth:google:${c.source}:${id}`),
    source: `google:${c.source}:${id}`,
  })));
  // Syncs as of `time`, from `cursor`.
  const syncAt = (time: number, cursor?: Record<string, unknown>) => {
    vi.setSystemTime(time);
    connect({ cursor });
    return sync({ sources: [c.source] });
  };
  // Syncs once Google refuses the change position the cursor kept.
  const syncRefused = (cursor: Record<string, unknown> = c.changesCursor) => {
    refused.add(c.source);
    return syncAt(T0, cursor);
  };
  // A cursor following changes, partway through checking what it held.
  const sweeping = (fields: Record<string, unknown> = {}) => ({
    ...c.changesCursor,
    documentSweep: {
      [c.source]: {
        since: iso(T0 - HOUR),
        after: "knowledge_0",
        checked: 7,
        removed: 2,
        ...fields,
      },
    },
  });
  const sweepOf = (cursor = savedCursor()) =>
    (cursor.documentSweep as Record<string, unknown> | undefined)?.[c.source];
  const removedKeys = () => mocks.remove.mock.calls.map(([key]) => key);
  const events = () => mocks.appendEvent.mock.calls.map(([event]) => event);
  const answering = (id: string, response: () => Response) => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) =>
      new URL(String(input)).pathname.endsWith(`/${id}`)
        ? response()
        : fakeGoogle(input)
    );
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Each document the check finds gone is still in knowledge.
    mocks.getDocument.mockResolvedValue({
      id: "document",
      sourceItemId: "item",
      sourceRevisionId: "revision",
      metadata: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks each document it held once Google refuses its place, and retires the ones that left", async () => {
    hold("kept", "left");
    c.serve("kept");

    const result = await syncRefused();

    expect(result.sources).toMatchObject([{ source: c.source, status: "healthy" }]);
    expect(result).toMatchObject({ imported: 0, removed: 1 });
    expect(mocks.listDocuments).toHaveBeenCalledTimes(1);
    expect(mocks.listDocuments).toHaveBeenCalledWith(`google:${c.source}:`, {
      tenantId: "personal",
      createdBefore: iso(T0),
      limit: 50,
    });
    expect(checkedIds()).toEqual(["kept", "left"]);
    expect(removedKeys()).toEqual([`oauth:google:${c.source}:left`]);
    expect(savedCursor()).toMatchObject(c.changesCursor);
    expect(savedCursor()).not.toHaveProperty("documentSweep");
    expect(events()).toEqual([{
      id: expect.stringMatching(/^source_sweep_event_[0-9a-f]{56}$/),
      streamId: "connector:google-grant",
      type: "connector.source_sweep.finished",
      executionScope: expect.objectContaining({ tenantId: "personal" }),
      payload: {
        schemaVersion: 1,
        connectionId: "google-grant",
        source: c.source,
        adapterId: GOOGLE_SOURCE_ADAPTERS[c.source].adapterId,
        adapterVersionId: GOOGLE_SOURCE_ADAPTERS[c.source].adapterVersionId,
        checked: 2,
        removed: 1,
      },
    }]);
    // The record carries counts only.
    expect(JSON.stringify(events())).not.toContain("kept");
  });

  it("checks each document it held on its first sync after it connects", async () => {
    hold("kept", "left");
    c.serve("kept");

    await syncAt(T0);

    expect(checkedIds()).toEqual(["kept", "left"]);
    expect(removedKeys()).toEqual([`oauth:google:${c.source}:left`]);
  });

  it("checks nothing it held while it pages through its listing or follows changes", async () => {
    c.list([["one"], ["two"]]);
    await syncAt(T0);
    hold("left");
    mocks.listDocuments.mockClear();

    await syncAt(T0, savedCursor());
    expect(savedCursor()).toMatchObject(c.changesCursor);
    await syncAt(T0, savedCursor());

    expect(mocks.listDocuments).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    // A check that found nothing held records nothing.
    expect(events()).toEqual([]);
  });

  it("checks only a document this connection's sync wrote for an item", async () => {
    holdDocuments([
      ...hold("kept", "left"),
      // One written under another key, and one naming no item.
      { id: "knowledge_another", source: `google:${c.source}:another` },
      {
        id: knowledgeDocumentId("personal", `oauth:google:${c.source}:`),
        source: `google:${c.source}:`,
      },
    ]);
    c.serve("kept");

    await syncRefused();

    expect(checkedIds()).toEqual(["kept", "left"]);
    expect(removedKeys()).toEqual([`oauth:google:${c.source}:left`]);
    expect(events()).toMatchObject([{ payload: { checked: 2, removed: 1 } }]);
  });

  it("checks the documents of a work connection under that connection's names", async () => {
    holdDocuments(["kept", "left"].map((id) => ({
      id: knowledgeDocumentId(
        "personal",
        `oauth:google:work:google-grant:${c.source}:${id}`,
      ),
      source: `google:work:google-grant:${c.source}:${id}`,
    })));
    c.serve("kept");
    refused.add(c.source);
    vi.setSystemTime(T0);
    connect({ cursor: c.changesCursor, purpose: "work" });

    await sync({ sources: [c.source] });

    expect(mocks.listDocuments).toHaveBeenCalledWith(
      `google:work:google-grant:${c.source}:`,
      expect.objectContaining({ tenantId: "personal" }),
    );
    expect(checkedIds()).toEqual(["kept", "left"]);
    expect(removedKeys()).toEqual([`oauth:google:work:google-grant:${c.source}:left`]);
  });

  it("stops, and removes nothing, when Google confirms none of what it held", async () => {
    hold("left", "also-left");

    const result = await syncRefused();

    expect(result).toMatchObject({ removed: 0 });
    expect(checkedIds()).toEqual(["also-left", "left"]);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(savedCursor()).not.toHaveProperty("documentSweep");
    expect(events()).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^source_sweep_event_[0-9a-f]{56}$/),
      streamId: "connector:google-grant",
      type: "connector.source_sweep.stopped",
      payload: expect.objectContaining({ checked: 0, removed: 0, wouldRemove: 2 }),
    })]);
  });

  it.each([
    [9, 9, "finished", { checked: 16, removed: 11 }],
    [10, 0, "stopped", { checked: 7, removed: 2, wouldRemove: 10 }],
  ])("given %i documents at once that left, removes %i, and records the check %s", async (left, removed, type, counts) => {
    hold(...Array.from({ length: left }, (_, index) => `left-${index}`));

    const result = await syncAt(T0, sweeping());

    expect(result).toMatchObject({ removed });
    expect(mocks.remove).toHaveBeenCalledTimes(removed);
    expect(savedCursor()).not.toHaveProperty("documentSweep");
    expect(events()).toEqual([expect.objectContaining({
      type: `connector.source_sweep.${type}`,
      payload: expect.objectContaining(counts),
    })]);
  });

  it("checks fifty documents a sync, five at a time, until it has checked them all", async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `item-${index}`);
    const documents = hold(...ids);
    for (const id of ids) c.serve(id);
    let active = 0;
    let most = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      if (!isCheck(new URL(String(input)))) return fakeGoogle(input);
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return fakeGoogle(input);
    });

    const first = await syncRefused();

    expect(checkedIds()).toHaveLength(50);
    expect(most).toBe(5);
    // Checking what it held does not move the source.
    expect(first.cursorAdvanced).toBe(false);
    expect(sweepOf()).toEqual({
      since: iso(T0),
      after: documents[49].id,
      checked: 50,
      removed: 0,
    });
    expect(events()).toEqual([]);

    refused.clear();
    requests = [];
    await syncAt(T0 + HOUR, savedCursor());

    expect(mocks.listDocuments).toHaveBeenLastCalledWith(`google:${c.source}:`, {
      tenantId: "personal",
      createdBefore: iso(T0),
      after: documents[49].id,
      limit: 50,
    });
    expect(checkedIds()).toEqual([documents[50].source.split(":").at(-1)]);
    expect(savedCursor()).not.toHaveProperty("documentSweep");
    expect(events()).toMatchObject([{
      type: "connector.source_sweep.finished",
      payload: { checked: 51, removed: 0 },
    }]);
  });

  it("starts its check over when its source starts over again", async () => {
    hold("kept");
    c.serve("kept");

    await syncRefused(sweeping());

    expect(mocks.listDocuments).toHaveBeenCalledWith(`google:${c.source}:`, {
      tenantId: "personal",
      createdBefore: iso(T0),
      limit: 50,
    });
    expect(events()).toMatchObject([{ payload: { checked: 1, removed: 0 } }]);
  });

  it("keeps its place in the check when Google fails to answer for a document", async () => {
    hold("kept", "flaky");
    c.serve("kept");
    answering("flaky", () => json({ error: { code: 503 } }, 503));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await syncRefused();

    expect(result.sources).toMatchObject([{ source: c.source, status: "healthy" }]);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(sweepOf()).toEqual({ since: iso(T0), checked: 0, removed: 0 });
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
      level: "warn",
      event: "connector.source_sweep.failed",
      source: c.source,
      diagnostic: "Connected source returned 503.",
    });
    expect(events()).toEqual([]);
    warn.mockRestore();

    refused.clear();
    vi.stubGlobal("fetch", fakeGoogle);
    c.serve("flaky");
    await syncAt(T0 + HOUR, savedCursor());

    expect(mocks.listDocuments).toHaveBeenLastCalledWith(
      `google:${c.source}:`,
      expect.objectContaining({ createdBefore: iso(T0) }),
    );
    expect(savedCursor()).not.toHaveProperty("documentSweep");
    expect(events()).toMatchObject([{ payload: { checked: 2, removed: 0 } }]);
  });

  it("leaves a document Google answers for unreadably, and checks the rest", async () => {
    hold("kept", "unclear", "left");
    c.serve("kept");
    answering("unclear", () => json({ error: { code: 400 } }, 400));

    await syncRefused();

    expect(removedKeys()).toEqual([`oauth:google:${c.source}:left`]);
    expect(savedCursor()).not.toHaveProperty("documentSweep");
    expect(events()).toMatchObject([{ payload: { checked: 2, removed: 1 } }]);
  });

  it("keeps a document when Google answers for another item", async () => {
    hold("kept", "asked");
    c.serve("kept");
    // The other item has left, so taking it for the one asked would remove it.
    if (c.source === "mail") {
      google.mail.messages.set("asked", { ...gmailMessage("another"), labelIds: ["TRASH"] });
    }
    if (c.source === "calendar") {
      google.calendar.items.set("asked", { ...calendarEvent("another"), status: "cancelled" });
    }
    if (c.source === "drive") {
      google.drive.items.set("asked", driveFile("another", { trashed: true }));
    }

    await syncRefused();

    expect(mocks.remove).not.toHaveBeenCalled();
    expect(events()).toMatchObject([{ payload: { checked: 1, removed: 0 } }]);
  });

  it("keeps its place in the check when its source fails", async () => {
    hold("left");
    google[c.source].status = 503;

    await syncAt(T0, sweeping());

    expect(mocks.listDocuments).not.toHaveBeenCalled();
    expect(sweepOf()).toEqual(sweepOf(sweeping()));
  });

  it("keeps the check of another source as it was", async () => {
    const other = SOURCES.find((source) => source !== c)!.source;
    const otherSweep = { since: iso(T0 - HOUR), checked: 1, removed: 0 };
    hold("kept");
    c.serve("kept");

    await syncAt(T0, {
      ...sweeping(),
      documentSweep: { ...sweeping().documentSweep, [other]: otherSweep },
    });

    expect(savedCursor().documentSweep).toEqual({ [other]: otherSweep });
  });

  it("drops a check it cannot read", async () => {
    hold("left");

    await syncAt(T0, sweeping({ since: "never" }));

    expect(mocks.listDocuments).not.toHaveBeenCalled();
    expect(savedCursor()).not.toHaveProperty("documentSweep");
  });

  it("names the record of a check by when its source started over", async () => {
    hold("kept");
    c.serve("kept");

    await syncAt(T0, sweeping());
    await syncAt(T0, sweeping());
    await syncAt(T0, sweeping({ since: iso(T0 - 2 * HOUR) }));

    const [first, again, later] = events().map((event) => event.id);
    expect(again).toBe(first);
    expect(later).not.toBe(first);
  });

  it("removes nothing, and keeps nothing, when the sync is interrupted checking a document", async () => {
    hold("kept", "left");
    c.serve("kept");
    const caller = new AbortController();
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      if (isCheck(new URL(String(input)))) {
        caller.abort();
        throw caller.signal.reason;
      }
      return fakeGoogle(input);
    });
    refused.add(c.source);
    vi.setSystemTime(T0);
    connect({ cursor: c.changesCursor });

    await expect(sync({ sources: [c.source], abortSignal: caller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });

    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.updateState.mock.calls
      .filter(([update]) => typeof update.cursor === "string")).toEqual([]);
  });

  // Google still answers for the item, though it no longer belongs in knowledge.
  const LEFT_IN_PLACE: Record<SourceId, Array<[string, () => void]>> = {
    mail: [
      ["in the trash", () => {
        google.mail.messages.set("left", { ...gmailMessage("left"), labelIds: ["TRASH"] });
      }],
      ["as spam", () => {
        google.mail.messages.set("left", { ...gmailMessage("left"), labelIds: ["SPAM"] });
      }],
    ],
    calendar: [
      ["cancelled", () => {
        google.calendar.items.set("left", { ...calendarEvent("left"), status: "cancelled" });
      }],
      ["gone", () => answering("left", () => json({ error: { code: 410 } }, 410))],
    ],
    drive: [
      ["in the trash", () => {
        google.drive.items.set("left", driveFile("left", { trashed: true }));
      }],
      ["given to another owner", () => {
        google.drive.items.set("left", driveFile("left", { ownedByMe: false }));
      }],
    ],
  };

  it.each(LEFT_IN_PLACE[c.source])("retires a document whose item Google reports %s", async (_state, leave) => {
    hold("kept", "left");
    c.serve("kept");
    leave();

    await syncRefused();

    expect(removedKeys()).toEqual([`oauth:google:${c.source}:left`]);
    expect(events()).toMatchObject([{ payload: { checked: 2, removed: 1 } }]);
  });

  if (c.source === "calendar") {
    it("cancels the meeting of an event that left", async () => {
      hold("kept", "left");
      c.serve("kept");

      await syncRefused();

      expect(mocks.cancelCalendar).toHaveBeenCalledTimes(1);
      expect(mocks.cancelCalendar).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: "personal",
        sourceItemId: "item",
      }));
    });
  }

  if (c.source === "drive") {
    it("keeps a document when Drive does not say who owns the file", async () => {
      hold("kept", "unsaid");
      c.serve("kept");
      answering("unsaid", () => json({ id: "unsaid", trashed: false }));

      await syncRefused();

      expect(mocks.remove).not.toHaveBeenCalled();
      expect(events()).toMatchObject([{ payload: { checked: 2, removed: 0 } }]);
    });
  }
});

describe("the declared Google source adapters", () => {
  it("are each held to the source contract", () => {
    expect(SOURCES.map((c) => c.source)).toEqual(Object.keys(GOOGLE_SOURCE_ADAPTERS));
  });

  // Indexed evidence names its adapter and version, so a new version is a
  // deliberate change.
  it("each name the adapter their evidence carries", () => {
    expect(Object.values(GOOGLE_SOURCE_ADAPTERS).map((adapter) => [
      adapter.adapterId,
      adapter.adapterVersionId,
      adapter.capability,
      adapter.sourceKind,
    ])).toEqual([
      ["google.personal_sync.mail", "1", "gmail.read", "email"],
      ["google.personal_sync.calendar", "1", "calendar.events.read", "calendar_event"],
      ["google.personal_sync.drive", "1", "drive.read", "file"],
    ]);
  });
});

describe("a Google connection", () => {
  it("reads nothing when it was granted no source", async () => {
    for (const source of SOURCES) source.list([[`${source.source}-item`]]);
    connect({
      scopes: [
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/drive.file",
      ],
    });
    await expect(sync()).resolves.toMatchObject({ sources: [] });
    expect(requests).toEqual([]);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("is held back when Google refuses every source", async () => {
    for (const source of SOURCES) google[source.source].status = 503;
    const result = await sync();
    expect(result.sources).toEqual(SOURCES.map((source) => expect.objectContaining({
      source: source.source,
      status: "error",
      failureCode: "provider_unavailable",
    })));
    expect(mocks.updateState).toHaveBeenLastCalledWith(expect.objectContaining({
      releaseLease: true,
      attempt: "failed",
    }));
  });

  it.each([1, 2])("revoked at checkpoint %i ingests no later source", async (revokedAt) => {
    for (const source of SOURCES) source.list([[`${source.source}-item`]]);
    let checkpoints = 0;
    mocks.updateState.mockImplementation(async (update: { releaseLease?: boolean }) =>
      update.releaseLease || ++checkpoints !== revokedAt
        ? { syncStatus: "healthy" }
        : undefined
    );
    await expect(sync()).rejects.toThrow(
      "Connected source was revoked during synchronization.",
    );
    expect(ingestedIds()).toEqual(
      ["mail-item", "calendar-item", "drive-item"].slice(0, revokedAt),
    );
    expect(checkpoints).toBe(revokedAt);
    expect(mocks.observeDrive).not.toHaveBeenCalled();
    expect(mocks.observeCanonicalDrive).not.toHaveBeenCalled();
  });

  it("keeps a long Calendar description to 100,000 characters on its meeting", async () => {
    google.calendar.pages = [[calendarEvent("long", "é".repeat(150_000))]];
    mocks.ingest.mockResolvedValue({
      document: { sourceItemId: "item-long", sourceRevisionId: "revision-long" },
    });
    await sync({ sources: ["calendar"] });
    expect(mocks.projectCalendar).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ description: "é".repeat(100_000) }),
    }));
  });

  it("stops reading a Drive export once it holds more than it keeps", async () => {
    // 40 chunks of 65,536 bytes, where 400,000 bytes hold every character kept.
    const { body, meter } = meteredBody(40, new TextEncoder().encode("é".repeat(32_768)));
    google.drive.pages = [[driveFile("long")]];
    google.drive.exports.set("long", () => new Response(body));
    await sync({ sources: ["drive"] });
    expect(occurrences(mocks.ingest.mock.calls[0][0].content, "é")).toBe(100_000);
    expect(meter.canceled).toBe(true);
    expect(meter.pulled).toBeLessThanOrEqual(9);
  });

  it("stops downloading a Drive file once it passes 5 MB, and keeps the file's metadata", async () => {
    // A file listed at 1 KB that sends its text and then 30 chunks of 512 KiB
    // of spaces, so its first 5 MB alone would still extract.
    const { body, meter } = meteredBody(
      31,
      new Uint8Array(512 * 1024).fill(0x20),
      new TextEncoder().encode("Scanned notes"),
    );
    google.drive.pages = [[driveFile("scan", {
      name: "Scan notes",
      mimeType: "text/plain",
      size: "1024",
    })]];
    google.drive.downloads.set("scan", () => new Response(body));
    await sync({ sources: ["drive"] });
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.ingest.mock.calls[0][0]).toMatchObject({
      idempotencyKey: "oauth:google:drive:scan",
      content: expect.stringContaining("File: Scan notes"),
    });
    expect(mocks.ingest.mock.calls[0][0].content).not.toContain("Content:");
    expect(meter.canceled).toBe(true);
    expect(meter.pulled).toBeLessThanOrEqual(12);
  });
});

async function fakeGoogle(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input));
  requests.push(url);
  const source = sourceOf(url);
  if (google[source].status) {
    return json({ error: { code: google[source].status } }, google[source].status);
  }
  const path = url.pathname;
  const page = Number(url.searchParams.get("pageToken")?.replace(`${source}-page-`, "") || 0);
  const next = (pages: readonly unknown[]) =>
    page + 1 < pages.length ? `${source}-page-${page + 1}` : undefined;
  if (path === "/gmail/v1/users/me/profile") return json({ historyId: "mail-history-1" });
  if (path === "/gmail/v1/users/me/history") {
    if (refused.has("mail")) return json({ error: { code: 404 } }, 404);
    return json({ history: google.mail.changes, historyId: "mail-history-2" });
  }
  if (path === "/gmail/v1/users/me/messages") {
    return json({
      messages: google.mail.pages[page].map((id) => ({ id })),
      nextPageToken: next(google.mail.pages),
    });
  }
  const message = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path);
  if (message) {
    const found = google.mail.messages.get(decodeURIComponent(message[1]));
    return found ? json(found) : json({ error: { code: 404 } }, 404);
  }
  const event = /^\/calendar\/v3\/calendars\/primary\/events\/([^/]+)$/.exec(path);
  if (event) {
    const found = google.calendar.items.get(decodeURIComponent(event[1]));
    return found ? json(found) : json({ error: { code: 404 } }, 404);
  }
  if (path === "/calendar/v3/calendars/primary/events") {
    if (url.searchParams.has("syncToken")) {
      if (refused.has("calendar")) return json({ error: { code: 410 } }, 410);
      return json({ items: google.calendar.changes, nextSyncToken: "calendar-sync-2" });
    }
    const nextPageToken = next(google.calendar.pages);
    return json({
      items: google.calendar.pages[page],
      ...(nextPageToken ? { nextPageToken } : { nextSyncToken: "calendar-sync" }),
    });
  }
  if (path === "/drive/v3/changes/startPageToken") {
    return json({ startPageToken: "drive-changes" });
  }
  if (path === "/drive/v3/changes") {
    if (refused.has("drive")) return json({ error: { code: 410 } }, 410);
    return json({ changes: google.drive.changes, newStartPageToken: "drive-changes-2" });
  }
  if (path === "/drive/v3/files") {
    return json({ files: google.drive.pages[page], nextPageToken: next(google.drive.pages) });
  }
  const exported = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(path);
  if (exported) {
    const id = decodeURIComponent(exported[1]);
    return google.drive.exports.get(id)?.() ?? new Response(`Notes in ${id}`);
  }
  const media = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
  if (media && url.searchParams.get("alt") !== "media") {
    const found = google.drive.items.get(decodeURIComponent(media[1]));
    return found ? json(found) : json({ error: { code: 404 } }, 404);
  }
  const download = media && url.searchParams.get("alt") === "media"
    ? google.drive.downloads.get(decodeURIComponent(media[1]))
    : undefined;
  if (download) return download();
  throw new Error(`Unexpected URL ${url}`);
}

function sourceOf(url: URL): SourceId {
  if (url.hostname === "gmail.googleapis.com") return "mail";
  if (url.pathname.startsWith("/calendar/")) return "calendar";
  if (url.pathname.startsWith("/drive/")) return "drive";
  throw new Error(`Unexpected URL ${url}`);
}

function sync(options: { sources?: SourceId[]; abortSignal?: AbortSignal } = {}) {
  return syncPersonalProvider({
    tenantId: "personal",
    actorId: "owner",
    provider: "google",
    ...options,
  });
}

function connect(input: {
  cursor?: Record<string, unknown>;
  scopes?: string[];
  purpose?: "personal" | "work";
}) {
  mocks.getSecrets.mockResolvedValue({
    grant: {
      id: "google-grant",
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
      accountEmail: "owner@example.com",
      connectionLabel: "Personal",
      connectionPurpose: input.purpose ?? "personal",
      status: "active",
      authorizationGeneration: 1,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: input.scopes || Object.values(SCOPES),
    },
    tokens: { access_token: "access" },
    credentialState: "active",
    syncCursor: input.cursor ? JSON.stringify(input.cursor) : undefined,
  });
}

function ingestedIds() {
  return mocks.ingest.mock.calls.map(([input]) =>
    String(input.idempotencyKey).split(":").at(-1)
  );
}

function savedCursor() {
  return JSON.parse(
    mocks.updateState.mock.calls.at(-1)?.[0].cursor,
  ) as Record<string, unknown>;
}

function occurrences(text: string, character: string) {
  return text.split(character).length - 1;
}

/**
 * A body of `count` chunks, `first` and then copies of `chunk`, that records
 * how far it was read.
 */
function meteredBody(count: number, chunk: Uint8Array, first = chunk) {
  const meter = { pulled: 0, canceled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (meter.pulled === count) return controller.close();
      meter.pulled += 1;
      controller.enqueue((meter.pulled === 1 ? first : chunk).slice());
    },
    cancel() {
      meter.canceled = true;
    },
  });
  return { body, meter };
}

function gmailMessage(id: string, body = `Body of ${id}`) {
  return {
    id,
    threadId: `thread-${id}`,
    historyId: "mail-history-1",
    internalDate: "1787695200000",
    labelIds: ["INBOX"],
    snippet: `Snippet of ${id}`,
    payload: {
      mimeType: "text/plain",
      body: { data: Buffer.from(body).toString("base64url") },
      headers: [
        { name: "Subject", value: `Subject of ${id}` },
        { name: "From", value: "sender@example.com" },
      ],
    },
  };
}

function calendarEvent(id: string, description = `Agenda for ${id}`) {
  return {
    id,
    etag: `etag-${id}`,
    created: "2026-09-20T10:00:00Z",
    updated: "2026-09-25T10:00:00Z",
    summary: `Event ${id}`,
    description,
    status: "confirmed",
    start: { dateTime: "2026-10-01T10:00:00Z" },
    end: { dateTime: "2026-10-01T11:00:00Z" },
  };
}

function driveFile(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    name: `Notes ${id}`,
    mimeType: "application/vnd.google-apps.document",
    createdTime: "2026-09-20T10:00:00Z",
    modifiedTime: "2026-09-25T10:00:00Z",
    version: "2",
    trashed: false,
    ownedByMe: true,
    ...fields,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
