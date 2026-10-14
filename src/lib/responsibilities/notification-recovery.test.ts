import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/sql-types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { notificationEnableRequestSchema } from "./notification-contracts";
import { assertNotificationRecoveryReadyWithSql, readNotificationConfigurationReceipts } from "./notification-store";
import { buildNotificationReceipt, enableNotificationAdmission, transitionNotificationCandidate, verifyNotificationConfiguration } from "./notification-state";
import { notificationOwner, notificationPending, notificationRecoveryFixture } from "./notification-test-fixtures";

describe("Reviewed notification recovery", () => {
  it("retains allowance, expiry, first enable time and canceled history while advancing one admission generation", async () => {
    const fixture = notificationRecoveryFixture();
    const renewed = enableNotificationAdmission(fixture.configuration, fixture.runtime, fixture.request, fixture.now, fixture.previous);
    expect(renewed).toMatchObject({ revision: fixture.previous.revision + 1, generation: fixture.previous.generation + 1,
      used: fixture.previous.used, reserved: 0, enabledAt: fixture.previous.enabledAt, configuration: { maximumNotifications: fixture.previous.configuration.maximumNotifications, expiresAt: fixture.previous.configuration.expiresAt } });
    const pending = await notificationPending();
    const canceled = transitionNotificationCandidate(pending.current, pending.candidate, { now: fixture.previous.updatedAt, outcome: "cancel", reason: "runtime_blocked" });
    expect(() => transitionNotificationCandidate(renewed, canceled.candidate, { now: fixture.now, outcome: "retry", reason: "delivery_retry" })).toThrow();
  });
  it("rejects missing or stale admission counters, widened configuration, expiry and every other stopped reason", () => {
    const fixture = notificationRecoveryFixture();
    expect(notificationEnableRequestSchema.safeParse({ ...fixture.request, expectedGeneration: undefined }).success).toBe(false);
    for (const request of [{ ...fixture.request, expectedRevision: 99 }, { ...fixture.request, expectedGeneration: 99 }, { ...fixture.request, expectedRuntimeRevision: 99 }]) {
      expect(() => enableNotificationAdmission(fixture.configuration, fixture.runtime, request, fixture.now, fixture.previous)).toThrow();
    }
    for (const reason of ["owner_stopped", "expired", "runtime_ended", "checks_exhausted"] as const) {
      expect(() => enableNotificationAdmission(fixture.configuration, fixture.runtime, fixture.request, fixture.now, { ...fixture.previous, reason })).toThrow();
    }
    for (const patch of [{ maximumNotifications: fixture.configuration.maximumNotifications + 1 }, { expiresAt: "2027-01-01T00:00:00.000Z" }, { draftSha256: "a".repeat(64) }, { source: { ...fixture.configuration.source, id: "another-source" } }]) {
      const { configurationSha256: ignored, ...body } = { ...fixture.configuration, ...patch }; void ignored;
      const configuration = verifyNotificationConfiguration({ ...body, configurationSha256: canonicalJsonSha256(body) });
      expect(() => enableNotificationAdmission(configuration, fixture.runtime, { ...fixture.request, configurationSha256: configuration.configurationSha256 }, fixture.now, fixture.previous)).toThrow();
    }
    expect(() => enableNotificationAdmission(fixture.configuration, fixture.runtime, fixture.request, fixture.configuration.expiresAt, fixture.previous)).toThrow();
    expect(() => enableNotificationAdmission(fixture.configuration, fixture.runtime, fixture.request, fixture.now, { ...fixture.previous, used: fixture.configuration.maximumNotifications })).toThrow();
  });
  it("refuses a recovery preview or persistence while any pending or held row remains", async () => {
    const fixture = notificationRecoveryFixture(); const sql = vi.fn(async () => [{ id: "still-held" }]) as unknown as SqlClient;
    await expect(assertNotificationRecoveryReadyWithSql(sql, fixture.previous, fixture.configuration, fixture.now)).rejects.toMatchObject({ code: "responsibility_notification_recovery_pending" });
    expect(sql).toHaveBeenCalledOnce();
  });
  it("reads exact older configuration proof outside the recent receipt window and fails closed on missing or foreign proof", async () => {
    const fixture = notificationRecoveryFixture(); const pending = await notificationPending();
    const canceled = transitionNotificationCandidate(pending.current, pending.candidate, { now: fixture.previous.updatedAt, outcome: "cancel", reason: "runtime_blocked" });
    const prior = { ...fixture.previous, revision: canceled.current.revision + 1 };
    const proof = buildNotificationReceipt({ previous: canceled.current, current: prior, action: "lifecycle", key: "blocked", request: { state: "blocked" } });
    const request = { ...fixture.request, expectedRevision: prior.revision };
    const current = enableNotificationAdmission(fixture.configuration, fixture.runtime, request, fixture.now, prior);
    const sql = vi.fn(async () => [{ receipt: proof }]) as unknown as SqlClient;
    expect(await readNotificationConfigurationReceipts(sql, notificationOwner, prior.responsibilityId, current, [canceled.candidate], [])).toEqual([proof]);
    expect(sql).toHaveBeenCalledOnce();
    const empty = vi.fn(async () => []) as unknown as SqlClient;
    await expect(readNotificationConfigurationReceipts(empty, notificationOwner, prior.responsibilityId, current, [canceled.candidate], [])).rejects.toThrow();
    await expect(readNotificationConfigurationReceipts(sql, { ...notificationOwner, tenantId: "foreign" }, prior.responsibilityId, current, [canceled.candidate], [])).rejects.toThrow();
    await expect(readNotificationConfigurationReceipts(sql, notificationOwner, prior.responsibilityId, current, [{ ...canceled.candidate, state: "held", terminalAt: null }], [])).rejects.toThrow();
  });
});
