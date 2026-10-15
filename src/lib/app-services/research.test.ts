import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAgentIdentityForExecution: vi.fn(), getAgentRun: vi.fn(), getAgentRunIdentityPin: vi.fn(),
  listStreamEvents: vi.fn(), getOwnedThread: vi.fn(), getWorkflowRunDetail: vi.fn(),
  createMission: vi.fn(), ensureMissionTask: vi.fn(), getMission: vi.fn(), getMissionTask: vi.fn(),
  transitionMission: vi.fn(), createWorkflowRun: vi.fn(), enqueueWorkflowRunTick: vi.fn(),
  scheduleWorkflowQueueDrain: vi.fn(),
}));
vi.mock("@/lib/agents/identity-store", () => ({ resolveAgentIdentityForExecution: mocks.resolveAgentIdentityForExecution }));
vi.mock("@/lib/runs/store", () => ({ getAgentRun: mocks.getAgentRun, getAgentRunIdentityPin: mocks.getAgentRunIdentityPin }));
vi.mock("@/lib/events/store", () => ({ listStreamEvents: mocks.listStreamEvents }));
vi.mock("@/lib/threads/store", () => ({ getOwnedThread: mocks.getOwnedThread }));
vi.mock("@/lib/missions/store", () => ({
  createMission: mocks.createMission, ensureMissionTask: mocks.ensureMissionTask,
  getMission: mocks.getMission, getMissionTask: mocks.getMissionTask, transitionMission: mocks.transitionMission,
}));
vi.mock("@/lib/workflows/store", () => ({
  createWorkflowRun: mocks.createWorkflowRun, getWorkflowRunDetail: mocks.getWorkflowRunDetail,
  deterministicWorkflowRunId: () => "workflow-hotel",
}));
vi.mock("@/lib/workflows/queue", () => ({
  enqueueWorkflowRunTick: mocks.enqueueWorkflowRunTick, scheduleWorkflowQueueDrain: mocks.scheduleWorkflowQueueDrain,
}));

import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { startResearchService } from "@/lib/app-services/research";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const context: SecurityContext = {
  tenantId: "tenant-hotel", actorId: "hotel-owner@example.com", role: "operator", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "hotel-owner@example.com", sessionId: "session-a", tenantName: "Private" },
};
const owner = { tenantId: context.tenantId, actorId: context.actorId };
const executionScope = createExecutionScope({
  tenantId: context.tenantId, initiatingActorId: context.actorId, executingPrincipalType: "agent",
  executingPrincipalId: "agent-hotel", correlationId: "run-hotel-followup", purpose: "agent.tool.execute",
  contextGrantIds: ["private-grant"], capabilityGrantIds: ["existing-capability-grant"],
});
const caller = createAppServiceCaller({ context, executionScope, idempotencyKey: "research-execution-a" });
const allResearchTools = ["app.research.start", "web.search", "web.read"];
const hotelGoal = "Compare cheaper Palm Meadows offers for check-in 19 October 2026 and check-out 21 October 2026, two nights. Keep occupancy unresolved; compare equivalent rooms, full taxes, breakfast, cancellation terms and discount conditions. Do not make a booking.";
const brief = { goal: hotelGoal, depth: "quick", questions: ["Which equivalent public offers have the lowest full two-night price?", "Which refundable offer gives the best value?"] };
function identity(overrides: Record<string, unknown> = {}) {
  return {
    definition: { definitionSha256: "definition-a", logicalAgentId: "atlas", name: "Asael", role: "Partner", description: "Complete work", instructions: "Use evidence", persona: {}, modelPolicy: "auto" },
    principal: { principalSha256: "principal-a", principalId: "agent-hotel", state: "active", expiresAt: null,
      autonomy: "governed", approvalPolicy: "risk_based", authorityMode: "explicit_grants", toolGrantIds: allResearchTools, ...overrides },
  };
}
function harness(overrides: Record<string, unknown> = {}) {
  return { type: "run.harness", payload: { toolIds: allResearchTools, contextScope: "none", approvalPolicy: "risk_based", autonomy: "governed", ...overrides } };
}
function parent(overrides: Record<string, unknown> = {}) {
  return { id: "run-hotel-followup", ownerActorId: context.actorId, threadId: "thread-hotel", status: "running", prompt: "can you enable live web search and check it", ...overrides };
}
function expectNoWorkStarted() {
  expect(mocks.createMission).not.toHaveBeenCalled();
  expect(mocks.ensureMissionTask).not.toHaveBeenCalled();
  expect(mocks.createWorkflowRun).not.toHaveBeenCalled();
  expect(mocks.enqueueWorkflowRunTick).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAgentRun.mockResolvedValue(parent());
  mocks.getOwnedThread.mockResolvedValue({ id: "thread-hotel" });
  mocks.getAgentRunIdentityPin.mockResolvedValue({ principalId: "agent-hotel", logicalAgentId: "atlas", definitionSha256: "definition-a", principalSha256: "principal-a", pinSha256: "pin-a" });
  mocks.listStreamEvents.mockResolvedValue([harness()]);
  mocks.resolveAgentIdentityForExecution.mockResolvedValue(identity());
  mocks.getWorkflowRunDetail.mockResolvedValue(null);
  mocks.createMission.mockImplementation(async input => ({ ...input, id: "mission-hotel", status: "draft" }));
  mocks.ensureMissionTask.mockImplementation(async (missionId, input) => ({ ...input, id: "task-hotel", missionId }));
  mocks.createWorkflowRun.mockImplementation(async input => ({ run: {
    id: "workflow-hotel", status: "queued", goal: input.goal, input: { metadata: input.metadata },
  } }));
});

describe("conversation research admission and recovery", () => {
  it("keeps the hotel follow-up brief and conversation while binding only the allowed public research tools", async () => {
    const result = await startResearchService(caller, brief);
    expect(mocks.getAgentRun).toHaveBeenCalledWith("run-hotel-followup", owner);
    expect(mocks.getOwnedThread).toHaveBeenCalledWith("thread-hotel", expect.objectContaining(owner));
    expect(mocks.getAgentRunIdentityPin).toHaveBeenCalledWith("run-hotel-followup", owner);
    expect(mocks.listStreamEvents).toHaveBeenCalledWith("run:run-hotel-followup", { ...owner, limit: 2_000 });
    expect(mocks.resolveAgentIdentityForExecution).toHaveBeenCalledWith({ ...owner, agentId: "atlas" });
    expect(mocks.createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: owner.tenantId, idempotencyKey: caller.idempotencyKey, goal: hotelGoal, mode: "research",
      executionAuthority: { requesterRole: "operator", executionScope: expect.objectContaining({
        tenantId: owner.tenantId, initiatingActorId: owner.actorId, executingPrincipalId: "agent-hotel",
        correlationId: "run-hotel-followup", purpose: "workflow.run", missionId: "mission-hotel", causationId: "task-hotel",
        contextGrantIds: [], capabilityGrantIds: executionScope.capabilityGrantIds, workspaceId: null, projectId: null,
      }) },
      metadata: expect.objectContaining({
        parentRunId: "run-hotel-followup", threadId: "thread-hotel", actorId: owner.actorId,
        contextScope: "none", researchOptionsV1: expect.objectContaining({ questions: brief.questions }),
        agentProfile: expect.objectContaining({ toolIds: ["web.search", "web.read"], skills: [], memoryScope: "session" }),
      }),
    }));
    expect(result.data).toMatchObject({ workflowId: "workflow-hotel", status: "queued", threadId: "thread-hotel", href: "/app/command?thread=thread-hotel", context: "public_web" });
    expect(mocks.enqueueWorkflowRunTick).toHaveBeenCalledWith("workflow-hotel", "conversation_research_created", undefined, owner.tenantId);
  });

  it.each(["web.search", "web.read"])("identifies missing %s and offers only the remaining admitted live-source tool", async missing => {
    mocks.listStreamEvents.mockResolvedValue([harness({ toolIds: allResearchTools.filter(id => id !== missing) })]);
    const failure = await startResearchService(caller, brief).catch(error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`this request is missing ${missing}`);
    expect((failure as Error).message).toContain(missing === "web.search" ? "read known public URLs with web.read" : "search public sources with web.search");
    expect((failure as Error).message).not.toContain("selected Mac browser");
    expectNoWorkStarted();
  });

  it("offers the selected Mac browser only when both browser open and observation are currently admitted", async () => {
    const tools = ["app.research.start", "local.macos.open_url", "local.macos.observe"];
    mocks.listStreamEvents.mockResolvedValue([harness({ toolIds: tools })]);
    mocks.resolveAgentIdentityForExecution.mockResolvedValue(identity({ toolGrantIds: tools }));
    await expect(startResearchService(caller, brief)).rejects.toThrow("inspect public sources in the selected Mac browser");
    expectNoWorkStarted();
  });

  it("does not invent a browser route or a web-access setting when no alternative tool was admitted", async () => {
    mocks.listStreamEvents.mockResolvedValue([harness({ toolIds: ["app.research.start", "local.macos.open_url"] })]);
    mocks.resolveAgentIdentityForExecution.mockResolvedValue(identity({ toolGrantIds: ["app.research.start", "local.macos.open_url"] }));
    await expect(startResearchService(caller, brief)).rejects.toThrow("no alternative live-source tool is available in this request");
    expectNoWorkStarted();
  });

  it("does not offer a tool withheld by the current principal even when a stale harness lists it", async () => {
    mocks.resolveAgentIdentityForExecution.mockResolvedValue(identity({ toolGrantIds: ["app.research.start", "web.search"] }));
    const failure = await startResearchService(caller, brief).catch(error => error as Error);
    expect((failure as Error).message).toContain("missing web.read");
    expect((failure as Error).message).not.toContain("read known public URLs");
    expectNoWorkStarted();
  });

  it.each(["parent", "brief"])("keeps an explicit no-web instruction in the %s and does not suggest a browser bypass", async source => {
    if (source === "parent") mocks.getAgentRun.mockResolvedValue(parent({ prompt: "Use only the supplied documents. Do not browse the web." }));
    const input = source === "brief" ? { ...brief, goal: `${hotelGoal} Use only the supplied documents.` } : brief;
    await expect(startResearchService(caller, input)).rejects.toThrow("Continue from the permitted sources; do not use a browser to bypass that instruction");
    expectNoWorkStarted();
  });

  it("keeps personal context out of public discovery and identifies the actual context restriction", async () => {
    mocks.listStreamEvents.mockResolvedValue([harness({ contextScope: "personal" })]);
    await expect(startResearchService(caller, brief)).rejects.toThrow("personal context, which cannot be sent to public web research");
    expectNoWorkStarted();
  });

  it.each(["read_only", "assist"])("distinguishes the %s background-work restriction from available direct web reads", async policy => {
    const tools = [...allResearchTools, "local.macos.open_url", "local.macos.observe"];
    mocks.listStreamEvents.mockResolvedValue([harness({ toolIds: tools, ...(policy === "assist" ? { autonomy: "assist" } : { approvalPolicy: "read_only" }) })]);
    mocks.resolveAgentIdentityForExecution.mockResolvedValue(identity({ toolGrantIds: tools }));
    const failure = await startResearchService(caller, brief).catch(error => error as Error);
    expect((failure as Error).message).toContain(policy === "assist" ? "assist mode" : "read-only policy");
    expect((failure as Error).message).toContain("search public sources with web.search");
    expect((failure as Error).message).not.toContain("selected Mac browser");
    expectNoWorkStarted();
  });

  it("refuses a wrapper missing from the exact parent harness while preserving direct research recovery", async () => {
    mocks.listStreamEvents.mockResolvedValue([harness({ toolIds: ["web.search", "web.read"] })]);
    await expect(startResearchService(caller, brief)).rejects.toThrow("Starting background research was not admitted for this request");
    expectNoWorkStarted();
  });

  it.each([
    { principalSha256: "changed" }, { principalId: "different-agent" }, { state: "disabled" }, { expiresAt: "2000-01-01T00:00:00Z" },
  ])("refuses changed or inactive principal authority before creating work: %j", async change => {
    mocks.resolveAgentIdentityForExecution.mockResolvedValue(identity(change));
    await expect(startResearchService(caller, brief)).rejects.toThrow("research permissions changed");
    expectNoWorkStarted();
  });

  it("rejects mismatched owner scope before touching another actor's thread", async () => {
    mocks.getAgentRun.mockResolvedValue(parent({ ownerActorId: "other@example.com" }));
    await expect(startResearchService(caller, brief)).rejects.toThrow("conversation is no longer active");
    expect(mocks.getOwnedThread).not.toHaveBeenCalled();
    expectNoWorkStarted();
  });

  it("permits only the exact approved pending research execution while the parent waits", async () => {
    mocks.getAgentRun.mockResolvedValue(parent({ status: "waiting_approval", continuation: {
      pendingToolCall: { toolId: "app.research.start", executionId: caller.idempotencyKey },
    } }));
    await expect(startResearchService(caller, brief)).resolves.toHaveProperty("data.workflowId", "workflow-hotel");
  });

  it("refuses a different pending approval execution", async () => {
    mocks.getAgentRun.mockResolvedValue(parent({ status: "waiting_approval", continuation: {
      pendingToolCall: { toolId: "app.research.start", executionId: "other-execution" },
    } }));
    await expect(startResearchService(caller, brief)).rejects.toThrow("conversation is no longer active");
    expectNoWorkStarted();
  });

  it("does not restart a completed idempotent research request", async () => {
    await startResearchService(caller, brief);
    const workflow = await mocks.createWorkflowRun.mock.results[0].value;
    workflow.run.status = "completed";
    mocks.getWorkflowRunDetail.mockResolvedValue(workflow);
    mocks.getMission.mockResolvedValue(await mocks.createMission.mock.results[0].value);
    mocks.getMissionTask.mockResolvedValue(await mocks.ensureMissionTask.mock.results[0].value);
    mocks.createWorkflowRun.mockResolvedValue(workflow);
    mocks.enqueueWorkflowRunTick.mockClear();
    mocks.scheduleWorkflowQueueDrain.mockClear();
    const result = await startResearchService(caller, brief);
    expect(result.data.status).toBe("completed");
    expect(mocks.createMission).toHaveBeenCalledOnce();
    expect(mocks.ensureMissionTask).toHaveBeenCalledOnce();
    expect(mocks.enqueueWorkflowRunTick).not.toHaveBeenCalled();
    expect(mocks.scheduleWorkflowQueueDrain).not.toHaveBeenCalled();
  });
});
