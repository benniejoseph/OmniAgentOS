"use client";

import Link from "next/link";
import { useRef, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import {
  CheckCircle2,
  Circle,
  Loader2,
  RefreshCw,
  Settings2,
} from "lucide-react";
import type { WorkspaceReadiness } from "@/lib/workspace/readiness";
import type { WorkspaceReadinessState } from "@/components/app-shell/use-workspace-readiness";

const compactPreferenceKey = "omniagent.workspace-readiness.compact.v1";

const readinessItems = [
  { key: "identity", label: "Workspace identity", href: "/app/settings" },
  { key: "knowledge", label: "Knowledge or memory added", href: "/app/memory" },
  { key: "connector", label: "Connector active", href: "/app/connectors" },
  { key: "firstRun", label: "First task completed", href: "/app/command" },
  { key: "evaluation", label: "Readiness evaluation recorded", href: "/app/evaluations" },
] as const;

export function WorkspaceReadinessCard({
  state,
  onRefresh,
}: {
  state: WorkspaceReadinessState;
  onRefresh: () => void | Promise<void>;
}) {
  const manualCompact = useSyncExternalStore(
    subscribeToCompactPreference,
    readCompactPreference,
    () => null,
  );
  const [disclosure, setDisclosure] = useState<
    "automatic" | "expanded" | "compact"
  >("automatic");
  const reopenRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const data = "data" in state ? state.data : undefined;
  const isCompact =
    state.status !== "error" &&
    (disclosure === "compact" ||
      (disclosure === "automatic" &&
        (manualCompact !== false || Boolean(data?.firstSuccessfulRun))));

  function dismiss() {
    try {
      window.localStorage.setItem(compactPreferenceKey, "1");
    } catch {
      // The card still compacts when storage is unavailable.
    }
    setDisclosure("compact");
    window.requestAnimationFrame(() => reopenRef.current?.focus());
  }

  function reopen() {
    try {
      window.localStorage.removeItem(compactPreferenceKey);
    } catch {
      // The expanded state remains available when storage is unavailable.
    }
    setDisclosure("expanded");
    window.requestAnimationFrame(() => dismissRef.current?.focus());
    if (state.status === "idle") {
      void onRefresh();
    }
  }

  if (manualCompact === null) {
    return null;
  }

  if (isCompact) {
    return (
      <section className="mt-4 rounded-lg border border-line bg-surface p-3">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-raised text-primary">
              <Settings2 size={16} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">Setup and readiness</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                {data
                  ? progressLabel(data)
                  : state.status === "loading"
                    ? "Checking workspace readiness."
                    : "Open the setup checklist when you need it."}
              </p>
            </div>
          </div>
          <button
            ref={reopenRef}
            type="button"
            className="action-button w-full shrink-0 sm:w-auto"
            onClick={reopen}
            aria-expanded="false"
            aria-controls="workspace-readiness-details"
          >
            Open setup and readiness
          </button>
        </div>
      </section>
    );
  }

  if (state.status === "idle" || state.status === "loading") {
    return (
      <section
        id="workspace-readiness-details"
        className="mt-4 rounded-lg border border-line bg-surface p-4"
        aria-labelledby="workspace-readiness-heading"
      >
        <div className="flex items-center gap-3" role="status" aria-live="polite">
          <Loader2
            size={18}
            className="shrink-0 animate-spin text-primary"
            aria-hidden="true"
          />
          <div>
            <h2 id="workspace-readiness-heading" className="text-sm font-semibold">
              Checking workspace readiness
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              You can keep working while setup checks load.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (state.status === "error" && !state.data) {
    return (
      <section
        id="workspace-readiness-details"
        className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-4"
        role="alert"
        aria-labelledby="workspace-readiness-error"
      >
        <h2 id="workspace-readiness-error" className="text-sm font-semibold">
          Setup readiness could not be loaded
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted">{state.error}</p>
        <button
          type="button"
          className="action-button mt-3 w-full sm:w-auto"
          onClick={() => void onRefresh()}
        >
          <RefreshCw size={15} aria-hidden="true" />
          Retry
        </button>
      </section>
    );
  }

  return (
    <ExpandedReadiness
      state={state}
      data={data as WorkspaceReadiness}
      onRefresh={onRefresh}
      onDismiss={dismiss}
      dismissRef={dismissRef}
    />
  );
}

function ExpandedReadiness({
  state,
  data,
  onRefresh,
  onDismiss,
  dismissRef,
}: {
  state: WorkspaceReadinessState;
  data: WorkspaceReadiness;
  onRefresh: () => void | Promise<void>;
  onDismiss: () => void;
  dismissRef: RefObject<HTMLButtonElement | null>;
}) {
  const refreshing = state.status === "refreshing";

  return (
    <section
      id="workspace-readiness-details"
      className="mt-4 rounded-lg border border-line bg-surface p-4 sm:p-5"
      aria-labelledby="workspace-readiness-heading"
    >
      <div className="min-w-0">
        <p className="text-xs font-semibold text-primary">Setup</p>
        <h2
          id="workspace-readiness-heading"
          className="mt-1 text-lg font-semibold"
        >
          Get your workspace ready
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
          These checks are recommendations, not gates. Start work now and finish
          setup when it is useful.
        </p>
        <p className="mt-3 text-sm font-semibold">{progressLabel(data)}</p>
      </div>

      {state.status === "error" ? (
        <div
          className="mt-4 rounded-md border border-danger/40 bg-danger/10 p-3"
          role="alert"
        >
          <p className="text-sm font-semibold">
            The latest readiness refresh failed
          </p>
          <p className="mt-1 text-sm leading-6 text-muted">{state.error}</p>
          <button
            type="button"
            className="action-button mt-3 w-full sm:w-auto"
            onClick={() => void onRefresh()}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : null}

      <ul className="mt-4 grid min-w-0 gap-2 sm:grid-cols-2">
        {readinessItems.map((item) => {
          const complete = data.checks[item.key];
          return (
            <li key={item.key} className="min-w-0">
              <Link
                href={item.href}
                className="flex min-h-11 min-w-0 items-center gap-3 rounded-md border border-line bg-background px-3 py-2 text-sm hover:bg-surface-raised"
              >
                {complete ? (
                  <CheckCircle2
                    size={17}
                    className="shrink-0 text-success"
                    aria-hidden="true"
                  />
                ) : (
                  <Circle
                    size={17}
                    className="shrink-0 text-muted"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0 flex-1 leading-5">{item.label}</span>
                <span
                  className={
                    complete
                      ? "shrink-0 text-xs font-semibold text-success"
                      : "shrink-0 text-xs font-semibold text-muted"
                  }
                >
                  {complete ? "Complete" : "To do"}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Link href="/app/command" className="primary-button w-full sm:w-auto">
          Start first task
        </Link>
        <button
          type="button"
          className="action-button w-full sm:w-auto"
          onClick={() => void onRefresh()}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={15} aria-hidden="true" />
          )}
          {refreshing ? "Refreshing setup" : "Refresh setup"}
        </button>
        <button
          ref={dismissRef}
          type="button"
          className="action-button w-full sm:w-auto"
          onClick={onDismiss}
          aria-expanded="true"
          aria-controls="workspace-readiness-details"
        >
          Dismiss setup for now
        </button>
      </div>

      {refreshing ? (
        <p className="sr-only" role="status" aria-live="polite">
          Refreshing workspace readiness.
        </p>
      ) : null}
    </section>
  );
}

function progressLabel(data: WorkspaceReadiness) {
  return `${data.completedCount} of ${data.totalCount} readiness checks complete.`;
}

function subscribeToCompactPreference(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  return () => window.removeEventListener("storage", onStoreChange);
}

function readCompactPreference() {
  try {
    return window.localStorage.getItem(compactPreferenceKey) === "1";
  } catch {
    return false;
  }
}
