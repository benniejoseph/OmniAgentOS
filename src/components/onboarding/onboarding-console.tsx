"use client";

import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Loader2,
  LockKeyhole,
  Play,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type SessionResponse = {
  authenticated: boolean;
  authEnabled: boolean;
  user?: { email?: string; name?: string | null };
  tenant?: { name?: string; slug?: string };
  membership?: { role?: string };
};

type CapabilitiesResponse = {
  memory?: { total?: number };
  knowledge?: { total?: number };
  runs?: { total?: number };
  workflows?: { total?: number };
  mcpConnectors?: { total?: number; active?: number };
  openApiConnectors?: { total?: number; active?: number };
  evaluations?: { total?: number };
};

const activationSteps = [
  {
    title: "Confirm workspace identity",
    body: "Know tenant, actor role, auth mode, and who owns operational decisions.",
    href: "/app/security",
  },
  {
    title: "Choose first memory source",
    body: "Start with one policy, run history, or knowledge base before adding connectors.",
    href: "/app/memory",
  },
  {
    title: "Register one safe connector",
    body: "Use MCP or OpenAPI with guarded endpoints and redacted secret references.",
    href: "/app/connectors",
  },
  {
    title: "Run the first goal",
    body: "Give the agent useful work, then follow approvals, progress, and evidence to completion.",
    href: "/app/command",
  },
  {
    title: "Run a readiness evaluation",
    body: "Exercise safety, tenant isolation, reliability, and evidence checks before relying on automation.",
    href: "/app/evaluations",
  },
];

export function OnboardingConsole() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [completed, setCompleted] = useState([false, false, false, false, false]);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let canceled = false;
    const controller = new AbortController();

    async function load() {
      try {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Session request failed.");
        }
        const body = await response.json() as SessionResponse;
        if (!canceled) {
          setSession(body);
        }

        const identityReady = !body.authEnabled || body.authenticated;
        if (!identityReady) {
          if (!canceled) {
            setCompleted([false, false, false, false, false]);
            setStatus("ready");
          }
          return;
        }

        const capabilitiesResult = await fetch("/api/capabilities", {
          cache: "no-store",
          signal: controller.signal,
        });
        let capabilities: CapabilitiesResponse | undefined;
        if (capabilitiesResult.ok) {
          capabilities = await capabilitiesResult.json() as CapabilitiesResponse;
        }
        if (!capabilities) {
          if (!canceled) {
            setCompleted((current) => [identityReady, ...current.slice(1)]);
            setStatus("error");
          }
          return;
        }
        if (!canceled) {
          setCompleted([
            identityReady,
            Number(capabilities?.memory?.total || 0) +
                Number(capabilities?.knowledge?.total || 0) >
              0,
            Number(capabilities?.mcpConnectors?.active || 0) +
                Number(capabilities?.openApiConnectors?.active || 0) >
              0,
            Number(capabilities?.runs?.total || 0) +
                Number(capabilities?.workflows?.total || 0) >
              0,
            Number(capabilities.evaluations?.total || 0) > 0,
          ]);
          setStatus("ready");
        }
      } catch (error) {
        if (!canceled && !(error instanceof DOMException && error.name === "AbortError")) {
          setStatus("error");
        }
      }
    }

    void load();
    return () => {
      canceled = true;
      controller.abort();
    };
  }, [refreshVersion]);

  const progress = useMemo(() => {
    const complete = completed.filter(Boolean).length;
    return Math.round((complete / completed.length) * 100);
  }, [completed]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="border-b border-line pt-16">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[0.78fr_1.22fr] lg:px-8">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Onboarding</p>
            <h1 className="mt-4 max-w-3xl text-5xl font-semibold tracking-normal sm:text-6xl">
              Reach first value in one operating session.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted">
              Confirm identity, attach one memory source, register one guarded integration, and run one auditable workflow.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/app/command"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-ink transition hover:brightness-105"
              >
                Start first run
                <Play size={16} aria-hidden="true" />
              </Link>
              <Link
                href="/demo"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-line bg-surface px-5 text-sm font-semibold transition hover:bg-surface-raised"
              >
                Open demo
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div className="rounded-lg border border-line bg-surface p-5 sm:p-6">
            <div className="flex flex-col gap-6 border-b border-line pb-6 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm text-muted">Activation progress</p>
                <p className="mt-1 text-3xl font-semibold">{progress}%</p>
              </div>
              {status === "loading" ? (
                <div className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-background px-3 text-sm text-muted">
                  <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                  Checking workspace
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setStatus("loading");
                    setRefreshVersion((version) => version + 1);
                  }}
                  className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-background px-3 text-sm font-semibold transition hover:bg-surface-raised"
                >
                  <RefreshCw size={15} aria-hidden="true" />
                  Refresh setup
                </button>
              )}
            </div>

            <div className="mt-6 rounded-lg border border-line bg-background p-5">
              {status === "error" ? (
                <div role="alert">
                  <p className="font-semibold">Setup status partially unavailable.</p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Existing progress is shown where available. Refresh when the workspace is healthy.
                  </p>
                </div>
              ) : !session?.authEnabled ? (
                <div>
                  <p className="font-semibold">Local workspace</p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Authentication is disabled. Workspace controls use the configured local role.
                  </p>
                  <Link href="/app" className="mt-4 inline-flex text-sm font-semibold text-primary hover:underline">
                    Open workspace
                  </Link>
                </div>
              ) : session?.authenticated ? (
                <div>
                  <p className="font-semibold">{session.tenant?.name || session.tenant?.slug || "Workspace"}</p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    {session.user?.email || "Authenticated operator"} · {session.membership?.role || "member"}
                  </p>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <LockKeyhole size={18} className="mt-1 text-warning" aria-hidden="true" />
                  <div>
                    <p className="font-semibold">Sample onboarding is active.</p>
                    <p className="mt-2 text-sm leading-6 text-muted">
                      Sign in to load protected telemetry and save operational setup decisions.
                    </p>
                    <Link href="/login" className="mt-4 inline-flex text-sm font-semibold text-primary hover:underline">
                      Sign in to continue
                    </Link>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-6 space-y-3">
              {activationSteps.map((step, index) => (
                <div key={step.title} className="rounded-lg border border-line bg-background p-4">
                  <div className="flex items-start gap-4">
                    <span
                      className={completed[index] ? "mt-1 grid size-7 place-items-center rounded-md bg-primary text-primary-ink" : "mt-1 grid size-7 place-items-center rounded-md border border-line text-muted"}
                      aria-label={completed[index] ? `${step.title} complete` : `${step.title} not complete`}
                      role="img"
                    >
                      {completed[index] ? <CheckCircle2 size={16} aria-hidden="true" /> : <Circle size={12} aria-hidden="true" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{step.title}</p>
                      <p className="mt-2 text-sm leading-6 text-muted">{step.body}</p>
                      <Link href={step.href} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline">
                        Open surface
                        <ArrowRight size={14} aria-hidden="true" />
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
