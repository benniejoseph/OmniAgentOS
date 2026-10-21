import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AVAILABILITY_WATCH_CONTRACT,
  AVAILABILITY_WATCH_COVERAGE,
  AvailabilityWatchCheckSchema,
  AvailabilityWatchProjectionSchema,
} from "@/lib/availability-watches/contracts";
import { nativeAvailabilityWatchReadSchema } from "@/lib/mobile/availability-watch-contracts";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/availability-watches/service", () => ({ getAvailabilityWatch: mocks.read }));
import { GET } from "./route";

const context = {
  tenantId: "synthetic-watch-tenant", actorId: "watch-owner@example.test", role: "viewer", source: "session",
  auth: { userId: "00000000-0000-4000-8000-000000000001", email: "watch-owner@example.test" },
};
const id = `watch_${"a".repeat(48)}`;
const at = "2026-10-19T04:00:00.000Z";
const watch = AvailabilityWatchProjectionSchema.parse({
  schemaVersion: 1, id, revision: 1740, generation: 1, state: "expired",
  config: {
    source: { provider: "district", cinemaId: "123", cinemaName: "Synthetic cinema", sourceUrl: "https://www.district.in/movies/synthetic-cinema-CD123" },
    target: { date: "2026-10-19", timezone: "Asia/Kolkata", movieTitle: "Synthetic film", language: "Tamil", seatClass: "gold", earliestTime: null, latestTime: "12:00" },
    intervalMinutes: 5, expiresAt: "2026-10-19T06:30:00.000Z", maxChecks: 2000,
    notification: { destination: "owner_in_app", push: true, quietOnNoChange: true },
  },
  lastCheckedAt: at, lastSuccessfulAt: at, nextCheckAt: null, checksUsed: 1740, consecutiveFailures: 0,
  lastError: null, lastObservation: null, matches: [], openingId: null, notification: null, delivery: null,
  createdAt: "2026-10-13T04:00:00.000Z", updatedAt: at,
});

function serviceResult(hasMore: boolean) {
  const checks = Array.from({ length: hasMore ? 40 : 1 }, (_, index) => AvailabilityWatchCheckSchema.parse({
    id: `availability-check:${index.toString(16).padStart(64, "0")}`,
    generation: 1, scheduledFor: new Date(Date.parse(at) - index * 300_000).toISOString(),
    state: "completed", startedAt: at, finishedAt: at, observation: null, error: null, toolExecutionId: `synthetic-check-${index}`,
  }));
  const last = checks.at(-1)!;
  return {
    schemaVersion: 1, contract: AVAILABILITY_WATCH_CONTRACT, coverage: AVAILABILITY_WATCH_COVERAGE,
    watch, checks, hasMore,
    nextPage: hasMore ? { id, limit: 40, before: { scheduledFor: last.scheduledFor, id: last.id } } : null,
  };
}

describe("watch detail public response contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue(context);
  });

  it.each([true, false])("keeps internal pagination out of the strict public envelope (hasMore=%s)", async (hasMore) => {
    const result = serviceResult(hasMore);
    const original = structuredClone(result);
    mocks.read.mockResolvedValue(result);
    const request = new Request(`https://asael.example/api/availability-watches/${id}`);
    const response = await GET(request, { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith({ request, action: "read", resourceType: "availability_watch", resourceId: id });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(id, { tenantId: context.tenantId, actorId: `actor:${context.auth.userId}` });
    const body = await response.json();
    expect(nativeAvailabilityWatchReadSchema.parse(body)).toEqual(body);
    expect(Object.keys(body).sort()).toEqual(["checks", "contract", "coverage", "hasMore", "schemaVersion", "watch"]);
    expect(body).toEqual({
      schemaVersion: result.schemaVersion, contract: result.contract, coverage: result.coverage,
      watch: result.watch, checks: result.checks, hasMore,
    });
    // The shared service result remains intact for app.watches.show pagination.
    expect(result).toEqual(original);
    expect(result).toHaveProperty("nextPage", original.nextPage);
  });
});
