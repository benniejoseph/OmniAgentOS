import { listStreamEvents } from "@/lib/events/store";

/**
 * Event sequence numbers come from one global counter and are taken before
 * the transaction that holds them commits, so a newer event can be readable
 * while an older one is still committing. A cursor kept before events this
 * new lets a later read pick the older one up.
 */
export const MISSION_EVENT_SETTLE_MS = 10_000;

/** How many of a mission's newest events a page reads to start from. */
const MISSION_EVENT_START_WINDOW = 100;

type MissionEventPosition = { seq: number; at: string };

/**
 * Where the next read may resume, given the events read oldest first after
 * `afterSeq` at `nowMs`: after the last event that has settled along with
 * every event before it.
 */
export function settledMissionEventCursor(
  events: readonly MissionEventPosition[],
  afterSeq: number,
  nowMs: number,
) {
  let cursor = afterSeq;
  for (const event of events) {
    if (!(Date.parse(event.at) <= nowMs - MISSION_EVENT_SETTLE_MS)) break;
    cursor = event.seq;
  }
  return cursor;
}

/**
 * Where a page that has just read a mission starts reading its events, given
 * the newest `windowSize` of them, newest first, read at `nowMs`.
 */
export function startingMissionEventCursor(
  newestFirst: readonly MissionEventPosition[],
  windowSize: number,
  nowMs: number,
) {
  const oldestFirst = [...newestFirst].reverse();
  // A full window starts just before its oldest event. It can miss only an
  // older event still committing behind a whole window of new ones.
  const afterSeq = oldestFirst.length < windowSize
    ? 0
    : oldestFirst[0].seq - 1;
  return settledMissionEventCursor(oldestFirst, afterSeq, nowMs);
}

/** Where a page that has just read a mission starts reading its events. */
export async function readStartingMissionEventCursor(
  missionId: string,
  owner: { tenantId: string; actorId: string },
) {
  // Taken before the read: an event judged settled was at least that old
  // when the read saw the log.
  const nowMs = Date.now();
  const newestFirst = await listStreamEvents(`mission:${missionId}`, {
    ...owner,
    limit: MISSION_EVENT_START_WINDOW,
    order: "desc",
  });
  return startingMissionEventCursor(
    newestFirst,
    MISSION_EVENT_START_WINDOW,
    nowMs,
  );
}
