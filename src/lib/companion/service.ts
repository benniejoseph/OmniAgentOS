import { commandConversationHref } from "@/lib/approvals/inbox-link";
import {
  COMPANION_PREFERENCES_CONTRACT, companionChangeSchema,
  type CompanionHome, type CompanionPreferencesResponse,
} from "@/lib/companion/contracts";
import {
  CompanionPreferencesError, companionSnapshot,
  type CompanionOwner, type CompanionThreadCheck, type StoredCompanion,
} from "@/lib/companion/state";
import type { CompanionStore } from "@/lib/companion/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";
import type { ThreadRecord } from "@/lib/threads/types";

export type CompanionDependencies = CompanionStore & {
  getThread: (id: string, owner: CompanionOwner) => Promise<Pick<ThreadRecord, "id" | "tenantId" | "actorId"> | null>;
};
const defaults: CompanionDependencies = {
  read: async (owner) => (await import("@/lib/companion/store")).readCompanionPreferences(owner),
  change: async (...args) => (await import("@/lib/companion/store")).changeCompanionPreferences(...args),
  getThread: async (id, owner) => (await import("@/lib/threads/store")).getOwnedThread(id, owner),
};

export async function getCompanionPreferences(context: SecurityContext, dependencies: CompanionDependencies = defaults): Promise<CompanionPreferencesResponse> {
  assertPermission(context, "read");
  const owner = ownerFromContext(context);
  const current = await dependencies.read(owner);
  const id = current?.preferences.preferredThreadId ?? null;
  const checked = id === null ? undefined : await checkThread(id, owner, dependencies);
  return responseFor(current, checked);
}

export async function saveCompanionPreferences(
  context: SecurityContext,
  input: unknown,
  idempotencyKey: string,
  dependencies: CompanionDependencies = defaults,
): Promise<CompanionPreferencesResponse> {
  assertPermission(context, "manage.own_preferences");
  const parsed = companionChangeSchema.safeParse(input);
  if (!parsed.success) throw new CompanionPreferencesError("Companion preference values are invalid.", 400, "companion_preferences_invalid");
  const owner = ownerFromContext(context);
  const target = parsed.data.action === "save" ? parsed.data.preferences.preferredThreadId : null;
  // Check before the storage transaction: getOwnedThread may use the same one-connection pool.
  // The atomic writer only requires this for a changed target and resolves replay first.
  const checked = target === null ? undefined : await checkThread(target, owner, dependencies);
  const result = await dependencies.change(owner, parsed.data, idempotencyKey, checked);
  // Settle the confirmed receipt without another read. An older replay can reveal a
  // newer current preference, whose different home target must be checked on GET.
  const currentTarget = result.current.preferences.preferredThreadId;
  const currentCheck = currentTarget === null ? undefined : checked?.id === currentTarget
    ? checked : { id: currentTarget, state: "unconfirmed" as const };
  const response = responseFor(result.current, currentCheck);
  return {
    ...response,
    mutation: {
      outcome: result.replayed ? "replayed" : "saved", receiptId: result.receipt.id,
      revision: result.receipt.revision, savedAt: result.receipt.savedAt, preferences: result.receipt.preferences,
    },
  };
}

function responseFor(current: StoredCompanion | undefined, checked: CompanionThreadCheck | undefined): CompanionPreferencesResponse {
  const snapshot = companionSnapshot(current);
  const id = snapshot.preferences.preferredThreadId;
  const home: CompanionHome = {
    state: checked?.state ?? "not_set", preferredThreadId: id,
    href: checked?.state === "available" && id !== null ? commandConversationHref({ threadId: id }) : null,
    fallbackHref: "/app/command",
  };
  const destination = snapshot.preferences.defaultDestination;
  const hrefs = { today: "/app", activity: "/app/activity", work: "/app/projects" } as const;
  return {
    schemaVersion: 1, contract: COMPANION_PREFERENCES_CONTRACT, snapshot, home,
    destination: destination === "assistant"
      ? { href: home.href ?? home.fallbackHref, state: id !== null && home.href === null ? "fallback" : "configured" }
      : { href: hrefs[destination], state: "configured" },
  };
}

async function checkThread(id: string, owner: CompanionOwner, dependencies: CompanionDependencies): Promise<CompanionThreadCheck> {
  try {
    const thread = await dependencies.getThread(id, owner);
    return { id, state: thread && thread.id === id && thread.tenantId === owner.tenantId && thread.actorId === owner.actorId ? "available" : "unavailable" };
  } catch { return { id, state: "unconfirmed" }; }
}
function ownerFromContext(context: SecurityContext): CompanionOwner {
  return { tenantId: context.tenantId, actorId: context.actorId, requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context) };
}
function assertPermission(context: SecurityContext, action: "read" | "manage.own_preferences") {
  if (!canPerform(context.role, action)) throw new CompanionPreferencesError("Companion preferences are unavailable for this account.", 403, "companion_preferences_forbidden");
}
