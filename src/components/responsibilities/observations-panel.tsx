import type { Resource } from "./controller";
import { readableCode, type ObservationView } from "./model";
import styles from "./responsibilities.module.css";

export function ObservationsPanel({ resource, refresh }: { resource: Resource<ObservationView>; refresh: () => void }) {
  const value = resource.value;
  return <section className={styles.card} aria-labelledby="observations-heading"><h2 id="observations-heading">Evidence and comparisons</h2>
    <button type="button" onClick={refresh} disabled={resource.state === "loading"}>Refresh observations</button>
    {resource.state === "loading" && <p role="status">Loading observation receipts…</p>}
    {resource.state === "error" && <p role="status">Observations unavailable. {resource.error}{value ? " Last-loaded evidence below may be stale." : " No evidence claim can be made."}</p>}
    {value && <>
      <p>{value.baseline ? `Accepted baseline revision ${value.baseline.revision} · ${value.baseline.acceptedAt}` : "No accepted baseline. The first complete, current observation establishes one without notification."}</p>
      {value.baseline && <details><summary>Accepted baseline evidence</summary><pre>{JSON.stringify(value.baseline, null, 2)}</pre></details>}
      <div className={styles.notice}><h3>What counts as a change</h3><p>{value.policy.adapterCoverage}</p>
        <h4>Material changes</h4><ul>{value.policy.materialExamples.map((example) => <li key={example}>{example}</li>)}</ul>
        <h4>Cosmetic changes</h4><ul>{value.policy.cosmeticExamples.map((example) => <li key={example}>{example}</li>)}</ul>
        <h4>Insufficient or blocked evidence</h4><ul>{value.policy.unsupportedExamples.map((example) => <li key={example}>{example}</li>)}</ul>
        <p className={styles.identity}>Policy: {value.policy.id} · {value.policy.policySha256}</p></div>
      <h3>Observation history</h3>{value.receipts.length === 0 ? <p>No observation receipts in this window. Reading this page does not run a check.</p> : <ol className={styles.history}>{value.receipts.map((receipt) => {
        const { plan } = receipt; const observation = plan.observation;
        return <li key={observation.id}><h4>{readableCode(plan.outcome)}</h4><p>{observation.observedAt} · observation {readableCode(observation.state)}</p>
          <p>{plan.outcome === "no_change" ? "No material change. Quiet; no new notification candidate." : plan.outcome === "baseline_established" ? "Initial accepted baseline. No notification candidate." : plan.outcome === "material_change" ? "A material change was recorded. Check the separate in-app notification history for any admitted delivery." : "Evidence was not sufficient to advance the accepted baseline."}</p>
          {plan.reasons.length > 0 && <ul>{plan.reasons.map((reason, index) => <li key={`${index}-${reason}`}>{readableCode(reason)}</li>)}</ul>}
          <p>Observation delivery field: {plan.change ? readableCode(plan.change.deliveryState) : "not requested"}. This immutable observation does not itself authorize delivery.</p>
          <ul>{observation.sources.map((item, index) => <li key={`${item.source.id}-${index}`}><p className={styles.identity}>{item.source.kind} · {item.source.id} · {item.state}{item.reason ? ` · ${readableCode(item.reason)}` : ""}</p>
            <p>Source updated: {item.sourceUpdatedAt ?? "unknown"} · fresh until: {item.freshUntil ?? "unknown"}</p>
            {item.evidence.length === 0 ? <p>No accepted evidence references.</p> : <ul>{item.evidence.map((evidence, position) => <li key={`${evidence.id}-${position}`} className={styles.identity}>{evidence.kind} · {evidence.id} · revision {evidence.revisionId ?? "unavailable"}</li>)}</ul>}
          </li>)}</ul>
          <details><summary>Exact observation receipt</summary><pre>{JSON.stringify(receipt, null, 2)}</pre></details>
        </li>;
      })}</ol>}
      <p className={styles.support}>{value.coverage.returned} newest receipts shown, limit {value.coverage.limit}. Total unavailable.{value.hasMore ? " Older observations exist beyond this window." : ""}</p>
    </>}
  </section>;
}
