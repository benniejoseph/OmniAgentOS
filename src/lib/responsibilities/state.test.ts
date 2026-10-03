import { describe, expect, it } from "vitest";
import { responsibilityDraftSchema, responsibilityMutationSchema } from "./contracts";
import { incompleteDraft, prepareResponsibilityChange, responsibilityId, reviewPreview, verifiedRecord } from "./state";
import { draftFixture as draft, nowFixture as now, ownerFixture as owner, pinsFixture as pins } from "./test-fixtures";
const key = "create-a";
const id = responsibilityId(owner, key);
const create = () => prepareResponsibilityChange({ owner, id, key, now, mutation: { action: "create", expectedRevision: 0, draft } });

describe("Responsibility draft and review state", () => {
  it("rejects unknown versions, activation actions, broad targets and non-finite bounds", () => {
    for (const bad of [ { ...draft, schemaVersion: 2 }, { ...draft, active: true }, { ...draft, sources: [{ kind: "url", id: "https://example.test" }] },
      { ...draft, cadence: { ...draft.cadence, expiresAt: null } }, { ...draft, limits: { ...draft.limits, maxChecks: 0 } },
      { ...draft, notificationRule: { ...draft.notificationRule, destination: "participants" } } ]) expect(responsibilityDraftSchema.safeParse(bad).success).toBe(false);
    expect(responsibilityMutationSchema.safeParse({ action: "activate", expectedRevision: 1 }).success).toBe(false);
  });
  it("rejects duplicate sources, malformed zones and missing budget dimensions", () => {
    expect(responsibilityDraftSchema.safeParse({ ...draft, sources: [draft.sources[0], draft.sources[0]] }).success).toBe(false);
    expect(responsibilityDraftSchema.safeParse({ ...draft, cadence: { ...draft.cadence, timezone: "not/a-zone" } }).success).toBe(false);
    expect(responsibilityDraftSchema.safeParse({ ...draft, limits: { ...draft.limits, cumulative: { tokens: 1 } } }).success).toBe(false);
  });
  it("persists incomplete drafts without implying review or activation", () => {
    const empty = { ...draft, purpose: "", sources: [], cadence: null, work: null };
    const saved = prepareResponsibilityChange({ owner, id, key, now, mutation: { action: "create", expectedRevision: 0, draft: empty } });
    expect(saved.current).toMatchObject({ state: "draft", revision: 1, review: null });
    expect(saved.receipt).toMatchObject({ action: "created", authorityEffect: "none", activationSupported: false });
    expect(incompleteDraft(empty, now)).toEqual(["purpose_required", "sources_required", "cadence_required", "canonical_work_required"]);
  });
  it("separates identities across tenant, owner and idempotency key", () => {
    expect(new Set([id, responsibilityId({ ...owner, tenantId: "tenant-b" }, key), responsibilityId({ ...owner, actorId: "actor-b" }, key), responsibilityId(owner, "create-b")]).size).toBe(4);
    expect(() => responsibilityId(owner, "")).toThrow(/Idempotency/);
  });
  it("replays the exact old receipt beside a newer head", () => {
    const first = create();
    const next = prepareResponsibilityChange({ owner, id, key: "update-a", now, current: first.current, mutation: { action: "update", expectedRevision: 1, draft: { ...draft, purpose: "Updated owner purpose" } } });
    const replay = prepareResponsibilityChange({ owner, id, key, now, current: next.current, existing: first.receipt, mutation: { action: "create", expectedRevision: 0, draft } });
    expect(replay).toMatchObject({ replayed: true, current: { revision: 2 }, receipt: { snapshot: { revision: 1, draft } } });
  });
  it("rejects reused keys with changed values and stale write revisions", () => {
    const first = create();
    expect(() => prepareResponsibilityChange({ owner, id, key, now, current: first.current, existing: first.receipt, mutation: { action: "create", expectedRevision: 0, draft: { ...draft, purpose: "Other purpose" } } })).toThrow(/another draft change/);
    expect(() => prepareResponsibilityChange({ owner, id, key: "update", now, current: first.current, mutation: { action: "update", expectedRevision: 2, draft } })).toThrow(/changed/);
  });
  it("binds exact source revisions, Work, Agent and policy in a non-activating review", () => {
    const first = create();
    const preview = reviewPreview(first.current, pins);
    const result = prepareResponsibilityChange({ owner, id, key: "review", now, current: first.current, preview,
      mutation: { action: "review", expectedRevision: 1, draftSha256: preview.draftSha256, reviewSha256: preview.reviewSha256 } });
    expect(result.current).toMatchObject({ state: "reviewed", revision: 2, review: { pins, authorityEffect: "none", activationSupported: false } });
    expect(verifiedRecord(result.current)).toEqual(result.current);
    expect(() => reviewPreview(first.current, { ...pins, agent: { ...pins.agent, id: "someone-else" } })).toThrow(/could not be verified/);
  });
  it("invalidates a prepared review when a source version changes without changing its ID", () => {
    const first = create();
    const previous = reviewPreview(first.current, pins);
    const current = reviewPreview(first.current, { ...pins, sources: [{ ...pins.sources[0], revisionSha256: "0".repeat(64) }] });
    expect(current.reviewSha256).not.toBe(previous.reviewSha256);
    expect(() => prepareResponsibilityChange({ owner, id, key: "review", now, current: first.current, preview: current,
      mutation: { action: "review", expectedRevision: 1, draftSha256: previous.draftSha256, reviewSha256: previous.reviewSha256 } })).toThrow(/review changed/);
  });
  it("clears review on every edited revision, including a same-value save", () => {
    const first = create(); const preview = reviewPreview(first.current, pins);
    const reviewed = prepareResponsibilityChange({ owner, id, key: "review", now, current: first.current, preview,
      mutation: { action: "review", expectedRevision: 1, draftSha256: preview.draftSha256, reviewSha256: preview.reviewSha256 } });
    const updated = prepareResponsibilityChange({ owner, id, key: "edit", now, current: reviewed.current, mutation: { action: "update", expectedRevision: 2, draft } });
    expect(updated.current).toMatchObject({ revision: 3, state: "draft", review: null });
    expect(reviewed.receipt.snapshot.review).not.toBeNull();
  });
  it("rejects expiry and corrupted or cross-owner persisted evidence", () => {
    const first = create(); const preview = reviewPreview(first.current, pins);
    expect(() => prepareResponsibilityChange({ owner, id, key: "review", now: "2026-10-12T00:00:00.000Z", current: first.current, preview,
      mutation: { action: "review", expectedRevision: 1, draftSha256: preview.draftSha256, reviewSha256: preview.reviewSha256 } })).toThrow(/incomplete/);
    expect(() => verifiedRecord({ ...first.current, draftSha256: "0".repeat(64) })).toThrow(/verified/);
    expect(() => prepareResponsibilityChange({ owner: { ...owner, actorId: "other" }, id, key: "edit", now, current: first.current, mutation: { action: "update", expectedRevision: 1, draft } })).toThrow(/verified/);
  });
});
