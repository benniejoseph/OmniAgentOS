"use client";

import { useEffect, useMemo, useState } from "react";
import { BrainCircuit, Loader2 } from "lucide-react";
import type {
  CommandModelCatalog,
  CommandModelChoice,
  CommandModelSelectionRequest,
  CommandReasoningLevel,
} from "@/lib/models/command-selection";
import type { ModelAssignmentScope } from "@/lib/settings/types";

type CatalogResponse = { command?: CommandModelCatalog };

export function CommandModelPicker({
  scope,
  value,
  disabled,
  onChange,
}: {
  scope: ModelAssignmentScope;
  value?: CommandModelSelectionRequest;
  disabled?: boolean;
  onChange: (selection: CommandModelSelectionRequest | undefined) => void;
}) {
  // Results are keyed by scope so a scope change shows loading immediately and
  // a late response for a previous scope is never displayed.
  const [loaded, setLoaded] = useState<{
    scope: ModelAssignmentScope;
    catalog?: CommandModelCatalog;
    state: "ready" | "error";
  }>();
  const current = loaded?.scope === scope ? loaded : undefined;
  const catalog = current?.catalog;
  const state: "loading" | "ready" | "error" = current?.state ?? "loading";

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/settings/models?commandScope=${encodeURIComponent(scope)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Model choices are unavailable.");
        return await response.json() as CatalogResponse;
      })
      .then((payload) => {
        if (!payload.command) throw new Error("Model choices are unavailable.");
        setLoaded({ scope, catalog: payload.command, state: "ready" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error(
          "Command model catalog failed.",
          error instanceof Error ? error.message : "Unknown error",
        );
        setLoaded({ scope, state: "error" });
      });
    return () => controller.abort();
  }, [scope]);

  const selectedChoice = useMemo(() =>
    catalog?.choices.find((choice) => selectionMatchesChoice(value, choice)),
  [catalog?.choices, value]);
  const selectedChoiceId = selectedChoice?.id || "auto";
  const reasoningOptions = selectedChoice?.reasoningOptions || [];

  function chooseModel(choiceId: string) {
    if (choiceId === "auto") {
      onChange(undefined);
      return;
    }
    const choice = catalog?.choices.find((candidate) => candidate.id === choiceId);
    if (!choice) return;
    const currentEffort = choice.reasoningOptions.some((option) =>
      option.id === value?.reasoningLevel
    )
      ? value?.reasoningLevel
      : undefined;
    onChange(selectionFromChoice(choice, currentEffort));
  }

  function chooseReasoning(level: string) {
    if (!selectedChoice) return;
    const supported = selectedChoice.reasoningOptions.find((option) =>
      option.id === level
    );
    onChange(selectionFromChoice(selectedChoice, supported?.id));
  }

  const statusTitle = state === "error"
    ? "Model choices could not be read from Settings. Asael will use the saved default."
    : catalog?.message || "Loading the validated Settings model route.";
  return (
    <div
      className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full bg-surface-raised px-3 text-muted"
      title={statusTitle}
    >
      {state === "loading"
        ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        : <BrainCircuit size={14} aria-hidden="true" />}
      <label className="sr-only" htmlFor="command-model-choice">Model</label>
      <span className="text-[13px] font-semibold text-foreground">Model</span>
      <select
        id="command-model-choice"
        value={selectedChoiceId}
        disabled={disabled || state !== "ready" || !catalog?.choices.length}
        onChange={(event) => chooseModel(event.currentTarget.value)}
        className="min-h-9 max-w-[11rem] bg-transparent px-1 text-[13px] font-semibold text-muted outline-none hover:text-foreground disabled:opacity-60 sm:max-w-[17rem]"
      >
        <option value="auto">Settings default</option>
        {catalog?.choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {providerLabel(choice.provider)} · {choice.displayName}{choice.route === "fallback" ? " · fallback" : ""}
          </option>
        ))}
      </select>
      {selectedChoice ? (
        <>
          <span className="h-4 w-px bg-line" aria-hidden="true" />
          <label className="sr-only" htmlFor="command-reasoning-choice">Thinking intensity</label>
          <span className="text-[13px] font-semibold text-foreground">Thinking</span>
          <select
            id="command-reasoning-choice"
            value={value?.reasoningLevel || "default"}
            disabled={disabled || !reasoningOptions.length}
            onChange={(event) => chooseReasoning(event.currentTarget.value)}
            className="min-h-9 max-w-28 bg-transparent px-1 text-[13px] font-semibold text-muted outline-none hover:text-foreground disabled:opacity-60 sm:max-w-32"
          >
            <option value="default">Default</option>
            {reasoningOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </>
      ) : null}
    </div>
  );
}

function selectionFromChoice(
  choice: CommandModelChoice,
  reasoningLevel?: CommandReasoningLevel,
): CommandModelSelectionRequest {
  return {
    schemaVersion: 1,
    assignmentId: choice.assignmentId,
    assignmentRevision: choice.assignmentRevision,
    assignmentConfigurationSha256: choice.assignmentConfigurationSha256,
    route: choice.route,
    provider: choice.provider,
    modelId: choice.modelId,
    ...(reasoningLevel ? { reasoningLevel } : {}),
  };
}

function selectionMatchesChoice(
  selection: CommandModelSelectionRequest | undefined,
  choice: CommandModelChoice,
) {
  return Boolean(
    selection &&
    selection.assignmentId === choice.assignmentId &&
    selection.assignmentRevision === choice.assignmentRevision &&
    selection.assignmentConfigurationSha256 ===
      choice.assignmentConfigurationSha256 &&
    selection.route === choice.route &&
    selection.provider === choice.provider &&
    selection.modelId === choice.modelId,
  );
}

function providerLabel(provider: CommandModelChoice["provider"]) {
  if (provider === "openai") return "OpenAI";
  if (provider === "google") return "Google";
  if (provider === "anthropic") return "Claude";
  return "Bedrock";
}
