import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/sql-types";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { buildAgentRunIdentityPinV1, buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { buildResponsibilityWorkItemProcedure, parseWorkflowProcedureSnapshot } from "@/lib/workflows/saved-procedures";
import { parseCanonicalWorkItemV1, type CanonicalWorkItemV1 } from "@/lib/workspaces/contracts";
import { RESPONSIBILITY_WORK_ITEM_COMPARISON_POLICY as policy } from "./comparison-policy";
import { responsibilityDraftSchema } from "./contracts";
import { changeResponsibilityLifecycle, verifyPilotConfiguration } from "./lifecycle-state";
import { buildNotificationConfiguration, enableNotificationAdmission, admitNotificationCandidate, notificationLifecycleTarget } from "./notification-state";
import { responsibilityObservationReader } from "./observation-references";
import { createResponsibilityObservationPipeline } from "./observation-state";
import { resolveResponsibilityPilot } from "./runtime-references";
import { RESPONSIBILITY_WORK_ITEM_PILOT } from "./runtime-contracts";
import { draftFixture, ownerFixture as owner, nowFixture as now } from "./test-fixtures";
import { prepareResponsibilityChange, responsibilityId, reviewPreview } from "./state";
import { readOwnedWorkItemWithSql, WORK_ITEM_FOLLOWTHROUGH_PROCEDURE, verifyWorkItemSourceRead } from "./work-item-source";

const tool = { id: "app.work_items.show", status: "active", riskLevel: 0, approvalRequired: false, operationClass: "read_only" };
vi.mock("@/lib/tools/registry", () => ({ getGovernedTool: () => tool, getGovernedTools: () => [] }));
vi.mock("@/lib/workflows/triggers", () => ({ nextWorkflowScheduleOccurrence: () => undefined }));
const context: SecurityContext = { tenantId: owner.tenantId, actorId: "owner@example.test", role: "operator", source: "session",
  auth: { userId: owner.actorId.slice(6), email: "owner@example.test", sessionId: "session", tenantName: "Fixture" } };
const workRef = { workspaceId: "workspace:owner", projectId: "project-a", workItemId: "work-a" };
const source = { kind: "work_item" as const, workspaceId: workRef.workspaceId, projectId: workRef.projectId, id: workRef.workItemId };
function item(patch: Partial<CanonicalWorkItemV1> = {}) {
  return parseCanonicalWorkItemV1({ schemaVersion: 1, tenantId: owner.tenantId, ...workRef, parentWorkItemId: null, kind: "task",
    title: "Send the proposal", detail: "Prepare the agreed deliverable", priority: "high", canonicalStatus: "running", sourceStatus: "doing", statusRevision: 1,
    sourceAuthority: "legacy_project_task", dependencyWorkItemIds: [], ownerActorIds: [owner.actorId], assignedAgents: [],
    schedule: { startsAt: null, dueAt: "2026-10-04T09:00:00.000Z", timeZone: "UTC" }, recurrence: null, risks: [], decisions: [], artifacts: [],
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", terminalAt: null, ...patch });
}
function database(initial = item()) {
  const state = { item: initial, membership: true, account: true, hashMismatch: false, dependencies: [] as CanonicalWorkItemV1[] };
  const spy = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    if (query.includes("omni_auth_users")) return state.account ? [{ id: owner.actorId.slice(6), email: context.actorId, role: "operator", name: "Fixture" }] : [];
    if (query.includes("omni_lock_responsibility_workspace_v1")) return [{ allowed: state.membership }];
    if (query.includes("omni_work_items")) {
      if (query.includes("ANY(")) return state.dependencies.map((work) => ({ projection: work, projection_sha256: canonicalJsonSha256(work) }));
      expect(values.slice(0, 4)).toEqual([owner.tenantId, workRef.workspaceId, workRef.projectId, workRef.workItemId]);
      return [{ projection: state.item, projection_sha256: state.hashMismatch ? "f".repeat(64) : canonicalJsonSha256(state.item) }];
    }
    throw new Error("Unexpected SQL in bounded work fixture");
  });
  const sql = Object.assign(spy, { transactionScoped: true }) as unknown as SqlClient;
  return { state, sql, spy };
}
async function reviewed(sql: SqlClient) {
  const id = responsibilityId(owner, "follow-work");
  const draft = { ...draftFixture, sources: [source], work: workRef, procedureId: WORK_ITEM_FOLLOWTHROUGH_PROCEDURE, agentId: "atlas" };
  const created = prepareResponsibilityChange({ owner, id, key: "follow-work", now, mutation: { action: "create", expectedRevision: 0, draft } }).current;
  const read = await readOwnedWorkItemWithSql(sql, owner, workRef, now);
  const procedure = buildResponsibilityWorkItemProcedure({ ...workRef, tenantId: owner.tenantId, ownerActorId: owner.actorId });
  const pin = buildAgentRunIdentityPinV1({ runId: id, identity: buildBuiltInAgentIdentityV1({ tenantId: owner.tenantId, controllerActorId: owner.actorId, agentId: "atlas" }) });
  const preview = reviewPreview(created, { sources: [{ source, revisionSha256: read.revisionSha256 }], work: { ...workRef, projectionSha256: read.projectionSha256 },
    procedure: { id: procedure.id, snapshotSha256: procedure.snapshotSha256, toolBindingsSha256: canonicalJsonSha256([{ id: tool.id, inputSha256: canonicalJsonSha256(workRef), contractSha256: canonicalJsonSha256(tool) }]) },
    agent: { id: "atlas", definitionVersionId: pin.definitionVersionId, principalVersionId: pin.principalVersionId, identityPinSha256: pin.pinSha256, policySha256: canonicalJsonSha256(pin.policyPins) } });
  return prepareResponsibilityChange({ owner, id, key: "review-work", now, current: created, preview,
    mutation: { action: "review", expectedRevision: 1, draftSha256: preview.draftSha256, reviewSha256: preview.reviewSha256 } }).current;
}

describe("Canonical WorkItem follow-through", () => {
  it("reads an old unchanged local source freshly, stays quiet, then detects the overdue crossing once", async () => {
    const db = database(); const record = await reviewed(db.sql);
    const flow = createResponsibilityObservationPipeline({ record, policySha256: policy.policySha256,
      readAuthoritativeSource: (input) => responsibilityObservationReader(context, owner)(input, db.sql) });
    const baseline = flow.plan(await flow.read({ observationKey: "first", observedAt: now }), null, 0);
    expect(baseline).toMatchObject({ outcome: "baseline_established", change: null });
    expect(baseline.observation.sources[0]).toMatchObject({ observedAt: now, sourceUpdatedAt: "2026-10-01T00:00:00.000Z" });
    const quiet = flow.plan(await flow.read({ observationKey: "quiet", observedAt: "2026-10-04T08:00:00.000Z" }), baseline.nextBaseline, 1);
    expect(quiet).toMatchObject({ outcome: "no_change", change: null });
    const overdue = flow.plan(await flow.read({ observationKey: "overdue", observedAt: "2026-10-04T09:00:00.000Z" }), quiet.nextBaseline, 2);
    expect(overdue).toMatchObject({ outcome: "material_change", reasons: ["work_overdue"], change: { categories: ["work_overdue"] } });
    expect(flow.plan(await flow.read({ observationKey: "again", observedAt: "2026-10-05T09:00:00.000Z" }), overdue.nextBaseline, 3)).toMatchObject({ outcome: "no_change", change: null });
  });
  it.each([
    ["Asia/Kolkata", "2026-10-04T18:29:59.999Z", "2026-10-04T18:30:00.000Z"],
    ["America/Los_Angeles", "2026-10-05T06:59:59.999Z", "2026-10-05T07:00:00.000Z"],
    ["Pacific/Kiritimati", "2026-10-04T09:59:59.999Z", "2026-10-04T10:00:00.000Z"],
    // Sydney starts daylight saving during this calendar day (23 hours).
    ["Australia/Sydney", "2026-10-04T12:59:59.999Z", "2026-10-04T13:00:00.000Z"],
  ])("treats a date-only commitment as overdue after its calendar day in %s, once", async (timeZone, onDate, afterDate) => {
    const db = database(item({ schedule: { startsAt: null, dueAt: null, dueDate: "2026-10-04", timeZone } }));
    const record = await reviewed(db.sql);
    const flow = createResponsibilityObservationPipeline({ record, policySha256: policy.policySha256,
      readAuthoritativeSource: (input) => responsibilityObservationReader(context, owner)(input, db.sql) });
    const baseline = flow.plan(await flow.read({ observationKey: "date-baseline", observedAt: now }), null, 0);
    const quiet = flow.plan(await flow.read({ observationKey: "during-date", observedAt: onDate }), baseline.nextBaseline, 1);
    expect(quiet).toMatchObject({ outcome: "no_change", change: null });
    const overdue = flow.plan(await flow.read({ observationKey: "after-date", observedAt: afterDate }), quiet.nextBaseline, 2);
    expect(overdue).toMatchObject({ outcome: "material_change", change: { categories: ["work_overdue"] } });
    expect(flow.plan(await flow.read({ observationKey: "after-date-again", observedAt: "2026-10-06T00:00:00.000Z" }), overdue.nextBaseline, 3))
      .toMatchObject({ outcome: "no_change", change: null });
    const read = await responsibilityObservationReader(context, owner)({ target: baseline.observation.target, source, observedAt: onDate }, db.sql);
    expect(read).toMatchObject({ state: "available", projection: { workItem: { dueAt: null, dueDate: "2026-10-04", dueTimeZone: timeZone, deadlineState: "date_only", overdue: false } } });
  });
  it("does not guess a date-only time zone or grant access from a named commitment owner", async () => {
    const db = database(item({ humanOwner: "Elena Ruiz", schedule: { startsAt: null, dueAt: null, dueDate: "2026-10-04", timeZone: null } }));
    const record = await reviewed(db.sql);
    const flow = createResponsibilityObservationPipeline({ record, policySha256: policy.policySha256,
      readAuthoritativeSource: (input) => responsibilityObservationReader(context, owner)(input, db.sql) });
    const baseline = flow.plan(await flow.read({ observationKey: "unknown-zone", observedAt: now }), null, 0);
    const reader = responsibilityObservationReader(context, owner);
    const read = await reader({ target: baseline.observation.target, source, observedAt: "2026-10-06T00:00:00.000Z" }, db.sql);
    expect(read).toMatchObject({ state: "available", projection: { workItem: { humanOwner: "Elena Ruiz", ownerActorIds: [owner.actorId], dueAt: null,
      dueDate: "2026-10-04", dueTimeZone: null, deadlineState: "date_only_timezone_unknown", overdue: null } } });
    expect(flow.plan(await flow.read({ observationKey: "still-unknown", observedAt: "2026-10-06T00:00:00.000Z" }), baseline.nextBaseline, 1))
      .toMatchObject({ outcome: "no_change", change: null });
    db.state.item = item({ ...db.state.item, ownerActorIds: ["actor:00000000-0000-4000-8000-000000000001"] });
    expect(await reader({ target: baseline.observation.target, source, observedAt: now }, db.sql)).toMatchObject({ state: "unavailable", reason: "access_denied" });
  });
  it("detects newly saved human owners, date-only deadlines and dependency states without invalidating its reviewed configuration", async () => {
    const db = database(); const record = await reviewed(db.sql);
    const configuration = (await resolveResponsibilityPilot(db.sql, owner, record, now, true)).configuration;
    const flow = createResponsibilityObservationPipeline({ record, policySha256: policy.policySha256,
      readAuthoritativeSource: (input) => responsibilityObservationReader(context, owner)(input, db.sql) });
    const baseline = flow.plan(await flow.read({ observationKey: "legacy", observedAt: now }), null, 0);
    db.state.item = item({ humanOwner: "Jonah Patel", schedule: { startsAt: null, dueAt: null, dueDate: "2026-10-07", timeZone: "Asia/Kolkata" },
      dependencyWorkItemIds: ["dependency-a"], updatedAt: now });
    db.state.dependencies = [item({ workItemId: "dependency-a", canonicalStatus: "unverified", sourceStatus: "done", terminalAt: now, updatedAt: now })];
    const changed = flow.plan(await flow.read({ observationKey: "structured", observedAt: now }), baseline.nextBaseline, 1);
    expect(changed).toMatchObject({ outcome: "material_change", change: { categories: ["work_deadline", "work_owners", "work_dependencies"] } });
    expect((await resolveResponsibilityPilot(db.sql, owner, record, now, false)).configuration).toEqual(configuration);
    expect(flow.plan(await flow.read({ observationKey: "structured-again", observedAt: now }), changed.nextBaseline, 2))
      .toMatchObject({ outcome: "no_change", change: null });
    db.state.dependencies = [item({ workItemId: "dependency-a", canonicalStatus: "waiting", sourceStatus: "open" })];
    const reopened = flow.plan(await flow.read({ observationKey: "dependency-reopened", observedAt: now }), changed.nextBaseline, 2);
    expect(reopened).toMatchObject({ outcome: "material_change", change: { categories: ["work_dependencies"] } });
  });
  it("observes done without verifying success, retains notification authority, and notices reopening", async () => {
    const db = database(); const record = await reviewed(db.sql);
    const resolved = await resolveResponsibilityPilot(db.sql, owner, record, now, true);
    const runtime = changeResponsibilityLifecycle({ owner, responsibilityId: record.id, current: null, configuration: resolved.configuration, now, nextDueAt: now,
      request: { action: "activate", expectedRevision: 0, expectedGeneration: 0, configurationSha256: resolved.configuration.configurationSha256, acknowledgePilot: RESPONSIBILITY_WORK_ITEM_PILOT } });
    const flow = createResponsibilityObservationPipeline({ record, policySha256: policy.policySha256,
      readAuthoritativeSource: (input) => responsibilityObservationReader(context, owner)(input, db.sql) });
    const baseline = flow.plan(await flow.read({ observationKey: "first", observedAt: now }), null, 0);
    db.state.item = item({ canonicalStatus: "unverified", sourceStatus: "done", terminalAt: now, updatedAt: now,
      artifacts: [{ artifactId: "proposal", kind: "document", evidenceRefIds: [] }] });
    const done = flow.plan(await flow.read({ observationKey: "done", observedAt: now }), baseline.nextBaseline, 1);
    expect(done.change?.categories).toEqual(["work_status", "work_outputs"]);
    const read = await responsibilityObservationReader(context, owner)({ target: done.observation.target, source, observedAt: now }, db.sql);
    expect(read).toMatchObject({ state: "available", projection: { workItem: { canonicalStatus: "unverified", sourceStatus: "done" } } });
    const notificationConfig = buildNotificationConfiguration(record, runtime, now);
    const admission = enableNotificationAdmission(notificationConfig, runtime, { action: "enable",
      expectedRuntimeRevision: runtime.revision, expectedRuntimeGeneration: runtime.generation, configurationSha256: notificationConfig.configurationSha256,
      acknowledgeDestination: "owner_in_app" }, now);
    expect(admitNotificationCandidate(admission, done.change!, "2026-10-04T01:00:00.000Z", now).candidate.state).toBe("pending");
    expect(notificationLifecycleTarget(admission, runtime, now).state).toBe("enabled");
    const afterDone = await resolveResponsibilityPilot(db.sql, owner, record, now, false);
    expect(afterDone.configuration).toEqual(resolved.configuration);
    expect(afterDone.configuration.stops).toEqual(["expiry"]);
    db.state.item = item();
    expect(flow.plan(await flow.read({ observationKey: "reopened", observedAt: now }), done.nextBaseline, 2).change?.categories).toContain("work_status");
  });
  it("pins the reviewed revision at activation, then validates current scope and digest on subsequent checks", async () => {
    const db = database(); const record = await reviewed(db.sql);
    const initial = await resolveResponsibilityPilot(db.sql, owner, record, now, true);
    db.state.item = item({ priority: "urgent", updatedAt: now });
    await expect(resolveResponsibilityPilot(db.sql, owner, record, now, true)).rejects.toMatchObject({ code: "responsibility_authority_changed" });
    expect((await resolveResponsibilityPilot(db.sql, owner, record, now, false)).configuration).toEqual(initial.configuration);
    db.state.hashMismatch = true;
    await expect(resolveResponsibilityPilot(db.sql, owner, record, now, false)).rejects.toBeDefined();
    db.state.hashMismatch = false; db.state.membership = false;
    await expect(resolveResponsibilityPilot(db.sql, owner, record, now, false)).rejects.toMatchObject({ code: "responsibility_owner_revoked" });
    db.state.membership = true; db.state.account = false;
    await expect(resolveResponsibilityPilot(db.sql, owner, record, now, false)).rejects.toMatchObject({ code: "responsibility_owner_revoked" });
  });
  it("rejects cross-scope and revoked ownership; dependencies expose only authorized exact states", async () => {
    for (const patch of [{ tenantId: "other" }, { workspaceId: "workspace:other" }, { projectId: "other" }, { workItemId: "other" }, { ownerActorIds: ["actor:22222222-2222-4222-8222-222222222222"] }]) {
      await expect(readOwnedWorkItemWithSql(database(item(patch)).sql, owner, workRef, now)).rejects.toBeDefined();
    }
    const db = database(item({ dependencyWorkItemIds: ["dependency-a", "dependency-b"] }));
    db.state.dependencies = [item({ workItemId: "dependency-a", canonicalStatus: "blocked", sourceStatus: "blocked" })];
    const read = await readOwnedWorkItemWithSql(db.sql, owner, workRef, now);
    expect(read.dependencies).toMatchObject([{ id: "dependency-a", state: "available", canonicalStatus: "blocked" }, { id: "dependency-b", state: "unavailable" }]);
    expect(db.spy).toHaveBeenCalledTimes(3);
    expect(() => verifyWorkItemSourceRead({ ...read, revisionSha256: "f".repeat(64) }, owner, workRef)).toThrow();
  });
  it("rejects mixed lane shapes, wrong acknowledgements, and arbitrary built-in procedure bindings", async () => {
    const db = database(); const record = await reviewed(db.sql); const { configuration, procedure } = await resolveResponsibilityPilot(db.sql, owner, record, now, true);
    expect(() => responsibilityDraftSchema.parse({ ...record.draft, work: { ...workRef, projectId: "another-project" } })).toThrow();
    expect(() => responsibilityDraftSchema.parse({ ...record.draft, sources: [source, { kind: "meeting", id: "meeting", workspaceId: source.workspaceId }] })).toThrow();
    for (const patch of [{ pilot: "native_meeting_metadata_v1" }, { stops: ["expiry", "meeting_started", "meeting_canceled"] },
      { source: { ...configuration.source, projectId: "other" } }, { tool: { ...configuration.tool, id: "app.meetings.show" } }]) {
      const body = { ...configuration, ...patch }; const { configurationSha256: _digest, ...unsigned } = body;
      expect(() => verifyPilotConfiguration({ ...unsigned, configurationSha256: canonicalJsonSha256(unsigned) })).toThrow();
    }
    expect(() => changeResponsibilityLifecycle({ owner, responsibilityId: record.id, current: null, configuration, now, nextDueAt: now,
      request: { action: "activate", expectedRevision: 0, expectedGeneration: 0, configurationSha256: configuration.configurationSha256, acknowledgePilot: "native_meeting_metadata_v1" } })).toThrow();
    expect(parseWorkflowProcedureSnapshot(procedure)).toEqual(procedure);
    expect(parseWorkflowProcedureSnapshot({ ...procedure, toolBindings: [{ toolId: "app.work_items.update", input: workRef }] })).toBeUndefined();
  });
});
