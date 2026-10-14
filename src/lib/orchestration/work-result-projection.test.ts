import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PersonalProject, ProjectTask } from "@/lib/projects/types";
import { projectTaskCanonicalProjection } from "@/lib/workspaces/legacy-projection";
import { canonicalWorkItemSurfaceSchema } from "@/lib/workspaces/surface";
import { reviewCouncilResponse, reviseCouncilResponse } from "./council";
import { formatRunReviewEvidence, REVIEW_EVIDENCE_INSTRUCTIONS, type ReviewToolObservation } from "./review-evidence";
import { observedWorkResult, projectWorkToolResult, workResultProjectionSchema, WORK_RESULT_CHARACTERS } from "./work-result-projection";

const mocks = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@/lib/models/gateway", () => ({ generateModelStructured: mocks.generate }));
vi.mock("@/lib/delegation/channel-store", () => ({ shareDelegationMissionArtifact: vi.fn(), sendDelegationMessage: vi.fn() }));

const now = "2026-10-14T08:00:00.000Z";
const authority = { workspaceId: "workspace:personal:123e4567-e89b-42d3-a456-426614174000", canonicalOwnerActorId: "actor:123e4567-e89b-42d3-a456-426614174000" };
const project: PersonalProject = {
  id: "project_c1d3b3a692ec69058dd02776dcf2c093c200497d", tenantId: "tenant-client-123e4567-e89b-42d3-a456-426614174000", actorId: "owner@example.test", title: "Client", objective: "Criteria remain in force",
  status: "active", autonomyMode: "manual", executionStatus: "idle", taskBudget: 12, tasksDispatched: 0, maxParallelTasks: 1, requireApproval: true, createdAt: now, updatedAt: now,
};
function fixture(index = 0, overrides: Partial<ProjectTask> = {}) {
  const task: ProjectTask = {
    id: `project_task_${String(index).padStart(40, "0")}`, tenantId: project.tenantId, projectId: project.id,
    title: `Client task ${index}: Confirm accountable owner, readiness dependencies and written acceptance`, detail: `Acceptance criteria for client task ${index} remain explicit. ` + "x".repeat(800) + " Require written acceptance; an invitation is not completion.",
    status: "open", priority: "medium", agentId: "atlas", position: index, origin: "manual", dependsOn: ["sandbox"], humanOwner: "Jonah Patel", dueDate: "2026-10-17",
    dispatchAttempt: 0, createdAt: now, updatedAt: now, ...overrides,
  };
  const canonical = projectTaskCanonicalProjection(project, task, [], authority, 1);
  const item = canonical.projection;
  const surface = canonicalWorkItemSurfaceSchema.parse({
    version: "p11.4-work-item-surface:1",
    projection: { authority: "canonical_work_item_v1", sha256: canonical.projectionSha256, sourceRevisionSha256: canonical.sourceRevisionSha256 },
    status: { schemaVersion: 1, authority: "canonical_work_item_v1", persistence: "postgres", workspaceId: item.workspaceId, projectId: item.projectId,
      workItemId: item.workItemId, kind: "task", sourceAuthority: "legacy_project_task", sourceId: task.id, status: item.canonicalStatus,
      sourceStatus: item.sourceStatus, statusRevision: 1, updatedAt: now },
    assignment: { authority: "canonical_work_item_v1", agents: item.assignedAgents },
    artifacts: { authority: "canonical_work_item_v1", count: 0, items: [] },
    execution: { authority: "governed_workflow_v1", availability: "not_started", workflowRunId: null, sourceStatus: null, currentStep: null, completedSteps: 0, totalSteps: 0, progressPercent: null, updatedAt: null },
    cost: { authority: "ai_usage_ledger_v1", state: "not_recorded", usageReceiptCount: 0, unknownCostReceiptCount: 0, totalTokens: 0, knownEstimatedCostMicrousd: 0 },
  });
  const read = { workItem: item, projectionSha256: canonical.projectionSha256,
    dependencies: item.dependencyWorkItemIds.map((id) => ({ id, state: "available", canonicalStatus: "unverified", sourceStatus: "done", projectionSha256: "d".repeat(64), updatedAt: now })),
    revisionSha256: "e".repeat(64), checkedAt: now, serviceReceipt: { operation: "app.work_items.show" } };
  return { task, read, update: { workItem: { ...task, workItemStatus: surface.status, workItem: surface }, serviceReceipt: { operation: "app.work_items.update" } } };
}
function observation(toolId: string, raw: unknown, executionId = "execution-fixture", approvalRequired = false): ReviewToolObservation {
  const envelope = (result: unknown) => JSON.stringify({ provenance: "tool_result", trust: "untrusted_data", data: {
    executionId, status: "executed", dryRun: false, approvalRequired, note: "Executed for real.", result, admissibleEvidenceIds: [],
  } });
  const full = envelope(raw);
  const modelOutput = full.length <= 8_000 ? full : envelope(projectWorkToolResult(toolId, raw));
  expect(modelOutput.length).toBeLessThanOrEqual(8_000);
  return { toolId, executionId, status: "executed", dryRun: false, approvalRequired, modelOutput };
}

type ReviewedWork = { workItemIndex: number; detailIndex: number; dependencies: { items: unknown[] } };
function payloadSize(result: { executions: { libraryReads: unknown; workItems: unknown; workDetails: unknown; observations: { result: unknown }[] } }) {
  const { libraryReads, workItems, workDetails, observations } = result.executions;
  return JSON.stringify({ libraryReads, workItems, workDetails, results: observations.map(item => item.result) }).length;
}
function clientLibraryPages(): ReviewToolObservation[] {
  return [4, 3, 3].flatMap((pageCount, document) => {
    const libraryItemId = `library:capture_asset:client-document-${document}-123e4567-e89b-42d3-a456-426614174000`;
    const versionId = `version:client-document-${document}-123e4567-e89b-42d3-a456-426614174000`;
    const contentSha256 = String(document + 1).repeat(64), extractionReceiptSha256 = String(document + 4).repeat(64);
    const content = `Document ${document}: preserve source acceptance. ` + "Client evidence and acceptance. ".repeat(30);
    return Array.from({ length: pageCount }, (_, index) => {
      const executionId = `document-${document}-page-${index}`, citationId = `knowledge:client-document-${document}-chunk-${index}`;
      const contentPage = { schemaVersion: 1, libraryItemId, versionId, contentSha256,
        sourceRevisionId: `revision:client-document-${document}`, extractionReceiptSha256, extractedContentSha256: "a".repeat(64),
        contentTrust: "untrusted", extractionState: "completed", warningCodes: [], totalUnitCount: pageCount, totalCharacters: content.length * pageCount,
        start: { unitIndex: index, characterOffset: 0 },
        next: index < pageCount - 1 ? { unitIndex: index + 1, characterOffset: 0, versionId, contentSha256, extractionReceiptSha256 } : null,
        coverage: { startsAtBeginning: index === 0, endsAtEnd: index === pageCount - 1, wholeExtractedText: false, pageCharacters: content.length },
        units: [{ index, evidenceUnitId: `evidence:client-document-${document}-unit-${index}`, knowledgeChunkId: `client-document-${document}-chunk-${index}`,
          citationId, citationToken: `[${citationId}]`, characterOffset: 0, endCharacterOffset: content.length, totalCharacters: content.length, content, redactionApplied: false }],
      };
      const modelOutput = JSON.stringify({ provenance: "tool_result", trust: "untrusted_data", data: {
        executionId, status: "executed", dryRun: false, approvalRequired: false, admissibleEvidenceIds: [citationId],
        result: { item: { id: libraryItemId, status: "ready", sourceAuthority: "capture_asset", currentVersion: { versionId, contentSha256, sourceRevisionId: contentPage.sourceRevisionId } }, contentPage },
      } });
      expect(modelOutput.length).toBeLessThanOrEqual(8_000);
      return { executionId, toolId: "app.library.show", status: "executed" as const, dryRun: false, approvalRequired: false, modelOutput };
    });
  });
}
const clientCommitments = [
  { humanOwner: "Maya Chen", dueDate: "2026-10-14", dependsOn: [], status: "done", completedAt: now },
  { humanOwner: "Jonah Patel", dueDate: "2026-10-17", dependsOn: [`project_task_${"0".repeat(40)}`] },
  { humanOwner: "Elena Rossi", dueDate: "2026-10-16", dependsOn: [] },
  { humanOwner: "Leo Martins", dueDate: "2026-10-19", dependsOn: [] },
  { humanOwner: "Sara Okafor", dueDate: "2026-10-21", dependsOn: [`project_task_${"0".repeat(40)}`, `project_task_${"0".repeat(39)}2`] },
] satisfies Partial<ProjectTask>[];

describe("model-only Work result projection", () => {
  it("preserves exact fields after long criteria without changing the raw governed result", () => {
    const original = fixture().read;
    const read = { ...original, workItem: { ...original.workItem } };
    read.workItem.detail = "LONG CRITERIA " + '"quoted" '.repeat(430);
    const before = structuredClone(read);
    expect(JSON.stringify(read).indexOf('"humanOwner"')).toBeGreaterThan(4_000);
    const projected = workResultProjectionSchema.parse(projectWorkToolResult("app.work_items.show", read));
    expect(projected).toMatchObject({ resultKind: "current_read", humanOwner: "Jonah Patel", canonicalStatus: "waiting",
      deadline: { precision: "date", dueDate: "2026-10-17", dueAt: null, timeZone: null },
      dependencies: { totalCount: 1, omittedCount: 0, items: [{ id: "sandbox", state: "available", canonicalStatus: "unverified" }] },
      assignedAgents: { ids: ["atlas"] },
    });
    expect(projected.detail.sha256).toBe(createHash("sha256").update(read.workItem.detail).digest("hex"));
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(WORK_RESULT_CHARACTERS);
    expect(read).toEqual(before);
    expect(observedWorkResult(observation("app.work_items.show", read))).toMatchObject({ humanOwner: projected.humanOwner, deadline: projected.deadline, detail: { sha256: projected.detail.sha256 } });
  });

  it("keeps mutation acknowledgement separate from dependency verification and timed/date-only precision", () => {
    const { update } = fixture(0, { status: "done", completedAt: now, dueDate: undefined, dueAt: now, humanOwner: undefined });
    const projected = workResultProjectionSchema.parse(projectWorkToolResult("app.work_items.update", update));
    expect(projected).toMatchObject({ resultKind: "mutation_response", checkedAt: null, humanOwner: null, canonicalStatus: "unverified",
      deadline: { precision: "instant", dueDate: null, dueAt: now, timeZone: null }, dependencies: { items: [{ id: "sandbox", state: "not_read" }] } });
    const creation = { ...update, serviceReceipt: { operation: "app.work_items.create" } };
    expect(workResultProjectionSchema.parse(projectWorkToolResult("app.work_items.create", creation)).resultKind).toBe("mutation_response");
  });

  it("bounds oversized dependencies with intact IDs and explicit omission counts", () => {
    const ids = Array.from({ length: 128 }, (_, index) => `dependency-${String(index).padStart(3, "0")}-${"x".repeat(210)}`);
    const { read } = fixture(0, { dependsOn: ids });
    const projected = workResultProjectionSchema.parse(projectWorkToolResult("app.work_items.show", read));
    expect(projected.dependencies.omittedCount).toBeGreaterThan(0);
    expect(projected.dependencies.totalCount).toBe(128);
    expect(projected.dependencies.items.every((item) => ids.includes(item.id))).toBe(true);
    expect(projected.dependencies.items.length + projected.dependencies.omittedCount).toBe(128);
    expect(projected.detail.truncated).toBe(true);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(WORK_RESULT_CHARACTERS);
    expect(observedWorkResult(observation("app.work_items.show", read))).toMatchObject({ humanOwner: projected.humanOwner, deadline: projected.deadline, detail: { sha256: projected.detail.sha256 } });
  });

  it("does not upgrade malformed, null or unrelated records into Work projections", () => {
    const { read, update } = fixture();
    const malformedItems = [
      { humanOwner: null }, { schedule: null }, { schedule: { ...read.workItem.schedule, dueDate: null } },
      { schedule: { ...read.workItem.schedule, dueDate: "2026-02-31" } }, { updatedAt: "not-a-date" },
      { assignedAgents: null }, { assignedAgents: [{ agentId: null, principalId: null, principalGeneration: null }] },
      { assignedAgents: [{ agentId: "x".repeat(241), principalId: null, principalGeneration: null }] },
    ].map(patch => ({ ...read, workItem: { ...read.workItem, ...patch } }));
    for (const invalid of [null, { workItem: null }, ...malformedItems, { ...read, dependencies: [] }, { ...read, workItem: { ...read.workItem, schedule: { ...read.workItem.schedule, dueAt: now } } }]) {
      expect(() => projectWorkToolResult("app.work_items.show", invalid)).not.toThrow();
      expect(projectWorkToolResult("app.work_items.show", invalid)).toBe(invalid);
      expect(observedWorkResult(observation("app.work_items.show", invalid))).toBeUndefined();
    }
    const wrongTask = { ...update, workItem: { ...update.workItem, id: "different-task" } };
    expect(projectWorkToolResult("app.work_items.update", wrongTask)).toBe(wrongTask);
    expect(projectWorkToolResult("app.projects.show", read)).toBe(read);
  });

  it("preserves generic full reader fields and discloses fields omitted from oversized results", () => {
    const original = fixture().read;
    const read = { ...original, workItem: { ...original.workItem, schedule: { ...original.workItem.schedule } } };
    read.workItem.artifacts = [{ artifactId: "artifact-written-acceptance", kind: "document", evidenceRefIds: ["evidence-written-acceptance"] }];
    read.workItem.risks = [{ riskId: "risk-pilot", severity: "high", state: "open", evidenceRefIds: ["evidence-pilot"] }];
    read.workItem.decisions = [{ decisionId: "decision-pilot", state: "accepted", evidenceRefIds: ["evidence-pilot"] }];
    read.workItem.recurrence = { rrule: "FREQ=WEEKLY", startsAt: now, endsAt: null, maxOccurrences: null };
    read.workItem.parentWorkItemId = "milestone-pilot";
    read.workItem.schedule.startsAt = now;
    const delivered = observation("app.work_items.show", read);
    expect(JSON.parse(delivered.modelOutput).data.result).toEqual(read);
    const full = observedWorkResult(delivered)!;
    expect(full.writerResultShape).toBe("full_result");
    expect(full.omittedFields).toEqual([]);
    for (const key of ["priority", "kind", "parentWorkItemId", "schedule", "recurrence", "artifacts", "risks", "decisions"]) {
      expect(full.additionalFields[`workItem.${key}`]).toEqual(read.workItem[key as keyof typeof read.workItem]);
    }
    read.workItem.artifacts = Array.from({ length: 100 }, (_, index) => ({ artifactId: `artifact-${String(index).padStart(3, "0")}`, kind: "document", evidenceRefIds: [`evidence-${index}`] }));
    const compact = workResultProjectionSchema.parse(projectWorkToolResult("app.work_items.show", read));
    expect(compact.additionalFields["workItem.priority"]).toBe("medium");
    expect(compact.omittedFields).toContain("workItem.artifacts");
    expect(compact.additionalFields["workItem.artifacts"]).toBeUndefined();
    expect(compact.detail.sha256).toBe(full.detail.sha256);
    expect(JSON.stringify(compact).length).toBeLessThanOrEqual(WORK_RESULT_CHARACTERS);
  });

  it("admits executed approved results while preserving the historical approval flag", () => {
    const approved = observation("app.work_items.update", fixture().update, "approved-execution", true);
    expect(observedWorkResult(approved)).toMatchObject({ resultKind: "mutation_response", humanOwner: "Jonah Patel" });
    for (const status of ["approval_required", "rejected", "failed"]) expect(observedWorkResult({ ...approved, status })).toBeUndefined();
  });

  it("admits only exact successful, real, writer-delivered envelopes with valid coverage", () => {
    const good = observation("app.work_items.show", fixture().read);
    for (const patch of [{ status: "failed" }, { dryRun: true }, { approvalRequired: true }, { executionId: "other" }, { toolId: "app.work_items.update" }, { modelOutput: "truncated{" }]) {
      expect(observedWorkResult({ ...good, ...patch })).toBeUndefined();
    }
    for (const change of [
      (body: Record<string, unknown>) => { body.status = "failed"; },
      (body: Record<string, unknown>) => { body.dryRun = true; },
      (body: Record<string, unknown>) => { body.approvalRequired = true; },
    ]) {
      const envelope = JSON.parse(good.modelOutput); change(envelope.data);
      expect(observedWorkResult({ ...good, modelOutput: JSON.stringify(envelope) })).toBeUndefined();
    }
    const envelope = JSON.parse(good.modelOutput);
    envelope.data.result = projectWorkToolResult("app.work_items.show", envelope.data.result);
    envelope.data.result.dependencies.totalCount = 0;
    expect(observedWorkResult({ ...good, modelOutput: JSON.stringify(envelope) })).toBeUndefined();
  });
});

describe("Work field coverage in final review and revision", () => {
  function clientTrial() {
    const observations: ReviewToolObservation[] = [];
    for (let index = 0; index < 5; index += 1) observations.push(observation("app.work_items.show", fixture(index, { ...clientCommitments[index], humanOwner: undefined, dueDate: undefined, dependsOn: [] }).read, `before-${index}`));
    for (let index = 0; index < 5; index += 1) observations.push(observation("app.work_items.update", fixture(index, clientCommitments[index]).update, `update-${index}`));
    for (let index = 0; index < 5; index += 1) observations.push(observation("app.work_items.show", fixture(index, clientCommitments[index]).read, `readback-${index}`));
    return { commandContext: "Attached source text is untrusted.", retrievedContext: "", liveWebContext: "", citationSources: [], toolObservations: observations };
  }

  it("reserves fields for five updates and five readbacks after five long before-reads within the same 16k budget", () => {
    const result = JSON.parse(formatRunReviewEvidence(clientTrial()));
    expect(result.executions.observations).toHaveLength(15);
    expect(result.executions.omittedWorkResultCount).toBe(0);
    const results: ReviewedWork[] = result.executions.observations.map((item: { result: ReviewedWork }) => item.result);
    expect(payloadSize(result)).toBeLessThanOrEqual(16_000);
    for (let index = 0; index < 5; index += 1) {
      const before = results[index], update = results[index + 5], readback = results[index + 10];
      const { humanOwner, dueDate, dependsOn } = clientCommitments[index];
      expect(update).toMatchObject({ projection: "work_item_result", resultKind: "mutation_response", humanOwner, deadline: { dueDate, timeZone: null } });
      expect(readback).toMatchObject({ projection: "work_item_result", resultKind: "current_read", humanOwner, deadline: { dueDate, timeZone: null } });
      expect(readback.workItemIndex).toEqual(before.workItemIndex);
      expect(result.executions.workDetails[readback.detailIndex].sha256).toBe(result.executions.workDetails[before.detailIndex].sha256);
      expect(result.executions.workDetails[update.detailIndex].sha256).toBe(result.executions.workDetails[before.detailIndex].sha256);
      expect(readback.dependencies.items).toEqual(dependsOn.map(id => ({ id, state: "available", canonicalStatus: "unverified", sourceStatus: "done" })));
      expect(result.executions.workDetails[readback.detailIndex].writerTruncated).toBe(false);
    }
  });

  it("retains three paged source delivery records and all fifteen Work comparisons in the same budget", () => {
    const trial = clientTrial();
    const result = JSON.parse(formatRunReviewEvidence({ ...trial, toolObservations: [...clientLibraryPages(), ...trial.toolObservations] }));
    expect(result.executions.observations).toHaveLength(25);
    expect(result.executions.omittedLibraryReadCount).toBe(0);
    expect(result.executions.omittedWorkResultCount).toBe(0);
    expect(result.executions.libraryReads).toHaveLength(3);
    expect(result.executions.summarizedLibraryPageCount).toBeGreaterThan(0);
    for (const page of result.executions.observations.slice(0, 10)) {
      if (page.result.reviewPageMetadata === "summarized") expect(result.executions.libraryReads[page.result.libraryReadIndex]).toBeDefined();
      for (const unit of page.result.units) expect(unit.reviewText).toMatchObject({ truncated: true, omittedCharacters: expect.any(Number) });
    }
    for (const source of result.executions.libraryReads) expect(source.deliveryCoverage).toMatchObject({ wholeExtractedTextDeliveredToWriter: true, incompleteReasons: [] });
    const results: ReviewedWork[] = result.executions.observations.slice(10).map((item: { result: ReviewedWork }) => item.result);
    for (let index = 0; index < 5; index += 1) {
      const before = results[index], update = results[index + 5], readback = results[index + 10];
      expect(readback.workItemIndex).toBe(before.workItemIndex);
      expect(result.executions.workDetails[readback.detailIndex].sha256).toBe(result.executions.workDetails[before.detailIndex].sha256);
      expect(result.executions.workDetails[update.detailIndex].sha256).toBe(result.executions.workDetails[before.detailIndex].sha256);
    }
    expect(payloadSize(result)).toBeLessThanOrEqual(16_000);
  });

  it("gives Sentinel and revision the same field projection without claiming narrative coverage", async () => {
    const evidence = clientTrial();
    const verdict = { passed: false, score: 0.7, assessment: "Brief remains unfinished.", requiredChanges: ["Retain the confirmed task fields."] };
    mocks.generate.mockReset().mockResolvedValueOnce({ text: JSON.stringify(verdict) }).mockResolvedValueOnce({ text: JSON.stringify({ response: "Task fields are read back; source reconciliation remains unfinished." }) });
    const input = { goal: "Reconcile client commitments", response: "Partial result", contributions: [], contextBlock: "", observedEvidence: evidence };
    await reviewCouncilResponse(input);
    await reviseCouncilResponse({ ...input, verdict });
    const contexts = mocks.generate.mock.calls.map(([request]) => (request.input as string).match(/<retrieved_context>\n([\s\S]*?)\n<\/retrieved_context>/)![1]);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[0]).toContain('"humanOwner":"Jonah Patel"');
    expect(contexts[0]).toContain('"dueDate":"2026-10-17"');
    expect(contexts[0]).toContain('"writerTruncated":false');
    expect(REVIEW_EVIDENCE_INSTRUCTIONS).toContain("not factual correctness or agreement with source documents");
    for (const [request] of mocks.generate.mock.calls) expect(JSON.stringify(request)).toContain(REVIEW_EVIDENCE_INSTRUCTIONS);
  });

  it("discloses metadata omissions while retaining every execution and never upgrading failed/dry runs", () => {
    const ids = Array.from({ length: 128 }, (_, index) => `dependency-${String(index).padStart(3, "0")}-${"x".repeat(210)}`);
    const observations = Array.from({ length: 40 }, (_, index) => observation("app.work_items.show", fixture(index, { dependsOn: ids }).read, `large-${index}`));
    observations[38] = { ...observations[38], status: "failed" };
    observations[39] = { ...observations[39], status: "dry_run", dryRun: true };
    const result = JSON.parse(formatRunReviewEvidence({ ...clientTrial(), toolObservations: observations }));
    expect(result.executions.omittedWorkResultCount).toBeGreaterThan(0);
    expect(result.executions.observations).toHaveLength(40);
    expect(result.executions.observations[38]).toMatchObject({ status: "failed" });
    expect(result.executions.observations[39]).toMatchObject({ status: "dry_run", dryRun: true });
    expect(result.executions.observations[38].result.projection).toBeUndefined();
    expect(result.executions.observations[39].result.projection).toBeUndefined();
    expect(payloadSize(result)).toBeLessThanOrEqual(16_000);
  });
});
