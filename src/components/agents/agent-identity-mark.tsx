import styles from "./agent-identity-mark.module.css";

/** A quiet identifier beside the full executing Agent name and version. */
export function AgentIdentityMark({ agentId, agentName, size = "medium", decorative = false }: {
  agentId: string;
  agentName?: string;
  size?: "small" | "medium";
  decorative?: boolean;
}) {
  const name = agentName?.trim() || agentId;
  const initials = name.split(/\s+/u).slice(0, 2).map((word) => [...word][0]).join("").toLocaleUpperCase("en-US");
  return <span className={styles.mark} data-size={size} role={decorative ? undefined : "img"} aria-label={decorative ? undefined : `${name} identity`} aria-hidden={decorative || undefined}>{initials}</span>;
}
