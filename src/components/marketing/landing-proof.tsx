import { CheckCircle2, LockKeyhole, ShieldCheck } from "lucide-react";
import {
  marketingFaq,
  trustControls,
  walkthroughSteps,
} from "@/lib/marketing-content";

export function ProductWalkthrough() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <div className="grid gap-12 lg:grid-cols-[0.78fr_1.22fr] lg:items-center">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
            Product walkthrough
          </p>
          <h2 className="mt-4 text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
            One workspace, shown as one operating story.
          </h2>
          <div className="mt-8">
            {walkthroughSteps.map((item) => (
              <div
                key={item.label}
                className="grid grid-cols-[2.5rem_1fr] gap-4 border-b border-line py-5"
              >
                <span className="font-mono text-sm text-primary">
                  {item.step}
                </span>
                <div>
                  <h3 className="font-semibold">{item.label}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted">
                    {item.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-line bg-foreground p-5 text-background sm:p-7">
          <div className="flex items-center justify-between border-b border-background/15 pb-5">
            <div>
              <p className="text-sm opacity-70">Governed run</p>
              <p className="mt-1 text-2xl font-semibold">Release review</p>
            </div>
            <ShieldCheck size={28} aria-hidden="true" />
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              ["Workflow", "7 stages"],
              ["Approval", "Resolved"],
              ["Evidence", "Verified"],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-md border border-background/15 bg-background/10 p-4"
              >
                <p className="text-xs opacity-70">{label}</p>
                <p className="mt-3 font-mono text-sm">{value}</p>
              </div>
            ))}
          </div>
          <div className="subtle-grid mt-4 min-h-48 rounded-md border border-background/15 bg-background/5" />
        </div>
      </div>
    </section>
  );
}

export function TrustControls() {
  return (
    <section id="security" className="border-y border-line bg-surface">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[0.85fr_1.15fr] lg:px-8">
        <div>
          <LockKeyhole size={24} className="text-primary" aria-hidden="true" />
          <p className="mt-8 text-sm font-semibold uppercase tracking-[0.2em] text-primary">
            Trust and control
          </p>
          <h2 className="mt-4 text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
            Private by design. Observable by default.
          </h2>
          <p className="mt-5 max-w-xl text-base leading-7 text-muted">
            Agent work can reach real data and systems, so identity, policy,
            evidence, and operator decisions remain visible.
          </p>
        </div>
        <div className="rounded-lg border border-line bg-background p-5 sm:p-7">
          {trustControls.map((control) => (
            <div
              key={control}
              className="flex min-h-16 items-center gap-3 border-b border-line last:border-b-0"
            >
              <CheckCircle2
                size={18}
                className="shrink-0 text-primary"
                aria-hidden="true"
              />
              <span className="text-sm font-medium">{control}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function MarketingFaq() {
  return (
    <section id="faq" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <div className="grid gap-12 lg:grid-cols-[0.7fr_1.3fr]">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
            Frequently asked
          </p>
          <h2 className="mt-4 text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
            Clear answers before entering the workspace.
          </h2>
        </div>
        <div className="divide-y divide-line border-y border-line">
          {marketingFaq.map((item) => (
            <details key={item.question} className="group py-5">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-semibold">
                {item.question}
                <span
                  className="text-primary transition group-open:rotate-45"
                  aria-hidden="true"
                >
                  +
                </span>
              </summary>
              <p className="max-w-2xl pb-2 pr-10 text-sm leading-6 text-muted">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
