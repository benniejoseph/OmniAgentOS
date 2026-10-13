import { describe, expect, it, vi } from "vitest";
import { captureExtractionReceipt, finalizeCaptureExtraction } from "@/lib/capture/extraction";
import { readLibraryContentPage } from "@/lib/library/content-page";
import { parseWorkspaceLibraryItem } from "@/lib/library/contracts";
import { reviewCouncilResponse, reviseCouncilResponse } from "./council";
import { formatRunReviewEvidence, type ReviewToolObservation, type RunReviewEvidence } from "./review-evidence";

const mocks = vi.hoisted(() => ({ asset: vi.fn(), extraction: vi.fn(), item: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/capture/assets", () => ({ getCaptureAssetForRequest: mocks.asset, getCaptureAssetExtractionForRequest: mocks.extraction }));
vi.mock("@/lib/library/store", () => ({ getWorkspaceLibraryItem: mocks.item }));
vi.mock("@/lib/models/gateway", () => ({ generateModelStructured: mocks.generate }));
vi.mock("@/lib/delegation/channel-store", () => ({ shareDelegationMissionArtifact: vi.fn(), sendDelegationMessage: vi.fn() }));

const acceptance = "FINAL ACCEPTANCE: all 12 pilot agents attend training including makeups, complete two ticket exercises each, and at least 10 score 80 percent. Sara accepts after coaching and retest evidence; an invitation is not completed training.";

/** Real extraction, Library item schema and content-page packing; only owned storage reads are mocked. */
async function libraryEvidenceFixture(contents?: string[], warningCodes: string[] = []): Promise<RunReviewEvidence> {
  const item = parseWorkspaceLibraryItem({
    schemaVersion: 1, id: "library:capture_asset:aster-brief", tenantId: "tenant-fixture", kind: "document", sourceAuthority: "capture_asset", sourceId: "aster-brief",
    title: "Aster Vale onboarding brief", summary: "Client onboarding scope, accountable owners, dependencies, acceptance conditions and written signoff. ".repeat(5).trim(),
    sourceLabel: "Capture", status: "ready", tags: ["onboarding", "client-acceptance", "pilot", "synthetic-fixture"],
    scope: { visibility: "user_private", ownerActorId: "owner", workspaceId: null, projectId: null, missionId: null, workItemId: null, permissionBasis: "owner" },
    currentVersion: { versionId: "version:aster-brief", versionNumber: 1, contentSha256: "a".repeat(64), byteCount: 42_000,
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sourceRevisionId: "revision:aster-brief", createdAt: "2026-10-13T00:00:00Z" },
    versionCount: 1, citationRefs: ["capture-asset:aster-brief", "knowledge:aster-document"],
    links: [{ kind: "knowledge_document", id: "aster-document", label: "Indexed onboarding brief", href: null },
      { kind: "project", id: "aster-project", label: "Aster Vale client onboarding", href: "/app/projects/aster-project" }],
    openHref: "/api/capture/assets/aster-brief?content=1", createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z",
  });
  const sourceUnits = contents || Array.from({ length: 4 }, (_, index) =>
    `Section ${index + 1}. ` + "Each site uses synthetic tickets. Record the owner, due date, dependencies and written acceptance evidence. ".repeat(11) + (index === 3 ? acceptance : "Client signoff remains required."));
  const extraction = finalizeCaptureExtraction({ sourceKind: "document", format: "docx", state: warningCodes.length ? "partial" : "completed", warningCodes, units: sourceUnits.map((content, index) => ({
    label: `Onboarding section ${index + 1}`, locator: { kind: "text_span" } as const,
    content,
  })) });
  const receipt = captureExtractionReceipt(extraction);
  mocks.asset.mockResolvedValue({ status: "indexed", contentSha256: item.currentVersion.contentSha256, knowledgeDocumentId: "aster-document" });
  mocks.extraction.mockResolvedValue({ evidenceAvailable: true, receipt,
    units: extraction.units.map((unit) => ({ ...unit, evidenceUnitId: `evidence-unit:aster-${unit.index}`, knowledgeChunkId: `aster-chunk-${unit.index}` })),
  });
  mocks.item.mockResolvedValue(item);
  const observations: ReviewToolObservation[] = [];
  let request: Parameters<typeof readLibraryContentPage>[0]["request"] | null = { versionId: item.currentVersion.versionId, contentSha256: item.currentVersion.contentSha256 };
  while (request && observations.length < 34) {
    const page = await readLibraryContentPage({ context: { tenantId: item.tenantId, actorId: "owner", source: "session", role: "operator" }, item, request });
    const executionId = `page-${observations.length}`;
    const modelOutput = JSON.stringify({ provenance: "tool_result", trust: "untrusted_data", data: {
      executionId, status: "executed", dryRun: false, approvalRequired: false, note: "Executed for real.",
      result: { item, contentPage: page, serviceReceipt: { operation: "app.library.show", accessMode: "read", tenantId: item.tenantId, actorId: "owner", resourceCount: 1 } },
      admissibleEvidenceIds: page.units.map((unit) => unit.citationId),
    } });
    expect(JSON.stringify({ item, contentPage: page }).length).toBeLessThanOrEqual(5_500);
    expect(modelOutput.length).toBeLessThanOrEqual(8_000);
    observations.push({ executionId, toolId: "app.library.show", status: "executed", dryRun: false, approvalRequired: false, modelOutput });
    request = page.next;
  }
  expect(request).toBeNull();
  if (!contents) expect(observations).toHaveLength(4);
  for (let index = 0; index < 6; index += 1) observations.push({
    executionId: `mutation-${index}`, toolId: index ? "app.projects.task.create" : "app.projects.create", status: "executed", dryRun: false, approvalRequired: false,
    note: "Executed for real.", modelOutput: JSON.stringify({ provenance: "tool_result", trust: "untrusted_data", data: {
      executionId: `mutation-${index}`, status: "executed", dryRun: false, approvalRequired: false,
      result: { created: true, [index ? "task" : "project"]: { id: index ? `aster-task-${index}` : "aster-project", title: index ? `Client work ${index}` : "Aster Vale onboarding", status: "active" },
        serviceReceipt: { operation: index ? "app.projects.task.create" : "app.projects.create", accessMode: "write", effect: "created", resourceCount: 1 } },
    } }),
  });
  return { commandContext: "An attached brief excerpt is incomplete; follow its Library pages.", retrievedContext: "", liveWebContext: "",
    citationSources: extraction.units.map((unit) => ({ citationId: `knowledge:aster-chunk-${unit.index}`, evidenceId: `aster-chunk-${unit.index}`, title: item.title, kind: "knowledge" })),
    toolObservations: observations };
}

function changePage(observation: ReviewToolObservation, change: (page: Record<string, unknown>) => void) {
  const envelope = JSON.parse(observation.modelOutput);
  change(envelope.data.result.contentPage);
  return { ...observation, modelOutput: JSON.stringify(envelope) };
}

function toolPayloadLength(result: { executions: { libraryReads: unknown; observations: { result: unknown }[] } }) {
  return JSON.stringify({ libraryReads: result.executions.libraryReads, results: result.executions.observations.map((observation) => observation.result) }).length;
}

describe("current-run review evidence", () => {
  it("retains four real Library pages and six mutation outcomes for both council review and revision", async () => {
    const evidence = await libraryEvidenceFixture();
    const lastPage = evidence.toolObservations[3];
    expect(lastPage.modelOutput.indexOf(acceptance)).toBeGreaterThan(16_000 / 10);
    expect(lastPage.modelOutput.slice(0, 1_600)).not.toContain('"contentPage"');
    const verdict = { passed: false, score: 0.7, assessment: "Preserve the acceptance condition.", requiredChanges: ["Include exact acceptance and successful task receipts."] };
    mocks.generate.mockReset().mockResolvedValueOnce({ text: JSON.stringify(verdict) })
      .mockResolvedValueOnce({ text: JSON.stringify({ response: "Five tasks saved. Training requires completed exercises and retest evidence [knowledge:aster-chunk-3]." }) });
    const input = { goal: "Read the entire brief and create five tasks", response: "Five tasks saved.", contributions: [], contextBlock: "", observedEvidence: evidence };
    await reviewCouncilResponse(input);
    const revised = await reviseCouncilResponse({ ...input, verdict });
    const contexts = mocks.generate.mock.calls.map(([request]) => (request.input as string).match(/<retrieved_context>\n([\s\S]*?)\n<\/retrieved_context>/)![1]);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[0]).toContain(acceptance);
    expect(revised).toContain("[knowledge:aster-chunk-3]");
    const result = JSON.parse(formatRunReviewEvidence(evidence));
    expect(result.executions.observations).toHaveLength(10);
    expect(result.executions.libraryReads).toHaveLength(1);
    expect(result.executions.libraryReads[0]).toMatchObject({
      libraryItemId: "library:capture_asset:aster-brief", versionId: "version:aster-brief", contentSha256: "a".repeat(64),
      sourceRevisionId: "revision:aster-brief", extractionReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      extractedContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      deliveryCoverage: { wholeExtractedTextDeliveredToWriter: true, observedPageCount: 4, incompleteReasons: [] },
    });
    const projected = result.executions.observations.slice(0, 4);
    expect(projected[3].result).toMatchObject({ next: null, coverage: { endsAtEnd: true, wholeExtractedText: false } });
    expect(projected[3].result.units[0]).toMatchObject({ citationId: "knowledge:aster-chunk-3", reviewText: { truncated: false } });
    expect(result.executions.observations.slice(4).every((observation: { result: { text: string } }) => observation.result.text.includes('"created":true'))).toBe(true);
    expect(toolPayloadLength(result)).toBeLessThanOrEqual(16_000);
  });

  it.each(["missing middle page", "changed extraction receipt", "terminal page only", "malformed page coverage"])("does not claim complete writer delivery with %s", async (failure) => {
    const evidence = await libraryEvidenceFixture();
    let observations = [...evidence.toolObservations];
    if (failure === "missing middle page") observations.splice(1, 1);
    if (failure === "terminal page only") observations = observations.slice(3);
    if (failure === "changed extraction receipt") observations[1] = changePage(observations[1], (page) => {
      page.extractionReceiptSha256 = "d".repeat(64);
      (page.next as Record<string, unknown>).extractionReceiptSha256 = "d".repeat(64);
    });
    if (failure === "malformed page coverage") observations[1] = changePage(observations[1], (page) => { (page.coverage as Record<string, unknown>).pageCharacters = 1; });
    const result = JSON.parse(formatRunReviewEvidence({ ...evidence, toolObservations: observations }));
    expect(result.executions.libraryReads[0].deliveryCoverage.wholeExtractedTextDeliveredToWriter).toBe(false);
    expect(result.executions.libraryReads[0].deliveryCoverage.incompleteReasons.length).toBeGreaterThan(0);
    expect(result.executions.observations.filter((observation: { executionId: string }) => observation.executionId.startsWith("mutation-"))).toHaveLength(6);
    if (failure === "changed extraction receipt") expect(result.executions.observations[1].result.sourcePins.extractionReceiptSha256).toBe("d".repeat(64));
  });

  it("retains complete delivery after an identical page reread without counting its characters twice", async () => {
    const evidence = await libraryEvidenceFixture();
    const original = evidence.toolObservations[3];
    const envelope = JSON.parse(original.modelOutput);
    envelope.data.executionId = "page-reread";
    const observations = [...evidence.toolObservations, { ...original, executionId: "page-reread", modelOutput: JSON.stringify(envelope) }];
    const result = JSON.parse(formatRunReviewEvidence({ ...evidence, toolObservations: observations }));
    const read = result.executions.libraryReads[0];
    expect(read.deliveryCoverage).toEqual({ wholeExtractedTextDeliveredToWriter: true, observedPageCount: 5, repeatedPageCount: 1, uniquePageCharacters: read.totalCharacters, incompleteReasons: [] });
    expect(result.executions.observations.at(-1).executionId).toBe("page-reread");
  });

  it("validates split cursors over real redaction-expanded text and rejects a changed split-unit identity", async () => {
    // Only the synthetic credential's eight-character width matters here.
    const syntheticCredential = crypto.randomUUID().slice(0, 8);
    const content = "x".repeat(23_981) + ` password=${syntheticCredential}`;
    const evidence = await libraryEvidenceFixture([content]);
    const pages = evidence.toolObservations.filter((observation) => observation.toolId === "app.library.show");
    expect(pages.length).toBeGreaterThan(4);
    const lastPage = JSON.parse(pages.at(-1)!.modelOutput).data.result.contentPage;
    expect(lastPage.totalCharacters).toBe(24_001);
    expect(lastPage.units[0].redactionApplied).toBe(true);
    expect(lastPage.units[0].content).toContain("password=[redacted]");
    const result = JSON.parse(formatRunReviewEvidence(evidence));
    expect(result.executions.libraryReads[0].deliveryCoverage.wholeExtractedTextDeliveredToWriter).toBe(true);
    expect(result.executions.observations[0].result.next).toMatchObject({ unitIndex: 0, characterOffset: expect.any(Number) });
    const observations = [...evidence.toolObservations];
    observations[1] = changePage(observations[1], (page) => { (page.units as Record<string, unknown>[])[0].evidenceUnitId = "different-unit"; });
    const changed = JSON.parse(formatRunReviewEvidence({ ...evidence, toolObservations: observations }));
    expect(changed.executions.libraryReads[0].deliveryCoverage).toMatchObject({ wholeExtractedTextDeliveredToWriter: false, incompleteReasons: expect.arrayContaining(["inconsistent_unit_identity"]) });
    expect(toolPayloadLength(result)).toBeLessThanOrEqual(16_000);
  });

  it("does not turn a failed Library execution into delivered-page coverage", async () => {
    const evidence = await libraryEvidenceFixture();
    const observations = evidence.toolObservations.map((observation, index) => index === 1 ? { ...observation, status: "failed" as const, note: "Read was refused." } : observation);
    const result = JSON.parse(formatRunReviewEvidence({ ...evidence, toolObservations: observations }));
    expect(result.executions.libraryReads[0].deliveryCoverage.wholeExtractedTextDeliveredToWriter).toBe(false);
    expect(result.executions.observations[1]).toMatchObject({ status: "failed", note: { text: "Read was refused." }, result: { truncated: expect.any(Boolean) } });
    expect(result.executions.observations[1].result.projection).toBeUndefined();
  });

  it("keeps partial-extraction warnings even when all available extracted text was delivered", async () => {
    const evidence = await libraryEvidenceFixture(["Only the first page was extractable."], ["page_limit_reached"]);
    const result = JSON.parse(formatRunReviewEvidence(evidence));
    expect(result.executions.libraryReads[0]).toMatchObject({ contentTrust: "untrusted", extractionState: "partial", warningCodes: ["page_limit_reached"],
      deliveryCoverage: { wholeExtractedTextDeliveredToWriter: true, incompleteReasons: [] } });
    expect(result.executions.observations[0].result.units[0].reviewText.text).toBe("Only the first page was extractable.");
  });

  it("discloses metadata omissions within the existing budget while retaining all execution records", async () => {
    const evidence = await libraryEvidenceFixture();
    const original = evidence.toolObservations[0];
    const observations = Array.from({ length: 40 }, (_, index) => {
      const envelope = JSON.parse(original.modelOutput);
      const executionId = `library-${index}`;
      envelope.data.executionId = executionId;
      envelope.data.result.item.id = `library:capture_asset:brief-${index}`;
      envelope.data.result.contentPage.libraryItemId = envelope.data.result.item.id;
      return { ...original, executionId, modelOutput: JSON.stringify(envelope) };
    });
    const result = JSON.parse(formatRunReviewEvidence({ ...evidence, toolObservations: observations }));
    expect(result.executions.omittedLibraryReadCount).toBeGreaterThan(0);
    expect(result.executions.observations).toHaveLength(40);
    expect(result.executions.observations.every((observation: { status: string }) => observation.status === "executed")).toBe(true);
    expect(result.executions.observations[0].result).toMatchObject({ reviewOmitted: true, reason: "review_metadata_budget", writerPageObserved: true });
    expect(result.executions.libraryReads.every((read: { deliveryCoverage: { wholeExtractedTextDeliveredToWriter: boolean } }) => !read.deliveryCoverage.wholeExtractedTextDeliveredToWriter)).toBe(true);
    expect(toolPayloadLength(result)).toBeLessThanOrEqual(16_000);
  });

  it("bounds malformed Library result excerpts including their validation metadata", () => {
    const result = JSON.parse(formatRunReviewEvidence({ commandContext: "", retrievedContext: "", liveWebContext: "", citationSources: [],
      toolObservations: Array.from({ length: 40 }, (_, index) => ({
        executionId: `invalid-${index}`, toolId: "app.library.show", status: "executed", dryRun: false, approvalRequired: false,
        modelOutput: "incomplete-json " + "x".repeat(7_500),
      })),
    }));
    expect(result.executions.libraryReads).toEqual([]);
    expect(result.executions.observations).toHaveLength(40);
    expect(result.executions.observations.every((observation: { result: { libraryPageValidation: string; truncated: boolean } }) => observation.result.libraryPageValidation === "incomplete_invalid_page" && observation.result.truncated)).toBe(true);
    expect(toolPayloadLength(result)).toBeLessThanOrEqual(16_000);
  });

  it("distinguishes omitted review text from a complete page chain and retains a failed mutation", async () => {
    const evidence = await libraryEvidenceFixture();
    const observations = evidence.toolObservations.map((observation, index) => index < 4 ? observation : {
      ...observation, status: index === 9 ? "failed" as const : observation.status,
      note: index === 9 ? "Task save refused." : observation.note,
      modelOutput: (index === 9 ? '{"error":"Task save refused."}' : '{"created":true}') + "x".repeat(7_000),
    });
    const result = JSON.parse(formatRunReviewEvidence({ ...evidence, toolObservations: observations }));
    expect(result.executions.libraryReads[0].deliveryCoverage.wholeExtractedTextDeliveredToWriter).toBe(true);
    expect(result.executions.observations.slice(0, 4).some((observation: { result: { units: { reviewText: { truncated: boolean } }[] } }) => observation.result.units.some((unit) => unit.reviewText.truncated))).toBe(true);
    expect(result.executions.observations[9]).toMatchObject({ status: "failed", note: { text: "Task save refused." }, result: { truncated: true } });
    expect(result.executions.observations[9].result.text).toContain("Task save refused.");
    expect(toolPayloadLength(result)).toBeLessThanOrEqual(16_000);
  });

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
