import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppBuilderStudio } from "../app-builder-studio";
import { BuilderEvidence, BuilderOutcome, BuilderRecordChoices } from "./components";
import { deployment, deploymentId, projectId, release, releaseId, snapshot, verification } from "./fixtures.test-support";

describe("Builder evidence and response presentation", () => {
  it("keeps unavailable selected records explicit in a bounded history", () => {
    const value = snapshot(); const missing = `app_build_release_${"1".repeat(48)}`;
    const html = renderToStaticMarkup(createElement(BuilderRecordChoices, { snapshot: value, deploymentId, releaseId: missing, verificationId: value.verifications[0].id, chooseDeployment: vi.fn(), chooseRelease: vi.fn(), chooseVerification: vi.fn() }));
    expect(html).toContain(missing); expect(html).toContain("Selected record unavailable"); expect(html).toContain("Totals and older pages are unavailable"); expect(html).toContain("Preview deployment record");
  });
  it("shows full identities, actual check evidence and rollback history without inventing rollback authority", () => {
    const value = snapshot(); const old = { ...verification(), checkpointId: "historical-exact-checkpoint" };
    const html = renderToStaticMarkup(createElement(BuilderEvidence, { session: value.session!, deployment: deployment(), release: release(), verification: old }));
    expect(html).toContain(releaseId); expect(html).toContain(deploymentId); expect(html).toContain("historical-exact-checkpoint"); expect(html).toContain("Historical verification");
    expect(html).toContain("provider:previous-production"); expect(html).toContain("does not expose a rollback action"); expect(html).not.toContain("<button");
    expect(html).toContain("lint"); expect(html).toContain("typecheck"); expect(html).toContain("output");
  });
  it("retains the action response when subsequent refresh failed and freezes uncertain decisions until review", () => {
    const accepted = renderToStaticMarkup(createElement(BuilderOutcome, { outcome: { action: "file.update", key: "frozen-key", state: "accepted", targets: [["path", "<script>unsafe()</script>"]] }, refreshFailed: true, reviewed: false, onReview: vi.fn() }));
    expect(accepted).toContain("Action response received"); expect(accepted).toContain("Refresh failed afterward"); expect(accepted).toContain("&lt;script&gt;"); expect(accepted).not.toContain("<script>");
    const uncertain = renderToStaticMarkup(createElement(BuilderOutcome, { outcome: { action: "command.run", key: "frozen-key", state: "uncertain", targets: [] }, refreshFailed: false, reviewed: false, onReview: vi.fn() }));
    expect(uncertain).toContain("No request has been retried"); expect(uncertain).toContain("disabled"); expect(uncertain).not.toContain("Retry exact");
  });
  it("renders neither private content nor a preview on inactive or unverified access", () => {
    const props = { project: { id: projectId, title: "Private title", objective: "Private objective", status: "active" }, ownerScopeKey: "verified-owner-role-deployment", accessReady: true, canManage: true };
    expect(renderToStaticMarkup(createElement(AppBuilderStudio, { ...props, active: false }))).toBe("");
    const hidden = renderToStaticMarkup(createElement(AppBuilderStudio, { ...props, accessReady: false }));
    expect(hidden).toContain("access is being checked"); expect(hidden).not.toContain("Private title"); expect(hidden).not.toContain("iframe");
  });
});
