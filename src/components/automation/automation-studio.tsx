"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Box,
  Cable,
  CalendarClock,
  CheckCircle2,
  CirclePlay,
  Clock3,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  Plug,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Workflow,
  Wrench,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  automationResourceDefinitions,
  buildCapabilitySummary,
  importedPluginPreviewPayload,
  integrationsOverviewAt,
  isJsonRecord,
  MAX_PLUGIN_MANIFEST_BYTES,
  numberAt,
  pluginManifestByteLength,
  recordAt,
  recordsAt,
  stringListAt,
  summarizeRisk,
  textAt,
  type AutomationResourceKey,
  type AutomationSnapshot,
  type CapabilityState,
  type JsonRecord,
} from "./automation-model";
import styles from "./automation-studio.module.css";

type StudioTab =
  | "overview"
  | "automations"
  | "skills"
  | "connections"
  | "plugins"
  | "advanced";

type ResourceLoad = {
  status: "loading" | "ready" | "error";
  data?: JsonRecord;
  error?: string;
};

type ResourceLedger = Record<AutomationResourceKey, ResourceLoad>;

const tabs: ReadonlyArray<{
  id: StudioTab;
  label: string;
  compactLabel?: string;
}> = [
  { id: "overview", label: "Overview" },
  { id: "automations", label: "Automations" },
  { id: "skills", label: "Skills" },
  { id: "connections", label: "Connections & MCP", compactLabel: "Connections" },
  { id: "plugins", label: "Plugins" },
  { id: "advanced", label: "Advanced audit", compactLabel: "Advanced" },
] as const;

const initialLedger = Object.fromEntries(
  automationResourceDefinitions.map(({ key }) => [key, { status: "loading" }]),
) as ResourceLedger;

export function AutomationStudioFallback() {
  return (
    <div className={styles.studio} aria-label="Loading Automation workspace">
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.eyebrow}><Sparkles size={14} aria-hidden="true" />Capability system</span>
          <h1>Automation</h1>
          <p>Loading the governed capability inventory…</p>
        </div>
      </header>
      <div className={styles.fallbackTabs} />
      <div className={styles.fallbackCanvas}><span /><span /><span /></div>
    </div>
  );
}

export function AutomationStudio() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = studioTab(searchParams.get("view"));
  const [ledger, setLedger] = useState<ResourceLedger>(initialLedger);
  const [refreshedAt, setRefreshedAt] = useState<string>();
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    setLedger((current) =>
      Object.fromEntries(
        automationResourceDefinitions.map(({ key }) => [
          key,
          { status: "loading", data: current[key].data },
        ]),
      ) as ResourceLedger,
    );

    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    await Promise.allSettled(
      automationResourceDefinitions.map(async ({ key, label, endpoint }) => {
        try {
          const data = await readAutomationResource(endpoint, controller.signal);
          if (generationRef.current !== generation) return;
          setLedger((current) => ({
            ...current,
            [key]: { status: "ready", data },
          }));
        } catch (error) {
          if (generationRef.current !== generation) return;
          const message = resourceErrorMessage(key, label, error);
          setLedger((current) => ({
            ...current,
            [key]: { status: "error", error: message },
          }));
        }
      }),
    );
    window.clearTimeout(timeout);
    if (generationRef.current === generation) {
      setRefreshedAt(new Date().toISOString());
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.abort();
    };
  }, [refresh]);

  const snapshot = useMemo<AutomationSnapshot>(() => {
    const ready: AutomationSnapshot = {};
    for (const { key } of automationResourceDefinitions) {
      if (ledger[key].status === "ready" && ledger[key].data) {
        ready[key] = ledger[key].data;
      }
    }
    return ready;
  }, [ledger]);

  const loading = Object.values(ledger).some((resource) => resource.status === "loading");
  const errorCount = Object.values(ledger).filter((resource) => resource.status === "error").length;

  const navigateToTab = useCallback((tab: StudioTab) => {
    const next = new URLSearchParams(searchParams.toString());
    if (tab === "overview") next.delete("view");
    else next.set("view", tab);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  function moveTabFocus(event: KeyboardEvent<HTMLElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    navigateToTab(nextTab.id);
    window.requestAnimationFrame(() => {
      document.getElementById(`automation-tab-${nextTab.id}`)?.focus();
    });
  }

  return (
    <div className={styles.studio}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.eyebrow}><Sparkles size={14} aria-hidden="true" />Capability system</span>
          <h1>Automation</h1>
          <p>Define what Asael can access, how agents work, and what should happen again.</p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.refreshStatus} aria-live="polite">
            <span className={loading ? styles.statusWorking : errorCount ? styles.statusWarning : styles.statusReady} />
            <span>
              {loading
                ? "Refreshing capability status"
                : errorCount
                  ? `${errorCount} ${errorCount === 1 ? "source needs" : "sources need"} attention`
                  : refreshedAt
                    ? `Current as of ${formatTime(refreshedAt)}`
                    : "Capability status ready"}
            </span>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={16} className={loading ? styles.spin : undefined} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </header>

      <nav className={styles.tabs} role="tablist" aria-label="Automation workspace sections" onKeyDown={moveTabFocus}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`automation-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`automation-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => navigateToTab(tab.id)}
          >
            <span className={styles.fullTabLabel}>{tab.label}</span>
            <span className={styles.compactTabLabel}>{tab.compactLabel || tab.label}</span>
          </button>
        ))}
      </nav>

      <section
        id={`automation-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`automation-tab-${activeTab}`}
        className={styles.panel}
      >
        {activeTab === "overview" ? (
          <OverviewPanel snapshot={snapshot} ledger={ledger} onNavigate={navigateToTab} />
        ) : null}
        {activeTab === "automations" ? (
          <AutomationsPanel ledger={ledger} onRefresh={refresh} />
        ) : null}
        {activeTab === "skills" ? <SkillsPanel ledger={ledger} /> : null}
        {activeTab === "connections" ? (
          <ConnectionsPanel ledger={ledger} />
        ) : null}
        {activeTab === "plugins" ? <PluginsPanel ledger={ledger} onRefresh={refresh} /> : null}
        {activeTab === "advanced" ? (
          <AdvancedPanel snapshot={snapshot} ledger={ledger} />
        ) : null}
      </section>
    </div>
  );
}

function OverviewPanel({
  snapshot,
  ledger,
  onNavigate,
}: {
  snapshot: AutomationSnapshot;
  ledger: ResourceLedger;
  onNavigate: (tab: StudioTab) => void;
}) {
  const summary = buildCapabilitySummary(snapshot);
  const destinations: Record<(typeof summary)[number]["key"], StudioTab> = {
    access: "connections",
    actions: "advanced",
    guidance: "skills",
    repeat: "automations",
    bundles: "plugins",
  };
  const icons: Record<(typeof summary)[number]["key"], ComponentType<{ size?: number }>> = {
    access: Cable,
    actions: Wrench,
    guidance: BookOpen,
    repeat: Workflow,
    bundles: Box,
  };

  return (
    <div className={styles.overview}>
      <section className={styles.sectionIntro}>
        <div>
          <span className={styles.sectionNumber}>01</span>
          <h2>How a capability becomes useful</h2>
          <p>Access, action, guidance, and repetition stay separate so authority remains visible.</p>
        </div>
        <Link href="/app/workflows">Open workflow queue <ArrowRight size={15} aria-hidden="true" /></Link>
      </section>

      <div className={styles.capabilityChain} aria-label="Asael capability chain">
        {summary.map((item, index) => {
          const Icon = icons[item.key];
          return (
            <div className={styles.chainStep} key={item.key}>
              <button type="button" onClick={() => onNavigate(destinations[item.key])}>
                <span className={styles.chainIcon}><Icon size={19} /></span>
                <span className={styles.chainCopy}>
                  <small>{String(index + 1).padStart(2, "0")} · {item.label}</small>
                  <strong>{chainTitle(item.key)}</strong>
                  <span>{item.detail}</span>
                </span>
                <span className={styles.chainValue} data-state={item.state}>{item.value}</span>
              </button>
              {index < summary.length - 1 ? <ArrowRight className={styles.chainArrow} size={16} aria-hidden="true" /> : null}
            </div>
          );
        })}
      </div>

      <div className={styles.overviewColumns}>
        <section className={styles.explainer}>
          <div className={styles.sectionHeading}>
            <div><span className={styles.sectionNumber}>02</span><h2>What each part means</h2></div>
          </div>
          <dl>
            <div><dt>Connections</dt><dd>Authorize an account or API. They grant access, but do not decide what an agent should do.</dd></div>
            <div><dt>MCP servers</dt><dd>Expose live tools and resources through a standard protocol. Discovered actions still enter Asael&apos;s review boundary.</dd></div>
            <div><dt>Tools</dt><dd>One atomic, governed action—read a file, send an email, or update a record—with risk and approval policy.</dd></div>
            <div><dt>Skills</dt><dd>Reusable instructions that teach an agent a method. A Skill never grants access on its own.</dd></div>
            <div><dt>Automations</dt><dd>A trigger and workflow that repeat known work. Every side effect still executes through Tools.</dd></div>
            <div><dt>Plugins</dt><dd>Reviewed declarative bundles of Skills, MCP templates, and automation templates. No arbitrary code or embedded secrets.</dd></div>
          </dl>
        </section>

        <section className={styles.healthSection}>
          <div className={styles.sectionHeading}>
            <div><span className={styles.sectionNumber}>03</span><h2>Live inventory</h2></div>
            <button type="button" onClick={() => onNavigate("advanced")}>Open audit</button>
          </div>
          <div className={styles.healthList}>
            {automationResourceDefinitions.map((source) => (
              <ResourceHealthRow key={source.key} label={source.label} resource={ledger[source.key]} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function AutomationsPanel({
  ledger,
  onRefresh,
}: {
  ledger: ResourceLedger;
  onRefresh: () => Promise<void>;
}) {
  const triggers = recordsAt(ledger.triggers.data, "triggers");
  const schedules = triggers.filter((trigger) =>
    textAt(trigger, ["triggerKind"], "webhook") === "schedule"
  );
  const webhooks = triggers.filter((trigger) =>
    textAt(trigger, ["triggerKind"], "webhook") === "webhook"
  );
  const workflows = recordsAt(ledger.workflows.data, "runs");
  const procedures = recordsAt(ledger.triggers.data, "procedures").filter(
    (procedure) => procedure.schedulable === true,
  );
  const agents = recordsAt(ledger.triggers.data, "agents");
  const occurrences = recordsAt(ledger.triggers.data, "occurrences");
  const receipts = recordsAt(ledger.triggers.data, "receipts");
  const [formOpen, setFormOpen] = useState(false);
  const [replacementId, setReplacementId] = useState<string>();
  const [mutationId, setMutationId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [previews, setPreviews] = useState<Record<string, JsonRecord>>({});
  const [historyId, setHistoryId] = useState<string>();
  const [historyLoads, setHistoryLoads] = useState<Record<string, ResourceLoad>>({});

  async function controlSchedule(
    triggerId: string,
    action: "pause" | "resume" | "run_once",
  ) {
    setMutationId(`${triggerId}:${action}`);
    setMessage(undefined);
    setError(undefined);
    try {
      await mutateAutomation(`/api/triggers/${encodeURIComponent(triggerId)}`, {
        action,
        ...(action === "run_once"
          ? { scheduledFor: new Date().toISOString() }
          : {}),
      }, `workflow-schedule-${action}`);
      setMessage(action === "run_once"
        ? "The read-only occurrence was queued."
        : action === "pause"
          ? "Schedule paused."
          : "Schedule resumed.");
      await onRefresh();
      if (historyId === triggerId) await loadHistory(triggerId);
    } catch (caught) {
      setError(safeMutationError(caught, "The schedule could not be changed."));
    } finally {
      setMutationId(undefined);
    }
  }

  async function loadPreview(triggerId: string) {
    setMutationId(`${triggerId}:preview`);
    setError(undefined);
    try {
      const result = await readAutomationResource(
        `/api/triggers/${encodeURIComponent(triggerId)}`,
        new AbortController().signal,
      );
      const preview = recordAt(result, "preview");
      if (preview) setPreviews((current) => ({ ...current, [triggerId]: preview }));
    } catch (caught) {
      setError(safeMutationError(caught, "The next occurrences could not be previewed."));
    } finally {
      setMutationId(undefined);
    }
  }

  async function toggleHistory(triggerId: string) {
    if (historyId === triggerId) {
      setHistoryId(undefined);
      return;
    }
    setHistoryId(triggerId);
    await loadHistory(triggerId);
  }

  async function loadHistory(triggerId: string) {
    setHistoryLoads((current) => ({
      ...current,
      [triggerId]: { status: "loading" },
    }));
    try {
      const data = await readAutomationResource(
        `/api/triggers/${encodeURIComponent(triggerId)}`,
        new AbortController().signal,
      );
      setHistoryLoads((current) => ({
        ...current,
        [triggerId]: { status: "ready", data },
      }));
    } catch (caught) {
      setHistoryLoads((current) => ({
        ...current,
        [triggerId]: {
          status: "error",
          error: safeMutationError(caught, "Schedule history could not be loaded."),
        },
      }));
    }
  }

  return (
    <div>
      <PanelHeading
        number="01"
        title="Automations"
        description="A trigger decides when work starts; its workflow defines the reviewed steps, retries, and approvals."
        action={<Link href="/app/workflows">Manage workflows <ExternalLink size={14} aria-hidden="true" /></Link>}
      />
      <section className={styles.scheduleWorkspace}>
        <div className={styles.scheduleIntro}>
          <div>
            <span><CalendarClock size={16} aria-hidden="true" />Reviewed routines</span>
            <h2>Run known procedures on time</h2>
            <p>Schedules replay one immutable saved procedure with its exact Agent, policy, and budget. Read-only routines stay automatic; reviewed reversible changes receive one short-lived PolicyLease per exact action.</p>
          </div>
          <button type="button" onClick={() => {
            setReplacementId(undefined);
            setFormOpen((open) => !open);
          }}>
            {formOpen && !replacementId ? "Close builder" : "New schedule"}
          </button>
        </div>

        {formOpen ? (
          <ScheduleBuilder
            procedures={procedures}
            agents={agents}
            replacementId={replacementId}
            onCancel={() => {
              setFormOpen(false);
              setReplacementId(undefined);
            }}
            onCreated={async (text) => {
              setMessage(text);
              setFormOpen(false);
              setReplacementId(undefined);
              await onRefresh();
            }}
            onError={setError}
          />
        ) : null}

        {message ? <p className={styles.scheduleNotice} role="status"><CheckCircle2 size={15} aria-hidden="true" />{message}</p> : null}
        {error ? <p className={styles.scheduleError} role="alert">{error}</p> : null}

        {ledger.triggers.status === "loading" && !ledger.triggers.data ? <LoadingRows /> : null}
        {ledger.triggers.status === "error" ? <InlineError>{ledger.triggers.error}</InlineError> : null}
        {ledger.triggers.status !== "error" && schedules.length === 0 ? (
          <EmptyState>{procedures.length
            ? "No reviewed routine is scheduled yet. Build one above when you want a read-only procedure to repeat."
            : "Create a saved procedure with exact read-only Tool inputs first; it will then become available here."}</EmptyState>
        ) : null}

        <div className={styles.scheduleGrid}>
          {schedules.map((trigger, index) => {
            const id = recordKey(trigger, index);
            const schedule = recordAt(trigger, "schedule");
            const config = recordAt(schedule, "config");
            const state = recordAt(schedule, "state");
            const procedurePin = recordAt(config, "procedurePin");
            const identityPin = recordAt(config, "agentIdentityPin");
            const latest = occurrences.find((occurrence) =>
              textAt(occurrence, ["triggerId"], "") === id
            );
            const latestReceipt = receipts.find((receipt) =>
              textAt(receipt, ["triggerId"], "") === id
            );
            const preview = previews[id];
            const upcoming = preview && Array.isArray(preview.occurrences)
              ? preview.occurrences.filter((value): value is string => typeof value === "string")
              : [];
            const status = textAt(trigger, ["status"], "unknown");
            const circuit = textAt(state, ["circuitState"], "closed");
            const authorityMode = textAt(
              config,
              ["authorityMode"],
              "read_only",
            );
            const mutationPolicy = recordAt(config, "mutationPolicy");
            return (
              <article className={`${styles.scheduleCard} ${historyId === id ? styles.scheduleCardExpanded : ""}`} key={id}>
                <header>
                  <span className={styles.rowIcon}><CalendarClock size={17} aria-hidden="true" /></span>
                  <div>
                    <small>{textAt(identityPin, ["logicalAgentId"], "Agent")} · {authorityMode === "reviewed_mutation" ? "reviewed changes" : "read-only canary"}</small>
                    <h3>{textAt(trigger, ["name"], "Untitled schedule")}</h3>
                  </div>
                  <span className={styles.badge} data-tone={statusTone(status)}>{status}</span>
                </header>
                <dl>
                  <div><dt>Procedure</dt><dd>{textAt(procedurePin, ["procedureId"], "Unavailable")}</dd></div>
                  <div><dt>Next run</dt><dd>{scheduleDate(textAt(state, ["nextDueAt"], ""), textAt(config, ["timezone"], "UTC"))}</dd></div>
                  <div><dt>Recurrence</dt><dd>{friendlyRrule(textAt(config, ["rrule"], ""))}</dd></div>
                  <div><dt>Circuit</dt><dd data-state={circuit}>{circuit}{numberAt(state, "consecutiveFailureCount") ? ` · ${numberAt(state, "consecutiveFailureCount")} failures` : ""}</dd></div>
                  <div><dt>Review</dt><dd title={textAt(config, ["configSha256"], "")}>{shortDigest(textAt(config, ["configSha256"], ""))}</dd></div>
                  {authorityMode === "reviewed_mutation" ? <div><dt>Change policy</dt><dd title={textAt(mutationPolicy, ["policySha256"], "")}>{shortDigest(textAt(mutationPolicy, ["policySha256"], ""))}</dd></div> : null}
                </dl>
                {latest ? (
                  <div className={styles.scheduleReceipt}>
                    <ReceiptText size={15} aria-hidden="true" />
                    <span>
                      <strong>{textAt(latest, ["status"], "unknown")}</strong>
                      {scheduleDate(textAt(latest, ["scheduledFor"], ""), textAt(config, ["timezone"], "UTC"))}
                      {latestReceipt ? <code title={textAt(latestReceipt, ["receiptSha256"], "")}>receipt {shortDigest(textAt(latestReceipt, ["receiptSha256"], ""))}</code> : null}
                    </span>
                  </div>
                ) : null}
                {upcoming.length ? (
                  <ol className={styles.schedulePreview}>
                    {upcoming.map((value) => <li key={value}>{scheduleDate(value, textAt(config, ["timezone"], "UTC"))}</li>)}
                  </ol>
                ) : null}
                <div className={styles.scheduleActions}>
                  <button type="button" disabled={Boolean(mutationId)} onClick={() => void loadPreview(id)}><Clock3 size={14} aria-hidden="true" />Preview</button>
                  <button type="button" aria-expanded={historyId === id} aria-controls={`schedule-history-${id}`} onClick={() => void toggleHistory(id)}><ReceiptText size={14} aria-hidden="true" />{historyId === id ? "Close history" : "History"}</button>
                  <button type="button" disabled={Boolean(mutationId) || status !== "active" || circuit !== "closed"} onClick={() => void controlSchedule(id, "run_once")}><CirclePlay size={14} aria-hidden="true" />Run once</button>
                  <button type="button" disabled={Boolean(mutationId)} onClick={() => void controlSchedule(id, status === "active" ? "pause" : "resume")}>
                    {status === "active" ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                    {status === "active" ? "Pause" : "Resume"}
                  </button>
                  <button type="button" disabled={Boolean(mutationId)} onClick={() => {
                    setReplacementId(id);
                    setFormOpen(true);
                    window.requestAnimationFrame(() => document.getElementById("schedule-builder")?.scrollIntoView({ behavior: "smooth", block: "start" }));
                  }}>Replace</button>
                </div>
                {historyId === id ? (
                  <ScheduleOutcomeHistory
                    id={`schedule-history-${id}`}
                    load={historyLoads[id] || { status: "loading" }}
                    timezone={textAt(config, ["timezone"], "UTC")}
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <div className={styles.splitInventory}>
        <InventorySection
          title="Webhook triggers"
          note="Authenticated external events that begin a governed workflow."
          resource={ledger.triggers}
          empty="No webhook triggers are configured."
        >
          {webhooks.slice(0, 20).map((trigger, index) => (
            <InventoryRow
              key={recordKey(trigger, index)}
              title={textAt(trigger, ["name"], "Untitled trigger")}
              description={triggerDescription(trigger)}
              meta={[textAt(trigger, ["source"], "external event"), textAt(trigger, ["workflowMode"], "orchestrate")]}
              status={textAt(trigger, ["status"], "unknown")}
              icon={<Activity size={16} aria-hidden="true" />}
            />
          ))}
        </InventorySection>

        <InventorySection
          title="Recent workflow runs"
          note="Live and recent executions created by people, agents, or triggers."
          resource={ledger.workflows}
          empty="No workflow runs are available yet."
        >
          {workflows.slice(0, 20).map((workflow, index) => {
            const input = recordAt(workflow, "input");
            return (
              <InventoryRow
                key={recordKey(workflow, index)}
                title={textAt(input, ["goal"], textAt(workflow, ["name"], "Workflow run"))}
                description={timeDescription(workflow)}
                meta={[textAt(workflow, ["mode"], textAt(input, ["mode"], "workflow"))]}
                status={textAt(workflow, ["canonicalStatus", "status"], "unknown")}
                icon={<Workflow size={16} aria-hidden="true" />}
              />
            );
          })}
        </InventorySection>
      </div>
    </div>
  );
}

export function ScheduleOutcomeHistory({
  id,
  load,
  timezone = "UTC",
}: {
  id: string;
  load: ResourceLoad;
  timezone?: string;
}) {
  if (load.status === "loading") {
    return <section id={id} className={styles.scheduleHistory} aria-label="Schedule outcome history" aria-busy="true"><Loader2 size={16} className={styles.spin} /><p>Loading exact occurrence and PolicyLease receipts…</p></section>;
  }
  if (load.status === "error" || !load.data) {
    return <section id={id} className={styles.scheduleHistory} aria-label="Schedule outcome history"><p role="alert">{load.error || "Schedule history is unavailable."}</p></section>;
  }
  const occurrences = recordsAt(load.data, "occurrences");
  const receipts = recordsAt(load.data, "receipts");
  const policyLeaseProjection = recordAt(load.data, "policyLeases");
  const leases = recordsAt(policyLeaseProjection, "outcomes");
  const leaseAvailable = policyLeaseProjection?.available !== false;
  if (!occurrences.length && !receipts.length && !leases.length && leaseAvailable) {
    return (
      <section id={id} className={styles.scheduleHistory} aria-label="Schedule outcome history">
        <p>No runs or PolicyLease decisions have been recorded for this schedule.</p>
      </section>
    );
  }
  return (
    <section id={id} className={styles.scheduleHistory} aria-label="Schedule outcome history">
      <header>
        <div><strong>Outcome history</strong><span>Content-free receipts</span></div>
        <small>{occurrences.length} run{occurrences.length === 1 ? "" : "s"} · {leases.length} lease{leases.length === 1 ? "" : "s"}</small>
      </header>
      <div className={styles.outcomeList}>
        {occurrences.slice(0, 8).map((occurrence, index) => {
          const occurrenceId = textAt(occurrence, ["id"], `occurrence-${index}`);
          const receipt = receipts.find((candidate) =>
            textAt(candidate, ["occurrenceId"], "") === occurrenceId
          );
          const failure = textAt(occurrence, ["failureCode"], "");
          const status = textAt(occurrence, ["status"], "unknown");
          return (
            <article key={occurrenceId} className={styles.outcomeItem}>
              <div className={styles.outcomeTitle}>
                <span className={styles.badge} data-tone={statusTone(status)}>{plainStatus(status)}</span>
                <time>{scheduleDate(textAt(occurrence, ["scheduledFor"], ""), timezone)}</time>
              </div>
              {failure ? <p><strong>Why it stopped:</strong> {plainFailure(failure)}</p> : <p>{occurrenceOutcomeCopy(status)}</p>}
              <dl>
                <div><dt>Authority binding</dt><dd>{textAt(occurrence, ["authoritySha256"], "Unavailable")}</dd></div>
                {receipt ? <div><dt>State receipt</dt><dd>{textAt(receipt, ["stateSha256"], "Unavailable")}</dd></div> : null}
                {receipt ? <div><dt>Outcome receipt</dt><dd>{textAt(receipt, ["receiptSha256"], "Unavailable")}</dd></div> : null}
              </dl>
            </article>
          );
        })}
      </div>
      <div className={styles.leaseHistory}>
        <h4>PolicyLease actions <span>{leaseAvailable ? "Available" : "Temporarily unavailable"}</span></h4>
        {leases.length ? leases.slice(0, 12).map((lease, index) => {
          const status = textAt(lease, ["status"], "issued");
          return (
            <article key={textAt(lease, ["leaseId"], `lease-${index}`)}>
              <div><strong>{policyLeaseLabel(status)}</strong><time>{scheduleDate(textAt(lease, [status === "consumed" ? "consumedAt" : status === "expired" ? "expiresAt" : "issuedAt"], ""), timezone)}</time></div>
              <p>{policyLeaseCopy(status)}</p>
              <dl>
                <div><dt>Exact action</dt><dd>{textAt(lease, ["toolId"], "Unavailable")}</dd></div>
                <div><dt>Binding digest</dt><dd>{textAt(lease, ["bindingSha256"], "Unavailable")}</dd></div>
                <div><dt>Tool contract</dt><dd>{textAt(lease, ["toolContractSha256"], "Unavailable")}</dd></div>
                {status === "consumed" ? <div><dt>Consumption receipt</dt><dd>{textAt(lease, ["consumptionReceiptSha256"], "Unavailable")}</dd></div> : null}
              </dl>
            </article>
          );
        }) : <p>{leaseAvailable ? "No change action has required a PolicyLease yet." : "The schedule remains visible, but its PolicyLease history could not be read."}</p>}
      </div>
    </section>
  );
}

function ScheduleBuilder({
  procedures,
  agents,
  replacementId,
  onCancel,
  onCreated,
  onError,
}: {
  procedures: JsonRecord[];
  agents: JsonRecord[];
  replacementId?: string;
  onCancel: () => void;
  onCreated: (message: string) => Promise<void>;
  onError: (message: string | undefined) => void;
}) {
  const [name, setName] = useState("");
  const [procedureId, setProcedureId] = useState(
    textAt(procedures[0], ["id"], ""),
  );
  const [agentId, setAgentId] = useState(textAt(agents[0], ["id"], "atlas"));
  const [timezone, setTimezone] = useState(() =>
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const [startsAt, setStartsAt] = useState(defaultScheduleStart());
  const [frequency, setFrequency] = useState("daily");
  const [maxOccurrences, setMaxOccurrences] = useState(365);
  const [missedPolicy, setMissedPolicy] = useState("skip");
  const [mutationAcknowledged, setMutationAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const selectedProcedureId = procedureId || textAt(procedures[0], ["id"], "");
  const selectedProcedure = procedures.find((procedure) =>
    textAt(procedure, ["id"], "") === selectedProcedureId
  );
  const authorityMode = textAt(
    selectedProcedure,
    ["authorityMode"],
    "read_only",
  );
  const mutationBindings = recordsAt(selectedProcedure, "mutationBindings");
  const mutationReviewDigest = textAt(selectedProcedure, ["reviewDigest"], "");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onError(undefined);
    setSubmitting(true);
    try {
      if (!selectedProcedureId) {
        throw new Error("Choose a schedulable saved procedure first.");
      }
      if (authorityMode === "reviewed_mutation" && !mutationAcknowledged) {
        throw new Error(
          "Review the exact change targets and acknowledge the warning first.",
        );
      }
      const localStart = new Date(startsAt);
      if (!Number.isFinite(localStart.getTime())) {
        throw new Error("Choose a valid start date and time.");
      }
      const hour = Number(startsAt.slice(11, 13));
      const minute = Number(startsAt.slice(14, 16));
      const byDay = frequency === "weekdays"
        ? ";BYDAY=MO,TU,WE,TH,FR"
        : frequency === "weekly"
          ? `;BYDAY=${weekdayCodeForDate(localStart)}`
          : "";
      const interval = frequency === "weekly" ? 1 : 1;
      const freq = frequency === "weekly" ? "WEEKLY" : "DAILY";
      await mutateAutomation("/api/triggers", {
        triggerKind: "schedule",
        name,
        procedureId: selectedProcedureId,
        agentId,
        timezone,
        rrule: `FREQ=${freq};INTERVAL=${interval}${byDay};BYHOUR=${hour};BYMINUTE=${minute}`,
        startsAt: localStart.toISOString(),
        maxOccurrences,
        missedPolicy,
        failureLimit: 3,
        authorityMode,
        ...(authorityMode === "reviewed_mutation"
          ? {
              reviewedMutationBindingsSha256: mutationReviewDigest,
              mutationAcknowledged: true,
            }
          : {}),
        ...(replacementId ? { replacesTriggerId: replacementId } : {}),
      }, replacementId ? "workflow-schedule-replace" : "workflow-schedule-create");
      await onCreated(replacementId
        ? "The replacement schedule is active and the previous version is paused."
        : authorityMode === "reviewed_mutation"
          ? "The reviewed change schedule is active. Each exact action will use one PolicyLease."
          : "The reviewed read-only schedule is active.");
    } catch (caught) {
      onError(safeMutationError(caught, "The schedule could not be created."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form id="schedule-builder" className={styles.scheduleBuilder} onSubmit={submit}>
      <header>
        <div>
          <small>{replacementId ? "Immutable replacement" : "New reviewed routine"}</small>
          <h3>{replacementId ? "Replace this schedule" : "Schedule a saved procedure"}</h3>
          <p>Asael will bind the exact procedure snapshot, Agent release, policy, and per-occurrence budget. Later edits create a new version instead of changing history.</p>
        </div>
        <span><ShieldCheck size={15} aria-hidden="true" />{authorityMode === "reviewed_mutation" ? "PolicyLease changes" : "Read-only"}</span>
      </header>
      <div className={styles.scheduleFields}>
        <label>
          <span>Routine name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} placeholder="Morning research review" />
        </label>
        <label>
          <span>Saved procedure</span>
          <select value={selectedProcedureId} onChange={(event) => {
            setProcedureId(event.target.value);
            setMutationAcknowledged(false);
          }} required disabled={!procedures.length}>
            {!procedures.length ? <option value="">No read-only procedures available</option> : null}
            {procedures.map((procedure, index) => (
              <option key={recordKey(procedure, index)} value={textAt(procedure, ["id"], "")}>
                {textAt(procedure, ["id"], "Untitled procedure")}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Agent</span>
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
            {agents.map((agent, index) => (
              <option key={recordKey(agent, index)} value={textAt(agent, ["id"], "atlas")}>
                {textAt(agent, ["name"], "Agent")} · {textAt(agent, ["role"], "specialist")}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Starts</span>
          <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required />
        </label>
        <label>
          <span>Repeats</span>
          <select value={frequency} onChange={(event) => setFrequency(event.target.value)}>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Every week</option>
          </select>
        </label>
        <label>
          <span>Timezone</span>
          <input value={timezone} onChange={(event) => setTimezone(event.target.value)} required maxLength={120} />
        </label>
        <label>
          <span>Maximum runs</span>
          <input type="number" min={1} max={10_000} value={maxOccurrences} onChange={(event) => setMaxOccurrences(Number(event.target.value))} required />
        </label>
        <label>
          <span>If Asael was offline</span>
          <select value={missedPolicy} onChange={(event) => setMissedPolicy(event.target.value)}>
            <option value="skip">Skip missed runs</option>
            <option value="run_once">Run the latest once</option>
          </select>
        </label>
      </div>
      {authorityMode === "reviewed_mutation" ? (
        <div className={styles.scheduleBoundary} role="note">
          <ShieldCheck size={15} aria-hidden="true" />
          <span>
            This routine can change external state. Only the exact reversible risk-1/2 actions below are eligible; dynamic inputs, destructive actions, Computer Use, and changed targets return to ordinary approval.
            {mutationBindings.map((binding, index) => (
              <code key={recordKey(binding, index)} title={textAt(binding, ["targetSha256"], "")}>
                {textAt(binding, ["toolId"], "Tool")} · risk {numberAt(binding, "riskLevel")} · target {shortDigest(textAt(binding, ["targetSha256"], ""))}
              </code>
            ))}
            <label>
              <input type="checkbox" checked={mutationAcknowledged} onChange={(event) => setMutationAcknowledged(event.target.checked)} />
              I reviewed these exact change targets and maximum of {maxOccurrences} occurrences.
            </label>
          </span>
        </div>
      ) : (
        <p className={styles.scheduleBoundary}><ShieldCheck size={15} aria-hidden="true" />Only reviewed risk-0 read operations are admitted. Identity drift, changed procedure inputs, policy changes, or three consecutive failures pause the routine automatically.</p>
      )}
      <div className={styles.scheduleBuilderActions}>
        <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="submit" disabled={submitting || !procedures.length || (authorityMode === "reviewed_mutation" && !mutationAcknowledged)}>{submitting ? "Reviewing…" : replacementId ? "Create replacement" : authorityMode === "reviewed_mutation" ? "Approve exact changes & schedule" : "Review & schedule"}</button>
      </div>
    </form>
  );
}

function SkillsPanel({ ledger }: { ledger: ResourceLedger }) {
  const skills = recordsAt(ledger.skills.data, "skills");
  return (
    <div>
      <PanelHeading
        number="01"
        title="Skills"
        description="Reusable playbooks teach agents how to work. They can reference governed Tools, but never grant new access."
        action={<Link href="/app/agents">Manage in Arsenal <ExternalLink size={14} aria-hidden="true" /></Link>}
      />
      <InventorySection
        title="Skill catalog"
        note="Built-in Skills are maintained by Asael; personal Skills remain owner-scoped and editable."
        resource={ledger.skills}
        empty="No Skills are available for this workspace."
        wide
      >
        {skills.map((skill, index) => {
          const toolCount = stringListAt(skill, "toolIds").length;
          const knowledgeCount = stringListAt(skill, "knowledgeTags").length;
          return (
            <InventoryRow
              key={recordKey(skill, index)}
              title={textAt(skill, ["name"], "Untitled skill")}
              description={textAt(skill, ["description"], "No description has been provided.")}
              meta={[
                textAt(skill, ["category"], "uncategorized"),
                skill.builtIn === true ? "built in" : "personal",
                `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`,
                `${knowledgeCount} knowledge ${knowledgeCount === 1 ? "tag" : "tags"}`,
              ]}
              status={textAt(skill, ["status"], "unknown")}
              icon={<BookOpen size={16} aria-hidden="true" />}
            />
          );
        })}
      </InventorySection>
    </div>
  );
}

function ConnectionsPanel({ ledger }: { ledger: ResourceLedger }) {
  const connections = recordsAt(
    integrationsOverviewAt(ledger.connections.data),
    "installed",
  ).filter(
    (item) => textAt(item, ["kind"], "") !== "mcp",
  );
  const connectors = recordsAt(ledger.mcp.data, "connectors");
  return (
    <div>
      <PanelHeading
        number="01"
        title="Connections & MCP"
        description="Connections authorize accounts and APIs. MCP servers expose live tools and resources that Asael discovers and reviews."
        action={<Link href="/app/connectors">Manage connections <ExternalLink size={14} aria-hidden="true" /></Link>}
      />
      <div className={styles.splitInventory}>
        <InventorySection
          title="Account and API connections"
          note="Only installed records appear here; catalog suggestions do not count as connected."
          resource={ledger.connections}
          empty="No account or API connections are installed."
        >
          {connections.map((connection, index) => {
            const permissions = recordAt(connection, "permissions");
            const sync = recordAt(connection, "sync");
            return (
              <InventoryRow
                key={recordKey(connection, index)}
                title={textAt(connection, ["name"], "Unnamed connection")}
                description={textAt(connection, ["nextAction"], "No next action reported.")}
                meta={[
                  textAt(connection, ["adapter"], "native"),
                  textAt(permissions, ["mode"], "access unknown").replaceAll("_", " "),
                  `sync ${textAt(sync, ["status"], "unknown").replaceAll("_", " ")}`,
                ]}
                status={textAt(connection, ["state"], "unknown")}
                icon={<Cable size={16} aria-hidden="true" />}
              />
            );
          })}
        </InventorySection>

        <InventorySection
          title="MCP servers"
          note="Server credentials create access; each discovered Tool keeps its own risk and approval contract."
          resource={ledger.mcp}
          empty="No MCP servers have been added."
        >
          {connectors.map((connector, index) => (
            <InventoryRow
              key={recordKey(connector, index)}
              title={textAt(connector, ["name"], "Unnamed MCP server")}
              description={mcpDescription(connector)}
              meta={[
                `${numberAt(connector, "toolCount")} tools`,
                textAt(connector, ["authType"], "auth unknown").replaceAll("_", " "),
                numberAt(connector, "defaultRiskLevel") > 1 ? "approval gated" : "lower risk",
              ]}
              status={textAt(connector, ["status"], "unknown")}
              icon={<Plug size={16} aria-hidden="true" />}
            />
          ))}
        </InventorySection>
      </div>
      <section className={styles.exportedMcp}>
        <span className={styles.rowIcon}><Plug size={16} aria-hidden="true" /></span>
        <div>
          <small>Opposite direction</small>
          <h2>Connect Codex or Claude to Asael</h2>
          <p>Asael can expose a governed, currently read-only MCP surface to an agent client. Configure its service key and maximum scopes in API &amp; MCP settings.</p>
        </div>
        <Link href="/app/settings">Open API &amp; MCP settings <ArrowRight size={14} aria-hidden="true" /></Link>
      </section>
    </div>
  );
}

type PluginDialog =
  | { kind: "install"; source: "catalog" | "import"; plugin: JsonRecord; preview: JsonRecord; manifest: JsonRecord }
  | { kind: "uninstall"; plugin: JsonRecord };

function PluginsPanel({
  ledger,
  onRefresh,
}: {
  ledger: ResourceLedger;
  onRefresh: () => Promise<void>;
}) {
  const unifiedPlugins = recordsAt(ledger.plugins.data, "plugins");
  const catalog = (unifiedPlugins.length
    ? unifiedPlugins
    : recordsAt(ledger.plugins.data, "catalog")
  ).filter((plugin) => plugin.installed !== true);
  const installations = unifiedPlugins.length
    ? unifiedPlugins.filter((plugin) => plugin.installed === true)
    : recordsAt(ledger.plugins.data, "installations").filter(
        (plugin) => textAt(plugin, ["state"], "uninstalled") !== "uninstalled",
      );
  const [dialog, setDialog] = useState<PluginDialog>();
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [importDraft, setImportDraft] = useState("");
  const [importError, setImportError] = useState<string>();
  const importBytes = useMemo(
    () => pluginManifestByteLength(importDraft),
    [importDraft],
  );

  useEffect(() => {
    if (!dialog) return;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setDialog(undefined);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = priorOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [dialog]);

  async function reviewPlugin(plugin: JsonRecord) {
    const pluginId = textAt(plugin, ["pluginId"], "");
    const version = textAt(plugin, ["version"], "");
    const manifestSha256 = textAt(plugin, ["manifestSha256"], "");
    if (!pluginId || !version || !/^[a-f0-9]{64}$/.test(manifestSha256)) {
      setError("This catalog record does not contain an exact reviewable manifest identity.");
      return;
    }
    setBusyId(`review:${pluginId}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await mutatePlugin("/api/plugins/preview", "POST", {
        pluginId,
        version,
        manifestSha256,
      }, "plugin-preview");
      const preview = recordAt(result, "preview");
      const manifest = recordAt(result, "manifest");
      if (!preview || !manifest) throw new Error("The server did not return an immutable Plugin review.");
      setDialog({ kind: "install", source: "catalog", plugin, preview, manifest });
    } catch (reviewError) {
      setError(safeMutationError(reviewError, "Plugin review could not be prepared."));
    } finally {
      setBusyId(undefined);
    }
  }

  async function reviewImportedManifest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let previewRequest: { manifest: JsonRecord };
    try {
      previewRequest = importedPluginPreviewPayload(importDraft);
    } catch (parseError) {
      setImportError(safeMutationError(parseError, "The Plugin manifest could not be parsed."));
      return;
    }

    setBusyId("review:import");
    setError(undefined);
    setImportError(undefined);
    setNotice(undefined);
    try {
      const result = await mutatePlugin(
        "/api/plugins/preview",
        "POST",
        previewRequest,
        "plugin-import-preview",
      );
      const preview = recordAt(result, "preview");
      const reviewedManifest = recordAt(result, "manifest");
      if (!preview || !reviewedManifest) {
        throw new Error("The server did not return an immutable Plugin review.");
      }
      setDialog({
        kind: "install",
        source: "import",
        plugin: reviewedManifest,
        preview,
        manifest: reviewedManifest,
      });
    } catch (reviewError) {
      setImportError(safeMutationError(reviewError, "Imported Plugin review could not be prepared."));
    } finally {
      setBusyId(undefined);
    }
  }

  async function installReviewedPlugin(review: Extract<PluginDialog, { kind: "install" }>) {
    const previewId = textAt(review.preview, ["previewId"], "");
    const manifestSha256 = textAt(review.preview, ["manifestSha256"], "");
    if (!previewId || !/^[a-f0-9]{64}$/.test(manifestSha256)) {
      setError("The immutable Plugin review is incomplete. Prepare it again.");
      setDialog(undefined);
      return;
    }
    setBusyId(`install:${previewId}`);
    setError(undefined);
    try {
      const result = await mutatePlugin("/api/plugins/install", "POST", {
        previewId,
        manifestSha256,
      }, "plugin-install");
      const activation = recordAt(result, "activation");
      setDialog(undefined);
      if (review.source === "import") setImportDraft("");
      setNotice(textAt(
        activation,
        ["explanation"],
        `${pluginTitle(review.plugin)} was installed. MCP credentials and contracts still require separate setup and review.`,
      ));
      await onRefresh();
    } catch (installError) {
      setError(safeMutationError(installError, "Plugin installation failed."));
    } finally {
      setBusyId(undefined);
    }
  }

  async function transitionPlugin(plugin: JsonRecord, action: "enable" | "disable" | "uninstall") {
    const installationId = textAt(plugin, ["installationId"], "");
    const expectedRevision = numberAt(plugin, "revision");
    if (!installationId || expectedRevision < 1) {
      setError("The installed Plugin does not include a current lifecycle revision. Refresh and try again.");
      return;
    }
    setBusyId(`${action}:${installationId}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await mutatePlugin(
        `/api/plugins/${encodeURIComponent(installationId)}`,
        action === "uninstall" ? "DELETE" : "PATCH",
        action === "uninstall" ? { expectedRevision } : { action, expectedRevision },
        `plugin-${action}`,
      );
      const activation = recordAt(result, "activation");
      setDialog(undefined);
      setNotice(
        action === "uninstall"
          ? `${pluginTitle(plugin)} was uninstalled from this workspace.`
          : textAt(activation, ["explanation"], `${pluginTitle(plugin)} is now ${action === "enable" ? "enabled" : "disabled"}.`),
      );
      await onRefresh();
    } catch (transitionError) {
      setError(safeMutationError(transitionError, `Plugin ${action} failed.`));
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <div>
      <PanelHeading
        number="01"
        title="Plugins"
        description="A Plugin is a reviewed, declarative bundle. It can package Skills, MCP setup templates, and an automation template—but not arbitrary code or secrets."
      />
      <div className={styles.pluginBoundary}>
        <ShieldCheck size={20} aria-hidden="true" />
        <div>
          <strong>Installation is a review, not an authority shortcut.</strong>
          <p>Asael must show the exact manifest and requested capabilities before installation. Connections and Tools keep their existing approval boundaries.</p>
        </div>
      </div>
      {error ? <InlineError>{error}</InlineError> : null}
      {notice ? <div className={styles.inlineNotice} role="status"><CheckCircle2 size={16} aria-hidden="true" /><span>{notice}</span></div> : null}
      <div className={styles.splitInventory}>
        <InventorySection
          title="Installed"
          note="Bundles currently retained for this workspace."
          resource={ledger.plugins}
          empty="No Plugins are installed."
        >
          {installations.map((plugin, index) => (
            <InventoryRow
              key={recordKey(plugin, index)}
              title={pluginTitle(plugin)}
              description={pluginActivationDescription(plugin)}
              meta={[
                ...pluginMeta(plugin),
                ...(plugin.updateRequiresUninstall === true ? ["update requires uninstall"] : []),
              ]}
              status={textAt(plugin, ["status", "state"], "installed")}
              icon={<Box size={16} aria-hidden="true" />}
              action={
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    onClick={() => void transitionPlugin(
                      plugin,
                      textAt(plugin, ["status", "state"], "disabled") === "enabled" ? "disable" : "enable",
                    )}
                    disabled={Boolean(busyId)}
                  >
                    {textAt(plugin, ["status", "state"], "disabled") === "enabled" ? "Disable" : "Enable"}
                  </button>
                  <button type="button" onClick={() => setDialog({ kind: "uninstall", plugin })} disabled={Boolean(busyId)}>
                    Uninstall
                  </button>
                </div>
              }
            />
          ))}
        </InventorySection>

        <InventorySection
          title="Available to review"
          note="Catalog entries are not installed and grant no access."
          resource={ledger.plugins}
          empty="No reviewed Plugin catalog entries are available."
        >
          {catalog.map((plugin, index) => (
            <InventoryRow
              key={recordKey(plugin, index)}
              title={pluginTitle(plugin)}
              description={textAt(plugin, ["description", "summary"], "No catalog description provided.")}
              meta={pluginMeta(plugin)}
              status="available"
              icon={<Box size={16} aria-hidden="true" />}
              action={
                <button
                  type="button"
                  className={styles.rowAction}
                  onClick={() => void reviewPlugin(plugin)}
                  disabled={Boolean(busyId)}
                >
                  {busyId === `review:${textAt(plugin, ["pluginId"], "")}` ? "Preparing…" : "Review"}
                </button>
              }
            />
          ))}
        </InventorySection>
      </div>
      <details className={styles.importDisclosure}>
        <summary>
          <span><Box size={16} aria-hidden="true" /></span>
          <div>
            <strong>Import declarative manifest</strong>
            <small>Advanced · review a personal Asael Plugin from pasted JSON</small>
          </div>
          <span className={styles.disclosureAction}>Show / hide</span>
        </summary>
        <form onSubmit={(event) => void reviewImportedManifest(event)}>
          <div className={styles.importHeading}>
            <div>
              <h2>Personal Plugin manifest</h2>
              <p>Paste schema v1 JSON only. Executable code and embedded credentials or secrets are rejected; MCP access is connected separately after installation.</p>
            </div>
            <span data-over-limit={importBytes > MAX_PLUGIN_MANIFEST_BYTES}>
              {importBytes.toLocaleString()} / {MAX_PLUGIN_MANIFEST_BYTES.toLocaleString()} bytes
            </span>
          </div>
          <label htmlFor="automation-plugin-manifest">Manifest JSON</label>
          <textarea
            id="automation-plugin-manifest"
            value={importDraft}
            onChange={(event) => {
              setImportDraft(event.target.value);
              if (importError) setImportError(undefined);
            }}
            maxLength={MAX_PLUGIN_MANIFEST_BYTES}
            rows={12}
            spellCheck={false}
            aria-describedby="automation-plugin-manifest-help automation-plugin-manifest-error"
            placeholder={'{\n  "schemaVersion": 1,\n  "pluginId": "personal.example",\n  "version": "1.0.0"\n}'}
          />
          <p id="automation-plugin-manifest-help" className={styles.importHelp}>JSON is parsed locally first, then the server validates its exact schema and returns immutable effects and limitations for review. Pasting does not install anything.</p>
          {importError ? <p id="automation-plugin-manifest-error" className={styles.importError} role="alert">{importError}</p> : <span id="automation-plugin-manifest-error" />}
          <div className={styles.importActions}>
            <button type="button" onClick={() => { setImportDraft(""); setImportError(undefined); }} disabled={!importDraft || Boolean(busyId)}>Clear</button>
            <button type="submit" disabled={!importDraft.trim() || importBytes > MAX_PLUGIN_MANIFEST_BYTES || Boolean(busyId)}>
              {busyId === "review:import" ? "Preparing review…" : "Prepare immutable review"}
            </button>
          </div>
        </form>
      </details>
      {dialog ? (
        <PluginDialogSurface
          dialog={dialog}
          busy={Boolean(busyId)}
          onClose={() => setDialog(undefined)}
          onInstall={() => dialog.kind === "install" ? void installReviewedPlugin(dialog) : undefined}
          onUninstall={() => dialog.kind === "uninstall" ? void transitionPlugin(dialog.plugin, "uninstall") : undefined}
        />
      ) : null}
    </div>
  );
}

function PluginDialogSurface({
  dialog,
  busy,
  onClose,
  onInstall,
  onUninstall,
}: {
  dialog: PluginDialog;
  busy: boolean;
  onClose: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  if (dialog.kind === "uninstall") {
    return (
      <div className={styles.dialogLayer}>
        <button type="button" className={styles.dialogDismiss} aria-label="Close Plugin confirmation" onClick={onClose} disabled={busy} />
        <section className={styles.dialog} role="alertdialog" aria-modal="true" aria-labelledby="plugin-uninstall-title">
          <span className={styles.dialogEyebrow}>Confirm removal</span>
          <h2 id="plugin-uninstall-title">Uninstall {pluginTitle(dialog.plugin)}?</h2>
          <p>The Plugin bundle will leave this workspace. Any account credentials or external connections configured separately are not revoked by this action.</p>
          <div className={styles.dialogActions}>
            <button type="button" onClick={onClose} disabled={busy} autoFocus>Cancel</button>
            <button type="button" className={styles.dangerAction} onClick={onUninstall} disabled={busy}>{busy ? "Uninstalling…" : "Uninstall Plugin"}</button>
          </div>
        </section>
      </div>
    );
  }

  const preview = dialog.preview;
  const counts = recordAt(preview, "componentCounts");
  const publisher = recordAt(dialog.manifest, "publisher");
  const effects = stringListAt(preview, "effects");
  const limitations = stringListAt(preview, "limitations");
  return (
    <div className={styles.dialogLayer}>
      <button type="button" className={styles.dialogDismiss} aria-label="Close Plugin review" onClick={onClose} disabled={busy} />
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="plugin-review-title">
        <span className={styles.dialogEyebrow}>Immutable installation review</span>
        <h2 id="plugin-review-title">Review {textAt(preview, ["name"], pluginTitle(dialog.plugin))}</h2>
        <p>Published by {textAt(preview, ["publisherName"], textAt(publisher, ["name"], "Unknown publisher"))}. Confirm the exact declared effects and limitations before installing.</p>
        <div className={styles.reviewCounts}>
          <div><strong>{numberAt(counts, "skills")}</strong><span>Skills</span></div>
          <div><strong>{numberAt(counts, "mcpTemplates")}</strong><span>MCP templates</span></div>
          <div><strong>{numberAt(counts, "workflowTemplates")}</strong><span>Automations</span></div>
        </div>
        <div className={styles.reviewColumns}>
          <div><h3>What installation does</h3><ul>{effects.map((effect) => <li key={effect}>{effect}</li>)}</ul></div>
          <div><h3>What it does not do</h3><ul>{limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div>
        </div>
        <dl className={styles.reviewDigest}>
          <div><dt>Manifest SHA-256</dt><dd><code>{textAt(preview, ["manifestSha256"], "Unavailable")}</code></dd></div>
          <div><dt>Review expires</dt><dd>{formatDateTime(textAt(preview, ["expiresAt"], ""))}</dd></div>
        </dl>
        <div className={styles.dialogActions}>
          <button type="button" onClick={onClose} disabled={busy} autoFocus>Cancel</button>
          <button type="button" className={styles.installAction} onClick={onInstall} disabled={busy}>{busy ? "Installing…" : "Install reviewed Plugin"}</button>
        </div>
      </section>
    </div>
  );
}

function AdvancedPanel({
  snapshot,
  ledger,
}: {
  snapshot: AutomationSnapshot;
  ledger: ResourceLedger;
}) {
  const risks = summarizeRisk(snapshot.tools);
  const tools = recordsAt(snapshot.tools, "tools");
  const policy = recordAt(snapshot.tools, "policy");
  return (
    <div>
      <PanelHeading
        number="01"
        title="Capability audit"
        description="Inspect inventory boundaries and verify that access, instructions, and execution policy remain independently observable."
        action={<Link href="/app/tools">Open Tool ledger <ExternalLink size={14} aria-hidden="true" /></Link>}
      />
      <div className={styles.auditGrid}>
        <section className={styles.auditSources}>
          <div className={styles.sectionHeading}><div><span className={styles.sectionNumber}>02</span><h2>Source integrity</h2></div></div>
          <div className={styles.healthList}>
            {automationResourceDefinitions.map((source) => (
              <ResourceHealthRow key={source.key} label={source.label} resource={ledger[source.key]} technical />
            ))}
          </div>
        </section>
        <section className={styles.riskSection}>
          <div className={styles.sectionHeading}><div><span className={styles.sectionNumber}>03</span><h2>Tool risk distribution</h2></div></div>
          {ledger.tools.status === "error" ? <InlineError>{ledger.tools.error}</InlineError> : null}
          {ledger.tools.status === "loading" && !ledger.tools.data ? <LoadingRows /> : null}
          {ledger.tools.status === "ready" ? (
            <div className={styles.riskList}>
              {risks.map(({ level, count }) => (
                <div key={level}>
                  <span className={styles.riskLevel}>Risk {level}</span>
                  <span className={styles.riskTrack}><i style={{ width: `${tools.length ? Math.max((count / tools.length) * 100, count ? 4 : 0) : 0}%` }} /></span>
                  <strong>{count}</strong>
                  <small>{riskMeaning(level)}</small>
                </div>
              ))}
              <p className={styles.policyNote}><ShieldCheck size={15} aria-hidden="true" />{textAt(policy, ["defaultBehavior"], "Unknown and unreviewed Tools remain blocked.")}</p>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function PanelHeading({
  number,
  title,
  description,
  action,
}: {
  number: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className={styles.panelHeading}>
      <div><span className={styles.sectionNumber}>{number}</span><h2>{title}</h2><p>{description}</p></div>
      {action ? <div className={styles.panelAction}>{action}</div> : null}
    </header>
  );
}

function InventorySection({
  title,
  note,
  resource,
  empty,
  children,
  wide = false,
}: {
  title: string;
  note: string;
  resource: ResourceLoad;
  empty: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className={wide ? styles.inventoryWide : styles.inventory}>
      <header><div><h2>{title}</h2><p>{note}</p></div><ResourceState state={resource.status} /></header>
      {resource.status === "loading" && !resource.data ? <LoadingRows /> : null}
      {resource.status === "error" ? <InlineError>{resource.error}</InlineError> : null}
      {resource.status === "ready" && !hasChildren ? <EmptyState>{empty}</EmptyState> : null}
      {resource.status === "ready" && hasChildren ? <div className={styles.inventoryRows}>{children}</div> : null}
    </section>
  );
}

function InventoryRow({
  title,
  description,
  meta,
  status,
  icon,
  action,
}: {
  title: string;
  description: string;
  meta: string[];
  status: string;
  icon: ReactNode;
  action?: ReactNode;
}) {
  return (
    <article className={styles.inventoryRow}>
      <span className={styles.rowIcon}>{icon}</span>
      <div className={styles.rowCopy}>
        <div className={styles.rowTitle}><h3>{title}</h3><StatusBadge status={status} /></div>
        <p>{description}</p>
        <div className={styles.rowMeta}>{meta.filter(Boolean).map((item) => <span key={item}>{item}</span>)}</div>
        {action ? <div className={styles.inventoryAction}>{action}</div> : null}
      </div>
    </article>
  );
}

function ResourceHealthRow({
  label,
  resource,
  technical = false,
}: {
  label: string;
  resource: ResourceLoad;
  technical?: boolean;
}) {
  return (
    <div className={styles.healthRow}>
      <span className={resource.status === "ready" ? styles.healthReady : resource.status === "loading" ? styles.healthLoading : styles.healthError}>
        {resource.status === "ready" ? <CheckCircle2 size={15} /> : resource.status === "loading" ? <Clock3 size={15} /> : <Activity size={15} />}
      </span>
      <div><strong>{label}</strong><small>{resource.status === "ready" ? (technical ? "Authenticated owner-scoped read succeeded" : "Inventory available") : resource.status === "loading" ? "Reading live inventory" : resource.error || "Inventory unavailable"}</small></div>
      <ResourceState state={resource.status} />
    </div>
  );
}

function ResourceState({ state }: { state: ResourceLoad["status"] }) {
  return <span className={styles.resourceState} data-state={state}>{state === "ready" ? "Available" : state === "loading" ? "Checking" : "Unavailable"}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase().replaceAll(" ", "_");
  return <span className={styles.badge} data-tone={statusTone(normalized)}>{status.replaceAll("_", " ")}</span>;
}

function InlineError({ children }: { children: ReactNode }) {
  return <div className={styles.inlineError} role="status"><Activity size={16} aria-hidden="true" /><span>{children}</span></div>;
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className={styles.empty}><span>—</span><p>{children}</p></div>;
}

function LoadingRows() {
  return <div className={styles.loadingRows} aria-label="Loading inventory"><span /><span /><span /></div>;
}

async function readAutomationResource(endpoint: string, signal: AbortSignal): Promise<JsonRecord> {
  const response = await fetch(endpoint, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const message = textAt(body, ["error", "message"], `Request failed with status ${response.status}.`);
    throw new Error(message);
  }
  if (!isJsonRecord(body)) throw new Error("The service returned an unreadable inventory.");
  return body;
}

async function mutateAutomation(
  endpoint: string,
  body: JsonRecord,
  purpose: string,
): Promise<JsonRecord> {
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "Idempotency-Key": `${purpose}:${window.crypto.randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    result = undefined;
  }
  if (!response.ok) {
    throw new Error(textAt(
      result,
      ["error", "message"],
      `Request failed with status ${response.status}.`,
    ));
  }
  if (!isJsonRecord(result)) {
    throw new Error("The schedule service returned an unreadable response.");
  }
  return result;
}

async function mutatePlugin(
  endpoint: string,
  method: "POST" | "PATCH" | "DELETE",
  body: JsonRecord,
  purpose: string,
): Promise<JsonRecord> {
  const response = await fetch(endpoint, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "Idempotency-Key": `${purpose}:${window.crypto.randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    result = undefined;
  }
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error("Administrator access is required to review or change Plugins.");
    }
    throw new Error(textAt(result, ["error", "message"], `Request failed with status ${response.status}.`));
  }
  if (!isJsonRecord(result)) throw new Error("The Plugin service returned an unreadable response.");
  return result;
}

function resourceErrorMessage(key: AutomationResourceKey, label: string, error: unknown) {
  if (key === "plugins") {
    return "The Plugin catalog is not available in this deployment. Nothing has been treated as installed.";
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return `${label} did not respond within 15 seconds.`;
  }
  const detail = error instanceof Error && error.message.length <= 240 ? error.message : undefined;
  return detail || `${label} could not be loaded.`;
}

function recordKey(record: JsonRecord, index: number) {
  return textAt(record, ["id", "slug", "name"], `row-${index}`);
}

function chainTitle(key: "access" | "actions" | "guidance" | "repeat" | "bundles") {
  return ({ access: "Connections & MCP", actions: "Governed Tools", guidance: "Skills", repeat: "Automations", bundles: "Plugins" } as const)[key];
}

function triggerDescription(trigger: JsonRecord) {
  const template = textAt(trigger, ["goalTemplate", "description"], "Starts a governed workflow when its event occurs.");
  return template.length > 180 ? `${template.slice(0, 177)}…` : template;
}

function timeDescription(record: JsonRecord) {
  const value = textAt(record, ["updatedAt", "createdAt", "startedAt"], "");
  return value ? `Updated ${formatDateTime(value)}` : "No execution timestamp reported.";
}

function mcpDescription(connector: JsonRecord) {
  const error = textAt(connector, ["lastError"], "");
  if (error) return error.length > 180 ? `${error.slice(0, 177)}…` : error;
  const discovered = textAt(connector, ["lastDiscoveredAt"], "");
  return discovered ? `Contracts discovered ${formatDateTime(discovered)}.` : "Waiting for its first reviewed capability discovery.";
}

function pluginTitle(plugin: JsonRecord) {
  const manifest = recordAt(plugin, "manifest");
  return textAt(plugin, ["name", "title"], textAt(manifest, ["name", "title"], "Unnamed Plugin"));
}

function pluginActivationDescription(plugin: JsonRecord) {
  const activation = recordAt(plugin, "activation");
  return textAt(
    activation,
    ["explanation"],
    "The bundle is installed, but MCP credentials, reviewed contracts, and executable workflows are not implied.",
  );
}

function pluginMeta(plugin: JsonRecord) {
  const manifest = recordAt(plugin, "manifest") || recordAt(plugin, "components") || plugin;
  const componentCounts = recordAt(plugin, "componentCounts");
  const skills = componentCounts
    ? numberAt(componentCounts, "skills")
    : recordsAt(manifest, "skills").length;
  const mcpTemplates = componentCounts
    ? numberAt(componentCounts, "mcpTemplates")
    : recordsAt(manifest, "mcpTemplates").length || recordsAt(manifest, "mcp").length;
  const workflows = componentCounts
    ? numberAt(componentCounts, "workflowTemplates")
    : recordsAt(manifest, "workflowTemplates").length;
  return [`${skills} ${skills === 1 ? "skill" : "skills"}`, `${mcpTemplates} MCP ${mcpTemplates === 1 ? "template" : "templates"}`, `${workflows} automation ${workflows === 1 ? "template" : "templates"}`];
}

function riskMeaning(level: 0 | 1 | 2 | 3) {
  return (["Read only", "Reversible write", "External or sensitive", "High impact"] as const)[level];
}

function statusTone(status: string) {
  if (["active", "ready", "working", "connected", "enabled", "installed", "available", "completed", "succeeded"].includes(status)) return "positive";
  if (["error", "failed", "unavailable", "blocked", "rejected"].includes(status)) return "negative";
  if (["paused", "degraded", "action_required", "waiting_approval", "pending_review", "queued", "running"].includes(status)) return "attention";
  return "neutral";
}

function plainStatus(status: string) {
  return ({
    claimed: "Preparing",
    enqueued: "Queued",
    completed: "Completed",
    skipped: "Skipped",
    failed: "Failed",
  } as Record<string, string>)[status] || status.replaceAll("_", " ");
}

function plainFailure(code: string) {
  return ({
    agent_identity_changed: "The pinned Agent release changed.",
    agent_policy_changed: "The reviewed Agent policy changed.",
    procedure_changed: "The saved procedure no longer matches the reviewed snapshot.",
    procedure_not_read_only: "The procedure no longer meets the read-only boundary.",
    mutation_policy_changed: "The reviewed change policy changed.",
    policy_lease_unavailable: "A safe one-use PolicyLease could not be issued.",
    occurrence_budget_changed: "The per-run budget changed.",
    workflow_enqueue_failed: "The workflow could not enter the queue.",
    workflow_failed: "The workflow reported a failure.",
    workflow_canceled: "The workflow was canceled.",
  } as Record<string, string>)[code] || code.replaceAll("_", " ");
}

function occurrenceOutcomeCopy(status: string) {
  if (status === "completed") return "The scheduled workflow completed under its reviewed bindings.";
  if (status === "enqueued") return "The reviewed occurrence entered the workflow queue.";
  if (status === "claimed") return "The scheduler claimed this occurrence and is checking its pins.";
  if (status === "skipped") return "The scheduler recorded this occurrence without starting duplicate work.";
  return "The occurrence state was recorded without notification content.";
}

function policyLeaseLabel(status: string) {
  if (status === "consumed") return "Consumed once";
  if (status === "expired") return "Expired unused";
  return "Issued and ready";
}

function policyLeaseCopy(status: string) {
  if (status === "consumed") return "The exact reviewed action claimed this lease atomically; it cannot be reused.";
  if (status === "expired") return "The short-lived lease expired without authorizing an action.";
  return "A short-lived, single-use lease is waiting for its exact reviewed action.";
}

function safeMutationError(error: unknown, fallback: string) {
  return error instanceof Error && error.message.length <= 240 ? error.message : fallback;
}

function studioTab(value: string | null): StudioTab {
  return tabs.some((tab) => tab.id === value) ? value as StudioTab : "overview";
}

function formatTime(value: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
  } catch {
    return "just now";
  }
}

function formatDateTime(value: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return "at an unknown time";
  }
}

function defaultScheduleStart() {
  const value = new Date(Date.now() + 60 * 60_000);
  value.setSeconds(0, 0);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function weekdayCodeForDate(value: Date) {
  return (["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const)[
    value.getDay()
  ];
}

function scheduleDate(value: string, timezone: string) {
  if (!value) return "No further occurrence";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return formatDateTime(value);
  }
}

function friendlyRrule(value: string) {
  const fields = Object.fromEntries(value.split(";").map((part) => part.split("=")));
  const time = `${String(fields.BYHOUR || "0").padStart(2, "0")}:${String(fields.BYMINUTE || "0").padStart(2, "0")}`;
  if (fields.FREQ === "WEEKLY") return `Weekly · ${fields.BYDAY || "start day"} · ${time}`;
  if (fields.BYDAY === "MO,TU,WE,TH,FR") return `Weekdays · ${time}`;
  if (fields.FREQ === "MONTHLY") return `Monthly · ${time}`;
  return `Daily · ${time}`;
}

function shortDigest(value: string) {
  return value ? `${value.slice(0, 12)}…` : "Unavailable";
}

export function capabilityStateLabel(state: CapabilityState) {
  return state === "available" ? "Available" : state === "partial" ? "Partially available" : "Unavailable";
}
