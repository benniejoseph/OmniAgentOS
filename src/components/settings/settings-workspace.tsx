"use client";

import { clsx } from "clsx";
import {
  AlertCircle,
  ArrowRight,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Cloud,
  Code2,
  Copy,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LockKeyhole,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PersonalDataControls } from "@/components/settings/personal-data-controls";
import {
  MODEL_ASSIGNMENT_SCOPES,
  MODEL_PROVIDERS,
  SERVICE_API_SCOPES,
  type McpExportConfiguration,
  type ModelAssignment,
  type ModelAssignmentScope,
  type ModelCatalogEntry,
  type RedactedProviderConnection,
  type ServiceApiScope,
  type SettingsModelProvider,
  type SettingsSnapshot,
} from "@/lib/settings/types";

type SettingsSection = "overview" | "providers" | "models" | "api" | "data";
type ProviderDraft = {
  provider: SettingsModelProvider;
  label: string;
  credentials: Record<string, string>;
};

const sections: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof Settings2;
}> = [
  { id: "overview", label: "Workspace", description: "Readiness and defaults", icon: Settings2 },
  { id: "providers", label: "AI providers", description: "Credentials and catalogs", icon: Cloud },
  { id: "models", label: "Model routing", description: "Assign work by role", icon: BrainCircuit },
  { id: "api", label: "API & MCP", description: "Programmatic access", icon: Code2 },
  { id: "data", label: "Data & privacy", description: "Ownership and recovery", icon: ShieldCheck },
];

const providerDetails: Record<SettingsModelProvider, {
  name: string;
  note: string;
  fields: Array<{ name: string; label: string; placeholder: string; secret?: boolean }>;
}> = {
  openai: {
    name: "OpenAI",
    note: "Text, reasoning, tools, vision, speech, and embeddings.",
    fields: [{ name: "apiKey", label: "API key", placeholder: "sk-…", secret: true }],
  },
  google: {
    name: "Google Gemini",
    note: "Long-context multimodal models and Google-native AI.",
    fields: [{ name: "apiKey", label: "Gemini API key", placeholder: "AIza…", secret: true }],
  },
  anthropic: {
    name: "Anthropic Claude",
    note: "Claude reasoning, coding, vision, and tool use.",
    fields: [{ name: "apiKey", label: "API key", placeholder: "sk-ant-…", secret: true }],
  },
  aws_bedrock: {
    name: "AWS Bedrock",
    note: "Foundation models through your AWS identity and region.",
    fields: [
      { name: "accessKeyId", label: "Access key ID", placeholder: "AKIA…" },
      { name: "secretAccessKey", label: "Secret access key", placeholder: "••••••••", secret: true },
      { name: "region", label: "AWS region", placeholder: "us-east-1" },
      { name: "sessionToken", label: "Session token (optional)", placeholder: "Temporary session token", secret: true },
    ],
  },
};

const assignmentLabels: Record<ModelAssignmentScope, { title: string; description: string }> = {
  main_agent: { title: "Main agent", description: "Everyday conversation and direct tasks" },
  orchestrator: { title: "Orchestrator", description: "Planning, delegation, and task routing" },
  workflow: { title: "Workflow steps", description: "Durable and repeatable procedures" },
  council: { title: "Agent council", description: "Specialist review and synthesis" },
  memory: { title: "Memory reasoning", description: "Consolidation and recall decisions" },
  embeddings: { title: "Embeddings", description: "Document and memory vector indexing" },
  vision: { title: "Vision", description: "Image and visual document understanding" },
  audio: { title: "Voice & audio", description: "Transcription and speech work" },
};

export function SettingsWorkspace() {
  const [section, setSection] = useState<SettingsSection>("overview");
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>();
  const [rotateConnection, setRotateConnection] = useState<RedactedProviderConnection>();
  const [revealedToken, setRevealedToken] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      const body = await response.json() as SettingsSnapshot & { message?: string };
      if (!response.ok) throw new Error(body.message || "Settings could not be loaded.");
      setSnapshot(body);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(initialLoad);
  }, [load]);

  const request = useCallback(async <T,>(
    key: string,
    path: string,
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    body?: unknown,
  ) => {
    setBusy(key);
    setError(undefined);
    try {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({})) as T & { message?: string; error?: string };
      if (!response.ok) throw new Error(payload.message || payload.error || "The change could not be saved.");
      await load();
      return payload;
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "The change could not be saved.";
      await load();
      setError(message);
      throw requestError;
    } finally {
      setBusy(undefined);
    }
  }, [load]);

  const savedProviders = snapshot?.providers.filter((item) => item.source === "tenant_vault" && item.status !== "revoked") || [];
  const activeProviders = new Set(
    snapshot?.providers
      .filter((item) => item.status === "connected" && item.enabled)
      .map((item) => item.provider) || [],
  ).size;
  const deprecatedModels = snapshot?.models.filter((item) => item.lifecycle === "deprecated" || item.lifecycle === "retiring").length || 0;

  return (
    <div className="workspace-enter mx-auto w-full max-w-[112rem] px-4 pb-16 pt-5 sm:px-6 lg:px-8">
      <header className="border-b border-line pb-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">Control plane</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">Settings</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
              Manage providers, model policy, programmatic access, and data ownership from one workspace.
            </p>
          </div>
          <div className="grid grid-cols-3 divide-x divide-line overflow-hidden rounded-lg border border-line bg-surface">
            <HeaderMetric label="Providers" value={loading ? "—" : String(activeProviders)} detail="connected" />
            <HeaderMetric label="Routes" value={loading ? "—" : String(snapshot?.assignments.length || 0)} detail="configured" />
            <HeaderMetric label="Lifecycle" value={loading ? "—" : deprecatedModels ? String(deprecatedModels) : "Clear"} detail={deprecatedModels ? "need review" : "no alerts"} warning={deprecatedModels > 0} />
          </div>
        </div>
      </header>

      {error ? (
        <div role="alert" className="mt-4 flex items-start justify-between gap-4 border-l-2 border-danger bg-danger/5 px-4 py-3 text-sm text-danger">
          <span className="flex items-start gap-2"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</span>
          <button type="button" onClick={() => setError(undefined)} aria-label="Dismiss error"><X size={16} /></button>
        </div>
      ) : null}

      <div className="mt-6 grid gap-8 xl:grid-cols-[16rem_minmax(0,1fr)]">
        <nav aria-label="Settings categories" className="-mx-4 flex gap-1 overflow-x-auto border-y border-line px-4 py-2 xl:sticky xl:top-5 xl:mx-0 xl:block xl:self-start xl:overflow-visible xl:border-0 xl:p-0">
          {sections.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={clsx(
                  "group flex min-w-[10rem] items-center gap-3 rounded-md px-3 py-3 text-left transition xl:mb-1 xl:w-full",
                  section === item.id ? "bg-primary/10 text-foreground" : "text-muted hover:bg-surface-raised hover:text-foreground",
                )}
                aria-current={section === item.id ? "page" : undefined}
              >
                <Icon size={17} className={section === item.id ? "text-primary" : "text-muted group-hover:text-foreground"} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{item.label}</span>
                  <span className="mt-0.5 hidden text-[11px] text-muted xl:block">{item.description}</span>
                </span>
                <ChevronRight size={14} className="ml-auto hidden opacity-50 xl:block" />
              </button>
            );
          })}
        </nav>

        <main className="min-w-0">
          {loading ? <SettingsLoading /> : null}
          {!loading && snapshot && section === "overview" ? (
            <OverviewSection snapshot={snapshot} onNavigate={setSection} />
          ) : null}
          {!loading && snapshot && section === "providers" ? (
            <ProvidersSection
              snapshot={snapshot}
              savedProviders={savedProviders}
              busy={busy}
              onAdd={(provider) => {
                setError(undefined);
                setProviderDraft({ provider, label: providerDetails[provider].name, credentials: {} });
              }}
              onRotate={(connection) => {
                setError(undefined);
                setRotateConnection(connection);
                setProviderDraft({ provider: connection.provider, label: connection.label, credentials: {} });
              }}
              onValidate={(id) => void request(`validate:${id}`, `/api/settings/providers/${id}/validate`, "POST").catch(() => undefined)}
              onToggle={(item) => void request(`toggle:${item.id}`, `/api/settings/providers/${item.id}`, "PATCH", { enabled: !item.enabled }).catch(() => undefined)}
              onRevoke={(id) => void request(`revoke:${id}`, `/api/settings/providers/${id}`, "DELETE").catch(() => undefined)}
            />
          ) : null}
          {!loading && snapshot && section === "models" ? (
            <ModelsSection snapshot={snapshot} busy={busy} onSave={(scope, value) => request(`assignment:${scope}`, "/api/settings/assignments", "PUT", { scope, ...value })} onRefresh={(id) => request(`validate:${id}`, `/api/settings/providers/${id}/validate`, "POST")} />
          ) : null}
          {!loading && snapshot && section === "api" ? (
            <ApiSection snapshot={snapshot} busy={busy} onRequest={request} onRevealToken={setRevealedToken} />
          ) : null}
          {!loading && snapshot && section === "data" ? (
            <DataSection snapshot={snapshot} />
          ) : null}
        </main>
      </div>

      {providerDraft ? (
        <ProviderDialog
          draft={providerDraft}
          rotating={rotateConnection}
          vaultReady={Boolean(snapshot?.vault.configured)}
          busy={busy === "provider:save"}
          error={error}
          onChange={setProviderDraft}
          onClose={() => { setProviderDraft(undefined); setRotateConnection(undefined); }}
          onSubmit={async () => {
            const target = rotateConnection
              ? `/api/settings/providers/${rotateConnection.id}/rotate`
              : "/api/settings/providers";
            const payload = rotateConnection
              ? { credentials: providerDraft.credentials, validateNow: true }
              : { ...providerDraft, validateNow: true };
            await request("provider:save", target, "POST", payload);
            setProviderDraft(undefined);
            setRotateConnection(undefined);
          }}
        />
      ) : null}
      {revealedToken ? <OneTimeTokenDialog token={revealedToken} onClose={() => setRevealedToken(undefined)} /> : null}
    </div>
  );
}

function HeaderMetric({ label, value, detail, warning }: { label: string; value: string; detail: string; warning?: boolean }) {
  return <div className="min-w-[7rem] px-4 py-3 sm:min-w-[9rem]">
    <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-muted">{label}</p>
    <div className="mt-1 flex items-baseline gap-2"><strong className={clsx("text-lg font-semibold", warning && "text-warning")}>{value}</strong><span className="hidden text-[10px] text-muted sm:inline">{detail}</span></div>
  </div>;
}

function SectionHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
    <div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary">{eyebrow}</p><h2 className="mt-1.5 text-2xl font-semibold tracking-[-0.035em]">{title}</h2><p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted">{description}</p></div>
    {action}
  </div>;
}

function OverviewSection({ snapshot, onNavigate }: { snapshot: SettingsSnapshot; onNavigate: (section: SettingsSection) => void }) {
  const deploymentProviders = snapshot.providers.filter((item) => item.source === "deployment_environment");
  const tenantProviders = snapshot.providers.filter((item) => item.source === "tenant_vault" && item.status !== "revoked");
  return <section>
    <SectionHeader eyebrow="Workspace" title="Configuration at a glance" description="See what is active now, what is safely stored, and what still needs runtime activation." />
    <div className="mt-6 divide-y divide-line border-y border-line">
      <OverviewRow icon={ShieldCheck} title="Authentication" value={snapshot.platform.authEnforced ? "Enforced" : "Development mode"} description={snapshot.platform.bootstrapConfigured ? "Bootstrap credentials are still configured; remove them after the workspace administrator is established." : "Native workspace authentication is active without bootstrap credentials."} tone={snapshot.platform.authEnforced && !snapshot.platform.bootstrapConfigured ? "success" : "warning"} action={() => onNavigate("data")} />
      <OverviewRow icon={Database} title="Storage" value={`${snapshot.platform.storageBackend} · ${snapshot.platform.databaseConfigured ? "database configured" : "no database"}`} description={snapshot.platform.storageBackend === "ephemeral" ? "Hosted ephemeral storage is not durable. Configure the production database before relying on saved settings." : "Tenant records use the active application persistence backend."} tone={snapshot.platform.storageBackend === "ephemeral" ? "warning" : "success"} action={() => onNavigate("data")} />
      <OverviewRow icon={snapshot.vault.configured ? LockKeyhole : AlertCircle} title="Credential vault" value={snapshot.vault.configured ? `Ready · ${snapshot.vault.activeKeyId}` : "Setup required"} description={snapshot.vault.message} tone={snapshot.vault.configured ? "success" : "warning"} action={() => onNavigate("providers")} />
      <OverviewRow icon={Cloud} title="Deployment routing" value={`${deploymentProviders.length} environment provider${deploymentProviders.length === 1 ? "" : "s"}`} description="These remain the active runtime fallback and are managed by your deployment platform." action={() => onNavigate("providers")} />
      <OverviewRow icon={BrainCircuit} title="Workspace model policy" value={`${snapshot.assignments.length} of ${MODEL_ASSIGNMENT_SCOPES.length} roles assigned`} description={snapshot.runtime.message} tone="neutral" action={() => onNavigate("models")} />
      <OverviewRow icon={Network} title="MCP server" value={snapshot.mcp.enabled ? "Enabled" : "Disabled"} description={snapshot.mcp.enabled ? `${snapshot.mcp.serverName} · ${snapshot.mcp.allowedScopes.length} allowed scopes` : "Enable governed access when you are ready to connect an MCP client."} tone={snapshot.mcp.enabled ? "success" : "neutral"} action={() => onNavigate("api")} />
      <OverviewRow icon={RefreshCw} title="Release" value={snapshot.platform.releaseRevision ? snapshot.platform.releaseRevision.slice(0, 12) : "Revision unavailable"} description="The deployment revision reported by this running application instance." tone="neutral" action={() => onNavigate("overview")} />
    </div>
    <div className="mt-8 grid gap-5 lg:grid-cols-2">
      <div className="rounded-lg bg-surface p-5 ring-1 ring-line"><p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted">Tenant credentials</p><p className="mt-3 text-3xl font-semibold tracking-[-0.04em]">{tenantProviders.length}</p><p className="mt-1 text-sm text-muted">Sealed provider connections in this workspace</p></div>
      <div className="rounded-lg bg-surface p-5 ring-1 ring-line"><p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted">Service identities</p><p className="mt-3 text-3xl font-semibold tracking-[-0.04em]">{snapshot.apiKeys.filter((item) => item.status === "active").length}</p><p className="mt-1 text-sm text-muted">Active hash-only API keys</p></div>
    </div>
  </section>;
}

function OverviewRow({ icon: Icon, title, value, description, tone = "neutral", action }: { icon: typeof Cloud; title: string; value: string; description: string; tone?: "neutral" | "success" | "warning"; action: () => void }) {
  return <button type="button" onClick={action} className="group grid w-full gap-3 py-5 text-left transition hover:bg-surface/60 sm:grid-cols-[2.5rem_minmax(10rem,.55fr)_minmax(14rem,1fr)_auto] sm:items-center sm:px-3">
    <span className={clsx("grid size-9 place-items-center rounded-md", tone === "success" ? "bg-success/10 text-success" : tone === "warning" ? "bg-warning/10 text-warning" : "bg-surface-raised text-muted")}><Icon size={17} /></span>
    <span><span className="block text-sm font-semibold">{title}</span><span className={clsx("mt-1 block text-xs", tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-muted")}>{value}</span></span>
    <span className="text-xs leading-5 text-muted">{description}</span><ArrowRight size={16} className="text-muted transition group-hover:translate-x-1 group-hover:text-primary" />
  </button>;
}

function ProvidersSection({ snapshot, savedProviders, busy, onAdd, onRotate, onValidate, onToggle, onRevoke }: {
  snapshot: SettingsSnapshot;
  savedProviders: RedactedProviderConnection[];
  busy?: string;
  onAdd: (provider: SettingsModelProvider) => void;
  onRotate: (connection: RedactedProviderConnection) => void;
  onValidate: (id: string) => void;
  onToggle: (connection: RedactedProviderConnection) => void;
  onRevoke: (id: string) => void;
}) {
  const providerByType = new Map(savedProviders.map((item) => [item.provider, item]));
  return <section>
    <SectionHeader eyebrow="AI providers" title="Credentials and model catalogs" description="Connect workspace-owned providers without exposing credential values. Validation refreshes the selectable model catalog and records lifecycle metadata." />
    {!snapshot.vault.configured ? <div className="mt-5 border-l-2 border-warning bg-warning/5 px-4 py-3"><p className="text-sm font-semibold text-warning">Independent keyring required</p><p className="mt-1 text-xs leading-5 text-muted">{snapshot.vault.message}</p></div> : null}
    <div className="mt-6 divide-y divide-line border-y border-line">
      {MODEL_PROVIDERS.map((provider) => {
        const connection = providerByType.get(provider);
        const env = snapshot.providers.find((item) => item.provider === provider && item.source === "deployment_environment");
        const detail = providerDetails[provider];
        return <div key={provider} className="grid gap-4 py-5 lg:grid-cols-[minmax(12rem,.65fr)_minmax(14rem,1fr)_auto] lg:items-center">
          <div className="flex items-center gap-3"><ProviderMark provider={provider} /><div><h3 className="text-sm font-semibold">{detail.name}</h3><p className="mt-0.5 text-xs text-muted">{detail.note}</p></div></div>
          <div className="flex flex-wrap items-center gap-2">
            {connection ? <StatusPill status={connection.status} /> : <span className="rounded-full bg-surface-raised px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-muted">Not connected</span>}
            {connection?.credentialFingerprint ? <span className="font-mono text-[10px] text-muted">fp {connection.credentialFingerprint}</span> : null}
            {env ? <span className="rounded-full bg-info/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-info">Environment active</span> : null}
            <p className="basis-full text-[11px] leading-5 text-muted">{connection?.runtimeNote || env?.runtimeNote || "No credentials configured for this provider."}{connection?.catalogRefreshedAt ? ` Catalog refreshed ${formatDate(connection.catalogRefreshedAt)}.` : ""}{connection?.validationCode ? ` Validation: ${connection.validationCode.replaceAll("_", " ")}.` : ""}</p>
          </div>
          <div className="flex flex-wrap justify-start gap-2 lg:justify-end">
            {connection ? <>
              <button type="button" className="action-button min-h-9 px-2.5 text-xs" disabled={Boolean(busy)} onClick={() => onValidate(connection.id)}>{busy === `validate:${connection.id}` ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}Refresh</button>
              <button type="button" className="action-button min-h-9 px-2.5 text-xs" disabled={Boolean(busy)} onClick={() => onRotate(connection)}><RotateCcw size={14} />Rotate</button>
              <button type="button" className="action-button min-h-9 px-2.5 text-xs" disabled={Boolean(busy)} onClick={() => onToggle(connection)}>{connection.enabled ? "Disable" : "Enable"}</button>
              <button type="button" className="grid size-9 place-items-center rounded-md text-muted transition hover:bg-danger/10 hover:text-danger" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Revoke ${detail.name} and scrub its stored credential?`)) onRevoke(connection.id); }} aria-label={`Revoke ${detail.name}`}><Trash2 size={14} /></button>
            </> : <button type="button" className="primary-button min-h-9 text-xs" disabled={!snapshot.vault.configured} onClick={() => onAdd(provider)}><Plus size={14} />Connect</button>}
          </div>
        </div>;
      })}
    </div>
    <div className="mt-7 flex items-start gap-3 rounded-lg bg-surface p-4 ring-1 ring-line"><ShieldCheck size={18} className="mt-0.5 shrink-0 text-primary" /><div><p className="text-sm font-semibold">Credential boundary</p><p className="mt-1 text-xs leading-5 text-muted">Workspace secrets are encrypted with a separate AES-256-GCM keyring and bound to tenant, actor, provider, record, and version. The API only returns status, configured field names, and a non-secret fingerprint.</p></div></div>
  </section>;
}

function ModelsSection({ snapshot, busy, onSave, onRefresh }: {
  snapshot: SettingsSnapshot;
  busy?: string;
  onSave: (scope: ModelAssignmentScope, value: AssignmentDraft) => Promise<unknown>;
  onRefresh: (id: string) => Promise<unknown>;
}) {
  const connected = snapshot.providers.filter((item) => item.source === "tenant_vault" && item.status === "connected");
  return <section>
    <SectionHeader eyebrow="Model routing" title="Assign the right model to each role" description="Choose a primary model and an optional fallback. Crossing provider boundaries is off until you explicitly consent for that assignment." action={connected.length ? <button type="button" className="action-button shrink-0" disabled={Boolean(busy)} onClick={() => void (async () => { for (const item of connected) await onRefresh(item.id); })().catch(() => undefined)}><RefreshCw size={15} />Refresh catalogs</button> : undefined} />
    <div className="mt-5 border-l-2 border-info bg-info/5 px-4 py-3"><p className="text-sm font-semibold text-info">Configuration scope</p><p className="mt-1 text-xs leading-5 text-muted">{snapshot.runtime.message}</p></div>
    <div className="mt-6 divide-y divide-line border-y border-line">
      {MODEL_ASSIGNMENT_SCOPES.map((scope) => <AssignmentEditor key={scope} scope={scope} models={snapshot.models} providers={snapshot.providers} current={snapshot.assignments.find((item) => item.scope === scope)} busy={busy === `assignment:${scope}`} onSave={(value) => onSave(scope, value)} />)}
    </div>
    <ModelCatalog models={snapshot.models} />
  </section>;
}

type AssignmentDraft = {
  provider: SettingsModelProvider;
  modelId: string;
  fallbackProvider?: SettingsModelProvider;
  fallbackModelId?: string;
  crossProviderFallbackConsent?: true;
};

function AssignmentEditor({ scope, models, providers, current, busy, onSave }: { scope: ModelAssignmentScope; models: ModelCatalogEntry[]; providers: RedactedProviderConnection[]; current?: ModelAssignment; busy: boolean; onSave: (value: AssignmentDraft) => Promise<unknown> }) {
  const defaultProvider = current?.provider || models[0]?.provider || providers[0]?.provider || "openai";
  const [provider, setProvider] = useState<SettingsModelProvider>(defaultProvider);
  const [modelId, setModelId] = useState(current?.modelId || "");
  const [fallbackProvider, setFallbackProvider] = useState<SettingsModelProvider | "">(current?.fallbackProvider || "");
  const [fallbackModelId, setFallbackModelId] = useState(current?.fallbackModelId || "");
  const [consent, setConsent] = useState(Boolean(current?.allowCrossProviderFallback));
  const providerOptions = [...new Set([...providers.map((item) => item.provider), ...models.map((item) => item.provider)])];
  const primaryModels = models.filter((item) => item.provider === provider);
  const fallbackModels = models.filter((item) => item.provider === fallbackProvider);
  const crossesBoundary = Boolean(fallbackProvider && fallbackProvider !== provider);
  const selectedLifecycle = models.find((item) => item.provider === provider && item.modelId === modelId);
  const details = assignmentLabels[scope];
  return <div className="py-5">
    <div className="grid gap-4 xl:grid-cols-[minmax(11rem,.55fr)_minmax(0,1fr)_auto] xl:items-start">
      <div><h3 className="text-sm font-semibold">{details.title}</h3><p className="mt-1 text-xs leading-5 text-muted">{details.description}</p>{current ? <span className={`mt-2 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] ${current.runtimeReadiness === "active" ? "text-success" : "text-warning"}`}><CircleDashed size={11} />{current.runtimeReadiness === "active" ? "Runtime active" : "Configuration only"}</span> : null}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SettingsField label="Primary provider"><select value={provider} onChange={(event) => { setProvider(event.target.value as SettingsModelProvider); setModelId(""); }}><option value="">Choose provider</option>{providerOptions.map((item) => <option key={item} value={item}>{providerDetails[item].name}</option>)}</select></SettingsField>
        <SettingsField label="Primary model"><input list={`${scope}-primary-models`} value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder={primaryModels.length ? "Choose or enter a model" : "Enter model ID"} /><datalist id={`${scope}-primary-models`}>{primaryModels.map((item) => <option key={item.id} value={item.modelId}>{item.displayName}</option>)}</datalist></SettingsField>
        <SettingsField label="Fallback provider"><select value={fallbackProvider} onChange={(event) => { setFallbackProvider(event.target.value as SettingsModelProvider | ""); setFallbackModelId(""); setConsent(false); }}><option value="">No fallback</option>{providerOptions.map((item) => <option key={item} value={item}>{providerDetails[item].name}</option>)}</select></SettingsField>
        <SettingsField label="Fallback model"><input list={`${scope}-fallback-models`} value={fallbackModelId} onChange={(event) => setFallbackModelId(event.target.value)} disabled={!fallbackProvider} placeholder={fallbackProvider ? "Choose or enter a model" : "Select provider first"} /><datalist id={`${scope}-fallback-models`}>{fallbackModels.map((item) => <option key={item.id} value={item.modelId}>{item.displayName}</option>)}</datalist></SettingsField>
        {selectedLifecycle && (selectedLifecycle.lifecycle === "deprecated" || selectedLifecycle.lifecycle === "retiring") ? <div className="flex items-start gap-2 rounded-md bg-warning/5 p-3 text-xs leading-5 text-warning sm:col-span-2"><AlertCircle size={14} className="mt-0.5 shrink-0" /><span><strong className="block">Model update needed</strong>{selectedLifecycle.lifecycleReason || "This model is no longer current in the provider catalog."}</span></div> : null}
        {crossesBoundary ? <label className="flex items-start gap-2 rounded-md bg-warning/5 p-3 text-xs leading-5 text-muted sm:col-span-2"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1 accent-primary" /><span><strong className="block text-foreground">Allow cross-provider disclosure</strong>On primary failure, this role may send the same task context to {providerDetails[fallbackProvider as SettingsModelProvider].name}.</span></label> : null}
      </div>
      <button type="button" className="primary-button min-h-9 self-end text-xs" disabled={busy || !modelId || Boolean(fallbackProvider) !== Boolean(fallbackModelId) || (crossesBoundary && !consent)} onClick={() => void onSave({ provider, modelId, fallbackProvider: fallbackProvider || undefined, fallbackModelId: fallbackModelId || undefined, crossProviderFallbackConsent: crossesBoundary && consent ? true : undefined }).catch(() => undefined)}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}Save route</button>
    </div>
  </div>;
}

function ModelCatalog({ models }: { models: ModelCatalogEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? models : models.slice(0, 8);
  return <div className="mt-8">
    <div className="flex items-end justify-between gap-4"><div><h3 className="text-base font-semibold">Discovered models</h3><p className="mt-1 text-xs text-muted">Lifecycle stays unknown unless the provider publishes a reliable state.</p></div>{models.length > 8 ? <button type="button" className="text-xs font-semibold text-primary" onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : `View all ${models.length}`}</button> : null}</div>
    {shown.length ? <div className="mt-4 overflow-x-auto rounded-lg border border-line"><table className="w-full min-w-[42rem] text-left text-xs"><thead className="bg-surface text-[10px] uppercase tracking-[0.1em] text-muted"><tr><th className="px-4 py-3 font-bold">Model</th><th className="px-4 py-3 font-bold">Provider</th><th className="px-4 py-3 font-bold">Capabilities</th><th className="px-4 py-3 font-bold">Lifecycle</th><th className="px-4 py-3 font-bold">Checked</th></tr></thead><tbody className="divide-y divide-line">{shown.map((model) => <tr key={model.id}><td className="px-4 py-3"><strong className="block font-semibold">{model.displayName}</strong><span className="font-mono text-[10px] text-muted">{model.modelId}</span></td><td className="px-4 py-3 text-muted">{providerDetails[model.provider].name}</td><td className="px-4 py-3 text-muted">{model.capabilities.join(" · ")}</td><td className="px-4 py-3"><LifecyclePill lifecycle={model.lifecycle} /></td><td className="px-4 py-3 text-muted">{model.lifecycleCheckedAt ? formatDate(model.lifecycleCheckedAt) : "Not reported"}</td></tr>)}</tbody></table></div> : <EmptyLine title="No model catalog yet" body="Connect and validate a provider to discover selectable models." />}
  </div>;
}

function ApiSection({ snapshot, busy, onRequest, onRevealToken }: { snapshot: SettingsSnapshot; busy?: string; onRequest: <T>(key: string, path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown) => Promise<T | undefined>; onRevealToken: (token: string) => void }) {
  return <section>
    <SectionHeader eyebrow="API & MCP" title="Programmatic access" description="Create scoped service identities and expose OmniAgent through a governed MCP endpoint. Tokens are stored as hashes and cannot be recovered." />
    <ServiceApiKeys snapshot={snapshot} busy={busy} onRequest={onRequest} onRevealToken={onRevealToken} />
    <McpConfiguration config={snapshot.mcp} busy={busy === "mcp:save"} onSave={(config) => onRequest("mcp:save", "/api/settings/mcp", "PUT", config)} />
  </section>;
}

function ServiceApiKeys({ snapshot, busy, onRequest, onRevealToken }: { snapshot: SettingsSnapshot; busy?: string; onRequest: <T>(key: string, path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown) => Promise<T | undefined>; onRevealToken: (token: string) => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ServiceApiScope[]>(["mcp:discover", "mcp:tools:list"]);
  const [expiresAt, setExpiresAt] = useState("");
  return <div className="mt-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h3 className="text-base font-semibold">Service API keys</h3><p className="mt-1 text-xs leading-5 text-muted">Use a separate key per integration so access can be revoked without interrupting anything else.</p></div><button type="button" className="primary-button shrink-0" onClick={() => setCreating(!creating)}><Plus size={15} />Create key</button></div>
    {creating ? <form className="mt-4 rounded-lg bg-surface p-4 ring-1 ring-line" onSubmit={(event) => { event.preventDefault(); void onRequest<{ token: string }>("api-key:create", "/api/settings/api-keys", "POST", { name, scopes, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined }).then((result) => { if (result?.token) { onRevealToken(result.token); setCreating(false); setName(""); setExpiresAt(""); } }).catch(() => undefined); }}><div className="grid gap-4 lg:grid-cols-[minmax(12rem,.6fr)_minmax(12rem,.55fr)_minmax(0,1fr)_auto] lg:items-end"><SettingsField label="Key name"><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Claude Desktop" maxLength={120} /></SettingsField><SettingsField label="Expiry (optional)"><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></SettingsField><fieldset><legend className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-muted">Scopes</legend><div className="flex flex-wrap gap-2">{SERVICE_API_SCOPES.map((scope) => <label key={scope} className={clsx("cursor-pointer rounded-full border px-2.5 py-1 text-[10px] font-semibold transition", scopes.includes(scope) ? "border-primary/40 bg-primary/10 text-primary" : "border-line text-muted hover:text-foreground")}><input type="checkbox" className="sr-only" checked={scopes.includes(scope)} onChange={(event) => setScopes(event.target.checked ? [...scopes, scope] : scopes.filter((item) => item !== scope))} />{scope}</label>)}</div></fieldset><button type="submit" className="primary-button" disabled={!name.trim() || !scopes.length || busy === "api-key:create"}>{busy === "api-key:create" ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}Generate once</button></div></form> : null}
    <div className="mt-4 divide-y divide-line border-y border-line">{snapshot.apiKeys.length ? snapshot.apiKeys.map((key) => <div key={key.id} className="grid gap-3 py-4 sm:grid-cols-[minmax(10rem,.55fr)_minmax(0,1fr)_auto] sm:items-center"><div><p className="text-sm font-semibold">{key.name}</p><p className="mt-1 font-mono text-[10px] text-muted">{key.tokenPrefix}••••{key.tokenLastFour}</p></div><div><StatusPill status={key.status === "active" ? "connected" : key.status === "expired" ? "error" : "revoked"} /><p className="mt-1.5 text-[10px] text-muted">{key.scopes.join(" · ")}</p></div><button type="button" className="action-button min-h-9 text-xs text-danger" disabled={key.status !== "active" || Boolean(busy)} onClick={() => { if (window.confirm(`Revoke the ${key.name} API key?`)) void onRequest(`api-key:revoke:${key.id}`, `/api/settings/api-keys/${key.id}`, "DELETE").catch(() => undefined); }}><Trash2 size={13} />Revoke</button></div>) : <EmptyLine title="No service API keys" body="Create a narrow, revocable identity for each client or automation." />}</div>
  </div>;
}

function McpConfiguration({ config, busy, onSave }: { config: McpExportConfiguration; busy: boolean; onSave: (config: Pick<McpExportConfiguration, "enabled" | "serverName" | "allowedScopes" | "exposeResources">) => Promise<unknown> }) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [serverName, setServerName] = useState(config.serverName);
  const [allowedScopes, setAllowedScopes] = useState(config.allowedScopes);
  const [exposeResources, setExposeResources] = useState(config.exposeResources);
  return <div className="mt-9 border-t border-line pt-7">
    <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><Network size={18} /></span><div><h3 className="text-base font-semibold">OmniAgent MCP server</h3><p className="mt-1 max-w-2xl text-xs leading-5 text-muted">Expose reviewed tools and optional resources at <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono">{config.endpointPath}</code>. Every tool execution remains governed.</p></div></div>
    <div className="mt-5 grid gap-5 rounded-lg bg-surface p-5 ring-1 ring-line lg:grid-cols-[minmax(12rem,.5fr)_minmax(0,1fr)]">
      <div className="space-y-4"><SettingsField label="Server name"><input value={serverName} onChange={(event) => setServerName(event.target.value)} maxLength={120} /></SettingsField><ToggleRow title="Enable MCP endpoint" description="Service-key authentication is still required." checked={enabled} onChange={setEnabled} /><ToggleRow title="Expose resources" description="Allow configured read-only resources in addition to tools." checked={exposeResources} onChange={setExposeResources} /></div>
      <div><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">Maximum scopes clients may receive</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{SERVICE_API_SCOPES.map((scope) => <label key={scope} className="flex items-center gap-2 rounded-md border border-line bg-background px-3 py-2 text-xs"><input type="checkbox" className="accent-primary" checked={allowedScopes.includes(scope)} onChange={(event) => setAllowedScopes(event.target.checked ? [...allowedScopes, scope] : allowedScopes.filter((item) => item !== scope))} /><span>{scope}</span></label>)}</div></div>
      <div className="flex flex-col gap-3 border-t border-line pt-4 lg:col-span-2 sm:flex-row sm:items-center sm:justify-between"><p className="flex items-center gap-2 text-xs text-muted"><ShieldCheck size={15} className="text-success" />Approval mode is permanently governed; MCP cannot bypass tool policy.</p><button type="button" className="primary-button" disabled={busy || !serverName.trim()} onClick={() => void onSave({ enabled, serverName, allowedScopes, exposeResources }).catch(() => undefined)}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}Save MCP policy</button></div>
    </div>
  </div>;
}

function DataSection({ snapshot }: { snapshot: SettingsSnapshot }) {
  return <section>
    <SectionHeader eyebrow="Data & privacy" title="Ownership, portability, and secret boundaries" description="Understand where configuration lives and keep a portable archive of your agent workspace." />
    <div className="mt-6 grid gap-4 md:grid-cols-3"><SecurityFact icon={Database} title="Tenant isolated" body="Settings records carry tenant and actor ownership and database row-level security is forced." /><SecurityFact icon={LockKeyhole} title="Secrets sealed" body={snapshot.vault.configured ? `Independent keyring ${snapshot.vault.activeKeyId} is active.` : "Credential saves remain locked until the independent keyring is configured."} /><SecurityFact icon={KeyRound} title="Tokens hash-only" body="Service API tokens are shown once. Only their SHA-256 digest and redacted identity remain." /></div>
    <PersonalDataControls />
  </section>;
}

function ProviderDialog({ draft, rotating, vaultReady, busy, error, onChange, onClose, onSubmit }: { draft: ProviderDraft; rotating?: RedactedProviderConnection; vaultReady: boolean; busy: boolean; error?: string; onChange: (draft: ProviderDraft) => void; onClose: () => void; onSubmit: () => Promise<void> }) {
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const detail = providerDetails[draft.provider];
  const complete = detail.fields.filter((field) => !field.label.includes("optional")).every((field) => draft.credentials[field.name]?.trim());
  return <div className="fixed inset-0 z-50 flex items-stretch justify-end" role="dialog" aria-modal="true" aria-labelledby="provider-dialog-title"><button type="button" className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={onClose} aria-label="Close provider setup" /><div className="relative flex w-full max-w-xl flex-col border-l border-line bg-background shadow-2xl"><header className="flex items-start justify-between gap-4 border-b border-line px-5 py-5 sm:px-7"><div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">{rotating ? "Credential rotation" : "Provider setup"}</p><h2 id="provider-dialog-title" className="mt-1 text-xl font-semibold">{rotating ? `Rotate ${detail.name}` : `Connect ${detail.name}`}</h2><p className="mt-1 text-xs leading-5 text-muted">{rotating ? "The previous encrypted value is replaced and the credential version advances." : detail.note}</p></div><button type="button" className="grid size-9 shrink-0 place-items-center rounded-md border border-line text-muted hover:bg-surface-raised" onClick={onClose}><X size={16} /></button></header><form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void onSubmit().catch(() => undefined); }}><div className="flex-1 space-y-5 overflow-y-auto px-5 py-6 sm:px-7">{error ? <div role="alert" className="border-l-2 border-danger bg-danger/5 px-3 py-2 text-xs leading-5 text-danger">{error}</div> : null}{!rotating ? <SettingsField label="Connection name"><input value={draft.label} onChange={(event) => onChange({ ...draft, label: event.target.value })} maxLength={120} /></SettingsField> : null}{detail.fields.map((field) => <SettingsField key={field.name} label={field.label}><div className="relative"><input type={field.secret && !visible[field.name] ? "password" : "text"} value={draft.credentials[field.name] || ""} onChange={(event) => onChange({ ...draft, credentials: { ...draft.credentials, [field.name]: event.target.value } })} placeholder={field.placeholder} autoComplete="off" className={field.secret ? "pr-11" : undefined} />{field.secret ? <button type="button" className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted" onClick={() => setVisible({ ...visible, [field.name]: !visible[field.name] })} aria-label={visible[field.name] ? `Hide ${field.label}` : `Show ${field.label}`}>{visible[field.name] ? <EyeOff size={15} /> : <Eye size={15} />}</button> : null}</div></SettingsField>)}<div className="rounded-lg bg-surface p-4 ring-1 ring-line"><p className="flex items-center gap-2 text-xs font-semibold"><LockKeyhole size={14} className="text-primary" />Write-only credential handling</p><p className="mt-1.5 text-[11px] leading-5 text-muted">The browser sends these values once over the authenticated settings route. They are sealed server-side and never returned by list, validate, or rotate responses.</p></div></div><footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-4 sm:px-7"><p className={clsx("text-[11px]", vaultReady ? "text-success" : "text-warning")}>{vaultReady ? "Independent vault ready" : "Keyring setup required"}</p><div className="flex gap-2"><button type="button" className="action-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={!vaultReady || !complete || busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}{rotating ? "Rotate and validate" : "Save and validate"}</button></div></footer></form></div></div>;
}

function OneTimeTokenDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="token-title"><div className="w-full max-w-2xl rounded-xl border border-line bg-background p-6 shadow-2xl sm:p-8"><span className="grid size-11 place-items-center rounded-full bg-success/10 text-success"><KeyRound size={20} /></span><h2 id="token-title" className="mt-5 text-2xl font-semibold tracking-[-0.035em]">Copy this key now</h2><p className="mt-2 text-sm leading-6 text-muted">For security, this is the only time OmniAgent will display the complete token. Store it in your client’s secret manager.</p><div className="mt-5 flex items-center gap-2 rounded-lg border border-line bg-surface p-3"><code className="min-w-0 flex-1 break-all font-mono text-xs leading-5">{token}</code><button type="button" className="action-button shrink-0" onClick={() => void navigator.clipboard.writeText(token).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "Copied" : "Copy"}</button></div><div className="mt-6 flex justify-end"><button type="button" className="primary-button" onClick={onClose}>I saved the key</button></div></div></div>;
}

function SettingsField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.1em] text-muted">{label}</span><div className="[&_input]:h-10 [&_input]:w-full [&_input]:rounded-md [&_input]:border [&_input]:border-line [&_input]:bg-background [&_input]:px-3 [&_input]:text-sm [&_input]:outline-none [&_input]:transition [&_input]:focus:border-primary [&_select]:h-10 [&_select]:w-full [&_select]:rounded-md [&_select]:border [&_select]:border-line [&_select]:bg-background [&_select]:px-3 [&_select]:text-sm [&_select]:outline-none [&_select]:transition [&_select]:focus:border-primary">{children}</div></label>;
}

function ProviderMark({ provider }: { provider: SettingsModelProvider }) {
  const initials = provider === "aws_bedrock" ? "AWS" : provider === "anthropic" ? "AI" : provider === "google" ? "G" : "O";
  return <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-raised text-xs font-bold text-foreground ring-1 ring-line">{initials}</span>;
}

function StatusPill({ status }: { status: RedactedProviderConnection["status"] }) {
  const success = status === "connected";
  const warning = status === "needs_validation" || status === "validating";
  return <span className={clsx("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em]", success ? "bg-success/10 text-success" : warning ? "bg-warning/10 text-warning" : status === "disabled" || status === "revoked" ? "bg-surface-raised text-muted" : "bg-danger/10 text-danger")}>{success ? <CheckCircle2 size={11} /> : warning ? <CircleDashed size={11} /> : <AlertCircle size={11} />}{status.replaceAll("_", " ")}</span>;
}

function LifecyclePill({ lifecycle }: { lifecycle: ModelCatalogEntry["lifecycle"] }) {
  return <span className={clsx("rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em]", lifecycle === "available" ? "bg-success/10 text-success" : lifecycle === "deprecated" || lifecycle === "retiring" ? "bg-warning/10 text-warning" : "bg-surface-raised text-muted")}>{lifecycle}</span>;
}

function ToggleRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex cursor-pointer items-start justify-between gap-4"><span><span className="block text-xs font-semibold">{title}</span><span className="mt-1 block text-[11px] leading-4 text-muted">{description}</span></span><span className={clsx("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition", checked ? "bg-primary" : "bg-surface-overlay")}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="sr-only" /><span className={clsx("absolute top-1 size-4 rounded-full bg-white shadow-sm transition", checked ? "left-6" : "left-1")} /></span></label>;
}

function SecurityFact({ icon: Icon, title, body }: { icon: typeof Database; title: string; body: string }) {
  return <div className="rounded-lg bg-surface p-5 ring-1 ring-line"><Icon size={18} className="text-primary" /><h3 className="mt-4 text-sm font-semibold">{title}</h3><p className="mt-1.5 text-xs leading-5 text-muted">{body}</p></div>;
}

function EmptyLine({ title, body }: { title: string; body: string }) {
  return <div className="py-8 text-center"><CircleDashed size={22} className="mx-auto text-muted" /><p className="mt-3 text-sm font-semibold">{title}</p><p className="mt-1 text-xs text-muted">{body}</p></div>;
}

function SettingsLoading() {
  return <div role="status" aria-label="Loading settings" className="space-y-4"><div className="h-16 animate-pulse rounded-lg bg-surface" /><div className="h-72 animate-pulse rounded-lg bg-surface" /><div className="h-32 animate-pulse rounded-lg bg-surface" /></div>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}
