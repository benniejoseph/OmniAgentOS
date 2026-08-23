import {
  Activity,
  Brain,
  CheckCircle2,
  ShieldCheck,
  TerminalSquare,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  homepageCapabilities,
  operatingLoop,
  productFacts,
  type MarketingIconName,
} from "@/lib/marketing-content";

const capabilityIcons: Record<MarketingIconName, LucideIcon> = {
  command: TerminalSquare,
  workflow: Workflow,
  shield: ShieldCheck,
  memory: Brain,
  monitor: Activity,
  evidence: CheckCircle2,
};

export function ProductFacts() {
  return (
    <section aria-label="Product facts" className="border-b border-line bg-surface">
      <div className="mx-auto grid max-w-7xl grid-cols-2 divide-x divide-y divide-line border-x border-line sm:grid-cols-4 sm:divide-y-0">
        {productFacts.map((fact) => (
          <div key={fact.label} className="px-4 py-6 sm:px-6">
            <p className="font-mono text-2xl font-semibold">{fact.value}</p>
            <p className="mt-1 text-sm text-muted">{fact.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function OperatingLoop() {
  return (
    <section
      id="workflow"
      className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8"
    >
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
        Operating loop
      </p>
      <h2 className="mt-4 max-w-3xl text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
        From goal to evidence, one connected flow.
      </h2>
      <p className="mt-5 max-w-2xl text-base leading-7 text-muted">
        Follow the same four stages every time you give the agent meaningful
        work.
      </p>
      <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {operatingLoop.map((item) => (
          <article
            key={item.title}
            className="min-h-56 rounded-lg border border-line bg-surface p-6"
          >
            <p className="font-mono text-sm text-primary">{item.step}</p>
            <h3 className="mt-12 text-2xl font-semibold">{item.title}</h3>
            <p className="mt-3 text-sm leading-6 text-muted">{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function CapabilityGrid() {
  return (
    <section id="platform" className="border-y border-line bg-surface">
      <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
          Platform capabilities
        </p>
        <h2 className="mt-4 max-w-3xl text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
          Designed like an operations desk, not a chatbot.
        </h2>
        <div className="mt-12 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {homepageCapabilities.map((capability) => {
            const Icon = capabilityIcons[capability.icon];
            return (
              <article
                key={capability.title}
                className="rounded-lg border border-line bg-background p-6"
              >
                <div className="grid size-11 place-items-center rounded-md bg-primary/12 text-primary">
                  <Icon size={20} aria-hidden="true" />
                </div>
                <h3 className="mt-8 text-xl font-semibold">
                  {capability.title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-muted">
                  {capability.body}
                </p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
