import { z } from "zod";
import { appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { clientProfileSchema, csmProfileWriteSchema, csmSourceWriteSchema, csmSourceDeleteSchema, csmSourceLinkSchema } from "@/lib/csm/contracts";
import { csmRoleWriteSchema } from "@/lib/csm/role-contracts";
import { workspaceLibraryItemSchema } from "@/lib/library/contracts";

const id = z.string().trim().min(1).max(320);
// Project presentation evolves independently; identity remains explicit here.
const project = z.object({ id, tenantId: id, title: z.string(), status: z.string() }).passthrough();
const sourceLinks = z.array(csmSourceLinkSchema.extend({ status: z.enum(["current", "processing", "changed", "unavailable"]) }).strict()).max(50);
const common = {
  revision: id.nullable(),
  sources: z.array(workspaceLibraryItemSchema).max(50),
  sourceLinks,
  acceptedRevision: id.optional(),
  serviceReceipt: appServiceReceiptSchema,
};
export const nativeCsmSchemas = Object.freeze({
  NativeCsmProfileRequest: csmProfileWriteSchema,
  NativeCsmRoleRequest: csmRoleWriteSchema,
  NativeCsmSourceRequest: csmSourceWriteSchema,
  NativeCsmSourceDeleteRequest: csmSourceDeleteSchema,
  NativeCsmClientListResponse: z.object({
    clients: z.array(z.object({ project, profile: clientProfileSchema, sourceCount: z.number().int().min(0).max(50), revision: id }).strict()).max(100),
    truncated: z.boolean(), serviceReceipt: appServiceReceiptSchema,
  }).strict(),
  NativeCsmClientResponse: z.object({
    ...common, project, profile: clientProfileSchema.nullable(),
    context: z.object({ scope: z.literal("project"), projectId: id, workspaceId: id, accessLevel: z.string(), canWrite: z.boolean(), authoritySha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  }).strict(),
  NativeCsmRoleResponse: z.object({
    ...common, schemaVersion: z.literal(1), text: z.string().max(20_000),
    context: z.object({ scope: z.literal("user"), canWrite: z.boolean() }).strict(),
    limits: z.object({ textCharacters: z.literal(20_000), sourceCount: z.literal(50) }).strict(),
  }).strict(),
});
