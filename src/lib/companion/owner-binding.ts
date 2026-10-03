import { createHash, timingSafeEqual } from "node:crypto";
import type { SecurityContext } from "@/lib/security/types";
import { CompanionPreferencesError } from "./state";

/** A caller's expected owner narrows the authenticated identity; it never
 * selects an owner or grants authority. Keep this byte contract in native too. */
export function companionOwnerSha256(tenantId: string, actorId: string) {
  return createHash("sha256").update(`asael.companion-owner:1\0${tenantId}\0${actorId}`).digest("hex");
}

export function assertCompanionOwnerBinding(request: Request, context: Pick<SecurityContext, "tenantId" | "actorId" | "source">) {
  const supplied = request.headers.get("x-asael-companion-owner-sha256");
  if (supplied === null && context.source !== "mobile") return;
  const expected = companionOwnerSha256(context.tenantId, context.actorId);
  if (!supplied || !/^[a-f0-9]{64}$/.test(supplied) ||
    !timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))) {
    throw new CompanionPreferencesError("The Companion preference owner changed. Reopen settings for the current account.", 409, "companion_owner_conflict");
  }
}
