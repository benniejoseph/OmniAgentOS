"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { clsx } from "clsx";
import { appNav } from "@/lib/navigation";

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
        setQuery("");
        setActiveIndex(0);
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setQuery("");
          setActiveIndex(0);
        }}
        className="hidden items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-muted transition hover:bg-surface-raised md:flex"
        aria-label="Open command palette"
      >
        <Search size={15} aria-hidden="true" />
        <span>Search</span>
        <kbd className="rounded border border-line bg-background px-1.5 py-0.5 font-mono text-[11px]">⌘K</kbd>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[14vh]"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-xl overflow-hidden rounded-lg border border-line bg-surface shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <Search size={16} className="shrink-0 text-muted" aria-hidden="true" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveIndex((index) => Math.min(index + 1, results.length - 1));
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((index) => Math.max(index - 1, 0));
                  }
                  if (event.key === "Enter" && results[activeIndex]) {
                    go(results[activeIndex].href);
                  }
                }}
                placeholder="Jump to a workspace…"
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
                aria-label="Search workspaces"
              />
              <kbd className="rounded border border-line bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted">esc</kbd>
            </div>
            <ul className="max-h-80 overflow-y-auto p-2" role="listbox">
              {results.length ? (
                results.map((item, index) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.href} role="option" aria-selected={index === activeIndex}>
                      <button
                        type="button"
                        onClick={() => go(item.href)}
                        onMouseEnter={() => setActiveIndex(index)}
                        className={clsx(
                          "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm",
                          index === activeIndex ? "bg-primary text-primary-ink" : "text-foreground",
                        )}
                      >
                        <Icon size={16} className="shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{item.label}</span>
                          <span className={clsx("block truncate text-xs", index === activeIndex ? "text-primary-ink/80" : "text-muted")}>
                            {item.description}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })
              ) : (
                <li className="px-3 py-6 text-center text-sm text-muted">No workspace matches “{query}”.</li>
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
