import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Brain,
  Cable,
  CheckCircle2,
  Database,
  KeyRound,
  Layers3,
  LockKeyhole,
  Play,
  ShieldCheck,
  TerminalSquare,
  Workflow,
  Wrench,
} from "lucide-react";
import { PublicFrame } from "./public-frame";
import styles from "./public-surface.module.css";
import { appNav } from "@/lib/navigation";

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
    body: "Use an approved private account to open its isolated operating workspace.",
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
  ["01", "Goal", "An operator submits a goal in Assistant; Demo uses sample content.", TerminalSquare],
  ["02", "Identity", "Session, tenant, actor, and role are resolved.", LockKeyhole],
  ["03", "Context", "Memory, RAG chunks, graph hints, and run history are assembled.", Brain],
  ["04", "Plan", "The goal becomes workflow nodes with risk and verification.", Workflow],
  ["05", "Tools", "MCP, OpenAPI, and internal tools are classified before side effects.", Wrench],
  ["06", "Approval", "Risky work pauses for human or policy approval.", ShieldCheck],
  ["07", "Observe", "Runtime events, SLOs, incidents, alerts, and diagnostics are recorded.", Layers3],
  ["08", "Release", "Evaluation reports and release gates provide evidence for release review.", CheckCircle2],
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
  ["/pricing", "Private availability; no public plans or checkout"],
  ["/docs", "This complete product guide"],
  ["/changelog", "Shipped slices and platform progress"],
  ["/demo", "Public sample workspace"],
  ["/login", "Secure session sign in"],
  ["/app", "Authenticated operations dashboard"],
  ["/app/command", "Goal entry and command center"],
  ["/app/memory", "Memory, RAG, graph, and provenance"],
  ["/app/workflows", "Durable workflows, queues, approvals, and recovery"],
  ["/app/connectors", "MCP and OpenAPI connector management"],
  ["/app/automation", "Capabilities: Skills, Extensions, Connections, and tool risk audit"],
  ["/app/settings?section=quality", "Regression runs, signed reports, and release gates"],
  ["/app/settings?section=monitoring", "Runtime events, SLOs, incidents, and alerts"],
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
  "Use approved private accounts. This deployment does not offer public registration or commercial checkout.",
  "Check observability, incidents, alert deliveries, and workflow queues after smoke runs or high-risk demos.",
];

export function DocsGuide() {
  return <PublicFrame>
    <header id="start" className={styles.hero}><div className={styles.container}><div className={styles.heroContent}>
      <p className={styles.eyebrow}>Product guide</p><h1>How to use Asael.</h1>
      <p className={styles.reading}>A guide to Assistant, memory, workflows, connections, governed tools, evaluations, system health, and release evidence.</p>
      <div className={styles.actions}><Link href="/login" prefetch={false} className={styles.primaryButton}>Sign in</Link><Link href="/demo" prefetch={false} className={styles.button}>Explore simulated demo</Link></div>
      <p className={styles.support}>Private workspace links require an approved account. The demo uses sample content.</p>
    </div></div></header>
    <nav aria-label="Guide sections" className={`${styles.container} ${styles.sectionNav}`}>
      {guideNav.map(([label, href]) => <a key={href} href={href}>{label}</a>)}
    </nav>
    <section className={styles.section}><div className={`${styles.container} ${styles.split}`}>
      <header className={styles.sectionHeader}><p className={styles.eyebrow}>Quick start</p><h2>Explore, sign in, then operate.</h2><p className={styles.reading}>Try the sample workspace first. Approved users can then sign in to their own account.</p></header>
      <ol className={styles.steps}>{quickStart.map((step, index) => <li key={step.title}><span className={styles.step}>{index + 1}</span><Link href={step.href} prefetch={false} className={styles.rowLink}><span className={styles.stack}><strong>{step.title}</strong><span className={styles.reading}>{step.body}</span><span className={styles.support}>{step.action}</span></span><ArrowRight size={18} aria-hidden="true" /></Link></li>)}</ol>
    </div></section>
    <section id="flow" className={styles.section}><div className={`${styles.container} ${styles.split}`}>
      <header className={styles.sectionHeader}><p className={styles.eyebrow}>Working flow</p><h2>Follow the goal through its controls.</h2><p className={styles.reading}>Identity, source context, policy, evidence, and your review remain part of the work.</p></header>
      <ol className={styles.steps}>{operatingFlow.map(([index, title, body]) => <li key={title}><span className={styles.step}>{index}</span><div className={styles.stack}><h3>{title}</h3><p className={styles.reading}>{body}</p></div></li>)}</ol>
    </div></section>
    <section className={styles.section}><div className={`${styles.container} ${styles.split}`}>
      <header className={styles.sectionHeader}><p className={styles.eyebrow}>Assistant</p><h2>Choose how to approach the request.</h2><p className={styles.reading}>Keep the goal, mode, source context, tools, approvals, history, and evidence together.</p><Link href="/app/command" prefetch={false} className={styles.button}>Open Assistant</Link></header>
      <ul className={styles.rows}>{commandModes.map(([mode, body]) => <li key={mode}><div className={styles.stack}><h3>{mode}</h3><p className={styles.reading}>{body}</p></div></li>)}</ul>
    </div></section>
    <section id="features" className={styles.section}><div className={styles.container}>
      <header className={styles.sectionHeader}><p className={styles.eyebrow}>Feature guide</p><h2>Find the view for your work.</h2><p className={styles.reading}>Each link opens the corresponding private workspace view. Access depends on your account and permissions.</p></header>
      <ul className={`${styles.rows} ${styles.columns}`}>{appNav.map((item) => <li key={item.href}><Link href={item.href} prefetch={false} className={styles.rowLink}><span className={styles.stack}><strong>{item.label}</strong><span className={styles.reading}>{item.description}</span></span><ArrowRight size={18} aria-hidden="true" /></Link></li>)}</ul>
    </div></section>
    <section className={styles.section}><div className={`${styles.container} ${styles.split}`}>
      <header className={styles.sectionHeader}><p className={styles.eyebrow}>Routes</p><h2>Public pages and private workspace views.</h2></header>
      <ul className={styles.rows}>{userSurfaces.map(([href, description]) => <li key={href}><Link href={href} prefetch={false} className={styles.rowLink}><span className={styles.stack}><strong className={styles.code}>{href}</strong><span>{description}</span></span><ArrowRight size={18} aria-hidden="true" /></Link></li>)}</ul>
    </div></section>
    <section id="use-cases" className={styles.section}><div className={styles.container}>
      <header className={styles.sectionHeader}><p className={styles.eyebrow}>Use cases</p><h2>Examples of governed work.</h2><p className={styles.reading}>These are example approaches. Available actions depend on connected sources, configuration, permissions, and required approvals.</p></header>
      <ul className={`${styles.rows} ${styles.columns}`}>{useCases.map((item) => <li key={item.title}><div className={styles.stack}><h3>{item.title}</h3><p className={styles.reading}>{item.outcome}</p><ol className={styles.checklist}>{item.flow.map((step) => <li key={step}>{step}</li>)}</ol></div></li>)}</ul>
    </div></section>
    <section id="api-map" className={styles.section}><div className={`${styles.container} ${styles.split}`}>
      <header className={styles.sectionHeader}><p className={styles.eyebrow}>API map</p><h2>Operating references.</h2><p className={styles.reading}>These are route references, not executable examples. Protected operations require their existing authorization and review controls.</p></header>
      <div>{apiGroups.map((group) => <details key={group.title} className={styles.disclosure}><summary>{group.title} <span className={styles.support}>· {group.routes.length} routes</span></summary><ul className={styles.codeList}>{group.routes.map((routePath) => <li key={routePath}><code className={styles.code}>{routePath}</code></li>)}</ul></details>)}</div>
    </div></section>
    <section id="checklist" className={styles.section}><div className={`${styles.container} ${styles.split}`}>
      <header className={styles.sectionHeader}><p className={styles.eyebrow}>Operations checklist</p><h2>Review readiness before consequential work.</h2><p className={styles.reading}>The application can connect to real systems. Review the relevant evidence and controls before running work.</p></header>
      <ol className={`${styles.checklist} ${styles.reading}`}>{productionChecklist.map((item) => <li key={item}>{item}</li>)}</ol>
    </div></section>
    <section className={styles.section}><div className={`${styles.container} ${styles.split}`}><div className={styles.stack}><h2>Keep the guide beside your work.</h2><p className={styles.reading}>Use it while you connect a source, inspect a workflow, or review evidence.</p></div><div className={styles.actions}><Link href="/app" prefetch={false} className={styles.primaryButton}>Open app</Link><Link href="/login" prefetch={false} className={styles.button}>Sign in</Link></div></div></section>
  </PublicFrame>;
}
