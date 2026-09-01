"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  AlertTriangle,
  Bell,
  BrainCircuit,
  Check,
  Circle,
  Loader2,
  MessageSquareText,
  FolderKanban,
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
}: {
  initialToday?: TodaySnapshot;
  initialSummary?: unknown;
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
      className="today-shell workspace-enter"
      data-testid="activity-workspace"
      data-hydrated={hydrated}
      aria-busy={loading}
    >
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      <header className="today-brief">
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
    </main>
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

function record(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown, fallback = "") { return typeof value === "string" || typeof value === "number" ? String(value) : fallback; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Today could not be refreshed."; }
function localDayKey(value: Date | null) { return value ? `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}` : ""; }
function greeting(now: Date | null) { if (!now) return "Today"; const hour = now.getHours(); return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"; }
function dueStateLabel(value?: TodayItem["reminderState"]) { return value === "overdue" ? " · overdue" : value === "due_soon" ? " · due soon" : ""; }
