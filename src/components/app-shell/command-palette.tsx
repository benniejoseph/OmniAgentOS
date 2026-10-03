"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { clsx } from "clsx";
import { appNav, type AppNavItem } from "@/lib/navigation";
import type { WorkspaceRole, WorkspaceSession } from "./session-context";
import { workspaceOwnerScope } from "./workspace-owner-scope";
import { useContentSearch } from "./use-content-search";
import searchStyles from "./content-search.module.css";
import { ContentSearchPaging, ContentSearchResults } from "./content-search-results";
import { openSearchOnCurrentPage } from "./content-search-location";
import type { PaletteSearchState } from "./content-search-state";

export function CommandPalette({ session, sessionStatus, role }: {
  session?: WorkspaceSession; sessionStatus?: "loading" | "ready" | "error"; role?: WorkspaceRole;
} = {}) {
  const router = useRouter();
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return appNav;
    }
    return appNav
      .filter(
        (item) =>
          item.label.toLowerCase().includes(normalized) ||
          item.description.toLowerCase().includes(normalized) ||
          item.href.toLowerCase().includes(normalized),
      )
      .toSorted((left, right) => {
        const relevance = (label: string) => {
          const candidate = label.toLowerCase();
          if (candidate === normalized) return 0;
          if (candidate.startsWith(normalized)) return 1;
          if (candidate.includes(normalized)) return 2;
          return 3;
        };
        return relevance(left.label) - relevance(right.label);
      });
  }, [query]);
  const owner = sessionStatus === "ready" ? workspaceOwnerScope(session, role ?? session?.context?.role ?? "viewer") : "";
  const content = useContentSearch(owner, query, open);
  const choices = [...results, ...content.state.groups.flatMap((group) => group.items)];
  const currentIndex = choices.length ? Math.min(activeIndex, choices.length - 1) : 0;
  const activeOptionId = choices[currentIndex] ? `${listboxId}-option-${currentIndex}` : undefined;

  const openPalette = useCallback(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current;
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }, []);

  const closePalette = useCallback(({ restoreFocus = true } = {}) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        const previous = previousFocusRef.current;
        (previous?.isConnected ? previous : triggerRef.current)?.focus();
      });
    }
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) {
          closePalette();
        } else {
          openPalette();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [closePalette, open, openPalette]);

  useEffect(() => {
    if (!open) {
      return;
    }

    inputRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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

    document.addEventListener("keydown", onDialogKeyDown);
    return () => {
      document.removeEventListener("keydown", onDialogKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [closePalette, open]);

  useEffect(() => {
    if (open && activeOptionId) {
      document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeOptionId, open]);

  function go(href: string) {
    closePalette({ restoreFocus: false });
    if (!openSearchOnCurrentPage(href)) router.push(href);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openPalette}
        className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm text-muted transition hover:bg-surface-raised hover:text-foreground"
        aria-label="Open command palette"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="command-palette-trigger"
      >
        <Search size={15} aria-hidden="true" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded border border-line bg-background px-1.5 py-0.5 font-mono text-xs md:inline">⌘K</kbd>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[60] flex items-start justify-center bg-black/55 p-3 pt-[8vh] sm:p-4 sm:pt-[14vh]"
          role="dialog"
          aria-modal="true"
          aria-labelledby={dialogTitleId}
          aria-describedby={dialogDescriptionId}
          data-testid="command-palette-dialog"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closePalette();
            }
          }}
        >
          <div
            ref={dialogRef}
            className={`${searchStyles.palette} w-full max-w-xl max-h-[84dvh] overflow-hidden flex flex-col rounded-lg border border-line bg-surface shadow-[0_8px_24px_oklch(0.08_0.02_245/0.32)]`}
          >
            <div className="flex items-start justify-between gap-4 px-4 pt-4">
              <div>
                <h2 id={dialogTitleId} className="text-sm font-semibold">Search Asael</h2>
                <p id={dialogDescriptionId} className="mt-1 text-xs text-muted">
                  Find a workspace or your content. Use arrow keys to move and Enter to open.
                </p>
              </div>
              <button
                type="button"
                onClick={() => closePalette()}
                className="grid size-11 shrink-0 place-items-center rounded-md border border-line text-muted hover:bg-surface-raised hover:text-foreground"
                aria-label="Close command palette"
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <Search size={16} className="shrink-0 text-muted" aria-hidden="true" />
              <input
                ref={inputRef}
                role="combobox"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveIndex((index) => choices.length ? (index + 1) % choices.length : 0);
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((index) => choices.length ? (index - 1 + choices.length) % choices.length : 0);
                  }
                  if (event.key === "Home" && choices.length) {
                    event.preventDefault();
                    setActiveIndex(0);
                  }
                  if (event.key === "End" && choices.length) {
                    event.preventDefault();
                    setActiveIndex(choices.length - 1);
                  }
                  if (event.key === "Enter" && choices[currentIndex]) {
                    event.preventDefault();
                    go(choices[currentIndex].href);
                  }
                }}
                placeholder="Search workspaces and your content"
                maxLength={240}
                className="min-h-11 w-full bg-transparent text-base outline-none placeholder:text-muted sm:text-sm"
                aria-label="Search workspaces"
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={activeOptionId}
                data-testid="command-palette-input"
              />
            </div>
            <p className="sr-only" role="status" aria-live="polite">
              {choices.length} matches available. {content.state.status === "loading" ? "Searching content." : ""}
            </p>
            <CommandPaletteResults
              listboxId={listboxId}
              query={query}
              results={results}
              currentIndex={currentIndex}
              onHighlight={setActiveIndex}
              onOpen={go}
              contentState={content.state.groups.length ? content.state : undefined}
            />
            <div className="px-4 py-2 text-xs text-muted" role="status" aria-live="polite">
              {!owner ? "Content search needs a current signed-in workspace. Navigation stays available." :
                query.trim().length < 2 ? "Enter at least two characters to search your content." :
                content.state.status === "loading" ? "Searching your content…" :
                content.state.error ? content.state.error :
                content.state.generatedAt ? "Live results may move as content changes. Opening a result checks access again." :
                "Include a word or number to search content."}
              {content.state.error ? <button type="button" className="ml-2 min-h-11 underline" onClick={content.refresh}>Restart search</button> : null}
            </div>
            <ContentSearchPaging groups={content.state.groups} loadingProvider={content.state.loadingProvider} more={content.more} />
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * The palette's matches. An option opens on a click, which a touch that
 * scrolls the list never makes, so starting a scroll on an option does not
 * open it. The keyboard opens the active option with Enter.
 */
export function CommandPaletteResults({
  listboxId,
  query,
  results,
  currentIndex,
  onHighlight,
  onOpen,
  contentState,
}: {
  listboxId: string;
  query: string;
  results: AppNavItem[];
  currentIndex: number;
  onHighlight: (index: number) => void;
  onOpen: (href: string) => void;
  contentState?: PaletteSearchState;
}) {
  const navigation = results.length ? (
        results.map((item, index) => {
          const Icon = item.icon;
          return (
            <li
              key={item.href}
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={index === currentIndex}
              onMouseEnter={() => onHighlight(index)}
              onClick={() => onOpen(item.href)}
              className={clsx(
                "flex min-h-14 cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm",
                index === currentIndex ? "bg-primary text-primary-ink" : "text-foreground hover:bg-surface-raised",
              )}
            >
              <Icon size={16} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{item.label}</span>
                <span className={clsx("block truncate text-xs", index === currentIndex ? "text-primary-ink/85" : "text-muted")}>
                  {item.description}
                </span>
              </span>
            </li>
          );
        })
      ) : (
        <li role="presentation" className="px-3 py-8 text-center text-sm text-muted">No workspace matches “{query}”.</li>
      );
  return <ul id={listboxId} className="max-h-[45dvh] min-h-0 overflow-y-auto p-2" role="listbox" aria-label="Workspace and content results" data-testid="command-palette-listbox">
    {contentState ? <>{navigation}<ContentSearchResults state={contentState} listboxId={listboxId} offset={results.length}
      currentIndex={currentIndex} onHighlight={onHighlight} onOpen={onOpen} /></> : navigation}
  </ul>;
}
