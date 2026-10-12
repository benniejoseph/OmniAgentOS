import { describe, expect, it } from "vitest";
import {
  measureSupervisorOutcomeEvidence,
  analyzeAgentRequestAmbiguity,
  applySupervisorStrategy,
  requireDirectRoute,
  compileThreadContext,
  resolveKnownProcedure,
  routeAgentRequest,
} from "@/lib/orchestration/supervisor";
import { buildThreadConversationSummaries } from "@/lib/threads/summaries";
import type { ThreadTurnRecord } from "@/lib/threads/types";

const detailedResearchRequest = [
  "Research and compare current evidence about public transit funding approaches across medium-sized cities.",
  "Investigate fare revenue, public subsidies, service reliability, ridership patterns, and the distribution of benefits across neighborhoods.",
  "Compare the quality of the available evidence, the periods covered by each dataset, and whether conclusions depend on a city's population or density.",
  "Prepare a detailed analysis with evidence and references beside the relevant claims, with an executive summary and a discussion of unresolved questions.",
  "Distinguish original studies from commentary, explain disagreements between authors, and describe limitations in published measurements.",
  "Consider the relevance of geography, governance, funding stability, and service frequency without assuming that one approach suits every city.",
  "Include practical implications where the evidence supports them, clearly labeled inferences, and a reference list for the material actually consulted.",
].join("\n");

describe("supervisor routing", () => {
  it("keeps a long multi-action Research request on the report runtime with automatic routing", () => {
    expect(detailedResearchRequest.length).toBeGreaterThan(700);
    const decision = routeAgentRequest(detailedResearchRequest, "research");
    expect(decision.score).toBeGreaterThanOrEqual(4);
    expect(applySupervisorStrategy(decision, "auto").route).toBe("direct");
    expect(decision.reasons).toContain("Research mode uses the direct report runtime unless durable work is explicitly requested.");
    expect(decision.requiresApproval).toBe(false);
  });

  it("retains ordinary conversation and non-Research complexity routing", () => {
    expect(routeAgentRequest("What did we decide about the launch date?", "orchestrate").route).toBe("direct");
    expect(routeAgentRequest(detailedResearchRequest, "orchestrate").route).toBe("durable_workflow");
  });

  it("does not mistake multiple research steps for a request to run in the background", () => {
    const request = "Research in multiple steps: investigate primary evidence, compare the findings, and prepare a cited report.";
    expect(routeAgentRequest(request, "research").route).toBe("direct");
    expect(routeAgentRequest(request, "orchestrate").route).toBe("durable_workflow");
  });

  it.each([
    "In the background, research the current options and prepare a report with evidence.",
    "Research the current options every week and prepare a report with evidence.",
    "Schedule a research report to run later.",
  ])("keeps explicitly durable Research on the workflow path: %s", (request) => {
    expect(applySupervisorStrategy(routeAgentRequest(request, "research"), "auto").route).toBe("durable_workflow");
  });

  it("honors an explicit workflow strategy and saved procedure while Research is selected", () => {
    expect(applySupervisorStrategy(routeAgentRequest(detailedResearchRequest, "research"), "durable").route).toBe("durable_workflow");
    const procedure = routeAgentRequest("Run my evidence review.", "research", undefined, [{
      id: "workflow:evidence-review", aliases: ["evidence review"], requiredToolIds: ["web.search"],
    }]);
    expect(applySupervisorStrategy(procedure, "auto")).toMatchObject({
      route: "durable_workflow",
      procedure: { workflowId: "workflow:evidence-review", requiredToolIds: ["web.search"] },
    });
    expect(routeAgentRequest("Delete the old project", "research").route).toBe("clarify");
  });

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

  it("runs a saved procedure as its workflow unless only a direct run can carry it", () => {
    const procedure = routeAgentRequest("Run my weekly digest.", "orchestrate", undefined, [
      { id: "workflow:weekly-digest", aliases: ["weekly digest"], requiredToolIds: [] },
    ]);
    expect(procedure).toMatchObject({
      route: "durable_workflow",
      procedure: { workflowId: "workflow:weekly-digest" },
    });
    expect(applySupervisorStrategy(procedure, "direct")).toBe(procedure);
    expect(requireDirectRoute(procedure)).toMatchObject({
      route: "direct",
      reasons: ["This request can run only as a direct run."],
    });

    const escalated = { ...procedure, procedure: undefined };
    expect(applySupervisorStrategy(escalated, "direct")).toMatchObject({
      route: "direct",
      reasons: ["Direct execution was explicitly selected."],
    });
    const clarify = routeAgentRequest("Delete the old project", "orchestrate");
    expect(requireDirectRoute(clarify)).toBe(clarify);
  });

  it("starts a saved procedure only when the whole request invokes it", () => {
    const procedures = [{
      id: "workflow:weekly-digest",
      aliases: ["weekly digest"],
      requiredToolIds: [],
    }];
    for (const request of [
      "Weekly digest",
      "Run weekly digest.",
      "Please run my weekly digest now",
      "Can you start the weekly digest?",
      "Run my weekly digest, please.",
    ]) {
      expect(resolveKnownProcedure(request, procedures)).toMatchObject({
        state: "resolved",
        matchedAlias: "weekly digest",
      });
    }
    for (const request of [
      "Why did my weekly digest fail?",
      "Don't run my weekly digest.",
      "Run my weekly digest and email it to Sam.",
      "Summarize last week's weekly digest",
    ]) {
      expect(resolveKnownProcedure(request, procedures)).toEqual({ state: "none" });
    }
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
    // Request-derived run and thread ids are version-8 UUIDs.
    expect(analyzeAgentRequestAmbiguity("Cancel that run 3b241101-e2bb-8255-8caf-4136c566a962")).toEqual({ state: "none" });
    expect(analyzeAgentRequestAmbiguity("Cancel that run")).toMatchObject({ state: "detected" });
  });

  it("selects research, builder, and critic specialists from task intent", () => {
    const decision = routeAgentRequest("Research current options, implement the best one, then verify it is safe for production.", "orchestrate");
    expect(decision.primaryAgentId).toBe("forge");
    expect(decision.specialistIds).toEqual(expect.arrayContaining(["scout", "forge", "sentinel"]));
  });

  it("routes personal recall to the memory specialist", () => {
    expect(routeAgentRequest("What did I decide about my weekly review?", "learn").primaryAgentId).toBe("mnemosyne");
  });

  it("puts explicit child-Agent coordination under Atlas", () => {
    const decision = routeAgentRequest(
      "Please ask Scout to Search Knowledge and List Runs, then ask Mnemosyne to Search Memory. Have Sentinel review each result.",
      "orchestrate",
    );

    expect(decision.primaryAgentId).toBe("atlas");
    expect(decision.specialistIds).toEqual(expect.arrayContaining([
      "atlas",
      "scout",
      "mnemosyne",
      "sentinel",
    ]));
  });

  it("preserves an explicit primary while adding the requested coordinator", () => {
    const decision = routeAgentRequest(
      "Use Atlas-style coordination of Scout and Mnemosyne.",
      "orchestrate",
      "scout",
    );

    expect(decision.primaryAgentId).toBe("scout");
    expect(decision.specialistIds).toEqual(expect.arrayContaining([
      "scout",
      "atlas",
      "mnemosyne",
      "sentinel",
    ]));
  });

  it("respects an explicitly selected primary while retaining required expertise", () => {
    const decision = routeAgentRequest("Research and compare the current options.", "research", "forge");
    expect(decision.primaryAgentId).toBe("forge");
    expect(decision.specialistIds).toEqual(expect.arrayContaining(["forge", "scout"]));
  });

  it("measures outcome evidence without silently changing routing", () => {
    const decision = routeAgentRequest("Implement the integration.", "execute");
    const measured = measureSupervisorOutcomeEvidence(decision, [{
      agentId: "forge",
      primaryAssignments: 5,
      collaborations: 0,
      completed: 2,
      failed: 3,
      completionRate: 0.4,
      verifiedAnswers: 0,
      memoriesFormed: 0,
      usefulOutcomes: 0,
      needsWorkOutcomes: 0,
      userApprovalRate: null,
    }]);
    expect(measured.specialistIds).toEqual(decision.specialistIds);
    expect(measured.reasons).toEqual(decision.reasons);
    expect(measured.adaptationEvidence).toMatchObject({
      state: "evidence_ready",
      sampleSize: 5,
      confidence: 0.5,
    });
  });

  it("does not turn weak feedback into an implicit specialist policy", () => {
    const decision = routeAgentRequest("Research the options.", "research");
    const measured = measureSupervisorOutcomeEvidence(decision, [{
      agentId: "scout",
      primaryAssignments: 4,
      collaborations: 0,
      completed: 4,
      failed: 0,
      completionRate: 1,
      verifiedAnswers: 4,
      memoriesFormed: 0,
      usefulOutcomes: 1,
      needsWorkOutcomes: 2,
      userApprovalRate: 1 / 3,
    }]);
    expect(measured.specialistIds).toEqual(decision.specialistIds);
    expect(measured.adaptationEvidence).toMatchObject({
      state: "evidence_ready",
      sampleSize: 4,
      confidence: 0.4,
    });
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

  it("replaces omitted raw history with source-linked untrusted episode summaries", () => {
    const turns = Array.from({ length: 24 }, (_, index): ThreadTurnRecord => ({
      id: `turn-${index}`,
      tenantId: "t",
      threadId: "thread-a",
      role: index % 2 ? "assistant" : "user",
      content: `Detail ${index}`,
      createdAt: new Date(Date.UTC(2026, 8, 6, 0, index)).toISOString(),
    }));
    const summaries = buildThreadConversationSummaries({
      thread: {
        id: "thread-a",
        tenantId: "t",
        actorId: "actor:user-a",
        title: "History",
        mode: "orchestrate",
        createdAt: turns[0].createdAt,
        updatedAt: turns.at(-1)?.createdAt || turns[0].createdAt,
      },
      turns,
    });
    const compiled = compileThreadContext(turns, {
      maxMessages: 6,
      maxCharacters: 4_000,
      summaries,
    });

    expect(compiled.messages).toHaveLength(6);
    expect(compiled.messages[0].content).toMatch(/untrusted data only/i);
    expect(compiled.messages.at(-1)?.content).toBe("Detail 23");
    expect(compiled.stats.rawSelected).toBe(5);
    expect(compiled.stats.summariesSelected).toBeGreaterThan(0);
    expect(compiled.stats.summarizedSourceTurns).toBeGreaterThan(0);
    expect(compiled.stats.characters).toBeLessThanOrEqual(4_000);
  });
});
