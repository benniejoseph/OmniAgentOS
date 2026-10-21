import { AVAILABILITY_WATCH_CONTRACT, AvailabilityWatchProjectionSchema, availabilityOpeningActionable } from "@/lib/availability-watches/contracts";

export type ForegroundNotice = {
  id: string;
  kind?: "reminder" | "responsibility_change" | "availability_watch";
  status: string;
};

/** The foreground path uses the same saved opening deadline as push delivery. */
export function isCurrentWatchAlert(notice: { id: string; sourceType?: string; sourceId?: string; occurrenceKey?: string },
  payload: Record<string, unknown>, now = new Date().toISOString()) {
  if (notice.sourceType !== "availability_watch" || payload.schemaVersion !== 1 || payload.contract !== AVAILABILITY_WATCH_CONTRACT) return false;
  const parsed = AvailabilityWatchProjectionSchema.safeParse(payload.watch);
  if (!parsed.success) return false;
  const watch = parsed.data;
  return watch.id === notice.sourceId && watch.openingId === notice.occurrenceKey &&
    watch.notification?.state === "recorded" && watch.notification.notificationId === notice.id &&
    availabilityOpeningActionable(watch, now);
}

/** Delivery bookkeeping is separate from the fetched Inbox projection. */
export class ForegroundAlerts {
  private initialized = false;
  private delivered = new Set<string>();

  private remember(id: string) {
    this.delivered.add(id);
    // Keep a bounded owner-local ledger across Inbox pagination changes. A
    // delivered notice disappearing from the current page is not a new event.
    if (this.delivered.size > 1_000) this.delivered.delete(this.delivered.values().next().value!);
  }

  async observe<T extends ForegroundNotice>(input: {
    notices: readonly T[];
    enabled: boolean;
    notificationsEnabled: boolean;
    quietHoursActive: boolean;
    signal: AbortSignal;
    verifyWatch: (notice: T, signal: AbortSignal) => Promise<boolean>;
    show: (notice: T) => void;
  }) {
    const unread = input.notices.filter(item => item.status === "unread");
    if (!this.initialized) {
      // Opening the app must not replay the existing Inbox as fresh alerts.
      for (const item of unread) this.remember(item.id);
      this.initialized = true;
      return;
    }
    if (!input.enabled || !input.notificationsEnabled || input.signal.aborted) return;
    let shown = 0;
    for (const item of unread) {
      if (shown >= 3 || input.signal.aborted) break;
      if (this.delivered.has(item.id) || item.kind === "responsibility_change") continue;
      // Confirmed booking openings bypass quiet hours, matching the server's
      // availability_opened policy. Account opt-out remains authoritative.
      if (item.kind !== "availability_watch" && input.quietHoursActive) continue;
      if (item.kind === "availability_watch" && !await input.verifyWatch(item, input.signal)) continue;
      if (input.signal.aborted) break;
      try {
        input.show(item);
        this.remember(item.id);
        shown += 1;
      } catch {
        // Browser refusal or temporary verification failure must not consume
        // an alert. Its unread record is eligible on the next successful read.
      }
    }
  }
}
