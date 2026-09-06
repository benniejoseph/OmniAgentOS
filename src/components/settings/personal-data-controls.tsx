"use client";

import { Download, FileUp, Loader2, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { clsx } from "clsx";

export function PersonalDataControls() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [archive, setArchive] = useState<File>();
  const [includeAssets, setIncludeAssets] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [restoreNeedsPassphrase, setRestoreNeedsPassphrase] = useState(false);
  const [busy, setBusy] = useState<"export" | "restore">();
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();

  async function downloadArchive() {
    setBusy("export"); setMessage(undefined);
    try {
      if (includeAssets && exportPassphrase.normalize("NFKC").length < 12) {
        throw new Error("Use at least 12 characters to encrypt original assets.");
      }
      const response = await fetch("/api/data/export", includeAssets ? {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ includeAssets: true, assetPassphrase: exportPassphrase }),
        cache: "no-store",
      } : { cache: "no-store" });
      if (!response.ok) throw new Error("Asael could not prepare the archive.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = dispositionFilename(response.headers.get("content-disposition")) || `asael-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage({
        tone: "success",
        text: includeAssets
          ? "Verified archive downloaded with eligible originals encrypted. Keep its passphrase separately."
          : "Verified portable archive downloaded. Original assets were explicitly excluded.",
      });
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : "Export failed." }); }
    finally { setBusy(undefined); }
  }

  async function restoreArchive() {
    if (!archive) return;
    setBusy("restore"); setMessage(undefined);
    try {
      if (archive.size > 4 * 1024 * 1024) throw new Error("Portable archives must be 4 MB or smaller.");
      const payload = JSON.parse(await archive.text()) as unknown;
      if (archiveContainsEncryptedAssets(payload) && !restorePassphrase) {
        throw new Error("Enter the passphrase used to encrypt this archive's assets.");
      }
      const requestPayload = archiveContainsEncryptedAssets(payload)
        ? { archive: payload, assetPassphrase: restorePassphrase }
        : payload;
      const response = await fetch("/api/data/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestPayload) });
      const body = await response.json().catch(() => ({})) as PortableRestoreResponse;
      if (!response.ok) throw new Error(body.error || "Restore failed.");
      const count = restoredRecordCount(body.restored);
      const receipt = body.restored?.verification?.receiptSha256?.slice(0, 12);
      const connections = body.restored?.connectionsReauthorizationRequired || 0;
      setMessage({ tone: "success", text: `Verified restore complete · ${count} records processed${receipt ? ` · receipt ${receipt}` : ""}.${connections ? ` ${connections} connection${connections === 1 ? "" : "s"} must be reauthorized.` : ""}` });
      setArchive(undefined);
      setRestorePassphrase("");
      setRestoreNeedsPassphrase(false);
      if (inputRef.current) inputRef.current.value = "";
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : "Restore failed." }); }
    finally { setBusy(undefined); }
  }

  return <section className="mt-4 overflow-hidden rounded-lg border border-line bg-surface p-5 sm:p-6" aria-labelledby="personal-data-title">
    <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"><ShieldCheck size={18} aria-hidden="true" /></span><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Ownership and recovery</p><h2 id="personal-data-title" className="mt-1 text-lg font-semibold">Your portable Asael archive</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-muted">Archive v2 declares counts, hashes, inclusions, and exclusions. Secrets never leave Asael, and restored connections always require reauthorization.</p></div></div>
    <div className="mt-5 grid gap-4 md:grid-cols-2">
      <div className="rounded-lg border border-line bg-background p-4"><h3 className="text-sm font-semibold">Export</h3><p className="mt-1 text-xs leading-5 text-muted">Knowledge, memories, conversations, focus items, projects, skills, and agents are included. Connector credentials, secrets, embeddings, and audit data are excluded.</p><label className="mt-4 flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1 accent-primary" checked={includeAssets} onChange={(event) => setIncludeAssets(event.target.checked)} /><span><strong className="block text-foreground">Include eligible original assets</strong><span className="text-muted">Up to 25 originals / 2 MB, encrypted before download.</span></span></label>{includeAssets ? <label className="mt-3 block text-xs font-semibold">Asset passphrase<input type="password" autoComplete="new-password" value={exportPassphrase} onChange={(event) => setExportPassphrase(event.target.value)} minLength={12} maxLength={256} placeholder="12 characters minimum" className="mt-1 block h-10 w-full rounded-md border border-line bg-surface px-3 text-sm font-normal outline-none focus:border-primary" /></label> : null}<button type="button" onClick={() => void downloadArchive()} disabled={Boolean(busy)} className="primary-button mt-4">{busy === "export" ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}{busy === "export" ? "Preparing…" : "Download archive v2"}</button></div>
      <div className="rounded-lg border border-line bg-background p-4"><h3 className="text-sm font-semibold">Restore</h3><p className="mt-1 text-xs leading-5 text-muted">Choose a v1 or verified v2 archive. Contents are rebound to your ownership; existing idempotent records are preserved.</p><div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => inputRef.current?.click()} disabled={Boolean(busy)} className="action-button"><FileUp size={15} aria-hidden="true" />{archive ? archive.name : "Choose archive"}</button>{archive ? <button type="button" onClick={() => void restoreArchive()} disabled={Boolean(busy)} className="primary-button">{busy === "restore" ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : null}{busy === "restore" ? "Restoring…" : "Verify and restore"}</button> : null}<input ref={inputRef} type="file" accept="application/json,.json" className="sr-only" aria-label="Choose an Asael archive to restore" onChange={(event) => void selectArchive(event.target.files?.[0])} /></div>{restoreNeedsPassphrase ? <label className="mt-3 block text-xs font-semibold">Archive asset passphrase<input type="password" autoComplete="current-password" value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} maxLength={256} className="mt-1 block h-10 w-full rounded-md border border-line bg-surface px-3 text-sm font-normal outline-none focus:border-primary" /></label> : null}</div>
    </div>
    {message ? <p role="status" className={clsx("mt-4 rounded-md border px-3 py-2 text-sm", message.tone === "success" ? "border-primary/30 bg-primary/8" : "border-danger/35 bg-danger/10 text-danger")}>{message.text}</p> : null}
  </section>;

  async function selectArchive(file?: File) {
    setArchive(file);
    setRestorePassphrase("");
    setRestoreNeedsPassphrase(false);
    setMessage(undefined);
    if (!file) return;
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error("Portable archives must be 4 MB or smaller.");
      setRestoreNeedsPassphrase(archiveContainsEncryptedAssets(JSON.parse(await file.text())));
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Archive could not be read." });
    }
  }
}

type PortableRestoreResponse = {
  error?: string;
  restored?: Partial<Record<PortableRestoredCountKey, number>> & {
    connectionsReauthorizationRequired?: number;
    verification?: { receiptSha256?: string };
  };
};

const portableRestoredCountKeys = [
  "knowledge", "memories", "threads", "turns", "today", "projects",
  "skills", "agents", "assets",
] as const;
type PortableRestoredCountKey = typeof portableRestoredCountKeys[number];

function restoredRecordCount(restored: PortableRestoreResponse["restored"]) {
  return portableRestoredCountKeys.reduce(
    (sum, key) => sum + Number(restored?.[key] || 0),
    0,
  );
}

function archiveContainsEncryptedAssets(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const archive = value as Record<string, unknown>;
  if (archive.version !== 2 || !archive.assetEncryption) return false;
  const data = archive.data;
  return Boolean(
    data && typeof data === "object" && !Array.isArray(data) &&
    Array.isArray((data as Record<string, unknown>).assets) &&
    ((data as Record<string, unknown>).assets as unknown[]).length,
  );
}

function dispositionFilename(value: string | null) {
  return value?.match(/filename="?([^";]+)"?/i)?.[1];
}
