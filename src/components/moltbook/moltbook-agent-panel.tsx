"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import styles from "@/components/moltbook/moltbook-agent-panel.module.css";
import {
  MOLTBOOK_DISCLOSURE_VERSION,
  type MoltbookActivityProjection,
  type MoltbookConnectionProjection,
} from "@/lib/moltbook/contracts";
type ConnectionState =
  | "not_registered"
  | "unavailable"
  | MoltbookConnectionProjection["status"];

type MoltbookProjection = {
  connection?: MoltbookConnectionProjection | null;
  activities?: MoltbookActivityProjection[];
  nextCursor?: string | null;
};

type MoltbookMutationResponse = {
  connection: MoltbookConnectionProjection;
  claim?: { url: string; verificationCode: string };
};

type Action = "refresh" | "pause" | "resume";

export function MoltbookAgentPanel({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) {
  const [projection, setProjection] = useState<MoltbookProjection>({});
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [busyAction, setBusyAction] = useState<Action | "register">();
  const [error, setError] = useState<string>();
  const [externalName, setExternalName] = useState("AsaelEnvoy");
  const [description, setDescription] = useState(
    "An Asael agent learning with the agent community about useful, safe, and governed AI work.",
  );
  const [disclosureAccepted, setDisclosureAccepted] = useState(false);
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const endpoint = useMemo(
    () => `/api/agents/${encodeURIComponent(agentId)}/moltbook`,
    [agentId],
  );

  const load = useCallback(async (cursor?: string, append = false) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const suffix = cursor
        ? `?cursor=${encodeURIComponent(cursor)}&limit=20`
        : "?limit=20";
      const next = await requestJson<MoltbookProjection>(`${endpoint}${suffix}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setProjection((current) => ({
        ...next,
        activities: append
          ? [...(current.activities || []), ...(next.activities || [])]
          : next.activities || [],
      }));
      setError(undefined);
      setPhase("ready");
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(errorMessage(cause));
      setPhase("error");
    }
  }, [endpoint]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      controllerRef.current?.abort();
    };
  }, [agentId, load]);

  const connection = projection.connection;
  const connectionState: ConnectionState = connection?.status ||
    (phase === "error" ? "unavailable" : "not_registered");
  const claimUrl = safeMoltbookUrl(connection?.claimUrl);
  const verificationCode = connection?.verificationCode;
  const registered = Boolean(connection);

  async function act(action: Action) {
    setBusyAction(action);
    setError(undefined);
    try {
      const next = await requestJson<MoltbookMutationResponse>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      setProjection((current) => ({ ...current, connection: next.connection }));
      setPhase("ready");
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function register() {
    if (!disclosureAccepted) return;
    const action = "register";
    setBusyAction(action);
    setError(undefined);
    try {
      const next = await requestJson<MoltbookMutationResponse>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          externalName: externalName.trim(),
          description: description.trim(),
          heartbeatEnabled: true,
          disclosureAccepted: true,
          disclosureVersion: MOLTBOOK_DISCLOSURE_VERSION,
        }),
      });
      setProjection((current) => ({
        ...current,
        connection: {
          ...next.connection,
          claimUrl: next.connection.claimUrl || next.claim?.url,
          verificationCode:
            next.connection.verificationCode || next.claim?.verificationCode,
        },
      }));
      setPhase("ready");
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby={`moltbook-${agentId}`}>
      <div className={styles.heading}>
        <div className={styles.mark} aria-hidden="true">
          <Radio size={17} />
        </div>
        <div>
          <p>External community</p>
          <h3 id={`moltbook-${agentId}`}>Moltbook field console</h3>
        </div>
        <ConnectionBadge state={connectionState} loading={phase === "loading"} />
      </div>

      {phase === "loading" ? (
        <div className={styles.loading} role="status">
          <Loader2 size={16} className={styles.spin} />
          Reading the private activity ledger…
        </div>
      ) : phase === "error" && !registered ? (
        <div className={styles.join} role="status">
          <p>
            The private Moltbook connection ledger is unavailable. Its join state
            cannot be verified, so no registration action is available yet.
          </p>
          <button type="button" onClick={() => void load()}>
            <RefreshCw size={14} /> Retry connection
          </button>
        </div>
      ) : !registered ? (
        <div className={styles.join}>
          <p>
            Give {agentName} one public identity on Moltbook. It receives only
            Moltbook tools—never your mail, files, memory, browser, or Mac.
          </p>
          <label>
            <span>Public agent name</span>
            <input
              value={externalName}
              onChange={(event) => setExternalName(event.target.value)}
              minLength={3}
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            <span>Public bio</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              minLength={10}
              maxLength={500}
              rows={3}
            />
          </label>
          <label className={styles.disclosure}>
            <input
              type="checkbox"
              checked={disclosureAccepted}
              onChange={(event) => setDisclosureAccepted(event.target.checked)}
            />
            <span>
              I understand Moltbook activity is public, its terms apply to posted
              content, and I remain responsible for this agent’s actions.
            </span>
          </label>
          <button
            type="button"
            className={styles.primary}
            disabled={
              busyAction === "register" ||
              !disclosureAccepted ||
              externalName.trim().length < 3 ||
              description.trim().length < 10
            }
            onClick={() => void register()}
          >
            {busyAction === "register" ? (
              <Loader2 size={15} className={styles.spin} />
            ) : (
              <ShieldCheck size={15} />
            )}
            Create public identity
          </button>
        </div>
      ) : (
        <>
          <div className={styles.identity}>
            <div>
              <span>Public identity</span>
              <strong>{connection?.externalName || externalName}</strong>
            </div>
            <div>
              <span>Connection health</span>
              <strong>{connection ? connectionHealthLabel(connection) : "Waiting"}</strong>
            </div>
            <div>
              <span>Next check</span>
              <strong>{formatRelativeDate(connection?.nextHeartbeatAt)}</strong>
            </div>
          </div>

          {connection?.status === "pending_claim" ? (
            <div className={styles.claim}>
              <div>
                <Clock3 size={17} aria-hidden="true" />
                <span>
                  <strong>Human claim required</strong>
                  Moltbook requires you to verify ownership before the agent can participate.
                </span>
              </div>
              {verificationCode ? (
                <p>
                  Verification code <code>{verificationCode}</code>
                </p>
              ) : null}
              {claimUrl ? (
                <a href={claimUrl} target="_blank" rel="noreferrer">
                  Complete claim <ExternalLink size={13} />
                </a>
              ) : null}
            </div>
          ) : null}

          {connection?.lastErrorCode ? (
            <div className={styles.warning}>
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{humanize(connection.lastErrorCode)}</span>
            </div>
          ) : null}

          {connection?.status === "error" ? (
            <div className={styles.warning}>
              <AlertTriangle size={15} aria-hidden="true" />
              <span>
                The provider outcome may have taken effect. Registration is held
                to prevent a duplicate public identity; inspect the Moltbook account
                and recover it with the provider before creating another Agent.
              </span>
            </div>
          ) : null}

          <div className={styles.controls} aria-label="Moltbook controls">
            <button
              type="button"
              onClick={() => void act("refresh")}
              disabled={Boolean(busyAction)}
            >
              {busyAction === "refresh" ? (
                <Loader2 size={14} className={styles.spin} />
              ) : (
                <RefreshCw size={14} />
              )}
              Check status
            </button>
            {connection?.status === "paused" ? (
              <button
                type="button"
                onClick={() => void act("resume")}
                disabled={Boolean(busyAction)}
              >
                {busyAction === "resume" ? (
                  <Loader2 size={14} className={styles.spin} />
                ) : (
                  <Play size={14} />
                )}
                Resume
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void act("pause")}
                disabled={Boolean(busyAction)}
              >
                {busyAction === "pause" ? (
                  <Loader2 size={14} className={styles.spin} />
                ) : (
                  <Pause size={14} />
                )}
                Pause
              </button>
            )}
          </div>

          <div className={styles.activityHeading}>
            <span><Activity size={14} /> Activity</span>
            <small>
              {connection?.rateLimit?.remaining == null
                ? "Observable actions only · no private reasoning"
                : `${connection.rateLimit.remaining} provider requests remain`}
            </small>
          </div>
          <ol className={styles.activities}>
            {(projection.activities || []).length ? (
              projection.activities!.map((item) => (
                <ActivityRow key={item.id} activity={item} />
              ))
            ) : (
              <li className={styles.empty}>No external activity yet.</li>
            )}
          </ol>
          {projection.nextCursor ? (
            <button
              type="button"
              className={styles.more}
              onClick={() => void load(projection.nextCursor || undefined, true)}
            >
              Load earlier activity
            </button>
          ) : null}
        </>
      )}

      {error ? (
        <p className={styles.error} role="alert">
          <AlertTriangle size={14} /> {error}
        </p>
      ) : null}
    </section>
  );
}

function ConnectionBadge({
  state,
  loading,
}: {
  state: ConnectionState;
  loading: boolean;
}) {
  const label = loading
    ? "Syncing"
    : ({
        not_registered: "Not joined",
        unavailable: "Unavailable",
        registering: "Joining",
        pending_claim: "Claim needed",
        claimed: "Live",
        paused: "Paused",
        error: "Needs attention",
        revoked: "Revoked",
      } satisfies Record<ConnectionState, string>)[state];
  return (
    <span className={styles.badge} data-state={state}>
      {loading ? <Loader2 size={11} className={styles.spin} /> : null}
      {label}
    </span>
  );
}

function ActivityRow({ activity }: { activity: MoltbookActivityProjection }) {
  const externalUrl = safeMoltbookUrl(activity.providerObject?.url);
  const successful = ["succeeded", "published"].includes(activity.status);
  const warning = ["uncertain", "pending_verification"].includes(activity.status);
  const tone = successful ? "success" : warning ? "warning" : "error";
  return (
    <li>
      <span className={styles.activityIcon} data-tone={tone}>
        {successful ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
      </span>
      <span>
        <strong>{activity.summary}</strong>
        <small>
          {humanize(activity.kind)} · {formatDate(activity.createdAt)}
        </small>
      </span>
      {externalUrl ? (
        <a href={externalUrl} target="_blank" rel="noreferrer" aria-label="Open this Moltbook activity">
          <ExternalLink size={13} />
        </a>
      ) : null}
    </li>
  );
}

function connectionHealthLabel(connection: MoltbookConnectionProjection) {
  if (connection.status === "paused" || connection.heartbeatEnabled === false) return "Paused";
  if (!connection.lastHeartbeatAt) return "Waiting";
  if ((connection.consecutiveFailures || 0) > 0) {
    return `${connection.consecutiveFailures} failed`;
  }
  return "Healthy";
}

export function safeMoltbookUrl(value?: string | null) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "www.moltbook.com" ||
      parsed.username ||
      parsed.password ||
      parsed.port
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function formatDate(value?: string | null) {
  if (!value) return "Just now";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatRelativeDate(value?: string | null) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Not scheduled";
  const minutes = Math.round((date.valueOf() - Date.now()) / 60_000);
  if (minutes <= 0) return "Due now";
  if (minutes < 60) return `In ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `In ${hours}h`;
  return formatDate(value);
}

function humanize(value: string) {
  return value.replaceAll(/[._-]+/g, " ").replace(/^./, (character) => character.toUpperCase());
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Moltbook is unavailable right now.";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "Moltbook request failed.");
  }
  return payload;
}
