"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  AlertTriangle,
  Brain,
  Cable,
  CheckCircle2,
  Database,
  GitBranch,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";

type DashboardSnapshot = {
  health: "healthy" | "degraded" | "unhealthy" | "unknown";
  releaseGate: "passed" | "warning" | "blocked" | "unknown";
  storageBackend: string;
  openaiConfigured: boolean;
  memoryTotal: number;
  workflowsActive: number;
  approvals: number;
  connectors: number;
  incidents: number;
  authFailures: number;
  routeFailures: number;
  availability: number;
};

const fallbackSnapshot: DashboardSnapshot = {
  health: "unknown",
  releaseGate: "unknown",
  storageBackend: "unknown",
  openaiConfigured: false,
  memoryTotal: 0,
  workflowsActive: 0,
  approvals: 0,
  connectors: 0,
  incidents: 0,
  authFailures: 0,
  routeFailures: 0,
  availability: 1,
};

const primaryMetrics = [
  { key: "releaseGate", label: "Release", icon: CheckCircle2 },
  { key: "health", label: "Health", icon: Activity },
  { key: "storageBackend", label: "Store", icon: Database },
  { key: "memoryTotal", label: "Memory", icon: Brain },
] as const;

const operationalMetrics = [
  { key: "workflowsActive", label: "Active workflows", icon: Workflow },
  { key: "approvals", label: "Approvals", icon: ShieldCheck },
  { key: "connectors", label: "Connectors", icon: Cable },
  { key: "incidents", label: "Incidents", icon: AlertTriangle },
] as const;

const releaseChain = ["Auth", "Tenant RLS", "SLO", "Eval", "Signing", "Deploy"];

const operatingLanes = [
  {
    title: "Build",
    body: "Create goals, plans, memory, connectors, and workflows from the command center.",
    icon: Sparkles,
  },
  {
    title: "Govern",
    body: "Approve risky execution, inspect tenant isolation, and keep audit evidence intact.",
    icon: LockKeyhole,
  },
  {
    title: "Operate",
    body: "Watch health, incidents, SLO pressure, release evidence, and workflow recovery.",
    icon: GitBranch,
  },
];

export function DashboardOverview() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(fallbackSnapshot);
  const [status, setStatus] = useState("Loading production snapshot.");

  useEffect(() => {
    let canceled = false;

    async function load() {
      try {
        const session = await readJson("/api/auth/session");
        const publicHealth = await readJson("/api/health");

        if (!session.authenticated) {
          if (!canceled) {
            setSnapshot((current) => ({
              ...current,
              health: normalizeStatus(publicHealth.status),
            }));
            setStatus("Sign in from the command center to load protected production telemetry.");
          }
          return;
        }

        const [health, release, capabilities, observability, workflows, approvals, connectors, incidents] = await Promise.all([
          readJson("/api/health"),
          readJson("/api/release/evidence"),
          readJson("/api/capabilities"),
          readJson("/api/observability"),
          readJson("/api/workflows"),
          readJson("/api/approvals"),
          readJson("/api/connectors"),
          readJson("/api/incidents?status=active&limit=8"),
        ]);

        if (canceled) {
          return;
        }

        setSnapshot({
          health: normalizeStatus(health.status),
          releaseGate: normalizeReleaseGate(release.report?.releaseGate?.status),
          storageBackend: String(capabilities.storageBackend || "unknown"),
          openaiConfigured: Boolean(capabilities.openaiConfigured),
          memoryTotal: Number(capabilities.memory?.total || 0),
          workflowsActive: Number(workflows.stats?.active || 0),
          approvals: Number(approvals.stats?.total || approvals.items?.length || 0),
          connectors: Number(connectors.stats?.active || connectors.connectors?.length || 0),
          incidents: Number(incidents.stats?.active || 0),
          authFailures: Number(observability.stats?.authFailures || 0),
          routeFailures: Number(observability.stats?.routeFailures || 0),
          availability: Number(observability.stats?.slo?.availability || 1),
        });
        setStatus("Live production snapshot.");
      } catch (error) {
        if (!canceled) {
          setStatus(error instanceof Error ? error.message : "Snapshot unavailable.");
        }
      }
    }

    void load();
    return () => {
      canceled = true;
    };
  }, []);

  const posture = useMemo(() => {
    if (snapshot.health === "healthy" && snapshot.releaseGate === "passed" && snapshot.routeFailures === 0) {
      return "Operational";
    }

    if (snapshot.releaseGate === "blocked" || snapshot.health === "unhealthy") {
      return "Intervention";
    }

    return "Watch";
  }, [snapshot]);

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <section className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="min-h-96 rounded-lg border border-line bg-surface p-6 sm:p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Overview</p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-normal sm:text-5xl">
            Enterprise AI operations cockpit.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-muted">
            Monitor release readiness, health, memory, workflows, approvals, connectors, incidents, and live SLO posture from one surface.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/onboarding"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105"
            >
              Continue onboarding
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <Link
              href="/demo"
              className="inline-flex h-11 items-center justify-center rounded-md border border-line bg-background px-4 text-sm font-semibold transition hover:bg-surface-raised"
            >
              View demo mode
            </Link>
          </div>
          <div className="mt-10 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
            {primaryMetrics.map((metric) => {
              const Icon = metric.icon;
              return (
                <div key={metric.key} className="bg-background p-5">
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <Icon size={16} aria-hidden="true" />
                    {metric.label}
                  </div>
                  <p className="mt-5 font-mono text-2xl text-foreground">{formatValue(snapshot[metric.key])}</p>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border border-line bg-foreground p-6 text-background sm:p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.22em] opacity-68">Posture</p>
          <p className="mt-4 text-5xl font-semibold tracking-normal">{posture}</p>
          <p className="mt-5 text-sm leading-6 opacity-72">{status}</p>
          <div className="mt-10 space-y-4">
            <StatusRow label="OpenAI" value={snapshot.openaiConfigured ? "Live" : "Fallback"} good={snapshot.openaiConfigured} />
            <StatusRow label="Availability" value={`${Math.round(snapshot.availability * 10000) / 100}%`} good={snapshot.availability >= 0.995} />
            <StatusRow label="Auth failures" value={`${snapshot.authFailures}`} good={snapshot.authFailures === 0} />
            <StatusRow label="Route failures" value={`${snapshot.routeFailures}`} good={snapshot.routeFailures === 0} />
          </div>
        </div>
      </section>

      <section className="mt-6 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4">
        {operationalMetrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div key={metric.key} className="min-h-44 bg-surface p-5">
              <Icon size={18} className="text-primary" aria-hidden="true" />
              <p className="mt-10 text-sm text-muted">{metric.label}</p>
              <p className="mt-2 font-mono text-3xl">{formatValue(snapshot[metric.key])}</p>
            </div>
          );
        })}
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-lg border border-line bg-surface p-6">
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Release chain</p>
          <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
            {releaseChain.map((item, index) => (
              <div key={item} className="min-h-32 bg-background p-4">
                <p className="font-mono text-xs text-muted">0{index + 1}</p>
                <p className="mt-8 text-sm font-semibold">{item}</p>
                <p className="mt-2 font-mono text-xs text-success">{snapshot.releaseGate === "passed" ? "ready" : "pending"}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
          {operatingLanes.map((lane) => {
            const Icon = lane.icon;
            return (
              <article key={lane.title} className="min-h-64 bg-surface p-6">
                <Icon size={18} className="text-primary" aria-hidden="true" />
                <h2 className="mt-12 text-xl font-semibold">{lane.title}</h2>
                <p className="mt-3 text-sm leading-6 text-muted">{lane.body}</p>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function StatusRow({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-background/18 pb-4">
      <span className="text-sm opacity-72">{label}</span>
      <span className={good ? "font-mono text-sm text-primary" : "font-mono text-sm text-warning"}>{value}</span>
    </div>
  );
}

async function readJson(path: string) {
  const response = await fetch(path, { headers: { "content-type": "application/json" } });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json();
}

function normalizeStatus(value: unknown): DashboardSnapshot["health"] {
  return value === "healthy" || value === "degraded" || value === "unhealthy" ? value : "unknown";
}

function normalizeReleaseGate(value: unknown): DashboardSnapshot["releaseGate"] {
  return value === "passed" || value === "warning" || value === "blocked" ? value : "unknown";
}

function formatValue(value: string | number | boolean) {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }

  return String(value);
}
