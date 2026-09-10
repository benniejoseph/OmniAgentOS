import { describe, expect, it } from "vitest";
import {
  libraryAtlasConnectedNodeIds,
  projectWorkspaceLibraryAtlas,
} from "@/lib/library/atlas-projection";
import type { WorkspaceLibraryItem } from "@/lib/library/contracts";

const createdAt = "2026-09-10T08:00:00.000Z";

describe("workspace library atlas projection", () => {
  it("is deterministic and derives only explicit provenance links", () => {
    const image = item({
      id: "library:capture_asset:image-1",
      kind: "image",
      sourceAuthority: "capture_asset",
      sourceLabel: "Capture",
      title: "Mountain reference",
      tags: ["ICT", "research"],
      links: [
        {
          kind: "knowledge_document",
          id: "knowledge-1",
          label: "Indexed knowledge",
          href: "/app/memory",
        },
      ],
    });
    const transcript = item({
      id: "library:source_item:transcript-1",
      kind: "transcript",
      sourceAuthority: "source_item",
      sourceLabel: "Google Drive",
      title: "ICT market structure",
      tags: ["research", "course"],
      links: [
        {
          kind: "project",
          id: "project-1",
          label: "Trading research",
          href: "/app/projects?project=project-1",
        },
        {
          kind: "source",
          id: "provider-locator-that-must-not-be-a-node",
          label: "Drive source",
          href: "/app/capture",
        },
      ],
    });

    const first = projectWorkspaceLibraryAtlas([image, transcript], { total: 2 });
    const second = projectWorkspaceLibraryAtlas([transcript, image], { total: 2 });

    expect(first).toEqual(second);
    expect(first.version).toBe("library-atlas:1");
    expect(first.nodes.filter((node) => node.kind === "asset")).toHaveLength(2);
    expect(first.nodes.some((node) =>
      node.kind === "tag" && node.label === "research" && node.count === 2
    )).toBe(true);
    expect(first.nodes.some((node) =>
      node.kind === "knowledge_document" && node.label === "Indexed knowledge"
    )).toBe(true);
    expect(first.nodes.some((node) =>
      node.label.includes("provider-locator")
    )).toBe(false);
    expect(new Set(first.edges.map((edge) => edge.relation))).toEqual(new Set([
      "classified_as",
      "originates_from",
      "tagged_with",
      "linked_to",
    ]));
    expect(first.edges.every((edge) =>
      first.nodes.some((node) => node.id === edge.sourceNodeId) &&
      first.nodes.some((node) => node.id === edge.targetNodeId)
    )).toBe(true);
  });

  it("returns the selected asset and only its directly connected provenance", () => {
    const selected = item({
      id: "library:capture_asset:selected",
      kind: "document",
      title: "Selected transcript",
      tags: ["ict"],
    });
    const unrelated = item({
      id: "library:capture_asset:unrelated",
      kind: "image",
      title: "Unrelated image",
      tags: ["portrait"],
    });
    const projection = projectWorkspaceLibraryAtlas([selected, unrelated]);
    const connected = libraryAtlasConnectedNodeIds(projection, selected.id);
    const selectedNode = projection.nodes.find((node) => node.itemId === selected.id);
    const unrelatedNode = projection.nodes.find((node) => node.itemId === unrelated.id);

    expect(connected).toContain(selectedNode?.id);
    expect(connected).not.toContain(unrelatedNode?.id);
    expect(connected.length).toBeGreaterThan(1);
  });

  it("fails closed instead of drawing a cross-tenant scene", () => {
    expect(() => projectWorkspaceLibraryAtlas([
      item({ id: "library:capture_asset:one", tenantId: "tenant-one" }),
      item({ id: "library:capture_asset:two", tenantId: "tenant-two" }),
    ])).toThrow(/different tenants/i);
  });

  it("caps visual density and reports projection truncation honestly", () => {
    const items = Array.from({ length: 5 }, (_, index) => item({
      id: `library:capture_asset:${index}`,
      title: `Transcript ${index}`,
      tags: [`tag-${index}`],
    }));
    const projection = projectWorkspaceLibraryAtlas(items, {
      total: 20,
      totalIsLowerBound: true,
      nextOffset: 5,
      itemLimit: 2,
      hubLimit: 2,
      edgeLimit: 2,
    });

    expect(projection.resultScope).toEqual({
      loadedItems: 5,
      mappedItems: 2,
      total: 20,
      totalIsLowerBound: true,
      nextOffset: 5,
      truncated: true,
    });
    expect(projection.nodes.filter((node) => node.kind === "asset")).toHaveLength(2);
    expect(projection.nodes.filter((node) => node.kind !== "asset")).toHaveLength(2);
    expect(projection.edges.length).toBeLessThanOrEqual(2);
  });
});

function item(
  overrides: Partial<WorkspaceLibraryItem> & Pick<WorkspaceLibraryItem, "id">,
): WorkspaceLibraryItem {
  return {
    schemaVersion: 1,
    tenantId: "tenant-1",
    kind: "document",
    sourceAuthority: "capture_asset",
    sourceId: overrides.id,
    title: "Captured document",
    summary: "Source-backed document",
    sourceLabel: "Capture",
    status: "ready",
    tags: [],
    scope: {
      visibility: "user_private",
      ownerActorId: "actor-1",
      workspaceId: null,
      projectId: null,
      missionId: null,
      workItemId: null,
      permissionBasis: "owner",
    },
    currentVersion: {
      versionId: `version:${overrides.id}`,
      versionNumber: 1,
      contentSha256: "a".repeat(64),
      byteCount: 1_024,
      mediaType: "text/plain",
      sourceRevisionId: null,
      createdAt,
    },
    versionCount: 1,
    citationRefs: [`capture-asset:${overrides.id}`],
    links: [],
    openHref: "/app/capture",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}
