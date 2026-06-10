import Link from "next/link";
import { ArrowRight, CheckCircle2, Sparkles } from "lucide-react";
import { PublicHeader } from "@/components/marketing/public-header";

const proofPoints = [
  "Protected session auth with HttpOnly cookies.",
  "Tenant-scoped access to production telemetry.",
  "Sample workspace for evaluation before setup.",
];

export function AuthShell({
  eyebrow,
  title,
  summary,
  children,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <PublicHeader />
      <section className="min-h-screen border-b border-line pt-16">
        <div className="mx-auto grid min-h-[calc(100svh-4rem)] max-w-7xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[0.95fr_1.05fr] lg:px-8">
          <div className="flex flex-col justify-between rounded-lg border border-line bg-foreground p-6 text-background sm:p-8 lg:min-h-[720px]">
            <div>
              <div className="grid size-12 place-items-center rounded-md bg-primary text-primary-ink">
                <Sparkles size={20} aria-hidden="true" />
              </div>
              <p className="mt-10 text-sm font-semibold uppercase tracking-[0.22em] opacity-68">{eyebrow}</p>
              <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-normal sm:text-6xl">{title}</h1>
              <p className="mt-6 max-w-xl text-base leading-7 opacity-72">{summary}</p>
            </div>

            <div className="mt-12">
              <div className="grid gap-px overflow-hidden rounded-lg border border-background/16 bg-background/16 sm:grid-cols-3">
                {["Identity", "Workspace", "First run"].map((item, index) => (
                  <div key={item} className="bg-background/8 p-4">
                    <p className="font-mono text-xs opacity-56">0{index + 1}</p>
                    <p className="mt-8 text-sm font-semibold">{item}</p>
                  </div>
                ))}
              </div>
              <div className="mt-8 space-y-4">
                {proofPoints.map((point) => (
                  <div key={point} className="flex items-start gap-3 border-b border-background/14 pb-4">
                    <CheckCircle2 size={17} className="mt-0.5 text-primary" aria-hidden="true" />
                    <p className="text-sm leading-6 opacity-76">{point}</p>
                  </div>
                ))}
              </div>
              <Link
                href="/demo"
                className="mt-8 inline-flex h-11 items-center gap-2 rounded-md bg-background px-4 text-sm font-semibold text-foreground transition hover:opacity-90"
              >
                Try sample workspace
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div className="flex items-center">
            <div className="w-full rounded-lg border border-line bg-surface p-5 sm:p-8">
              {children}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
