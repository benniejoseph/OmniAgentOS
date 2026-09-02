import { clsx } from "clsx";
import styles from "@/components/agents/agent-mascot.module.css";

export type AgentMascotKind =
  | "atlas"
  | "scout"
  | "forge"
  | "sentinel"
  | "mnemosyne"
  | "custom";

export type AgentMascotIdentity = {
  id: AgentMascotKind;
  companion: string;
  motto: string;
  theme: string;
};

export const agentMascotIdentities: Record<
  AgentMascotKind,
  AgentMascotIdentity
> = {
  atlas: {
    id: "atlas",
    companion: "Compass Tortoise",
    motto: "Find the true north. Move with purpose.",
    theme: "Direction",
  },
  scout: {
    id: "scout",
    companion: "Signal Fox",
    motto: "Follow the signal. Bring back proof.",
    theme: "Discovery",
  },
  forge: {
    id: "forge",
    companion: "Ember Salamander",
    motto: "Shape the spark. Temper the result.",
    theme: "Creation",
  },
  sentinel: {
    id: "sentinel",
    companion: "Bastion Crane",
    motto: "See the fault line. Guard the standard.",
    theme: "Assurance",
  },
  mnemosyne: {
    id: "mnemosyne",
    companion: "Archive Moth",
    motto: "Keep what matters. Recall it with care.",
    theme: "Memory",
  },
  custom: {
    id: "custom",
    companion: "Orb Companion",
    motto: "A new intelligence finding its orbit.",
    theme: "Specialist",
  },
};

export function getAgentMascotIdentity(agentId: string): AgentMascotIdentity {
  return (
    agentMascotIdentities[agentId as AgentMascotKind] ||
    agentMascotIdentities.custom
  );
}

export function AgentMascot({
  agentId,
  agentName,
  size = "medium",
  className,
  decorative = false,
}: {
  agentId: string;
  agentName?: string;
  size?: "small" | "medium" | "large" | "hero";
  className?: string;
  decorative?: boolean;
}) {
  const identity = getAgentMascotIdentity(agentId);
  const label = `${agentName || "Agent"} — ${identity.companion}`;

  return (
    <span
      className={clsx(styles.frame, styles[size], className)}
      data-agent={identity.id}
      aria-hidden={decorative || undefined}
    >
      <svg
        className={styles.mascot}
        viewBox="0 0 120 120"
        role={decorative ? undefined : "img"}
        aria-label={decorative ? undefined : label}
        focusable="false"
      >
        <circle className={styles.aura} cx="60" cy="60" r="52" />
        <circle className={styles.orbit} cx="60" cy="60" r="46" />
        {identity.id === "atlas" ? <AtlasTortoise /> : null}
        {identity.id === "scout" ? <ScoutFox /> : null}
        {identity.id === "forge" ? <ForgeSalamander /> : null}
        {identity.id === "sentinel" ? <SentinelCrane /> : null}
        {identity.id === "mnemosyne" ? <MnemosyneMoth /> : null}
        {identity.id === "custom" ? <OrbCompanion /> : null}
      </svg>
    </span>
  );
}

function AtlasTortoise() {
  return (
    <g className={styles.creature}>
      <path
        className={styles.soft}
        d="M28 65 18 57l3-8 13 2m58 14 10-8-3-8-13 2M39 84l-8 12 8 4 10-12m32-4 8 12-8 4-10-12"
      />
      <path className={styles.solid} d="M86 58c10 0 17 5 17 12s-7 12-17 12l-7-12Z" />
      <path className={styles.soft} d="M24 54c7-18 20-29 37-29 18 0 33 13 38 33-6 25-20 36-39 36-20 0-34-13-36-40Z" />
      <path className={styles.detail} d="m60 31 21 12 8 23-13 19H45L31 66l8-23Z" />
      <path className={styles.detail} d="m60 31 1 54M39 43l42 0M31 66h58M45 85l15-54 16 54" />
      <path className={styles.solid} d="m60 39 7 23-7 13-7-13Z" />
      <circle className={styles.spark} cx="60" cy="62" r="3.5" />
      <circle className={styles.ink} cx="94" cy="68" r="1.8" />
    </g>
  );
}

function ScoutFox() {
  return (
    <g className={styles.creature}>
      <path className={styles.signal} d="M29 44c7-14 18-22 31-22s24 8 31 22M37 49c5-9 13-14 23-14s18 5 23 14" />
      <path className={styles.soft} d="m27 40 24 9h18l24-9-8 40-25 20-25-20Z" />
      <path className={styles.solid} d="m27 40 26 12-18 20Zm66 0L67 52l18 20Z" />
      <path className={styles.detail} d="m51 49 9 38 9-38M35 80l25 20 25-20" />
      <path className={styles.ink} d="m43 68 9 3-8 5Zm34 0-9 3 8 5Z" />
      <path className={styles.solid} d="m54 84 6 3 6-3-6 9Z" />
      <circle className={styles.spark} cx="60" cy="22" r="3" />
    </g>
  );
}

function ForgeSalamander() {
  return (
    <g className={styles.creature}>
      <path className={styles.signal} d="M82 22c12 13 11 24-2 33 2-10-4-14-11-19 1-7 5-12 13-14Z" />
      <path className={styles.spark} d="M80 29c6 8 5 14-2 20 1-6-3-8-6-11 1-4 3-7 8-9Z" />
      <path className={styles.soft} d="M30 79c8-25 25-38 46-32 14 4 18 15 13 26-5 12-20 18-36 12-11-4-19 2-23 12-9-4-9-11 0-18Z" />
      <path className={styles.solid} d="M26 81c-14 6-15 17-4 21 7 3 15-1 21-9-11 4-18 2-17-12Z" />
      <path className={styles.detail} d="M40 71c12-14 29-18 44-10M49 85l-12 12m25-9 4 13m15-24 13 7m-45-21-12-9" />
      <circle className={styles.ink} cx="77" cy="59" r="2" />
      <path className={styles.spark} d="m51 71 7-5 8 4-2 9-10 1Z" />
    </g>
  );
}

function SentinelCrane() {
  return (
    <g className={styles.creature}>
      <path className={styles.soft} d="M25 35c13 5 24 13 35 27 11-14 22-22 35-27-3 21-14 36-32 43v26h-7V78C39 71 28 56 25 35Z" />
      <path className={styles.solid} d="M60 62c2-19 13-32 29-39l-4 22-18 25Z" />
      <path className={styles.detail} d="M25 35c16 13 27 27 35 43m35-43C79 48 68 62 60 78M42 56h36" />
      <path className={styles.signal} d="m60 50 17 8-3 22c-2 10-7 17-14 21-7-4-12-11-14-21l-3-22Z" />
      <path className={styles.spark} d="m60 59 9 4-2 13c-1 6-3 10-7 13-4-3-6-7-7-13l-2-13Z" />
      <circle className={styles.ink} cx="83" cy="32" r="1.8" />
    </g>
  );
}

function MnemosyneMoth() {
  return (
    <g className={styles.creature}>
      <path className={styles.signal} d="M56 31C49 18 39 16 33 25M64 31c7-13 17-15 23-6" />
      <path className={styles.soft} d="M55 42C43 26 23 28 18 44c-4 14 8 25 25 25-15 6-17 19-8 28 8 8 18 2 25-13 7 15 17 21 25 13 9-9 7-22-8-28 17 0 29-11 25-25-5-16-25-18-37-2Z" />
      <path className={styles.detail} d="M55 43 34 53l9 16-8 28m30-54 21 10-9 16 8 28M43 69h34" />
      <path className={styles.solid} d="M55 39h10l4 41-9 13-9-13Z" />
      <path className={styles.spark} d="M28 43h18v13H28Zm46 0h18v13H74ZM39 76h13v12H39Zm29 0h13v12H68Z" />
      <path className={styles.ink} d="M32 48h10M78 48h10M43 81h5m24 0h5" />
    </g>
  );
}

function OrbCompanion() {
  return (
    <g className={styles.creature}>
      <circle className={styles.soft} cx="60" cy="60" r="29" />
      <circle className={styles.detail} cx="60" cy="60" r="18" />
      <path className={styles.solid} d="m60 39 18 21-18 21-18-21Z" />
      <path className={styles.detail} d="M18 63c16-16 68-24 84-6 12 14-15 27-37 29" />
      <circle className={styles.spark} cx="94" cy="50" r="6" />
      <circle className={styles.ink} cx="60" cy="60" r="4" />
    </g>
  );
}
