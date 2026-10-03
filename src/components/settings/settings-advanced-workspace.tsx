"use client";

import { useCallback, useEffect, useState } from "react";
import { AgentGrantSettingsPanel } from "@/components/agents/agent-grant-editor";
import { MODEL_ASSIGNMENT_SCOPES, type SettingsSnapshot } from "@/lib/settings/types";
import { PersonalDataControls } from "./personal-data-controls";
import { PushCanaryPanel } from "./push-canary-panel";
import { TrashRecoveryControls } from "./trash-recovery-controls";
import { AdvancedSettingsBoundary, mutationOptions, settingsJson, useAdvancedSettingsActions } from "./settings-advanced-lifecycle";
import { ApiSettings, ProviderSettings, RoutingSettings } from "./settings-advanced-editors";
import { Metadata, ReadNotice } from "./settings-advanced-ui";
import { confirmedSettingsMetadata, settingsSnapshot, settingsMutationReplayable, validateSettingsMutation, type SettingsMutation } from "./settings-advanced-state";
import { settingsSections, type SettingsSection } from "./settings-navigation";
import styles from "./settings-advanced.module.css";

// Compatibility exports used by the existing composition regressions.
export { mcpConfigurationActionBlocked, mcpConfigurationIsEditable, mcpContinuityMetadata, settingsLoadMayClearLoading, settingsLoadNeedsVerificationWarning, settingsRequestResultIsCurrent } from "./settings-advanced-state";
export type { McpConfigurationGate, SettingsLoadResult } from "./settings-advanced-state";
export { McpConfigurationSurface } from "./settings-advanced-editors";

export function AdvancedSettingsWorkspace(props: { section: SettingsSection; onNavigate: (section: SettingsSection) => void }) {
  return <AdvancedSettingsBoundary><AdvancedSettingsContent {...props} /></AdvancedSettingsBoundary>;
}
function AdvancedSettingsContent({ section, onNavigate }: { section: SettingsSection; onNavigate: (section: SettingsSection) => void }) {
  const actions = useAdvancedSettingsActions();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const [receipt, setReceipt] = useState<{ label: string; metadata: ReturnType<typeof confirmedSettingsMetadata> }>();
  const [visited, setVisited] = useState<SettingsSection[]>([section]);
  if (!visited.includes(section)) setVisited([...visited, section]);
  const readBlocked = actions.blocked("read");
  const tenantId = actions.session?.context?.tenantId;
  const actorId = actions.session?.context?.actorId;
  const load = useCallback(async () => {
    if (readBlocked) return;
    const ticket = actions.gate.read("settings");
    setLoading(true); setFresh(false); setError(undefined);
    try {
      const value = settingsSnapshot(await settingsJson("/api/settings?ownerScope=readable", { signal: ticket.signal }), { tenantId, actorId });
      if (ticket.current()) { setSnapshot(value); setFresh(true); }
      else if (ticket.owned()) setError("The read was interrupted by a settings action. Refresh to verify current configuration.");
    } catch (failure) {
      if (ticket.owned()) setError(ticket.current() ? failure instanceof Error ? failure.message : "Settings could not be checked." : "The read was interrupted by a settings action. Refresh to verify current configuration.");
    } finally { if (ticket.owned()) setLoading(false); }
  }, [actions.gate, readBlocked, tenantId, actorId]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  const perform = async (request: SettingsMutation) => {
    const permission = actions.blocked("manage.connector");
    if (permission || !fresh || loading || !snapshot) {
      setLocalError(permission || "Refresh settings before changing a last-loaded configuration."); return;
    }
    setLocalError(undefined);
    const result = await actions.run({
      label: request.label, permission: "manage.connector", fingerprint: JSON.stringify([request.kind, request.path, request.body, request.id, request.credentialVersion]),
      replayable: settingsMutationReplayable(request.kind), success: `${request.label}: response confirmed. The following read may still be unavailable.`,
      execute: async ({ idempotencyKey }) => validateSettingsMutation(await settingsJson(request.path, mutationOptions(request.method, request.body, settingsMutationReplayable(request.kind) ? idempotencyKey : undefined)), request, actions.session?.context ?? {}),
    });
    // Release the action slot before a slow or failed verification read.
    if (!actions.gate.live() || actions.gate.pending()) return;
    if (result) { setReceipt({ label: request.label, metadata: confirmedSettingsMetadata(result.value) }); setFresh(false); void load(); return result.value; }
    setFresh(false); void load();
  };
  const manageBlocked = actions.blocked("manage.connector") || (!fresh || loading ? "Refresh settings to verify current ownership before saving." : undefined);
  const providerBlocked = manageBlocked || (snapshot?.requestReadContracts?.providerConnections !== "readable_v1" ? "Provider ownership metadata is unavailable. Refresh settings." : undefined);
  const routingBlocked = providerBlocked || (snapshot?.requestReadContracts?.modelAssignments !== "readable_v1" ? "Model routing ownership metadata is unavailable. Refresh settings." : undefined);
  const title = settingsSections.find((item) => item.id === section)?.label ?? "Advanced settings";
  return <div className={`${styles.workspace} ${styles.shell}`} data-testid="advanced-settings">
    <header className={styles.header}><div><h1>Settings</h1><p>Review workspace configuration, exact identities and access boundaries before making a change.</p></div><button type="button" disabled={Boolean(actions.busy) || Boolean(readBlocked)} onClick={() => void load()}>Refresh settings</button></header>
    <nav aria-label="Settings categories" className={styles.navigation}>{settingsSections.map((item) => <button key={item.id} type="button" aria-current={item.id === section ? "page" : undefined} onClick={() => onNavigate(item.id)}>{item.label}</button>)}</nav>
    <h2>{title}</h2>
    <ReadNotice loaded={Boolean(snapshot)} loading={loading && !readBlocked} error={readBlocked || error} label="Settings" />
    {actions.busy ? <p role="status" className={styles.notice}>{actions.busy}… Work already sent to the server may continue if you leave Settings.</p> : null}
    {actions.error || localError ? <p role="alert" className={styles.error}>{actions.error || localError}</p> : null}
    {actions.notice ? <p role="status" className={styles.receipt}>{actions.notice}</p> : null}
    {receipt ? <details className={styles.receipt}><summary>Confirmed settings response · {receipt.label}</summary><p>This accepted response is retained separately from the current read state.</p><Metadata items={receipt.metadata} /></details> : null}
    {visited.includes("overview") ? <div hidden={section !== "overview"}>
      {snapshot ? <WorkspaceOverview snapshot={snapshot} onNavigate={onNavigate} /> : <p className={styles.empty}>Workspace readiness has not been verified. Counts and health are unavailable.</p>}
      <PushCanaryPanel />
    </div> : null}
    {visited.includes("providers") ? <div hidden={section !== "providers"}>{snapshot ? <ProviderSettings snapshot={snapshot} busy={Boolean(actions.busy)} blocked={providerBlocked} perform={perform} /> : <p className={styles.empty}>Provider connections could not be checked.</p>}</div> : null}
    {visited.includes("models") ? <div hidden={section !== "models"}>{snapshot ? <RoutingSettings snapshot={snapshot} busy={Boolean(actions.busy)} blocked={routingBlocked} providerBlocked={providerBlocked} perform={perform} /> : <p className={styles.empty}>Model routing and catalogs could not be checked.</p>}</div> : null}
    {visited.includes("agents") ? <div hidden={section !== "agents"} className={styles.section}>
      <p className={styles.support}>Agent release, evaluation and grant controls use their own authorized reads and reviewed changes. Workspace provider availability does not determine Agent authority.</p>
      <AgentGrantSettingsPanel />
    </div> : null}
    {visited.includes("api") ? <div hidden={section !== "api"}>{snapshot ? <ApiSettings snapshot={snapshot} busy={Boolean(actions.busy)} blocked={manageBlocked} mcpGate={{ loading, snapshotFresh: fresh, requestReadContract: snapshot.requestReadContracts?.mcpExportConfiguration, manageable: snapshot.mcp.manageable, permissionBlocked: actions.blocked("manage.connector") }} perform={perform} /> : <p className={styles.empty}>API keys and MCP policy could not be checked.</p>}</div> : null}
    {visited.includes("data") ? <section hidden={section !== "data"} className={styles.section} aria-label="Data and privacy controls">
      <h3>Ownership and portability</h3><p>Export personal records or restore an archive through the existing authorized recovery services. Service credentials are not portable authority.</p>
      <Metadata items={[{ label: "Credential storage", value: snapshot ? snapshot.vault.message : "Vault readiness unavailable" }, { label: "Service tokens", value: "Only token hashes and redacted identities are retained. A complete token is shown once." }]} />
      <PersonalDataControls /><TrashRecoveryControls />
    </section> : null}
  </div>;
}
function WorkspaceOverview({ snapshot, onNavigate }: { snapshot: SettingsSnapshot; onNavigate: (section: SettingsSection) => void }) {
  const managed = snapshot.providers.filter((provider) => provider.source === "tenant_vault" && provider.manageable && provider.status !== "revoked");
  return <section className={styles.section} aria-label="Workspace readiness">
    <h3>Configuration at a glance</h3>
    <Metadata items={[
      { label: "Authentication", value: snapshot.platform.authEnforced ? "Enforced" : "Development mode" },
      { label: "Bootstrap credentials", value: snapshot.platform.bootstrapConfigured ? "Configured; remove after establishing an administrator" : "Not configured" },
      { label: "Storage", value: `${snapshot.platform.storageBackend} · ${snapshot.platform.databaseConfigured ? "database configured" : "database not configured"}` },
      { label: "Credential vault", value: snapshot.vault.configured ? "Configured" : "Setup required" },
      { label: "Active keyring ID", value: snapshot.vault.activeKeyId || "Not reported" },
      { label: "Manageable provider connections", value: managed.length },
      { label: "Retained provider connections", value: snapshot.providers.filter((provider) => provider.source === "tenant_vault" && !provider.manageable).length },
      { label: "Environment providers", value: snapshot.providers.filter((provider) => provider.source === "deployment_environment").length },
      { label: "Configured model roles", value: `${snapshot.assignments.filter((assignment) => assignment.manageable).length} of ${MODEL_ASSIGNMENT_SCOPES.length}` },
      { label: "Active service keys", value: snapshot.apiKeys.filter((key) => key.status === "active").length },
      { label: "MCP", value: `${snapshot.mcp.enabled ? "Enabled" : "Disabled"} · ${snapshot.mcp.serverName}` },
      { label: "Release revision", value: snapshot.platform.releaseRevision || "Not reported" },
    ]} />
    <p>{snapshot.vault.message}</p><p>{snapshot.runtime.message}</p>
    {snapshot.platform.storageBackend === "ephemeral" ? <p className={styles.warning}>Ephemeral storage is not durable. Configure production storage before relying on saved settings.</p> : null}
    <div className={styles.actions}><button type="button" onClick={() => onNavigate("providers")}>Review providers</button><button type="button" onClick={() => onNavigate("models")}>Review model routing</button><button type="button" onClick={() => onNavigate("api")}>Review API and MCP access</button></div>
  </section>;
}
