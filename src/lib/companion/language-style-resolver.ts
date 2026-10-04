import "server-only";

import {
  COMPANION_LANGUAGE_STYLE_VERSION,
  UNAVAILABLE_COMPANION_LANGUAGE_STYLE,
  type CompanionLanguageStyle,
} from "@/lib/companion/language-style";
import { companionOwnerCoordinates, storedCompanionSchema } from "@/lib/companion/state";
import type { CompanionStore } from "@/lib/companion/store";
import type { AgentRunRequest } from "@/lib/orchestration/types";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";

type DirectRequest = Pick<AgentRunRequest,
  "runId" | "preclaimedRunId" | "tenantId" | "actorId" | "role" |
  "securityContext" | "executionScope" | "moltbookAutonomy"
>;
type Dependencies = Pick<CompanionStore, "read">;
const defaults: Dependencies = {
  read: async (owner) => (await import("@/lib/companion/store")).readCompanionPreferences(owner),
};
const PREFERENCE_READ_TIMEOUT_MS = 3_000;

/**
 * Server-internal only. A new live direct conversation may use its initiating
 * person's preference. Legacy, delegated, preclaimed, durable, background and
 * loop-v2 work need their own trusted admission pin and are deliberately absent.
 * A foreground prompt-queue dispatch retains that live authenticated owner and
 * starts a new direct run, so it resolves here at dispatch, not when drafted.
 * Never derive this owner from the selected Agent, request text or a client pin.
 */
export async function resolveDirectConversationLanguageStyle(
  request: DirectRequest,
  dependencies: Dependencies = defaults,
): Promise<CompanionLanguageStyle | undefined> {
  const context = request.securityContext;
  const scope = request.executionScope;
  if (
    !context || (context.source !== "session" && context.source !== "mobile") ||
    !request.runId || request.preclaimedRunId || request.moltbookAutonomy ||
    request.tenantId !== context.tenantId || request.actorId !== context.actorId ||
    request.role !== context.role || !canPerform(context.role, "read") ||
    !scope || scope.tenantId !== context.tenantId ||
    scope.initiatingActorId !== context.actorId || scope.delegationId !== null ||
    scope.executingPrincipalType !== "agent" || !scope.executingPrincipalId ||
    scope.correlationId !== request.runId || scope.purpose !== "agent.run"
  ) return undefined;

  const requestActorBinding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!requestActorBinding) return undefined;
  const owner = { tenantId: context.tenantId, actorId: context.actorId, requestActorBinding };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const coordinates = companionOwnerCoordinates(owner);
    // Timeout is uncertainty, not evidence that no preference has been saved.
    const result = await Promise.race([
      dependencies.read(owner).then((current) => ({ current })),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PREFERENCE_READ_TIMEOUT_MS);
      }),
    ]);
    if (result === null) return UNAVAILABLE_COMPANION_LANGUAGE_STYLE;
    if (result.current === undefined) return Object.freeze({
      version: COMPANION_LANGUAGE_STYLE_VERSION,
      source: "default",
      intensity: "balanced",
      preferenceRevision: 0,
    });
    const parsed = storedCompanionSchema.safeParse(result.current);
    if (!parsed.success || parsed.data.tenantId !== coordinates.tenantId ||
      !coordinates.readableActorIds.includes(parsed.data.actorId)) {
      return UNAVAILABLE_COMPANION_LANGUAGE_STYLE;
    }
    return Object.freeze({
      version: COMPANION_LANGUAGE_STYLE_VERSION,
      source: "saved",
      intensity: parsed.data.preferences.intensity,
      preferenceRevision: parsed.data.revision,
    });
  } catch {
    // Presentation uncertainty must neither fail the task nor expose store errors.
    return UNAVAILABLE_COMPANION_LANGUAGE_STYLE;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
