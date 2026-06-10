"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Search, Sparkles } from "lucide-react";
import { clsx } from "clsx";
import { appNav } from "@/lib/navigation";
import { ThemeToggle } from "@/components/theme/theme-toggle";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-line bg-surface/86 backdrop-blur-xl lg:block">
        <div className="flex h-16 items-center gap-3 border-b border-line px-5">
          <Link href="/" className="grid size-9 place-items-center rounded-md bg-primary text-primary-ink">
            <Sparkles size={17} aria-hidden="true" />
          </Link>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">OmniAgentOS</p>
            <p className="truncate text-xs text-muted">Enterprise control plane</p>
          </div>
        </div>
        <nav className="space-y-1 px-3 py-4" aria-label="Application navigation">
          {appNav.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  "group flex items-start gap-3 rounded-md px-3 py-3 text-sm transition",
                  active
                    ? "bg-primary text-primary-ink"
                    : "text-muted hover:bg-surface-raised hover:text-foreground",
                )}
              >
                <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block font-medium">{item.label}</span>
                  <span className={clsx("mt-1 block text-xs leading-5", active ? "text-primary-ink/76" : "text-muted")}>
                    {item.description}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-20 border-b border-line bg-background/82 backdrop-blur-xl">
          <div className="flex h-16 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <Link
                href="/"
                className="grid size-10 place-items-center rounded-md border border-line bg-surface text-primary lg:hidden"
                aria-label="OmniAgentOS home"
              >
                <Sparkles size={18} aria-hidden="true" />
              </Link>
              <div className="hidden min-w-0 items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-muted sm:flex">
                <Search size={15} aria-hidden="true" />
                <span className="truncate">Search agents, memory, workflows</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm md:flex">
                <Activity size={15} className="text-success" aria-hidden="true" />
                <span>Production</span>
              </div>
              <ThemeToggle compact />
              <Link
                href="/app/command"
                className="inline-flex h-10 items-center rounded-md bg-primary px-3 text-sm font-semibold text-primary-ink transition hover:brightness-105"
              >
                Command
              </Link>
            </div>
          </div>
          <nav className="flex gap-2 overflow-x-auto border-t border-line px-4 py-2 lg:hidden" aria-label="Mobile app navigation">
            {appNav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  "shrink-0 rounded-md px-3 py-2 text-sm",
                  pathname === item.href ? "bg-primary text-primary-ink" : "bg-surface text-muted",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </header>

        <main>{children}</main>
      </div>
    </div>
  );
}
