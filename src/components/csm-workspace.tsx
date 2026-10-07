"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Bot, BriefcaseBusiness, CalendarDays, Check, CheckCircle2, Circle, FileText, FolderOpen, Info, Link2, Loader2, Plus, RefreshCw, Search, Upload, UserRound, UsersRound, X } from "lucide-react";
import { clsx } from "clsx";
import { canPerform, useWorkspaceSession } from "@/components/app-shell/session-context";
import { workspaceOwnerScope } from "@/components/app-shell/workspace-owner-scope";
import type { WorkspaceLibraryItem } from "@/lib/library/contracts";
import type { ClientProfile } from "@/lib/csm/contracts";
import { CSM_AGENT_NAME, CSM_AGENT_TEMPLATE } from "@/lib/csm/template";
import styles from "./csm-workspace.module.css";

type ClientTask = { id: string; title: string; detail?: string; status: "open" | "doing" | "done"; dueAt?: string; workflowRunId?: string; priority: "low" | "medium" | "high" };
type ClientProject = { id: string; title: string; objective: string; status: string; updatedAt: string; tasks?: ClientTask[] };
type ClientSummary = { project: ClientProject; profile: ClientProfile; sourceCount: number; revision: string };
type ClientDetail = {
  project: ClientProject;
  profile: ClientProfile | null;
  sources: WorkspaceLibraryItem[];
  sourceLinks: { libraryItemId: string; versionId: string; contentSha256: string; status: "current" | "processing" | "changed" | "unavailable" }[];
  revision: string | null;
  context: { canWrite: boolean };
};
const EMPTY_PROFILE: ClientProfile = { role: "secondary", successPlan: "unknown", leadCsm: "", customerGoals: "", successPath: "", stakeholders: "" };
const PLAN_LABELS = { unknown: "Plan not confirmed", standard: "Standard", premier: "Premier", signature: "Signature" };
const FILE_TYPE_LABELS: Record<WorkspaceLibraryItem["kind"], string> = {
  document: "Document", spreadsheet: "Spreadsheet", presentation: "Slide deck", file: "File", image: "Image",
  audio: "Audio", video: "Video", recording: "Recording", transcript: "Transcript", email: "Email",
  meeting: "Meeting", message: "Message", webpage: "Web page", record: "Saved item", generated_artifact: "Created file",
};
const FILE_STATUS_LABELS: Record<WorkspaceLibraryItem["status"], string> = {
  ready: "Ready to use", processing: "Preparing to read", failed: "Could not prepare this file", unsupported: "File type not supported",
};
const STARTER_TASKS = [
  "Confirm my responsibilities and the Lead CSM handoff",
  "Capture the client's top business outcomes",
  "Map customer and Salesforce stakeholders",
  "Add the latest meeting notes and Success Path",
  "Agree the next client touchpoint and review date",
];
const ASSISTANT_ACTIONS = [
  { label: "Client brief", prompt: "Prepare a client brief from this client's saved context and linked evidence. Cover customer goals, recent developments, stakeholder responsibilities, open questions and the three most useful next actions. Cite sources and separate known facts from suggestions. Identify missing or stale context." },
  { label: "Prepare a meeting", prompt: "Prepare for the next meeting with this client. Review the selected client's saved evidence and commitments. Draft an agenda, questions, decisions needed and a preparation checklist. Ask for the meeting purpose and participants if they are not recorded. Cite the evidence behind your recommendations." },
  { label: "Follow up on a meeting", prompt: "Review this client's latest linked meeting evidence. Draft a recap with separate decisions, customer commitments, Salesforce commitments, proposed next steps and unresolved questions. Cite transcript timestamps or source passages. Never invent owners or dates; identify what needs confirmation. Prepare drafts only." },
  { label: "Suggested next steps", prompt: "Review this client's goals, Success Path, evidence and recorded commitments. Recommend a short prioritized checklist with a reason, supporting source, suggested owner and timing for each action. Separate explicit commitments from your suggestions. For a Secondary CSM, identify decisions or handoffs for the Lead CSM. Do not invent customer agreement or current org status." },
  { label: "Draft Success Path", prompt: "Draft an evidence-based Success Path for this client. Map business outcomes to recommendations, measures, milestones, owners, dependencies and the next review. Mark unknown baselines, targets and entitlements explicitly. Distinguish proposals from customer-agreed plans. Cite the selected client's sources." },
  { label: "Specialist handoff", prompt: "Prepare a Salesforce specialist handoff for this client's most important unresolved need. Include business impact, evidence timeline, what has been tried, the exact decision or help needed, suggested role and missing information. Explain why that role fits. Draft only; do not claim a request was sent or a service entitlement confirmed." },
] as const;

async function readJson<T>(href: string, init?: RequestInit): Promise<T> {
  const response = await fetch(href, { cache: "no-store", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(requestErrorMessage(body.error, response.status));
  return body as T;
}
function jsonWrite(method: string, body: unknown, key: string): RequestInit {
  return { method, headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) };
}
function dateLabel(value?: string) {
  if (!value) return "Not scheduled";
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(parsed.getTime()) ? "Date unavailable" : parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function requestErrorMessage(message: unknown, status: number) {
  const friendly: Record<string, string> = {
    "Invalid client context request.": "Some client details could not be saved. Check the fields and try again.",
    "Client context access is unavailable.": "We couldn't open this client's details. Refresh the page and check that you still have access.",
    "Client context is temporarily unavailable. Your accepted edits can be retried with the same edit key.": "We couldn't confirm whether your changes were saved. Try this action again to check or finish saving it.",
    "Client context changed. Reload it before saving your edit.": "This client brief was updated while you were editing. Load the saved brief before making further changes.",
    "Client context has conflicting active revisions.": "There are conflicting saved copies of this client brief. We can't safely choose one. Contact support for help.",
    "The saved client context could not be verified.": "We couldn't verify the saved client brief. Refresh the page; if it still won't open, contact support.",
    "Client context write access is required.": "You can view this client, but you don't have permission to change their brief or files.",
    "An exact client edit intent is required.": "We couldn't safely save this change. Refresh the saved brief before trying again.",
    "This edit key was already used for another change.": "The details of this change no longer match the earlier attempt. Refresh the saved brief before trying again.",
    "Client context belongs to another project.": "These details don't belong to the selected client. Reopen the client before saving.",
    "Client context was not found.": "This client's brief could not be found. Reopen the client to check whether it is still available.",
    "The selected source is no longer available.": "This file is no longer available. Choose another file from Library.",
    "The source changed. Select its current Library version again.": "This file was updated. Refresh Library and choose it again.",
    "A client can have up to 50 linked sources.": "You can add up to 50 files or notes to a client. Remove one from this client before adding another.",
    "Archived client work is read-only.": "This client is archived. Reopen their project in Other projects before making changes.",
    "Project not found.": "This client is no longer available, or you don't have access to it.",
    "Invalid project task": "Check the action's title, note and due date before trying again.",
    "Invalid task update": "This action could not be updated. Refresh the saved actions before trying again.",
    "Invalid project": "Check the client name and goals before trying again.",
  };
  if (typeof message === "string" && friendly[message]) return friendly[message];
  if (typeof message === "string" && message.startsWith("Idempotency-Key")) return "We couldn't safely repeat this action because its details changed. Refresh the saved work before trying again.";
  if (status === 401) return "Please sign in again to continue with this client.";
  if (status === 403) return "You don't have permission to make this request. Check your access before trying again.";
  return typeof message === "string" ? message : "We couldn't complete this request. Refresh the saved work before trying again.";
}
function errorText(error: unknown) {
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return "The connection was interrupted. Refresh the saved work before retrying; your changes may have been saved.";
  return error instanceof Error ? error.message : "This action could not be completed.";
}

export function CsmWorkspace({ deployment = "local", initialProjectId }: { deployment?: string; initialProjectId?: string }) {
  const { session, role, status } = useWorkspaceSession();
  if (status !== "ready" || !session || (session.authEnabled && !session.authenticated)) return <main className={styles.shell}><p role="status">Loading your client workspace…</p></main>;
  return <CsmWorkspaceBody key={workspaceOwnerScope(session, role, deployment)} initialProjectId={initialProjectId} />;
}

function CsmWorkspaceBody({ initialProjectId }: { initialProjectId?: string }) {
  const { role } = useWorkspaceSession();
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [selectedId, setSelectedId] = useState(initialProjectId || "");
  const [showDetail, setShowDetail] = useState(Boolean(initialProjectId));
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const mounted = useRef(true);
  const canWrite = canPerform(role, "run.agent");
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await readJson<{ clients: ClientSummary[]; truncated: boolean }>("/api/csm/clients", { signal });
      if (signal?.aborted || !mounted.current) return;
      const visibleClients = data.clients.filter((client) => client.project.status !== "archived");
      setClients(visibleClients); setTruncated(data.truncated); setError("");
      setSelectedId((current) => current || visibleClients[0]?.project.id || "");
    } catch (caught) { if (!signal?.aborted && mounted.current) setError(errorText(caught)); }
    finally { if (!signal?.aborted && mounted.current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; const controller = new AbortController(); void load(controller.signal); return () => { mounted.current = false; controller.abort(); }; }, [load]);
  const filtered = clients.filter((client) => client.project.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <main className={styles.shell}>
    <header className={styles.header}>
      <div><h1>Work</h1><p>Your clients, their priorities, and what needs to happen next.</p></div>
      <div className={styles.actions}><Link href="/app/projects?view=projects" className={styles.textButton}>Other projects <ArrowUpRight size={15} /></Link><button className={styles.primary} onClick={() => setCreateOpen(true)} disabled={!canWrite}><Plus size={17} />Add client</button></div>
    </header>
    {error ? <Notice error>{error} <button className={styles.textButton} onClick={() => void load()}>Reload</button></Notice> : null}
    {loading ? <p className={styles.muted} role="status">Loading clients…</p> : !clients.length && !selectedId && !error ?
      <div className={styles.empty}><BriefcaseBusiness size={34} /><h2>Start with one client</h2><p>Add your role and their priorities. Add meeting recordings, transcripts, decks, and documents to prepare for your next conversation.</p><button className={styles.primary} disabled={!canWrite} onClick={() => setCreateOpen(true)}><Plus size={17} />Add your first client</button></div> :
      <div className={styles.layout}>
        <aside className={clsx(styles.rail, showDetail && styles.railHidden)} aria-label="Clients">
          <div className={styles.railHeader}><span>Clients</span><span className={styles.muted}>{clients.length}{truncated ? "+" : ""}</span></div>
          <label className={styles.search}><Search size={16} aria-hidden="true" /><input aria-label="Find a client" placeholder="Find a client" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <ul className={styles.clientList}>{filtered.map(({ project, profile }) => <li key={project.id}><button className={styles.clientButton} aria-current={project.id === selectedId ? "true" : undefined} onClick={() => { setSelectedId(project.id); setShowDetail(true); }}><strong>{project.title}</strong><span>{profile.role === "lead" ? "Lead CSM" : "Secondary CSM"} · {PLAN_LABELS[profile.successPlan]}</span></button></li>)}</ul>
          {!filtered.length ? <p className={styles.hint}>No clients match this name.</p> : null}
          {truncated ? <p className={styles.hint}>Older clients may be under Other projects.</p> : null}
        </aside>
        <div className={clsx(styles.clientCanvas, !showDetail && styles.canvasHidden)}>
          <button className={clsx(styles.textButton, styles.mobileBack)} onClick={() => setShowDetail(false)}><ArrowLeft size={16} />All clients</button>
          {selectedId ? <ClientWorkspace key={selectedId} projectId={selectedId} onChange={() => void load()} /> : <p className={styles.muted}>Choose a client to open their workspace.</p>}
        </div>
      </div>}
    <ClientForm open={createOpen} onClose={() => setCreateOpen(false)} onSaved={(id) => { setCreateOpen(false); setSelectedId(id); setShowDetail(true); void load(); }} />
  </main>;
}

function ClientWorkspace({ projectId, onChange }: { projectId: string; onChange: () => void }) {
  const router = useRouter();
  const { role } = useWorkspaceSession();
  const [detail, setDetail] = useState<ClientDetail>();
  const [tasks, setTasks] = useState<ClientTask[]>([]);
  const [tab, setTab] = useState("overview");
  const [editOpen, setEditOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDate, setTaskDate] = useState("");
  const [taskDetail, setTaskDetail] = useState("");
  const alive = useRef(true);
  const ownerController = useRef(new AbortController());
  function assertOwner() {
    if (!alive.current || ownerController.current.signal.aborted) throw new DOMException("Client workspace changed.", "AbortError");
  }
  function clientRead<T>(href: string, init: RequestInit = {}): Promise<T> {
    assertOwner();
    const signal = init.signal ? AbortSignal.any([ownerController.current.signal, init.signal]) : ownerController.current.signal;
    return readJson<T>(href, { ...init, signal });
  }
  const uploadRef = useRef<HTMLInputElement>(null);
  const mutationKeys = useRef(new Map<string, string>());
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const load = useCallback(async (signal?: AbortSignal) => {
    const data = await clientRead<ClientDetail>(`${base}/csm`, { signal });
    if (signal?.aborted || !alive.current) return;
    setDetail(data); setTasks(data.project.tasks || []);
  }, [base]);
  useEffect(() => { alive.current = true; if (ownerController.current.signal.aborted) ownerController.current = new AbortController(); const controller = new AbortController(); void load(controller.signal).catch((caught) => { if (!controller.signal.aborted) setError(errorText(caught)); }); return () => { alive.current = false; ownerController.current.abort(); controller.abort(); }; }, [load]);
  useEffect(() => {
    if (!detail?.sourceLinks.some((link) => link.status === "processing")) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(controller.signal).catch(() => {}); }, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [detail?.sourceLinks, load]);
  const canWrite = Boolean(detail?.context.canWrite && detail.project.status !== "archived" && canPerform(role, "run.agent"));
  function keyFor(action: string, payload: unknown) { const binding = JSON.stringify([action, payload]); let key = mutationKeys.current.get(binding); if (!key) { key = crypto.randomUUID(); mutationKeys.current.set(binding, key); } return key; }
  async function act(name: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(name); setError(""); setNotice("");
    try { await action(); } catch (caught) { if (alive.current) setError(errorText(caught)); }
    finally { if (alive.current) setBusy(""); }
  }
  async function linkSource(item: Pick<WorkspaceLibraryItem, "id" | "currentVersion">) {
    if (!detail) return;
    const body = { libraryItemId: item.id, versionId: item.currentVersion.versionId, contentSha256: item.currentVersion.contentSha256, expectedRevision: detail.revision };
    const updated = await clientRead<ClientDetail>(`${base}/csm/sources`, jsonWrite("POST", body, keyFor("link", body)));
    if (!alive.current) return;
    setDetail(updated); onChange(); setNotice("File added to this client.");
  }
  async function uploadFiles(files: FileList | null) {
    if (!files?.length || !detail) return;
    const chosen = Array.from(files).slice(0, 8);
    await act("upload", async () => {
      let current = detail;
      let linked = 0;
      for (const file of chosen) {
        assertOwner();
        if (file.size > 4_000_000) throw new Error(`${file.name} is larger than this web upload's 4 MB limit. Open Capture for other upload and recording options.`);
        const form = new FormData(); form.set("file", file); form.set("title", file.name); form.set("tags", "csm-client-evidence");
        const uploaded = await clientRead<{ asset: { id: string } }>("/api/capture", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: form });
        const libraryItemId = `library:capture_asset:${uploaded.asset.id}`;
        try {
          const body = { libraryItemId, expectedRevision: current.revision };
          current = await clientRead<ClientDetail>(`${base}/csm/sources`, jsonWrite("POST", body, keyFor("upload-link", body)));
          linked += 1;
          if (alive.current) setDetail(current);
        } catch (caught) { throw new Error(`${file.name} was uploaded to Library, but could not be added to this client. Choose Add from Library to finish. ${errorText(caught)}`); }
      }
      if (alive.current) { setNotice(`${linked} file${linked === 1 ? "" : "s"} uploaded and added. Your assistant can use them once they are ready to read.${files.length > 8 ? " Only the first 8 files were included." : ""}`); onChange(); }
    });
    if (uploadRef.current) uploadRef.current.value = "";
  }
  async function addTask(title: string, dueAt?: string, explanation?: string) {
    const payload = { title, detail: explanation || "", priority: "medium", agentId: "atlas", ...(dueAt ? { dueAt: new Date(`${dueAt}T12:00:00`).toISOString() } : {}) };
    await clientRead(`${base}/tasks`, jsonWrite("POST", payload, keyFor("task", payload)));
    await load(); onChange();
  }
  async function openAssistant(prompt: string) {
    if (!detail) return;
    await act("assistant", async () => {
      const catalog = await clientRead<{ agents: { id: string; name: string; role: string; status: string; selectable?: boolean }[] }>("/api/agents?ownerScope=exact");
      assertOwner();
      let agent = catalog.agents.find((candidate) => candidate.name === CSM_AGENT_NAME);
      if (agent && (agent.status === "paused" || agent.selectable === false)) throw new Error("Your CSM assistant is paused or unavailable. Review it in Agents before starting a new conversation.");
      if (!agent) {
        const created = await clientRead<{ agent: typeof agent }>("/api/agents", jsonWrite("POST", CSM_AGENT_TEMPLATE, keyFor("agent", CSM_AGENT_TEMPLATE)));
        agent = created.agent;
      }
      assertOwner();
      if (!agent?.id) throw new Error("The CSM assistant could not be prepared.");
      const params = new URLSearchParams({ agent: agent.id, project: projectId, context: "project", prompt: `Client: ${detail.project.title}. ${prompt}` });
      router.push(`/app/command?${params.toString()}`);
    });
  }
  if (!detail) return <div>{error ? <Notice error>{error} <button className={styles.textButton} onClick={() => void act("reload", () => load())}>Reload client</button></Notice> : <p role="status" className={styles.muted}>Opening client details…</p>}</div>;
  const profile = detail.profile || EMPTY_PROFILE;
  const currentSources = detail.sourceLinks.filter((link) => link.status === "current").length;
  const openTasks = tasks.filter((task) => task.status !== "done");
  const missingStarterTasks = STARTER_TASKS.filter((title) => !tasks.some((task) => task.title.toLocaleLowerCase() === title.toLocaleLowerCase()));
  return <>
    <header className={styles.clientHeading}><div><h2>{detail.project.title}</h2><div className={styles.meta}><span><UserRound size={14} />{profile.role === "lead" ? "Lead CSM" : "Secondary CSM"}</span><span>{PLAN_LABELS[profile.successPlan]}</span><span><CalendarDays size={14} />Review: {dateLabel(profile.nextReviewDate)}</span></div></div><button className={styles.button} disabled={!canWrite || Boolean(busy)} onClick={() => setEditOpen(true)}>Edit client brief</button></header>
    {error ? <Notice error>{error} <button className={styles.textButton} onClick={() => void act("reload", async () => { await load(); setNotice("Latest client details loaded."); })}>Reload</button></Notice> : null}
    {notice ? <Notice>{notice}</Notice> : null}
    {!detail.profile ? <Notice>Add a client brief to start preparing meetings and tracking next steps. <button className={styles.textButton} onClick={() => setEditOpen(true)} disabled={!canWrite}>Set up client</button></Notice> : null}
    <div className={styles.tabs} role="tablist" aria-label="Client workspace">{[["overview", "Overview"], ["evidence", "Documents & notes"], ["path", "Success Path"], ["team", "People & roles"]].map(([id, label]) => <button key={id} id={`csm-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="csm-tab-panel" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(event) => { const ids = ["overview", "evidence", "path", "team"]; if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); const next = ids[(ids.indexOf(id) + (event.key === "ArrowRight" ? 1 : 3)) % 4]; setTab(next); document.getElementById(`csm-tab-${next}`)?.focus(); } }}>{label}</button>)}</div>
    <div className={styles.contentGrid}>
      <div id="csm-tab-panel" role="tabpanel" aria-labelledby={`csm-tab-${tab}`}>
        {tab === "overview" ? <>
          <section className={styles.section}><div className={styles.sectionHeading}><h3>Customer outcomes</h3><span>Confirmed by you</span></div><p className={styles.prose}>{profile.customerGoals || detail.project.objective}</p></section>
          <section className={styles.section}><div className={styles.sectionHeading}><h3>Your CSM assistant</h3><Bot size={18} /></div><p className={styles.muted}>Prepare meetings, review the client's documents, and decide what to do next. Your assistant starts with this client's brief and selected documents.</p><div className={styles.assistantActions}>{ASSISTANT_ACTIONS.map((action) => <button key={action.label} className={styles.button} disabled={Boolean(busy) || !canPerform(role, "manage.workflow") || !detail.profile} onClick={() => void openAssistant(action.prompt)}>{busy === "assistant" ? <Loader2 size={15} className={styles.busy} /> : <ArrowUpRight size={15} />}{action.label}</button>)}</div><p className={styles.hint}>Recommendations and communication drafts stay yours to review. Opening a prompt does not send it.</p></section>
          <section className={styles.section}><div className={styles.sectionHeading}><h3>What your assistant can use</h3><button className={styles.textButton} onClick={() => setTab("evidence")}>Manage documents <ArrowUpRight size={14} /></button></div><p>{currentSources} file{currentSources === 1 ? "" : "s"} ready · {detail.sourceLinks.length - currentSources} still preparing or needing attention</p><p className={styles.hint}>Your assistant starts with the client brief and selected passages from up to four documents or notes. It tells you what it could not read or include. Screenshots and decks reflect the information recorded at the time.</p>{profile.leadCsm ? <p className={styles.hint}>Counterpart / Lead CSM: {profile.leadCsm}</p> : null}</section>
        </> : null}
        {tab === "evidence" ? <section className={styles.section}>
          <div className={styles.sectionHeading}><h3>Client documents & notes</h3><button className={styles.iconButton} aria-label="Refresh file status" title="Refresh file status" disabled={Boolean(busy)} onClick={() => void act("reload", () => load())}><RefreshCw size={16} /></button></div>
          <p className={styles.muted}>Add transcripts, decks, documents, screenshots, or recordings from Library. Files captured on mobile appear there too.</p>
          <div className={styles.sourceActions}><button className={styles.button} disabled={!canWrite || Boolean(busy) || !detail.profile} onClick={() => uploadRef.current?.click()}><Upload size={16} />{busy === "upload" ? "Uploading…" : "Upload files"}</button><button className={styles.button} disabled={!canWrite || Boolean(busy) || !detail.profile} onClick={() => setPickerOpen(true)}><Link2 size={16} />Add from Library</button><Link className={styles.textButton} href="/app/capture">Open Capture <ArrowUpRight size={14} /></Link><input hidden ref={uploadRef} type="file" multiple accept=".pdf,.docx,.pptx,.txt,.md,.csv,.xlsx,.png,.jpg,.jpeg,.webp,.mp3,.m4a,.wav,.mp4,.webm" onChange={(event) => void uploadFiles(event.target.files)} /></div>
          <p className={styles.hint}>Add up to 8 files, 4 MB each. Files still being prepared or that cannot be opened won't be used. If a file is updated, choose its latest copy before your assistant uses it.</p>
          {!detail.sourceLinks.length ? <div className={styles.empty}><FolderOpen size={28} /><h3>No documents or notes yet</h3><p>Start with the latest client transcript, Success Path, or review deck.</p></div> : <ul className={styles.sourceList}>{detail.sourceLinks.map((link) => {
            const item = detail.sources.find((source) => source.id === link.libraryItemId);
            return <li key={link.libraryItemId} className={styles.sourceRow}><FileText className={styles.sourceIcon} size={20} /><div className={styles.sourceBody}><div className={styles.sourceTitle}>{item?.openHref ? <Link href={item.openHref}>{item.title}</Link> : item?.title || "File no longer available"}</div><p className={styles.sourceMeta}>{item ? FILE_TYPE_LABELS[item.kind] : "File or note"} · {link.status === "current" ? "Ready to use" : link.status === "processing" ? "Preparing to read" : link.status === "changed" ? "Newer copy available" : "Cannot open this file"}{item ? ` · ${dateLabel(item.updatedAt)}` : ""}</p></div><div>{link.status === "changed" && item ? <button className={styles.textButton} disabled={!canWrite || Boolean(busy)} onClick={() => void act("source", () => linkSource(item))}>Use updated file</button> : null}<button className={styles.iconButton} aria-label={`Remove ${item?.title || "file"} from this client`} title="Remove from this client; keep the original in Library" disabled={!canWrite || Boolean(busy)} onClick={() => void act("source", async () => { const body = { libraryItemId: link.libraryItemId, expectedRevision: detail.revision }; const updated = await clientRead<ClientDetail>(`${base}/csm/sources`, jsonWrite("DELETE", body, keyFor("unlink", body))); if (alive.current) { setDetail(updated); onChange(); setNotice("Removed from this client. The original is still in Library."); } })}><X size={15} /></button></div></li>;
          })}</ul>}
        </section> : null}
        {tab === "path" ? <>
          <section className={styles.section}><div className={styles.sectionHeading}><h3>Success Path</h3><button className={styles.textButton} disabled={!canWrite} onClick={() => setEditOpen(true)}>Edit</button></div><p className={styles.prose}>{profile.successPath || "Record the customer's agreed outcomes, recommendations, owners, measures and milestones. Keep unknowns visible until you confirm them."}</p><p className={styles.hint}>Next review: {dateLabel(profile.nextReviewDate)}</p><button className={styles.button} disabled={Boolean(busy) || !canPerform(role, "manage.workflow") || !detail.profile} onClick={() => void openAssistant(ASSISTANT_ACTIONS[4].prompt)}><Bot size={16} />Prepare a draft</button></section>
          <section className={styles.section}><h3>A useful working structure</h3><ul className={styles.guideList}><li><strong>Outcome and evidence</strong><p>What does the customer want to achieve, and which source confirms it?</p></li><li><strong>Measure and milestone</strong><p>Record the baseline, target and review date when agreed. Mark missing values as unknown.</p></li><li><strong>Owner and next step</strong><p>Separate your commitments, the customer's commitments and specialist handoffs.</p></li></ul><p className={styles.reference}>Based on Salesforce's <a href="https://help.salesforce.com/s/articleView?id=000395788&language=en_US&type=1" target="_blank" rel="noreferrer">Signature guidance</a> and <a href="https://help.salesforce.com/s/success-reviews?language=en_US" target="_blank" rel="noreferrer">Success Reviews</a>. Confirm the client's actual service coverage.</p></section>
        </> : null}
        {tab === "team" ? <>
          <section className={styles.section}><div className={styles.sectionHeading}><h3>People and responsibilities</h3><button className={styles.textButton} disabled={!canWrite} onClick={() => setEditOpen(true)}>Edit</button></div><p className={styles.prose}>{profile.stakeholders || "Add names, roles, responsibilities and the best way to engage each person. Start with the client sponsor, technical owner, Lead CSM and Account Executive."}</p><p className={styles.hint}>Your assignment: {profile.role === "lead" ? "Lead CSM" : "Secondary CSM"}{profile.leadCsm ? ` · Counterpart: ${profile.leadCsm}` : ""}. Record the responsibility split you have agreed.</p></section>
          <section className={styles.section}><div className={styles.sectionHeading}><h3>Who to bring in</h3><UsersRound size={17} /></div><ul className={styles.guideList}>{[["CSM / Lead CSM", "Customer advocacy, outcomes, relationship context and coordination."], ["Account Executive", "Commercial and account strategy questions. Confirm the actual owner for renewals and licensing."], ["Success Guide", "Product guidance, coaching, onboarding and review support where available."], ["Success Architect", "Architecture, scalability, technical health and focused technical decisions."], ["Support / Critical Incident team", "Technical issues and incidents. Supply impact, case references, evidence and the current update."], ["Professional Services / partner", "Implementation and delivery within their agreed engagement scope."], ["TAM, if assigned", "Record the actual technical advisory role and coverage supplied by your team."], ["Customer sponsor and technical owner", "Business priorities, decisions, adoption and technical coordination."]].map(([name, purpose]) => <li key={name}><strong>{name}</strong><p>{purpose}</p></li>)}</ul><p className={styles.reference}>Role guidance from <a href="https://www.salesforce.com/services/success-plans/signature/" target="_blank" rel="noreferrer">Salesforce Signature Success</a>. Titles describe responsibilities, not guaranteed staffing or entitlements.</p></section>
        </> : null}
      </div>
      <aside aria-label="Client next actions">
        <section className={styles.section}><div className={styles.sectionHeading}><h3>Next actions</h3><span>{openTasks.length} open</span></div>
          {!tasks.length ? <p className={styles.muted}>Turn agreed commitments into a checklist. Agent suggestions need your confirmation.</p> : null}{missingStarterTasks.length ? <button className={styles.textButton} disabled={!canWrite || Boolean(busy)} onClick={() => void act("checklist", async () => { for (const title of missingStarterTasks) await addTask(title); if (alive.current) setNotice("Starter checklist added. Adjust the actions to your responsibilities."); })}><Plus size={15} />{tasks.length ? "Add remaining starter actions" : "Add onboarding checklist"}</button> : null}
          <ul className={styles.taskList}>{[...openTasks, ...tasks.filter((task) => task.status === "done")].map((task) => <li className={styles.taskRow} key={task.id}><button className={styles.taskToggle} role="checkbox" aria-checked={task.status === "done"} aria-label={`${task.status === "done" ? "Reopen" : "Complete"}: ${task.title}`} title={task.workflowRunId ? "This action is handled by an agent. Open Other projects to review its progress." : undefined} disabled={!canWrite || Boolean(busy) || Boolean(task.workflowRunId)} onClick={() => void act("task", async () => { const payload = { status: task.status === "done" ? "open" : "done" }; await clientRead(`${base}/tasks/${encodeURIComponent(task.id)}`, jsonWrite("PATCH", payload, keyFor(`task-${task.id}-${task.status}`, payload))); mutationKeys.current.delete(JSON.stringify([`task-${task.id}-${task.status}`, payload])); await load(); onChange(); })}>{task.status === "done" ? <CheckCircle2 size={19} /> : <Circle size={19} />}</button><div className={styles.taskContent}><p className={task.status === "done" ? styles.taskDone : undefined}>{task.title}</p>{task.detail ? <p className={styles.taskMeta}>{task.detail}</p> : null}<p className={styles.taskMeta}>{task.dueAt ? `Due ${dateLabel(task.dueAt)}` : "No agreed due date"}{task.workflowRunId ? " · Handled by an agent" : ""}</p></div></li>)}</ul>
          <form className={styles.taskForm} onSubmit={(event) => { event.preventDefault(); const submitted = taskTitle.trim(); if (!submitted) return; void act("add-task", async () => { await addTask(submitted, taskDate, taskDetail.trim()); if (alive.current) { setTaskTitle((current) => current.trim() === submitted ? "" : current); setTaskDate(""); setTaskDetail(""); setNotice("Action added."); } }); }}><input className={styles.input} aria-label="New action" placeholder="Add a next action" maxLength={240} required value={taskTitle} disabled={!canWrite} onChange={(event) => setTaskTitle(event.target.value)} /><input className={styles.input} aria-label="Action owner or note" placeholder="Owner or note (optional)" maxLength={1000} value={taskDetail} disabled={!canWrite} onChange={(event) => setTaskDetail(event.target.value)} /><div className={styles.fieldPair}><input type="date" className={styles.input} aria-label="Agreed action due date" value={taskDate} disabled={!canWrite} onChange={(event) => setTaskDate(event.target.value)} /><button className={styles.button} disabled={!canWrite || Boolean(busy) || !taskTitle.trim()}><Plus size={15} />Add action</button></div></form>
        </section>
        <section className={styles.section}><h3>Meeting follow-up</h3><p className={styles.hint}>Use Meetings to review what was said and confirm agreed actions. Add the recording or transcript here to use it when preparing for this client.</p><Link className={styles.textButton} href="/app/meetings">Open Meetings <ArrowUpRight size={14} /></Link></section>
      </aside>
    </div>
    <ClientForm open={editOpen} detail={detail} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); void act("reload", async () => { await load(); onChange(); setNotice("Client brief saved."); }); }} />
    <LibraryPicker open={pickerOpen} onClose={() => setPickerOpen(false)} linkedIds={detail.sourceLinks.map((source) => source.libraryItemId)} onSelect={async (item) => { await linkSource(item); }} />
  </>;
}

function ClientForm({ open, detail, onClose, onSaved }: { open: boolean; detail?: ClientDetail; onClose: () => void; onSaved: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [profile, setProfile] = useState<ClientProfile>(EMPTY_PROFILE);
  const [openingRevision, setOpeningRevision] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ownerController = useRef(new AbortController());
  useEffect(() => { if (ownerController.current.signal.aborted) ownerController.current = new AbortController(); return () => ownerController.current.abort(); }, []);
  async function formRead<T>(href: string, init: RequestInit): Promise<T> {
    ownerController.current.signal.throwIfAborted();
    return readJson<T>(href, { ...init, signal: ownerController.current.signal });
  }
  const pendingProject = useRef<string | undefined>(undefined);
  const writeKeys = useRef(new Map<string, string>());
  const previousOpen = useRef(false);
  useEffect(() => {
    if (open && !previousOpen.current && !pendingProject.current) { setTitle(detail?.project.title || ""); setProfile(detail?.profile || EMPTY_PROFILE); setOpeningRevision(detail?.revision || null); setError(""); pendingProject.current = undefined; writeKeys.current.clear(); }
    previousOpen.current = open;
  }, [open, detail]);
  function keyFor(payload: unknown) { const binding = JSON.stringify(payload); let key = writeKeys.current.get(binding); if (!key) { key = crypto.randomUUID(); writeKeys.current.set(binding, key); } return key; }
  function field<K extends keyof ClientProfile>(key: K, value: ClientProfile[K]) { setProfile((current) => ({ ...current, [key]: value })); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !title.trim()) return;
    setBusy(true); setError("");
    try {
      let projectId = detail?.project.id || pendingProject.current;
      if (!projectId) {
        const body = { title: title.trim(), objective: profile.customerGoals.trim().slice(0, 2000) || `Customer success context and follow-through for ${title.trim()}.`, status: "active" };
        const created = await formRead<{ project: ClientProject }>("/api/projects", jsonWrite("POST", body, keyFor(["create", body])));
        projectId = created.project.id; pendingProject.current = projectId;
      }
      const savedProfile = { ...profile }; if (!savedProfile.nextReviewDate) delete savedProfile.nextReviewDate;
      const body = { profile: savedProfile, expectedRevision: openingRevision };
      await formRead(`/api/projects/${encodeURIComponent(projectId)}/csm`, jsonWrite("PUT", body, keyFor([projectId, body])));
      ownerController.current.signal.throwIfAborted();
      pendingProject.current = undefined;
      onSaved(projectId);
    } catch (caught) { if (!ownerController.current.signal.aborted) setError(`${pendingProject.current && !detail ? "The client was created, but the brief still needs saving. Try again to finish setting up this same client. " : ""}${errorText(caught)}`); }
    finally { if (!ownerController.current.signal.aborted) setBusy(false); }
  }
  return <Modal open={open} title={detail ? "Edit client brief" : "Add a client"} onClose={onClose} preventClose={busy}>
    <form onSubmit={(event) => void submit(event)} className={styles.fields}>
      {error ? <Notice error>{error}{detail ? <button type="button" className={styles.textButton} disabled={busy} onClick={() => { setBusy(true); void formRead<ClientDetail>(`/api/projects/${encodeURIComponent(detail.project.id)}/csm`, { method: "GET" }).then((latest) => { ownerController.current.signal.throwIfAborted(); setProfile(latest.profile || EMPTY_PROFILE); setOpeningRevision(latest.revision); setError(""); }).catch((caught) => { if (!ownerController.current.signal.aborted) setError(errorText(caught)); }).finally(() => { if (!ownerController.current.signal.aborted) setBusy(false); }); }}>Reload saved brief</button> : null}</Notice> : null}
      <label className={styles.field}>Client name<input className={styles.input} value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={180} disabled={Boolean(detail || pendingProject.current) || busy} placeholder="Client or company name" /></label>
      <div className={styles.fieldPair}><label className={styles.field}>My role<select className={styles.select} value={profile.role} onChange={(event) => field("role", event.target.value as ClientProfile["role"])} disabled={busy}><option value="secondary">Secondary CSM</option><option value="lead">Lead CSM</option></select></label><label className={styles.field}>Success Plan<select className={styles.select} value={profile.successPlan} onChange={(event) => field("successPlan", event.target.value as ClientProfile["successPlan"])} disabled={busy}>{Object.entries(PLAN_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <label className={styles.field}>Lead CSM / counterpart<input className={styles.input} value={profile.leadCsm} onChange={(event) => field("leadCsm", event.target.value)} maxLength={240} disabled={busy} placeholder="Name and agreed responsibility, if known" /></label>
      <label className={styles.field}>Customer goals and background<textarea className={styles.textarea} value={profile.customerGoals} onChange={(event) => field("customerGoals", event.target.value)} maxLength={4000} disabled={busy} placeholder="Business priorities, products in use, your responsibilities, and what matters most to this client." /></label>
      <label className={styles.field}>Success Path<textarea className={styles.textarea} value={profile.successPath} onChange={(event) => field("successPath", event.target.value)} maxLength={4000} disabled={busy} placeholder="Outcome → recommendation → owner → measure → milestone. Separate agreed commitments from proposals." /></label>
      <label className={styles.field}>People and responsibilities<textarea className={styles.textarea} value={profile.stakeholders} onChange={(event) => field("stakeholders", event.target.value)} maxLength={4000} disabled={busy} placeholder="Customer sponsor, technical owner, Account Executive, CSMs, specialists, and their agreed responsibilities." /></label>
      <label className={styles.field}>Next Success Review<input className={styles.input} type="date" value={profile.nextReviewDate || ""} onChange={(event) => field("nextReviewDate", event.target.value || undefined)} disabled={busy} /></label>
      <div className={styles.dialogFooter}><button type="button" className={styles.button} disabled={busy} onClick={onClose}>Cancel</button><button className={styles.primary} disabled={busy || !title.trim()}>{busy ? <Loader2 size={16} className={styles.busy} /> : <Check size={16} />}{detail ? "Save brief" : pendingProject.current ? "Finish client setup" : "Create client"}</button></div>
    </form>
  </Modal>;
}

function LibraryPicker({ open, onClose, linkedIds, onSelect }: { open: boolean; onClose: () => void; linkedIds: string[]; onSelect: (item: WorkspaceLibraryItem) => Promise<void> }) {
  const [items, setItems] = useState<WorkspaceLibraryItem[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => { setLoading(true); void readJson<{ items: WorkspaceLibraryItem[] }>(`/api/library?limit=40&q=${encodeURIComponent(query)}`, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) { setItems(data.items); setError(""); } }).catch((caught) => { if (!controller.signal.aborted) setError(errorText(caught)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, query]);
  return <Modal open={open} title="Add documents & notes" onClose={onClose} preventClose={Boolean(busy)}>
    <p className={styles.hint}>Choose documents, notes or recordings for this client. The originals stay in Library, and their sharing settings stay the same.</p>
    <label className={styles.search}><Search size={16} /><input aria-label="Search documents and notes" placeholder="Find a transcript, deck, or recording" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    {error ? <Notice error>{error}</Notice> : null}
    {loading ? <p role="status" className={styles.muted}>Finding documents and notes…</p> : null}
    <ul className={styles.sourceList}>{items.map((item) => <li className={styles.sourceRow} key={item.id}><FileText className={styles.sourceIcon} size={19} /><div className={styles.sourceBody}><p className={styles.sourceTitle}>{item.title}</p><p className={styles.sourceMeta}>{FILE_TYPE_LABELS[item.kind]} · {FILE_STATUS_LABELS[item.status]} · {dateLabel(item.updatedAt)}</p></div><button className={styles.button} disabled={Boolean(busy) || linkedIds.includes(item.id) || item.status === "failed" || item.status === "unsupported"} onClick={() => { setBusy(item.id); setError(""); void onSelect(item).catch((caught) => setError(errorText(caught))).finally(() => setBusy("")); }}>{linkedIds.includes(item.id) ? <><Check size={15} />Added</> : busy === item.id ? "Adding…" : "Add"}</button></li>)}</ul>
    {!loading && !items.length ? <p className={styles.hint}>No matching documents or notes. Upload a file from the client page or add it through Capture first.</p> : null}
    <div className={styles.dialogFooter}><button className={styles.button} onClick={onClose} disabled={Boolean(busy)}>Done</button></div>
  </Modal>;
}

function Modal({ open, title, children, onClose, preventClose = false }: { open: boolean; title: string; children: ReactNode; onClose: () => void; preventClose?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => { const dialog = ref.current; if (!dialog) return; if (open && !dialog.open) dialog.showModal(); else if (!open && dialog.open) dialog.close(); }, [open]);
  return <dialog ref={ref} className={styles.dialog} aria-labelledby={headingId} onCancel={(event) => { event.preventDefault(); if (!preventClose) onClose(); }} onClose={() => { if (!preventClose && open) onClose(); }}><header className={styles.dialogHeader}><h2 id={headingId}>{title}</h2><button type="button" className={styles.iconButton} aria-label="Close dialog" disabled={preventClose} onClick={onClose}><X size={18} /></button></header>{children}</dialog>;
}
function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={clsx(styles.notice, error && styles.error)} role={error ? "alert" : "status"}><Info size={17} /><div>{children}</div></div>;
}
