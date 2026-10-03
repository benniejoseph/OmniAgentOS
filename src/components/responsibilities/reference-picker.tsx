"use client";
import { sourceKey, type References, type ResponsibilityDraft } from "./model";
import type { Resource } from "./controller";
import styles from "./responsibilities.module.css";

export function ReferencePicker({ draft, onChange, resource, refresh }: { draft: ResponsibilityDraft; onChange: (value: ResponsibilityDraft) => void; resource: Resource<References>; refresh: () => void }) {
  const groups = resource.state === "ready" ? resource.value?.groups : undefined;
  return <section className={styles.stack} aria-labelledby="responsibility-references">
    <h3 id="responsibility-references">Authorized references</h3>
    <p>Choose from currently readable metadata. Review checks every selected reference again and pins its exact revision. The meeting pilot supports one owner-private native meeting.</p>
    <button type="button" onClick={refresh} disabled={resource.state === "loading"}>{resource.state === "loading" ? "Loading references…" : "Refresh available references"}</button>
    {resource.state === "error" && <p role="status">References unavailable. {resource.error} Your selected IDs remain in this draft.</p>}
    {groups && <>
      <div className={styles.options}><h4>Sources</h4><GroupStatus group={groups.sources} label="sources" />
        {groups.sources.state === "available" && groups.sources.items.map(({ source, label }) => {
          const selected = draft.sources.some((item) => sourceKey(item) === sourceKey(source));
          return <label key={sourceKey(source)} className={styles.check}><input type="checkbox" checked={selected} disabled={!selected && draft.sources.length >= 20}
            onChange={() => onChange({ ...draft, sources: selected ? draft.sources.filter((item) => sourceKey(item) !== sourceKey(source)) : [...draft.sources, source] })} />
            <span>{label || source.id}<small>{source.kind} · {source.id}{"workspaceId" in source ? ` · ${source.workspaceId}` : ""}</small></span></label>;
        })}
      </div>
      <label>Canonical work<GroupStatus group={groups.work} label="Work items" /><select value={draft.work ? workValue(draft.work) : ""} disabled={groups.work.state !== "available"} onChange={(event) => {
        const selected = groups.work.items.find((item) => workValue(item) === event.target.value); onChange({ ...draft, work: selected ? { workspaceId: selected.workspaceId, projectId: selected.projectId, workItemId: selected.workItemId } : null });
      }}><option value="">Choose a Work item</option>
        {draft.work && !groups.work.items.some((item) => workValue(item) === workValue(draft.work!)) && <option value={workValue(draft.work)}>Saved reference · {draft.work.workItemId} (not in this page)</option>}
        {groups.work.items.map((item) => <option key={workValue(item)} value={workValue(item)}>{item.label || item.workItemId} · {item.workItemId}</option>)}
      </select></label>
      {(["procedures", "agents"] as const).map((key) => {
        const field = key === "procedures" ? "procedureId" : "agentId"; const group = groups[key];
        return <label key={key}>{key === "procedures" ? "Owner-private procedure" : "Agent"}<GroupStatus group={group} label={key} />
          <select value={draft[field] ?? ""} disabled={group.state !== "available"} onChange={(event) => onChange({ ...draft, [field]: event.target.value || null })}>
            <option value="">Choose {key === "procedures" ? "a procedure" : "an Agent"}</option>
            {draft[field] && !group.items.some((item) => item.id === draft[field]) && <option value={draft[field]!}>Saved reference · {draft[field]} (not in this page)</option>}
            {group.items.map((item) => <option key={item.id} value={item.id}>{item.label || item.id} · {item.id}</option>)}
          </select></label>;
      })}
    </>}
    <div className={styles.options}><h4>Selected source identities ({draft.sources.length}/20)</h4>
      {draft.sources.length === 0 ? <p>No sources selected.</p> : <ul>{draft.sources.map((item) => <li key={sourceKey(item)}><span className={styles.identity}>{item.kind} · {item.id}{"workspaceId" in item ? ` · ${item.workspaceId}` : ""}</span>
        <button type="button" onClick={() => onChange({ ...draft, sources: draft.sources.filter((source) => sourceKey(source) !== sourceKey(item)) })}>Remove source {item.id}</button></li>)}</ul>}
    </div>
    <details><summary>Selected Work, procedure and Agent IDs</summary><pre>{JSON.stringify({ work: draft.work, procedureId: draft.procedureId, agentId: draft.agentId }, null, 2)}</pre></details>
  </section>;
}
function workValue(item: NonNullable<ResponsibilityDraft["work"]>) { return JSON.stringify({ workspaceId: item.workspaceId, projectId: item.projectId, workItemId: item.workItemId }); }
function GroupStatus({ group, label }: { group: { state: string; items: unknown[]; hasMore: boolean | null }; label: string }) {
  return <small>{group.state === "unavailable" ? `${label} are unavailable; availability could not be checked.` : group.items.length === 0 ? `No readable ${label} in this bounded selection.` : `${group.items.length} readable ${label} shown.${group.hasMore ? " More exist outside this page." : ""}`}</small>;
}
