"use client";

import {
  CalendarDays,
  Check,
  ChevronDown,
  Cloud,
  HardDrive,
  Loader2,
  Mail,
  RefreshCw,
  RotateCcw,
  Unplug,
} from "lucide-react";
import { useMemo, useState } from "react";
import { clsx } from "clsx";

type OAuthProvider = {
  id: string;
  label: string;
  scopes: string[];
  configured: boolean;
  authorizeUrl: string;
};

type OAuthGrant = {
  provider: string;
  scopes: string[];
  status: "active" | "revoked";
  syncStatus?: "idle" | "syncing" | "healthy" | "error";
  syncError?: string;
  lastSyncedAt?: string;
  syncedItems?: number;
  createdAt: string;
  updatedAt: string;
};

type OAuthPayload = {
  providers?: OAuthProvider[];
  grants?: OAuthGrant[];
};

type PersonalConnectionsProps = {
  payload?: unknown;
  loading?: boolean;
  error?: string;
  onRefresh: () => Promise<void>;
};

const permissions = [
  {
    suffix: "/auth/gmail.readonly",
    label: "Gmail",
    detail: "Messages and metadata, read-only",
    icon: Mail,
  },
  {
    suffix: "/auth/calendar.events.readonly",
    label: "Calendar",
    detail: "Events and schedules, read-only",
    icon: CalendarDays,
  },
  {
    suffix: "/auth/drive.readonly",
    label: "Drive",
    detail: "Files and document content, read-only",
    icon: HardDrive,
  },
] as const;

export function PersonalConnections({
  payload,
  loading,
  error,
  onRefresh,
}: PersonalConnectionsProps) {
  const oauth = asOAuthPayload(payload);
  const provider = oauth.providers?.find((item) => item.id === "google");
  const grant = oauth.grants?.find(
    (item) => item.provider === "google" && item.status === "active",
  );
  const connected = Boolean(grant);
  const [action, setAction] = useState<"sync" | "disconnect">();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | undefined
  >();
  const grantedPermissions = useMemo(
    () =>
      permissions.filter((permission) =>
        grant?.scopes.some((scope) => scope.endsWith(permission.suffix)),
      ),
    [grant?.scopes],
  );

  async function syncGoogle() {
    setAction("sync");
    setMessage(undefined);
    try {
      const response = await fetch("/api/oauth/google/sync", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const result = (await response.json().catch(() => ({}))) as {
        imported?: number;
        removed?: number;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(result.error || "Google sync failed.");
      }
      const imported = result.imported || 0;
      const removed = result.removed || 0;
      setMessage({
        tone: "success",
        text: `Sync complete · ${imported} imported${removed ? ` · ${removed} removed` : ""}`,
      });
      await onRefresh();
    } catch (syncError) {
      setMessage({
        tone: "error",
        text: syncError instanceof Error ? syncError.message : "Google sync failed.",
      });
      await onRefresh();
    } finally {
      setAction(undefined);
    }
  }

  async function disconnectGoogle() {
    setAction("disconnect");
    setMessage(undefined);
    try {
      const response = await fetch("/api/oauth/google", {
        method: "DELETE",
        headers: { accept: "application/json" },
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(result.error || "Google could not be disconnected.");
      }
      setConfirmDisconnect(false);
      setMessage({ tone: "success", text: "Google disconnected from Asael." });
      await onRefresh();
    } catch (disconnectError) {
      setMessage({
        tone: "error",
        text:
          disconnectError instanceof Error
            ? disconnectError.message
            : "Google could not be disconnected.",
      });
    } finally {
      setAction(undefined);
    }
  }

  const busy = Boolean(action) || loading;

  return (
    <section
      className="relative mt-4 overflow-hidden rounded-lg border border-line bg-surface"
      aria-labelledby="personal-sources-title"
      aria-busy={busy}
    >
      <div className="absolute inset-y-0 left-0 w-1 bg-primary" aria-hidden="true" />
      <div className="p-5 sm:p-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Personal sources
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span className="grid size-10 place-items-center rounded-full border border-line bg-background text-foreground">
                <Cloud size={18} aria-hidden="true" />
              </span>
              <div>
                <h2 id="personal-sources-title" className="text-lg font-semibold">
                  Google workspace
                </h2>
                <p className="mt-0.5 text-sm text-muted">
                  Gmail, Calendar and Drive become searchable context for Asael.
                </p>
              </div>
              <ConnectionStatus
                connected={connected}
                configured={provider?.configured}
                syncStatus={grant?.syncStatus}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            {connected ? (
              <>
                <button
                  type="button"
                  onClick={() => void syncGoogle()}
                  disabled={busy}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {action === "sync" ? (
                    <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw size={15} aria-hidden="true" />
                  )}
                  {action === "sync" ? "Syncing…" : "Sync now"}
                </button>
                <a
                  href={provider?.authorizeUrl || "/api/oauth/google/authorize"}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line bg-background px-3 text-sm font-semibold transition hover:bg-surface-raised"
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  Reconnect
                </a>
                <button
                  type="button"
                  onClick={() => setConfirmDisconnect((current) => !current)}
                  disabled={busy}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line bg-background px-3 text-sm font-semibold text-muted transition hover:border-danger/40 hover:text-danger disabled:opacity-60"
                  aria-expanded={confirmDisconnect}
                >
                  <Unplug size={15} aria-hidden="true" />
                  Disconnect
                </button>
              </>
            ) : provider?.configured ? (
              <a
                href={provider.authorizeUrl}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105"
              >
                Connect Google
              </a>
            ) : (
              <span className="inline-flex min-h-11 items-center rounded-md border border-warning/40 bg-warning/10 px-3 text-sm font-semibold text-warning">
                OAuth setup required
              </span>
            )}
          </div>
        </div>

        {error ? (
          <p className="mt-4 rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {message ? (
          <p
            className={clsx(
              "mt-4 rounded-md border px-3 py-2 text-sm",
              message.tone === "success"
                ? "border-primary/30 bg-primary/8 text-foreground"
                : "border-danger/35 bg-danger/10 text-danger",
            )}
            role="status"
          >
            {message.text}
          </p>
        ) : null}
        {grant?.syncError ? (
          <p className="mt-4 rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
            Last sync failed: {grant.syncError}
          </p>
        ) : null}

        {confirmDisconnect ? (
          <div className="mt-4 flex flex-col gap-3 rounded-md border border-danger/30 bg-danger/8 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Disconnect Google?</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Future syncs stop. Previously imported knowledge remains until you remove it.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmDisconnect(false)}
                disabled={Boolean(action)}
                className="min-h-10 rounded-md border border-line bg-background px-3 text-sm font-semibold"
              >
                Keep connected
              </button>
              <button
                type="button"
                onClick={() => void disconnectGoogle()}
                disabled={Boolean(action)}
                className="inline-flex min-h-10 items-center gap-2 rounded-md bg-danger px-3 text-sm font-semibold text-white disabled:opacity-60"
              >
                {action === "disconnect" ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : null}
                Disconnect
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-5 grid gap-px overflow-hidden rounded-md border border-line bg-line md:grid-cols-3">
          <ConnectionFact
            label="Connection"
            value={connected ? `Added ${formatDate(grant?.createdAt)}` : "Not connected"}
          />
          <ConnectionFact
            label="Last sync"
            value={grant?.lastSyncedAt ? formatDate(grant.lastSyncedAt) : "Not synced yet"}
          />
          <ConnectionFact
            label="Imported"
            value={`${grant?.syncedItems || 0} items`}
          />
        </div>

        <details className="group mt-4 border-t border-line pt-4">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold marker:content-none">
            <span>
              Permissions
              <span className="ml-2 font-normal text-muted">
                {grantedPermissions.length || permissions.length} read-only sources
              </span>
            </span>
            <ChevronDown
              size={16}
              className="text-muted transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="grid gap-3 pb-1 pt-3 md:grid-cols-3">
            {(connected ? grantedPermissions : permissions).map((permission) => {
              const PermissionIcon = permission.icon;
              return (
                <div key={permission.label} className="flex items-start gap-3">
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                    <PermissionIcon size={15} aria-hidden="true" />
                  </span>
                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                      {permission.label}
                      {connected ? <Check size={13} className="text-primary" aria-hidden="true" /> : null}
                    </p>
                    <p className="mt-0.5 text-xs leading-5 text-muted">{permission.detail}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      </div>
    </section>
  );
}

function ConnectionStatus({
  connected,
  configured,
  syncStatus,
}: {
  connected: boolean;
  configured?: boolean;
  syncStatus?: OAuthGrant["syncStatus"];
}) {
  const label = !configured
    ? "Unavailable"
    : !connected
      ? "Not connected"
      : syncStatus === "error"
        ? "Needs attention"
        : syncStatus === "syncing"
          ? "Syncing"
          : "Connected";
  const live = connected && syncStatus !== "error";
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold",
        live
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-line bg-background text-muted",
      )}
    >
      <span
        className={clsx(
          "size-1.5 rounded-full",
          live ? "animate-pulse bg-primary motion-reduce:animate-none" : "bg-muted",
        )}
      />
      {label}
    </span>
  );
}

function ConnectionFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function asOAuthPayload(value: unknown): OAuthPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as OAuthPayload;
}

function formatDate(value?: string) {
  if (!value) return "Unknown";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}
