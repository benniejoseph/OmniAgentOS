"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { clsx } from "clsx";
import { appNav } from "@/lib/navigation";

export function CommandPalette() {
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
    return appNav.filter(
      (item) =>
        item.label.toLowerCase().includes(normalized) ||
        item.description.toLowerCase().includes(normalized) ||
        item.href.toLowerCase().includes(normalized),
    );
  }, [query]);
  const currentIndex = results.length
    ? Math.min(activeIndex, results.length - 1)
    : 0;
  const activeOptionId = results[currentIndex]
    ? `${listboxId}-option-${currentIndex}`
    : undefined;

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
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
    router.push(href);
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
        <kbd className="hidden rounded border border-line bg-background px-1.5 py-0.5 font-mono text-[11px] md:inline">⌘K</kbd>
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
            className="w-full max-w-xl overflow-hidden rounded-lg border border-line bg-surface shadow-[0_8px_24px_oklch(0.08_0.02_245/0.32)]"
          >
            <div className="flex items-start justify-between gap-4 px-4 pt-4">
              <div>
                <h2 id={dialogTitleId} className="text-sm font-semibold">Go to a workspace</h2>
                <p id={dialogDescriptionId} className="mt-1 text-xs text-muted">
                  Type to filter. Use arrow keys to move and Enter to open.
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
                    setActiveIndex((index) => results.length ? (index + 1) % results.length : 0);
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((index) => results.length ? (index - 1 + results.length) % results.length : 0);
                  }
                  if (event.key === "Home" && results.length) {
                    event.preventDefault();
                    setActiveIndex(0);
                  }
                  if (event.key === "End" && results.length) {
                    event.preventDefault();
                    setActiveIndex(results.length - 1);
                  }
                  if (event.key === "Enter" && results[currentIndex]) {
                    event.preventDefault();
                    go(results[currentIndex].href);
                  }
                }}
                placeholder="Search workspaces"
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
              {results.length} {results.length === 1 ? "workspace" : "workspaces"} available.
            </p>
            <ul id={listboxId} className="max-h-[55vh] overflow-y-auto p-2" role="listbox" aria-label="Workspace results" data-testid="command-palette-listbox">
              {results.length ? (
                results.map((item, index) => {
                  const Icon = item.icon;
                  return (
                    <li
                      key={item.href}
                      id={`${listboxId}-option-${index}`}
                      role="option"
                    aria-selected={index === currentIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        go(item.href);
                      }}
                    onClick={() => go(item.href)}
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
                <li className="px-3 py-8 text-center text-sm text-muted">No workspace matches “{query}”.</li>
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
