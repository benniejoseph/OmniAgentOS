import { parseVoiceApprovalEvidence, type VoiceCommandReply } from "@/lib/voice/command-review";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit = 24_000) => typeof value === "string" ? value.slice(0, limit) : "";

/** Follow an already-admitted identity. This reader never starts or retries work. */
export async function readVoiceWork(reply: VoiceCommandReply, conversationId: string, signal: AbortSignal): Promise<VoiceCommandReply> {
  const id = reply.workflowId || reply.runId;
  if (!id || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) throw new Error("Missing task identity.");
  const response = await fetch(`/api/${reply.workflowId ? "workflows" : "runs"}/${encodeURIComponent(id)}`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error("Task updates are unavailable.");
  const payload = record(await response.json());
  const run = record(payload.run);
  if (run.id !== id) throw new Error("Task identity changed.");
  const metadata = record(record(run.input).metadata);
  const thread = text(run.threadId || metadata.threadId, 200);
  if (thread && thread !== conversationId) throw new Error("Task conversation changed.");
  const state = text(run.status, 40);
  const delegated = record(run.delegatedWork);
  const delegatedId = text(delegated.workflowId, 200);
  if (!reply.workflowId && state === "completed" && delegated.status === "accepted" &&
      /^[A-Za-z0-9_.:-]{1,200}$/.test(delegatedId) && delegated.threadId === conversationId) {
    return { ...reply, workflowId: delegatedId, status: "accepted", approval: undefined,
      text: "The approved action started your background task. I’m following it until it finishes." };
  }
  const status: VoiceCommandReply["status"] = state === "completed" ? "completed" : state === "failed" ? "failed" : state === "canceled" ? "canceled"
    : state === "waiting_approval" ? "waiting_approval" : state === "waiting_clarification" || state === "paused" ? "waiting_clarification"
      : ["queued", "running", "resuming"].includes(state) ? "running" : "unconfirmed";
  const result = record(run.result);
  const report = record(result.researchReportV1);
  const finalText = text(reply.workflowId ? report.content || result.response || result.summary : run.response);
  const approvalId = text(record(run.waitingApproval).executionId, 200);
  let approval;
  if (status === "waiting_approval" && approvalId) {
    const approvalResponse = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}`, { signal, cache: "no-store" });
    if (approvalResponse.ok) approval = parseVoiceApprovalEvidence(record(await approvalResponse.json()).approval);
    if (approval && approval.id !== approvalId) throw new Error("Approval identity changed.");
  }
  return { ...reply, status, approval, text: status === "completed" ? finalText || "The task completed. Its saved result is available in History."
    : status === "failed" || status === "canceled" ? text(run.error, 2000) || `The task ${status}.`
      : status === "waiting_approval" ? "An action needs your review before this task can continue."
        : status === "waiting_clarification" ? finalText || "This task needs your input."
          : "Your task is still running. I’ll let you know when it finishes." };
}

export const voiceWorkSettled = (reply: VoiceCommandReply) => ["completed", "failed", "canceled", "waiting_clarification"].includes(reply.status || "completed");
