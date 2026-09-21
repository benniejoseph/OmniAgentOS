"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Gauge,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  TimerReset,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import styles from "@/components/moltbook/moltbook-agent-panel.module.css";
import {
  MOLTBOOK_AUTONOMY_DISCLOSURE_VERSION,
  MOLTBOOK_DISCLOSURE_VERSION,
  type MoltbookActivityProjection,
  type MoltbookConnectionProjection,
} from "@/lib/moltbook/contracts";

type ConnectionState =
  "not_registered" | "unavailable" | MoltbookConnectionProjection["status"];

type MoltbookProjection = {
  connection?: MoltbookConnectionProjection | null;
  activities?: MoltbookActivityProjection[];
  autonomy?: unknown;
  nextCursor?: string | null;
};

type MoltbookMutationResponse = {
  connection?: MoltbookConnectionProjection;
  autonomy?: unknown;
  claim?: { url: string; verificationCode: string };
};

type Action =
  | "refresh"
  | "pause"
  | "resume"
  | "enable_autonomy"
  | "pause_autonomy"
  | "resume_autonomy"
  | "revoke_autonomy"
  | "run_autonomy_once";

type AutonomyStatus = "enabled" | "paused" | "revoked" | "running";
type AutonomyBlockedReason =
  | "connection_unavailable"
  | "authority_unavailable";
type BudgetKey = "post" | "comment" | "vote" | "follow" | "subscribe";

export type MoltbookAutonomyView = Readonly<{
  status: AutonomyStatus;
  executable: boolean;
  blockedReason?: AutonomyBlockedReason;
  cadenceMs: number;
  lastCycleAt?: string;
  nextCycleAt?: string;
  lastRunId?: string;
  budgetResetAt?: string;
  budgets: readonly Readonly<{
    key: BudgetKey;
    label: string;
    used: number;
    limit: number;
  }>[];
  interests: readonly Readonly<{
    topic: string;
    score: number;
    confidence: number;
    evidenceCount: number;
  }>[];
  cycles: readonly Readonly<{
    id: string;
    status: string;
    trigger?: string;
    createdAt?: string;
    completedAt?: string;
    runId?: string;
  }>[];
}>;

const BUDGETS: ReadonlyArray<{
  key: BudgetKey;
  label: string;
  aliases: readonly string[];
}> = [
  { key: "post", label: "Posts", aliases: ["post", "posts"] },
  {
    key: "comment",
    label: "Replies",
    aliases: ["comment", "comments", "reply", "replies"],
  },
  { key: "vote", label: "Votes", aliases: ["vote", "votes"] },
  { key: "follow", label: "Follows", aliases: ["follow", "follows"] },
  {
    key: "subscribe",
    label: "Community joins",
    aliases: [
      "subscribe",
      "subscribes",
      "subscription",
      "subscriptions",
      "communityJoin",
      "communityJoins",
    ],
  },
] as const;

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
  const [autonomyDisclosureAccepted, setAutonomyDisclosureAccepted] =
    useState(false);
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const endpoint = useMemo(
    () => `/api/agents/${encodeURIComponent(agentId)}/moltbook`,
    [agentId],
  );

  const load = useCallback(
    async (cursor?: string, append = false) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const suffix = cursor
          ? `?cursor=${encodeURIComponent(cursor)}&limit=20`
          : "?limit=20";
        const next = await requestJson<MoltbookProjection>(
          `${endpoint}${suffix}`,
          { signal: controller.signal },
        );
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
    },
    [endpoint],
  );

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
  const connectionState: ConnectionState =
    connection?.status ||
    (phase === "error" ? "unavailable" : "not_registered");
  const claimUrl = safeMoltbookUrl(connection?.claimUrl);
  const verificationCode = connection?.verificationCode;
  const registered = Boolean(connection);
  const autonomy = normalizeMoltbookAutonomy(projection.autonomy);
  const autonomyConnectionReady =
    connection?.status === "claimed" &&
    connection.claimState === "claimed" &&
    connection.credentialConfigured === true;

  async function act(action: Action) {
    setBusyAction(action);
    setError(undefined);
    try {
      const body =
        action === "enable_autonomy"
          ? {
              action,
              disclosureAccepted: true,
              disclosureVersion: MOLTBOOK_AUTONOMY_DISCLOSURE_VERSION,
            }
          : { action };
      const next = await requestJson<MoltbookMutationResponse>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setProjection((current) => ({
        ...current,
        ...(next.connection ? { connection: next.connection } : {}),
        ...(next.autonomy !== undefined ? { autonomy: next.autonomy } : {}),
      }));
      if (action === "enable_autonomy") setAutonomyDisclosureAccepted(false);
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
      if (!next.connection) {
        throw new Error("Moltbook returned no connection state.");
      }
      const connection = next.connection;
      setProjection((current) => ({
        ...current,
        connection: {
          ...connection,
          claimUrl: connection.claimUrl || next.claim?.url,
          verificationCode:
            connection.verificationCode || next.claim?.verificationCode,
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
          <Radio size={19} />
        </div>
        <div>
          <p>Public agent operations</p>
          <h3 id={`moltbook-${agentId}`}>Moltbook field console</h3>
        </div>
        <ConnectionBadge
          state={connectionState}
          loading={phase === "loading"}
        />
      </div>

      {phase === "loading" ? (
        <div className={styles.loading} role="status">
          <Loader2 size={17} className={styles.spin} />
          Reading the private activity ledger…
        </div>
      ) : phase === "error" && !registered ? (
        <div className={styles.join} role="status">
          <p>
            The private Moltbook connection ledger is unavailable. Its join
            state cannot be verified, so no registration action is available
            yet.
          </p>
          <button type="button" onClick={() => void load()}>
            <RefreshCw size={15} /> Retry connection
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
              I understand Moltbook activity is public, its terms apply to
              posted content, and I remain responsible for this agent’s actions.
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
              <Loader2 size={16} className={styles.spin} />
            ) : (
              <ShieldCheck size={16} />
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
              <strong>
                {connection ? connectionHealthLabel(connection) : "Waiting"}
              </strong>
            </div>
            <div>
              <span>Connection check</span>
              <strong>{formatRelativeDate(connection?.nextHeartbeatAt)}</strong>
            </div>
          </div>

          {connection?.status === "pending_claim" ? (
            <div className={styles.claim}>
              <div>
                <Clock3 size={18} aria-hidden="true" />
                <span>
                  <strong>Human claim required</strong>
                  Moltbook requires you to verify ownership before the agent can
                  participate.
                </span>
              </div>
              {verificationCode ? (
                <p>
                  Verification code <code>{verificationCode}</code>
                </p>
              ) : null}
              {claimUrl ? (
                <a href={claimUrl} target="_blank" rel="noreferrer">
                  Complete claim <ExternalLink size={14} />
                </a>
              ) : null}
            </div>
          ) : null}

          {connection?.lastErrorCode ? (
            <div className={styles.warning}>
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{humanize(connection.lastErrorCode)}</span>
            </div>
          ) : null}

          {connection?.status === "error" ? (
            <div className={styles.warning}>
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                The provider outcome may have taken effect. Registration is held
                to prevent a duplicate public identity; inspect the Moltbook
                account and recover it with the provider before creating another
                Agent.
              </span>
            </div>
          ) : null}

          {connection?.status === "claimed" ||
          connection?.status === "paused" ? (
            <AutonomyConsole
              autonomy={autonomy}
              connectionReady={autonomyConnectionReady}
              accepted={autonomyDisclosureAccepted}
              onAccepted={setAutonomyDisclosureAccepted}
              busyAction={busyAction}
              onAction={(action) => void act(action)}
            />
          ) : null}

          <div
            className={styles.connectionControls}
            aria-label="Moltbook connection controls"
          >
            <button
              type="button"
              onClick={() => void act("refresh")}
              disabled={Boolean(busyAction)}
            >
              {busyAction === "refresh" ? (
                <Loader2 size={15} className={styles.spin} />
              ) : (
                <RefreshCw size={15} />
              )}
              Check connection
            </button>
            {connection?.status === "paused" ? (
              <button
                type="button"
                onClick={() => void act("resume")}
                disabled={Boolean(busyAction)}
              >
                {busyAction === "resume" ? (
                  <Loader2 size={15} className={styles.spin} />
                ) : (
                  <Play size={15} />
                )}
                Resume connection
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void act("pause")}
                disabled={Boolean(busyAction)}
              >
                {busyAction === "pause" ? (
                  <Loader2 size={15} className={styles.spin} />
                ) : (
                  <Pause size={15} />
                )}
                Pause connection
              </button>
            )}
          </div>

          <div className={styles.activityHeading}>
            <span>
              <Activity size={16} /> Activity receipts
            </span>
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
              onClick={() =>
                void load(projection.nextCursor || undefined, true)
              }
            >
              Load earlier activity
            </button>
          ) : null}
        </>
      )}

      {error ? (
        <p className={styles.error} role="alert">
          <AlertTriangle size={15} /> {error}
        </p>
      ) : null}
    </section>
  );
}

function AutonomyConsole({
  autonomy,
  connectionReady,
  accepted,
  onAccepted,
  busyAction,
  onAction,
}: {
  autonomy: MoltbookAutonomyView | null;
  connectionReady: boolean;
  accepted: boolean;
  onAccepted: (accepted: boolean) => void;
  busyAction?: Action | "register";
  onAction: (action: Action) => void;
}) {
  const canEnable = !autonomy || autonomy.status === "revoked";
  const status = autonomy?.status || "not_enabled";
  const displayStatus = autonomy &&
    !autonomy.executable &&
    (autonomy.status === "enabled" || autonomy.status === "running")
    ? "blocked"
    : status;
  const effectiveBlockedReason: AutonomyBlockedReason | undefined =
    !connectionReady
      ? "connection_unavailable"
      : !canEnable && autonomy && !autonomy.executable
        ? autonomy.blockedReason || "authority_unavailable"
        : undefined;
  const blockedMessage = effectiveBlockedReason
    ? autonomyBlockedMessage(effectiveBlockedReason)
    : undefined;
  return (
    <section
      className={styles.autonomy}
      aria-labelledby="moltbook-autonomy-heading"
    >
      <div className={styles.autonomyHeading}>
        <div>
          <p>Independent public engagement</p>
          <h4 id="moltbook-autonomy-heading">
            {displayStatus === "blocked"
              ? "Autonomy is blocked"
              : status === "enabled" || status === "running"
              ? "Autonomy is active"
              : status === "paused"
                ? "Autonomy is paused"
                : "Autonomy is off"}
          </h4>
        </div>
        <span className={styles.autonomyState} data-state={displayStatus}>
          <span aria-hidden="true" /> {humanize(displayStatus)}
        </span>
      </div>

      <p className={styles.scopeDisclosure}>
        This public Agent can independently read and take at most one public
        action per check-in—post, reply, vote, follow, or join a community—within
        strict daily budgets. DMs, verification, deletion, moderation, private
        Asael memory or files, and control of this Mac remain excluded.
      </p>

      {blockedMessage ? (
        <div className={styles.autonomyBlocked} role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            <strong>Public actions are held.</strong> {blockedMessage}
          </span>
        </div>
      ) : null}

      {canEnable ? (
        <div className={styles.enableArea}>
          <label className={styles.autonomyDisclosure}>
            <input
              type="checkbox"
              checked={accepted}
              disabled={!connectionReady}
              onChange={(event) => onAccepted(event.target.checked)}
            />
            <span>
              I authorize this Agent to take those public actions without asking
              me each time. I can pause or revoke this authority here at any
              time.
            </span>
          </label>
          <button
            type="button"
            className={styles.enableButton}
            disabled={!accepted || Boolean(busyAction) || !connectionReady}
            onClick={() => onAction("enable_autonomy")}
          >
            {busyAction === "enable_autonomy" ? (
              <Loader2 size={16} className={styles.spin} />
            ) : (
              <ShieldCheck size={16} />
            )}
            {autonomy?.status === "revoked"
              ? "Grant new authority"
              : "Enable autonomy"}
          </button>
        </div>
      ) : (
        <>
          <div
            className={styles.autonomyControls}
            aria-label="Autonomous engagement controls"
          >
            {autonomy.status === "paused" ? (
              <button
                type="button"
                className={styles.resumeButton}
                disabled={Boolean(busyAction) || !autonomy.executable}
                onClick={() => onAction("resume_autonomy")}
              >
                {busyAction === "resume_autonomy" ? (
                  <Loader2 size={16} className={styles.spin} />
                ) : (
                  <Play size={16} />
                )}
                Resume autonomy
              </button>
            ) : (
              <button
                type="button"
                className={styles.pauseButton}
                disabled={Boolean(busyAction)}
                onClick={() => onAction("pause_autonomy")}
              >
                {busyAction === "pause_autonomy" ? (
                  <Loader2 size={16} className={styles.spin} />
                ) : (
                  <Pause size={16} />
                )}
                Pause now
              </button>
            )}
            <button
              type="button"
              disabled={
                Boolean(busyAction) ||
                autonomy.status !== "enabled" ||
                !autonomy.executable
              }
              onClick={() => onAction("run_autonomy_once")}
            >
              {busyAction === "run_autonomy_once" ? (
                <Loader2 size={16} className={styles.spin} />
              ) : (
                <Sparkles size={16} />
              )}
              Run once
            </button>
            <button
              type="button"
              className={styles.revokeButton}
              disabled={Boolean(busyAction)}
              onClick={() => onAction("revoke_autonomy")}
            >
              {busyAction === "revoke_autonomy" ? (
                <Loader2 size={16} className={styles.spin} />
              ) : (
                <ShieldOff size={16} />
              )}
              Revoke authority
            </button>
          </div>

          <div className={styles.cycleStrip}>
            <div>
              <TimerReset size={17} aria-hidden="true" />
              <span>
                <small>Cadence</small>
                <strong>{formatCadence(autonomy.cadenceMs)}</strong>
              </span>
            </div>
            <div>
              <Clock3 size={17} aria-hidden="true" />
              <span>
                <small>Last cycle</small>
                <strong>{formatDateOrNever(autonomy.lastCycleAt)}</strong>
              </span>
            </div>
            <div>
              <Play size={17} aria-hidden="true" />
              <span>
                <small>Next cycle</small>
                <strong>{formatRelativeDate(autonomy.nextCycleAt)}</strong>
              </span>
            </div>
            <div>
              <Activity size={17} aria-hidden="true" />
              <span>
                <small>Last run</small>
                <strong title={autonomy.lastRunId}>
                  {shortId(autonomy.lastRunId)}
                </strong>
              </span>
            </div>
          </div>

          <div className={styles.autonomyGrid}>
            <section
              className={styles.budgets}
              aria-labelledby="moltbook-budget-heading"
            >
              <div className={styles.sectionTitle}>
                <span>
                  <Gauge size={16} /> Daily action budget
                </span>
                <small
                  title={
                    autonomy.budgetResetAt
                      ? formatDate(autonomy.budgetResetAt)
                      : undefined
                  }
                >
                  {autonomy.budgetResetAt
                    ? `Next release ${formatRelativeDate(autonomy.budgetResetAt)}`
                    : "Rolling 24h"}
                </small>
              </div>
              <div id="moltbook-budget-heading" className={styles.srOnly}>
                Daily action budget
              </div>
              {autonomy.budgets.map((budget) => (
                <BudgetRow key={budget.key} budget={budget} />
              ))}
            </section>

            <section
              className={styles.interests}
              aria-labelledby="moltbook-interest-heading"
            >
              <div className={styles.sectionTitle}>
                <span>
                  <Sparkles size={16} /> Developing interests
                </span>
                <small>Evidence-backed</small>
              </div>
              <div id="moltbook-interest-heading" className={styles.srOnly}>
                Developing interests
              </div>
              {autonomy.interests.length ? (
                autonomy.interests.map((interest) => (
                  <div className={styles.interestRow} key={interest.topic}>
                    <div>
                      <strong>{interest.topic}</strong>
                      <small>
                        {interest.evidenceCount} evidence signal
                        {interest.evidenceCount === 1 ? "" : "s"}
                      </small>
                    </div>
                    <span
                      title={`${Math.round(interest.confidence * 100)}% confidence`}
                    >
                      {Math.round(interest.score * 100)}
                    </span>
                  </div>
                ))
              ) : (
                <p className={styles.emptyState}>
                  Interests appear after the Agent completes an evidence-backed
                  reading cycle.
                </p>
              )}
            </section>
          </div>

          {autonomy.cycles.length ? (
            <section
              className={styles.cycleReceipts}
              aria-labelledby="moltbook-cycle-heading"
            >
              <div className={styles.sectionTitle}>
                <span>
                  <Activity size={16} /> Recent cycle receipts
                </span>
                <small>No private reasoning</small>
              </div>
              <div id="moltbook-cycle-heading" className={styles.srOnly}>
                Recent cycle receipts
              </div>
              <ol>
                {autonomy.cycles.map((cycle) => (
                  <li key={cycle.id}>
                    <span
                      className={styles.cycleStatus}
                      data-status={cycle.status}
                      aria-hidden="true"
                    />
                    <span>
                      <strong>{humanize(cycle.status)}</strong>
                      <small>
                        {humanize(cycle.trigger || "scheduled")} ·{" "}
                        {formatDate(cycle.completedAt || cycle.createdAt)}
                      </small>
                    </span>
                    <code title={cycle.runId || cycle.id}>
                      {shortId(cycle.runId || cycle.id)}
                    </code>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}

function BudgetRow({
  budget,
}: {
  budget: MoltbookAutonomyView["budgets"][number];
}) {
  const remaining = Math.max(0, budget.limit - budget.used);
  const percent =
    budget.limit > 0
      ? Math.min(100, Math.round((budget.used / budget.limit) * 100))
      : 0;
  return (
    <div className={styles.budgetRow}>
      <div>
        <strong>{budget.label}</strong>
        <small>{remaining} remaining</small>
      </div>
      <div
        className={styles.budgetTrack}
        role="progressbar"
        aria-label={`${budget.label} used`}
        aria-valuemin={0}
        aria-valuemax={budget.limit}
        aria-valuenow={Math.min(budget.used, budget.limit)}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <span>
        {budget.used} / {budget.limit}
      </span>
    </div>
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
    : (
        {
          not_registered: "Not joined",
          unavailable: "Unavailable",
          registering: "Joining",
          pending_claim: "Claim needed",
          claimed: "Connected",
          paused: "Paused",
          error: "Needs attention",
          revoked: "Revoked",
        } satisfies Record<ConnectionState, string>
      )[state];
  return (
    <span className={styles.badge} data-state={state}>
      {loading ? <Loader2 size={12} className={styles.spin} /> : null}
      {label}
    </span>
  );
}

function ActivityRow({ activity }: { activity: MoltbookActivityProjection }) {
  const externalUrl = safeMoltbookUrl(activity.providerObject?.url);
  const successful = ["succeeded", "published"].includes(activity.status);
  const warning = ["uncertain", "pending_verification"].includes(
    activity.status,
  );
  const tone = successful ? "success" : warning ? "warning" : "error";
  return (
    <li>
      <span className={styles.activityIcon} data-tone={tone}>
        {successful ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      </span>
      <span>
        <strong>{activity.summary}</strong>
        <small>
          {humanize(activity.kind)} · {formatDate(activity.createdAt)}
        </small>
      </span>
      {externalUrl ? (
        <a
          href={externalUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Open this Moltbook activity"
        >
          <ExternalLink size={14} />
        </a>
      ) : null}
    </li>
  );
}

function connectionHealthLabel(connection: MoltbookConnectionProjection) {
  if (connection.status === "paused" || connection.heartbeatEnabled === false) {
    return "Paused";
  }
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

export function normalizeMoltbookAutonomy(
  value: unknown,
): MoltbookAutonomyView | null {
  if (!isRecord(value)) return null;
  const enrollment = isRecord(value.enrollment) ? value.enrollment : value;
  const enrollmentBudgets = isRecord(enrollment.budgets)
    ? enrollment.budgets
    : undefined;
  const rawStatus = readString(value.status, enrollment.status)?.toLowerCase();
  const status: AutonomyStatus | undefined =
    rawStatus === "active"
      ? "enabled"
      : rawStatus === "enabled" ||
          rawStatus === "paused" ||
          rawStatus === "revoked" ||
          rawStatus === "running"
        ? rawStatus
        : undefined;
  if (!status) return null;

  const cadenceMs =
    readFiniteNumber(value.cadenceMs, enrollment.cadenceMs) ??
    (readFiniteNumber(
      value.cycleIntervalSeconds,
      enrollment.cycleIntervalSeconds,
      enrollmentBudgets?.cycleIntervalSeconds,
    ) ?? 14_400) * 1_000;
  const budgetsSource = firstRecord(
    isRecord(value.budgets) && isRecord(value.budgets.daily)
      ? value.budgets.daily
      : undefined,
    value.dailyBudgets,
    value.budgets,
    value.budget,
  );
  const usageSource = firstRecord(
    value.dailyUsage,
    value.usage,
    value.budgetUsage,
  );
  const limitsSource = firstRecord(
    value.dailyLimits,
    value.limits,
    enrollment.dailyLimits,
    enrollmentBudgets?.daily,
  );
  const budgets = BUDGETS.map(({ key, label, aliases }) => {
    const item = aliases.map((alias) => budgetsSource?.[alias]).find(isRecord);
    const flatLimit = aliases.flatMap((alias) => [
      value[`daily${capitalize(alias)}Limit`],
      enrollment[`daily${capitalize(alias)}Limit`],
      value[`daily_${camelToSnake(alias)}_limit`],
      enrollment[`daily_${camelToSnake(alias)}_limit`],
    ]);
    const flatUsed = aliases.flatMap((alias) => [
      value[`daily${capitalize(alias)}Used`],
      value[`daily_${camelToSnake(alias)}_used`],
    ]);
    const limit = nonNegativeInteger(
      readFiniteNumber(
        item?.limit,
        item?.total,
        ...aliases.map((alias) => limitsSource?.[alias]),
        ...flatLimit,
      ) ?? 0,
    );
    const explicitUsed = readFiniteNumber(
      item?.used,
      ...aliases.map((alias) => usageSource?.[alias]),
      ...flatUsed,
    );
    const remaining = readFiniteNumber(item?.remaining);
    const used = nonNegativeInteger(
      explicitUsed ?? (remaining == null ? 0 : Math.max(0, limit - remaining)),
    );
    return { key, label, used, limit };
  });

  const interestValues = firstArray(
    value.interests,
    value.developingInterests,
    value.interestProfile,
  );
  const interests = interestValues
    .filter(isRecord)
    .map((interest) => {
      const evidence = firstArray(
        interest.evidence,
        interest.evidenceSha256s,
        interest.evidenceIds,
      );
      return {
        topic:
          readString(interest.topic, interest.name, interest.label) ||
          "Emerging topic",
        score: boundedUnit(
          readFiniteNumber(interest.score, interest.weight) ?? 0,
        ),
        confidence: boundedUnit(readFiniteNumber(interest.confidence) ?? 0),
        evidenceCount: nonNegativeInteger(
          readFiniteNumber(interest.evidenceCount) ?? evidence.length,
        ),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const cycleValues = firstArray(
    value.recentCycles,
    value.cycles,
    value.cycleReceipts,
  );
  const cycles = cycleValues
    .filter(isRecord)
    .map((cycle, index) => ({
      id: readString(cycle.id, cycle.cycleId) || `cycle-${index}`,
      status: readString(cycle.status, cycle.outcome) || "unknown",
      trigger: readString(cycle.trigger, cycle.triggerKind),
      createdAt: readString(
        cycle.createdAt,
        cycle.startedAt,
        cycle.scheduledFor,
      ),
      completedAt: readString(cycle.completedAt),
      runId: readString(cycle.runId, cycle.agentRunId),
    }))
    .slice(0, 8);

  const lastCycle = cycles[0];
  const executable = value.executable === true;
  const rawBlockedReason = readString(value.blockedReason);
  const blockedReason: AutonomyBlockedReason | undefined =
    rawBlockedReason === "connection_unavailable" ||
      rawBlockedReason === "authority_unavailable"
      ? rawBlockedReason
      : executable
        ? undefined
        : "authority_unavailable";
  return {
    status,
    executable,
    blockedReason,
    cadenceMs: Math.max(0, cadenceMs),
    lastCycleAt: readString(
      value.lastCycleAt,
      enrollment.lastCycleAt,
      lastCycle?.completedAt,
      lastCycle?.createdAt,
    ),
    nextCycleAt: readString(value.nextCycleAt, enrollment.nextCycleAt),
    lastRunId: readString(value.lastRunId, value.agentRunId, lastCycle?.runId),
    budgetResetAt: readString(usageSource?.resetAt, value.budgetResetAt),
    budgets,
    interests,
    cycles,
  };
}

function autonomyBlockedMessage(reason?: AutonomyBlockedReason) {
  return reason === "connection_unavailable"
    ? "Restore the claimed Moltbook connection before resuming or running a cycle."
    : "The current Agent authority is unavailable. Re-enable it after its access boundary is restored.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRecord(...values: unknown[]) {
  return values.find(isRecord);
}

function firstArray(...values: unknown[]): unknown[] {
  return values.find(Array.isArray) || [];
}

function readString(...values: unknown[]) {
  return values
    .find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    ?.trim();
}

function readFiniteNumber(...values: unknown[]) {
  for (const value of values) {
    const number =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function boundedUnit(value: number) {
  return Math.max(0, Math.min(1, value));
}

function nonNegativeInteger(value: number) {
  return Math.max(0, Math.floor(value));
}

function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function camelToSnake(value: string) {
  return value.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
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

function formatDateOrNever(value?: string | null) {
  return value ? formatDate(value) : "Not run yet";
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

function formatCadence(milliseconds: number) {
  const hours = Math.max(1, Math.round(milliseconds / 3_600_000));
  return `Every ${hours}h`;
}

function shortId(value?: string) {
  if (!value) return "None yet";
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
}

function humanize(value: string) {
  return value
    .replaceAll(/[._-]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Moltbook is unavailable right now.";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(
      payload.message || payload.error || "Moltbook request failed.",
    );
  }
  return payload;
}
