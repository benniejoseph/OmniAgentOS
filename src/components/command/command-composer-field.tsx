"use client";

import {
  Bot,
  Brain,
  Cable,
  FileText,
  FolderKanban,
  Loader2,
  Paperclip,
  Play,
  Puzzle,
  Search,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";
import type {
  CommandContextCatalog,
  CommandContextCatalogItem,
  CommandContextKind,
} from "@/lib/command/composer-context-contract";

export type CommandSlashAction = "research" | "act" | "learn" | "plan";

type TriggerState = Readonly<{
  symbol: "/" | "@";
  query: string;
  start: number;
  end: number;
}>;

type SlashItem = Readonly<{
  type: "action";
  id: CommandSlashAction;
  label: string;
  description: string;
}>;

type MenuItem = SlashItem | Readonly<{
  type: "reference";
  item: CommandContextCatalogItem;
}> | Readonly<{
  type: "upload";
  id: "upload";
  label: string;
  description: string;
}>;

type MenuGroupKey = "approach" | CommandContextKind;

type MenuLayout = Readonly<{
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  listMaxHeight: number;
  theme: Readonly<Record<string, string>>;
}>;

const mentionKindOrder: readonly CommandContextKind[] = [
  "agent",
  "file",
  "project",
  "skill",
  "plugin",
  "integration",
];

const menuThemeVariables = [
  "--background",
  "--surface",
  "--surface-raised",
  "--foreground",
  "--muted",
  "--line",
  "--primary",
  "--danger",
  "--warning",
] as const;

const slashActions: readonly SlashItem[] = [
  { type: "action", id: "research", label: "Research", description: "Investigate with current sources and citations." },
  { type: "action", id: "act", label: "Act", description: "Let Asael use connected services and governed actions." },
  { type: "action", id: "learn", label: "Learn", description: "Explain, organize, and add useful knowledge." },
  { type: "action", id: "plan", label: "Plan this", description: "Preview a durable multi-step plan before it runs." },
];

export function CommandComposerField({
  value,
  disabled,
  placeholder,
  selected,
  onChange,
  onSubmit,
  onSlashAction,
  onSelectReference,
  onRemoveReference,
}: {
  value: string;
  disabled: boolean;
  placeholder: string;
  selected: readonly CommandContextCatalogItem[];
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSlashAction: (action: CommandSlashAction) => void;
  onSelectReference: (item: CommandContextCatalogItem) => void;
  onRemoveReference: (item: CommandContextCatalogItem) => void;
}) {
  const listboxId = useId();
  const composerFieldRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const catalogRef = useRef<CommandContextCatalog | undefined>(undefined);
  const selectReferenceRef = useRef(onSelectReference);
  const [trigger, setTrigger] = useState<TriggerState>();
  const [menuLayout, setMenuLayout] = useState<MenuLayout>();
  const [catalog, setCatalog] = useState<CommandContextCatalog>();
  const [catalogError, setCatalogError] = useState<string>();
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string>();
  const [pendingUploads, setPendingUploads] = useState<readonly Readonly<{
    assetId: string;
    label: string;
  }>[]>([]);

  useEffect(() => {
    selectReferenceRef.current = onSelectReference;
  }, [onSelectReference]);

  const loadCatalog = useCallback(async (force = false) => {
    if (catalogRef.current && !force) return catalogRef.current;
    setCatalogLoading(true);
    setCatalogError(undefined);
    try {
      const response = await fetch("/api/command/catalog", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !isCatalog(payload)) {
        throw new Error(readError(payload, "Command context is temporarily unavailable."));
      }
      catalogRef.current = payload;
      setCatalog(payload);
      return payload;
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : "Command context is temporarily unavailable.");
      return undefined;
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!pendingUploads.length) return;
    let active = true;
    const check = async () => {
      const next = await loadCatalog(true);
      if (!active || !next) return;
      const remaining: Array<{ assetId: string; label: string }> = [];
      for (const pending of pendingUploads) {
        const item = next.items.find((candidate) =>
          candidate.kind === "file" && candidate.sourceId === pending.assetId
        );
        if (item?.selectable) {
          selectReferenceRef.current(item);
          setUploadNotice(`${pending.label} is ready and attached.`);
        } else if (item?.state === "failed" || item?.state === "unsupported") {
          setUploadNotice(`${pending.label} could not be prepared. Open Capture to review it.`);
        } else {
          remaining.push(pending);
        }
      }
      setPendingUploads((current) =>
        current.length === remaining.length &&
          current.every((item, index) => item.assetId === remaining[index]?.assetId)
          ? current
          : remaining
      );
    };
    const timer = window.setInterval(() => void check(), 2_500);
    void check();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadCatalog, pendingUploads]);

  const menuItems = useMemo<MenuItem[]>(() => {
    if (!trigger) return [];
    const query = trigger.query.trim().toLowerCase();
    const matches = (label: string, description: string) =>
      !query || label.toLowerCase().includes(query) || description.toLowerCase().includes(query);
    const selectedKeys = new Set(selected.map(referenceKey));

    if (trigger.symbol === "/") {
      const actions = slashActions.filter((item) =>
        matches(item.label, `Approach approaches ${item.description}`)
      );
      const skills = (catalog?.items || [])
        .filter((item) =>
          item.kind === "skill" &&
          item.selectable &&
          !selectedKeys.has(referenceKey(item)) &&
          matches(item.label, `${kindSearchTerms("skill")} ${item.description}`)
        )
        .slice(0, 8)
        .map((item) => ({ type: "reference" as const, item }));
      return [...actions, ...skills].slice(0, 12);
    }

    const limitPerKind = query ? 8 : 3;
    return mentionKindOrder.flatMap<MenuItem>((kind) => {
      const items: MenuItem[] = [];
      if (
        kind === "file" &&
        matches(
          "Attach files",
          "File files document documents upload attachment attachments image images audio video",
        )
      ) {
        items.push({
          type: "upload",
          id: "upload",
          label: "Attach files",
          description: "Upload, index, and use them as exact context.",
        });
      }
      items.push(...(catalog?.items || [])
        .filter((item) =>
          item.kind === kind &&
          item.selectable &&
          !selectedKeys.has(referenceKey(item)) &&
          matches(item.label, `${kindSearchTerms(item.kind)} ${item.description}`)
        )
        .slice(0, limitPerKind)
        .map((item) => ({ type: "reference" as const, item })));
      return items;
    });
  }, [catalog, selected, trigger]);

  const currentIndex = menuItems.length
    ? Math.min(activeIndex, menuItems.length - 1)
    : 0;
  const activeOptionId = menuItems[currentIndex]
    ? `${listboxId}-option-${currentIndex}`
    : undefined;
  const menuOpen = Boolean(trigger);

  // A closed menu keeps its last layout; the portal renders only while a
  // trigger is active, and reopening re-measures before paint.
  useLayoutEffect(() => {
    if (!menuOpen) return;

    const positionMenu = () => {
      const anchor = composerFieldRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const gutter = 8;
      const aboveSpace = Math.max(0, rect.top - gutter * 2);
      const belowSpace = Math.max(0, viewportHeight - rect.bottom - gutter * 2);
      const opensAbove = aboveSpace >= 260 || aboveSpace >= belowSpace;
      const availableHeight = opensAbove ? aboveSpace : belowSpace;
      const availableWidth = Math.max(0, viewportWidth - gutter * 2);
      const width = Math.min(Math.max(240, rect.width - gutter * 2), availableWidth);
      const left = Math.max(
        gutter,
        Math.min(rect.left + gutter, viewportWidth - gutter - width),
      );
      const computedStyle = window.getComputedStyle(anchor);
      const theme = Object.fromEntries(
        menuThemeVariables.map((name) => [name, computedStyle.getPropertyValue(name)]),
      );

      setMenuLayout({
        left,
        width,
        ...(opensAbove
          ? { bottom: viewportHeight - rect.top + gutter }
          : { top: rect.bottom + gutter }),
        listMaxHeight: Math.max(96, Math.min(288, availableHeight - 104)),
        theme,
      });
    };

    positionMenu();
    window.addEventListener("resize", positionMenu);
    document.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      document.removeEventListener("scroll", positionMenu, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!trigger || !activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId, trigger]);

  function updateTrigger(nextValue: string, caret: number) {
    const next = triggerAtCaret(nextValue, caret);
    setTrigger(next);
    setActiveIndex(0);
    if (next) void loadCatalog();
  }

  function replaceTrigger() {
    if (!trigger) return;
    const before = value.slice(0, trigger.start);
    const after = value.slice(trigger.end);
    const separator = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${separator}${after}`.replace(/ {2,}/g, " ");
    onChange(next);
    setTrigger(undefined);
    window.requestAnimationFrame(() => {
      const caret = Math.min(before.length + separator.length, next.length);
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  function choose(item: MenuItem) {
    if (item.type === "upload") {
      replaceTrigger();
      fileInputRef.current?.click();
      return;
    }
    if (item.type === "action") {
      replaceTrigger();
      onSlashAction(item.id);
      return;
    }
    replaceTrigger();
    onSelectReference(item.item);
  }

  async function uploadFiles(files: FileList | null) {
    const picked = Array.from(files || []);
    if (!picked.length) return;
    setUploading(true);
    setUploadNotice(undefined);
    const queued: Array<{ assetId: string; label: string }> = [];
    try {
      for (const file of picked.slice(0, 10)) {
        if (file.size > 6 * 1024 * 1024) {
          throw new Error(`${file.name} is larger than the 6 MB Command upload limit.`);
        }
        const form = new FormData();
        form.set("file", file);
        form.set("title", file.name.replace(/\.[^.]+$/, ""));
        form.set("tags", "command-context");
        const response = await fetch("/api/capture", {
          method: "POST",
          body: form,
          headers: { "idempotency-key": `command-attachment-${crypto.randomUUID()}` },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(readError(payload, `${file.name} could not be uploaded.`));
        const asset = isRecord(payload.asset) ? payload.asset : undefined;
        const assetId = typeof asset?.id === "string" ? asset.id : "";
        if (!assetId) throw new Error(`${file.name} was stored without an attachment receipt.`);
        queued.push({ assetId, label: file.name });
      }
      setPendingUploads((current) => [...current, ...queued]);
      setUploadNotice(`${queued.length} file${queued.length === 1 ? " is" : "s are"} processing. Asael will attach ${queued.length === 1 ? "it" : "them"} when ready.`);
    } catch (error) {
      setUploadNotice(error instanceof Error ? error.message : "The selected files could not be attached.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div ref={composerFieldRef} className="relative">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(event) => void uploadFiles(event.currentTarget.files)}
        tabIndex={-1}
      />

      {selected.length || pendingUploads.length || uploadNotice ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line/70 px-3 py-2" aria-label="Command context">
          {selected.map((item) => {
            const Icon = kindIcon(item.kind);
            return (
              <span key={referenceKey(item)} className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full bg-primary/10 px-2.5 text-xs font-semibold text-primary">
                <Icon size={13} aria-hidden="true" />
                <span className="max-w-44 truncate">{item.label}</span>
                <button
                  type="button"
                  onClick={() => onRemoveReference(item)}
                  className="grid size-5 place-items-center rounded-full hover:bg-primary/10"
                  aria-label={`Remove ${item.label}`}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </span>
            );
          })}
          {pendingUploads.map((item) => (
            <span key={item.assetId} className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full bg-warning/10 px-2.5 text-xs font-semibold text-warning">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              <span className="max-w-44 truncate">{item.label}</span>
            </span>
          ))}
          {uploadNotice ? <span className="basis-full text-[11px] leading-4 text-muted" role="status">{uploadNotice}</span> : null}
        </div>
      ) : null}

      <label className="block">
        <span className="sr-only">Message Asael</span>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            const next = event.currentTarget.value;
            onChange(next);
            updateTrigger(next, event.currentTarget.selectionStart);
          }}
          onClick={(event) => updateTrigger(value, event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (trigger && menuItems.length) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) => {
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  return (current + direction + menuItems.length) % menuItems.length;
                });
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                choose(menuItems[currentIndex]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setTrigger(undefined);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
          onKeyUp={(event) => {
            if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
            updateTrigger(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          rows={2}
          required
          disabled={disabled}
          placeholder={placeholder}
          className="max-h-40 min-h-14 w-full resize-none bg-transparent px-4 pb-2 pt-3 text-sm leading-6 outline-none placeholder:text-muted/75 disabled:cursor-not-allowed disabled:opacity-60"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={Boolean(trigger)}
          aria-controls={trigger ? listboxId : undefined}
          aria-activedescendant={trigger ? activeOptionId : undefined}
        />
      </label>

      {trigger && menuLayout && typeof document !== "undefined" ? createPortal(
        <div
          className="fixed z-[100] overflow-hidden rounded-2xl border border-line bg-surface/98 text-foreground shadow-2xl backdrop-blur-xl"
          style={{
            left: menuLayout.left,
            width: menuLayout.width,
            top: menuLayout.top,
            bottom: menuLayout.bottom,
            ...menuLayout.theme,
          } as CSSProperties}
        >
          <div className="flex items-center justify-between gap-3 border-b border-line/70 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid size-7 place-items-center rounded-full bg-primary/10 font-mono text-xs font-bold text-primary">{trigger.symbol}</span>
              <span className="min-w-0">
                <strong className="block text-xs">{trigger.symbol === "/" ? "Use a Skill or choose an approach" : "Add context"}</strong>
                <span className="block truncate text-[11px] text-muted">{trigger.symbol === "/" ? "Approaches guide the task; Skills teach Asael how to work." : "Agents, Files, Projects, Skills, Plugins, and Integrations."}</span>
              </span>
            </div>
            {catalogLoading || uploading ? <Loader2 size={14} className="animate-spin text-primary" aria-label="Loading command context" /> : null}
          </div>
          <div
            id={listboxId}
            role="listbox"
            className="overflow-y-auto p-1.5"
            style={{ maxHeight: menuLayout.listMaxHeight }}
          >
            {menuItems.map((item, index) => {
              const presentation = menuItemPresentation(item);
              const Icon = presentation.icon;
              const group = menuItemGroup(item);
              const previousGroup = index ? menuItemGroup(menuItems[index - 1]) : undefined;
              const startsGroup = !previousGroup || previousGroup.key !== group.key;
              const groupSize = menuItems.filter((candidate) => menuItemGroup(candidate).key === group.key).length;
              return (
                <Fragment key={presentation.key}>
                  {startsGroup ? (
                    <div className={clsx("flex items-center gap-2 px-3 pb-1 pt-2", index ? "mt-1 border-t border-line/55" : "")} role="presentation">
                      <span className="text-[10px] font-bold uppercase tracking-[.16em] text-muted">{group.label}</span>
                      <span className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[9px] font-semibold text-muted" aria-hidden="true">{groupSize}</span>
                      <span className="h-px min-w-4 flex-1 bg-line/60" aria-hidden="true" />
                    </div>
                  ) : null}
                  <button
                    id={`${listboxId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === currentIndex}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(item)}
                    className={clsx(
                      "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition",
                      index === currentIndex ? "bg-primary/10" : "hover:bg-surface-raised",
                    )}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-background text-primary"><Icon size={15} aria-hidden="true" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <strong className="truncate text-xs">{presentation.label}</strong>
                        {presentation.kind ? <small className="shrink-0 uppercase tracking-[.12em] text-muted">{presentation.kind}</small> : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted">{presentation.description}</span>
                    </span>
                  </button>
                </Fragment>
              );
            })}
            {!menuItems.length && !catalogLoading ? (
              <div className="px-4 py-6 text-center">
                <Search size={18} className="mx-auto text-muted" aria-hidden="true" />
                <p className="mt-2 text-xs font-semibold">No matching context</p>
                <p className="mt-1 text-[11px] text-muted">Try another name or open Capabilities to add it.</p>
              </div>
            ) : null}
            {catalogError ? <p className="px-3 py-2 text-xs leading-5 text-danger" role="status">{catalogError}</p> : null}
          </div>
          <div className="flex items-center justify-between border-t border-line/70 px-3 py-2 text-[10px] text-muted">
            <span>↑↓ choose · Enter add · Esc close</span>
            <span>{selected.length} attached</span>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function triggerAtCaret(value: string, caret: number): TriggerState | undefined {
  const before = value.slice(0, caret);
  const match = before.match(/(?:^|\s)([/@])([^\s/@]*)$/);
  if (!match || (match[1] !== "/" && match[1] !== "@")) return undefined;
  const leading = match[0].length - match[0].trimStart().length;
  const start = (match.index || 0) + leading;
  return {
    symbol: match[1],
    query: match[2] || "",
    start,
    end: caret,
  };
}

function referenceKey(item: Pick<CommandContextCatalogItem, "kind" | "id">) {
  return `${item.kind}:${item.id}`;
}

function kindLabel(kind: CommandContextKind) {
  return ({
    agent: "Agent",
    skill: "Skill",
    plugin: "Plugin",
    project: "Project",
    integration: "Integration",
    file: "File",
  } as const)[kind];
}

function kindSearchTerms(kind: CommandContextKind) {
  return ({
    agent: "Agent Agents assistant assistants",
    skill: "Skill Skills capability capabilities",
    plugin: "Plugin Plugins Extension Extensions MCP server servers",
    project: "Project Projects workspace workspaces",
    integration: "Integration Integrations Connection Connections connected service services",
    file: "File Files document documents attachment attachments",
  } as const)[kind];
}

function menuItemGroup(item: MenuItem): Readonly<{ key: MenuGroupKey; label: string }> {
  if (item.type === "action") return { key: "approach", label: "Approaches" };
  const key = item.type === "upload" ? "file" : item.item.kind;
  return {
    key,
    label: ({
      agent: "Agents",
      skill: "Skills",
      plugin: "Plugins",
      project: "Projects",
      integration: "Integrations",
      file: "Files",
    } as const)[key],
  };
}

function kindIcon(kind: CommandContextKind) {
  return ({
    agent: Bot,
    skill: WandSparkles,
    plugin: Puzzle,
    project: FolderKanban,
    integration: Cable,
    file: FileText,
  } as const)[kind];
}

function menuItemPresentation(item: MenuItem) {
  if (item.type === "upload") {
    return { key: "upload", label: item.label, description: item.description, kind: "File", icon: Paperclip };
  }
  if (item.type === "action") {
    const icons = { research: Search, act: Play, learn: Brain, plan: Sparkles } as const;
    return { key: `action:${item.id}`, label: item.label, description: item.description, kind: "Approach", icon: icons[item.id] };
  }
  return {
    key: referenceKey(item.item),
    label: item.item.label,
    description: item.item.description,
    kind: kindLabel(item.item.kind),
    icon: kindIcon(item.item.kind),
  };
}

function isCatalog(value: unknown): value is CommandContextCatalog {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) return false;
  return value.items.every((item) =>
    isRecord(item) &&
    typeof item.kind === "string" &&
    typeof item.id === "string" &&
    typeof item.label === "string" &&
    typeof item.description === "string" &&
    typeof item.selectable === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readError(value: unknown, fallback: string) {
  if (!isRecord(value)) return fallback;
  return typeof value.message === "string"
    ? value.message
    : typeof value.error === "string"
      ? value.error
      : fallback;
}
