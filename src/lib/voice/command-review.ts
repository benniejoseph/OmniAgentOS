export type VoiceConfidenceBand = "high" | "low" | "unavailable" | "edited";

export type VoiceCommandReview = Readonly<{
  schemaVersion: 1;
  source: "realtime_voice";
  sessionId: string;
  conversationId: string;
  provider: "openai";
  confidenceBand: VoiceConfidenceBand;
  confidenceMean?: number;
  confidenceMinimum?: number;
  confidenceSampleCount: number;
  reviewMethod: "send_button" | "explicit_checkbox";
  reviewAttested: true;
}>;

export type VoiceApprovalEvidence = Readonly<{
  id: string;
  status: string;
  toolId: string;
  title: string;
  description: string;
  riskLevel: number;
  reversible: boolean;
  reason: string;
  input: Readonly<Record<string, unknown>>;
  requestedBy?: string;
  approvalProgress: Readonly<{
    approvals: number;
    required: number;
  }>;
  canApprove: boolean;
  blockReason?: string;
  canReject: boolean;
}>;

export type VoiceCommandReply = Readonly<{
  text: string;
  runId?: string;
  agentId?: string;
  approval?: VoiceApprovalEvidence;
}>;

export function parseVoiceApprovalEvidence(value: unknown): VoiceApprovalEvidence {
  const approval = recordValue(value);
  const progress = recordValue(approval.approvalProgress);
  const riskLevel = finiteNumber(approval.riskLevel, -1);
  const approvals = finiteNumber(progress.approvals, -1);
  const required = finiteNumber(progress.required, -1);
  if (
    !textValue(approval.id) ||
    !textValue(approval.status) ||
    !textValue(approval.toolId) ||
    !textValue(approval.title) ||
    !textValue(approval.description) ||
    !Number.isInteger(riskLevel) ||
    riskLevel < 0 ||
    riskLevel > 3 ||
    typeof approval.reversible !== "boolean" ||
    !textValue(approval.reason) ||
    !Number.isInteger(approvals) ||
    approvals < 0 ||
    !Number.isInteger(required) ||
    required < 1 ||
    typeof approval.canApprove !== "boolean" ||
    typeof approval.canReject !== "boolean"
  ) {
    throw new Error("The approval evidence response was invalid.");
  }
  return {
    id: textValue(approval.id),
    status: textValue(approval.status),
    toolId: textValue(approval.toolId),
    title: textValue(approval.title),
    description: textValue(approval.description),
    riskLevel,
    reversible: approval.reversible,
    reason: textValue(approval.reason),
    input: recordValue(approval.input),
    requestedBy: textValue(approval.requestedBy) || undefined,
    approvalProgress: { approvals, required },
    canApprove: approval.canApprove,
    blockReason: textValue(approval.blockReason) || undefined,
    canReject: approval.canReject,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
