import { randomUUID } from "node:crypto";

import { refreshOAuthAccess, type OAuthProvider } from "@/lib/connectors/oauth-providers";
import { getOAuthGrantSecrets, listOAuthGrantsForTenant, saveOAuthGrant, updateOAuthSyncState } from "@/lib/connectors/oauth-store";
import { observeGoogleDriveCanonicalMetadata } from "@/lib/connectors/google-drive-canonical";
import { observeGoogleDriveShadow } from "@/lib/connectors/google-drive-shadow";
import { extractCaptureFile } from "@/lib/capture/files";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { deleteKnowledgeDocumentByIdempotencyKey } from "@/lib/rag/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

type SyncCursor = {
  calendar?: string;
  calendarPageToken?: string;
  calendarTimeMin?: string;
  calendarTimeMax?: string;
  gmailHistoryId?: string;
  gmailPageToken?: string;
  gmailPendingHistoryId?: string;
  gmailBackfillPageToken?: string;
  gmailBackfillHistoryId?: string;
  driveModifiedAfter?: string;
  drivePageToken?: string;
  driveWindowStart?: string;
  driveWindowEnd?: string;
};
type SyncItem = {
  id: string;
  kind: "mail" | "calendar" | "drive";
  title: string;
  content: string;
  deleted?: boolean;
  providerRevisionId?: string;
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
  capturedAt?: string;
};
type PersonalSourceId = SyncItem["kind"];
type GoogleSourceObservation = Readonly<{
  source: PersonalSourceId;
  items: SyncItem[];
  cursor: Partial<SyncCursor>;
}>;
type PersonalSourceSettlement = Readonly<{
  source: PersonalSourceId;
  status: "healthy" | "error";
  imported: number;
  removed: number;
  error?: string;
}>;

export async function syncDuePersonalProviders(options: { tenantId: string; limit?: number; staleAfterMs?: number } ) {
  const limit = Math.min(Math.max(options.limit || 2, 1), 5);
  const staleBefore = Date.now() - (options.staleAfterMs || 30 * 60_000);
  const grants = (await listOAuthGrantsForTenant(options.tenantId))
    .filter((grant) => !grant.lastSyncedAt || Date.parse(grant.lastSyncedAt) <= staleBefore)
    .slice(0, limit);
  const results: Array<{ provider: OAuthProvider; status: "healthy" | "error"; imported?: number; error?: string }> = [];
  for (const grant of grants) {
    try {
      const synced = await syncPersonalProvider({ tenantId: grant.tenantId, actorId: grant.actorId, provider: grant.provider });
      results.push({
        provider: grant.provider,
        status: synced.status === "healthy" ? "healthy" : "error",
        imported: synced.imported,
        ...(synced.error ? { error: synced.error } : {}),
      });
    } catch (error) {
      results.push({ provider: grant.provider, status: "error", error: error instanceof Error ? error.message : "Sync failed." });
    }
  }
  return results;
}

export async function syncPersonalProvider(input: { tenantId: string; actorId: string; provider: OAuthProvider; abortSignal?: AbortSignal }) {
  const secrets = await getOAuthGrantSecrets(input.tenantId, input.actorId, input.provider);
  if (!secrets) throw new Error("Connected source not found.");
  await updateOAuthSyncState({ ...input, status: "syncing" });
  let shadowAccessToken: string | undefined;
  let shadowObservation: Promise<unknown> | undefined;
  let canonicalObservation: Promise<unknown> | undefined;
  const startDriveShadow = (accessToken: string) =>
    observeGoogleDriveShadow({
      accessToken,
      tenantId: input.tenantId,
      actorId: input.actorId,
      connectionId: secrets.grant.id,
      authorizationGeneration: secrets.grant.authorizationGeneration,
      abortSignal: input.abortSignal,
    }).catch(() => undefined);
  const startDriveCanonical = (accessToken: string) =>
    observeGoogleDriveCanonicalMetadata({
      accessToken,
      tenantId: input.tenantId,
      actorId: input.actorId,
      connectionId: secrets.grant.id,
      authorizationGeneration: secrets.grant.authorizationGeneration,
      abortSignal: input.abortSignal,
    }).catch(() => undefined);
  try {
    const accessToken = await activeAccessToken(input, secrets.tokens, secrets.grant.expiresAt);
    shadowAccessToken = accessToken;
    // This promise owns and suppresses all shadow failures, so the bounded
    // metadata page can overlap the full legacy fetch without changing its
    // health, cursor, return value, or served RAG behavior.
    shadowObservation = startDriveShadow(accessToken);
    // Generation 2 is a separately gated, Postgres-only metadata sidecar.
    // Missing, paused, or mismatched rollout state fails closed inside this
    // owned promise and cannot alter legacy sync behavior.
    canonicalObservation = startDriveCanonical(accessToken);
    const cursor = parseCursor(secrets.syncCursor);
    const observations = await observeGoogleSources(
      accessToken,
      cursor,
      input.abortSignal,
      { tenantId: input.tenantId, actorId: input.actorId, provider: input.provider },
    );
    const sourceExecutionScope = createExecutionScope({
      tenantId: input.tenantId,
      initiatingActorId: input.actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "connector.google.personal_sync",
      correlationId: `google-personal-sync:${randomUUID()}`,
      contextGrantIds: [secrets.grant.id],
      purpose: "connector.google.personal_sync.ingest",
    });
    let nextCursor = { ...cursor };
    const sources: PersonalSourceSettlement[] = [];
    for (const observation of observations) {
      if (observation.status === "rejected") {
        sources.push({
          source: observation.source,
          status: "error",
          imported: 0,
          removed: 0,
          error: safeSourceSyncError(observation.reason),
        });
        continue;
      }
      let sourceImported = 0;
      let sourceRemoved = 0;
      try {
        for (const item of observation.value.items) {
          const idempotencyKey = `oauth:${input.provider}:${item.kind}:${item.id}`;
          if (item.deleted) {
            await deleteKnowledgeDocumentByIdempotencyKey(idempotencyKey, {
              tenantId: input.tenantId,
            });
            sourceRemoved += 1;
            continue;
          }
          if (!item.content.trim()) continue;
          if (!item.capturedAt) {
            throw new Error(
              `Google ${item.kind} item is missing a canonical provider timestamp.`,
            );
          }
          await ingestTextDocument({
            idempotencyKey,
            tenantId: input.tenantId,
            title: item.title,
            content: item.content,
            source: `${input.provider}:${item.kind}:${item.id}`,
            sourceType: "api",
            tags: ["connected-source", input.provider, item.kind],
            abortSignal: input.abortSignal,
            usageScope: {
              tenantId: input.tenantId,
              actorId: input.actorId,
              sourceStreamId: `connector-sync:${input.provider}:${input.actorId}:${item.kind}`,
              operation: "embedding",
              purpose: `connector.${input.provider}.${item.kind}.ingest`,
              credentialSource: "deployment_environment",
            },
            sourceLineage: {
              executionScope: sourceExecutionScope,
              connectionId: secrets.grant.id,
              adapterId: `google.personal_sync.${item.kind}`,
              adapterVersionId: "1",
              externalItemId: `${item.kind}:${item.id}`,
              providerRevisionId: item.providerRevisionId || null,
              sourceKind: personalSourceKind(item.kind),
              sourceCreatedAt: item.sourceCreatedAt || null,
              sourceUpdatedAt: item.sourceUpdatedAt || null,
              capturedAt: item.capturedAt,
            },
          });
          sourceImported += 1;
        }
        const candidateCursor = { ...nextCursor, ...observation.value.cursor };
        const checkpoint = await updateOAuthSyncState({
          ...input,
          status: "syncing",
          cursor: JSON.stringify(candidateCursor),
          syncedItems: sourceImported,
        });
        if (!checkpoint) {
          throw new Error("Connected source was revoked during synchronization.");
        }
        nextCursor = candidateCursor;
        sources.push({
          source: observation.source,
          status: "healthy",
          imported: sourceImported,
          removed: sourceRemoved,
        });
      } catch (error) {
        sources.push({
          source: observation.source,
          status: "error",
          imported: sourceImported,
          removed: sourceRemoved,
          error: safeSourceSyncError(error),
        });
      }
    }
    const imported = sources.reduce((sum, source) => sum + source.imported, 0);
    const removed = sources.reduce((sum, source) => sum + source.removed, 0);
    const failed = sources.filter((source) => source.status === "error");
    const status = failed.length
      ? failed.length === sources.length ? "error" as const : "partial" as const
      : "healthy" as const;
    const error = failed.length
      ? failed.map((source) => `${source.source}: ${source.error}`).join("; ")
      : undefined;
    const grant = await updateOAuthSyncState({
      ...input,
      status: status === "healthy" ? "healthy" : "error",
      cursor: JSON.stringify(nextCursor),
      error,
    });
    return {
      provider: input.provider,
      status,
      imported,
      removed,
      cursorAdvanced: JSON.stringify(cursor) !== JSON.stringify(nextCursor),
      sources,
      error,
      grant,
    };
  } catch (error) {
    await updateOAuthSyncState({ ...input, status: "error", error: error instanceof Error ? error.message : "Sync failed." });
    throw error;
  } finally {
    if (shadowAccessToken) {
      shadowObservation ||= startDriveShadow(shadowAccessToken);
      canonicalObservation ||= startDriveCanonical(shadowAccessToken);
      await Promise.all([shadowObservation, canonicalObservation]);
    }
  }
}

async function activeAccessToken(input: { tenantId: string; actorId: string; provider: OAuthProvider }, tokens: Record<string, unknown>, expiresAt?: string) {
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : "";
  if (accessToken && (!expiresAt || Date.parse(expiresAt) > Date.now() + 60_000)) return accessToken;
  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
  if (!refreshToken) throw new Error("Connected source access expired. Reconnect it to continue syncing.");
  const refreshed = await refreshOAuthAccess(input.provider, refreshToken);
  await saveOAuthGrant({
    ...input,
    tokens: refreshed,
    authorizationMode: "refresh",
  });
  return String(refreshed.access_token);
}

async function observeGoogleSources(
  accessToken: string,
  cursor: SyncCursor,
  signal?: AbortSignal,
  identity?: { tenantId: string; actorId: string; provider: OAuthProvider },
) {
  const headers = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
  const settled = await Promise.allSettled([
    googleMail(headers, cursor, signal),
    googleCalendar(headers, cursor, signal),
    googleDrive(headers, cursor, signal, identity),
  ] as const);
  const mail = settled[0].status === "fulfilled"
    ? {
        source: "mail" as const,
        status: "fulfilled" as const,
        value: {
          source: "mail" as const,
          items: settled[0].value.items,
          cursor: settled[0].value.cursor,
        } satisfies GoogleSourceObservation,
      }
    : {
        source: "mail" as const,
        status: "rejected" as const,
        reason: settled[0].reason,
      };
  const calendar = settled[1].status === "fulfilled"
    ? {
        source: "calendar" as const,
        status: "fulfilled" as const,
        value: {
          source: "calendar" as const,
          items: settled[1].value.items,
          cursor: settled[1].value.cursor,
        } satisfies GoogleSourceObservation,
      }
    : {
        source: "calendar" as const,
        status: "rejected" as const,
        reason: settled[1].reason,
      };
  const drive = settled[2].status === "fulfilled"
    ? {
        source: "drive" as const,
        status: "fulfilled" as const,
        value: {
          source: "drive" as const,
          items: settled[2].value.items,
          cursor: settled[2].value.cursor,
        } satisfies GoogleSourceObservation,
      }
    : {
        source: "drive" as const,
        status: "rejected" as const,
        reason: settled[2].reason,
      };
  return [mail, calendar, drive] as const;
}

async function googleMail(
  headers: Record<string, string>,
  cursor: SyncCursor,
  signal?: AbortSignal,
) {
  let addedIds: string[] = [];
  let deletedIds: string[] = [];
  if (cursor.gmailHistoryId) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
    url.searchParams.set("startHistoryId", cursor.gmailHistoryId);
    url.searchParams.set("maxResults", "50");
    if (cursor.gmailPageToken) {
      url.searchParams.set("pageToken", cursor.gmailPageToken);
    }
    const response = await providerJson(url.toString(), headers, signal, [404]);
    if (response.status === 404) return googleMail(headers, {}, signal);
    const payload = response.body;
    addedIds = unique(array(payload.history).flatMap((entry) =>
      array(record(entry).messagesAdded).map((added) =>
        String(record(record(added).message).id || "")
      )
    )).filter(Boolean);
    deletedIds = unique(array(payload.history).flatMap((entry) =>
      array(record(entry).messagesDeleted).map((deleted) =>
        String(record(record(deleted).message).id || "")
      )
    )).filter(Boolean);
    const nextPageToken = optionalProviderString(payload.nextPageToken);
    const pendingHistoryId = String(
      payload.historyId || cursor.gmailPendingHistoryId || cursor.gmailHistoryId,
    );
    const items = await gmailItems(
      headers,
      addedIds.filter((id) => !deletedIds.includes(id)),
      deletedIds,
      signal,
    );
    return {
      items,
      cursor: nextPageToken
        ? {
            gmailHistoryId: cursor.gmailHistoryId,
            gmailPageToken: nextPageToken,
            gmailPendingHistoryId: pendingHistoryId,
            gmailBackfillPageToken: undefined,
            gmailBackfillHistoryId: undefined,
          }
        : {
            gmailHistoryId: pendingHistoryId,
            gmailPageToken: undefined,
            gmailPendingHistoryId: undefined,
            gmailBackfillPageToken: undefined,
            gmailBackfillHistoryId: undefined,
          },
    };
  }

  const historyFence = cursor.gmailBackfillHistoryId || String(
    (await providerJson(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      headers,
      signal,
    )).body.historyId || "",
  );
  if (!historyFence) throw new Error("Gmail profile returned no history fence.");
  const listUrl = new URL(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  );
  listUrl.searchParams.set("maxResults", "20");
  listUrl.searchParams.set("q", "newer_than:30d");
  if (cursor.gmailBackfillPageToken) {
    listUrl.searchParams.set("pageToken", cursor.gmailBackfillPageToken);
  }
  const list = await providerJson(listUrl.toString(), headers, signal);
  const listedMessages = array(list.body.messages);
  if (listedMessages.length > 20) {
    throw new Error("Gmail backfill page exceeds the requested item limit.");
  }
  addedIds = listedMessages
    .map((item) => String(record(item).id || ""))
    .filter(Boolean);
  const items = await gmailItems(headers, addedIds, [], signal);
  const nextPageToken = optionalProviderString(list.body.nextPageToken);
  return {
    items,
    cursor: nextPageToken
      ? {
          gmailHistoryId: undefined,
          gmailPageToken: undefined,
          gmailPendingHistoryId: undefined,
          gmailBackfillPageToken: nextPageToken,
          gmailBackfillHistoryId: historyFence,
        }
      : {
          gmailHistoryId: historyFence,
          gmailPageToken: undefined,
          gmailPendingHistoryId: undefined,
          gmailBackfillPageToken: undefined,
          gmailBackfillHistoryId: undefined,
        },
  };
}

async function gmailItems(
  headers: Record<string, string>,
  addedIds: string[],
  deletedIds: string[],
  signal?: AbortSignal,
) {
  if (addedIds.length + deletedIds.length > 200) {
    throw new Error("Gmail page exceeds the bounded item limit.");
  }
  const added = await Promise.all(addedIds.map(async (id): Promise<SyncItem> => {
    const response = await providerJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
      headers,
      signal,
      [404],
    );
    return response.status === 404
      ? { id, kind: "mail", title: "Removed email", content: "", deleted: true }
      : googleMessage(response.body);
  }));
  return [
    ...added,
    ...deletedIds.map((id): SyncItem => ({
      id,
      kind: "mail",
      title: "Removed email",
      content: "",
      deleted: true,
    })),
  ];
}

async function googleCalendar(
  headers: Record<string, string>,
  cursor: SyncCursor,
  signal?: AbortSignal,
) {
  const initial = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  initial.searchParams.set("maxResults", "100"); initial.searchParams.set("singleEvents", "true"); initial.searchParams.set("showDeleted", "true"); initial.searchParams.set("conferenceDataVersion", "1");
  const timeMin = cursor.calendarTimeMin || new Date(Date.now() - 30 * 86_400_000).toISOString();
  const timeMax = cursor.calendarTimeMax || new Date(Date.now() + 365 * 86_400_000).toISOString();
  if (cursor.calendar) initial.searchParams.set("syncToken", cursor.calendar);
  else {
    initial.searchParams.set("timeMin", timeMin);
    initial.searchParams.set("timeMax", timeMax);
  }
  if (cursor.calendarPageToken) {
    initial.searchParams.set("pageToken", cursor.calendarPageToken);
  }
  const first = await providerJson(initial.toString(), headers, signal, [410]);
  if (first.status === 410) {
    return googleCalendar(headers, {}, signal);
  }
  const payload = first.body;
  const providerItems = array(payload.items);
  if (providerItems.length > 100) {
    throw new Error("Google Calendar page exceeds the requested item limit.");
  }
  const items = providerItems.map((item) => googleEvent(record(item)));
  const nextPageToken = optionalProviderString(payload.nextPageToken);
  return {
    items,
    cursor: nextPageToken
      ? {
          calendar: cursor.calendar,
          calendarPageToken: nextPageToken,
          calendarTimeMin: cursor.calendar ? undefined : timeMin,
          calendarTimeMax: cursor.calendar ? undefined : timeMax,
        }
      : {
          calendar: String(payload.nextSyncToken || cursor.calendar || "") || undefined,
          calendarPageToken: undefined,
          calendarTimeMin: undefined,
          calendarTimeMax: undefined,
        },
  };
}

async function googleDrive(
  headers: Record<string, string>,
  cursor: SyncCursor,
  signal?: AbortSignal,
  identity?: { tenantId: string; actorId: string; provider: OAuthProvider },
) {
  const windowStart = cursor.driveWindowStart || cursor.driveModifiedAfter ||
    new Date(Date.now() - 30 * 86_400_000).toISOString();
  const windowEnd = cursor.driveWindowEnd || new Date().toISOString();
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("pageSize", "20");
  url.searchParams.set("orderBy", "modifiedTime,name");
  url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,version,headRevisionId,webViewLink,description,trashed,size,fileExtension)");
  url.searchParams.set("q", `trashed = false and modifiedTime > '${windowStart}' and modifiedTime <= '${windowEnd}'`);
  if (cursor.drivePageToken) {
    url.searchParams.set("pageToken", cursor.drivePageToken);
  }
  const payload = (await providerJson(url.toString(), headers, signal)).body;
  const files = array(payload.files).map(record);
  if (files.length > 20) {
    throw new Error("Google Drive page exceeds the requested item limit.");
  }
  const items = await Promise.all(files.slice(0, 20).map(async (file): Promise<SyncItem> => {
    const id = String(file.id || "");
    const mimeType = String(file.mimeType || "");
    const exportMime = mimeType === "application/vnd.google-apps.document"
      ? "text/plain"
      : mimeType === "application/vnd.google-apps.spreadsheet"
        ? "text/csv"
        : undefined;
    let extracted = "";
    if (id && exportMime) {
      const exportUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportMime)}`;
      try {
        extracted = (await providerText(exportUrl, headers, signal)).slice(0, 100_000);
      } catch {
        // A file can disappear or deny export after it was listed. Preserve
        // its useful metadata and let the next sync reconcile it.
      }
    }
    if (id && !extracted) {
      const size = Number(file.size || 0);
      const download = downloadableDriveFile(mimeType, String(file.fileExtension || ""), size);
      if (download) {
        try {
          const bytes = await providerBytes(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, headers, signal, 5 * 1024 * 1024);
          const parsed = await extractCaptureFile(
            new File([bytes], `${String(file.name || "drive-file")}.${download.extension}`, { type: download.mimeType }),
            identity ? {
              tenantId: identity.tenantId,
              actorId: identity.actorId,
              sourceStreamId: `connector-sync:${identity.provider}:${identity.actorId}`,
              operation: "ocr",
              purpose: "connector.google.drive.extract",
              credentialSource: "deployment_environment",
            } : undefined,
          );
          extracted = parsed.content.slice(0, 100_000);
        } catch {
          // Metadata remains useful when a Drive binary cannot be extracted.
        }
      }
    }
    const sourceCreatedAt = optionalCanonicalProviderTimestamp(file.createdTime);
    const sourceUpdatedAt = canonicalProviderTimestamp(
      file.modifiedTime,
      "Drive modifiedTime",
    );
    return {
      id,
      kind: "drive",
      title: String(file.name || "Google Drive file"),
      providerRevisionId: String(
        file.headRevisionId || file.version || file.modifiedTime || id,
      ),
      sourceCreatedAt,
      sourceUpdatedAt,
      capturedAt: sourceUpdatedAt,
      content: [
        `File: ${String(file.name || "Untitled")}`,
        `Type: ${mimeType}`,
        `Modified: ${String(file.modifiedTime || "")}`,
        `Link: ${String(file.webViewLink || "")}`,
        `Description: ${String(file.description || "")}`,
        extracted ? `Content:\n${extracted}` : "",
      ].filter(Boolean).join("\n"),
    };
  }));
  const nextPageToken = optionalProviderString(payload.nextPageToken);
  return {
    items: items.filter((item) => item.id),
    cursor: nextPageToken
      ? {
          driveModifiedAfter: cursor.driveModifiedAfter,
          drivePageToken: nextPageToken,
          driveWindowStart: windowStart,
          driveWindowEnd: windowEnd,
        }
      : {
          driveModifiedAfter: windowEnd,
          drivePageToken: undefined,
          driveWindowStart: undefined,
          driveWindowEnd: undefined,
        },
  };
}

function googleMessage(value: Record<string, unknown>): SyncItem {
  const headers = array(record(value.payload).headers).map(record);
  const header = (name: string) => String(headers.find((item) => String(item.name).toLowerCase() === name.toLowerCase())?.value || "");
  const payload = record(value.payload);
  const body = gmailText(payload).slice(0, 100_000);
  const attachments = gmailAttachments(payload);
  const observedAt = canonicalProviderEpochMilliseconds(
    value.internalDate,
    "Gmail internalDate",
  );
  return {
    id: String(value.id),
    kind: "mail",
    title: header("Subject") || "Email",
    providerRevisionId: String(value.historyId || value.internalDate || value.id),
    sourceCreatedAt: observedAt,
    sourceUpdatedAt: observedAt,
    capturedAt: observedAt,
    content: [`Subject: ${header("Subject")}`, `From: ${header("From")}`, `To: ${header("To")}`, `Cc: ${header("Cc")}`, `Date: ${header("Date")}`, `Labels: ${array(value.labelIds).map(String).join(", ")}`, body ? `Body:\n${body}` : `Snippet: ${String(value.snippet || "")}`, attachments.length ? `Attachments:\n${attachments.join("\n")}` : ""].filter(Boolean).join("\n"),
  };
}
function googleEvent(value: Record<string, unknown>): SyncItem {
  const start = record(value.start);
  const end = record(value.end);
  const organizer = record(value.organizer);
  const conference = record(value.conferenceData);
  const deleted = value.status === "cancelled";
  const sourceCreatedAt = optionalCanonicalProviderTimestamp(value.created);
  const sourceUpdatedAt = value.updated
    ? canonicalProviderTimestamp(value.updated, "Calendar updated")
    : undefined;
  if (!deleted && !sourceUpdatedAt) {
    throw new Error("Google Calendar item is missing a canonical updated timestamp.");
  }
  return {
    id: String(value.id),
    kind: "calendar",
    title: String(value.summary || "Calendar event"),
    deleted,
    providerRevisionId: String(value.etag || value.updated || value.id),
    sourceCreatedAt,
    sourceUpdatedAt,
    capturedAt: sourceUpdatedAt,
    content: [`Event: ${String(value.summary || "Untitled")}`, `Status: ${String(value.status || "")}`, `Start: ${String(start.dateTime || start.date || "")}`, `End: ${String(end.dateTime || end.date || "")}`, `Timezone: ${String(start.timeZone || end.timeZone || "")}`, `Location: ${String(value.location || "")}`, `Organizer: ${String(organizer.email || "")}`, `Meeting: ${String(value.hangoutLink || conference.conferenceId || "")}`, `Recurrence: ${array(value.recurrence).map(String).join("; ")}`, `Description: ${String(value.description || "")}`, `Attendees: ${array(value.attendees).map((item) => { const attendee = record(item); return `${String(attendee.email || "")} (${String(attendee.responseStatus || "unknown")})`; }).filter(Boolean).join(", ")}`].join("\n"),
  };
}

async function providerJson(url: string, headers: Record<string, string>, signal?: AbortSignal, accepted: number[] = []) { const response = await fetch(url, { headers, signal }); const body = await response.json().catch(() => ({})) as Record<string, unknown>; if (!response.ok && !accepted.includes(response.status)) throw new Error(`Connected source returned ${response.status}.`); return { status: response.status, body }; }
async function providerText(url: string, headers: Record<string, string>, signal?: AbortSignal) { const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.hostname !== "www.googleapis.com") throw new Error("Provider returned an unsafe document URL."); const response = await fetch(url, { headers, signal }); if (!response.ok) throw new Error(`Connected source returned ${response.status}.`); return response.text(); }
async function providerBytes(url: string, headers: Record<string, string>, signal: AbortSignal | undefined, maxBytes: number) { const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.hostname !== "www.googleapis.com") throw new Error("Provider returned an unsafe document URL."); const response = await fetch(url, { headers, signal }); if (!response.ok) throw new Error(`Connected source returned ${response.status}.`); const declared = Number(response.headers.get("content-length") || 0); if (declared > maxBytes) throw new Error("Connected file exceeds the extraction limit."); const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > maxBytes) throw new Error("Connected file exceeds the extraction limit."); return bytes; }
function gmailText(payload: Record<string, unknown>): string { const ownType = String(payload.mimeType || ""); const ownData = String(record(payload.body).data || ""); if (ownData && (ownType === "text/plain" || ownType === "text/html")) return ownType === "text/html" ? stripHtml(decodeBase64Url(ownData)) : decodeBase64Url(ownData); const parts = array(payload.parts).map(record); const plain = parts.flatMap((part) => gmailParts(part, "text/plain")); if (plain.length) return plain.join("\n\n"); return parts.flatMap((part) => gmailParts(part, "text/html")).map(stripHtml).join("\n\n"); }
function gmailParts(part: Record<string, unknown>, mimeType: string): string[] { const nested = array(part.parts).map(record).flatMap((child) => gmailParts(child, mimeType)); const data = String(record(part.body).data || ""); return String(part.mimeType || "") === mimeType && data ? [decodeBase64Url(data), ...nested] : nested; }
function gmailAttachments(payload: Record<string, unknown>): string[] { return array(payload.parts).map(record).flatMap((part) => { const nested = gmailAttachments(part); const filename = String(part.filename || "").trim(); const body = record(part.body); return filename ? [`- ${filename} · ${String(part.mimeType || "file")} · ${Number(body.size || 0)} bytes`, ...nested] : nested; }); }
function decodeBase64Url(value: string) { try { return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").trim(); } catch { return ""; } }
function stripHtml(value: string) { return value.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(); }
function downloadableDriveFile(mimeType: string, extension: string, size: number) {
  if (size > 5 * 1024 * 1024) return undefined;
  const normalizedExtension = extension.trim().toLowerCase();
  const knownMimeTypes: Record<string, string> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.oasis.opendocument.presentation": "odp",
    "application/epub+zip": "epub",
    "application/rtf": "rtf",
    "message/rfc822": "eml",
    "text/calendar": "ics",
    "text/vcard": "vcf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  const inferred = knownMimeTypes[mimeType];
  if (inferred) return { extension: inferred, mimeType };
  if (mimeType.startsWith("text/")) return { extension: normalizedExtension || "txt", mimeType };
  return undefined;
}
function parseCursor(value?: string): SyncCursor { if (!value) return {}; try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed as SyncCursor : {}; } catch { return {}; } }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function unique(values: string[]) { return [...new Set(values)]; }

function optionalProviderString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  if (text.length > 8_000 || /[\u0000-\u001f]/.test(text)) {
    throw new Error("Google returned an invalid pagination token.");
  }
  return text;
}

function personalSourceKind(kind: SyncItem["kind"]) {
  if (kind === "mail") return "email" as const;
  if (kind === "calendar") return "calendar_event" as const;
  return "file" as const;
}

function canonicalProviderEpochMilliseconds(value: unknown, field: string) {
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error(`Google ${field} is invalid.`);
  }
  return canonicalProviderTimestamp(milliseconds, field);
}

function canonicalProviderTimestamp(value: unknown, field: string) {
  const timestamp = new Date(
    typeof value === "number" ? value : String(value || ""),
  );
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`Google ${field} is invalid.`);
  }
  return timestamp.toISOString();
}

function optionalCanonicalProviderTimestamp(value: unknown) {
  return value === null || value === undefined || value === ""
    ? undefined
    : canonicalProviderTimestamp(value, "provider timestamp");
}

function safeSourceSyncError(error: unknown) {
  const message = error instanceof Error ? error.message : "Source sync failed.";
  return message.replace(/[\r\n<>]/g, " ").slice(0, 500);
}
