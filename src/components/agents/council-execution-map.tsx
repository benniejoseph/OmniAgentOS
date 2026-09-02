import type { CSSProperties } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Network,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { clsx } from "clsx";
import {
  AgentMascot,
  getAgentMascotIdentity,
} from "@/components/agents/agent-mascot";
import styles from "@/components/agents/council-execution-map.module.css";

type CouncilMemberStatus = "thinking" | "completed" | "failed";

type CouncilMemberEvent = {
  type: "council_member";
  agentId: string;
  agentName: string;
  role: string;
  status: CouncilMemberStatus;
  summary?: string;
  confidence?: number;
  durationMs?: number;
};

type CouncilVerdictEvent = {
  type: "council_verdict";
  status: "passed" | "revised" | "failed";
  score: number;
  assessment: string;
  requiredChanges: string[];
};

const seatLayouts: Record<number, Array<{ x: number; y: number }>> = {
  1: [{ x: 50, y: 22 }],
  2: [{ x: 17, y: 50 }, { x: 83, y: 50 }],
  3: [{ x: 50, y: 19 }, { x: 17, y: 77 }, { x: 83, y: 77 }],
  4: [{ x: 17, y: 22 }, { x: 83, y: 22 }, { x: 17, y: 76 }, { x: 83, y: 76 }],
  5: [{ x: 17, y: 19 }, { x: 83, y: 19 }, { x: 13, y: 69 }, { x: 87, y: 69 }, { x: 50, y: 87 }],
  6: [{ x: 17, y: 22 }, { x: 50, y: 15 }, { x: 83, y: 22 }, { x: 17, y: 78 }, { x: 50, y: 85 }, { x: 83, y: 78 }],
};

export function CouncilExecutionMap({ events }: { events: readonly unknown[] }) {
  const latestByAgent = new Map<string, CouncilMemberEvent>();
  let verdict: CouncilVerdictEvent | undefined;

  for (const event of events) {
    const member = parseCouncilMember(event);
    if (member) latestByAgent.set(member.agentId, member);
    const nextVerdict = parseCouncilVerdict(event);
    if (nextVerdict) verdict = nextVerdict;
  }

  const members = [...latestByAgent.values()];
  if (!members.length && !verdict) return null;

  const visibleMembers = members.slice(0, 6);
  const seatPositions = seatLayouts[visibleMembers.length] || seatLayouts[6];
  const activeCount = members.filter((member) => member.status === "thinking").length;
  const completedCount = members.filter((member) => member.status === "completed").length;
  const verdictScore = normalizedScore(verdict?.score) || 0;

  return (
    <section className={styles.council} aria-label="Live agent council">
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.titleIcon} aria-hidden="true"><Network size={17} /></span>
          <div>
            <p className={styles.eyebrow}>Live collaboration</p>
            <h3>Agent Council Chamber</h3>
          </div>
        </div>
        <div className={clsx(styles.councilStatus, verdict && styles.isComplete)}>
          {verdict ? <CheckCircle2 size={14} aria-hidden="true" /> : <span className={styles.liveDot} aria-hidden="true" />}
          {verdict
            ? "Synthesis complete"
            : activeCount
              ? `${activeCount} perspective${activeCount === 1 ? "" : "s"} active`
              : `${completedCount} perspective${completedCount === 1 ? "" : "s"} delivered`}
        </div>
      </header>

      <div className={styles.chamber}>
        <div className={styles.constellation} aria-hidden="true">
          <span className={styles.fieldOne} />
          <span className={styles.fieldTwo} />
          <span className={styles.fieldThree} />
        </div>

        <svg className={styles.connections} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {visibleMembers.map((member, index) => {
            const position = seatPositions[index];
            return (
              <g key={member.agentId} className={styles[member.status]}>
                <line x1="50" y1="50" x2={position.x} y2={position.y} />
                <circle cx={position.x} cy={position.y} r="0.9" />
              </g>
            );
          })}
        </svg>

        <div className={styles.synthesisCore}>
          <span className={styles.coreOrbit} aria-hidden="true" />
          <span className={styles.coreGlyph} aria-hidden="true"><Sparkles size={22} /></span>
          <strong>Synthesis core</strong>
          <small>
            {verdict
              ? `${completedCount} perspectives reconciled`
              : "Reconciling independent passes"}
          </small>
        </div>

        <div className={styles.seats}>
          {visibleMembers.map((member, index) => {
            const position = seatPositions[index];
            const identity = getAgentMascotIdentity(member.agentId);
            const confidence = normalizedScore(member.confidence);
            const seatStyle = {
              "--seat-x": `${position.x}%`,
              "--seat-y": `${position.y}%`,
            } as CSSProperties;

            return (
              <article
                key={member.agentId}
                className={clsx(styles.seat, styles[member.status])}
                data-agent={identity.id}
                style={seatStyle}
              >
                <AgentMascot
                  agentId={member.agentId}
                  agentName={member.agentName}
                  size="medium"
                />
                <div className={styles.memberCopy}>
                  <div className={styles.memberHeading}>
                    <strong>{member.agentName}</strong>
                    <StatusIcon status={member.status} />
                  </div>
                  <span>{identity.companion} · {member.role}</span>
                  <p>{member.summary || memberStatusCopy(member.status)}</p>
                  <div className={styles.memberMeta}>
                    <small>{memberStatusLabel(member.status)}</small>
                    {confidence === undefined ? null : <small>{Math.round(confidence * 100)}% confidence</small>}
                  </div>
                  {confidence === undefined ? null : (
                    <span className={styles.confidenceTrack} aria-label={`${Math.round(confidence * 100)} percent confidence`}>
                      <span style={{ width: `${confidence * 100}%` }} />
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {members.length > visibleMembers.length ? (
        <p className={styles.overflowNote}>+{members.length - visibleMembers.length} additional council members contributed to synthesis.</p>
      ) : null}

      {verdict ? (
        <footer className={clsx(styles.verdict, styles[`verdict-${verdict.status}`])}>
          <span className={styles.verdictIcon} aria-hidden="true">
            {verdict.status === "failed" ? <AlertTriangle size={18} /> : <ShieldCheck size={18} />}
          </span>
          <div className={styles.verdictCopy}>
            <p className={styles.verdictLabel}>{verdictTitle(verdict.status)}</p>
            <p>{verdict.assessment}</p>
            {verdict.requiredChanges.length ? (
              <small>{verdict.requiredChanges.length} required change{verdict.requiredChanges.length === 1 ? "" : "s"} recorded</small>
            ) : null}
          </div>
          <div className={styles.score} aria-label={`${Math.round(verdictScore * 100)} percent council score`}>
            <strong>{Math.round(verdictScore * 100)}</strong>
            <span>score</span>
          </div>
        </footer>
      ) : null}
    </section>
  );
}

function StatusIcon({ status }: { status: CouncilMemberStatus }) {
  if (status === "thinking") return <Loader2 size={13} className={styles.statusSpinner} aria-label="Working" />;
  if (status === "failed") return <AlertTriangle size={13} aria-label="Needs retry" />;
  return <CheckCircle2 size={13} aria-label="Complete" />;
}

function parseCouncilMember(value: unknown): CouncilMemberEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (
    event.type !== "council_member" ||
    typeof event.agentId !== "string" ||
    typeof event.agentName !== "string" ||
    typeof event.role !== "string" ||
    (event.status !== "thinking" && event.status !== "completed" && event.status !== "failed")
  ) return undefined;
  return {
    type: "council_member",
    agentId: event.agentId,
    agentName: event.agentName,
    role: event.role,
    status: event.status,
    summary: typeof event.summary === "string" ? event.summary : undefined,
    confidence: finiteNumber(event.confidence),
    durationMs: finiteNumber(event.durationMs),
  };
}

function parseCouncilVerdict(value: unknown): CouncilVerdictEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (
    event.type !== "council_verdict" ||
    (event.status !== "passed" && event.status !== "revised" && event.status !== "failed") ||
    typeof event.assessment !== "string"
  ) return undefined;
  return {
    type: "council_verdict",
    status: event.status,
    score: finiteNumber(event.score) || 0,
    assessment: event.assessment,
    requiredChanges: Array.isArray(event.requiredChanges)
      ? event.requiredChanges.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedScore(value?: number) {
  if (value === undefined) return undefined;
  return Math.min(Math.max(value, 0), 1);
}

function memberStatusLabel(status: CouncilMemberStatus) {
  if (status === "thinking") return "Exploring";
  if (status === "failed") return "Needs another pass";
  return "Perspective delivered";
}

function memberStatusCopy(status: CouncilMemberStatus) {
  if (status === "thinking") return "Reviewing the task from this specialist perspective.";
  if (status === "failed") return "This perspective could not be completed.";
  return "Independent findings are ready for synthesis.";
}

function verdictTitle(status: CouncilVerdictEvent["status"]) {
  if (status === "passed") return "Council consensus reached";
  if (status === "revised") return "Answer strengthened after review";
  return "Council requested another pass";
}
