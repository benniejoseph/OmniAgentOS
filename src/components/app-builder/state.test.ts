import { describe, expect, it } from "vitest";
import { assertExactFile, assertSnapshotIdentity, boundedOutput, builderSelectionUrl, canConfirmRelease, exactSelection, isolatedPreviewUrl, readBuilderSelection, releaseConfirmationBasis, safeExternalUrl } from "./state";
import { deployment, deploymentId, digest, projectId, release, releaseId, sessionId, snapshot } from "./fixtures.test-support";

describe("Builder exact record and revision state", () => {
  it("retains exact records across reorder, omission and later reappearance without choosing a different first row", () => {
    const selected = deployment(); const other = { ...selected, id: `app_build_deployment_${"1".repeat(48)}` };
    expect(exactSelection([other, selected], selected.id)).toBe(selected);
    expect(exactSelection([other], selected.id)).toBeUndefined();
    expect(exactSelection([], selected.id)).toBeUndefined();
    expect(exactSelection([other], "invalid-selection")).toBeUndefined();
    expect(exactSelection([other, selected], "")).toBe(other);
  });
  it("roundtrips only navigation metadata while retaining full project/artifact identities and other query state", () => {
    const selection = readBuilderSelection(`?builderView=code&builderRail=checkpoints&builderFile=app%2Fpage.tsx&builderDeployment=${deploymentId}&builderRelease=${releaseId}`);
    const next = builderSelectionUrl("https://app.example.test/app/projects?project=owner%2Fproject%3A1&artifact=artifact%3Afull&view=build#return", selection);
    const url = new URL(next, "https://app.example.test");
    expect(url.searchParams.get("project")).toBe("owner/project:1"); expect(url.searchParams.get("artifact")).toBe("artifact:full");
    expect(url.searchParams.get("view")).toBe("build"); expect(url.hash).toBe("#return");
    expect(readBuilderSelection(url.search)).toEqual(selection);
    const scoped = builderSelectionUrl(url.href, selection, "owner-project");
    expect(readBuilderSelection(new URL(scoped, url.origin).search, "different-project").deployment).toBe("");
    expect(next).not.toMatch(/asael_preview|RELEASE|content|prompt/);
  });
  it("keeps a malformed explicit identity unresolved and rejects escaping or overlong file paths", () => {
    expect(readBuilderSelection("?builderDeployment=wrong&builderFile=..%2Fprivate")).toMatchObject({ deployment: "invalid-selection", file: "" });
    expect(readBuilderSelection("?builderFile=" + "x".repeat(241)).file).toBe("");
    expect(readBuilderSelection("?builderRelease=" + releaseId + "extra").release).toBe("invalid-selection");
  });
  it("binds production confirmation to session, exact release, source deployment, digest, expiry and state", () => {
    const original = release(); const basis = releaseConfirmationBasis(sessionId, original);
    for (const patch of [{ id: original.id + "a" }, { deploymentId: original.deploymentId + "a" }, { releaseDigest: "1".repeat(64) }, { expiresAt: "2026-10-04T00:14:00Z" }, { status: "building" as const }]) expect(releaseConfirmationBasis(sessionId, { ...original, ...patch })).not.toBe(basis);
    expect(releaseConfirmationBasis(sessionId + "b", original)).not.toBe(basis);
    expect(canConfirmRelease(original, Date.parse(original.expiresAt) - 1)).toBe(true);
    expect(canConfirmRelease(original, Date.parse(original.expiresAt))).toBe(false);
    expect(canConfirmRelease({ ...original, migrationEvidence: { ...original.migrationEvidence, status: "declared" } }, Date.parse(original.createdAt))).toBe(false);
    expect(canConfirmRelease({ ...original, status: "healthy" }, Date.parse(original.createdAt))).toBe(false);
  });
  it("isolates previews from the application origin, forbids credentials and executable URLs, and never strips private preview tokens into storage", () => {
    const origin = "https://app.example.test";
    for (const value of ["javascript:alert(1)", "data:text/html,hi", "http://sandbox.example.test", origin + "/api/private", "https://owner:secret@sandbox.example.test"]) expect(isolatedPreviewUrl(value, origin)).toBeUndefined();
    expect(isolatedPreviewUrl("https://sandbox.example.test/?asael_preview=exact", origin)).toBe("https://sandbox.example.test/?asael_preview=exact");
    expect(isolatedPreviewUrl("https://sandbox.example.test", "")).toBeUndefined(); expect(safeExternalUrl("/relative")).toBeUndefined();
  });
  it("rejects cross-project, cross-session and oversized history even when the selected path was authorized", () => {
    const value = snapshot(); expect(assertSnapshotIdentity(value, projectId)).toBe(value);
    expect(() => assertSnapshotIdentity(value, "foreign-project")).toThrow();
    expect(() => assertSnapshotIdentity({ ...value, checkpoints: [{ ...value.checkpoints[0], sessionId: "foreign" }] }, projectId)).toThrow();
    expect(() => assertSnapshotIdentity({ ...value, deployments: Array.from({ length: 21 }, (_, i) => ({ ...deployment(), id: String(i) })) }, projectId)).toThrow();
    expect(() => assertSnapshotIdentity({ ...value, verifications: [value.verifications[0], value.verifications[0]] }, projectId)).toThrow();
  });
  it("requires a complete exact file before enabling edits and bounds streamed output", () => {
    const file = { path: "app/page.tsx", content: "export default App", sha256: digest, size: 18 };
    expect(assertExactFile(file, file.path)).toBe(file);
    expect(() => assertExactFile(file, "app/foreign.tsx")).toThrow();
    expect(() => assertExactFile({ ...file, lineRange: { truncated: true } }, file.path)).toThrow();
    expect(() => assertExactFile({ ...file, sha256: "invalid" }, file.path)).toThrow();
    expect(boundedOutput("x".repeat(70_000))).toContain("Earlier output omitted");
    expect(boundedOutput("x".repeat(70_000)).split("\n")[1]).toHaveLength(64_000);
    expect(boundedOutput("small")).toBe("small");
  });
});
