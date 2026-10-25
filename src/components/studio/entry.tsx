"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { FolderOpen, Plus, Workflow } from "lucide-react";
import {
  canPerform,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";
import { workspaceOwnerScope } from "@/components/app-shell/workspace-owner-scope";
import type { StudioCapability } from "@/lib/studio/capabilities";
import type { StudioTemplateId } from "@/lib/studio/templates";
import {
  StudioClient,
  StudioScopeChanged,
  errorMessage,
  uncertainFailure,
} from "./transport";
import styles from "./studio.module.css";

// The saved-flow landing does not need graph validation, media previews, or a canvas.
// Load the editing workspace only after a flow is opened or explicitly created.
const Editor = dynamic(
  () => import("./workspace").then((module) => module.StudioWorkspace),
  {
    ssr: false,
    loading: () => (
      <section className={styles.empty} role="status">
        <h1>Visual Studio</h1>
        <p>Opening your saved flow and run history…</p>
        <div className={styles.skeleton} aria-hidden="true" />
      </section>
    ),
  },
);
type Props = {
  initialFlowId?: string;
  initialProjectId?: string;
  deployment: string;
  templates: { id: StudioTemplateId; name: string; description: string }[];
};
type FlowSummary = {
  id: string;
  name: string;
  projectId?: string | null;
  updatedAt: string;
  nodeCount: number;
  archived: boolean;
};
type PendingCreate = { key: string; body: Record<string, unknown> };
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
}
function storedFlow(owner: string) {
  if (typeof sessionStorage === "undefined") return undefined;
  try {
    const value = sessionStorage.getItem(`asael:studio-last-flow:${owner}`);
    return validId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
function storedCreate(owner: string): PendingCreate | undefined {
  if (typeof sessionStorage === "undefined") return undefined;
  try {
    const value = JSON.parse(
      sessionStorage.getItem(`asael:studio-create:${owner}`) || "null",
    );
    if (
      value &&
      typeof value.key === "string" &&
      value.key &&
      value.body &&
      typeof value.body === "object" &&
      !Array.isArray(value.body) &&
      typeof value.body.name === "string"
    )
      return { key: value.key, body: value.body };
  } catch {
    /* The server validates any recovered creation before saving it. */
  }
}
function flowSummaries(value: unknown): FlowSummary[] {
  if (!Array.isArray(value))
    throw new Error("Saved flows could not be read. Retry the list.");
  return value.map((flow) => {
    if (
      !flow ||
      !validId(flow.id) ||
      typeof flow.name !== "string" ||
      typeof flow.updatedAt !== "string"
    )
      throw new Error("The flow list is incomplete. Retry the list.");
    return {
      id: flow.id,
      name: flow.name,
      updatedAt: flow.updatedAt,
      projectId: typeof flow.projectId === "string" ? flow.projectId : null,
      archived: flow.archived === true,
      nodeCount: Array.isArray(flow.graph?.nodes) ? flow.graph.nodes.length : 0,
    };
  });
}

export function StudioEntry(props: Props) {
  const { session, status, role } = useWorkspaceSession();
  const owner = workspaceOwnerScope(session, role, props.deployment);
  if (status !== "ready" || !owner)
    return (
      <section className={styles.empty}>
        <h1>Visual Studio</h1>
        <p>
          {status === "loading"
            ? "Checking your workspace…"
            : "Your workspace session is unavailable. Sign in or refresh to continue."}
        </p>
      </section>
    );
  return (
    <OwnedEntry
      key={owner}
      {...props}
      owner={owner}
      writable={
        canPerform(role, "manage.workflow") && canPerform(role, "execute.tool")
      }
    />
  );
}
function OwnedEntry({
  owner,
  writable,
  ...props
}: Props & { owner: string; writable: boolean }) {
  const [client] = useState(() => new StudioClient(undefined, 30_000, owner));
  const [selectedFlow, setSelectedFlow] = useState(
    () =>
      props.initialFlowId ||
      (!props.initialProjectId ? storedFlow(owner) : undefined),
  );
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [pending, setPending] = useState(() => storedCreate(owner));
  const [loading, setLoading] = useState(!selectedFlow);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  function openFlow(id: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("flow", id);
    window.history.replaceState(null, "", url);
    try {
      sessionStorage.setItem(`asael:studio-last-flow:${owner}`, id);
    } catch {
      /* The address still preserves the selected flow. */
    }
    setSelectedFlow(id);
  }
  useEffect(() => {
    if (selectedFlow) return;
    client.activate();
    let alive = true;
    void client
      .json<{ flows: unknown }>("/api/studio/flows")
      .then((response) => {
        if (alive) setFlows(flowSummaries(response.flows));
      })
      .catch((error) => {
        if (alive && !(error instanceof StudioScopeChanged))
          setError(errorMessage(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      client.dispose();
    };
  }, [client, selectedFlow, reload]);

  async function createFlow(template?: StudioTemplateId) {
    if (!writable || busy) return;
    setBusy(true);
    setError("");
    const receiptKey = `asael:studio-create:${owner}`;
    let submission = pending;
    try {
      if (!submission) {
        let graph = {
          schemaVersion: 1 as const,
          nodes: [],
          edges: [],
        } as import("@/lib/studio/contracts").StudioGraph;
        if (template) {
          const [factory, response] = await Promise.all([
            import("@/lib/studio/templates"),
            client.json<{ capabilities: StudioCapability[] }>(
              "/api/studio/capabilities",
            ),
          ]);
          graph = factory.createStudioTemplate(template, response.capabilities);
        }
        submission = {
          key: crypto.randomUUID(),
          body: {
            name: template
              ? props.templates.find((value) => value.id === template)?.name ||
                "Untitled flow"
              : "Untitled flow",
            description: "",
            graph,
            viewport: { x: 0, y: 0, zoom: 1 },
            projectId: props.initialProjectId,
          },
        };
        setPending(submission);
        try {
          sessionStorage.setItem(receiptKey, JSON.stringify(submission));
        } catch {
          /* Keep the same in-memory receipt when tab storage is unavailable. */
        }
      }
      const response = await client.post<{ flow: { id?: unknown } }>(
        "/api/studio/flows",
        submission.body,
        submission.key,
      );
      if (!validId(response.flow?.id))
        throw new Error(
          "Flow creation returned an incomplete receipt. Recover this same creation before trying again.",
        );
      setPending(undefined);
      try {
        sessionStorage.removeItem(receiptKey);
      } catch {}
      openFlow(response.flow.id);
    } catch (error) {
      if (!uncertainFailure(error)) {
        setPending(undefined);
        try {
          sessionStorage.removeItem(receiptKey);
        } catch {}
      }
      if (!(error instanceof StudioScopeChanged)) setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (selectedFlow)
    return (
      <Editor
        initialFlowId={selectedFlow}
        initialProjectId={props.initialProjectId}
        deployment={props.deployment}
      />
    );
  const visible = flows.filter(
    (flow) =>
      !flow.archived &&
      (!props.initialProjectId || flow.projectId === props.initialProjectId),
  );
  return (
    <section
      className={styles.studio}
      aria-label="Visual Studio"
      data-testid="creative-studio-landing"
    >
      <header className={styles.toolbar}>
        <div className={styles.titleGroup}>
          <Workflow size={24} aria-hidden="true" />
          <div>
            <h1>Visual Studio</h1>
            <p>Create images and videos in reusable flows</p>
          </div>
        </div>
        <button
          className={styles.primary}
          disabled={!writable || busy || Boolean(pending)}
          onClick={() => void createFlow()}
        >
          <Plus size={16} aria-hidden="true" />
          New flow
        </button>
      </header>
      {!writable ? (
        <div className={styles.notice}>
          Your current role can view flows and results. Editing and running
          require an operator role.
        </div>
      ) : null}
      {error ? (
        <div className={styles.notice} data-tone="error" role="alert">
          <p>{error}</p>
          {!pending ? (
            <button
              className={styles.button}
              disabled={busy}
              onClick={() => {
                setLoading(true);
                setError("");
                setReload((value) => value + 1);
              }}
            >
              Retry saved flows
            </button>
          ) : null}
        </div>
      ) : null}
      {busy || pending ? (
        <div
          className={styles.notice}
          data-tone={busy ? "info" : "warning"}
          role="status"
        >
          <p>
            {busy
              ? "Preparing and saving this flow…"
              : "Flow creation is unconfirmed. Recover the original result before creating another flow."}
          </p>
          {pending ? (
            <button
              className={styles.button}
              disabled={busy || !writable}
              onClick={() => void createFlow()}
            >
              Recover flow creation
            </button>
          ) : null}
        </div>
      ) : null}
      <div className={styles.empty}>
        <h2>Your creative workflows</h2>
        <p>
          Connect a prompt and references to image and video models. Saved flows
          retain their results and run history.
        </p>
        <h3 className={styles.sectionHeading}>Start from a template</h3>
        {props.templates.map((template) => (
          <button
            key={template.id}
            className={styles.libraryItem}
            disabled={!writable || busy || Boolean(pending)}
            onClick={() => void createFlow(template.id)}
          >
            <Workflow size={20} aria-hidden="true" />
            <span>
              <strong>{template.name}</strong>
              <small>{template.description}</small>
            </span>
          </button>
        ))}
        <p className={styles.support}>
          Templates use available models. Demo operations are clearly labeled
          and create fixed fixture files without paid requests.
        </p>
        <h3 className={styles.sectionHeading}>Saved flows</h3>
        {loading ? (
          <p className={styles.support} role="status">
            Loading your saved flows…
          </p>
        ) : visible.length ? (
          <div className={styles.flowList}>
            {visible.map((flow) => (
              <div className={styles.flowRow} key={flow.id}>
                <button disabled={busy} onClick={() => openFlow(flow.id)}>
                  <strong>{flow.name}</strong>
                  <small>
                    {flow.nodeCount} nodes · Updated{" "}
                    {new Date(flow.updatedAt).toLocaleString()}
                  </small>
                </button>
                <button
                  className={styles.button}
                  disabled={busy}
                  onClick={() => openFlow(flow.id)}
                >
                  <FolderOpen size={16} aria-hidden="true" />
                  Open flow
                </button>
              </div>
            ))}
          </div>
        ) : !error ? (
          <p className={styles.support}>
            Your first saved flow will appear here.
          </p>
        ) : null}
      </div>
    </section>
  );
}
