import type { DomainEvent } from "@/lib/events/store";
import type { RunStatus } from "@/lib/runs/types";
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

export type RunToolCallProjection = {
  toolId: string;
  toolName: string;
  status: string;
  riskLevel?: number;
  dryRun?: boolean;
  summary?: string;
  executionId?: string;
};

export type RunProjection = {
  status: RunStatus;
  response?: string;
  error?: string;
  memoryContextCount: number;
  toolCalls: RunToolCallProjection[];
  waitingApproval?: { executionId: string; toolId: string; message: string };
};

/**
 * Stage-2 (EVENT_LOG.md): rebuild a run's lifecycle status, response/error,
 * and tool-call history by folding its `run.*` event stream — the same
 * proof shape as foldTrustProfile, exposed via `GET /api/runs/:id?replay=true`.
 */
export function foldRunProjection(events: DomainEvent[]): RunProjection {
  const ordered = [...events]
    .filter((event) => event.streamId.startsWith("run:") && event.type.startsWith("run."))
    .sort((left, right) => left.seq - right.seq);

  const projection: RunProjection = {
    status: "running",
    memoryContextCount: 0,
    toolCalls: [],
  };

  for (const event of ordered) {
    const kind = event.type.replace("run.", "");
    const payload = event.payload;

    switch (kind) {
      case "memory":
        projection.memoryContextCount = Number(payload.count ?? projection.memoryContextCount);
        break;
      case "tool":
        projection.toolCalls.push({
          toolId: String(payload.toolId || ""),
          toolName: String(payload.toolName || payload.toolId || ""),
          status: String(payload.status || ""),
          riskLevel: typeof payload.riskLevel === "number" ? payload.riskLevel : undefined,
          dryRun: Boolean(payload.dryRun),
          summary: typeof payload.summary === "string" ? payload.summary : undefined,
          executionId: typeof payload.executionId === "string" ? payload.executionId : undefined,
        });
        break;
      case "waiting_approval":
        projection.status = "waiting_approval";
        projection.waitingApproval = {
          executionId: String(payload.executionId || ""),
          toolId: String(payload.toolId || ""),
          message: String(payload.message || ""),
        };
        break;
      case "done":
        projection.status = "completed";
        projection.response = String(payload.response || "");
        projection.error = undefined;
        projection.waitingApproval = undefined;
        break;
      case "error":
        projection.status = "failed";
        projection.error = String(payload.message || "");
        projection.waitingApproval = undefined;
        break;
      default:
        break;
    }
  }

  return projection;
}
