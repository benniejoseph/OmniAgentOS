"use client";

import { Download, FileUp, Loader2, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { clsx } from "clsx";

export function PersonalDataControls() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [archive, setArchive] = useState<File>();
  const [busy, setBusy] = useState<"export" | "restore">();
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();

  async function downloadArchive() {
    setBusy("export"); setMessage(undefined);
    try {
      const response = await fetch("/api/data/export", { cache: "no-store" });
      if (!response.ok) throw new Error("Asael could not prepare the archive.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = dispositionFilename(response.headers.get("content-disposition")) || `asael-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage({ tone: "success", text: "Portable archive downloaded to this device." });
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : "Export failed." }); }
    finally { setBusy(undefined); }
  }

  async function restoreArchive() {
    if (!archive) return;
    setBusy("restore"); setMessage(undefined);
    try {
      if (archive.size > 10 * 1024 * 1024) throw new Error("Portable archives must be 10 MB or smaller.");
      const payload = JSON.parse(await archive.text()) as unknown;
      const response = await fetch("/api/data/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({})) as { error?: string; restored?: Record<string, number> };
      if (!response.ok) throw new Error(body.error || "Restore failed.");
      const count = Object.values(body.restored || {}).reduce((sum, value) => sum + Number(value || 0), 0);
      setMessage({ tone: "success", text: `Restore complete · ${count} records processed. Existing idempotent memories and knowledge were preserved.` });
      setArchive(undefined);
      if (inputRef.current) inputRef.current.value = "";
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : "Restore failed." }); }
    finally { setBusy(undefined); }
  }

  return <section className="mt-4 overflow-hidden rounded-lg border border-line bg-surface p-5 sm:p-6" aria-labelledby="personal-data-title">
    <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"><ShieldCheck size={18} aria-hidden="true" /></span><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Ownership and recovery</p><h2 id="personal-data-title" className="mt-1 text-lg font-semibold">Your portable Asael archive</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-muted">Download knowledge, memories, conversations, focus items, and projects as readable JSON. Restores are additive and keep existing idempotent records.</p></div></div>
    <div className="mt-5 grid gap-4 md:grid-cols-2">
      <div className="rounded-lg border border-line bg-background p-4"><h3 className="text-sm font-semibold">Export</h3><p className="mt-1 text-xs leading-5 text-muted">Use this between infrastructure backups or before major changes.</p><button type="button" onClick={() => void downloadArchive()} disabled={Boolean(busy)} className="primary-button mt-4">{busy === "export" ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}{busy === "export" ? "Preparing…" : "Download archive"}</button></div>
      <div className="rounded-lg border border-line bg-background p-4"><h3 className="text-sm font-semibold">Restore</h3><p className="mt-1 text-xs leading-5 text-muted">Choose an Asael portable archive. Nothing is deleted or overwritten.</p><div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => inputRef.current?.click()} disabled={Boolean(busy)} className="action-button"><FileUp size={15} aria-hidden="true" />{archive ? archive.name : "Choose archive"}</button>{archive ? <button type="button" onClick={() => void restoreArchive()} disabled={Boolean(busy)} className="primary-button">{busy === "restore" ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : null}{busy === "restore" ? "Restoring…" : "Restore archive"}</button> : null}<input ref={inputRef} type="file" accept="application/json,.json" className="sr-only" aria-label="Choose an Asael archive to restore" onChange={(event) => { setArchive(event.target.files?.[0]); setMessage(undefined); }} /></div></div>
    </div>
    {message ? <p role="status" className={clsx("mt-4 rounded-md border px-3 py-2 text-sm", message.tone === "success" ? "border-primary/30 bg-primary/8" : "border-danger/35 bg-danger/10 text-danger")}>{message.text}</p> : null}
  </section>;
}

function dispositionFilename(value: string | null) {
  return value?.match(/filename="?([^";]+)"?/i)?.[1];
}
