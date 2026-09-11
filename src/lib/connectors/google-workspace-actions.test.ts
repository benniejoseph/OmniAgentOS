import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const access = vi.hoisted(() => ({
  getActive: vi.fn(),
}));

vi.mock("@/lib/connectors/google-workspace-access", () => ({
  getActiveGoogleWorkspaceAccess: access.getActive,
}));

import {
  executeGoogleWorkspaceAction,
  googleWorkspaceAuditInput,
  googleWorkspaceEffectTarget,
  parseGoogleWorkspaceActionInput,
  reconcileGoogleWorkspaceMutation,
} from "@/lib/connectors/google-workspace-actions";

const owner = {
  tenantId: "tenant-google",
  actorId: "owner-google",
  executionId: "execution-google",
};

describe("governed Google Workspace actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.getActive.mockResolvedValue({
      accessToken: "access-token",
      grant: { id: "grant-google" },
    });
  });

  it("rejects untrusted provider IDs before any credential is opened", () => {
    expect(() => parseGoogleWorkspaceActionInput("google.drive.trash", {
      fileId: "../../another-user/file",
    })).toThrow(/resource ID/i);
    expect(access.getActive).not.toHaveBeenCalled();
  });

  it("keeps uploaded file bytes sealed while retaining approval-safe evidence", () => {
    const contentBase64 = Buffer.from("private file body", "utf8").toString("base64");
    expect(googleWorkspaceAuditInput("google.drive.create", {
      name: "private.txt",
      mimeType: "text/plain",
      contentBase64,
    })).toMatchObject({
      name: "private.txt",
      contentBase64: "[sealed binary content]",
      contentBytes: 17,
      contentSha256: sha256("private file body"),
    });
  });

  it("moves Gmail messages only to recoverable Trash under the exact capability", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "message_1", labelIds: ["INBOX"] }))
      .mockResolvedValueOnce(json({ id: "message_1", labelIds: ["TRASH"] }))
      .mockResolvedValueOnce(json({ id: "message_1", labelIds: ["TRASH"] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeGoogleWorkspaceAction(
      "google.gmail.trash",
      { messageId: "message_1" },
      owner,
    );

    expect(access.getActive).toHaveBeenCalledWith({
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      capability: "gmail.trash",
    });
    expect(fetchMock.mock.calls[1]?.[0].toString()).toContain(
      "/messages/message_1/trash",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(result).toMatchObject({
      toolId: "google.gmail.trash",
      resourceId: "message_1",
      verificationState: "verified",
    });
  });

  it("searches Gmail narrowly and returns stable IDs with bounded safe headers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ messages: [{ id: "message_1" }] }))
      .mockResolvedValueOnce(json({
        id: "message_1",
        threadId: "thread_1",
        labelIds: ["INBOX"],
        internalDate: "1789040000000",
        snippet: "Untrusted preview",
        payload: {
          headers: [
            { name: "Subject", value: "Market notes" },
            { name: "From", value: "analyst@example.com" },
          ],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeGoogleWorkspaceAction(
      "google.gmail.search",
      { query: "subject:market", maxResults: 3 },
      owner,
    );

    expect(access.getActive).toHaveBeenCalledWith(expect.objectContaining({
      capability: "gmail.read",
    }));
    const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(listUrl.searchParams.get("q")).toBe("subject:market");
    expect(listUrl.searchParams.get("maxResults")).toBe("3");
    expect(result).toMatchObject({
      resultCount: 1,
      contentTrust: "untrusted_provider_content",
      messages: [{
        messageId: "message_1",
        threadId: "thread_1",
        subject: "Market notes",
        from: "analyst@example.com",
      }],
    });
  });

  it("reads bounded Gmail text without returning attachment bytes", async () => {
    const body = Buffer.from("Exact email body", "utf8").toString("base64url");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      id: "message_1",
      threadId: "thread_1",
      labelIds: ["INBOX"],
      snippet: "Preview",
      payload: {
        headers: [{ name: "Subject", value: "Private message" }],
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: body } },
          {
            filename: "private.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "attachment_1", size: 999 },
          },
        ],
      },
    })));

    const result = await executeGoogleWorkspaceAction(
      "google.gmail.read",
      { messageId: "message_1" },
      owner,
    );

    expect(result).toMatchObject({
      messageId: "message_1",
      subject: "Private message",
      bodyText: "Exact email body",
      bodyTruncated: false,
      attachmentCount: 1,
      contentTrust: "untrusted_provider_content",
    });
    expect(result).not.toHaveProperty("attachmentBytes");
  });

  it("keeps binary Drive content out of the tool transcript", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        id: "file_1",
        name: "private.bin",
        mimeType: "application/octet-stream",
        parents: ["folder_1"],
        trashed: false,
      }))
      .mockResolvedValueOnce(new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeGoogleWorkspaceAction(
      "google.drive.download",
      { fileId: "file_1", maxBytes: 100 },
      owner,
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      fileId: "file_1",
      name: "private.bin",
      contentDisposition: "metadata_only_binary",
      contentSha256: sha256(bytes),
    });
    expect(result).not.toHaveProperty("contentBase64");
    expect(result).not.toHaveProperty("textPreview");
    expect(new URL(String(fetchMock.mock.calls[0]?.[0]))
      .searchParams.get("supportsAllDrives")).toBe("true");
  });

  it("returns metadata instead of copying oversized Drive bytes into the transcript", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      id: "file_1",
      name: "large.txt",
      mimeType: "text/plain",
      size: "500000",
      trashed: false,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeGoogleWorkspaceAction(
      "google.drive.download",
      { fileId: "file_1", maxBytes: 100 },
      owner,
    );

    expect(result).toMatchObject({
      fileId: "file_1",
      size: 500_000,
      contentDisposition: "metadata_only_oversize",
      previewOmittedReason: "file_exceeds_transcript_preview_limit",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("routes native Drive files to their structure-aware read tools", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      id: "document_1",
      name: "Plan",
      mimeType: "application/vnd.google-apps.document",
      trashed: false,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeGoogleWorkspaceAction(
      "google.drive.download",
      { fileId: "document_1", maxBytes: 100 },
      owner,
    )).rejects.toThrow(/Docs, Sheets, or Slides/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to overwrite Drive content after the downloaded digest changed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        id: "file_1",
        name: "notes.txt",
        mimeType: "text/plain",
        parents: ["folder_1"],
        trashed: false,
      }))
      .mockResolvedValueOnce(new Response("newer remote content", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeGoogleWorkspaceAction("google.drive.update", {
      fileId: "file_1",
      mimeType: "text/plain",
      contentBase64: Buffer.from("replacement", "utf8").toString("base64"),
      expectedCurrentSha256: sha256("older remote content"),
    }, owner)).rejects.toThrow(/changed since it was read/i);

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"))
      .toBe(false);
  });

  it("replaces a Google document body behind a current-content fence", async () => {
    const prior = document("before", "revision-1");
    const observed = document("after", "revision-2");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(prior))
      .mockResolvedValueOnce(json({ writeControl: { requiredRevisionId: "revision-2" } }))
      .mockResolvedValueOnce(json(observed));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      documentId: "document_1",
      text: "after",
      expectedCurrentSha256: sha256("before"),
      expectedStructureSha256: documentStructureSha256(prior),
    };

    const result = await executeGoogleWorkspaceAction(
      "google.docs.update",
      input,
      owner,
    );

    const write = fetchMock.mock.calls[1];
    expect(write?.[0].toString()).toContain("documents/document_1:batchUpdate");
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
      writeControl: { requiredRevisionId: "revision-1" },
    });
    expect(result).toMatchObject({
      toolId: "google.docs.update",
      resourceType: "google_document",
      providerAcknowledgement: "provider_response",
    });
    expect((result as { observedTargetStateSha256: string }).observedTargetStateSha256)
      .toBe(googleWorkspaceEffectTarget("google.docs.update", input, owner.executionId).expectedTargetStateSha256);
  });

  it("refuses to replace a Docs body containing non-text structures", async () => {
    const prior = {
      ...document("before", "revision-1"),
      body: {
        content: [
          ...document("before", "revision-1").body.content,
          {
            startIndex: 8,
            endIndex: 10,
            table: { rows: 1, columns: 1, tableRows: [] },
          },
        ],
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(json(prior));
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeGoogleWorkspaceAction("google.docs.update", {
      documentId: "document_1",
      text: "after",
      expectedCurrentSha256: sha256("before"),
      expectedStructureSha256: documentStructureSha256(prior),
    }, owner)).rejects.toThrow(/non-text body content/i);

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST"))
      .toBe(false);
  });

  it("refuses to replace Docs text when positioned objects are referenced", async () => {
    const prior = document("before", "revision-1");
    const paragraph = prior.body.content[0]?.paragraph as typeof prior.body.content[number]["paragraph"] & {
      positionedObjectIds: string[];
    };
    paragraph.positionedObjectIds = ["positioned_1"];
    const providerDocument = {
      ...prior,
      positionedObjects: { positioned_1: { positionedObjectProperties: {} } },
    };
    const fetchMock = vi.fn().mockResolvedValue(json(providerDocument));
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeGoogleWorkspaceAction("google.docs.update", {
      documentId: "document_1",
      text: "after",
      expectedCurrentSha256: sha256("before"),
      expectedStructureSha256: documentStructureSha256(providerDocument),
    }, owner)).rejects.toThrow(/non-text body content/i);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST"))
      .toBe(false);
  });

  it("reconciles an already-applied Sheets write without another mutation", async () => {
    const values = [["symbol", "price"], ["NAS100", 25000]];
    const fetchMock = vi.fn().mockResolvedValue(json({ range: "Sheet1!A1:B2", values }));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      spreadsheetId: "spreadsheet_1",
      range: "Sheet1!A1:B2",
      values,
      expectedCurrentSha256: "0".repeat(64),
    };

    const result = await reconcileGoogleWorkspaceMutation(
      "google.sheets.update",
      input,
      owner,
    );

    expect(result).toMatchObject({
      providerAcknowledgement: "provider_idempotency_reconciliation",
      verificationState: "verified",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    const readUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(readUrl.searchParams.get("valueRenderOption")).toBe("FORMULA");
    expect(readUrl.searchParams.get("dateTimeRenderOption")).toBe("SERIAL_NUMBER");
  });

  it("does not treat a calculated value as the same state as its formula", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      range: "Sheet1!A1",
      values: [["=1+1"]],
    })));

    const result = await reconcileGoogleWorkspaceMutation(
      "google.sheets.update",
      {
        spreadsheetId: "spreadsheet_1",
        range: "Sheet1!A1",
        values: [[2]],
        expectedCurrentSha256: "0".repeat(64),
      },
      owner,
    );

    expect(result).toBeUndefined();
  });

  it("allows viewer-shared Docs and Slides to be read without revision IDs", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        documentId: "document_1",
        title: "Viewer doc",
        body: { content: [] },
      }))
      .mockResolvedValueOnce(json({
        presentationId: "presentation_1",
        title: "Viewer deck",
        slides: [],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const doc = await executeGoogleWorkspaceAction(
      "google.docs.read",
      { documentId: "document_1" },
      owner,
    );
    const slides = await executeGoogleWorkspaceAction(
      "google.slides.read",
      { presentationId: "presentation_1" },
      owner,
    );

    expect(doc).toMatchObject({ documentId: "document_1", text: "" });
    expect(doc).not.toHaveProperty("revisionId");
    expect(slides).toMatchObject({ presentationId: "presentation_1", objects: [] });
    expect(slides).not.toHaveProperty("revisionId");
  });

  it("returns hashes only for directly editable Slides shape text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      presentationId: "presentation_1",
      title: "Deck",
      revisionId: "revision-1",
      slides: [{
        pageElements: [
          {
            objectId: "shape_1",
            shape: {
              text: { textElements: [{ textRun: { content: "Editable text\n" } }] },
            },
          },
          {
            objectId: "group_1",
            elementGroup: {
              children: [{ shape: { text: { textElements: [{ textRun: { content: "Child" } }] } } }],
            },
          },
          {
            objectId: "table_1",
            table: {
              tableRows: [{ tableCells: [{ text: { textElements: [{ textRun: { content: "Cell" } }] } }] }],
            },
          },
        ],
      }],
    })));

    const result = await executeGoogleWorkspaceAction(
      "google.slides.read",
      { presentationId: "presentation_1" },
      owner,
    ) as { objects: Array<Record<string, unknown>> };

    expect(result.objects).toEqual([{
      objectId: "shape_1",
      text: "Editable text",
      textSha256: sha256("Editable text"),
    }]);
  });

  it("uses the documented Calendar event URL without list-only query parameters", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "event_1", status: "confirmed" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await executeGoogleWorkspaceAction(
      "calendar.delete",
      { calendarId: "primary", eventId: "event_1" },
      owner,
    );

    expect(fetchMock.mock.calls.every(([request]) =>
      !new URL(String(request)).searchParams.has("showDeleted")))
      .toBe(true);
  });

  it("never verifies or updates a cancelled Calendar event", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      id: "event_1",
      status: "cancelled",
      summary: "Updated",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeGoogleWorkspaceAction(
      "calendar.update",
      { calendarId: "primary", eventId: "event_1", summary: "Updated" },
      owner,
    )).rejects.toThrow(/cancelled/i);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"))
      .toBe(false);
  });

  it("binds calendar effect identity to both calendar and event IDs", () => {
    const first = googleWorkspaceEffectTarget(
      "calendar.delete",
      { calendarId: "calendar_a", eventId: "shared_event" },
      owner.executionId,
    );
    const second = googleWorkspaceEffectTarget(
      "calendar.delete",
      { calendarId: "calendar_b", eventId: "shared_event" },
      owner.executionId,
    );
    expect(first.targetSha256).not.toBe(second.targetSha256);
    expect(() => parseGoogleWorkspaceActionInput("calendar.update", {
      eventId: "event_1",
      summary: "Updated",
      timeZone: "Asia/Kolkata",
    })).toThrow(/time zone requires start and end/i);
    expect(parseGoogleWorkspaceActionInput("calendar.delete", {
      calendarId: "en.usa#holiday+private@group.v.calendar.google.com",
      eventId: "e".repeat(1_024),
    })).toMatchObject({
      calendarId: "en.usa#holiday+private@group.v.calendar.google.com",
      eventId: "e".repeat(1_024),
    });
  });
});

function document(text: string, revisionId: string) {
  return {
    documentId: "document_1",
    title: "Plan",
    revisionId,
    body: {
      content: [{
        startIndex: 1,
        endIndex: text.length + 2,
        paragraph: {
          elements: [{ textRun: { content: `${text}\n` } }],
        },
      }],
    },
  };
}

function json(value: unknown) {
  return Response.json(value, { status: 200 });
}

function documentStructureSha256(value: {
  body: unknown;
  inlineObjects?: unknown;
  positionedObjects?: unknown;
}) {
  return canonicalJsonSha256({
    body: value.body,
    inlineObjects: objectValue(value.inlineObjects),
    positionedObjects: objectValue(value.positionedObjects),
  });
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
