import type {
  WorkspaceLibraryItem,
  WorkspaceLibraryKind,
} from "@/lib/library/contracts";

export const LIBRARY_ATLAS_VERSION = "library-atlas:1" as const;
export const LIBRARY_ATLAS_ITEM_LIMIT = 300;
export const LIBRARY_ATLAS_HUB_LIMIT = 96;
export const LIBRARY_ATLAS_EDGE_LIMIT = 1_500;

export type LibraryAtlasNodeKind =
  | "asset"
  | "kind"
  | "source"
  | "tag"
  | "workspace"
  | "project"
  | "mission"
  | "work_item"
  | "knowledge_document";

export type LibraryAtlasNode = Readonly<{
  id: string;
  kind: LibraryAtlasNodeKind;
  label: string;
  count: number;
  itemId?: string;
  assetKind?: WorkspaceLibraryKind;
  status?: WorkspaceLibraryItem["status"];
  updatedAt?: string;
}>;

export type LibraryAtlasEdgeRelation =
  | "classified_as"
  | "originates_from"
  | "tagged_with"
  | "linked_to";

export type LibraryAtlasEdge = Readonly<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: LibraryAtlasEdgeRelation;
}>;

export type LibraryAtlasProjection = Readonly<{
  version: typeof LIBRARY_ATLAS_VERSION;
  resultScope: Readonly<{
    loadedItems: number;
    mappedItems: number;
    total: number;
    totalIsLowerBound: boolean;
    nextOffset: number | null;
    truncated: boolean;
  }>;
  nodes: readonly LibraryAtlasNode[];
  edges: readonly LibraryAtlasEdge[];
}>;

export type LibraryAtlasProjectionOptions = Readonly<{
  total?: number;
  totalIsLowerBound?: boolean;
  nextOffset?: number | null;
  itemLimit?: number;
  hubLimit?: number;
  edgeLimit?: number;
}>;

type HubCandidate = {
  node: LibraryAtlasNode;
  priority: number;
};

type EdgeCandidate = LibraryAtlasEdge & { priority: number };

const linkNodeKinds = new Set<LibraryAtlasNodeKind>([
  "workspace",
  "project",
  "mission",
  "work_item",
  "knowledge_document",
]);

const hubPriorities: Record<Exclude<LibraryAtlasNodeKind, "asset">, number> = {
  kind: 0,
  source: 1,
  knowledge_document: 2,
  project: 3,
  mission: 3,
  workspace: 3,
  work_item: 4,
  tag: 5,
};

const edgePriorities: Record<LibraryAtlasEdgeRelation, number> = {
  classified_as: 0,
  originates_from: 1,
  linked_to: 2,
  tagged_with: 3,
};

/**
 * Builds a presentation-only provenance graph from the exact fields already
 * disclosed by the workspace library contract. It never invents semantic
 * asset-to-asset relationships.
 */
export function projectWorkspaceLibraryAtlas(
  input: readonly WorkspaceLibraryItem[],
  options: LibraryAtlasProjectionOptions = {},
): LibraryAtlasProjection {
  assertSingleTenant(input);

  const itemLimit = boundedLimit(
    options.itemLimit,
    LIBRARY_ATLAS_ITEM_LIMIT,
    LIBRARY_ATLAS_ITEM_LIMIT,
  );
  const hubLimit = boundedLimit(
    options.hubLimit,
    LIBRARY_ATLAS_HUB_LIMIT,
    LIBRARY_ATLAS_HUB_LIMIT,
  );
  const edgeLimit = boundedLimit(
    options.edgeLimit,
    LIBRARY_ATLAS_EDGE_LIMIT,
    LIBRARY_ATLAS_EDGE_LIMIT,
  );
  const items = [...input]
    .sort(compareItems)
    .slice(0, itemLimit);
  const assetNodes = items.map(assetNode);
  const hubs = new Map<string, HubCandidate>();
  const edges = new Map<string, EdgeCandidate>();

  for (const item of items) {
    const assetId = assetNodeId(item.id);
    const kindId = `kind:${item.kind}`;
    addHub(hubs, {
      id: kindId,
      kind: "kind",
      label: libraryKindLabel(item.kind),
      count: 1,
    });
    addEdge(edges, assetId, kindId, "classified_as");

    const sourceId = `source:${item.sourceAuthority}:${stableDigest(
      item.sourceLabel.toLocaleLowerCase(),
    )}`;
    addHub(hubs, {
      id: sourceId,
      kind: "source",
      label: item.sourceLabel,
      count: 1,
    });
    addEdge(edges, assetId, sourceId, "originates_from");

    for (const tag of [...new Set(item.tags.map(normalizeLabel).filter(Boolean))]
      .sort(compareText)
      .slice(0, 6)) {
      const tagId = `tag:${stableDigest(tag.toLocaleLowerCase())}`;
      addHub(hubs, {
        id: tagId,
        kind: "tag",
        label: tag,
        count: 1,
      });
      addEdge(edges, assetId, tagId, "tagged_with");
    }

    for (const link of [...item.links].sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
    )) {
      if (!linkNodeKinds.has(link.kind as LibraryAtlasNodeKind)) continue;
      const nodeKind = link.kind as LibraryAtlasNodeKind;
      const linkId = `link:${nodeKind}:${stableDigest(link.id)}`;
      addHub(hubs, {
        id: linkId,
        kind: nodeKind,
        label: link.label,
        count: 1,
      });
      addEdge(edges, assetId, linkId, "linked_to");
    }
  }

  const allHubs = [...hubs.values()].sort(compareHubs);
  const selectedHubs = allHubs.slice(0, hubLimit).map((candidate) =>
    Object.freeze(candidate.node)
  );
  const selectedNodeIds = new Set([
    ...assetNodes.map((node) => node.id),
    ...selectedHubs.map((node) => node.id),
  ]);
  const viableEdges = [...edges.values()]
    .filter((edge) =>
      selectedNodeIds.has(edge.sourceNodeId) &&
      selectedNodeIds.has(edge.targetNodeId)
    )
    .sort(compareEdges);
  const selectedEdges = viableEdges
    .slice(0, edgeLimit)
    .map(({ priority: _priority, ...edge }) => Object.freeze(edge));
  const total = Math.max(
    input.length,
    boundedCount(options.total, input.length),
  );

  return Object.freeze({
    version: LIBRARY_ATLAS_VERSION,
    resultScope: Object.freeze({
      loadedItems: input.length,
      mappedItems: items.length,
      total,
      totalIsLowerBound: Boolean(options.totalIsLowerBound),
      nextOffset: boundedOffset(options.nextOffset),
      truncated:
        input.length > items.length ||
        allHubs.length > selectedHubs.length ||
        viableEdges.length > selectedEdges.length,
    }),
    nodes: Object.freeze([
      ...assetNodes.map((node) => Object.freeze(node)),
      ...selectedHubs,
    ]),
    edges: Object.freeze(selectedEdges),
  });
}

export function libraryAtlasConnectedNodeIds(
  projection: LibraryAtlasProjection,
  itemId?: string,
) {
  if (!itemId) return Object.freeze([] as string[]);
  const assetId = assetNodeId(itemId);
  const connected = new Set<string>([assetId]);
  for (const edge of projection.edges) {
    if (edge.sourceNodeId === assetId) connected.add(edge.targetNodeId);
    if (edge.targetNodeId === assetId) connected.add(edge.sourceNodeId);
  }
  return Object.freeze([...connected].sort(compareText));
}

function assetNode(item: WorkspaceLibraryItem): LibraryAtlasNode {
  return {
    id: assetNodeId(item.id),
    kind: "asset",
    label: item.title,
    count: 1,
    itemId: item.id,
    assetKind: item.kind,
    status: item.status,
    updatedAt: item.updatedAt,
  };
}

function assetNodeId(itemId: string) {
  return `asset:${stableDigest(itemId)}`;
}

function addHub(
  hubs: Map<string, HubCandidate>,
  node: LibraryAtlasNode,
) {
  const existing = hubs.get(node.id);
  if (existing) {
    existing.node = { ...existing.node, count: existing.node.count + 1 };
    return;
  }
  hubs.set(node.id, {
    node,
    priority: hubPriorities[node.kind as Exclude<LibraryAtlasNodeKind, "asset">],
  });
}

function addEdge(
  edges: Map<string, EdgeCandidate>,
  sourceNodeId: string,
  targetNodeId: string,
  relation: LibraryAtlasEdgeRelation,
) {
  const id = `edge:${relation}:${sourceNodeId}:${targetNodeId}`;
  if (edges.has(id)) return;
  edges.set(id, {
    id,
    sourceNodeId,
    targetNodeId,
    relation,
    priority: edgePriorities[relation],
  });
}

function compareItems(left: WorkspaceLibraryItem, right: WorkspaceLibraryItem) {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function compareHubs(left: HubCandidate, right: HubCandidate) {
  return left.priority - right.priority ||
    right.node.count - left.node.count ||
    left.node.id.localeCompare(right.node.id);
}

function compareEdges(left: EdgeCandidate, right: EdgeCandidate) {
  return left.priority - right.priority || left.id.localeCompare(right.id);
}

function compareText(left: string, right: string) {
  return left.localeCompare(right);
}

function normalizeLabel(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function stableDigest(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value as number), 1), maximum);
}

function boundedCount(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : fallback;
}

function boundedOffset(value: number | null | undefined) {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

function assertSingleTenant(items: readonly WorkspaceLibraryItem[]) {
  const tenants = new Set(items.map((item) => item.tenantId));
  if (tenants.size > 1) {
    throw new Error("Library Atlas cannot combine items from different tenants.");
  }
}

function libraryKindLabel(kind: WorkspaceLibraryKind) {
  return kind === "generated_artifact"
    ? "Generated"
    : kind.charAt(0).toUpperCase() + kind.slice(1).replaceAll("_", " ");
}
