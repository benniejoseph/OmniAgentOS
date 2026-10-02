import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  buildLedgerReplayCorpus,
  LEDGER_REPLAY_EVENT_PAGE,
  LEDGER_REPLAY_RUN_WINDOW,
} from "@/lib/evals2/ledger-replay";
import { parseBoundedInteger } from "@/lib/http/body";
import { recordRuntimeEventSafely } from "@/lib/observability/store";
import { listAgentRunEventsAfter, listAgentRuns } from "@/lib/runs/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getOwnedThread } from "@/lib/threads/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "agent_run",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const days = parseBoundedInteger(url.searchParams.get("days"), 7, { max: 30 });
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, { max: 50 });
  const tenantId = context.tenantId;
  const now = new Date();
  const requestActorBinding = canonicalRequestActorBindingFromSecurityContext(context);
  const readableActors = new Set(requestActorBinding?.readableOwnerActorIds ?? [context.actorId]);
  const candidates = await listAgentRuns(LEDGER_REPLAY_RUN_WINDOW, { tenantId });
  const runs = [];
  const readableThreads = new Map<string, boolean>();
  // File-backed run lists do not have Postgres actor RLS. Enforce ownership
  // before counting a run or reading any of its events in either store.
  for (const run of candidates) {
    if (!readableActors.has(run.ownerActorId)) continue;
    if (run.threadId) {
      if (!readableThreads.has(run.threadId)) {
        readableThreads.set(run.threadId, Boolean(await getOwnedThread(run.threadId, {
          tenantId,
          actorId: context.actorId,
          requestActorBinding,
        })));
      }
      if (!readableThreads.get(run.threadId)) continue;
    }
    runs.push(run);
  }
  const corpus = await buildLedgerReplayCorpus({
    tenantId,
    runs,
    days,
    limit,
    now,
    loadEvents: (runId) =>
      listAgentRunEventsAfter(runId, { tenantId, limit: LEDGER_REPLAY_EVENT_PAGE }),
  });
  // Counts only: the corpus holds the runs' own words.
  await recordRuntimeEventSafely({
    category: "evaluation",
    action: "evaluation.ledger_replay_exported",
    tenantId,
    actorId: context.actorId,
    resourceType: "agent_run",
    message: `Exported ${corpus.tasks.length} ledger-replay tasks.`,
    metadata: {
      days,
      limit,
      examined: corpus.examined,
      taskCount: corpus.tasks.length,
      skipped: corpus.skipped,
    },
  });
  return Response.json(corpus, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition":
        `attachment; filename="ledger-replay-${now.toISOString().slice(0, 10)}.json"`,
    },
  });
}
