import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  getOwnedThread,
  listConversationSummaries,
  listThreadTurns,
  rebuildConversationSummaryHierarchy,
} from "@/lib/threads/store";
import type { ConversationSummaryRecord } from "@/lib/threads/summaries";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const rebuildSchema = z.object({
  action: z.literal("rebuild_summaries"),
}).strict();

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "thread", resourceId: id }); }
  catch (error) { return forbiddenResponse(error); }
  const thread = await getOwnedThread(id, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
  });
  if (!thread) {
    return Response.json(
      { error: "Thread not found." },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  }
  return Response.json({
    thread,
    turns: await listThreadTurns(thread.id, {
      tenantId: context.tenantId,
      limit: 40,
    }),
    summaries: (
      await listConversationSummaries(thread.id, {
        tenantId: context.tenantId,
        levels: ["episode"],
        limit: 100,
      })
    ).map(publicConversationSummary),
  }, { headers: { "cache-control": "private, no-store" } });
}

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = rebuildSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid thread summary action", details: parsed.error.flatten() },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "conversation_summary",
      resourceId: id,
      metadata: { action: parsed.data.action },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const thread = await getOwnedThread(id, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
  });
  if (!thread) {
    return Response.json(
      { error: "Thread not found." },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  }
  const summaries = await rebuildConversationSummaryHierarchy(thread.id, {
    tenantId: context.tenantId,
    actorId: thread.actorId,
  });
  return Response.json({
    summaries: summaries.map(publicConversationSummary),
    summaryCount: summaries.length,
  }, { headers: { "cache-control": "private, no-store" } });
}

function publicConversationSummary(summary: ConversationSummaryRecord) {
  const { actorId: _actorId, accessScope, ...publicSummary } = summary;
  void _actorId;
  return {
    ...publicSummary,
    accessScope: {
      schemaVersion: accessScope.schemaVersion,
      visibility: accessScope.visibility,
      threadId: accessScope.threadId,
      projectId: accessScope.projectId,
      purposeIds: accessScope.purposeIds,
      scopeSha256: accessScope.scopeSha256,
    },
  };
}
