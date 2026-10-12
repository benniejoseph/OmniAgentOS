import { describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@/lib/security/types";
import { compatibleResponsibilityValue, requireCompatibleResponsibilityRecord } from "./responsibility-compatibility";
const read = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => vi.fn());
const notifications = vi.hoisted(() => vi.fn());
vi.mock("@/lib/responsibilities/service", () => ({ getResponsibilityDraft: read }));
vi.mock("@/lib/responsibilities/lifecycle-service", () => ({ getResponsibilityLifecycle: runtime }));
vi.mock("@/lib/responsibilities/notification-service", () => ({ getResponsibilityNotifications: notifications }));
const old: SecurityContext = { tenantId: "t", actorId: "a", source: "mobile", role: "operator",
  native: { deviceId: "d", platform: "macos", clientContractVersion: 47 } };
const current = { ...old, native: { ...old.native!, clientContractVersion: 48 } };
const work = { record: { draft: { sources: [{ kind: "work_item", id: "work-a", workspaceId: "w", projectId: "p" }] } } };
describe("native responsibility upgrade boundary", () => {
  it("retains meeting reads and web/current work reads", () => {
    const meeting = { record: { draft: { sources: [{ kind: "meeting", id: "m" }], work: { workItemId: "w" } } } };
    expect(compatibleResponsibilityValue(old, meeting)).toBe(meeting);
    expect(compatibleResponsibilityValue(current, work)).toBe(work);
    expect(compatibleResponsibilityValue({ ...old, source: "session" }, work)).toBe(work);
  });
  it("rejects incompatible list, runtime, observation and incoming acknowledgement shapes", () => {
    for (const value of [work, { records: [work.record] }, { current: { configuration: { pilot: "canonical_work_item_followthrough_v1" } } },
      { policy: { id: "responsibility-work-item-comparison:1" } }, { acknowledgePilot: "canonical_work_item_followthrough_v1" }]) {
      expect(() => compatibleResponsibilityValue(old, value)).toThrow(expect.objectContaining({ status: 409, code: "responsibility_client_upgrade_required" }));
    }
  });
  it("checks the stored source before an old client's lifecycle or draft mutation", async () => {
    read.mockResolvedValue(work);
    await expect(requireCompatibleResponsibilityRecord(old, "responsibility-a")).rejects.toThrow("Update Asael");
    expect(read).toHaveBeenCalledWith(old, "responsibility-a", false);
    read.mockClear(); await requireCompatibleResponsibilityRecord(current, "responsibility-a"); expect(read).not.toHaveBeenCalled();
  });
  it("checks immutable runtime and delivery authority even after its draft becomes a meeting", async () => {
    read.mockResolvedValue({ record: { draft: { sources: [{ kind: "meeting", id: "meeting-a" }] } } });
    runtime.mockResolvedValue({ current: { configuration: { pilot: "canonical_work_item_followthrough_v1" } } });
    await expect(requireCompatibleResponsibilityRecord(old, "r", "lifecycle")).rejects.toThrow("Update Asael");
    await expect(requireCompatibleResponsibilityRecord(old, "r", "notifications")).rejects.toThrow("Update Asael");
    runtime.mockResolvedValue({ current: null }); notifications.mockResolvedValue({ current: { configuration: { source: work.record.draft.sources[0] } } });
    await expect(requireCompatibleResponsibilityRecord(old, "r", "notifications")).rejects.toThrow("Update Asael");
    notifications.mockResolvedValue({ current: null });
    await expect(requireCompatibleResponsibilityRecord(old, "r", "notifications")).resolves.toBeUndefined();
  });
});
