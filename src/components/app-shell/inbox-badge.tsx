"use client";

import { Inbox } from "lucide-react";
import { clsx } from "clsx";
import { IntentPrefetchLink as Link } from "@/components/app-shell/intent-prefetch-link";
import { inboxBadgeLabel } from "@/lib/approvals/inbox-link";

export const INBOX_HREF = "/app/approvals";

/** The count a navigation item shows: the inbox's on the Inbox, none elsewhere. */
export function navBadgeLabel(href: string, count: number | undefined) {
  return href === INBOX_HREF ? inboxBadgeLabel(count) : "";
}

/** The count a collapsed navigation group shows for the items it hides. */
export function navGroupBadgeLabel(items: readonly { href: string }[], count: number | undefined) {
  return items.some((item) => item.href === INBOX_HREF) ? inboxBadgeLabel(count) : "";
}

/** The accessible name of a navigation item that carries a count. */
export function navItemAccessibleName(label: string, badge: string) {
  return badge ? `${label}, ${badge} waiting` : label;
}

/**
 * The way into the inbox from the header, shown while something waits in it
 * and you are not already there.
 */
export function InboxHeaderLink({ count, pathname }: { count?: number; pathname: string }) {
  const badge = inboxBadgeLabel(count);
  if (!badge || pathname === INBOX_HREF || pathname.startsWith(`${INBOX_HREF}/`)) {
    return null;
  }
  return (
    <Link
      href={INBOX_HREF}
      className="notification-trigger"
      aria-label={navItemAccessibleName("Inbox", badge)}
      title="Inbox"
    >
      <Inbox size={17} aria-hidden="true" />
      <span aria-hidden="true">{badge}</span>
    </Link>
  );
}

/**
 * The count beside a navigation label, or on the corner of an icon when the
 * navigation is compact. Its words are in the link's name.
 */
export function NavCountPill({
  badge,
  active = false,
  compact = false,
}: {
  badge: string;
  active?: boolean;
  compact?: boolean;
}) {
  if (!badge) {
    return null;
  }
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 justify-center rounded-full font-semibold tabular-nums",
        compact
          ? "absolute right-1 top-1 min-w-4 px-1 text-xs leading-4"
          : "min-w-5 px-1.5 text-xs leading-5",
        active ? "bg-primary-ink text-primary" : "bg-primary text-primary-ink",
      )}
      aria-hidden="true"
      data-nav-count={badge}
    >
      {badge}
    </span>
  );
}
