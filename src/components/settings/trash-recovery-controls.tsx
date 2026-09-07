"use client";

import { Loader2, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { clsx } from "clsx";

type TrashItem = {
  trashId: string;
  resourceType: "custom_agent" | "agent_skill" | "mcp_connector" | "openapi_connector";
  resourceId: string;
  displayLabel: string;
  state: "retained" | "restored" | "purged" | "expired";
  restoreUntil: string;
  compensation: {
    kind: "exact_restore" | "equivalent_action" | "unavailable";
    limitation: string | null;
  };
};

type TrashPreview = {
  version: "p9.3-trash-preview:1";
  action: "restore" | "purge";
  trashId: string;
  resourceType: TrashItem["resourceType"];
  resourceId: string;
  lifecycleRevision: number;
  targetSha256: string;
  effectSummary: string;
  reversible: boolean;
  issuedAt: string;
  expiresAt: string;
  previewSha256: string;
};

export function TrashRecoveryControls() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [message, setMessage] = useState<{
    tone: "success" | "error";
    text: string;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  async function load(signal?: AbortSignal) {
    try {
      const payload = await requestJson<{ items?: TrashItem[] }>(
        "/api/trash?state=retained&limit=100",
        { cache: "no-store", signal },
      );
      setItems(payload.items || []);
    } catch (error) {
      if (!signal?.aborted) {
        setMessage({
          tone: "error",
          text: error instanceof Error ? error.message : "Trash could not be loaded.",
        });
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  async function restore(item: TrashItem) {
    setBusyId(item.trashId);
    setMessage(undefined);
    try {
      const prepared = await requestJson<{ preview?: TrashPreview }>(
        `/api/trash/${encodeURIComponent(item.trashId)}/restore`,
        { cache: "no-store" },
      );
      if (!prepared.preview) throw new Error("Restore preview was not returned.");
      const limitation = item.compensation.limitation
        ? `\n\nLimitation: ${item.compensation.limitation}`
        : "";
      if (!window.confirm(`${prepared.preview.effectSummary}${limitation}`)) return;
      const result = await requestJson<{
        effectReceipt?: { receiptSha256?: string };
        restoredResourceIds?: string[];
      }>(`/api/trash/${encodeURIComponent(item.trashId)}/restore`, {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({ preview: prepared.preview }),
      });
      setMessage({
        tone: "success",
        text: `Restored ${item.displayLabel}${receiptSuffix(result.effectReceipt?.receiptSha256)}.`,
      });
      await load();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Restore failed.",
      });
    } finally {
      setBusyId(undefined);
    }
  }

  async function purge(item: TrashItem) {
    setBusyId(item.trashId);
    setMessage(undefined);
    try {
      const prepared = await requestJson<{ preview?: TrashPreview }>(
        `/api/trash/${encodeURIComponent(item.trashId)}/purge`,
        { cache: "no-store" },
      );
      if (!prepared.preview) throw new Error("Purge preview was not returned.");
      if (!window.confirm(
        `${prepared.preview.effectSummary}\n\nThis permanently removes the restore snapshot. The audit receipt remains.`,
      )) return;
      const result = await requestJson<{
        finalDeletionReceipt?: { receiptSha256?: string };
      }>(`/api/trash/${encodeURIComponent(item.trashId)}/purge`, {
        method: "DELETE",
        headers: mutationHeaders(),
        body: JSON.stringify({ preview: prepared.preview }),
      });
      setMessage({
        tone: "success",
        text: `Permanently purged ${item.displayLabel}${receiptSuffix(result.finalDeletionReceipt?.receiptSha256)}.`,
      });
      await load();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Permanent purge failed.",
      });
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section className="mt-4 overflow-hidden rounded-lg border border-line bg-surface p-5 sm:p-6" aria-labelledby="trash-recovery-title">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <RotateCcw size={18} aria-hidden="true" />
        </span>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Reversible changes</p>
          <h2 id="trash-recovery-title" className="mt-1 text-lg font-semibold">Trash and recovery</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">Deleted Agents, Skills, and connectors remain actor-private and restorable for 30 days. Permanent purge always requires a separate exact preview.</p>
        </div>
      </div>

      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={clsx("mt-4 rounded-md border px-3 py-2 text-sm", message.tone === "success" ? "border-primary/30 bg-primary/8" : "border-danger/35 bg-danger/10 text-danger")}>{message.text}</p>
      ) : null}

      {loading ? (
        <p className="mt-5 flex items-center gap-2 text-sm text-muted"><Loader2 size={15} className="animate-spin" aria-hidden="true" />Loading retained items…</p>
      ) : items.length ? (
        <div className="mt-5 space-y-3">
          {items.map((item) => (
            <article key={item.trashId} className="flex flex-col gap-3 rounded-lg border border-line bg-background p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold">{item.displayLabel}</h3>
                <p className="mt-1 text-xs leading-5 text-muted">{resourceLabel(item.resourceType)} · restore until {formatDate(item.restoreUntil)}</p>
                {item.compensation.limitation ? <p className="mt-1 text-xs leading-5 text-warning">{item.compensation.limitation}</p> : null}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button type="button" className="action-button" disabled={Boolean(busyId)} onClick={() => void restore(item)}>{busyId === item.trashId ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}Restore</button>
                <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-md border border-danger/35 px-3 text-sm font-semibold text-danger disabled:opacity-50" disabled={Boolean(busyId)} onClick={() => void purge(item)}><Trash2 size={14} aria-hidden="true" />Purge permanently</button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="mt-5 flex items-center gap-2 rounded-lg border border-dashed border-line bg-background p-4 text-sm text-muted"><ShieldCheck size={16} aria-hidden="true" />Trash is empty.</div>
      )}
    </section>
  );
}

async function requestJson<T>(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.message || payload.error || "Request failed.");
  return payload;
}

function mutationHeaders() {
  return {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
  };
}

function resourceLabel(value: TrashItem["resourceType"]) {
  return ({
    custom_agent: "Custom Agent",
    agent_skill: "Custom Skill",
    mcp_connector: "MCP connector",
    openapi_connector: "OpenAPI connector",
  } as const)[value];
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}

function receiptSuffix(value?: string) {
  return value ? ` · receipt ${value.slice(0, 12)}` : "";
}
