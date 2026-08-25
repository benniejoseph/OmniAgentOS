"use client";

import Link from "next/link";
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
import { useWorkspaceSession } from "@/components/app-shell/session-context";
import { useWorkspaceReadiness } from "@/components/app-shell/use-workspace-readiness";
import { WorkspaceReadinessCard } from "@/components/app-shell/workspace-readiness-card";
import { useLiveRefresh } from "@/components/use-live-refresh";

type JsonRecord = Record<string, unknown>;
type TodayItem = {
  id: string;
  title: string;
  kind: "task" | "reminder";
  priority: "low" | "medium" | "high";
  status: "open" | "done";
  dueAt?: string;
  completedAt?: string;
  createdAt: string;
  reminderState?: "none" | "overdue" | "due_soon" | "later";
};
type TodayPreferences = {
  briefEnabled: boolean;
  briefTime: string;
  timezone: string;
  reminderLeadMinutes: number;
  notificationsEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
};
type DailyBrief = {
  localDate: string;
  summary: string;
  focus: Array<{ title: string; reason: string }>;
  watchouts: string[];
  resurfaced: Array<{ title: string; context: string }>;
  generatedBy: "ai" | "system";
  model?: string;
  sourceCounts: { items: number; memories: number; threads: number; activeWork: number; projects: number };
  generatedAt: string;
};
type TodayPayload = {
  generatedAt: string;
  items: TodayItem[];
  threads: Array<{ id: string; title: string; updatedAt: string }>;
  memories: Array<{ id: string; title: string; content: string; type: string; updatedAt: string }>;
  brief?: DailyBrief;
  preferences: TodayPreferences;
  briefLocalDate?: string;
  briefGenerationDue: boolean;
  projects?: Array<{ id: string; title: string; objective: string; targetDate?: string; completedTasks: number; totalTasks: number; nextTask?: string }>;
};

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

export function TodayWorkspace() {
  const { session, status: sessionStatus } = useWorkspaceSession();
  const [today, setToday] = useState<TodayPayload>({ generatedAt: "", items: [], threads: [], memories: [], preferences: emptyPreferences, briefGenerationDue: false });
  const [summary, setSummary] = useState<JsonRecord>({});
  const [todayError, setTodayError] = useState<string>();
  const [summaryError, setSummaryError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generatingBrief, setGeneratingBrief] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<TodayItem["kind"]>("task");
  const [priority, setPriority] = useState<TodayItem["priority"]>("medium");
  const [dueAt, setDueAt] = useState("");
  const [announcement, setAnnouncement] = useState("Today is ready.");
  const [now, setNow] = useState<Date | null>(null);
  const loadRef = useRef<AbortController | null>(null);
  const briefAttemptRef = useRef("");
  const workspaceAvailable = Boolean(session && (!session.authEnabled || session.authenticated));
  const readiness = useWorkspaceReadiness({ enabled: workspaceAvailable });

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

  async function load() {
    if (sessionStatus !== "ready" || !workspaceAvailable) return;
    loadRef.current?.abort();
    const controller = new AbortController();
    loadRef.current = controller;
    setLoading(true);
    const [todayResult, summaryResult] = await Promise.allSettled([
      readJson("/api/today", { signal: controller.signal }),
      readJson("/api/workspace-summary?limit=16&approvalLimit=12", { signal: controller.signal }),
    ]);
    if (controller.signal.aborted) return;
    if (todayResult.status === "fulfilled") {
      const nextToday = todayResult.value as TodayPayload;
      setToday(nextToday);
      setTodayError(undefined);
      if (nextToday.briefGenerationDue && briefAttemptRef.current !== nextToday.briefLocalDate) {
        briefAttemptRef.current = nextToday.briefLocalDate || nextToday.generatedAt.slice(0, 10);
        void generateBrief(false);
      }
    } else {
      setTodayError(errorMessage(todayResult.reason));
    }
    if (summaryResult.status === "fulfilled") {
      setSummary(record(summaryResult.value.summary));
      setSummaryError(undefined);
    } else {
      setSummaryError(errorMessage(summaryResult.reason));
    }
    setLoading(false);
    setAnnouncement("Today refreshed.");
  }

  useEffect(() => {
    const clockTimer = window.setTimeout(() => setNow(new Date()), 0);
    const minuteTimer = window.setInterval(() => setNow(new Date()), 60_000);
    const loadTimer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearInterval(minuteTimer);
      window.clearTimeout(clockTimer);
      window.clearTimeout(loadTimer);
      loadRef.current?.abort();
    };
    // Session identity is the automatic load boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, session]);

  useLiveRefresh({
    enabled: workspaceAvailable,
    onRefresh: load,
    pollIntervalMs: activeWork.length ? 8_000 : undefined,
  });

  async function addItem(event: React.FormEvent) {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    setSaving(true);
    try {
      const payload = await readJson("/api/today", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: cleanTitle,
          kind,
          priority,
          dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
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
    <main className="today-shell workspace-enter" data-testid="activity-workspace" aria-busy={loading}>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      <header className="today-brief">
        <div className="today-date" aria-hidden="true">
          <strong>{now ? now.toLocaleDateString(undefined, { day: "2-digit" }) : "--"}</strong>
          <span>{now ? now.toLocaleDateString(undefined, { month: "short", weekday: "short" }) : "Today"}</span>
        </div>
        <div className="today-intro">
          <p className="today-kicker">{greeting(now)}</p>
          <h1>{open.length ? `${open.length} things deserve your attention.` : "Your field is clear."}</h1>
          <p>{briefLine(activeWork.length, approvals.length, reminders.length)}</p>
        </div>
        <div className="today-actions">
          <button type="button" onClick={() => void load()} disabled={loading} className="today-icon-button" aria-label="Refresh Today">
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} aria-hidden="true" />
          </button>
          <Link href="/app/capture" className="action-link">Capture</Link>
          <Link href="/app/command" className="primary-button" aria-label="Start task">
            Ask Asael <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </header>

      {workspaceAvailable ? <WorkspaceReadinessCard state={readiness.state} onRefresh={readiness.refresh} /> : null}
      {todayError || summaryError ? (
        <div className="today-error" role="alert">
          <strong>Some context is unavailable.</strong>
          <span>{[todayError, summaryError].filter(Boolean).join(" ")}</span>
        </div>
      ) : null}

      <section className="today-generated-brief" aria-labelledby="daily-brief-title">
        <div className="today-brief-lead">
          <div className="today-brief-title-row">
            <div className="today-brief-mark" aria-hidden="true"><Sunrise size={21} /></div>
            <div>
              <p className="today-kicker">Daily brief</p>
              <h2 id="daily-brief-title">A clear starting point</h2>
            </div>
          </div>
          {today.brief ? (
            <>
              <p className="today-brief-summary">{today.brief.summary}</p>
              <div className="today-brief-meta">
                <span>{today.brief.generatedBy === "ai" ? "Synthesized by Asael" : "Built from your focus list"}</span>
                <span>{formatTime(today.brief.generatedAt)}</span>
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
          <p className="today-brief-label">First moves</p>
          {today.brief?.focus.length ? today.brief.focus.slice(0, 3).map((item, index) => (
            <div className="today-brief-priority" key={`${item.title}-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><strong>{item.title}</strong><p>{item.reason}</p></div>
            </div>
          )) : <p className="today-brief-placeholder">Your top priorities will appear here.</p>}
        </div>

        <div className="today-brief-side">
          <div>
            <p className="today-brief-label"><AlertTriangle size={12} aria-hidden="true" /> Watch</p>
            {today.brief?.watchouts.length ? today.brief.watchouts.slice(0, 2).map((item) => <p key={item} className="today-watchout">{item}</p>) : <p className="today-brief-placeholder">Nothing urgent is hiding.</p>}
          </div>
          {today.brief?.resurfaced[0] ? <div className="today-resurfaced"><p className="today-brief-label">Resurfaced</p><strong>{today.brief.resurfaced[0].title}</strong><p>{today.brief.resurfaced[0].context}</p></div> : null}
          <details className="today-brief-schedule">
            <summary><Settings2 size={13} aria-hidden="true" /> Schedule</summary>
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
        <div className="today-focus">
          <div className="today-section-heading">
            <div><p className="today-kicker">Focus</p><h2>What moves today forward</h2></div>
            <ProgressRing value={progress} completed={completed} total={visibleItems.length} />
          </div>

          <form className="today-capture-row" onSubmit={addItem}>
            <Plus size={17} aria-hidden="true" />
            <label className="sr-only" htmlFor="today-item-title">Add a focus item</label>
            <input id="today-item-title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="Add a focus item..." maxLength={280} />
            <select aria-label="Item type" value={kind} onChange={(event) => setKind(event.currentTarget.value as TodayItem["kind"])}>
              <option value="task">Task</option><option value="reminder">Reminder</option>
            </select>
            <select aria-label="Priority" value={priority} onChange={(event) => setPriority(event.currentTarget.value as TodayItem["priority"])}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select>
            <label className="sr-only" htmlFor="today-due-at">Due time</label>
            <input id="today-due-at" type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.currentTarget.value)} />
            <button type="submit" disabled={saving || !title.trim()}>{saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : "Add"}</button>
          </form>

          <div className="today-focus-list" aria-label="Focus items">
            {visibleItems.length ? visibleItems.map((item) => (
              <button key={item.id} type="button" onClick={() => void toggleItem(item)} className={clsx("today-focus-item", item.status === "done" && "is-done", item.reminderState && `is-${item.reminderState}`)}>
                <span className="today-check">{item.status === "done" ? <Check size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}</span>
                <span className="today-item-copy"><strong>{item.title}</strong><small>{item.kind}{item.dueAt ? ` · ${formatDue(item.dueAt)}` : ""}{dueStateLabel(item.reminderState)}</small></span>
                <span className={clsx("today-priority", `priority-${item.priority}`)}>{item.priority}</span>
              </button>
            )) : (
              <div className="today-empty"><Sparkles size={20} aria-hidden="true" /><p>No focus items yet.</p><span>Add one above or ask Asael to help plan the day.</span></div>
            )}
          </div>
        </div>

        <aside className="today-agenda">
          <div className="today-section-heading compact"><div><p className="today-kicker">Agenda</p><h2>Time and attention</h2></div></div>
          <div className="today-timeline">
            {reminders.length ? reminders.slice(0, 6).map((item) => (
              <div key={item.id} className={clsx("today-timeline-item", item.reminderState && `is-${item.reminderState}`)}><span>{item.dueAt ? formatTime(item.dueAt) : "Anytime"}</span><div><strong>{item.title}</strong><small>{item.reminderState === "overdue" ? "Overdue" : item.reminderState === "due_soon" ? "Due soon" : `${item.priority} priority`}</small></div></div>
            )) : <div className="today-timeline-item"><span>Open</span><div><strong>No reminders scheduled</strong><small>Your timeline has room.</small></div></div>}
          </div>
          <div className="today-attention">
            <Bell size={15} aria-hidden="true" />
            <div><strong>{approvals.length} waiting for you</strong><p>Approvals and consequential actions remain paused.</p></div>
            <Link href="/app/approvals">Review</Link>
          </div>
        </aside>
      </section>

      <section className="today-context-grid">
        <TodayContextSection icon={Workflow} eyebrow="Live work" title="Agents and automations">
          {visibleWork.length ? visibleWork.slice(0, 5).map((item, index) => (
            <Link key={text(item.id) || index} href={item.goal ? "/app/workflows" : "/app/command"} className="today-context-row">
              <span className="today-live-dot" /><div><strong>{text(item.goal || item.prompt, "Untitled work")}</strong><small>{text(item.status, "active").replaceAll("_", " ")}</small></div><ArrowRight size={14} aria-hidden="true" />
            </Link>
          )) : <ContextEmpty>Nothing is running in the background.</ContextEmpty>}
          {sourceErrors.map(({ source, error }) => <p key={source} className="today-source-error">{source}: {error}</p>)}
        </TodayContextSection>

        <TodayContextSection icon={FolderKanban} eyebrow="Projects" title="Goals in motion">
          {today.projects?.length ? today.projects.map((project) => (
            <Link key={project.id} href="/app/projects" className="today-project-row"><div><strong>{project.title}</strong><p>{project.nextTask || project.objective}</p><span><i style={{ width: `${project.totalTasks ? project.completedTasks / project.totalTasks * 100 : 0}%` }} /></span></div><small>{project.completedTasks}/{project.totalTasks}</small></Link>
          )) : <ContextEmpty>Your active projects and next milestones will appear here.</ContextEmpty>}
        </TodayContextSection>

        <TodayContextSection icon={BrainCircuit} eyebrow="Resurface" title="Worth remembering">
          {today.memories.length ? today.memories.slice(0, 4).map((memory) => (
            <Link key={memory.id} href="/app/memory" className="today-memory-row"><div><strong>{memory.title}</strong><p>{memory.content}</p></div><span>{memory.type}</span></Link>
          )) : <ContextEmpty>Capture a note and useful knowledge will resurface here.</ContextEmpty>}
        </TodayContextSection>

        <TodayContextSection icon={MessageSquareText} eyebrow="Continue" title="Recent conversations">
          {today.threads.length ? today.threads.slice(0, 5).map((thread) => (
            <Link key={thread.id} href={`/app/command?thread=${encodeURIComponent(thread.id)}`} className="today-context-row"><div><strong>{thread.title}</strong><small>{formatRelative(thread.updatedAt)}</small></div><ArrowRight size={14} aria-hidden="true" /></Link>
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

function TodayContextSection({ icon: Icon, eyebrow, title, children }: { icon: typeof Workflow; eyebrow: string; title: string; children: React.ReactNode }) {
  return <section className="today-context-section"><div className="today-context-heading"><Icon size={16} aria-hidden="true" /><div><p>{eyebrow}</p><h2>{title}</h2></div></div><div className="today-context-content">{children}</div></section>;
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
function briefLine(active: number, approvals: number, reminders: number) { return `${active} active ${active === 1 ? "run" : "runs"}, ${approvals} awaiting approval, and ${reminders} ${reminders === 1 ? "reminder" : "reminders"} on your timeline.`; }
function formatTime(value: string) { return new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function formatDue(value: string) { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function formatRelative(value: string) { const delta = Date.now() - Date.parse(value); const minutes = Math.max(0, Math.round(delta / 60_000)); if (minutes < 60) return `${Math.max(1, minutes)}m ago`; const hours = Math.round(minutes / 60); return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`; }
function dueStateLabel(value?: TodayItem["reminderState"]) { return value === "overdue" ? " · overdue" : value === "due_soon" ? " · due soon" : ""; }
