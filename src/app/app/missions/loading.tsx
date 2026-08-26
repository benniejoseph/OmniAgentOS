import styles from "@/components/missions/mission-workspace.module.css";

export default function MissionsLoading() {
  return (
    <section className={styles.loadingShell} aria-label="Loading missions">
      <div className={styles.loadingHeader} />
      <div className={styles.loadingGrid}>
        <div className={styles.loadingRail} />
        <div className={styles.loadingCanvas} />
        <div className={styles.loadingInspector} />
      </div>
    </section>
  );
}
