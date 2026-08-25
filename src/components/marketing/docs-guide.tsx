import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Brain,
  Cable,
  CheckCircle2,
  Database,
  KeyRound,
  Layers3,
  LockKeyhole,
  Play,
  Route,
  ShieldCheck,
  TerminalSquare,
  Workflow,
  Wrench,
} from "lucide-react";
import { PublicHeader } from "@/components/marketing/public-header";
import { appNav, productPages } from "@/lib/navigation";

const guideNav = [
  ["Start", "#start"],
  ["Flow", "#flow"],
  ["Features", "#features"],
  ["Use cases", "#use-cases"],
  ["APIs", "#api-map"],
  ["Checklist", "#checklist"],
];

const quickStart = [
  {
    title: "Explore safely",
    href: "/demo",
    action: "Open demo",
    body: "Use the sample workspace to see how a goal becomes memory-backed, approval-aware, auditable agent work.",
    icon: Play,
  },
  {
    title: "Enter the private workspace",
    href: "/login",
    action: "Sign in",
    body: "Use the configured owner account to continue into the operating workspace.",
    icon: KeyRound,
  },
  {
    title: "Operate from the app",
    href: "/app",
    action: "Open app",
    body: "Use the dashboard and command center for live health, release readiness, workflows, approvals, and observability.",
    icon: Activity,
  },
];

const operatingFlow = [
  ["01", "Goal", "Operator submits intent in Command or Demo.", TerminalSquare],
  ["02", "Identity", "Session, tenant, actor, and role are resolved.", LockKeyhole],
  ["03", "Context", "Memory, RAG chunks, graph hints, and run history are assembled.", Brain],
  ["04", "Plan", "The goal becomes workflow nodes with risk and verification.", Workflow],
  ["05", "Tools", "MCP, OpenAPI, and internal tools are classified before side effects.", Wrench],
  ["06", "Approval", "Risky work pauses for human or policy approval.", ShieldCheck],
  ["07", "Observe", "Runtime events, SLOs, incidents, alerts, and diagnostics are recorded.", Layers3],
  ["08", "Release", "Evaluation reports and release gates prove production readiness.", CheckCircle2],
  ["09", "Learn", "Useful results can become durable memory and future context.", Database],
] as const;

const commandModes = [
  ["Orchestrate", "Turn a goal into a governed plan, workflow, tool calls, evidence, and memory updates."],
  ["Research", "Use RAG, memory, source chunks, and graph context to answer questions with provenance."],
  ["Execute", "Run approved tools, dry runs, connector operations, and workflow ticks with audit records."],
  ["Learn", "Capture successful outcomes as durable memory, reusable plans, and operational knowledge."],
];

const userSurfaces = [
  ["/", "Public product homepage"],
  ["/platform", "Platform overview and product architecture"],
  ["/solutions", "Use cases and deployment patterns"],
  ["/security", "Security, governance, and compliance posture"],
  ["/pricing", "Commercial packaging placeholder"],
  ["/docs", "This complete product guide"],
  ["/changelog", "Shipped slices and platform progress"],
  ["/demo", "Public sample workspace"],
  ["/login", "Secure session sign in"],
  ["/app", "Authenticated operations dashboard"],
  ["/app/command", "Goal entry and command center"],
  ["/app/memory", "Memory, RAG, graph, and provenance"],
  ["/app/workflows", "Durable workflows, queues, approvals, and recovery"],
  ["/app/connectors", "MCP and OpenAPI connector management"],
  ["/app/tools", "Governed tool execution and audit"],
  ["/app/evaluations", "Regression runs, signed reports, and release gates"],
  ["/app/observability", "Runtime events, SLOs, incidents, and alerts"],
  ["/app/security", "Tenant isolation, auth posture, and audit controls"],
  ["/app/settings", "Runtime, environment, tenant, and model posture"],
];

const useCases = [
  {
    title: "Research and knowledge work",
    outcome: "Ask complex questions over source-backed memory and preserve useful answers.",
    flow: ["Ingest documents", "Retrieve with RAG", "Summarize with provenance", "Save durable memory"],
  },
  {
    title: "Operations automation",
    outcome: "Turn repeatable operational tasks into auditable workflows with approvals.",
    flow: ["Submit goal", "Plan workflow", "Run safe tools", "Recover or approve"],
  },
  {
    title: "Customer support agents",
    outcome: "Retrieve policy, inspect history, draft responses, and escalate risky actions.",
    flow: ["Load ticket", "Retrieve policy", "Draft answer", "Request approval"],
  },
  {
    title: "Security and compliance",
    outcome: "Track tenant isolation, auth failures, policy blocks, and signed release evidence.",
    flow: ["Inspect context", "Run eval", "Review audit", "Gate release"],
  },
  {
    title: "Connector-driven work",
    outcome: "Register external APIs without exposing platform secrets or private networks.",
    flow: ["Import spec", "Classify risk", "Dry run operation", "Execute with audit"],
  },
  {
    title: "Release readiness",
    outcome: "Use smoke tests, SLO snapshots, evaluation reports, and signing gates before deploys.",
    flow: ["Run smoke", "Check SLO", "Verify report", "Approve release"],
  },
];

const apiGroups = [
  {
    title: "Auth and identity",
    icon: KeyRound,
    routes: [
      "/api/auth/login",
      "/api/auth/logout",
      "/api/auth/session",
      "/api/auth/control-plane",
    ],
  },
  {
    title: "Agent, memory, RAG, and knowledge",
    icon: Brain,
    routes: [
      "/api/agent",
      "/api/memory",
      "/api/memory/graph",
      "/api/knowledge",
      "/api/ingest",
      "/api/retrieval/plan",
      "/api/runs",
      "/api/capabilities",
    ],
  },
  {
    title: "Workflows, triggers, approvals, and operations",
    icon: Workflow,
    routes: [
      "/api/workflows",
      "/api/workflows/[id]",
      "/api/workflows/[id]/tick",
      "/api/workflows/[id]/signal",
      "/api/workflows/executions",
      "/api/workflows/plan",
      "/api/workflows/tick",
      "/api/triggers",
      "/api/triggers/[id]/dispatch",
      "/api/approvals",
      "/api/approvals/[id]",
      "/api/operations",
    ],
  },
  {
    title: "Connectors and governed tools",
    icon: Cable,
    routes: [
      "/api/connectors",
      "/api/connectors/[id]",
      "/api/connectors/[id]/discover",
      "/api/openapi-connectors",
      "/api/openapi-connectors/[id]",
      "/api/openapi-connectors/[id]/import",
      "/api/connection-catalog",
      "/api/tools",
      "/api/tools/execute",
    ],
  },
  {
    title: "Evaluation, release, observability, and incidents",
    icon: Layers3,
    routes: [
      "/api/evaluations",
      "/api/evaluations/[id]",
      "/api/evaluations/[id]/report",
      "/api/evaluations/[id]/report/verify",
      "/api/release/evidence",
      "/api/observability",
      "/api/observability/slo",
      "/api/observability/slo/policies",
      "/api/incidents",
      "/api/incidents/[id]",
      "/api/incidents/[id]/actions",
      "/api/alerts",
      "/api/diagnostics",
      "/api/health",
    ],
  },
  {
    title: "Security and tenant isolation",
    icon: ShieldCheck,
    routes: [
      "/api/security/context",
      "/api/security/audits",
      "/api/security/isolation-report",
    ],
  },
];

const productionChecklist = [
  "Set production secrets in Vercel: OpenAI, database, auth bootstrap, cron, internal smoke, and signing values.",
  "Confirm /api/health returns healthy before inviting operators.",
  "Run Production Smoke after every deployment and inspect release evidence.",
  "Use demo mode for prospects and dashboard readiness for new workspaces before connecting real systems.",
  "Register one connector at a time, start with dry runs, and require approval for high-risk operations.",
  "Review SLO warnings after smoke tests; cold-start latency warnings can be advisory when availability and errors are clean.",
  "Keep access requests separate from real account creation until admin invitation, billing, and SSO policies are finalized.",
  "Check observability, incidents, alert deliveries, and workflow queues after smoke runs or high-risk demos.",
];

export function DocsGuide() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <PublicHeader />

      <section id="start" className="border-b border-line pt-16">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[0.78fr_1.22fr] lg:px-8">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Product guide</p>
            <h1 className="mt-4 max-w-3xl text-5xl font-semibold tracking-normal sm:text-7xl">
              How to use Asael.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted">
              A complete operating manual for the public site, dashboard readiness, command center, memory, workflows, connectors, governed tools, evaluations, observability, security, and production release gates.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/login"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-ink transition hover:brightness-105"
              >
                Sign in
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
              <Link
                href="/demo"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-line bg-surface px-5 text-sm font-semibold transition hover:bg-surface-raised"
              >
                Try demo
                <Play size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div className="rounded-lg border border-line bg-foreground p-5 text-background sm:p-6">
            <div className="flex items-center justify-between border-b border-background/14 pb-5">
              <div>
                <p className="text-sm opacity-64">System map</p>
                <p className="mt-1 text-2xl font-semibold">From request to release evidence</p>
              </div>
              <Route size={24} className="text-primary" aria-hidden="true" />
            </div>
            <div className="mt-6 grid gap-px overflow-hidden rounded-lg border border-background/14 bg-background/14 sm:grid-cols-3">
              {operatingFlow.map(([index, title, body, Icon]) => (
                <div key={title} className="min-h-40 bg-background/8 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-mono text-xs opacity-56">{index}</p>
                    <Icon size={16} className="text-primary" aria-hidden="true" />
                  </div>
                  <p className="mt-8 text-base font-semibold">{title}</p>
                  <p className="mt-3 text-xs leading-5 opacity-70">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <nav className="sticky top-16 z-20 border-b border-line bg-background/86 backdrop-blur-xl" aria-label="Guide sections">
        <div className="mx-auto flex max-w-7xl gap-2 overflow-x-auto px-4 py-3 sm:px-6 lg:px-8">
          {guideNav.map(([label, href]) => (
            <a key={href} href={href} className="shrink-0 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-muted transition hover:border-primary/50 hover:text-foreground">
              {label}
            </a>
          ))}
        </div>
      </nav>

      <section className="border-b border-line bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Quick path</p>
              <h2 className="mt-4 text-4xl font-semibold tracking-normal sm:text-5xl">Start with the safest path to value.</h2>
              <p className="mt-5 text-base leading-7 text-muted">
                New users should understand the product in demo mode, sign in with owner access, then follow readiness from the dashboard and command center.
              </p>
            </div>
            <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2">
              {quickStart.map((step, index) => {
                const Icon = step.icon;
                return (
                  <Link key={step.title} href={step.href} className="group min-h-72 bg-background p-6 transition hover:bg-surface-raised">
                    <div className="flex items-center justify-between">
                      <p className="font-mono text-sm text-muted">0{index + 1}</p>
                      <Icon size={20} className="text-primary" aria-hidden="true" />
                    </div>
                    <h3 className="mt-12 text-2xl font-semibold tracking-normal">{step.title}</h3>
                    <p className="mt-4 text-sm leading-6 text-muted">{step.body}</p>
                    <p className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-primary">
                      {step.action}
                      <ArrowRight size={14} className="transition group-hover:translate-x-1" aria-hidden="true" />
                    </p>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section id="flow" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
          <div className="lg:sticky lg:top-36">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">App flow</p>
            <h2 className="mt-4 text-4xl font-semibold tracking-normal sm:text-5xl">The workspace has one main loop.</h2>
            <p className="mt-5 text-base leading-7 text-muted">
              Every serious task should pass through identity, context, planning, governed execution, observability, release evidence, and memory.
            </p>
          </div>
          <div className="space-y-4">
            {operatingFlow.map(([index, title, body, Icon]) => (
              <article key={title} className="rounded-lg border border-line bg-surface p-5 transition hover:border-primary/40 hover:bg-surface-raised">
                <div className="flex gap-5">
                  <div className="grid size-12 shrink-0 place-items-center rounded-md bg-primary/12 text-primary">
                    <Icon size={20} aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-mono text-sm text-primary">{index}</p>
                    <h3 className="mt-2 text-2xl font-semibold tracking-normal">{title}</h3>
                    <p className="mt-3 text-sm leading-6 text-muted">{body}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-foreground text-background">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[0.75fr_1.25fr] lg:px-8">
          <div>
            <TerminalSquare size={24} className="text-primary" aria-hidden="true" />
            <p className="mt-8 text-sm font-semibold uppercase tracking-[0.22em] opacity-68">Command center</p>
            <h2 className="mt-4 text-4xl font-semibold tracking-normal sm:text-5xl">Use Command when you want the system to act.</h2>
            <p className="mt-5 text-base leading-7 opacity-72">
              The command center is the working surface for goals, modes, context, tool calls, approvals, run history, and execution evidence.
            </p>
            <Link href="/app/command" className="mt-8 inline-flex h-11 items-center gap-2 rounded-md bg-background px-4 text-sm font-semibold text-foreground transition hover:opacity-90">
              Open command center
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
          <div className="grid gap-px overflow-hidden rounded-lg border border-background/14 bg-background/14 sm:grid-cols-2">
            {commandModes.map(([mode, body]) => (
              <div key={mode} className="min-h-56 bg-background/8 p-5">
                <p className="font-mono text-sm text-primary">{mode}</p>
                <p className="mt-12 text-sm leading-6 opacity-76">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[0.72fr_1.28fr]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Feature guide</p>
            <h2 className="mt-4 text-4xl font-semibold tracking-normal sm:text-5xl">Every feature and what to use it for.</h2>
            <p className="mt-5 text-base leading-7 text-muted">
              Use the app surfaces as a sequence: dashboard for posture, command for work, memory and connectors for inputs, tools and workflows for action, evaluations and observability for proof, security and settings for control.
            </p>
          </div>
          <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2">
            {appNav.map((item) => {
              const Icon = item.icon;
              const key = item.href.split("/").pop() || "overview";
              const product = productPages[key];
              return (
                <Link key={item.href} href={item.href} className="group bg-surface p-5 transition hover:bg-surface-raised">
                  <div className="flex items-center justify-between gap-4">
                    <div className="grid size-10 place-items-center rounded-md bg-primary/12 text-primary">
                      <Icon size={18} aria-hidden="true" />
                    </div>
                    <ArrowRight size={15} className="text-muted transition group-hover:translate-x-1 group-hover:text-primary" aria-hidden="true" />
                  </div>
                  <h3 className="mt-8 text-xl font-semibold">{item.label}</h3>
                  <p className="mt-3 text-sm leading-6 text-muted">{item.description}</p>
                  {product ? (
                    <div className="mt-6 flex flex-wrap gap-2">
                      {product.metrics.map((metric) => (
                        <span key={metric.label} className="rounded-full border border-line bg-background px-3 py-1 font-mono text-xs text-muted">
                          {metric.label}: {metric.value}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-6 flex flex-wrap gap-2">
                      <span className="rounded-full border border-line bg-background px-3 py-1 font-mono text-xs text-muted">posture</span>
                      <span className="rounded-full border border-line bg-background px-3 py-1 font-mono text-xs text-muted">health</span>
                      <span className="rounded-full border border-line bg-background px-3 py-1 font-mono text-xs text-muted">release</span>
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
          <div className="grid gap-12 lg:grid-cols-[0.75fr_1.25fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Routes</p>
              <h2 className="mt-4 text-4xl font-semibold tracking-normal sm:text-5xl">Where everything lives.</h2>
              <p className="mt-5 text-base leading-7 text-muted">
                The product is split into public education, private access, and authenticated operations.
              </p>
            </div>
            <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
              {userSurfaces.map(([routePath, description]) => (
                <Link key={routePath} href={routePath} className="group flex min-h-24 items-center justify-between gap-4 bg-background p-4 transition hover:bg-surface-raised">
                  <div className="min-w-0">
                    <p className="font-mono text-sm text-primary">{routePath}</p>
                    <p className="mt-2 text-sm leading-5 text-muted">{description}</p>
                  </div>
                  <ArrowRight size={14} className="shrink-0 text-muted transition group-hover:translate-x-1 group-hover:text-primary" aria-hidden="true" />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="use-cases" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[0.7fr_1.3fr]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Use cases</p>
            <h2 className="mt-4 text-4xl font-semibold tracking-normal sm:text-5xl">What teams can get done.</h2>
            <p className="mt-5 text-base leading-7 text-muted">
              Asael is useful whenever AI work needs memory, tools, approvals, repeatability, and production evidence.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {useCases.map((useCase) => (
              <article key={useCase.title} className="rounded-lg border border-line bg-surface p-5">
                <h3 className="text-xl font-semibold">{useCase.title}</h3>
                <p className="mt-3 text-sm leading-6 text-muted">{useCase.outcome}</p>
                <div className="mt-6 grid gap-px overflow-hidden rounded-md border border-line bg-line">
                  {useCase.flow.map((step, index) => (
                    <div key={step} className="flex items-center gap-3 bg-background px-3 py-3 text-sm">
                      <span className="font-mono text-xs text-primary">0{index + 1}</span>
                      <span>{step}</span>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="api-map" className="border-y border-line bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
          <div className="grid gap-12 lg:grid-cols-[0.75fr_1.25fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">API map</p>
              <h2 className="mt-4 text-4xl font-semibold tracking-normal sm:text-5xl">The backend surface behind the UI.</h2>
              <p className="mt-5 text-base leading-7 text-muted">
                These route handlers power the product. Anonymous users can access public surfaces; protected operational routes require session or trusted internal context.
              </p>
            </div>
            <div className="space-y-3">
              {apiGroups.map((group) => {
                const Icon = group.icon;
                return (
                  <details key={group.title} className="group rounded-lg border border-line bg-background p-5 open:bg-surface-raised">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                      <span className="flex items-center gap-3">
                        <span className="grid size-10 place-items-center rounded-md bg-primary/12 text-primary">
                          <Icon size={18} aria-hidden="true" />
                        </span>
                        <span className="font-semibold">{group.title}</span>
                      </span>
                      <span className="font-mono text-sm text-muted">{group.routes.length} routes</span>
                    </summary>
                    <div className="mt-5 grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2">
                      {group.routes.map((routePath) => (
                        <div key={routePath} className="bg-background px-3 py-3 font-mono text-xs text-muted">
                          {routePath}
                        </div>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section id="checklist" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[0.75fr_1.25fr]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Production checklist</p>
            <h2 className="mt-4 text-4xl font-semibold tracking-normal sm:text-5xl">Use this before and after every serious run.</h2>
            <p className="mt-5 text-base leading-7 text-muted">
              The app can connect to real systems, so the operating discipline matters as much as the model output.
            </p>
          </div>
          <div className="rounded-lg border border-line bg-surface p-5 sm:p-6">
            <div className="grid gap-3">
              {productionChecklist.map((item, index) => (
                <div key={item} className="flex items-start gap-4 border-b border-line pb-4 last:border-b-0 last:pb-0">
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/12 font-mono text-xs text-primary">
                    {index + 1}
                  </span>
                  <p className="text-sm leading-6 text-muted">{item}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-line bg-foreground text-background">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_auto] lg:items-center lg:px-8">
          <div>
            <BookOpen size={24} className="text-primary" aria-hidden="true" />
            <h2 className="mt-4 text-3xl font-semibold tracking-normal">Run the guide with the product open.</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 opacity-72">
              Keep this page beside the app while you follow dashboard readiness, connect your first source, run your first workflow, and inspect release evidence.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link href="/app" className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-background px-5 text-sm font-semibold text-foreground transition hover:opacity-90">
              Open app
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
            <Link
              href="/login"
              className="inline-flex h-12 items-center justify-center rounded-md border border-background/20 px-5 text-sm font-semibold transition hover:bg-background/10"
            >
              Sign in
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
