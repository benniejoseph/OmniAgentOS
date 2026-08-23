"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Menu, Sparkles, X } from "lucide-react";
import { clsx } from "clsx";
import { marketingActions, marketingNav } from "@/lib/marketing-content";
import { ThemeToggle } from "@/components/theme/theme-toggle";

export function PublicHeader() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setMobileOpen(false), 0);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMobileOpen(false);
        menuButtonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-line bg-background/95 backdrop-blur">
      <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-3 px-4 py-2 sm:px-6 lg:px-8">
        <Link href="/" className="flex min-w-0 items-center gap-3 text-sm font-semibold tracking-tight" aria-label="OmniAgentOS home">
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
              prefetch={item.href === "/demo"}
              aria-current={pathname === item.href ? "page" : undefined}
              className={clsx(
                "inline-flex min-h-11 items-center rounded-md px-3 text-sm transition",
                pathname === item.href
                  ? "bg-surface-raised font-semibold text-foreground"
                  : "text-muted hover:bg-surface hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle compact />
          <Link
            href={marketingActions.signIn.href}
            className="hidden min-h-11 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105 sm:inline-flex"
          >
            {marketingActions.signIn.label}
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMobileOpen((current) => !current)}
            className="grid size-11 place-items-center rounded-md border border-line bg-surface md:hidden"
            aria-label={mobileOpen ? "Close public navigation" : "Open public navigation"}
            aria-expanded={mobileOpen}
            aria-controls="public-mobile-navigation"
          >
            {mobileOpen ? <X size={19} aria-hidden="true" /> : <Menu size={19} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {mobileOpen ? (
        <nav
          id="public-mobile-navigation"
          aria-label="Public navigation"
          className="border-t border-line bg-background px-4 py-4 shadow-[0_8px_24px_oklch(0.08_0.02_245/0.2)] md:hidden"
        >
          <div className="mx-auto grid max-w-7xl gap-1">
            {marketingNav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                prefetch={item.href === "/demo"}
                aria-current={pathname === item.href ? "page" : undefined}
                className={clsx(
                  "flex min-h-11 items-center rounded-md px-3 text-sm font-medium",
                  pathname === item.href
                    ? "bg-primary text-primary-ink"
                    : "text-muted hover:bg-surface-raised hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            ))}
            <div className="mt-3 border-t border-line pt-3">
              <Link
                href={marketingActions.signIn.href}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-ink"
              >
                {marketingActions.signIn.label}
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </nav>
      ) : null}
    </header>
  );
}
