import { z } from "zod";

import { appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { workspaceLibraryItemSchema, workspaceLibraryKindSchema } from "@/lib/library/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

// Unpublished read candidates. Domain refinements and receipt hashes remain
// runtime checks; JSON Schema publication alone cannot grant source access.
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(320);
const timestamp = z.string().datetime({ offset: true });
const issue = (context: z.RefinementCtx, message: string, path: PropertyKey[] = []) =>
  context.addIssue({ code: "custom", message, path });

// Generated native paths can use a single comma-separated kind value. The
// existing web handler also accepts repeated kind fields; it currently ignores
// unknown keys and takes the first singleton value. This strict candidate does
// not claim that a future registry enrollment already enforces those policies.
export const nativeLibraryListQuerySchema = z.object({
  q: z.string().trim().max(240).default(""),
  kind: z.string().max(419).refine((value) => {
    const kinds = value.split(",").map((kind) => kind.trim()).filter(Boolean);
    return z.array(workspaceLibraryKindSchema).max(20).safeParse(kinds).success;
  }).optional(),
  project: z.string().trim().min(1).max(320).optional(),
  limit: z.number().int().min(1).max(100).default(60),
  offset: z.number().int().min(0).max(10_000).default(0),
}).strict();
export const nativeLibraryReadQuerySchema = z.object({}).strict();
export const nativeLibraryExactIdSchema = id.regex(/^library:(capture_asset|capture_recording|capture_transcript|project_artifact|source_item):.+$/);
export const nativeLibraryListQueryMetadata = Object.freeze([
  { name: "q", type: "string", maxLength: 240, defaultValue: "" },
  { name: "kind", type: "string", maxLength: 419, description: "At most 20 comma-separated Library kind values; omit for all kinds." },
  { name: "project", type: "string", minLength: 1, maxLength: 320 },
  { name: "limit", type: "integer", minimum: 1, maximum: 100, defaultValue: 60 },
  { name: "offset", type: "integer", minimum: 0, maximum: 10_000, defaultValue: 0 },
] as const);

export const nativeLibraryItemSchema = workspaceLibraryItemSchema.superRefine((item, context) => {
  if (item.id !== `library:${item.sourceAuthority}:${item.sourceId}`) issue(context, "Library identity must bind its exact source authority and ID.", ["id"]);
  if (item.sourceAuthority === "source_item" && item.currentVersion.sourceRevisionId === null) issue(context, "A current connected source requires its exact revision.", ["currentVersion", "sourceRevisionId"]);
  for (const [index, href] of [item.openHref, ...item.links.map((link) => link.href)].entries()) {
    if (href !== null && (href.startsWith("//") || href.includes("\\") || Array.from(href).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
      issue(context, "Library links must remain application-relative metadata.", index === 0 ? ["openHref"] : ["links", index - 1, "href"]);
    }
  }
});

function serviceReceipt(operation: "app.library.list" | "app.library.show") {
  const expected = getAppServiceOperationContract(operation);
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== operation || value.action !== expected.action || value.resourceType !== expected.resourceType ||
        value.eventContract !== expected.eventContract || value.accessMode !== "read" || value.idempotencyKeySha256 !== null) {
      issue(context, "The receipt belongs to a different operation.");
    }
  });
}

export const nativeLibraryListResponseSchema = z.object({
  items: z.array(nativeLibraryItemSchema).max(100),
  total: count,
  totalIsLowerBound: z.boolean(),
  nextOffset: z.number().int().min(1).max(10_100).nullable(),
  countsByKind: z.partialRecord(workspaceLibraryKindSchema, count),
  countsAreLowerBound: z.boolean(),
  serviceReceipt: serviceReceipt("app.library.list"),
  generatedAt: timestamp,
}).strict().superRefine((value, context) => {
  const receipt = value.serviceReceipt;
  const data = { items: value.items, total: value.total, totalIsLowerBound: value.totalIsLowerBound,
    nextOffset: value.nextOffset, countsByKind: value.countsByKind, countsAreLowerBound: value.countsAreLowerBound };
  if (receipt.outcomeSha256 !== canonicalJsonSha256(data) || receipt.resourceCount !== value.items.length) issue(context, "The receipt must bind the exact list and returned count.", ["serviceReceipt"]);
  if (new Set(value.items.map((item) => item.id)).size !== value.items.length) issue(context, "Library items must be unique.", ["items"]);
  if (value.total < value.items.length || (value.totalIsLowerBound && value.items.length > 0 && value.nextOffset === null) || (value.nextOffset !== null &&
      (!value.totalIsLowerBound || value.items.length === 0 || value.total !== value.nextOffset + 1))) {
    issue(context, "Library continuation and lower-bound counts disagree.", ["nextOffset"]);
  }
  const displayed = new Map<string, number>();
  for (const item of value.items) displayed.set(item.kind, (displayed.get(item.kind) ?? 0) + 1);
  for (const [kind, returned] of displayed) {
    if ((value.countsByKind[kind as z.infer<typeof workspaceLibraryKindSchema>] ?? 0) < returned) issue(context, "Kind counts cannot be below the returned page.", ["countsByKind", kind]);
  }
});
export const nativeLibraryReadResponseSchema = z.object({
  item: nativeLibraryItemSchema,
  serviceReceipt: serviceReceipt("app.library.show"),
}).strict().superRefine((value, context) => {
  if (!nativeLibraryExactIdSchema.safeParse(value.item.id).success) issue(context, "This source is outside current exact-opening coverage.", ["item", "id"]);
  if (value.serviceReceipt.resourceCount !== 1 || value.serviceReceipt.outcomeSha256 !== canonicalJsonSha256({ item: value.item })) {
    issue(context, "The receipt must bind this exact item.", ["serviceReceipt"]);
  }
});

export type NativeLibraryReadScope = Readonly<{ tenantId: string; readableOwnerActorIds: readonly string[] }>;
function checkScope(item: z.infer<typeof nativeLibraryItemSchema>, scope: NativeLibraryReadScope, context: z.RefinementCtx) {
  if (item.tenantId !== scope.tenantId || (item.scope.visibility === "user_private" && !scope.readableOwnerActorIds.includes(item.scope.ownerActorId))) {
    issue(context, "Library item belongs to a different private request scope.");
  }
}
export function nativeLibraryListResponseForScopeSchema(scope: NativeLibraryReadScope & { limit: number; offset: number }) {
  return nativeLibraryListResponseSchema.superRefine((value, context) => {
    value.items.forEach((item) => checkScope(item, scope, context));
    if (value.items.length > scope.limit || (value.nextOffset !== null && value.nextOffset !== scope.offset + value.items.length) ||
        value.total !== scope.offset + value.items.length + (value.totalIsLowerBound ? 1 : 0)) {
      issue(context, "Library page does not match its exact requested window.");
    }
  });
}
export function nativeLibraryReadResponseForScopeSchema(scope: NativeLibraryReadScope & { libraryItemId: string }) {
  return nativeLibraryReadResponseSchema.superRefine((value, context) => {
    checkScope(value.item, scope, context);
    if (value.item.id !== scope.libraryItemId) issue(context, "Library response does not match the requested source.", ["item", "id"]);
  });
}
const errorText = z.string().min(1).max(2_000);
export const nativeLibraryErrorResponseSchema = z.union([
  z.object({ error: errorText }).strict(),
  z.object({ error: z.enum(["Unauthorized", "Forbidden"]), message: errorText }).strict(),
]);
export const nativeLibraryContractSchemas = Object.freeze({
  NativeLibraryListQuery: nativeLibraryListQuerySchema,
  NativeLibraryReadQuery: nativeLibraryReadQuerySchema,
  NativeLibraryItem: nativeLibraryItemSchema,
  NativeLibraryListResponse: nativeLibraryListResponseSchema,
  NativeLibraryReadResponse: nativeLibraryReadResponseSchema,
  NativeLibraryErrorResponse: nativeLibraryErrorResponseSchema,
});
