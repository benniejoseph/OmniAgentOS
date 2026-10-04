import { describe, expect, it } from "vitest";
import { readLibraryItem, readLibraryList } from "./workspace-library-read";

const stamp = "2026-10-04T10:00:00.000Z";
function item(sourceId = "source-a") {
  return { schemaVersion: 1, id: `library:capture_asset:${sourceId}`, tenantId: "tenant-a", kind: "document", sourceAuthority: "capture_asset", sourceId,
    title: "An exact source", summary: "Literal <source> text", sourceLabel: "Capture", status: "ready", tags: [],
    scope: { visibility: "user_private", ownerActorId: "owner-a", workspaceId: null, projectId: null, missionId: null, workItemId: null, permissionBasis: "owner" },
    currentVersion: { versionId: "version-exact", versionNumber: 2, contentSha256: "a".repeat(64), byteCount: 27, mediaType: "text/plain", sourceRevisionId: "revision-exact", createdAt: stamp },
    versionCount: 3, citationRefs: ["citation:first", "citation:second"], links: [], openHref: `/api/capture/assets/${sourceId}?content=1`, createdAt: stamp, updatedAt: stamp };
}
const envelope = () => ({ items: [item()], total: 2, totalIsLowerBound: true, nextOffset: 1, countsByKind: { document: 2 }, countsAreLowerBound: true });
const expected = { tenantId: "tenant-a", limit: 100, offset: 0 };

describe("Library current-source reads", () => {
  it("retains server paging and all immutable current-version and citation identities", () => {
    const read = readLibraryList(envelope(), expected);
    expect(read.nextOffset).toBe(1);
    expect(read.items[0].currentVersion.versionId).toBe("version-exact");
    expect(read.items[0].citationRefs).toEqual(["citation:first", "citation:second"]);
    expect(read.totalIsLowerBound).toBe(true);
    expect(Object.isFrozen(read.items)).toBe(true);
  });
  it("requires confirmed counts and rows even for an empty read", () => {
    expect(() => readLibraryList({}, expected)).toThrow();
    expect(() => readLibraryList({ items: [] }, expected)).toThrow();
    expect(readLibraryList({ items: [], total: 0, totalIsLowerBound: false, nextOffset: null, countsByKind: {}, countsAreLowerBound: false }, expected).total).toBe(0);
  });
  it("rejects foreign ownership, changed source identity and unrelated exact responses", () => {
    expect(() => readLibraryItem({ ...item(), tenantId: "tenant-b" }, "tenant-a")).toThrow();
    expect(() => readLibraryItem({ ...item(), sourceId: "different" }, "tenant-a")).toThrow();
    expect(() => readLibraryItem(item(), "tenant-a", "library:capture_asset:other")).toThrow();
  });
  it("rejects duplicate rows, unsupported counts, impossible totals and nonadvancing pages", () => {
    for (const patch of [{ items: [item(), item()] }, { countsByKind: { unknown: 1 } }, { total: 0 }, { nextOffset: 0 }, { totalIsLowerBound: false }, { countsByKind: { document: -1 } }]) {
      expect(() => readLibraryList({ ...envelope(), ...patch }, expected)).toThrow();
    }
    expect(() => readLibraryList(envelope(), { ...expected, limit: 0 })).toThrow();
  });
  it("allows local application/private API links and null while rejecting escape links", () => {
    expect(readLibraryItem({ ...item(), openHref: null }, "tenant-a").openHref).toBeNull();
    expect(readLibraryItem({ ...item(), openHref: "/app/capture" }, "tenant-a").openHref).toBe("/app/capture");
    for (const href of ["//external.test", "/\\external.test", "/api/source\nother"]) {
      expect(() => readLibraryItem({ ...item(), openHref: href }, "tenant-a")).toThrow();
      expect(() => readLibraryItem({ ...item(), links: [{ kind: "source", id: "x", label: "Source", href }] }, "tenant-a")).toThrow();
    }
  });
  it("binds exact Capture destinations and source links to the returned source identity", () => {
    expect(() => readLibraryItem({ ...item(), openHref: "/api/capture/assets/other?content=1" }, "tenant-a")).toThrow();
    expect(() => readLibraryItem({ ...item(), links: [{ kind: "source", id: "other", label: "Captured file", href: "/app/capture" }] }, "tenant-a")).toThrow();
    const recording = { ...item(), id: "library:capture_recording:source-a", sourceAuthority: "capture_recording", kind: "recording", openHref: "/app/capture?recording=source-a" };
    expect(readLibraryItem(recording, "tenant-a").sourceId).toBe("source-a");
    expect(() => readLibraryItem({ ...recording, openHref: "/app/capture?recording=other" }, "tenant-a")).toThrow();
  });
  it("retains the legitimate legacy project route while binding the exact artifact and canonical link IDs", () => {
    const project = { ...item(), id: "library:project_artifact:source-a", sourceAuthority: "project_artifact", kind: "generated_artifact",
      scope: { ...item().scope, visibility: "project_shared", projectId: "canonical-project" },
      openHref: "/app/projects?project=legacy-project&artifact=source-a",
      links: [{ kind: "source", id: "source-a", label: "Artifact", href: "/app/projects?project=legacy-project&artifact=source-a" },
        { kind: "project", id: "canonical-project", label: "Project", href: "/app/projects?project=legacy-project" }] };
    expect(readLibraryItem(project, "tenant-a").scope.projectId).toBe("canonical-project");
    expect(() => readLibraryItem({ ...project, openHref: "/app/projects?project=legacy-project&artifact=other" }, "tenant-a")).toThrow();
  });
  it("accepts existing mission/source-item projections without inventing target IDs", () => {
    const source = { ...item(), id: "library:source_item:source-a", sourceAuthority: "source_item", openHref: "/app/capture",
      links: [{ kind: "source", id: "source-a", label: "Connected source", href: "/app/capture" }] };
    expect(readLibraryItem(source, "tenant-a").openHref).toBe("/app/capture");
    const mission = { ...item(), id: "library:mission_artifact:source-a", sourceAuthority: "mission_artifact", scope: { ...item().scope, visibility: "mission_shared", missionId: "mission-exact", projectId: "canonical-project" },
      openHref: "/app/missions/mission-exact?artifact=source-a", links: [
        { kind: "source", id: "source-a", label: "Artifact", href: "/app/missions/mission-exact" },
        { kind: "project", id: "canonical-project", label: "Project", href: "/app/missions/mission-exact" },
      ] };
    expect(readLibraryItem(mission, "tenant-a").scope.missionId).toBe("mission-exact");
    expect(() => readLibraryItem({ ...mission, openHref: "/app/missions/other?artifact=source-a" }, "tenant-a")).toThrow();
  });
});
