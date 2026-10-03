import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RESPONSIBILITY_PILOT_DISCLOSURE } from "@/lib/responsibilities/runtime-contracts";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY } from "@/lib/responsibilities/comparison-policy";
import { draftFixture as draft, nowFixture as now, ownerFixture as owner } from "@/lib/responsibilities/test-fixtures";
import { prepareResponsibilityChange, responsibilityId } from "@/lib/responsibilities/state";
import { emptyDraft, responsibilityHref, sessionResponsibilityOwner, type Detail, type ObservationView, type References, type RuntimeView } from "./model";
import { DraftEditor, normalizedDraft, reconcileDraft } from "./draft-editor";
import { ReferencePicker } from "./reference-picker";
import { RuntimePanel } from "./runtime-panel";
import { ObservationsPanel } from "./observations-panel";

const id = responsibilityId(owner, "component");
const current = prepareResponsibilityChange({ owner, id, key: "component", now, mutation: { action: "create", expectedRevision: 0, draft } }).current;
const detail: Detail = { record: current, readiness: { state: "not_checked", issues: [] } };
describe("Responsibility owner-facing presentation", () => {
  it("binds private state to the actual canonical user, including an email reused by a different account", () => {
    const session = { authenticated: true, context: { tenantId: "tenant-a", actorId: "owner@example.test" }, user: { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" } };
    expect(sessionResponsibilityOwner(session)).toEqual(owner);
    expect(sessionResponsibilityOwner({ ...session, user: { ...session.user, id: "22222222-2222-4222-8222-222222222222" } })?.actorId).not.toBe(owner.actorId);
    expect(sessionResponsibilityOwner({ ...session, user: { ...session.user, email: "foreign@example.test" } })).toBeUndefined();
    expect(sessionResponsibilityOwner({ ...session, authenticated: false })).toBeUndefined();
    expect(sessionResponsibilityOwner({ ...session, user: undefined })).toBeUndefined();
  });
  it("retains dirty same-owner drafts across a newer revision, while clean drafts follow current evidence", () => {
    const original = emptyDraft(); const dirty = { ...original, purpose: "My unsaved purpose" };
    const old = { observed: 0, basis: 0, original, draft: dirty };
    expect(reconcileDraft(old, detail)).toEqual({ ...old, observed: 1 });
    expect(reconcileDraft({ ...old, draft: original }, detail)).toMatchObject({ basis: 1, draft });
    expect(reconcileDraft({ ...old, draft }, detail)).toMatchObject({ basis: 1, draft });
  });
  it("shows explicit inactivity, finite dimensions, descriptive stops and frozen controls", () => {
    const html = renderToStaticMarkup(createElement(DraftEditor, { detail, canManage: true, frozen: true, references: { state: "error", error: "Unavailable" }, save: vi.fn(), preview: vi.fn(), refreshReferences: vi.fn() }));
    expect(html).toContain("Saving or reviewing keeps the draft inactive.");
    expect(html).toContain("<fieldset disabled="); expect(html).toContain("Maximum checks"); expect(html).toContain("Cost (micro USD)");
    expect(html).toContain("Zero means no budget"); expect(html).toContain("descriptive stop conditions"); expect(html).not.toContain("Activate this exact pilot");
    expect(normalizedDraft({ ...draft, purpose: "  purpose  ", stopConditions: [" first ", ""] })).toMatchObject({ purpose: "purpose", stopConditions: ["first"] });
  });
  it("keeps unavailable source groups distinct from an empty readable result and escapes labels", () => {
    const empty = { state: "available" as const, items: [], hasMore: false };
    const references: References = { owner, groups: { sources: { state: "available", items: [{ source: draft.sources[0], label: "<script>private()</script>" }], hasMore: true }, work: empty,
      procedures: { state: "unavailable", items: [], hasMore: null }, agents: empty } };
    const html = renderToStaticMarkup(createElement(ReferencePicker, { draft, onChange: vi.fn(), refresh: vi.fn(), resource: { state: "ready", value: references } }));
    expect(html).toContain("procedures are unavailable"); expect(html).toContain("No readable Work items"); expect(html).toContain("More exist outside this page");
    expect(html).toContain("&lt;script&gt;private()&lt;/script&gt;"); expect(html).not.toContain("<script>");
    expect(html).toContain(draft.sources[0].id);
  });
  it("never infers activation or dispatch from a reviewed draft or an unavailable lifecycle", () => {
    const html = renderToStaticMarkup(createElement(RuntimePanel, { resource: { state: "error", error: "Not available" }, record: current, enabled: true, frozen: false, refresh: vi.fn(), preview: vi.fn(), control: vi.fn() }));
    expect(html).toContain("Activation status is unknown"); expect(html).not.toContain("Activate this exact pilot");
    const view: RuntimeView = { current: null, disclosure: RESPONSIBILITY_PILOT_DISCLOSURE, wakes: [], receipts: [], coverage: { limit: 40, total: null, hasMoreWakes: false, hasMoreReceipts: false }, dispatchReadiness: "not_observed", deliverySupported: false };
    const inactive = renderToStaticMarkup(createElement(RuntimePanel, { resource: { state: "ready", value: view }, record: current, enabled: true, frozen: false, refresh: vi.fn(), preview: vi.fn(), control: vi.fn() }));
    expect(inactive).toContain("no activation recorded"); expect(inactive).toContain("Dispatch readiness has not been observed"); expect(inactive).toContain("Free-text success and stop conditions");
  });
  it("shows material/cosmetic policy and baseline absence without inventing delivery or observations", () => {
    const view: ObservationView = { receipts: [], baseline: null, hasMore: false, policy: RESPONSIBILITY_MEETING_COMPARISON_POLICY, coverage: { kind: "bounded_recent", limit: 25, returned: 0, total: null } };
    const html = renderToStaticMarkup(createElement(ObservationsPanel, { resource: { state: "ready", value: view }, refresh: vi.fn() }));
    expect(html).toContain("No accepted baseline"); expect(html).toContain("Material changes"); expect(html).toContain("Cosmetic changes"); expect(html).toContain("Reading this page does not run a check");
    expect(responsibilityHref(id)).toBe(`/app/responsibilities/${encodeURIComponent(id)}`);
  });
});
