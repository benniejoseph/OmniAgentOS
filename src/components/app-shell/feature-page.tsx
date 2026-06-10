import Link from "next/link";
import { ArrowRight, CheckCircle2, Route } from "lucide-react";
import { productPages } from "@/lib/navigation";

type ProductPageKey = keyof typeof productPages;

export function FeaturePage({ pageKey }: { pageKey: ProductPageKey }) {
  const page = productPages[pageKey];
  const Icon = page.icon;

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <section className="rounded-lg border border-line bg-surface p-6 sm:p-8">
        <div className="grid gap-10 lg:grid-cols-[0.75fr_1.25fr] lg:items-end">
          <div>
            <div className="grid size-12 place-items-center rounded-md bg-primary/12 text-primary">
              <Icon size={22} aria-hidden="true" />
            </div>
            <p className="mt-8 text-sm font-semibold uppercase tracking-[0.22em] text-primary">{page.eyebrow}</p>
            <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-normal sm:text-5xl">
              {page.headline}
            </h1>
          </div>
          <div>
            <p className="max-w-2xl text-base leading-7 text-muted">{page.summary}</p>
            <Link
              href="/app/command"
              className="mt-8 inline-flex h-11 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105"
            >
              Use in command
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      <section className="mt-6 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
        {page.metrics.map((metric) => (
          <div key={metric.label} className="bg-background p-5">
            <p className="text-sm text-muted">{metric.label}</p>
            <p className="mt-4 font-mono text-3xl">{metric.value}</p>
          </div>
        ))}
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-[1fr_0.8fr]">
        <div className="rounded-lg border border-line bg-surface p-6">
          <div className="flex items-center gap-3">
            <Route size={18} className="text-primary" aria-hidden="true" />
            <h2 className="text-lg font-semibold">System path</h2>
          </div>
          <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
            {page.architecture.map((item, index) => (
              <div key={item.label} className="relative min-h-44 bg-background p-5">
                <p className="font-mono text-xs text-muted">0{index + 1}</p>
                <p className="mt-8 break-words text-base font-semibold">{item.label}</p>
                <p className="mt-3 text-sm leading-6 text-muted">{item.detail}</p>
                {index < page.architecture.length - 1 ? (
                  <span className="absolute right-4 top-4 text-muted" aria-hidden="true">→</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-line bg-foreground p-6 text-background">
          <p className="text-sm font-semibold uppercase tracking-[0.22em] opacity-68">Signals</p>
          <div className="mt-8 space-y-4">
            {page.signals.map((signal) => (
              <div key={signal} className="flex items-center justify-between border-b border-background/18 pb-4">
                <span className="text-sm opacity-76">{signal}</span>
                <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-3">
        {page.sections.map((section) => (
          <article key={section.title} className="min-h-80 rounded-lg border border-line bg-surface p-6">
            <CheckCircle2 size={19} className="text-primary" aria-hidden="true" />
            <h2 className="mt-8 text-2xl font-semibold tracking-normal">{section.title}</h2>
            <p className="mt-4 text-sm leading-6 text-muted">{section.body}</p>
            <div className="mt-8 space-y-3">
              {section.points.map((point) => (
                <div key={point} className="flex items-center gap-3 border-t border-line pt-3 text-sm">
                  <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
                  {point}
                </div>
              ))}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
