"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bell,
  BellRing,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Loader2,
  MoonStar,
  Settings2,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { useWorkspaceSession } from "@/components/app-shell/session-context";

type NotificationStatus = "unread" | "read" | "snoozed" | "dismissed" | "acted";
type PersonalNotification = {
  id: string;
  title: string;
  urgency: "due_soon" | "overdue";
  status: NotificationStatus;
  dueAt: string;
  snoozedUntil?: string;
  updatedAt: string;
};
type NotificationPreferences = {
  notificationsEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string;
  reminderLeadMinutes: number;
};
type CenterPayload = {
  notifications: PersonalNotification[];
  unreadCount: number;
  quietHoursActive: boolean;
  preferences: NotificationPreferences;
  generatedAt: string;
};

const emptyPreferences: NotificationPreferences = {
  notificationsEnabled: true,
  quietHoursEnabled: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  timezone: "UTC",
  reminderLeadMinutes: 30,
};

const INITIAL_NOTIFICATION_REFRESH_DELAY_MS = 5_000;

export function NotificationCenter() {
  const { session, status: sessionStatus } = useWorkspaceSession();
  const [center, setCenter] = useState<CenterPayload>({
    notifications: [], unreadCount: 0, quietHoursActive: false,
    preferences: emptyPreferences, generatedAt: "",
  });
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const [desktopAlerts, setDesktopAlerts] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const knownUnreadRef = useRef(new Set<string>());
  const loadedOnceRef = useRef(false);
  const available = Boolean(session && (!session.authEnabled || session.authenticated));

  const attention = useMemo(() => center.notifications.filter((item) =>
    item.status === "unread" || item.status === "read" || item.status === "snoozed"
  ), [center.notifications]);
  const history = useMemo(() => center.notifications.filter((item) =>
    item.status === "acted" || item.status === "dismissed"
  ).slice(0, 8), [center.notifications]);

  async function load(options: { quiet?: boolean } = {}) {
    if (!available) return;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    if (!options.quiet) setLoading(true);
    try {
      const payload = await readJson("/api/notifications", {
        signal: controller.signal,
      }) as CenterPayload;
      if (controller.signal.aborted) return;
      const freshUnread = payload.notifications.filter((item) =>
        item.status === "unread" && !knownUnreadRef.current.has(item.id)
      );
      if (loadedOnceRef.current && desktopAlerts && typeof window !== "undefined" && window.Notification?.permission === "granted") {
        for (const item of freshUnread.slice(0, 3)) {
          new window.Notification(item.urgency === "overdue" ? "Reminder overdue" : "Reminder due soon", {
            body: item.title,
            tag: item.id,
          });
        }
      }
      knownUnreadRef.current = new Set(payload.notifications.filter((item) => item.status === "unread").map((item) => item.id));
      loadedOnceRef.current = true;
      setCenter(payload);
      setError(undefined);
    } catch (loadError) {
      if (!controller.signal.aborted) setError(message(loadError));
    } finally {
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    if (sessionStatus !== "ready" || !available) return;
    const stored = window.localStorage.getItem("omni-desktop-alerts") === "true";
    const initial = window.setTimeout(() => {
      setDesktopAlerts((current) =>
        current || (stored && window.Notification?.permission === "granted")
      );
      if (!loadedOnceRef.current && !loadControllerRef.current) void load();
    }, INITIAL_NOTIFICATION_REFRESH_DELAY_MS);
    const interval = window.setInterval(() => void load({ quiet: true }), 60_000);
    const onFocus = () => void load({ quiet: true });
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      loadControllerRef.current?.abort();
    };
    // Session identity controls the polling lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, session]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("button, input, select, summary")?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  async function act(item: PersonalNotification, action: "dismiss" | "snooze" | "complete") {
    setActingId(item.id);
    try {
      const payload = await readJson(`/api/notifications/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "snooze" ? { action, minutes: 15 } : { action }),
      });
      const notification = payload.notification as PersonalNotification;
      setCenter((current) => ({
        ...current,
        notifications: current.notifications.map((candidate) => candidate.id === item.id ? notification : candidate),
        unreadCount: Math.max(0, current.unreadCount - (item.status === "unread" ? 1 : 0)),
      }));
      setAnnouncement(action === "complete" ? "Reminder completed." : action === "snooze" ? "Reminder snoozed for 15 minutes." : "Reminder dismissed.");
    } catch (actionError) {
      setError(message(actionError));
    } finally {
      setActingId("");
    }
  }

  async function markAllRead() {
    try {
      await readJson("/api/notifications", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "read_all" }),
      });
      const now = new Date().toISOString();
      setCenter((current) => ({
        ...current,
        unreadCount: 0,
        notifications: current.notifications.map((item) => item.status === "unread" ? { ...item, status: "read", updatedAt: now } : item),
      }));
      setAnnouncement("All notifications marked as read.");
    } catch (actionError) {
      setError(message(actionError));
    }
  }

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    setSavingSettings(true);
    try {
      const payload = await readJson("/api/today/brief", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notificationsEnabled: center.preferences.notificationsEnabled,
          quietHoursEnabled: center.preferences.quietHoursEnabled,
          quietHoursStart: center.preferences.quietHoursStart,
          quietHoursEnd: center.preferences.quietHoursEnd,
          timezone: center.preferences.timezone,
          reminderLeadMinutes: center.preferences.reminderLeadMinutes,
        }),
      });
      setCenter((current) => ({ ...current, preferences: payload.preferences as NotificationPreferences }));
      setAnnouncement("Notification settings saved.");
    } catch (settingsError) {
      setError(message(settingsError));
    } finally {
      setSavingSettings(false);
    }
  }

  async function enableDesktopAlerts() {
    if (!("Notification" in window)) {
      setError("Desktop notifications are not supported by this browser.");
      return;
    }
    const permission = await window.Notification.requestPermission();
    const enabled = permission === "granted";
    setDesktopAlerts(enabled);
    window.localStorage.setItem("omni-desktop-alerts", String(enabled));
    setAnnouncement(enabled ? "Desktop alerts enabled while Asael is open." : "Desktop alerts remain disabled.");
  }

  function updatePreference<Key extends keyof NotificationPreferences>(key: Key, value: NotificationPreferences[Key]) {
    setCenter((current) => ({ ...current, preferences: { ...current.preferences, [key]: value } }));
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="notification-trigger"
        onClick={() => {
          setOpen(true);
          void load({ quiet: loadedOnceRef.current });
        }}
        aria-label={`Notifications${center.unreadCount ? `, ${center.unreadCount} unread` : ""}`}
        aria-expanded={open}
      >
        {center.unreadCount ? <BellRing size={17} aria-hidden="true" /> : <Bell size={17} aria-hidden="true" />}
        {center.unreadCount ? <span>{center.unreadCount > 9 ? "9+" : center.unreadCount}</span> : null}
      </button>

      {open && typeof document !== "undefined" ? createPortal((
        <div className="notification-layer">
          <button type="button" className="notification-scrim" onClick={() => { setOpen(false); buttonRef.current?.focus(); }} aria-label="Close notifications" tabIndex={-1} />
          <aside ref={panelRef} className="notification-panel" role="dialog" aria-modal="true" aria-labelledby="notification-title">
            <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
            <header className="notification-header">
              <div>
                <p>Attention stream</p>
                <h2 id="notification-title">Notifications</h2>
              </div>
              <div className="notification-header-actions">
                {center.unreadCount ? <button type="button" onClick={() => void markAllRead()}><CheckCheck size={14} aria-hidden="true" /> Mark read</button> : null}
                <button type="button" className="notification-close" onClick={() => { setOpen(false); buttonRef.current?.focus(); }} aria-label="Close notifications"><X size={18} aria-hidden="true" /></button>
              </div>
            </header>

            <div className="notification-status-line">
              <span className={clsx(center.quietHoursActive && "is-quiet")}><MoonStar size={13} aria-hidden="true" />{center.quietHoursActive ? `Quiet until ${center.preferences.quietHoursEnd}` : "Delivery active"}</span>
              <span>{center.unreadCount} unread</span>
            </div>

            <div className="notification-scroll">
              {error ? <div className="notification-error" role="alert">{error}<button type="button" onClick={() => { setError(undefined); void load(); }}>Retry</button></div> : null}
              {loading && !center.generatedAt ? <div className="notification-loading"><Loader2 size={17} className="animate-spin" aria-hidden="true" /> Checking your attention stream…</div> : null}

              <section className="notification-feed" aria-labelledby="notification-now">
                <div className="notification-section-title"><h3 id="notification-now">Now</h3><span>{attention.length}</span></div>
                {attention.length ? attention.map((item) => (
                  <article key={item.id} className={clsx("notification-item", `is-${item.status}`, `is-${item.urgency}`)}>
                    <div className="notification-dot" aria-hidden="true" />
                    <div className="notification-copy">
                      <div><strong>{item.title}</strong><span>{item.urgency === "overdue" ? "Overdue" : "Due soon"}</span></div>
                      <p>{item.status === "snoozed" && item.snoozedUntil ? `Snoozed until ${formatTime(item.snoozedUntil)}` : `Due ${formatDue(item.dueAt)}`}</p>
                      <div className="notification-actions">
                        <button type="button" onClick={() => void act(item, "complete")} disabled={actingId === item.id}><Check size={13} aria-hidden="true" /> Complete</button>
                        <button type="button" onClick={() => void act(item, "snooze")} disabled={actingId === item.id}><Clock3 size={13} aria-hidden="true" /> 15m</button>
                        <button type="button" onClick={() => void act(item, "dismiss")} disabled={actingId === item.id}>Dismiss</button>
                      </div>
                    </div>
                  </article>
                )) : <div className="notification-empty"><Bell size={19} aria-hidden="true" /><strong>Nothing needs you right now.</strong><p>Due reminders and agent attention requests will collect here.</p></div>}
              </section>

              <details className="notification-settings">
                <summary><span><Settings2 size={14} aria-hidden="true" /> Delivery settings</span><ChevronRight size={14} aria-hidden="true" /></summary>
                <form onSubmit={saveSettings}>
                  <label className="notification-toggle"><span><strong>Reminder delivery</strong><small>Surface due items in this stream.</small></span><input type="checkbox" checked={center.preferences.notificationsEnabled} onChange={(event) => updatePreference("notificationsEnabled", event.currentTarget.checked)} /></label>
                  <label className="notification-toggle"><span><strong>Quiet hours</strong><small>Hold new alerts until your quiet window ends.</small></span><input type="checkbox" checked={center.preferences.quietHoursEnabled} onChange={(event) => updatePreference("quietHoursEnabled", event.currentTarget.checked)} /></label>
                  <div className="notification-time-grid"><label><span>From</span><input type="time" value={center.preferences.quietHoursStart} onChange={(event) => updatePreference("quietHoursStart", event.currentTarget.value)} /></label><label><span>Until</span><input type="time" value={center.preferences.quietHoursEnd} onChange={(event) => updatePreference("quietHoursEnd", event.currentTarget.value)} /></label></div>
                  <label><span>Timezone</span><input value={center.preferences.timezone} onChange={(event) => updatePreference("timezone", event.currentTarget.value)} maxLength={120} /></label>
                  <label><span>Reminder lead</span><select value={center.preferences.reminderLeadMinutes} onChange={(event) => updatePreference("reminderLeadMinutes", Number(event.currentTarget.value))}><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={120}>2 hours</option></select></label>
                  <button type="submit" disabled={savingSettings}>{savingSettings ? "Saving…" : "Save settings"}</button>
                  <button type="button" className="notification-desktop-button" onClick={() => void enableDesktopAlerts()}>{desktopAlerts ? "Desktop alerts enabled" : "Enable desktop alerts"}<small>While Asael is open</small></button>
                </form>
              </details>

              {history.length ? <section className="notification-history" aria-labelledby="notification-history"><div className="notification-section-title"><h3 id="notification-history">Recent history</h3></div>{history.map((item) => <div key={item.id}><span className={item.status === "acted" ? "is-complete" : ""}>{item.status === "acted" ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}</span><p><strong>{item.title}</strong><small>{item.status === "acted" ? "Completed" : "Dismissed"} · {formatRelative(item.updatedAt)}</small></p></div>)}</section> : null}
            </div>
          </aside>
        </div>
      ), document.body) : null}
    </>
  );
}

async function readJson(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.message || payload.error || `${path} returned ${response.status}`));
  return payload as Record<string, unknown>;
}
function message(error: unknown) { return error instanceof Error ? error.message : "Notifications could not be updated."; }
function formatTime(value: string) { return new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function formatDue(value: string) { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function formatRelative(value: string) { const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000)); if (minutes < 60) return `${Math.max(1, minutes)}m ago`; const hours = Math.round(minutes / 60); return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`; }
