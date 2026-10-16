# Availability watches

ATLAS can create a durable booking watch from a conversation using
`app.watches.create`, then inspect or stop it with `app.watches.show`,
`app.watches.list` and `app.watches.stop`. Web and native clients expose the
same owner-scoped state in **Watches**. Creating a watch schedules public reads
and one opening alert; it never buys tickets or reserves seats.

## Supported evidence

The first adapter reads public District cinema pages in India. Each watch binds
an exact cinema ID and page, cinema date, movie title (or explicit any-movie),
optional language, Gold or any seating, and inclusive local showtime bounds.
All showtimes use Asia/Kolkata. An unsupported website must be reported as a
specific capability gap, never represented as an active watch.

The reader fetches through the existing public HTTP transport and parses inert
server-rendered data. It requires the requested cinema/date state and fresh
provider time. Gold is matched against session seating, not a cinema's URL
slug. Bookable matches require positive seat availability and enabled booking.
Empty matching listings mean only that this source has no matching show; they
do not prove that every seller has closed bookings. HTTP failures, blocked
access, stale data and parsing changes produce an interrupted check, never a
false closed result. No browser JavaScript, account login or CAPTCHA bypass is
used. The dated provider page is the booking destination when no more precise
verified link is available.

## Durable execution

The existing worker fast lane enumerates a bounded set of due watch IDs and
enters each canonical owner's database scope. A leased
`availability.watch.check` job executes `web.availability.inspect` through the
governed tool executor. Network work happens outside the watch transaction.
Generation, current ownership, lease, expiry and pending-check identity are
checked again before the observation is committed.

Checks run every 1–60 minutes (5 by default), with bounded backoff after source
failures. A watch has a maximum check count and expires no later than the end
of its selected date, within a 31-day planning horizon. There are at most 20
active watches per owner. No model remains running between checks. The first
matching opening fulfills the watch and stops further reads. A stable opening
identity binds its notification; unchanged listings cannot create more opening
alerts. Stop advances the generation, revokes future work, and cancels pending
delivery while retaining prior receipts.

Saved configuration, current state, check receipts, last successful read, next
attempt, failure details and alert transport evidence are separately visible.
Create and stop support exact-request recovery with Idempotency-Key. A retry
must reuse its original request body and key until its outcome is known.

## Notifications

Availability notifications use their own source kind and decision policy. They
do not change the deliberately in-app-only Follow-up contract. One opening
creates one private Inbox entry and deduplicated delivery to eligible registered
devices. Owner preferences and quiet hours apply. Native clients below v60 do
not receive the new Inbox kind or its push delivery.

Queued delivery, provider acceptance, device receipt and opening are different
states. No eligible device or missing provider configuration must remain
visible. The owner-only Mac build has no production APNs entitlement, so a
closed-app Mac push cannot be promised. Its running primary app can use the
separate opt-in local-alert path; it polls for recorded watch alerts and
suppresses duplicates for the same account. Detection latency includes the
watch interval, source latency and notification delivery or app polling.

## Deployment

This feature introduces schema migration 259 and native contract v60. Deploy
the paired server/worker candidate before installing Mac 1.38.0 (112). Preserve
the previous public contract documents byte-for-byte. The migration adds
isolated watch storage and notification-kind support; it does not reset or
alter existing Follow-up state, comparisons, schedules or delivery receipts.
The Release Timeline remains stopped.

For the owner-directed release, test suites and audits are deferred. Record
compilation, signed builds, live source reads and required deployment checks
as their actual evidence. A current source read does not establish a later
scheduled opening or delivered alert; those require their own real receipts.
