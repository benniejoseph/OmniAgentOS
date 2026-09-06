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
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import type { AgentMemoryGrantViewV1 } from "@/lib/memory/agent-grant-editor";
import type {
  RequestCustomAgentDefinition,
} from "@/lib/skills/types";
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

export function AgentGrantEditor({
  agentId,
  agentName,
  compact = false,
}: {
  agentId: string;
  agentName: string;
  compact?: boolean;
}) {
  const [grants, setGrants] = useState<AgentMemoryGrantViewV1[]>([]);
  const [form, setForm] = useState<AgentGrantFormState>(initialForm);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const loadGeneration = useRef(0);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(undefined);
      void requestJson<{ grants?: AgentMemoryGrantViewV1[] }>(
        `/api/agents/${encodeURIComponent(agentId)}/grants`,
        { signal: controller.signal },
      ).then((payload) => {
        if (generation !== loadGeneration.current) return;
        setGrants(payload.grants || []);
      }).catch((caught) => {
        if (controller.signal.aborted || generation !== loadGeneration.current) return;
        setError(caught instanceof Error ? caught.message : "Grants could not be loaded.");
      }).finally(() => {
        if (generation === loadGeneration.current) setLoading(false);
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [agentId]);

  const activeCounts = useMemo(() => ({
    context: grants.filter((grant) => grant.record.grantKind === "context").length,
    capability: grants.filter((grant) =>
      grant.record.grantKind === "capability"
    ).length,
  }), [grants]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    setError(undefined);
    setMessage(undefined);
    try {
      const payload = await requestJson<{ grant: AgentMemoryGrantViewV1 }>(
        `/api/agents/${encodeURIComponent(agentId)}/grants`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildAgentGrantDraft(form)),
        },
      );
      setGrants((current) => [
        ...current.filter((grant) =>
          grant.record.grantId !== payload.grant.record.grantId
        ),
        payload.grant,
      ]);
      setMessage(`Grant activated for ${agentName}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Grant creation failed.");
    } finally {
      setBusy(undefined);
    }
  }

  async function revoke(grant: AgentMemoryGrantViewV1) {
    if (!window.confirm(`Revoke this ${grant.record.grantKind} grant?`)) return;
    setBusy(grant.record.grantId);
    setError(undefined);
    setMessage(undefined);
    try {
      await requestJson(
        `/api/agents/${encodeURIComponent(agentId)}/grants/${encodeURIComponent(grant.record.grantId)}`,
        { method: "DELETE" },
      );
      setGrants((current) => current.filter((entry) =>
        entry.record.grantId !== grant.record.grantId
      ));
      setMessage("Grant revoked. The Agent's authority generation was rotated.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Grant revocation failed.");
    } finally {
      setBusy(undefined);
    }
  }

  const editor = (
    <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Grant type">
          <select
            value={form.grantKind}
            onChange={(event) => setForm((current) => ({
              ...current,
              grantKind: event.currentTarget.value as GrantKind,
              purposeId: event.currentTarget.value === "context"
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
            onChange={(event) => setForm((current) => ({
              ...current,
              purposeId: event.currentTarget.value as PurposeId,
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
            onChange={(event) => setForm((current) => ({
              ...current,
              visibility: event.currentTarget.value as GrantVisibility,
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
            onChange={(event) => setForm((current) => ({
              ...current,
              expiryHours: Number(event.currentTarget.value),
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
          onChange={(event) => setForm((current) => ({
            ...current,
            resourceIds: event.currentTarget.value,
          }))}
        />
      </Field>
      {form.visibility === "mission_shared" ? (
        <Field label="Mission ID"><input required value={form.missionId} onChange={(event) => setForm((current) => ({ ...current, missionId: event.currentTarget.value }))} /></Field>
      ) : null}
      {form.visibility === "project_shared" || form.visibility === "workspace_shared" ? (
        <Field label="Workspace ID"><input required placeholder="workspace:…" value={form.workspaceId} onChange={(event) => setForm((current) => ({ ...current, workspaceId: event.currentTarget.value }))} /></Field>
      ) : null}
      {form.visibility === "project_shared" ? (
        <Field label="Project ID"><input required value={form.projectId} onChange={(event) => setForm((current) => ({ ...current, projectId: event.currentTarget.value }))} /></Field>
      ) : null}
      {form.grantKind === "context" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Maximum items" value={form.maxItems} min={1} max={1_000} onChange={(maxItems) => setForm((current) => ({ ...current, maxItems }))} />
          <NumberField label="Maximum bytes" value={form.maxBytes} min={1} max={10_000_000} onChange={(maxBytes) => setForm((current) => ({ ...current, maxBytes }))} />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField label="Invocations" value={form.maxInvocations} min={1} max={10_000} onChange={(maxInvocations) => setForm((current) => ({ ...current, maxInvocations }))} />
          <NumberField label="Cost ceiling (USD)" value={form.maxCostUsd} min={0.01} max={100} step={0.01} onChange={(maxCostUsd) => setForm((current) => ({ ...current, maxCostUsd }))} />
          <NumberField label="Duration (ms)" value={form.maxDurationMs} min={1} max={3_600_000} onChange={(maxDurationMs) => setForm((current) => ({ ...current, maxDurationMs }))} />
        </div>
      )}
      <button
        type="submit"
        className="primary-button justify-center"
        disabled={Boolean(busy)}
      >
        {busy === "create" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
        Activate exact grant
      </button>
    </form>
  );

  return (
    <section className="rounded-xl border border-border/70 bg-surface/70 p-4" aria-label={`${agentName} grants`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">Authority</p>
          <h3 className="mt-1 text-base font-semibold">What {agentName} can see and do</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Default-deny. Each grant is exact, budgeted, expiring, revocable, and pinned to one Agent identity generation.
          </p>
        </div>
        <div className="flex gap-2 text-xs text-muted">
          <span className="rounded-full border border-border px-2 py-1"><Eye size={12} className="mr-1 inline" />{activeCounts.context}</span>
          <span className="rounded-full border border-border px-2 py-1"><KeyRound size={12} className="mr-1 inline" />{activeCounts.capability}</span>
        </div>
      </div>
      {loading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 size={15} className="animate-spin" />Loading exact grants…</p>
      ) : grants.length ? (
        <div className="mt-4 grid gap-2">
          {grants.map((grant) => (
            <article key={grant.record.grantId} className="rounded-lg border border-border/70 bg-background/55 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[0.67rem] font-semibold text-primary">
                    {grant.record.grantKind === "context" ? <Eye size={11} /> : <KeyRound size={11} />}
                    {grant.record.grantKind}
                  </span>
                  <p className="mt-2 text-xs leading-5 text-foreground">{grant.explanation}</p>
                  <p className="mt-1 break-all text-[0.65rem] text-muted">{grant.record.purposeId} · {grant.record.grantId}</p>
                </div>
                <button
                  type="button"
                  className="action-button px-2 text-danger"
                  disabled={Boolean(busy) || !grant.manageable}
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
          No explicit grants. {agentName} receives no private or shared memory context and no memory operation capability.
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
  const [agents, setAgents] = useState<Array<{
    id: string;
    name: string;
    builtIn: boolean;
    manageable: boolean;
    releaseState?: "active" | "retired";
  }>>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void requestJson<{
      builtIns?: Array<{ id: string; name: string }>;
      agents?: RequestCustomAgentDefinition[];
    }>("/api/agents?ownerScope=readable", { signal: controller.signal })
      .then((payload) => {
        const options = [
          ...(payload.agents || []).map((agent) => ({
            id: agent.id,
            name: agent.name,
            builtIn: false,
            manageable: agent.manageable,
            releaseState: agent.releaseState,
          })),
          ...(payload.builtIns || []).map((agent) => ({
            id: agent.id,
            name: agent.name,
            builtIn: true,
            manageable: false,
          })),
        ];
        setAgents(options);
        setSelectedId((current) => current || options[0]?.id || "");
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Agents could not be loaded.");
        }
      });
    return () => controller.abort();
  }, []);

  const selected = agents.find((agent) => agent.id === selectedId);
  return (
    <section className="panel space-y-5">
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
          <select value={selectedId} onChange={(event) => setSelectedId(event.currentTarget.value)}>
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
        <div className="rounded-xl border border-border/70 bg-surface-raised/45 p-5">
          <div className="flex items-center gap-2"><Bot size={18} className="text-primary" /><strong>{selected?.name || "Built-in Agent"}</strong></div>
          <p className="mt-2 text-sm leading-6 text-muted">
            This Agent uses reviewed server policy and has no user-authored explicit grant IDs. Built-in authority cannot be widened from Settings.
          </p>
        </div>
      ) : selected ? (
        <div className="grid gap-5">
          <AgentReleaseEditor agentId={selected.id} agentName={selected.name} />
          <AgentGrantEditor agentId={selected.id} agentName={selected.name} />
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-5 text-sm text-muted">
          Create a custom Agent in <Link href="/app/agents" className="text-primary underline">Arsenal</Link> to assign explicit grants.
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
      <input type="number" required value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.currentTarget.value))} />
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

async function requestJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) throw new Error(payload.message || payload.error || "Request failed.");
  return payload;
}
