import { createHash } from "node:crypto";
import { z } from "zod";

import { getActiveGoogleWorkspaceAccess } from "@/lib/connectors/google-workspace-access";
import type { GoogleWorkspaceCapability } from "@/lib/connectors/google-workspace-capabilities";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const MAX_PROVIDER_JSON_BYTES = 1_000_000;
const MAX_FILE_BYTES = 160_000;
const MAX_DOWNLOAD_PREVIEW_BYTES = 250_000;
const MAX_TEXT_CHARS = 200_000;
const GOOGLE_NATIVE_MIME_PREFIX = "application/vnd.google-apps.";
const DRIVE_FILE_FIELDS = "id,name,mimeType,parents,trashed,size,md5Checksum,appProperties";

const providerIdSchema = z.string().trim().min(1).max(240)
  .regex(/^[A-Za-z0-9_.:@-]+$/, "Google resource ID contains unsupported characters.");
const calendarIdSchema = z.string().trim().min(1).max(500)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "Google Calendar ID contains unsupported characters.",
  });
const calendarEventIdSchema = z.string().trim().min(1).max(1_024)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "Google Calendar event ID contains unsupported characters.",
  });
const resourceNameSchema = z.string().trim().min(1).max(255)
  .refine((value) => value !== "." && value !== ".." && !/[\u0000-\u001f\u007f]/.test(value), {
    message: "File name contains unsupported characters.",
  });
const mimeTypeSchema = z.string().trim().min(3).max(127)
  .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/)
  .refine((value) => !value.toLowerCase().startsWith(GOOGLE_NATIVE_MIME_PREFIX), {
    message: "Use the Docs, Sheets, or Slides tool for native Google Workspace files.",
  });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const boundedTextSchema = z.string().max(MAX_TEXT_CHARS);
const a1RangeSchema = z.string().trim().min(1).max(500)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Sheet range contains unsupported characters.");
const dateTimeSchema = z.string().datetime({ offset: true });

const base64ContentSchema = z.string().max(Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8)
  .refine(isCanonicalBase64, "File content must be canonical base64.");
const sheetCellSchema = z.union([
  z.string().max(50_000),
  z.number().finite(),
  z.boolean(),
]);
const sheetWriteCellSchema = z.union([
  z.string().max(50_000).refine((value) => !value.startsWith("="), {
    message:
      "RAW Sheets updates cannot accept strings beginning with '=' because exact verification cannot distinguish them from formulas.",
  }),
  z.number().finite(),
  z.boolean(),
]);
const sheetReadValuesSchema = z.array(z.array(sheetCellSchema).max(100)).max(50);
const sheetValuesSchema = z.array(
  z.array(sheetWriteCellSchema).min(1).max(100),
).min(1).max(50)
  .superRefine((rows, context) => {
    const cells = rows.reduce((total, row) => total + row.length, 0);
    if (cells === 0) {
      context.addIssue({
        code: "custom",
        message: "A Sheets update requires at least one addressed cell.",
      });
    }
    if (cells > 5_000) {
      context.addIssue({
        code: "custom",
        message: "A Sheets update may contain at most 5,000 cells.",
      });
    }
  });

export const googleWorkspaceActionSchemas = Object.freeze({
  "google.gmail.search": z.object({
    query: z.string().trim().min(1).max(500)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Gmail query contains unsupported characters."),
    maxResults: z.number().int().min(1).max(10).default(5),
  }).strict(),
  "google.gmail.read": z.object({ messageId: providerIdSchema }).strict(),
  "google.gmail.trash": z.object({ messageId: providerIdSchema }).strict(),
  "google.drive.search": z.object({
    query: z.string().trim().min(1).max(200)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Drive search contains unsupported characters.")
      .optional(),
    maxResults: z.number().int().min(1).max(20).default(10),
  }).strict(),
  "google.drive.download": z.object({
    fileId: providerIdSchema,
    maxBytes: z.number().int().min(1).max(MAX_DOWNLOAD_PREVIEW_BYTES).default(64_000),
  }).strict(),
  "google.drive.create": z.object({
    name: resourceNameSchema,
    mimeType: mimeTypeSchema,
    contentBase64: base64ContentSchema,
    parentId: providerIdSchema.optional(),
  }).strict(),
  "google.drive.update": z.object({
    fileId: providerIdSchema,
    mimeType: mimeTypeSchema,
    contentBase64: base64ContentSchema,
    expectedCurrentSha256: sha256Schema,
  }).strict(),
  "google.drive.move": z.object({
    fileId: providerIdSchema,
    parentId: providerIdSchema,
  }).strict(),
  "google.drive.rename": z.object({
    fileId: providerIdSchema,
    name: resourceNameSchema,
  }).strict(),
  "google.drive.trash": z.object({ fileId: providerIdSchema }).strict(),
  "google.docs.read": z.object({ documentId: providerIdSchema }).strict(),
  "google.docs.update": z.object({
    documentId: providerIdSchema,
    text: boundedTextSchema,
    expectedCurrentSha256: sha256Schema,
    expectedStructureSha256: sha256Schema,
  }).strict(),
  "google.sheets.read": z.object({
    spreadsheetId: providerIdSchema,
    range: a1RangeSchema,
  }).strict(),
  "google.sheets.update": z.object({
    spreadsheetId: providerIdSchema,
    range: a1RangeSchema,
    values: sheetValuesSchema,
    expectedCurrentSha256: sha256Schema,
  }).strict(),
  "google.slides.read": z.object({ presentationId: providerIdSchema }).strict(),
  "google.slides.update": z.object({
    presentationId: providerIdSchema,
    objectId: providerIdSchema,
    text: boundedTextSchema,
    expectedCurrentSha256: sha256Schema,
  }).strict(),
  "calendar.update": z.object({
    calendarId: calendarIdSchema.default("primary"),
    eventId: calendarEventIdSchema,
    summary: z.string().trim().min(1).max(1_000).optional(),
    description: z.string().max(8_000).optional(),
    location: z.string().max(1_000).optional(),
    start: dateTimeSchema.optional(),
    end: dateTimeSchema.optional(),
    timeZone: z.string().trim().min(1).max(100).optional(),
    attendees: z.array(z.string().email().max(320)).max(50).optional(),
  }).strict().superRefine((value, context) => {
    const mutableKeys = ["summary", "description", "location", "start", "end", "attendees"] as const;
    if (!mutableKeys.some((key) => value[key] !== undefined)) {
      context.addIssue({ code: "custom", message: "Calendar update requires at least one changed field." });
    }
    if ((value.start === undefined) !== (value.end === undefined)) {
      context.addIssue({ code: "custom", path: ["end"], message: "Calendar start and end must be updated together." });
    }
    if (value.timeZone !== undefined && value.start === undefined) {
      context.addIssue({ code: "custom", path: ["timeZone"], message: "Calendar time zone requires start and end." });
    }
    if (value.start && value.end && Date.parse(value.end) <= Date.parse(value.start)) {
      context.addIssue({ code: "custom", path: ["end"], message: "Calendar event end must be after start." });
    }
  }),
  "calendar.delete": z.object({
    calendarId: calendarIdSchema.default("primary"),
    eventId: calendarEventIdSchema,
  }).strict(),
});

export type GoogleWorkspaceActionToolId = keyof typeof googleWorkspaceActionSchemas;

export const GOOGLE_WORKSPACE_ACTION_TOOL_IDS = Object.freeze(
  Object.keys(googleWorkspaceActionSchemas) as GoogleWorkspaceActionToolId[],
);

export const GOOGLE_WORKSPACE_MUTATION_TOOL_IDS = Object.freeze([
  "google.gmail.trash",
  "google.drive.create",
  "google.drive.update",
  "google.drive.move",
  "google.drive.rename",
  "google.drive.trash",
  "google.docs.update",
  "google.sheets.update",
  "google.slides.update",
  "calendar.update",
  "calendar.delete",
] as const satisfies readonly GoogleWorkspaceActionToolId[]);

const mutationIds = new Set<string>(GOOGLE_WORKSPACE_MUTATION_TOOL_IDS);

export const googleWorkspaceEffectResultSchema = z.object({
  toolId: z.enum(GOOGLE_WORKSPACE_MUTATION_TOOL_IDS),
  resourceType: z.enum(["gmail_message", "drive_file", "google_document", "google_spreadsheet", "google_presentation", "google_calendar_event"]),
  resourceId: z.string().trim().min(1).max(1_024)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  resourceIdSha256: sha256Schema,
  providerAcknowledgement: z.enum(["provider_response", "provider_idempotency_reconciliation"]),
  providerAcknowledgementId: z.string().min(1).max(160),
  providerAcknowledgementSha256: sha256Schema,
  observedTargetStateSha256: sha256Schema,
  verificationState: z.literal("verified"),
  verificationReasonCode: z.literal("state_matched"),
}).strict();

export type GoogleWorkspaceEffectResult = z.infer<typeof googleWorkspaceEffectResultSchema>;

type ActionOptions = Readonly<{
  tenantId: string;
  actorId: string;
  executionId: string;
  abortSignal?: AbortSignal;
}>;

type EffectActionOptions = ActionOptions & Readonly<{
  effectInput: Record<string, unknown>;
}>;

type EffectTarget = Readonly<{
  targetType: "google_workspace_resource";
  targetId: string;
  targetSha256: string;
  expectedTargetStateSha256: string;
}>;

export function isGoogleWorkspaceActionToolId(value: string): value is GoogleWorkspaceActionToolId {
  return value in googleWorkspaceActionSchemas;
}

export function isGoogleWorkspaceMutationToolId(
  value: string,
): value is (typeof GOOGLE_WORKSPACE_MUTATION_TOOL_IDS)[number] {
  return mutationIds.has(value);
}

export function parseGoogleWorkspaceActionInput(
  toolId: GoogleWorkspaceActionToolId,
  input: unknown,
): Record<string, unknown> {
  const schema = googleWorkspaceActionSchemas[toolId] as z.ZodType<Record<string, unknown>>;
  return schema.parse(input);
}

export function googleWorkspaceAuditInput(
  toolId: GoogleWorkspaceActionToolId,
  inputValue: unknown,
) {
  const input = parseGoogleWorkspaceActionInput(toolId, inputValue);
  if (
    (toolId === "google.drive.create" || toolId === "google.drive.update") &&
    typeof input.contentBase64 === "string"
  ) {
    const bytes = decodeBase64(input.contentBase64);
    return {
      ...input,
      contentBase64: "[sealed binary content]",
      contentBytes: bytes.byteLength,
      contentSha256: sha256(bytes),
    };
  }
  return input;
}

export function googleWorkspaceEffectTarget(
  toolId: (typeof GOOGLE_WORKSPACE_MUTATION_TOOL_IDS)[number],
  inputValue: unknown,
  executionId: string,
): EffectTarget {
  const input = parseGoogleWorkspaceActionInput(toolId, inputValue);
  const identity = effectIdentity(toolId, input, executionId);
  const targetSha256 = canonicalJsonSha256(identity);
  return Object.freeze({
    targetType: "google_workspace_resource",
    targetId: `google_workspace_${targetSha256.slice(0, 52)}`,
    targetSha256,
    expectedTargetStateSha256: canonicalJsonSha256(
      expectedTargetState(toolId, input, executionId),
    ),
  });
}

export async function executeGoogleWorkspaceAction(
  toolId: GoogleWorkspaceActionToolId,
  inputValue: unknown,
  options: ActionOptions,
): Promise<unknown> {
  const input = parseGoogleWorkspaceActionInput(toolId, inputValue);
  const access = await getActiveGoogleWorkspaceAccess({
    tenantId: requiredOwner(options.tenantId, "tenant"),
    actorId: requiredOwner(options.actorId, "actor"),
    capability: capabilityForTool(toolId),
  });
  const provider = { accessToken: access.accessToken, abortSignal: options.abortSignal };
  const effectOptions: EffectActionOptions = { ...options, effectInput: input };

  switch (toolId) {
    case "google.gmail.search":
      return searchGmailMessages(input, provider);
    case "google.gmail.read":
      return readGmailMessageResult(input, provider);
    case "google.gmail.trash":
      return trashGmailMessage(input, effectOptions, provider, "provider_response");
    case "google.drive.search":
      return searchDriveFiles(input, provider);
    case "google.drive.download":
      return downloadDriveFile(input, provider);
    case "google.drive.create":
      return createDriveFile(input, effectOptions, provider);
    case "google.drive.update":
      return updateDriveFile(input, effectOptions, provider);
    case "google.drive.move":
      return moveDriveFile(input, effectOptions, provider);
    case "google.drive.rename":
      return renameDriveFile(input, effectOptions, provider);
    case "google.drive.trash":
      return trashDriveFile(input, effectOptions, provider);
    case "google.docs.read":
      return readDocumentResult(input, provider);
    case "google.docs.update":
      return updateDocument(input, effectOptions, provider);
    case "google.sheets.read":
      return readSheetResult(input, provider);
    case "google.sheets.update":
      return updateSheet(input, effectOptions, provider);
    case "google.slides.read":
      return readPresentationResult(input, provider);
    case "google.slides.update":
      return updatePresentation(input, effectOptions, provider);
    case "calendar.update":
      return updateCalendarEvent(input, effectOptions, provider);
    case "calendar.delete":
      return deleteCalendarEvent(input, effectOptions, provider);
  }
}

export async function reconcileGoogleWorkspaceMutation(
  toolId: (typeof GOOGLE_WORKSPACE_MUTATION_TOOL_IDS)[number],
  inputValue: unknown,
  options: ActionOptions,
): Promise<GoogleWorkspaceEffectResult | undefined> {
  const input = parseGoogleWorkspaceActionInput(toolId, inputValue);
  const access = await getActiveGoogleWorkspaceAccess({
    tenantId: requiredOwner(options.tenantId, "tenant"),
    actorId: requiredOwner(options.actorId, "actor"),
    capability: capabilityForTool(toolId),
  });
  const provider = { accessToken: access.accessToken, abortSignal: options.abortSignal };
  const effectOptions: EffectActionOptions = { ...options, effectInput: input };
  const acknowledgement = "provider_idempotency_reconciliation" as const;
  switch (toolId) {
    case "google.gmail.trash": {
      const message = await readGmailMessageMinimal(String(input.messageId), provider);
      return message && stringArray(message.labelIds).includes("TRASH")
        ? verifiedEffect(toolId, "gmail_message", String(input.messageId), effectOptions, acknowledgement)
        : undefined;
    }
    case "google.drive.create": {
      const file = await findDriveFileByExecution(options.executionId, provider);
      return file && await driveFileMatchesCreate(file, input, options.executionId, provider)
        ? verifiedEffect(toolId, "drive_file", requiredProviderId(file.id), effectOptions, acknowledgement)
        : undefined;
    }
    case "google.drive.update": {
      const file = await readDriveFile(String(input.fileId), provider);
      return file && await driveFileMatchesContent(file, input, provider)
        ? verifiedEffect(toolId, "drive_file", String(input.fileId), effectOptions, acknowledgement)
        : undefined;
    }
    case "google.drive.move": {
      const file = await readDriveFile(String(input.fileId), provider);
      return file && parentsMatch(file, String(input.parentId))
        ? verifiedEffect(toolId, "drive_file", String(input.fileId), effectOptions, acknowledgement)
        : undefined;
    }
    case "google.drive.rename": {
      const file = await readDriveFile(String(input.fileId), provider);
      return file && String(file.name || "") === input.name
        ? verifiedEffect(toolId, "drive_file", String(input.fileId), effectOptions, acknowledgement)
        : undefined;
    }
    case "google.drive.trash": {
      const file = await readDriveFile(String(input.fileId), provider, true);
      return file && file.trashed === true
        ? verifiedEffect(toolId, "drive_file", String(input.fileId), effectOptions, acknowledgement)
        : undefined;
    }
    case "google.docs.update": {
      const document = await readDocument(String(input.documentId), provider);
      return sha256(document.text) === sha256(String(input.text))
        ? verifiedEffect(toolId, "google_document", String(input.documentId), effectOptions, acknowledgement)
        : undefined;
    }
    case "google.sheets.update": {
      const sheet = await readSheetValues(String(input.spreadsheetId), String(input.range), provider);
      return sheetPatchMatches(sheet.values, sheetPatchValues(input.values))
        ? verifiedEffect(toolId, "google_spreadsheet", String(input.spreadsheetId), effectOptions, acknowledgement)
        : undefined;
    }
    case "google.slides.update": {
      const presentation = await readPresentation(String(input.presentationId), provider);
      const object = presentation.objects.find((candidate) => candidate.objectId === input.objectId);
      return object && sha256(object.text) === sha256(String(input.text))
        ? verifiedEffect(toolId, "google_presentation", String(input.presentationId), effectOptions, acknowledgement)
        : undefined;
    }
    case "calendar.update": {
      const event = await readCalendarEvent(String(input.calendarId), String(input.eventId), provider);
      return event && calendarEventMatches(input, event)
        ? verifiedEffect(toolId, "google_calendar_event", String(input.eventId), effectOptions, acknowledgement)
        : undefined;
    }
    case "calendar.delete": {
      const event = await readCalendarEvent(String(input.calendarId), String(input.eventId), provider);
      return !event || event.status === "cancelled"
        ? verifiedEffect(toolId, "google_calendar_event", String(input.eventId), effectOptions, acknowledgement)
        : undefined;
    }
  }
}

function capabilityForTool(toolId: GoogleWorkspaceActionToolId): GoogleWorkspaceCapability {
  if (toolId === "google.gmail.search" || toolId === "google.gmail.read") return "gmail.read";
  if (toolId === "google.gmail.trash") return "gmail.trash";
  if (toolId === "google.drive.search" || toolId === "google.drive.download") return "drive.read";
  if (toolId.startsWith("google.drive.")) return "drive.write";
  if (toolId === "google.docs.read") return "docs.read";
  if (toolId === "google.docs.update") return "docs.write";
  if (toolId === "google.sheets.read") return "sheets.read";
  if (toolId === "google.sheets.update") return "sheets.write";
  if (toolId === "google.slides.read") return "slides.read";
  if (toolId === "google.slides.update") return "slides.write";
  return "calendar.events.write";
}

function effectIdentity(
  toolId: (typeof GOOGLE_WORKSPACE_MUTATION_TOOL_IDS)[number],
  input: Record<string, unknown>,
  executionId: string,
) {
  const resourceId = resourceIdFor(toolId, input, executionId);
  return {
    provider: "google_workspace",
    toolId,
    resourceType: resourceTypeFor(toolId),
    resourceIdSha256: toolId.startsWith("calendar.")
      ? sha256(`${String(input.calendarId)}\0${resourceId}`)
      : sha256(resourceId),
  };
}

function expectedTargetState(
  toolId: (typeof GOOGLE_WORKSPACE_MUTATION_TOOL_IDS)[number],
  input: Record<string, unknown>,
  executionId: string,
) {
  const base = effectIdentity(toolId, input, executionId);
  switch (toolId) {
    case "google.gmail.trash":
    case "google.drive.trash":
      return { ...base, trashed: true };
    case "google.drive.create":
      return { ...base, name: input.name, mimeType: input.mimeType, parentIdSha256: optionalIdSha256(input.parentId), contentSha256: contentSha256(input.contentBase64) };
    case "google.drive.update":
      return { ...base, mimeType: input.mimeType, contentSha256: contentSha256(input.contentBase64) };
    case "google.drive.move":
      return { ...base, parentIdSha256: sha256(String(input.parentId)) };
    case "google.drive.rename":
      return { ...base, name: input.name };
    case "google.docs.update":
      return { ...base, textSha256: sha256(String(input.text)) };
    case "google.sheets.update":
      return { ...base, range: input.range, valuesSha256: canonicalJsonSha256(sheetPatchValues(input.values)) };
    case "google.slides.update":
      return { ...base, objectIdSha256: sha256(String(input.objectId)), textSha256: sha256(String(input.text)) };
    case "calendar.update":
      return { ...base, changes: calendarExpectedChanges(input) };
    case "calendar.delete":
      return { ...base, deleted: true };
  }
}

function resourceIdFor(
  toolId: (typeof GOOGLE_WORKSPACE_MUTATION_TOOL_IDS)[number],
  input: Record<string, unknown>,
  executionId: string,
) {
  if (toolId === "google.drive.create") return `execution:${executionMarker(executionId)}`;
  if (toolId === "google.gmail.trash") return String(input.messageId);
  if (toolId.startsWith("google.drive.")) return String(input.fileId);
  if (toolId === "google.docs.update") return String(input.documentId);
  if (toolId === "google.sheets.update") return String(input.spreadsheetId);
  if (toolId === "google.slides.update") return String(input.presentationId);
  return String(input.eventId);
}

function resourceTypeFor(toolId: (typeof GOOGLE_WORKSPACE_MUTATION_TOOL_IDS)[number]): GoogleWorkspaceEffectResult["resourceType"] {
  if (toolId === "google.gmail.trash") return "gmail_message";
  if (toolId.startsWith("google.drive.")) return "drive_file";
  if (toolId === "google.docs.update") return "google_document";
  if (toolId === "google.sheets.update") return "google_spreadsheet";
  if (toolId === "google.slides.update") return "google_presentation";
  return "google_calendar_event";
}

async function trashGmailMessage(
  input: Record<string, unknown>,
  options: EffectActionOptions,
  provider: ProviderContext,
  acknowledgement: GoogleWorkspaceEffectResult["providerAcknowledgement"],
) {
  const messageId = String(input.messageId);
  const prior = await readGmailMessageMinimal(messageId, provider);
  if (prior && stringArray(prior.labelIds).includes("TRASH")) {
    return verifiedEffect("google.gmail.trash", "gmail_message", messageId, options, "provider_idempotency_reconciliation");
  }
  await providerJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/trash`, {
    ...provider,
    method: "POST",
    body: "{}",
  });
  const observed = await readGmailMessageMinimal(messageId, provider);
  if (!observed || !stringArray(observed.labelIds).includes("TRASH")) {
    throw new Error("Gmail message was not verified in Trash.");
  }
  return verifiedEffect("google.gmail.trash", "gmail_message", messageId, options, acknowledgement);
}

async function searchGmailMessages(
  input: Record<string, unknown>,
  provider: ProviderContext,
) {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", String(input.query));
  url.searchParams.set("maxResults", String(input.maxResults));
  const result = await providerJson(url, provider);
  const refs = array(result?.messages).slice(0, Number(input.maxResults));
  const messages = [];
  for (const value of refs) {
    const messageId = safeProviderId(record(value).id);
    if (!messageId) continue;
    const message = await readGmailMessageMetadata(messageId, provider);
    if (message) messages.push(message);
  }
  return {
    query: String(input.query),
    messages,
    resultCount: messages.length,
    contentTrust: "untrusted_provider_content",
  };
}

async function readGmailMessageResult(
  input: Record<string, unknown>,
  provider: ProviderContext,
) {
  const messageId = String(input.messageId);
  const url = gmailMessageUrl(messageId);
  url.searchParams.set("format", "full");
  const message = await providerJson(url, { ...provider, notFound: true });
  if (!message) throw new Error("Gmail message was not found.");
  const body = collectGmailBody(record(message.payload));
  return {
    ...gmailMessageSummary(messageId, message),
    bodyText: body.text,
    bodyTruncated: body.truncated,
    attachmentCount: body.attachmentCount,
    contentTrust: "untrusted_provider_content",
  };
}

async function readGmailMessageMetadata(
  messageId: string,
  provider: ProviderContext,
) {
  const url = gmailMessageUrl(messageId);
  url.searchParams.set("format", "metadata");
  for (const header of ["Subject", "From", "To", "Cc", "Date", "Message-ID"]) {
    url.searchParams.append("metadataHeaders", header);
  }
  const message = await providerJson(url, { ...provider, notFound: true });
  return message ? gmailMessageSummary(messageId, message) : undefined;
}

function gmailMessageSummary(
  messageId: string,
  message: Record<string, unknown>,
) {
  const headers = gmailHeaders(record(message.payload));
  return {
    messageId,
    threadId: safeProviderId(message.threadId),
    subject: headers.subject || "",
    from: headers.from || "",
    to: headers.to || "",
    cc: headers.cc || "",
    date: headers.date || "",
    rfcMessageId: headers["message-id"] || "",
    internalDate: boundedProviderString(message.internalDate, 32),
    snippet: boundedProviderString(message.snippet, 2_000),
    labelIds: stringArray(message.labelIds).slice(0, 100)
      .map((label) => boundedProviderString(label, 128)),
  };
}

function gmailHeaders(payload: Record<string, unknown>) {
  const result: Record<string, string> = {};
  for (const value of array(payload.headers)) {
    const header = record(value);
    const name = typeof header.name === "string" ? header.name.toLowerCase() : "";
    if (!["subject", "from", "to", "cc", "date", "message-id"].includes(name)) continue;
    if (!(name in result)) result[name] = boundedProviderString(header.value, 2_000);
  }
  return result;
}

function collectGmailBody(payload: Record<string, unknown>) {
  const plainParts: string[] = [];
  const fallbackParts: string[] = [];
  let attachmentCount = 0;
  let truncated = false;
  const visit = (part: Record<string, unknown>) => {
    const body = record(part.body);
    const filename = boundedProviderString(part.filename, 255);
    if (filename || typeof body.attachmentId === "string") {
      attachmentCount += 1;
      return;
    }
    const data = typeof body.data === "string" ? body.data : "";
    if (data) {
      const decoded = decodeGmailBodyData(data);
      if (decoded.truncated) truncated = true;
      if (String(part.mimeType).toLowerCase() === "text/plain") {
        plainParts.push(decoded.text);
      } else if (String(part.mimeType).toLowerCase() === "text/html") {
        fallbackParts.push(decoded.text);
      }
    }
    for (const child of array(part.parts)) visit(record(child));
  };
  visit(payload);
  const selected = plainParts.length ? plainParts : fallbackParts;
  const combined = selected.join("\n");
  return {
    text: combined.slice(0, 100_000),
    truncated: truncated || combined.length > 100_000,
    attachmentCount,
  };
}

function decodeGmailBodyData(value: string) {
  if (value.length > 400_000 || !/^[A-Za-z0-9_-]*={0,2}$/.test(value)) {
    throw new Error("Gmail returned invalid message body data.");
  }
  const bytes = Buffer.from(value, "base64url");
  const text = decodeUntrustedText(bytes);
  if (text === undefined) return { text: "", truncated: false };
  return { text: text.slice(0, 100_000), truncated: text.length > 100_000 };
}

async function readGmailMessageMinimal(messageId: string, provider: ProviderContext) {
  const url = gmailMessageUrl(messageId);
  url.searchParams.set("format", "minimal");
  return providerJson(url, { ...provider, notFound: true });
}

async function downloadDriveFile(input: Record<string, unknown>, provider: ProviderContext) {
  const fileId = String(input.fileId);
  const metadata = await requireDriveFile(fileId, provider);
  const mimeType = boundedProviderString(metadata.mimeType, 127);
  if (mimeType.toLowerCase().startsWith(GOOGLE_NATIVE_MIME_PREFIX)) {
    throw new Error(
      "Native Google files must be read with the governed Docs, Sheets, or Slides tool.",
    );
  }
  const maxBytes = Number(input.maxBytes);
  const declaredSize = optionalProviderByteSize(metadata.size);
  if (declaredSize !== undefined && declaredSize > maxBytes) {
    return {
      fileId,
      name: boundedProviderString(metadata.name, 255),
      mimeType,
      size: declaredSize,
      contentDisposition: "metadata_only_oversize",
      previewOmittedReason: "file_exceeds_transcript_preview_limit",
      contentTrust: "untrusted_provider_content",
    };
  }
  const bytes = await readDriveContent(fileId, provider, maxBytes);
  const textPreview = textMimeType(mimeType)
    ? decodeUntrustedText(bytes)
    : undefined;
  return {
    fileId,
    name: boundedProviderString(metadata.name, 255),
    mimeType,
    size: bytes.byteLength,
    contentSha256: sha256(bytes),
    contentDisposition: textPreview === undefined
      ? "metadata_only_binary"
      : "untrusted_text_preview",
    contentTrust: "untrusted_provider_content",
    ...(textPreview === undefined ? {} : { textPreview }),
  };
}

async function searchDriveFiles(
  input: Record<string, unknown>,
  provider: ProviderContext,
) {
  const query = typeof input.query === "string" ? input.query : undefined;
  const maxResults = Number(input.maxResults);
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("pageSize", String(maxResults));
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set(
    "fields",
    "files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents,capabilities(canEdit,canDownload))",
  );
  url.searchParams.set(
    "q",
    query
      ? `trashed = false and (name contains '${escapeDriveQueryLiteral(query)}' or fullText contains '${escapeDriveQueryLiteral(query)}')`
      : "trashed = false",
  );
  const result = await providerJson(url, provider);
  const files = array(result?.files).slice(0, maxResults).flatMap((value) => {
    const file = record(value);
    const fileId = safeProviderId(file.id);
    if (!fileId) return [];
    const capabilities = record(file.capabilities);
    return [{
      fileId,
      name: boundedProviderString(file.name, 255),
      mimeType: boundedProviderString(file.mimeType, 127),
      size: optionalProviderByteSize(file.size),
      createdTime: boundedProviderString(file.createdTime, 64),
      modifiedTime: boundedProviderString(file.modifiedTime, 64),
      webViewLink: boundedProviderString(file.webViewLink, 2_000),
      parentIds: stringArray(file.parents).slice(0, 100).flatMap((parentId) => {
        const safeId = safeProviderId(parentId);
        return safeId ? [safeId] : [];
      }),
      canEdit: capabilities.canEdit === true,
      canDownload: capabilities.canDownload === true,
    }];
  });
  return {
    query: query || "",
    files,
    resultCount: files.length,
    contentTrust: "untrusted_provider_content",
  };
}

function escapeDriveQueryLiteral(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

async function createDriveFile(input: Record<string, unknown>, options: EffectActionOptions, provider: ProviderContext) {
  const prior = await findDriveFileByExecution(options.executionId, provider);
  if (prior) {
    if (!await driveFileMatchesCreate(prior, input, options.executionId, provider)) {
      throw new Error("Drive idempotency marker is already bound to a different file state.");
    }
    return verifiedEffect("google.drive.create", "drive_file", requiredProviderId(prior.id), options, "provider_idempotency_reconciliation");
  }
  const marker = executionMarker(options.executionId);
  const bytes = decodeBase64(String(input.contentBase64));
  const metadata = {
    name: input.name,
    mimeType: input.mimeType,
    appProperties: { asaelExecution: marker },
    ...(input.parentId ? { parents: [input.parentId] } : {}),
  };
  const response = await driveMultipartRequest(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
    "POST",
    metadata,
    String(input.mimeType),
    bytes,
    provider,
  );
  const fileId = requiredProviderId(response.id);
  const observed = await requireDriveFile(fileId, provider);
  if (!await driveFileMatchesCreate(observed, input, options.executionId, provider)) {
    throw new Error("Drive file does not match the governed create intent.");
  }
  return verifiedEffect("google.drive.create", "drive_file", fileId, options, "provider_response");
}

async function updateDriveFile(input: Record<string, unknown>, options: EffectActionOptions, provider: ProviderContext) {
  const fileId = String(input.fileId);
  const prior = await requireDriveFile(fileId, provider);
  const currentContentSha256 = sha256(
    await readDriveContent(fileId, provider, MAX_FILE_BYTES),
  );
  const targetContentSha256 = contentSha256(input.contentBase64);
  if (prior.mimeType === input.mimeType && currentContentSha256 === targetContentSha256) {
    return verifiedEffect("google.drive.update", "drive_file", fileId, options, "provider_idempotency_reconciliation");
  }
  assertExpectedCurrent(
    input.expectedCurrentSha256,
    currentContentSha256,
    "Google Drive file",
  );
  await driveMultipartRequest(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id&supportsAllDrives=true`,
    "PATCH",
    { mimeType: input.mimeType },
    String(input.mimeType),
    decodeBase64(String(input.contentBase64)),
    provider,
  );
  const observed = await requireDriveFile(fileId, provider);
  if (!await driveFileMatchesContent(observed, input, provider)) {
    throw new Error("Drive content does not match the governed update intent.");
  }
  return verifiedEffect("google.drive.update", "drive_file", fileId, options, "provider_response");
}

async function moveDriveFile(input: Record<string, unknown>, options: EffectActionOptions, provider: ProviderContext) {
  const fileId = String(input.fileId);
  const parentId = String(input.parentId);
  const prior = await requireDriveFile(fileId, provider);
  if (parentsMatch(prior, parentId)) {
    return verifiedEffect("google.drive.move", "drive_file", fileId, options, "provider_idempotency_reconciliation");
  }
  const currentParents = stringArray(prior.parents).filter((id) => id !== parentId);
  const url = driveFileUrl(fileId);
  url.searchParams.set("addParents", parentId);
  if (currentParents.length) url.searchParams.set("removeParents", currentParents.join(","));
  url.searchParams.set("fields", DRIVE_FILE_FIELDS);
  await providerJson(url, { ...provider, method: "PATCH", body: "{}" });
  const observed = await requireDriveFile(fileId, provider);
  if (!parentsMatch(observed, parentId)) throw new Error("Drive move could not be verified.");
  return verifiedEffect("google.drive.move", "drive_file", fileId, options, "provider_response");
}

async function renameDriveFile(input: Record<string, unknown>, options: EffectActionOptions, provider: ProviderContext) {
  const fileId = String(input.fileId);
  const name = String(input.name);
  const prior = await requireDriveFile(fileId, provider);
  if (prior.name === name) {
    return verifiedEffect("google.drive.rename", "drive_file", fileId, options, "provider_idempotency_reconciliation");
  }
  const url = driveFileUrl(fileId);
  url.searchParams.set("fields", DRIVE_FILE_FIELDS);
  await providerJson(url, { ...provider, method: "PATCH", body: JSON.stringify({ name }) });
  const observed = await requireDriveFile(fileId, provider);
  if (observed.name !== name) throw new Error("Drive rename could not be verified.");
  return verifiedEffect("google.drive.rename", "drive_file", fileId, options, "provider_response");
}

async function trashDriveFile(input: Record<string, unknown>, options: EffectActionOptions, provider: ProviderContext) {
  const fileId = String(input.fileId);
  const prior = await readDriveFile(fileId, provider, true);
  if (!prior) throw new Error("Drive file was not found.");
  if (prior.trashed === true) {
    return verifiedEffect("google.drive.trash", "drive_file", fileId, options, "provider_idempotency_reconciliation");
  }
  const url = driveFileUrl(fileId);
  url.searchParams.set("fields", DRIVE_FILE_FIELDS);
  await providerJson(url, { ...provider, method: "PATCH", body: JSON.stringify({ trashed: true }) });
  const observed = await readDriveFile(fileId, provider, true);
  if (!observed || observed.trashed !== true) throw new Error("Drive file was not verified in Trash.");
  return verifiedEffect("google.drive.trash", "drive_file", fileId, options, "provider_response");
}

async function readDriveFile(fileId: string, provider: ProviderContext, includeTrashed = false) {
  const url = driveFileUrl(fileId);
  url.searchParams.set("fields", DRIVE_FILE_FIELDS);
  const value = await providerJson(url, { ...provider, notFound: true });
  if (!value || (!includeTrashed && value.trashed === true)) return undefined;
  requiredProviderId(value.id);
  return value;
}

async function requireDriveFile(fileId: string, provider: ProviderContext) {
  const file = await readDriveFile(fileId, provider, true);
  if (!file) throw new Error("Drive file was not found.");
  return file;
}

async function findDriveFileByExecution(executionId: string, provider: ProviderContext) {
  const marker = executionMarker(executionId);
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", `appProperties has { key='asaelExecution' and value='${marker}' }`);
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("pageSize", "2");
  url.searchParams.set("fields", `files(${DRIVE_FILE_FIELDS})`);
  const result = await providerJson(url, provider);
  const files = array(result?.files).map(record);
  if (files.length > 1) throw new Error("Drive idempotency marker is ambiguous.");
  return files[0];
}

async function driveFileMatchesCreate(
  file: Record<string, unknown>,
  input: Record<string, unknown>,
  executionId: string,
  provider: ProviderContext,
) {
  const appProperties = record(file.appProperties);
  return file.name === input.name && file.mimeType === input.mimeType &&
    (!input.parentId || parentsMatch(file, String(input.parentId))) &&
    appProperties.asaelExecution === executionMarker(executionId) &&
    await driveFileMatchesContent(file, input, provider);
}

async function driveFileMatchesContent(file: Record<string, unknown>, input: Record<string, unknown>, provider: ProviderContext) {
  if (file.mimeType !== input.mimeType) return false;
  const fileId = requiredProviderId(file.id);
  const bytes = await readDriveContent(fileId, provider, MAX_FILE_BYTES);
  return sha256(bytes) === contentSha256(input.contentBase64);
}

function parentsMatch(file: Record<string, unknown>, parentId: string) {
  const parents = stringArray(file.parents).sort();
  return parents.length === 1 && parents[0] === parentId;
}

async function readDriveContent(fileId: string, provider: ProviderContext, maxBytes: number) {
  const url = driveFileUrl(fileId);
  url.searchParams.set("alt", "media");
  const response = await providerFetch(url, provider);
  if (!response.ok) throw new Error(`Google Drive download returned ${response.status}.`);
  return readBytesLimited(response, maxBytes);
}

async function driveMultipartRequest(
  url: string,
  method: "POST" | "PATCH",
  metadata: Record<string, unknown>,
  mimeType: string,
  bytes: Uint8Array,
  provider: ProviderContext,
) {
  const boundaryDigest = createHash("sha256")
    .update(JSON.stringify(metadata), "utf8")
    .update("\0", "utf8")
    .update(bytes)
    .digest("hex");
  const boundary = `asael_${boundaryDigest.slice(0, 24)}`;
  const media = new Uint8Array(bytes.byteLength);
  media.set(bytes);
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    media.buffer,
    `\r\n--${boundary}--`,
  ]);
  return requireProviderJson(await providerFetch(url, {
    ...provider,
    method,
    body,
    contentType: `multipart/related; boundary=${boundary}`,
  }), "Google Drive upload");
}

async function readDocumentResult(input: Record<string, unknown>, provider: ProviderContext) {
  const documentId = String(input.documentId);
  const document = await readDocument(documentId, provider);
  return {
    documentId,
    title: document.title,
    ...(document.revisionId ? { revisionId: document.revisionId } : {}),
    text: document.text,
    contentSha256: sha256(document.text),
    structureSha256: document.structureSha256,
    textOnlyBody: document.textOnlyBody,
    scope: "first_tab_body_text",
  };
}

async function updateDocument(input: Record<string, unknown>, options: EffectActionOptions, provider: ProviderContext) {
  const documentId = String(input.documentId);
  const targetText = String(input.text);
  const prior = await readDocument(documentId, provider);
  if (sha256(prior.text) === sha256(targetText)) {
    return verifiedEffect("google.docs.update", "google_document", documentId, options, "provider_idempotency_reconciliation");
  }
  assertExpectedCurrent(input.expectedCurrentSha256, sha256(prior.text), "Google document");
  assertExpectedCurrent(
    input.expectedStructureSha256,
    prior.structureSha256,
    "Google document structure",
  );
  if (!prior.textOnlyBody) {
    throw new Error(
      "Google document contains non-text body content; this text-only update will not remove tables or embedded objects.",
    );
  }
  if (!prior.revisionId) {
    throw new Error("Google document update requires edit access and a current revision ID.");
  }
  const requests: Record<string, unknown>[] = [];
  if (prior.contentEndIndex > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: prior.contentEndIndex - 1 } } });
  }
  if (targetText) requests.push({ insertText: { location: { index: 1 }, text: targetText } });
  await providerJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
    ...provider,
    method: "POST",
    body: JSON.stringify({ requests, writeControl: { requiredRevisionId: prior.revisionId } }),
  });
  const observed = await readDocument(documentId, provider);
  if (sha256(observed.text) !== sha256(targetText)) throw new Error("Google document update could not be verified.");
  return verifiedEffect("google.docs.update", "google_document", documentId, options, "provider_response");
}

async function readDocument(documentId: string, provider: ProviderContext) {
  const value = await providerJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`, provider);
  if (!value) throw new Error("Google document was not found.");
  const body = record(value.body);
  const inlineObjects = record(value.inlineObjects);
  const positionedObjects = record(value.positionedObjects);
  const content = array(body.content);
  const text = normalizeDocumentText(collectText(body).join(""));
  if (text.length > MAX_TEXT_CHARS) throw new Error("Google document is too large for this tool.");
  const contentEndIndex = content.reduce<number>(
    (maximum, item) => Math.max(maximum, finiteInteger(record(item).endIndex)),
    2,
  );
  return {
    title: boundedProviderString(value.title, 1_000),
    revisionId: optionalRevisionId(value.revisionId),
    text,
    contentEndIndex,
    structureSha256: canonicalJsonSha256({
      body,
      inlineObjects,
      positionedObjects,
    }),
    textOnlyBody: isTextOnlyDocumentBody(body) &&
      Object.keys(inlineObjects).length === 0 &&
      Object.keys(positionedObjects).length === 0,
  };
}

async function readSheetResult(input: Record<string, unknown>, provider: ProviderContext) {
  const spreadsheetId = String(input.spreadsheetId);
  const range = String(input.range);
  const result = await readSheetValues(spreadsheetId, range, provider);
  return { spreadsheetId, range: result.range, values: result.values, contentSha256: canonicalJsonSha256(result.values) };
}

async function updateSheet(input: Record<string, unknown>, options: EffectActionOptions, provider: ProviderContext) {
  const spreadsheetId = String(input.spreadsheetId);
  const range = String(input.range);
  const targetValues = sheetPatchValues(input.values);
  const prior = await readSheetValues(spreadsheetId, range, provider);
  if (sheetPatchMatches(prior.values, targetValues)) {
    return verifiedEffect("google.sheets.update", "google_spreadsheet", spreadsheetId, options, "provider_idempotency_reconciliation");
  }
  assertExpectedCurrent(input.expectedCurrentSha256, canonicalJsonSha256(prior.values), "Google Sheets range");
  const url = sheetValuesUrl(spreadsheetId, range);
  url.searchParams.set("valueInputOption", "RAW");
  await providerJson(url, {
    ...provider,
    method: "PUT",
    body: JSON.stringify({ range, majorDimension: "ROWS", values: targetValues }),
  });
  const observed = await readSheetValues(spreadsheetId, range, provider);
  if (!sheetPatchMatches(observed.values, targetValues)) {
    throw new Error("Google Sheets update could not be verified.");
  }
  return verifiedEffect("google.sheets.update", "google_spreadsheet", spreadsheetId, options, "provider_response");
}

async function readSheetValues(spreadsheetId: string, range: string, provider: ProviderContext) {
  const url = sheetValuesUrl(spreadsheetId, range);
  url.searchParams.set("valueRenderOption", "FORMULA");
  url.searchParams.set("dateTimeRenderOption", "SERIAL_NUMBER");
  const value = await providerJson(url, provider);
  if (!value) throw new Error("Google spreadsheet was not found.");
  const parsedValues = sheetReadValuesSchema.parse(array(value.values));
  return {
    range: boundedProviderString(value.range, 500) || range,
    values: normalizeSheetValues(parsedValues),
  };
}

async function readPresentationResult(input: Record<string, unknown>, provider: ProviderContext) {
  const presentationId = String(input.presentationId);
  const presentation = await readPresentation(presentationId, provider);
  return {
    presentationId,
    title: presentation.title,
    ...(presentation.revisionId ? { revisionId: presentation.revisionId } : {}),
    objects: presentation.objects,
    contentSha256: canonicalJsonSha256(presentation.objects),
  };
}

async function updatePresentation(input: Record<string, unknown>, options: EffectActionOptions, provider: ProviderContext) {
  const presentationId = String(input.presentationId);
  const objectId = String(input.objectId);
  const targetText = String(input.text);
  const prior = await readPresentation(presentationId, provider);
  const object = prior.objects.find((candidate) => candidate.objectId === objectId);
  if (!object) throw new Error("Google Slides text object was not found.");
  if (sha256(object.text) === sha256(targetText)) {
    return verifiedEffect("google.slides.update", "google_presentation", presentationId, options, "provider_idempotency_reconciliation");
  }
  assertExpectedCurrent(input.expectedCurrentSha256, sha256(object.text), "Google Slides text object");
  if (!prior.revisionId) {
    throw new Error("Google Slides update requires edit access and a current revision ID.");
  }
  const requests: Record<string, unknown>[] = [];
  if (object.text) requests.push({ deleteText: { objectId, textRange: { type: "ALL" } } });
  if (targetText) requests.push({ insertText: { objectId, insertionIndex: 0, text: targetText } });
  await providerJson(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`, {
    ...provider,
    method: "POST",
    body: JSON.stringify({ requests, writeControl: { requiredRevisionId: prior.revisionId } }),
  });
  const observed = await readPresentation(presentationId, provider);
  const updated = observed.objects.find((candidate) => candidate.objectId === objectId);
  if (!updated || sha256(updated.text) !== sha256(targetText)) throw new Error("Google Slides update could not be verified.");
  return verifiedEffect("google.slides.update", "google_presentation", presentationId, options, "provider_response");
}

async function readPresentation(presentationId: string, provider: ProviderContext) {
  const value = await providerJson(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`, provider);
  if (!value) throw new Error("Google presentation was not found.");
  const objects: Array<{ objectId: string; text: string; textSha256: string }> = [];
  for (const slide of array(value.slides)) {
    for (const element of array(record(slide).pageElements)) {
      const pageElement = record(element);
      const objectId = safeProviderId(pageElement.objectId);
      if (!objectId) continue;
      if (!isRecord(pageElement.shape) || !isRecord(pageElement.shape.text)) {
        continue;
      }
      const text = normalizePresentationText(
        collectText(pageElement.shape.text).join(""),
      );
      objects.push({ objectId, text, textSha256: sha256(text) });
      if (objects.length > 500) throw new Error("Google presentation has too many text objects for this tool.");
    }
  }
  if (objects.reduce((total, object) => total + object.text.length, 0) > MAX_TEXT_CHARS) {
    throw new Error("Google presentation is too large for this tool.");
  }
  return {
    title: boundedProviderString(value.title, 1_000),
    revisionId: optionalRevisionId(value.revisionId),
    objects,
  };
}

async function updateCalendarEvent(input: Record<string, unknown>, options: EffectActionOptions, provider: ProviderContext) {
  const calendarId = String(input.calendarId);
  const eventId = String(input.eventId);
  const prior = await readCalendarEvent(calendarId, eventId, provider);
  if (!prior) throw new Error("Google Calendar event was not found.");
  if (prior.status === "cancelled") throw new Error("Google Calendar event is cancelled.");
  if (calendarEventMatches(input, prior)) {
    return verifiedEffect("calendar.update", "google_calendar_event", eventId, options, "provider_idempotency_reconciliation");
  }
  const url = calendarEventUrl(calendarId, eventId);
  url.searchParams.set("sendUpdates", "none");
  await providerJson(url, { ...provider, method: "PATCH", body: JSON.stringify(calendarPatch(input)) });
  const observed = await readCalendarEvent(calendarId, eventId, provider);
  if (!observed || !calendarEventMatches(input, observed)) throw new Error("Google Calendar update could not be verified.");
  return verifiedEffect("calendar.update", "google_calendar_event", eventId, options, "provider_response");
}

async function deleteCalendarEvent(input: Record<string, unknown>, options: EffectActionOptions, provider: ProviderContext) {
  const calendarId = String(input.calendarId);
  const eventId = String(input.eventId);
  const prior = await readCalendarEvent(calendarId, eventId, provider);
  if (!prior) throw new Error("Google Calendar event was not found.");
  if (prior.status === "cancelled") {
    return verifiedEffect("calendar.delete", "google_calendar_event", eventId, options, "provider_idempotency_reconciliation");
  }
  const url = calendarEventUrl(calendarId, eventId);
  url.searchParams.set("sendUpdates", "none");
  const response = await providerFetch(url, { ...provider, method: "DELETE" });
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new Error(`Google Calendar delete returned ${response.status}.`);
  }
  const observed = await readCalendarEvent(calendarId, eventId, provider);
  if (observed && observed.status !== "cancelled") throw new Error("Google Calendar deletion could not be verified.");
  return verifiedEffect("calendar.delete", "google_calendar_event", eventId, options, "provider_response");
}

async function readCalendarEvent(calendarId: string, eventId: string, provider: ProviderContext) {
  const url = calendarEventUrl(calendarId, eventId);
  return providerJson(url, { ...provider, notFound: true });
}

function calendarPatch(input: Record<string, unknown>) {
  return {
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.start !== undefined ? { start: { dateTime: input.start, ...(input.timeZone ? { timeZone: input.timeZone } : {}) } } : {}),
    ...(input.end !== undefined ? { end: { dateTime: input.end, ...(input.timeZone ? { timeZone: input.timeZone } : {}) } } : {}),
    ...(input.attendees !== undefined ? { attendees: array(input.attendees).map((email) => ({ email })) } : {}),
  };
}

function calendarEventMatches(input: Record<string, unknown>, event: Record<string, unknown>) {
  if (event.status === "cancelled") return false;
  const expected = calendarExpectedChanges(input);
  const actual: Record<string, unknown> = {};
  if (input.summary !== undefined) actual.summary = String(event.summary || "");
  if (input.description !== undefined) actual.description = String(event.description || "");
  if (input.location !== undefined) actual.location = String(event.location || "");
  if (input.start !== undefined) actual.start = normalizeDateTime(String(record(event.start).dateTime || ""));
  if (input.end !== undefined) actual.end = normalizeDateTime(String(record(event.end).dateTime || ""));
  if (input.timeZone !== undefined && input.start !== undefined) actual.timeZone = String(record(event.start).timeZone || record(event.end).timeZone || "");
  if (input.attendees !== undefined) actual.attendees = array(event.attendees).map((item) => String(record(item).email || "").toLowerCase()).filter(Boolean).sort();
  return canonicalJsonSha256(actual) === canonicalJsonSha256(expected);
}

function calendarExpectedChanges(input: Record<string, unknown>) {
  return {
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.start !== undefined ? { start: normalizeDateTime(String(input.start)) } : {}),
    ...(input.end !== undefined ? { end: normalizeDateTime(String(input.end)) } : {}),
    ...(input.timeZone !== undefined && input.start !== undefined ? { timeZone: input.timeZone } : {}),
    ...(input.attendees !== undefined ? { attendees: array(input.attendees).map(String).map((email) => email.toLowerCase()).sort() } : {}),
  };
}

function verifiedEffect(
  toolId: (typeof GOOGLE_WORKSPACE_MUTATION_TOOL_IDS)[number],
  resourceType: GoogleWorkspaceEffectResult["resourceType"],
  resourceId: string,
  options: EffectActionOptions,
  providerAcknowledgement: GoogleWorkspaceEffectResult["providerAcknowledgement"],
): GoogleWorkspaceEffectResult {
  const target = googleWorkspaceEffectTarget(
    toolId,
    options.effectInput,
    options.executionId,
  );
  const resourceIdSha256 = sha256(resourceId);
  const providerAcknowledgementSha256 = canonicalJsonSha256({
    provider: "google_workspace",
    toolId,
    resourceType,
    resourceIdSha256,
    providerAcknowledgement,
    observedTargetStateSha256: target.expectedTargetStateSha256,
  });
  return googleWorkspaceEffectResultSchema.parse({
    toolId,
    resourceType,
    resourceId,
    resourceIdSha256,
    providerAcknowledgement,
    providerAcknowledgementId: `google_workspace_ack_${providerAcknowledgementSha256.slice(0, 43)}`,
    providerAcknowledgementSha256,
    observedTargetStateSha256: target.expectedTargetStateSha256,
    verificationState: "verified",
    verificationReasonCode: "state_matched",
  });
}

type ProviderContext = Readonly<{
  accessToken: string;
  abortSignal?: AbortSignal;
}>;

type ProviderRequest = ProviderContext & Readonly<{
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: BodyInit;
  contentType?: string;
  notFound?: boolean;
}>;

async function providerJson(url: string | URL, input: ProviderRequest): Promise<Record<string, unknown> | undefined> {
  const response = await providerFetch(url, input);
  if (input.notFound && (response.status === 404 || response.status === 410)) return undefined;
  return requireProviderJson(response, "Google Workspace request");
}

async function providerFetch(url: string | URL, input: ProviderRequest) {
  return fetch(url, {
    method: input.method || "GET",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      accept: "application/json",
      ...(input.body !== undefined && !input.contentType ? { "content-type": "application/json" } : {}),
      ...(input.contentType ? { "content-type": input.contentType } : {}),
    },
    body: input.body,
    redirect: "error",
    cache: "no-store",
    signal: providerSignal(input.abortSignal),
  });
}

async function requireProviderJson(response: Response, label: string) {
  if (!response.ok) throw new Error(`${label} returned ${response.status}.`);
  if (response.status === 204) return {};
  const bytes = await readBytesLimited(response, MAX_PROVIDER_JSON_BYTES);
  try {
    return record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function readBytesLimited(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Google Workspace response is too large.");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel("Google Workspace response byte limit reached.").catch(() => undefined);
        throw new Error("Google Workspace response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function driveFileUrl(fileId: string) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

function gmailMessageUrl(messageId: string) {
  return new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
}

function sheetValuesUrl(spreadsheetId: string, range: string) {
  return new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
}

function calendarEventUrl(calendarId: string, eventId: string) {
  return new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
}

function providerSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(20_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function executionMarker(executionId: string) {
  return createHash("sha256").update(requiredOwner(executionId, "execution"), "utf8").digest("hex");
}

function requiredOwner(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Google Workspace ${label} identity is invalid.`);
  }
  return normalized;
}

function requiredProviderId(value: unknown) {
  return providerIdSchema.parse(value);
}

function safeProviderId(value: unknown) {
  const parsed = providerIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function optionalRevisionId(value: unknown) {
  const revision = typeof value === "string" ? value.trim() : "";
  if (!revision) return undefined;
  if (revision.length > 500 || /[\u0000-\u001f\u007f]/.test(revision)) {
    throw new Error("Google Workspace revision ID is invalid.");
  }
  return revision;
}

function boundedProviderString(value: unknown, max: number) {
  const text = typeof value === "string" ? value : "";
  if (text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error("Google Workspace returned invalid text metadata.");
  }
  return text;
}

function optionalProviderByteSize(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const size = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Google Workspace returned invalid file size metadata.");
  }
  return size;
}

function assertExpectedCurrent(expected: unknown, actual: string, label: string) {
  if (expected !== actual) throw new Error(`${label} changed since it was read. Read it again before updating.`);
}

function normalizeDateTime(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeDocumentText(value: string) {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function normalizePresentationText(value: string) {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function collectText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectText);
  const object = record(value);
  if (!Object.keys(object).length) return [];
  const textRun = record(object.textRun);
  if (typeof textRun.content === "string") return [boundedProviderString(textRun.content, MAX_TEXT_CHARS)];
  return Object.values(object).flatMap(collectText);
}

function isTextOnlyDocumentBody(body: Record<string, unknown>) {
  return array(body.content).every((value) => {
    const element = record(value);
    const structuralKeys = Object.keys(element).filter((key) =>
      key !== "startIndex" && key !== "endIndex");
    if (structuralKeys.length !== 1) return false;
    if (structuralKeys[0] === "sectionBreak") {
      return isRecord(element.sectionBreak);
    }
    if (structuralKeys[0] !== "paragraph") return false;
    const paragraph = record(element.paragraph);
    if (!Object.keys(paragraph).length) return false;
    if (
      hasCollectionEntries(paragraph.positionedObjectIds) ||
      hasCollectionEntries(paragraph.suggestedPositionedObjectIds)
    ) return false;
    return array(paragraph.elements).every((paragraphValue) => {
      const paragraphElement = record(paragraphValue);
      return isRecord(paragraphElement.textRun) &&
        !Object.keys(paragraphElement).some((key) => ![
          "startIndex",
          "endIndex",
          "textRun",
        ].includes(key));
    });
  });
}

function normalizeSheetValues(value: unknown) {
  const rows = sheetReadValuesSchema.parse(value).map((row) => [...row]);
  for (const row of rows) {
    while (row.length && (row.at(-1) === "" || row.at(-1) === null)) row.pop();
  }
  while (rows.length && rows.at(-1)?.length === 0) rows.pop();
  return rows;
}

function sheetPatchValues(value: unknown) {
  return sheetValuesSchema.parse(value).map((row) => [...row]);
}

function sheetPatchMatches(
  observedValue: unknown,
  patchValue: unknown,
) {
  const observed = normalizeSheetValues(observedValue);
  const patch = sheetPatchValues(patchValue);
  return patch.every((row, rowIndex) =>
    row.every((cell, columnIndex) => {
      const observedCell = observed[rowIndex]?.[columnIndex];
      return canonicalJsonSha256(observedCell ?? "") ===
        canonicalJsonSha256(cell);
    })
  );
}

function isCanonicalBase64(value: string) {
  if (value === "") return true;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.byteLength <= MAX_FILE_BYTES && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

function decodeBase64(value: string) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("Drive file content is too large.");
  return Uint8Array.from(bytes);
}

function textMimeType(value: string) {
  const normalized = value.toLowerCase().split(";", 1)[0];
  return normalized.startsWith("text/") || [
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
  ].includes(normalized);
}

function decodeUntrustedText(value: Uint8Array) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    if (/[\u0000]/.test(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function contentSha256(value: unknown) {
  return sha256(decodeBase64(String(value)));
}

function optionalIdSha256(value: unknown) {
  return value ? sha256(String(value)) : null;
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown) {
  return array(value).filter((item): item is string => typeof item === "string");
}

function hasCollectionEntries(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

function finiteInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}
