"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { BookOpen, Check, FileText, FolderOpen, ImagePlus, Loader2, RefreshCw, Upload, X } from "lucide-react";
import type { WorkspaceLibraryItem } from "@/lib/library/contracts";
import { useWorkspaceSession, canPerform } from "@/components/app-shell/session-context";
import { dateLabel, errorText, FILE_STATUS_LABELS, FILE_TYPE_LABELS, jsonWrite, LibraryPicker, Notice, readJson } from "./csm-workspace-shared";
import styles from "./csm-workspace.module.css";

type RoleContext = {
  schemaVersion: 1;
  text: string;
  revision: string | null;
  acceptedRevision?: string;
  sources: WorkspaceLibraryItem[];
  sourceLinks: { libraryItemId: string; versionId: string; contentSha256: string; status: "current" | "processing" | "changed" | "unavailable" }[];
  context: { scope: "user"; canWrite: boolean };
  limits: { textCharacters: number; sourceCount: number };
};
const BASE = "/api/csm/role-context";

export function CsmRoleContext({ active }: { active: boolean }) {
  const { role } = useWorkspaceSession();
  const [saved, setSaved] = useState<RoleContext>();
  const [draft, setDraft] = useState("");
  const [draftRevision, setDraftRevision] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const owner = useRef(new AbortController());
  const loaded = useRef(false);
  const editCount = useRef(0);
  const keys = useRef(new Map<string, string>());
  const uploadRef = useRef<HTMLInputElement>(null);
  const dirty = Boolean(saved && draft !== saved.text);
  const canWrite = Boolean(saved?.context.canWrite && canPerform(role, "run.agent"));

  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    owner.current.signal.throwIfAborted();
    const result = await readJson<T>(path, { ...init, signal: owner.current.signal });
    owner.current.signal.throwIfAborted();
    return result;
  }, []);
  function accept(result: RoleContext, replaceDraft = false) {
    if (result.acceptedRevision && result.acceptedRevision !== result.revision) {
      throw new Error("Your change was saved, then updated elsewhere. Reload the latest role context before making another change.");
    }
    setSaved(result);
    if (replaceDraft) setDraft(result.text);
    setDraftRevision(result.revision);
  }
  const load = useCallback(async () => {
    const openingEditCount = editCount.current;
    const result = await request<RoleContext>(BASE);
    if (openingEditCount !== editCount.current) return;
    setSaved(result); setDraft(result.text); setDraftRevision(result.revision);
    loaded.current = true; setLoading(false); setError("");
  }, [request]);
  useEffect(() => {
    if (owner.current.signal.aborted) owner.current = new AbortController();
    return () => owner.current.abort();
  }, []);
  useEffect(() => {
    if (!active || loaded.current) return;
    void load().catch((caught) => { if (!owner.current.signal.aborted) { setError(errorText(caught)); setLoading(false); } });
  }, [active, load]);
  useEffect(() => {
    if (!active || busy || dirty || !saved?.sourceLinks.some((link) => link.status === "processing")) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load().catch((caught) => { if (!owner.current.signal.aborted) setError(errorText(caught)); });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [active, busy, dirty, load, saved?.sourceLinks]);
  function keyFor(action: string, payload: unknown) {
    const binding = JSON.stringify([action, payload]);
    let key = keys.current.get(binding);
    if (!key) { key = crypto.randomUUID(); keys.current.set(binding, key); }
    return key;
  }
  async function act(name: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(name); setError(""); setNotice("");
    try { await action(); }
    catch (caught) { if (!owner.current.signal.aborted) setError(errorText(caught)); }
    finally { if (!owner.current.signal.aborted) setBusy(""); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!saved || !canWrite) return;
    const body = { text: draft, expectedRevision: draftRevision };
    await act("save", async () => {
      const result = await request<RoleContext>(BASE, jsonWrite("PUT", body, keyFor("save", body)));
      accept(result, true); setNotice("Role notes saved. Your CSM assistant will use this update on its next request.");
    });
  }
  async function link(item: Pick<WorkspaceLibraryItem, "id" | "currentVersion">) {
    if (!saved) return;
    const body = { libraryItemId: item.id, versionId: item.currentVersion.versionId, contentSha256: item.currentVersion.contentSha256, expectedRevision: saved.revision };
    const result = await request<RoleContext>(`${BASE}/sources`, jsonWrite("POST", body, keyFor("link", body)));
    accept(result); setNotice("Added to your role context. Ready files are available to your CSM assistant.");
  }
  async function upload(files: FileList | null) {
    if (!files?.length || !saved || !canWrite) return;
    const chosen = Array.from(files).slice(0, 8);
    await act("upload", async () => {
      let current = saved;
      for (const file of chosen) {
        owner.current.signal.throwIfAborted();
        if (file.size > 4_000_000) throw new Error(`${file.name} is larger than the 4 MB web upload limit. Add it through Capture, then choose Add from Library.`);
        const form = new FormData(); form.set("file", file); form.set("title", file.name); form.set("tags", "csm-role-context");
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const uploaded = await request<{ asset: { id: string } }>("/api/capture", { method: "POST", headers: { "idempotency-key": keyFor("upload", { name: file.name, digest }) }, body: form });
        const body = { libraryItemId: `library:capture_asset:${uploaded.asset.id}`, expectedRevision: current.revision };
        try {
          current = await request<RoleContext>(`${BASE}/sources`, jsonWrite("POST", body, keyFor("upload-link", body)));
          accept(current);
        } catch (caught) { throw new Error(`${file.name} is saved in Library, but couldn't be added here. Use Add from Library to finish. ${errorText(caught)}`); }
      }
      setNotice(`${chosen.length} file${chosen.length === 1 ? "" : "s"} added. Your assistant can use them once they are ready to read.${files.length > 8 ? " Only the first 8 files were included." : ""}`);
    });
    if (uploadRef.current) uploadRef.current.value = "";
  }

  if (!active && !loaded.current) return null;
  return <section aria-label="My CSM role" className={styles.roleWorkspace}>
    <header className={styles.roleHeading}>
      <div><h2>My CSM role</h2><p>Build your personal playbook: responsibilities, ways of working, and lessons you want your assistant to remember.</p></div>
      <span className={styles.roleScope}><BookOpen size={16} />Used with every client</span>
    </header>
    {error ? <Notice error>{error} <button className={styles.textButton} type="button" disabled={Boolean(busy)} onClick={() => void act("reload", load)}>Reload saved context</button>{dirty ? <p className={styles.hint}>Reloading replaces the unsaved notes below with your last saved copy.</p> : null}</Notice> : null}
    {notice ? <Notice>{notice}</Notice> : null}
    {loading ? <p role="status" className={styles.muted}>Loading your role context…</p> : saved ? <div className={styles.roleGrid}>
      <form className={styles.roleNotes} onSubmit={(event) => void save(event)}>
        <label className={styles.field} htmlFor="csm-role-notes">Role notes</label>
        <p className={styles.hint} id="csm-role-notes-help">Describe how you work as a Lead or Secondary CSM, what you own, when to involve specialists, and how you prefer follow-ups. Keep client-specific details in that client’s workspace.</p>
        <textarea id="csm-role-notes" aria-describedby="csm-role-notes-help" className={styles.roleTextarea} value={draft} maxLength={saved.limits.textCharacters} onChange={(event) => { editCount.current += 1; setDraft(event.target.value); }} disabled={!canWrite || Boolean(busy)} placeholder={"My responsibilities\n\nHow I work with the Lead CSM\n\nWhen and how to involve Salesforce specialists\n\nWhat a good client follow-up looks like"} />
        <div className={styles.roleSave}><span className={styles.hint}>{dirty ? "Unsaved changes" : saved.revision ? "Saved role context" : "Add your first role notes"} · {draft.length.toLocaleString()} / {saved.limits.textCharacters.toLocaleString()}</span><button className={styles.primary} disabled={!canWrite || Boolean(busy) || !dirty}>{busy === "save" ? <Loader2 className={styles.busy} size={16} /> : <Check size={16} />}{busy === "save" ? "Saving notes…" : "Save role notes"}</button></div>
        <p className={styles.hint}>Your CSM assistant reads the latest saved role notes with the selected client’s brief and relevant documents on each request. Files are used when ready; it does not assume every page has been read.</p>
      </form>
      <section className={styles.roleSources} aria-label="Role documents and images">
        <div className={styles.sectionHeading}><h3>Documents & images</h3>{saved.sourceLinks.length ? <span>{saved.sourceLinks.length} added</span> : null}</div>
        <p className={styles.hint}>Add role guides, screenshots, training slides, and your own notes. These stay separate from client files.</p>
        <div className={styles.sourceActions}>
          <button className={styles.button} disabled={!canWrite || Boolean(busy)} onClick={() => uploadRef.current?.click()}><Upload size={16} />{busy === "upload" ? "Uploading…" : "Upload files"}</button>
          <button className={styles.textButton} disabled={!canWrite || Boolean(busy)} onClick={() => setPickerOpen(true)}><FolderOpen size={16} />Add from Library</button>
          <input ref={uploadRef} type="file" multiple hidden onChange={(event) => void upload(event.target.files)} />
        </div>
        {!saved.sourceLinks.length ? <div className={styles.roleSourceEmpty}><ImagePlus size={23} /><p>Have a screenshot or role guide?<br />Add it here as your playbook grows.</p></div> : <ul className={styles.sourceList}>{saved.sourceLinks.map((linkInfo) => {
          const item = saved.sources.find((source) => source.id === linkInfo.libraryItemId);
          const state = linkInfo.status === "changed" ? "Newer copy available" : linkInfo.status === "unavailable" ? "File unavailable" : linkInfo.status === "processing" ? "Preparing to read" : item ? FILE_STATUS_LABELS[item.status] : "File unavailable";
          return <li className={styles.sourceRow} key={linkInfo.libraryItemId}>
            <FileText className={styles.sourceIcon} size={18} /><div className={styles.sourceBody}><p className={styles.sourceTitle}>{item?.openHref ? <a href={item.openHref}>{item.title}</a> : item?.title || "Unavailable document"}</p><p className={styles.sourceMeta}>{state}{item ? ` · ${FILE_TYPE_LABELS[item.kind]} · ${dateLabel(item.updatedAt)}` : ""}</p>{linkInfo.status === "changed" ? <p className={styles.hint}>Add the current copy from Library so your assistant can use it.</p> : null}</div>
            {linkInfo.status === "changed" && item ? <button className={styles.iconButton} aria-label={`Use latest copy of ${item.title}`} title="Use latest copy" disabled={!canWrite || Boolean(busy)} onClick={() => void act("refresh-source", () => link(item))}><RefreshCw size={16} /></button> : null}
            <button className={styles.iconButton} aria-label={`Remove ${item?.title || "document"} from role context`} title="Remove from role context. Original stays in Library." disabled={!canWrite || Boolean(busy)} onClick={() => void act("remove", async () => { const body = { libraryItemId: linkInfo.libraryItemId, expectedRevision: saved.revision }; accept(await request<RoleContext>(`${BASE}/sources`, jsonWrite("DELETE", body, keyFor("remove", body)))); setNotice("Removed from role context. The original remains in Library."); })}><X size={16} /></button>
          </li>;
        })}</ul>}
        <p className={styles.hint}>Up to 8 files per upload, 4 MB each. Larger files and mobile captures can be added from Library.</p>
      </section>
    </div> : null}
    <LibraryPicker open={pickerOpen} onClose={() => setPickerOpen(false)} linkedIds={saved?.sourceLinks.filter((linkInfo) => linkInfo.status !== "changed").map((linkInfo) => linkInfo.libraryItemId) || []} onSelect={link} />
  </section>;
}
