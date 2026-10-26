"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  Film,
  ImageIcon,
  Layers2,
  MessageSquareText,
  Plus,
  Search,
  Workflow,
} from "lucide-react";
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
import styles from "./landing.module.css";

// The saved-flow landing does not need graph validation, media previews, or a canvas.
// Load the editing workspace only after a flow is opened or explicitly created.
const Editor = dynamic(
  () => import("./workspace").then((module) => module.StudioWorkspace),
  {
    ssr: false,
    loading: () => (
      <section className={styles.session} role="status">
        <h1>Opening your flow</h1>
        <p>Your steps, results and history are on their way.</p>
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
      <section className={styles.session}>
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
  const [search, setSearch] = useState("");
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
        onBack={() => {
          setSelectedFlow(undefined);
          setLoading(true);
          setError("");
        }}
      />
    );
  const visible = flows.filter(
    (flow) =>
      !flow.archived &&
      (!props.initialProjectId || flow.projectId === props.initialProjectId),
  );
  const matchingFlows = visible.filter((flow) =>
    flow.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const primaryTemplate = props.templates.find(
    (template) => template.id === "image-to-video",
  );
  const secondaryTemplates = props.templates.filter(
    (template) => template.id !== "image-to-video",
  );
  return (
    <section
      className={styles.landing}
      aria-label="Visual Studio"
      data-testid="creative-studio-landing"
    >
      <header className={styles.header}>
        <div>
          <h1>What will you create?</h1>
          <p>Start with an idea. Shape it into images and video.</p>
        </div>
        <button
          className={styles.button}
          disabled={!writable || busy || Boolean(pending)}
          onClick={() => void createFlow()}
        >
          <Plus size={16} aria-hidden="true" />
          New blank flow
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
      <section className={styles.starters} aria-label="Start from a template">
        {primaryTemplate ? (
          <article className={styles.primaryStarter}>
            <div className={styles.starterCopy}>
              <h2>{primaryTemplate.name}</h2>
              <p>{primaryTemplate.description}</p>
            </div>
            <ol className={styles.path} aria-label="Image to video steps">
              <li>
                <MessageSquareText size={20} aria-hidden="true" />
                <span>Your idea</span>
              </li>
              <li>
                <ArrowRight
                  className={styles.pathArrow}
                  size={16}
                  aria-hidden="true"
                />
                <ImageIcon size={20} aria-hidden="true" />
                <span>Create an image</span>
              </li>
              <li>
                <ArrowRight
                  className={styles.pathArrow}
                  size={16}
                  aria-hidden="true"
                />
                <Film size={20} aria-hidden="true" />
                <span>Bring it to life</span>
              </li>
            </ol>
            <button
              className={styles.primary}
              disabled={!writable || busy || Boolean(pending)}
              onClick={() => void createFlow(primaryTemplate.id)}
            >
              Start image to video
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </article>
        ) : null}
        {secondaryTemplates.length ? (
          <div className={styles.secondaryStarters}>
            <h2>Other starting points</h2>
            {secondaryTemplates.map((template) => (
              <button
                key={template.id}
                className={styles.templateRow}
                disabled={!writable || busy || Boolean(pending)}
                onClick={() => void createFlow(template.id)}
              >
                {template.id === "product-scene" ? (
                  <ImageIcon size={20} aria-hidden="true" />
                ) : (
                  <Layers2 size={20} aria-hidden="true" />
                )}
                <span>
                  <strong>{template.name}</strong>
                  <small>{template.description}</small>
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : null}
      </section>
      <p className={styles.guidance}>
        Creating a flow does not generate media. Review the models and cost
        before you run it. Demo steps use clearly labelled sample media.
      </p>
      <section className={styles.saved} aria-labelledby="studio-saved-flows">
        <div className={styles.savedHeading}>
          <h2 id="studio-saved-flows">Your flows</h2>
          {visible.length ? (
            <label className={styles.search}>
              <span className={styles.srOnly}>Find a saved flow</span>
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Find a flow…"
              />
            </label>
          ) : null}
        </div>
        {loading ? (
          <div className={styles.loading} role="status">
            <span className={styles.srOnly}>Loading your saved flows…</span>
            <div className={styles.skeletonRow} aria-hidden="true" />
            <div className={styles.skeletonRow} aria-hidden="true" />
            <div className={styles.skeletonRow} aria-hidden="true" />
          </div>
        ) : matchingFlows.length ? (
          <ul className={styles.flowList}>
            {matchingFlows.map((flow) => (
              <li key={flow.id}>
                <button
                  className={styles.flowRow}
                  disabled={busy}
                  onClick={() => openFlow(flow.id)}
                >
                  <Workflow size={20} aria-hidden="true" />
                  <span className={styles.flowName}>
                    <strong>{flow.name}</strong>
                    <small>
                      {flow.nodeCount} step{flow.nodeCount === 1 ? "" : "s"}
                    </small>
                  </span>
                  <time
                    className={styles.updated}
                    dateTime={flow.updatedAt}
                    title={new Date(flow.updatedAt).toLocaleString()}
                  >
                    Updated{" "}
                    {new Date(flow.updatedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </time>
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : visible.length ? (
          <div className={styles.emptyFlows}>
            <p>No flows match “{search.trim()}”.</p>
            <button className={styles.button} onClick={() => setSearch("")}>
              Clear search
            </button>
          </div>
        ) : !error ? (
          <div className={styles.emptyFlows}>
            <Workflow size={24} aria-hidden="true" />
            <div>
              <p>Your next idea starts here.</p>
              <p className={styles.support}>
                Choose a starting point above. Your saved flows and results will
                stay here when you return.
              </p>
            </div>
          </div>
        ) : null}
      </section>
    </section>
  );
}
