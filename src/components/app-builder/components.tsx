import type { BuilderActionOutcome } from "./client";
import type { BuilderDeployment, BuilderRelease, BuilderSession, BuilderVerification, SessionPayload } from "./model";
import { safeExternalUrl } from "./state";
import styles from "../app-builder-studio.module.css";

export function BuilderOutcome({ outcome, refreshFailed, reviewed, onReview }: { outcome?: BuilderActionOutcome; refreshFailed: boolean; reviewed: boolean; onReview: () => void }) {
  if (!outcome || outcome.state === "pending") return null;
  return <section className={styles.outcome} data-state={outcome.state} aria-label="Builder action response" role="status">
    <strong>{outcome.state === "accepted" ? "Action response received" : outcome.state === "uncertain" ? "Action outcome uncertain" : "Action rejected"} · {outcome.action}</strong>
    <p>{outcome.state === "accepted" ? refreshFailed ? "The action returned successfully. Refresh failed afterward; this accepted response is retained independently of the stale workspace snapshot." : "The server returned this action response. Inspect its exact records and evidence below." : outcome.state === "uncertain" ? "The response does not establish whether the action completed. No request has been retried. Refresh the workspace, then inspect Activity and provider evidence before making another decision." : outcome.detail}</p>
    <details><summary>Exact submitted targets</summary><dl><dt>Request key</dt><dd><code>{outcome.key}</code></dd>{outcome.targets.map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{value}</code></dd></div>)}{outcome.receiptSha256 ? <><dt>Service receipt digest</dt><dd><code>{outcome.receiptSha256}</code></dd></> : null}</dl></details>
    {outcome.state === "uncertain" ? <button type="button" onClick={onReview} disabled={!reviewed}>I inspected the refreshed state; allow a new decision</button> : null}
  </section>;
}

function Choice<T extends { id: string }>({ label, rows, value, choose }: { label: string; rows: readonly T[]; value: string; choose: (id: string) => void }) {
  const missing = value && !rows.some((row) => row.id === value);
  const id = `builder-${label.toLowerCase().replaceAll(" ", "-")}`;
  return <div className={styles.recordChoice}><label htmlFor={id}>{label}</label><select id={id} value={value} onChange={(event) => choose(event.currentTarget.value)}>
    {!value ? <option value="">{rows.length ? "Choose an exact record" : "No records in this snapshot"}</option> : null}
    {missing ? <option value={value}>Selected record unavailable · {value}</option> : null}
    {rows.map((row) => <option key={row.id} value={row.id}>{row.id}</option>)}
  </select>{missing ? <p role="status">The exact selected record is outside this bounded snapshot or is no longer available. Refresh or choose another record explicitly.</p> : null}</div>;
}
export function BuilderRecordChoices({ snapshot, deploymentId, releaseId, verificationId, chooseDeployment, chooseRelease, chooseVerification }: { snapshot: SessionPayload; deploymentId: string; releaseId: string; verificationId: string; chooseDeployment: (id: string) => void; chooseRelease: (id: string) => void; chooseVerification: (id: string) => void }) {
  return <section className={styles.recordChoices} aria-label="Exact Builder records"><p>Recent history: up to 20 deployments, 20 releases and 10 verifications. Totals and older pages are unavailable. A refresh retains your exact choices.</p>
    <Choice label="Preview deployment record" rows={snapshot.deployments} value={deploymentId} choose={chooseDeployment} />
    <Choice label="Production release record" rows={snapshot.releases} value={releaseId} choose={chooseRelease} />
    <Choice label="Verification record" rows={snapshot.verifications} value={verificationId} choose={chooseVerification} />
  </section>;
}
export function BuilderEvidence({ session, deployment, release, verification }: { session: BuilderSession; deployment?: BuilderDeployment; release?: BuilderRelease; verification?: BuilderVerification }) {
  return <section className={styles.evidenceInspector} aria-label="Selected Builder evidence"><details><summary>Inspect exact source, verification and release evidence</summary>
    <dl><dt>Sandbox</dt><dd><code>{session.id}</code> · {session.status} · revision {session.revision}</dd><dt>Current checkpoint</dt><dd><code>{session.currentCheckpointId || "No checkpoint"}</code></dd></dl>
    {verification ? <article><h4>Selected verification · {verification.status}</h4><dl><dt>Verification</dt><dd><code>{verification.id}</code></dd><dt>Checkpoint</dt><dd><code>{verification.checkpointId}</code></dd><dt>Workspace SHA-256</dt><dd><code>{verification.workspaceSha256}</code></dd></dl><p>{verification.checkpointId === session.currentCheckpointId ? "This verification targets the current checkpoint. Delivery still requires its separate passing Sentinel verdict." : "Historical verification. It does not authorize delivery of the current checkpoint."}</p><ul>{verification.checks.map((check) => <li key={check.command}>{check.command} · {check.status} · exit {check.exitCode} · {check.durationMs} ms · output <code>{check.outputSha256}</code></li>)}</ul><p>{verification.browserEvidence.replacement?.summary || "Legacy browser capture history is retired from readiness; no visual inspection is claimed."}</p></article> : <p>No exact verification is selected in the loaded snapshot.</p>}
    {deployment ? <article><h4>Selected preview · {deployment.status}</h4><dl>{Object.entries({ deployment: deployment.id, checkpoint: deployment.checkpointId, verification: deployment.verificationId, workspace: deployment.workspaceSha256, manifest: deployment.fileManifestSha256, provider: deployment.providerDeploymentId || "Not acknowledged" }).map(([name, value]) => <div key={name}><dt>{name}</dt><dd><code>{value}</code></dd></div>)}</dl><p>Build logs: {deployment.logs.status} · {deployment.logs.eventCount} events. Route checks: {deployment.routeEvidence.status}.</p><ul>{deployment.routeEvidence.routes.map((route) => <li key={route.path}><code>{route.path}</code> · {route.status} · {route.statusCode ?? route.errorCode ?? "No response"} · {route.durationMs} ms</li>)}</ul></article> : null}
    {release ? <article><h4>Selected production release · {release.status}</h4><dl><dt>Release</dt><dd><code>{release.id}</code></dd><dt>Reviewed preview</dt><dd><code>{release.deploymentId}</code></dd><dt>Exact digest</dt><dd><code>{release.releaseDigest}</code></dd><dt>Review expiry</dt><dd>{new Date(release.expiresAt).toLocaleString()}</dd><dt>Recorded rollback target</dt><dd><code>{release.rollbackEvidence.providerDeploymentId || "First release; no previous production target"}</code></dd></dl><p>Rollback evidence records the previous production target. This API does not expose a rollback action; no rollback has been requested.</p>{safeExternalUrl(release.rollbackEvidence.deploymentUrl) ? <a href={safeExternalUrl(release.rollbackEvidence.deploymentUrl)} target="_blank" rel="noopener noreferrer">Inspect recorded rollback deployment</a> : null}</article> : null}
  </details></section>;
}
