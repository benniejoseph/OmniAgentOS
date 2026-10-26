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
  if (!reply.workflowId && state === "completed" && delegated.kind === "subagents" && delegated.threadId === conversationId) {
    if (delegated.status === "failed" || delegated.status === "canceled") return { ...reply,
      status: delegated.status, approval: undefined, text: "The delegated task could not finish. Its recorded results are available in History." };
    const continuationId = text(delegated.runId, 200);
    return { ...reply, ...(/^[A-Za-z0-9_.:-]{1,200}$/.test(continuationId) ? { runId: continuationId } : {}),
      status: "running", approval: undefined, text: "Atlas is finishing your task with its specialists. I’m following the result." };
  }
  if (!reply.workflowId && state === "completed" && delegated.status === "accepted" &&
      /^[A-Za-z0-9_.:-]{1,200}$/.test(delegatedId) && delegated.threadId === conversationId) {
    return { ...reply, workflowId: delegatedId, status: "accepted", approval: undefined,
      text: "The approved action started your background task. I’m following it until it finishes." };
  }
  const status: VoiceCommandReply["status"] = state === "completed" ? "completed" : state === "failed" ? "failed" : state === "canceled" ? "canceled"
    : state === "waiting_approval" ? "waiting_approval" : state === "waiting_clarification" ? "waiting_clarification"
      : state === "paused" ? "paused" : state === "queued" ? "accepted"
        : ["running", "resuming"].includes(state) ? "running" : "unconfirmed";
  const result = record(run.result);
  const report = record(result.researchReportV1);
  const finalText = text(reply.workflowId ? report.content || result.response || result.summary : run.response);
  const currentStep = text(run.currentStep, 80) || undefined;
  const failedStep = Array.isArray(payload.steps) ? payload.steps.map(record).find(step =>
    step.stepKey === currentStep && step.status === "failed" && (!reply.workflowId || step.workflowRunId === reply.workflowId)) : undefined;
  const failureReason = ["paused", "failed", "canceled"].includes(status || "")
    ? text(run.error || failedStep?.error, 2000) || undefined : undefined;
  const approvalId = text(record(run.waitingApproval).executionId, 200);
  let approval;
  if (status === "waiting_approval" && approvalId) {
    const approvalResponse = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}`, { signal, cache: "no-store" });
    if (approvalResponse.ok) approval = parseVoiceApprovalEvidence(record(await approvalResponse.json()).approval);
    if (approval && approval.id !== approvalId) throw new Error("Approval identity changed.");
  }
  return { ...reply, status, approval, currentStep, failureReason, text: status === "completed" ? finalText || "The task completed. Its saved result is available in History."
    : status === "failed" || status === "canceled" ? failureReason || `The task ${status}.`
      : status === "paused" ? `The task is paused${currentStep ? ` at ${currentStep.replaceAll("_", " ")}` : ""}.${failureReason ? ` Recorded reason: ${failureReason}` : " No reason is recorded."} A pause alone does not establish a need for clarification or approval.`
      : status === "waiting_approval" ? "An action needs your review before this task can continue."
        : status === "waiting_clarification" ? finalText || "This task needs your input."
          : status === "accepted" ? "Your task is queued for its next execution step."
            : status === "unconfirmed" ? "The task's current state is unconfirmed. No work has been repeated."
              : "Your task is still running. I’ll let you know when it finishes." };
}

/** A follow-up during work reads its existing receipt, never dispatches it again. */
export async function inspectActiveVoiceWork(reply: VoiceCommandReply | undefined, conversationId: string, signal: AbortSignal): Promise<VoiceCommandReply> {
  if (!reply?.runId && !reply?.workflowId) return { text: "The current task cannot be inspected yet. Its saved task identity is unavailable. No new request was submitted.", status: "unconfirmed" };
  try { return await readVoiceWork(reply, conversationId, signal); }
  catch { return { ...reply, status: "unconfirmed", approval: undefined, currentStep: undefined, failureReason: undefined,
    text: "The current task could not be checked. Its progress and any blocker are unconfirmed. No new request was submitted." }; }
}

export const voiceWorkSettled = (reply: VoiceCommandReply) => ["completed", "failed", "canceled", "paused", "waiting_clarification"].includes(reply.status || "completed");
