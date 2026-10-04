import { describe, expect, it } from "vitest";
import { z } from "zod";

import { workspaceLibraryListServiceInputSchema } from "@/lib/app-services/library";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  nativeLibraryContractSchemas, nativeLibraryErrorResponseSchema, nativeLibraryExactIdSchema,
  nativeLibraryItemSchema, nativeLibraryListQuerySchema, nativeLibraryListResponseForScopeSchema,
  nativeLibraryListResponseSchema, nativeLibraryReadResponseForScopeSchema, nativeLibraryReadResponseSchema,
} from "./library-contracts";

const now = "2026-10-04T12:00:00.000Z", hash = "a".repeat(64), tenantId = "tenant-a", actorId = "owner@example.test";
const scope = { tenantId, readableOwnerActorIds: [actorId, "actor:11111111-1111-4111-8111-111111111111"] };
function item(authority: "capture_asset" | "source_item" | "mission_artifact" = "capture_asset") {
  return { schemaVersion: 1, id: `library:${authority}:source-one`, tenantId, kind: "file", sourceAuthority: authority,
    sourceId: "source-one", title: "Exact file", summary: "A bounded source", sourceLabel: "Capture", status: "ready", tags: [],
    scope: { visibility: "user_private", ownerActorId: actorId, workspaceId: null, projectId: null, missionId: null, workItemId: null, permissionBasis: "owner" },
    currentVersion: { versionId: "version:source-one:1", versionNumber: 1, contentSha256: hash, byteCount: 42,
      mediaType: "application/pdf", sourceRevisionId: authority === "source_item" ? "source-revision:one" : null, createdAt: now },
    versionCount: 1, citationRefs: ["source:one"], links: [{ kind: "source", id: "source-one", label: "Source", href: "/app/capture" }],
    openHref: "/app/capture", createdAt: now, updatedAt: now };
}
function receipt(operation: "app.library.list" | "app.library.show", data: unknown, resourceCount: number) {
  const contract = getAppServiceOperationContract(operation);
  const body = { schemaVersion: 1, receiptKind: "app_service_receipt", boundaryVersion: "p9.1-app-service-boundary:1",
    operation, action: contract.action, resourceType: contract.resourceType, accessMode: "read", eventContract: contract.eventContract,
    authoritySha256: hash, idempotencyKeySha256: null, outcomeSha256: canonicalJsonSha256(data), resourceCount, occurredAt: now };
  return { ...body, receiptSha256: canonicalJsonSha256(body) };
}
function listing(options: { items?: ReturnType<typeof item>[]; offset?: number; more?: boolean } = {}) {
  const items = options.items ?? [item()], offset = options.offset ?? 0, more = options.more ?? false;
  const data = { items, total: offset + items.length + (more ? 1 : 0), totalIsLowerBound: more,
    nextOffset: more && items.length ? offset + items.length : null, countsByKind: { file: items.length }, countsAreLowerBound: more };
  return { ...data, serviceReceipt: receipt("app.library.list", data, items.length), generatedAt: now };
}
function detail(value = item()) {
  return { item: value, serviceReceipt: receipt("app.library.show", { item: value }, 1) };
}

describe("unpublished native Library reads", () => {
  it("retains authoritative list bounds and normalized kind semantics", () => {
    for (const query of [{}, { q: " plan ", kind: "document, file", project: "project-one", limit: 100, offset: 10_000 },
      { limit: 101 }, { offset: 10_001 }, { kind: "invented" }, { q: "x".repeat(241) }]) {
      const candidate = nativeLibraryListQuerySchema.safeParse(query);
      const wire = query as { q?: string; kind?: string; project?: string; limit?: number; offset?: number };
      const domain = workspaceLibraryListServiceInputSchema.safeParse({ query: wire.q, kinds: wire.kind?.split(",").map((value) => value.trim()),
        projectId: wire.project, limit: wire.limit, offset: wire.offset });
      expect(candidate.success).toBe(domain.success);
    }
    expect(nativeLibraryListQuerySchema.safeParse({ tenantId: "foreign" }).success).toBe(false);
    expect(nativeLibraryListQuerySchema.safeParse({ kind: Array(21).fill("file").join(",") }).success).toBe(false);
  });

  it("accepts exact read receipts and excludes the route timestamp from the list outcome hash", () => {
    expect(nativeLibraryListResponseSchema.parse({ ...listing(), generatedAt: "2026-10-05T12:00:00.000Z" }).items).toHaveLength(1);
    expect(nativeLibraryReadResponseSchema.parse(detail()).item.currentVersion.contentSha256).toBe(hash);
  });

  it("preserves lower-bound and empty-page truth without manufacturing an available total", () => {
    expect(nativeLibraryListResponseForScopeSchema({ ...scope, offset: 5, limit: 1 }).safeParse(listing({ offset: 5, more: true })).success).toBe(true);
    expect(nativeLibraryListResponseForScopeSchema({ ...scope, offset: 5, limit: 1 }).safeParse(listing({ items: [], offset: 5, more: true })).success).toBe(true);
    expect(nativeLibraryListResponseSchema.safeParse(listing({ items: [] })).success).toBe(true);
  });

  it("rejects wrong operation, altered content, malformed hashes and leaked receipt fields", () => {
    const value = detail();
    expect(nativeLibraryReadResponseSchema.safeParse({ ...value, item: { ...value.item, title: "Altered" } }).success).toBe(false);
    expect(nativeLibraryReadResponseSchema.safeParse({ ...value, serviceReceipt: receipt("app.library.list", { item: value.item }, 1) }).success).toBe(false);
    expect(nativeLibraryReadResponseSchema.safeParse({ ...value, serviceReceipt: { ...value.serviceReceipt, receiptSha256: "b".repeat(64) } }).success).toBe(false);
    expect(nativeLibraryReadResponseSchema.safeParse({ ...value, token: "private" }).success).toBe(false);
  });

  it("binds identity to the source and requires a connected source's current revision", () => {
    expect(nativeLibraryItemSchema.safeParse({ ...item(), sourceId: "other" }).success).toBe(false);
    const source = item("source_item");
    expect(nativeLibraryReadResponseSchema.safeParse(detail(source)).success).toBe(true);
    expect(nativeLibraryItemSchema.safeParse({ ...source, currentVersion: { ...source.currentVersion, sourceRevisionId: null } }).success).toBe(false);
  });

  it("keeps Mission artifacts listable but outside the current exact-open route", () => {
    const source = item("mission_artifact");
    expect(nativeLibraryListResponseSchema.safeParse(listing({ items: [source] })).success).toBe(true);
    expect(nativeLibraryReadResponseSchema.safeParse(detail(source)).success).toBe(false);
    expect(nativeLibraryExactIdSchema.safeParse(source.id).success).toBe(false);
  });

  it("fences tenant, private owner and the requested full key even with a valid receipt", () => {
    const parser = nativeLibraryReadResponseForScopeSchema({ ...scope, libraryItemId: item().id });
    expect(parser.safeParse(detail({ ...item(), tenantId: "foreign" })).success).toBe(false);
    expect(parser.safeParse(detail({ ...item(), scope: { ...item().scope, ownerActorId: "foreign" } })).success).toBe(false);
    expect(parser.safeParse(detail({ ...item(), id: "library:capture_asset:other", sourceId: "other" })).success).toBe(false);
  });

  it("enforces citation, link, version and page caps without truncating identities", () => {
    const base = item();
    for (const value of [{ ...base, citationRefs: Array.from({ length: 65 }, (_, index) => `source:${index}`) },
      { ...base, citationRefs: ["same", "same"] }, { ...base, links: Array(17).fill(base.links[0]) },
      { ...base, versionCount: 0 }, { ...base, currentVersion: { ...base.currentVersion, versionNumber: 2 } },
      { ...base, sourceId: "x".repeat(321) }]) expect(nativeLibraryItemSchema.safeParse(value).success).toBe(false);
    expect(nativeLibraryListResponseSchema.safeParse(listing({ items: Array(101).fill(base) })).success).toBe(false);
  });

  it("rejects duplicate page IDs, wrong requested windows and contradictory lower-bound metadata", () => {
    expect(nativeLibraryListResponseSchema.safeParse(listing({ items: [item(), item()] })).success).toBe(false);
    expect(nativeLibraryListResponseForScopeSchema({ ...scope, limit: 1, offset: 4 }).safeParse(listing({ offset: 5 })).success).toBe(false);
    const value = listing({ more: true });
    const { serviceReceipt: _receipt, generatedAt: _at, ...data } = value;
    const wrong = { ...data, totalIsLowerBound: false };
    expect(nativeLibraryListResponseSchema.safeParse({ ...wrong, serviceReceipt: receipt("app.library.list", wrong, 1), generatedAt: now }).success).toBe(false);
    const missingContinuation = { ...data, nextOffset: null };
    expect(nativeLibraryListResponseSchema.safeParse({ ...missingContinuation, serviceReceipt: receipt("app.library.list", missingContinuation, 1), generatedAt: now }).success).toBe(false);
  });

  it("rejects external or ambiguous link metadata", () => {
    for (const openHref of ["//example.test/private", "/\\example.test", "/app\u0000"]) {
      expect(nativeLibraryItemSchema.safeParse({ ...item(), openHref }).success).toBe(false);
    }
  });

  it("retains flat private error shapes", () => {
    expect(nativeLibraryErrorResponseSchema.safeParse({ error: "Unavailable" }).success).toBe(true);
    expect(nativeLibraryErrorResponseSchema.safeParse({ error: "Forbidden", message: "No read access." }).success).toBe(true);
    expect(nativeLibraryErrorResponseSchema.safeParse({ error: { code: "wrong" } }).success).toBe(false);
  });

  it("emits strict structural JSON Schema while retaining runtime checks separately", () => {
    for (const schema of Object.values(nativeLibraryContractSchemas)) {
      const document = z.toJSONSchema(schema, { target: "draft-2020-12" });
      expect(JSON.stringify(document)).not.toContain("unrepresentable");
      if (document.type === "object") expect(document.additionalProperties).toBe(false);
    }
  });
});
