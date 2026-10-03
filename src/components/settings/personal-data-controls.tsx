"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { AdvancedSettingsBoundary, mutationOptions, settingsJson, useAdvancedSettingsActions } from "./settings-advanced-lifecycle";
import { archiveContainsEncryptedAssets, readPortableRestore, settingsJsonSha256 } from "./settings-recovery-state";
import { digest, object } from "./settings-advanced-state";
import { Metadata, SettingsCheck, SettingsField } from "./settings-advanced-ui";
import styles from "./settings-advanced.module.css";

export function PersonalDataControls() {
  return <AdvancedSettingsBoundary><PersonalDataContent /></AdvancedSettingsBoundary>;
}
function PersonalDataContent() {
  const actions = useAdvancedSettingsActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const [archive, setArchive] = useState<{ file: File; value: unknown }>();
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState<string>();
  const [includeAssets, setIncludeAssets] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [download, setDownload] = useState<string>();
  const [receipt, setReceipt] = useState<Awaited<ReturnType<typeof readPortableRestore>>>();
  useLayoutEffect(() => () => { selection.current++; }, []);
  const exportingBlocked = actions.blocked("read");
  const restoreBlocked = actions.blocked("write.memory");
  const needsPassphrase = archiveContainsEncryptedAssets(archive?.value);
  const validPassphrase = !includeAssets || exportPassphrase.normalize("NFKC").length >= 12 && exportPassphrase.length <= 256;
  async function selectArchive(file?: File) {
    const epoch = ++selection.current;
    setArchive(undefined); setRestorePassphrase(""); setSelectionError(undefined); setSelecting(Boolean(file));
    if (!file) return;
    try {
      if (file.size === 0 || file.size > 4 * 1024 * 1024) throw new Error("Choose a nonempty JSON archive no larger than 4 MB.");
      const value: unknown = JSON.parse(await file.text());
      if (!object(value)) throw new Error("The archive must be a JSON object.");
      if (epoch === selection.current) setArchive({ file, value });
    } catch (failure) { if (epoch === selection.current) setSelectionError(failure instanceof Error ? failure.message : "This archive could not be read."); }
    finally { if (epoch === selection.current) setSelecting(false); }
  }
  async function downloadArchive() {
    if (actions.busy || exportingBlocked || !validPassphrase) return;
    const submitted = { includeAssets, assetPassphrase: exportPassphrase };
    const result = await actions.run({ label: "Prepare archive", permission: "read", fingerprint: JSON.stringify(["archive.export", submitted]), replayable: true, success: "Archive preparation completed. Browser download requested.", execute: async ({ current }) => {
      const response = await fetch("/api/data/export", { cache: "no-store", signal: AbortSignal.timeout(150_000), ...(submitted.includeAssets ? mutationOptions("POST", submitted) : {}) });
      if (!response.ok) throw new Error(`The archive could not be prepared (${response.status}).`);
      const blob = await response.blob();
      const value: unknown = JSON.parse(await blob.text());
      if (!object(value) || value.format !== "asael-portable-archive" || value.version !== 2 || !object(value.data) || !digest(value.archiveSha256)) throw new Error("The export returned an incomplete v2 archive; no download was requested.");
      const { archiveSha256, ...body } = value;
      if (await settingsJsonSha256(body) !== archiveSha256) throw new Error("The exported archive digest did not match; no download was requested.");
      if (!current()) return;
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/i)?.[1]?.replace(/[\\/\u0000-\u001f]/g, "_") || "asael-portable-archive.json";
        anchor.click();
      } finally { URL.revokeObjectURL(url); }
      return archiveSha256;
    } });
    if (result) { setDownload(result.value); setExportPassphrase(""); }
  }
  async function restoreArchive() {
    if (actions.busy || restoreBlocked || !archive || selecting || needsPassphrase && !restorePassphrase) return;
    const submitted = archive;
    const body = needsPassphrase ? { archive: submitted.value, assetPassphrase: restorePassphrase } : submitted.value;
    const result = await actions.run({ label: "Restore archive", permission: "write.memory", fingerprint: JSON.stringify(["archive.restore", body]), replayable: false, success: "The archive restore response was confirmed.", execute: async () => readPortableRestore(await settingsJson("/api/data/restore", mutationOptions("POST", body), 300_000), submitted.value, actions.session?.context?.tenantId) });
    if (result) { setReceipt(result.value); setArchive(undefined); setRestorePassphrase(""); selection.current++; if (inputRef.current) inputRef.current.value = ""; }
  }
  return <section className={`${styles.workspace} ${styles.panel}`} aria-labelledby="personal-data-title">
    <h3 id="personal-data-title">Your portable Asael archive</h3><p>Archive v2 declares counts, hashes, inclusions and exclusions. Credentials, embeddings and audit data are excluded; restored connections require reauthorization.</p>
    <section className={styles.panel} aria-label="Export personal data"><h4>Export</h4><p>Knowledge, memories, conversations, focus items, projects, skills and Agents are included. Eligible originals can be included as encrypted assets: up to 25 originals / 2 MB.</p>
      <fieldset disabled={Boolean(actions.busy)}><SettingsCheck label="Include eligible original assets" checked={includeAssets} onChange={setIncludeAssets} />{includeAssets ? <div className={styles.fields}><SettingsField label="Asset passphrase"><input type="password" autoComplete="new-password" value={exportPassphrase} minLength={12} maxLength={256} onChange={(event) => setExportPassphrase(event.target.value)} /></SettingsField><p className={styles.support}>Use 12–256 characters and keep the passphrase separately from the archive.</p></div> : null}</fieldset>
      {exportingBlocked ? <p className={styles.warning}>{exportingBlocked}</p> : null}<div className={styles.actions}><button type="button" className={styles.primary} disabled={Boolean(actions.busy) || Boolean(exportingBlocked) || !validPassphrase} onClick={() => void downloadArchive()}>Download archive v2</button></div>
      {download ? <div role="status" className={styles.receipt}><p>Archive prepared; browser download requested. Check your browser downloads for the saved file.</p><Metadata items={[{ label: "Archive digest", value: download }]} /></div> : null}
    </section>
    <section className={styles.panel} aria-label="Restore personal data"><h4>Restore</h4><p>Choose a v1 or v2 archive, up to 4 MB. Records are rebound to your current ownership. This endpoint has no general replay guarantee; an unconfirmed response must be checked before another restore.</p>
      <SettingsField label="Choose an Asael archive to restore"><input ref={inputRef} type="file" accept="application/json,.json" disabled={Boolean(actions.busy)} onChange={(event) => void selectArchive(event.target.files?.[0])} /></SettingsField>
      {selecting ? <p role="status">Reading the selected local archive…</p> : null}
      {archive ? <Metadata items={[{ label: "Selected archive", value: archive.file.name }, { label: "Bytes", value: archive.file.size }, { label: "Version", value: object(archive.value) ? String(archive.value.version ?? "Legacy") : "Unknown" }]} /> : null}
      {needsPassphrase ? <SettingsField label="Archive asset passphrase"><input type="password" autoComplete="current-password" value={restorePassphrase} maxLength={256} disabled={Boolean(actions.busy)} onChange={(event) => setRestorePassphrase(event.target.value)} /></SettingsField> : null}
      {selectionError ? <p role="alert" className={styles.error}>{selectionError}</p> : null}{restoreBlocked ? <p className={styles.warning}>{restoreBlocked}</p> : null}
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={Boolean(actions.busy) || Boolean(restoreBlocked) || !archive || selecting || needsPassphrase && !restorePassphrase} onClick={() => void restoreArchive()}>Verify and restore</button></div>
      {receipt ? <div className={styles.receipt} role="status"><p>{receipt.verification ? "V2 restore receipt confirmed" : "Legacy restore response confirmed; no v2 verification receipt was returned"} · {receipt.count} records processed.</p>{receipt.verification ? <><Metadata items={[{ label: "Receipt digest", value: String(receipt.verification.receiptSha256) }, { label: "Archive digest", value: String(receipt.verification.archiveSha256) }, { label: "Connections requiring reauthorization", value: receipt.reauthorization }, { label: "Verified at", value: String(receipt.verification.verifiedAt) }]} /><details><summary>Full restore verification receipt</summary><pre>{JSON.stringify(receipt.verification, null, 2)}</pre></details></> : null}</div> : null}
    </section>
    {actions.error ? <p className={styles.error}>{actions.error}</p> : null}
  </section>;
}
