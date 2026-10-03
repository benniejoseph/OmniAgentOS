"use client";

import { clsx } from "clsx";
import {
  Cable,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  GitBranch,
  KeyRound,
  Loader2,
  LockKeyhole,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  ServerCog,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import type { TrashActionPreviewV1 } from "@/lib/trash/contracts";
import { useCapabilityActions, type CapabilityActions } from "../automation/use-capability-actions";
import { parseMcpReceipt, parseMcpTrashPreview, parseMcpTrashReceipt } from "../integrations/connection-state";
import { isJsonRecord } from "../automation/automation-model";

type McpAuthType = "bearer_vault" | "bearer_env" | "none";

type McpConnector = {
  id: string;
  name?: string;
  endpoint?: string;
  authType?: McpAuthType;
  status?: "active" | "disabled" | "error" | string;
  toolCount?: number;
  defaultRiskLevel?: number;
  approvalRequired?: boolean;
  credentialConfigured?: boolean;
  credentialVersion?: number;
  credentialFingerprint?: string;
  credentialRotatedAt?: string;
  credentialOriginMatch?: boolean;
  lastDiscoveredAt?: string;
  createdAt?: string;
  updatedAt?: string;
  review?: {
    pendingCount?: number;
  };
};

type McpPayload = {
  connectors?: McpConnector[];
  credentialVault?: {
    configured?: boolean;
    message?: string;
  };
};

type McpConnectionsProps = {
  actions?: CapabilityActions;
  payload?: unknown;
  loading?: boolean;
  error?: string;
  disabledReason?: string;
  onRefresh: () => Promise<void>;
};

type Notice = {
  tone: "success" | "error";
  text: string;
};

const GITHUB_MCP_ENDPOINT = "https://api.githubcopilot.com/mcp/x/all";

export function McpConnections({
  actions: sharedActions,
  payload,
  loading,
  error,
  disabledReason: permissionReason,
  onRefresh,
}: McpConnectionsProps) {
  const localActions = useCapabilityActions();
  const actions = sharedActions || localActions;
  const disabledReason = permissionReason || (loading ? "Refreshing current connection state." : error || !payload ? "Refresh the connection inventory before making changes." : undefined);
  const [receipt, setReceipt] = useState<string>();
  const mcp = asMcpPayload(payload);
  const connectors = useMemo(
    () => (Array.isArray(mcp.connectors) ? mcp.connectors : []),
    [mcp.connectors],
  );
  const vaultUnavailable = mcp.credentialVault?.configured !== true;
  const [adding, setAdding] = useState(false);
  const [advancedAuthOpen, setAdvancedAuthOpen] = useState(false);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authType, setAuthType] = useState<McpAuthType>("bearer_vault");
  const [bearerToken, setBearerToken] = useState("");
  const [authTokenEnv, setAuthTokenEnv] = useState("");
  const [discoverOnAdd, setDiscoverOnAdd] = useState(true);
  const [credentialEditorId, setCredentialEditorId] = useState<string>();
  const [credentialValue, setCredentialValue] = useState("");
  const [confirmRemoveCredentialId, setConfirmRemoveCredentialId] =
    useState<string>();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [deletePreviews, setDeletePreviews] = useState<Record<string, TrashActionPreviewV1>>({});
  const [pendingAction, setPendingAction] = useState<string>();
  const [notice, setNotice] = useState<Notice>();

  const busy = Boolean(actions.pending) || Boolean(loading);
  const showAddForm = adding || (Boolean(payload) && !error && !loading && connectors.length === 0);
  const githubPresetApplied =
    name.trim() === "GitHub" &&
    endpoint.trim() === GITHUB_MCP_ENDPOINT &&
    authType === "bearer_vault";

  function resetAddForm() {
    setName("");
    setEndpoint("");
    setAuthType("bearer_vault");
    setBearerToken("");
    setAuthTokenEnv("");
    setDiscoverOnAdd(true);
    setAdvancedAuthOpen(false);
  }

  function applyGitHubPreset() {
    setName("GitHub");
    setEndpoint(GITHUB_MCP_ENDPOINT);
    setAuthType("bearer_vault");
    setAuthTokenEnv("");
    setDiscoverOnAdd(true);
    setAdvancedAuthOpen(false);
    setNotice(undefined);
  }

  async function addConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabledReason) {
      setNotice({ tone: "error", text: disabledReason });
      return;
    }
    if (!name.trim() || !endpoint.trim()) {
      setNotice({
        tone: "error",
        text: "Enter a connection name and MCP server URL.",
      });
      return;
    }
    if (authType === "bearer_vault" && !bearerToken) {
      setNotice({ tone: "error", text: "Enter the provider token to store." });
      return;
    }
    if (authType === "bearer_vault" && vaultUnavailable) {
      setNotice({
        tone: "error",
        text:
          mcp.credentialVault?.message ||
          "Encrypted credential storage is not available. Choose an advanced authentication method.",
      });
      return;
    }
    if (authType === "bearer_env" && !authTokenEnv.trim()) {
      setNotice({
        tone: "error",
        text: "Enter the deployment environment variable name.",
      });
      return;
    }

    const submittedToken = bearerToken;
    const submittedEndpoint = endpoint.trim();
    const officialGitHubEndpoint = submittedEndpoint === GITHUB_MCP_ENDPOINT;
    const attempt = actions.begin("mcp:create");
    if (!attempt) return;
    setBearerToken("");
    setPendingAction("create");
    setNotice(undefined);
    try {
      const result = await requestJson(
        "/api/connectors",
        {
          method: "POST",
          headers: requestHeaders(true),
          body: JSON.stringify({
            name: name.trim(),
            endpoint: submittedEndpoint,
            authType,
            ...(authType === "bearer_vault"
              ? { bearerToken: submittedToken }
              : {}),
            ...(authType === "bearer_env"
              ? { authTokenEnv: authTokenEnv.trim() }
              : {}),
            defaultRiskLevel: 2,
            approvalRequired: !officialGitHubEndpoint,
            discover: discoverOnAdd,
          }),
        },
        "The MCP connection could not be added.",
      );
      if (!actions.current(attempt)) return;
      const confirmed = parseMcpReceipt(result, { fields: { name: name.trim(), endpoint: submittedEndpoint, authType, ...(authType === "bearer_vault" ? { credentialConfigured: true } : {}) }, discovered: discoverOnAdd });
      setReceipt(`Connection ${String(confirmed.id)} created · state ${String(confirmed.status)} · endpoint ${String(confirmed.endpoint)}. Discovered tools require their current contract review.`);
      resetAddForm();
      setAdding(false);
      setNotice({
        tone: "success",
        text:
          authType === "bearer_vault"
            ? "Connection added. Its token is encrypted and can only be replaced or removed."
            : "Connection added.",
      });
      setPendingAction(undefined);
      actions.finish(attempt);
      void onRefresh();
    } catch (requestError) {
      if (!actions.current(attempt)) return;
      if (
        requestError instanceof ConnectorRequestError &&
        requestError.connectionCreated
      ) {
        try {
          const confirmed = parseMcpReceipt(requestError.result, { fields: { name: name.trim(), endpoint: submittedEndpoint, authType, ...(requestError.credentialSaved ? { credentialConfigured: true } : {}) } });
          setReceipt(`Connection ${String(confirmed.id)} was created, but tool discovery failed. ${requestError.credentialSaved ? "Its token was saved." : "No token-save receipt was returned."}`);
          resetAddForm();
          setAdding(false);
        } catch { requestError = new Error("The creation outcome could not be confirmed. Refresh before trying again."); }
      }
      setNotice({
        tone: "error",
        text:
          requestError instanceof Error
            ? requestError.message
            : "The MCP connection could not be added.",
      });
      void onRefresh();
    } finally {
      if (actions.current(attempt)) { setBearerToken(""); setPendingAction(undefined); actions.finish(attempt); }
    }
  }

  async function rotateCredential(connector: McpConnector) {
    if (disabledReason) {
      setNotice({ tone: "error", text: disabledReason });
      return;
    }
    if (!credentialValue) {
      setNotice({ tone: "error", text: "Enter the replacement token." });
      return;
    }
    const submittedToken = credentialValue;
    const attempt = actions.begin(`mcp:credential:${connector.id}`);
    if (!attempt) return;
    setCredentialValue("");
    setPendingAction(`credential-${connector.id}`);
    setNotice(undefined);
    try {
      const result = await requestJson(
        `/api/connectors/${encodeURIComponent(connector.id)}/credential`,
        {
          method: "POST",
          headers: requestHeaders(true),
          body: JSON.stringify({
            bearerToken: submittedToken,
            discover: true,
          }),
        },
        "The token could not be stored.",
      );
      if (!actions.current(attempt)) return;
      const confirmed = parseMcpReceipt(result, { id: connector.id, fields: { credentialConfigured: true, credentialOriginMatch: true }, discovered: true });
      if (typeof connector.credentialVersion === "number" && !(typeof confirmed.credentialVersion === "number" && confirmed.credentialVersion > connector.credentialVersion)) throw new Error("The new credential version was not confirmed. Refresh before trying again.");
      setReceipt(`Connection ${connector.id}: token stored at version ${String(confirmed.credentialVersion ?? "unavailable")}; tools rediscovered. State ${String(confirmed.status)}. Current contracts still require review.`);
      setCredentialEditorId(undefined);
      setNotice({
        tone: "success",
        text: connector.credentialConfigured
          ? `${connectorLabel(connector)} token rotated and tools rediscovered.`
          : `${connectorLabel(connector)} token stored and tools rediscovered.`,
      });
      setPendingAction(undefined);
      actions.finish(attempt);
      void onRefresh();
    } catch (requestError) {
      if (!actions.current(attempt)) return;
      if (
        requestError instanceof ConnectorRequestError &&
        requestError.credentialSaved
      ) {
        try {
          parseMcpReceipt(requestError.result, { id: connector.id, fields: { credentialConfigured: true } });
          setReceipt(`Connection ${connector.id}: token saved, but tool discovery failed. Rediscover and review current contracts before enabling it.`);
          setCredentialEditorId(undefined);
        } catch { requestError = new Error("The token-save outcome could not be confirmed. Refresh before trying again."); }
      }
      setNotice({
        tone: "error",
        text:
          requestError instanceof Error
            ? requestError.message
            : "The token could not be stored.",
      });
      void onRefresh();
    } finally {
      if (actions.current(attempt)) { setCredentialValue(""); setPendingAction(undefined); actions.finish(attempt); }
    }
  }

  async function removeCredential(connector: McpConnector) {
    await runConnectorAction({
      actionId: `remove-credential-${connector.id}`,
      path: `/api/connectors/${encodeURIComponent(connector.id)}/credential`,
      method: "DELETE",
      success: `${connectorLabel(connector)} token removed and connection disabled.`,
      failure: "The stored token could not be removed.",
      validate: (result) => {
        parseMcpReceipt(result, { id: connector.id, fields: { status: "disabled", credentialConfigured: false } });
        if (!isJsonRecord(result) || typeof result.removed !== "boolean" || result.externalCredentialRevoked !== false) throw new Error("The local credential-removal receipt was incomplete.");
        return `Connection ${connector.id}: encrypted local token removed and connector disabled. The external token was not revoked.`;
      },
      after: () => setConfirmRemoveCredentialId(undefined),
    });
  }

  async function rediscover(connector: McpConnector) {
    await runConnectorAction({
      actionId: `discover-${connector.id}`,
      path: `/api/connectors/${encodeURIComponent(connector.id)}/discover`,
      method: "POST",
      success: `${connectorLabel(connector)} tools rediscovered. Review any changed contracts below.`,
      failure: "Tool discovery failed.",
      validate: (result) => {
        const confirmed = parseMcpReceipt(result, { id: connector.id, fields: { endpoint: connector.endpoint }, discovered: true });
        return `Connection ${connector.id}: discovery returned state ${String(confirmed.status)}. Review any changed contracts before activation.`;
      },
    });
  }

  async function upgradeGitHubConnection(connector: McpConnector) {
    if (disabledReason) {
      setNotice({ tone: "error", text: disabledReason });
      return;
    }
    const actionId = `upgrade-github-${connector.id}`;
    const attempt = actions.begin(actionId);
    if (!attempt) return;
    setPendingAction(actionId);
    setNotice(undefined);
    try {
      const updated = await requestJson(
        `/api/connectors/${encodeURIComponent(connector.id)}`,
        {
          method: "PATCH",
          headers: requestHeaders(true),
          body: JSON.stringify({
            endpoint: GITHUB_MCP_ENDPOINT,
            defaultRiskLevel: 2,
            approvalRequired: false,
          }),
        },
        "The GitHub connection could not be upgraded.",
      );
      if (!actions.current(attempt)) return;
      parseMcpReceipt(updated, { id: connector.id, fields: { endpoint: GITHUB_MCP_ENDPOINT, defaultRiskLevel: 2, approvalRequired: false } });
      setReceipt(`Connection ${connector.id}: official GitHub endpoint and policy updated. Tool rediscovery is pending.`);
      const discovered = await requestJson(
        `/api/connectors/${encodeURIComponent(connector.id)}/discover?resetPolicy=official-github`,
        { method: "POST", headers: requestHeaders(false) },
        "The GitHub connection was upgraded, but its tools could not be rediscovered.",
      );
      if (!actions.current(attempt)) return;
      parseMcpReceipt(discovered, { id: connector.id, fields: { endpoint: GITHUB_MCP_ENDPOINT }, discovered: true });
      setReceipt(`Connection ${connector.id}: official GitHub endpoint updated and tools rediscovered. Review the exact changed contracts before activation.`);
      setNotice({
        tone: "success",
        text:
          "GitHub Actions tools are available. Review the changed contracts below to activate them.",
      });
      setPendingAction(undefined);
      actions.finish(attempt);
      void onRefresh();
    } catch (requestError) {
      if (!actions.current(attempt)) return;
      setNotice({
        tone: "error",
        text:
          requestError instanceof Error
            ? requestError.message
            : "The GitHub connection could not be upgraded.",
      });
      void onRefresh();
    } finally {
      if (actions.current(attempt)) { setPendingAction(undefined); actions.finish(attempt); }
    }
  }

  async function setConnectorEnabled(
    connector: McpConnector,
    enabled: boolean,
  ) {
    await runConnectorAction({
      actionId: `status-${connector.id}`,
      path: `/api/connectors/${encodeURIComponent(connector.id)}`,
      method: "PATCH",
      body: { status: enabled ? "active" : "disabled" },
      success: `${connectorLabel(connector)} ${enabled ? "enabled" : "disabled"}.`,
      failure: `The connection could not be ${enabled ? "enabled" : "disabled"}.`,
      validate: (result) => {
        parseMcpReceipt(result, { id: connector.id, fields: { status: enabled ? "active" : "disabled" } });
        return `Connection ${connector.id}: ${enabled ? "active" : "disabled"}.`;
      },
    });
  }

  async function deleteConnection(connector: McpConnector, requestedAt: number) {
    const preview = deletePreviews[connector.id];
    if (!preview || Date.parse(preview.expiresAt) <= requestedAt) {
      setNotice({ tone: "error", text: "Prepare the exact trash preview before removing this connection." });
      setConfirmDeleteId(undefined);
      return;
    }
    await runConnectorAction({
      actionId: `delete-${connector.id}`,
      path: `/api/connectors/${encodeURIComponent(connector.id)}`,
      method: "DELETE",
      body: { preview },
      success: `${connectorLabel(connector)} moved to Trash. Restore is available for 30 days in Settings → Data & privacy.`,
      failure: "The MCP connection could not be moved to Trash.",
      validate: async (result) => {
        const confirmed = await parseMcpTrashReceipt(result, preview);
        return `Connection ${connector.id} moved to Trash ${confirmed.trashId}. Restore until ${confirmed.restoreUntil}. Receipt ${confirmed.receiptSha256}.`;
      },
      after: () => {
        setConfirmDeleteId(undefined);
        setDeletePreviews((current) => {
          const next = { ...current };
          delete next[connector.id];
          return next;
        });
      },
    });
  }

  async function prepareDelete(connector: McpConnector) {
    if (disabledReason) { setNotice({ tone: "error", text: disabledReason }); return; }
    if (confirmDeleteId === connector.id) {
      setConfirmDeleteId(undefined);
      return;
    }
    const attempt = actions.begin(`delete-preview-${connector.id}`);
    if (!attempt) return;
    setPendingAction(attempt.name);
    setNotice(undefined);
    try {
      const result = await requestJson<ConnectorRequestResult & {
        preview?: TrashActionPreviewV1;
      }>(`/api/connectors/${encodeURIComponent(connector.id)}`, {
        method: "POST",
        headers: requestHeaders(false),
      }, "The MCP trash preview could not be prepared.");
      if (!actions.current(attempt)) return;
      const preview = await parseMcpTrashPreview(result, connector.id);
      if (!actions.current(attempt)) return;
      setDeletePreviews((current) => ({ ...current, [connector.id]: preview }));
      setCredentialValue("");
      setCredentialEditorId(undefined);
      setConfirmRemoveCredentialId(undefined);
      setConfirmDeleteId(connector.id);
    } catch (requestError) {
      if (!actions.current(attempt)) return;
      setNotice({
        tone: "error",
        text: requestError instanceof Error ? requestError.message : "The MCP trash preview could not be prepared.",
      });
    } finally {
      if (actions.current(attempt)) { setPendingAction(undefined); actions.finish(attempt); }
    }
  }

  async function runConnectorAction(input: {
    actionId: string;
    path: string;
    method: "POST" | "PATCH" | "DELETE";
    body?: Record<string, unknown>;
    success: string;
    failure: string;
    validate: (result: unknown) => string | Promise<string>;
    after?: () => void;
  }) {
    if (disabledReason) {
      setNotice({ tone: "error", text: disabledReason });
      return;
    }
    const attempt = actions.begin(input.actionId);
    if (!attempt) return;
    setPendingAction(input.actionId);
    setNotice(undefined);
    try {
      const result = await requestJson(
        input.path,
        {
          method: input.method,
          headers: requestHeaders(Boolean(input.body)),
          body: input.body ? JSON.stringify(input.body) : undefined,
        },
        input.failure,
      );
      if (!actions.current(attempt)) return;
      const confirmed = await input.validate(result);
      if (!actions.current(attempt)) return;
      setReceipt(confirmed);
      input.after?.();
      setNotice({ tone: "success", text: input.success });
      setPendingAction(undefined);
      actions.finish(attempt);
      void onRefresh();
    } catch (requestError) {
      if (!actions.current(attempt)) return;
      setNotice({
        tone: "error",
        text:
          requestError instanceof Error ? requestError.message : input.failure,
      });
      void onRefresh();
    } finally {
      if (actions.current(attempt)) { setPendingAction(undefined); actions.finish(attempt); }
    }
  }

  function openCredentialEditor(connectorId: string) {
    setCredentialValue("");
    setConfirmRemoveCredentialId(undefined);
    setConfirmDeleteId(undefined);
    setCredentialEditorId((current) =>
      current === connectorId ? undefined : connectorId,
    );
  }

  return (
    <section
      className="relative overflow-hidden rounded-lg border border-line bg-surface"
      aria-labelledby="mcp-connections-title"
      aria-busy={busy}
    >
      <div
        className="absolute inset-y-0 left-0 w-1 bg-primary"
        aria-hidden="true"
      />
      <div className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Model Context Protocol
            </p>
            <div className="mt-2 flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-full border border-line bg-background text-foreground">
                <Cable size={18} aria-hidden="true" />
              </span>
              <div>
                <h2 id="mcp-connections-title" className="text-lg font-semibold">
                  MCP connections
                </h2>
                <p className="mt-0.5 max-w-2xl text-sm leading-6 text-muted">
                  Add and manage MCP servers here. Stored tokens are encrypted,
                  write-only, and scoped to this workspace.
                </p>
              </div>
            </div>
          </div>
          {connectors.length ? (
            <button
              type="button"
              onClick={() => {
                setNotice(undefined);
                setAdding((current) => !current);
              }}
              disabled={busy || Boolean(disabledReason)}
              title={disabledReason}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-55"
              aria-expanded={showAddForm}
            >
              <Plus size={15} aria-hidden="true" />
              {showAddForm ? "Close form" : "Add MCP connection"}
            </button>
          ) : null}
        </div>

        {disabledReason ? (
          <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm leading-6 text-muted">
            <span className="font-semibold text-foreground">
              Management controls unavailable.
            </span>{" "}
            {disabledReason}
          </div>
        ) : null}

        {vaultUnavailable && payload ? (
          <div
            className="mt-4 flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 p-3"
            role="status"
          >
            <CircleAlert
              size={17}
              className="mt-0.5 shrink-0 text-warning"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-semibold">
                {mcp.credentialVault?.configured === false ? "Encrypted token storage needs configuration" : "Encrypted token storage availability is unconfirmed"}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                {mcp.credentialVault?.message ||
                  "App-managed credentials are unavailable. Deployment environment authentication remains available under Advanced authentication."}
              </p>
            </div>
          </div>
        ) : null}

        {error ? (
          <p
            className="mt-4 rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger"
            role="alert"
          >
            {error}{payload ? " Last-loaded connection records remain visible." : " Current connection counts are unavailable."}
          </p>
        ) : null}

        {notice ? (
          <div
            className={clsx(
              "mt-4 flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
              notice.tone === "success"
                ? "border-primary/30 bg-primary/8 text-foreground"
                : "border-danger/35 bg-danger/10 text-danger",
            )}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            {notice.tone === "success" ? (
              <CheckCircle2
                size={16}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
            ) : (
              <CircleAlert
                size={16}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
            )}
            <span>{notice.text}</span>
          </div>
        ) : null}
        {receipt ? <details className="mt-4 border-y border-line py-2"><summary>Last confirmed MCP receipt</summary><p className="text-sm">{receipt}</p></details> : null}

        {showAddForm ? (
          <form
            className="mt-5 border-t border-line pt-5"
            onSubmit={(event) => void addConnection(event)}
          >
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold">New MCP connection</h3>
                <p className="mt-1 text-xs leading-5 text-muted">
                  {endpoint.trim() === GITHUB_MCP_ENDPOINT
                    ? "GitHub read tools run directly; write and Actions operations pause for approval."
                    : "New tools use risk level 2 and require approval by default."}
                </p>
              </div>
              <span className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-full border border-line bg-background px-2.5 py-1 text-xs font-semibold text-muted sm:mt-0">
                <ShieldCheck size={13} aria-hidden="true" />
                {endpoint.trim() === GITHUB_MCP_ENDPOINT
                  ? "Risk governed"
                  : "Approval protected"}
              </span>
            </div>

            <div className="mt-4">
              <div className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/8 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                    <GitBranch size={17} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">Connect GitHub</p>
                    <p className="mt-1 max-w-3xl text-xs leading-5 text-muted">
                      Use GitHub&apos;s official MCP endpoint with an app-encrypted
                      personal access token. Private repository access comes from
                      the repositories and scopes granted to that token. Read-only
                      checks run normally; writes and actions require approval.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={applyGitHubPreset}
                  disabled={
                    busy ||
                    Boolean(disabledReason) ||
                    vaultUnavailable ||
                    githubPresetApplied
                  }
                  title={
                    disabledReason ||
                    (vaultUnavailable
                      ? "Encrypted credential storage is required for the GitHub preset."
                      : undefined)
                  }
                  className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-primary/35 bg-background px-3 text-xs font-semibold text-foreground transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <GitBranch size={14} aria-hidden="true" />
                  {githubPresetApplied
                    ? "GitHub preset applied"
                    : "Use GitHub preset"}
                </button>
              </div>

            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Field label="Connection name" htmlFor="mcp-connection-name">
                <input
                  id="mcp-connection-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Connection name"
                  maxLength={120}
                  disabled={busy || Boolean(disabledReason)}
                  className="min-h-11 w-full border border-line bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                />
              </Field>
              <Field label="MCP server URL" htmlFor="mcp-connection-endpoint">
                <input
                  id="mcp-connection-endpoint"
                  type="url"
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  placeholder="https://api.example.com/mcp"
                  maxLength={2048}
                  disabled={busy || Boolean(disabledReason)}
                  className="min-h-11 w-full border border-line bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                />
              </Field>
            </div>

            <fieldset className="mt-4">
              <legend className="text-xs font-semibold text-foreground">
                Authentication
              </legend>
              <label
                className={clsx(
                  "mt-2 flex cursor-pointer items-start gap-3 rounded-md border p-4 transition",
                  authType === "bearer_vault"
                    ? "border-primary/45 bg-primary/8"
                    : "border-line bg-background hover:bg-surface-raised",
                  vaultUnavailable && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="radio"
                  name="mcp-auth-type"
                  value="bearer_vault"
                  checked={authType === "bearer_vault"}
                  onChange={() => setAuthType("bearer_vault")}
                  disabled={busy || Boolean(disabledReason) || vaultUnavailable}
                  className="mt-1 accent-[var(--primary)]"
                />
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                  <LockKeyhole size={16} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">
                    Store token securely in Asael
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-muted">
                    Recommended. Encrypted by the app and never shown again after
                    it is saved.
                  </span>
                </span>
              </label>
            </fieldset>

            {authType === "bearer_vault" ? (
              <div className="mt-4">
                <Field
                  label="Provider token"
                  htmlFor="mcp-bearer-token"
                >
                  <input
                    id="mcp-bearer-token"
                    name="new-mcp-bearer-token"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={bearerToken}
                    onChange={(event) => setBearerToken(event.target.value)}
                    placeholder="Paste token — it will not be displayed again"
                    disabled={busy || Boolean(disabledReason) || vaultUnavailable}
                    className="min-h-11 w-full border border-line bg-background px-3 font-mono text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                  />
                </Field>
              </div>
            ) : null}

            <div className="mt-4 border-t border-line pt-3">
              <button
                type="button"
                onClick={() => setAdvancedAuthOpen((current) => !current)}
                className="flex min-h-10 w-full items-center justify-between gap-3 text-left text-sm font-semibold"
                aria-expanded={advancedAuthOpen}
              >
                <span>
                  Advanced authentication
                  {authType !== "bearer_vault" ? (
                    <span className="ml-2 font-normal text-primary">
                      {authType === "bearer_env"
                        ? "Deployment environment"
                        : "No authentication"}
                    </span>
                  ) : null}
                </span>
                <ChevronDown
                  size={16}
                  className={clsx(
                    "text-muted transition-transform",
                    advancedAuthOpen && "rotate-180",
                  )}
                  aria-hidden="true"
                />
              </button>
              {advancedAuthOpen ? (
                <fieldset className="grid gap-3 pb-1 pt-3 md:grid-cols-2">
                  <legend className="sr-only">Advanced authentication method</legend>
                  <AdvancedAuthChoice
                    value="bearer_env"
                    selected={authType === "bearer_env"}
                    title="Deployment environment"
                    description="Reference a server-side environment variable managed by your deployment platform."
                    icon={ServerCog}
                    disabled={busy || Boolean(disabledReason)}
                    onSelect={setAuthType}
                  />
                  <AdvancedAuthChoice
                    value="none"
                    selected={authType === "none"}
                    title="No authentication"
                    description="Use only when the MCP server intentionally accepts unauthenticated requests."
                    icon={PowerOff}
                    disabled={busy || Boolean(disabledReason)}
                    onSelect={setAuthType}
                  />
                </fieldset>
              ) : null}
            </div>

            {authType === "bearer_env" ? (
              <div className="mt-4">
                <Field
                  label="Environment variable name"
                  htmlFor="mcp-token-env"
                >
                  <input
                    id="mcp-token-env"
                    value={authTokenEnv}
                    onChange={(event) =>
                      setAuthTokenEnv(event.target.value.toUpperCase())
                    }
                    placeholder="OMNIAGENT_CONNECTOR_GITHUB_TOKEN"
                    pattern="[A-Z0-9_]+"
                    maxLength={120}
                    spellCheck={false}
                    disabled={busy || Boolean(disabledReason)}
                    className="min-h-11 w-full border border-line bg-background px-3 font-mono text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                  />
                </Field>
              </div>
            ) : null}

            <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={discoverOnAdd}
                  onChange={(event) => setDiscoverOnAdd(event.target.checked)}
                  disabled={busy || Boolean(disabledReason)}
                  className="mt-0.5 accent-[var(--primary)]"
                />
                <span>
                  <span className="font-semibold">Discover tools now</span>
                  <span className="block text-xs leading-5 text-muted">
                    Changed tool contracts still require review before use.
                  </span>
                </span>
              </label>
              <div className="flex gap-2">
                {connectors.length ? (
                  <button
                    type="button"
                    onClick={() => {
                      resetAddForm();
                      setAdding(false);
                    }}
                    disabled={busy}
                    className="min-h-11 rounded-md border border-line bg-background px-4 text-sm font-semibold transition hover:bg-surface-raised disabled:opacity-60"
                  >
                    Cancel
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={busy || Boolean(disabledReason)}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {pendingAction === "create" ? (
                    <Loader2
                      size={15}
                      className="animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Plus size={15} aria-hidden="true" />
                  )}
                  {pendingAction === "create"
                    ? "Adding connection…"
                    : "Add connection"}
                </button>
              </div>
            </div>
          </form>
        ) : null}

        <div className="mt-5 border-t border-line pt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Managed connections</h3>
              <p className="mt-1 text-xs leading-5 text-muted">
                {connectors.length
                  ? `${connectors.length} ${connectors.length === 1 ? "server" : "servers"} registered in this workspace.`
                  : !payload || error ? "Current MCP inventory count is unavailable." : loading ? "Checking current MCP inventory…" : "No MCP servers were returned by this inventory read."}
              </p>
            </div>
            {loading ? (
              <span className="inline-flex items-center gap-2 text-xs font-semibold text-muted">
                <Loader2
                  size={14}
                  className="animate-spin"
                  aria-hidden="true"
                />
                Refreshing
              </span>
            ) : null}
          </div>

          {loading && !connectors.length ? (
            <div
              className="mt-4 space-y-3"
              role="status"
              aria-label="Loading MCP connections"
            >
              {[0, 1].map((item) => (
                <div
                  key={item}
                  className="rounded-md border border-line bg-background p-4"
                >
                  <div className="h-4 w-40 animate-pulse rounded bg-surface-raised" />
                  <div className="mt-3 h-3 w-64 max-w-full animate-pulse rounded bg-surface-raised" />
                </div>
              ))}
            </div>
          ) : connectors.length ? (
            <div className="mt-4 space-y-3">
              {connectors.map((connector) => (
                <ConnectionRow
                  key={connector.id}
                  connector={connector}
                  busy={busy}
                  pendingAction={pendingAction}
                  disabledReason={disabledReason}
                  credentialStorageUnavailable={vaultUnavailable}
                  credentialEditorOpen={credentialEditorId === connector.id}
                  credentialValue={
                    credentialEditorId === connector.id ? credentialValue : ""
                  }
                  confirmRemoveCredential={
                    confirmRemoveCredentialId === connector.id
                  }
                  confirmDelete={confirmDeleteId === connector.id}
                  deletePreview={deletePreviews[connector.id]}
                  onCredentialValueChange={setCredentialValue}
                  onToggleCredentialEditor={() =>
                    openCredentialEditor(connector.id)
                  }
                  onRotateCredential={() => void rotateCredential(connector)}
                  onToggleRemoveCredential={() => {
                    setCredentialValue("");
                    setCredentialEditorId(undefined);
                    setConfirmDeleteId(undefined);
                    setConfirmRemoveCredentialId((current) =>
                      current === connector.id ? undefined : connector.id,
                    );
                  }}
                  onRemoveCredential={() => void removeCredential(connector)}
                  onRediscover={() => void rediscover(connector)}
                  onUpgradeGitHub={() =>
                    void upgradeGitHubConnection(connector)
                  }
                  onToggleEnabled={() =>
                    void setConnectorEnabled(
                      connector,
                      connector.status !== "active",
                    )
                  }
                  onToggleDelete={() => void prepareDelete(connector)}
                  onDelete={() => void deleteConnection(connector, Date.now())}
                />
              ))}
            </div>
          ) : !error ? (
            <div className="mt-4 rounded-md border border-dashed border-line bg-background p-4 text-sm leading-6 text-muted">
              Add a server above. Asael will discover its tools and hold any
              new contracts for review.
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ConnectionRow({
  connector,
  busy,
  pendingAction,
  disabledReason,
  credentialStorageUnavailable,
  credentialEditorOpen,
  credentialValue,
  confirmRemoveCredential,
  confirmDelete,
  deletePreview,
  onCredentialValueChange,
  onToggleCredentialEditor,
  onRotateCredential,
  onToggleRemoveCredential,
  onRemoveCredential,
  onRediscover,
  onUpgradeGitHub,
  onToggleEnabled,
  onToggleDelete,
  onDelete,
}: {
  connector: McpConnector;
  busy: boolean;
  pendingAction?: string;
  disabledReason?: string;
  credentialStorageUnavailable: boolean;
  credentialEditorOpen: boolean;
  credentialValue: string;
  confirmRemoveCredential: boolean;
  confirmDelete: boolean;
  deletePreview?: TrashActionPreviewV1;
  onCredentialValueChange: (value: string) => void;
  onToggleCredentialEditor: () => void;
  onRotateCredential: () => void;
  onToggleRemoveCredential: () => void;
  onRemoveCredential: () => void;
  onRediscover: () => void;
  onUpgradeGitHub: () => void;
  onToggleEnabled: () => void;
  onToggleDelete: () => void;
  onDelete: () => void;
}) {
  const active = connector.status === "active";
  const pendingReview = connector.review?.pendingCount || 0;
  const appManaged = connector.authType === "bearer_vault";
  const credentialConfigured = Boolean(connector.credentialConfigured);
  const legacyGitHubEndpoint = isLegacyGitHubMcpEndpoint(connector.endpoint);
  const credentialUnavailableReason =
    appManaged && credentialStorageUnavailable
      ? "Encrypted credential storage is unavailable."
      : appManaged && connector.credentialOriginMatch === false
        ? "The stored token is not bound to this server origin. Rotate it before using the connection."
        : appManaged && !credentialConfigured
          ? "Add a token before using this connection."
          : undefined;

  return (
    <article className="rounded-md border border-line bg-background p-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <ServerCog size={15} aria-hidden="true" />
            </span>
            <h4 className="text-sm font-semibold">{connectorLabel(connector)}</h4>
            <StatusPill status={connector.status} />
            {pendingReview ? (
              <span className="rounded-full border border-warning/35 bg-warning/10 px-2 py-1 text-xs font-semibold text-warning">
                {pendingReview} {pendingReview === 1 ? "change" : "changes"} to review
              </span>
            ) : null}
          </div>
          <p className="mt-2 break-words font-mono text-xs text-muted">
            {displayEndpoint(connector.endpoint)}
          </p>
          <p className="mt-1 break-words font-mono text-xs text-muted">Connection {connector.id}</p>
          {isOfficialGitHubMcpEndpoint(connector.endpoint) ? (
            <p className="mt-2 text-xs leading-5 text-muted">
              Built-in agents discover reviewed GitHub tools automatically.
              Assign specific GitHub tools to custom agents under{" "}
              <a className="font-semibold text-primary hover:underline" href="/app/agents">
                Agents
              </a>
              .
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 xl:justify-end">
          {legacyGitHubEndpoint ? (
            <ActionButton
              label="Add Actions tools"
              icon={GitBranch}
              busy={pendingAction === `upgrade-github-${connector.id}`}
              disabled={
                busy || Boolean(disabledReason) || Boolean(credentialUnavailableReason)
              }
              title={disabledReason || credentialUnavailableReason}
              onClick={onUpgradeGitHub}
            />
          ) : null}
          <ActionButton
            label="Rediscover tools"
            icon={RefreshCw}
            busy={pendingAction === `discover-${connector.id}`}
            disabled={
              busy || Boolean(disabledReason) || Boolean(credentialUnavailableReason)
            }
            title={disabledReason || credentialUnavailableReason}
            onClick={onRediscover}
          />
          <ActionButton
            label={active ? "Disable" : "Enable"}
            icon={active ? PowerOff : Power}
            busy={pendingAction === `status-${connector.id}`}
            disabled={
              busy ||
              Boolean(disabledReason) ||
              (!active && Boolean(credentialUnavailableReason))
            }
            title={
              disabledReason ||
              (!active ? credentialUnavailableReason : undefined)
            }
            onClick={onToggleEnabled}
          />
          <button
            type="button"
            onClick={onToggleDelete}
            disabled={busy || Boolean(disabledReason)}
            title={disabledReason}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-line bg-surface px-3 text-xs font-semibold text-muted transition hover:border-danger/40 hover:text-danger disabled:cursor-not-allowed disabled:opacity-55"
            aria-expanded={confirmDelete}
          >
            <Trash2 size={14} aria-hidden="true" />
            Delete
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-3">
        <ConnectionFact
          label="Authentication"
          value={authLabel(connector.authType)}
        />
        <ConnectionFact
          label="Tools"
          value={typeof connector.toolCount === "number" ? `${connector.toolCount} discovered` : "Count unavailable"}
        />
        <ConnectionFact
          label="Last discovery"
          value={formatDate(connector.lastDiscoveredAt)}
        />
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={clsx(
              "grid size-8 shrink-0 place-items-center rounded-md",
              appManaged && credentialConfigured
                ? "bg-primary/10 text-primary"
                : "bg-surface-raised text-muted",
            )}
          >
            {appManaged ? (
              <KeyRound size={15} aria-hidden="true" />
            ) : (
              <ServerCog size={15} aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold">
              {credentialStatusLabel(connector)}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              {credentialStatusDetail(connector)}
            </p>
          </div>
        </div>
        {appManaged ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={onToggleCredentialEditor}
              disabled={
                busy ||
                Boolean(disabledReason) ||
                credentialStorageUnavailable
              }
              title={
                disabledReason ||
                (credentialStorageUnavailable
                  ? "Encrypted credential storage is unavailable."
                  : undefined)
              }
              className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line bg-surface px-3 text-xs font-semibold transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-55"
              aria-expanded={credentialEditorOpen}
            >
              <RotateCcw size={14} aria-hidden="true" />
              {credentialConfigured ? "Rotate token" : "Add token"}
            </button>
            {credentialConfigured ? (
              <button
                type="button"
                onClick={onToggleRemoveCredential}
                disabled={
                  busy ||
                  Boolean(disabledReason) ||
                  credentialStorageUnavailable
                }
                title={
                  disabledReason ||
                  (credentialStorageUnavailable
                    ? "Encrypted credential storage is unavailable."
                    : undefined)
                }
                className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line bg-surface px-3 text-xs font-semibold text-muted transition hover:border-danger/40 hover:text-danger disabled:cursor-not-allowed disabled:opacity-55"
                aria-expanded={confirmRemoveCredential}
              >
                <Trash2 size={14} aria-hidden="true" />
                Remove token
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {credentialEditorOpen ? (
        <div className="mt-4 rounded-md border border-primary/30 bg-primary/8 p-4">
          <div className="flex items-start gap-3">
            <LockKeyhole
              size={17}
              className="mt-0.5 shrink-0 text-primary"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-semibold">
                {credentialConfigured ? "Replace stored token" : "Store token"}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                This field is write-only. It clears immediately when submitted,
                and the server will rediscover tools with the new credential.
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor={`credential-${connector.id}`}>
              Replacement token for {connectorLabel(connector)}
            </label>
            <input
              id={`credential-${connector.id}`}
              name={`new-credential-${connector.id}`}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={credentialValue}
              onChange={(event) => onCredentialValueChange(event.target.value)}
              placeholder="Paste replacement token"
              disabled={busy || Boolean(disabledReason)}
              className="min-h-11 min-w-0 flex-1 border border-line bg-surface px-3 font-mono text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={onRotateCredential}
              disabled={busy || Boolean(disabledReason) || !credentialValue}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {pendingAction === `credential-${connector.id}` ? (
                <Loader2
                  size={15}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <LockKeyhole size={15} aria-hidden="true" />
              )}
              {credentialConfigured ? "Rotate and rediscover" : "Store and rediscover"}
            </button>
          </div>
        </div>
      ) : null}

      {confirmRemoveCredential ? (
        <Confirmation
          title="Remove this token from Asael?"
          description="The connection will be disabled. Removing a token from Asael does not revoke it at the provider; revoke it separately in the provider account if it should no longer work anywhere."
          confirmLabel="Remove stored token"
          busy={pendingAction === `remove-credential-${connector.id}`}
          disabled={busy || Boolean(disabledReason)}
          onCancel={onToggleRemoveCredential}
          onConfirm={onRemoveCredential}
        />
      ) : null}

      {confirmDelete ? (
        <>
        {deletePreview ? <details><summary>Exact Trash preview</summary><dl><div><dt>Connection</dt><dd>{deletePreview.resourceId}</dd></div><div><dt>Target digest</dt><dd>{deletePreview.targetSha256}</dd></div><div><dt>Preview digest</dt><dd>{deletePreview.previewSha256}</dd></div><div><dt>Expires</dt><dd>{deletePreview.expiresAt}</dd></div></dl></details> : null}
        <Confirmation
          title={`Move ${connectorLabel(connector)} to Trash?`}
          description={`${deletePreview?.effectSummary || "This moves the connection and its discovered tools to reversible Trash."} Any provider token must still be revoked separately at the provider.`}
          confirmLabel="Move to Trash"
          busy={pendingAction === `delete-${connector.id}`}
          disabled={busy || Boolean(disabledReason)}
          onCancel={onToggleDelete}
          onConfirm={onDelete}
        />
        </>
      ) : null}
    </article>
  );
}

function AdvancedAuthChoice({
  value,
  selected,
  title,
  description,
  icon: Icon,
  disabled,
  onSelect,
}: {
  value: Extract<McpAuthType, "bearer_env" | "none">;
  selected: boolean;
  title: string;
  description: string;
  icon: typeof ServerCog;
  disabled: boolean;
  onSelect: (value: McpAuthType) => void;
}) {
  return (
    <label
      className={clsx(
        "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition",
        selected
          ? "border-primary/45 bg-primary/8"
          : "border-line bg-background hover:bg-surface-raised",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="radio"
        name="mcp-auth-type"
        value={value}
        checked={selected}
        onChange={() => onSelect(value)}
        disabled={disabled}
        className="mt-1 accent-[var(--primary)]"
      />
      <Icon size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-muted">
          {description}
        </span>
      </span>
    </label>
  );
}

function ActionButton({
  label,
  icon: Icon,
  busy,
  disabled,
  title,
  onClick,
}: {
  label: string;
  icon: typeof RefreshCw;
  busy: boolean;
  disabled: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-line bg-surface px-3 text-xs font-semibold transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-55"
    >
      {busy ? (
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      ) : (
        <Icon size={14} aria-hidden="true" />
      )}
      {label}
    </button>
  );
}

function Confirmation({
  title,
  description,
  confirmLabel,
  busy,
  disabled,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-md border border-danger/30 bg-danger/8 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted">
          {description}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className="min-h-10 rounded-md border border-line bg-background px-3 text-sm font-semibold disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={disabled}
          className="inline-flex min-h-10 items-center gap-2 rounded-md bg-danger px-3 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 size={14} aria-hidden="true" />
          )}
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1.5 block text-xs font-semibold text-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function ConnectionFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 truncate text-xs font-semibold" title={value}>
        {value}
      </p>
    </div>
  );
}

function StatusPill({ status }: { status?: string }) {
  const normalized = status || "unknown";
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-semibold",
        normalized === "active"
          ? "border-primary/30 bg-primary/10 text-primary"
          : normalized === "error"
            ? "border-danger/35 bg-danger/10 text-danger"
            : "border-line bg-surface text-muted",
      )}
    >
      <span
        className={clsx(
          "size-1.5 rounded-full",
          normalized === "active"
            ? "bg-primary"
            : normalized === "error"
              ? "bg-danger"
              : "bg-muted",
        )}
        aria-hidden="true"
      />
      {capitalize(normalized)}
    </span>
  );
}

function credentialStatusLabel(connector: McpConnector) {
  if (connector.authType === "bearer_vault") {
    if (
      connector.credentialConfigured &&
      connector.credentialOriginMatch === false
    ) {
      return "Stored token origin mismatch";
    }
    return connector.credentialConfigured
      ? "Token stored · ••••••••"
      : "Stored token required";
  }
  if (connector.authType === "bearer_env") {
    return "Deployment token reference";
  }
  return "No token used";
}

function credentialStatusDetail(connector: McpConnector) {
  if (connector.authType === "bearer_vault") {
    if (!connector.credentialConfigured) {
      return "Add a token to authenticate this connection.";
    }
    if (connector.credentialOriginMatch === false) {
      return "This credential is not bound to the current server origin. Verify the endpoint, then rotate the token.";
    }
    return [
      connector.credentialVersion
        ? `Version ${connector.credentialVersion}`
        : undefined,
      connector.credentialFingerprint
        ? `Fingerprint ${connector.credentialFingerprint}`
        : undefined,
      connector.credentialRotatedAt
        ? `Updated ${formatDate(connector.credentialRotatedAt)}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || "Encrypted by Asael. The token cannot be viewed or copied.";
  }
  if (connector.authType === "bearer_env") {
    return "The token reference is managed by the deployment environment and is not stored in this app. Runtime availability is reported by the connection status.";
  }
  return "This server is contacted without an Authorization token.";
}

function authLabel(authType?: McpAuthType) {
  if (authType === "bearer_vault") return "App-encrypted token";
  if (authType === "bearer_env") return "Deployment environment";
  return "None";
}

function connectorLabel(connector: McpConnector) {
  return connector.name?.trim() || "MCP connection";
}

function displayEndpoint(endpoint?: string) {
  if (!endpoint) return "Endpoint unavailable";
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "Endpoint unavailable";
  }
}

function isOfficialGitHubMcpEndpoint(endpoint?: string) {
  if (!endpoint) return false;
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.githubcopilot.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/"))
    );
  } catch {
    return false;
  }
}

function isLegacyGitHubMcpEndpoint(endpoint?: string) {
  if (!isOfficialGitHubMcpEndpoint(endpoint) || !endpoint) return false;
  const pathname = new URL(endpoint).pathname.replace(/\/+$/, "");
  return pathname === "/mcp";
}

function formatDate(value?: string) {
  if (!value) return "Not yet";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Not yet";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

function asMcpPayload(value: unknown): McpPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as McpPayload;
}

function requestHeaders(hasBody: boolean) {
  return {
    accept: "application/json",
    "idempotency-key": crypto.randomUUID(),
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };
}

type ConnectorRequestResult = {
  error?: unknown;
  message?: unknown;
  discoveryFailed?: unknown;
  credentialSaved?: unknown;
  connectionCreated?: unknown;
};

async function requestJson<T extends ConnectorRequestResult = ConnectorRequestResult>(
  path: string,
  init: RequestInit,
  fallbackError: string,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    signal: init.signal || AbortSignal.timeout(70_000),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!isJsonRecord(body)) throw new ConnectorRequestError("No complete connection receipt was received. The outcome is unconfirmed; refresh before trying again.");
  const result = body as T;
  if (!response.ok || result.error || result.discoveryFailed) {
    throw new ConnectorRequestError(
      safeRequestError(fallbackError, response.status, result),
      result.credentialSaved === true,
      result.connectionCreated === true,
      result,
    );
  }
  return result;
}

function safeRequestError(
  fallbackError: string,
  status: number,
  result?: {
    error?: unknown;
    message?: unknown;
    credentialSaved?: unknown;
    connectionCreated?: unknown;
  },
) {
  const detail = [result?.message, result?.error].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0 && value.length <= 300,
  );
  const partialSuccess = result?.connectionCreated === true
    ? result.credentialSaved === true
      ? "Connection and token saved, but tool discovery failed."
      : "Connection saved, but tool discovery failed."
    : result?.credentialSaved === true
      ? "Token saved, but tool discovery failed."
      : undefined;
  if (partialSuccess) {
    return detail ? `${partialSuccess} ${detail.trim()}` : partialSuccess;
  }
  if (detail) return `${fallbackError} ${detail.trim()}`;
  if (status === 400) return `${fallbackError} Check the connection details.`;
  if (status === 401) return `${fallbackError} Sign in and try again.`;
  if (status === 403) return `${fallbackError} An admin role is required.`;
  if (status === 409) return `${fallbackError} Refresh the connector and review its current contracts.`;
  if (status === 502) return `${fallbackError} The MCP server could not be reached.`;
  if (status === 503) return `${fallbackError} Encrypted credential storage is unavailable.`;
  return `${fallbackError} Server returned ${status}.`;
}

class ConnectorRequestError extends Error {
  constructor(
    message: string,
    readonly credentialSaved = false,
    readonly connectionCreated = false,
    readonly result?: unknown,
  ) {
    super(message);
    this.name = "ConnectorRequestError";
  }
}
