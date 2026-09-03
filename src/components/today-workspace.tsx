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
  FolderKanban,
  Layers3,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Sunrise,
  Workflow,
} from "lucide-react";
import { clsx } from "clsx";
import { IntentPrefetchLink as Link } from "@/components/app-shell/intent-prefetch-link";
import { useWorkspaceSession } from "@/components/app-shell/session-context";
import { useLiveRefresh } from "@/components/use-live-refresh";
import {
  formatTodayDue,
  formatTodayRelative,
  formatTodayTime,
} from "@/lib/today/presentation";
import type { TodaySnapshot } from "@/lib/today/snapshot";
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
const ACTIVE_WORK_REFRESH_INTERVAL_MS = 15_000;

const emptyPreferences: TodayPreferences = {
  briefEnabled: true,
  briefTime: "08:00",
  timezone: "UTC",
  reminderLeadMinutes: 30,
  notificationsEnabled: true,
  quietHoursEnabled: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
};

export function TodayWorkspace({
  initialToday,
  initialSummary,
  initialUsage,
}: {
  initialToday?: TodaySnapshot;
  initialSummary?: unknown;
  initialUsage?: UsageSummary;
}) {
  const { session, status: sessionStatus } = useWorkspaceSession();
  const hasInitialWorkspace = initialToday !== undefined && initialSummary !== undefined;
  const [today, setToday] = useState<TodaySnapshot>(initialToday || {
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
  const [summary, setSummary] = useState<JsonRecord>(() => record(initialSummary));
  const [usage, setUsage] = useState<UsageSummary | undefined>(initialUsage);
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriodKey>("day");
  const [usageLoading, setUsageLoading] = useState(!initialUsage);
  const [usageError, setUsageError] = useState<string>();
  const [todayError, setTodayError] = useState<string>();
  const [summaryError, setSummaryError] = useState<string>();
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
  const todayRequestRef = useRef<AbortController | null>(null);
  const summaryRequestRef = useRef<AbortController | null>(null);
  const usageRequestRef = useRef<AbortController | null>(null);
  const summaryRefreshRef = useRef<() => Promise<void>>(async () => undefined);
  const lastFullRefreshAtRef = useRef(
    initialToday?.generatedAt ? Date.parse(initialToday.generatedAt) : 0,
  );
  const briefAttemptRef = useRef("");
  const workspaceAvailable = Boolean(session && (!session.authEnabled || session.authenticated));

  const runs = sourceData(summary, "runs");
  const workflows = sourceData(summary, "workflows");
  const approvals = sourceData(summary, "approvals");
  const activeWork = [...runs, ...workflows].filter((item) =>
    ["running", "queued", "pending", "waiting_approval", "paused"].includes(
      text(item.status).toLowerCase(),
    ),
  );
  const visibleWork = activeWork.length
    ? activeWork
    : [...runs, ...workflows].slice(0, 5);
  const sourceErrors = ["runs", "workflows", "approvals"]
    .map((source) => ({ source, error: sourceError(summary, source) }))
    .filter((item) => item.error);

  const visibleItems = useMemo(() => {
    const day = localDayKey(now);
    return today.items.filter((item) =>
      item.status === "open" || localDayKey(item.completedAt ? new Date(item.completedAt) : null) === day
    );
  }, [now, today.items]);
  const completed = visibleItems.filter((item) => item.status === "done").length;
  const open = visibleItems.filter((item) => item.status === "open");
  const reminders = open.filter((item) => item.kind === "reminder");
  const progress = visibleItems.length ? completed / visibleItems.length : 0;
  const presentationTimezone = today.preferences.timezone;
  const relativeAsOf = now?.getTime() ?? Date.parse(today.generatedAt);

  function maybeGenerateBrief(nextToday: TodaySnapshot) {
    if (
      nextToday.briefGenerationDue &&
      briefAttemptRef.current !== nextToday.briefLocalDate
    ) {
      briefAttemptRef.current = nextToday.briefLocalDate || nextToday.generatedAt.slice(0, 10);
      void generateBrief(false);
    }
  }

  async function refreshToday() {
    if (sessionStatus !== "ready" || !workspaceAvailable) return;
    todayRequestRef.current?.abort();
    const controller = new AbortController();
    todayRequestRef.current = controller;
    try {
      const payload = await readJson("/api/today", { signal: controller.signal });
      if (controller.signal.aborted) return;
      const nextToday = payload as unknown as TodaySnapshot;
      setToday(nextToday);
      setTodayError(undefined);
      maybeGenerateBrief(nextToday);
    } catch (error) {
      if (!controller.signal.aborted) setTodayError(errorMessage(error));
    }
  }

  async function refreshSummary() {
    if (sessionStatus !== "ready" || !workspaceAvailable) return;
    summaryRequestRef.current?.abort();
    const controller = new AbortController();
    summaryRequestRef.current = controller;
    try {
      const payload = await readJson(
        "/api/workspace-summary?limit=16&approvalLimit=12",
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setSummary(record(payload.summary));
      setSummaryError(undefined);
    } catch (error) {
      if (!controller.signal.aborted) setSummaryError(errorMessage(error));
    }
  }

  async function refreshUsage() {
    if (sessionStatus !== "ready" || !workspaceAvailable) return;
    usageRequestRef.current?.abort();
    const controller = new AbortController();
    usageRequestRef.current = controller;
    setUsageLoading(true);
    try {
      const payload = await readJson("/api/usage/summary", {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const nextUsage = payload.summary;
      if (!isUsageSummary(nextUsage)) {
        throw new Error("Usage summary returned an invalid response.");
      }
      setUsage(nextUsage);
      setUsageError(undefined);
    } catch (error) {
      if (!controller.signal.aborted) setUsageError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setUsageLoading(false);
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
    void refreshUsage();
    try {
      await Promise.all([refreshToday(), refreshSummary()]);
      if (announce) setAnnouncement("Today refreshed.");
    } finally {
      if (showLoading) setLoading(false);
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
      todayRequestRef.current?.abort();
      summaryRequestRef.current?.abort();
      usageRequestRef.current?.abort();
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

  useEffect(() => {
    if (initialUsage || !hasInitialWorkspace || sessionStatus !== "ready" || !workspaceAvailable) return;
    const usageTimer = window.setTimeout(() => void refreshUsage(), 0);
    return () => window.clearTimeout(usageTimer);
    // Session identity is the automatic usage-load boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUsage, hasInitialWorkspace, sessionStatus, session]);

  useEffect(() => {
    summaryRefreshRef.current = refreshSummary;
  });

  useEffect(() => {
    if (!workspaceAvailable || activeWork.length === 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void summaryRefreshRef.current();
      }
    }, ACTIVE_WORK_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeWork.length, workspaceAvailable]);

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
        headers: { "content-type": "application/json" },
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      setToday((current) => ({
        ...current,
        items: current.items.map((candidate) =>
          candidate.id === item.id ? payload.item as TodayItem : candidate
        ),
      }));
      setAnnouncement(nextStatus === "done" ? "Focus item completed." : "Focus item reopened.");
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
        headers: { "content-type": "application/json" },
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify(today.preferences),
      });
      setToday((current) => ({ ...current, preferences: payload.preferences as TodayPreferences }));
      setAnnouncement("Daily brief schedule updated.");
    } catch (error) {
      setTodayError(errorMessage(error));
    } finally {
      setSavingSchedule(false);
    }
  }

  function updatePreference<Key extends keyof TodayPreferences>(key: Key, value: TodayPreferences[Key]) {
    setToday((current) => ({ ...current, preferences: { ...current.preferences, [key]: value } }));
  }

  return (
    <main
      className={clsx("today-shell workspace-enter", styles.shell)}
      data-testid="activity-workspace"
      data-hydrated={hydrated}
      aria-busy={loading}
    >
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      <header className="today-brief">
        <div className={styles.daylightArt} aria-hidden="true">
          <span className={styles.sun} />
          <span className={styles.sunRing} />
          <span className={styles.cloud} />
        </div>
        <div className="today-date" aria-hidden="true">
          <strong>{now ? now.toLocaleDateString(undefined, { day: "2-digit" }) : "--"}</strong>
          <span>{now ? now.toLocaleDateString(undefined, { month: "short", weekday: "short" }) : "Today"}</span>
        </div>
        <div className="today-intro">
          <p className="today-kicker">{greeting(now)}</p>
          <h1>Today</h1>
          <p>
            {open.length
              ? `${open.length} ${open.length === 1 ? "item needs" : "items need"} your attention. ${completed} completed today.`
              : completed
                ? `Everything is clear. You completed ${completed} ${completed === 1 ? "item" : "items"} today.`
                : "Everything is clear. Add a task or start new work when you are ready."}
          </p>
          <div className="today-operating-line" aria-label="Current workspace status">
            <span>
              <i className={clsx(activeWork.length && "is-active")} aria-hidden="true" />
              {activeWork.length
                ? `${activeWork.length} ${activeWork.length === 1 ? "run is" : "runs are"} active`
                : "No background work"}
            </span>
            <span>{approvals.length ? `${approvals.length} waiting for approval` : "No approvals waiting"}</span>
            <span>{reminders.length ? `${reminders.length} scheduled reminders` : "Schedule is clear"}</span>
          </div>
        </div>
        <div className="today-actions">
          <button type="button" onClick={() => void load({ force: true, showLoading: true, announce: true })} disabled={loading} className="today-icon-button" aria-label="Refresh Today">
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} aria-hidden="true" />
          </button>
          <Link href="/app/capture" className="action-link">Capture</Link>
          <Link href="/app/command" className="primary-button" aria-label="Start task">
            Start a task <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </header>

      {todayError || summaryError ? (
        <div className="today-error" role="alert">
          <strong>Some context is unavailable.</strong>
          <span>{[todayError, summaryError].filter(Boolean).join(" ")}</span>
        </div>
      ) : null}

      <section className="today-overview" aria-labelledby="today-overview-title">
        <div className={styles.dayArc} aria-hidden="true">
          <svg viewBox="0 0 1200 210" preserveAspectRatio="none">
            <path d="M18 176C250 48 398 27 601 28c202 1 364 28 581 148" />
          </svg>
          <span />
        </div>
        <div className="today-overview-heading">
          <div>
            <h2 id="today-overview-title">At a glance</h2>
            <p>Open any area to continue where you left off.</p>
          </div>
        </div>
        <div className="today-overview-list">
          <TodayOverviewLink
            icon={Circle}
            label="Open today"
            value={open.length}
            detail={`${completed} completed`}
            href="#today-focus"
          />
          <TodayOverviewLink
            icon={Workflow}
            label="Work in progress"
            value={activeWork.length}
            detail="Agents and workflows"
            href="/app/workflows"
          />
          <TodayOverviewLink
            icon={Bell}
            label="Approvals"
            value={approvals.length}
            detail="Waiting for review"
            href="/app/approvals"
            attention={approvals.length > 0}
          />
          <TodayOverviewLink
            icon={FolderKanban}
            label="Projects"
            value={today.projects?.length || 0}
            detail="Active projects in view"
            href="/app/projects"
          />
          <TodayOverviewLink
            icon={BrainCircuit}
            label="Memory"
            value={today.memories.length}
            detail="Recent memories in view"
            href="/app/memory"
          />
          <TodayOverviewLink
            icon={MessageSquareText}
            label="Conversations"
            value={today.threads.length}
            detail="Recent threads"
            href="/app/command"
          />
        </div>
      </section>

      <section className="today-generated-brief" aria-labelledby="daily-brief-title">
        <div className="today-brief-lead">
          <div className="today-brief-title-row">
            <div className="today-brief-mark" aria-hidden="true"><Sunrise size={21} /></div>
            <div>
              <p className="today-kicker">Plan for the day</p>
              <h2 id="daily-brief-title">Daily brief</h2>
            </div>
          </div>
          {today.brief ? (
            <>
              <p className="today-brief-summary">{today.brief.summary}</p>
              <div className="today-brief-meta">
                <span>{today.brief.generatedBy === "ai" ? "Synthesized by Asael" : "Built from your focus list"}</span>
                <span><time dateTime={today.brief.generatedAt}>{formatTodayTime(today.brief.generatedAt, presentationTimezone)}</time></span>
                <button type="button" onClick={() => void generateBrief(true)} disabled={generatingBrief}>
                  {generatingBrief ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />} Refresh
                </button>
              </div>
            </>
          ) : (
            <div className="today-brief-empty">
              <p>{generatingBrief ? "Reading your focus, memory, and recent work…" : "Generate a grounded view of what deserves your attention."}</p>
              <button type="button" onClick={() => void generateBrief(true)} disabled={generatingBrief}>
                {generatingBrief ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
                {generatingBrief ? "Preparing" : "Generate brief"}
              </button>
            </div>
          )}
        </div>

        <div className="today-brief-focus" aria-label="Brief priorities">
          <p className="today-brief-label">Priorities</p>
          {today.brief?.focus.length ? today.brief.focus.slice(0, 3).map((item, index) => (
            <div className="today-brief-priority" key={`${item.title}-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><strong>{item.title}</strong><p>{item.reason}</p></div>
            </div>
          )) : <p className="today-brief-placeholder">Your top priorities will appear here.</p>}
        </div>

        <div className="today-brief-side">
          <div>
            <p className="today-brief-label"><AlertTriangle size={12} aria-hidden="true" /> Risks and blockers</p>
            {today.brief?.watchouts.length ? today.brief.watchouts.slice(0, 2).map((item) => <p key={item} className="today-watchout">{item}</p>) : <p className="today-brief-placeholder">No risks or blockers found.</p>}
          </div>
          {today.brief?.resurfaced[0] ? <div className="today-resurfaced"><p className="today-brief-label">From your memory</p><strong>{today.brief.resurfaced[0].title}</strong><p>{today.brief.resurfaced[0].context}</p></div> : null}
          <details className="today-brief-schedule">
            <summary><Settings2 size={13} aria-hidden="true" /> Brief settings</summary>
            <form onSubmit={saveSchedule}>
              <label className="today-switch-row"><span>Automatic brief</span><input type="checkbox" checked={today.preferences.briefEnabled} onChange={(event) => updatePreference("briefEnabled", event.currentTarget.checked)} /></label>
              <label><span>Time</span><input type="time" value={today.preferences.briefTime} onChange={(event) => updatePreference("briefTime", event.currentTarget.value)} /></label>
              <label><span>Timezone</span><input value={today.preferences.timezone} onChange={(event) => updatePreference("timezone", event.currentTarget.value)} maxLength={120} /></label>
              <label><span>Remind me</span><select value={today.preferences.reminderLeadMinutes} onChange={(event) => updatePreference("reminderLeadMinutes", Number(event.currentTarget.value))}>
                <option value={5}>5 min before</option><option value={15}>15 min before</option><option value={30}>30 min before</option><option value={60}>1 hour before</option><option value={120}>2 hours before</option>
              </select></label>
              <button type="submit" disabled={savingSchedule}>{savingSchedule ? "Saving…" : "Save schedule"}</button>
            </form>
          </details>
        </div>
      </section>

      <section className="today-grid">
        <div className="today-focus" id="today-focus">
          <div className="today-section-heading">
            <div>
              <h2>Tasks and reminders</h2>
              <p className="today-section-copy">{open.length} open and {completed} completed today.</p>
            </div>
            <ProgressRing value={progress} completed={completed} total={visibleItems.length} />
          </div>

          <div className="today-capture-panel">
            <div className="today-capture-heading">
              <Plus size={17} aria-hidden="true" />
              <div><strong>Add to Today</strong><span>Create a task or reminder with an optional due time.</span></div>
            </div>
            <form className="today-capture-row" onSubmit={addItem}>
              <label className="today-capture-field today-capture-title">
                <span>What needs to happen?</span>
                <input aria-label="Add a focus item" id="today-item-title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="Write a clear task or reminder" maxLength={280} />
              </label>
              <label className="today-capture-field">
                <span>Type</span>
                <select aria-label="Item type" value={kind} onChange={(event) => setKind(event.currentTarget.value as TodayItem["kind"])}>
                  <option value="task">Task</option><option value="reminder">Reminder</option>
                </select>
              </label>
              <label className="today-capture-field">
                <span>Priority</span>
                <select aria-label="Priority" value={priority} onChange={(event) => setPriority(event.currentTarget.value as TodayItem["priority"])}>
                  <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                </select>
              </label>
              <label className="today-capture-field today-capture-due">
                <span>Due date and time</span>
                <input aria-label="Due time" id="today-due-at" name="dueAt" type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.currentTarget.value)} />
              </label>
              <button type="submit" disabled={saving || !title.trim()}>{saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : "Add"}</button>
            </form>
          </div>

          <div className="today-focus-list" aria-label="Focus items">
            {visibleItems.length ? visibleItems.map((item) => (
              <button key={item.id} type="button" onClick={() => void toggleItem(item)} className={clsx("today-focus-item", item.status === "done" && "is-done", item.reminderState && `is-${item.reminderState}`)}>
                <span className="today-check">{item.status === "done" ? <Check size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}</span>
                <span className="today-item-copy"><strong>{item.title}</strong><small>{item.kind}{item.dueAt ? ` · ${formatTodayDue(item.dueAt, presentationTimezone)}` : ""}{dueStateLabel(item.reminderState)}</small></span>
                <span className={clsx("today-priority", `priority-${item.priority}`)}>{item.priority}</span>
              </button>
            )) : (
              <div className="today-empty"><Sparkles size={20} aria-hidden="true" /><p>No tasks or reminders yet.</p><span>Add your first item above.</span></div>
            )}
          </div>
        </div>

        <aside className="today-agenda">
          <div className="today-section-heading compact"><div><h2>Schedule</h2><p className="today-section-copy">Reminders with a time appear here.</p></div></div>
          <div className="today-timeline">
            {reminders.length ? reminders.slice(0, 6).map((item) => (
              <div key={item.id} className={clsx("today-timeline-item", item.reminderState && `is-${item.reminderState}`)}><span>{item.dueAt ? formatTodayTime(item.dueAt, presentationTimezone) : "Anytime"}</span><div><strong>{item.title}</strong><small>{item.reminderState === "overdue" ? "Overdue" : item.reminderState === "due_soon" ? "Due soon" : `${item.priority} priority`}</small></div></div>
            )) : <div className="today-timeline-item"><span>Open</span><div><strong>No reminders scheduled</strong><small>Your timeline has room.</small></div></div>}
          </div>
          <div className="today-attention">
            <Bell size={15} aria-hidden="true" />
            <div>
              <strong>{approvals.length ? `${approvals.length} ${approvals.length === 1 ? "approval" : "approvals"} waiting` : "No approvals waiting"}</strong>
              <p>{approvals.length ? "Review consequential actions before they continue." : "There are no paused actions to review."}</p>
            </div>
            <Link href="/app/approvals">View</Link>
          </div>
        </aside>
      </section>

      <section className="today-context-grid">
        <TodayContextSection icon={Workflow} title="Work in progress" description="Agents and workflows currently active." href="/app/workflows">
          {visibleWork.length ? visibleWork.slice(0, 5).map((item, index) => (
            <Link key={text(item.id) || index} href={item.goal ? "/app/workflows" : "/app/command"} className="today-context-row">
              <span className="today-live-dot" /><div><strong>{text(item.goal || item.prompt, "Untitled work")}</strong><small>{text(item.status, "active").replaceAll("_", " ")}</small></div><ArrowRight size={14} aria-hidden="true" />
            </Link>
          )) : <ContextEmpty>Nothing is running in the background.</ContextEmpty>}
          {sourceErrors.map(({ source, error }) => (
            <details key={source} className="today-source-error">
              <summary><AlertTriangle size={12} aria-hidden="true" />Could not refresh {source}</summary>
              <p>{error}</p>
            </details>
          ))}
        </TodayContextSection>

        <TodayContextSection icon={FolderKanban} title="Projects" description="Progress and the next task in each active project." href="/app/projects">
          {today.projects?.length ? today.projects.map((project) => (
            <Link key={project.id} href="/app/projects" className="today-project-row"><div><strong>{project.title}</strong><p>{project.nextTask || project.objective}</p><span><i style={{ width: `${project.totalTasks ? project.completedTasks / project.totalTasks * 100 : 0}%` }} /></span></div><small>{project.completedTasks}/{project.totalTasks}</small></Link>
          )) : <ContextEmpty>Your active projects and next milestones will appear here.</ContextEmpty>}
        </TodayContextSection>

        <TodayContextSection icon={BrainCircuit} title="Memory" description="Recent knowledge Asael may use." href="/app/memory">
          {today.memories.length ? today.memories.slice(0, 4).map((memory) => (
            <Link key={memory.id} href="/app/memory" className="today-memory-row"><div><strong>{memory.title}</strong><p>{memory.content}</p></div><span>{memory.type}</span></Link>
          )) : <ContextEmpty>Capture a note and useful knowledge will resurface here.</ContextEmpty>}
        </TodayContextSection>

        <TodayContextSection icon={MessageSquareText} title="Conversations" description="Pick up where you left off." href="/app/command">
          {today.threads.length ? today.threads.slice(0, 5).map((thread) => (
            <Link key={thread.id} href={`/app/command?thread=${encodeURIComponent(thread.id)}`} className="today-context-row"><div><strong>{thread.title}</strong><small>{formatTodayRelative(thread.updatedAt, relativeAsOf)}</small></div><ArrowRight size={14} aria-hidden="true" /></Link>
          )) : <ContextEmpty>Your recent conversations will appear here.</ContextEmpty>}
        </TodayContextSection>
      </section>

      <UsageCockpit
        summary={usage}
        periodKey={usagePeriod}
        loading={usageLoading}
        error={usageError}
        onPeriodChange={setUsagePeriod}
        onRetry={() => void refreshUsage()}
      />
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
      <div className={styles.usageHalo} aria-hidden="true"><span /><span /><span /></div>
      <header className={styles.usageHeader}>
        <div>
          <p className={styles.usageKicker}><Activity size={14} aria-hidden="true" /> Consumption</p>
          <h2 id="usage-cockpit-title">AI consumption</h2>
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
              <small>tokens across {currentSourceStreams.toLocaleString()} distinct {currentSourceStreams === 1 ? "source" : "sources"}</small>
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
                value={currentProviderCalls.toLocaleString()}
                detail={`${compactComparison(currentProviderCalls, previousProviderCalls)} · ${(period.current.attempts ?? 0).toLocaleString()} attempts · ${(period.current.failedAttempts ?? 0).toLocaleString()} failed`}
              />
              <UsageMetric
                icon={Coins}
                label="Known est. cost"
                value={formatKnownCost(period.current)}
                detail={`${period.current.costCoveragePercent}% priced · previous ${formatKnownCost(period.previous)} · ${period.current.unknownCostCalls.toLocaleString()} unknown`}
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
        <title id={titleId}>Token consumption trend for {period.currentLabel}</title>
        <desc id={descriptionId}>
          {period.current.totalTokens.toLocaleString()} tokens in the current period, compared with {period.previous.totalTokens.toLocaleString()} in the previous equal period.
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
        Current total {period.current.totalTokens.toLocaleString()} tokens; previous total {period.previous.totalTokens.toLocaleString()} tokens.
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
                  <td>{point.currentTotalTokens.toLocaleString()}</td>
                  <th scope="row">{formatBucketLabel(point.previousAt, period.bucketUnit)}</th>
                  <td>{point.previousTotalTokens.toLocaleString()}</td>
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
  const outputShare = Math.max(0, 100 - inputShare);
  return (
    <div className={styles.usageComposition} aria-label={`Token composition: ${inputShare}% input and ${outputShare}% output`}>
      <div><span style={{ width: `${inputShare}%` }} /><i style={{ width: `${outputShare}%` }} /></div>
      <p><span><i />Input {inputShare}%</span><span><i />Output {outputShare}%</span><small>Cached input is included in input tokens.</small></p>
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
                    {formatTokens(item.totals.inputTokens)} context · {providerCalls.toLocaleString()} {providerCalls === 1 ? "call" : "calls"} · {formatBreakdownCost(item.totals)} · {item.totals.costCoveragePercent}% priced
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
  return <div className="today-progress" aria-label={`${completed} of ${total} focus items completed`}><svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="18" /><circle className="progress-value" cx="22" cy="22" r="18" style={{ strokeDasharray: circumference, strokeDashoffset: circumference * (1 - value) }} /></svg><span>{total ? `${Math.round(value * 100)}%` : "—"}</span></div>;
}

function TodayOverviewLink({
  icon: Icon,
  label,
  value,
  detail,
  href,
  attention = false,
}: {
  icon: typeof Workflow;
  label: string;
  value: number;
  detail: string;
  href: string;
  attention?: boolean;
}) {
  return (
    <Link href={href} className={clsx("today-overview-item", attention && "needs-attention")}>
      <span className="today-overview-icon"><Icon size={17} aria-hidden="true" /></span>
      <span className="today-overview-copy"><strong>{label}</strong><small>{detail}</small></span>
      <span className="today-overview-value">{value}</span>
      <ArrowRight size={14} aria-hidden="true" />
    </Link>
  );
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
    <section className="today-context-section">
      <div className="today-context-heading">
        <Icon size={18} aria-hidden="true" />
        <div><h2>{title}</h2><p>{description}</p></div>
        <Link href={href}>View all</Link>
      </div>
      <div className="today-context-content">{children}</div>
    </section>
  );
}

function ContextEmpty({ children }: { children: React.ReactNode }) {
  return <p className="today-context-empty">{children}</p>;
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

function isUsageSummary(value: unknown): value is UsageSummary {
  const candidate = record(value);
  const periods = record(candidate.periods);
  return typeof candidate.generatedAt === "string" &&
    ["day", "week", "month"].every((key) => {
      const period = record(periods[key]);
      return Array.isArray(period.series) &&
        Array.isArray(period.providers) &&
        Array.isArray(period.models) &&
        Boolean(period.current) &&
        Boolean(period.previous);
    });
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
  if (value < 1_000) return Math.round(value).toLocaleString();
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: value >= 1_000_000 ? 2 : 1,
  }).format(value);
}

function formatKnownCost(totals: UsageTotals) {
  const calls = totals.providerCalls ?? totals.modelCalls;
  if (!totals.knownCostCalls && calls) return "Unknown";
  const value = totals.knownEstimatedCostUsd;
  return new Intl.NumberFormat(undefined, {
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
  return value >= 1_000 ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value) : String(value);
}

function formatBucketLabel(value: string | undefined, unit: UsagePeriodSummary["bucketUnit"]) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return unit === "hour"
    ? date.toLocaleTimeString(undefined, { hour: "numeric" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : "recently";
}

function record(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown, fallback = "") { return typeof value === "string" || typeof value === "number" ? String(value) : fallback; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Today could not be refreshed."; }
function localDayKey(value: Date | null) { return value ? `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}` : ""; }
function greeting(now: Date | null) { if (!now) return "Today"; const hour = now.getHours(); return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"; }
function dueStateLabel(value?: TodayItem["reminderState"]) { return value === "overdue" ? " · overdue" : value === "due_soon" ? " · due soon" : ""; }
