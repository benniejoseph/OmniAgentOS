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
  resumeGoogleWorkspaceCreation,
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

  it("finds live Drive files with bounded metadata and the read capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      files: [{
        id: "document_1",
        name: "O'Brien plan",
        mimeType: "application/vnd.google-apps.document",
        size: "1234",
        createdTime: "2026-09-01T10:00:00.000Z",
        modifiedTime: "2026-09-11T10:00:00.000Z",
        webViewLink: "https://docs.google.com/document/d/document_1/edit",
        parents: ["folder_1", "../../unsafe"],
        capabilities: { canEdit: true, canDownload: false },
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeGoogleWorkspaceAction(
      "google.drive.search",
      { query: "O'Brien", maxResults: 5 },
      owner,
    );

    expect(access.getActive).toHaveBeenCalledWith(expect.objectContaining({
      capability: "drive.read",
    }));
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("q")).toBe(
      "trashed = false and (name contains 'O\\'Brien' or fullText contains 'O\\'Brien')",
    );
    expect(url.searchParams.get("pageSize")).toBe("5");
    expect(result).toMatchObject({
      query: "O'Brien",
      resultCount: 1,
      contentTrust: "untrusted_provider_content",
      files: [{
        fileId: "document_1",
        name: "O'Brien plan",
        size: 1234,
        parentIds: ["folder_1"],
        canEdit: true,
        canDownload: false,
      }],
    });
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

  it("creates a native Google document from structured editable content", async () => {
    const input = {
      title: "Quarterly plan",
      blocks: [
        { type: "heading", level: 1, text: "Overview" },
        { type: "paragraph", text: "Trade only confirmed setups." },
        { type: "bullets", items: ["Wait for liquidity", "Confirm displacement"] },
      ],
    };
    let documentReads = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/drive/v3/files?") && init?.method === "GET") {
        return json({ files: [] });
      }
      if (url.includes("/drive/v3/files?") && init?.method === "POST") {
        return json({ id: "document_created" });
      }
      if (url.includes("documents/document_created:batchUpdate")) {
        return json({});
      }
      if (url.includes("/drive/v3/files/document_created")) {
        return json({
          id: "document_created",
          name: input.title,
          mimeType: "application/vnd.google-apps.document",
          trashed: false,
          appProperties: nativeCreateProperties("google.docs.create", input),
        });
      }
      if (new URL(url).pathname.endsWith("/documents/document_created")) {
        documentReads += 1;
        return documentReads === 1
          ? json({
              documentId: "document_created",
              title: input.title,
              revisionId: "revision-pristine",
              body: { content: [] },
            })
          : json({
              documentId: "document_created",
              title: input.title,
              revisionId: "revision-created",
              body: {
                content: documentParagraphs([
                  { text: "Overview", namedStyleType: "HEADING_1" },
                  { text: "Trade only confirmed setups." },
                  { text: "Wait for liquidity", bulleted: true },
                  { text: "Confirm displacement", bulleted: true },
                ]),
              },
            });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeGoogleWorkspaceAction(
      "google.docs.create",
      input,
      owner,
    );

    expect(access.getActive).toHaveBeenCalledWith({
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      capability: "docs.write",
    });
    const driveCreate = fetchMock.mock.calls.find(([request, init]) =>
      String(request).includes("/drive/v3/files?") && init?.method === "POST");
    expect(JSON.parse(String(driveCreate?.[1]?.body))).toEqual({
      name: input.title,
      mimeType: "application/vnd.google-apps.document",
      appProperties: nativeCreateProperties("google.docs.create", input),
    });
    const docsWrite = fetchMock.mock.calls.find(([request]) =>
      String(request).includes("documents/document_created:batchUpdate"));
    const docsRequests = JSON.parse(String(docsWrite?.[1]?.body)).requests;
    expect(docsRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ updateParagraphStyle: expect.any(Object) }),
      expect.objectContaining({ createParagraphBullets: expect.any(Object) }),
    ]));
    expect(JSON.parse(String(docsWrite?.[1]?.body)).writeControl).toEqual({
      requiredRevisionId: "revision-pristine",
    });
    expect(result).toMatchObject({
      toolId: "google.docs.create",
      resourceId: "document_created",
      providerAcknowledgement: "provider_response",
      verificationState: "verified",
      editorUrl: "https://docs.google.com/document/d/document_created/edit",
    });
  });

  it("reconciles a previously-created Google document by its Drive execution marker", async () => {
    const input = { title: "Research notes", bodyText: "Durable exact content" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        files: [{
          id: "document_created",
          name: input.title,
          mimeType: "application/vnd.google-apps.document",
          trashed: false,
          appProperties: nativeCreateProperties("google.docs.create", input),
        }],
      }))
      .mockResolvedValueOnce(json({
        documentId: "document_created",
        title: input.title,
        body: {
          content: [{
            startIndex: 1,
            endIndex: 23,
            paragraph: { elements: [{ textRun: { content: `${input.bodyText}\n` } }] },
          }],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileGoogleWorkspaceMutation(
      "google.docs.create",
      input,
      owner,
    );

    expect(result).toMatchObject({
      providerAcknowledgement: "provider_idempotency_reconciliation",
      resourceId: "document_created",
      editorUrl: "https://docs.google.com/document/d/document_created/edit",
    });
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET"))
      .toBe(true);
  });

  it("pages the Drive marker search and refuses a duplicate on a later page", async () => {
    const input = { title: "Research notes", bodyText: "Durable exact content" };
    const markerFile = (id: string) => ({
      id,
      name: input.title,
      mimeType: "application/vnd.google-apps.document",
      trashed: false,
      appProperties: nativeCreateProperties("google.docs.create", input),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        files: [markerFile("document_page_1")],
        nextPageToken: "page-2",
      }))
      .mockResolvedValueOnce(json({
        files: [markerFile("document_page_2")],
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileGoogleWorkspaceMutation(
      "google.docs.create",
      input,
      owner,
    )).rejects.toThrow(/marker is ambiguous/i);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams
      .get("pageToken"))
      .toBe("page-2");
  });

  it("rejects marker files whose intent, actor scope, or create version differs", async () => {
    const input = { title: "Research notes", bodyText: "Durable exact content" };
    for (const mismatch of [
      { asaelIntent: "0".repeat(64) },
      { asaelScope: "1".repeat(64) },
      { asaelCreateVersion: "1" },
    ]) {
      const fetchMock = vi.fn().mockResolvedValueOnce(json({
        files: [{
          id: "document_wrong_binding",
          name: input.title,
          mimeType: "application/vnd.google-apps.document",
          trashed: false,
          appProperties: {
            ...nativeCreateProperties("google.docs.create", input),
            ...mismatch,
          },
        }],
      }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(reconcileGoogleWorkspaceMutation(
        "google.docs.create",
        input,
        owner,
      )).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("fails closed when Drive reports an incomplete marker search", async () => {
    const input = { title: "Research notes", bodyText: "Durable exact content" };
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      files: [],
      incompleteSearch: true,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileGoogleWorkspaceMutation(
      "google.docs.create",
      input,
      owner,
    )).rejects.toThrow(/complete idempotency-marker search/i);
  });

  it("resumes a marker-owned blank Google document without creating a duplicate", async () => {
    const input = {
      title: "Research notes",
      blocks: [
        { type: "heading", level: 1, text: "Plan" },
        { type: "bullets", items: ["Observe", "Verify"] },
      ],
    };
    let documentReads = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/drive/v3/files?") && init?.method === "GET") {
        return json({
          files: [{
            id: "document_partial",
            name: input.title,
            mimeType: "application/vnd.google-apps.document",
            trashed: false,
            appProperties: nativeCreateProperties("google.docs.create", input),
          }],
        });
      }
      if (url.includes("documents/document_partial:batchUpdate")) return json({});
      if (new URL(url).pathname.endsWith("/documents/document_partial")) {
        documentReads += 1;
        return documentReads === 1
          ? json({
              documentId: "document_partial",
              title: input.title,
              revisionId: "revision-partial",
              body: { content: [] },
            })
          : json({
              documentId: "document_partial",
              title: input.title,
              revisionId: "revision-complete",
              body: {
                content: documentParagraphs([
                  { text: "Plan", namedStyleType: "HEADING_1" },
                  { text: "Observe", bulleted: true },
                  { text: "Verify", bulleted: true },
                ]),
              },
            });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resumeGoogleWorkspaceCreation(
      "google.docs.create",
      input,
      owner,
    );

    expect(result).toMatchObject({
      providerAcknowledgement: "provider_response",
      resourceId: "document_partial",
    });
    expect(fetchMock.mock.calls.filter(([request, init]) =>
      String(request).includes("documents/document_partial:batchUpdate") &&
      init?.method === "POST"))
      .toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([request, init]) =>
      String(request).includes("/drive/v3/files?") && init?.method === "POST"))
      .toHaveLength(0);
  });

  it("refuses to repair a marker-owned document containing ambiguous user content", async () => {
    const input = { title: "Research notes", bodyText: "Intended body" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        files: [{
          id: "document_partial",
          name: input.title,
          mimeType: "application/vnd.google-apps.document",
          trashed: false,
          appProperties: nativeCreateProperties("google.docs.create", input),
        }],
      }))
      .mockResolvedValueOnce(json({
        documentId: "document_partial",
        title: input.title,
        body: {
          content: [{
            startIndex: 1,
            endIndex: 19,
            paragraph: { elements: [{ textRun: { content: "User-edited content\n" } }] },
          }],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await resumeGoogleWorkspaceCreation(
      "google.docs.create",
      input,
      owner,
    )).toBeUndefined();
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET"))
      .toBe(true);
  });

  it("refuses to repair a marker-owned document when another tab exists", async () => {
    const input = { title: "Research notes", bodyText: "Intended body" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        files: [{
          id: "document_tabs",
          name: input.title,
          mimeType: "application/vnd.google-apps.document",
          trashed: false,
          appProperties: nativeCreateProperties("google.docs.create", input),
        }],
      }))
      .mockResolvedValueOnce(json({
        documentId: "document_tabs",
        title: input.title,
        revisionId: "revision-tabs",
        tabs: [
          { documentTab: { body: { content: [] } } },
          {
            documentTab: {
              body: {
                content: [{
                  startIndex: 1,
                  endIndex: 13,
                  paragraph: {
                    elements: [{ textRun: { content: "Private tab\n" } }],
                  },
                }],
              },
            },
          },
        ],
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resumeGoogleWorkspaceCreation(
      "google.docs.create",
      input,
      owner,
    )).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET"))
      .toBe(true);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams
      .get("includeTabsContent"))
      .toBe("true");
  });

  it("refuses to overwrite a styled but text-empty Google document", async () => {
    const input = { title: "Research notes", bodyText: "Intended body" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        files: [{
          id: "document_styled_blank",
          name: input.title,
          mimeType: "application/vnd.google-apps.document",
          trashed: false,
          appProperties: nativeCreateProperties("google.docs.create", input),
        }],
      }))
      .mockResolvedValueOnce(json({
        documentId: "document_styled_blank",
        title: input.title,
        revisionId: "revision-styled",
        body: {
          content: [{
            startIndex: 1,
            endIndex: 2,
            paragraph: {
              paragraphStyle: { namedStyleType: "HEADING_1" },
              elements: [{ textRun: { content: "\n" } }],
            },
          }],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resumeGoogleWorkspaceCreation(
      "google.docs.create",
      input,
      owner,
    )).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET"))
      .toBe(true);
  });

  it("creates and verifies a native Google spreadsheet with bounded RAW values", async () => {
    const input = {
      title: "Market journal",
      sheetName: "Signals",
      values: [["Symbol", "Bias"], ["XAUUSD", "Bullish"]],
    };
    let definitionReads = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/drive/v3/files?") && init?.method === "GET") {
        return json({ files: [] });
      }
      if (url.includes("/drive/v3/files?") && init?.method === "POST") {
        return json({ id: "spreadsheet_created" });
      }
      if (url.includes("/drive/v3/files/spreadsheet_created")) {
        return json({
          id: "spreadsheet_created",
          name: input.title,
          mimeType: "application/vnd.google-apps.spreadsheet",
          trashed: false,
          appProperties: nativeCreateProperties("google.sheets.create", input),
        });
      }
      if (url.includes("spreadsheets/spreadsheet_created:batchUpdate")) {
        return json({});
      }
      if (url.includes("/values/")) {
        return json({ range: "Signals!A1:B2", values: input.values });
      }
      if (url.includes("/v4/spreadsheets/spreadsheet_created")) {
        definitionReads += 1;
        return json({
          spreadsheetId: "spreadsheet_created",
          properties: { title: input.title },
          sheets: definitionReads === 1
            ? [{
                properties: {
                  sheetId: 0,
                  index: 0,
                  title: "Sheet1",
                  sheetType: "GRID",
                },
              }]
            : [
                {
                  properties: {
                    sheetId: 0,
                    index: 0,
                    title: "Sheet1",
                    sheetType: "GRID",
                  },
                },
                {
                  properties: {
                    sheetId: ownedSheetId(),
                    index: 1,
                    title: input.sheetName,
                    sheetType: "GRID",
                  },
                },
              ],
        });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeGoogleWorkspaceAction(
      "google.sheets.create",
      input,
      owner,
    );

    expect(access.getActive).toHaveBeenCalledWith(expect.objectContaining({
      capability: "sheets.write",
    }));
    const sheetWrite = fetchMock.mock.calls.find(([request, init]) =>
      String(request).includes("spreadsheet_created:batchUpdate") &&
      init?.method === "POST");
    expect(JSON.parse(String(sheetWrite?.[1]?.body))).toMatchObject({
      requests: [
        {
          addSheet: {
            properties: {
              sheetId: ownedSheetId(),
              title: "Signals",
              sheetType: "GRID",
            },
          },
        },
        {
          updateCells: {
            start: {
              sheetId: ownedSheetId(),
              rowIndex: 0,
              columnIndex: 0,
            },
            fields: "userEnteredValue",
            rows: [
              { values: [
                { userEnteredValue: { stringValue: "Symbol" } },
                { userEnteredValue: { stringValue: "Bias" } },
              ] },
              { values: [
                { userEnteredValue: { stringValue: "XAUUSD" } },
                { userEnteredValue: { stringValue: "Bullish" } },
              ] },
            ],
          },
        },
      ],
    });
    expect(result).toMatchObject({
      toolId: "google.sheets.create",
      resourceId: "spreadsheet_created",
      editorUrl: "https://docs.google.com/spreadsheets/d/spreadsheet_created/edit",
    });
  });

  it("reconciles a native Google spreadsheet without repeating its writes", async () => {
    const input = {
      title: "Market journal",
      sheetName: "Signals",
      values: [["Symbol", "Bias"], ["NAS100", "Bearish"]],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        files: [{
          id: "spreadsheet_created",
          name: input.title,
          mimeType: "application/vnd.google-apps.spreadsheet",
          trashed: false,
          appProperties: nativeCreateProperties("google.sheets.create", input),
        }],
      }))
      .mockResolvedValueOnce(json({
        spreadsheetId: "spreadsheet_created",
        properties: { title: input.title },
        sheets: [
          { properties: { sheetId: 0, index: 0, title: "Sheet1" } },
          {
            properties: {
              sheetId: ownedSheetId(),
              index: 1,
              title: input.sheetName,
            },
          },
        ],
      }))
      .mockResolvedValueOnce(json({ range: "Signals!A1:B2", values: input.values }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileGoogleWorkspaceMutation(
      "google.sheets.create",
      input,
      owner,
    );

    expect(result).toMatchObject({
      providerAcknowledgement: "provider_idempotency_reconciliation",
      resourceId: "spreadsheet_created",
    });
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET"))
      .toBe(true);
  });

  it("resumes a marker-owned spreadsheet by adding an exact owned sheet", async () => {
    const input = {
      title: "Market journal",
      sheetName: "Signals",
      values: [["Symbol", "Bias"], ["XAUUSD", "Bullish"]],
    };
    let definitionReads = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/drive/v3/files?") && init?.method === "GET") {
        return json({
          files: [{
            id: "spreadsheet_partial",
            name: input.title,
            mimeType: "application/vnd.google-apps.spreadsheet",
            trashed: false,
            appProperties: nativeCreateProperties("google.sheets.create", input),
          }],
        });
      }
      if (url.includes("spreadsheets/spreadsheet_partial:batchUpdate")) return json({});
      if (url.includes("/values/")) {
        return json({ range: "Signals", values: input.values });
      }
      if (url.includes("/v4/spreadsheets/spreadsheet_partial")) {
        definitionReads += 1;
        return json({
          spreadsheetId: "spreadsheet_partial",
          properties: { title: input.title },
          sheets: definitionReads === 1
            ? [{
                properties: { sheetId: 0, index: 0, title: "Sheet1" },
              }]
            : [
                {
                  properties: { sheetId: 0, index: 0, title: "Sheet1" },
                },
                {
                  properties: {
                    sheetId: ownedSheetId(),
                    index: 1,
                    title: input.sheetName,
                  },
                },
              ],
        });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resumeGoogleWorkspaceCreation(
      "google.sheets.create",
      input,
      owner,
    );

    expect(result).toMatchObject({
      providerAcknowledgement: "provider_response",
      resourceId: "spreadsheet_partial",
    });
    expect(fetchMock.mock.calls.filter(([request, init]) =>
      String(request).includes("spreadsheet_partial:batchUpdate") && init?.method === "POST"))
      .toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([request, init]) =>
      String(request).includes("/values/") && init?.method === "PUT"))
      .toHaveLength(0);
    const repairWrite = fetchMock.mock.calls.find(([request, init]) =>
      String(request).includes("spreadsheet_partial:batchUpdate") &&
      init?.method === "POST");
    expect(JSON.parse(String(repairWrite?.[1]?.body)).requests).toEqual([
      expect.objectContaining({ addSheet: expect.any(Object) }),
      expect.objectContaining({ updateCells: expect.any(Object) }),
    ]);
    expect(fetchMock.mock.calls.filter(([request, init]) =>
      String(request).includes("/drive/v3/files?") && init?.method === "POST"))
      .toHaveLength(0);
  });

  it("reconciles a concurrent deterministic sheet-ID collision without overwriting", async () => {
    const input = {
      title: "Market journal",
      sheetName: "Signals",
      values: [["Symbol", "Bias"]],
    };
    let definitionReads = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/drive/v3/files?") && init?.method === "GET") {
        return json({
          files: [{
            id: "spreadsheet_concurrent",
            name: input.title,
            mimeType: "application/vnd.google-apps.spreadsheet",
            trashed: false,
            appProperties: nativeCreateProperties("google.sheets.create", input),
          }],
        });
      }
      if (url.includes("spreadsheet_concurrent:batchUpdate")) {
        return Response.json({ error: { message: "sheet ID exists" } }, {
          status: 409,
        });
      }
      if (url.includes("/values/")) {
        return json({ range: "Signals!A1:B1", values: input.values });
      }
      if (url.includes("/v4/spreadsheets/spreadsheet_concurrent")) {
        definitionReads += 1;
        return json({
          spreadsheetId: "spreadsheet_concurrent",
          properties: { title: input.title },
          sheets: definitionReads === 1
            ? [{ properties: { sheetId: 0, index: 0, title: "Sheet1" } }]
            : [
                { properties: { sheetId: 0, index: 0, title: "Sheet1" } },
                {
                  properties: {
                    sheetId: ownedSheetId(),
                    index: 1,
                    title: input.sheetName,
                  },
                },
              ],
        });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resumeGoogleWorkspaceCreation(
      "google.sheets.create",
      input,
      owner,
    )).resolves.toMatchObject({
      providerAcknowledgement: "provider_idempotency_reconciliation",
      resourceId: "spreadsheet_concurrent",
    });
    const write = fetchMock.mock.calls.find(([request, init]) =>
      String(request).includes("spreadsheet_concurrent:batchUpdate") &&
      init?.method === "POST");
    expect(JSON.parse(String(write?.[1]?.body)).requests).toEqual([
      expect.objectContaining({ addSheet: expect.any(Object) }),
      expect.objectContaining({ updateCells: expect.any(Object) }),
    ]);
  });

  it("preserves a collaborator-formatted default sheet while adding the owned sheet", async () => {
    const input = {
      title: "Market journal",
      sheetName: "Signals",
      values: [["Symbol", "Bias"]],
    };
    let definitionReads = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/drive/v3/files?") && init?.method === "GET") {
        return json({
          files: [{
            id: "spreadsheet_formatted",
            name: input.title,
            mimeType: "application/vnd.google-apps.spreadsheet",
            trashed: false,
            appProperties: nativeCreateProperties("google.sheets.create", input),
          }],
        });
      }
      if (url.includes("spreadsheet_formatted:batchUpdate")) return json({});
      if (url.includes("/values/")) {
        return json({ range: "Signals!A1:B1", values: input.values });
      }
      if (url.includes("/v4/spreadsheets/spreadsheet_formatted")) {
        definitionReads += 1;
        return json({
          spreadsheetId: "spreadsheet_formatted",
          properties: { title: input.title },
          sheets: [
            {
              properties: { sheetId: 0, index: 0, title: "Sheet1" },
              data: [{
                rowData: [{
                  values: [{
                    userEnteredFormat: {
                      backgroundColor: { red: 1, green: 0.9, blue: 0.9 },
                    },
                  }],
                }],
              }],
            },
            ...(definitionReads > 1
              ? [{
                  properties: {
                    sheetId: ownedSheetId(),
                    index: 1,
                    title: input.sheetName,
                  },
                }]
              : []),
          ],
        });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resumeGoogleWorkspaceCreation(
      "google.sheets.create",
      input,
      owner,
    )).resolves.toMatchObject({ providerAcknowledgement: "provider_response" });
    const write = fetchMock.mock.calls.find(([request, init]) =>
      String(request).includes("spreadsheet_formatted:batchUpdate") &&
      init?.method === "POST");
    const requests = JSON.parse(String(write?.[1]?.body)).requests;
    expect(requests).toEqual([
      expect.objectContaining({ addSheet: expect.any(Object) }),
      expect.objectContaining({ updateCells: expect.any(Object) }),
    ]);
    expect(requests.some((request: Record<string, unknown>) =>
      request.updateSheetProperties || request.deleteSheet)).toBe(false);
  });

  it("fails closed when another sheet already owns the requested name", async () => {
    const input = {
      title: "Market journal",
      sheetName: "Signals",
      values: [["Symbol", "Bias"]],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        files: [{
          id: "spreadsheet_renamed",
          name: input.title,
          mimeType: "application/vnd.google-apps.spreadsheet",
          trashed: false,
          appProperties: nativeCreateProperties("google.sheets.create", input),
        }],
      }))
      .mockResolvedValueOnce(json({
        spreadsheetId: "spreadsheet_renamed",
        properties: { title: input.title },
        sheets: [{
          properties: { sheetId: 0, index: 0, title: input.sheetName },
        }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resumeGoogleWorkspaceCreation(
      "google.sheets.create",
      input,
      owner,
    )).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET"))
      .toBe(true);
  });

  it("creates a themed Google Slides deck with editable text shapes", async () => {
    const marker = sha256(owner.executionId);
    const prefix = `asael_${marker.slice(0, 20)}`;
    const input = {
      title: "Weekly market brief",
      slides: [
        {
          title: "XAUUSD weekly outlook",
          body: "Price is consolidating above support.",
          bullets: ["Watch prior-week high", "Confirm London displacement"],
        },
        {
          title: "Execution checklist",
          bullets: ["Wait for liquidity", "Respect invalidation"],
        },
      ],
    };
    let presentationReads = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/drive/v3/files?") && init?.method === "GET") {
        return json({ files: [] });
      }
      if (url.includes("/drive/v3/files?") && init?.method === "POST") {
        return json({ id: "presentation_created" });
      }
      if (url.includes("/drive/v3/files/presentation_created")) {
        return json({
          id: "presentation_created",
          name: input.title,
          mimeType: "application/vnd.google-apps.presentation",
          trashed: false,
          appProperties: slideCreateProperties(input),
        });
      }
      if (url.includes("presentations/presentation_created:batchUpdate")) {
        return json({});
      }
      if (url.endsWith("/presentations/presentation_created")) {
        presentationReads += 1;
        if (presentationReads <= 2) {
          return json({
            presentationId: "presentation_created",
            title: input.title,
            revisionId: "revision-pristine",
            slides: [{ objectId: "initial_slide", pageElements: [] }],
          });
        }
        return json({
          presentationId: "presentation_created",
          title: input.title,
          slides: [
            {
              objectId: `${prefix}_s01`,
              pageProperties: themedPageProperties(),
              pageElements: [
                slideShape(`${prefix}_t01`, input.slides[0].title),
                slideShape(`${prefix}_b01`, input.slides[0].body!),
                slideShape(`${prefix}_l01`, input.slides[0].bullets!.join("\n"), {
                  bulletCount: input.slides[0].bullets!.length,
                }),
              ],
            },
            {
              objectId: `${prefix}_s02`,
              pageProperties: themedPageProperties(),
              pageElements: [
                slideShape(`${prefix}_t02`, input.slides[1].title),
                slideShape(`${prefix}_l02`, input.slides[1].bullets!.join("\n"), {
                  bulletCount: input.slides[1].bullets!.length,
                }),
              ],
            },
          ],
        });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeGoogleWorkspaceAction(
      "google.slides.create",
      input,
      owner,
    );

    expect(access.getActive).toHaveBeenCalledWith(expect.objectContaining({
      capability: "slides.write",
    }));
    const write = fetchMock.mock.calls.find(([request]) =>
      String(request).includes("presentations/presentation_created:batchUpdate"));
    const writeBody = JSON.parse(String(write?.[1]?.body));
    const requests = writeBody.requests;
    expect(writeBody.writeControl).toEqual({
      requiredRevisionId: "revision-pristine",
    });
    expect(requests).toEqual(expect.arrayContaining([
      { deleteObject: { objectId: "initial_slide" } },
      expect.objectContaining({ updatePageProperties: expect.any(Object) }),
      expect.objectContaining({ createParagraphBullets: expect.any(Object) }),
    ]));
    expect(requests.filter((request: Record<string, unknown>) => request.createSlide))
      .toHaveLength(2);
    expect(requests.filter((request: Record<string, unknown>) => request.createShape))
      .toHaveLength(5);
    expect(result).toMatchObject({
      toolId: "google.slides.create",
      resourceId: "presentation_created",
      editorUrl: "https://docs.google.com/presentation/d/presentation_created/edit",
    });
  });

  it("recovers a pristine Slides allocation after the seed-binding PATCH fails", async () => {
    const marker = sha256(owner.executionId);
    const prefix = `asael_${marker.slice(0, 20)}`;
    const input = {
      title: "Seed recovery brief",
      slides: [{ title: "XAUUSD", body: "Monitor the weekly range." }],
    };
    let searchCount = 0;
    let createCount = 0;
    let seedPatchCount = 0;
    let batchCount = 0;
    let seedBound = false;
    let blueprintApplied = false;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/drive/v3/files?") && init?.method === "GET") {
        searchCount += 1;
        return searchCount === 1
          ? json({ files: [] })
          : json({
              files: [{
                id: "presentation_seed_crash",
                name: input.title,
                mimeType: "application/vnd.google-apps.presentation",
                trashed: false,
                appProperties: seedBound
                  ? slideCreateProperties(input)
                  : nativeCreateProperties("google.slides.create", input),
              }],
            });
      }
      if (url.includes("/drive/v3/files?") && init?.method === "POST") {
        createCount += 1;
        return json({ id: "presentation_seed_crash" });
      }
      if (url.includes("/drive/v3/files/presentation_seed_crash")) {
        if (init?.method === "PATCH") {
          seedPatchCount += 1;
          if (seedPatchCount === 1) {
            return Response.json({ error: { message: "seed write failed" } }, {
              status: 503,
            });
          }
          seedBound = true;
        }
        return json({
          id: "presentation_seed_crash",
          name: input.title,
          mimeType: "application/vnd.google-apps.presentation",
          trashed: false,
          appProperties: seedBound
            ? slideCreateProperties(input)
            : nativeCreateProperties("google.slides.create", input),
        });
      }
      if (url.includes("presentations/presentation_seed_crash:batchUpdate")) {
        batchCount += 1;
        blueprintApplied = true;
        return json({});
      }
      if (url.endsWith("/presentations/presentation_seed_crash")) {
        return blueprintApplied
          ? json({
              presentationId: "presentation_seed_crash",
              title: input.title,
              revisionId: "revision-complete",
              slides: [{
                objectId: `${prefix}_s01`,
                pageProperties: themedPageProperties(),
                pageElements: [
                  slideShape(`${prefix}_t01`, input.slides[0].title),
                  slideShape(`${prefix}_b01`, input.slides[0].body),
                ],
              }],
            })
          : json({
              presentationId: "presentation_seed_crash",
              title: input.title,
              revisionId: "revision-pristine",
              slides: [{ objectId: "initial_slide", pageElements: [] }],
            });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeGoogleWorkspaceAction(
      "google.slides.create",
      input,
      owner,
    )).rejects.toThrow(/returned 503/i);
    await expect(resumeGoogleWorkspaceCreation(
      "google.slides.create",
      input,
      owner,
    )).resolves.toMatchObject({
      providerAcknowledgement: "provider_response",
      resourceId: "presentation_seed_crash",
    });
    expect(createCount).toBe(1);
    expect(searchCount).toBe(2);
    expect(seedPatchCount).toBe(2);
    expect(batchCount).toBe(1);
  });

  it("reconciles a native Google presentation from its deterministic editable shapes", async () => {
    const marker = sha256(owner.executionId);
    const prefix = `asael_${marker.slice(0, 20)}`;
    const input = {
      title: "Weekly market brief",
      slides: [
        {
          title: "XAUUSD weekly outlook",
          bullets: ["Wait for liquidity", "Confirm displacement"],
        },
        {
          title: "NAS100 weekly outlook",
          body: "Monitor the prior-week range.",
        },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        files: [{
          id: "presentation_created",
          name: input.title,
          mimeType: "application/vnd.google-apps.presentation",
          trashed: false,
          appProperties: slideCreateProperties(input),
        }],
      }))
      .mockResolvedValueOnce(json({
        presentationId: "presentation_created",
        title: input.title,
        slides: [
          {
            objectId: `${prefix}_s01`,
            pageProperties: themedPageProperties(),
            pageElements: [
              slideShape(`${prefix}_t01`, input.slides[0].title),
              slideShape(`${prefix}_l01`, input.slides[0].bullets!.join("\n"), {
                bulletCount: input.slides[0].bullets!.length,
              }),
            ],
          },
          {
            objectId: `${prefix}_s02`,
            pageProperties: themedPageProperties(),
            pageElements: [
              slideShape(`${prefix}_t02`, input.slides[1].title),
              slideShape(`${prefix}_b02`, input.slides[1].body!),
            ],
          },
        ],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileGoogleWorkspaceMutation(
      "google.slides.create",
      input,
      owner,
    );

    expect(result).toMatchObject({
      providerAcknowledgement: "provider_idempotency_reconciliation",
      resourceId: "presentation_created",
    });
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET"))
      .toBe(true);
  });

  it("repairs a pristine marker-owned presentation into the intended multi-slide deck", async () => {
    const marker = sha256(owner.executionId);
    const prefix = `asael_${marker.slice(0, 20)}`;
    const input = {
      title: "Weekly market brief",
      slides: [
        { title: "XAUUSD", body: "Monitor the weekly range." },
        { title: "NAS100", bullets: ["Wait for liquidity", "Confirm displacement"] },
      ],
    };
    let presentationReads = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("/drive/v3/files?") && init?.method === "GET") {
        return json({
          files: [{
            id: "presentation_partial",
            name: input.title,
            mimeType: "application/vnd.google-apps.presentation",
            trashed: false,
            appProperties: slideCreateProperties(input),
          }],
        });
      }
      if (url.includes("presentations/presentation_partial:batchUpdate")) return json({});
      if (url.endsWith("/presentations/presentation_partial")) {
        presentationReads += 1;
        if (presentationReads === 1) {
          return json({
            presentationId: "presentation_partial",
            title: input.title,
            revisionId: "revision-partial",
            slides: [{ objectId: "initial_slide", pageElements: [] }],
          });
        }
        return json({
          presentationId: "presentation_partial",
          title: input.title,
          revisionId: "revision-complete",
          slides: [
            {
              objectId: `${prefix}_s01`,
              pageProperties: themedPageProperties(),
              pageElements: [
                slideShape(`${prefix}_t01`, input.slides[0].title),
                slideShape(`${prefix}_b01`, input.slides[0].body!),
              ],
            },
            {
              objectId: `${prefix}_s02`,
              pageProperties: themedPageProperties(),
              pageElements: [
                slideShape(`${prefix}_t02`, input.slides[1].title),
                slideShape(`${prefix}_l02`, input.slides[1].bullets!.join("\n"), {
                  bulletCount: input.slides[1].bullets!.length,
                }),
              ],
            },
          ],
        });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resumeGoogleWorkspaceCreation(
      "google.slides.create",
      input,
      owner,
    );

    expect(result).toMatchObject({
      providerAcknowledgement: "provider_response",
      resourceId: "presentation_partial",
    });
    expect(fetchMock.mock.calls.filter(([request, init]) =>
      String(request).includes("presentation_partial:batchUpdate") && init?.method === "POST"))
      .toHaveLength(1);
    const repairWrite = fetchMock.mock.calls.find(([request, init]) =>
      String(request).includes("presentation_partial:batchUpdate") && init?.method === "POST");
    const repairBody = JSON.parse(String(repairWrite?.[1]?.body));
    expect(repairBody.writeControl).toEqual({ requiredRevisionId: "revision-partial" });
    expect(repairBody.requests).toEqual(expect.arrayContaining([
      { deleteObject: { objectId: "initial_slide" } },
      { createSlide: expect.objectContaining({ objectId: `${prefix}_s01` }) },
    ]));
    expect(fetchMock.mock.calls.filter(([request, init]) =>
      String(request).includes("/drive/v3/files?") && init?.method === "POST"))
      .toHaveLength(0);
  });

  it("refuses to delete a blank-looking slide with notes or a custom background", async () => {
    const input = {
      title: "Weekly market brief",
      slides: [{ title: "XAUUSD", body: "Monitor the weekly range." }],
    };
    for (const unsafeState of [
      {
        notesPage: {
          pageElements: [slideShape("speaker_notes", "Private note")],
        },
      },
      {
        pageProperties: {
          pageBackgroundFill: {
            solidFill: {
              color: { rgbColor: { red: 1, green: 0, blue: 0 } },
            },
          },
        },
      },
    ]) {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json({
          files: [{
            id: "presentation_unsafe",
            name: input.title,
            mimeType: "application/vnd.google-apps.presentation",
            trashed: false,
            appProperties: slideCreateProperties(input),
          }],
        }))
        .mockResolvedValueOnce(json({
          presentationId: "presentation_unsafe",
          title: input.title,
          revisionId: "revision-unsafe",
          slides: [{
            objectId: "initial_slide",
            pageElements: [],
            ...unsafeState,
          }],
        }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(resumeGoogleWorkspaceCreation(
        "google.slides.create",
        input,
        owner,
      )).resolves.toBeUndefined();
      expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET"))
        .toBe(true);
    }
  });

  it("does not reconcile bullet text unless editable bullet semantics match", async () => {
    const marker = sha256(owner.executionId);
    const prefix = `asael_${marker.slice(0, 20)}`;
    const input = {
      title: "Weekly market brief",
      slides: [{ title: "Checklist", bullets: ["Wait", "Confirm"] }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        files: [{
          id: "presentation_plain_text",
          name: input.title,
          mimeType: "application/vnd.google-apps.presentation",
          trashed: false,
          appProperties: slideCreateProperties(input),
        }],
      }))
      .mockResolvedValueOnce(json({
        presentationId: "presentation_plain_text",
        title: input.title,
        slides: [{
          objectId: `${prefix}_s01`,
          pageProperties: themedPageProperties(),
          pageElements: [
            slideShape(`${prefix}_t01`, input.slides[0].title),
            slideShape(`${prefix}_l01`, input.slides[0].bullets.join("\n")),
          ],
        }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileGoogleWorkspaceMutation(
      "google.slides.create",
      input,
      owner,
    )).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET"))
      .toBe(true);
  });

  it("strictly bounds native Workspace create schemas without binary escape hatches", () => {
    expect(() => parseGoogleWorkspaceActionInput("google.docs.create", {
      title: "Plan",
      bodyText: "Plain",
      blocks: [{ type: "paragraph", text: "Structured" }],
    })).toThrow(/exactly one/i);
    expect(() => parseGoogleWorkspaceActionInput("google.docs.create", {
      title: "Plan",
      bodyText: "Plain",
      contentBase64: "cHJpdmF0ZQ==",
    })).toThrow();
    expect(() => parseGoogleWorkspaceActionInput("google.docs.create", {
      title: "Plan",
      blocks: [{ type: "bullets", items: ["one\ntwo"] }],
    })).toThrow(/one line/i);
    expect(() => parseGoogleWorkspaceActionInput("google.sheets.create", {
      title: "Journal",
      sheetName: "Bad/Name",
      values: [["value"]],
    })).toThrow(/sheet name/i);
    expect(() => parseGoogleWorkspaceActionInput("google.sheets.create", {
      title: "Journal",
      sheetName: "Signals",
      values: [["=IMPORTDATA(\"https://example.test\")"]],
    })).toThrow(/formulas/i);
    expect(() => parseGoogleWorkspaceActionInput("google.sheets.create", {
      title: "Journal",
      sheetName: "Signals",
      values: [[...Array.from({ length: 5 }, () => "x".repeat(50_000))]],
    })).toThrow(/200000 string characters/i);
    expect(() => parseGoogleWorkspaceActionInput("google.slides.create", {
      title: "Deck",
      slides: [{ title: "Empty" }],
    })).toThrow(/body text, bullets/i);
    expect(() => parseGoogleWorkspaceActionInput("google.slides.create", {
      title: "Deck",
      slides: [{ title: "Title", body: "Body", imageBase64: "cHJpdmF0ZQ==" }],
    })).toThrow();
    expect(() => parseGoogleWorkspaceActionInput("google.slides.create", {
      title: "Deck",
      slides: [],
    })).toThrow();
    expect(() => parseGoogleWorkspaceActionInput("google.slides.create", {
      title: "Deck",
      slides: Array.from({ length: 25 }, (_, index) => ({
        title: `Slide ${index + 1}`,
        body: "Bounded body",
      })),
    })).toThrow();
    expect(access.getActive).not.toHaveBeenCalled();
  });

  it("binds Docs create receipts to canonical structure as well as plain text", () => {
    const heading = googleWorkspaceEffectTarget(
      "google.docs.create",
      {
        title: "Structured note",
        blocks: [{ type: "heading", level: 1, text: "Plan" }],
      },
      owner.executionId,
    );
    const paragraph = googleWorkspaceEffectTarget(
      "google.docs.create",
      {
        title: "Structured note",
        blocks: [{ type: "paragraph", text: "Plan" }],
      },
      owner.executionId,
    );

    expect(heading.expectedTargetStateSha256)
      .not.toBe(paragraph.expectedTargetStateSha256);
  });

  it("does not reconcile a requested paragraph that was restyled as a heading", async () => {
    const input = {
      title: "Structured note",
      blocks: [{ type: "paragraph", text: "Plan" }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        files: [{
          id: "document_restyled",
          name: input.title,
          mimeType: "application/vnd.google-apps.document",
          trashed: false,
          appProperties: nativeCreateProperties("google.docs.create", input),
        }],
      }))
      .mockResolvedValueOnce(json({
        documentId: "document_restyled",
        title: input.title,
        revisionId: "revision-restyled",
        body: {
          content: documentParagraphs([{
            text: "Plan",
            namedStyleType: "HEADING_1",
          }]),
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileGoogleWorkspaceMutation(
      "google.docs.create",
      input,
      owner,
    )).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET"))
      .toBe(true);
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

  it("refuses ambiguous RAW strings that exact reads cannot distinguish from formulas", () => {
    expect(() => parseGoogleWorkspaceActionInput("google.sheets.update", {
      spreadsheetId: "spreadsheet_1",
      range: "Sheet1!A1",
      values: [["=1+1"]],
      expectedCurrentSha256: "0".repeat(64),
    })).toThrow(/cannot accept strings beginning with '='.*formulas/i);

    expect(parseGoogleWorkspaceActionInput("google.sheets.update", {
      spreadsheetId: "spreadsheet_1",
      range: "Sheet1!A1",
      values: [[""]],
      expectedCurrentSha256: "0".repeat(64),
    })).toMatchObject({ values: [[""]] });

    expect(access.getActive).not.toHaveBeenCalled();
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
        objectId: "slide_1",
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

function slideShape(
  objectId: string,
  text: string,
  options: Readonly<{ bulletCount?: number }> = {},
) {
  return {
    objectId,
    shape: {
      text: {
        textElements: [
          ...Array.from({ length: options.bulletCount || 0 }, () => ({
            paragraphMarker: { bullet: { glyph: "•" } },
          })),
          { textRun: { content: `${text}\n` } },
        ],
      },
    },
  };
}

function nativeCreateProperties(
  toolId: "google.docs.create" | "google.sheets.create" | "google.slides.create",
  input: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  return {
    asaelExecution: sha256(owner.executionId),
    asaelIntent: canonicalJsonSha256({ toolId, input }),
    asaelScope: canonicalJsonSha256({
      tenantId: owner.tenantId,
      actorId: owner.actorId,
    }),
    asaelCreateVersion: "2",
    ...extra,
  };
}

function slideCreateProperties(input: Record<string, unknown>) {
  return nativeCreateProperties("google.slides.create", input, {
    asaelSeedSlide: sha256("initial_slide"),
    asaelSeedState: canonicalJsonSha256({
      pageElements: [],
      pageProperties: {},
      notesPage: {},
    }),
  });
}

function ownedSheetId() {
  return (Number.parseInt(sha256(owner.executionId).slice(0, 8), 16) %
    2_147_483_646) + 1;
}

function themedPageProperties() {
  return {
    pageBackgroundFill: {
      solidFill: {
        color: {
          rgbColor: { red: 0.965, green: 0.976, blue: 0.973 },
        },
      },
    },
  };
}

function documentParagraphs(
  entries: readonly Readonly<{
    text: string;
    namedStyleType?: string;
    bulleted?: boolean;
  }>[],
) {
  let cursor = 1;
  return entries.map((entry) => {
    const content = `${entry.text}\n`;
    const startIndex = cursor;
    cursor += content.length;
    return {
      startIndex,
      endIndex: cursor,
      paragraph: {
        ...(entry.namedStyleType
          ? { paragraphStyle: { namedStyleType: entry.namedStyleType } }
          : {}),
        ...(entry.bulleted
          ? { bullet: { listId: "asael_list", nestingLevel: 0 } }
          : {}),
        elements: [{
          startIndex,
          endIndex: cursor,
          textRun: { content },
        }],
      },
    };
  });
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
