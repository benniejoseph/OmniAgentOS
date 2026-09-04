import { beforeEach, describe, expect, it, vi } from "vitest";

const snapshotMocks = vi.hoisted(() => ({
  getTodayBriefBundle: vi.fn(),
  hasDatabaseUrl: vi.fn(() => false),
  listMemories: vi.fn(),
  listProjects: vi.fn(),
  listProjectTasks: vi.fn(),
  listThreads: vi.fn(),
  listTodayItems: vi.fn(),
  loadCachedTodaySnapshot: vi.fn(),
  loadPostgresTodaySnapshot: vi.fn(),
  runWithDatabaseTenantScope: vi.fn(
    (_tenantId: string, callback: () => unknown) => callback(),
  ),
}));

vi.mock("@/lib/db/client", () => ({
  hasDatabaseUrl: snapshotMocks.hasDatabaseUrl,
  runWithDatabaseTenantScope: snapshotMocks.runWithDatabaseTenantScope,
}));

vi.mock("@/lib/memory/store", () => ({
  listMemories: snapshotMocks.listMemories,
}));

vi.mock("@/lib/projects/store", () => ({
  listProjects: snapshotMocks.listProjects,
  listProjectTasks: snapshotMocks.listProjectTasks,
}));

vi.mock("@/lib/threads/store", () => ({
  listThreads: snapshotMocks.listThreads,
}));

vi.mock("@/lib/today/briefs", () => ({
  getTodayBriefBundle: snapshotMocks.getTodayBriefBundle,
}));

vi.mock("@/lib/today/postgres-snapshot", () => ({
  loadPostgresTodaySnapshot: snapshotMocks.loadPostgresTodaySnapshot,
}));

vi.mock("@/lib/today/snapshot-cache", () => ({
  loadCachedTodaySnapshot: snapshotMocks.loadCachedTodaySnapshot,
}));

vi.mock("@/lib/today/store", () => ({
  listTodayItems: snapshotMocks.listTodayItems,
}));

import { loadTodaySnapshot } from "@/lib/today/snapshot";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "snapshot-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const requestActorBinding = {
  version: 1 as const,
  kind: "auth_user" as const,
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

beforeEach(() => {
  snapshotMocks.getTodayBriefBundle.mockReset().mockResolvedValue({
    preferences: {
      tenantId: "tenant-a",
      actorId,
      briefEnabled: true,
      briefTime: "08:00",
      timezone: "UTC",
      reminderLeadMinutes: 30,
      notificationsEnabled: true,
      quietHoursEnabled: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:00.000Z",
    },
    brief: undefined,
    localDate: "2026-09-04",
    generationDue: false,
  });
  snapshotMocks.hasDatabaseUrl.mockReset().mockReturnValue(false);
  snapshotMocks.listMemories.mockReset().mockResolvedValue([]);
  snapshotMocks.listProjects.mockReset().mockResolvedValue([]);
  snapshotMocks.listProjectTasks.mockReset().mockResolvedValue([]);
  snapshotMocks.listThreads.mockReset().mockResolvedValue([]);
  snapshotMocks.listTodayItems.mockReset().mockResolvedValue([]);
  snapshotMocks.loadCachedTodaySnapshot.mockReset();
  snapshotMocks.loadPostgresTodaySnapshot.mockReset();
  snapshotMocks.runWithDatabaseTenantScope.mockClear();
});

describe("local Today snapshot", () => {
  it("threads the request actor binding into thread and project reads", async () => {
    await loadTodaySnapshot({
      tenantId: "tenant-a",
      actorId,
      now: new Date("2026-09-04T12:00:00.000Z"),
      requestActorBinding,
    });

    expect(snapshotMocks.listThreads).toHaveBeenCalledWith(6, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding,
    });
    expect(snapshotMocks.listProjects).toHaveBeenCalledWith(6, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding,
    });
    expect(snapshotMocks.loadPostgresTodaySnapshot).not.toHaveBeenCalled();
    expect(snapshotMocks.loadCachedTodaySnapshot).not.toHaveBeenCalled();
  });
});
