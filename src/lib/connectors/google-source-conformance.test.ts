import { beforeEach, describe, expect, it, vi } from "vitest";

// Every Google source the personal sync reads keeps the same contract. It
// pages through a listing and then follows changes from where the listing
// ended. It refuses a page larger than it asked for, retires what the provider
// deleted, and reads only what the connection was granted. It keeps each item
// under one key, bounds what it reads and keeps, fails without failing the
// others, and stops when its connection is revoked.

const mocks = vi.hoisted(() => ({
  claimLease: vi.fn(), getSecrets: vi.fn(), updateState: vi.fn(), refresh: vi.fn(), ingest: vi.fn(), remove: vi.fn(), getDocument: vi.fn(), projectCalendar: vi.fn(), cancelCalendar: vi.fn(), mapInbound: vi.fn(), observeDrive: vi.fn(), observeCanonicalDrive: vi.fn(),
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
vi.mock("@/lib/rag/store", () => ({ deleteKnowledgeDocumentByIdempotencyKey: mocks.remove, getKnowledgeDocumentByIdempotencyKey: mocks.getDocument }));
vi.mock("@/lib/meetings/google-calendar-projection", () => ({ projectGoogleCalendarMeeting: mocks.projectCalendar, cancelGoogleCalendarMeeting: mocks.cancelCalendar }));
vi.mock("@/lib/communications/store", () => ({ mapInboundCommunication: mocks.mapInbound }));

import { syncPersonalProvider } from "@/lib/connectors/personal-sync";

type SourceId = "mail" | "calendar" | "drive";

const SCOPES: Record<SourceId, string> = {
  mail: "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar.events",
  drive: "https://www.googleapis.com/auth/drive",
};

/**
 * A Google that answers each source from the listing pages and changes a test
 * sets. A listing's page tokens are `<source>-page-<n>`.
 */
const google = {
  mail: { pages: [[]] as string[][], changes: [] as unknown[], messages: new Map<string, Record<string, unknown>>(), status: 0 },
  calendar: { pages: [[]] as Record<string, unknown>[][], changes: [] as unknown[], status: 0 },
  drive: { pages: [[]] as Record<string, unknown>[][], changes: [] as unknown[], exports: new Map<string, () => Response>(), downloads: new Map<string, () => Response>(), status: 0 },
};
let requests: URL[] = [];

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
};

const SOURCES: SourceCase[] = [
  {
    source: "mail",
    pageLimit: 5,
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
  },
  {
    source: "calendar",
    pageLimit: 10,
    pageTokenKey: "calendarPageToken",
    changesKey: "calendar",
    changesCursor: { calendar: "calendar-sync", calendarMeetingProjectionVersion: 1 },
    followsChanges: (url) => url.searchParams.get("syncToken") === "calendar-sync",
    list: (pages) => {
      google.calendar.pages = pages.map((ids) => ids.map((id) => calendarEvent(id)));
    },
    deleteItem: (id) => {
      google.calendar.changes = [{ id, status: "cancelled" }];
    },
    serveText: (text) => {
      google.calendar.pages = [[calendarEvent("long", text)]];
    },
  },
  {
    source: "drive",
    pageLimit: 3,
    pageTokenKey: "drivePageToken",
    changesKey: "driveChangesStartPageToken",
    changesCursor: { driveChangesStartPageToken: "drive-changes" },
    followsChanges: (url) =>
      url.pathname === "/drive/v3/changes" &&
      url.searchParams.get("pageToken") === "drive-changes",
    list: (pages) => {
      google.drive.pages = pages.map((ids) => ids.map((id) => driveFile(id)));
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
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  google.mail = { pages: [[]], changes: [], messages: new Map(), status: 0 };
  google.calendar = { pages: [[]], changes: [], status: 0 };
  google.drive = { pages: [[]], changes: [], exports: new Map(), downloads: new Map(), status: 0 };
  requests = [];
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
  if (path === "/calendar/v3/calendars/primary/events") {
    if (url.searchParams.has("syncToken")) {
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

function sync(options: { sources?: SourceId[] } = {}) {
  return syncPersonalProvider({
    tenantId: "personal",
    actorId: "owner",
    provider: "google",
    ...options,
  });
}

function connect(input: { cursor?: Record<string, unknown>; scopes?: string[] }) {
  mocks.getSecrets.mockResolvedValue({
    grant: {
      id: "google-grant",
      tenantId: "personal",
      actorId: "owner",
      provider: "google",
      accountEmail: "owner@example.com",
      connectionLabel: "Personal",
      connectionPurpose: "personal",
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
