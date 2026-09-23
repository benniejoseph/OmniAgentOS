import { createHash } from "node:crypto";
import { z } from "zod";
import type { ModelReasoningEffort } from "@/lib/models/types";
import {
  COMMAND_REASONING_LEVELS,
  commandReasoningOptionsForModel,
  type CommandReasoningLevel,
  type CommandReasoningOption,
} from "@/lib/models/reasoning-effort";
import type {
  ModelAssignment,
  ModelAssignmentScope,
  ModelCatalogEntry,
  RequestModelAssignment,
  RequestModelCatalogEntry,
  RequestProviderConnection,
  SettingsModelProvider,
} from "@/lib/settings/types";

export type { ModelReasoningEffort } from "@/lib/models/types";
export type {
  CommandReasoningLevel,
  CommandReasoningOption,
} from "@/lib/models/reasoning-effort";

export const commandModelSelectionRequestSchema = z.object({
  schemaVersion: z.literal(1),
  assignmentId: z.string().trim().min(1).max(240),
  assignmentRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  assignmentConfigurationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  route: z.enum(["primary", "fallback"]),
  provider: z.enum(["openai", "google", "anthropic", "aws_bedrock"]),
  modelId: z.string().trim().min(1).max(240),
  reasoningLevel: z.enum(COMMAND_REASONING_LEVELS).optional(),
}).strict();

export type CommandModelSelectionRequest = z.infer<
  typeof commandModelSelectionRequestSchema
>;

export type CommandModelChoice = Readonly<{
  id: string;
  assignmentId: string;
  assignmentRevision: number;
  assignmentConfigurationSha256: string;
  route: "primary" | "fallback";
  provider: Exclude<SettingsModelProvider, "typesafe">;
  modelId: string;
  displayName: string;
  displayModelId: string;
  reasoningOptions: readonly CommandReasoningOption[];
}>;

export type CommandModelCatalog = Readonly<{
  schemaVersion: 1;
  scope: ModelAssignmentScope;
  defaultChoiceId: string | null;
  choices: readonly CommandModelChoice[];
  message: string;
}>;

export type ResolvedCommandModelSelection = Readonly<{
  provider: Exclude<SettingsModelProvider, "typesafe">;
  modelId: string;
  route: "primary" | "fallback";
  reasoningLevel?: CommandReasoningLevel;
  reasoningEffort?: ModelReasoningEffort;
  selectionSha256: string;
}>;

export class CommandModelSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandModelSelectionError";
  }
}

export function buildCommandModelCatalog(input: {
  scope: ModelAssignmentScope;
  assignments: readonly RequestModelAssignment[];
  models: readonly RequestModelCatalogEntry[];
  providers: readonly RequestProviderConnection[];
}): CommandModelCatalog {
  const assignment = input.assignments.find((candidate) =>
    candidate.scope === input.scope &&
    candidate.runtimeReadiness === "active" &&
    candidate.contractVersion === "p11.8-model-assignment:1" &&
    Boolean(candidate.configurationSha256)
  );
  if (!assignment || !assignment.configurationSha256) {
    return {
      schemaVersion: 1,
      scope: input.scope,
      defaultChoiceId: null,
      choices: [],
      message: "Choose and validate this role's model route in Settings first.",
    };
  }

  const candidates: Array<{
    route: "primary" | "fallback";
    provider: SettingsModelProvider;
    modelId: string;
  }> = [{
    route: "primary",
    provider: assignment.provider,
    modelId: assignment.modelId,
  }];
  if (assignment.fallbackProvider && assignment.fallbackModelId) {
    candidates.push({
      route: "fallback",
      provider: assignment.fallbackProvider,
      modelId: assignment.fallbackModelId,
    });
  }

  const choices = candidates.flatMap((candidate): CommandModelChoice[] => {
    if (candidate.provider === "typesafe") return [];
    if (
      candidate.route === "fallback" &&
      candidate.provider !== assignment.provider &&
      !assignment.allowCrossProviderFallback
    ) return [];
    const connected = input.providers.some((provider) =>
      provider.provider === candidate.provider &&
      provider.source === "tenant_vault" &&
      provider.enabled &&
      provider.status === "connected"
    );
    const model = input.models.find((catalogModel) =>
      catalogModel.provider === candidate.provider &&
      catalogModel.modelId === candidate.modelId &&
      catalogModel.selectable === true &&
      catalogModel.lifecycle !== "deprecated" &&
      catalogModel.lifecycle !== "retiring"
    );
    if (!connected || !model || !model.capabilities.includes("tools")) return [];
    return [{
      id: commandModelChoiceId(
        assignment.id,
        assignment.revision,
        candidate.route,
        candidate.provider,
        candidate.modelId,
      ),
      assignmentId: assignment.id,
      assignmentRevision: assignment.revision,
      assignmentConfigurationSha256: assignment.configurationSha256!,
      route: candidate.route,
      provider: candidate.provider,
      modelId: candidate.modelId,
      displayName: model.displayName,
      displayModelId: model.displayModelId,
      reasoningOptions: commandReasoningOptionsForModel(
        candidate.provider,
        candidate.modelId,
      ),
    }];
  });

  return {
    schemaVersion: 1,
    scope: input.scope,
    defaultChoiceId:
      choices.find((choice) => choice.route === "primary")?.id || null,
    choices,
    message: choices.length
      ? "Model choices are limited to this role's validated Settings route."
      : "The saved route is not currently selectable. Refresh its provider catalog in Settings.",
  };
}

/** Revalidates a client choice against the exact active Settings assignment. */
export function resolveCommandModelSelection(input: {
  selection: CommandModelSelectionRequest;
  assignment: ModelAssignment;
  catalog: readonly ModelCatalogEntry[];
}): ResolvedCommandModelSelection {
  const { selection, assignment } = input;
  if (
    assignment.runtimeReadiness !== "active" ||
    assignment.contractVersion !== "p11.8-model-assignment:1" ||
    !assignment.configurationSha256 ||
    !assignment.validatedAt
  ) {
    throw new CommandModelSelectionError(
      "The model route is no longer active. Review it in Settings and choose again.",
    );
  }
  if (
    selection.assignmentId !== assignment.id ||
    selection.assignmentRevision !== assignment.revision ||
    selection.assignmentConfigurationSha256 !== assignment.configurationSha256
  ) {
    throw new CommandModelSelectionError(
      "The model route changed after it was selected. Choose the model again.",
    );
  }

  const policyTarget = selection.route === "primary"
    ? { provider: assignment.provider, modelId: assignment.modelId }
    : {
        provider: assignment.fallbackProvider,
        modelId: assignment.fallbackModelId,
      };
  if (!policyTarget.provider || !policyTarget.modelId) {
    throw new CommandModelSelectionError(
      "This Settings route does not have the selected fallback model.",
    );
  }
  if (
    selection.route === "fallback" &&
    policyTarget.provider !== assignment.provider &&
    !assignment.allowCrossProviderFallback
  ) {
    throw new CommandModelSelectionError(
      "The selected fallback crosses providers without stored disclosure consent.",
    );
  }
  if (
    selection.provider !== policyTarget.provider ||
    selection.modelId !== policyTarget.modelId ||
    policyTarget.provider === "typesafe"
  ) {
    throw new CommandModelSelectionError(
      "The selected provider and model are outside this role's Settings policy.",
    );
  }
  const model = input.catalog.find((candidate) =>
    candidate.provider === selection.provider &&
    candidate.modelId === selection.modelId
  );
  if (
    !model ||
    model.lifecycle === "deprecated" ||
    model.lifecycle === "retiring" ||
    !model.capabilities.includes("tools")
  ) {
    throw new CommandModelSelectionError(
      "The selected model is no longer available for governed agent work.",
    );
  }

  const reasoningOption = selection.reasoningLevel
    ? commandReasoningOptionsForModel(
        selection.provider,
        selection.modelId,
      ).find((option) => option.id === selection.reasoningLevel)
    : undefined;
  if (selection.reasoningLevel && !reasoningOption) {
    throw new CommandModelSelectionError(
      "That reasoning intensity is not supported by the selected provider and model.",
    );
  }

  const resolved = {
    provider: selection.provider,
    modelId: selection.modelId,
    route: selection.route,
    ...(reasoningOption
      ? {
          reasoningLevel: reasoningOption.id,
          reasoningEffort: reasoningOption.nativeEffort,
        }
      : {}),
  } satisfies Omit<ResolvedCommandModelSelection, "selectionSha256">;
  return {
    ...resolved,
    selectionSha256: createHash("sha256")
      .update(JSON.stringify({
        schemaVersion: 1,
        assignmentId: assignment.id,
        assignmentRevision: assignment.revision,
        assignmentConfigurationSha256: assignment.configurationSha256,
        ...resolved,
      }), "utf8")
      .digest("hex"),
  };
}

function commandModelChoiceId(
  assignmentId: string,
  revision: number,
  route: "primary" | "fallback",
  provider: SettingsModelProvider,
  modelId: string,
) {
  return createHash("sha256")
    .update(`${assignmentId}\n${revision}\n${route}\n${provider}\n${modelId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}
