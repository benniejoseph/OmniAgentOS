import { randomUUID } from "node:crypto";
import { searchOwnedThreadsPage } from "@/lib/threads/store";
import { searchPrivateMemoryPage } from "@/lib/memory/store";
import { listWorkspaceLibrary } from "@/lib/library/store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { searchOwnedWorkPage } from "./work-reader";
import { encodeSearchCursor, type ContentSearchRequest } from "./cursor";
import {
  contentSearchCoverage, contentSearchLabels, contentSearchProviders, contentSearchResponseSchema, searchGroupSchema,
  type ContentSearchGroup, type ContentSearchItem, type ContentSearchProvider,
} from "./contracts";

const searchReaders = { conversations: searchOwnedThreadsPage, work: searchOwnedWorkPage,
  memory: searchPrivateMemoryPage, library: listWorkspaceLibrary };
export type ContentSearchReaders = typeof searchReaders;

export async function searchContent(context: SecurityContext, request: ContentSearchRequest,
  readers: ContentSearchReaders = searchReaders) {
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  const memoryAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.read, auditPurpose: "content.search.private", correlationId: randomUUID(),
  });
  const groups: ContentSearchGroup[] = [];
  // The hosted database has one connection. Independent groups recover serially;
  // parallel reservations here would turn a partial read into pool starvation.
  for (const provider of request.provider ? [request.provider] : contentSearchProviders) {
    const base = { provider, label: contentSearchLabels[provider], coverage: contentSearchCoverage[provider] };
    if (!binding || !context.tenantId.trim() || !context.actorId.trim()) {
      groups.push({ ...base, status: "unavailable", items: [], nextCursor: null,
        message: "Sign in with a current workspace account to search this content." });
      continue;
    }
    try {
      const scope = { tenantId: context.tenantId, actorId: context.actorId, requestActorBinding: binding,
        query: request.query, limit: request.limit, ...(request.cursor?.after ? { after: request.cursor.after } : {}) };
      let items: ContentSearchItem[];
      let nextCursor: string | null = null;
      const keysetCursor = (after: { updatedAt: string; id: string } | null) => after
        ? encodeSearchCursor(context, request.query, { provider, after, offset: null }) : null;
      if (provider === "conversations") {
        const page = await readers.conversations(scope);
        items = page.items.map((item) => ({ ...item, detail: "Conversation", href: `/app/command?thread=${encodeURIComponent(item.id)}` }));
        nextCursor = keysetCursor(page.next);
      } else if (provider === "work") {
        const page = await readers.work(scope);
        items = page.items.map((item) => ({ id: item.id, title: item.title, updatedAt: item.updatedAt,
          detail: item.kind, href: `/app/projects?project=${encodeURIComponent(item.projectId)}${item.taskId ? `&task=${encodeURIComponent(item.taskId)}` : ""}&fromSearch=1` }));
        nextCursor = keysetCursor(page.next);
      } else if (provider === "memory") {
        if (!memoryAccess) throw new Error("Canonical memory scope is unavailable.");
        const page = await readers.memory({ ...scope, accessScope: memoryAccess.databaseAccessScope });
        items = page.items.map((item) => ({ ...item, detail: "Active private memory", href: `/app/memory?memory=${encodeURIComponent(item.id)}` }));
        nextCursor = keysetCursor(page.next);
      } else {
        const page = await readers.library({ ...scope, offset: request.cursor?.offset ?? 0,
          sourceAuthorities: ["capture_asset", "capture_recording", "capture_transcript", "project_artifact", "source_item"] });
        items = page.items.map((item) => ({ id: item.id, title: item.title, updatedAt: item.updatedAt,
          detail: `${item.kind.replaceAll("_", " ")} · ${item.status}`, href: `/app/capture?libraryItem=${encodeURIComponent(item.id)}` }));
        nextCursor = page.nextOffset !== null && page.nextOffset <= 10_000
          ? encodeSearchCursor(context, request.query, { provider, after: null, offset: page.nextOffset }) : null;
      }
      groups.push(searchGroupSchema.parse({ ...base, status: "ready", items, nextCursor, message: null }));
    } catch {
      groups.push(unavailable(base));
    }
  }
  return contentSearchResponseSchema.parse({ query: request.query, generatedAt: new Date().toISOString(), groups, consistency: "live" });
}
function unavailable(base: { provider: ContentSearchProvider; label: string; coverage: string }): ContentSearchGroup {
  return { ...base, status: "unavailable", items: [], nextCursor: null,
    message: "This content could not be searched. Try again; other groups remain available." };
}
