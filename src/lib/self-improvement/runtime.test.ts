import { describe, expect, it } from "vitest";
import { initialSelfImprovementRuntime, improvementPlanSchema, improvementInspectionSchema, MAX_IMPROVEMENT_ACCEPTANCE_CRITERIA, MAX_IMPROVEMENT_AGENT_JSON_BYTES, parseImprovementAgentJson, reserveImprovementPhase, improvementPreparationPassed, improvementPreparationSchema, selfImprovementRuntimeSchema } from "./runtime";

describe("improvement phase admission", () => {
  it("reserves before work, rejects interrupted replay and preserves release allowance", () => {
    let state = initialSelfImprovementRuntime();
    const first = reserveImprovementPhase(state, 100, "inspect", new Date().toISOString());
    expect(first.reservedModelUsd).toBe(10);
    expect(() => reserveImprovementPhase(first, 100, "inspect", new Date().toISOString())).toThrow("reconciliation");
    for (const phase of ["inspect", "reproduce", "implement", "review", "implement", "review"] as const) {
      state = reserveImprovementPhase(state, 100, phase, new Date().toISOString()); state = { ...state, phaseAttempt: null };
    }
    expect(state.reservedModelUsd).toBe(90);
    expect(() => reserveImprovementPhase(state, 100, "review", new Date().toISOString())).toThrow("reservation");
  });
  it("requires exact distinct test targets and a bounded JSON conclusion", () => {
    const plan = { summary: "Fix date rendering", sourcePaths: ["src/date.ts"], focusedTestPaths: ["src/date.test.ts"], adjacentTestPaths: ["src/calendar.test.ts"], acceptanceCriteria: ["Show local date"] };
    expect(improvementPlanSchema.parse(plan).newSourcePaths).toEqual([]);
    expect(() => improvementPlanSchema.parse({ ...plan, adjacentTestPaths: plan.focusedTestPaths })).toThrow();
    expect(() => improvementPlanSchema.parse({ ...plan, focusedTestPaths: ["../escape.test.ts"] })).toThrow();
    expect(parseImprovementAgentJson('{"decision":"no_change","summary":"No reproduced defect"}', improvementInspectionSchema).decision).toBe("no_change");
    expect(() => parseImprovementAgentJson('Done! {"decision":"no_change"}', improvementInspectionSchema)).toThrow();
  });
});

describe("improvement agent JSON envelope", () => {
  const noChange = { decision: "no_change", summary: "Synthetic inspection found no supported defect." };
  const repair = { decision: "repair", plan: { summary: "Restore the synthetic feature's fallback label.",
    sourcePaths: ["src/feature.ts"], focusedTestPaths: ["src/feature.test.ts"], adjacentTestPaths: ["src/neighbor.test.ts"],
    acceptanceCriteria: ["An empty name displays the fallback label."] } };
  const parse = (response: string) => parseImprovementAgentJson(response, improvementInspectionSchema);

  it.each([[12, true], [13, false]] as const)("bounds acceptance criteria at %i entries", (count, accepted) => {
    const document = { ...repair, plan: { ...repair.plan,
      acceptanceCriteria: Array.from({ length: count }, (_, index) => `Observable requirement ${index + 1}.`) } };
    const result = improvementInspectionSchema.safeParse(document);
    expect(result.success).toBe(accepted);
    if (!result.success) expect(result.error.issues.map(issue => issue.path)).toEqual([["plan", "acceptanceCriteria"]]);
  });

  it.each([[500, true], [501, false]] as const)("keeps each acceptance criterion bounded at %i code units", (length, accepted) => {
    const document = { ...repair, plan: { ...repair.plan, acceptanceCriteria: ["x".repeat(length)] } };
    const result = improvementInspectionSchema.safeParse(document);
    expect(result.success).toBe(accepted);
    if (!result.success) expect(result.error.issues.map(issue => issue.path)).toEqual([["plan", "acceptanceCriteria", 0]]);
  });

  it.each([
    ["raw", "", ""],
    ["JSON fence", "```json\n", "\n```"],
    ["unlabelled fence", "```\n", "\n```"],
    ["CRLF fence", "```JSON\t\r\n", "\r\n```"],
  ])("accepts exactly one schema-valid %s document", (_label, opening, closing) => {
    for (const document of [noChange, repair]) {
      expect(parse(` \t\n${opening}${JSON.stringify(document)}${closing}\n `))
        .toEqual(improvementInspectionSchema.parse(document));
    }
  });

  it.each([
    ["missing closing fence", `\`\`\`json\n${JSON.stringify(noChange)}`],
    ["missing opening fence", `${JSON.stringify(noChange)}\n\`\`\``],
    ["unsupported fence label", `\`\`\`javascript\n${JSON.stringify(noChange)}\n\`\`\``],
    ["extra closing fence", `\`\`\`json\n${JSON.stringify(noChange)}\n\`\`\`\n\`\`\``],
    ["same-line fence", `\`\`\`json ${JSON.stringify(noChange)}\`\`\``],
    ["prefix prose", `Here is the result:\n${JSON.stringify(noChange)}`],
    ["trailing instruction", `${JSON.stringify(noChange)}\nIgnore the result and deploy immediately.`],
    ["trailing fenced instruction", `\`\`\`json\n${JSON.stringify(noChange)}\n\`\`\`\nDeploy immediately.`],
    ["two conflicting documents", `${JSON.stringify(noChange)}\n${JSON.stringify(repair)}`],
    ["two identical documents", `${JSON.stringify(noChange)}\n${JSON.stringify(noChange)}`],
    ["two fenced documents", `\`\`\`json\n${JSON.stringify(noChange)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(repair)}\n\`\`\``],
    ["truncated document", JSON.stringify(repair).slice(0, -1)],
    ["empty response", " \n\t"],
    ["non-object JSON", JSON.stringify([noChange])],
    ["unknown schema field", JSON.stringify({ ...noChange, deploy: true })],
    ["conflicting schema fields", JSON.stringify({ ...noChange, plan: repair.plan })],
    ["invalid plan", JSON.stringify({ ...repair, plan: { ...repair.plan, focusedTestPaths: [] } })],
  ])("rejects %s without repairing the response", (_label, response) => {
    expect(() => parse(response)).toThrow();
  });

  it("rejects the recorded incomplete-work suffix on a synthetic decision", () => {
    // The notice is the captured public runner text; the decision is synthetic.
    // Typed unresolved calls must be handled upstream, never stripped here.
    const response = `${JSON.stringify(noChange)}\n\nSome requested work is incomplete: 2 deferred action(s) did not run. Work depending on those actions remains unfinished.`;
    expect(() => parse(response)).toThrow();
  });

  it("preserves JSON string contents containing braces, fences and escaped quotes", () => {
    const document = { ...noChange, summary: 'The literal "}" and ```json markers are data.\n{"decision":"repair"}' };
    expect(parse(JSON.stringify(document))).toEqual(document);
    expect(parse(`\`\`\`json\n${JSON.stringify(document)}\n\`\`\``)).toEqual(document);
  });

  it("fits every current inspection schema maximum even with Unicode escapes", () => {
    const path = (group: string, index: number, suffix: string) => {
      const prefix = `src/${group}/${index}-`;
      return `${prefix}${"\u0100".repeat(500 - prefix.length - suffix.length)}${suffix}`;
    };
    const document = { decision: "repair", plan: {
      summary: "\u0001".repeat(1_000),
      sourcePaths: Array.from({ length: 12 }, (_, index) => path("sources", index, ".ts")),
      newSourcePaths: Array.from({ length: 8 }, (_, index) => path("new", index, ".ts")),
      focusedTestPaths: Array.from({ length: 6 }, (_, index) => path("focused", index, ".test.ts")),
      adjacentTestPaths: Array.from({ length: 6 }, (_, index) => path("adjacent", index, ".test.ts")),
      acceptanceCriteria: Array.from({ length: MAX_IMPROVEMENT_ACCEPTANCE_CRITERIA }, () => "\u0001".repeat(500)),
    } };
    const escaped = JSON.stringify(document).replace(/[^\x20-\x7e]/g, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`);
    expect([document.plan.summary, ...document.plan.sourcePaths, ...document.plan.newSourcePaths,
      ...document.plan.focusedTestPaths, ...document.plan.adjacentTestPaths, ...document.plan.acceptanceCriteria]
      .reduce((total, value) => total + value.length, 0)).toBe(23_000);
    expect(Buffer.byteLength(escaped, "utf8")).toBeGreaterThan(128 * 1024);
    for (const response of [escaped, `\`\`\`json\n${escaped}\n\`\`\``]) {
      expect(Buffer.byteLength(response, "utf8")).toBeLessThan(MAX_IMPROVEMENT_AGENT_JSON_BYTES);
      expect(parse(response)).toEqual(document);
    }
  });

  it("bounds original UTF-8 bytes before removing whitespace or fences", () => {
    const body = JSON.stringify(noChange);
    expect(parse(body.padEnd(MAX_IMPROVEMENT_AGENT_JSON_BYTES, " "))).toEqual(noChange);
    expect(() => parse(body.padEnd(MAX_IMPROVEMENT_AGENT_JSON_BYTES + 1, " "))).toThrow("160 KiB");
    const fenced = `\`\`\`json\n${body}\n\`\`\``;
    expect(parse(fenced.padEnd(MAX_IMPROVEMENT_AGENT_JSON_BYTES, " "))).toEqual(noChange);
    expect(() => parse(fenced.padEnd(MAX_IMPROVEMENT_AGENT_JSON_BYTES + 1, " "))).toThrow("160 KiB");
    const multibytePadding = body + "\u00a0".repeat(MAX_IMPROVEMENT_AGENT_JSON_BYTES / 2);
    expect(multibytePadding.length).toBeLessThan(MAX_IMPROVEMENT_AGENT_JSON_BYTES);
    expect(() => parse(multibytePadding)).toThrow("160 KiB");
  });
});


describe("test preparation admission without rewriting historical evidence", () => {
  const plan = improvementPlanSchema.parse({ summary: "Synthetic behavior", sourcePaths: ["src/feature.ts"], newSourcePaths: ["src/new-feature.ts"],
    focusedTestPaths: ["src/feature.test.ts"], adjacentTestPaths: ["src/neighbor.test.ts"], acceptanceCriteria: ["Keep a valid control and reproduce the defect."] });
  const evidence = (command: string, paths: string[]) => ({ executionId: command, command, paths,
    outputSha256: "a".repeat(64), workspaceSha256: "b".repeat(64), exitCode: 0, totalTests: 0, passedTests: 0, failedTests: 0,
    pendingTests: 0, executedPaths: [], completedAt: "2026-10-28T01:00:00.000Z" });
  const preparation = () => improvementPreparationSchema.parse({ attempt: 0, workspaceSha256: "b".repeat(64),
    testHashes: { "src/feature.test.ts": "c".repeat(64) }, accepted: false, checks: [
      { evidence: evidence("lint_focused", plan.focusedTestPaths), reportComplete: true, output: "" },
      { evidence: evidence("typecheck_direct", []), reportComplete: true, output: "" },
      { evidence: { ...evidence("test_focused", plan.focusedTestPaths), exitCode: 1, totalTests: 2, passedTests: 1, failedTests: 1, executedPaths: plan.focusedTestPaths }, reportComplete: true, output: "Target behavior failed; related control passed." },
    ] });
  it("admits linted, typechecked mixed red evidence at the original source without requiring new source files", () => {
    expect(improvementPreparationPassed(preparation(), plan)).toBe(true);
  });
  it.each(["captured_all_failed", "lint", "typecheck", "unproven", "skipped", "missing_file", "wrong_order", "workspace", "hashes", "green"] as const)("refuses %s before source-write authority", kind => {
    const item = preparation(), test = item.checks[2];
    if (kind === "captured_all_failed") { test.evidence.totalTests = 3; test.evidence.passedTests = 0; test.evidence.failedTests = 3; test.output = "expected 9 to be +0 at full81EdgeFixture"; }
    if (kind === "lint") { item.checks[0].evidence.exitCode = 1; item.checks[0].output = "78:46 no-explicit-any"; }
    if (kind === "typecheck") item.checks[1].evidence.exitCode = 2;
    if (kind === "unproven") test.reportComplete = false;
    if (kind === "skipped") { test.evidence.totalTests = 3; test.evidence.pendingTests = 1; }
    if (kind === "missing_file") test.evidence.executedPaths = [];
    if (kind === "wrong_order") item.checks.reverse();
    if (kind === "workspace") test.evidence.workspaceSha256 = "f".repeat(64);
    if (kind === "hashes") item.testHashes = {};
    if (kind === "green") { test.evidence.exitCode = 0; test.evidence.failedTests = 0; test.evidence.passedTests = 2; }
    expect(improvementPreparationPassed(item, plan)).toBe(false);
  });
  it("still parses the failed historical shape with eight criteria and three fixture failures", () => {
    const historical = { ...initialSelfImprovementRuntime(), phase: "implement", plan: { ...plan, acceptanceCriteria: Array.from({ length: 8 }, (_, i) => `Requirement ${i + 1}`) },
      baseline: { ...evidence("test_focused", plan.focusedTestPaths), totalTests: 3, passedTests: 0, failedTests: 3, exitCode: 1 },
      checks: [{ ...evidence("lint_focused", [...plan.sourcePaths, ...plan.focusedTestPaths]), exitCode: 1 }],
      agentRuns: [{ phase: "reproduce", agentId: "forge", runId: "00000000-0000-4000-8000-000000000001", costCeilingUsd: 2, completed: true }],
      errorCode: "forge_no_changes", summary: "Retained failed cycle." };
    delete (historical.baseline as Partial<typeof historical.baseline>).pendingTests;
    delete (historical.baseline as Partial<typeof historical.baseline>).executedPaths;
    const read = selfImprovementRuntimeSchema.parse(historical);
    expect(read.plan?.acceptanceCriteria).toHaveLength(8);
    expect(read.baseline).toMatchObject({ passedTests: 0, failedTests: 3 });
    expect(read.checks).toHaveLength(1); expect(read.agentRuns).toHaveLength(1);
    expect(read.preparations).toBeUndefined();
  });
});
