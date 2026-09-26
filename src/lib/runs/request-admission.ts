import { createHash } from "node:crypto";
import {
  appendScopedDomainEvent,
  listStreamEvents,
  type DomainEvent,
} from "@/lib/events/store";
import type { AgentEvent } from "@/lib/orchestration/types";
import { agentRunOutcomeEvent } from "@/lib/runs/public";
import { getAgentRun } from "@/lib/runs/store";
import type { AgentRunRecord } from "@/lib/runs/types";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

/**
 * Replay protection for direct agent requests.
 *
 * A client-supplied requestId (the body `requestId` or `Idempotency-Key`)
 * names one instruction. The first request binds that id to a fingerprint of
 * its validated body, and every server identity the request mints (root run,
 * new thread, user turn) is derived from it. A retry after a dropped
 * connection therefore finds the same run and gets its recorded outcome back
 * instead of executing the work a second time, and reusing the id for a
 * different instruction is refused rather than silently merged.
 */

export const AGENT_REQUEST_BINDING_EVENT_TYPE = "agent_request.scope_bound";

const BINDING_SCHEMA_VERSION = 1;
const FINGERPRINT_SCHEMA_VERSION = 1;

const REPLAYED_COMPLETION_DETAIL =
  "This request already ran, so its recorded outcome was returned instead of running it again.";
const REPLAYED_CANCELLATION =
  "This request stopped before it finished, so it was not run again. Send it again to start over.";
const REPLAYED_WORKFLOW_REASON =
  "Replayed the workflow this request already started.";

export type AgentRequestAdmission =
  | Readonly<{ state: "new" }>
  | Readonly<{ state: "reused" }>
  | Readonly<{
    state: "in_progress";
    runId: string;
    status: string;
    threadId?: string;
  }>
  | Readonly<{ state: "replay"; events: readonly AgentEvent[] }>;

/**
 * An RFC 9562 version-8 UUID over a domain-separated SHA-256, so derived ids
 * stay valid wherever the schema expects a UUID and never collide with the
 * random version-4 ids minted elsewhere.
 */
export function requestScopedUuid(parts: readonly string[]) {
  const bytes = createHash("sha256")
    .update(parts.join("\u0000"), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function agentRequestRunId(
  tenantId: string,
  actorId: string,
  requestId: string,
) {
  return requestScopedUuid([
    "asael.agent-request.run.v1",
    tenantId,
    actorId,
    requestId,
  ]);
}

export function agentRequestThreadId(
  tenantId: string,
  actorId: string,
  requestId: string,
) {
  return requestScopedUuid([
    "asael.agent-request.thread.v1",
    tenantId,
    actorId,
    requestId,
  ]);
}

export function agentRequestUserTurnId(
  tenantId: string,
  actorId: string,
  threadId: string,
  requestId: string,
) {
  return requestScopedUuid([
    "asael.agent-request.user-turn.v1",
    tenantId,
    actorId,
    threadId,
    requestId,
  ]);
}

/** The assistant turn that acknowledges a request's durable workflow. */
export function agentRequestDelegatedTurnId(
  tenantId: string,
  actorId: string,
  threadId: string,
  requestId: string,
) {
  return requestScopedUuid([
    "asael.agent-request.delegated-turn.v1",
    tenantId,
    actorId,
    threadId,
    requestId,
  ]);
}

/**
 * Hashes the validated request body without its requestId. A retry that
 * names the thread this request created (the client learns it from the first
 * `run` event) is the same instruction as the original that named none.
 */
export function agentRequestFingerprint(
  tenantId: string,
  actorId: string,
  requestId: string,
  request: Readonly<Record<string, unknown>> & {
    requestId?: string;
    threadId?: string;
  },
) {
  const { requestId: _requestId, threadId, ...rest } = request;
  void _requestId;
  return canonicalJsonSha256({
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
    request: {
      ...rest,
      threadId: threadId === agentRequestThreadId(tenantId, actorId, requestId)
        ? undefined
        : threadId,
    },
  });
}

export function durableWorkflowAcknowledgement(requiresApproval: boolean) {
  return requiresApproval
    ? "I moved this into a durable workflow. It will preserve progress and pause before consequential external actions."
    : "I moved this into a durable workflow so it can continue in the background and preserve progress.";
}

/**
 * Admits one client-identified request. The binding is written before any
 * work starts; a request that finds its binding again returns the recorded
 * outcome of the run or workflow it started, reports a still-running run, or
 * (when neither exists yet) runs again under the same derived identities.
 * Read or write failures propagate so the caller fails closed.
 */
export async function admitAgentRequest(input: {
  context: SecurityContext;
  requestId: string;
  requestFingerprintSha256: string;
}): Promise<AgentRequestAdmission> {
  const { context, requestId, requestFingerprintSha256 } = input;
  const runId = agentRequestRunId(context.tenantId, context.actorId, requestId);
  let binding = await readBinding(context, requestId);
  if (!binding) {
    try {
      await appendScopedDomainEvent({
        id: bindingEventId(context, requestId),
        streamId: bindingStreamId(requestId),
        type: AGENT_REQUEST_BINDING_EVENT_TYPE,
        executionScope: executionScopeFromSecurityContext(context, {
          correlationId: requestId,
          purpose: "agent.request.admission",
        }),
        payload: {
          schemaVersion: BINDING_SCHEMA_VERSION,
          requestFingerprintSha256,
          runId,
        },
      });
      return { state: "new" };
    } catch (error) {
      // A concurrent first attempt may have bound the id between the read and
      // the write; its binding decides. Anything else is an outage.
      binding = await readBinding(context, requestId);
      if (!binding) throw error;
    }
  }
  if (binding.payload.requestFingerprintSha256 !== requestFingerprintSha256) {
    return { state: "reused" };
  }

  const run = await getAgentRun(runId, { tenantId: context.tenantId });
  if (run) {
    if (run.ownerActorId !== context.actorId) return { state: "reused" };
    return replayRun(run);
  }

  const workflowReplay = await replayWorkflow(context, requestId);
  return workflowReplay || { state: "new" };
}

function replayRun(run: AgentRunRecord): AgentRequestAdmission {
  const started: AgentEvent = {
    type: "run",
    runId: run.id,
    ...(run.threadId ? { threadId: run.threadId } : {}),
  };
  const outcome = agentRunOutcomeEvent(run, {
    canceledMessage: REPLAYED_CANCELLATION,
  });
  if (!outcome) {
    return {
      state: "in_progress",
      runId: run.id,
      status: run.status,
      ...(run.threadId ? { threadId: run.threadId } : {}),
    };
  }
  return {
    state: "replay",
    events: outcome.type === "done"
      ? [
          started,
          { type: "status", label: "Replayed", detail: REPLAYED_COMPLETION_DETAIL },
          outcome,
        ]
      : [started, outcome],
  };
}

async function replayWorkflow(
  context: SecurityContext,
  requestId: string,
): Promise<AgentRequestAdmission | undefined> {
  const { deterministicWorkflowRunId, getWorkflowRunDetail } = await import(
    "@/lib/workflows/store"
  );
  const detail = await getWorkflowRunDetail(
    deterministicWorkflowRunId(
      context.tenantId,
      `supervisor:${context.actorId}:${requestId}`,
    ),
    { tenantId: context.tenantId },
  );
  const metadata = detail?.run.input.metadata;
  if (
    !detail ||
    metadata?.actorId !== context.actorId ||
    metadata?.requestId !== requestId ||
    typeof metadata?.threadId !== "string"
  ) {
    return undefined;
  }
  return {
    state: "replay",
    events: [
      {
        type: "delegated",
        threadId: metadata.threadId,
        workflowId: detail.run.id,
        ...(typeof metadata.missionId === "string"
          ? { missionId: metadata.missionId }
          : {}),
        acknowledgement: durableWorkflowAcknowledgement(
          detail.run.approvalRequired,
        ),
        reason: REPLAYED_WORKFLOW_REASON,
      },
    ],
  };
}

async function readBinding(
  context: SecurityContext,
  requestId: string,
): Promise<DomainEvent | undefined> {
  const id = bindingEventId(context, requestId);
  const events = await listStreamEvents(bindingStreamId(requestId), {
    tenantId: context.tenantId,
    actorId: context.actorId,
    limit: 20,
  });
  return events.find(
    (event) =>
      event.id === id && event.type === AGENT_REQUEST_BINDING_EVENT_TYPE,
  );
}

function bindingStreamId(requestId: string) {
  return `agent-request:${requestId}`;
}

function bindingEventId(context: SecurityContext, requestId: string) {
  return `agent-request-bound:${createHash("sha256")
    .update(`${context.tenantId}\u0000${context.actorId}\u0000${requestId}`)
    .digest("hex")}`;
}
