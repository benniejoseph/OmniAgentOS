import { randomUUID } from "node:crypto";
import { z } from "zod";
import { captureBrowserFrameAfterToolSafely } from "@/lib/browser/frames";
import {
  getActiveBrowserTakeover,
  recordBrowserTakeoverAction,
  releaseBrowserTakeover,
  resolveBrowserProfileSession,
  startBrowserTakeover,
  type BrowserTakeoverRecord,
} from "@/lib/browser/profiles";
import { callMcpTool, type McpSessionScope } from "@/lib/connectors/mcp-client";
import { isAsaelPlaywrightMcpEndpoint } from "@/lib/connectors/mcp-trust";
import {
  createMcpToolId,
  getMcpConnector,
  getMcpToolById,
} from "@/lib/connectors/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  getAgentResumeJobDedupeKey,
  wakeOperationJobByDedupeKey,
} from "@/lib/operations/job-queue";
import {
  findAgentRunWaitingForToolApproval,
  getAgentRun,
} from "@/lib/runs/store";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  approveAndClaimToolExecution,
  completeClaimedToolExecution,
  getToolExecution,
} from "@/lib/tools/audit-store";
import { toolApprovalMutationFromRequest } from "@/lib/tools/approval-events";
import type { ToolExecutionRecord } from "@/lib/tools/types";

export const runtime = "nodejs";
export const maxDuration = 70;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("observe") }).strict(),
  z.object({
    action: z.literal("click"),
    target: z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    action: z.literal("type"),
    target: z.string().trim().min(1).max(500),
    text: z.string().max(8_000),
    submit: z.boolean().optional(),
  }).strict(),
  z.object({
    action: z.literal("press_key"),
    key: z.string().trim().min(1).max(80),
  }).strict(),
  z.object({ action: z.literal("handback") }).strict(),
]);
const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id: runId } = await route.params;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "browser_takeover",
      resourceId: runId,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const takeover = await getActiveBrowserTakeover({
    tenantId: context.tenantId,
    ownerActorId: context.actorId,
    runId,
  });
  return Response.json({ takeover: takeover ? publicTakeover(takeover) : null }, {
    headers: privateNoStoreHeaders,
  });
}

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id: runId } = await route.params;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "execute.tool",
      resourceType: "browser_takeover",
      resourceId: runId,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid browser takeover action.", details: parsed.error.flatten() }, {
      status: 400,
      headers: privateNoStoreHeaders,
    });
  }

  try {
    const waiting = await resolveWaitingBrowserRun(
      runId,
      context.tenantId,
      context.actorId,
    );
    const correlationId = request.headers.get("x-request-id")?.trim() || randomUUID();
    const executionScope = executionScopeFromSecurityContext(context, {
      correlationId,
      causationId: waiting.execution.id,
      purpose: `browser.takeover.${parsed.data.action}`,
    });
    const sessionScope = await takeoverSessionScope(waiting, context.tenantId, context.actorId);

    if (parsed.data.action === "start") {
      const takeover = await startBrowserTakeover({
        tenantId: context.tenantId,
        ownerActorId: context.actorId,
        runId,
        executionId: waiting.execution.id,
        profileId: sessionScope.browserProfile?.id,
        executionScope,
      });
      return Response.json({ takeover: publicTakeover(takeover) }, {
        status: 201,
        headers: privateNoStoreHeaders,
      });
    }

    const takeover = await requireActiveTakeover(
      runId,
      waiting.execution.id,
      context.tenantId,
      context.actorId,
    );
    if (parsed.data.action === "handback") {
      return handBackBrowserControl({
        request,
        context,
        waiting,
        takeover,
        sessionScope,
        executionScope,
      });
    }

    const manual = takeoverToolCall(parsed.data);
    const result = await callMcpTool({
      connector: waiting.connector,
      toolName: manual.toolName,
      args: manual.args,
      actorRole: context.role,
      idempotencyKey: `takeover:${takeover.id}:${takeover.actionCount + 1}`,
      sessionScope,
    });
    const updated = await recordBrowserTakeoverAction({
      takeover,
      action: parsed.data.action,
      target: "target" in parsed.data
        ? parsed.data.target
        : "key" in parsed.data
          ? parsed.data.key
          : undefined,
      executionScope,
    });
    return Response.json({
      takeover: publicTakeover(updated),
      observation: parsed.data.action === "type"
        ? undefined
        : boundedMcpText(result),
      message: parsed.data.action === "type"
        ? "Text was sent directly to the isolated browser and was not retained."
        : undefined,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Browser takeover failed.";
    return Response.json({ error: message }, {
      status: /not found/i.test(message) ? 404 : 409,
      headers: privateNoStoreHeaders,
    });
  }
}

async function resolveWaitingBrowserRun(
  runId: string,
  tenantId: string,
  actorId: string,
) {
  const executionCandidates = await getAgentRun(runId, { tenantId });
  if (
    !executionCandidates ||
    executionCandidates.ownerActorId !== actorId ||
    executionCandidates.status !== "waiting_approval" ||
    !executionCandidates.continuation
  ) {
    throw new Error("Browser takeover requires an actor-owned run paused for approval.");
  }
  const executionId = executionCandidates.continuation.pendingToolCall.executionId;
  const waitingRun = await findAgentRunWaitingForToolApproval(executionId, { tenantId });
  if (!waitingRun || waitingRun.id !== runId || waitingRun.ownerActorId !== actorId) {
    throw new Error("The waiting browser execution is no longer current.");
  }
  const execution = await getToolExecution(executionId, { tenantId });
  if (!execution || execution.status !== "approval_required" || execution.riskLevel >= 3) {
    throw new Error("The waiting browser action cannot enter takeover mode.");
  }
  const mcpTool = await getMcpToolById(execution.toolId, { tenantId });
  if (!mcpTool || mcpTool.status !== "active") {
    throw new Error("The waiting browser tool is not active.");
  }
  const connector = await getMcpConnector(mcpTool.connectorId, { tenantId });
  if (!connector || connector.status !== "active" || !isAsaelPlaywrightMcpEndpoint(connector.endpoint)) {
    throw new Error("The waiting action does not belong to the managed Playwright browser.");
  }
  return { run: waitingRun, execution, mcpTool, connector };
}

async function takeoverSessionScope(
  waiting: Awaited<ReturnType<typeof resolveWaitingBrowserRun>>,
  tenantId: string,
  actorId: string,
): Promise<McpSessionScope> {
  const executionId = `agent:${waiting.run.id}`;
  const profile = await resolveBrowserProfileSession({
    tenantId,
    ownerActorId: actorId,
    executionId,
  });
  return {
    tenantId,
    actorId,
    executionId,
    ...(profile ? { browserProfile: profile } : {}),
  };
}

async function requireActiveTakeover(
  runId: string,
  executionId: string,
  tenantId: string,
  actorId: string,
) {
  const takeover = await getActiveBrowserTakeover({
    tenantId,
    ownerActorId: actorId,
    runId,
  });
  if (!takeover || takeover.executionId !== executionId) {
    throw new Error("An active takeover lease was not found for this waiting action.");
  }
  return takeover;
}

function takeoverToolCall(
  action: Exclude<z.infer<typeof actionSchema>, { action: "start" | "handback" }>,
) {
  if (action.action === "observe") {
    return { toolName: "browser_snapshot", args: { boxes: true } };
  }
  if (action.action === "click") {
    return {
      toolName: "browser_click",
      args: { target: action.target, element: "User-selected browser control" },
    };
  }
  if (action.action === "type") {
    return {
      toolName: "browser_type",
      args: {
        target: action.target,
        element: "User-selected browser field",
        text: action.text,
        submit: Boolean(action.submit),
      },
    };
  }
  return { toolName: "browser_press_key", args: { key: action.key } };
}

async function handBackBrowserControl(input: {
  request: Request;
  context: Awaited<ReturnType<typeof authorizeRequest>>;
  waiting: Awaited<ReturnType<typeof resolveWaitingBrowserRun>>;
  takeover: BrowserTakeoverRecord;
  sessionScope: McpSessionScope;
  executionScope: ReturnType<typeof executionScopeFromSecurityContext>;
}) {
  const approvalMutation = toolApprovalMutationFromRequest(
    input.request,
    input.context,
    { executionId: input.waiting.execution.id, decision: "approve" },
  );
  const claimToken = randomUUID();
  const claim = await approveAndClaimToolExecution({
    id: input.waiting.execution.id,
    tenantId: input.context.tenantId,
    approvedBy: input.context.actorId,
    approvedRole: input.context.role,
    approvalReason: "The authenticated owner completed this browser step during takeover.",
    claimToken,
    mutation: approvalMutation,
  });
  if (claim.outcome !== "claimed" || !claim.record) {
    throw new Error("The waiting browser action changed before control could be returned.");
  }
  const now = new Date().toISOString();
  const completedRecord: ToolExecutionRecord = {
    ...claim.record,
    status: "executed",
    output: {
      status: "completed_by_user_takeover",
      message: "The authenticated owner completed the browser interaction and returned control.",
    },
    reason: "Completed directly by the authenticated owner during browser takeover.",
    approvalDecision: "approved",
    approvedBy: input.context.actorId,
    approvedAt: claim.record.approvedAt || now,
    approvalReason: "The authenticated owner completed this browser step during takeover.",
    completedAt: now,
  };
  const completed = await completeClaimedToolExecution(completedRecord, claimToken, {
    executionScope: approvalMutation.executionScope,
    idempotencyKey: approvalMutation.idempotencyKey,
  });
  if (!completed) {
    throw new Error("The browser handback execution claim was lost.");
  }

  const snapshotToolId = createMcpToolId(
    input.waiting.mcpTool.connectorId,
    "browser_snapshot",
  );
  await captureBrowserFrameAfterToolSafely({
    toolId: snapshotToolId,
    toolInput: { source: "user_takeover_handback" },
    toolResult: completed.output,
    executionId: completed.id,
    executionScope: input.waiting.run.continuation?.executionScope || input.executionScope,
    context: input.context,
    sessionScope: input.sessionScope,
  });
  const released = await releaseBrowserTakeover({
    takeover: input.takeover,
    executionScope: input.executionScope,
  });
  const resumeJobs = await wakeOperationJobByDedupeKey(
    getAgentResumeJobDedupeKey(completed.id),
    { tenantId: input.context.tenantId },
  );
  return Response.json({
    takeover: publicTakeover(released),
    continuation: { scheduled: true, resumeJobs: resumeJobs.length },
  }, { headers: privateNoStoreHeaders });
}

function boundedMcpText(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as { type?: unknown; text?: unknown };
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("\n").slice(0, 160_000);
}

function publicTakeover(takeover: BrowserTakeoverRecord) {
  return {
    id: takeover.id,
    runId: takeover.runId,
    state: takeover.state,
    actionCount: takeover.actionCount,
    profileActive: Boolean(takeover.profileId),
    startedAt: takeover.startedAt,
    expiresAt: takeover.expiresAt,
    lastActionAt: takeover.lastActionAt,
    releasedAt: takeover.releasedAt,
  };
}
