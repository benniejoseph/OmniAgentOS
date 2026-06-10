import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { marketingNav } from "@/lib/navigation";
import { ThemeToggle } from "@/components/theme/theme-toggle";

export function PublicHeader() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-white/10 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex min-w-0 items-center gap-3 text-sm font-semibold tracking-tight">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary text-primary-ink">
            <Sparkles size={17} aria-hidden="true" />
          </span>
          <span className="truncate text-base">OmniAgentOS</span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Public navigation">
          {marketingNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm text-muted transition hover:bg-surface hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle compact />
          <Link
            href="/login"
            className="hidden h-10 items-center rounded-md px-3 text-sm font-semibold text-muted transition hover:bg-surface hover:text-foreground sm:inline-flex"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-ink transition hover:brightness-105 focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            Get access
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </header>
  );
}
