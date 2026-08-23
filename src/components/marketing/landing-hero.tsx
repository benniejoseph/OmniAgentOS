import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Play, Sparkles } from "lucide-react";
import { PublicHealthBadge } from "@/components/marketing/public-health-badge";
import { marketingActions } from "@/lib/marketing-content";

export function LandingHero() {
  return (
    <section
      className="border-b border-line pt-16"
      aria-labelledby="landing-title"
    >
      <div className="mx-auto grid min-h-[calc(100svh-4rem)] max-w-7xl items-center gap-14 px-4 py-16 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-sm font-semibold text-primary">
            <Sparkles size={15} aria-hidden="true" />
            Your governed agent operating layer
          </p>
          <h1
            id="landing-title"
            className="mt-7 max-w-3xl text-5xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-6xl lg:text-7xl"
          >
            Give agents goals. Keep the controls.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted sm:text-xl">
            Plan, supervise, approve, and verify AI work in one focused
            workspace—with durable memory and evidence at every step.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href={marketingActions.signIn.href}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-ink transition hover:brightness-105"
            >
              {marketingActions.signIn.label}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
            <Link
              href={marketingActions.demo.href}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-line bg-surface px-5 text-sm font-semibold transition hover:bg-surface-raised"
            >
              {marketingActions.demo.label}
              <Play size={16} aria-hidden="true" />
            </Link>
          </div>
          <PublicHealthBadge />
        </div>

        <div className="overflow-hidden rounded-xl border border-line bg-foreground text-background shadow-2xl shadow-primary/10">
          <div className="flex min-h-12 items-center justify-between border-b border-background/15 px-4 text-xs">
            <span className="font-semibold">Workspace overview</span>
            <span className="font-mono opacity-70">Operational</span>
          </div>
          <figure className="relative aspect-video">
            <Image
              src="/omniagent-command-center.webp"
              alt="OmniAgent workspace showing task progress, approvals, and result evidence."
              fill
              preload
              sizes="(max-width: 1024px) calc(100vw - 2rem), 55vw"
              className="object-cover object-center"
            />
          </figure>
        </div>
      </div>
    </section>
  );
}
