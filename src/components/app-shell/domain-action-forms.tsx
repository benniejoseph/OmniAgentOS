"use client";

import { useMemo, useState } from "react";
import { Loader2, Play } from "lucide-react";
import type {
  ActionField,
  DomainAction,
  FormValue,
} from "@/components/app-shell/domain-console";
import { WorkflowControlActionForm } from "@/components/app-shell/workflow-control-action-form";
import type { WorkflowControlRun } from "@/lib/workflows/client-controls";

export function DomainActionForms({
  actions,
  defaultValues,
  runningAction,
  disabledReasons,
  workflowRuns = [],
  onRun,
}: {
  actions: DomainAction[];
  defaultValues: Record<string, Record<string, FormValue>>;
  runningAction?: string;
  disabledReasons: Record<string, string | undefined>;
  workflowRuns?: WorkflowControlRun[];
  onRun: (
    action: DomainAction,
    values: Record<string, FormValue>,
  ) => void;
}) {
  return (
    <div className="space-y-3">
      {actions.map((action) =>
        action.id === "control-workflow" ? (
          <WorkflowControlActionForm
            key={action.id}
            action={action}
            runs={workflowRuns}
            defaultValues={defaultValues[action.id]}
            loading={runningAction === action.id}
            disabledReason={disabledReasons[action.id]}
            onRun={(values) => onRun(action, values)}
          />
        ) : (
          <ActionForm
            key={action.id}
            action={action}
            defaultValues={defaultValues[action.id]}
            loading={runningAction === action.id}
            disabledReason={disabledReasons[action.id]}
            onRun={(values) => onRun(action, values)}
          />
        ),
      )}
    </div>
  );
}

function ActionForm({
  action,
  defaultValues,
  loading,
  disabledReason,
  onRun,
}: {
  action: DomainAction;
  defaultValues?: Record<string, FormValue>;
  loading: boolean;
  disabledReason?: string;
  onRun: (values: Record<string, FormValue>) => void;
}) {
  const initialValues = useMemo(() => {
    const fieldDefaults = Object.fromEntries(
      action.fields.map((field) => [
        field.name,
        field.defaultValue ?? (field.type === "checkbox" ? false : ""),
      ]),
    ) as Record<string, FormValue>;
    return { ...fieldDefaults, ...defaultValues };
  }, [action.fields, defaultValues]);
  const [values, setValues] = useState(initialValues);

  return (
    <form
      id={action.id}
      className="rounded-md border border-line bg-background p-3"
      aria-busy={loading}
      onSubmit={(event) => {
        event.preventDefault();
        onRun(values);
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
      <div className="mt-3 space-y-3">
        {action.fields.map((field) => (
          <FieldControl
            key={field.name}
            field={field}
            value={values[field.name]}
            onChange={(value) =>
              setValues((current) => ({
                ...current,
                [field.name]: value,
              }))
            }
          />
        ))}
      </div>
      <button
        type="submit"
        disabled={loading || Boolean(disabledReason)}
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

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: ActionField;
  value: FormValue;
  onChange: (value: FormValue) => void;
}) {
  if (field.type === "checkbox") {
    return (
      <label className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-xs">
        <span>{field.label}</span>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.currentTarget.checked)}
          className="size-4 accent-primary"
        />
      </label>
    );
  }

  const commonClass =
    "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary";
  const stringValue = typeof value === "string" ? value : String(value ?? "");
  return (
    <label className="block text-xs font-medium text-muted">
      {field.label}
      {field.type === "select" ? (
        <select
          value={stringValue}
          onChange={(event) => onChange(event.currentTarget.value)}
          className={commonClass}
        >
          {(field.options || []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === "textarea" || field.type === "json" ? (
        <textarea
          value={stringValue}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={field.placeholder}
          rows={field.type === "json" ? 4 : 5}
          className={commonClass}
        />
      ) : (
        <input
          type={field.type === "password" ? "password" : "text"}
          autoComplete={field.type === "password" ? "new-password" : undefined}
          value={stringValue}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={field.placeholder}
          className={commonClass}
        />
      )}
    </label>
  );
}
