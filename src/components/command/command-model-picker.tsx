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
import styles from "@/components/agent-runs-workspace.module.css";

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
  const defaultChoice = catalog?.choices.find((choice) => choice.id === catalog.defaultChoiceId);
  const displayedChoice = selectedChoice || defaultChoice;
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
    : displayedChoice
      ? `${commandModelDisplayName(displayedChoice)}. ${selectedChoice ? "Chosen for this message." : "Your saved default."} Choose a model for this message.`
      : state === "loading" ? "Loading your models." : "Review your model choices in Settings.";
  return (
    <div
      className={styles.modelPicker}
      title={statusTitle}
    >
      {state === "loading"
        ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        : <BrainCircuit size={14} aria-hidden="true" />}
      <label className="sr-only" htmlFor="command-model-choice">Model</label>
      <select
        id="command-model-choice"
        value={selectedChoiceId}
        disabled={disabled || state !== "ready" || !catalog?.choices.length}
        onChange={(event) => chooseModel(event.currentTarget.value)}
        className={styles.modelSelect}
        title={statusTitle}
      >
        <option value="auto">{defaultChoice ? commandModelDisplayName(defaultChoice) : state === "loading" ? "Loading model…" : "Default unavailable"}</option>
        {catalog?.choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {commandModelDisplayName(choice)}
          </option>
        ))}
      </select>
      {selectedChoice ? (
        <>
          <span className="h-4 w-px bg-line" aria-hidden="true" />
          <label className="sr-only" htmlFor="command-reasoning-choice">Thinking intensity</label>
          <select
            id="command-reasoning-choice"
            value={value?.reasoningLevel || "default"}
            disabled={disabled || !reasoningOptions.length}
            onChange={(event) => chooseReasoning(event.currentTarget.value)}
            className={styles.reasoningSelect}
            title="Thinking intensity: more reasoning can take longer"
          >
            <option value="default">Default thinking</option>
            {reasoningOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </>
      ) : null}
    </div>
  );
}

/** Presentation only: provider routing and exact selection IDs stay unchanged. */
export function commandModelDisplayName(model: { modelId: string; displayName?: string; displayModelId?: string }) {
  const displayName = model.displayName?.trim();
  const namedClaude = displayName?.replace(/^(?:global|us|eu|apac)\s+(?:anthropic\s+)?(?=claude\s)/i, "");
  if (namedClaude && namedClaude !== displayName) return namedClaude;
  const rawName = displayName || model.modelId;
  const knownName = rawName
    .replace(/^(?:(?:global|us|eu|apac)\.)?(?:openai|anthropic|google)[./]/i, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/(?:-\d{8})?(?:-v\d+(?::\d+)?)?$/, "");
  const gpt = /^gpt-(\d+(?:\.\d+)*)(.*)$/i.exec(knownName);
  if (gpt && /^(-[a-z0-9]+)*$/i.test(gpt[2])) {
    const suffix = gpt[2].split("-").filter(Boolean).map((part) =>
      part === "mini" || part === "nano" ? part : part[0].toUpperCase() + part.slice(1));
    return [`GPT-${gpt[1]}`, ...suffix].join(" ");
  }
  const claude = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?(?:-latest)?$/i.exec(knownName);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  const gemini = /^gemini-(\d+(?:\.\d+)*)(?:-(pro|flash|flash-lite))?(?:-preview.*|-latest)?$/i.exec(knownName);
  if (gemini) return `Gemini ${gemini[1]}${gemini[2] ? ` ${gemini[2].split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ")}` : ""}`;
  const reasoning = /^(o\d+)(?:-(mini|pro))?$/i.exec(knownName);
  if (reasoning) return `${reasoning[1]}${reasoning[2] ? ` ${reasoning[2]}` : ""}`;
  // A meaningful owner/provider label is more useful than a guessed model name.
  if (displayName && displayName !== model.modelId && displayName !== model.displayModelId) return displayName;
  return "Custom model";
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
