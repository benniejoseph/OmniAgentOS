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
devices and opted-in browsers. Account notifications-off still applies. Booking
openings are explicitly time-sensitive and bypass Asael quiet hours without being
labeled a critical security event; other notification kinds retain their policy.
OS Do Not Disturb, connectivity and provider delays can still delay an alert.
Native clients below v60 do
not receive the new Inbox kind or its push delivery.

Queued delivery, provider acceptance, device receipt and opening are different
states. No eligible device or missing provider configuration must remain
visible. The owner-only Mac build has no production APNs entitlement, so a
closed-app Mac push cannot be promised. Its running primary app can use the
separate opt-in local-alert path; it polls for recorded watch alerts and
suppresses duplicates for the same account. Detection latency includes the
watch interval, source latency and notification delivery or app polling.

The readiness read (`GET /api/availability-watches/{id}/readiness`, native v61)
and Atlas's governed `app.watches.show` expose the exact dated URL, adapter method,
periodic-check limits, Inbox state, eligible Android/browser registrations and
browser receipts. No eligible device is a blocker to phone delivery, even when
FCM is configured. Older native clients retain the unchanged v60 watch payload.

Browser alerts are opt-in on Watches. The server seals subscriptions in its
credential vault and binds them to one tenant, canonical owner and web session.
An outbox row is co-committed with the same Inbox entry. The existing scheduler
claims bounded leases, checks live session/account/preferences/watch state and
sends encrypted Web Push through an allowlisted public HTTPS transport. Provider
acceptance is not browser display: the service worker reauthorizes the opaque
receipt ID on this origin before showing a generic alert and recording receipt.
Signing out, stopping a watch, expiry and disabling account notifications prevent
new presentation. Test alerts are labeled and never create booking evidence.

Configure `OMNIAGENT_WEB_PUSH_PUBLIC_KEY`, `OMNIAGENT_WEB_PUSH_PRIVATE_KEY` and
`OMNIAGENT_WEB_PUSH_SUBJECT` (an HTTPS site or mailto contact) on the web server.
Generate one VAPID keypair outside the checkout and retain it securely; rotating
it requires browser re-enrollment. No endpoint, key or private preview enters
logs, events or client readiness projections.

## Deployment

The initial feature introduced schema259/native v60. The delivery repair adds
schema260 (browser subscriptions/outbox and the missing availability-opened
disposition reason), native v61, and Mac/Android 1.39.0 (113). Deploy the paired
server/worker candidate before installing the new native builds. Preserve the
previous public contract documents byte-for-byte. Existing watch IDs, saved
conditions, baselines and Follow-up records are retained. The Release Timeline
remains stopped.

Validate the changed task-owner lookup, alert policy, transport receipts and
actual database transitions before promotion. Use synthetic isolated records
for an opening that has not occurred. Do not force a real watch, modify its
baseline or present test data as a booking. Reuse unchanged parser evidence.
After release, verify Atlas can retrieve its existing specialist result, inspect
the real watch/readiness through Asael, and deliver labeled device/browser test
alerts. A source read or provider acknowledgment alone is not a delivered alert.
