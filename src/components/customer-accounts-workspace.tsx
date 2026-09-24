"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarClock,
  CheckCircle2,
  CloudCog,
  Clock3,
  DatabaseZap,
  Fingerprint,
  Gauge,
  History,
  Lightbulb,
  ListChecks,
  Plus,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  UserRound,
  Unplug,
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
import type {
  CustomerHealthPolicy,
  CustomerHealthScore,
} from "@/lib/customer-success/health-contracts";
import type {
  CustomerSuccessAccountIntelligence,
  CustomerSuccessPortfolio,
  CustomerSuccessPortfolioItem,
} from "@/lib/customer-success/intelligence-contracts";
import type { SalesforceSyncHealth } from "@/lib/customer-success/salesforce-contracts";
import type {
  CustomerSuccessWorkflowDefinition,
  CustomerSuccessWorkflowId,
  CustomerSuccessWorkflowInput,
  CustomerSuccessWorkflowRunRevision,
} from "@/lib/customer-success/workflow-contracts";
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

type SalesforcePayload = {
  health: SalesforceSyncHealth;
  findings: Array<{
    findingId: string;
    objectType: string;
    findingKind: string;
    observedAt: string;
  }>;
  authorizeUrl: string;
  webhook: { configured: boolean };
  writes: {
    configured: boolean;
    enabled: boolean;
    mode: "approval_required";
    createObjects: string[];
    updateObjects: string[];
    operations: Array<{
      operationId: string;
      state: "prepared" | "verified" | "failed";
      verificationReasonCode: string | null;
      completedAt: string | null;
    }>;
  };
};

type CustomerHealthPayload = {
  policy: CustomerHealthPolicy;
  score: CustomerHealthScore | null;
  history: CustomerHealthScore[];
};

type CustomerSuccessWorkflowPayload = {
  pack: CustomerSuccessWorkflowDefinition[];
  runs: CustomerSuccessWorkflowRunRevision[];
};

type CustomerSuccessPortfolioPayload = {
  portfolio: CustomerSuccessPortfolio;
};

type CustomerSuccessIntelligencePayload = {
  intelligence: CustomerSuccessAccountIntelligence;
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
  const [customerHealth, setCustomerHealth] = useState<CustomerHealthPayload>();
  const [customerWorkflows, setCustomerWorkflows] = useState<CustomerSuccessWorkflowPayload>();
  const [customerPortfolio, setCustomerPortfolio] = useState<CustomerSuccessPortfolio>();
  const [customerIntelligence, setCustomerIntelligence] = useState<CustomerSuccessAccountIntelligence>();
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContext>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [healthEvaluating, setHealthEvaluating] = useState(false);
  const [workflowLaunching, setWorkflowLaunching] = useState(false);
  const [workflowEditor, setWorkflowEditor] = useState<CustomerSuccessWorkflowDefinition>();
  const [editingLifecycle, setEditingLifecycle] = useState(false);
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("Customer accounts are ready.");
  const [salesforce, setSalesforce] = useState<SalesforcePayload>();
  const [salesforceLoading, setSalesforceLoading] = useState(false);
  const [salesforceAction, setSalesforceAction] = useState<"sync" | "reconcile" | "disconnect">();
  const [salesforceMessage, setSalesforceMessage] = useState<string>();
  const controllerRef = useRef<AbortController | null>(null);
  const mutationKeyRef = useRef("");
  const available = Boolean(session && (!session.authEnabled || session.authenticated));
  const canWrite = Boolean(
    workspaceContext?.canWrite && canPerform(role, "manage.workflow"),
  );
  const canManageSalesforce = Boolean(
    workspaceContext?.canWrite && canPerform(role, "manage.connector"),
  );
  const canRunWorkflow = Boolean(
    workspaceContext?.canWrite && canPerform(role, "run.agent"),
  );

  const activeCount = accounts.filter((account) =>
    ["active", "onboarding"].includes(account.lifecycle)
  ).length;
  const riskCount = accounts.filter((account) => account.lifecycle === "at_risk").length;
  const portfolioByAccountId = new Map(
    (customerPortfolio?.accounts || []).map((item) => [item.accountId, item]),
  );

  async function load() {
    if (!available || sessionStatus !== "ready") return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const accountsRequest = readJson("/api/customer-accounts?limit=200", {
        signal: controller.signal,
      });
      const supportingReads = Promise.allSettled([
        readJson("/api/customer-accounts/portfolio?limit=200", {
          signal: controller.signal,
        }).then((portfolioPayload) => {
          if (!controller.signal.aborted) {
            setCustomerPortfolio(
              (portfolioPayload as CustomerSuccessPortfolioPayload).portfolio,
            );
          }
        }),
        loadSalesforce(controller.signal),
      ]);
      const payload = await accountsRequest;
      if (controller.signal.aborted) return;
      const nextAccounts = (payload.accounts || []) as CustomerAccountRevision[];
      setAccounts(nextAccounts);
      setWorkspaceContext(payload.context as WorkspaceContext);
      const targetId = initialAccountId || nextAccounts[0]?.accountId;
      const detailRead = targetId
        ? loadDetail(targetId, controller.signal)
        : Promise.resolve().then(() => {
            setSelected(undefined);
            setCustomerHealth(undefined);
            setCustomerWorkflows(undefined);
            setCustomerIntelligence(undefined);
          });
      const [supportingResults, detailResult] = await Promise.all([
        supportingReads,
        Promise.allSettled([detailRead]).then(([result]) => result),
      ]);
      if (controller.signal.aborted) return;
      const readFailures = [supportingResults[0], detailResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => message(result.reason));
      if (readFailures.length) throw new Error(readFailures.join(" "));
      setError(undefined);
    } catch (loadError) {
      if (!controller.signal.aborted) setError(message(loadError));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function loadSalesforce(signal?: AbortSignal) {
    setSalesforceLoading(true);
    try {
      const payload = await readJson("/api/customer-accounts/salesforce", { signal });
      setSalesforce(payload as SalesforcePayload);
    } catch (loadError) {
      if (!signal?.aborted) setSalesforceMessage(message(loadError));
    } finally {
      if (!signal?.aborted) setSalesforceLoading(false);
    }
  }

  async function runSalesforceAction(action: "sync" | "reconcile" | "disconnect") {
    if (!canManageSalesforce || !workspaceContext) return;
    setSalesforceAction(action);
    setSalesforceMessage(undefined);
    try {
      const endpoint = action === "disconnect"
        ? `/api/oauth/salesforce?workspaceId=${encodeURIComponent(workspaceContext.workspaceId)}`
        : `/api/customer-accounts/salesforce/${action}?workspaceId=${encodeURIComponent(workspaceContext.workspaceId)}`;
      const payload = await readJson(endpoint, {
        method: action === "disconnect" ? "DELETE" : "POST",
        headers: { accept: "application/json" },
      });
      setSalesforceMessage(action === "sync"
        ? `Salesforce sync ${payload.status || "complete"} · ${payload.records || 0} records observed.`
        : action === "reconcile"
          ? `Read-only reconciliation checked ${payload.checked || 0} records and found ${payload.findings || 0} differences.`
          : "Salesforce disconnected. Imported evidence remains in history.");
      if (action === "sync") await load();
      else await loadSalesforce();
    } catch (actionError) {
      setSalesforceMessage(message(actionError));
    } finally {
      setSalesforceAction(undefined);
    }
  }

  async function loadDetail(accountId: string, signal?: AbortSignal) {
    setDetailLoading(true);
    try {
      const encodedAccountId = encodeURIComponent(accountId);
      const [accountPayload, healthPayload, workflowPayload, intelligencePayload] = await Promise.all([
        readJson(`/api/customer-accounts/${encodedAccountId}`, { signal }),
        readJson(`/api/customer-accounts/${encodedAccountId}/health?historyLimit=20`, { signal }),
        readJson(`/api/customer-accounts/${encodedAccountId}/workflows?limit=50`, { signal }),
        readJson(`/api/customer-accounts/${encodedAccountId}/intelligence?historyLimit=100&timelineLimit=100`, { signal }),
      ]);
      setSelected(accountPayload.account as CustomerAccount360);
      setCustomerHealth(healthPayload as CustomerHealthPayload);
      setCustomerWorkflows(workflowPayload as CustomerSuccessWorkflowPayload);
      setCustomerIntelligence((intelligencePayload as CustomerSuccessIntelligencePayload).intelligence);
      setWorkspaceContext(accountPayload.context as WorkspaceContext);
    } finally {
      setDetailLoading(false);
    }
  }

  async function evaluateHealth() {
    if (!selected || !canWrite) return;
    setHealthEvaluating(true);
    try {
      const payload = await readJson(
        `/api/customer-accounts/${encodeURIComponent(selected.account.accountId)}/health`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `customer-health:${selected.account.accountId}:${selected.account.revision}:${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            expectedAccountRevision: selected.account.revision,
            expectedAccountSha256: selected.account.accountSha256,
          }),
        },
      );
      const score = payload.score as CustomerHealthScore;
      setCustomerHealth((current) => current ? {
        ...current,
        score,
        history: [score, ...current.history.filter((item) =>
          item.scoreRevisionId !== score.scoreRevisionId
        )].slice(0, 20),
      } : current);
      setAnnouncement(
        `${selected.account.name} health evaluated as ${formatLabel(score.status)} with ${percent(score.confidenceBasisPoints)} confidence.`,
      );
      await loadCustomerIntelligence(selected.account.accountId);
      setError(undefined);
    } catch (evaluationError) {
      setError(message(evaluationError));
    } finally {
      setHealthEvaluating(false);
    }
  }

  async function startCustomerSuccessWorkflow(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !workflowEditor || !canRunWorkflow) return;
    setWorkflowLaunching(true);
    try {
      const input = workflowInputFromForm(workflowEditor.workflowId, new FormData(event.currentTarget));
      const payload = await readJson(
        `/api/customer-accounts/${encodeURIComponent(selected.account.accountId)}/workflows`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `customer-success:${selected.account.accountId}:${workflowEditor.workflowId}:${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            expectedAccountRevision: selected.account.revision,
            expectedAccountSha256: selected.account.accountSha256,
            input,
          }),
        },
      );
      const run = payload.run as CustomerSuccessWorkflowRunRevision;
      setCustomerWorkflows((current) => current ? {
        ...current,
        runs: [run, ...current.runs.filter((item) => item.runId !== run.runId)],
      } : current);
      setWorkflowEditor(undefined);
      setAnnouncement(`${workflowEditor.name} started for ${selected.account.name}.`);
      await loadCustomerIntelligence(selected.account.accountId);
      setError(undefined);
    } catch (workflowError) {
      setError(message(workflowError));
    } finally {
      setWorkflowLaunching(false);
    }
  }

  async function loadCustomerIntelligence(accountId: string, signal?: AbortSignal) {
    const payload = await readJson(
      `/api/customer-accounts/${encodeURIComponent(accountId)}/intelligence?historyLimit=100&timelineLimit=100`,
      { signal },
    );
    if (!signal?.aborted) {
      setCustomerIntelligence((payload as CustomerSuccessIntelligencePayload).intelligence);
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
        <Metric value={customerPortfolio?.counts.urgent ?? riskCount} label="Needs attention" detail="approvals, critical risk, or overdue" warning={Boolean(customerPortfolio?.counts.urgent ?? riskCount)} />
        <Metric value={customerPortfolio?.counts.pendingApprovals || 0} label="Approvals" detail="customer actions waiting" warning={Boolean(customerPortfolio?.counts.pendingApprovals)} />
      </section>

      <SalesforcePanel
        payload={salesforce}
        loading={salesforceLoading}
        action={salesforceAction}
        canManage={canManageSalesforce}
        message={salesforceMessage}
        onAction={runSalesforceAction}
      />

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
          {accounts.length ? accounts.map((account) => {
            const intelligence = portfolioByAccountId.get(account.accountId);
            return (
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
                <small>{portfolioRailLabel(account, intelligence)}</small>
              </span>
              <Building2 size={15} aria-hidden="true" />
            </button>
            );
          }) : (
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
              health={customerHealth}
              workflows={customerWorkflows}
              intelligence={customerIntelligence}
              canWrite={canWrite}
              canRunWorkflow={canRunWorkflow}
              healthEvaluating={healthEvaluating}
              editingLifecycle={editingLifecycle}
              saving={saving}
              onEditLifecycle={() => setEditingLifecycle(true)}
              onCancelLifecycle={() => setEditingLifecycle(false)}
              onReviseLifecycle={(value) => void reviseLifecycle(value)}
              onEvaluateHealth={() => void evaluateHealth()}
              onStartWorkflow={setWorkflowEditor}
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

      {workflowEditor && selected ? (
        <WorkflowEditor
          definition={workflowEditor}
          accountName={selected.account.name}
          saving={workflowLaunching}
          onCancel={() => setWorkflowEditor(undefined)}
          onSubmit={startCustomerSuccessWorkflow}
        />
      ) : null}
    </main>
  );
}

function SalesforcePanel({
  payload,
  loading,
  action,
  canManage,
  message: statusMessage,
  onAction,
}: {
  payload?: SalesforcePayload;
  loading: boolean;
  action?: "sync" | "reconcile" | "disconnect";
  canManage: boolean;
  message?: string;
  onAction: (action: "sync" | "reconcile" | "disconnect") => Promise<void>;
}) {
  const health = payload?.health;
  const connected = health?.connected === true;
  const cursorProgress = health?.cursor
    ? Object.values(health.cursor.objects).filter((item) => item.phase === "current").length
    : 0;
  return (
    <section className={styles.salesforcePanel} aria-label="Salesforce synchronization and guarded writes" aria-busy={loading || Boolean(action)}>
      <div className={styles.salesforceIdentity}>
        <span><CloudCog size={18} aria-hidden="true" /></span>
        <div>
          <p className={styles.eyebrow}>CRM adapter · governed</p>
          <h2>Salesforce sync</h2>
          <p>
            External records become sourced Account 360 facts. Salesforce never
            becomes Asael&apos;s internal source of truth.
          </p>
        </div>
      </div>
      <div className={styles.salesforceHealth}>
        <div><small>Status</small><strong>{formatLabel(health?.status || (loading ? "loading" : "unavailable"))}</strong></div>
        <div><small>Cursor</small><strong>{health?.cursor ? `${cursorProgress}/8 current` : "Not started"}</strong></div>
        <div><small>Lag</small><strong>{formatLag(health?.lagSeconds)}</strong></div>
        <div><small>Scope</small><strong>{health?.objectScope.length || 8} objects · read only</strong></div>
        <div><small>Webhook</small><strong>{payload?.webhook.configured ? "Verified HMAC" : "Not configured"}</strong></div>
        <div><small>Reconciliation</small><strong>{payload?.findings.length || 0} findings</strong></div>
        <div><small>Write gate</small><strong>{payload?.writes.configured ? "Approval-bound" : "Disabled"}</strong></div>
        <div><small>Write receipts</small><strong>{payload?.writes.operations.length || 0} retained</strong></div>
      </div>
      <div className={styles.salesforceActions}>
        {!health?.configured ? (
          <span>Salesforce OAuth credentials are required in the deployment environment.</span>
        ) : !connected ? (
          <a
            className={styles.primaryButton}
            href={canManage ? payload?.authorizeUrl : undefined}
            aria-disabled={!canManage}
          >
            <CloudCog size={15} aria-hidden="true" /> Connect Salesforce
          </a>
        ) : (
          <>
            <button className={styles.primaryButton} type="button" disabled={!canManage || Boolean(action)} onClick={() => void onAction("sync")}>
              <RefreshCw size={15} aria-hidden="true" /> {action === "sync" ? "Syncing…" : "Sync now"}
            </button>
            <button className={styles.secondaryButton} type="button" disabled={!canManage || Boolean(action)} onClick={() => void onAction("reconcile")}>
              <RotateCcw size={15} aria-hidden="true" /> {action === "reconcile" ? "Checking…" : "Reconcile"}
            </button>
            <button className={styles.secondaryButton} type="button" disabled={!canManage || Boolean(action)} onClick={() => void onAction("disconnect")}>
              <Unplug size={15} aria-hidden="true" /> {action === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </>
        )}
      </div>
      {health?.actionableError ? (
        <p className={styles.salesforceNotice} data-tone="error">
          {health.actionableError.message} · {formatLabel(health.actionableError.action)}
        </p>
      ) : statusMessage ? (
        <p className={styles.salesforceNotice} role="status">{statusMessage}</p>
      ) : null}
    </section>
  );
}

function AccountDetail({
  value,
  health,
  workflows,
  intelligence,
  canWrite,
  canRunWorkflow,
  healthEvaluating,
  editingLifecycle,
  saving,
  onEditLifecycle,
  onCancelLifecycle,
  onReviseLifecycle,
  onEvaluateHealth,
  onStartWorkflow,
}: {
  value: CustomerAccount360;
  health?: CustomerHealthPayload;
  workflows?: CustomerSuccessWorkflowPayload;
  intelligence?: CustomerSuccessAccountIntelligence;
  canWrite: boolean;
  canRunWorkflow: boolean;
  healthEvaluating: boolean;
  editingLifecycle: boolean;
  saving: boolean;
  onEditLifecycle: () => void;
  onCancelLifecycle: () => void;
  onReviseLifecycle: (value: CustomerAccountRevision["lifecycle"]) => void;
  onEvaluateHealth: () => void;
  onStartWorkflow: (definition: CustomerSuccessWorkflowDefinition) => void;
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
          <span><ShieldCheck size={11} aria-hidden="true" /> {formatLabel(account.crmPermissions.externalWriteState)} CRM writes</span>
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
        <span>{formatLabel(account.crmPermissions.externalWriteState)} CRM writes</span>
      </section>

      <CustomerIntelligencePanel
        value={intelligence}
        workflows={workflows}
        canWrite={canWrite}
        canRunWorkflow={canRunWorkflow}
        onEvaluateHealth={onEvaluateHealth}
        onStartWorkflow={onStartWorkflow}
      />

      <CustomerHealthPanel
        value={health}
        currentAccountRevisionId={account.revisionId}
        canEvaluate={canWrite}
        evaluating={healthEvaluating}
        onEvaluate={onEvaluateHealth}
      />

      <CustomerSuccessWorkflowPanel
        value={workflows}
        currentAccountRevisionId={account.revisionId}
        canStart={canRunWorkflow}
        onStart={onStartWorkflow}
      />

      <div className={styles.domainGrid}>
        {CUSTOMER_FACT_KINDS.map((kind) => (
          <FactSection kind={kind} facts={value.factsByKind[kind]} key={kind} />
        ))}
      </div>
    </div>
  );
}

function CustomerIntelligencePanel({
  value,
  workflows,
  canWrite,
  canRunWorkflow,
  onEvaluateHealth,
  onStartWorkflow,
}: {
  value?: CustomerSuccessAccountIntelligence;
  workflows?: CustomerSuccessWorkflowPayload;
  canWrite: boolean;
  canRunWorkflow: boolean;
  onEvaluateHealth: () => void;
  onStartWorkflow: (definition: CustomerSuccessWorkflowDefinition) => void;
}) {
  if (!value) {
    return (
      <section className={styles.intelligencePanel} aria-label="Customer-success decision view" aria-busy="true">
        <div className={styles.intelligenceLoading}>Assembling current risks, commitments, approvals, and timeline…</div>
      </section>
    );
  }
  const recommendation = value.nextBestAction;
  const recommendedWorkflow = recommendation.workflowId
    ? workflows?.pack.find((item) => item.workflowId === recommendation.workflowId)
    : recommendation.action === "resolve_risk"
      ? workflows?.pack.find((item) => item.workflowId === "risk_escalation")
      : undefined;
  const openCommitments = value.commitments.filter((item) =>
    !["completed", "dismissed"].includes(item.status)
  );
  return (
    <section className={styles.intelligencePanel} aria-label="Customer-success decision view">
      <header className={styles.intelligenceHeader}>
        <div className={styles.healthIdentity}>
          <span><Lightbulb size={19} aria-hidden="true" /></span>
          <div>
            <p className={styles.eyebrow}>Customer portfolio intelligence · suggested only</p>
            <h3>What needs attention now</h3>
            <p>Deterministic ranking over exact account, health, workflow, meeting, and approval evidence.</p>
          </div>
        </div>
        <span className={styles.attentionBadge} data-attention={value.portfolio.attention}>
          {formatLabel(value.portfolio.attention)}
        </span>
      </header>

      <div className={styles.recommendation}>
        <div>
          <span className={styles.suggestionBadge}>Non-authoritative recommendation</span>
          <h4>{recommendation.title}</h4>
          <p>{recommendation.reason}</p>
          <div className={styles.recommendationMeta}>
            <span>{percent(recommendation.confidenceBasisPoints)} confidence</span>
            <span>{formatLabel(recommendation.freshness.status)} evidence</span>
            <span>{recommendation.evidence.length} cited source{recommendation.evidence.length === 1 ? "" : "s"}</span>
          </div>
          {recommendation.uncertainty.length ? (
            <ul className={styles.uncertaintyList}>
              {recommendation.uncertainty.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : null}
        </div>
        <div className={styles.recommendationAction}>
          {recommendation.action === "review_approval" ? (
            <Link href="/app/approvals" className={styles.primaryButton}>Open approvals</Link>
          ) : recommendation.action === "evaluate_health" ? (
            <button className={styles.primaryButton} type="button" onClick={onEvaluateHealth} disabled={!canWrite}>Evaluate health</button>
          ) : recommendedWorkflow ? (
            <button className={styles.primaryButton} type="button" onClick={() => onStartWorkflow(recommendedWorkflow)} disabled={!canRunWorkflow}>
              <Play size={13} aria-hidden="true" /> Open workflow
            </button>
          ) : recommendation.action === "advance_commitment" ? (
            <Link href="/app/meetings" className={styles.primaryButton}>Open meetings</Link>
          ) : null}
          <small>No action runs from this recommendation itself.</small>
        </div>
      </div>

      <div className={styles.intelligenceGrid}>
        <IntelligenceList
          title="Risks"
          count={value.risks.length}
          empty="No current risk signal."
          items={value.risks.slice(0, 5).map((item) => ({
            id: item.riskId,
            title: item.title,
            detail: `${formatLabel(item.severity)} · ${formatLabel(item.freshness.status)} · ${item.reason}`,
            tone: item.severity,
          }))}
        />
        <IntelligenceList
          title="Commitments"
          count={openCommitments.length}
          empty="No open customer commitment."
          items={openCommitments.slice(0, 5).map((item) => ({
            id: item.commitmentSha256,
            title: item.summary,
            detail: [item.owner || "Owner unconfirmed", item.dueAt ? formatDateTime(item.dueAt) : "No due date", formatLabel(item.status)].join(" · "),
            tone: item.dueAt && item.dueAt < value.generatedAt ? "high" : undefined,
          }))}
        />
        <IntelligenceList
          title="Approval queue"
          count={value.approvals.length}
          empty="No customer action is waiting for approval."
          footer={value.approvals.length ? <Link href="/app/approvals">Review approvals</Link> : undefined}
          items={value.approvals.slice(0, 5).map((item) => ({
            id: item.approvalId,
            title: item.title,
            detail: `${formatLabel(item.status)} · risk ${item.riskLevel} · ${formatDateTime(item.createdAt)}`,
            tone: "high",
          }))}
        />
        <IntelligenceList
          title="Account timeline"
          count={value.timeline.length}
          empty="No account history yet."
          items={value.timeline.slice(0, 8).map((item) => ({
            id: item.eventId,
            title: item.title,
            detail: `${formatDateTime(item.occurredAt)} · ${item.summary}`,
          }))}
        />
      </div>
    </section>
  );
}

function IntelligenceList({
  title,
  count,
  empty,
  items,
  footer,
}: {
  title: string;
  count: number;
  empty: string;
  items: Array<{ id: string; title: string; detail: string; tone?: string }>;
  footer?: React.ReactNode;
}) {
  return (
    <article className={styles.intelligenceList}>
      <header><strong>{title}</strong><span>{count}</span></header>
      {items.length ? (
        <ul>{items.map((item) => (
          <li key={item.id} data-tone={item.tone}>
            <strong>{item.title}</strong>
            <small>{item.detail}</small>
          </li>
        ))}</ul>
      ) : <p>{empty}</p>}
      {footer ? <footer>{footer}</footer> : null}
    </article>
  );
}

function CustomerHealthPanel({
  value,
  currentAccountRevisionId,
  canEvaluate,
  evaluating,
  onEvaluate,
}: {
  value?: CustomerHealthPayload;
  currentAccountRevisionId: string;
  canEvaluate: boolean;
  evaluating: boolean;
  onEvaluate: () => void;
}) {
  const score = value?.score;
  const outdated = Boolean(score && score.accountRevisionId !== currentAccountRevisionId);
  return (
    <section className={styles.healthPanel} aria-label="Explainable customer health" aria-busy={evaluating}>
      <header className={styles.healthHeader}>
        <div className={styles.healthIdentity}>
          <span><Gauge size={19} aria-hidden="true" /></span>
          <div>
            <p className={styles.eyebrow}>Deterministic policy · evidence first</p>
            <h3>Explainable customer health</h3>
            <p>Missing, stale, and conflicting inputs lower confidence. Model advice is never authoritative.</p>
          </div>
        </div>
        <button
          className={styles.secondaryButton}
          type="button"
          disabled={!canEvaluate || evaluating}
          onClick={onEvaluate}
        >
          <RefreshCw size={14} aria-hidden="true" /> {evaluating ? "Evaluating…" : score ? "Re-evaluate" : "Evaluate health"}
        </button>
      </header>
      {score ? (
        <>
          {outdated ? (
            <p className={styles.healthOutdated} role="status">
              This score is bound to {shortId(score.accountRevisionId)}; the account is now {shortId(currentAccountRevisionId)}. Re-evaluate before relying on it.
            </p>
          ) : null}
          <div className={styles.healthSummary}>
            <div data-status={score.status}>
              <small>Authoritative score</small>
              <strong>{score.scoreBasisPoints === null ? "Unknown" : percent(score.scoreBasisPoints)}</strong>
              <span>{formatLabel(score.status)}</span>
            </div>
            <div><small>Confidence</small><strong>{percent(score.confidenceBasisPoints)}</strong><span>freshness and conflict adjusted</span></div>
            <div><small>Coverage</small><strong>{percent(score.coverageBasisPoints)}</strong><span>weighted factors with evidence</span></div>
            <div><small>Policy</small><strong>{score.policy.policyVersion}</strong><span>rev {score.revision} · {value?.history.length || 1} retained</span></div>
          </div>
          <div className={styles.factorGrid}>
            {score.factors.map((factor) => (
              <article className={styles.factorCard} key={factor.factorKey} data-state={factor.evidenceState}>
                <header>
                  <div>
                    <small>{factor.weightBasisPoints / 100}% weight</small>
                    <h4>{factor.label}</h4>
                  </div>
                  <strong>{factor.scoreBasisPoints === null ? "—" : percent(factor.scoreBasisPoints)}</strong>
                </header>
                <p>{formatLabel(factor.evidenceState)} · {percent(factor.confidenceBasisPoints)} confidence</p>
                <ul>
                  {factor.evidence.length ? factor.evidence.map((evidence) => (
                    <li key={evidence.factRevisionId}>
                      <span>{shortId(evidence.factRevisionId)}</span>
                      <small>
                        {formatLabel(evidence.freshnessStatus)} · raw {evidence.rawScoreBasisPoints === null ? "unscorable" : percent(evidence.rawScoreBasisPoints)} · effective {percent(evidence.effectiveConfidenceBasisPoints)} confidence
                      </small>
                    </li>
                  )) : <li><span>No current evidence</span><small>This missing factor contributes zero confidence.</small></li>}
                </ul>
              </article>
            ))}
          </div>
          {score.suggestions.length ? (
            <div className={styles.healthSuggestions}>
              <div><Lightbulb size={16} aria-hidden="true" /><strong>Model suggestions · non-authoritative</strong></div>
              {score.suggestions.map((suggestion) => (
                <article key={suggestion.suggestionId}>
                  <p>{suggestion.statement}</p>
                  <small>{formatLabel(suggestion.suggestionKind)} · {percent(suggestion.confidenceBasisPoints)} model confidence · {suggestion.citedFactRevisionIds.length} cited fact{suggestion.citedFactRevisionIds.length === 1 ? "" : "s"}</small>
                </article>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className={styles.healthEmpty}>
          <Gauge size={22} aria-hidden="true" />
          <div>
            <strong>No health score yet</strong>
            <p>Evaluate the current Account 360 revision to create a versioned score. Unknown or missing evidence will stay explicit.</p>
          </div>
        </div>
      )}
    </section>
  );
}

function CustomerSuccessWorkflowPanel({
  value,
  currentAccountRevisionId,
  canStart,
  onStart,
}: {
  value?: CustomerSuccessWorkflowPayload;
  currentAccountRevisionId: string;
  canStart: boolean;
  onStart: (definition: CustomerSuccessWorkflowDefinition) => void;
}) {
  return (
    <section className={styles.workflowPanel} aria-label="Governed customer-success workflows">
      <header className={styles.workflowHeader}>
        <div className={styles.healthIdentity}>
          <span><ListChecks size={19} aria-hidden="true" /></span>
          <div>
            <p className={styles.eyebrow}>Asael CSM pack · governed execution</p>
            <h3>Customer-success workflows</h3>
            <p>Typed inputs become owned project work. Customer messages remain drafts and CRM commitments require governed writes.</p>
          </div>
        </div>
        <span className={styles.packBadge}>8 versioned playbooks</span>
      </header>
      <div className={styles.workflowPackGrid}>
        {(value?.pack || []).map((definition) => (
          <article className={styles.workflowCard} key={definition.workflowId}>
            <div>
              <small>{definition.artifacts.length} artifacts · {definition.evidenceRequirements.length} evidence gates</small>
              <h4>{definition.name}</h4>
              <p>{definition.description}</p>
            </div>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={!canStart}
              onClick={() => onStart(definition)}
            >
              <Play size={12} aria-hidden="true" /> Start
            </button>
          </article>
        ))}
      </div>
      <div className={styles.workflowRuns}>
        <div className={styles.workflowRunsHeading}>
          <strong>Account runs</strong>
          <span>{value?.runs.length || 0}</span>
        </div>
        {value?.runs.length ? value.runs.map((run) => (
          <article className={styles.workflowRun} key={run.runId} data-status={run.outcome.status}>
            <span className={styles.statusDot} data-status={run.outcome.status === "completed" ? "active" : run.outcome.status === "blocked" ? "at_risk" : run.outcome.status} />
            <div>
              <strong>{value.pack.find((item) => item.workflowId === run.workflowId)?.name || formatLabel(run.workflowId)}</strong>
              <p>{run.outcome.nextAction}</p>
              {run.accountRevisionId !== currentAccountRevisionId ? (
                <small data-warning="true">Started from {shortId(run.accountRevisionId)}; the account is now {shortId(currentAccountRevisionId)}.</small>
              ) : (
                <small>rev {run.revision} · {formatLabel(run.outcome.status)} · receipt {run.outcome.receiptSha256.slice(0, 10)}</small>
              )}
            </div>
            <Link href={`/app/projects?project=${encodeURIComponent(run.projectId)}`} className={styles.secondaryButton}>
              Open project
            </Link>
          </article>
        )) : (
          <p className={styles.workflowEmpty}>No CSM workflow has started for this account.</p>
        )}
      </div>
    </section>
  );
}

function WorkflowEditor({
  definition,
  accountName,
  saving,
  onCancel,
  onSubmit,
}: {
  definition: CustomerSuccessWorkflowDefinition;
  accountName: string;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !saving) onCancel();
    }}>
      <form className={styles.editor} onSubmit={onSubmit}>
        <header className={styles.editorHeader}>
          <div>
            <p className={styles.eyebrow}>Asael CSM pack · {accountName}</p>
            <h2>{definition.name}</h2>
          </div>
          <button type="button" onClick={onCancel} aria-label="Close workflow editor" disabled={saving}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className={styles.editorFields}>
          <label className={styles.fullField}>
            <span>Objective</span>
            <textarea name="objective" required maxLength={2_000} autoFocus />
          </label>
          <label>
            <span>Target date · optional</span>
            <input name="targetDate" type="datetime-local" />
          </label>
          {workflowSpecificFields(definition.workflowId)}
          <div className={styles.workflowRequirements}>
            <div>
              <strong>Acceptance criteria</strong>
              <ul>{definition.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
            <div>
              <strong>Required outcome receipts</strong>
              <p>{definition.artifacts.filter((item) => item.required).map((item) => item.title).join(" · ")}</p>
              <p>{definition.evidenceRequirements.filter((item) => item.required).map((item) => item.title).join(" · ")}</p>
            </div>
          </div>
          <div className={styles.permissionNotice}>
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <strong>No direct external effects</strong>
              <p>Starting creates an internal project and work items only. Communication stays unsent until governed delivery; CRM changes require an approval-bound Salesforce tool.</p>
            </div>
          </div>
        </div>
        <footer className={styles.editorFooter}>
          <button className={styles.secondaryButton} type="button" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className={styles.primaryButton} type="submit" disabled={saving}>
            <Play size={14} aria-hidden="true" /> {saving ? "Starting…" : "Create workflow project"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function workflowSpecificFields(workflowId: CustomerSuccessWorkflowId) {
  switch (workflowId) {
    case "onboarding": return <>
      <LinesField name="successCriteria" label="Success criteria · one per line" required />
      <LinesField name="productNames" label="Products · one per line" />
      <LinesField name="stakeholderIds" label="Stakeholder IDs · one per line" />
    </>;
    case "adoption_review": return <>
      <DateField name="periodStartAt" label="Review period start" />
      <DateField name="periodEndAt" label="Review period end" />
      <LinesField name="adoptionGoals" label="Adoption goals · one per line" required />
      <LinesField name="productIds" label="Product IDs · one per line" />
    </>;
    case "risk_escalation": return <>
      <TextField name="riskTitle" label="Risk title" />
      <SelectField name="severity" label="Severity" values={["low", "medium", "high", "critical"]} defaultValue="high" />
      <LinesField name="signals" label="Observed signals · one per line" required />
      <TextField name="executiveSponsorId" label="Executive sponsor ID · optional" required={false} />
    </>;
    case "renewal_planning": return <>
      <DateField name="renewalAt" label="Renewal date" />
      <LinesField name="renewalGoals" label="Renewal goals · one per line" required />
      <TextField name="amount" label="Renewal amount · optional" type="number" required={false} />
      <TextField name="currency" label="Currency · with amount" required={false} />
    </>;
    case "qbr_ebr": return <>
      <SelectField name="reviewKind" label="Review kind" values={["qbr", "ebr"]} defaultValue="qbr" />
      <DateField name="meetingAt" label="Meeting time" />
      <DateField name="periodStartAt" label="Review period start" />
      <DateField name="periodEndAt" label="Review period end" />
      <LinesField name="audience" label="Audience · one per line" required />
      <LinesField name="agendaObjectives" label="Agenda objectives · one per line" required />
    </>;
    case "meeting_prep_follow_up": return <>
      <TextField name="meetingId" label="Meeting ID" />
      <SelectField name="phase" label="Phase" values={["prep", "follow_up"]} defaultValue="prep" />
      <LinesField name="participantIds" label="Participant IDs · one per line" required />
      <LinesField name="meetingObjectives" label="Meeting objectives · one per line" required />
    </>;
    case "support_escalation": return <>
      <LinesField name="caseIds" label="Case IDs · one per line" required />
      <SelectField name="severity" label="Severity" values={["medium", "high", "critical"]} defaultValue="high" />
      <LinesField name="customerImpact" label="Customer impact" required />
      <LinesField name="requestedOutcome" label="Requested outcome" required />
    </>;
    case "expansion_discovery": return <>
      <LinesField name="hypotheses" label="Expansion hypotheses · one per line" required />
      <LinesField name="stakeholderIds" label="Stakeholder IDs · one per line" required />
      <DateField name="discoveryWindowEndAt" label="Discovery window end" />
    </>;
  }
}

function TextField({ name, label, required = true, type = "text" }: {
  name: string;
  label: string;
  required?: boolean;
  type?: "text" | "number";
}) {
  return <label><span>{label}</span><input name={name} type={type} required={required} /></label>;
}

function DateField({ name, label }: { name: string; label: string }) {
  return <label><span>{label}</span><input name={name} type="datetime-local" required /></label>;
}

function SelectField({ name, label, values, defaultValue }: {
  name: string;
  label: string;
  values: string[];
  defaultValue: string;
}) {
  return <label><span>{label}</span><select name={name} defaultValue={defaultValue}>{values.map((value) => <option value={value} key={value}>{formatLabel(value)}</option>)}</select></label>;
}

function LinesField({ name, label, required = false }: { name: string; label: string; required?: boolean }) {
  return <label className={styles.fullField}><span>{label}</span><textarea name={name} required={required} /></label>;
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

function workflowInputFromForm(
  workflowId: CustomerSuccessWorkflowId,
  form: FormData,
): CustomerSuccessWorkflowInput {
  const objective = formText(form, "objective");
  const targetDate = optionalIso(form, "targetDate");
  switch (workflowId) {
    case "onboarding": return {
      workflowId,
      objective,
      targetDate,
      successCriteria: formLines(form, "successCriteria"),
      productNames: formLines(form, "productNames"),
      stakeholderIds: formLines(form, "stakeholderIds"),
    };
    case "adoption_review": return {
      workflowId,
      objective,
      targetDate,
      periodStartAt: requiredIso(form, "periodStartAt"),
      periodEndAt: requiredIso(form, "periodEndAt"),
      adoptionGoals: formLines(form, "adoptionGoals"),
      productIds: formLines(form, "productIds"),
    };
    case "risk_escalation": return {
      workflowId,
      objective,
      targetDate,
      riskTitle: formText(form, "riskTitle"),
      severity: formText(form, "severity") as "low" | "medium" | "high" | "critical",
      signals: formLines(form, "signals"),
      executiveSponsorId: formText(form, "executiveSponsorId") || null,
    };
    case "renewal_planning": {
      const amount = formText(form, "amount");
      const amountMinor = amount ? Math.round(Number(amount) * 100) : null;
      return {
        workflowId,
        objective,
        targetDate,
        renewalAt: requiredIso(form, "renewalAt"),
        renewalGoals: formLines(form, "renewalGoals"),
        amountMinor,
        currency: amountMinor === null ? null : formText(form, "currency").toUpperCase(),
      };
    }
    case "qbr_ebr": return {
      workflowId,
      objective,
      targetDate,
      reviewKind: formText(form, "reviewKind") as "qbr" | "ebr",
      meetingAt: requiredIso(form, "meetingAt"),
      periodStartAt: requiredIso(form, "periodStartAt"),
      periodEndAt: requiredIso(form, "periodEndAt"),
      audience: formLines(form, "audience"),
      agendaObjectives: formLines(form, "agendaObjectives"),
    };
    case "meeting_prep_follow_up": return {
      workflowId,
      objective,
      targetDate,
      meetingId: formText(form, "meetingId"),
      phase: formText(form, "phase") as "prep" | "follow_up",
      participantIds: formLines(form, "participantIds"),
      meetingObjectives: formLines(form, "meetingObjectives"),
    };
    case "support_escalation": return {
      workflowId,
      objective,
      targetDate,
      caseIds: formLines(form, "caseIds"),
      severity: formText(form, "severity") as "medium" | "high" | "critical",
      customerImpact: formText(form, "customerImpact"),
      requestedOutcome: formText(form, "requestedOutcome"),
    };
    case "expansion_discovery": return {
      workflowId,
      objective,
      targetDate,
      hypotheses: formLines(form, "hypotheses"),
      stakeholderIds: formLines(form, "stakeholderIds"),
      discoveryWindowEndAt: requiredIso(form, "discoveryWindowEndAt"),
    };
  }
}

function formText(form: FormData, name: string) {
  return String(form.get(name) || "").trim();
}

function formLines(form: FormData, name: string) {
  return formText(form, name).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function optionalIso(form: FormData, name: string) {
  const value = formText(form, name);
  return value ? new Date(value).toISOString() : null;
}

function requiredIso(form: FormData, name: string) {
  return new Date(formText(form, name)).toISOString();
}

function formatLabel(value: string) {
  return value.replace(/^customer_success\./, "").replaceAll(/[._]/g, " ");
}

function formatLag(value: number | null | undefined) {
  if (value === null || value === undefined) return "Unknown";
  if (value < 60) return `${value}s`;
  if (value < 3_600) return `${Math.floor(value / 60)}m`;
  if (value < 86_400) return `${Math.floor(value / 3_600)}h`;
  return `${Math.floor(value / 86_400)}d`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function portfolioRailLabel(
  account: CustomerAccountRevision,
  intelligence?: CustomerSuccessPortfolioItem,
) {
  if (!intelligence) return `${formatLabel(account.lifecycle)} · rev ${account.revision}`;
  return `${formatLabel(intelligence.attention)} · ${formatLabel(account.lifecycle)} · ${formatLabel(intelligence.nextBestAction.action)}`;
}

function percent(basisPoints: number) {
  return `${(basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 1)}%`;
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
