"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  LogIn,
  LogOut,
  Menu,
  UserRound,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { appNav, appNavGroups, primaryNavHrefs, primaryNavItems } from "@/lib/navigation";
import { CommandPalette } from "@/components/app-shell/command-palette";
import { useWorkspaceSession } from "@/components/app-shell/session-context";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { NotificationCenter } from "@/components/app-shell/notification-center";
import { AsaelMark } from "@/components/brand/asael-mark";

export function AppShell({ children, banner }: { children: React.ReactNode; banner?: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const activeItem = appNav.find((item) => isActivePath(pathname, item.href));
  const { session, status: sessionStatus, error: sessionError, role, signOut } = useWorkspaceSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string>();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobilePanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mobileOpen) {
      return;
    }

    const panel = mobilePanelRef.current;
    const firstLink = panel?.querySelector<HTMLElement>("a[href], button:not([disabled])");
    firstLink?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        menuButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !panel) {
        return;
      }
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileOpen]);

  async function handleSignOut() {
    setSigningOut(true);
    setSignOutError(undefined);
    try {
      await signOut();
      setMobileOpen(false);
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Sign out failed.");
    } finally {
      setSigningOut(false);
    }
  }

  function closeMobileNavigation() {
    setMobileOpen(false);
    window.setTimeout(() => {
      document.getElementById("workspace-content")?.focus();
    }, 0);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#workspace-content"
        className="fixed left-3 top-3 z-[70] -translate-y-24 rounded-md bg-foreground px-4 py-3 text-sm font-semibold text-background focus:translate-y-0"
      >
        Skip to workspace
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line/80 bg-surface lg:flex lg:flex-col">
        <div className="flex h-16 items-center gap-3 border-b border-line px-5">
          <Link
            href="/app"
            className="flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none"
            aria-label="Asael workspace home"
          >
            <AsaelMark size={36} priority />
            <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold tracking-tight">Asael</span>
                  <span className="block truncate text-xs text-muted">Your second brain</span>
            </span>
          </Link>
        </div>
        <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Application navigation">
          {appNavGroups.map((group) => (
            <NavGroup key={group.label} group={group} pathname={pathname} />
          ))}
        </nav>
        <div className="border-t border-line p-3">
          <AccountPanel
            session={session}
            sessionStatus={sessionStatus}
            sessionError={sessionError}
            role={role}
            signingOut={signingOut}
            signOutError={signOutError}
            onSignOut={() => void handleSignOut()}
          />
        </div>
      </aside>

      <div className="lg:pl-60">
        {banner}
        <header className="sticky top-0 z-20 border-b border-line/70 bg-background/85 backdrop-blur-xl">
          <div className="flex min-h-16 items-center justify-between gap-3 px-3 py-2 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <button
                ref={menuButtonRef}
                type="button"
                onClick={() => setMobileOpen(true)}
                className="grid size-11 shrink-0 place-items-center rounded-md border border-line bg-surface text-foreground lg:hidden"
                aria-label="Open workspace menu"
                aria-expanded={mobileOpen}
                aria-controls="mobile-workspace-menu"
                data-testid="workspace-menu-trigger"
              >
                <Menu size={19} aria-hidden="true" />
              </button>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{activeItem?.label || "Workspace"}</p>
                <p className="hidden truncate text-xs text-muted sm:block">
                  {activeItem?.description || "Give the agent work and review the outcome."}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <CommandPalette />
              <NotificationCenter />
              <ThemeToggle compact />
              <Link
                href="/app/command"
                className="hidden min-h-11 items-center justify-center rounded-md bg-primary px-3 text-sm font-semibold text-primary-ink transition hover:brightness-105 sm:inline-flex"
              >
                  Ask Asael
              </Link>
            </div>
          </div>
        </header>

        <main id="workspace-content" tabIndex={-1} className="workspace-enter pb-20 lg:pb-0">
          {children}
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line/80 bg-background/95 px-1 pb-[max(.35rem,env(safe-area-inset-bottom))] pt-1 backdrop-blur-xl lg:hidden" aria-label="Everyday workspace navigation">
        {primaryNavItems.map((item) => {
          const Icon = item.icon;
          const active = isActivePath(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "flex min-h-14 flex-col items-center justify-center gap-1 rounded-md px-1 text-[11px] font-semibold transition",
                active ? "text-primary" : "text-muted hover:bg-surface-raised hover:text-foreground",
              )}
            >
              <Icon size={19} aria-hidden="true" />
              <span>{item.shortLabel || item.label}</span>
            </Link>
          );
        })}
      </nav>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/55"
            onClick={() => {
              setMobileOpen(false);
              menuButtonRef.current?.focus();
            }}
            aria-label="Close workspace menu"
            tabIndex={-1}
          />
          <div
            ref={mobilePanelRef}
            id="mobile-workspace-menu"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-workspace-menu-title"
            className="absolute inset-y-0 left-0 flex w-[min(90vw,22rem)] flex-col border-r border-line bg-surface"
            data-testid="workspace-mobile-menu"
          >
            <div className="flex min-h-16 items-center justify-between gap-3 border-b border-line px-4">
              <Link
                href="/app"
                onClick={closeMobileNavigation}
                className="flex min-w-0 items-center gap-3"
                aria-label="Asael workspace home"
              >
                <AsaelMark size={36} />
                <span id="mobile-workspace-menu-title" className="truncate text-sm font-semibold">
                  Asael
                </span>
              </Link>
              <button
                type="button"
                onClick={() => {
                  setMobileOpen(false);
                  menuButtonRef.current?.focus();
                }}
                className="grid size-11 place-items-center rounded-md border border-line"
                aria-label="Close workspace menu"
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4" aria-label="Complete workspace navigation">
              {appNavGroups.map((group) => (
                <div key={group.label} className="mb-5">
                  <p className="px-3 text-xs font-semibold text-muted">{group.label}</p>
                  <div className="mt-2 space-y-1">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const active = isActivePath(pathname, item.href);
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          prefetch={primaryNavHrefs.includes(item.href)}
                          onClick={closeMobileNavigation}
                          aria-current={active ? "page" : undefined}
                          className={clsx(
                            "flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm",
                            active
                              ? "bg-primary text-primary-ink"
                              : "text-muted hover:bg-surface-raised hover:text-foreground",
                          )}
                        >
                          <Icon size={17} aria-hidden="true" />
                          <span className="min-w-0 flex-1 font-medium">{item.label}</span>
                          {active ? <ArrowRight size={14} aria-hidden="true" /> : null}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
            <div className="border-t border-line p-3">
              <AccountPanel
                session={session}
                sessionStatus={sessionStatus}
                sessionError={sessionError}
                role={role}
                signingOut={signingOut}
                signOutError={signOutError}
                onSignOut={() => void handleSignOut()}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NavGroup({ group, pathname }: { group: (typeof appNavGroups)[number]; pathname: string }) {
  const containsActive = group.items.some((item) => isActivePath(pathname, item.href));
  const [userPref, setUserPref] = useState<boolean | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = window.localStorage.getItem(`omni-nav-open:${group.label}`);
      setUserPref(stored === null ? null : stored === "true");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [group.label]);

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
          className="flex min-h-9 w-full items-center justify-between rounded-md px-3 text-xs font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground"
        >
          {group.label}
          <ChevronDown size={13} className={clsx("transition-transform", open ? "" : "-rotate-90")} aria-hidden="true" />
        </button>
      ) : (
        <p className="px-3 text-xs font-semibold text-muted">{group.label}</p>
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
                prefetch={primaryNavHrefs.includes(item.href)}
                title={item.description}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "group flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm transition",
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

function AccountPanel({
  session,
  sessionStatus,
  sessionError,
  role,
  signingOut,
  signOutError,
  onSignOut,
}: {
  session: ReturnType<typeof useWorkspaceSession>["session"];
  sessionStatus: ReturnType<typeof useWorkspaceSession>["status"];
  sessionError?: string;
  role: ReturnType<typeof useWorkspaceSession>["role"];
  signingOut: boolean;
  signOutError?: string;
  onSignOut: () => void;
}) {
  if (sessionStatus === "loading") {
    return (
      <div className="rounded-md border border-line bg-background p-3" role="status">
        <p className="text-sm font-semibold">Checking session</p>
        <p className="mt-1 text-xs text-muted">Account controls will appear shortly.</p>
      </div>
    );
  }

  if (sessionStatus === "error" || !session) {
    return (
      <div className="rounded-md border border-danger/40 bg-danger/10 p-3" role="alert">
        <p className="text-sm font-semibold">Session unavailable</p>
        <p className="mt-1 text-xs leading-5 text-muted">{sessionError || "Refresh the page to try again."}</p>
      </div>
    );
  }

  if (session.authEnabled && !session.authenticated) {
    return (
      <div className="rounded-md border border-line bg-background p-3">
        <p className="text-sm font-semibold">Signed out</p>
        <p className="mt-1 text-xs text-muted">Sign in to access protected workspace data.</p>
        <Link href="/login" className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-ink">
          <LogIn size={15} aria-hidden="true" />
          Sign in
        </Link>
      </div>
    );
  }

  const accountName =
    session.user?.name ||
    session.user?.email ||
    session.context?.actorId ||
    (session.authEnabled ? "Workspace member" : "Local workspace");
  const tenantName = session.tenant?.name || session.tenant?.slug || session.context?.tenantId;

  return (
    <div className="rounded-md border border-line bg-background p-3">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-raised text-muted">
          <UserRound size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{accountName}</p>
          <p className="mt-0.5 truncate text-xs text-muted">
            {session.authEnabled ? tenantName || "Workspace" : "Local mode"} · {role}
          </p>
        </div>
      </div>
      {!session.authEnabled ? (
        <p className="mt-3 text-xs leading-5 text-muted">Authentication is disabled. Requests use the configured local role.</p>
      ) : (
        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-line px-3 text-sm font-semibold hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60"
        >
          <LogOut size={15} aria-hidden="true" />
          {signingOut ? "Signing out" : "Sign out"}
        </button>
      )}
      {signOutError ? <p className="mt-2 text-xs text-danger" role="alert">{signOutError}</p> : null}
    </div>
  );
}

function isActivePath(pathname: string, href: string) {
  return pathname === href || (href !== "/app" && pathname.startsWith(`${href}/`));
}
