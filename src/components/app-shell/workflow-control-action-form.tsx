"use client";

import { useMemo, useState } from "react";
import { Loader2, Play } from "lucide-react";
import type {
  DomainAction,
  FormValue,
} from "@/components/app-shell/domain-console";
import {
  workflowControlHint,
  workflowControlSignals,
  workflowSignalLabel,
  type WorkflowControlRun,
} from "@/lib/workflows/client-controls";
import type { WorkflowSignalType } from "@/lib/workflows/types";

export function WorkflowControlActionForm({
  action,
  runs,
  defaultValues,
  loading,
  disabledReason,
  onRun,
}: {
  action: DomainAction;
  runs: WorkflowControlRun[];
  defaultValues?: Record<string, FormValue>;
  loading: boolean;
  disabledReason?: string;
  onRun: (values: Record<string, FormValue>) => void;
}) {
  const controllableRuns = useMemo(
    () => runs.filter((run) => workflowControlSignals(run.status).length > 0),
    [runs],
  );
  const defaultRunId =
    typeof defaultValues?.runId === "string" ? defaultValues.runId : "";
  const defaultSignal =
    typeof defaultValues?.signal === "string"
      ? (defaultValues.signal as WorkflowSignalType)
      : undefined;
  const [runId, setRunId] = useState(defaultRunId);
  const [signal, setSignal] = useState<WorkflowSignalType | undefined>(
    defaultSignal,
  );
  const selectedRun =
    controllableRuns.find((run) => run.id === runId) || controllableRuns[0];
  const availableSignals = selectedRun
    ? workflowControlSignals(selectedRun.status)
    : [];
  const selectedSignal =
    signal && availableSignals.includes(signal) ? signal : availableSignals[0];
  const unavailable = !selectedRun || !selectedSignal;

  return (
    <form
      id={action.id}
      className="rounded-md border border-line bg-background p-3"
      aria-busy={loading}
      onSubmit={(event) => {
        event.preventDefault();
        if (!selectedRun || !selectedSignal) return;
        onRun({ runId: selectedRun.id, signal: selectedSignal });
      }}
    >
      <p className="text-sm font-semibold">{action.title}</p>
      <p className="mt-1 text-xs leading-5 text-muted">
        {action.description}
      </p>
      {disabledReason ? (
        <p
          id={`${action.id}-permission`}
          className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs leading-5 text-muted"
        >
          {disabledReason}
        </p>
      ) : null}
      {selectedRun ? (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium text-muted">
            Workflow run
            <select
              value={selectedRun.id}
              onChange={(event) => {
                const nextRun = controllableRuns.find(
                  (run) => run.id === event.currentTarget.value,
                );
                setRunId(event.currentTarget.value);
                setSignal(
                  nextRun
                    ? workflowControlSignals(nextRun.status)[0]
                    : undefined,
                );
              }}
              className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
            >
              {controllableRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.goal} · {run.status.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <div className="rounded-md border border-line bg-surface p-2 text-xs leading-5 text-muted">
            <strong className="font-semibold text-foreground">
              {selectedRun.status.replaceAll("_", " ")}
            </strong>{" "}
            · {workflowControlHint(selectedRun.status)}
          </div>
          <label className="block text-xs font-medium text-muted">
            Available action
            <select
              value={selectedSignal}
              onChange={(event) =>
                setSignal(event.currentTarget.value as WorkflowSignalType)
              }
              className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
            >
              {availableSignals.map((availableSignal) => (
                <option key={availableSignal} value={availableSignal}>
                  {workflowSignalLabel(availableSignal)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-line bg-surface p-3 text-xs leading-5 text-muted">
          No recent workflow run has an available control. Start a run or refresh
          after its state changes.
        </p>
      )}
      <button
        type="submit"
        disabled={loading || Boolean(disabledReason) || unavailable}
        title={disabledReason}
        aria-describedby={
          disabledReason ? `${action.id}-permission` : undefined
        }
        className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-semibold text-primary-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        ) : (
          <Play size={14} aria-hidden="true" />
        )}
        Run action
      </button>
    </form>
  );
}
