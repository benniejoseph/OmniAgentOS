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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";

import {
  closeGooglePhotosPickerSession,
  googlePhotosSessionDeadlineElapsed,
  nextGooglePhotosSessionWakeDelayMs,
  withGooglePhotosPollDeadline,
  type ClientGooglePhotosPickerSession,
  type GooglePhotosPickerSession,
} from "@/components/capture/google-photos-session";
import { googleWorkspaceCapabilitiesForScopes } from "@/lib/connectors/google-workspace-capabilities";
import { createConnectedSourceIdentity, waitForConnectedSourceClose, type ConnectedSourceIdentityToken } from "./connected-source-identity";
import styles from "./connected-sources.module.css";

const INTEGRATION_STATUS_CHANGED_EVENT = "asael:integration-status-changed";

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
  accountEmail?: string;
  connectionLabel?: string;
  connectionPurpose?: "personal" | "work";
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

type BoundPhotoSession = ClientGooglePhotosPickerSession & { connectionId: string };
type SourceEffect = { name: string; identity: ConnectedSourceIdentityToken; connectionId: string };
type SourceMessage = {
  tone: "success" | "warning" | "error";
  text: string;
  connectionId?: string;
  cleanup?: boolean;
};

class SupersededPhotoSelectionError extends Error {}

class GooglePhotosPickerSessionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GooglePhotosPickerSessionRequestError";
  }
}

const sourceRows = [
  {
    id: "mail",
    label: "Email",
    prefix: "google:mail:",
    icon: Mail,
  },
  {
    id: "drive",
    label: "Drive",
    prefix: "google:drive:",
    icon: HardDrive,
  },
  {
    id: "calendar",
    label: "Calendar",
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
  const googleGrants = useMemo(
    () => grants.filter(
      (item) => item.provider === "google" && item.status !== "revoked" && item.id,
    ),
    [grants],
  );
  const [selectedConnectionId, setSelectedConnectionId] = useState(
    () => googleGrants.find((item) => item.manageable)?.id || googleGrants[0]?.id || "",
  );
  // A selection that disappears from the grant list falls back to the same
  // manageable-first default used for the initial selection.
  const grant = googleGrants.find((item) => item.id === selectedConnectionId) ||
    googleGrants.find((item) => item.manageable) ||
    googleGrants[0];
  const connected = Boolean(grant);
  const actionDisabledReason = requestReadContract !== "readable_v1"
    ? "Connection ownership could not be verified. Refresh before changing this source."
    : grant && grant.manageable !== true
      ? "This retained connection is visible for continuity, but only its stored owner can use or change it."
      : disabledReason;
  const [action, setAction] = useState<SourceEffect>();
  const [confirming, setConfirming] = useState<{ kind: string; connectionId: string }>();
  const [message, setMessage] = useState<SourceMessage>();
  const [photoSession, setPhotoSession] = useState<BoundPhotoSession>();
  const photoSessionRef = useRef<BoundPhotoSession | undefined>(undefined);
  const mountedRef = useRef(false);
  const [photoImportContinuation, setPhotoImportContinuation] = useState(false);
  const connectionIdentityRef = useRef(createConnectedSourceIdentity(grant?.id));
  const actionRef = useRef<SourceEffect | undefined>(undefined);
  const photoReadRevisionRef = useRef(0);

  useLayoutEffect(() => {
    const identity = connectionIdentityRef.current;
    identity.select(grant?.id);
    if (actionRef.current && !identity.isCurrent(actionRef.current.identity)) {
      actionRef.current = undefined;
      // Release the UI when a refreshed grant list changes the effective account.
      setAction(undefined);
    }
    return () => identity.invalidate();
  }, [grant?.id]);

  const sourceAccess = useMemo(
    () => googleSourceAccess(grant?.scopes || []),
    [grant?.scopes],
  );

  const refreshIntegrationViews = useCallback(async () => {
    window.dispatchEvent(new Event(INTEGRATION_STATUS_CHANGED_EVENT));
    await onRefresh().catch(() => undefined);
  }, [onRefresh]);

  const storePhotoSession = useCallback((session?: BoundPhotoSession) => {
    photoSessionRef.current = session;
    setPhotoSession(session);
  }, []);

  const clearPhotoSession = useCallback(() => {
    storePhotoSession(undefined);
    setPhotoImportContinuation(false);
  }, [storePhotoSession]);

  const closeActivePhotoSession = useCallback(async () => {
    const activeSession = photoSessionRef.current;
    if (!activeSession) return;

    await closeGooglePhotosPickerSession(activeSession.handle);
    if (photoSessionRef.current?.handle === activeSession.handle) {
      clearPhotoSession();
    }
  }, [clearPhotoSession]);

  useEffect(() => {
    const identity = connectionIdentityRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      identity.invalidate();
      photoReadRevisionRef.current += 1;
      const activeSession = photoSessionRef.current;
      photoSessionRef.current = undefined;
      if (activeSession) {
        void closeGooglePhotosPickerSession(activeSession.handle, { keepalive: true })
          .catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    const callback = readOAuthCallbackNotice(window.location.href);
    if (!callback) return;
    let active = true;
    window.history.replaceState(window.history.state, "", callback.cleanUrl);
    void refreshIntegrationViews().finally(() => {
      if (active) setMessage(callback.message);
    });
    return () => { active = false; };
  }, [refreshIntegrationViews]);

  const refreshPhotoSession = useCallback(async (handle: string) => {
    const identity = connectionIdentityRef.current.capture();
    const initial = photoSessionRef.current;
    if (!initial || initial.handle !== handle || initial.connectionId !== identity.connectionId) {
      throw new SupersededPhotoSelectionError("This Google Photos selection belongs to another connection.");
    }
    const readRevision = ++photoReadRevisionRef.current;
    const currentRead = () => mountedRef.current &&
      connectionIdentityRef.current.isCurrent(identity) &&
      photoReadRevisionRef.current === readRevision;
    const response = await fetch(`/api/oauth/google/photos/sessions/${encodeURIComponent(handle)}`, {
      cache: "no-store",
    });
    if (!currentRead()) throw new SupersededPhotoSelectionError("This Google Photos read was superseded.");
    const payload = (await response.json().catch(() => ({}))) as {
      session?: GooglePhotosPickerSession;
      error?: string;
    };
    if (!currentRead()) throw new SupersededPhotoSelectionError("This Google Photos read was superseded.");
    if (!response.ok || !payload.session || payload.session.handle !== handle) {
      throw new GooglePhotosPickerSessionRequestError(
        payload.error || "Google Photos selection could not be checked.",
        response.status,
      );
    }
    const current = photoSessionRef.current;
    if (!current || current.handle !== handle || current.connectionId !== identity.connectionId) {
      throw new SupersededPhotoSelectionError("This Google Photos selection is no longer active.");
    }
    const session = { ...withGooglePhotosPollDeadline({
      ...payload.session,
      pickerUri: payload.session.pickerUri ||
        current.pickerUri,
    }, current), connectionId: current.connectionId };
    if (googlePhotosSessionDeadlineElapsed(session)) {
      try {
        await closeGooglePhotosPickerSession(handle);
      } finally {
        if (photoSessionRef.current?.handle === handle) clearPhotoSession();
      }
      if (!currentRead()) throw new SupersededPhotoSelectionError("This Google Photos read was superseded.");
      throw new Error("This Google Photos selection expired. Start a new selection to continue.");
    }
    storePhotoSession(session);
    return session;
  }, [clearPhotoSession, storePhotoSession]);

  const expirePhotoSession = useCallback(async (handle: string) => {
    const expiredSession = photoSessionRef.current;
    if (expiredSession?.handle !== handle) return;
    try {
      await closeGooglePhotosPickerSession(handle);
      if (photoSessionRef.current?.handle === handle) {
        clearPhotoSession();
        setMessage({
          tone: "warning",
          connectionId: expiredSession.connectionId,
          text: "The Google Photos selection expired and was closed. Start a new selection to continue.",
        });
      }
    } catch (closeError) {
      if (photoSessionRef.current?.handle === handle) {
        clearPhotoSession();
        setMessage({
          tone: "error",
          cleanup: true,
          connectionId: expiredSession.connectionId,
          text: closeError instanceof Error
            ? closeError.message
            : "The Google Photos selection expired, but its closure could not be confirmed.",
        });
      }
    }
  }, [clearPhotoSession]);

  useEffect(() => {
    if (!photoSession) return;
    const handle = photoSession.handle;
    let canceled = false;
    let timer: number | undefined;

    const scheduleNextCheck = () => {
      const activeSession = photoSessionRef.current;
      if (canceled || !activeSession || activeSession.handle !== handle) return;
      const nowMs = Date.now();
      const delay = actionDisabledReason || action || activeSession.connectionId !== grant?.id
        ? Math.max(0, activeSession.clientPollDeadlineAt - nowMs)
        : nextGooglePhotosSessionWakeDelayMs(activeSession, nowMs);
      timer = window.setTimeout(() => {
        void checkSession();
      }, delay);
    };

    const checkSession = async () => {
      const activeSession = photoSessionRef.current;
      if (canceled || !activeSession || activeSession.handle !== handle) return;
      if (googlePhotosSessionDeadlineElapsed(activeSession)) {
        await expirePhotoSession(handle);
        return;
      }

      if (!actionDisabledReason && !action && activeSession.connectionId === grant?.id && !activeSession.mediaItemsSet) {
        try {
          await refreshPhotoSession(handle);
        } catch (refreshError) {
          if (canceled || refreshError instanceof SupersededPhotoSelectionError) return;
          if (refreshError instanceof GooglePhotosPickerSessionRequestError &&
            (refreshError.status === 404 || refreshError.status === 410)) {
            if (photoSessionRef.current?.handle === handle) clearPhotoSession();
            setMessage({ tone: "warning", connectionId: activeSession.connectionId, text: "The Google Photos selection is no longer active." });
            return;
          }
          setMessage({
            tone: "error",
            connectionId: activeSession.connectionId,
            text: refreshError instanceof Error
              ? refreshError.message
              : "Google Photos selection could not be checked.",
          });
        }
      }
      scheduleNextCheck();
    };

    scheduleNextCheck();
    return () => {
      canceled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [action, actionDisabledReason, clearPhotoSession, expirePhotoSession, grant?.id, photoSession, refreshPhotoSession]);

  function blockUnavailableAction() {
    if (!actionDisabledReason) return false;
    setMessage({ tone: "error", text: actionDisabledReason, connectionId: grant?.id });
    return true;
  }

  function beginSourceAction(name: string): SourceEffect | undefined {
    if (actionRef.current || loading || blockUnavailableAction()) return undefined;
    const identity = connectionIdentityRef.current.capture();
    if (!identity.connectionId || !connectionIdentityRef.current.isCurrent(identity)) return undefined;
    let connectionId: string;
    try {
      connectionId = requiredConnectionId(grant);
    } catch (identityError) {
      setMessage({ tone: "error", text: identityError instanceof Error ? identityError.message : "Choose the Google account to use." });
      return undefined;
    }
    const effect = { name, identity, connectionId };
    actionRef.current = effect;
    setAction(effect);
    setMessage(undefined);
    return effect;
  }

  function sourceActionIsCurrent(effect: SourceEffect) {
    return mountedRef.current && actionRef.current === effect &&
      connectionIdentityRef.current.isCurrent(effect.identity);
  }

  function reportSourceAction(effect: SourceEffect, nextMessage: SourceMessage) {
    if (sourceActionIsCurrent(effect)) {
      setMessage({ ...nextMessage, connectionId: effect.identity.connectionId });
    }
  }

  function endSourceAction(effect: SourceEffect) {
    if (actionRef.current !== effect) return;
    actionRef.current = undefined;
    if (mountedRef.current) setAction(undefined);
  }

  async function selectGoogleConnection(connectionId: string) {
    if (actionRef.current || loading || connectionId === grant?.id) return;
    // Invalidate pending reads immediately, before waiting for the existing close.
    connectionIdentityRef.current.invalidate();
    connectionIdentityRef.current.select(grant?.id);
    photoReadRevisionRef.current += 1;
    const effect = { name: "account:change", identity: connectionIdentityRef.current.capture(), connectionId: grant?.id || "" };
    actionRef.current = effect;
    setAction(effect);
    setConfirming(undefined);
    setMessage(undefined);
    const previousSession = photoSessionRef.current;
    try {
      await waitForConnectedSourceClose(closeActivePhotoSession());
    } catch (closeError) {
      if (mountedRef.current) setMessage({
        tone: "error",
        cleanup: true,
        connectionId: previousSession?.connectionId || effect.identity.connectionId,
        text: `The previous Photos selection${previousSession ? ` ${previousSession.handle}` : ""} could not be confirmed closed. ${closeError instanceof Error ? closeError.message : "Return to its account to retry canceling it."}`,
      });
    } finally {
      if (sourceActionIsCurrent(effect)) {
        connectionIdentityRef.current.select(connectionId);
        setSelectedConnectionId(connectionId);
      }
      endSourceAction(effect);
    }
  }

  async function syncGoogle() {
    const effect = beginSourceAction("sync");
    if (!effect) return;
    try {
      const response = await fetch(
        `/api/oauth/google/sync?connectionId=${encodeURIComponent(effect.connectionId)}`,
        { method: "POST" },
      );
      const payload = (await response.json().catch(() => ({}))) as { imported?: number; removed?: number; error?: string };
      if (!sourceActionIsCurrent(effect)) return;
      if (!response.ok) throw new Error(payload.error || "Google sync failed.");
      reportSourceAction(effect, {
        tone: "success",
        text: `Google sync finished. ${typeof payload.imported === "number" ? `${payload.imported} imported` : "Import count unavailable"}${typeof payload.removed === "number" ? ` · ${payload.removed} removed` : ""}.`,
      });
      await refreshIntegrationViews();
    } catch (syncError) {
      if (!sourceActionIsCurrent(effect)) return;
      reportSourceAction(effect, { tone: "error", text: syncError instanceof Error ? syncError.message : "Google sync failed." });
      await refreshIntegrationViews();
    } finally {
      endSourceAction(effect);
    }
  }

  async function disconnectGoogle() {
    const effect = beginSourceAction("disconnect");
    if (!effect) return;
    try {
      await closeActivePhotoSession();
      if (!sourceActionIsCurrent(effect)) return;
      const response = await fetch(
        `/api/oauth/google?connectionId=${encodeURIComponent(effect.connectionId)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        providerRevocation?: "revoked" | "not_needed" | "failed";
      };
      if (!sourceActionIsCurrent(effect)) return;
      if (!response.ok) throw new Error(payload.error || "Google could not be disconnected.");
      clearPhotoSession();
      setConfirming(undefined);
      reportSourceAction(effect, {
        tone: payload.providerRevocation === "failed" ? "error" : "success",
        text: payload.providerRevocation === "failed"
          ? "Google is disconnected from Asael, but Google did not confirm remote revocation. Remove Asael from your Google account security page if needed."
          : "Google has been disconnected. Existing indexed data remains until you remove it.",
      });
      await refreshIntegrationViews();
    } catch (disconnectError) {
      reportSourceAction(effect, { tone: "error", text: disconnectError instanceof Error ? disconnectError.message : "Google could not be disconnected." });
    } finally {
      endSourceAction(effect);
    }
  }

  async function removeImportedSource(id: string, prefix: string) {
    const effect = beginSourceAction(`remove:${id}`);
    if (!effect) return;
    try {
      const sourcePrefix = googleSourcePrefix(grant, prefix);
      if (id === "photos") await closeActivePhotoSession();
      if (!sourceActionIsCurrent(effect)) return;
      const response = id === "photos"
        ? await fetch(
            `/api/oauth/google/photos?connectionId=${encodeURIComponent(effect.connectionId)}`,
            { method: "DELETE" },
          )
        : await fetch(
            `/api/knowledge?source=${encodeURIComponent(sourcePrefix)}`,
            { method: "DELETE", headers: { "idempotency-key": crypto.randomUUID() } },
          );
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!sourceActionIsCurrent(effect)) return;
      if (!response.ok) throw new Error(payload.error || `${id} data could not be removed.`);
      if (id === "photos") clearPhotoSession();
      setConfirming(undefined);
      reportSourceAction(effect, { tone: "success", text: `${sourceLabel(id)} data was removed from knowledge and linked memory.` });
      await refreshIntegrationViews();
    } catch (removeError) {
      reportSourceAction(effect, { tone: "error", text: removeError instanceof Error ? removeError.message : `${sourceLabel(id)} data could not be removed.` });
    } finally {
      endSourceAction(effect);
    }
  }

  async function closeCreatedPhotoSession(session: BoundPhotoSession) {
    try {
      await waitForConnectedSourceClose(
        closeGooglePhotosPickerSession(session.handle, { keepalive: !mountedRef.current }).then(() => {
          if (photoSessionRef.current?.handle === session.handle) clearPhotoSession();
        }),
      );
      return true;
    } catch (closeError) {
      if (mountedRef.current) setMessage({
        tone: "error",
        cleanup: true,
        connectionId: session.connectionId,
        text: `Closure of Photos selection ${session.handle} could not be confirmed. ${closeError instanceof Error ? closeError.message : "The selection may remain open until it expires."}`,
      });
      return false;
    }
  }

  async function beginPhotoSelection() {
    const effect = beginSourceAction("photos:create");
    if (!effect) return;
    const pickerWindow = window.open("about:blank", `asael-google-photos-${crypto.randomUUID()}`);
    let createdSession: BoundPhotoSession | undefined;
    try {
      await closeActivePhotoSession();
      if (!sourceActionIsCurrent(effect)) { pickerWindow?.close(); return; }
      const response = await fetch("/api/oauth/google/photos/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxItemCount: 12, connectionId: effect.connectionId }),
      });
      // Read a superseded create response only to close its exact returned handle.
      const payload = (await response.json().catch(() => ({}))) as { session?: GooglePhotosPickerSession; error?: string };
      if (payload.session?.handle) {
        createdSession = { ...withGooglePhotosPollDeadline(payload.session), connectionId: effect.identity.connectionId! };
      }
      if (!sourceActionIsCurrent(effect)) {
        pickerWindow?.close();
        if (createdSession) await closeCreatedPhotoSession(createdSession);
        return;
      }
      if (!response.ok || !createdSession?.pickerUri) throw new Error(payload.error || "Google Photos could not be opened.");
      if (googlePhotosSessionDeadlineElapsed(createdSession)) throw new Error("Google returned an expired Photos selection. Try again.");
      storePhotoSession(createdSession);
      setPhotoImportContinuation(false);
      if (pickerWindow) {
        pickerWindow.opener = null;
        pickerWindow.location.replace(createdSession.pickerUri);
      } else {
        reportSourceAction(effect, { tone: "error", text: "Your browser blocked the photo picker. Use Open picker below." });
      }
    } catch (photoError) {
      pickerWindow?.close();
      const closed = !createdSession || await closeCreatedPhotoSession(createdSession);
      if (closed) reportSourceAction(effect, {
        tone: "error",
        text: photoError instanceof Error ? photoError.message : "Google Photos could not be opened.",
      });
    } finally {
      endSourceAction(effect);
    }
  }

  async function importSelectedPhotos() {
    const effect = beginSourceAction("photos:import");
    if (!effect) return;
    const initial = photoSessionRef.current;
    try {
      if (!initial || initial.connectionId !== effect.identity.connectionId) return;
      const latest = initial.mediaItemsSet ? initial : await refreshPhotoSession(initial.handle);
      if (!sourceActionIsCurrent(effect) || photoSessionRef.current?.handle !== latest.handle) return;
      if (!latest.mediaItemsSet) {
        reportSourceAction(effect, { tone: "error", text: "Finish choosing photos in Google Photos, then return here." });
        return;
      }
      const response = await fetch(`/api/oauth/google/photos/sessions/${encodeURIComponent(latest.handle)}/import`, { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as {
        imported?: number;
        skipped?: Array<{ filename: string; code: string; reason: string }>;
        selectionTruncated?: boolean;
        sessionDeleted?: boolean;
        jobs?: Array<{
          id: string;
          status: "queued" | "running" | "completed" | "failed" | "canceled";
          progress?: Record<string, unknown>;
          lastError?: string;
        }>;
        error?: string;
      };
      if (!sourceActionIsCurrent(effect)) return;
      if (!response.ok) throw new Error(payload.error || "Selected photos could not be imported.");
      if (payload.jobs?.[0]) onJob?.(payload.jobs[0]);
      const needsContinuation = payload.sessionDeleted !== true;
      if (needsContinuation) {
        storePhotoSession(latest);
        setPhotoImportContinuation(true);
      } else {
        clearPhotoSession();
      }
      const skippedCount = Array.isArray(payload.skipped) ? payload.skipped.length : 0;
      const transferLimited = payload.skipped?.some((item) => item.code === "batch_transfer_limit") === true;
      const continuationCopy = needsContinuation
        ? transferLimited
          ? " Continue import to process the remaining photos."
          : skippedCount
            ? " Retry the skipped items or cancel this selection when you are done."
            : " Continue once to finish the Google session, or cancel it."
        : "";
      reportSourceAction(effect, {
        tone: needsContinuation ? "warning" : "success",
        text: `${typeof payload.imported === "number" ? `${payload.imported} photo${payload.imported === 1 ? "" : "s"} saved for indexing` : "Photo import finished; saved count unavailable"}${skippedCount ? ` · ${skippedCount} skipped` : ""}${payload.selectionTruncated ? " · selection limit reached" : ""}.${continuationCopy}`,
      });
      await refreshIntegrationViews();
    } catch (importError) {
      if (importError instanceof SupersededPhotoSelectionError) return;
      reportSourceAction(effect, { tone: "error", text: importError instanceof Error ? importError.message : "Selected photos could not be imported." });
    } finally {
      endSourceAction(effect);
    }
  }

  async function cancelPhotoSelection() {
    const effect = beginSourceAction("photos:cancel");
    if (!effect) return;
    try {
      if (photoSessionRef.current?.connectionId !== effect.identity.connectionId) return;
      await closeActivePhotoSession();
      reportSourceAction(effect, { tone: "success", text: "Google Photos selection canceled." });
    } catch (cancelError) {
      reportSourceAction(effect, {
        tone: "error",
        text: cancelError instanceof Error ? cancelError.message : "Google Photos could not confirm that the selection was canceled.",
      });
    } finally {
      endSourceAction(effect);
    }
  }

  const busy = Boolean(action) || Boolean(loading);
  const accessVerified = requestReadContract === "readable_v1" && !loading;
  const hasSnapshot = providers.length > 0 || grants.length > 0;
  const confirmation = confirming?.connectionId === grant?.id ? confirming?.kind : undefined;
  const visibleMessage = message && (message.cleanup || !message.connectionId || message.connectionId === grant?.id) ? message : undefined;
  const photoBelongsToAccount = photoSession?.connectionId === grant?.id;
  const connectUrl = addReturnTo(provider?.authorizeUrl || "/api/oauth/google/authorize");
  const repairUrl = googleAccountAuthorizeUrl(provider?.authorizeUrl || "/api/oauth/google/authorize", grant);

  return (
    <section aria-labelledby="connected-sources-title" className={styles.shell} data-testid="connected-sources">
      <div className={styles.header}>
        <div>
          <h2 id="connected-sources-title" className={styles.title}>Connected sources</h2>
          <p className={styles.intro}>Sync permitted sources into your private index. Changes to Gmail, Calendar, and Drive use separately governed actions. Photos includes only the items you choose.</p>
        </div>
        <button type="button" onClick={() => void refreshIntegrationViews()} disabled={busy} className={styles.button} aria-label="Refresh connected sources"><RefreshCw size={16} aria-hidden="true" />Refresh</button>
      </div>

      <p className={styles.readStatus} role="status">
        {loading
          ? hasSnapshot ? "Refreshing connection access. Last-loaded details are shown below." : "Loading connected sources…"
          : requestReadContract !== "readable_v1"
            ? hasSnapshot ? "Connection access is unverified. Last-loaded details are shown below; source actions are unavailable." : "Connection information is unavailable until ownership is verified."
            : "Connection snapshot. Refresh to check the latest access and sync status."}
      </p>

      <div className={styles.header}>
        <div>
          <h3 className={styles.accountTitle}>{provider?.label || "Google"}</h3>
          <p className={styles.identity}>Provider ID: {provider?.id || "Unavailable"}</p>
          {accessVerified && provider?.configured === false ? <p className={styles.supporting}>Google OAuth setup is required before connecting an account.</p> : null}
          {accessVerified && !provider ? <p className={styles.supporting}>The Google provider was not returned in this snapshot.</p> : null}
          {accessVerified && !connected ? <p className={styles.supporting}>No active Google connections were returned. Connect an account to review its permitted sources.</p> : null}
        </div>
        <div className={styles.actions}>
          {googleGrants.length > 1 ? (
            <label className={styles.field}>
              Google account
              <select
                value={grant?.id || ""}
                onChange={(event) => void selectGoogleConnection(event.target.value)}
                disabled={busy}
                className={styles.select}
              >
                {googleGrants.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.connectionLabel || (item.connectionPurpose === "work" ? "Work" : "Personal")}
                    {item.accountEmail ? ` · ${item.accountEmail}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {connected && !actionDisabledReason ? (
            <>
              <button type="button" onClick={() => void syncGoogle()} disabled={busy} className={styles.primaryButton}>
                {action?.name === "sync" ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}Sync Google
              </button>
              {busy ? <button type="button" className={styles.button} disabled>Manage access</button> : <a href={repairUrl} className={styles.button}>Manage access</a>}
              <button type="button" onClick={() => setConfirming({ kind: "disconnect", connectionId: grant!.id! })} disabled={busy} className={styles.button}><Unplug size={16} aria-hidden="true" />Disconnect</button>
            </>
          ) : connected ? (
            <p className={styles.supporting}>{accessVerified && grant?.manageable !== true ? "Read-only connection" : "Connection actions unavailable"}</p>
          ) : provider?.configured && !actionDisabledReason && !busy ? (
            <a href={connectUrl} className={styles.primaryButton}>Connect Google</a>
          ) : (
            <button type="button" disabled className={styles.primaryButton}>Connect Google</button>
          )}
        </div>
      </div>

      {action ? <p className={styles.pending} role="status">{sourceActionLabel(action.name)}{action.identity.connectionId ? <> · Connection ID: <span className={styles.identity}>{action.identity.connectionId}</span></> : null}</p> : null}
      {actionDisabledReason ? <p className={clsx(styles.notice, styles.neutral)}>{actionDisabledReason}</p> : null}

      {grant ? (
        <section className={styles.account} aria-label="Selected Google account">
          <h3 className={styles.accountTitle}>{grant.connectionLabel || (grant.connectionPurpose === "work" ? "Work account" : "Personal account")}</h3>
          <p className={styles.supporting}>{grant.accountEmail || "Account email unavailable"}</p>
          <p className={styles.identity}>Connection ID: {grant.id}</p>
          <p className={clsx(styles.readStatus, grant.syncStatus === "error" && styles.dangerText)}>{googleSyncStatusLabel(grant)}</p>
          <details className={styles.details}>
            <summary>Connection details</summary>
            <dl className={styles.metadata}>
              <div><dt>Account email</dt><dd>{grant.accountEmail || "Unavailable"}</dd></div>
              <div><dt>Connection label</dt><dd>{grant.connectionLabel || "Not specified"}</dd></div>
              <div><dt>Account type</dt><dd>{grant.connectionPurpose || "Not specified"}</dd></div>
              <div><dt>Grant status</dt><dd>{grant.status || "Unavailable"}</dd></div>
              <div><dt>Access</dt><dd>{accessVerified ? grant.manageable === true ? "Manageable by this session" : "Read-only retained connection" : "Ownership unverified"}</dd></div>
              <div><dt>Updated</dt><dd>{formatSourceTime(grant.updatedAt)}</dd></div>
              <div><dt>Last synced</dt><dd>{grant.lastSyncedAt ? formatSourceTime(grant.lastSyncedAt) : "No timestamp returned"}</dd></div>
              <div><dt>Imported items</dt><dd>{typeof grant.syncedItems === "number" ? grant.syncedItems : "Count unavailable"}</dd></div>
            </dl>
            <h4 className={styles.sourceTitle}>{accessVerified ? "Granted scopes" : "Last-loaded scopes"}</h4>
            {grant.scopes.length ? <ul className={styles.scopeList}>{grant.scopes.map((scope) => <li key={scope} className={styles.identity}>{scope}</li>)}</ul> : <p className={styles.supporting}>No scopes were returned for this connection.</p>}
          </details>
        </section>
      ) : null}

      {confirmation === "disconnect" && !actionDisabledReason ? (
        <div className={styles.confirmation} role="group" aria-label="Confirm Google disconnect">
          <div className={styles.confirmationText}>
            <p>Disconnect {grant?.accountEmail || grant?.connectionLabel || "this Google account"}?</p>
            <p className={styles.supporting}>Indexed copies stay searchable until you remove them below.</p>
            <p className={styles.identity}>Connection ID: {grant?.id}</p>
          </div>
          <div className={styles.actions}>
            <button type="button" onClick={() => setConfirming(undefined)} disabled={busy} className={styles.button}>Keep connected</button>
            <button type="button" onClick={() => void disconnectGoogle()} disabled={busy} className={styles.primaryButton}>Confirm disconnect</button>
          </div>
        </div>
      ) : null}

      <div className={styles.sourceList}>
        {[...sourceRows, { id: "photos" as const, label: "Photos", prefix: "google:photos:" as const, icon: Images }].map((source) => {
          const Icon = source.icon;
          const access = sourceAccess[source.id];
          const sourceConnected = access.granted;
          const sourcePrefix = grant?.id?.trim() ? googleSourcePrefix(grant, source.prefix) : undefined;
          return (
            <article key={source.id} className={styles.sourceRow} aria-label={`${source.label} source`}>
              <div className={styles.sourceHeading}>
                <span className={styles.sourceIcon}><Icon size={18} aria-hidden="true" /></span>
                <div>
                  <h3 className={styles.sourceTitle}>{source.label}</h3>
                  <p className={clsx(styles.sourceStatus, accessVerified && sourceConnected && styles.successText)}>
                    {!accessVerified ? sourceConnected ? `Last loaded: ${access.label}` : "Access unverified" : sourceConnected ? access.label : connected ? "Not granted" : "Not connected"}
                  </p>
                </div>
              </div>
              <div className={styles.sourceDescription}>
                <p>{accessVerified || grant ? access.detail : "Source permissions are unavailable until connection ownership is verified."}</p>
                {sourcePrefix ? <p className={styles.identity}>Source prefix: {sourcePrefix}</p> : null}
              </div>
              <div className={styles.sourceControls}>
                {source.id === "photos" && sourceConnected && !actionDisabledReason ? (
                  <button type="button" onClick={() => void beginPhotoSelection()} disabled={busy} className={styles.button}>
                    {action?.name === "photos:create" ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : <Images size={16} aria-hidden="true" />}Choose photos
                  </button>
                ) : null}
                {connected && sourceConnected && !actionDisabledReason ? (
                  <button type="button" onClick={() => setConfirming({ kind: source.id, connectionId: grant!.id! })} disabled={busy} className={styles.iconButton} aria-label={`Remove indexed ${source.label} data`}><Trash2 size={16} aria-hidden="true" /></button>
                ) : connected && source.id === "photos" && !actionDisabledReason ? (
                  busy ? <button type="button" disabled className={styles.button}>Enable Photos</button> : <a href={connectUrl} className={styles.button}>Enable Photos<ChevronRight size={16} aria-hidden="true" /></a>
                ) : null}
              </div>
              {confirmation === source.id && !actionDisabledReason ? (
                <div className={styles.confirmation} role="group" aria-label={`Confirm removing ${source.label} data`}>
                  <div className={styles.confirmationText}>
                    <p>Remove indexed {source.label} copies and their linked memories?</p>
                    <p className={styles.identity}>Connection ID: {grant?.id}</p>
                  </div>
                  <div className={styles.actions}>
                    <button type="button" onClick={() => setConfirming(undefined)} disabled={busy} className={styles.button} aria-label={`Cancel removing ${source.label} data`}>Cancel</button>
                    <button type="button" onClick={() => void removeImportedSource(source.id, source.prefix)} disabled={busy} className={styles.button} aria-label={`Confirm removing ${source.label} data`}><Trash2 size={16} aria-hidden="true" />Remove</button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {photoSession && photoBelongsToAccount ? (
        <section className={styles.photoPanel} aria-label="Google Photos selection">
          <div className={styles.photoHeader}>
            <div>
              <h3 className={styles.sourceTitle}><Images size={18} aria-hidden="true" />Google Photos selection</h3>
              <p className={styles.supporting}>{photoImportContinuation ? "Part of this selection is already saved. Continue import to retry the remaining items." : photoSession.mediaItemsSet ? "Your selection is ready to import." : "Choose photos in the Google window, then return here."}</p>
              <p className={styles.identity}>Connection ID: {photoSession.connectionId}</p>
              <p className={styles.identity}>Selection ID: {photoSession.handle}</p>
              <p className={styles.supporting}>Expires {formatSourceTime(photoSession.expiresAt)}</p>
            </div>
            <div className={styles.actions}>
              {photoSession.pickerUri ? busy || actionDisabledReason ? <button type="button" disabled className={styles.button}>Open picker</button> : <a href={photoSession.pickerUri} target="_blank" rel="noreferrer" className={styles.button}>Open picker</a> : null}
              <button type="button" onClick={() => void cancelPhotoSelection()} disabled={busy || Boolean(actionDisabledReason)} className={styles.button} aria-label="Cancel Photos selection">Cancel</button>
              <button type="button" onClick={() => void importSelectedPhotos()} disabled={busy || Boolean(actionDisabledReason)} className={styles.primaryButton}>
                {action?.name === "photos:import" ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
                {photoImportContinuation ? "Continue import" : photoSession.mediaItemsSet ? "Import selected" : "Check selection"}
              </button>
            </div>
          </div>
          {actionDisabledReason ? <p className={styles.supporting}>{actionDisabledReason}</p> : null}
        </section>
      ) : photoSession ? (
        <p className={clsx(styles.notice, styles.warning)}>A Photos selection for connection <span className={styles.identity}>{photoSession.connectionId}</span> has not been confirmed closed. Select its account to retry cancellation. It is unavailable to the currently selected account.</p>
      ) : null}

      {visibleMessage ? (
        <div role={visibleMessage.tone === "error" ? "alert" : "status"} className={clsx(styles.notice, visibleMessage.tone === "error" ? styles.danger : visibleMessage.tone === "warning" ? styles.warning : styles.success)}>
          <p>{visibleMessage.text}</p>
          {visibleMessage.connectionId ? <p className={styles.identity}>Connection ID: {visibleMessage.connectionId}</p> : null}
        </div>
      ) : null}
      <p className={styles.footer}><ShieldCheck size={16} aria-hidden="true" /><span>Connect and disconnect apply to the selected Google account. Removing a category deletes its indexed copies and linked memories.</span></p>
    </section>
  );
}

function sourceActionLabel(action: string) {
  if (action === "account:change") return "Closing the previous Photos selection before switching accounts…";
  if (action === "sync") return "Google sync is running…";
  if (action === "disconnect") return "Disconnecting Google…";
  if (action === "photos:create") return "Opening a Google Photos selection…";
  if (action === "photos:import") return "Checking or importing the selected photos…";
  if (action === "photos:cancel") return "Closing the Google Photos selection…";
  if (action.startsWith("remove:")) return `Removing indexed ${sourceLabel(action.slice(7))} data…`;
  return "Source action in progress…";
}

function googleSyncStatusLabel(grant: OAuthGrantItem) {
  if (grant.syncStatus === "error") return grant.syncError || "The last reported Google sync needs attention.";
  if (grant.syncStatus === "syncing") return "Last reported sync status: in progress.";
  if (grant.lastSyncedAt) return `Last synced ${formatSourceTime(grant.lastSyncedAt)} · ${typeof grant.syncedItems === "number" ? `${grant.syncedItems} items imported` : "import count unavailable"}`;
  if (grant.syncStatus === "healthy") return "Last reported sync status: healthy. No sync timestamp was returned.";
  if (grant.syncStatus === "idle") return "Last reported sync status: idle. No completed sync timestamp was returned.";
  return "Sync status is unavailable in this snapshot.";
}

function addReturnTo(url: string, intent?: "repair") {
  const separator = url.includes("?") ? "&" : "?";
  const params = new URLSearchParams({ returnTo: "/app/capture" });
  if (intent) params.set("intent", intent);
  return `${url}${separator}${params.toString()}`;
}

function googleAccountAuthorizeUrl(
  url: string,
  grant: OAuthGrantItem | undefined,
) {
  const params = new URLSearchParams({
    returnTo: "/app/capture",
    intent: "repair",
    account: grant?.connectionPurpose || "personal",
  });
  if (grant?.id) params.set("connectionId", grant.id);
  return `${url}${url.includes("?") ? "&" : "?"}${params.toString()}`;
}

function requiredConnectionId(grant: OAuthGrantItem | undefined) {
  const connectionId = grant?.id?.trim();
  if (!connectionId) throw new Error("Choose the Google account to use.");
  return connectionId;
}

function googleSourcePrefix(grant: OAuthGrantItem | undefined, prefix: string) {
  if (grant?.connectionPurpose !== "work") return prefix;
  const connectionId = requiredConnectionId(grant);
  const source = prefix.replace(/^google:/, "");
  return `google:work:${connectionId}:${source}`;
}

function sourceLabel(id: string) {
  if (id === "mail") return "Email";
  if (id === "drive") return "Drive";
  if (id === "calendar") return "Calendar";
  return "Photos";
}

function formatSourceTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function googleSourceAccess(scopes: readonly string[]) {
  const capabilities = googleWorkspaceCapabilitiesForScopes(scopes);
  const gmailRead = capabilities.has("gmail.read");
  const gmailSend = capabilities.has("gmail.send");
  const gmailModify = capabilities.has("gmail.modify");
  const gmailTrash = capabilities.has("gmail.trash");
  const calendarRead = capabilities.has("calendar.events.read");
  const calendarWrite = capabilities.has("calendar.events.write");
  const driveRead = capabilities.has("drive.read");
  const driveWrite = capabilities.has("drive.write");
  const photosPicked = capabilities.has("photos.pick");

  return {
    mail: {
      granted: gmailRead || gmailSend,
      label: gmailModify && gmailTrash
        ? "Read + send + trash"
        : gmailRead && gmailSend
          ? "Read + send"
          : gmailRead ? "Read only" : gmailSend ? "Send only" : "Not granted",
      detail: gmailModify && gmailTrash
        ? "Read and send Gmail messages; recoverable deletion moves them to Trash."
        : gmailRead && gmailSend
          ? "Read and send Gmail messages; moving messages to Trash is not granted."
          : gmailRead
            ? "Read Gmail messages and attachments; sending and deletion are not granted."
            : gmailSend
              ? "Send Gmail messages; inbox content is not readable."
              : "Gmail content and actions are unavailable.",
    },
    calendar: {
      granted: calendarRead,
      label: calendarWrite ? "Read + write" : calendarRead ? "Read only" : "Not granted",
      detail: calendarWrite
        ? "View, create, update, and delete Calendar events through governed actions."
        : calendarRead
          ? "View Calendar events and schedules; event changes are not granted."
          : "Calendar events are unavailable.",
    },
    drive: {
      granted: driveRead,
      label: driveRead && driveWrite
        ? "Full read + write"
        : driveRead ? "Read only" : "Not granted",
      detail: driveRead && driveWrite
        ? "View and change all accessible Drive files through governed actions."
        : driveRead
          ? "View and export accessible Drive files; file changes are not granted."
          : "Drive files are unavailable.",
    },
    photos: {
      granted: photosPicked,
      label: photosPicked ? "User-picked only" : "Not granted",
      detail: photosPicked
        ? "Import only photos and videos you explicitly choose in Google Photos Picker."
        : "Asael cannot browse or sync your Photos library in the background.",
    },
  } as const;
}

function readOAuthCallbackNotice(value: string): {
  message: { tone: "success" | "warning" | "error"; text: string };
  cleanUrl: string;
} | undefined {
  const url = new URL(value);
  const status = url.searchParams.get("oauth");
  if (status !== "connected" && status !== "denied" && status !== "failed") {
    return undefined;
  }
  const message = status === "connected"
    ? { tone: "success" as const, text: "The Google connection flow completed. Check the latest connection snapshot below to verify access." }
    : status === "denied"
      ? { tone: "warning" as const, text: "Google connection was not completed. No new access was granted." }
      : { tone: "error" as const, text: "Google could not be connected. Try again, then check OAuth configuration if it keeps failing." };
  url.searchParams.delete("oauth");
  url.searchParams.delete("provider");
  return { message, cleanUrl: url.toString() };
}
