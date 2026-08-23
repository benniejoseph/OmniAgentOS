import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";

const proofPoints = [
  {
    icon: Activity,
    title: "Operational clarity",
    body: "See current work, blockers, and what happens next.",
  },
  {
    icon: ShieldCheck,
    title: "Risk-first controls",
    body: "Pause sensitive tools for an explicit decision.",
  },
  {
    icon: CheckCircle2,
    title: "Durable evidence",
    body: "Keep results, memory, approvals, and release proof.",
  },
] as const;

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only fixed left-4 top-4 z-50 rounded-md bg-primary px-4 py-3 font-semibold text-primary-ink focus:not-sr-only"
      >
        Skip to sign in
      </a>
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-svh bg-background text-foreground"
      >
        <div className="grid min-h-svh lg:grid-cols-[0.95fr_1.05fr]">
          <aside
            data-testid="auth-story"
            aria-label="Private workspace benefits"
            className="hidden flex-col justify-between border-r border-line bg-primary/10 p-10 lg:flex xl:p-14"
          >
            <div>
              <Link
                href="/"
                className="inline-flex min-h-11 items-center gap-3 font-semibold tracking-tight"
                aria-label="OmniAgentOS home"
              >
                <span className="grid size-10 place-items-center rounded-md bg-primary text-primary-ink">
                  <Sparkles size={18} aria-hidden="true" />
                </span>
                <span className="text-lg">OmniAgentOS</span>
              </Link>
              <p className="mt-16 inline-flex rounded-full border border-primary/25 bg-background/60 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
                Private agent workspace
              </p>
              <p className="mt-5 max-w-xl text-5xl font-semibold leading-[1.02] tracking-tighter xl:text-6xl">
                Run faster. Keep every action governed.
              </p>
              <p className="mt-6 max-w-lg text-base leading-7 text-muted">
                One focused command center for plans, approvals, memory, and
                release evidence.
              </p>
              <div className="mt-10 grid gap-3">
                {proofPoints.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.title}
                      className="grid grid-cols-[2.75rem_1fr] gap-4 rounded-lg border border-line bg-background/60 p-4"
                    >
                      <div className="grid size-11 place-items-center rounded-md bg-primary/12 text-primary">
                        <Icon size={18} aria-hidden="true" />
                      </div>
                      <div>
                        <p className="font-semibold">{item.title}</p>
                        <p className="mt-1 text-sm leading-6 text-muted">
                          {item.body}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mt-12 flex items-center justify-between rounded-lg border border-primary/20 bg-background/60 px-4 py-3 text-sm">
              <span className="text-muted">Owner access</span>
              <strong className="text-primary">Single account</strong>
            </div>
          </aside>

          <section
            aria-label="Sign in"
            className="flex min-h-svh flex-col p-4 sm:p-8 lg:p-10"
          >
            <div className="flex min-h-11 items-center justify-between gap-4">
              <Link
                href="/"
                className="inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-semibold lg:hidden"
              >
                <span className="grid size-9 place-items-center rounded-md bg-primary text-primary-ink">
                  <Sparkles size={16} aria-hidden="true" />
                </span>
                OmniAgentOS
              </Link>
              <span className="hidden lg:block" />
              <ThemeToggle />
            </div>

            <div className="flex flex-1 items-center justify-center py-8">
              <div className="w-full max-w-md">{children}</div>
            </div>

            <Link
              href="/"
              className="inline-flex min-h-11 items-center gap-2 self-center rounded-md px-3 text-sm font-medium text-muted transition hover:text-foreground"
            >
              <ArrowLeft size={16} aria-hidden="true" />
              Back to homepage
            </Link>
          </section>
        </div>
      </main>
    </>
  );
}
