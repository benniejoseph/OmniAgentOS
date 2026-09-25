"use client";

import {
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronDown,
  CircleUserRound,
  Cloud,
  HardDrive,
  Images,
  Loader2,
  Mail,
  RefreshCw,
  RotateCcw,
  Unplug,
} from "lucide-react";
import { clsx } from "clsx";
import { useMemo, useState } from "react";

import { googleWorkspaceCapabilitiesForScopes } from "@/lib/connectors/google-workspace-capabilities";

const INTEGRATION_STATUS_CHANGED_EVENT = "asael:integration-status-changed";
type GoogleConnectionPurpose = "personal" | "work";

type OAuthProvider = {
  id: string;
  label: string;
  scopes: string[];
  configured: boolean;
  authorizeUrl: string;
  accounts?: Array<{
    purpose: GoogleConnectionPurpose;
    label: string;
    email: string;
  }>;
};

type OAuthGrant = {
  id: string;
  provider: string;
  accountEmail?: string;
  connectionLabel: string;
  connectionPurpose: GoogleConnectionPurpose;
  scopes: string[];
  status: "active" | "revoked";
  syncStatus?: "idle" | "syncing" | "healthy" | "error";
  syncError?: string;
  lastSyncedAt?: string;
  syncedItems?: number;
  sourceCoverage?: Partial<Record<"mail" | "calendar" | "drive", {
    lastSuccessfulAt?: string;
  }>>;
  createdAt: string;
  updatedAt: string;
  manageable?: boolean;
};

type OAuthPayload = {
  providers?: OAuthProvider[];
  grants?: OAuthGrant[];
  requestReadContracts?: { oauthGrants?: "exact_v1" | "readable_v1" };
};

type PersonalConnectionsProps = {
  payload?: unknown;
  loading?: boolean;
  error?: string;
  disabledReason?: string;
  onRefresh: () => Promise<void>;
};

export function PersonalConnections({
  payload,
  loading,
  error,
  disabledReason,
  onRefresh,
}: PersonalConnectionsProps) {
  const oauth = asOAuthPayload(payload);
  const provider = oauth.providers?.find((item) => item.id === "google");
  const grants = (oauth.grants || []).filter(
    (item) => item.provider === "google" && item.status === "active",
  );
  const account = provider?.accounts?.[0] || (grants[0]
    ? {
        purpose: grants[0].connectionPurpose,
        label: grants[0].connectionLabel,
        email: grants[0].accountEmail || "",
      }
    : undefined);

  async function refreshIntegrationViews() {
    window.dispatchEvent(new Event(INTEGRATION_STATUS_CHANGED_EVENT));
    await onRefresh().catch(() => undefined);
  }

  return (
    <section
      className="relative mt-4 overflow-hidden rounded-xl border border-line bg-surface"
      aria-labelledby="personal-sources-title"
      aria-busy={loading}
    >
      <div className="absolute inset-y-0 left-0 w-1 bg-primary" aria-hidden="true" />
      <div className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-full border border-primary/25 bg-primary/10 text-primary">
              <Cloud size={20} aria-hidden="true" />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                Workspace connection
              </p>
              <h2 id="personal-sources-title" className="mt-1 text-xl font-semibold">
                Google Workspace
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                Connect only the Google identity that belongs to this signed-in Asael account.
                Its mail, calendar, files, and selected photos stay inside this workspace.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refreshIntegrationViews()}
            disabled={loading}
            className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-md border border-line bg-background px-3 text-sm font-semibold transition hover:bg-surface-raised disabled:opacity-60"
          >
            {loading ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
            Refresh connection
          </button>
        </div>

        {error ? (
          <p className="mt-4 rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5">
          {account ? (
            <GoogleAccountCard
              account={account}
              provider={provider}
              grant={grants.find((grant) =>
                grant.connectionPurpose === account.purpose &&
                (!account.email || grant.accountEmail === account.email))}
              ownershipReady={oauth.requestReadContracts?.oauthGrants === "readable_v1"}
              disabledReason={disabledReason}
              loading={loading}
              onChanged={refreshIntegrationViews}
            />
          ) : (
            <p className="rounded-lg border border-warning/35 bg-warning/10 px-4 py-3 text-sm text-foreground">
              This signed-in account could not be matched to its private workspace policy.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function GoogleAccountCard({
  account,
  provider,
  grant,
  ownershipReady,
  disabledReason,
  loading,
  onChanged,
}: {
  account: NonNullable<OAuthProvider["accounts"]>[number];
  provider?: OAuthProvider;
  grant?: OAuthGrant;
  ownershipReady: boolean;
  disabledReason?: string;
  loading?: boolean;
  onChanged: () => Promise<void>;
}) {
  const [action, setAction] = useState<"sync" | "disconnect">();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | undefined
  >();
  const connected = Boolean(grant);
  const busy = Boolean(action) || loading;
  const actionDisabledReason = loading
    ? "Refreshing connection ownership."
    : !ownershipReady
      ? "Connection ownership could not be verified. Refresh before changing this account."
      : grant && grant.manageable !== true
        ? "This retained account is visible for continuity, but only its stored owner can use or change it."
        : disabledReason;
  const permissions = useMemo(
    () => googlePermissionViews(grant?.scopes || provider?.scopes || []),
    [grant?.scopes, provider?.scopes],
  );
  const grantedPermissions = permissions.filter((permission) => permission.granted);
  const lastSuccessfulSyncAt = latestSuccessfulSyncAt(grant);
  const AccountIcon = account.label.toLowerCase().includes("work")
    ? BriefcaseBusiness
    : CircleUserRound;

  function blockUnavailableAction() {
    if (!actionDisabledReason) return false;
    setMessage({ tone: "error", text: actionDisabledReason });
    return true;
  }

  async function syncGoogle() {
    if (!grant || blockUnavailableAction()) return;
    setAction("sync");
    setMessage(undefined);
    try {
      const response = await fetch(
        `/api/oauth/google/sync?connectionId=${encodeURIComponent(grant.id)}`,
        { method: "POST", headers: { accept: "application/json" } },
      );
      const result = (await response.json().catch(() => ({}))) as {
        imported?: number;
        removed?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || "Google sync failed.");
      setMessage({
        tone: "success",
        text: `Sync complete · ${result.imported || 0} imported${result.removed ? ` · ${result.removed} removed` : ""}`,
      });
      await onChanged();
    } catch (syncError) {
      setMessage({
        tone: "error",
        text: syncError instanceof Error ? syncError.message : "Google sync failed.",
      });
      await onChanged();
    } finally {
      setAction(undefined);
    }
  }

  async function disconnectGoogle() {
    if (!grant || blockUnavailableAction()) return;
    setAction("disconnect");
    setMessage(undefined);
    try {
      const response = await fetch(
        `/api/oauth/google?connectionId=${encodeURIComponent(grant.id)}`,
        { method: "DELETE", headers: { accept: "application/json" } },
      );
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error || "Google could not be disconnected.");
      setConfirmDisconnect(false);
      setMessage({ tone: "success", text: `${account.label} Google disconnected.` });
      await onChanged();
    } catch (disconnectError) {
      setMessage({
        tone: "error",
        text: disconnectError instanceof Error
          ? disconnectError.message
          : "Google could not be disconnected.",
      });
    } finally {
      setAction(undefined);
    }
  }

  const authorizeUrl = googleAuthorizeUrl(
    provider?.authorizeUrl || "/api/oauth/google/authorize",
    account.purpose,
    grant?.id,
    Boolean(grant),
  );

  return (
    <article className="overflow-hidden rounded-lg border border-line bg-background">
      <div className="border-b border-line p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <AccountIcon size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{grant?.connectionLabel || account.label}</h3>
                <ConnectionStatus
                  connected={connected}
                  configured={provider?.configured}
                  syncStatus={grant?.syncStatus}
                  manageable={grant?.manageable}
                  loading={Boolean(loading && !provider)}
                />
              </div>
              <p className="mt-1 truncate text-sm text-muted">
                {grant?.accountEmail || account.email || "Private Google account"}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Mail, calendar, files, and selected photos remain isolated to this Asael account.
              </p>
            </div>
          </div>

          {!provider?.configured ? (
            <span className="inline-flex min-h-10 items-center rounded-md border border-warning/40 bg-warning/10 px-3 text-sm font-semibold text-warning">
              OAuth setup required
            </span>
          ) : connected ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void syncGoogle()}
                disabled={busy || Boolean(actionDisabledReason)}
                className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-ink disabled:opacity-60"
              >
                {action === "sync" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
                Sync
              </button>
              <a
                href={authorizeUrl}
                aria-disabled={Boolean(actionDisabledReason)}
                className={clsx(
                  "inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm font-semibold",
                  actionDisabledReason && "pointer-events-none opacity-60",
                )}
              >
                <RotateCcw size={14} aria-hidden="true" />
                Reconnect
              </a>
              <button
                type="button"
                onClick={() => setConfirmDisconnect((current) => !current)}
                disabled={busy || Boolean(actionDisabledReason)}
                className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm font-semibold text-muted transition hover:text-danger disabled:opacity-60"
                aria-expanded={confirmDisconnect}
              >
                <Unplug size={14} aria-hidden="true" />
                Disconnect
              </button>
            </div>
          ) : (
            <a
              href={authorizeUrl}
              aria-disabled={Boolean(actionDisabledReason)}
              className={clsx(
                "inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink",
                actionDisabledReason && "pointer-events-none opacity-60",
              )}
            >
                Connect Google
            </a>
          )}
        </div>

        {actionDisabledReason ? <p className="mt-3 text-xs leading-5 text-muted">{actionDisabledReason}</p> : null}
        {grant?.syncError ? (
          <p className="mt-3 rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
            Last sync failed: {grant.syncError}
          </p>
        ) : null}
        {message ? (
          <p
            role="status"
            className={clsx(
              "mt-3 rounded-md border px-3 py-2 text-sm",
              message.tone === "success"
                ? "border-primary/30 bg-primary/8 text-foreground"
                : "border-danger/35 bg-danger/10 text-danger",
            )}
          >
            {message.text}
          </p>
        ) : null}

        {confirmDisconnect && !actionDisabledReason ? (
          <div className="mt-3 rounded-md border border-danger/30 bg-danger/8 p-3">
            <p className="text-sm font-semibold">Disconnect {account.label} Google?</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Future syncs stop. Previously imported knowledge remains available.
            </p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => setConfirmDisconnect(false)} className="min-h-9 rounded-md border border-line px-3 text-sm font-semibold">
                Keep connected
              </button>
              <button type="button" onClick={() => void disconnectGoogle()} disabled={Boolean(action)} className="inline-flex min-h-9 items-center gap-2 rounded-md bg-danger px-3 text-sm font-semibold text-white disabled:opacity-60">
                {action === "disconnect" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null}
                Disconnect
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid gap-px bg-line sm:grid-cols-3">
        <ConnectionFact label="Connected" value={grant ? formatDate(grant.createdAt) : "Not yet"} />
        <ConnectionFact label="Last sync" value={lastSuccessfulSyncAt ? formatDate(lastSuccessfulSyncAt) : "Not synced"} />
        <ConnectionFact label="Knowledge" value={`${grant?.syncedItems || 0} items`} />
      </div>

      <details className="group border-t border-line px-4 py-3 sm:px-5">
        <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold marker:content-none">
          <span>
            What Asael can use
            <span className="ml-2 font-normal text-muted">
              {connected ? grantedPermissions.length : permissions.length} areas
            </span>
          </span>
          <ChevronDown size={16} className="text-muted transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="grid gap-3 pb-2 pt-3 sm:grid-cols-2">
          {permissions.map((permission) => {
            const PermissionIcon = permission.icon;
            return (
              <div key={permission.label} className="flex items-start gap-3">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                  <PermissionIcon size={15} aria-hidden="true" />
                </span>
                <div>
                  <p className="flex items-center gap-1.5 text-sm font-semibold">
                    {permission.label}
                    {connected && permission.granted ? <Check size={13} className="text-primary" aria-hidden="true" /> : null}
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-muted">{permission.detail}</p>
                </div>
              </div>
            );
          })}
        </div>
      </details>
    </article>
  );
}

function googleAuthorizeUrl(
  baseUrl: string,
  purpose: GoogleConnectionPurpose,
  connectionId?: string,
  repair = false,
) {
  const params = new URLSearchParams({ account: purpose });
  if (connectionId) params.set("connectionId", connectionId);
  if (repair) params.set("intent", "repair");
  return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${params.toString()}`;
}

function ConnectionStatus({
  connected,
  configured,
  syncStatus,
  manageable,
  loading,
}: {
  connected: boolean;
  configured?: boolean;
  syncStatus?: OAuthGrant["syncStatus"];
  manageable?: boolean;
  loading?: boolean;
}) {
  const label = loading
    ? "Checking"
    : !configured
      ? "Unavailable"
      : !connected
        ? "Not connected"
        : manageable !== true
          ? "Managed by owner"
          : syncStatus === "error"
            ? "Needs attention"
            : syncStatus === "syncing"
              ? "Syncing"
              : "Connected";
  const live = !loading && connected && manageable === true && syncStatus !== "error";
  return (
    <span className={clsx("inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold", live ? "border-primary/30 bg-primary/10 text-primary" : "border-line bg-surface text-muted")}>
      <span className={clsx("size-1.5 rounded-full", live ? "animate-pulse bg-primary motion-reduce:animate-none" : "bg-muted")} />
      {label}
    </span>
  );
}

function ConnectionFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background px-4 py-3 sm:px-5">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function asOAuthPayload(value: unknown): OAuthPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as OAuthPayload;
}

function latestSuccessfulSyncAt(grant?: OAuthGrant) {
  const candidates = [
    grant?.lastSyncedAt,
    ...Object.values(grant?.sourceCoverage || {}).map((checkpoint) => checkpoint?.lastSuccessfulAt),
  ].filter((value): value is string => Boolean(value));
  return candidates.reduce<string | undefined>((latest, candidate) => {
    const candidateTime = Date.parse(candidate);
    if (!Number.isFinite(candidateTime)) return latest;
    if (!latest || candidateTime > Date.parse(latest)) return candidate;
    return latest;
  }, undefined);
}

function googlePermissionViews(scopes: readonly string[]) {
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

  return [
    {
      label: "Gmail",
      detail: gmailModify && gmailTrash
        ? "Read, send, organize, and move messages to Trash."
        : gmailRead && gmailSend
          ? "Read and send messages."
          : gmailRead ? "Read messages only." : gmailSend ? "Send messages only." : "Not granted.",
      icon: Mail,
      granted: gmailRead || gmailSend,
    },
    {
      label: "Calendar",
      detail: calendarWrite ? "View and manage events." : calendarRead ? "View events only." : "Not granted.",
      icon: CalendarDays,
      granted: calendarRead,
    },
    {
      label: "Drive",
      detail: driveRead && driveWrite ? "View and change accessible files." : driveRead ? "View files only." : "Not granted.",
      icon: HardDrive,
      granted: driveRead,
    },
    {
      label: "Photos",
      detail: photosPicked ? "Import only photos you explicitly choose." : "Not granted.",
      icon: Images,
      granted: photosPicked,
    },
  ] as const;
}

function formatDate(value?: string) {
  if (!value) return "Unknown";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}
