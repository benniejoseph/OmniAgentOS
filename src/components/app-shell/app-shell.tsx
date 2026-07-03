"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ArrowRight, ChevronDown, Sparkles } from "lucide-react";
import { clsx } from "clsx";
import { appNav, appNavGroups, primaryNavHrefs } from "@/lib/navigation";
import { CommandPalette } from "@/components/app-shell/command-palette";
import { ThemeToggle } from "@/components/theme/theme-toggle";

export function AppShell({ children, banner }: { children: React.ReactNode; banner?: React.ReactNode }) {
  const pathname = usePathname();
  const activeItem = appNav.find((item) => isActivePath(pathname, item.href));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-line bg-surface/92 backdrop-blur-xl lg:block">
        <div className="flex h-16 items-center gap-3 border-b border-line px-5">
          <Link href="/" className="grid size-9 place-items-center rounded-md bg-primary text-primary-ink">
            <Sparkles size={17} aria-hidden="true" />
          </Link>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">OmniAgentOS</p>
            <p className="truncate text-xs text-muted">Your AI agent workspace</p>
          </div>
        </div>
        <nav className="space-y-4 overflow-y-auto px-3 py-4 pb-32" style={{ maxHeight: "calc(100vh - 4rem)" }} aria-label="Application navigation">
          {appNavGroups.map((group) => (
            <NavGroup key={group.label} group={group} pathname={pathname} />
          ))}
        </nav>
        <div className="absolute inset-x-3 bottom-3 rounded-md border border-line bg-background p-3">
          <p className="text-xs font-semibold text-foreground">{activeItem?.label || "OmniAgentOS"}</p>
          <p className="mt-1 text-xs leading-5 text-muted">{activeItem?.description || "Pick a page from the menu."}</p>
        </div>
      </aside>

      <div className="lg:pl-72">
        {banner}
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
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{activeItem?.label || "OmniAgentOS"}</p>
                <p className="hidden truncate text-xs text-muted sm:block">{activeItem?.description || "Your AI agent workspace"}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <CommandPalette />
              <ThemeToggle compact />
              <Link
                href="/app/command"
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-3 text-sm font-semibold text-primary-ink transition hover:brightness-105"
              >
                Start run
              </Link>
            </div>
          </div>
          <nav className="flex gap-2 overflow-x-auto border-t border-line px-4 py-2 lg:hidden" aria-label="Mobile app navigation">
            {/* Mobile shows only the everyday loop; everything else lives in the
                sidebar's Advanced group on desktop or the command palette. */}
            {appNav
              .filter((item) => primaryNavHrefs.includes(item.href) || isActivePath(pathname, item.href))
              .map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={clsx(
                    "shrink-0 rounded-md px-3 py-2 text-sm",
                    isActivePath(pathname, item.href) ? "bg-primary text-primary-ink" : "bg-surface text-muted",
                  )}
                >
                  {item.shortLabel || item.label}
                </Link>
              ))}
          </nav>
        </header>

        <main>{children}</main>
      </div>
    </div>
  );
}

function NavGroup({ group, pathname }: { group: (typeof appNavGroups)[number]; pathname: string }) {
  const containsActive = group.items.some((item) => isActivePath(pathname, item.href));
  const [userPref, setUserPref] = useState<boolean | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    const stored = window.localStorage.getItem(`omni-nav-open:${group.label}`);
    return stored === null ? null : stored === "true";
  });

  // Derived, not stored in an effect: an active group is always revealed; a
  // user preference wins otherwise; collapsible groups default closed.
  const open = !group.collapsible || containsActive || (userPref ?? false);

  function toggle() {
    const next = !open;
    setUserPref(next);
    window.localStorage.setItem(`omni-nav-open:${group.label}`, String(next));
  }

  return (
    <div>
      {group.collapsible ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex w-full items-center justify-between rounded-md px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted transition hover:text-foreground"
        >
          {group.label}
          <ChevronDown size={13} className={clsx("transition-transform", open ? "" : "-rotate-90")} aria-hidden="true" />
        </button>
      ) : (
        <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">{group.label}</p>
      )}
      {open ? (
        <div className="mt-2 space-y-1">
          {group.items.map((item) => {
            const Icon = item.icon;
            const active = isActivePath(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.description}
                className={clsx(
                  "group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition",
                  active
                    ? "bg-primary text-primary-ink"
                    : "text-muted hover:bg-surface-raised hover:text-foreground",
                )}
              >
                <Icon size={17} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                {active ? <ArrowRight size={14} className="shrink-0" aria-hidden="true" /> : null}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function isActivePath(pathname: string, href: string) {
  return pathname === href || (href !== "/app" && pathname.startsWith(`${href}/`));
}
