import { createHash } from "node:crypto";

import type {
  ModelAssignmentScope,
  ModelCatalogEntry,
  SettingsModelProvider,
} from "@/lib/settings/types";

export const MODEL_ASSIGNMENT_CONTRACT_VERSION =
  "p11.8-model-assignment:1" as const;

type AssignmentRoleContract = Readonly<{
  title: string;
  description: string;
  runtimePurpose: string;
  supportedProviders: readonly SettingsModelProvider[];
  acceptedCapabilities: readonly string[];
}>;

function assignmentRoleContract(contract: AssignmentRoleContract) {
  return Object.freeze(contract);
}

export const modelAssignmentRoleContracts: Readonly<
  Record<ModelAssignmentScope, AssignmentRoleContract>
> = Object.freeze({
  main_agent: assignmentRoleContract({
    title: "Main agent",
    description: "Everyday conversation and direct governed tasks",
    runtimePurpose: "Direct Agent model and tool turns",
    supportedProviders: ["openai", "google", "anthropic", "aws_bedrock"],
    acceptedCapabilities: ["tools", "text"],
  }),
  orchestrator: assignmentRoleContract({
    title: "Orchestrator",
    description: "Intent classification, delegation, and task routing",
    runtimePurpose: "Semantic routing before task execution",
    supportedProviders: ["openai", "google", "anthropic", "aws_bedrock"],
    acceptedCapabilities: ["text"],
  }),
  planner: assignmentRoleContract({
    title: "Planner",
    description: "Project and durable workflow planning and synthesis",
    runtimePurpose: "Structured Project and workflow plans",
    supportedProviders: ["openai", "anthropic"],
    acceptedCapabilities: ["text"],
  }),
  verifier: assignmentRoleContract({
    title: "Verifier",
    description: "Evidence-bound workflow and Council review",
    runtimePurpose: "Structured outcome verification",
    supportedProviders: ["openai", "anthropic"],
    acceptedCapabilities: ["text"],
  }),
  council: assignmentRoleContract({
    title: "Agent council",
    description: "Specialist contributions, tool plans, and synthesis",
    runtimePurpose: "Bounded Council member model calls",
    supportedProviders: ["openai", "anthropic"],
    acceptedCapabilities: ["text"],
  }),
  memory: assignmentRoleContract({
    title: "Memory reasoning",
    description: "Semantic recall and context query planning",
    runtimePurpose: "Non-authoritative retrieval query planning",
    supportedProviders: ["openai", "anthropic"],
    acceptedCapabilities: ["text"],
  }),
  embeddings: assignmentRoleContract({
    title: "Embeddings",
    description: "Document and memory vector indexing",
    runtimePurpose: "External embedding generation",
    supportedProviders: ["openai"],
    acceptedCapabilities: ["embeddings"],
  }),
  vision: assignmentRoleContract({
    title: "Vision",
    description: "Image and visual-document understanding",
    runtimePurpose: "OCR and visual extraction",
    supportedProviders: ["openai"],
    acceptedCapabilities: ["vision"],
  }),
  audio: assignmentRoleContract({
    title: "Audio transcription",
    description: "Uploaded recording and meeting transcription",
    runtimePurpose: "Capture and meeting transcription",
    supportedProviders: ["openai"],
    acceptedCapabilities: ["audio", "transcription"],
  }),
});

export function modelAssignmentRoleSupportsFallback(
  scope: ModelAssignmentScope,
) {
  return scope !== "embeddings" && scope !== "vision" && scope !== "audio";
}

export function modelSupportsAssignmentRole(
  scope: ModelAssignmentScope,
  provider: SettingsModelProvider,
  model: Pick<ModelCatalogEntry, "capabilities">,
) {
  const contract = modelAssignmentRoleContracts[scope];
  return contract.supportedProviders.includes(provider) &&
    contract.acceptedCapabilities.some((capability) =>
      model.capabilities.includes(capability)
    );
}

export function modelAssignmentConfigurationSha256(input: {
  scope: ModelAssignmentScope;
  provider: SettingsModelProvider;
  modelId: string;
  fallbackProvider?: SettingsModelProvider;
  fallbackModelId?: string;
  allowCrossProviderFallback: boolean;
  revision: number;
  validatedAt: string;
}) {
  return createHash("sha256").update(JSON.stringify({
    contractVersion: MODEL_ASSIGNMENT_CONTRACT_VERSION,
    scope: input.scope,
    provider: input.provider,
    modelId: input.modelId,
    fallbackProvider: input.fallbackProvider || null,
    fallbackModelId: input.fallbackModelId || null,
    allowCrossProviderFallback: input.allowCrossProviderFallback,
    revision: input.revision,
    validatedAt: input.validatedAt,
  })).digest("hex");
}
