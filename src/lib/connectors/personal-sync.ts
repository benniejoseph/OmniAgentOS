import { refreshOAuthAccess, type OAuthProvider } from "@/lib/connectors/oauth-providers";
import { getOAuthGrantSecrets, listOAuthGrantsForTenant, saveOAuthGrant, updateOAuthSyncState } from "@/lib/connectors/oauth-store";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { deleteKnowledgeDocumentByIdempotencyKey } from "@/lib/rag/store";

type SyncCursor = { calendar?: string; gmailHistoryId?: string; driveModifiedAfter?: string };
type SyncItem = { id: string; kind: "mail" | "calendar" | "drive"; title: string; content: string; deleted?: boolean };

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
      results.push({ provider: grant.provider, status: "healthy", imported: synced.imported });
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
  try {
    const accessToken = await activeAccessToken(input, secrets.tokens, secrets.grant.expiresAt);
    const cursor = parseCursor(secrets.syncCursor);
    const result = await syncGoogle(accessToken, cursor, input.abortSignal);
    let imported = 0;
    let removed = 0;
    for (const item of result.items.slice(0, 40)) {
      const idempotencyKey = `oauth:${input.provider}:${item.kind}:${item.id}`;
      if (item.deleted) {
        await deleteKnowledgeDocumentByIdempotencyKey(idempotencyKey, { tenantId: input.tenantId });
        removed += 1;
        continue;
      }
      if (!item.content.trim()) continue;
      await ingestTextDocument({
        idempotencyKey,
        tenantId: input.tenantId,
        title: item.title,
        content: item.content,
        source: `${input.provider}:${item.kind}:${item.id}`,
        sourceType: "api",
        tags: ["connected-source", input.provider, item.kind],
        abortSignal: input.abortSignal,
      });
      imported += 1;
    }
    const grant = await updateOAuthSyncState({ ...input, status: "healthy", cursor: JSON.stringify(result.cursor), syncedItems: imported });
    return { provider: input.provider, imported, removed, cursorAdvanced: JSON.stringify(cursor) !== JSON.stringify(result.cursor), grant };
  } catch (error) {
    await updateOAuthSyncState({ ...input, status: "error", error: error instanceof Error ? error.message : "Sync failed." });
    throw error;
  }
}

async function activeAccessToken(input: { tenantId: string; actorId: string; provider: OAuthProvider }, tokens: Record<string, unknown>, expiresAt?: string) {
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : "";
  if (accessToken && (!expiresAt || Date.parse(expiresAt) > Date.now() + 60_000)) return accessToken;
  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
  if (!refreshToken) throw new Error("Connected source access expired. Reconnect it to continue syncing.");
  const refreshed = await refreshOAuthAccess(input.provider, refreshToken);
  await saveOAuthGrant({ ...input, tokens: refreshed });
  return String(refreshed.access_token);
}

async function syncGoogle(accessToken: string, cursor: SyncCursor, signal?: AbortSignal) {
  const headers = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
  const [mail, calendar, drive] = await Promise.all([
    googleMail(headers, cursor.gmailHistoryId, signal),
    googleCalendar(headers, cursor.calendar, signal),
    googleDrive(headers, cursor.driveModifiedAfter, signal),
  ]);
  return { items: [...mail.items, ...calendar.items, ...drive.items], cursor: { ...cursor, gmailHistoryId: mail.historyId, calendar: calendar.syncToken, driveModifiedAfter: drive.modifiedAfter } };
}

async function googleMail(headers: Record<string, string>, historyId?: string, signal?: AbortSignal) {
  let ids: string[] = [];
  let nextHistoryId = historyId;
  if (historyId) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
    url.searchParams.set("startHistoryId", historyId); url.searchParams.set("historyTypes", "messageAdded"); url.searchParams.set("maxResults", "50");
    const response = await providerJson(url.toString(), headers, signal, [404]);
    if (response.status === 404) return googleMail(headers, undefined, signal);
    const payload = response.body;
    ids = unique((array(payload.history).flatMap((entry) => array(record(entry).messagesAdded).map((added) => String(record(record(added).message).id || ""))))).filter(Boolean);
    nextHistoryId = String(payload.historyId || historyId);
  } else {
    const list = await providerJson("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=newer_than%3A30d", headers, signal);
    ids = array(list.body.messages).map((item) => String(record(item).id || "")).filter(Boolean);
    const profile = await providerJson("https://gmail.googleapis.com/gmail/v1/users/me/profile", headers, signal);
    nextHistoryId = String(profile.body.historyId || "") || undefined;
  }
  const details = await Promise.all(ids.slice(0, 20).map((id) => providerJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`, headers, signal).then((response) => response.body)));
  return { historyId: nextHistoryId, items: details.map(googleMessage) };
}

async function googleCalendar(headers: Record<string, string>, syncToken?: string, signal?: AbortSignal) {
  const initial = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  initial.searchParams.set("maxResults", "100"); initial.searchParams.set("singleEvents", "true"); initial.searchParams.set("showDeleted", "true");
  if (syncToken) initial.searchParams.set("syncToken", syncToken);
  else { initial.searchParams.set("timeMin", new Date(Date.now() - 30 * 86_400_000).toISOString()); initial.searchParams.set("timeMax", new Date(Date.now() + 365 * 86_400_000).toISOString()); }
  const first = await providerJson(initial.toString(), headers, signal, [410]);
  if (first.status === 410) return googleCalendar(headers, undefined, signal);
  let payload = first.body; const items = array(payload.items).map((item) => googleEvent(record(item))); let pages = 1;
  while (payload.nextPageToken && pages < 3) {
    initial.searchParams.set("pageToken", String(payload.nextPageToken));
    payload = (await providerJson(initial.toString(), headers, signal)).body;
    items.push(...array(payload.items).map((item) => googleEvent(record(item)))); pages += 1;
  }
  return { items, syncToken: String(payload.nextSyncToken || syncToken || "") || undefined };
}

async function googleDrive(headers: Record<string, string>, modifiedAfter?: string, signal?: AbortSignal) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("pageSize", "20");
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,webViewLink,description,trashed)");
  url.searchParams.set("q", `trashed = false and modifiedTime > '${modifiedAfter || new Date(Date.now() - 30 * 86_400_000).toISOString()}'`);
  const payload = (await providerJson(url.toString(), headers, signal)).body;
  const files = array(payload.files).map(record);
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
      extracted = (await providerText(exportUrl, headers, signal)).slice(0, 100_000);
    }
    return {
      id,
      kind: "drive",
      title: String(file.name || "Google Drive file"),
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
  const newest = files.map((file) => String(file.modifiedTime || "")).filter(Boolean).sort().at(-1);
  return { items: items.filter((item) => item.id), modifiedAfter: newest || modifiedAfter || new Date().toISOString() };
}

function googleMessage(value: Record<string, unknown>): SyncItem {
  const headers = array(record(value.payload).headers).map(record);
  const header = (name: string) => String(headers.find((item) => String(item.name).toLowerCase() === name.toLowerCase())?.value || "");
  return { id: String(value.id), kind: "mail", title: header("Subject") || "Email", content: [`Subject: ${header("Subject")}`, `From: ${header("From")}`, `To: ${header("To")}`, `Date: ${header("Date")}`, `Snippet: ${String(value.snippet || "")}`].join("\n") };
}
function googleEvent(value: Record<string, unknown>): SyncItem { const start = record(value.start); const end = record(value.end); return { id: String(value.id), kind: "calendar", title: String(value.summary || "Calendar event"), deleted: value.status === "cancelled", content: [`Event: ${String(value.summary || "Untitled")}`, `Start: ${String(start.dateTime || start.date || "")}`, `End: ${String(end.dateTime || end.date || "")}`, `Location: ${String(value.location || "")}`, `Description: ${String(value.description || "")}`, `Attendees: ${array(value.attendees).map((item) => String(record(item).email || "")).filter(Boolean).join(", ")}`].join("\n") }; }

async function providerJson(url: string, headers: Record<string, string>, signal?: AbortSignal, accepted: number[] = []) { const response = await fetch(url, { headers, signal }); const body = await response.json().catch(() => ({})) as Record<string, unknown>; if (!response.ok && !accepted.includes(response.status)) throw new Error(`Connected source returned ${response.status}.`); return { status: response.status, body }; }
async function providerText(url: string, headers: Record<string, string>, signal?: AbortSignal) { const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.hostname !== "www.googleapis.com") throw new Error("Provider returned an unsafe document URL."); const response = await fetch(url, { headers, signal }); if (!response.ok) throw new Error(`Connected source returned ${response.status}.`); return response.text(); }
function parseCursor(value?: string): SyncCursor { if (!value) return {}; try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed as SyncCursor : {}; } catch { return {}; } }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function unique(values: string[]) { return [...new Set(values)]; }
