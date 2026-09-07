"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock3,
  DatabaseZap,
  Fingerprint,
  History,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  canPerform,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";
import {
  CUSTOMER_FACT_KINDS,
  type CustomerAccount360,
  type CustomerAccountRevision,
  type CustomerFactKind,
  type CustomerFactView,
} from "@/lib/customer-success/contracts";
import styles from "./customer-accounts-workspace.module.css";

const categoryLabels: Record<CustomerFactKind, string> = {
  organization: "Organization",
  contact: "Contacts",
  stakeholder: "Stakeholders",
  product: "Products",
  opportunity: "Opportunities",
  case: "Cases",
  usage: "Usage",
  project: "Projects",
  interaction: "Interactions",
  health: "Health",
  risk: "Risks",
  renewal: "Renewal",
};

type WorkspaceContext = {
  workspaceId: string;
  accessLevel: "reader" | "contributor" | "manager";
  canWrite: boolean;
};

export function CustomerAccountsWorkspace({
  initialAccountId,
}: {
  initialAccountId?: string;
}) {
  const router = useRouter();
  const { session, status: sessionStatus, role } = useWorkspaceSession();
  const [accounts, setAccounts] = useState<CustomerAccountRevision[]>([]);
  const [selected, setSelected] = useState<CustomerAccount360>();
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContext>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingLifecycle, setEditingLifecycle] = useState(false);
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("Customer accounts are ready.");
  const controllerRef = useRef<AbortController | null>(null);
  const mutationKeyRef = useRef("");
  const available = Boolean(session && (!session.authEnabled || session.authenticated));
  const canWrite = Boolean(
    workspaceContext?.canWrite && canPerform(role, "manage.workflow"),
  );

  const activeCount = accounts.filter((account) =>
    ["active", "onboarding"].includes(account.lifecycle)
  ).length;
  const riskCount = accounts.filter((account) => account.lifecycle === "at_risk").length;

  async function load() {
    if (!available || sessionStatus !== "ready") return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const payload = await readJson("/api/customer-accounts?limit=200", {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const nextAccounts = (payload.accounts || []) as CustomerAccountRevision[];
      setAccounts(nextAccounts);
      setWorkspaceContext(payload.context as WorkspaceContext);
      const targetId = initialAccountId || nextAccounts[0]?.accountId;
      if (targetId) await loadDetail(targetId, controller.signal);
      else setSelected(undefined);
      setError(undefined);
    } catch (loadError) {
      if (!controller.signal.aborted) setError(message(loadError));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function loadDetail(accountId: string, signal?: AbortSignal) {
    setDetailLoading(true);
    try {
      const payload = await readJson(
        `/api/customer-accounts/${encodeURIComponent(accountId)}`,
        { signal },
      );
      setSelected(payload.account as CustomerAccount360);
      setWorkspaceContext(payload.context as WorkspaceContext);
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.abort();
    };
    // The authenticated session and route own the Account 360 read boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, session, initialAccountId]);

  async function createAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      const ownerId = session?.context?.actorId || session?.user?.email || "current-actor";
      const ownerName = String(form.get("ownerName") || "").trim();
      const payload = await readJson("/api/customer-accounts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": mutationKeyRef.current || `customer-account:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          name: String(form.get("name") || ""),
          lifecycle: String(form.get("lifecycle") || "prospect"),
          accountOwner: {
            ownerKind: "actor",
            ownerId,
            displayName: ownerName,
          },
          customerDataPurposeIds: [
            "customer_success.account.manage",
            "customer_success.account.read",
          ],
        }),
      });
      const account = payload.account as CustomerAccountRevision;
      setAccounts((current) => [account, ...current]);
      setCreating(false);
      setAnnouncement(`${account.name} Account 360 created.`);
      mutationKeyRef.current = "";
      router.push(`/app/accounts/${encodeURIComponent(account.accountId)}`);
      router.refresh();
      await loadDetail(account.accountId);
    } catch (saveError) {
      setError(message(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function reviseLifecycle(lifecycle: CustomerAccountRevision["lifecycle"]) {
    if (!selected || lifecycle === selected.account.lifecycle) {
      setEditingLifecycle(false);
      return;
    }
    setSaving(true);
    try {
      const payload = await readJson(
        `/api/customer-accounts/${encodeURIComponent(selected.account.accountId)}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `customer-account-revise:${selected.account.accountId}:${selected.account.revision}:${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            expectedRevision: selected.account.revision,
            lifecycle,
          }),
        },
      );
      const account = payload.account as CustomerAccountRevision;
      setAccounts((current) => current.map((candidate) =>
        candidate.accountId === account.accountId ? account : candidate
      ));
      setAnnouncement(`${account.name} lifecycle revised to ${formatLabel(lifecycle)}.`);
      setEditingLifecycle(false);
      await loadDetail(account.accountId);
    } catch (saveError) {
      setError(message(saveError));
    } finally {
      setSaving(false);
    }
  }

  function openCreate() {
    mutationKeyRef.current = `customer-account-create:${crypto.randomUUID()}`;
    setCreating(true);
    setError(undefined);
  }

  return (
    <main className={styles.shell}>
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Customer success · provider neutral</p>
          <h1>Account 360</h1>
          <p>
            A sourced customer record where freshness, confidence, ownership,
            disagreements, and data-use permissions stay visible.
          </p>
        </div>
        <div className={styles.heroActions}>
          <button className={styles.secondaryButton} type="button" onClick={() => void load()}>
            <RefreshCw size={15} aria-hidden="true" /> Refresh
          </button>
          <button className={styles.primaryButton} type="button" onClick={openCreate} disabled={!canWrite}>
            <Plus size={15} aria-hidden="true" /> New account
          </button>
        </div>
      </header>

      <section className={styles.metrics} aria-label="Customer account overview">
        <Metric value={accounts.length} label="Accounts" detail="readable in this workspace" />
        <Metric value={activeCount} label="In motion" detail="active or onboarding" />
        <Metric value={riskCount} label="At risk" detail="explicit lifecycle state" warning={riskCount > 0} />
        <Metric value={selected?.conflictCount || 0} label="Conflicts" detail="visible on selected account" warning={Boolean(selected?.conflictCount)} />
      </section>

      {error ? (
        <div className={styles.error} role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => setError(undefined)}>Dismiss</button>
        </div>
      ) : null}

      <div className={styles.workspace} aria-busy={loading || detailLoading}>
        <aside className={styles.rail} aria-label="Customer account list">
          <div className={styles.railHeading}>
            <span>Portfolio</span>
            <strong>{accounts.length}</strong>
          </div>
          {accounts.length ? accounts.map((account) => (
            <button
              type="button"
              className={selected?.account.accountId === account.accountId
                ? styles.selectedRailItem
                : styles.railItem}
              key={account.accountId}
              onClick={() => {
                router.push(`/app/accounts/${encodeURIComponent(account.accountId)}`);
                void loadDetail(account.accountId).catch((loadError) => setError(message(loadError)));
              }}
            >
              <span className={styles.statusDot} data-status={account.lifecycle} />
              <span>
                <strong>{account.name}</strong>
                <small>{formatLabel(account.lifecycle)} · rev {account.revision}</small>
              </span>
              <Building2 size={15} aria-hidden="true" />
            </button>
          )) : (
            <div className={styles.emptyRail}>
              <Building2 size={24} aria-hidden="true" />
              <p>No customer accounts yet.</p>
            </div>
          )}
        </aside>

        <section className={styles.canvas}>
          {selected ? (
            <AccountDetail
              value={selected}
              canWrite={canWrite}
              editingLifecycle={editingLifecycle}
              saving={saving}
              onEditLifecycle={() => setEditingLifecycle(true)}
              onCancelLifecycle={() => setEditingLifecycle(false)}
              onReviseLifecycle={(value) => void reviseLifecycle(value)}
            />
          ) : (
            <div className={styles.emptyCanvas}>
              <DatabaseZap size={28} aria-hidden="true" />
              <h2>{loading ? "Resolving customer authority…" : "Create the first Account 360"}</h2>
              <p>
                Account facts remain provider-neutral. Salesforce can synchronize
                later without becoming Asael&apos;s internal source of truth.
              </p>
              {!loading ? (
                <button className={styles.primaryButton} type="button" onClick={openCreate} disabled={!canWrite}>
                  <Plus size={15} aria-hidden="true" /> New account
                </button>
              ) : null}
            </div>
          )}
        </section>
      </div>

      {creating ? (
        <div className={styles.backdrop} role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target && !saving) setCreating(false);
        }}>
          <form className={styles.editor} onSubmit={createAccount}>
            <header className={styles.editorHeader}>
              <div>
                <p className={styles.eyebrow}>Governed customer record</p>
                <h2>New Account 360</h2>
              </div>
              <button type="button" onClick={() => setCreating(false)} aria-label="Close account editor">
                <X size={18} aria-hidden="true" />
              </button>
            </header>
            <div className={styles.editorFields}>
              <label>
                <span>Account name</span>
                <input name="name" required maxLength={240} autoFocus />
              </label>
              <label>
                <span>Lifecycle</span>
                <select name="lifecycle" defaultValue="prospect">
                  {lifecycleOptions().map((value) => (
                    <option value={value} key={value}>{formatLabel(value)}</option>
                  ))}
                </select>
              </label>
              <label className={styles.fullField}>
                <span>Account owner</span>
                <input
                  name="ownerName"
                  required
                  maxLength={180}
                  defaultValue={session?.user?.name || session?.user?.email || "Account owner"}
                />
              </label>
              <div className={styles.permissionNotice}>
                <ShieldCheck size={18} aria-hidden="true" />
                <div>
                  <strong>Explicit permissions</strong>
                  <p>Workspace members may read. Only the account owner may manage. External CRM writes are disabled.</p>
                </div>
              </div>
            </div>
            <footer className={styles.editorFooter}>
              <button className={styles.secondaryButton} type="button" onClick={() => setCreating(false)} disabled={saving}>Cancel</button>
              <button className={styles.primaryButton} type="submit" disabled={saving}>
                {saving ? "Creating…" : "Create Account 360"}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
    </main>
  );
}

function AccountDetail({
  value,
  canWrite,
  editingLifecycle,
  saving,
  onEditLifecycle,
  onCancelLifecycle,
  onReviseLifecycle,
}: {
  value: CustomerAccount360;
  canWrite: boolean;
  editingLifecycle: boolean;
  saving: boolean;
  onEditLifecycle: () => void;
  onCancelLifecycle: () => void;
  onReviseLifecycle: (value: CustomerAccountRevision["lifecycle"]) => void;
}) {
  const account = value.account;
  return (
    <div className={styles.detail}>
      <div className={styles.detailTopline}>
        <Link href="/app/accounts" className={styles.backLink}>
          <ArrowLeft size={13} aria-hidden="true" /> Portfolio
        </Link>
        <div className={styles.badges}>
          <span data-tone={account.lifecycle}>{formatLabel(account.lifecycle)}</span>
          <span><Fingerprint size={11} aria-hidden="true" /> rev {account.revision}</span>
          <span><ShieldCheck size={11} aria-hidden="true" /> CRM writes disabled</span>
        </div>
      </div>

      <div className={styles.accountHeader}>
        <div>
          <p className={styles.eyebrow}>Account entity · {shortId(account.accountEntityId)}</p>
          <h2>{account.name}</h2>
          <p>
            Owned by {account.accountOwner.displayName}. Current facts are grouped
            by ontology domain without erasing source disagreements.
          </p>
        </div>
        {editingLifecycle ? (
          <div className={styles.lifecycleEditor}>
            <select
              defaultValue={account.lifecycle}
              disabled={saving}
              onChange={(event) => onReviseLifecycle(
                event.target.value as CustomerAccountRevision["lifecycle"],
              )}
              aria-label="Account lifecycle"
            >
              {lifecycleOptions().map((option) => (
                <option value={option} key={option}>{formatLabel(option)}</option>
              ))}
            </select>
            <button type="button" onClick={onCancelLifecycle}>Cancel</button>
          </div>
        ) : (
          <button className={styles.secondaryButton} type="button" onClick={onEditLifecycle} disabled={!canWrite}>
            Revise lifecycle
          </button>
        )}
      </div>

      <div className={styles.metadataGrid}>
        <Metadata icon={<UserRound size={15} />} label="Owner" value={account.accountOwner.displayName} />
        <Metadata icon={<History size={15} />} label="History" value={`${value.historyCount} immutable revisions`} />
        <Metadata icon={<Clock3 size={15} />} label="Stale facts" value={String(value.staleCount)} warning={value.staleCount > 0} />
        <Metadata icon={<AlertTriangle size={15} />} label="Conflicts" value={String(value.conflictCount)} warning={value.conflictCount > 0} />
      </div>

      <section className={styles.permissionBar} aria-label="Customer-data permissions">
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>Customer-data purposes</strong>
          <p>{account.crmPermissions.customerDataPurposeIds.map(formatLabel).join(" · ")}</p>
        </div>
        <span>{formatLabel(account.crmPermissions.readScope)} read</span>
        <span>{formatLabel(account.crmPermissions.writeScope)} write</span>
      </section>

      <div className={styles.domainGrid}>
        {CUSTOMER_FACT_KINDS.map((kind) => (
          <FactSection kind={kind} facts={value.factsByKind[kind]} key={kind} />
        ))}
      </div>
    </div>
  );
}

function FactSection({ kind, facts }: { kind: CustomerFactKind; facts: CustomerFactView[] }) {
  return (
    <section className={styles.domainSection} data-empty={facts.length === 0}>
      <header>
        <span>{categoryLabels[kind]}</span>
        <strong>{facts.length}</strong>
      </header>
      {facts.length ? facts.map((view) => (
        <article className={styles.factCard} key={view.fact.factId} data-conflict={view.conflict.state}>
          <div className={styles.factHeading}>
            <div>
              <small>{view.fact.factKey}</small>
              <h4>{factSummary(view)}</h4>
            </div>
            {view.conflict.state === "conflicting" ? (
              <span className={styles.conflictBadge}><AlertTriangle size={11} /> Conflict</span>
            ) : (
              <span className={styles.verifiedBadge}><CheckCircle2 size={11} /> Current</span>
            )}
          </div>
          <dl className={styles.factEvidence}>
            <EvidenceTerm
              icon={<DatabaseZap size={12} />}
              term="Source"
              value={`${view.fact.source.sourceLabel} · ${formatLabel(view.fact.source.sourceKind)}`}
              detail={`${shortId(view.fact.source.sourceRevisionId)} · ${view.fact.source.sourceRevisionSha256.slice(0, 10)}`}
            />
            <EvidenceTerm
              icon={<CalendarClock size={12} />}
              term="Freshness"
              value={formatLabel(view.freshness.status)}
              detail={`Observed ${formatDate(view.freshness.observedAt)}${view.freshness.staleAfter ? ` · stale ${formatDate(view.freshness.staleAfter)}` : " · no expiry supplied"}`}
              tone={view.freshness.status}
            />
            <EvidenceTerm
              icon={<ShieldCheck size={12} />}
              term="Confidence"
              value={`${(view.fact.confidenceBasisPoints / 100).toFixed(0)}%`}
              detail={view.fact.source.allowedPurposeIds.map(formatLabel).join(" · ")}
            />
            <EvidenceTerm
              icon={<UserRound size={12} />}
              term="Owner"
              value={view.fact.owner.displayName}
              detail={`${formatLabel(view.fact.owner.ownerKind)} · ${shortId(view.fact.owner.ownerId)}`}
            />
          </dl>
          {view.conflict.state === "conflicting" ? (
            <p className={styles.conflictNote}>
              Conflicts with {view.conflict.conflictingFactIds.length} current sourced fact{view.conflict.conflictingFactIds.length === 1 ? "" : "s"}. Neither value was silently selected.
            </p>
          ) : null}
        </article>
      )) : (
        <p className={styles.emptyDomain}>No current {categoryLabels[kind].toLowerCase()} facts.</p>
      )}
    </section>
  );
}

function Metric({ value, label, detail, warning = false }: {
  value: number;
  label: string;
  detail: string;
  warning?: boolean;
}) {
  return <div data-warning={warning}><strong>{value}</strong><span>{label}</span><small>{detail}</small></div>;
}

function Metadata({ icon, label, value, warning = false }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  warning?: boolean;
}) {
  return (
    <div className={styles.metadata} data-warning={warning}>
      <span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div>
    </div>
  );
}

function EvidenceTerm({ icon, term, value, detail, tone }: {
  icon: React.ReactNode;
  term: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <div data-tone={tone}>
      <dt>{icon}{term}</dt>
      <dd>{value}</dd>
      <small>{detail}</small>
    </div>
  );
}

function factSummary(view: CustomerFactView) {
  const value = view.fact.value;
  switch (value.kind) {
    case "organization": return `${value.name}${value.industry ? ` · ${value.industry}` : ""}`;
    case "contact": return `${value.name}${value.title ? ` · ${value.title}` : ""}`;
    case "stakeholder": return `${value.name} · ${value.role} · ${formatLabel(value.stance)}`;
    case "product": return `${value.name} · ${formatLabel(value.status)}`;
    case "opportunity": return `${value.name} · ${value.stage}${money(value.amountMinor, value.currency)}`;
    case "case": return `${value.title} · ${formatLabel(value.severity)} · ${value.status}`;
    case "usage": return `${value.label}: ${value.value} ${value.unit}`;
    case "project": return `${value.name} · ${value.status}`;
    case "interaction": return `${formatLabel(value.channel)} · ${value.summary}`;
    case "health": return `${formatLabel(value.dimension)} · ${formatLabel(value.status)} · ${value.summary}`;
    case "risk": return `${value.title} · ${formatLabel(value.severity)} · ${formatLabel(value.status)}`;
    case "renewal": return `${formatLabel(value.status)} · ${formatDate(value.renewalAt)}${money(value.amountMinor, value.currency)}`;
  }
}

function money(amountMinor: number | null, currency: string | null) {
  if (amountMinor === null || currency === null) return "";
  return ` · ${new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100)}`;
}

function lifecycleOptions(): CustomerAccountRevision["lifecycle"][] {
  return ["prospect", "onboarding", "active", "at_risk", "churned", "archived"];
}

function formatLabel(value: string) {
  return value.replace(/^customer_success\./, "").replaceAll(/[._]/g, " ");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function shortId(value: string) {
  return value.length > 28 ? `${value.slice(0, 14)}…${value.slice(-8)}` : value;
}

async function readJson(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown> & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Request returned ${response.status}.`);
  }
  return payload;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Customer accounts could not be updated.";
}
