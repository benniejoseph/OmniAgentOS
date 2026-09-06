import { z } from "zod";
import { redactSensitive } from "@/lib/security/context";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type {
  WorkflowPlanNode,
  WorkflowPlanNodeContract,
  WorkflowPlanNodeExecutionRecord,
  WorkflowPlanNodeInputBinding,
} from "@/lib/workflows/types";

export const WORKFLOW_NODE_CONTRACT_VERSION = 1 as const;
export const WORKFLOW_NODE_MAX_TOOL_CALLS = 6;
export const WORKFLOW_NODE_MAX_OUTPUT_CHARS = 6_000;
export const WORKFLOW_NODE_MAX_DEPENDENCY_CHARS = 12_000;

const nodeArtifactSchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(["analysis", "result", "verification", "report", "memory", "control"]),
  content: z.string().trim().min(1).max(WORKFLOW_NODE_MAX_OUTPUT_CHARS),
  evidenceIds: z.array(z.string().trim().min(1).max(240)).max(32),
}).strict();

const acceptanceCheckSchema = z.object({
  criterion: z.string().trim().min(1).max(1_000),
  passed: z.boolean(),
  evidenceIds: z.array(z.string().trim().min(1).max(240)).max(32),
  note: z.string().trim().max(1_000),
}).strict();

export const workflowNodeAgentResultSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  summary: z.string().trim().min(1).max(2_000),
  artifacts: z.array(nodeArtifactSchema).min(1).max(8),
  acceptanceChecks: z.array(acceptanceCheckSchema).max(24),
  sideEffectClaimed: z.boolean(),
}).strict();

export type WorkflowNodeResultV1 = z.infer<typeof workflowNodeAgentResultSchema> & {
  schemaVersion: typeof WORKFLOW_NODE_CONTRACT_VERSION;
  completionBasis: "model_receipt" | "tool_receipts" | "control_receipt";
};

export type WorkflowNodeInputV1 = Readonly<{
  schemaVersion: typeof WORKFLOW_NODE_CONTRACT_VERSION;
  nodeId: string;
  objective: string;
  task: string;
  executor: WorkflowPlanNodeContract["executor"];
  grants: Readonly<{
    toolIds: readonly string[];
    connectorTargets: readonly string[];
    policy: WorkflowPlanNode["policy"];
    riskLevel: WorkflowPlanNode["riskLevel"];
  }>;
  inputBindings: readonly Readonly<WorkflowPlanNodeInputBinding>[];
  dependencies: readonly Readonly<{
    nodeId: string;
    executionId: string;
    outputSha256: string;
    artifacts: readonly Readonly<{
      name: string;
      kind: string;
      content: string;
      evidenceIds: readonly string[];
    }>[];
  }>[];
  acceptanceCriteria: readonly string[];
  expectedOutputs: readonly string[];
  limits: Readonly<{
    maxToolCalls: number;
    maxModelCalls: 0 | 1;
    maxOutputChars: number;
  }>;
}>;

export type WorkflowNodeExecutionReceiptV1 = Readonly<{
  schemaVersion: typeof WORKFLOW_NODE_CONTRACT_VERSION;
  nodeId: string;
  executor: WorkflowPlanNodeContract["executor"];
  inputSha256: string;
  outputSha256: string;
  dependencyExecutionIds: readonly string[];
  toolExecutionIds: readonly string[];
  model?: Readonly<{
    provider: string;
    model: string;
    usageReceiptId?: string;
    usageReceiptRecorded: boolean;
    providerRequestId?: string;
    attemptCount: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  control?: Readonly<{
    type: "approval";
    approved: boolean;
    approvedAt?: string;
  }>;
}>;

export const workflowNodeAgentResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "summary",
    "artifacts",
    "acceptanceChecks",
    "sideEffectClaimed",
  ],
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string", maxLength: 2_000 },
    artifacts: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "kind", "content", "evidenceIds"],
        properties: {
          name: { type: "string", maxLength: 160 },
          kind: {
            type: "string",
            enum: ["analysis", "result", "verification", "report", "memory", "control"],
          },
          content: { type: "string", maxLength: WORKFLOW_NODE_MAX_OUTPUT_CHARS },
          evidenceIds: {
            type: "array",
            maxItems: 32,
            items: { type: "string", maxLength: 240 },
          },
        },
      },
    },
    acceptanceChecks: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "passed", "evidenceIds", "note"],
        properties: {
          criterion: { type: "string", maxLength: 1_000 },
          passed: { type: "boolean" },
          evidenceIds: {
            type: "array",
            maxItems: 32,
            items: { type: "string", maxLength: 240 },
          },
          note: { type: "string", maxLength: 1_000 },
        },
      },
    },
    sideEffectClaimed: { type: "boolean", const: false },
  },
} as const;

export function deriveWorkflowNodeContract(
  node: WorkflowPlanNode,
): WorkflowPlanNodeContract {
  const grantedToolIds = unique(node.toolIds).slice(0, WORKFLOW_NODE_MAX_TOOL_CALLS);
  const executor = node.kind === "approval"
    ? "control"
    : grantedToolIds.length
      ? "tool"
      : "agent";
  return {
    schemaVersion: WORKFLOW_NODE_CONTRACT_VERSION,
    executor,
    dependencyNodeIds: unique(node.dependsOn),
    grantedToolIds,
    maxToolCalls: executor === "tool" ? grantedToolIds.length : 0,
    maxModelCalls: executor === "agent" ? 1 : 0,
    maxOutputChars: WORKFLOW_NODE_MAX_OUTPUT_CHARS,
  };
}

export function resolveWorkflowNodeContract(
  node: WorkflowPlanNode,
): WorkflowPlanNodeContract {
  const derived = deriveWorkflowNodeContract(node);
  if (
    node.execution &&
    canonicalJsonSha256(node.execution) !== canonicalJsonSha256(derived)
  ) {
    throw new Error(`Workflow node ${node.id} execution contract does not match its declared dependencies and grants.`);
  }
  return node.execution || derived;
}

export function withWorkflowNodeContract(node: WorkflowPlanNode): WorkflowPlanNode {
  return { ...node, execution: deriveWorkflowNodeContract(node) };
}

export function buildWorkflowNodeInput({
  objective,
  node,
  dependencyRecords,
}: {
  objective: string;
  node: WorkflowPlanNode;
  dependencyRecords: readonly WorkflowPlanNodeExecutionRecord[];
}): WorkflowNodeInputV1 {
  const contract = resolveWorkflowNodeContract(node);
  const declaredDependencies = new Set(contract.dependencyNodeIds);
  if (dependencyRecords.some((record) => !declaredDependencies.has(record.nodeId))) {
    throw new Error(`Workflow node ${node.id} received an undeclared dependency artifact.`);
  }
  const recordsByNode = new Map(dependencyRecords.map((record) => [record.nodeId, record]));
  let remainingDependencyChars = WORKFLOW_NODE_MAX_DEPENDENCY_CHARS;
  const dependencies = contract.dependencyNodeIds.map((nodeId) => {
    const record = recordsByNode.get(nodeId);
    if (!record || record.status !== "completed" || !record.output) {
      throw new Error(`Workflow node ${node.id} is missing completed dependency artifact ${nodeId}.`);
    }
    const safeOutput = redactSensitive(record.output) as Record<string, unknown>;
    const artifacts = dependencyArtifacts(safeOutput, remainingDependencyChars);
    remainingDependencyChars -= artifacts.reduce(
      (total, artifact) => total + artifact.content.length,
      0,
    );
    return Object.freeze({
      nodeId,
      executionId: record.id,
      outputSha256: canonicalJsonSha256(safeOutput),
      artifacts,
    });
  });
  return Object.freeze({
    schemaVersion: WORKFLOW_NODE_CONTRACT_VERSION,
    nodeId: node.id,
    objective: safeBoundedText(objective, 4_000),
    task: safeBoundedText(node.description, 2_000),
    executor: contract.executor,
    grants: Object.freeze({
      toolIds: Object.freeze([...contract.grantedToolIds]),
      connectorTargets: Object.freeze(unique(node.connectorTargets).slice(0, 32)),
      policy: node.policy,
      riskLevel: node.riskLevel,
    }),
    inputBindings: Object.freeze((node.inputBindings || []).map((binding) => Object.freeze({
      dependencyNodeId: binding.dependencyNodeId,
      targetToolId: binding.targetToolId,
      targetPath: binding.targetPath,
      artifactName: binding.artifactName,
    }))),
    dependencies: Object.freeze(dependencies),
    acceptanceCriteria: Object.freeze(node.acceptanceCriteria.map((value) => safeBoundedText(value, 1_000)).slice(0, 24)),
    expectedOutputs: Object.freeze(node.expectedOutputs.map((value) => safeBoundedText(value, 1_000)).slice(0, 24)),
    limits: Object.freeze({
      maxToolCalls: contract.maxToolCalls,
      maxModelCalls: contract.maxModelCalls,
      maxOutputChars: contract.maxOutputChars,
    }),
  });
}

export function parseWorkflowNodeAgentResult(
  value: unknown,
  input: WorkflowNodeInputV1,
): WorkflowNodeResultV1 {
  if (input.executor !== "agent" || input.limits.maxModelCalls !== 1) {
    throw new Error(`Workflow node ${input.nodeId} is not authorized for an agent execution.`);
  }
  const parsed = workflowNodeAgentResultSchema.parse(value);
  if (parsed.sideEffectClaimed) {
    throw new Error(`Workflow node ${input.nodeId} cannot claim side effects from a model-only execution.`);
  }
  const safeParsed = redactSensitive(parsed) as typeof parsed;
  const criteria = new Map(input.acceptanceCriteria.map((criterion) => [criterion, false]));
  for (const check of safeParsed.acceptanceChecks) {
    if (!criteria.has(check.criterion) || criteria.get(check.criterion)) {
      throw new Error(`Workflow node ${input.nodeId} returned an undeclared or duplicate acceptance criterion.`);
    }
    criteria.set(check.criterion, true);
  }
  if ([...criteria.values()].some((seen) => !seen)) {
    throw new Error(`Workflow node ${input.nodeId} did not evaluate every acceptance criterion.`);
  }
  const outputChars = safeParsed.summary.length + safeParsed.artifacts.reduce(
    (total, artifact) => total + artifact.content.length,
    0,
  );
  if (outputChars > input.limits.maxOutputChars) {
    throw new Error(`Workflow node ${input.nodeId} exceeded its output contract.`);
  }
  const descriptionOnly = normalizedText(input.task);
  if (safeParsed.artifacts.some((artifact) => normalizedText(artifact.content) === descriptionOnly)) {
    throw new Error(`Workflow node ${input.nodeId} only restated its task description.`);
  }
  return {
    schemaVersion: WORKFLOW_NODE_CONTRACT_VERSION,
    completionBasis: "model_receipt",
    ...safeParsed,
  };
}

export function workflowNodeInputSha256(input: WorkflowNodeInputV1) {
  return canonicalJsonSha256(input);
}

export function workflowNodeOutputSha256(output: WorkflowNodeResultV1) {
  return canonicalJsonSha256(output);
}

export function assertWorkflowNodeExecutionReceipt(
  input: WorkflowNodeInputV1,
  output: WorkflowNodeResultV1,
  receipt: WorkflowNodeExecutionReceiptV1,
) {
  if (
    receipt.schemaVersion !== WORKFLOW_NODE_CONTRACT_VERSION ||
    receipt.nodeId !== input.nodeId ||
    receipt.executor !== input.executor ||
    receipt.inputSha256 !== workflowNodeInputSha256(input) ||
    receipt.outputSha256 !== workflowNodeOutputSha256(output)
  ) {
    throw new Error(`Workflow node ${input.nodeId} execution receipt does not bind its typed input and output.`);
  }
  const dependencyIds = input.dependencies.map((dependency) => dependency.executionId);
  if (canonicalJsonSha256(receipt.dependencyExecutionIds) !== canonicalJsonSha256(dependencyIds)) {
    throw new Error(`Workflow node ${input.nodeId} execution receipt does not bind its dependencies.`);
  }
  if (input.executor === "agent") {
    if (
      output.completionBasis !== "model_receipt" ||
      !receipt.model ||
      receipt.model.attemptCount < 1 ||
      receipt.toolExecutionIds.length
    ) {
      throw new Error(`Workflow node ${input.nodeId} is missing its bounded model receipt.`);
    }
    return;
  }
  if (input.executor === "tool") {
    if (
      output.completionBasis !== "tool_receipts" ||
      receipt.model ||
      receipt.control ||
      !receipt.toolExecutionIds.length ||
      receipt.toolExecutionIds.length > input.limits.maxToolCalls
    ) {
      throw new Error(`Workflow node ${input.nodeId} is missing governed tool receipts.`);
    }
    return;
  }
  if (
    output.completionBasis !== "control_receipt" ||
    !receipt.control ||
    receipt.model ||
    receipt.toolExecutionIds.length
  ) {
    throw new Error(`Workflow node ${input.nodeId} is missing its deterministic control receipt.`);
  }
}

function dependencyArtifacts(output: Record<string, unknown>, maxChars: number) {
  const nodeResult = recordValue(output.nodeResult);
  const artifacts = Array.isArray(nodeResult?.artifacts)
    ? nodeResult.artifacts
        .map(recordValue)
        .filter((value): value is Record<string, unknown> => Boolean(value))
        .map((artifact) => ({
          name: boundedText(String(artifact.name || "dependency artifact"), 160),
          kind: boundedText(String(artifact.kind || "result"), 80),
          content: boundedText(String(artifact.content || ""), 4_000),
          evidenceIds: stringArray(artifact.evidenceIds, 32),
        }))
        .filter((artifact) => artifact.content)
    : [];
  if (artifacts.length) return boundDependencyArtifacts(artifacts, maxChars);
  const legacyArtifact = typeof output.artifact === "string" ? output.artifact : "";
  return boundDependencyArtifacts(legacyArtifact
    ? [{
        name: "legacy workflow artifact",
        kind: "result",
        content: boundedText(legacyArtifact, 4_000),
        evidenceIds: [],
      }]
    : [{
        name: "workflow dependency output",
        kind: "result",
        content: boundedText(JSON.stringify(output), 4_000),
        evidenceIds: [],
      }], maxChars);
}

function boundDependencyArtifacts<T extends { content: string }>(artifacts: T[], maxChars: number) {
  let remaining = Math.max(0, maxChars);
  const bounded: T[] = [];
  for (const artifact of artifacts.slice(0, 8)) {
    if (remaining <= 0) break;
    const content = artifact.content.slice(0, remaining);
    if (!content) continue;
    bounded.push({ ...artifact, content });
    remaining -= content.length;
  }
  return Object.freeze(bounded.map((artifact) => Object.freeze(artifact)));
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown, limit: number) {
  return Array.isArray(value)
    ? value.map(String).map((item) => boundedText(item, 240)).filter(Boolean).slice(0, limit)
    : [];
}

function unique(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function boundedText(value: string, limit: number) {
  return value.trim().slice(0, limit);
}

function safeBoundedText(value: string, limit: number) {
  return boundedText(String(redactSensitive(value)), limit);
}

function normalizedText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
