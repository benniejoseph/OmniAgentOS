"use client";

import Link from "next/link";
import { ArrowRight, Brain, CheckCircle2, Loader2, LockKeyhole, Play, Workflow, Wrench } from "lucide-react";
import { useMemo, useState } from "react";

const demoSteps = [
  {
    label: "Goal",
    title: "Launch enterprise onboarding agent",
    body: "Capture objective, tenant, actor role, and operating constraints.",
    icon: Play,
  },
  {
    label: "Memory",
    title: "Assemble governed context",
    body: "Retrieve policies, prior runs, source chunks, and graph hints.",
    icon: Brain,
  },
  {
    label: "Workflow",
    title: "Create durable execution plan",
    body: "Split work into queued nodes with approval and recovery rules.",
    icon: Workflow,
  },
  {
    label: "Tools",
    title: "Classify side effects",
    body: "Dry-run connector actions before live operations are allowed.",
    icon: Wrench,
  },
  {
    label: "Proof",
    title: "Close with release evidence",
    body: "Record SLO, tenant isolation, signing, and audit status.",
    icon: CheckCircle2,
  },
];

const sampleSignals = [
  ["Tenant", "sample-enterprise"],
  ["Auth", "demo mode"],
  ["Memory", "23 chunks"],
  ["Risk", "approval gated"],
  ["Release", "passed"],
  ["SLO", "clear"],
];

export function DemoWorkspace() {
  const [active, setActive] = useState(0);
  const [running, setRunning] = useState(false);
  const progress = useMemo(() => Math.round(((active + 1) / demoSteps.length) * 100), [active]);

  async function runDemo() {
    setRunning(true);
    for (let index = active; index < demoSteps.length; index++) {
      setActive(index);
      await new Promise((resolve) => setTimeout(resolve, 460));
    }
    setRunning(false);
  }

  const step = demoSteps[active];
  const Icon = step.icon;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="border-b border-line pt-16">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[0.78fr_1.22fr] lg:px-8">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Demo workspace</p>
            <h1 className="mt-4 max-w-3xl text-5xl font-semibold tracking-normal sm:text-6xl">
              Experience the onboarding loop with sample data.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted">
              This public mode shows how goals become memory-backed, approval-aware, auditable agent work without touching private systems.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={runDemo}
                disabled={running}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {running ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                {running ? "Running demo" : "Run sample agent"}
              </button>
              <Link
                href="/signup"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-line bg-surface px-5 text-sm font-semibold transition hover:bg-surface-raised"
              >
                Request workspace
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div className="rounded-lg border border-line bg-surface p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4 border-b border-line pb-5">
              <div>
                <p className="text-sm text-muted">Sample run</p>
                <p className="mt-1 text-2xl font-semibold">Enterprise onboarding agent</p>
              </div>
              <div className="rounded-md border border-line bg-background px-3 py-2 font-mono text-sm text-primary">
                {progress}%
              </div>
            </div>

            <div className="mt-6 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-5">
              {demoSteps.map((item, index) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => setActive(index)}
                  className={index === active ? "bg-primary p-4 text-left text-primary-ink" : "bg-background p-4 text-left transition hover:bg-surface-raised"}
                >
                  <p className="font-mono text-xs opacity-70">0{index + 1}</p>
                  <p className="mt-8 text-sm font-semibold">{item.label}</p>
                </button>
              ))}
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
              <div className="rounded-lg border border-line bg-background p-5">
                <div className="grid size-12 place-items-center rounded-md bg-primary/12 text-primary">
                  <Icon size={22} aria-hidden="true" />
                </div>
                <h2 className="mt-8 text-2xl font-semibold tracking-normal">{step.title}</h2>
                <p className="mt-4 text-sm leading-6 text-muted">{step.body}</p>
              </div>

              <div className="rounded-lg border border-line bg-foreground p-5 text-background">
                <p className="text-sm font-semibold uppercase tracking-[0.22em] opacity-68">Sample signals</p>
                <div className="mt-6 grid gap-px overflow-hidden rounded-lg border border-background/14 bg-background/14 sm:grid-cols-2">
                  {sampleSignals.map(([label, value]) => (
                    <div key={label} className="bg-background/8 p-4">
                      <p className="text-xs opacity-60">{label}</p>
                      <p className="mt-2 font-mono text-sm">{value}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-6 flex items-start gap-3 border-t border-background/14 pt-5">
                  <LockKeyhole size={17} className="mt-0.5 text-primary" aria-hidden="true" />
                  <p className="text-sm leading-6 opacity-72">
                    Demo mode never executes external connectors or writes private tenant data.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
