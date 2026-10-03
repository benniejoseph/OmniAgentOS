"use client";

import { useState } from "react";
import { commandReasoningOptionsForModel } from "@/lib/models/reasoning-effort";
import {
  MODEL_ASSIGNMENT_SCOPES, MODEL_PROVIDERS, SERVICE_API_SCOPES, SPECIALIZED_MODEL_ASSIGNMENT_SCOPES,
  type McpExportConfiguration, type ModelAssignmentScope, type RequestModelAssignment, type RequestModelCatalogEntry,
  type RequestProviderConnection, type ServiceApiScope, type SettingsModelProvider, type SettingsSnapshot,
} from "@/lib/settings/types";
import { mcpConfigurationActionBlocked, mcpContinuityMetadata, object, reconcileSettingsDraft, settingsVersion, type McpConfigurationGate, type SettingsMutation } from "./settings-advanced-state";
import { useAdvancedSettingsActions } from "./settings-advanced-lifecycle";
import { Metadata, SettingsCheck, SettingsDialog, SettingsField } from "./settings-advanced-ui";
import styles from "./settings-advanced.module.css";

type Perform = (request: SettingsMutation) => Promise<Record<string, unknown> | undefined>;
type Common = { snapshot: SettingsSnapshot; busy: boolean; blocked?: string; perform: Perform };
const providerNames: Record<SettingsModelProvider, string> = { openai: "OpenAI", google: "Google Gemini", anthropic: "Anthropic", aws_bedrock: "AWS Bedrock", typesafe: "TypeSafe" };
const providerFields: Record<SettingsModelProvider, Array<{ name: string; label: string; secret?: boolean; optional?: boolean }>> = {
  openai: [{ name: "apiKey", label: "API key", secret: true }], google: [{ name: "apiKey", label: "Gemini API key", secret: true }],
  anthropic: [{ name: "apiKey", label: "API key", secret: true }], typesafe: [{ name: "apiKey", label: "TypeSafe API key", secret: true }],
  aws_bedrock: [{ name: "accessKeyId", label: "Access key ID" }, { name: "secretAccessKey", label: "Secret access key", secret: true }, { name: "region", label: "Region" }, { name: "sessionToken", label: "Session token (optional)", secret: true, optional: true }],
};
const roleNames: Record<ModelAssignmentScope, string> = {
  main_agent: "Main agent", orchestrator: "Orchestrator", planner: "Planner", verifier: "Verifier", council: "Agent council", market_research: "Market research",
  code_builder: "Code builder", memory: "Memory reasoning", embeddings: "Embeddings", vision: "Vision", audio: "Audio transcription", audio_diarization: "Speaker diarization",
  web_search: "Web search", image_generation: "Image generation", video_generation: "Video generation", computer_use: "Computer use", speech_synthesis: "Speech synthesis",
  realtime_transcription: "Realtime transcription", semantic_decision: "Semantic decisions",
};

function useBoundDraft<T>(source: string, seed: T) {
  const [state, setState] = useState({ observed: source, basis: source, original: seed, draft: seed });
  const dirty = settingsVersion(state.original) !== settingsVersion(state.draft);
  if (state.observed !== source) setState(reconcileSettingsDraft(state, source, seed));
  return {
    draft: state.draft, dirty, conflict: state.basis !== source,
    edit: (draft: T) => setState((previous) => ({ ...previous, draft })),
    reset: () => setState({ observed: source, basis: source, original: seed, draft: seed }),
    review: () => setState((previous) => ({ ...previous, basis: source, observed: source })),
    accepted: (draft: T) => setState({ observed: source, basis: source, original: draft, draft }),
  };
}
function DraftState({ dirty, conflict, busy, reset, review }: { dirty: boolean; conflict: boolean; busy: boolean; reset: () => void; review: () => void }) {
  return <div className={styles.notice}>
    <p role="status">{conflict ? "The saved configuration changed. Your draft is retained, but saving is blocked until you review the current source." : dirty ? "Unsaved changes" : "No unsaved changes"}</p>
    {dirty || conflict ? <div className={styles.actions}><button type="button" disabled={busy} onClick={reset}>Discard draft and load current values</button>{conflict ? <button type="button" disabled={busy} onClick={review}>I reviewed the current version; keep my draft</button> : null}</div> : null}
  </div>;
}

export function ProviderSettings({ snapshot, busy, blocked, perform }: Common) {
  const actions = useAdvancedSettingsActions();
  const [setup, setSetup] = useState<{ provider: SettingsModelProvider; connection?: RequestProviderConnection; prior?: RequestProviderConnection }>();
  const [confirmation, setConfirmation] = useState<RequestProviderConnection>();
  const [page, setPage] = useState(0);
  const start = Math.min(page * 12, Math.max(0, Math.floor((snapshot.providers.length - 1) / 12) * 12));
  const invoke = (connection: RequestProviderConnection, kind: "provider.validate" | "provider.update" | "provider.revoke") => {
    if (busy || blocked || !connection.manageable || connection.source !== "tenant_vault") return Promise.resolve(undefined);
    return perform({ kind, id: connection.id, provider: connection.provider, label: kind === "provider.validate" ? `Validate ${connection.label}` : kind === "provider.revoke" ? `Revoke ${connection.label}` : `${connection.enabled ? "Disable" : "Enable"} ${connection.label}`,
      path: `/api/settings/providers/${encodeURIComponent(connection.id)}${kind === "provider.validate" ? "/validate" : ""}`, method: kind === "provider.validate" ? "POST" : kind === "provider.revoke" ? "DELETE" : "PATCH", body: kind === "provider.update" ? { enabled: !connection.enabled } : undefined });
  };
  const currentConfirmation = snapshot.providers.find((item) => item.id === confirmation?.id);
  const revokeChanged = settingsVersion(currentConfirmation) !== settingsVersion(confirmation);
  return <section className={styles.section} aria-label="AI providers">
    <h3>Credentials and model catalogs</h3><p>Each connection keeps its own owner, status and credential version. Environment credentials are managed in the deployment platform; retained connections are read only.</p>
    <p className={styles.support}>{snapshot.vault.message}</p>{blocked ? <p className={styles.warning}>{blocked}</p> : null}
    <div className={styles.actions}>{MODEL_PROVIDERS.map((provider) => {
      const existing = snapshot.providers.find((item) => item.provider === provider && item.manageable && item.source === "tenant_vault");
      return <button key={provider} type="button" disabled={busy || Boolean(blocked) || !snapshot.vault.configured || Boolean(existing && existing.status !== "revoked")} onClick={() => setSetup({ provider, prior: existing })}>{existing?.status === "revoked" ? "Reconnect" : "Connect"} {providerNames[provider]}</button>;
    })}</div><p className={styles.support}>Use the exact connection&apos;s Rotate control to replace an existing credential.</p>
    <p className={styles.support}>TypeSafe classifications remain evaluation-only and never control execution.</p>
    <p>{snapshot.providers.length} connection{snapshot.providers.length === 1 ? "" : "s"} in the loaded snapshot</p>
    <ul className={styles.rows}>{snapshot.providers.slice(start, start + 12).map((connection) => <li key={connection.id} className={styles.panel}>
      <h4>{connection.label} · {providerNames[connection.provider]}</h4><p>{connection.status.replaceAll("_", " ")} · {connection.enabled ? "Enabled" : "Disabled"}</p>
      <Metadata items={[{ label: "Connection ID", value: connection.id }, { label: "Tenant ID", value: connection.tenantId }, { label: "Owner actor ID", value: connection.actorId },
        { label: "Source", value: connection.source }, { label: "Credential version", value: connection.credentialVersion ?? "Not reported" }, { label: "Fingerprint", value: connection.credentialFingerprint || "Not reported" },
        { label: "Configured fields", value: connection.configuredFields.join(" · ") || "None reported" }, { label: "Runtime readiness", value: connection.runtimeReadiness },
        { label: "Last validation", value: connection.lastValidatedAt || "Not reported" }, { label: "Validation result", value: connection.validationCode || "Not reported" },
        { label: "Catalog refreshed", value: connection.catalogRefreshedAt || "Not reported" }, { label: "Last changed", value: connection.updatedAt || "Not reported" }]} />
      <p>{connection.runtimeNote}</p>
      {connection.manageable && connection.source === "tenant_vault" && connection.status !== "revoked" ? <div className={styles.actions}>
        <button type="button" disabled={busy || Boolean(blocked)} onClick={() => void invoke(connection, "provider.validate")}>Validate {connection.label}</button>
        <button type="button" disabled={busy || Boolean(blocked) || !snapshot.vault.configured} onClick={() => setSetup({ provider: connection.provider, connection })}>Rotate {connection.label}</button>
        <button type="button" disabled={busy || Boolean(blocked)} onClick={() => void invoke(connection, "provider.update")}>{connection.enabled ? "Disable" : "Enable"} {connection.label}</button>
        <button type="button" disabled={busy || Boolean(blocked)} onClick={() => setConfirmation(connection)}>Revoke {connection.label}</button>
      </div> : <p className={styles.support}>{connection.source === "deployment_environment" ? "Managed by the deployment environment" : connection.status === "revoked" ? "Revoked connection" : "Retained connection · read only"}</p>}
    </li>)}</ul>
    {!snapshot.providers.length ? <p className={styles.empty}>No provider connections were returned by this successful read.</p> : null}
    <div className={styles.pagination}><button type="button" disabled={!start} onClick={() => setPage(Math.max(0, start / 12 - 1))}>Previous connections</button><span>{snapshot.providers.length ? `${start + 1}–${Math.min(start + 12, snapshot.providers.length)}` : "0–0"} of {snapshot.providers.length}</span><button type="button" disabled={start + 12 >= snapshot.providers.length} onClick={() => setPage(start / 12 + 1)}>Next connections</button></div>
    {setup ? <ProviderSetup key={setup.connection?.id || setup.provider} setup={setup} current={setup.connection ? snapshot.providers.find((item) => item.id === setup.connection?.id) : snapshot.providers.find((item) => item.provider === setup.provider && item.manageable && item.source === "tenant_vault")} busy={busy} blocked={blocked || (!snapshot.vault.configured ? "The credential vault is unavailable." : undefined)} onClose={() => setSetup(undefined)} perform={perform} /> : null}
    {confirmation ? <SettingsDialog title={`Revoke ${confirmation.label}`} busy={busy} onClose={() => setConfirmation(undefined)}>
      <p>This scrubs the stored credential for the exact connection below. Dependent routing may stop working.</p><Metadata items={[{ label: "Connection ID", value: confirmation.id }, { label: "Credential version", value: confirmation.credentialVersion ?? "Not reported" }, { label: "Owner", value: confirmation.actorId }]} />
      {revokeChanged ? <p role="alert" className={styles.error}>This connection changed. Close this review and inspect its current version.</p> : null}
      {actions.error ? <p role="alert" className={styles.error}>{actions.error}</p> : null}
      <button type="button" disabled={busy || Boolean(blocked) || revokeChanged} onClick={async () => { if (!revokeChanged && await invoke(confirmation, "provider.revoke")) setConfirmation(undefined); }}>Confirm revoke connection</button>
    </SettingsDialog> : null}
  </section>;
}
function ProviderSetup({ setup, current, busy, blocked, perform, onClose }: { setup: { provider: SettingsModelProvider; connection?: RequestProviderConnection; prior?: RequestProviderConnection }; current?: RequestProviderConnection; busy: boolean; blocked?: string; perform: Perform; onClose: () => void }) {
  const actions = useAdvancedSettingsActions();
  const [label, setLabel] = useState(setup.connection?.label ?? setup.prior?.label ?? providerNames[setup.provider]);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const changed = settingsVersion(setup.connection ?? setup.prior) !== settingsVersion(current);
  const complete = label.trim() && providerFields[setup.provider].every((field) => field.optional || credentials[field.name]?.trim());
  const title = `${setup.connection ? "Rotate" : setup.prior ? "Reconnect" : "Connect"} ${providerNames[setup.provider]}`;
  return <SettingsDialog title={title} busy={busy} onClose={onClose}>
    <p>Credentials are sealed by the server and never returned. This form holds unsaved values only in this mounted view.</p>
    {setup.connection || setup.prior ? <Metadata items={[{ label: "Connection ID", value: (setup.connection ?? setup.prior)?.id }, { label: "Reviewed credential version", value: (setup.connection ?? setup.prior)?.credentialVersion ?? "Not reported" }]} /> : null}
    {blocked || changed ? <p role="alert" className={styles.error}>{changed ? "This connection changed. Close this form and review the current identity before rotating." : blocked}</p> : null}
    {actions.error ? <p role="alert" className={styles.error}>{actions.error}</p> : null}
    <form onSubmit={async (event) => {
      event.preventDefault(); if (busy || blocked || changed || !complete) return;
      const connection = setup.connection;
      const value = await perform({ kind: connection ? "provider.rotate" : "provider.create", label: title, id: connection?.id ?? setup.prior?.id, provider: setup.provider, credentialVersion: connection?.credentialVersion ?? setup.prior?.credentialVersion,
        path: connection ? `/api/settings/providers/${encodeURIComponent(connection.id)}/rotate` : "/api/settings/providers", method: "POST",
        body: connection ? { credentials: { ...credentials }, validateNow: true } : { provider: setup.provider, label: label.trim(), credentials: { ...credentials }, validateNow: true } });
      if (value) onClose();
    }}>
      <fieldset disabled={busy} className={styles.fields}>
        {!setup.connection ? <SettingsField label="Connection name"><input value={label} maxLength={120} required onChange={(event) => setLabel(event.target.value)} /></SettingsField> : null}
        {providerFields[setup.provider].map((field) => <SettingsField key={field.name} label={field.label}><span className={styles.secret}><input aria-label={field.label} type={field.secret && !visible[field.name] ? "password" : "text"} value={credentials[field.name] ?? ""} maxLength={8192} required={!field.optional} autoComplete="off" spellCheck={false} onChange={(event) => setCredentials({ ...credentials, [field.name]: event.target.value })} />{field.secret ? <button type="button" aria-label={`${visible[field.name] ? "Hide" : "Show"} ${field.label}`} onClick={() => setVisible({ ...visible, [field.name]: !visible[field.name] })}>{visible[field.name] ? "Hide" : "Show"}</button> : null}</span></SettingsField>)}
      </fieldset>
      <button className={styles.primary} type="submit" disabled={busy || Boolean(blocked) || changed || !complete}>{busy ? "Request pending…" : setup.connection ? "Rotate and validate" : "Save and validate"}</button>
    </form>
  </SettingsDialog>;
}

type AssignmentDraft = { provider: SettingsModelProvider | ""; modelId: string; fallbackProvider: SettingsModelProvider | ""; fallbackModelId: string; consent: boolean };
function assignmentDraft(current?: RequestModelAssignment): AssignmentDraft { return { provider: current?.provider ?? "", modelId: current?.modelId ?? "", fallbackProvider: current?.fallbackProvider ?? "", fallbackModelId: current?.fallbackModelId ?? "", consent: current?.allowCrossProviderFallback ?? false }; }
export function RoutingSettings({ snapshot, busy, blocked, providerBlocked, perform }: Common & { providerBlocked?: string }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const filtered = snapshot.models.filter((model) => `${model.displayName} ${model.displayModelId} ${model.provider}`.toLowerCase().includes(query.trim().toLowerCase()));
  const start = Math.min(page * 12, Math.max(0, Math.floor((filtered.length - 1) / 12) * 12));
  return <section className={styles.section} aria-label="Model routing controls">
    <h3>Assign a validated model to each role</h3><p>{snapshot.runtime.message}</p><p className={styles.support}>Saved configuration and evidence of an actual runtime call are shown separately. Semantic decisions remain shadow-only.</p>
    {blocked ? <p className={styles.warning}>{blocked}</p> : null}
    <details><summary>Refresh provider catalogs</summary><p>Each validation is an explicit provider request. Select the exact connection to validate.</p><div className={styles.actions}>{snapshot.providers.filter((item) => item.manageable && item.source === "tenant_vault" && item.status !== "revoked").map((connection) => <button key={connection.id} type="button" disabled={busy || Boolean(providerBlocked)} onClick={() => void perform({ kind: "provider.validate", label: `Validate ${connection.label}`, id: connection.id, provider: connection.provider, path: `/api/settings/providers/${encodeURIComponent(connection.id)}/validate`, method: "POST" })}>Validate {connection.label}</button>)}</div>{providerBlocked ? <p>{providerBlocked}</p> : null}</details>
    {MODEL_ASSIGNMENT_SCOPES.map((scope) => {
      const acknowledged = snapshot.requestReadContracts?.modelAssignments === "readable_v1";
      const current = acknowledged ? snapshot.assignments.find((item) => item.scope === scope && item.manageable) : undefined;
      const retained = snapshot.assignments.filter((item) => item.scope === scope && (!item.manageable || !acknowledged));
      return <section key={scope} className={styles.panel} aria-label={`${roleNames[scope]} routing`}>
        <h4>{roleNames[scope]}</h4>
        {retained.map((assignment) => <details key={assignment.id}><summary>Retained route · read only</summary><AssignmentMetadata assignment={assignment} /><p>This route remains visible for continuity. It cannot be edited from this session or supply current-owner consent.</p></details>)}
        <AssignmentEditor key={scope} scope={scope} snapshot={snapshot} current={current} busy={busy} blocked={blocked} perform={perform} />
      </section>;
    })}
    <section className={styles.panel} aria-label="Discovered models"><h3>Discovered models</h3><p>Lifecycle is unknown unless the provider reports a reliable state. Only selectable models may be saved.</p>
      <SettingsField label="Search model catalog"><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></SettingsField>
      <ul className={styles.rows}>{filtered.slice(start, start + 12).map((model) => <li key={model.id} className={styles.panel}><h4>{model.displayName}</h4><Metadata items={[
        { label: "Catalog ID", value: model.id }, { label: "Model", value: model.displayModelId }, { label: "Provider", value: providerNames[model.provider] }, { label: "Owner", value: model.actorId },
        { label: "Capabilities", value: model.capabilities.join(" · ") || "Not reported" }, { label: "Lifecycle", value: model.lifecycle }, { label: "Checked", value: model.lifecycleCheckedAt || "Not reported" },
        { label: "Selection", value: model.selectable ? "Selectable" : "Retained · read only" }, { label: "Thinking", value: commandReasoningOptionsForModel(model.provider, model.modelId).map((option) => option.label).join(" · ") || "Provider default" },
      ]} />{model.lifecycleReason ? <p>{model.lifecycleReason}</p> : null}</li>)}</ul>
      {!filtered.length ? <p className={styles.empty}>{snapshot.models.length ? "No catalog models match this search." : "No models were returned in the successful catalog read."}</p> : null}
      <div className={styles.pagination}><button type="button" disabled={!start} onClick={() => setPage(start / 12 - 1)}>Previous models</button><span>{filtered.length ? `${start + 1}–${Math.min(start + 12, filtered.length)}` : "0–0"} of {filtered.length}</span><button type="button" disabled={start + 12 >= filtered.length} onClick={() => setPage(start / 12 + 1)}>Next models</button></div>
    </section>
  </section>;
}
function AssignmentMetadata({ assignment }: { assignment: RequestModelAssignment }) {
  return <Metadata items={[{ label: "Assignment ID", value: assignment.id }, { label: "Owner", value: assignment.actorId }, { label: "Revision", value: assignment.revision }, { label: "Configuration digest", value: assignment.configurationSha256 || "Legacy; digest not reported" },
    { label: "Primary", value: `${assignment.provider} · ${assignment.displayModelId}` }, { label: "Fallback", value: assignment.fallbackProvider ? `${assignment.fallbackProvider} · ${assignment.displayFallbackModelId || "Unsupported model identifier"}` : "None" },
    { label: "Cross-provider consent", value: assignment.allowCrossProviderFallback ? "Recorded" : "Not recorded" }, { label: "Runtime readiness", value: assignment.runtimeReadiness }, { label: "Updated", value: assignment.updatedAt }]} />;
}
function AssignmentEditor({ scope, snapshot, current, busy, blocked, perform }: Common & { scope: ModelAssignmentScope; current?: RequestModelAssignment }) {
  const draft = useBoundDraft(settingsVersion(current), assignmentDraft(current));
  const value = draft.draft;
  const specialized = SPECIALIZED_MODEL_ASSIGNMENT_SCOPES.includes(scope as typeof SPECIALIZED_MODEL_ASSIGNMENT_SCOPES[number]);
  const providers = MODEL_PROVIDERS.filter((provider) => snapshot.providers.some((connection) => connection.provider === provider && connection.manageable && connection.source === "tenant_vault" && connection.enabled && connection.status === "connected"));
  const models = snapshot.models.filter((model) => model.selectable && modelSupportsUiRole(scope, model));
  const primaryValid = providers.includes(value.provider as SettingsModelProvider) && models.some((model) => model.provider === value.provider && model.modelId === value.modelId);
  const fallbackValid = !value.fallbackProvider && !value.fallbackModelId || !specialized && providers.includes(value.fallbackProvider as SettingsModelProvider) && models.some((model) => model.provider === value.fallbackProvider && model.modelId === value.fallbackModelId);
  const cross = Boolean(value.fallbackProvider) && value.fallbackProvider !== value.provider;
  const valid = primaryValid && fallbackValid && (!cross || value.consent);
  const receipt = snapshot.runtime.receipts.find((item) => current && item.assignmentId === current.id && item.assignmentRevision === current.revision && item.assignmentConfigurationSha256 === current.configurationSha256 && item.scope === scope);
  return <div>
    {current ? <><AssignmentMetadata assignment={current} /><p>{current.runtimeNote}</p>{receipt ? <Metadata items={[{ label: "Actual call outcome", value: receipt.state }, { label: "Actual provider and model", value: `${receipt.provider} · ${receipt.model}` }, { label: "Fallback used", value: receipt.fallbackUsed ? "Yes" : "No" }, { label: "Recorded", value: receipt.recordedAt }]} /> : <p className={styles.support}>No runtime receipt for this exact revision yet.</p>}</> : <p className={styles.support}>No manageable assignment is recorded; deployment routing remains in effect.</p>}
    <DraftState {...draft} busy={busy} />
    <fieldset disabled={busy} className={styles.fields}>
      <SettingsField label={`${roleNames[scope]} primary provider`}><select value={value.provider} onChange={(event) => draft.edit({ ...value, provider: event.target.value as AssignmentDraft["provider"], modelId: "", consent: false })}><option value="">Choose provider</option>{value.provider && !providers.includes(value.provider) ? <option value={value.provider}>{providerNames[value.provider]} · unavailable</option> : null}{providers.map((provider) => <option key={provider} value={provider}>{providerNames[provider]}</option>)}</select></SettingsField>
      <SettingsField label={`${roleNames[scope]} primary model`}><select value={value.modelId} onChange={(event) => draft.edit({ ...value, modelId: event.target.value })}><option value="">Choose a validated model</option>{value.modelId && !models.some((model) => model.provider === value.provider && model.modelId === value.modelId) ? <option value={value.modelId}>{value.modelId} · unavailable</option> : null}{models.filter((model) => model.provider === value.provider).map((model) => <option key={model.id} value={model.modelId}>{model.displayName} · {model.displayModelId} · {model.lifecycle}</option>)}</select></SettingsField>
      {!specialized ? <><SettingsField label={`${roleNames[scope]} fallback provider`}><select value={value.fallbackProvider} onChange={(event) => draft.edit({ ...value, fallbackProvider: event.target.value as AssignmentDraft["fallbackProvider"], fallbackModelId: "", consent: false })}><option value="">No fallback</option>{value.fallbackProvider && !providers.includes(value.fallbackProvider) ? <option value={value.fallbackProvider}>{providerNames[value.fallbackProvider]} · unavailable</option> : null}{providers.map((provider) => <option key={provider} value={provider}>{providerNames[provider]}</option>)}</select></SettingsField><SettingsField label={`${roleNames[scope]} fallback model`}><select value={value.fallbackModelId} disabled={!value.fallbackProvider} onChange={(event) => draft.edit({ ...value, fallbackModelId: event.target.value })}><option value="">Choose a validated model</option>{value.fallbackModelId && !models.some((model) => model.provider === value.fallbackProvider && model.modelId === value.fallbackModelId) ? <option value={value.fallbackModelId}>{value.fallbackModelId} · unavailable</option> : null}{models.filter((model) => model.provider === value.fallbackProvider).map((model) => <option key={model.id} value={model.modelId}>{model.displayName} · {model.displayModelId}</option>)}</select></SettingsField></> : null}
    </fieldset>
    {specialized ? <p className={styles.support}>This specialized runtime accepts one validated primary model and has no executable fallback.</p> : null}
    {cross ? <SettingsCheck label={`Allow ${roleNames[scope]} cross-provider disclosure to ${value.fallbackProvider}`} checked={value.consent} disabled={busy} onChange={(consent) => draft.edit({ ...value, consent })} /> : null}
    {!valid ? <p className={styles.support}>Select available catalog models and explicitly consent to any cross-provider fallback before saving.</p> : null}
    <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || Boolean(blocked) || draft.conflict || !valid || !draft.dirty} onClick={async () => {
      if (busy || blocked || draft.conflict || !valid) return;
      const submitted = { ...value };
      const body = { scope, provider: submitted.provider, modelId: submitted.modelId, ...(submitted.fallbackProvider ? { fallbackProvider: submitted.fallbackProvider, fallbackModelId: submitted.fallbackModelId } : {}), ...(cross && submitted.consent ? { crossProviderFallbackConsent: true } : {}) };
      if (await perform({ kind: "assignment", label: `Save ${roleNames[scope]} route`, path: "/api/settings/assignments", method: "PUT", body })) draft.accepted(submitted);
    }}>Save {roleNames[scope]} route</button></div>
  </div>;
}
export function modelSupportsUiRole(scope: ModelAssignmentScope, model: Pick<RequestModelCatalogEntry, "provider" | "capabilities">) {
  const generic: SettingsModelProvider[] = ["openai", "google", "anthropic", "aws_bedrock"];
  const contract = scope === "semantic_decision" ? { providers: ["typesafe"], capabilities: ["semantic_decision"] }
    : scope === "main_agent" || scope === "code_builder" ? { providers: generic, capabilities: ["tools", "text"] }
      : scope === "orchestrator" || scope === "market_research" ? { providers: generic, capabilities: ["text"] }
        : ["planner", "verifier", "council", "memory"].includes(scope) ? { providers: ["openai", "anthropic"], capabilities: ["text"] }
          : scope === "embeddings" ? { providers: ["openai"], capabilities: ["embeddings"] }
            : scope === "vision" ? { providers: ["openai"], capabilities: ["vision"] }
              : scope === "audio" ? { providers: ["openai", "google"], capabilities: ["audio", "transcription"] }
                : scope === "image_generation" ? { providers: ["openai", "google"], capabilities: ["image"] }
                  : scope === "video_generation" ? { providers: ["google"], capabilities: ["video"] }
                    : scope === "computer_use" ? { providers: ["openai", "google"], capabilities: ["computer_use"] }
                      : scope === "speech_synthesis" ? { providers: ["openai"], capabilities: ["speech"] }
                        : scope === "web_search" ? { providers: ["openai"], capabilities: ["tools"] }
                          : { providers: ["openai"], capabilities: ["audio", "transcription"] };
  return contract.providers.includes(model.provider) && contract.capabilities.some((capability) => model.capabilities.includes(capability));
}

type McpDraft = Pick<McpExportConfiguration, "enabled" | "serverName" | "allowedScopes" | "exposeResources">;
export function ApiSettings({ snapshot, busy, blocked, mcpGate, perform }: Common & { mcpGate: McpConfigurationGate }) {
  const actions = useAdvancedSettingsActions();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ServiceApiScope[]>(["mcp:discover", "mcp:tools:list"]);
  const [expires, setExpires] = useState("");
  const [token, setToken] = useState<{ token: string; record: Record<string, unknown> }>();
  const [revoke, setRevoke] = useState<SettingsSnapshot["apiKeys"][number]>();
  const [page, setPage] = useState(0);
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const start = Math.min(page * 12, Math.max(0, Math.floor((snapshot.apiKeys.length - 1) / 12) * 12));
  const expirationValid = !expires || Number.isFinite(Date.parse(expires)) && Date.parse(expires) > checkedAt;
  const changed = revoke && settingsVersion(revoke) !== settingsVersion(snapshot.apiKeys.find((key) => key.id === revoke.id));
  return <section className={styles.section} aria-label="API and MCP access"><h3>Service identities</h3><p>Keys grant only the selected scopes and remain subject to existing governance. The complete token is shown once.</p>
    {blocked ? <p className={styles.warning}>{blocked}</p> : null}
    <form onSubmit={async (event) => {
      event.preventDefault(); if (busy || blocked || !name.trim() || !scopes.length || !expirationValid) return;
      if (expires && Date.parse(expires) <= Date.now()) { setCheckedAt(Date.now()); return; }
      const body = { name: name.trim(), scopes: [...scopes], ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}) };
      const result = await perform({ kind: "key.create", label: "Create service key", path: "/api/settings/api-keys", method: "POST", body });
      if (result && typeof result.token === "string" && object(result.record)) { setToken({ token: result.token, record: result.record }); setName(""); setExpires(""); }
    }}><fieldset disabled={busy}>
      <div className={styles.fields}><SettingsField label="Service key name"><input value={name} maxLength={120} required onChange={(event) => setName(event.target.value)} /></SettingsField><SettingsField label="Expiration (optional)"><input type="datetime-local" value={expires} onChange={(event) => setExpires(event.target.value)} /></SettingsField></div>
      <ScopeChoices label="Service key scopes" value={scopes} onChange={setScopes} />
    </fieldset>{!expirationValid ? <p className={styles.error}>Choose a future expiration.</p> : null}<div className={styles.actions}><button className={styles.primary} type="submit" disabled={busy || Boolean(blocked) || !name.trim() || !scopes.length || !expirationValid}>Create service key</button></div></form>
    <ul className={styles.rows}>{snapshot.apiKeys.slice(start, start + 12).map((key) => <li key={key.id} className={styles.panel}><h4>{key.name}</h4><Metadata items={[{ label: "Key ID", value: key.id }, { label: "Tenant ID", value: key.tenantId }, { label: "Owner", value: key.actorId }, { label: "Token preview", value: `${key.tokenPrefix}…${key.tokenLastFour}` }, { label: "Status", value: key.status }, { label: "Scopes", value: key.scopes.join(" · ") }, { label: "Created", value: key.createdAt }, { label: "Expires", value: key.expiresAt || "No expiration" }, { label: "Last used", value: key.lastUsedAt || "Not reported" }]} />{key.manageable && key.status === "active" ? <button type="button" disabled={busy || Boolean(blocked)} onClick={() => setRevoke(key)}>Revoke {key.name}</button> : <p className={styles.support}>{key.manageable ? `Key is ${key.status}.` : "Retained key · read only"}</p>}</li>)}</ul>
    {!snapshot.apiKeys.length ? <p className={styles.empty}>No service keys were returned by this successful read.</p> : null}
    <div className={styles.pagination}><button type="button" disabled={!start} onClick={() => setPage(start / 12 - 1)}>Previous keys</button><span>{snapshot.apiKeys.length ? `${start + 1}–${Math.min(start + 12, snapshot.apiKeys.length)}` : "0–0"} of {snapshot.apiKeys.length}</span><button type="button" disabled={start + 12 >= snapshot.apiKeys.length} onClick={() => setPage(start / 12 + 1)}>Next keys</button></div>
    <McpConfigurationSurface config={snapshot.mcp} gate={mcpGate} busy={busy} onSave={(body) => perform({ kind: "mcp", label: "Save MCP policy", path: "/api/settings/mcp", method: "PUT", body })} />
    {token ? <TokenDialog token={token.token} record={token.record} onClose={() => setToken(undefined)} /> : null}
    {revoke ? <SettingsDialog title={`Revoke ${revoke.name}`} busy={busy} onClose={() => setRevoke(undefined)}><p>This prevents future use of the exact service key. The key cannot be recovered.</p><Metadata items={[{ label: "Key ID", value: revoke.id }, { label: "Owner", value: revoke.actorId }, { label: "Scopes", value: revoke.scopes.join(" · ") }]} />{changed ? <p className={styles.error}>The key changed. Close this review and inspect its current state.</p> : null}{actions.error ? <p role="alert" className={styles.error}>{actions.error}</p> : null}<button type="button" disabled={busy || Boolean(blocked) || Boolean(changed)} onClick={async () => { if (!changed && !blocked && !busy && await perform({ kind: "key.revoke", label: `Revoke ${revoke.name}`, id: revoke.id, path: `/api/settings/api-keys/${encodeURIComponent(revoke.id)}`, method: "DELETE" })) setRevoke(undefined); }}>Confirm revoke key</button></SettingsDialog> : null}
  </section>;
}
function ScopeChoices({ label, value, onChange, disabled }: { label: string; value: ServiceApiScope[]; onChange: (scopes: ServiceApiScope[]) => void; disabled?: boolean }) {
  return <fieldset disabled={disabled}><legend>{label}</legend><div className={styles.checkGrid}>{SERVICE_API_SCOPES.map((scope) => <SettingsCheck key={scope} label={scope} checked={value.includes(scope)} disabled={disabled} onChange={(checked) => onChange(checked ? [...value, scope] : value.filter((item) => item !== scope))} />)}</div></fieldset>;
}
export function McpConfigurationSurface({ config, gate, busy, onSave }: { config: McpExportConfiguration; gate: McpConfigurationGate; busy: boolean; onSave: (draft: McpDraft) => Promise<unknown> }) {
  const seed: McpDraft = { enabled: config.enabled, serverName: config.serverName, allowedScopes: [...config.allowedScopes], exposeResources: config.exposeResources };
  // Never seed editable controls with a retained owner's policy.
  return gate.manageable === true && gate.requestReadContract === "readable_v1" ? <McpEditor config={config} seed={seed} gate={gate} busy={busy} onSave={onSave} /> : <section className={styles.panel} aria-label="Retained MCP policy"><h3>Retained MCP policy</h3><p>This policy cannot be edited from this session. It may still govern service keys owned by the retained identity.</p><Metadata items={mcpContinuityMetadata(config)} /><Metadata items={[{ label: "Owner", value: config.actorId }, { label: "Tenant ID", value: config.tenantId }, { label: "Updated", value: config.updatedAt }]} /><p>Approval mode remains governed. {mcpConfigurationActionBlocked(gate)}</p></section>;
}
function McpEditor({ config, seed, gate, busy, onSave }: { config: McpExportConfiguration; seed: McpDraft; gate: McpConfigurationGate; busy: boolean; onSave: (draft: McpDraft) => Promise<unknown> }) {
  const draft = useBoundDraft(settingsVersion(config), seed);
  const blocked = mcpConfigurationActionBlocked(gate);
  const value = draft.draft;
  return <section className={styles.panel} aria-label="MCP export policy"><h3>MCP export policy</h3><p>Endpoint: /api/mcp. Approval mode remains governed. Allowed scopes are a maximum, not a bypass of key scopes or approvals.</p>
    <Metadata items={[{ label: "Owner", value: config.actorId }, { label: "Tenant ID", value: config.tenantId }, { label: "Current policy updated", value: config.updatedAt }]} />
    <details><summary>Current saved MCP policy</summary><Metadata items={mcpContinuityMetadata(config)} /></details><DraftState {...draft} busy={busy} />
    {blocked ? <p className={styles.warning}>{blocked}</p> : null}
    <fieldset disabled={busy}><div className={styles.fields}><SettingsField label="MCP server name"><input value={value.serverName} maxLength={120} onChange={(event) => draft.edit({ ...value, serverName: event.target.value })} /></SettingsField><SettingsCheck label="Enable MCP export" checked={value.enabled} onChange={(enabled) => draft.edit({ ...value, enabled })} /><SettingsCheck label="Expose resources" checked={value.exposeResources} onChange={(exposeResources) => draft.edit({ ...value, exposeResources })} /></div><ScopeChoices label="Maximum MCP scopes" value={value.allowedScopes} onChange={(allowedScopes) => draft.edit({ ...value, allowedScopes })} /></fieldset>
    <div className={styles.actions}><button className={styles.primary} type="button" disabled={busy || Boolean(blocked) || draft.conflict || !draft.dirty || !value.serverName.trim()} onClick={async () => { if (busy || blocked || draft.conflict || !value.serverName.trim()) return; const submitted = { ...value, serverName: value.serverName.trim(), allowedScopes: [...value.allowedScopes] }; if (await onSave(submitted)) draft.accepted(submitted); }}>Save MCP policy</button></div>
  </section>;
}
function TokenDialog({ token, record, onClose }: { token: string; record: Record<string, unknown>; onClose: () => void }) {
  const [copy, setCopy] = useState("");
  return <SettingsDialog title="Copy this key now" onClose={onClose}><p>This is the only time Asael displays the complete token. Store it in your client&apos;s secret manager. Closing discards the displayed value.</p><Metadata items={[{ label: "Key ID", value: String(record.id) }, { label: "Name", value: String(record.name) }]} /><code>{token}</code><div className={styles.actions}><button type="button" onClick={() => void navigator.clipboard.writeText(token).then(() => setCopy("Key copied.")).catch(() => setCopy("The key could not be copied. Select the displayed text and copy it manually."))}>Copy key</button><button type="button" onClick={onClose}>I saved the key</button></div><p role="status">{copy}</p></SettingsDialog>;
}
