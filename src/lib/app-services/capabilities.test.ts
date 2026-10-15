import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getAgentRun: vi.fn(), getAgentRunIdentityPin: vi.fn(), listStreamEvents: vi.fn() }));
vi.mock("@/lib/runs/store", () => ({ getAgentRun: mocks.getAgentRun, getAgentRunIdentityPin: mocks.getAgentRunIdentityPin }));
vi.mock("@/lib/events/store", () => ({ listStreamEvents: mocks.listStreamEvents }));
import { inspectCapabilitiesService } from "@/lib/app-services/capabilities";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const context: SecurityContext = { tenantId: "capability-tenant", actorId: "owner@example.com", role: "operator", source: "session" };
const owner = { tenantId: context.tenantId, actorId: context.actorId };
const executionScope = createExecutionScope({ ...owner, initiatingActorId: context.actorId,
  executingPrincipalType: "agent", executingPrincipalId: "atlas-principal", correlationId: "own-run", purpose: "agent.tool.execute" });
const caller = createAppServiceCaller({ context, executionScope });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAgentRun.mockResolvedValue({ id: "own-run", ownerActorId: context.actorId });
  mocks.getAgentRunIdentityPin.mockResolvedValue({ principalId: executionScope.executingPrincipalId });
  mocks.listStreamEvents.mockResolvedValue([{ type: "run.harness", payload: { toolIds: ["web.read", "app.capabilities.inspect"] } }]);
});
describe("capability self inspection", () => {
  it("labels product knowledge separately from this exact owner's recorded admission", async () => {
    const { data, receipt } = await inspectCapabilitiesService(caller, { query: "web.", limit: 40 });
    expect(data.entries.find(tool => tool.id === "web.read")?.admission).toBe("admitted_for_this_run");
    expect(data.entries.find(tool => tool.id === "web.search")?.admission).toBe("catalog_only");
    expect(data.runAdmission).toBe("recorded");
    expect(mocks.getAgentRun).toHaveBeenCalledWith("own-run", owner);
    expect(mocks.listStreamEvents).toHaveBeenCalledWith("run:own-run", { ...owner, limit: 2_000 });
    expect(receipt.operation).toBe("app.capabilities.inspect");
    expect(data.entries.every(tool => !Object.hasOwn(tool, "inputSchema"))).toBe(true);
    expect(data.entries.every(tool => tool.category !== "mcp" && tool.category !== "openapi")).toBe(true);
  });
  it("does not read a different actor's run events", async () => {
    mocks.getAgentRun.mockResolvedValue({ id: "other-run", ownerActorId: "someone-else" });
    const { data } = await inspectCapabilitiesService(caller, {});
    expect(mocks.listStreamEvents).not.toHaveBeenCalled();
    expect(data.runAdmission).toBe("unavailable");
    expect(data.entries.every(tool => tool.admission === "catalog_only")).toBe(true);
  });
  it("does not label a different principal's recorded tools as current admission", async () => {
    mocks.getAgentRunIdentityPin.mockResolvedValue({ principalId: "other-principal" });
    const { data } = await inspectCapabilitiesService(caller, {});
    expect(data.runAdmission).toBe("unavailable");
    expect(mocks.listStreamEvents).not.toHaveBeenCalled();
  });
  it("keeps the entire maximum page parseable inside the model output limit", async () => {
    const result = await inspectCapabilitiesService(caller, { limit: 40 });
    expect(JSON.stringify(result).length).toBeLessThan(8_000);
    expect(result.data.nextOffset).toBe(result.data.entries.length);
    expect(result.data.entries.length).toBeGreaterThan(0);
  });
  it.each([[], [{ type: "run.harness", payload: {} }], [
    { type: "run.harness", payload: { toolIds: ["web.search"] } },
    { type: "run.harness", payload: { toolIds: ["web.read"] } },
  ]])("does not invent admission from absent, malformed or ambiguous receipts: %j", async (...events) => {
    mocks.listStreamEvents.mockResolvedValue(events);
    const { data } = await inspectCapabilitiesService(caller, {});
    expect(data.runAdmission).toBe("unavailable");
  });
  it("can page public product metadata without pretending a request granted execution", async () => {
    const catalogCaller = createAppServiceCaller({ context });
    const first = (await inspectCapabilitiesService(catalogCaller, { limit: 3 })).data;
    const second = (await inspectCapabilitiesService(catalogCaller, { limit: 3, offset: first.nextOffset })).data;
    expect(first.catalogCount).toBeGreaterThan(40);
    expect(second.entries).toHaveLength(3);
    expect(first.entries.some(a => second.entries.some(b => a.id === b.id))).toBe(false);
    expect(mocks.getAgentRun).not.toHaveBeenCalled();
    expect(first.runAdmission).toBe("unavailable");
  });
  it("rejects caller-chosen run IDs and unbounded queries", async () => {
    await expect(inspectCapabilitiesService(caller, { runId: "other-run" })).rejects.toThrow();
    await expect(inspectCapabilitiesService(caller, { query: "x".repeat(161) })).rejects.toThrow();
    await expect(inspectCapabilitiesService(caller, { limit: 100 })).rejects.toThrow();
    expect(mocks.getAgentRun).not.toHaveBeenCalled();
  });
});
