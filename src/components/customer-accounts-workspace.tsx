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
import { useEffect, useRef, useState } from "react";
import { approvalInboxHref } from "@/lib/approvals/inbox-link";

import {
  canPerform,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";
import type {
  CustomerAccount360,
  CustomerAccountRevision,
  CustomerFactView,
} from "@/lib/customer-success/contracts";
import {
  CUSTOMER_FACT_KINDS,
  type CustomerFactKind,
} from "@/lib/customer-success/fact-kinds";
import type {
  CustomerSuccessAccountIntelligence,
  CustomerSuccessPortfolio,
  CustomerSuccessPortfolioItem,
} from "@/lib/customer-success/intelligence-contracts";
import type {
  CustomerSuccessWorkflowDefinition,
  CustomerSuccessWorkflowId,
  CustomerSuccessWorkflowInput,
} from "@/lib/customer-success/workflow-contracts";
import { accountsScopeKey, accountDetail, accountList, accountReceipt, createAccountsGate, healthRead, healthReceipt, intelligenceRead, portfolioRead, salesforceRead, salesforceReceipt, workflowRead, workflowReceipt, type AccountReadState, type AccountsContext, type HealthPayload, type WorkflowPayload, type SalesforcePayload } from "./accounts-workspace-state";
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

type ReadSource = "list" | "portfolio" | "salesforce" | "detail" | "health" | "workflows" | "intelligence";
const initialReads: Record<ReadSource, AccountReadState> = Object.fromEntries(
  ["list", "portfolio", "salesforce", "detail", "health", "workflows", "intelligence"].map((key) => [key, { state: "idle" }]),
) as Record<ReadSource, AccountReadState>;
type WorkflowDraft = { definition: CustomerSuccessWorkflowDefinition; account: CustomerAccountRevision };
type LifecycleDraft = { account: CustomerAccountRevision; value: CustomerAccountRevision["lifecycle"] };

export function CustomerAccountsWorkspace({ initialAccountId }: { initialAccountId?: string }) {
  const { session, role } = useWorkspaceSession();
  const scope = accountsScopeKey({ tenantId: session?.context?.tenantId, actorId: session?.context?.actorId, email: session?.user?.email, role, authEnabled: session?.authEnabled, authenticated: session?.authenticated, accountId: initialAccountId });
  return <AccountsWorkspace key={scope} initialAccountId={initialAccountId} />;
}

function AccountsWorkspace({ initialAccountId }: { initialAccountId?: string }) {
  const { session, status: sessionStatus, role } = useWorkspaceSession();
  const available = Boolean(session && (!session.authEnabled || session.authenticated) && sessionStatus === "ready");
  const gate = useRef(createAccountsGate()).current;
  const controllers = useRef(new Map<ReadSource, AbortController>());
  const selectedId = useRef(initialAccountId);
  const canvas = useRef<HTMLElement>(null);
  const accountButtons = useRef(new Map<string, HTMLButtonElement>());
  const [mobileView, setMobileView] = useState<"list" | "detail">(initialAccountId ? "detail" : "list");
  const [accounts, setAccounts] = useState<CustomerAccountRevision[]>();
  const [selected, setSelected] = useState<CustomerAccount360>();
  const [customerHealth, setCustomerHealth] = useState<HealthPayload>();
  const [customerWorkflows, setCustomerWorkflows] = useState<WorkflowPayload>();
  const [customerPortfolio, setCustomerPortfolio] = useState<CustomerSuccessPortfolio>();
  const [customerIntelligence, setCustomerIntelligence] = useState<CustomerSuccessAccountIntelligence>();
  const [workspaceContext, setWorkspaceContext] = useState<AccountsContext>();
  const [detailContext, setDetailContext] = useState<AccountsContext>();
  const [salesforce, setSalesforce] = useState<SalesforcePayload>();
  const [reads, setReads] = useState(initialReads);
  const [busy, setBusy] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [createContext, setCreateContext] = useState<AccountsContext>();
  const [workflowEditor, setWorkflowEditor] = useState<WorkflowDraft>();
  const [lifecycleDraft, setLifecycleDraft] = useState<LifecycleDraft>();
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState<{ message: string; value: unknown; href?: string }>();
  const tenantId = session?.context?.tenantId;
  const canCreate = Boolean(available && workspaceContext?.canWrite && reads.list.state === "ready" && canPerform(role, "manage.workflow"));
  const freshDetail = Boolean(selected && reads.detail.state === "ready" && detailContext?.canWrite);
  const canWrite = Boolean(available && freshDetail && canPerform(role, "manage.workflow"));
  const canRunWorkflow = Boolean(available && freshDetail && reads.workflows.state === "ready" && canPerform(role, "run.agent"));
  const canManageSalesforce = Boolean(available && reads.salesforce.state === "ready" && salesforce?.context.canWrite && canPerform(role, "manage.connector"));
  const portfolioByAccountId = new Map((customerPortfolio?.accounts || []).map((item) => [item.accountId, item]));

  function clearSource(source: ReadSource) {
    if (source === "list") { setAccounts(undefined); setWorkspaceContext(undefined); }
    if (source === "portfolio") setCustomerPortfolio(undefined);
    if (source === "salesforce") setSalesforce(undefined);
    if (source === "detail") { setSelected(undefined); setDetailContext(undefined); }
    if (source === "health") setCustomerHealth(undefined);
    if (source === "workflows") setCustomerWorkflows(undefined);
    if (source === "intelligence") setCustomerIntelligence(undefined);
  }
  function abortReads() {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
  }
  async function readSource<T>(source: ReadSource, path: string, parse: (raw: Record<string, unknown>) => T, apply: (value: T) => void, target?: string) {
    if (!available || gate.busy()) return;
    controllers.current.get(source)?.abort();
    const controller = new AbortController();
    controllers.current.set(source, controller);
    const current = gate.read(source);
    const valid = () => current() && !controller.signal.aborted && (!target || selectedId.current === target);
    setReads((previous) => ({ ...previous, [source]: { state: "loading" } }));
    try {
      const raw = await readJson(path, { signal: controller.signal });
      if (!valid()) return;
      const value = parse(raw);
      if (!valid()) return;
      apply(value);
      setReads((previous) => ({ ...previous, [source]: { state: "ready" } }));
    } catch (cause) {
      if (!valid()) return;
      if (cause instanceof AccountsRequestError && [401, 403, 404].includes(cause.status)) clearSource(source);
      setReads((previous) => ({ ...previous, [source]: { state: "error", error: message(cause) } }));
    } finally {
      if (controllers.current.get(source) === controller) controllers.current.delete(source);
    }
  }
  function loadSalesforce() {
    return readSource("salesforce", "/api/customer-accounts/salesforce", salesforceRead, setSalesforce);
  }
  function loadPortfolio() {
    return readSource("portfolio", "/api/customer-accounts/portfolio?limit=200", portfolioRead, setCustomerPortfolio);
  }
  function loadOptional(accountId: string, source: "health" | "workflows" | "intelligence") {
    const base = `/api/customer-accounts/${encodeURIComponent(accountId)}`;
    if (source === "health") return readSource(source, `${base}/health?historyLimit=20`, (raw) => healthRead(raw, accountId), setCustomerHealth, accountId);
    if (source === "workflows") return readSource(source, `${base}/workflows?limit=50`, (raw) => workflowRead(raw, accountId), setCustomerWorkflows, accountId);
    return readSource(source, `${base}/intelligence?historyLimit=100&timelineLimit=100`, (raw) => intelligenceRead(raw, accountId), setCustomerIntelligence, accountId);
  }
  function loadDetail(accountId: string) {
    if (gate.busy()) return;
    if (selectedId.current !== accountId) {
      selectedId.current = accountId;
      for (const source of ["detail", "health", "workflows", "intelligence"] as const) { controllers.current.get(source)?.abort(); clearSource(source); }
      setLifecycleDraft(undefined);
      setWorkflowEditor(undefined);
    }
    void readSource("detail", `/api/customer-accounts/${encodeURIComponent(accountId)}`, (raw) => accountDetail(raw, accountId, tenantId), ({ detail, context }) => { setSelected(detail); setDetailContext(context); }, accountId);
    void loadOptional(accountId, "health");
    void loadOptional(accountId, "workflows");
    void loadOptional(accountId, "intelligence");
  }
  function selectAccount(accountId: string) {
    if (gate.busy()) return;
    loadDetail(accountId);
    setMobileView("detail");
    window.requestAnimationFrame(() => { if (selectedId.current === accountId) canvas.current?.focus(); });
  }
  function showAccountList() {
    setMobileView("list");
    window.requestAnimationFrame(() => { if (selectedId.current) accountButtons.current.get(selectedId.current)?.focus(); });
  }
  function load() {
    if (!available || gate.busy()) return;
    void loadSalesforce();
    void loadPortfolio();
    if (selectedId.current) loadDetail(selectedId.current);
    void readSource("list", "/api/customer-accounts?limit=200", (raw) => accountList(raw, tenantId), ({ accounts: next, context }) => {
      setAccounts(next); setWorkspaceContext(context);
      if (!selectedId.current && next[0]) loadDetail(next[0].accountId);
    });
  }
  useEffect(() => {
    gate.mount();
    const timer = window.setTimeout(load, 0);
    const activeControllers = controllers.current;
    return () => { window.clearTimeout(timer); gate.dispose(); for (const controller of activeControllers.values()) controller.abort(); activeControllers.clear(); };
    // The authenticated identity and external dossier route key own all reads and receipts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  async function effect<T>(label: string, path: string, method: "POST" | "PATCH" | "DELETE", input: unknown, parse: (raw: Record<string, unknown>) => T, accept: (value: T) => void, refresh: () => void, idempotent = true) {
    const token = gate.begin(path, method, input, idempotent);
    if (!token) return;
    abortReads(); setBusy(label); setError(undefined);
    setReads((previous) => Object.fromEntries(Object.entries(previous).map(([key, value]) => [key, value.state === "loading" ? { state: "error", error: "This read was interrupted by an account action. Refresh to check current details." } : value])) as typeof previous);
    let accepted = false;
    try {
      const raw = await readJson(path, { method, headers: { accept: "application/json", ...(token.body ? { "content-type": "application/json" } : {}), ...(token.idempotencyKey ? { "idempotency-key": token.idempotencyKey } : {}) }, body: token.body });
      if (!gate.current(token)) return;
      const result = parse(raw);
      if (!gate.current(token)) return;
      accept(result); accepted = true;
    } catch (cause) {
      if (gate.current(token)) setError(`${message(cause)} The action is not confirmed here. Check the current record before retrying.`);
    } finally {
      if (gate.current(token)) {
        gate.finish(token, accepted); setBusy(undefined);
        // A confirmed receipt is independent of these separately fenced reads.
        if (accepted) refresh();
      }
    }
  }
  function runSalesforceAction(action: "sync" | "reconcile" | "disconnect") {
    if (!canManageSalesforce || !salesforce) return Promise.resolve();
    const endpoint = action === "disconnect" ? `/api/oauth/salesforce?workspaceId=${encodeURIComponent(salesforce.context.workspaceId)}` : `/api/customer-accounts/salesforce/${action}?workspaceId=${encodeURIComponent(salesforce.context.workspaceId)}`;
    return effect(action, endpoint, action === "disconnect" ? "DELETE" : "POST", undefined, (raw) => salesforceReceipt(raw, action), (result) => setReceipt({ message: result.message, value: result.value }), load, false);
  }
  function evaluateHealth() {
    if (!selected || !canWrite) return;
    const account = selected.account;
    void effect("health", `/api/customer-accounts/${encodeURIComponent(account.accountId)}/health`, "POST", { workspaceId: account.workspaceId, expectedAccountRevision: account.revision, expectedAccountSha256: account.accountSha256 }, (raw) => healthReceipt(raw.score, account), (score) => {
      setCustomerHealth((current) => current ? { ...current, score, history: [score, ...current.history.filter((item) => item.scoreRevisionId !== score.scoreRevisionId)].slice(0, 20) } : { policy: score.policy, score, history: [score] });
      setReceipt({ message: `${account.name} health evaluated as ${formatLabel(score.status)} with ${percent(score.confidenceBasisPoints)} confidence.`, value: score });
    }, () => { void loadOptional(account.accountId, "health"); void loadOptional(account.accountId, "intelligence"); void loadPortfolio(); });
  }
  function startCustomerSuccessWorkflow(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !workflowEditor || !canRunWorkflow || workflowEditor.account.accountSha256 !== selected.account.accountSha256 || !customerWorkflows?.pack.some((item) => item.definitionSha256 === workflowEditor.definition.definitionSha256)) return;
    const { account, definition } = workflowEditor;
    let input: CustomerSuccessWorkflowInput;
    try { input = workflowInputFromForm(definition.workflowId, new FormData(event.currentTarget)); } catch (cause) { setError(message(cause)); return; }
    void effect("workflow", `/api/customer-accounts/${encodeURIComponent(account.accountId)}/workflows`, "POST", { workspaceId: account.workspaceId, expectedAccountRevision: account.revision, expectedAccountSha256: account.accountSha256, input }, (raw) => workflowReceipt(raw.run, account, definition, input), (run) => {
      setCustomerWorkflows((current) => current ? { ...current, runs: [run, ...current.runs.filter((item) => item.runId !== run.runId)].slice(0, 50) } : current);
      setWorkflowEditor(undefined);
      setReceipt({ message: `${definition.name} project created for ${account.name}.`, value: run, href: `/app/projects?project=${encodeURIComponent(run.projectId)}` });
    }, () => { void loadOptional(account.accountId, "workflows"); void loadOptional(account.accountId, "intelligence"); void loadPortfolio(); });
  }
  function createAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate || !workspaceContext || createContext?.authoritySha256 !== workspaceContext.authoritySha256) return;
    const form = new FormData(event.currentTarget);
    const input = { workspaceId: workspaceContext.workspaceId, name: formText(form, "name"), lifecycle: formText(form, "lifecycle"), accountOwner: { ownerKind: "actor" as const, ownerId: session?.context?.actorId || session?.user?.email || "current-actor", displayName: formText(form, "ownerName") }, customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"] };
    void effect("create", "/api/customer-accounts", "POST", input, (raw) => accountReceipt(raw.account, { ...input, workspaceId: workspaceContext.workspaceId, tenantId }), (account) => {
      setAccounts((current) => [account, ...(current || []).filter((item) => item.accountId !== account.accountId)].slice(0, 200));
      setCreating(false);
      setReceipt({ message: `${account.name} Account 360 created.`, value: account, href: `/app/accounts/${encodeURIComponent(account.accountId)}` });
      selectedId.current = account.accountId; setSelected(undefined); setDetailContext(undefined); setCustomerHealth(undefined); setCustomerWorkflows(undefined); setCustomerIntelligence(undefined);
      setMobileView("detail");
    }, load);
  }
  function reviseLifecycle() {
    if (!selected || !lifecycleDraft || !canWrite || lifecycleDraft.account.accountSha256 !== selected.account.accountSha256 || lifecycleDraft.value === selected.account.lifecycle) return;
    const { account, value: lifecycle } = lifecycleDraft;
    void effect("lifecycle", `/api/customer-accounts/${encodeURIComponent(account.accountId)}`, "PATCH", { workspaceId: account.workspaceId, expectedRevision: account.revision, lifecycle }, (raw) => accountReceipt(raw.account, { account, lifecycle, workspaceId: account.workspaceId }), (updated) => {
      setSelected((current) => current ? { ...current, account: updated } : current);
      setAccounts((current) => current?.map((item) => item.accountId === updated.accountId ? updated : item));
      setLifecycleDraft(undefined); setReceipt({ message: `${updated.name} lifecycle revised to ${formatLabel(lifecycle)}.`, value: updated });
    }, load);
  }
  function openCreate() { if (!canCreate || gate.busy()) return; setCreateContext(workspaceContext); setCreating(true); setError(undefined); }
  const staleWorkflow = Boolean(workflowEditor && (workflowEditor.account.accountSha256 !== selected?.account.accountSha256 || !customerWorkflows?.pack.some((item) => item.definitionSha256 === workflowEditor.definition.definitionSha256)));
  const staleLifecycle = Boolean(lifecycleDraft && lifecycleDraft.account.accountSha256 !== selected?.account.accountSha256);
  const saving = Boolean(busy);
  const listLabel = accounts ? reads.list.state === "ready" ? "in this bounded workspace list" : "last loaded workspace list" : reads.list.state === "error" ? "count unavailable" : "checking workspace access";
  return (
    <div className={styles.shell} data-testid="customer-accounts-workspace">
      <header className={styles.hero}>
        <div><p className={styles.eyebrow}>Customer success</p><h1>Customer Accounts</h1><p>A sourced customer dossier with exact evidence, freshness, ownership and disagreements.</p></div>
        <div className={styles.heroActions}>
          <button className={styles.secondaryButton} type="button" onClick={load} disabled={!available || saving}><RefreshCw size={16} aria-hidden="true" /> Refresh accounts</button>
          <button className={styles.primaryButton} type="button" onClick={openCreate} disabled={!canCreate || saving}><Plus size={16} aria-hidden="true" /> New account</button>
        </div>
      </header>
      {!available ? <p role="status">{sessionStatus === "loading" ? "Checking your workspace session…" : "Customer accounts are unavailable until your workspace session is ready."}</p> : null}
      <section className={styles.metrics} aria-label="Customer account overview">
        <Metric value={accounts?.length ?? "Unavailable"} label="Accounts" detail={listLabel} />
        <Metric value={accounts?.filter((item) => ["active", "onboarding"].includes(item.lifecycle)).length ?? "Unavailable"} label="In motion" detail={accounts ? `${reads.list.state === "ready" ? "" : "Last loaded · "}active or onboarding` : "not yet checked"} />
        <Metric value={customerPortfolio?.counts.urgent ?? "Unavailable"} label="Needs attention" detail={customerPortfolio ? `${reads.portfolio.state === "ready" ? "" : "Last loaded · "}in the bounded projection` : "intelligence not yet checked"} warning={Boolean(customerPortfolio?.counts.urgent)} />
        <Metric value={customerPortfolio?.counts.pendingApprovals ?? "Unavailable"} label="Approvals" detail={customerPortfolio ? `${reads.portfolio.state === "ready" ? "" : "Last loaded · "}customer actions waiting` : "approval count not yet checked"} warning={Boolean(customerPortfolio?.counts.pendingApprovals)} />
      </section>
      <p className={styles.support}>Up to 200 readable accounts and 200 portfolio projections. Counts describe these bounded reads, not a complete CRM inventory.</p>
      <ReadStatus label="Account list" state={reads.list} retained={accounts !== undefined} disabled={saving} onRetry={load} />
      <ReadStatus label="Portfolio intelligence" state={reads.portfolio} retained={Boolean(customerPortfolio)} disabled={saving} onRetry={() => void loadPortfolio()} />
      <SalesforcePanel payload={salesforce} loading={reads.salesforce.state === "loading"} action={(["sync", "reconcile", "disconnect"].includes(busy || "") ? busy : undefined) as "sync" | "reconcile" | "disconnect" | undefined} canManage={canManageSalesforce && !saving} onAction={runSalesforceAction} />
      <ReadStatus label="Salesforce" state={reads.salesforce} retained={Boolean(salesforce)} disabled={saving} onRetry={() => void loadSalesforce()} />
      {receipt ? <section className={styles.receipt} aria-label="Confirmed account action"><p role="status">{receipt.message}</p>{receipt.href ? <Link className={styles.secondaryButton} href={receipt.href}>Open confirmed record</Link> : null}<ExactEvidence label="Confirmed action receipt" value={receipt.value} /></section> : null}
      {error ? <div className={styles.error} role="alert"><AlertTriangle size={16} aria-hidden="true" /><span>{error}</span><button type="button" onClick={() => setError(undefined)}>Dismiss action error</button></div> : null}
      <p className={styles.support}>Management requires workspace write access and the account owner. The server checks ownership for every action. Refresh stale account details before making changes.</p>
      <div className={styles.workspace} data-mobile-view={mobileView}>
        <aside className={styles.rail} aria-label="Customer account list" tabIndex={0}>
          <div className={styles.railHeading}><h2>Portfolio</h2><span>{accounts ? `${accounts.length}${reads.list.state !== "ready" ? " · Last loaded" : ""}` : "Count unavailable"}</span></div>
          {accounts?.map((account) => <button type="button" ref={(element) => { if (element) accountButtons.current.set(account.accountId, element); else accountButtons.current.delete(account.accountId); }} className={selectedId.current === account.accountId ? styles.selectedRailItem : styles.railItem} key={account.accountId} aria-pressed={selectedId.current === account.accountId} disabled={saving} onClick={() => selectAccount(account.accountId)}><span><strong>{account.name}</strong><small>{portfolioRailLabel(account, portfolioByAccountId.get(account.accountId))}</small></span><Building2 size={16} aria-hidden="true" /></button>)}
          {accounts?.length === 0 ? <p className={styles.emptyRail}>No customer accounts were returned in this workspace.</p> : !accounts ? <p className={styles.emptyRail}>{reads.list.state === "error" ? "The account list is unavailable." : "Checking customer accounts…"}</p> : null}
        </aside>
        <section className={styles.canvas} aria-label="Account dossier" ref={canvas} tabIndex={-1}>
          <button className={styles.mobileBack} type="button" onClick={showAccountList} disabled={saving}><ArrowLeft size={16} aria-hidden="true" /> Back to account list</button>
          {selectedId.current ? <ReadStatus label="Account dossier" state={reads.detail} retained={Boolean(selected)} disabled={saving} onRetry={() => selectedId.current && loadDetail(selectedId.current)} /> : null}
          {selected ? <AccountDetail value={selected} health={customerHealth} workflows={customerWorkflows} intelligence={customerIntelligence} reads={reads} busy={saving} onRetry={(source) => void loadOptional(selected.account.accountId, source)} canWrite={canWrite && !saving} canRunWorkflow={canRunWorkflow && !saving} healthEvaluating={busy === "health"} lifecycleDraft={lifecycleDraft} staleLifecycle={staleLifecycle} saving={saving} onEditLifecycle={() => setLifecycleDraft({ account: selected.account, value: selected.account.lifecycle })} onCancelLifecycle={() => setLifecycleDraft(undefined)} onLifecycleChange={(value) => setLifecycleDraft((draft) => draft ? { ...draft, value } : draft)} onReviseLifecycle={reviseLifecycle} onEvaluateHealth={evaluateHealth} onStartWorkflow={(definition) => { if (canRunWorkflow && !gate.busy()) { setWorkflowEditor({ definition, account: selected.account }); setError(undefined); } }} /> : <div className={styles.emptyCanvas}><DatabaseZap size={28} aria-hidden="true" /><h2>{reads.detail.state === "error" ? "Account dossier unavailable" : selectedId.current ? "Loading the selected dossier…" : accounts ? "Choose or create an account" : "Checking customer access…"}</h2><p>Account facts remain provider neutral. An unavailable source is not evidence of an empty account.</p></div>}
        </section>
      </div>
      {creating ? <AccountDialog title="New Account 360" busy={saving} onClose={() => setCreating(false)}><form onSubmit={createAccount}><fieldset disabled={saving}><div className={styles.editorFields}><label><span>Account name</span><input name="name" required maxLength={240} autoFocus /></label><label><span>Lifecycle</span><select name="lifecycle" defaultValue="prospect">{lifecycleOptions().map((value) => <option value={value} key={value}>{formatLabel(value)}</option>)}</select></label><label className={styles.fullField}><span>Account owner</span><input name="ownerName" required maxLength={180} defaultValue={session?.user?.name || session?.user?.email || "Account owner"} /></label><div className={styles.permissionNotice}><ShieldCheck size={18} aria-hidden="true" /><div><strong>Explicit permissions</strong><p>Workspace members may read. Only the account owner may manage. External CRM writes are disabled.</p></div></div></div></fieldset>{error ? <p className={styles.error} role="alert">{error}</p> : null}{!canCreate || createContext?.authoritySha256 !== workspaceContext?.authoritySha256 ? <p className={styles.support}>Recheck workspace access before creating. If access changed, close this draft and review a new account.</p> : null}<footer className={styles.editorFooter}><button className={styles.secondaryButton} type="button" onClick={load} disabled={saving}>Recheck workspace access</button><button className={styles.secondaryButton} type="button" onClick={() => setCreating(false)} disabled={saving}>Cancel</button><button className={styles.primaryButton} type="submit" disabled={saving || !canCreate || createContext?.authoritySha256 !== workspaceContext?.authoritySha256}>{busy === "create" ? "Creating…" : "Create Account 360"}</button></footer></form></AccountDialog> : null}
      {workflowEditor ? <WorkflowEditor definition={workflowEditor.definition} accountName={workflowEditor.account.name} accountRevisionId={workflowEditor.account.revisionId} saving={saving} disabled={!canRunWorkflow || staleWorkflow} error={error} onRefresh={load} onCancel={() => setWorkflowEditor(undefined)} onSubmit={startCustomerSuccessWorkflow} /> : null}
    </div>
  );
}

function ReadStatus({ label, state, retained, onRetry, disabled }: { label: string; state: AccountReadState; retained: boolean; onRetry: () => void; disabled: boolean }) {
  if (state.state === "ready") return null;
  return <div className={styles.readStatus}><p role={state.state === "error" ? "alert" : "status"}><strong>{label}: </strong>{state.state === "error" ? `${retained ? "Refresh unavailable; last-loaded details are shown. " : "Unavailable. "}${state.error || "Please retry this source."}` : `${retained ? "Refreshing; last-loaded details are shown." : "Loading…"}`}</p>{state.state === "error" ? <button className={styles.secondaryButton} type="button" disabled={disabled} onClick={onRetry}>Retry {label.toLowerCase()}</button> : null}</div>;
}
function ExactEvidence({ label, value }: { label: string; value: unknown }) {
  return <details className={styles.exactEvidence}><summary>{label}</summary><pre tabIndex={0} aria-label={label}>{JSON.stringify(value, null, 2)}</pre></details>;
}
function AccountDialog({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  return <dialog ref={ref} className={styles.editor} aria-label={title} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onClick={(event) => { if (event.target === event.currentTarget && !busy) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}><header className={styles.editorHeader}><h2>{title}</h2><button type="button" disabled={busy} onClick={onClose} aria-label={`Close ${title}`}><X size={18} aria-hidden="true" /></button></header>{children}</dialog>;
}

function SalesforcePanel({
  payload,
  loading,
  action,
  canManage,
  onAction,
}: {
  payload?: SalesforcePayload;
  loading: boolean;
  action?: "sync" | "reconcile" | "disconnect";
  canManage: boolean;
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
        <div><small>Cursor</small><strong>{health?.cursor ? `${cursorProgress}/${health.objectScope.length} current` : health ? "Not started" : "Unavailable"}</strong></div>
        <div><small>Lag</small><strong>{formatLag(health?.lagSeconds)}</strong></div>
        <div><small>Scope</small><strong>{health ? `${health.objectScope.length} objects · read only` : "Unavailable"}</strong></div>
        <div><small>Webhook</small><strong>{payload ? payload.webhook.configured ? "Verified HMAC" : "Not configured" : "Unavailable"}</strong></div>
        <div><small>Reconciliation</small><strong>{payload ? `${payload.findings.length} findings (up to 50)` : "Unavailable"}</strong></div>
        <div><small>Write gate</small><strong>{payload ? payload.writes.configured ? "Approval-bound" : "Disabled" : "Unavailable"}</strong></div>
        <div><small>Write receipts</small><strong>{payload ? `${payload.writes.operations.length} retained (up to 25)` : "Unavailable"}</strong></div>
      </div>
      <div className={styles.salesforceActions}>
        {!health ? <p>Connection configuration has not been confirmed.</p> : !health.configured ? (
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
      ) : null}
      {payload ? <ExactEvidence label="Exact Salesforce connection, scope and receipts" value={payload} /> : null}
    </section>
  );
}

function AccountDetail({
  value,
  health,
  workflows,
  intelligence,
  reads,
  busy,
  onRetry,
  canWrite,
  canRunWorkflow,
  healthEvaluating,
  lifecycleDraft,
  staleLifecycle,
  saving,
  onEditLifecycle,
  onCancelLifecycle,
  onLifecycleChange,
  onReviseLifecycle,
  onEvaluateHealth,
  onStartWorkflow,
}: {
  value: CustomerAccount360;
  health?: HealthPayload;
  workflows?: WorkflowPayload;
  intelligence?: CustomerSuccessAccountIntelligence;
  reads: Record<ReadSource, AccountReadState>;
  busy: boolean;
  onRetry: (source: "health" | "workflows" | "intelligence") => void;
  canWrite: boolean;
  canRunWorkflow: boolean;
  healthEvaluating: boolean;
  lifecycleDraft?: LifecycleDraft;
  staleLifecycle: boolean;
  saving: boolean;
  onEditLifecycle: () => void;
  onCancelLifecycle: () => void;
  onLifecycleChange: (value: CustomerAccountRevision["lifecycle"]) => void;
  onReviseLifecycle: () => void;
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
        {lifecycleDraft ? (
          <form className={styles.lifecycleEditor} onSubmit={(event) => { event.preventDefault(); onReviseLifecycle(); }}>
            <select
              value={lifecycleDraft.value}
              disabled={saving}
              onChange={(event) => onLifecycleChange(
                event.target.value as CustomerAccountRevision["lifecycle"],
              )}
              aria-label="Account lifecycle"
            >
              {lifecycleOptions().map((option) => (
                <option value={option} key={option}>{formatLabel(option)}</option>
              ))}
            </select>
            <p className={styles.support}>Reviewed account revision: {lifecycleDraft.account.revisionId}</p>
            {staleLifecycle ? <p role="status">The account changed. Cancel this draft and review its current revision before saving.</p> : null}
            <button className={styles.primaryButton} type="submit" disabled={!canWrite || saving || staleLifecycle || lifecycleDraft.value === account.lifecycle}>Save lifecycle</button>
            <button className={styles.secondaryButton} type="button" disabled={saving} onClick={onCancelLifecycle}>Cancel</button>
          </form>
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

      <Link className={styles.secondaryButton} href={`/app/accounts/${encodeURIComponent(account.accountId)}`}>Open dossier link</Link>
      <ExactEvidence label="Account identity, revision and permissions" value={account} />
      <ReadStatus label="Account intelligence" state={reads.intelligence} retained={Boolean(intelligence)} disabled={busy} onRetry={() => onRetry("intelligence")} />
      {intelligence && intelligence.portfolio.accountRevisionId !== account.revisionId ? <p className={styles.healthOutdated}>Intelligence reflects {intelligence.portfolio.accountRevisionId}. The current account is {account.revisionId}. Refresh before relying on its recommendations.</p> : null}
      <CustomerIntelligencePanel
        value={intelligence}
        workflows={workflows}
        canWrite={canWrite}
        canRunWorkflow={canRunWorkflow}
        onEvaluateHealth={onEvaluateHealth}
        onStartWorkflow={onStartWorkflow}
      />

      <ReadStatus label="Customer health" state={reads.health} retained={Boolean(health)} disabled={busy} onRetry={() => onRetry("health")} />
      <CustomerHealthPanel
        value={health}
        currentAccountRevisionId={account.revisionId}
        canEvaluate={canWrite}
        evaluating={healthEvaluating}
        onEvaluate={onEvaluateHealth}
      />

      <ReadStatus label="Customer workflows" state={reads.workflows} retained={Boolean(workflows)} disabled={busy} onRetry={() => onRetry("workflows")} />
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
  workflows?: WorkflowPayload;
  canWrite: boolean;
  canRunWorkflow: boolean;
  onEvaluateHealth: () => void;
  onStartWorkflow: (definition: CustomerSuccessWorkflowDefinition) => void;
}) {
  if (!value) {
    return (
      <section className={styles.intelligencePanel} aria-label="Customer-success decision view">
        <div className={styles.intelligenceLoading}>Account intelligence has not been confirmed. Risks, commitments, approvals and timeline are unavailable.</div>
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
          items={value.risks.map((item) => ({
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
          items={openCommitments.map((item) => ({
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
          items={value.approvals.map((item) => ({
            id: item.approvalId,
            title: item.title,
            detail: `${formatLabel(item.status)} · risk ${item.riskLevel} · ${formatDateTime(item.createdAt)}`,
            tone: "high",
            href: approvalInboxHref({ id: item.approvalId, kind: item.kind, returnTo: `/app/accounts/${encodeURIComponent(value.portfolio.accountId)}` }),
          }))}
        />
        <IntelligenceList
          title="Account timeline"
          count={value.timeline.length}
          empty="No account history yet."
          items={value.timeline.map((item) => ({
            id: item.eventId,
            title: item.title,
            detail: `${formatDateTime(item.occurredAt)} · ${item.summary}`,
          }))}
        />
      </div>
      <p className={styles.support}>Bounded evidence: up to 250 risks, 500 commitments, 100 approvals and 100 timeline entries requested. Evaluation: {value.generatedAt}.</p>
      <ExactEvidence label="Exact intelligence sources and uncertainty" value={value} />
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
  items: Array<{ id: string; title: string; detail: string; tone?: string; href?: string }>;
  footer?: React.ReactNode;
}) {
  const [shown, setShown] = useState(5);
  return (
    <article className={styles.intelligenceList}>
      <header><strong>{title}</strong><span>{count}</span></header>
      {items.length ? (
        <ul>{items.slice(0, shown).map((item) => (
          <li key={item.id} data-tone={item.tone}>
            <strong>{item.title}</strong>
            <small>{item.detail}</small>
            <small>Source ID: {item.id}</small>
            {item.href ? <Link className={styles.secondaryButton} href={item.href}>Review {item.title}</Link> : null}
          </li>
        ))}</ul>
      ) : <p>{empty}</p>}
      {shown < items.length ? <button className={styles.secondaryButton} type="button" onClick={() => setShown((count) => count + 10)}>Show more {title.toLowerCase()} ({items.length - shown} remaining)</button> : null}
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
  value?: HealthPayload;
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
            <div><small>Policy</small><strong>{score.policy.policyVersion}</strong><span>rev {score.revision} · {value?.history.length ?? "Unavailable"} retained (up to 20)</span></div>
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
            <strong>{value ? "No health score yet" : "Health evaluation unavailable"}</strong>
            <p>{value ? "Evaluate the current Account 360 revision to create a versioned score. Unknown or missing evidence will stay explicit." : "A missing read does not establish account health or the absence of earlier evaluations."}</p>
          </div>
        </div>
      )}
      {value ? <ExactEvidence label="Exact health evaluation, evidence and retained history" value={value} /> : null}
    </section>
  );
}

function CustomerSuccessWorkflowPanel({
  value,
  currentAccountRevisionId,
  canStart,
  onStart,
}: {
  value?: WorkflowPayload;
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
        <span className={styles.packBadge}>{value ? `${value.pack.length} versioned playbooks` : "Playbook count unavailable"}</span>
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
              aria-label={`Review ${definition.name} workflow`}
            >
              <Play size={12} aria-hidden="true" /> Review inputs
            </button>
          </article>
        ))}
      </div>
      <div className={styles.workflowRuns}>
        <div className={styles.workflowRunsHeading}>
          <strong>Account runs</strong>
          <span>{value?.runs.length ?? "Unavailable"}</span>
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
                <small>rev {run.revision} · {formatLabel(run.outcome.status)} · receipt {run.outcome.receiptSha256}</small>
              )}
            </div>
            <Link href={`/app/projects?project=${encodeURIComponent(run.projectId)}`} className={styles.secondaryButton}>
              Open project
            </Link>
          </article>
        )) : (
          <p className={styles.workflowEmpty}>{value ? "No CSM workflow was returned for this account." : "Workflow history is unavailable."}</p>
        )}
      </div>
      {value ? <ExactEvidence label="Exact workflow definitions and up to 50 run receipts" value={value} /> : null}
    </section>
  );
}

function WorkflowEditor({
  definition,
  accountName,
  accountRevisionId,
  saving,
  disabled,
  error,
  onRefresh,
  onCancel,
  onSubmit,
}: {
  definition: CustomerSuccessWorkflowDefinition;
  accountName: string;
  accountRevisionId: string;
  saving: boolean;
  disabled: boolean;
  error?: string;
  onRefresh: () => void;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <AccountDialog title={definition.name} busy={saving} onClose={onCancel}>
      <form onSubmit={onSubmit}>
        <p className={styles.support}>{accountName} · Reviewed revision: {accountRevisionId}</p>
        <fieldset disabled={saving}>
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
        </fieldset>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {disabled ? <p className={styles.support}>Current account access and the reviewed account revision and workflow definition are required. Recheck the sources; if the revision or definition changed, close and review the inputs again.</p> : null}
        <footer className={styles.editorFooter}>
          <button className={styles.secondaryButton} type="button" onClick={onRefresh} disabled={saving}>Recheck account sources</button>
          <button className={styles.secondaryButton} type="button" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className={styles.primaryButton} type="submit" disabled={saving || disabled}>
            <Play size={14} aria-hidden="true" /> {saving ? "Starting…" : "Create workflow project"}
          </button>
        </footer>
      </form>
    </AccountDialog>
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
  return <label><span>{label}</span><input name={name} type={type} required={required} min={type === "number" ? 0 : undefined} step={type === "number" ? "0.01" : undefined} /></label>;
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
  const [shown, setShown] = useState(5);
  return (
    <section className={styles.domainSection} data-empty={facts.length === 0}>
      <header>
        <span>{categoryLabels[kind]}</span>
        <strong>{facts.length}</strong>
      </header>
      {facts.length ? facts.slice(0, shown).map((view) => (
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
              detail={`${shortId(view.fact.source.sourceRevisionId)} · ${view.fact.source.sourceRevisionSha256}`}
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
          <ExactEvidence label={`Exact fact and source evidence: ${view.fact.factKey}`} value={view} />
        </article>
      )) : (
        <p className={styles.emptyDomain}>No current {categoryLabels[kind].toLowerCase()} facts.</p>
      )}
      {shown < facts.length ? <button className={styles.secondaryButton} type="button" onClick={() => setShown((count) => count + 10)}>Show more {categoryLabels[kind].toLowerCase()} ({facts.length - shown} remaining)</button> : null}
    </section>
  );
}

function Metric({ value, label, detail, warning = false }: {
  value: number | string;
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
      <dd>{value}<small>{detail}</small></dd>
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
  return value;
}

class AccountsRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function readJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : `Request returned ${response.status}.`;
    throw new AccountsRequestError(detail, response.status);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("The account source returned an invalid response.");
  return payload as Record<string, unknown>;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Customer accounts could not be updated.";
}
