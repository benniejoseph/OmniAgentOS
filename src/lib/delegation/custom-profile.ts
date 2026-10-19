import { getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { getCustomAgent } from "@/lib/skills/store";
import { canonicalActorIdFromExactRequestBinding, type CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

export async function resolveDelegationOwnerAuthority(tenantId: string, canonicalActorId: string) {
  if (!/^actor:[0-9a-f-]{36}$/.test(canonicalActorId)) return undefined;
  return runWithDatabaseActorScope(tenantId, [canonicalActorId], async () => {
    const owners = await getSql()`SELECT owner.email, membership.role FROM omni_auth_users owner
      JOIN omni_auth_memberships membership ON membership.user_id = owner.id
      WHERE owner.id = ${canonicalActorId.slice(6)} AND membership.tenant_id = ${tenantId}
        AND owner.status = 'active' AND membership.status = 'active'`;
    const email = owners[0]?.email, role = owners[0]?.role;
    if (typeof email !== "string" || !["viewer", "operator", "admin"].includes(String(role))) return undefined;
    const binding: CanonicalRequestActorBindingV1 = { version: 1, kind: "auth_user", authUserId: canonicalActorId.slice(6),
      canonicalActorId, legacyOwnerActorIds: [email], readableOwnerActorIds: [canonicalActorId, email] };
    if (!canonicalActorIdFromExactRequestBinding(email, binding)) return undefined;
    return { binding, role: role === "viewer" ? "viewer" as const : "operator" as const };
  });
}

/** Resolve only the current authenticated owner's exact stored profile. Profile
 * rows can still use the login email; identity pins use its canonical actor. */
export async function getDelegationCustomProfile(tenantId: string, canonicalActorId: string, agentId: string) {
    const authority = await resolveDelegationOwnerAuthority(tenantId, canonicalActorId);
    if (!authority) return undefined;
    const email = authority.binding.legacyOwnerActorIds[0];
    return runWithDatabaseActorScope(tenantId, [canonicalActorId, email], async () => {
      const canonical = await getCustomAgent(agentId, { tenantId, actorId: canonicalActorId });
      const legacy = await getCustomAgent(agentId, { tenantId, actorId: email });
      if (canonical && legacy) throw new Error("The custom Agent owner is ambiguous.");
      return canonical || legacy;
    });
}
