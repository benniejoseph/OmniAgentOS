import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { updateTodayPreferences } from "@/lib/today/briefs";
import {
  getNotificationCenter,
  isQuietHoursActive,
  listNotifications,
  processDueNotifications,
  updatePersonalNotification,
} from "@/lib/today/notifications";
import { createTodayItem, listTodayItems } from "@/lib/today/store";

describe("personal notification center", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(os.tmpdir(), "omni-notifications-"),
    );
  });

  it("handles quiet hours that cross midnight", async () => {
    const preferences = await updateTodayPreferences({
      timezone: "UTC",
      quietHoursEnabled: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
    }, { tenantId: "personal", actorId: "owner" });

    expect(isQuietHoursActive(preferences, new Date("2026-08-25T23:00:00.000Z"))).toBe(true);
    expect(isQuietHoursActive(preferences, new Date("2026-08-26T06:59:00.000Z"))).toBe(true);
    expect(isQuietHoursActive(preferences, new Date("2026-08-26T07:00:00.000Z"))).toBe(false);
  });

  it("delivers once, snoozes, and reopens the same reminder occurrence", async () => {
    await updateTodayPreferences({
      timezone: "UTC",
      quietHoursEnabled: false,
      notificationsEnabled: true,
      reminderLeadMinutes: 30,
    }, { tenantId: "personal", actorId: "owner" });
    await createTodayItem({
      tenantId: "personal",
      actorId: "owner",
      title: "Send the launch note",
      kind: "reminder",
      dueAt: "2026-08-25T09:15:00.000Z",
    });
    const firstNow = new Date("2026-08-25T09:00:00.000Z");
    await processDueNotifications({ tenantId: "personal", actorId: "owner", now: firstNow });
    await processDueNotifications({ tenantId: "personal", actorId: "owner", now: firstNow });
    const [notification] = await listNotifications(10, { tenantId: "personal", actorId: "owner" });
    expect(notification).toMatchObject({ title: "Send the launch note", status: "unread", urgency: "due_soon" });
    await expect(listNotifications(10, { tenantId: "personal", actorId: "owner" })).resolves.toHaveLength(1);

    const snoozed = await updatePersonalNotification(notification.id, "snooze", {
      tenantId: "personal", actorId: "owner", snoozeMinutes: 15, now: firstNow,
    });
    expect(snoozed?.status).toBe("snoozed");
    await processDueNotifications({
      tenantId: "personal", actorId: "owner", now: new Date("2026-08-25T09:10:00.000Z"),
    });
    expect((await listNotifications(10, { tenantId: "personal", actorId: "owner" }))[0].status).toBe("snoozed");
    await processDueNotifications({
      tenantId: "personal", actorId: "owner", now: new Date("2026-08-25T09:15:00.000Z"),
    });
    expect((await listNotifications(10, { tenantId: "personal", actorId: "owner" }))[0]).toMatchObject({ status: "unread", urgency: "overdue" });
  });

  it("keeps interactive notification reads separate from reminder generation", async () => {
    await updateTodayPreferences({
      timezone: "UTC",
      quietHoursEnabled: false,
      notificationsEnabled: true,
      reminderLeadMinutes: 30,
    }, { tenantId: "personal", actorId: "owner" });
    await createTodayItem({
      tenantId: "personal",
      actorId: "owner",
      title: "Prepare the daily review",
      kind: "reminder",
      dueAt: "2026-08-25T09:15:00.000Z",
    });
    const now = new Date("2026-08-25T09:00:00.000Z");

    await expect(getNotificationCenter({
      tenantId: "personal",
      actorId: "owner",
      now,
      processDue: false,
    })).resolves.toMatchObject({ notifications: [], unreadCount: 0 });

    await processDueNotifications({ tenantId: "personal", actorId: "owner", now });
    await expect(getNotificationCenter({
      tenantId: "personal",
      actorId: "owner",
      now,
      processDue: false,
    })).resolves.toMatchObject({
      unreadCount: 1,
      notifications: [expect.objectContaining({ title: "Prepare the daily review" })],
    });
  });

  it("keeps request-bound notification reads exact in file mode", async () => {
    const authUserId = "11111111-1111-4111-8111-111111111111";
    const actorId = "notification-owner@example.test";
    const canonicalActorId = `actor:${authUserId}`;
    const now = new Date("2026-08-25T09:00:00.000Z");
    for (const ownerActorId of [canonicalActorId, actorId]) {
      await updateTodayPreferences({
        timezone: "UTC",
        quietHoursEnabled: false,
        notificationsEnabled: true,
      }, { tenantId: "notification-file-binding", actorId: ownerActorId });
      await createTodayItem({
        tenantId: "notification-file-binding",
        actorId: ownerActorId,
        title: `Reminder for ${ownerActorId}`,
        dueAt: "2026-08-25T08:00:00.000Z",
      });
      await processDueNotifications({
        tenantId: "notification-file-binding",
        actorId: ownerActorId,
        now,
      });
    }

    await expect(listNotifications(10, {
      tenantId: "notification-file-binding",
      actorId,
      requestActorBinding: {
        version: 1,
        kind: "auth_user",
        authUserId,
        canonicalActorId,
        legacyOwnerActorIds: Object.freeze([actorId]),
        readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
      },
    })).resolves.toEqual([
      expect.objectContaining({
        actorId,
        title: `Reminder for ${actorId}`,
      }),
    ]);
  });

  it("completes the underlying Today item from a notification", async () => {
    await updateTodayPreferences({
      timezone: "UTC", quietHoursEnabled: false, notificationsEnabled: true,
    }, { tenantId: "personal", actorId: "owner" });
    await createTodayItem({
      tenantId: "personal",
      actorId: "owner",
      title: "Review the agent result",
      dueAt: "2026-08-25T08:00:00.000Z",
    });
    await processDueNotifications({
      tenantId: "personal", actorId: "owner", now: new Date("2026-08-25T09:00:00.000Z"),
    });
    const [notification] = await listNotifications(10, { tenantId: "personal", actorId: "owner" });
    await expect(updatePersonalNotification(notification.id, "complete", {
      tenantId: "personal", actorId: "owner", now: new Date("2026-08-25T09:01:00.000Z"),
    })).resolves.toMatchObject({ status: "acted" });
    await expect(listTodayItems(10, { tenantId: "personal", actorId: "owner" }))
      .resolves.toEqual([expect.objectContaining({ title: "Review the agent result", status: "done" })]);
  });
});
