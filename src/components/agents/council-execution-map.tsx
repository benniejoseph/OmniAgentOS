import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Coins,
  KeyRound,
  Loader2,
  MessageSquare,
  Network,
  PackageCheck,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { clsx } from "clsx";
import type { ReactNode } from "react";

import { AgentMascot } from "@/components/agents/agent-mascot";
import styles from "@/components/agents/council-execution-map.module.css";
import type {
  AgentCouncilMap,
  AgentCouncilMapMember,
} from "@/lib/agents/council-map-contract";

type CouncilLoadState = "loading" | "ready" | "unavailable";

export function CouncilExecutionMap({
  map,
  state,
}: {
  map?: AgentCouncilMap;
  state: CouncilLoadState;
}) {
  if (state === "loading") return <CouncilNotice kind="loading" />;
  if (state === "unavailable" || map?.state === "unavailable") {
    return <CouncilNotice kind="unavailable" />;
  }
  if (!map || map.state === "empty") return <CouncilNotice kind="empty" />;

  return (
    <section className={styles.council} aria-label="Live Agent Council delegation map">
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.titleIcon} aria-hidden="true"><Network size={18} /></span>
          <div>
            <p className={styles.eyebrow}>Canonical delegation ledger</p>
            <h2>Live Council map</h2>
            <p>Who is working, what each Agent can access, and who verifies the result.</p>
          </div>
        </div>
        <div className={styles.summary} aria-label="Council summary">
          <SummaryValue value={map.summary.activeMemberCount} label="active" live />
          <SummaryValue value={map.summary.memberCount} label="members" />
          <SummaryValue
            value={formatKnownCost(map.summary.knownEstimatedCostMicrousd)}
            label="known cost"
          />
        </div>
      </header>

      <div className={styles.executions}>
        {map.executions.map((execution) => (
          <article className={styles.execution} key={execution.parentExecutionId}>
            <header className={styles.executionHeader}>
              <div className={styles.executionCopy}>
                <span className={styles.runState} data-state={execution.status}>
                  <span aria-hidden="true" />{runStatusLabel(execution.status)}
                </span>
                <h3>{execution.currentWork}</h3>
                <p>
                  {execution.members.length} delegated Agent{execution.members.length === 1 ? "" : "s"}
                  <span aria-hidden="true"> · </span>
                  updated {formatTime(execution.updatedAt)}
                </p>
              </div>
              <div className={styles.executionActions}>
                <CostBadge cost={execution.verifierCost} prefix="Verifier" />
                <Link href={execution.href} className={styles.runLink}>
                  Open run <ArrowUpRight size={13} aria-hidden="true" />
                </Link>
              </div>
            </header>

            <div className={styles.delegationLane}>
              <div className={styles.parentNode} aria-label="Parent coordinator">
                <AgentMascot agentId="atlas" agentName="Atlas" size="small" decorative />
                <span><strong>Atlas</strong><small>Parent coordinator</small></span>
              </div>
              <span className={styles.laneLine} aria-hidden="true" />
              <span className={styles.laneLabel}><KeyRound size={11} /> scoped grants</span>
            </div>

            <div className={styles.members}>
              {execution.members.map((member) => (
                <CouncilMemberCard member={member} key={member.taskId} />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function CouncilMemberCard({ member }: { member: AgentCouncilMapMember }) {
  const active = ["proposed", "accepted", "working", "waiting", "challenged", "completed_proposed"]
    .includes(member.state);
  return (
    <article className={styles.member} data-state={member.state}>
      <header className={styles.memberHeader}>
        <AgentMascot
          agentId={member.identity.agentId}
          agentName={member.identity.name}
          size="medium"
        />
        <div className={styles.memberIdentity}>
          <p>{member.identity.role} · definition v{member.identity.definitionVersion}</p>
          <h4>{member.identity.name}</h4>
          <span className={clsx(styles.memberState, active && styles.isActive)}>
            {active ? <span className={styles.liveDot} aria-hidden="true" /> : <StateIcon state={member.state} />}
            {taskStateLabel(member.state)}
          </span>
        </div>
        <div className={styles.confidence}>
          <strong>{member.confidence === null ? "—" : `${Math.round(member.confidence * 100)}%`}</strong>
          <span>confidence</span>
        </div>
      </header>

      <div className={styles.currentWork}>
        <span>Current work</span>
        <p>{member.currentWork}</p>
      </div>

      <div className={styles.factGrid}>
        <Fact
          icon={<KeyRound size={13} />}
          label="Context"
          value={authorityCount(member.authority.context.state, member.authority.context.grantCount)}
        />
        <Fact
          icon={<Wrench size={13} />}
          label="Tools"
          value={toolCount(member)}
        />
        <Fact
          icon={<Coins size={13} />}
          label="Cost"
          value={costLabel(member.cost)}
        />
      </div>

      <section className={styles.authority} aria-label={`${member.identity.name} authority`}>
        <div className={styles.sectionHeading}>
          <span><ShieldCheck size={14} /> Allowed authority</span>
          <AuthoritySource member={member} />
        </div>
        <p className={styles.purpose}>{member.authority.purpose}</p>
        <div className={styles.chips}>
          {member.authority.source === "historical_unavailable" ? (
            <span className={styles.unavailableChip}>Historical grants unavailable</span>
          ) : (
            <>
              <span>{member.authority.context.grantCount} context grant{member.authority.context.grantCount === 1 ? "" : "s"}</span>
              <span>{member.authority.capabilities.grantCount} capability grant{member.authority.capabilities.grantCount === 1 ? "" : "s"}</span>
              {member.authority.tools.ids.map((toolId) => <span key={toolId}>{toolId}</span>)}
              {!member.authority.tools.ids.length ? <span>No governed tools</span> : null}
            </>
          )}
        </div>
        <div className={styles.scopeLine}>
          <span>Project: {member.authority.scope.projectId || "none"}</span>
          <span>Mission: {member.authority.scope.missionId || "none"}</span>
          <span>Budget: {budgetLabel(member)}</span>
        </div>
      </section>

      <div className={styles.exchangeGrid}>
        <ExchangePanel
          icon={<MessageSquare size={14} />}
          title="Messages"
          state={messageStateLabel(member)}
        >
          {member.messages.items.slice(0, 3).map((message) => (
            <div className={styles.exchangeItem} key={`${message.messageId}:${message.direction}`}>
              <span>{message.direction} · {message.kind}</span>
              <p>{message.body}</p>
              <small>Untrusted shared content</small>
            </div>
          ))}
        </ExchangePanel>
        <ExchangePanel
          icon={<PackageCheck size={14} />}
          title="Outputs"
          state={outputStateLabel(member)}
        >
          {member.outputs.items.slice(0, 3).map((output) => (
            <div className={styles.exchangeItem} key={output.artifactId}>
              <span>{output.kind} · {output.title}</span>
              <p>{output.content}</p>
              <small>Untrusted shared content</small>
            </div>
          ))}
        </ExchangePanel>
      </div>

      <footer className={styles.verifier}>
        <AgentMascot
          agentId={member.verifier.identity.agentId}
          agentName={member.verifier.identity.name}
          size="small"
          decorative
        />
        <div>
          <span>Verifier</span>
          <strong>{member.verifier.identity.name}</strong>
          <small>{verifierMethodLabel(member.verifier.method)}</small>
        </div>
        <div className={styles.verdict} data-verdict={member.verifier.verdict}>
          <span>{verdictLabel(member.verifier.verdict)}</span>
          <small>
            {member.verifier.score === null ? "Not scored" : `${Math.round(member.verifier.score * 100)}% score`}
            {` · ${Math.round(member.verifier.acceptanceThreshold * 100)}% required`}
          </small>
        </div>
      </footer>
    </article>
  );
}

function CouncilNotice({ kind }: { kind: "loading" | "unavailable" | "empty" }) {
  const copy = kind === "loading"
    ? ["Loading the Council", "Reading your scoped delegation ledger."]
    : kind === "unavailable"
      ? ["Council map unavailable", "The canonical delegation ledger could not be read. No authority was inferred."]
      : ["Council is ready", "Multi-agent runs will appear here with their grants, exchanges, cost, confidence, and verifier."];
  return (
    <section className={clsx(styles.notice, styles[kind])} aria-label="Agent Council status">
      <span aria-hidden="true">
        {kind === "loading" ? <Loader2 size={20} /> : kind === "unavailable" ? <AlertTriangle size={20} /> : <Network size={20} />}
      </span>
      <div><h2>{copy[0]}</h2><p>{copy[1]}</p></div>
    </section>
  );
}

function SummaryValue({ value, label, live }: { value: string | number; label: string; live?: boolean }) {
  return <span>{live ? <i aria-hidden="true" /> : null}<strong>{value}</strong><small>{label}</small></span>;
}

function Fact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div>{icon}<span><small>{label}</small><strong>{value}</strong></span></div>;
}

function ExchangePanel({
  icon,
  title,
  state,
  children,
}: {
  icon: ReactNode;
  title: string;
  state: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.exchange}>
      <div className={styles.sectionHeading}><span>{icon}{title}</span><small>{state}</small></div>
      <div className={styles.exchangeItems}>{children}</div>
    </section>
  );
}

function CostBadge({ cost, prefix }: { cost: AgentCouncilMapMember["cost"]; prefix: string }) {
  return <span className={styles.costBadge}><Coins size={12} />{prefix}: {costLabel(cost)}</span>;
}

function AuthoritySource({ member }: { member: AgentCouncilMapMember }) {
  return member.authority.source === "delegation_grants"
    ? <small><CheckCircle2 size={11} /> receipt verified</small>
    : <small><AlertTriangle size={11} /> unavailable</small>;
}

function StateIcon({ state }: { state: AgentCouncilMapMember["state"] }) {
  return state === "result_accepted"
    ? <CheckCircle2 size={11} aria-hidden="true" />
    : <AlertTriangle size={11} aria-hidden="true" />;
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

function budgetLabel(member: AgentCouncilMapMember) {
  const budget = member.authority.budgets;
  if (budget.modelTurns === null) return "unavailable";
  return `${budget.modelTurns} turn${budget.modelTurns === 1 ? "" : "s"}, ${budget.tokens?.toLocaleString() || 0} tokens`;
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

function runStatusLabel(status: AgentCouncilMap["executions"][number]["status"]) {
  return status.replaceAll("_", " ");
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
}
