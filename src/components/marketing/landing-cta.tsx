import Link from "next/link";
import { ArrowRight, Play } from "lucide-react";
import { marketingActions } from "@/lib/marketing-content";

export function PrivateWorkspaceCta() {
  return (
    <section className="border-t border-line bg-foreground text-background">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-16 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div>
          <h2 className="text-3xl font-semibold tracking-[-0.04em]">
            Open the operating workspace.
          </h2>
          <p className="mt-3 text-sm opacity-70">
            Private owner access · Email/password authentication · No public
            registration
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href={marketingActions.signIn.href}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-background px-5 text-sm font-semibold text-foreground"
          >
            {marketingActions.signIn.label}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
          <Link
            href={marketingActions.demo.href}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-background/20 px-5 text-sm font-semibold"
          >
            Open demo
            <Play size={16} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
