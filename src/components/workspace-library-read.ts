import { parseWorkspaceLibraryItem, workspaceLibraryKindSchema, type WorkspaceLibraryItem, type WorkspaceLibraryKind } from "@/lib/library/contracts";

export type LibraryRead = Readonly<{
  items: readonly WorkspaceLibraryItem[];
  total: number;
  totalIsLowerBound: boolean;
  nextOffset: number | null;
  countsByKind: Partial<Record<WorkspaceLibraryKind, number>>;
  countsAreLowerBound: boolean;
}>;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function requireRead(value: unknown): asserts value { if (!value) throw new Error("The Library response could not be verified. Refresh to read the current source."); }
const safeHref = (value: string | null) => value === null || /^\/(?!\/)[^\\\u0000-\u0020]*$/.test(value);

function sourceTarget(item: WorkspaceLibraryItem, href: string | null, sourceLink = false) {
  if (href === null) return true;
  const target = new URL(href, "https://library.invalid");
  const exactQuery = (entries: Record<string, string>) => !target.hash && target.searchParams.size === Object.keys(entries).length &&
    Object.entries(entries).every(([key, value]) => target.searchParams.get(key) === value);
  if (sourceLink && ["capture_asset", "capture_recording", "capture_transcript", "source_item"].includes(item.sourceAuthority)) return href === "/app/capture";
  switch (item.sourceAuthority) {
    case "capture_asset":
      return href === "/app/capture" || target.pathname === `/api/capture/assets/${encodeURIComponent(item.sourceId)}` &&
        (exactQuery({ content: "1" }) || exactQuery({ content: "1", download: "1" }));
    case "capture_recording": case "capture_transcript":
      return target.pathname === "/app/capture" && exactQuery({ recording: item.sourceId });
    case "source_item": return href === "/app/capture";
    case "project_artifact": {
      const project = target.searchParams.get("project");
      // This route carries the legacy project ID, while scope.projectId can be canonical.
      return target.pathname === "/app/projects" && Boolean(project) && exactQuery({ project: project!, artifact: item.sourceId }) &&
        (!sourceLink || !item.openHref || new URL(item.openHref, "https://library.invalid").searchParams.get("project") === project);
    }
    case "mission_artifact":
      return Boolean(item.scope.missionId) && target.pathname === `/app/missions/${encodeURIComponent(item.scope.missionId!)}` &&
        (sourceLink ? exactQuery({}) : exactQuery({ artifact: item.sourceId }));
  }
}

function relatedTarget(item: WorkspaceLibraryItem, link: WorkspaceLibraryItem["links"][number]) {
  if (link.kind === "source") return link.id === item.sourceId && sourceTarget(item, link.href, true);
  if (link.kind === "knowledge_document") return link.href === null || link.href === "/app/memory";
  const scopeId = { workspace: item.scope.workspaceId, project: item.scope.projectId, mission: item.scope.missionId, work_item: item.scope.workItemId }[link.kind];
  if (link.id !== scopeId) return false;
  if (link.href === null) return true;
  if (link.kind === "workspace") return link.href === "/app";
  if (link.kind === "mission") return link.href === `/app/missions/${encodeURIComponent(link.id)}`;
  if (link.kind === "work_item") return false;
  if (item.sourceAuthority === "mission_artifact") return link.href === `/app/missions/${encodeURIComponent(item.scope.missionId!)}`;
  const target = new URL(link.href, "https://library.invalid");
  const expectedProject = item.sourceAuthority === "project_artifact" && item.openHref
    ? new URL(item.openHref, "https://library.invalid").searchParams.get("project") : link.id;
  return target.pathname === "/app/projects" && !target.hash && target.searchParams.size === 1 && target.searchParams.get("project") === expectedProject;
}

export function readLibraryItem(value: unknown, tenantId: string, id?: string) {
  const item = parseWorkspaceLibraryItem(value);
  requireRead(item.tenantId === tenantId && (!id || item.id === id) && item.id === `library:${item.sourceAuthority}:${item.sourceId}`);
  requireRead(safeHref(item.openHref) && sourceTarget(item, item.openHref) && item.links.every((link) => safeHref(link.href) && relatedTarget(item, link)));
  return item;
}

/** Loaded lazily by the client so the strict domain schema stays out of the page's initial chunk. */
export function readLibraryList(value: unknown, expected: { tenantId: string; limit: number; offset: number }): LibraryRead {
  requireRead(object(value) && Array.isArray(value.items) && value.items.length <= expected.limit && count(value.total) &&
    typeof value.totalIsLowerBound === "boolean" && typeof value.countsAreLowerBound === "boolean" && object(value.countsByKind));
  const items = value.items.map((item) => readLibraryItem(item, expected.tenantId));
  requireRead(new Set(items.map((item) => item.id)).size === items.length && value.total >= expected.offset + items.length);
  requireRead(value.nextOffset === null || count(value.nextOffset) && value.nextOffset > expected.offset && items.length > 0 && value.totalIsLowerBound);
  const countsByKind: Partial<Record<WorkspaceLibraryKind, number>> = {};
  for (const [kind, amount] of Object.entries(value.countsByKind)) {
    requireRead(workspaceLibraryKindSchema.safeParse(kind).success && count(amount));
    countsByKind[kind as WorkspaceLibraryKind] = amount;
  }
  return Object.freeze({ items: Object.freeze(items), total: value.total, totalIsLowerBound: value.totalIsLowerBound,
    nextOffset: value.nextOffset as number | null, countsByKind: Object.freeze(countsByKind), countsAreLowerBound: value.countsAreLowerBound });
}
