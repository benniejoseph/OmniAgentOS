import Link from "next/link";
import { PublicHeader } from "@/components/marketing/public-header";

type LegalSection = {
  title: string;
  paragraphs: string[];
};

export function LegalPage({
  eyebrow,
  title,
  summary,
  sections,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  sections: LegalSection[];
}) {
  return (
    <>
      <PublicHeader />
      <main className="min-h-screen bg-background px-4 pb-20 pt-28 sm:px-6">
        <article className="mx-auto max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">{eyebrow}</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">{title}</h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-muted">{summary}</p>
          <p className="mt-4 text-sm text-muted">Effective August 25, 2026</p>

          <div className="mt-12 space-y-10">
            {sections.map((section) => (
              <section key={section.title} className="rounded-2xl border border-line bg-surface p-6 sm:p-8">
                <h2 className="text-xl font-semibold text-foreground">{section.title}</h2>
                <div className="mt-4 space-y-4 text-base leading-7 text-muted">
                  {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                </div>
              </section>
            ))}
          </div>

          <div className="mt-10 flex flex-wrap gap-3 text-sm">
            <Link href="/privacy" className="text-primary hover:underline">Privacy</Link>
            <Link href="/terms" className="text-primary hover:underline">Terms</Link>
            <Link href="/" className="text-primary hover:underline">Return to Asael</Link>
          </div>
        </article>
      </main>
    </>
  );
}
