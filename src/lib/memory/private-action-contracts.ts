import { z } from "zod";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

export const privateActionShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const privateActionIdSchema = z.string().min(1).max(320).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
export const privateActionScopeSchema = z.object({ tenantId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ownerActorId: z.string().min(1).max(320).refine((v) => v === v.trim()),
  canonicalActorId: z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/) }).strict();
export type PrivateActionScope = z.infer<typeof privateActionScopeSchema>;
export const samePrivateActionValue = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
export function privateActionKeySha256(scope: PrivateActionScope, idempotencyKey: string) {
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/).parse(idempotencyKey);
  return idempotencyKeySha256({ tenantId: scope.tenantId, idempotencyKey });
}
export function privateActionAcceptanceId(scope: PrivateActionScope, keySha256: string) {
  return `private-action-acceptance:${canonicalJsonSha256({ scope, keySha256 })}`;
}
export class NativePrivateActionError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = "NativePrivateActionError"; }
}
