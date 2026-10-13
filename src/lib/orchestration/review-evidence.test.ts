import { describe, expect, it } from "vitest";
import { formatRunReviewEvidence, type RunReviewEvidence } from "./review-evidence";

describe("current-run review evidence", () => {
  it("keeps a recent user correction visible after a long earlier message", () => {
    const result = JSON.parse(formatRunReviewEvidence({
      commandContext: "", retrievedContext: "", liveWebContext: "", citationSources: [], toolObservations: [],
      conversation: [
        { role: "user", content: "Old tentative date. " + "x".repeat(20_000) },
        { role: "assistant", content: "Tentative summary; no action receipt." },
        { role: "user", content: "Correction: accepted mapping deadline is October 17." },
      ],
    }));
    expect(result.conversation.messages[0].content.truncated).toBe(true);
    expect(result.conversation.messages[2]).toMatchObject({ role: "user", content: { text: "Correction: accepted mapping deadline is October 17.", truncated: false } });
  });

  it("reserves each source class and every included execution status when results exceed the review budget", () => {
    const input: RunReviewEvidence = {
      commandContext: "ATTACHED " + "a".repeat(20_000),
      commandContextReceiptSha256: "c".repeat(64),
      retrievedContext: "SAVED " + "b".repeat(20_000),
      liveWebContext: "WEB " + "c".repeat(20_000),
      citationSources: [{ citationId: "knowledge:attached", evidenceId: "attached", title: "Brief", kind: "knowledge" }],
      toolObservations: Array.from({ length: 6 }, (_, index) => ({
        executionId: `execution-${index}`, toolId: "app.projects.show",
        status: index === 5 ? "failed" : "executed", dryRun: false, approvalRequired: false,
        note: index === 5 ? "Scoped read rejected." : "Executed for real.",
        modelOutput: `RESULT-${index} ` + "r".repeat(8_000),
      })),
    };
    const result = JSON.parse(formatRunReviewEvidence(input));
    expect(result.commandContext).toMatchObject({ truncated: true, includedCharacters: 10_000, omittedCharacters: 10_009 });
    expect(result.retrievedContext.text).toContain("SAVED");
    expect(result.liveWebContext.text).toContain("WEB");
    expect(result.citationCatalog.text).toContain("knowledge:attached");
    expect(result.executions).toMatchObject({ observedCount: 6, includedCount: 6, omittedEarlierCount: 0 });
    expect(result.executions.observations.map((item: { status: string }) => item.status)).toEqual(["executed", "executed", "executed", "executed", "executed", "failed"]);
    expect(result.executions.observations.every((item: { result: { truncated: boolean } }) => item.result.truncated)).toBe(true);
    expect(result.executions.observations[5].note.text).toBe("Scoped read rejected.");
    expect(formatRunReviewEvidence(input).length).toBeLessThan(44_000);
  });

  it("discloses omitted older observations without merging an empty result, failure and dry run", () => {
    const result = JSON.parse(formatRunReviewEvidence({
      commandContext: "", retrievedContext: "", liveWebContext: "", citationSources: [],
      toolObservations: Array.from({ length: 42 }, (_, index) => ({
        executionId: `execution-${index}`, toolId: "app.projects.list",
        status: index === 41 ? "dry_run" : "executed", dryRun: index === 41, approvalRequired: false,
        modelOutput: '{"projects":[]}',
      })),
    }));
    expect(result.executions).toMatchObject({ observedCount: 42, includedCount: 40, omittedEarlierCount: 2 });
    expect(result.executions.observations[0].executionId).toBe("execution-2");
    expect(result.executions.observations[39]).toMatchObject({ status: "dry_run", dryRun: true });
    expect(result.executions.observations[0].result.text).toBe('{"projects":[]}');
  });
});
