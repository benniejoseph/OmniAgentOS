"use client";

import { useEffect } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";

export default function CommandError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Command workspace render failed", error);
  }, [error]);

  return (
    <main className="grid min-h-[60vh] place-items-center px-5 py-16">
      <section className="w-full max-w-xl rounded-2xl border border-line bg-surface p-7 shadow-sm sm:p-9" aria-labelledby="command-recovery-title">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Command recovery</p>
        <h1 id="command-recovery-title" className="mt-2 text-2xl font-semibold tracking-tight">The conversation is still safe</h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Command hit a temporary display problem. Your conversation and completed work remain stored; retry this view or return to the workspace.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <button type="button" onClick={() => reset()} className="primary-button">
            <RefreshCw size={15} aria-hidden="true" />
            Retry Command
          </button>
          <a href="/app" className="action-button">
            <ArrowLeft size={15} aria-hidden="true" />
            Back to workspace
          </a>
        </div>
      </section>
    </main>
  );
}
