import { z } from "zod";

export const ENTITY_OPTIONS_CONTRACT = "asael-entity-options:1" as const;
export const entityOptionIdSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
export const entityOptionTypeSchema = z.enum(["person", "organization", "account", "project"]);
export const entityOptionsQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(40),
  after: entityOptionIdSchema.optional(),
}).strict();
export const entityOptionsQueryMetadata = Object.freeze([
  { name: "limit", type: "integer", minimum: 1, maximum: 100, defaultValue: 40 },
  { name: "after", type: "string", minLength: 1, maxLength: 240, description: "Exact last returned entity ID; authorization is rechecked for every page." },
] as const);

// Labels retain the registry's full bound. A Meeting may require a shorter
// user-reviewed display label; it must never truncate or replace the entity ID.
export const entityOptionSchema = z.object({
  entityId: entityOptionIdSchema,
  entityTypeId: entityOptionTypeSchema,
  canonicalLabel: z.string().trim().min(1).max(320),
  state: z.literal("active"),
}).strict();

export const entityOptionsResponseSchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal(ENTITY_OPTIONS_CONTRACT),
  scope: z.object({
    tenantId: entityOptionIdSchema,
    ownerActorId: z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    accessScopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    purposeId: z.literal("entity.read.v1"),
  }).strict(),
  items: z.array(entityOptionSchema).max(100),
  hasMore: z.boolean(),
  nextAfter: entityOptionIdSchema.nullable(),
  coverage: z.object({
    kind: z.literal("bounded_current"),
    limit: z.number().int().min(1).max(100),
    returned: z.number().int().min(0).max(100),
    after: entityOptionIdSchema.nullable(),
    total: z.null(),
  }).strict(),
  authorityEffect: z.literal("none"),
}).strict().superRefine((value, context) => {
  if (value.items.length !== value.coverage.returned || value.items.length > value.coverage.limit ||
      (value.hasMore && value.items.length !== value.coverage.limit)) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "Coverage must describe the exact bounded page." });
  }
  const last = value.items[value.items.length - 1]?.entityId ?? null;
  if (value.nextAfter !== (value.hasMore ? last : null) || (value.hasMore && last === null)) {
    context.addIssue({ code: "custom", path: ["nextAfter"], message: "Only another page has an exact continuation ID." });
  }
  let previous = value.coverage.after;
  for (const [index, item] of value.items.entries()) {
    // IDs are ASCII: this is the same ordering as PostgreSQL COLLATE "C".
    if (previous !== null && item.entityId <= previous) {
      context.addIssue({ code: "custom", path: ["items", index, "entityId"], message: "Options must be unique and follow the exact continuation ID." });
    }
    previous = item.entityId;
  }
});

export type EntityOptionsQuery = z.input<typeof entityOptionsQuerySchema>;
export type EntityOptionsResponse = z.infer<typeof entityOptionsResponseSchema>;

const errorText = z.string().min(1).max(2_000);
export const entityOptionsErrorResponseSchema = z.union([
  z.object({ error: errorText }).strict(),
  z.object({ error: z.enum(["Unauthorized", "Forbidden"]), message: errorText }).strict(),
]);
export const entityOptionsContractSchemas = Object.freeze({
  NativeEntityOptionsQuery: entityOptionsQuerySchema,
  NativeEntityOptionsResponse: entityOptionsResponseSchema,
  NativeEntityOptionsError: entityOptionsErrorResponseSchema,
});
