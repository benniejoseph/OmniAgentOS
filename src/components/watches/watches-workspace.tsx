"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { canPerform, useWorkspaceSession } from "@/components/app-shell/session-context";
import { sessionResponsibilityOwner } from "@/components/responsibilities/model";
import { AvailabilityWatchCreateInputSchema, type AvailabilityWatchProjection } from "@/lib/availability-watches/contracts";
import { nativeAvailabilityWatchListSchema, nativeAvailabilityWatchReadSchema, nativeAvailabilityWatchMutationSchema } from "@/lib/mobile/availability-watch-contracts";
import type { z } from "zod";
import { WatchReadinessSchema, type WatchReadiness } from "@/lib/availability-watches/readiness-contracts";
import { BrowserAlerts } from "./browser-alerts";
import styles from "./watches.module.css";

type Detail = z.infer<typeof nativeAvailabilityWatchReadSchema>;
type Pending = { key: string; path: string; body: unknown };
const endpoint = "/api/availability-watches";
const states: Record<AvailabilityWatchProjection["state"], string> = {
  active: "Watching", degraded: "Checks interrupted", fulfilled: "Booking found", expired: "Expired", stopped: "Stopped", exhausted: "Check limit reached",
};
const time = (value: string | null) => value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value)) : "Not yet";
const title = (watch: AvailabilityWatchProjection) => `${watch.config.target.movieTitle ?? "Any movie"}${watch.config.target.language ? ` · ${watch.config.target.language}` : ""}`;

export function WatchesWorkspace({ id, deployment }: { id?: string; deployment: string }) {
  const { session, status, role } = useWorkspaceSession();
  const owner = sessionResponsibilityOwner(session);
  if (!owner) return <div className={styles.workspace}><h1>Watches</h1><p role="status">Sign in to see your availability watches.</p></div>;
  if (id && !/^watch_[a-f0-9]{48}$/.test(id)) return <div className={styles.workspace}><h1>Watch unavailable</h1><Link href="/app/watches">All watches</Link></div>;
  return <ScopedWatches key={JSON.stringify([deployment, owner, role, id])} ownerKey={JSON.stringify(owner)} id={id} active={status === "ready"} canManage={canPerform(role, "manage.workflow")} />;
}

function ScopedWatches({ id, active, canManage, ownerKey }: { id?: string; active: boolean; canManage: boolean; ownerKey:string }) {
  const [watches, setWatches] = useState<AvailabilityWatchProjection[]>();
  const [detail, setDetail] = useState<Detail>();
  const [readiness,setReadiness] = useState<WatchReadiness>();
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(40);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<Pending>();
  const lifecycle = useRef(0);
  const reading = useRef<AbortController | null>(null);
  const writing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async () => {
    if (!active || writing.current) return;
    const generation = lifecycle.current;
    reading.current?.abort(); const controller = new AbortController(); reading.current = controller;
    setLoading(true);
    try {
      const response = await fetch(id ? `${endpoint}/${encodeURIComponent(id)}` : `${endpoint}?limit=${limit}`, { cache: "no-store", signal: controller.signal });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(body));
      if (generation !== lifecycle.current || controller.signal.aborted) return;
      if (id) {
        const value = nativeAvailabilityWatchReadSchema.parse(body);
        if (value.watch.id !== id) throw new Error("The service returned a different watch. Reload to continue.");
        setDetail(value);
        const readinessResponse = await fetch(`${endpoint}/${encodeURIComponent(id)}/readiness`,{ cache:"no-store",signal:controller.signal });
        if (!readinessResponse.ok) throw new Error("Alert readiness could not be verified. Refresh to retry.");
        const readinessValue = WatchReadinessSchema.parse(await readinessResponse.json());
        if (generation !== lifecycle.current || controller.signal.aborted) return;
        setReadiness(readinessValue);
      } else {
        const value = nativeAvailabilityWatchListSchema.parse(body); setWatches(value.watches); setHasMore(value.hasMore);
      }
      setError(undefined);
    } catch (failure) {
      if (generation === lifecycle.current && !controller.signal.aborted) { setReadiness(undefined); setError(failure instanceof Error ? failure.message : "Watches could not be loaded."); }
    } finally { if (generation === lifecycle.current && !controller.signal.aborted) setLoading(false); }
  }, [active, id, limit]);
  useEffect(() => {
    const generation = ++lifecycle.current;
    queueMicrotask(() => { if (active && lifecycle.current === generation) void load(); });
    const timer = setInterval(() => { if (active && document.visibilityState === "visible") void load(); }, 30_000);
    return () => { lifecycle.current = generation + 1; reading.current?.abort(); clearInterval(timer); };
  }, [active, load]);
  async function submit(request: Pending) {
    if (!active || !canManage || writing.current) return;
    const generation = lifecycle.current; writing.current = true; reading.current?.abort();
    setSubmitting(true); setLoading(false); setPending(request); setError(undefined); setNotice(undefined);
    try {
      const response = await fetch(request.path, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": request.key }, body: JSON.stringify(request.body), cache: "no-store" });
      const body: unknown = await response.json();
      if (generation !== lifecycle.current) return;
      if (!response.ok) {
        if ([400, 401, 403, 404, 409, 413, 415].includes(response.status)) setPending(undefined);
        throw new Error(responseError(body));
      }
      const value = nativeAvailabilityWatchMutationSchema.parse(body);
      if (id && value.watch.id !== id) throw new Error("The service returned a different watch. Retry this exact request.");
      setPending(undefined); setCreating(false);
      if (id) setDetail((previous) => previous ? { ...previous, watch: value.watch } : previous);
      else setWatches((previous) => [value.watch, ...(previous ?? []).filter(watch => watch.id !== value.watch.id)]);
      setNotice(value.watch.state === "stopped" ? "Watch stopped. Future checks and undelivered alerts are canceled." : "Your watch is saved. Asael will check on the schedule shown below.");
    } catch (failure) {
      if (generation === lifecycle.current) setError(failure instanceof Error ? failure.message : "The result is uncertain. Retry the same request below.");
    } finally { writing.current = false; if (mounted.current) setSubmitting(false); }
  }
  const watch = detail?.watch;
  return <>
    {!active && <div className={styles.workspace}><h1>Watches</h1><p role="status">Checking your account access…</p></div>}
    <div className={styles.workspace} hidden={!active} inert={!active}>
      <header className={styles.header}><div><h1>{id ? "Availability watch" : "Watches"}</h1><p>Let Asael check for a booking and tell you when it finds a match.</p></div>
        {id ? <Link href="/app/watches">All watches</Link> : canManage && <button disabled={Boolean(pending) || creating} onClick={() => setCreating(true)}>New watch</button>}
      </header>
      <p className={styles.support}>Currently supports public District cinema listings across India. Checks continue when this app is closed. Alerts go to your Inbox and eligible registered devices, when account notifications and device permissions are enabled. Booking openings bypass Asael quiet hours. This private Mac build cannot receive alerts while fully closed.</p>
      {notice && <p role="status" className={styles.notice}>{notice}</p>}
      {error && <div role="alert" className={styles.notice}><p>{error}</p></div>}
      {pending && <div role="status" className={styles.notice}><p>{submitting ? "Saving your exact request…" : "The result of your request is uncertain."}</p>{!submitting && <button onClick={() => void submit(pending)}>Retry the same request</button>}</div>}
      {creating && <WatchForm disabled={submitting || Boolean(pending)} cancel={() => setCreating(false)} save={body => void submit({ key: crypto.randomUUID(), path: endpoint, body })} />}
      <div className={styles.actions}><button disabled={loading || submitting} onClick={() => void load()}>{loading ? "Refreshing…" : "Refresh"}</button><span className={styles.support}>All times are India Standard Time.</span></div>
      {!id && <section aria-label="Your watches">
        {!watches && loading && <p role="status">Loading watches…</p>}
        {watches?.length === 0 && <p>No watches yet. Ask ATLAS to monitor a booking, or create one here.</p>}
        <ul className={styles.list}>{watches?.map(item => <li key={item.id}><Link href={`/app/watches/${item.id}`}><strong>{title(item)}</strong></Link><p>{item.config.source.cinemaName} · {item.config.target.date} · {item.config.target.seatClass === "gold" ? "Gold" : "Any seating"}</p><p>{states[item.state]} · Last success: {time(item.lastSuccessfulAt)}{item.nextCheckAt ? ` · Next: ${time(item.nextCheckAt)}` : ""}</p></li>)}</ul>
        {hasMore && limit < 100 && <button onClick={() => setLimit(100)}>Show more recent watches</button>}
        {hasMore && limit === 100 && <p className={styles.support}>The most recent 100 watches are shown. Older watches remain available by their direct link.</p>}
      </section>}
      {watch && <>
        <section className={styles.section}><div className={styles.header}><h2>{title(watch)}</h2><strong>{states[watch.state]}</strong></div>
          <p>{watch.config.source.cinemaName} · {watch.config.target.date} · {watch.config.target.seatClass === "gold" ? "Gold seating" : "Any seating"}</p>
          <p>Show starts {watch.config.target.earliestTime ? `from ${watch.config.target.earliestTime}` : "at any time"}{watch.config.target.latestTime ? ` up to and including ${watch.config.target.latestTime}` : ""}.</p>
          <dl className={styles.metadata}>
            <div><dt>Checking interval</dt><dd>Every {watch.config.intervalMinutes} minute{watch.config.intervalMinutes === 1 ? "" : "s"}</dd></div>
            <div><dt>Next check</dt><dd>{watch.nextCheckAt ? time(watch.nextCheckAt) : ["active","degraded"].includes(watch.state) ? "Check queued or running" : "Checks finished"}</dd></div>
            <div><dt>Last attempt</dt><dd>{time(watch.lastCheckedAt)}</dd></div>
            <div><dt>Last successful check</dt><dd>{time(watch.lastSuccessfulAt)}</dd></div>
            <div><dt>Stops by</dt><dd>{time(watch.config.expiresAt)}</dd></div>
            <div><dt>Checks used</dt><dd>{watch.checksUsed} of {watch.config.maxChecks}</dd></div>
          </dl>
          {watch.lastError && <p role="status">Check interrupted: {watch.lastError.message}. Failed reads do not mean booking is closed.</p>}
          {watch.lastObservation && <p>{watch.lastObservation.outcome === "available" ? "A bookable matching show was found." : watch.lastObservation.outcome === "sold_out" ? "Matching shows are listed, but no bookable seats matched your conditions." : "This source does not currently list a matching show."} {watch.lastObservation.scope}</p>}
          <h3>Where and how Asael checks</h3>
          <p>{readiness?.method ?? "Asael reads the public District listing for this exact cinema and date and matches your saved conditions."}</p>
          <p>{readiness?.schedule ?? "Checks are periodic. Scheduler and source delays can extend the displayed interval."}</p>
          <p>Only District is checked. BookMyShow and PVR’s own website are not checked.</p>
          <a href={`${watch.config.source.sourceUrl}?fromdate=${watch.config.target.date}`} target="_blank" rel="noreferrer">Open the dated cinema listing</a>
          {canManage && !["stopped", "expired", "exhausted"].includes(watch.state) && <button disabled={submitting || Boolean(pending) || Boolean(error)} onClick={() => void submit({ key: crypto.randomUUID(), path: `${endpoint}/${watch.id}/stop`, body: { expectedRevision: watch.revision } })}>Stop watch and pending alert</button>}
        </section>
        {watch.matches.length > 0 && <section className={styles.section}><h2>Bookable shows found</h2><ul className={styles.list}>{watch.matches.map(match => <li key={`${match.sessionId}:${match.seatClass}`}><strong>{match.movieTitle} · {match.language} · {match.localTime}</strong><p>{match.seatClass} · {match.availableSeats} available seats when checked{match.price !== null ? ` · ₹${match.price}` : ""}</p><a href={match.bookingUrl} target="_blank" rel="noreferrer">View booking</a></li>)}</ul><p className={styles.support}>Availability can change before checkout. Asael has not booked or paid for tickets.</p></section>}
        <section className={styles.section}><h2>Alert</h2><p>{alertText(watch)}</p>
          {readiness && <><p>{readiness.alertPolicy}</p><p>Shared app and web Inbox: {readiness.inbox === "ready" ? "ready" : "notifications disabled"}. Android: {readiness.android.configured ? `${readiness.android.eligible} eligible device(s)` : "delivery needs configuration"}{readiness.android.needsUpdate ? `; ${readiness.android.needsUpdate} device(s) need an app update` : ""}. Browser: {readiness.browser.eligible} eligible registration(s).</p>
            <p>Browser delivery: {readiness.browser.queued} queued · {readiness.browser.accepted} accepted by provider · {readiness.browser.received} displayed · {readiness.browser.opened} opened · {readiness.browser.failed} failed.</p>
            {!readiness.android.eligible && <p>Open the current Asael Android app, sign in and allow notifications to enable phone alerts.</p>}</>}
          {watch.delivery && <><p>{watch.delivery.eligibleDevices} registered device{watch.delivery.eligibleDevices === 1 ? "" : "s"} eligible for alerts. APNs: {watch.delivery.providers.apns.replaceAll("_", " ")}; Android delivery: {watch.delivery.providers.fcm.replaceAll("_", " ")}.</p>
            <p>Queued: {watch.delivery.queued} · Sending: {watch.delivery.running} · Accepted by provider: {watch.delivery.providerAccepted} · Received on device: {watch.delivery.received} · Opened: {watch.delivery.opened} · Failed: {watch.delivery.failed}</p></>}
          {watch.notification?.notificationId && <Link href={`/app/approvals?notificationId=${encodeURIComponent(watch.notification.notificationId)}`}>Open Inbox</Link>}</section>
        <details><summary>Recent check evidence</summary><ul className={styles.list}>{detail.checks.map(check => <li key={check.id}><strong>{time(check.scheduledFor)} · {check.state}</strong><p>{check.error?.message ?? (check.observation ? `${check.observation.outcome.replaceAll("_", " ")} · ${check.observation.matches.length} bookable matches` : "Waiting for a source result")}</p></li>)}</ul>{detail.hasMore && <p>Older checks are outside this recent view.</p>}</details>
      </>}
      <BrowserAlerts active={active} ownerKey={ownerKey} />
    </div>
  </>;
}

function alertText(watch: AvailabilityWatchProjection) {
  const alert = watch.notification;
  if (!alert) return "One alert is prepared when a matching bookable show is first observed. No repeated alerts for unchanged listings.";
  if (alert.state === "recorded") return `Saved in your Inbox.${alert.pushDeliveryIds.length ? " Device deliveries were queued; this alone does not confirm that a device received them." : " No device delivery was queued."}`;
  return ({ pending: "Opening detected. Alert delivery is pending.", held: "Opening detected. Alert is held by your notification preferences.", disabled: "Opening detected. Notifications are disabled for this account.", expired: "The pending alert expired.", canceled: "The pending alert was canceled." } as const)[alert.state];
}

function responseError(body: unknown) {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error.slice(0, 500);
  return "The watch request could not be completed. Refresh or retry the same request.";
}

function WatchForm({ disabled, save, cancel }: { disabled: boolean; save: (body: unknown) => void; cancel: () => void }) {
  const [error, setError] = useState<string>();
  const [anyMovie, setAnyMovie] = useState(false);
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(undefined); const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const url = text("url"); const cinemaId = /-CD([1-9]\d*)$/.exec(url)?.[1] ?? "";
    const value = AvailabilityWatchCreateInputSchema.safeParse({
      source: { provider: "district", cinemaId, cinemaName: text("cinema"), sourceUrl: url },
      target: { date: text("date"), timezone: "Asia/Kolkata", movieTitle: anyMovie ? null : text("movie"), language: text("language") || null, seatClass: text("seating"), earliestTime: text("from") || null, latestTime: text("until") || null },
      intervalMinutes: Number(text("interval")),
    });
    if (!value.success) { setError(value.error.issues[0]?.message ?? "Check the watch details."); return; }
    save(value.data);
  }
  return <form className={styles.section} onSubmit={onSubmit}><h2>New booking watch</h2><fieldset disabled={disabled} className={styles.stack}>
    <label>Cinema name<input name="cinema" required maxLength={180} defaultValue="PVR VR, Whitefield Road, Bengaluru" /></label>
    <label>District cinema page<input name="url" required type="url" maxLength={500} defaultValue="https://www.district.in/movies/pvr-vr-whitefield-road-bengaluru-CD1022272" /><small>Use the public cinema page without a date query. Other booking sites are not yet supported.</small></label>
    <div className={styles.grid}><label>Movie<input name="movie" required={!anyMovie} disabled={anyMovie} maxLength={180} placeholder="Movie title" /></label><label>Language<input name="language" maxLength={60} placeholder="Any language" /></label></div>
    <label className={styles.check}><input type="checkbox" checked={anyMovie} onChange={event => setAnyMovie(event.target.checked)} /> Any movie at this cinema</label>
    <div className={styles.grid}><label>Cinema date<input name="date" required type="date" /></label><label>Seating<select name="seating" defaultValue="gold"><option value="gold">Gold</option><option value="any">Any seating</option></select></label><label>Earliest show start<input name="from" type="time" /></label><label>Latest show start (inclusive)<input name="until" type="time" /></label><label>Check every<select name="interval" defaultValue="5"><option value="1">1 minute</option><option value="2">2 minutes</option><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option></select></label></div>
    <p className={styles.support}>Stops after the first match or at the end of the selected date, within 31 days. Booking openings bypass Asael quiet hours; account notifications-off and device permissions still apply. Checks require no repeated approval.</p>
    {error && <p role="alert">{error}</p>}<div className={styles.actions}><button type="submit" className={styles.primary}>Start watch</button><button type="button" onClick={cancel}>Cancel</button></div>
  </fieldset></form>;
}
