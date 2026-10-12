"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  AlertTriangle,
  Bell,
  BrainCircuit,
  Check,
  Circle,
  Coins,
  Cpu,
  Database,
  Loader2,
  MessageSquareText,
  Layers3,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Workflow,
} from "lucide-react";
import { clsx } from "clsx";
import { IntentPrefetchLink as Link } from "@/components/app-shell/intent-prefetch-link";
import { useWorkspaceSession } from "@/components/app-shell/session-context";
import { CompanionAtlasPortrait, useCompanionAtlasPlayer } from "@/components/companion-atlas-player";
import { companionPresentation } from "@/lib/companion/presentation";
import { SourceCoveragePanel } from "@/components/source-coverage/source-coverage-panel";
import { useLiveRefresh } from "@/components/use-live-refresh";
import { approvalInboxHref, parseApprovalKind } from "@/lib/approvals/inbox-link";
import {
  formatTodayDate,
  formatTodayDue,
  formatTodayRelative,
  formatTodayTime,
} from "@/lib/today/presentation";
import type { TodaySnapshot } from "@/lib/today/snapshot";
import type {
  CohesiveTodayProjection,
  TodayAgendaItem,
  TodayProjectionSourceState,
} from "@/lib/today/cohesive-projection";
import {
  DEFAULT_TODAY_SECTIONS,
  TODAY_SECTION_KEYS,
  type TodaySectionKey,
} from "@/lib/today/sections";
import type {
  UsagePeriodKey,
  UsagePeriodSummary,
  UsageSummary,
  UsageTotals,
} from "@/lib/usage/summary";
import styles from "./today-workspace.module.css";

type JsonRecord = Record<string, unknown>;
type TodayItem = TodaySnapshot["items"][number];
type TodayPreferences = TodaySnapshot["preferences"];
type DailyBrief = NonNullable<TodaySnapshot["brief"]>;

const FULL_REFRESH_INTERVAL_MS = 60_000;
const FULL_REFRESH_MIN_GAP_MS = 30_000;

const emptyPreferences: TodayPreferences = {
  briefEnabled: true,
  briefTime: "08:00",
  timezone: "UTC",
  reminderLeadMinutes: 30,
  notificationsEnabled: true,
  quietHoursEnabled: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  visibleSections: [...DEFAULT_TODAY_SECTIONS],
};

export function TodayWorkspace({
  initialProjection,
}: {
  initialProjection?: CohesiveTodayProjection;
}) {
  const { session, status: sessionStatus } = useWorkspaceSession();
  const hasInitialWorkspace = initialProjection !== undefined;
  const [today, setToday] = useState<TodaySnapshot>(initialProjection?.today || {
    generatedAt: "",
    items: [],
    threads: [],
    memories: [],
    brief: undefined,
    preferences: emptyPreferences,
    briefLocalDate: "",
    briefGenerationDue: false,
    projects: [],
  });
  const [summary, setSummary] = useState<JsonRecord>(() => record(initialProjection?.workspaceSummary));
  const [usage, setUsage] = useState<UsageSummary | undefined>(initialProjection?.usage || undefined);
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriodKey>("day");
  const [usageLoading, setUsageLoading] = useState(!initialProjection?.usage);
  const [todayError, setTodayError] = useState<string>();
  const [agenda, setAgenda] = useState<readonly TodayAgendaItem[]>(initialProjection?.agenda || []);
  const [sourceStates, setSourceStates] = useState<readonly TodayProjectionSourceState[]>(initialProjection?.sources || []);
  const [loading, setLoading] = useState(!hasInitialWorkspace);
  const [saving, setSaving] = useState(false);
  const [generatingBrief, setGeneratingBrief] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<TodayItem["kind"]>("task");
  const [priority, setPriority] = useState<TodayItem["priority"]>("medium");
  const [dueAt, setDueAt] = useState("");
  const [announcement, setAnnouncement] = useState("Today is ready.");
  const [now, setNow] = useState<Date | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const lastFullRefreshAtRef = useRef(
    initialProjection?.generatedAt ? Date.parse(initialProjection.generatedAt) : 0,
  );
  const briefAttemptRef = useRef("");
  const workspaceAvailable = Boolean(session && (!session.authEnabled || session.authenticated));

  const runs = sourceData(summary, "runs");
  const workflows = sourceData(summary, "workflows");
  const approvals = sourceData(summary, "approvals");
  const activeWork = [...runs, ...workflows].filter((item) =>
    ["running", "queued", "pending", "resuming"].includes(
      text(item.status).toLowerCase(),
    ),
  );
  const activeWorkflowWork = workflows.filter((item) =>
    ["running", "queued", "pending", "waiting_approval", "paused"].includes(
      text(item.status).toLowerCase(),
    ),
  );
  const visibleWorkflowWork = activeWorkflowWork;
  const sourceErrors = ["runs", "workflows", "approvals"]
    .map((source) => ({ source, error: sourceError(summary, source) }))
    .filter((item) => item.error);
  const activeRuns = runs.filter((item) => [
    "running", "queued", "resuming", "waiting_approval", "waiting_clarification",
  ].includes(text(item.status).toLowerCase()));
  const visibleSections = new Set(today.preferences.visibleSections || DEFAULT_TODAY_SECTIONS);
  const usageSource = sourceStates.find((source) => source.source === "consumption");
  const usageError = usageSource && usageSource.status !== "ready" && usageSource.status !== "hidden"
    ? usageSource.detail
    : undefined;

  const visibleItems = useMemo(() => {
    const day = localDayKey(now, today.preferences.timezone);
    return today.items.filter((item) =>
      item.status === "open" || localDayKey(item.completedAt ? new Date(item.completedAt) : null, today.preferences.timezone) === day
    );
  }, [now, today.items, today.preferences.timezone]);
  const completed = visibleItems.filter((item) => item.status === "done").length;
  const open = visibleItems.filter((item) => item.status === "open");
  const progress = visibleItems.length ? completed / visibleItems.length : 0;
  const presentationTimezone = today.preferences.timezone;
  const relativeAsOf = now?.getTime() ?? Date.parse(today.generatedAt);
  const sourceIsCurrent = (key: TodayProjectionSourceState["source"]) => sourceStates.some(
    (source) => source.source === key && source.status === "ready" && source.freshness === "current",
  );
  const agendaSources = ["personal_reminders", "meetings", "commitments"] as const;
  const uncheckedAgendaSources = agendaSources.filter((source) => !sourceIsCurrent(source));
  const agendaIsCurrent = uncheckedAgendaSources.length === 0;
  const agendaItems = agenda.filter((item) => ["reminder", "meeting", "commitment"].includes(item.kind));
  const uncheckedAgendaStates = uncheckedAgendaSources.map((key) => sourceStates.find((source) => source.source === key));
  const agendaHidden = uncheckedAgendaStates.length > 0 && uncheckedAgendaStates.every((source) => source?.status === "hidden");
  const agendaRestricted = uncheckedAgendaStates.length > 0 && uncheckedAgendaStates.every((source) => source?.status === "restricted");
  const agendaStatus = loading && !hasInitialWorkspace
    ? "Checking agenda…"
    : agendaIsCurrent
      ? agendaItems.length ? `${agendaItems.length} agenda ${agendaItems.length === 1 ? "item" : "items"}` : "No agenda items in view"
      : agendaItems.length ? "Agenda is incomplete"
        : agendaHidden ? "Agenda hidden"
          : agendaRestricted ? "Agenda access limited"
            : "Agenda unavailable";
  const approvalsCurrent = sourceIsCurrent("approvals");
  const workCurrent = (!visibleSections.has("active_agents") || sourceIsCurrent("active_agents")) && (!visibleSections.has("work") || sourceIsCurrent("work"));
  const sourceIssueCount = sourceStates.filter((source) => source.status === "error" || source.status === "restricted").length;
  const sourceNeedsAttention = (key: TodayProjectionSourceState["source"]) => sourceStates.some(
    (source) => source.source === key && ["error", "restricted"].includes(source.status),
  );
  const rankedOpen = [...open].sort((a, b) => {
    const urgency = (item: TodayItem) => (item.reminderState === "overdue" ? 4 : 0) + (item.priority === "high" ? 2 : item.priority === "medium" ? 1 : 0);
    return urgency(b) - urgency(a) || (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity);
  });
  const focusItems = showCompleted ? [...rankedOpen, ...visibleItems.filter((item) => item.status === "done")] : rankedOpen;
  const nextMeeting = agendaItems.filter((item) => item.kind === "meeting" && item.scheduledAt && Date.parse(item.scheduledAt) >= relativeAsOf)
    .sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!))[0];
  const nextMove = approvalsCurrent && approvals.length && visibleSections.has("approvals")
    ? { label: "Needs your decision", title: text(approvals[0].title, "Review a proposed action"), detail: "Your approval is needed before this can continue.", href: approvalInboxHref({ id: text(approvals[0].id), kind: parseApprovalKind(approvals[0].kind), returnTo: "/app" }), action: "Review action", attention: true }
    : rankedOpen[0] && visibleSections.has("focus")
      ? { label: rankedOpen[0].reminderState === "overdue" ? "Overdue" : "Start here", title: rankedOpen[0].title, detail: rankedOpen[0].dueAt ? `Due ${formatTodayDue(rankedOpen[0].dueAt, presentationTimezone)}` : "One useful thing to move forward today.", href: "#today-focus", action: "See your tasks", attention: rankedOpen[0].reminderState === "overdue" }
      : nextMeeting && visibleSections.has("agenda")
        ? { label: "Coming up", title: nextMeeting.title, detail: formatTodayTime(nextMeeting.scheduledAt!, presentationTimezone), href: nextMeeting.href, action: "Open meeting", attention: false }
        : { label: "Make room for what matters", title: "What would you like to move forward?", detail: "Ask Asael to research, plan, or help you take the next step.", href: "/app/command", action: "Talk to Asael", attention: false };
  const firstName = session?.user?.name?.trim().split(/\s+/)[0];
  const ownerScope = sessionStatus === "ready" && session?.context?.tenantId && session.context.actorId
    ? JSON.stringify([session.context.tenantId, session.context.actorId, session.user?.id, session.context.role, session.membership?.role]) : undefined;


  function maybeGenerateBrief(nextToday: TodaySnapshot) {
    if (
      nextToday.briefGenerationDue &&
      briefAttemptRef.current !== nextToday.briefLocalDate
    ) {
      briefAttemptRef.current = nextToday.briefLocalDate || nextToday.generatedAt.slice(0, 10);
      void generateBrief(false);
    }
  }

  async function load({
    force = false,
    showLoading = false,
    announce = false,
  }: {
    force?: boolean;
    showLoading?: boolean;
    announce?: boolean;
  } = {}) {
    if (sessionStatus !== "ready" || !workspaceAvailable) return;
    const timestamp = Date.now();
    if (
      !force &&
      Number.isFinite(lastFullRefreshAtRef.current) &&
      timestamp - lastFullRefreshAtRef.current < FULL_REFRESH_MIN_GAP_MS
    ) {
      return;
    }
    lastFullRefreshAtRef.current = timestamp;
    if (showLoading) setLoading(true);
    setUsageLoading(true);
    try {
      const payload = await readJson(
        "/api/today/agenda?workLimit=16&approvalLimit=12&meetingLimit=50",
      );
      const projection = payload.projection as CohesiveTodayProjection;
      if (!projection?.today || !Array.isArray(projection.sources)) {
        throw new Error("Today returned an invalid cohesive projection.");
      }
      setToday(projection.today);
      setSummary(record(projection.workspaceSummary));
      setUsage(projection.usage || undefined);
      setAgenda(projection.agenda || []);
      setSourceStates(projection.sources);
      setTodayError(undefined);
      maybeGenerateBrief(projection.today);
      if (announce) setAnnouncement("Today refreshed.");
    } catch (error) {
      setTodayError(errorMessage(error));
    } finally {
      if (showLoading) setLoading(false);
      setUsageLoading(false);
    }
  }

  useEffect(() => {
    const clockTimer = window.setTimeout(() => {
      setNow(new Date());
      setHydrated(true);
    }, 0);
    const minuteTimer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => {
      window.clearInterval(minuteTimer);
      window.clearTimeout(clockTimer);
    };
  }, []);

  useEffect(() => {
    if (hasInitialWorkspace) {
      maybeGenerateBrief(today);
      return;
    }
    const loadTimer = window.setTimeout(
      () => void load({ force: true, showLoading: true }),
      0,
    );
    return () => window.clearTimeout(loadTimer);
    // Session identity is the automatic load boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasInitialWorkspace, sessionStatus, session]);

  useLiveRefresh({
    enabled: workspaceAvailable,
    onRefresh: load,
    pollIntervalMs: FULL_REFRESH_INTERVAL_MS,
  });

  async function addItem(event: React.FormEvent) {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    const submittedDueAt = String(
      new FormData(event.currentTarget as HTMLFormElement).get("dueAt") || "",
    ).trim();
    const dueTimestamp = submittedDueAt ? Date.parse(submittedDueAt) : undefined;
    if (dueTimestamp !== undefined && !Number.isFinite(dueTimestamp)) {
      setTodayError("Choose a valid due date and time.");
      return;
    }
    setSaving(true);
    try {
      const payload = await readJson("/api/today", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          title: cleanTitle,
          kind,
          priority,
          // Read the submitted control rather than relying on a possibly stale
          // controlled-state render. Browser date pickers and assistive input
          // tools can update the native field immediately before submit.
          dueAt: dueTimestamp === undefined ? undefined : new Date(dueTimestamp).toISOString(),
        }),
      });
      const item = payload.item as TodayItem;
      setToday((current) => ({ ...current, items: [item, ...current.items] }));
      setTitle("");
      setDueAt("");
      setAnnouncement(`${kind === "reminder" ? "Reminder" : "Task"} added.`);
    } catch (error) {
      setTodayError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function toggleItem(item: TodayItem) {
    const nextStatus = item.status === "done" ? "open" : "done";
    const previous = today.items;
    setToday((current) => ({
      ...current,
      items: current.items.map((candidate) =>
        candidate.id === item.id ? { ...candidate, status: nextStatus } : candidate
      ),
    }));
    try {
      const payload = await readJson(`/api/today/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ status: nextStatus }),
      });
      setToday((current) => ({
        ...current,
        items: current.items.map((candidate) =>
          candidate.id === item.id ? payload.item as TodayItem : candidate
        ),
      }));
      setAnnouncement(nextStatus === "done" ? "Task completed." : "Task reopened.");
    } catch (error) {
      setToday((current) => ({ ...current, items: previous }));
      setTodayError(errorMessage(error));
    }
  }

  async function generateBrief(force = true) {
    setGeneratingBrief(true);
    try {
      const payload = await readJson("/api/today/brief", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ force }),
      });
      setToday((current) => ({ ...current, brief: payload.brief as DailyBrief, briefGenerationDue: false }));
      setAnnouncement("Your daily brief is ready.");
    } catch (error) {
      setTodayError(errorMessage(error));
    } finally {
      setGeneratingBrief(false);
    }
  }

  async function saveSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingSchedule(true);
    try {
      const payload = await readJson("/api/today/brief", {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(today.preferences),
      });
      setToday((current) => ({ ...current, preferences: payload.preferences as TodayPreferences }));
      await load({ force: true });
      setAnnouncement("Today preferences updated.");
    } catch (error) {
      setTodayError(errorMessage(error));
    } finally {
      setSavingSchedule(false);
    }
  }

  function updatePreference<Key extends keyof TodayPreferences>(key: Key, value: TodayPreferences[Key]) {
    setToday((current) => ({ ...current, preferences: { ...current.preferences, [key]: value } }));
  }

  function toggleTodaySection(section: TodaySectionKey, visible: boolean) {
    const current = [...(today.preferences.visibleSections || DEFAULT_TODAY_SECTIONS)];
    const next = visible
      ? [...new Set([...current, section])]
      : current.filter((candidate) => candidate !== section);
    if (!next.length) {
      setAnnouncement("Keep at least one Today section visible.");
      return;
    }
    updatePreference("visibleSections", next);
  }

  return (
    <main
      className={styles.shell}
      data-testid="activity-workspace"
      data-hydrated={hydrated}
      aria-busy={loading}
    >
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      <header className={styles["today-brief"]}>
        <div className={styles.welcomeCopy}>
          <p className={styles["today-kicker"]}>{now ? formatTodayDate(now, presentationTimezone) : "Today"}</p>
          <h1>{todayGreeting(now, presentationTimezone)}{firstName ? `, ${firstName}` : ""}.</h1>
          <p>Your day, with the important things in reach.</p>
          <div className={styles["today-operating-line"]} aria-label="Current workspace status">
            {visibleSections.has("focus") ? <span><Check size={14} aria-hidden="true" />{loading && !hasInitialWorkspace ? "Checking your tasks…" : `${open.length} open · ${completed} done today`}</span> : null}
            {visibleSections.has("active_agents") || visibleSections.has("work") ? <span><i className={clsx(activeWork.length && styles["is-active"])} aria-hidden="true" />{workCurrent ? activeWork.length ? `${activeWork.length} in progress` : "No work running" : "Work status not confirmed"}</span> : null}
            {visibleSections.has("approvals") ? <span><Bell size={14} aria-hidden="true" />{approvalsCurrent ? approvals.length ? `${approvals.length} awaiting your decision` : "No decisions waiting" : "Decisions not checked"}</span> : null}
          </div>
        </div>
        <TodayCompanion key={ownerScope} scope={ownerScope} />
        <div className={styles["today-actions"]}>
          <button type="button" onClick={() => void load({ force: true, showLoading: true, announce: true })} disabled={loading} className={styles["today-icon-button"]} aria-label="Refresh Today" title="Refresh Today"><RefreshCw size={16} className={loading ? "animate-spin" : ""} aria-hidden="true" /></button>
          <Link href="/app/capture" className="action-link">Save a note</Link>
          <Link href="/app/command" className="primary-button" aria-label="Start task">Ask Asael <ArrowRight size={15} aria-hidden="true" /></Link>
        </div>
      </header>

      <section className={styles.nextMove} data-attention={nextMove.attention} aria-labelledby="today-next-move">
        <div className={styles.nextMoveIcon}>{nextMove.attention ? <Bell size={22} aria-hidden="true" /> : <ArrowRight size={22} aria-hidden="true" />}</div>
        <div><p>{nextMove.label}</p><h2 id="today-next-move">{nextMove.title}</h2><span>{nextMove.detail}</span></div>
        <Link href={nextMove.href}>{nextMove.action}<ArrowRight size={16} aria-hidden="true" /></Link>
      </section>

      {todayError ? (
        <div className={styles["today-error"]} role="alert">
          <strong>Some context is unavailable.</strong>
          <span>{todayError}</span>
        </div>
      ) : null}

      <section className={styles["today-generated-brief"]} data-has-priorities={Boolean(today.brief?.focus.length)} aria-labelledby="daily-brief-title">
        <div className={styles["today-brief-lead"]}>
          <div className={styles["today-brief-title-row"]}>
            <div>
              <h2 id="daily-brief-title">Your daily brief</h2>
            </div>
          </div>
          {today.brief ? (
            <>
              <p className={styles["today-brief-summary"]}>{today.brief.summary}</p>
              <div className={styles["today-brief-meta"]}>
                {today.brief.localDate !== today.briefLocalDate ? <span>Earlier brief</span> : null}
                <span>{today.brief.generatedBy === "ai" ? "Prepared by Asael" : "From your tasks and reminders"}</span>
                <span><time dateTime={today.brief.generatedAt}>{formatTodayTime(today.brief.generatedAt, presentationTimezone)}</time></span>
                <button type="button" onClick={() => void generateBrief(true)} disabled={generatingBrief}>
                  {generatingBrief ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />} Refresh
                </button>
              </div>
            </>
          ) : (
            <div className={styles["today-brief-empty"]}>
              <p>{generatingBrief ? "Reading your focus, memory, and recent work…" : "A short read on your priorities, recent work, and anything to keep an eye on."}</p>
              <button type="button" onClick={() => void generateBrief(true)} disabled={generatingBrief}>
                {generatingBrief ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
                {generatingBrief ? "Preparing" : "Generate brief"}
              </button>
            </div>
          )}
        </div>

        {today.brief?.focus.length ? <div className={styles["today-brief-focus"]} aria-label="Brief priorities">
          <p className={styles["today-brief-label"]}>Priorities</p>
          {today.brief?.focus.length ? today.brief.focus.slice(0, 3).map((item, index) => (
            <div className={styles["today-brief-priority"]} key={`${item.title}-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><strong>{item.title}</strong><p>{item.reason}</p></div>
            </div>
          )) : <p className={styles["today-brief-placeholder"]}>Your top priorities will appear here.</p>}
        </div> : null}

        <div className={styles["today-brief-side"]}>
          {today.brief?.watchouts.length ? <div>
            <p className={styles["today-brief-label"]}><AlertTriangle size={12} aria-hidden="true" /> Risks and blockers</p>
            {today.brief?.watchouts.length ? today.brief.watchouts.slice(0, 2).map((item) => <p key={item} className={styles["today-watchout"]}>{item}</p>) : <p className={styles["today-brief-placeholder"]}>{today.brief ? "No risks or blockers in this brief." : "Generate a brief to review risks and blockers."}</p>}
          </div> : null}
          {today.brief?.resurfaced[0] ? <div className={styles["today-resurfaced"]}><p className={styles["today-brief-label"]}>From your memory</p><strong>{today.brief.resurfaced[0].title}</strong><p>{today.brief.resurfaced[0].context}</p></div> : null}
          <details className={styles["today-brief-schedule"]}>
            <summary><Settings2 size={13} aria-hidden="true" /> Personalize Today</summary>
            <form onSubmit={saveSchedule}>
              <label className={styles["today-switch-row"]}><span>Automatic brief</span><input type="checkbox" checked={today.preferences.briefEnabled} onChange={(event) => updatePreference("briefEnabled", event.currentTarget.checked)} /></label>
              <label><span>Time</span><input type="time" value={today.preferences.briefTime} onChange={(event) => updatePreference("briefTime", event.currentTarget.value)} /></label>
              <label><span>Timezone</span><input value={today.preferences.timezone} onChange={(event) => updatePreference("timezone", event.currentTarget.value)} maxLength={120} /></label>
              <label><span>Remind me</span><select value={today.preferences.reminderLeadMinutes} onChange={(event) => updatePreference("reminderLeadMinutes", Number(event.currentTarget.value))}>
                <option value={5}>5 min before</option><option value={15}>15 min before</option><option value={30}>30 min before</option><option value={60}>1 hour before</option><option value={120}>2 hours before</option>
              </select></label>
              <fieldset className={styles.sectionPicker}>
                <legend>Visible sections</legend>
                {TODAY_SECTION_KEYS.map((section) => (
                  <label key={section}>
                    <input
                      type="checkbox"
                      checked={visibleSections.has(section)}
                      onChange={(event) => toggleTodaySection(section, event.currentTarget.checked)}
                    />
                    <span>{sectionLabel(section)}</span>
                  </label>
                ))}
              </fieldset>
              <button type="submit" disabled={savingSchedule}>{savingSchedule ? "Saving…" : "Save preferences"}</button>
            </form>
          </details>
        </div>
      </section>

      {visibleSections.has("focus") || visibleSections.has("agenda") ? <section className={styles["today-grid"]}>
        {visibleSections.has("focus") ? <div className={styles["today-focus"]} id="today-focus">
          <div className={styles["today-section-heading"]}>
            <div>
              <h2>Your focus</h2>
              <p className={styles["today-section-copy"]}>{open.length} open and {completed} completed in this view.</p>
            </div>
            <ProgressRing value={progress} completed={completed} total={visibleItems.length} />
          </div>

          <details className={styles["today-capture-panel"]}>
            <summary className={styles["today-capture-heading"]}><Plus size={17} aria-hidden="true" />Add a task or reminder</summary>
            <form className={styles["today-capture-row"]} onSubmit={addItem}>
              <label className={clsx(styles["today-capture-field"], styles["today-capture-title"])}>
                <span>What needs to happen?</span>
                <input aria-label="Task or reminder" id="today-item-title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="Write a clear task or reminder" maxLength={280} />
              </label>
              <label className={styles["today-capture-field"]}>
                <span>Type</span>
                <select aria-label="Item type" value={kind} onChange={(event) => setKind(event.currentTarget.value as TodayItem["kind"])}>
                  <option value="task">Task</option><option value="reminder">Reminder</option>
                </select>
              </label>
              <label className={styles["today-capture-field"]}>
                <span>Priority</span>
                <select aria-label="Priority" value={priority} onChange={(event) => setPriority(event.currentTarget.value as TodayItem["priority"])}>
                  <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                </select>
              </label>
              <label className={clsx(styles["today-capture-field"], styles["today-capture-due"])}>
                <span>Due date and time</span>
                <input aria-label="Due time" id="today-due-at" name="dueAt" type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.currentTarget.value)} />
              </label>
              <button type="submit" disabled={saving || !title.trim()}>{saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : "Add"}</button>
            </form>
          </details>

          {completed ? <button type="button" className={styles.completedToggle} aria-pressed={showCompleted} onClick={() => setShowCompleted(!showCompleted)}>{showCompleted ? "Hide" : "Show"} {completed} completed</button> : null}
          <div className={styles["today-focus-list"]} aria-label="Focus items">
            {focusItems.length ? focusItems.map((item) => (
              <button key={item.id} type="button" onClick={() => void toggleItem(item)} aria-label={`${item.status === "done" ? "Reopen" : "Complete"}: ${item.title}`} className={clsx(styles["today-focus-item"], item.status === "done" && styles["is-done"], item.reminderState && styles[`is-${item.reminderState}`])}>
                <span className={styles["today-check"]}>{item.status === "done" ? <Check size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}</span>
                <span className={styles["today-item-copy"]}><strong>{item.title}</strong><small>{item.kind === "reminder" ? "Reminder" : "Task"}{item.dueAt ? ` · ${formatTodayDue(item.dueAt, presentationTimezone)}` : ""}{dueStateLabel(item.reminderState)}</small></span>
                <span className={clsx(styles["today-priority"], styles[`priority-${item.priority}`])}>{friendlyLabel(item.priority)}</span>
              </button>
            )) : (
              <div className={styles["today-empty"]}><Sparkles size={20} aria-hidden="true" /><p>{loading && !hasInitialWorkspace ? "Loading your tasks…" : completed ? "Your focus list is clear." : "A little focus goes a long way."}</p><span>{completed ? "Your completed tasks are saved above." : "Add one thing you want to move forward today."}</span></div>
            )}
          </div>
        </div> : null}

        {visibleSections.has("agenda") ? <aside className={styles["today-agenda"]} id="today-agenda">
          <div className={clsx(styles["today-section-heading"], styles["compact"])}><div><h2>Agenda</h2><p className={styles["today-section-copy"]}>Meetings, confirmed commitments, and personal reminders.</p></div></div>
          <div className={styles["today-timeline"]}>
            {agendaItems.length
              ? agendaItems.slice(0, 8).map((item) => (
                <Link key={item.itemId} href={item.href} className={clsx(styles["today-timeline-item"], styles[`is-${item.priority}`])}>
                  <span>{item.scheduledAt ? formatTodayTime(item.scheduledAt, presentationTimezone) : "Open"}</span>
                  <div><strong>{item.title}</strong><small>{agendaKindLabel(item.kind)} · {item.detail}</small></div>
                </Link>
              ))
              : <p className={styles["today-context-empty"]}>{agendaIsCurrent ? "No meetings, commitments, or reminders in this view." : agendaStatus}</p>}
            {!agendaIsCurrent && !(loading && !hasInitialWorkspace) ? <p className={styles.sourceNotice}>{uncheckedAgendaSources.map((key) => {
              const source = sourceStates.find((candidate) => candidate.source === key);
              return `${sourceLabel(key)}: ${source ? sourceStatusLabel(source.status).toLowerCase() : "not available"}`;
            }).join(" · ")}. See “About this view” below.</p> : null}
          </div>
          {visibleSections.has("approvals") && (approvals.length > 0 || sourceNeedsAttention("approvals")) ? <div className={styles["today-attention"]}>
            <Bell size={15} aria-hidden="true" />
            <div>
              <strong>{!approvalsCurrent ? "Approval status unavailable" : approvals.length ? `${approvals.length} ${approvals.length === 1 ? "approval" : "approvals"} waiting` : "No approvals waiting"}</strong>
              <p>{!approvalsCurrent ? "Open Approvals to check the queue." : approvals.length ? "Review consequential actions before they continue." : "There are no paused actions to review."}</p>
            </div>
            <Link href="/app/approvals">View</Link>
          </div> : null}
        </aside> : null}
      </section> : null}

      {["approvals", "active_agents", "work", "memory", "conversations"].some((section) => visibleSections.has(section as TodaySectionKey)) ? <section className={styles["today-context-grid"]}>
        {visibleSections.has("approvals") && (approvals.length > 0 || sourceNeedsAttention("approvals")) ? <TodayContextSection icon={Bell} title="Needs your approval" description="Consequential actions remain paused until you review them." href="/app/approvals">
          {approvals.length ? approvals.slice(0, 5).map((approval, index) => (
            <Link key={text(approval.id) || index} href={approvalInboxHref({ id: text(approval.id), kind: parseApprovalKind(approval.kind), returnTo: "/app" })} className={styles["today-context-row"]}>
              <span className={clsx(styles["today-live-dot"], styles["is-active"])} /><div><strong>{text(approval.title, "Approval required")}</strong><small>Risk {text(approval.riskLevel, "unknown")} · {text(approval.status, "waiting").replaceAll("_", " ")}</small></div><ArrowRight size={14} aria-hidden="true" />
            </Link>
          )) : <ContextEmpty>{approvalsCurrent ? "Nothing is waiting for your approval." : "The approval queue could not be checked."}</ContextEmpty>}
        </TodayContextSection> : null}

        {visibleSections.has("active_agents") && (activeRuns.length > 0 || sourceNeedsAttention("active_agents")) ? <TodayContextSection icon={Cpu} title="Happening now" description="What Asael is working on for you." href="/app/command">
          {activeRuns.length ? activeRuns.slice(0, 5).map((run, index) => (
            <Link key={text(run.id) || index} href={text(run.id) ? `/app/command?run=${encodeURIComponent(text(run.id))}` : "/app/command"} className={styles["today-context-row"]}>
              <span className={styles["today-live-dot"]} /><div><strong>{text(run.prompt, "Assistant task")}</strong><small>{friendlyLabel(text(run.status, "active"))}</small></div><ArrowRight size={14} aria-hidden="true" />
            </Link>
          )) : <ContextEmpty>{sourceIsCurrent("active_agents") ? "No agent is currently running." : "Agent status could not be checked."}</ContextEmpty>}
        </TodayContextSection> : null}

        {visibleSections.has("work") && (visibleWorkflowWork.length > 0 || Boolean(today.projects?.length) || sourceNeedsAttention("work")) ? <TodayContextSection icon={Workflow} title="Work in progress" description="Workflows, active projects, and their next task." href="/app/workflows">
          {visibleWorkflowWork.length ? visibleWorkflowWork.slice(0, 4).map((item, index) => (
            <Link key={text(item.id) || index} href="/app/workflows" className={styles["today-context-row"]}>
              <span className={styles["today-live-dot"]} /><div><strong>{text(item.goal, "Untitled workflow")}</strong><small>{text(item.status, "active").replaceAll("_", " ")}</small></div><ArrowRight size={14} aria-hidden="true" />
            </Link>
          )) : null}
          {today.projects?.length ? today.projects.slice(0, 4).map((project) => (
            <Link key={project.id} href="/app/projects" className={styles["today-project-row"]}><div><strong>{project.title}</strong><p>{project.nextTask || project.objective}{project.nextTaskStatus ? ` · ${project.nextTaskStatus}` : ""}</p><span><i style={{ width: `${project.totalTasks ? project.closedTasks / project.totalTasks * 100 : 0}%` }} /></span></div><small>{project.closedTasks}/{project.totalTasks} closed{project.unverifiedTasks ? ` · ${project.unverifiedTasks} unverified` : ""}</small></Link>
          )) : !visibleWorkflowWork.length ? <ContextEmpty>{sourceIsCurrent("work") ? "No active workflow or project is in view." : "Workflow status could not be checked."}</ContextEmpty> : null}
          {sourceErrors.filter(({ source }) => source === "workflows").map(({ source, error }) => (
            <details key={source} className={styles["today-source-error"]}><summary><AlertTriangle size={12} aria-hidden="true" />Could not refresh {source}</summary><p>{error}</p></details>
          ))}
        </TodayContextSection> : null}

        {visibleSections.has("memory") && today.memories.length > 0 ? <TodayContextSection icon={BrainCircuit} title="Memory" description="Recent knowledge Asael may use." href="/app/memory">
          {today.memories.length ? today.memories.slice(0, 4).map((memory) => (
            <Link key={memory.id} href="/app/memory" className={styles["today-memory-row"]}><div><strong>{memory.title}</strong><p>{memoryPreview(memory.content)}</p></div><span>{friendlyLabel(memory.type)}</span></Link>
          )) : <ContextEmpty>Capture a note and useful knowledge will resurface here.</ContextEmpty>}
        </TodayContextSection> : null}

        {visibleSections.has("conversations") && today.threads.length > 0 ? <TodayContextSection icon={MessageSquareText} title="Pick up where you left off" description="Your recent conversations." href="/app/command">
          {today.threads.length ? today.threads.slice(0, 5).map((thread) => (
            <Link key={thread.id} href={`/app/command?thread=${encodeURIComponent(thread.id)}`} className={styles["today-context-row"]}><div><strong>{thread.title}</strong><small>{formatTodayRelative(thread.updatedAt, relativeAsOf)}</small></div><ArrowRight size={14} aria-hidden="true" /></Link>
          )) : <ContextEmpty>Your recent conversations will appear here.</ContextEmpty>}
        </TodayContextSection> : null}
      </section> : null}

      {visibleSections.has("consumption") ? <details className={styles.detailSection}>
        <summary><span>AI usage</span><span>{usage ? `${formatTokens(usage.periods[usagePeriod].current.totalTokens)} tokens · ${usage.periods[usagePeriod].label}` : usageLoading ? "Loading…" : "Unavailable"}</span></summary>
        <UsageCockpit
          summary={usage}
          periodKey={usagePeriod}
          loading={usageLoading}
          error={usageError}
          onPeriodChange={setUsagePeriod}
          onRetry={() => void load({ force: true, showLoading: true })}
        />
      </details> : null}

      <details className={styles.detailSection} id="today-sources">
        <summary><span>About this view</span><span>{sourceIssueCount ? `${sourceIssueCount} sources need attention` : sourceStates.length ? "Source freshness and coverage" : "Waiting for sources"}</span></summary>
        <section className={styles.projectionStatus} aria-labelledby="today-projection-status-title">
          <div>
            <p className={styles.projectionKicker}>About this view</p>
            <h2 id="today-projection-status-title">What has been checked</h2>
            <p>See which parts of Asael are current enough to rely on. If a source cannot be checked, Asael says so instead of pretending it is empty.</p>
          </div>
          <div className={styles.sourceStateGrid}>
            {sourceStates.map((source) => (
              <div key={source.source} className={styles.sourceState} data-status={source.status}>
                <span>{sourceLabel(source.source)}</span>
                <strong>{sourceStatusLabel(source.status)}</strong>
                <small>{source.lastChangedAt ? `Last change ${formatTodayRelative(source.lastChangedAt, relativeAsOf)}` : source.detail}</small>
              </div>
            ))}
          </div>
        </section>

        <SourceCoveragePanel surface="today" />
      </details>
    </main>
  );
}

function UsageCockpit({
  summary,
  periodKey,
  loading,
  error,
  onPeriodChange,
  onRetry,
}: {
  summary?: UsageSummary;
  periodKey: UsagePeriodKey;
  loading: boolean;
  error?: string;
  onPeriodChange: (period: UsagePeriodKey) => void;
  onRetry: () => void;
}) {
  const period = summary?.periods[periodKey];
  const currentSourceStreams = period?.current.sourceStreams ?? period?.current.runs ?? 0;
  const currentProviderCalls = period?.current.providerCalls ?? period?.current.modelCalls ?? 0;
  const previousProviderCalls = period?.previous.providerCalls ?? period?.previous.modelCalls ?? 0;
  const periods: Array<{ key: UsagePeriodKey; label: string }> = [
    { key: "day", label: "Daily" },
    { key: "week", label: "Weekly" },
    { key: "month", label: "Monthly" },
  ];

  return (
    <section className={styles.usageCockpit} aria-labelledby="usage-cockpit-title" aria-busy={loading}>
      <header className={styles.usageHeader}>
        <div>
          <p className={styles.usageKicker}><Activity size={14} aria-hidden="true" /> Consumption</p>
          <h2 id="usage-cockpit-title">AI usage</h2>
          <p>Models, retrieval, media AI, retries, and known estimated cost in one ledger.</p>
        </div>
        <div className={styles.usagePeriodSwitch} role="group" aria-label="Consumption period">
          {periods.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={periodKey === item.key}
              onClick={() => onPeriodChange(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      {period ? (
        <div className={styles.usageBody} key={period.key}>
          <div className={styles.usageReadout}>
            <div className={styles.usagePrimaryMetric}>
              <span>Total consumption · {period.label}</span>
              <strong>{formatTokens(period.current.totalTokens)}</strong>
              <UsageDelta current={period.current.totalTokens} previous={period.previous.totalTokens} />
          <small>tokens across {currentSourceStreams.toLocaleString("en-US")} distinct {currentSourceStreams === 1 ? "source" : "sources"}</small>
            </div>

            <div className={styles.usageMetricLedger}>
              <UsageMetric
                icon={Database}
                label="Context consumed"
                value={formatTokens(period.current.inputTokens)}
                detail={`${compactComparison(period.current.inputTokens, period.previous.inputTokens)} · input tokens, not window %`}
              />
              <UsageMetric
                icon={Activity}
                label="Output"
                value={formatTokens(period.current.outputTokens)}
                detail={`${compactComparison(period.current.outputTokens, period.previous.outputTokens)} · generated tokens`}
              />
              <UsageMetric
                icon={Layers3}
                label="Cache reused"
                value={formatTokens(period.current.cachedInputTokens)}
                detail={`${tokenShare(period.current.cachedInputTokens, period.current.inputTokens)}% of input · ${compactComparison(period.current.cachedInputTokens, period.previous.cachedInputTokens)}`}
              />
              <UsageMetric
                icon={Cpu}
                label="AI calls"
                value={currentProviderCalls.toLocaleString("en-US")}
                detail={`${compactComparison(currentProviderCalls, previousProviderCalls)} · ${(period.current.attempts ?? 0).toLocaleString("en-US")} attempts · ${(period.current.failedAttempts ?? 0).toLocaleString("en-US")} failed`}
              />
              <UsageMetric
                icon={Coins}
                label="Known est. cost"
                value={formatKnownCost(period.current)}
                detail={`${period.current.costCoveragePercent}% priced · previous ${formatKnownCost(period.previous)} · ${period.current.unknownCostCalls.toLocaleString("en-US")} unknown`}
              />
            </div>
          </div>

          <div className={styles.usageMain}>
            <div className={styles.usageTrendPanel}>
              <div className={styles.usageTrendHeading}>
                <div>
                  <h3>Consumption rhythm</h3>
                  <p>{period.currentLabel} compared with the equal previous period.</p>
                </div>
                <div className={styles.usageLegend} aria-label="Chart legend">
                  <span><i className={styles.currentLegend} />Current</span>
                  <span><i className={styles.previousLegend} />Previous</span>
                </div>
              </div>
              <UsageTrendChart period={period} />
              <TokenComposition totals={period.current} />
            </div>

            <div className={styles.usageMixPanel}>
              <UsageBreakdown
                title="Provider mix"
                description="Where tracked tokens were processed"
                items={period.providers}
                totalTokens={period.current.totalTokens}
              />
              <UsageBreakdown
                title="Model mix"
                description="Highest-consumption models"
                items={period.models}
                totalTokens={period.current.totalTokens}
                showProvider
              />
            </div>
          </div>

          <footer className={styles.usageDisclosure}>
            <span>{summary.scopeLabel}</span>
            <p>{summary.disclosure}</p>
            {summary.sourceEventLimitReached ? (
              <strong>Source limit reached; totals may be partial.</strong>
            ) : null}
            {error ? <strong>Refresh failed; showing the last available totals.</strong> : null}
            <time dateTime={summary.generatedAt}>Updated {formatUpdatedAt(summary.generatedAt)}</time>
          </footer>
        </div>
      ) : (
        <div className={styles.usageUnavailable} role={error ? "alert" : "status"}>
          {loading ? <Loader2 size={20} className="animate-spin" aria-hidden="true" /> : <AlertTriangle size={20} aria-hidden="true" />}
          <div>
            <strong>{loading ? "Loading consumption…" : "Consumption is temporarily unavailable"}</strong>
            <p>{error || "Today remains available while tracked usage loads independently."}</p>
          </div>
          {!loading ? <button type="button" onClick={onRetry}>Try again</button> : null}
        </div>
      )}
    </section>
  );
}

function UsageMetric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={styles.usageMetric}>
      <Icon size={15} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function UsageDelta({ current, previous }: { current: number; previous: number }) {
  const delta = comparison(current, previous);
  return (
    <span className={clsx(styles.usageDelta, styles[delta.tone])}>
      {delta.symbol} {delta.label} vs previous
    </span>
  );
}

function UsageTrendChart({ period }: { period: UsagePeriodSummary }) {
  const width = 760;
  const height = 238;
  const inset = { top: 18, right: 14, bottom: 34, left: 46 };
  const plotWidth = width - inset.left - inset.right;
  const plotHeight = height - inset.top - inset.bottom;
  const peak = Math.max(
    1,
    ...period.series.flatMap((point) => [point.currentTotalTokens, point.previousTotalTokens]),
  );
  const x = (index: number) => inset.left + (period.series.length <= 1 ? 0 : index / (period.series.length - 1) * plotWidth);
  const y = (value: number) => inset.top + plotHeight - value / peak * plotHeight;
  const currentPath = linePath(period.series.map((point) => point.currentTotalTokens), x, y);
  const previousPath = linePath(period.series.map((point) => point.previousTotalTokens), x, y);
  const areaPath = period.series.length
    ? `${currentPath} L ${x(period.series.length - 1)} ${inset.top + plotHeight} L ${x(0)} ${inset.top + plotHeight} Z`
    : "";
  const labelIndexes = chartLabelIndexes(period.series.length);
  const titleId = `usage-trend-title-${period.key}`;
  const descriptionId = `usage-trend-description-${period.key}`;

  return (
    <figure className={styles.usageChartFigure}>
      <svg
        className={styles.usageChart}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        <title id={titleId}>{`Token consumption trend for ${period.currentLabel}`}</title>
        <desc id={descriptionId}>
          {`${period.current.totalTokens.toLocaleString("en-US")} tokens in the current period, compared with ${period.previous.totalTokens.toLocaleString("en-US")} in the previous equal period.`}
        </desc>
        <defs>
          <linearGradient id={`usage-area-${period.key}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.2" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const gridY = inset.top + ratio * plotHeight;
          const gridValue = Math.round(peak * (1 - ratio));
          return (
            <g key={ratio} className={styles.usageGridline}>
              <line x1={inset.left} x2={width - inset.right} y1={gridY} y2={gridY} />
              <text x={inset.left - 8} y={gridY + 3} textAnchor="end">{compactAxisValue(gridValue)}</text>
            </g>
          );
        })}
        {areaPath ? <path className={styles.usageArea} d={areaPath} fill={`url(#usage-area-${period.key})`} /> : null}
        <path className={styles.usagePreviousLine} d={previousPath} />
        <path className={styles.usageCurrentLine} d={currentPath} />
        {period.series.map((point, index) => (
          <circle
            key={point.currentAt}
            className={styles.usageCurrentPoint}
            cx={x(index)}
            cy={y(point.currentTotalTokens)}
            r={point.currentTotalTokens ? 2.4 : 0}
          />
        ))}
        {labelIndexes.map((index) => (
          <text
            key={period.series[index]?.currentAt || index}
            className={styles.usageAxisLabel}
            x={x(index)}
            y={height - 8}
            textAnchor={index === 0 ? "start" : index === period.series.length - 1 ? "end" : "middle"}
          >
            {formatBucketLabel(period.series[index]?.currentAt, period.bucketUnit)}
          </text>
        ))}
      </svg>
      <figcaption>
        Current total {period.current.totalTokens.toLocaleString("en-US")} tokens; previous total {period.previous.totalTokens.toLocaleString("en-US")} tokens.
      </figcaption>
      <details className={styles.usageDataTable}>
        <summary>View chart data</summary>
        <div>
          <table>
            <caption>Token consumption by {period.bucketUnit}</caption>
            <thead><tr><th scope="col">Current</th><th scope="col">Tokens</th><th scope="col">Previous</th><th scope="col">Tokens</th></tr></thead>
            <tbody>
              {period.series.map((point) => (
                <tr key={`${point.currentAt}-${point.previousAt}`}>
                  <th scope="row">{formatBucketLabel(point.currentAt, period.bucketUnit)}</th>
                  <td>{point.currentTotalTokens.toLocaleString("en-US")}</td>
                  <th scope="row">{formatBucketLabel(point.previousAt, period.bucketUnit)}</th>
                  <td>{point.previousTotalTokens.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function TokenComposition({ totals }: { totals: UsageTotals }) {
  const inputShare = tokenShare(totals.inputTokens, totals.totalTokens);
  const outputShare = tokenShare(totals.outputTokens, totals.totalTokens);
  return (
    <div className={styles.usageComposition} aria-label={`Token composition: ${inputShare}% input and ${outputShare}% output`}>
      <div><span style={{ width: `${inputShare}%` }} /><i style={{ width: `${outputShare}%` }} /></div>
      <p><span><i />Input {inputShare}%</span><span><i />Output {outputShare}%</span><small>{totals.totalTokens > 0 ? "Cached input is included in input tokens." : "No tracked tokens in this period."}</small></p>
    </div>
  );
}

function UsageBreakdown({
  title,
  description,
  items,
  totalTokens,
  showProvider = false,
}: {
  title: string;
  description: string;
  items: UsagePeriodSummary["providers"];
  totalTokens: number;
  showProvider?: boolean;
}) {
  const visible = items.slice(0, 6);
  return (
    <section className={styles.usageBreakdown}>
      <header><div><h3>{title}</h3><p>{description}</p></div><strong>{items.length}</strong></header>
      {visible.length ? (
        <ol>
          {visible.map((item, index) => {
            const share = tokenShare(item.totals.totalTokens, totalTokens);
            const providerCalls = item.totals.providerCalls ?? item.totals.modelCalls;
            return (
              <li key={item.id} data-color={index % 5}>
                <span className={styles.usageIdentity}>{item.label.slice(0, 2).toUpperCase()}</span>
                <div>
                  <p><strong>{item.label}</strong>{showProvider && item.provider ? <small>{item.provider}</small> : null}<span>{formatTokens(item.totals.totalTokens)} · {share}%</span></p>
                  <span className={styles.usageBar}><i style={{ width: `${share}%` }} /></span>
                  <small className={styles.usageItemCost}>
                    {formatTokens(item.totals.inputTokens)} context · {providerCalls.toLocaleString("en-US")} {providerCalls === 1 ? "call" : "calls"} · {formatBreakdownCost(item.totals)} · {item.totals.costCoveragePercent}% priced
                  </small>
                </div>
              </li>
            );
          })}
        </ol>
      ) : <p className={styles.usageMixEmpty}>No tracked model calls in this period.</p>}
      {items.length > visible.length ? <small className={styles.usageMore}>+{items.length - visible.length} more</small> : null}
    </section>
  );
}

function ProgressRing({ value, completed, total }: { value: number; completed: number; total: number }) {
  const circumference = 2 * Math.PI * 18;
  return <div className={styles["today-progress"]} aria-label={`${completed} of ${total} focus items completed`}><svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="18" /><circle className={styles["progress-value"]} cx="22" cy="22" r="18" style={{ strokeDasharray: circumference, strokeDashoffset: circumference * (1 - value) }} /></svg><span>{total ? `${Math.round(value * 100)}%` : "—"}</span></div>;
}

function TodayContextSection({
  icon: Icon,
  title,
  description,
  href,
  children,
}: {
  icon: typeof Workflow;
  title: string;
  description: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <section className={styles["today-context-section"]}>
      <div className={styles["today-context-heading"]}>
        <Icon size={18} aria-hidden="true" />
        <div><h2>{title}</h2><p>{description}</p></div>
        <Link href={href}>View all</Link>
      </div>
      <div className={styles["today-context-content"]}>{children}</div>
    </section>
  );
}

function ContextEmpty({ children }: { children: React.ReactNode }) {
  return <p className={styles["today-context-empty"]}>{children}</p>;
}

async function readJson(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(text(payload.message || payload.error, `${path} returned ${response.status}`));
  return record(payload);
}

function sourceData(summary: JsonRecord, source: string) {
  const value = record(record(record(summary).sources)[source]);
  return value.status === "ready" && Array.isArray(value.data) ? value.data.map(record) : [];
}

function sourceError(summary: JsonRecord, source: string) {
  const value = record(record(record(summary).sources)[source]);
  return value.status === "error" ? text(value.error, "Source unavailable.") : "";
}

function comparison(current: number, previous: number): {
  label: string;
  symbol: string;
  tone: "up" | "down" | "flat";
} {
  if (current === previous) return { label: "No change", symbol: "—", tone: "flat" };
  if (previous === 0) return { label: "New activity", symbol: "↑", tone: "up" };
  const percent = Math.abs((current - previous) / previous * 100);
  return current > previous
    ? { label: `${formatPercentage(percent)} higher`, symbol: "↑", tone: "up" }
    : { label: `${formatPercentage(percent)} lower`, symbol: "↓", tone: "down" };
}

function compactComparison(current: number, previous: number) {
  const delta = comparison(current, previous);
  return `${delta.symbol} ${delta.label}`;
}

function formatTokens(value: number) {
  if (value < 1_000) return Math.round(value).toLocaleString("en-US");
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value >= 1_000_000 ? 2 : 1,
  }).format(value);
}

function formatKnownCost(totals: UsageTotals) {
  const calls = totals.providerCalls ?? totals.modelCalls;
  if (!totals.knownCostCalls && calls) return "Unknown";
  const value = totals.knownEstimatedCostUsd;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 2,
  }).format(value);
}

function formatBreakdownCost(totals: UsageTotals) {
  return totals.knownCostCalls ? `${formatKnownCost(totals)} known cost` : "cost unknown";
}

function formatPercentage(value: number) {
  return `${value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function tokenShare(value: number, total: number) {
  return total > 0 ? Math.min(100, Math.max(0, Math.round(value / total * 100))) : 0;
}

function linePath(
  values: number[],
  x: (index: number) => number,
  y: (value: number) => number,
) {
  return values.map((value, index) => `${index ? "L" : "M"} ${x(index)} ${y(value)}`).join(" ");
}

function chartLabelIndexes(length: number) {
  if (!length) return [];
  return [...new Set([0, Math.round((length - 1) / 3), Math.round((length - 1) * 2 / 3), length - 1])];
}

function compactAxisValue(value: number) {
  return value >= 1_000 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value) : String(value);
}

function formatBucketLabel(value: string | undefined, unit: UsagePeriodSummary["bucketUnit"]) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return unit === "hour"
    ? date.toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })
    : "recently";
}

function agendaKindLabel(kind: TodayAgendaItem["kind"]) {
  return kind === "meeting" ? "Meeting" : kind === "commitment" ? "Commitment" : "Reminder";
}

function sourceLabel(source: TodayProjectionSourceState["source"]) {
  const labels: Record<TodayProjectionSourceState["source"], string> = {
    personal_reminders: "Personal reminders",
    meetings: "Meetings",
    commitments: "Commitments",
    approvals: "Approvals",
    active_agents: "Active agents",
    work: "Canonical work",
    consumption: "AI usage",
  };
  return labels[source];
}

function sourceStatusLabel(status: TodayProjectionSourceState["status"]) {
  const labels: Record<TodayProjectionSourceState["status"], string> = {
    ready: "Current",
    restricted: "Access limited",
    error: "Not available",
    hidden: "Hidden",
  };
  return labels[status];
}

function sectionLabel(section: TodaySectionKey) {
  const labels: Record<TodaySectionKey, string> = {
    focus: "Tasks and reminders",
    agenda: "Meetings and commitments",
    approvals: "Approvals",
    active_agents: "Active agents",
    work: "Canonical work",
    memory: "Memory",
    conversations: "Conversations",
    consumption: "AI usage",
  };
  return labels[section];
}

function record(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown, fallback = "") { return typeof value === "string" || typeof value === "number" ? String(value) : fallback; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Today could not be refreshed."; }
function localDayKey(value: Date | null, timezone: string) {
  if (!value || !Number.isFinite(value.getTime())) return "";
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value); }
  catch { return value.toISOString().slice(0, 10); }
}

function todayGreeting(value: Date | null, timezone: string) {
  if (!value) return "Welcome back";
  let hour = value.getHours();
  try { hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(value)); } catch { /* Device clock is a presentation fallback. */ }
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

function memoryPreview(content: string) {
  return /^\s*[\[{]/.test(content) ? "Saved context. Open Memory to read more." : content;
}

function friendlyLabel(value: string) {
  const known: Record<string, string> = { episodic: "Experience", semantic: "Knowledge", procedural: "How-to", preference: "Preference", working: "Current context", waiting_approval: "Waiting for your approval", waiting_clarification: "Waiting for your reply", running: "In progress", resuming: "Continuing" };
  const label = known[value] || value.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function TodayCompanion({ scope }: { scope?: string }) {
  const { portrait, observationRef, showPortrait } = useCompanionAtlasPlayer({ scope, presentation: companionPresentation({}), greeting: true });
  return <section ref={observationRef} className={styles.welcomeCompanion} aria-label="Your ATLAS companion" data-visible={showPortrait}>
    <CompanionAtlasPortrait {...portrait} className={styles.welcomePortrait} size="112px" />
    {showPortrait ? <span>ATLAS</span> : null}
  </section>;
}
function dueStateLabel(value?: TodayItem["reminderState"]) { return value === "overdue" ? " · overdue" : value === "due_soon" ? " · due soon" : ""; }
