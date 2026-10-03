import { describe, expect, it, vi } from "vitest";
import { changeResponsibilityLifecycleService, getResponsibilityLifecycle, lifecycleDependencies } from "./lifecycle-service";
import { runtimeConfiguration, runtimeId, runtimeOwner } from "./runtime-test-fixtures";
const context = { tenantId: runtimeOwner.tenantId, actorId: "owner@example.test", role: "operator" as const, source: "session" as const,
  auth: { userId: runtimeOwner.actorId.slice(6), email: "owner@example.test", sessionId: "fixture", tenantName: "Fixture" } };
const request = { action: "activate", expectedRevision: 0, expectedGeneration: 0, configurationSha256: runtimeConfiguration.configurationSha256, acknowledgePilot: "native_meeting_metadata_v1" };
function dependencies() { return { read: vi.fn(), control: vi.fn() } as unknown as typeof lifecycleDependencies; }
describe("Responsibility lifecycle service", () => {
  it("keeps reads/activation previews side-effect free and sends only exact canonical owner mutations", async () => {
    const deps = dependencies(); await getResponsibilityLifecycle(context, runtimeId, true, deps);
    expect(deps.read).toHaveBeenCalledWith(runtimeOwner, runtimeId, true); expect(deps.control).not.toHaveBeenCalled();
    await changeResponsibilityLifecycleService(context, runtimeId, request, "stable-key", deps);
    expect(deps.control).toHaveBeenCalledWith(runtimeOwner, runtimeId, request, "stable-key");
  });
  it("rejects unbound/internal caller identities and roles before storage", async () => {
    const deps = dependencies();
    for (const bad of [{ ...context, actorId: "other" }, { ...context, auth: undefined }, { ...context, source: "default" as const }]) {
      await expect(changeResponsibilityLifecycleService(bad, runtimeId, request, "key", deps)).rejects.toMatchObject({ status: 409 });
    }
    await expect(changeResponsibilityLifecycleService({ ...context, role: "viewer" }, runtimeId, request, "key", deps)).rejects.toMatchObject({ status: 403 });
    expect(deps.control).not.toHaveBeenCalled();
  });
  it("rejects extra authority, unsupported actions and missing exact version acknowledgment", async () => {
    const deps = dependencies();
    for (const bad of [{ ...request, expectedGeneration: 1 }, { ...request, notificationAuthority: "send" }, { ...request, action: "run_now" },
      { ...request, acknowledgePilot: undefined }, { ...request, configurationSha256: "wrong" }]) {
      await expect(changeResponsibilityLifecycleService(context, runtimeId, bad, "key", deps)).rejects.toMatchObject({ status: 400 });
    }
    expect(deps.control).not.toHaveBeenCalled();
  });
});
