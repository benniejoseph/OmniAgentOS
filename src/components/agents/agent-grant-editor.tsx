"use client";

import Link from "next/link";
import {
  Bot,
  Eye,
  KeyRound,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { agentMemoryGrantDraftV1Schema, type AgentMemoryGrantDraftV1, type AgentMemoryGrantViewV1 } from "@/lib/memory/agent-grant-editor";
import { AgentsLifecycleBoundary, useAgentRead, useAgentsLifecycle } from "./agents-workspace-lifecycle";
import { agentsActionRequest, agentsRead, grantsRead, grantReceipt, grantRevokeReceipt, object, sameAgentJson, type AgentsAction } from "@/components/agents-workspace-state";
import styles from "./agent-inspectors.module.css";
import { AgentAdaptationEditor } from "@/components/agents/agent-adaptation-editor";
import { AgentReleaseEditor } from "@/components/agents/agent-release-editor";

type GrantKind = "context" | "capability";
type GrantVisibility =
  | "agent_private"
  | "user_private"
  | "mission_shared"
  | "project_shared"
  | "workspace_shared";
type PurposeId =
  | "memory.read.v1"
  | "memory.retrieve.v1"
  | "memory.write.v1"
  | "memory.correct.v1"
  | "memory.forget.v1"
  | "memory.formation.v1"
  | "memory.maintenance.v1"
  | "memory.export.v1";

export type AgentGrantFormState = Readonly<{
  grantKind: GrantKind;
  purposeId: PurposeId;
  visibility: GrantVisibility;
  resourceIds: string;
  workspaceId: string;
  projectId: string;
  missionId: string;
  expiryHours: number;
  maxItems: number;
  maxBytes: number;
  maxInvocations: number;
  maxCostUsd: number;
  maxDurationMs: number;
}>;

const initialForm: AgentGrantFormState = {
  grantKind: "context",
  purposeId: "memory.retrieve.v1",
  visibility: "agent_private",
  resourceIds: "",
  workspaceId: "",
  projectId: "",
  missionId: "",
  expiryHours: 24,
  maxItems: 24,
  maxBytes: 48_000,
  maxInvocations: 10,
  maxCostUsd: 1,
  maxDurationMs: 60_000,
};

const purposes: Array<{ id: PurposeId; label: string }> = [
  { id: "memory.read.v1", label: "Inspect memory" },
  { id: "memory.retrieve.v1", label: "Retrieve into context" },
  { id: "memory.write.v1", label: "Create memory" },
  { id: "memory.correct.v1", label: "Correct memory" },
  { id: "memory.formation.v1", label: "Form verified memory" },
  { id: "memory.maintenance.v1", label: "Maintain memory" },
  { id: "memory.export.v1", label: "Export memory" },
  { id: "memory.forget.v1", label: "Permanently forget memory" },
];

const visibilityLabels: Record<GrantVisibility, string> = {
  agent_private: "This Agent's private memory",
  user_private: "My private memory",
  mission_shared: "One mission",
  project_shared: "One project",
  workspace_shared: "One workspace",
};

export function buildAgentGrantDraft(
  form: AgentGrantFormState,
  now = Date.now(),
) {
  const resourceIds = canonicalIds(form.resourceIds);
  const target = {
    visibility: form.visibility,
    resourceIds,
    workspaceId: form.visibility === "project_shared" ||
        form.visibility === "workspace_shared"
      ? nullable(form.workspaceId)
      : null,
    projectId: form.visibility === "project_shared"
      ? nullable(form.projectId)
      : null,
    missionId: form.visibility === "mission_shared"
      ? nullable(form.missionId)
      : null,
  };
  const common = {
    schemaVersion: 1 as const,
    grantKind: form.grantKind,
    purposeId: form.purposeId,
    target,
    expiresAt: new Date(now + form.expiryHours * 60 * 60_000).toISOString(),
  };
  return form.grantKind === "context"
    ? {
        ...common,
        grantKind: "context" as const,
        purposeId: form.purposeId === "memory.read.v1"
          ? form.purposeId
          : "memory.retrieve.v1" as const,
        maxItems: form.maxItems,
        maxBytes: form.maxBytes,
      }
    : {
        ...common,
        grantKind: "capability" as const,
        operationIds: [form.purposeId],
        maxInvocations: form.maxInvocations,
        maxCostMicrousd: Math.round(form.maxCostUsd * 1_000_000),
        maxDurationMs: form.maxDurationMs,
      };
}

export function AgentGrantEditor(props: { agentId: string; agentName: string; compact?: boolean }) {
  return <AgentsLifecycleBoundary scope={props.agentId}><GrantEditor {...props} /></AgentsLifecycleBoundary>;
}
function GrantEditor({ agentId, agentName, compact = false }: { agentId: string; agentName: string; compact?: boolean }) {
  const { gate, busy, reason, session } = useAgentsLifecycle();
  const confirmedGeneration = useRef(0);
  const fresh = useRef(false);
  const read = useAgentRead(`/api/agents/${encodeURIComponent(agentId)}/grants`, (value) => {
    const next = grantsRead(value, agentId, session?.context?.tenantId);
    if (next.some((grant) => (grant.record.granteePrincipalGeneration || 0) < confirmedGeneration.current)) throw new Error("The read predates the confirmed authority change. Recheck current grants.");
    fresh.current = true; return next;
  });
  const grants = useMemo(() => read.data ?? [], [read.data]);
  const [form, setForm] = useState<AgentGrantFormState>(initialForm);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [receipt, setReceipt] = useState<AgentMemoryGrantViewV1>();
  const [reviewedIdentity, setReviewedIdentity] = useState<string>();
  const attempt = useRef<{ identity: string; form: AgentGrantFormState; draft: AgentMemoryGrantDraftV1 } | undefined>(undefined);
  const identity = JSON.stringify(grants.map((item) => [item.record.grantId, item.record.granteeId, item.record.granteePrincipalGeneration, item.record.lifecycleRevision]));
  const identityChanged = reviewedIdentity !== undefined && reviewedIdentity !== identity;
  const disabled = Boolean(busy || reason || !read.current || identityChanged);
  const activeCounts = useMemo(() => ({
    context: grants.filter((grant) => grant.record.grantKind === "context").length,
    capability: grants.filter((grant) => grant.record.grantKind === "capability").length,
  }), [grants]);
  function updateForm(update: (current: AgentGrantFormState) => AgentGrantFormState) {
    setReviewedIdentity((current) => current ?? identity);
    setForm(update);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !fresh.current) return;
    setError(undefined);
    let token: AgentsAction | undefined;
    try {
      if (!attempt.current || attempt.current.identity !== identity || !sameAgentJson(attempt.current.form, form)) attempt.current = { identity, form, draft: agentMemoryGrantDraftV1Schema.parse(buildAgentGrantDraft(form)) };
      const draft = attempt.current.draft;
      if (Date.parse(draft.expiresAt) <= Date.now()) throw new Error("The reviewed grant expiry has passed. Change the expiry and review again.");
      token = gate.begin(`/api/agents/${encodeURIComponent(agentId)}/grants`, "POST", draft, "create", identity);
      if (!token) return;
        const payload = await agentsActionRequest(token);
        if (!gate.current(token)) return;
        const confirmed = grantReceipt(payload, agentId, draft, session?.context?.tenantId, grants[0]);
        confirmedGeneration.current = confirmed.record.granteePrincipalGeneration || 0;
        fresh.current = false; setReceipt(confirmed); setReviewedIdentity(undefined); attempt.current = undefined;
        setMessage(`Grant activation confirmed for ${agentName}. Authority generation changed; checking the complete current grant list.`);
        gate.finish(token, true);
    } catch (caught) { if (!token || gate.current(token)) setError(caught instanceof Error ? caught.message : "Grant creation was not confirmed."); }
    finally { if (token) gate.finish(token, false); }
  }
  async function revoke(grant: AgentMemoryGrantViewV1) {
    if (disabled || !fresh.current || !grant.manageable || !window.confirm(`Revoke ${grant.record.grantId} for ${agentName}? Remaining grants are reissued under a new authority generation.`)) return;
    const token = gate.begin(`/api/agents/${encodeURIComponent(agentId)}/grants/${encodeURIComponent(grant.record.grantId)}`, "DELETE", undefined, grant.record.grantId, grant.record);
    if (!token) return;
    setError(undefined);
    try {
      const payload = await agentsActionRequest(token);
      if (!gate.current(token)) return;
      grantRevokeReceipt(payload, agentId, grant);
      fresh.current = false; confirmedGeneration.current = (grant.record.granteePrincipalGeneration || 0) + 1;
      setMessage(`Revocation confirmed for ${grant.record.grantId}. Checking reissued grants before another change.`);
      setReceipt(undefined); setReviewedIdentity(undefined); attempt.current = undefined;
      gate.finish(token, true);
    } catch (caught) { if (gate.current(token)) setError(caught instanceof Error ? caught.message : "Grant revocation was not confirmed."); }
    finally { gate.finish(token, false); }
  }
  const editor = (
    <form className="grid gap-3" onSubmit={(event) => void submit(event)}><fieldset disabled={Boolean(busy)} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Grant type">
          <select
            value={form.grantKind}
            onChange={(event) => updateForm((current) => ({
              ...current,
              grantKind: event.target.value as GrantKind,
              purposeId: event.target.value === "context"
                ? "memory.retrieve.v1"
                : current.purposeId,
            }))}
          >
            <option value="context">Context · what it can see</option>
            <option value="capability">Capability · what it can do</option>
          </select>
        </Field>
        <Field label="Purpose">
          <select
            value={form.purposeId}
            onChange={(event) => updateForm((current) => ({
              ...current,
              purposeId: event.target.value as PurposeId,
            }))}
          >
            {purposes
              .filter((purpose) =>
                form.grantKind === "capability" ||
                purpose.id === "memory.read.v1" ||
                purpose.id === "memory.retrieve.v1"
              )
              .map((purpose) => (
                <option key={purpose.id} value={purpose.id}>{purpose.label}</option>
              ))}
          </select>
        </Field>
        <Field label="Scope">
          <select
            value={form.visibility}
            onChange={(event) => updateForm((current) => ({
              ...current,
              visibility: event.target.value as GrantVisibility,
            }))}
          >
            {Object.entries(visibilityLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </Field>
        <Field label="Expires">
          <select
            value={form.expiryHours}
            onChange={(event) => updateForm((current) => ({
              ...current,
              expiryHours: Number(event.target.value),
            }))}
          >
            <option value={1}>In 1 hour</option>
            <option value={24}>In 24 hours</option>
            <option value={168}>In 7 days</option>
            <option value={720}>In 30 days</option>
          </select>
        </Field>
      </div>
      <Field label="Exact targets" hint="Comma or line-separated resource IDs. Use only IDs this Agent should receive.">
        <textarea
          required
          rows={2}
          placeholder="memory:…"
          value={form.resourceIds}
          onChange={(event) => updateForm((current) => ({
            ...current,
            resourceIds: event.target.value,
          }))}
        />
      </Field>
      {form.visibility === "mission_shared" ? (
        <Field label="Mission ID"><input required value={form.missionId} onChange={(event) => updateForm((current) => ({ ...current, missionId: event.target.value }))} /></Field>
      ) : null}
      {form.visibility === "project_shared" || form.visibility === "workspace_shared" ? (
        <Field label="Workspace ID"><input required placeholder="workspace:…" value={form.workspaceId} onChange={(event) => updateForm((current) => ({ ...current, workspaceId: event.target.value }))} /></Field>
      ) : null}
      {form.visibility === "project_shared" ? (
        <Field label="Project ID"><input required value={form.projectId} onChange={(event) => updateForm((current) => ({ ...current, projectId: event.target.value }))} /></Field>
      ) : null}
      {form.grantKind === "context" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Maximum items" value={form.maxItems} min={1} max={1_000} onChange={(maxItems) => updateForm((current) => ({ ...current, maxItems }))} />
          <NumberField label="Maximum bytes" value={form.maxBytes} min={1} max={10_000_000} onChange={(maxBytes) => updateForm((current) => ({ ...current, maxBytes }))} />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField label="Invocations" value={form.maxInvocations} min={1} max={10_000} onChange={(maxInvocations) => updateForm((current) => ({ ...current, maxInvocations }))} />
          <NumberField label="Cost ceiling (USD)" value={form.maxCostUsd} min={0.01} max={100} step={0.01} onChange={(maxCostUsd) => updateForm((current) => ({ ...current, maxCostUsd }))} />
          <NumberField label="Duration (ms)" value={form.maxDurationMs} min={1} max={3_600_000} onChange={(maxDurationMs) => updateForm((current) => ({ ...current, maxDurationMs }))} />
        </div>
      )}
      <button
        type="submit"
        className="primary-button justify-center"
        disabled={disabled}
      >
        {busy === "create" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
        Activate exact grant
      </button>
    </fieldset></form>
  );

  return (
    <section className={styles.panel} aria-label={`${agentName} grants`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-primary">Authority</p>
          <h3 className="mt-1 text-base font-semibold">What {agentName} can see and do</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Default-deny. Each grant is exact, budgeted, expiring, revocable, and pinned to one Agent identity generation.
          </p>
        </div>
        <div className="flex gap-2 text-xs text-muted">
          <span className="rounded-full border border-border px-2 py-1"><Eye size={12} className="mr-1 inline" />{read.data ? activeCounts.context : "Unknown"}</span>
          <span className="rounded-full border border-border px-2 py-1"><KeyRound size={12} className="mr-1 inline" />{read.data ? activeCounts.capability : "Unknown"}</span>
        </div>
      </div>
      <div className={styles.toolbar}><span role="status">{read.label}</span><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void read.refresh()}>Refresh exact grants</button></div>
      <p>Agent ID: {agentId}</p>
      {read.error ? <p role="alert">{read.error}</p> : null}
      {reason ? <p>{reason}</p> : null}
      {identityChanged ? <div className={styles.notice}><p>The authority snapshot changed. Your draft is retained; review its exact targets and limits again.</p><button className="secondary-button" disabled={Boolean(busy) || !read.current} onClick={() => { setReviewedIdentity(identity); attempt.current = undefined; }}>Review current authority</button></div> : null}
      {receipt ? <details className={styles.evidence}><summary>Confirmed grant receipt</summary><p>{receipt.record.grantId}</p><p>Principal: {receipt.record.granteeId} · generation {receipt.record.granteePrincipalGeneration}</p><p>This receipt confirms the submitted change. The current grant list is checked separately.</p></details> : null}
      {!read.data && read.loading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 size={15} className="animate-spin" />Loading exact grants…</p>
      ) : grants.length ? (
        <div className="mt-4 grid gap-2">
          {grants.map((grant) => (
            <article key={grant.record.grantId} className="rounded-lg border border-border/70 bg-background/55 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                    {grant.record.grantKind === "context" ? <Eye size={11} /> : <KeyRound size={11} />}
                    {grant.record.grantKind}
                  </span>
                  <p className="mt-2 text-xs leading-5 text-foreground">{grant.explanation}</p>
                  <p className="mt-1 break-all text-xs text-muted">{grant.record.purposeId} · {grant.record.grantId}</p>
                  <details><summary>Exact grant identity and limits</summary><dl className={styles.identity}><dt>Principal ID</dt><dd>{grant.record.granteeId}</dd><dt>Principal generation</dt><dd>{grant.record.granteePrincipalGeneration}</dd><dt>Grant generation</dt><dd>{grant.record.grantGeneration}</dd><dt>State</dt><dd>{grant.record.state}</dd><dt>Owner</dt><dd>{grant.record.target.ownerActorId}</dd><dt>Targets</dt><dd>{grant.record.target.resourceIds.join("\n")}</dd><dt>Expiry</dt><dd>{grant.record.expiresAt}</dd><dt>Workspace / project / mission</dt><dd>{grant.record.target.workspaceId || "None"} / {grant.record.target.projectId || "None"} / {grant.record.target.missionId || "None"}</dd><dt>Limits</dt><dd>{grant.record.grantKind === "context" ? `${grant.record.maxItems} items · ${grant.record.maxBytes} bytes` : `${grant.record.maxInvocations} invocations · ${grant.record.maxCostMicrousd} microUSD · ${grant.record.maxDurationMs} ms`}</dd></dl></details>
                </div>
                <button
                  type="button"
                  className="action-button px-2 text-danger"
                  disabled={disabled || !grant.manageable}
                  onClick={() => void revoke(grant)}
                  aria-label={`Revoke ${grant.record.grantId}`}
                >
                  {busy === grant.record.grantId ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-border p-3 text-xs leading-5 text-muted">
          {read.data ? `No explicit grants were returned for ${agentName} in this snapshot.` : "Exact grants are unavailable. No empty authority count has been confirmed."}
        </p>
      )}
      {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
      {message ? <p className="mt-3 text-sm text-primary" role="status">{message}</p> : null}
      {compact ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-semibold text-primary">Add a bounded grant</summary>
          <div className="mt-3">{editor}</div>
        </details>
      ) : <div className="mt-5">{editor}</div>}
    </section>
  );
}

export function AgentGrantSettingsPanel() {
  return <AgentsLifecycleBoundary scope="settings-agent-authority"><GrantSettingsPanel /></AgentsLifecycleBoundary>;
}
function GrantSettingsPanel() {
  const { busy, session } = useAgentsLifecycle();
  const read = useAgentRead("/api/agents?ownerScope=readable", (payload) => {
    const custom = agentsRead(payload, session?.context?.tenantId);
    if (!Array.isArray(payload.builtIns) || !payload.builtIns.every((item) => object(item) && typeof item.id === "string" && typeof item.name === "string")) throw new Error("Agent options are unavailable.");
    return [ ...custom.map((agent) => ({ id: agent.id, name: agent.name, builtIn: false, manageable: agent.manageable, releaseState: agent.releaseState })), ...payload.builtIns.map((item) => ({ id: (item as {id:string}).id, name: (item as {name:string}).name, builtIn: true, manageable: false, releaseState: undefined })) ];
  });
  const agents = read.data || [];
  const [selection, setSelectedId] = useState<string>();
  const selectedId = selection ?? agents[0]?.id ?? "";
  const error = read.error;
  const selected = agents.find((agent) => agent.id === selectedId);
  return (
    <section className={`${styles.panel} space-y-5`}>
      <div className={styles.toolbar}><span role="status">{read.label}</span><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void read.refresh()}>Refresh Agent choices</button></div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="section-kicker">Agent authority</span>
          <h2 className="mt-1 text-lg font-semibold">Context and capability grants</h2>
          <p className="mt-1 text-sm text-muted">Review one Agent at a time. Behavioral persona and tool labels never create authority.</p>
        </div>
        <ShieldCheck size={22} className="text-primary" />
      </div>
      {agents.length ? (
        <Field label="Agent">
          <select disabled={Boolean(busy)} value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}{agent.builtIn ? " · built in" : " · custom"}</option>
            ))}
          </select>
        </Field>
      ) : null}
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      {selected?.releaseState === "retired" ? (
        <AgentReleaseEditor agentId={selected.id} agentName={selected.name} />
      ) : selected?.builtIn || selected?.manageable === false ? (
        <div className="grid gap-5">
          {selected?.builtIn ? (
            <AgentAdaptationEditor agentId={selected.id} agentName={selected.name} />
          ) : null}
          <div className="rounded-xl border border-border/70 bg-surface-raised/45 p-5">
            <div className="flex items-center gap-2"><Bot size={18} className="text-primary" /><strong>{selected?.name || "Built-in Agent"}</strong></div>
            <p className="mt-2 text-sm leading-6 text-muted">
              This Agent uses reviewed server policy and has no user-authored explicit grant IDs. Built-in authority cannot be widened from Settings.
            </p>
          </div>
        </div>
      ) : selected ? (
        <div className="grid gap-5">
          <AgentReleaseEditor agentId={selected.id} agentName={selected.name} />
          <AgentAdaptationEditor agentId={selected.id} agentName={selected.name} />
          <AgentGrantEditor agentId={selected.id} agentName={selected.name} />
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-5 text-sm text-muted">
          {read.data ? "Create a custom Agent in " : "Agent choices are unavailable. Retry the read or open "}<Link href="/app/agents" className="text-primary underline">Arsenal</Link> to assign explicit grants.
        </div>
      )}
    </section>
  );
}

function Field({ label, hint, children }: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium [&_input]:min-h-10 [&_input]:rounded-md [&_input]:border [&_input]:border-border [&_input]:bg-background [&_input]:px-3 [&_select]:min-h-10 [&_select]:rounded-md [&_select]:border [&_select]:border-border [&_select]:bg-background [&_select]:px-3 [&_textarea]:rounded-md [&_textarea]:border [&_textarea]:border-border [&_textarea]:bg-background [&_textarea]:px-3 [&_textarea]:py-2">
      <span>{label}</span>
      {children}
      {hint ? <small className="text-xs font-normal leading-5 text-muted">{hint}</small> : null}
    </label>
  );
}

function NumberField({ label, value, min, max, step = 1, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <input type="number" required value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </Field>
  );
}

function canonicalIds(value: string) {
  return [...new Set(value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean))]
    .sort();
}

function nullable(value: string) {
  return value.trim() || null;
}
