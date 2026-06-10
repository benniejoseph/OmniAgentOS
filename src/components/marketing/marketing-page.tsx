import Link from "next/link";
import { ArrowRight, Check, Layers3 } from "lucide-react";
import { PublicHeader } from "@/components/marketing/public-header";
import { appNav, marketingPages, proofMetrics } from "@/lib/navigation";

type MarketingPageKey = keyof typeof marketingPages;

export function MarketingPage({ pageKey }: { pageKey: MarketingPageKey }) {
  const page = marketingPages[pageKey];
  const Icon = page.icon;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <PublicHeader />
      <section className="border-b border-line pt-16">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[0.82fr_1.18fr] lg:px-8">
          <div>
            <div className="grid size-12 place-items-center rounded-md bg-primary/12 text-primary">
              <Icon size={22} aria-hidden="true" />
            </div>
            <p className="mt-8 text-sm font-semibold uppercase tracking-[0.22em] text-primary">{page.eyebrow}</p>
            <h1 className="mt-4 max-w-3xl text-5xl font-semibold tracking-normal sm:text-6xl">
              {page.headline}
            </h1>
          </div>
          <div className="flex flex-col justify-end">
            <p className="max-w-2xl text-lg leading-8 text-muted">{page.summary}</p>
            <div className="mt-8">
              <Link
                href="/app"
                className="inline-flex h-12 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-ink transition hover:brightness-105"
              >
                Open app
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2">
          {page.sections.map((section) => (
            <div key={section} className="min-h-40 bg-surface p-6">
              <Check size={18} className="text-primary" aria-hidden="true" />
              <p className="mt-8 text-lg font-semibold">{section}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[0.7fr_1.3fr] lg:px-8">
          <div>
            <Layers3 size={22} className="text-primary" aria-hidden="true" />
            <h2 className="mt-6 text-3xl font-semibold tracking-normal">Built as a system, not a feature wall.</h2>
            <p className="mt-4 text-sm leading-6 text-muted">
              The public product surface maps directly to production routes, data APIs, and release gates already in the application.
            </p>
          </div>
          <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
            {appNav.slice(2, 10).map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} className="group bg-background p-5 transition hover:bg-surface-raised">
                  <Icon size={17} className="text-primary" aria-hidden="true" />
                  <p className="mt-8 font-semibold">{item.label}</p>
                  <p className="mt-2 text-sm leading-6 text-muted">{item.description}</p>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
          {proofMetrics.map((metric) => (
            <div key={metric.label} className="bg-surface p-5">
              <p className="font-mono text-2xl">{metric.value}</p>
              <p className="mt-2 text-sm text-muted">{metric.label}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
