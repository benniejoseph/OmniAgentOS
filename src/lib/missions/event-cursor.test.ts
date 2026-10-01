import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appendDomainEvent } from "@/lib/events/store";
import {
  MISSION_EVENT_SETTLE_MS,
  readStartingMissionEventCursor,
  settledMissionEventCursor,
  startingMissionEventCursor,
} from "@/lib/missions/event-cursor";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "asael-mission-cursor-"));
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  vi.useRealTimers();
});

const nowMs = Date.parse("2026-10-01T12:00:00.000Z");

function event(seq: number, ageMs: number) {
  return { seq, at: new Date(nowMs - ageMs).toISOString() };
}

describe("resuming a mission's events after a read", () => {
  it("moves past every event once it has settled", () => {
    expect(settledMissionEventCursor([
      event(4, 60_000),
      event(9, MISSION_EVENT_SETTLE_MS),
    ], 2, nowMs)).toBe(9);
  });

  it("stays before the first event too new to read past", () => {
    expect(settledMissionEventCursor([
      event(4, 60_000),
      event(9, MISSION_EVENT_SETTLE_MS - 1),
      event(12, 60_000),
    ], 2, nowMs)).toBe(4);
    expect(settledMissionEventCursor([
      event(9, 0),
    ], 2, nowMs)).toBe(2);
  });

  it("stays put when nothing was read", () => {
    expect(settledMissionEventCursor([], 7, nowMs)).toBe(7);
  });

  it("stays before an event whose time cannot be read", () => {
    expect(settledMissionEventCursor([
      event(4, 60_000),
      { seq: 9, at: "not a time" },
    ], 2, nowMs)).toBe(4);
  });
});

describe("starting a mission's events from a page read", () => {
  it("starts past the newest settled event of a short history", () => {
    expect(startingMissionEventCursor([
      event(9, 1_000),
      event(5, 60_000),
      event(3, 90_000),
    ], 100, nowMs)).toBe(5);
    expect(startingMissionEventCursor([
      event(9, 1_000),
      event(5, 2_000),
    ], 100, nowMs)).toBe(0);
    expect(startingMissionEventCursor([], 100, nowMs)).toBe(0);
  });

  it("starts just before a full window of new events", () => {
    expect(startingMissionEventCursor([
      event(9, 1_000),
      event(5, 2_000),
    ], 2, nowMs)).toBe(4);
    expect(startingMissionEventCursor([
      event(9, 1_000),
      event(5, 60_000),
    ], 2, nowMs)).toBe(5);
    expect(startingMissionEventCursor([
      event(1, 1_000),
    ], 1, nowMs)).toBe(0);
  });
});

describe("reading where a page starts a mission's events", () => {
  it("starts past the newest of the mission's own events that has settled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const owner = { tenantId: "tenant-cursor", actorId: "actor-cursor" };
    vi.setSystemTime(nowMs - 60_000);
    const first = await appendDomainEvent({
      ...owner,
      streamId: "mission:started",
      type: "mission.created",
    });
    const second = await appendDomainEvent({
      ...owner,
      streamId: "mission:started",
      type: "mission.step",
    });
    await appendDomainEvent({
      ...owner,
      streamId: "mission:elsewhere",
      type: "mission.step",
    });
    await appendDomainEvent({
      ...owner,
      actorId: "actor-other",
      streamId: "mission:started",
      type: "mission.step",
    });
    vi.setSystemTime(nowMs - 1_000);
    await appendDomainEvent({
      ...owner,
      streamId: "mission:started",
      type: "mission.step",
    });
    vi.setSystemTime(nowMs);

    expect(second.seq).toBeGreaterThan(first.seq);
    await expect(readStartingMissionEventCursor("started", owner)).resolves.toBe(second.seq);
    await expect(readStartingMissionEventCursor("missing", owner)).resolves.toBe(0);
  });
});
