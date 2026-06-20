import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  CircuitBoard,
  LockKeyhole,
  Network,
  Play,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  capabilityMatrix,
  operatingModes,
  orchestrationJourney,
  platformPillars,
  proofMetrics,
} from "@/lib/navigation";
import { PublicHeader } from "@/components/marketing/public-header";

async function fetchHealthStatus(): Promise<"healthy" | "degraded" | "unhealthy" | "unknown"> {
  try {
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : "http://localhost:3000");
    const res = await fetch(`${baseUrl}/api/health`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "unknown";
    const data = (await res.json()) as { status?: string };
    const s = data.status;
    if (s === "healthy" || s === "degraded" || s === "unhealthy") return s;
    return "unknown";
  } catch {
    return "unknown";
  }
}

const workflowSteps = [
  "Goal",
  "Plan",
  "Memory",
  "Tools",
  "Workflow",
  "Evaluate",
  "Release",
];

const enterpriseControls = [
  "Forced tenant row-level security",
  "Governed tool execution with approval gates",
  "Release evidence with SLO and eval proof",
  "Connector network and secret controls",
];

export async function LandingPage() {
  const healthStatus = await fetchHealthStatus();
  const signalRail = [
    {
      label: "Health",
      value: healthStatus,
      tone: healthStatus === "healthy" ? "success" : healthStatus === "degraded" ? "warning" : "neutral",
    },
    { label: "Release gate", value: "active", tone: "neutral" },
    { label: "Store", value: "Postgres", tone: "neutral" },
    { label: "Vector", value: "HNSW", tone: "neutral" },
    { label: "OpenAI", value: "wired", tone: "neutral" },
    { label: "Auth", value: "enforced", tone: "neutral" },
  ] as const;

  return (
    <main className="min-h-screen overflow-hidden bg-background text-foreground">
      <PublicHeader />

      <section className="relative min-h-[calc(100svh-0px)] overflow-hidden pt-16">
        <Image
          src="/omniagent-command-center.png"
          alt="OmniAgentOS production command center showing release health, memory, workflows, observability, and governed tools."
          fill
          priority
          sizes="100vw"
          className="animate-drift object-cover object-[58%_50%] opacity-42 dark:opacity-50"
        />
        <div className="hero-scrim absolute inset-0" />
        <div className="relative z-10 mx-auto flex min-h-[calc(100svh-4rem)] max-w-7xl items-center px-4 pb-16 pt-12 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="animate-rise inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-sm font-medium text-white backdrop-blur">
              <Sparkles size={15} aria-hidden="true" />
              Public enterprise AI orchestration platform
            </p>
            <h1 className="animate-rise mt-7 max-w-3xl text-5xl font-semibold tracking-normal text-white sm:text-7xl lg:text-8xl">
              OmniAgentOS
            </h1>
            <p className="animate-rise-delay mt-6 max-w-2xl text-lg leading-8 text-white/78 sm:text-xl">
              Build, govern, remember, retrieve, execute, observe, and release AI agents from one production control plane.
            </p>
            <div className="animate-rise-delay mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/demo"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-ink transition hover:brightness-105 focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                Try demo workspace
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
              <Link
                href="/platform"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-white/18 bg-white/10 px-5 text-sm font-semibold text-white backdrop-blur transition hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-white/30"
              >
                View platform
                <Play size={16} aria-hidden="true" />
              </Link>
            </div>
            <div className="animate-rise-delay mt-10 grid max-w-2xl grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/14 bg-white/14 backdrop-blur sm:grid-cols-3">
              {signalRail.map((signal) => (
                <div key={signal.label} className="bg-black/24 px-4 py-3">
                  <p className="text-xs text-white/56">{signal.label}</p>
                  <p className={signal.tone === "success" ? "mt-1 font-mono text-sm text-primary" : signal.tone === "warning" ? "mt-1 font-mono text-sm text-amber-400" : "mt-1 font-mono text-sm text-white"}>
                    {signal.value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-surface/72">
        <div className="mx-auto grid max-w-7xl grid-cols-2 divide-x divide-y divide-line sm:grid-cols-4 sm:divide-y-0">
          {proofMetrics.map((metric) => (
            <div key={metric.label} className="px-4 py-6 sm:px-6 lg:px-8">
              <p className="font-mono text-2xl text-foreground">{metric.value}</p>
              <p className="mt-1 text-sm text-muted">{metric.label}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-b border-line bg-background">
        <div className="mx-auto grid max-w-7xl gap-px overflow-hidden border-x border-line bg-line md:grid-cols-3">
          {operatingModes.map((mode) => (
            <article key={mode.label} className="bg-background p-6 sm:p-8">
              <p className="font-mono text-sm text-primary">{mode.label}</p>
              <p className="mt-12 max-w-sm text-lg leading-7">{mode.value}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Platform</p>
            <h2 className="mt-4 max-w-xl text-4xl font-semibold tracking-normal sm:text-5xl">
              One operating layer for serious AI work.
            </h2>
          </div>
          <p className="max-w-2xl text-lg leading-8 text-muted">
            OmniAgentOS turns disconnected AI features into a governed system: goals become plans, plans use memory and tools, execution is observable, and release readiness is proven.
          </p>
        </div>

        <div className="mt-16 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2 lg:grid-cols-4">
          {platformPillars.map((pillar) => {
            const Icon = pillar.icon;
            return (
              <article key={pillar.title} className="group min-h-64 bg-surface p-6 transition hover:bg-surface-raised">
                <div className="grid size-11 place-items-center rounded-md bg-primary/12 text-primary transition group-hover:scale-105">
                  <Icon size={20} aria-hidden="true" />
                </div>
                <h3 className="mt-8 text-xl font-semibold">{pillar.title}</h3>
                <p className="mt-3 text-sm leading-6 text-muted">{pillar.body}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
          <div className="grid gap-12 lg:grid-cols-[0.72fr_1.28fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Capability matrix</p>
              <h2 className="mt-4 max-w-xl text-4xl font-semibold tracking-normal sm:text-5xl">
                A full stack for agentic operations.
              </h2>
              <p className="mt-6 max-w-xl text-base leading-7 text-muted">
                Each layer is built as an operational subsystem, so the product can move from showcase to production without swapping foundations.
              </p>
            </div>
            <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
              {capabilityMatrix.map(([label, body]) => (
                <div key={label} className="group bg-background p-5 transition hover:bg-surface-raised">
                  <p className="font-mono text-sm text-primary">{label}</p>
                  <p className="mt-8 text-sm leading-6 text-muted">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
          <div className="grid gap-12 lg:grid-cols-[0.72fr_1.28fr] lg:items-center">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Workflow</p>
              <h2 className="mt-4 text-4xl font-semibold tracking-normal sm:text-5xl">
                From prompt to proof, every step has a state.
              </h2>
            </div>
            <div className="overflow-x-auto">
              <div className="grid min-w-[760px] grid-cols-7 rounded-lg border border-line bg-background">
                {workflowSteps.map((step, index) => (
                  <div key={step} className="relative min-h-40 border-r border-line p-4 last:border-r-0">
                    <p className="font-mono text-xs text-muted">0{index + 1}</p>
                    <p className="mt-12 text-lg font-semibold">{step}</p>
                    {index < workflowSteps.length - 1 ? (
                      <span className="absolute right-3 top-5 text-muted" aria-hidden="true">
                        →
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[0.75fr_1.25fr]">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Agent lifecycle</p>
            <h2 className="mt-4 text-4xl font-semibold tracking-normal sm:text-5xl">
              The system remembers what happened after every run.
            </h2>
          </div>
          <div className="space-y-4">
            {orchestrationJourney.map((item, index) => (
              <article key={item.title} className="group rounded-lg border border-line bg-surface p-6 transition hover:border-primary/40 hover:bg-surface-raised">
                <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="font-mono text-sm text-primary">0{index + 1}</p>
                    <h3 className="mt-4 text-2xl font-semibold">{item.title}</h3>
                    <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">{item.body}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {item.signals.map((signal) => (
                      <span key={signal} className="rounded-full border border-line bg-background px-3 py-1 font-mono text-xs text-muted">
                        {signal}
                      </span>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div className="relative min-h-[420px] overflow-hidden rounded-lg border border-line bg-surface subtle-grid">
            <div className="absolute inset-x-8 top-10 rounded-md border border-line bg-background/86 p-5 backdrop-blur">
              <div className="flex items-center justify-between border-b border-line pb-4">
                <div>
                  <p className="text-sm text-muted">Release evidence</p>
                  <p className="mt-1 text-2xl font-semibold">Passed</p>
                </div>
                <CheckCircle2 className="text-success" size={28} aria-hidden="true" />
              </div>
              <div className="mt-5 grid grid-cols-3 gap-3">
                {["Tenant RLS", "SLO", "Signing"].map((item) => (
                  <div key={item} className="rounded-md border border-line bg-surface px-3 py-4">
                    <p className="text-xs text-muted">{item}</p>
                    <p className="mt-2 font-mono text-sm text-success">pass</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="absolute bottom-8 left-8 right-8 grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-line bg-background/86 p-4 backdrop-blur">
                <Network className="text-primary" size={18} aria-hidden="true" />
                <p className="mt-4 text-sm font-semibold">Connector guardrails</p>
              </div>
              <div className="rounded-md border border-line bg-background/86 p-4 backdrop-blur">
                <CircuitBoard className="text-accent" size={18} aria-hidden="true" />
                <p className="mt-4 text-sm font-semibold">Memory provenance</p>
              </div>
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Enterprise</p>
            <h2 className="mt-4 text-4xl font-semibold tracking-normal sm:text-5xl">
              Governance is part of the runtime, not a bolt-on.
            </h2>
            <p className="mt-6 text-lg leading-8 text-muted">
              The platform is built for agentic work that touches real systems: tenant data, external APIs, durable workflows, and operational release gates.
            </p>
            <div className="mt-8 grid gap-3">
              {enterpriseControls.map((control) => (
                <div key={control} className="flex items-center gap-3 border-b border-line py-4">
                  <ShieldCheck size={18} className="text-primary" aria-hidden="true" />
                  <span className="text-sm font-medium">{control}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-line bg-foreground text-background">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-16 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div>
            <LockKeyhole size={24} aria-hidden="true" />
            <h2 className="mt-4 text-3xl font-semibold tracking-normal">Run the control plane.</h2>
            <p className="mt-3 max-w-2xl text-sm opacity-72">
              Open the production app, inspect release evidence, and continue building from the enterprise shell.
            </p>
          </div>
          <Link
            href="/onboarding"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-background px-5 text-sm font-semibold text-foreground transition hover:opacity-90"
          >
            Start onboarding
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </section>
    </main>
  );
}
