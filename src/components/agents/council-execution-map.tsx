"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Coins,
  FileCheck2,
  Inbox,
  KeyRound,
  Loader2,
  MessageSquare,
  Network,
  OctagonX,
  PackageCheck,
  PanelRight,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { clsx } from "clsx";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { AgentMascot } from "@/components/agents/agent-mascot";
import styles from "@/components/agents/council-execution-map.module.css";
import type {
  AgentCouncilMap,
  AgentCouncilMapMember,
} from "@/lib/agents/council-map-contract";

type CouncilLoadState = "loading" | "ready" | "unavailable";
type CouncilExecution = AgentCouncilMap["executions"][number];

export type AgentTaskAuthorityDetail = Readonly<{
  immutable: true;
  contractSha256: string;
  grantRequestSha256: string;
  validation: Readonly<{
    status: "not_checked" | "current" | "changed";
    category: "all_grants" | "capability_binding" | null;
    validatedAt: string | null;
  }>;
  nativeReadTools: readonly Readonly<{
    toolId: string;
    managementHref: string;
  }>[];
  skills: readonly Readonly<{
    capabilityGrantId: string;
    skillId: string;
    skillVersion: number;
    skillVersionId: string;
    skillSha256: string;
    managementHref: string;
  }>[];
  plugins: readonly Readonly<{
    capabilityGrantId: string;
    installationId: string;
    installationRevision: number;
    installationSha256: string;
    pluginId: string;
    pluginVersion: string;
    manifestSha256: string;
    componentIds: readonly string[];
    managementHref: string;
  }>[];
  mcpServers: readonly Readonly<{
    capabilityGrantId: string;
    serverId: string;
    serverVersionId: string;
    serverContractSha256: string;
    governedToolIds: readonly string[];
    connectorTargetIds: readonly string[];
    managementHref: string;
  }>[];
}>;

type AgentTaskDetailPayload = Readonly<{
  task: Readonly<{
    executionId: string;
    authority: AgentTaskAuthorityDetail;
    controls: Readonly<{
      grantsImmutable: true;
      allowedActions: readonly string[];
      cancelHref: string | null;
    }>;
  }>;
}>;

export function CouncilExecutionMap({
  map,
  state,
  initialRunId,
  initialTaskId,
  onTaskCanceled,
}: {
  map?: AgentCouncilMap;
  state: CouncilLoadState;
  initialRunId?: string;
  initialTaskId?: string;
  onTaskCanceled?: (task: CanceledTaskProjection) => void;
}) {
  const [selection, setSelection] = useState<{ runId?: string; taskId?: string }>({
    runId: initialRunId,
    taskId: initialTaskId,
  });

  const selected = useMemo(() => selectCouncilItem(map, selection), [map, selection]);

  if (state === "loading") return <CouncilNotice kind="loading" />;
  if (state === "unavailable" || map?.state === "unavailable") {
    return <CouncilNotice kind="unavailable" />;
  }
  if (!map || map.state === "empty") return <CouncilNotice kind="empty" />;

  const choose = (execution: CouncilExecution, member?: AgentCouncilMapMember) => {
    const next = {
      runId: execution.parentExecutionId,
      taskId: member?.taskId || execution.members[0]?.taskId,
    };
    setSelection(next);
    const url = new URL(window.location.href);
    url.searchParams.set("view", "live");
    url.searchParams.set("run", next.runId);
    if (next.taskId) url.searchParams.set("task", next.taskId);
    window.history.replaceState(window.history.state, "", url);
  };

  return (
    <section className={styles.controlCenter} aria-label="Live Agent work">
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.titleIcon} aria-hidden="true"><Network size={20} /></span>
          <div>
            <p className={styles.eyebrow}>Canonical delegation ledger</p>
            <h2>Live work</h2>
            <p>Follow each execution, its delegated team, shared work, and verification boundary.</p>
          </div>
        </div>
        <div className={styles.summary} aria-label="Live work summary">
          <SummaryValue value={map.summary.activeMemberCount} label="active" live />
          <SummaryValue value={map.summary.memberCount} label="workers" />
          <SummaryValue value={map.summary.waitingMemberCount} label="waiting" />
          <SummaryValue value={formatKnownCost(map.summary.knownEstimatedCostMicrousd)} label="known cost" />
        </div>
      </header>

      <div className={styles.workspace}>
        <aside className={styles.executionRail} aria-label="Executions and team members">
          <div className={styles.paneHeading}>
            <div><span>Execution queue</span><strong>{map.executions.length} recent</strong></div>
            <small>Read only</small>
          </div>
          <div className={styles.executionList}>
            {map.executions.map((execution) => {
              const executionSelected = execution.parentExecutionId === selected.execution.parentExecutionId;
              return (
                <section className={styles.executionGroup} key={execution.parentExecutionId}>
                  <button
                    type="button"
                    className={clsx(styles.executionButton, executionSelected && styles.isSelected)}
                    onClick={() => choose(execution)}
                    aria-pressed={executionSelected}
                  >
                    <span className={styles.runState} data-state={execution.status}>
                      <i aria-hidden="true" />{runStatusLabel(execution.status)}
                    </span>
                    <strong>{execution.currentWork}</strong>
                    <span>{execution.members.length} worker{execution.members.length === 1 ? "" : "s"} · updated {formatTime(execution.updatedAt)}</span>
                  </button>
                  {executionSelected ? (
                    <div className={styles.teamTree} aria-label="Delegated team">
                      <div className={styles.parentNode}>
                        <AgentMascot agentId="atlas" agentName="Atlas" size="small" decorative />
                        <span><strong>Atlas</strong><small>Coordinator</small></span>
                      </div>
                      {execution.members.map((member) => (
                        <button
                          type="button"
                          key={member.taskId}
                          className={clsx(styles.memberButton, member.taskId === selected.member.taskId && styles.isSelected)}
                          onClick={() => choose(execution, member)}
                          aria-pressed={member.taskId === selected.member.taskId}
                        >
                          <AgentMascot agentId={member.identity.agentId} agentName={member.identity.name} size="small" decorative />
                          <span><strong>{member.identity.name}</strong><small>{taskStateLabel(member.state)}</small></span>
                          <ChevronRight size={14} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </aside>

        <main className={styles.activityPane} aria-live="polite">
          <ExecutionOverview
            execution={selected.execution}
            member={selected.member}
            onTaskCanceled={onTaskCanceled}
          />
        </main>

        <aside className={styles.inspector} aria-label="Selected worker authority and budget">
          <WorkerInspector member={selected.member} />
        </aside>
      </div>
    </section>
  );
}

type CanceledTaskProjection = Readonly<{
  executionId: string;
  state: "canceled";
  lifecycleRevision: number;
  canCancel: false;
  updatedAt: string;
  terminalAt: string | null;
}>;

function ExecutionOverview({
  execution,
  member,
  onTaskCanceled,
}: {
  execution: CouncilExecution;
  member: AgentCouncilMapMember;
  onTaskCanceled?: (task: CanceledTaskProjection) => void;
}) {
  const [cancelState, setCancelState] = useState<"idle" | "canceling" | "failed">("idle");
  const [cancelMessage, setCancelMessage] = useState<string>();
  const cancellationAttempt = useRef<{
    taskId: string;
    idempotencyKey: string;
  } | undefined>(undefined);

  const cancelTask = async () => {
    if (member.canCancel !== true || cancelState === "canceling") return;
    if (!window.confirm(`Stop ${member.identity.name}'s current task? Completed work remains inspectable.`)) return;
    setCancelState("canceling");
    setCancelMessage(undefined);
    try {
      if (cancellationAttempt.current?.taskId !== member.taskId) {
        cancellationAttempt.current = {
          taskId: member.taskId,
          idempotencyKey: crypto.randomUUID(),
        };
      }
      const response = await fetch(
        `/api/agents/tasks/${encodeURIComponent(member.taskId)}/cancel`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": cancellationAttempt.current.idempotencyKey,
          },
          body: JSON.stringify({ expectedRevision: member.lifecycleRevision }),
        },
      );
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        task?: CanceledTaskProjection;
      };
      if (!response.ok || !payload.task) {
        throw new Error(payload.error || "The delegated task could not be canceled.");
      }
      onTaskCanceled?.(payload.task);
      setCancelState("idle");
      setCancelMessage("Task canceled. Its recorded work remains available.");
    } catch (error) {
      setCancelState("failed");
      setCancelMessage(error instanceof Error ? error.message : "The delegated task could not be canceled.");
    }
  };

  return (
    <>
      <header className={styles.activityHeader}>
        <div className={styles.activityIdentity}>
          <AgentMascot agentId={member.identity.agentId} agentName={member.identity.name} size="medium" />
          <div>
            <p>{member.identity.role} · definition v{member.identity.definitionVersion}</p>
            <h3>{member.identity.name}</h3>
            <span className={styles.memberState} data-state={member.state}>
              <i aria-hidden="true" />{taskStateLabel(member.state)}
            </span>
          </div>
        </div>
        <div className={styles.activityActions}>
          <span className={styles.readOnlyBadge}><ShieldCheck size={13} />Observed ledger</span>
          {member.canCancel === true ? (
            <button
              type="button"
              className={styles.cancelButton}
              disabled={cancelState === "canceling"}
              onClick={() => void cancelTask()}
            >
              {cancelState === "canceling" ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : <OctagonX size={14} aria-hidden="true" />}
              {cancelState === "canceling" ? "Canceling" : "Cancel task"}
            </button>
          ) : null}
          <Link href={execution.href} className={styles.primaryLink}>
            Open in Command <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </header>
      {cancelMessage ? (
        <p className={clsx(styles.cancelNotice, cancelState === "failed" && styles.isError)} role="status">
          {cancelMessage}
        </p>
      ) : null}

      <section className={styles.workBrief} aria-labelledby="current-work-title">
        <div>
          <p>Current assignment</p>
          <h4 id="current-work-title">{member.currentWork}</h4>
        </div>
        <dl>
          <div><dt>Started</dt><dd>{formatTime(execution.startedAt)}</dd></div>
          <div><dt>Updated</dt><dd>{formatTime(member.updatedAt)}</dd></div>
          <div><dt>Confidence</dt><dd>{member.confidence === null ? "Not reported" : `${Math.round(member.confidence * 100)}%`}</dd></div>
        </dl>
      </section>

      <section className={styles.activitySection} aria-labelledby="activity-title">
        <SectionTitle icon={<Sparkles size={16} />} title="Activity" meta="Latest canonical state" id="activity-title" />
        <div className={styles.timeline}>
          <TimelineItem icon={<CircleDot size={15} />} title={taskStateLabel(member.state)} time={formatTime(member.updatedAt)}>
            {member.currentWork}
          </TimelineItem>
          <TimelineItem icon={<KeyRound size={15} />} title="Authority attached" time="Delegation receipt">
            {member.authority.purpose}
          </TimelineItem>
        </div>
      </section>

      <div className={styles.exchangeGrid}>
        <ExchangePanel icon={<MessageSquare size={16} />} title="Messages" state={messageStateLabel(member)}>
          {member.messages.items.length ? member.messages.items.map((message) => (
            <article className={styles.exchangeItem} key={`${message.messageId}:${message.direction}`}>
              <div><strong>{message.direction === "sent" ? "Sent" : "Received"} · {message.kind}</strong><time>{formatTime(message.createdAt)}</time></div>
              <p>{message.body}</p>
              <small>Untrusted shared content</small>
            </article>
          )) : <EmptyExchange text="No team messages have been shared for this worker." />}
        </ExchangePanel>
        <ExchangePanel icon={<PackageCheck size={16} />} title="Outputs" state={outputStateLabel(member)}>
          {member.outputs.items.length ? member.outputs.items.map((output) => (
            <article className={styles.exchangeItem} key={output.artifactId}>
              <div><strong>{output.title}</strong><time>{formatTime(output.createdAt)}</time></div>
              <p>{output.content}</p>
              <small>{output.kind} · untrusted shared content</small>
            </article>
          )) : <EmptyExchange text="No shared artifacts have been recorded yet." />}
        </ExchangePanel>
      </div>

      <section className={styles.verification} aria-label="Verification status">
        <div className={styles.verifierIdentity}>
          <AgentMascot agentId={member.verifier.identity.agentId} agentName={member.verifier.identity.name} size="small" decorative />
          <div><span>Independent verifier</span><strong>{member.verifier.identity.name}</strong><small>{verifierMethodLabel(member.verifier.method)}</small></div>
        </div>
        <div className={styles.verdict} data-verdict={member.verifier.verdict}>
          <strong>{verdictLabel(member.verifier.verdict)}</strong>
          <span>{member.verifier.score === null ? "Not scored" : `${Math.round(member.verifier.score * 100)}% score`}{` · ${Math.round(member.verifier.acceptanceThreshold * 100)}% required`}</span>
        </div>
      </section>

      <footer className={styles.destinationLinks} aria-label="Related workspaces">
        <span>Actions are handled in their governed workspaces.</span>
        <div>
          <Link href={execution.href}><Bot size={14} />Command</Link>
          <Link href="/app/approvals"><Inbox size={14} />Inbox</Link>
          <Link href="/app/results"><FileCheck2 size={14} />Results</Link>
        </div>
      </footer>
    </>
  );
}

function WorkerInspector({ member }: { member: AgentCouncilMapMember }) {
  const budget = member.authority.budgets;
  const [detailLoad, setDetailLoad] = useState<{
    taskId: string;
    state: "ready" | "error";
    detail?: AgentTaskAuthorityDetail;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/agents/tasks/${encodeURIComponent(member.taskId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as Partial<AgentTaskDetailPayload> & { error?: string };
        if (!response.ok || !payload.task?.authority) {
          throw new Error(payload.error || "Task authority could not be loaded.");
        }
        return payload.task.authority;
      })
      .then((authority) => {
        if (controller.signal.aborted) return;
        setDetailLoad({ taskId: member.taskId, state: "ready", detail: authority });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setDetailLoad({ taskId: member.taskId, state: "error" });
        }
      });
    return () => controller.abort();
  }, [member.taskId]);

  return (
    <>
      <div className={styles.paneHeading}>
        <div><span>Execution inspector</span><strong>Authority & limits</strong></div>
        <PanelRight size={17} aria-hidden="true" />
      </div>
      <section className={styles.inspectorSection}>
        <InspectorTitle icon={<ShieldCheck size={15} />} title="Authority" />
        <p className={styles.purpose}>{member.authority.purpose}</p>
        <div className={styles.receiptState} data-available={member.authority.source === "delegation_grants"}>
          {member.authority.source === "delegation_grants" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          {member.authority.source === "delegation_grants" ? "Verified delegation receipt" : "Historical grants unavailable"}
        </div>
        <InspectorRows rows={[
          ["Context", authorityCount(member.authority.context.state, member.authority.context.grantCount)],
          ["Capabilities", authorityCount(member.authority.capabilities.state, member.authority.capabilities.grantCount)],
          ["Governed tools", toolCount(member)],
        ]} />
        {member.authority.tools.ids.length ? <div className={styles.chips}>{member.authority.tools.ids.map((toolId) => <span key={toolId}>{toolId}</span>)}</div> : null}
      </section>

      <TaskAuthorityGrantInspector
        state={detailLoad?.taskId === member.taskId ? detailLoad.state : "loading"}
        authority={detailLoad?.taskId === member.taskId ? detailLoad.detail : undefined}
      />

      <section className={styles.inspectorSection}>
        <InspectorTitle icon={<Bot size={15} />} title="Model route" />
        <p className={styles.missingFact}>Not recorded in this read-only Council projection. Open the run to inspect its harness receipt.</p>
      </section>

      <section className={styles.inspectorSection}>
        <InspectorTitle icon={<Coins size={15} />} title="Budget" />
        <InspectorRows rows={[
          ["Model turns", nullableBudget(budget.modelTurns)],
          ["Tokens", nullableBudget(budget.tokens)],
          ["Tool calls", nullableBudget(budget.toolCalls)],
          ["Wall time", durationBudget(budget.wallTimeMs)],
          ["Known spend", costLabel(member.cost)],
        ]} />
      </section>

      <section className={styles.inspectorSection}>
        <InspectorTitle icon={<KeyRound size={15} />} title="Scope" />
        <InspectorRows rows={[
          ["Workspace", member.authority.scope.workspaceId || "None"],
          ["Project", member.authority.scope.projectId || "None"],
          ["Mission", member.authority.scope.missionId || "None"],
        ]} />
      </section>
    </>
  );
}

export function TaskAuthorityGrantInspector({
  state,
  authority,
}: {
  state: "loading" | "ready" | "error";
  authority?: AgentTaskAuthorityDetail;
}) {
  if (state === "loading") {
    return (
      <section className={styles.inspectorSection} aria-label="Signed execution grants" aria-busy="true">
        <InspectorTitle icon={<Loader2 size={15} className={styles.spin} />} title="Signed execution grants" />
        <p className={styles.missingFact}>Loading exact immutable pins…</p>
      </section>
    );
  }
  if (state === "error" || !authority) {
    return (
      <section className={styles.inspectorSection} aria-label="Signed execution grants">
        <InspectorTitle icon={<AlertTriangle size={15} />} title="Signed execution grants" />
        <p className={styles.missingFact}>Exact grant pins are temporarily unavailable. No authority was inferred.</p>
      </section>
    );
  }
  const grantCount = authority.nativeReadTools.length + authority.skills.length +
    authority.plugins.length + authority.mcpServers.length;
  return (
    <section className={styles.grantInspector} aria-label="Signed execution grants">
      <div className={styles.grantHeading}>
        <InspectorTitle icon={<KeyRound size={15} />} title="Signed execution grants" />
        <span>Immutable</span>
      </div>
      <p className={styles.missingFact}>These exact pins were signed when the task started. They cannot be edited or revoked in-place; cancel the task or change the source for future work.</p>
      <GrantValidation validation={authority.validation} />
      <InspectorRows rows={[
        ["Execution contract", authority.contractSha256],
        ["Grant request", authority.grantRequestSha256],
      ]} />
      {grantCount === 0 ? (
        <p className={styles.emptyGrant}>No external Skill, Plugin, MCP, or native read grants are attached.</p>
      ) : (
        <div className={styles.grantGroups}>
          <GrantGroup title="Native read tools" count={authority.nativeReadTools.length}>
            {authority.nativeReadTools.map((grant) => (
              <GrantPin key={grant.toolId} title={grant.toolId} rows={[]} href={grant.managementHref} />
            ))}
          </GrantGroup>
          <GrantGroup title="Skills" count={authority.skills.length}>
            {authority.skills.map((grant) => (
              <GrantPin key={grant.capabilityGrantId} title={grant.skillId} href={grant.managementHref} rows={[
                ["Version", `v${grant.skillVersion} · ${grant.skillVersionId}`],
                ["Skill digest", grant.skillSha256],
              ]} />
            ))}
          </GrantGroup>
          <GrantGroup title="Plugins" count={authority.plugins.length}>
            {authority.plugins.map((grant) => (
              <GrantPin key={grant.capabilityGrantId} title={`${grant.pluginId} · ${grant.pluginVersion}`} href={grant.managementHref} rows={[
                ["Installation", `${grant.installationId} · rev ${grant.installationRevision}`],
                ["Install digest", grant.installationSha256],
                ["Manifest", grant.manifestSha256],
                ["Components", grant.componentIds.join(", ") || "None"],
              ]} />
            ))}
          </GrantGroup>
          <GrantGroup title="MCP servers" count={authority.mcpServers.length}>
            {authority.mcpServers.map((grant) => (
              <GrantPin key={grant.capabilityGrantId} title={grant.serverId} href={grant.managementHref} rows={[
                ["Server version", grant.serverVersionId],
                ["Contract", grant.serverContractSha256],
                ["Read tools", grant.governedToolIds.join(", ") || "None"],
                ["Targets", grant.connectorTargetIds.join(", ") || "None"],
              ]} />
            ))}
          </GrantGroup>
        </div>
      )}
    </section>
  );
}

function GrantValidation({ validation }: { validation: AgentTaskAuthorityDetail["validation"] }) {
  const current = validation.status === "current";
  const label = validation.status === "not_checked"
    ? "Not validated yet"
    : current
      ? "All signed grants are current"
      : "A signed capability binding changed";
  const detail = validation.category === "all_grants"
    ? "Full grant set"
    : validation.category === "capability_binding"
      ? "Capability binding"
      : "No validation receipt";
  return (
    <div className={styles.grantValidation} data-status={validation.status} role="status">
      {current ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      <span><strong>{label}</strong><small>{detail}{validation.validatedAt ? ` · ${formatTime(validation.validatedAt)}` : ""}</small></span>
    </div>
  );
}

function GrantGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return <section className={styles.grantGroup}><h4>{title}<span>{count}</span></h4>{children}</section>;
}

function GrantPin({ title, rows, href }: { title: string; rows: [string, string][]; href: string }) {
  return (
    <article className={styles.grantPin}>
      <header><strong>{title}</strong><Link href={href}><Wrench size={12} />Manage source</Link></header>
      {rows.length ? <InspectorRows rows={rows} /> : null}
    </article>
  );
}

function CouncilNotice({ kind }: { kind: "loading" | "unavailable" | "empty" }) {
  const copy = kind === "loading"
    ? ["Loading live work", "Reading your scoped delegation ledger."]
    : kind === "unavailable"
      ? ["Live work unavailable", "The canonical delegation ledger could not be read. No authority was inferred."]
      : ["No delegated work yet", "When a multi-Agent run starts, its team, authority, shared outputs, and verification will appear here."];
  return (
    <section className={clsx(styles.notice, styles[kind])} aria-label="Live Agent work status">
      <span aria-hidden="true">{kind === "loading" ? <Loader2 size={22} /> : kind === "unavailable" ? <AlertTriangle size={22} /> : <Network size={22} />}</span>
      <div><h2>{copy[0]}</h2><p>{copy[1]}</p></div>
      {kind === "empty" ? <Link href="/app/command">Start in Command <ArrowUpRight size={14} /></Link> : null}
    </section>
  );
}

function selectCouncilItem(map: AgentCouncilMap | undefined, selection: { runId?: string; taskId?: string }) {
  const fallbackExecution = map?.executions[0];
  if (!fallbackExecution) return undefined as never;
  const execution = map.executions.find((item) => item.parentExecutionId === selection.runId) || fallbackExecution;
  const member = execution.members.find((item) => item.taskId === selection.taskId) || execution.members[0];
  return { execution, member };
}

function SummaryValue({ value, label, live }: { value: string | number; label: string; live?: boolean }) {
  return <span>{live ? <i aria-hidden="true" /> : null}<strong>{value}</strong><small>{label}</small></span>;
}

function SectionTitle({ icon, title, meta, id }: { icon: ReactNode; title: string; meta: string; id?: string }) {
  return <div className={styles.sectionTitle}><span>{icon}<strong id={id}>{title}</strong></span><small>{meta}</small></div>;
}

function InspectorTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return <div className={styles.inspectorTitle}>{icon}<strong>{title}</strong></div>;
}

function TimelineItem({ icon, title, time, children }: { icon: ReactNode; title: string; time: string; children: ReactNode }) {
  return <article><span aria-hidden="true">{icon}</span><div><header><strong>{title}</strong><time>{time}</time></header><p>{children}</p></div></article>;
}

function ExchangePanel({ icon, title, state, children }: { icon: ReactNode; title: string; state: string; children: ReactNode }) {
  return <section className={styles.exchange}><SectionTitle icon={icon} title={title} meta={state} /><div className={styles.exchangeItems}>{children}</div></section>;
}

function EmptyExchange({ text }: { text: string }) { return <p className={styles.emptyExchange}>{text}</p>; }

function InspectorRows({ rows }: { rows: [string, string][] }) {
  return <dl className={styles.inspectorRows}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function authorityCount(state: AgentCouncilMapMember["authority"]["context"]["state"], count: number) {
  if (state === "unavailable") return "Unavailable";
  return `${count} grant${count === 1 ? "" : "s"}`;
}

function toolCount(member: AgentCouncilMapMember) {
  if (member.authority.tools.state === "unavailable") return "Unavailable";
  const count = member.authority.tools.ids.length;
  return `${count} tool${count === 1 ? "" : "s"}`;
}

function nullableBudget(value: number | null) { return value === null ? "Unavailable" : value.toLocaleString(); }
function durationBudget(value: number | null) {
  if (value === null) return "Unavailable";
  if (value < 1_000) return `${value} ms`;
  return `${Math.round(value / 1_000)} sec`;
}

function costLabel(cost: AgentCouncilMapMember["cost"]) {
  if (cost.state === "not_recorded") return "Not recorded";
  if (cost.state === "unknown") return "Unknown";
  const known = formatKnownCost(cost.knownEstimatedCostMicrousd);
  return cost.state === "partial" ? `${known} + unknown` : known;
}

function formatKnownCost(microusd: number) {
  if (!microusd) return "$0.00";
  const usd = microusd / 1_000_000;
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function messageStateLabel(member: AgentCouncilMapMember) {
  if (member.messages.state === "not_applicable") return "No Mission channel";
  if (member.messages.state === "unavailable") return "Unavailable";
  return `${member.messages.items.length} shared`;
}

function outputStateLabel(member: AgentCouncilMapMember) {
  if (member.outputs.state === "receipt_only") return "Receipt only";
  if (member.outputs.state === "unavailable") return "Unavailable";
  return `${member.outputs.items.length} recorded`;
}

function verifierMethodLabel(method: AgentCouncilMapMember["verifier"]["method"]) {
  if (method === "deterministic_schema_and_evidence") return "Deterministic schema + evidence";
  if (method === "agent_then_deterministic") return "Agent review + deterministic checks";
  return "Historical method unavailable";
}

function verdictLabel(verdict: AgentCouncilMapMember["verifier"]["verdict"]) {
  if (verdict === "accepted") return "Accepted";
  if (verdict === "rejected") return "Rejected";
  if (verdict === "unavailable") return "Unavailable";
  return "Pending review";
}

function taskStateLabel(state: AgentCouncilMapMember["state"]) {
  return ({
    proposed: "Proposed",
    accepted: "Accepted task",
    working: "Working",
    waiting: "Waiting at boundary",
    challenged: "Challenged",
    completed_proposed: "Result proposed",
    result_accepted: "Result accepted",
    rejected: "Rejected",
    canceled: "Canceled",
    expired: "Expired",
  } satisfies Record<AgentCouncilMapMember["state"], string>)[state];
}

function runStatusLabel(status: CouncilExecution["status"]) { return status.replaceAll("_", " "); }

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
