export type MarketingIconName =
  | "command"
  | "workflow"
  | "shield"
  | "memory"
  | "monitor"
  | "evidence";

export const marketingNav = [
  { href: "/platform", label: "Platform" },
  { href: "/solutions", label: "Solutions" },
  { href: "/security", label: "Security" },
  { href: "/demo", label: "Demo" },
  { href: "/docs", label: "Docs" },
] as const;

export const marketingActions = {
  signIn: { href: "/login", label: "Sign in" },
  demo: { href: "/demo", label: "Explore sample workspace" },
} as const;

export const productFacts = [
  { value: "7", label: "Recorded workflow stages" },
  { value: "3", label: "Independent worker lanes" },
  { value: "Scoped", label: "Tenant-aware operations" },
  { value: "Live", label: "Evidence-backed health" },
] as const;

export const operatingLoop = [
  {
    step: "01",
    title: "Define",
    body: "Set the goal, operating mode, and boundaries for the run.",
  },
  {
    step: "02",
    title: "Execute",
    body: "Follow the plan, retrieved context, and governed tool activity.",
  },
  {
    step: "03",
    title: "Approve",
    body: "Pause sensitive actions for an explicit human decision.",
  },
  {
    step: "04",
    title: "Verify",
    body: "Review the result, evidence, and durable memory produced.",
  },
] as const;

export const homepageCapabilities = [
  {
    icon: "command",
    title: "Agent command center",
    body: "Start work, inspect progress, and understand the current step.",
  },
  {
    icon: "workflow",
    title: "Durable workflows",
    body: "Resume long-running work across retries, approvals, and recovery.",
  },
  {
    icon: "shield",
    title: "Governed tools",
    body: "Route risky side effects through policy and explicit approval.",
  },
  {
    icon: "memory",
    title: "Memory and knowledge",
    body: "Retrieve source-backed context and retain useful outcomes with provenance.",
  },
  {
    icon: "monitor",
    title: "Observability",
    body: "Trace runtime events, performance, incidents, and worker health.",
  },
  {
    icon: "evidence",
    title: "Release evidence",
    body: "Verify isolation, security, worker readiness, and evaluation quality.",
  },
] as const satisfies readonly {
  icon: MarketingIconName;
  title: string;
  body: string;
}[];

export const walkthroughSteps = [
  {
    step: "01",
    label: "Command",
    body: "Describe a bounded outcome and choose how the agent should operate.",
  },
  {
    step: "02",
    label: "Workflow",
    body: "Inspect durable stages, dependencies, tool calls, and progress.",
  },
  {
    step: "03",
    label: "Approval",
    body: "Resolve sensitive actions with the payload and reason visible.",
  },
  {
    step: "04",
    label: "Evidence",
    body: "Review the completed result with verification and provenance.",
  },
] as const;

export const trustControls = [
  "Tenant-scoped database access",
  "Connector credentials kept server-side",
  "Risk-based tool approval",
  "Auditable run and decision history",
  "Evaluation-backed release gates",
] as const;

export const marketingFaq = [
  {
    question: "What can OmniAgent do?",
    answer:
      "It turns a goal into planned, observable work using durable workflows, governed tools, memory, approvals, and stored result evidence.",
  },
  {
    question: "When does work pause for approval?",
    answer:
      "Policy pauses actions whose risk requires a human decision before a side effect can reach a connected system.",
  },
  {
    question: "What information is retained?",
    answer:
      "Tenant-scoped run events, approvals, results, evidence, and selected memories are retained under the configured policies. Connector secrets remain server-side.",
  },
  {
    question: "How is release readiness verified?",
    answer:
      "Evaluation, authentication, tenant-isolation, worker, SLO, and evidence-signing gates are collected into the release report.",
  },
] as const;
