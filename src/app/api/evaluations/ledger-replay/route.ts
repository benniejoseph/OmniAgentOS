import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  buildLedgerReplayCorpus,
  LEDGER_REPLAY_EVENT_PAGE,
  LEDGER_REPLAY_RUN_WINDOW,
} from "@/lib/evals2/ledger-replay";
import { parseBoundedInteger } from "@/lib/http/body";
import { recordRuntimeEventSafely } from "@/lib/observability/store";
import { listAgentRunEventsAfter, listAgentRuns } from "@/lib/runs/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

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
  const corpus = await buildLedgerReplayCorpus({
    tenantId,
    runs: await listAgentRuns(LEDGER_REPLAY_RUN_WINDOW, { tenantId }),
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
