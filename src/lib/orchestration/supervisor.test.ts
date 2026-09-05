import { describe, expect, it } from "vitest";
import {
  adaptSupervisorDecision,
  analyzeAgentRequestAmbiguity,
  applySupervisorStrategy,
  compileThreadContext,
  resolveKnownProcedure,
  routeAgentRequest,
} from "@/lib/orchestration/supervisor";
import type { ThreadTurnRecord } from "@/lib/threads/types";

describe("supervisor routing", () => {
  it("keeps ordinary questions on the direct path", () => {
    expect(routeAgentRequest("What did we decide about the launch date?", "research").route).toBe("direct");
  });

  it("routes explicit background multi-step work durably", () => {
    const decision = routeAgentRequest("In the background, research the options, prepare a report with evidence, and keep working until complete.", "orchestrate");
    expect(decision.route).toBe("durable_workflow");
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it("marks consequential external actions for approval", () => {
    expect(routeAgentRequest("Create a workflow to deploy and verify production.", "execute").requiresApproval).toBe(true);
  });

  it("keeps bounded natural-language automations on the governed direct path", () => {
    const portfolioRun = routeAgentRequest("Run my portfolio blog automation.", "orchestrate");
    expect(portfolioRun).toMatchObject({
      route: "direct",
      requiresApproval: true,
    });
    expect(portfolioRun.specialistIds).not.toContain("sentinel");
    expect(routeAgentRequest("Run the GitHub workflow that generates my blog post.", "orchestrate").route).toBe("direct");
    expect(routeAgentRequest("Schedule a calendar event tomorrow.", "orchestrate").route).toBe("direct");
    expect(routeAgentRequest("Run, verify, and report back on the GitHub action for my portfolio repository.", "execute").route).toBe("direct");
    expect(routeAgentRequest("Show my recent email.", "orchestrate").specialistIds).not.toContain("sentinel");
  });

  it("still routes explicitly recurring automation durably", () => {
    expect(routeAgentRequest("Run the GitHub workflow every week.", "orchestrate").route).toBe("durable_workflow");
  });

  it("binds an exact saved-procedure alias to its canonical workflow", () => {
    const decision = routeAgentRequest(
      "Run my portfolio blog automation.",
      "orchestrate",
      undefined,
      [{
        id: "workflow:portfolio-blog",
        aliases: ["portfolio blog automation", "generate blog post"],
        requiredToolIds: [],
      }],
    );

    expect(decision).toMatchObject({
      route: "durable_workflow",
      ambiguity: { state: "none" },
      procedure: {
        workflowId: "workflow:portfolio-blog",
        matchedAlias: "portfolio blog automation",
        requiredToolIds: [],
      },
    });
  });

  it("clarifies saved-procedure alias collisions and does not accept partial words", () => {
    const collision = routeAgentRequest(
      "Run my publishing automation.",
      "orchestrate",
      undefined,
      [
        { id: "workflow:one", aliases: ["publishing automation"], requiredToolIds: [] },
        { id: "workflow:two", aliases: ["publishing automation"], requiredToolIds: [] },
      ],
    );
    expect(collision).toMatchObject({
      route: "clarify",
      ambiguity: { state: "detected", reasonCode: "ambiguous_known_procedure" },
    });
    expect(applySupervisorStrategy(collision, "direct").route).toBe("clarify");

    expect(resolveKnownProcedure("Run my portfolio automation", [{
      id: "workflow:partial",
      aliases: ["port"],
      requiredToolIds: [],
    }])).toEqual({ state: "none" });
  });

  it("fails closed when a destructive request has an ambiguous target", () => {
    const decision = routeAgentRequest("Delete the old project", "orchestrate");
    expect(decision).toMatchObject({
      route: "clarify",
      ambiguity: {
        state: "detected",
        reasonCode: "ambiguous_destructive_target",
      },
      requiresApproval: true,
    });
    expect(applySupervisorStrategy(decision, "direct").route).toBe("clarify");
    expect(applySupervisorStrategy(decision, "durable").route).toBe("clarify");
  });

  it("does not invent ambiguity for exact targets, prohibitions, or explanatory questions", () => {
    expect(analyzeAgentRequestAmbiguity("Delete project:one")).toEqual({ state: "none" });
    expect(analyzeAgentRequestAmbiguity("Do not delete the old project")).toEqual({ state: "none" });
    expect(analyzeAgentRequestAmbiguity("Explain how to delete the old project")).toEqual({ state: "none" });
    expect(analyzeAgentRequestAmbiguity('Delete the project named "Old Portfolio"')).toEqual({ state: "none" });
    expect(analyzeAgentRequestAmbiguity('Please delete the old project and say "okay"')).toMatchObject({ state: "detected" });
  });

  it("selects research, builder, and critic specialists from task intent", () => {
    const decision = routeAgentRequest("Research current options, implement the best one, then verify it is safe for production.", "orchestrate");
    expect(decision.primaryAgentId).toBe("forge");
    expect(decision.specialistIds).toEqual(expect.arrayContaining(["scout", "forge", "sentinel"]));
  });

  it("routes personal recall to the memory specialist", () => {
    expect(routeAgentRequest("What did I decide about my weekly review?", "learn").primaryAgentId).toBe("mnemosyne");
  });

  it("respects an explicitly selected primary while retaining required expertise", () => {
    const decision = routeAgentRequest("Research and compare the current options.", "research", "forge");
    expect(decision.primaryAgentId).toBe("forge");
    expect(decision.specialistIds).toEqual(expect.arrayContaining(["forge", "scout"]));
  });

  it("adds planning and verification support after repeated incomplete outcomes", () => {
    const decision = routeAgentRequest("Implement the integration.", "execute");
    const adapted = adaptSupervisorDecision(decision, [{
      agentId: "forge",
      primaryAssignments: 5,
      collaborations: 0,
      completed: 2,
      failed: 3,
      completionRate: 0.4,
      verifiedAnswers: 0,
      memoriesLearned: 0,
      usefulOutcomes: 0,
      needsWorkOutcomes: 0,
      userApprovalRate: null,
    }]);
    expect(adapted.specialistIds).toEqual(expect.arrayContaining(["forge", "atlas", "sentinel"]));
    expect(adapted.learning).toMatchObject({ state: "supported", sampleSize: 5 });
  });

  it("adds support when personal feedback shows repeated weak outcomes", () => {
    const decision = routeAgentRequest("Research the options.", "research");
    const adapted = adaptSupervisorDecision(decision, [{
      agentId: "scout",
      primaryAssignments: 4,
      collaborations: 0,
      completed: 4,
      failed: 0,
      completionRate: 1,
      verifiedAnswers: 4,
      memoriesLearned: 0,
      usefulOutcomes: 1,
      needsWorkOutcomes: 2,
      userApprovalRate: 1 / 3,
    }]);
    expect(adapted.specialistIds).toEqual(expect.arrayContaining(["scout", "atlas", "sentinel"]));
    expect(adapted.learning?.adjustments.join(" ")).toMatch(/your recent outcome feedback/i);
  });
});

describe("thread context compiler", () => {
  it("keeps the newest turns inside message and character budgets", () => {
    const turns = ["oldest", "middle", "newest"].map((content, index): ThreadTurnRecord => ({ id: String(index), tenantId: "t", threadId: "x", role: index % 2 ? "assistant" : "user", content, createdAt: new Date(index).toISOString() }));
    const compiled = compileThreadContext(turns, { maxMessages: 2, maxCharacters: 20 });
    expect(compiled.messages.map((message) => message.content)).toEqual(["middle", "newest"]);
    expect(compiled.stats.omitted).toBe(1);
    expect(compiled.stats.tokens).toBeGreaterThan(0);
  });
});
