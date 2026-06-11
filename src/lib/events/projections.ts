import type { DomainEvent } from "@/lib/events/store";
import { applyOutcome } from "@/lib/trust/ledger";
import { computeAutonomy } from "@/lib/trust/policy";
import type { TrustProfile } from "@/lib/trust/types";

/**
 * Proof that state is a projection of the event log: rebuild a trust profile
 * by folding its `trust.outcome.*` events. Used by the replay smoke and as
 * the template for migrating other stores onto the log (EVENT_LOG.md stage 2).
 */
export function foldTrustProfile(
  events: DomainEvent[],
  seed: { actionClass: string; tenantId: string },
): TrustProfile | undefined {
  const outcomes = events
    .filter((event) => event.type.startsWith("trust.outcome."))
    .sort((left, right) => left.seq - right.seq);

  if (!outcomes.length) {
    return undefined;
  }

  let profile: TrustProfile = {
    actionClass: seed.actionClass,
    toolId: String(outcomes[0].payload.toolId || seed.actionClass),
    tenantId: seed.tenantId,
    riskLevel: Number(outcomes[0].payload.riskLevel || 0),
    reversible: Boolean(outcomes[0].payload.reversible),
    total: 0,
    successes: 0,
    failures: 0,
    rejections: 0,
    humanApprovals: 0,
    cleanStreak: 0,
    autonomyMode: "approve_each",
    updatedAt: outcomes[0].at,
  };

  for (const event of outcomes) {
    const kind = event.type.replace("trust.outcome.", "");
    if (kind !== "success" && kind !== "failure" && kind !== "rejected") {
      continue;
    }
    profile = applyOutcome(profile, {
      actionClass: seed.actionClass,
      toolId: String(event.payload.toolId || profile.toolId),
      tenantId: seed.tenantId,
      kind,
      reversible: Boolean(event.payload.reversible),
      riskLevel: Number(event.payload.riskLevel || 0),
      humanApproved: Boolean(event.payload.humanApproved),
      at: event.at,
    });
  }

  return { ...profile, autonomyMode: computeAutonomy(profile).mode };
}
