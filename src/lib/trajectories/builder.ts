import { createHash } from "node:crypto";
import type { DomainEvent } from "@/lib/events/store";
import {
  runContractEventPayloadV1Schema,
  type RunContractEventPayloadV1,
} from "@/lib/runs/contracts";
import type { AgentRunRecord } from "@/lib/runs/types";
import type {
  RunTrajectory,
  TrajectoryEvent,
  TrajectoryUsage,
} from "@/lib/trajectories/types";

const zeroUsage: TrajectoryUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: undefined,
  costKnown: false,
  latencyMs: 0,
  fallbackCount: 0,
};

const runContractReceiptKeys = [
  "schemaVersion",
  "payloadKind",
  "runId",
  "envelopeId",
  "envelopeSha256",
  "agentPrincipalId",
  "agentPrincipalSha256",
  "intentSpecId",
  "intentSpecSha256",
  "outcomeContractId",
  "outcomeContractSha256",
  "harnessManifestId",
  "contextManifestCount",
  "toolContractCount",
  "skillCount",
  "policyCount",
  "terminalState",
  "terminalReceiptId",
  "terminalDisposition",
  "terminalExecutionMode",
  "terminalVerificationState",
  "terminalSource",
  "terminalReasonCode",
  "legacyStatus",
  "requiredRequirementCount",
  "verifiedRequirementCount",
  "failedRequirementCount",
  "unverifiedRequirementCount",
  "usefulWorkUnitCount",
  "artifactReceiptCount",
  "effectReceiptCount",
  "verifierReceiptCount",
  "pendingApprovalCount",
  "blockingDependencyCount",
] as const satisfies readonly (keyof RunContractEventPayloadV1)[];

export function buildRunTrajectory(
  run: AgentRunRecord,
  domainEvents: DomainEvent[],
): RunTrajectory {
  const ordered = [...domainEvents]
    .filter((event) => event.streamId === `run:${run.id}`)
    .sort((left, right) => left.seq - right.seq);
  const modelEvents = ordered.filter((event) => event.type === "run.model");
  const usage = ordered.reduce((total, event) => {
    if (event.type !== "run.model") return total;
    const eventCost = optionalFinite(event.payload.estimatedCostUsd);
    return {
      inputTokens: total.inputTokens + finite(event.payload.inputTokens),
      outputTokens: total.outputTokens + finite(event.payload.outputTokens),
      cachedInputTokens: total.cachedInputTokens + finite(event.payload.cachedInputTokens),
      totalTokens: total.totalTokens + finite(event.payload.totalTokens),
      estimatedCostUsd: eventCost === undefined || !total.costKnown
        ? undefined
        : roundUsd((total.estimatedCostUsd || 0) + eventCost),
      costKnown: total.costKnown && eventCost !== undefined,
      latencyMs: total.latencyMs + finite(event.payload.latencyMs),
      fallbackCount: total.fallbackCount + (event.payload.fallbackUsed === true ? 1 : 0),
    };
  }, {
    ...zeroUsage,
    costKnown: modelEvents.length > 0,
    estimatedCostUsd: modelEvents.length > 0 ? 0 : undefined,
  });

  const providers = unique(ordered
    .filter((event) => event.type === "run.model")
    .map((event) => optionalString(event.payload.provider)));
  const models = unique(ordered
    .filter((event) => event.type === "run.model")
    .map((event) => optionalString(event.payload.model)));
  const toolExecutionIds = unique(ordered
    .filter((event) => event.type === "run.tool" || event.type === "run.waiting_approval")
    .map((event) => optionalString(event.payload.executionId)));

  return {
    version: 2,
    run: {
      id: run.id,
      tenantId: run.tenantId,
      threadId: run.threadId,
      mode: run.mode,
      status: run.status,
      agentId: run.agentId,
      specialistIds: run.specialistIds || [],
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    },
    request: {
      promptLength: run.prompt.length,
      promptSha256: sha256(run.prompt),
      messageCount: run.messages.length,
    },
    response: run.response === undefined
      ? undefined
      : { length: run.response.length, sha256: sha256(run.response) },
    usage,
    providers,
    models,
    toolExecutionIds,
    learning: {
      feedbackVerdict: run.feedback?.verdict,
      correctionLength: run.feedback?.correction?.length,
      correctionSha256: run.feedback?.correction
        ? sha256(run.feedback.correction)
        : undefined,
      groundingStatus: run.grounding?.status,
      citedIds: run.grounding?.citedIds || [],
      invalidCitationCount: run.grounding?.invalidIds.length || 0,
    },
    events: ordered.map(toTrajectoryEvent),
    runtime: {
      app: "asael",
      version: process.env.npm_package_version || "0.1.0",
      revision: optionalString(
        process.env.VERCEL_GIT_COMMIT_SHA ||
          process.env.OMNIAGENT_RELEASE_SHA ||
          process.env.GITHUB_SHA,
      ),
    },
  };
}

function toTrajectoryEvent(event: DomainEvent): TrajectoryEvent {
  const payload = event.payload;
  const receipt: TrajectoryEvent["receipt"] = {};
  if (event.type === "run.model") {
    copy(receipt, payload, [
      "provider", "model", "tier", "inputTokens", "outputTokens",
      "cachedInputTokens", "totalTokens", "latencyMs", "fallbackUsed",
      "estimatedCostUsd",
      "costKnown", "iteration", "iterationCount",
    ]);
  } else if (event.type === "run.harness") {
    copy(receipt, payload, [
      "version", "mode", "provider", "model", "tier", "memoryScope",
      "contextDecision", "contextMode", "contextCount", "contextTraceId",
      "liveWeb", "toolCount", "approvalToolCount", "toolboxSha256",
      "instructionsSha256", "maxToolSteps", "maxToolCallsPerTurn",
      "maxToolResultChars", "maxOutputTokens", "approvalPolicy", "autonomy",
      "learningState", "learningSampleSize", "learningGuidanceCount",
      "learningGuidanceSha256",
    ]);
  } else if (
    event.type === "run.contracts.bound" ||
    event.type === "run.manifests.resolved" ||
    event.type === "run.terminal_receipt.recorded"
  ) {
    const contractPayload = { ...payload };
    delete contractPayload._executionScope;
    const parsed = runContractEventPayloadV1Schema.safeParse(contractPayload);
    if (parsed.success) {
      copy(receipt, parsed.data, runContractReceiptKeys);
    }
  } else if (event.type === "run.tool") {
    copy(receipt, payload, [
      "toolId", "toolName", "status", "riskLevel", "dryRun", "executionId",
    ]);
  } else if (event.type === "run.waiting_approval") {
    copy(receipt, payload, ["executionId", "toolId"]);
  } else if (event.type === "run.done") {
    copy(receipt, payload, ["responseLength", "responseSha256"]);
    const grounding = payload.grounding;
    if (grounding && typeof grounding === "object") {
      const record = grounding as Record<string, unknown>;
      const citedIds = Array.isArray(record.citedIds)
        ? record.citedIds.filter((value): value is string => typeof value === "string")
        : [];
      const status = optionalString(record.status) || "not_required";
      receipt.groundingStatus = status;
      receipt.grounded = status === "verified" || status === "not_required";
      receipt.citationCount = citedIds.length;
    }
  } else if (event.type === "run.memory") {
    copy(receipt, payload, ["count"]);
  } else if (event.type === "run.council_member") {
    copy(receipt, payload, ["agentId", "status", "confidence", "durationMs"]);
  } else if (event.type === "run.council_verdict") {
    copy(receipt, payload, ["status", "score"]);
  } else if (event.type === "run.status") {
    copy(receipt, payload, ["label"]);
  } else if (event.type === "run.error") {
    const message = optionalString(payload.message);
    if (message) {
      receipt.messageLength = message.length;
      receipt.messageSha256 = sha256(message);
    }
  }
  return { seq: event.seq, type: event.type, at: event.at, receipt };
}

function copy(
  target: TrajectoryEvent["receipt"],
  source: Record<string, unknown>,
  keys: readonly string[],
) {
  for (const key of keys) {
    const value = source[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      target[key] = value;
    }
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function finite(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function optionalString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function unique(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function optionalFinite(value: unknown) {
  const number = Number(value);
  return value === undefined || value === null || !Number.isFinite(number) || number < 0
    ? undefined
    : number;
}
