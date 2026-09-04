"use client";

import {
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  HardDrive,
  Images,
  Loader2,
  Mail,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Unplug,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";

export type OAuthProviderItem = {
  id: string;
  label: string;
  configured: boolean;
  authorizeUrl: string;
  scopes: string[];
};

export type OAuthGrantItem = {
  id?: string;
  provider: string;
  status?: "active" | "revoked";
  scopes: string[];
  updatedAt: string;
  syncStatus?: "idle" | "syncing" | "healthy" | "error";
  syncError?: string;
  lastSyncedAt?: string;
  syncedItems?: number;
  manageable?: boolean;
};

type PhotoPickerSession = {
  handle: string;
  pickerUri?: string;
  expiresAt: string;
  mediaItemsSet: boolean;
  pollAfterMs: number;
  timeoutAfterMs: number;
};

type Props = {
  providers: OAuthProviderItem[];
  grants: OAuthGrantItem[];
  requestReadContract?: "exact_v1" | "readable_v1";
  disabledReason?: string;
  loading?: boolean;
  onRefresh: () => Promise<void>;
  onJob?: (job: {
    id: string;
    status: "queued" | "running" | "completed" | "failed" | "canceled";
    progress?: Record<string, unknown>;
    lastError?: string;
  }) => void;
};

const sourceRows = [
  {
    id: "mail",
    label: "Email",
    detail: "Messages, people, decisions and attachments from Gmail.",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    prefix: "google:mail:",
    icon: Mail,
  },
  {
    id: "drive",
    label: "Drive",
    detail: "Google Docs, Sheets, PDFs and files you can access.",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    prefix: "google:drive:",
    icon: HardDrive,
  },
  {
    id: "calendar",
    label: "Calendar",
    detail: "Events, schedules, attendees and meeting context.",
    scope: "https://www.googleapis.com/auth/calendar.events.readonly",
    prefix: "google:calendar:",
    icon: CalendarDays,
  },
] as const;

export function ConnectedSources({
  providers,
  grants,
  requestReadContract,
  disabledReason,
  loading,
  onRefresh,
  onJob,
}: Props) {
  const provider = providers.find((item) => item.id === "google");
  const grant = grants.find((item) => item.provider === "google" && item.status !== "revoked");
  const connected = Boolean(grant);
  const actionDisabledReason = requestReadContract !== "readable_v1"
    ? "Connection ownership could not be verified. Refresh before changing this source."
    : grant && grant.manageable !== true
      ? "This retained connection is visible for continuity, but only its stored owner can use or change it."
      : disabledReason;
  const [action, setAction] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const [photoSession, setPhotoSession] = useState<PhotoPickerSession>();

  const photosGranted = useMemo(
    () => grant?.scopes.includes("https://www.googleapis.com/auth/photospicker.mediaitems.readonly") || false,
    [grant?.scopes],
  );

  const refreshPhotoSession = useCallback(async (handle: string) => {
    const response = await fetch(`/api/oauth/google/photos/sessions/${encodeURIComponent(handle)}`, {
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => ({}))) as {
      session?: PhotoPickerSession;
      error?: string;
    };
    if (!response.ok || !payload.session) throw new Error(payload.error || "Google Photos selection could not be checked.");
    const session = {
      ...payload.session,
      pickerUri: payload.session.pickerUri ||
        (photoSession?.handle === handle ? photoSession.pickerUri : undefined),
    };
    setPhotoSession((current) =>
      current?.handle === handle
        ? { ...session, pickerUri: session.pickerUri || current.pickerUri }
        : current
    );
    return session;
  }, [photoSession]);

  useEffect(() => {
    if (actionDisabledReason || !photoSession || photoSession.mediaItemsSet) return;
    const delay = Math.min(Math.max(photoSession.pollAfterMs || 3_000, 2_000), 10_000);
    const timer = window.setTimeout(() => {
      void refreshPhotoSession(photoSession.handle).catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [actionDisabledReason, photoSession, refreshPhotoSession]);

  function blockUnavailableAction() {
    if (!actionDisabledReason) return false;
    setMessage({ tone: "error", text: actionDisabledReason });
    return true;
  }

  async function syncGoogle() {
    if (blockUnavailableAction()) return;
    setAction("sync");
    setMessage(undefined);
    try {
      const response = await fetch("/api/oauth/google/sync", { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as {
        imported?: number;
        removed?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Google sync failed.");
      setMessage({
        tone: "success",
        text: `Google is up to date · ${payload.imported || 0} imported${payload.removed ? ` · ${payload.removed} removed` : ""}.`,
      });
      await onRefresh();
    } catch (syncError) {
      setMessage({ tone: "error", text: syncError instanceof Error ? syncError.message : "Google sync failed." });
    } finally {
      setAction(undefined);
    }
  }

  async function disconnectGoogle() {
    if (blockUnavailableAction()) return;
    setAction("disconnect");
    setMessage(undefined);
    try {
      const response = await fetch("/api/oauth/google", { method: "DELETE" });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        providerRevocation?: "revoked" | "not_needed" | "failed";
      };
      if (!response.ok) throw new Error(payload.error || "Google could not be disconnected.");
      setPhotoSession(undefined);
      setConfirming(undefined);
      setMessage({
        tone: payload.providerRevocation === "failed" ? "error" : "success",
        text: payload.providerRevocation === "failed"
          ? "Google is disconnected from Asael, but Google did not confirm remote revocation. Remove Asael from your Google account security page if needed."
          : "Google has been disconnected. Existing indexed data remains until you remove it.",
      });
      await onRefresh();
    } catch (disconnectError) {
      setMessage({ tone: "error", text: disconnectError instanceof Error ? disconnectError.message : "Google could not be disconnected." });
    } finally {
      setAction(undefined);
    }
  }

  async function removeImportedSource(id: string, prefix: string) {
    if (blockUnavailableAction()) return;
    setAction(`remove:${id}`);
    setMessage(undefined);
    try {
      const response = id === "photos"
        ? await fetch("/api/oauth/google/photos", { method: "DELETE" })
        : await fetch(`/api/knowledge?source=${encodeURIComponent(prefix)}`, { method: "DELETE" });
      const payload = (await response.json().catch(() => ({}))) as {
        deleted?: { documents?: number; memories?: number };
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || `${id} data could not be removed.`);
      setConfirming(undefined);
      setMessage({ tone: "success", text: `${sourceLabel(id)} data was removed from knowledge and linked memory.` });
      await onRefresh();
    } catch (removeError) {
      setMessage({ tone: "error", text: removeError instanceof Error ? removeError.message : `${sourceLabel(id)} data could not be removed.` });
    } finally {
      setAction(undefined);
    }
  }

  async function beginPhotoSelection() {
    if (blockUnavailableAction()) return;
    setAction("photos:create");
    setMessage(undefined);
    const pickerWindow = window.open("about:blank", "asael-google-photos");
    try {
      const response = await fetch("/api/oauth/google/photos/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxItemCount: 12 }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        session?: PhotoPickerSession;
        error?: string;
      };
      if (!response.ok || !payload.session?.pickerUri) throw new Error(payload.error || "Google Photos could not be opened.");
      setPhotoSession(payload.session);
      if (pickerWindow) {
        pickerWindow.opener = null;
        pickerWindow.location.replace(payload.session.pickerUri);
      } else {
        setMessage({ tone: "error", text: "Your browser blocked the photo picker. Use Open picker below." });
      }
    } catch (photoError) {
      pickerWindow?.close();
      setMessage({ tone: "error", text: photoError instanceof Error ? photoError.message : "Google Photos could not be opened." });
    } finally {
      setAction(undefined);
    }
  }

  async function importSelectedPhotos() {
    if (blockUnavailableAction()) return;
    if (!photoSession) return;
    setAction("photos:import");
    setMessage(undefined);
    try {
      const latest = photoSession.mediaItemsSet
        ? photoSession
        : await refreshPhotoSession(photoSession.handle);
      if (!latest.mediaItemsSet) {
        setMessage({ tone: "error", text: "Finish choosing photos in Google Photos, then return here." });
        return;
      }
      const response = await fetch(`/api/oauth/google/photos/sessions/${encodeURIComponent(latest.handle)}/import`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        imported?: number;
        skipped?: Array<{ filename: string; reason: string }>;
        selectionTruncated?: boolean;
        jobs?: Array<{
          id: string;
          status: "queued" | "running" | "completed" | "failed" | "canceled";
          progress?: Record<string, unknown>;
          lastError?: string;
        }>;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Selected photos could not be imported.");
      if (payload.jobs?.[0]) onJob?.(payload.jobs[0]);
      setPhotoSession(undefined);
      const skippedCount = Array.isArray(payload.skipped)
        ? payload.skipped.length
        : 0;
      setMessage({
        tone: "success",
        text: `${payload.imported || 0} photo${payload.imported === 1 ? "" : "s"} saved for indexing${skippedCount ? ` · ${skippedCount} skipped` : ""}${payload.selectionTruncated ? " · selection limit reached" : ""}.`,
      });
      await onRefresh();
    } catch (importError) {
      setMessage({ tone: "error", text: importError instanceof Error ? importError.message : "Selected photos could not be imported." });
    } finally {
      setAction(undefined);
    }
  }

  async function cancelPhotoSelection() {
    if (blockUnavailableAction()) return;
    if (!photoSession) return;
    setAction("photos:cancel");
    try {
      await fetch(`/api/oauth/google/photos/sessions/${encodeURIComponent(photoSession.handle)}`, { method: "DELETE" });
    } finally {
      setPhotoSession(undefined);
      setAction(undefined);
    }
  }

  const busy = Boolean(action) || loading;
  const connectUrl = addReturnTo(provider?.authorizeUrl || "/api/oauth/google/authorize");

  return (
    <section aria-labelledby="connected-sources-title" className="border-t border-line pt-7">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Connected sources</p>
          <h2 id="connected-sources-title" className="mt-2 text-xl font-semibold tracking-tight">Bring your working world into one index.</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Google access stays read-only. Asael stores indexed copies with provenance so you can use them in Command context and remove them later.</p>
          {grant ? <p className={clsx("mt-2 text-xs font-semibold", grant.syncStatus === "error" ? "text-danger" : "text-muted")}>{grant.syncStatus === "error" ? grant.syncError || "The last Google sync needs attention." : grant.lastSyncedAt ? `Last synced ${formatSourceTime(grant.lastSyncedAt)} · ${grant.syncedItems || 0} items imported` : "Connected · waiting for the first sync"}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {connected && !actionDisabledReason ? (
            <>
              <button type="button" onClick={() => void syncGoogle()} disabled={busy} className="primary-button">
                {action === "sync" ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
                {action === "sync" ? "Syncing…" : "Sync Google"}
              </button>
              <a href={connectUrl} className="action-button">Manage access</a>
              <button type="button" onClick={() => setConfirming("disconnect")} disabled={busy} className="action-button text-muted"><Unplug size={15} aria-hidden="true" />Disconnect</button>
            </>
          ) : connected ? (
            <span
              className="rounded-md border border-line bg-surface-raised px-3 py-2 text-sm font-semibold text-muted"
              title={actionDisabledReason}
            >
              Read only
            </span>
          ) : provider?.configured && !actionDisabledReason ? (
            <a href={connectUrl} className="primary-button">Connect Google</a>
          ) : provider?.configured ? (
            <button type="button" disabled className="primary-button" title={actionDisabledReason}>
              Connect Google
            </button>
          ) : (
            <span className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm font-semibold text-warning">Google OAuth setup required</span>
          )}
        </div>
      </div>

      {confirming === "disconnect" && !actionDisabledReason ? (
        <div className="mt-4 flex flex-col gap-3 border-l-2 border-warning bg-warning/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm leading-6">Disconnect Google? Indexed copies stay searchable until you remove them below.</p>
          <div className="flex gap-2"><button type="button" onClick={() => setConfirming(undefined)} className="action-button">Keep connected</button><button type="button" onClick={() => void disconnectGoogle()} className="primary-button">Disconnect</button></div>
        </div>
      ) : null}

      <div className="mt-5 overflow-hidden rounded-xl border border-line bg-surface">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-line bg-surface-raised px-4 py-3 text-xs font-semibold text-muted sm:grid-cols-[minmax(12rem,.8fr)_minmax(16rem,1.4fr)_auto]">
          <span>Source</span><span className="hidden sm:block">What Asael can use</span><span>Control</span>
        </div>
        {[...sourceRows, {
          id: "photos" as const,
          label: "Photos",
          detail: "Only photos you explicitly choose with Google Photos Picker.",
          scope: "https://www.googleapis.com/auth/photospicker.mediaitems.readonly" as const,
          prefix: "google:photos:" as const,
          icon: Images,
        }].map((source) => {
          const Icon = source.icon;
          const sourceConnected = source.id === "photos"
            ? photosGranted
            : grant?.scopes.includes(source.scope) || false;
          const removing = action === `remove:${source.id}`;
          return (
            <div key={source.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-line px-4 py-4 last:border-b-0 sm:grid-cols-[minmax(12rem,.8fr)_minmax(16rem,1.4fr)_auto] sm:items-center">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-raised text-primary"><Icon size={18} aria-hidden="true" /></span>
                <div className="min-w-0"><p className="font-semibold">{source.label}</p><p className={clsx("mt-0.5 text-xs", sourceConnected ? "text-success" : "text-muted")}>{sourceConnected ? "Connected" : connected && source.id === "photos" ? "Reconnect to enable" : "Not connected"}</p></div>
              </div>
              <p className="hidden text-sm leading-6 text-muted sm:block">{source.detail}</p>
              <div className="flex flex-wrap justify-end gap-2">
                {source.id === "photos" && sourceConnected && !actionDisabledReason ? (
                  <button type="button" onClick={() => void beginPhotoSelection()} disabled={busy} className="action-button">
                    {action === "photos:create" ? <Loader2 size={14} className="animate-spin" /> : <Images size={14} />}
                    Choose
                  </button>
                ) : null}
                {connected && sourceConnected && !actionDisabledReason ? (
                  confirming === source.id ? (
                    <div className="flex gap-1"><button type="button" onClick={() => setConfirming(undefined)} className="action-button">Cancel</button><button type="button" onClick={() => void removeImportedSource(source.id, source.prefix)} disabled={removing} className="action-button text-danger">{removing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}Remove</button></div>
                  ) : (
                    <button type="button" onClick={() => setConfirming(source.id)} disabled={busy} className="grid size-10 place-items-center rounded-md text-muted hover:bg-danger/10 hover:text-danger" aria-label={`Remove indexed ${source.label} data`}><Trash2 size={15} /></button>
                  )
                ) : connected && source.id === "photos" && !actionDisabledReason ? (
                  <a href={connectUrl} className="action-button">Enable <ChevronRight size={14} /></a>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {photoSession && !actionDisabledReason ? (
        <div className="mt-4 flex flex-col gap-3 border-l-2 border-primary bg-primary/5 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold"><Images size={16} aria-hidden="true" />Google Photos selection</p>
            <p className="mt-1 text-xs leading-5 text-muted">{photoSession.mediaItemsSet ? "Your selection is ready to import." : "Choose photos in the Google window, then return here."}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {photoSession.pickerUri ? <a href={photoSession.pickerUri} target="_blank" rel="noreferrer" className="action-button">Open picker</a> : null}
            <button type="button" onClick={() => void cancelPhotoSelection()} disabled={Boolean(action)} className="action-button">Cancel</button>
            <button type="button" onClick={() => void importSelectedPhotos()} disabled={Boolean(action)} className="primary-button">
              {action === "photos:import" ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {photoSession.mediaItemsSet ? "Import selected" : "Check selection"}
            </button>
          </div>
        </div>
      ) : null}

      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={clsx("mt-3 text-sm", message.tone === "error" ? "text-danger" : "text-success")}>{message.text}</p> : null}
      {actionDisabledReason ? <p className="mt-3 text-xs text-muted">{actionDisabledReason}</p> : null}
      <p className="mt-3 flex items-center gap-2 text-xs text-muted"><ShieldCheck size={14} aria-hidden="true" />Connect and disconnect apply to the Google account. Removing a category deletes only its indexed copies and linked memories.</p>
    </section>
  );
}

function addReturnTo(url: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}returnTo=${encodeURIComponent("/app/capture")}`;
}

function sourceLabel(id: string) {
  if (id === "mail") return "Email";
  if (id === "drive") return "Drive";
  if (id === "calendar") return "Calendar";
  return "Photos";
}

function formatSourceTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "recently"
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
