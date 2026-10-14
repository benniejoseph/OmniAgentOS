import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showProjectInventoryService, updateProjectService, updateWorkItemService } from "@/lib/app-services/projects";
import { createProject, createProjectTasks, getOwnedProject, listProjectTasks } from "@/lib/projects/store";
import type { PersonalProject, ProjectTask } from "@/lib/projects/types";
import { createExecutionScope, deriveExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { projectTaskCanonicalProjection } from "@/lib/workspaces/legacy-projection";
import { reviewCouncilResponse, reviseCouncilResponse } from "./council";
import { observedProjectResult, projectPageDelivery } from "./project-result-projection";
import { formatRunReviewEvidence, type ReviewToolObservation, type RunReviewEvidence } from "./review-evidence";
import { projectWorkToolResult } from "./work-result-projection";

const mocks = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@/lib/models/gateway", () => ({ generateModelStructured: mocks.generate }));
vi.mock("@/lib/delegation/channel-store", () => ({ shareDelegationMissionArtifact: vi.fn(), sendDelegationMessage: vi.fn() }));

const scope = { tenantId: "tenant-client", actorId: "client-owner" };
const caller = createAppServiceCaller({ context: { ...scope, role: "operator", source: "session" },
  executionScope: createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.actorId,
    executingPrincipalType: "agent", executingPrincipalId: "agent:atlas:fixture", correlationId: "project-review-fixture", purpose: "project.review" }),
  idempotencyKey: "project-review-fixture",
});
function invocation(id: string) {
  return { ...caller, idempotencyKey: id, executionScope: deriveExecutionScope(caller.executionScope!, { causationId: id, purpose: "agent.tool.execute" }) };
}
const now = "2026-10-15T00:00:00.000Z";
const acceptance = " Full rollout needs security approval and written pilot acceptance; 12 trained agents each complete two exercises, at least 10 score 80 percent, with coaching and retests.";
const objective = (changed: boolean) => `${changed ? "Mapping due October 20. Dictionary received. Knowledge acceptance still pending." : "Mapping due October 17. Dictionary receipt unverified. Knowledge acceptance pending."} ${"Preserve source evidence and conditional pilot scope. ".repeat(38)}`.slice(0, 1_999 - acceptance.length) + "." + acceptance;
const criteria = (index: number, changed = false) => `${changed && index === 1 ? "Mapping due October 20. Received AVDICT015; 25-ticket validation pending." : `Commitment ${index}; existing deadline and dependencies apply.`} ${"Retain saved criteria and distinguish reports from accepted work. ".repeat(13)}`.slice(0, 850) + ` CRITERIA-TAIL-${index}: Written acceptance remains required; an invitation or a reported done status is not acceptance.`;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "asael-project-review-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", directory); vi.stubEnv("DATABASE_URL", "");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

function observation(toolId: string, raw: unknown, executionId: string, status: ReviewToolObservation["status"] = "executed"): ReviewToolObservation {
  const envelope = (result: unknown) => JSON.stringify({ provenance: "tool_result", trust: "untrusted_data", data: {
    executionId, status, dryRun: false, approvalRequired: false, result, admissibleEvidenceIds: [],
  } });
  const full = envelope(raw);
  const modelOutput = full.length <= 8_000 ? full : envelope(projectWorkToolResult(toolId, raw));
  expect(modelOutput.length).toBeLessThanOrEqual(8_000);
  return { toolId, executionId, status, dryRun: false, approvalRequired: false, modelOutput };
}
function serviceObservation(toolId: string, service: { data: unknown; receipt: unknown }, id: string) {
  return observation(toolId, { ...(service.data as object), serviceReceipt: service.receipt }, id);
}
function readWork(project: PersonalProject, task: ProjectTask, id: string) {
  const canonical = projectTaskCanonicalProjection(project, task, [], { workspaceId: "workspace:client",
    canonicalOwnerActorId: "actor:123e4567-e89b-42d3-a456-426614174000" }, 1);
  return observation("app.work_items.show", { workItem: canonical.projection, projectionSha256: canonical.projectionSha256,
    revisionSha256: canonical.sourceRevisionSha256, checkedAt: now,
    dependencies: canonical.projection.dependencyWorkItemIds.map(id => ({ id, state: "available", canonicalStatus: "unverified", sourceStatus: "done", projectionSha256: "a".repeat(64), updatedAt: now })) }, id);
}
function evidence(toolObservations: ReviewToolObservation[]): RunReviewEvidence {
  return { commandContext: "", retrievedContext: "", liveWebContext: "", citationSources: [], toolObservations };
}
function projectPayloadLength(result: ReturnType<typeof JSON.parse>) {
  const { libraryReads, workItems, workDetails, projectObjectives, observations } = result.executions;
  return JSON.stringify({ libraryReads, workItems, workDetails, projectObjectives, results: observations.map((item: { result: unknown }) => item.result) }).length;
}
async function fixture() {
  const project = await createProject({ ...scope, title: "Aster Vale client trial", objective: objective(false) });
  const tasks = await createProjectTasks(project.id, Array.from({ length: 5 }, (_, index) => ({ title: `Client commitment ${index}`,
    detail: criteria(index), humanOwner: ["Maya Chen", "Jonah Patel", "Elena Ruiz", "Leo Martins", "Sara Okafor"][index],
    dueDate: ["2026-10-14", "2026-10-17", "2026-10-16", "2026-10-19", "2026-10-21"][index] })), scope);
  return { project, tasks };
}
async function trial() {
  const { project, tasks } = await fixture();
  const observations = [serviceObservation("app.projects.show", await showProjectInventoryService(invocation(`inventory-${crypto.randomUUID()}`), { projectId: project.id, includeFullObjective: true }), "project-before")];
  tasks.forEach((task, index) => observations.push(readWork(project, task, `before-${index}`)));
  for (let index = 0; index < 3; index += 1) observations.push(observation("app.projects.list", { noisy: "Unrelated earlier inventory. ".repeat(240) }, `noise-${index}`));
  observations.push(observation("app.projects.update", { error: "Objective exceeds 2000 characters; write refused." }, "failed-write", "failed"));
  for (const [index, task] of tasks.entries()) observations.push(serviceObservation("app.work_items.update",
    await updateWorkItemService(invocation(`update-${index}`), { projectId: project.id, workItemId: task.id, detail: criteria(index, true), ...(index === 1 ? { dueDate: "2026-10-20" } : {}) }), `update-${index}`));
  observations.push(serviceObservation("app.projects.update", await updateProjectService(invocation("project-update"), { projectId: project.id, objective: objective(true) }), "project-update"));
  const updatedProject = (await getOwnedProject(project.id, scope))!;
  const saved = await listProjectTasks(project.id, { tenantId: scope.tenantId, limit: 100 });
  expect(saved).toHaveLength(5);
  saved.forEach((task, index) => observations.push(readWork(updatedProject, task, `readback-${index}`)));
  observations.push(serviceObservation("app.projects.show", await showProjectInventoryService(invocation(`inventory-${crypto.randomUUID()}`), { projectId: project.id, includeFullObjective: true }), "project-readback"));
  return { observations, project, tasks };
}

describe("bounded project readback review evidence", () => {
  it("retains actual service inventory summary, full objective and page receipts", async () => {
    const { project } = await fixture();
    const service = await showProjectInventoryService(invocation(`inventory-${crypto.randomUUID()}`), { projectId: project.id, includeFullObjective: true });
    const parsed = observedProjectResult(serviceObservation("app.projects.show", service, "project-show"));
    expect(parsed).toMatchObject({ invalid: false, resultKind: "current_read", identity: { projectId: project.id },
      objective: { text: objective(false), writerCoverage: "complete", writerIncludedCharacters: 2_000 },
      inventory: { taskPage: { returnedCount: 5, startsAtBeginning: true, hasMore: false, requestedCursor: null },
        project: { commitmentSummary: { coverage: "complete", commitmentCount: 5, openCount: 5, narrativeAssessment: "not_compared" } } } });
  });

  it("keeps five latest criteria tails and the 2k brief after before/update/readbacks, a failed write and noisy reads within 16k", async () => {
    const { observations } = await trial();
    const result = JSON.parse(formatRunReviewEvidence(evidence(observations)));
    expect(projectPayloadLength(result)).toBeLessThanOrEqual(16_000);
    expect(result.executions.observations.map((item: { executionId: string; status: string }) => [item.executionId, item.status])).toEqual(observations.map(item => [item.executionId, item.status]));
    const latest = result.executions.observations.at(-1).result;
    expect(latest).toMatchObject({ projection: "project_result", resultKind: "current_read", commitmentSummary: { commitmentCount: 5, coverage: "complete" },
      taskPage: { returnedCount: 5, hasMore: false }, deliveryCoverage: { pageChainReachedEnd: true, consistency: "current_read_not_snapshot" } });
    expect(result.executions.projectObjectives[latest.objectiveIndex].reviewText).toMatchObject({ text: objective(true), truncated: false });
    for (let index = 0; index < 5; index += 1) {
      const read = result.executions.observations.find((item: { executionId: string }) => item.executionId === `readback-${index}`).result;
      expect(read).toMatchObject({ resultKind: "current_read", deadline: { dueDate: index === 1 ? "2026-10-20" : ["2026-10-14", "", "2026-10-16", "2026-10-19", "2026-10-21"][index], timeZone: null } });
      expect(result.executions.workDetails[read.detailIndex].reviewText).toMatchObject({ text: criteria(index, true), truncated: false });
    }
    expect(result.executions.observations.find((item: { executionId: string }) => item.executionId === "failed-write")).toMatchObject({ status: "failed", result: { text: expect.stringContaining("write refused") } });
    const update = result.executions.observations.find((item: { executionId: string }) => item.executionId === "project-update").result;
    expect(update).toMatchObject({ resultKind: "mutation_response" });
    if (update.reviewOmitted) expect(result.executions.reviewOmissionReason).toBe("review_metadata_budget");
    else expect(update.objectiveIndex).toBe(latest.objectiveIndex);
    const priorMapping = result.executions.observations.find((item: { executionId: string }) => item.executionId === "before-1").result;
    expect(priorMapping).toMatchObject({ resultKind: "current_read", deadline: { dueDate: "2026-10-17" } });
  });

  it("passes the same actual complete latest narratives and exact receipts to both reviewer and revision", async () => {
    const { observations } = await trial();
    const verdict = { passed: false, score: 0.8, assessment: "Retain accepted changes and unresolved gates.", requiredChanges: ["Read the supplied current records."] };
    mocks.generate.mockReset().mockResolvedValueOnce({ text: JSON.stringify(verdict) }).mockResolvedValueOnce({ text: JSON.stringify({ response: "Fixture model output is not the assertion under test." }) });
    const input = { goal: "Reconcile the change", response: "Provisional answer", contributions: [], contextBlock: "", observedEvidence: evidence(observations) };
    await reviewCouncilResponse(input); await reviseCouncilResponse({ ...input, verdict });
    const contexts = mocks.generate.mock.calls.map(([request]) => (request.input as string).match(/<retrieved_context>\n([\s\S]*?)\n<\/retrieved_context>/)![1]);
    expect(contexts[0]).toBe(contexts[1]);
    const actual = JSON.parse(contexts[0]);
    const last = actual.executions.observations.at(-1).result;
    expect(actual.executions.projectObjectives[last.objectiveIndex].reviewText.text).toBe(objective(true));
    for (let index = 0; index < 5; index += 1) expect(contexts[0]).toContain(`CRITERIA-TAIL-${index}`);
    expect(contexts[0]).toContain("current_read_not_snapshot");
    expect(contexts[0]).toContain("failed-write");
  });

  it("deduplicates only exact objective text and preserves mutation/read attribution and excerpt coverage", async () => {
    const { project } = await fixture();
    const mutation = serviceObservation("app.projects.update", await updateProjectService(invocation("objective"), { projectId: project.id, objective: objective(true) }), "write");
    const full = serviceObservation("app.projects.show", await showProjectInventoryService(invocation(`inventory-${crypto.randomUUID()}`), { projectId: project.id, includeFullObjective: true }), "full-read");
    const partial = serviceObservation("app.projects.show", await showProjectInventoryService(invocation(`inventory-${crypto.randomUUID()}`), { projectId: project.id }), "excerpt-read");
    const result = JSON.parse(formatRunReviewEvidence(evidence([mutation, full, partial])));
    const [written, read, excerpt] = result.executions.observations.map((item: { result: unknown }) => item.result);
    expect(written.resultKind).toBe("mutation_response"); expect(read.resultKind).toBe("current_read");
    expect(written.objectiveIndex).toBe(read.objectiveIndex);
    expect(excerpt.objectiveIndex).not.toBe(read.objectiveIndex);
    expect(result.executions.projectObjectives[excerpt.objectiveIndex]).toMatchObject({ writerIncludedCharacters: 400, writerCoverage: "excerpt" });
    expect(result.executions.projectObjectives[excerpt.objectiveIndex]).not.toHaveProperty("totalCharacters");
  });

  it("validates real cursor succession without upgrading page counts to an atomic snapshot", async () => {
    const { project } = await fixture();
    const pages: ReviewToolObservation[] = [];
    let taskCursor: string | undefined;
    do {
      const service = await showProjectInventoryService(invocation(`inventory-${crypto.randomUUID()}`), { projectId: project.id, taskLimit: 2, taskCursor });
      pages.push(serviceObservation("app.projects.show", service, `page-${pages.length}`));
      if (!("taskPage" in service.data)) throw new Error("Expected owned inventory");
      expect(service.data.taskPage.requestedCursor).toBe(taskCursor ?? null);
      taskCursor = service.data.taskPage.nextCursor ?? undefined;
    } while (taskCursor && pages.length < 5);
    expect(pages).toHaveLength(3);
    const projected = pages.map(observedProjectResult);
    expect(new Set(projected.map(item => item && !item.invalid ? item.authoritySha256 : null)).size).toBe(3);
    expect(projectPageDelivery(projected).at(-1)).toMatchObject({ pageChainReachedEnd: true, distinctTaskCount: 5, observationIndexes: [0, 1, 2], consistency: "current_read_not_snapshot" });
    const result = JSON.parse(formatRunReviewEvidence(evidence(pages)));
    expect(result.executions.observations.map((item: { result: { commitmentSummary: { coverage: string; commitmentCount: number } } }) => item.result.commitmentSummary)).toEqual([
      expect.objectContaining({ coverage: "partial", commitmentCount: 2 }), expect.objectContaining({ coverage: "partial", commitmentCount: 2 }), expect.objectContaining({ coverage: "partial", commitmentCount: 1 }),
    ]);
    for (const incomplete of [pages.slice(1), [pages[0], pages[2]], [pages[0], changed(pages[1], raw => { delete raw.data.result.taskPage.requestedCursor; }), pages[2]],
      [pages[0], changed(pages[1], raw => { raw.data.result.project.actorId = "foreign-owner"; }), pages[2]],
      [pages[0], changed(pages[1], raw => { raw.data.result.project.tasks[0].id = JSON.parse(pages[0].modelOutput).data.result.project.tasks[0].id; }), pages[2]],
    ]) {
      expect(projectPageDelivery(incomplete.map(observedProjectResult)).at(-1)?.pageChainReachedEnd).toBe(false);
    }
    // Legacy single-page observations can still prove their own page, but a
    // terminal legacy page cannot manufacture the missing beginning/cursor.
    const terminal = changed(pages[2], raw => { delete raw.data.result.taskPage.requestedCursor; });
    expect(projectPageDelivery([observedProjectResult(terminal)])[0]).toMatchObject({ pageChainReachedEnd: false, incompleteReasons: ["missing_beginning"] });
  });

  it("retains the earlier full objective when later pagination supplies only an excerpt under five-Work pressure", async () => {
    const { observations, project } = await trial();
    const first = await showProjectInventoryService(invocation("full-first-page"), { projectId: project.id, includeFullObjective: true, taskLimit: 2 });
    if (!("taskPage" in first.data)) throw new Error("Expected owned inventory");
    const second = await showProjectInventoryService(invocation("default-next-page"), { projectId: project.id, taskCursor: first.data.taskPage.nextCursor!, taskLimit: 200 });
    const pages = [serviceObservation("app.projects.show", first, "full-first-page"), serviceObservation("app.projects.show", second, "default-next-page")];
    const result = JSON.parse(formatRunReviewEvidence(evidence([...observations, ...pages])));
    expect(projectPayloadLength(result)).toBeLessThanOrEqual(16_000);
    const [full, later] = result.executions.observations.slice(-2).map((item: { result: unknown }) => item.result);
    expect(result.executions.projectObjectives[full.objectiveIndex]).toMatchObject({ writerCoverage: "complete", reviewText: { text: objective(true), truncated: false } });
    expect(result.executions.projectObjectives[later.objectiveIndex]).toMatchObject({ writerCoverage: "excerpt", writerIncludedCharacters: 400 });
    expect(later.deliveryCoverage).toMatchObject({ pageChainReachedEnd: true, consistency: "current_read_not_snapshot" });
    expect(full.commitmentSummary).toMatchObject({ coverage: "partial", commitmentCount: 2 });
    expect(later.commitmentSummary).toMatchObject({ coverage: "partial", commitmentCount: 3 });
    for (let index = 0; index < 5; index += 1) {
      const read = result.executions.observations.find((item: { executionId: string }) => item.executionId === `readback-${index}`).result;
      expect(result.executions.workDetails[read.detailIndex].reviewText).toMatchObject({ text: criteria(index, true), truncated: false });
    }
  });

  it("prioritizes changed facts in a later excerpt instead of treating it as redundant with an older full objective", async () => {
    const { observations, project } = await trial();
    const first = await showProjectInventoryService(invocation("old-full-page"), { projectId: project.id, includeFullObjective: true, taskLimit: 2 });
    if (!("taskPage" in first.data)) throw new Error("Expected owned inventory");
    const changedObjective = objective(true).replace("October 20", "October 22");
    const write = await updateProjectService(invocation("intervening-project-change"), { projectId: project.id, objective: changedObjective });
    const later = await showProjectInventoryService(invocation("changed-excerpt"), { projectId: project.id, taskCursor: first.data.taskPage.nextCursor!, taskLimit: 200 });
    const result = JSON.parse(formatRunReviewEvidence(evidence([...observations,
      serviceObservation("app.projects.show", first, "old-full-page"),
      serviceObservation("app.projects.update", write, "intervening-project-change"),
      serviceObservation("app.projects.show", later, "changed-excerpt"),
    ])));
    expect(projectPayloadLength(result)).toBeLessThanOrEqual(16_000);
    const current = result.executions.observations.at(-1).result;
    expect(result.executions.projectObjectives[current.objectiveIndex]).toMatchObject({ writerCoverage: "excerpt",
      reviewText: { text: changedObjective.slice(0, 400), truncated: false } });
    expect(current.deliveryCoverage).toMatchObject({ pageChainReachedEnd: false, incompleteReasons: ["missing_beginning"] });
    expect(result.executions.observations.at(-2).result.resultKind).toBe("mutation_response");
  });

  it.each(["tenantId", "actorId"])("keeps the same project ID in different %s scopes independent", async field => {
    const { project } = await fixture();
    const valid = serviceObservation("app.projects.show", await showProjectInventoryService(invocation("scope-first"), { projectId: project.id, includeFullObjective: true }), "scope-first");
    const foreign = { ...changed(valid, raw => { raw.data.executionId = "scope-second"; raw.data.result.project[field] = "foreign-scope"; raw.data.result.project.objective = "A distinct observed scoped objective."; }), executionId: "scope-second" };
    const result = JSON.parse(formatRunReviewEvidence(evidence([valid, foreign])));
    const [first, second] = result.executions.observations.map((item: { result: unknown }) => item.result);
    expect(first.identity.projectId).toBe(second.identity.projectId);
    expect(first.identity).not.toEqual(second.identity);
    expect(first.objectiveIndex).not.toBe(second.objectiveIndex);
    expect(result.executions.projectObjectives[first.objectiveIndex].reviewText.text).toBe(objective(false));
    expect(result.executions.projectObjectives[second.objectiveIndex].reviewText.text).toBe("A distinct observed scoped objective.");
    expect(first.deliveryCoverage.observationIndexes).toEqual([0]); expect(second.deliveryCoverage.observationIndexes).toEqual([1]);
  });

  it("keeps supplemental inventory fields as observed untrusted text rather than silently dropping them", async () => {
    const { project } = await fixture();
    const valid = serviceObservation("app.projects.show", await showProjectInventoryService(invocation("supplemental"), { projectId: project.id }), "supplemental");
    const extended = changed(valid, raw => { raw.data.result.project.tasks[0].futureReceipt = { unknownState: "retained-not-interpreted" }; });
    const result = JSON.parse(formatRunReviewEvidence(evidence([extended])));
    expect(result.executions.observations[0].result.additionalFields).toMatchObject({ truncated: false, text: expect.stringContaining("retained-not-interpreted") });
  });

  it("marks malformed and oversized successful results unknown and never promotes failed or dry executions", async () => {
    const { project } = await fixture();
    const valid = serviceObservation("app.projects.show", await showProjectInventoryService(invocation(`inventory-${crypto.randomUUID()}`), { projectId: project.id, includeFullObjective: true }), "valid");
    const invalid = [
      changed(valid, raw => { raw.trust = "instructions"; }),
      changed(valid, raw => { raw.data.executionId = "other"; }),
      changed(valid, raw => { raw.data.result.project.commitmentSummary.openCount += 1; }),
      changed(valid, raw => { raw.data.result.taskPage.returnedCount += 1; }),
      changed(valid, raw => { raw.data.result.taskPage.requestedCursor = "noninitial-cursor"; }),
      changed(valid, raw => { raw.data.result.taskPage.hasMore = true; }),
      changed(valid, raw => { raw.data.result.project.tasks[1].id = raw.data.result.project.tasks[0].id; }),
      changed(valid, raw => { raw.data.result.serviceReceipt.operation = "app.projects.update"; rehashReceipt(raw); }),
      { ...valid, modelOutput: valid.modelOutput + " ".repeat(8_001) },
      { ...valid, modelOutput: "{truncated" },
    ];
    for (const item of invalid) {
      expect(observedProjectResult(item)).toEqual({ invalid: true });
      const projected = JSON.parse(formatRunReviewEvidence(evidence([item]))).executions.observations[0].result;
      expect(projected).toMatchObject({ projectResultValidation: "unknown_invalid_or_oversized_result" });
      expect(projected.projection).toBeUndefined();
    }
    for (const patch of [{ status: "failed" as const }, { status: "approval_required" as const }, { status: "dry_run" as const, dryRun: true }]) {
      expect(observedProjectResult({ ...valid, ...patch })).toBeUndefined();
    }
    const approved = changed(valid, raw => { raw.data.approvalRequired = true; });
    expect(observedProjectResult({ ...approved, approvalRequired: true })).toMatchObject({ invalid: false });
    const missing = changed(valid, raw => { raw.data.result = { project: null, serviceReceipt: raw.data.result.serviceReceipt }; });
    expect(observedProjectResult(missing)).toBeUndefined();
  });

  it("discloses review metadata and narrative omissions when forty scoped latest objectives cannot fit", async () => {
    const { project } = await fixture();
    const valid = serviceObservation("app.projects.show", await showProjectInventoryService(invocation(`inventory-${crypto.randomUUID()}`), { projectId: project.id, includeFullObjective: true }), "valid");
    const observations = Array.from({ length: 40 }, (_, index) => {
      const id = `large-${index}`;
      return { ...changed(valid, raw => { raw.data.executionId = id; raw.data.result.project.id = `project-${index}`; raw.data.result.project.objective = `${index}: ${objective(false)}`.slice(0, 2_000); }), executionId: id };
    });
    const result = JSON.parse(formatRunReviewEvidence(evidence(observations)));
    expect(projectPayloadLength(result)).toBeLessThanOrEqual(16_000);
    expect(result.executions.observations.map((item: { executionId: string }) => item.executionId)).toEqual(observations.map(item => item.executionId));
    expect(result.executions.omittedProjectResultCount).toBeGreaterThan(0);
    expect(result.executions.projectObjectives.length).toBeGreaterThan(0);
    expect(result.executions.projectObjectives.every((item: { reviewText: { truncated: boolean; availableCharacters: number; text: string } }) => item.reviewText.truncated && item.reviewText.availableCharacters > item.reviewText.text.length)).toBe(true);
  });
});

// Test mutations deliberately violate one observed wire property at a time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function changed(value: ReviewToolObservation, change: (raw: any) => void): ReviewToolObservation {
  const raw = JSON.parse(value.modelOutput); change(raw); return { ...value, modelOutput: JSON.stringify(raw) };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rehashReceipt(raw: any) {
  const { receiptSha256: _previous, ...body } = raw.data.result.serviceReceipt;
  raw.data.result.serviceReceipt.receiptSha256 = canonicalJsonSha256(body);
}
