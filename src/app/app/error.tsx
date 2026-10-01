"use client";

import { useEffect } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";

/**
 * Catches a workspace view that fails to render, inside the shell, so the
 * navigation stays usable. Retry fetches the view from the server again.
 */
export default function WorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("Workspace view failed to render", error);
  }, [error]);

  return (
    <section className="grid min-h-[60vh] place-items-center px-5 py-16" aria-labelledby="workspace-recovery-title">
      <div className="w-full max-w-xl rounded-2xl border border-line bg-surface p-7 shadow-sm sm:p-9">
        <h1 id="workspace-recovery-title" className="text-2xl font-semibold tracking-tight">This view could not open</h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Something went wrong while showing it. Nothing you saved was lost; try again, or go back to Today.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <button type="button" onClick={() => retry()} className="primary-button">
            <RefreshCw size={15} aria-hidden="true" />
            Try again
          </button>
          <a href="/app" className="action-button">
            <ArrowLeft size={15} aria-hidden="true" />
            Back to Today
          </a>
        </div>
      </div>
    </section>
  );
}
