"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import {
  studioProjectProfileDefaults,
  studioProjectProfileInputSchema,
  type StudioGraph,
  type StudioProject,
  type StudioProjectProfileInput,
} from "@/lib/studio/contracts";
import {
  StudioClient,
  StudioResponseError,
  StudioScopeChanged,
  errorMessage,
  uncertainFailure,
} from "./transport";
import { readStudioProjects, studioEditableProfile } from "./project-state";
import styles from "./project.module.css";

const categories = [
  ["custom", "Custom"],
  ["fashion", "Fashion"],
  ["trading", "Trading"],
  ["ai-tech", "AI & Tech"],
] as const;
type ProjectReceipt = { key: string; body: Record<string, unknown> };
function recoverProjectReceipt(key: string): ProjectReceipt | undefined {
  if (typeof sessionStorage === "undefined") return;
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "null");
    if (
      value &&
      typeof value.key === "string" &&
      value.key &&
      studioProjectProfileInputSchema.safeParse(value.body?.profile).success
    )
      return value;
  } catch {
    /* Recover only a recognizable request; the server validates its fields. */
  }
}

export function StudioDialog({
  title,
  description,
  children,
  busy = false,
  onClose,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  busy?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = `studio-dialog-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  useEffect(() => {
    const dialog = ref.current;
    const invoker = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (invoker instanceof HTMLElement && invoker.isConnected)
        invoker.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <div>
          <h2 id={titleId}>{title}</h2>
          {description ? <p className={styles.support}>{description}</p> : null}
        </div>
        <button
          className={styles.quiet}
          aria-label={`Close ${title.toLowerCase()}`}
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function StudioProjectDialog({
  client,
  owner,
  project,
  writable,
  onSaved,
  onClose,
}: {
  client: StudioClient;
  owner: string;
  project?: StudioProject;
  writable: boolean;
  onSaved: (project: StudioProject) => void;
  onClose: () => void;
}) {
  const storageKey = `asael:studio-project-edit:${owner}:${project?.id || "new"}`;
  const [pending, setPending] = useState(() =>
    recoverProjectReceipt(storageKey),
  );
  const [title, setTitle] = useState(
    typeof pending?.body.title === "string"
      ? pending.body.title
      : project?.title || "",
  );
  const [profile, setProfile] = useState<StudioProjectProfileInput>(() =>
    pending
      ? studioProjectProfileInputSchema.parse(pending.body.profile)
      : project?.profile
        ? studioEditableProfile(project.profile)
        : studioProjectProfileDefaults("custom", project?.title || ""),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [revision, setRevision] = useState(project?.profile?.revision || 0);
  const mounted = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function update(change: Partial<StudioProjectProfileInput>) {
    setProfile((current) => ({ ...current, ...change }));
  }
  function persist(value?: ProjectReceipt) {
    setPending(value);
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* The same receipt remains available in this dialog. */
    }
  }
  async function save() {
    if (!writable || lock.current || conflict) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const submission = pending || {
      key: crypto.randomUUID(),
      body: project
        ? { revision, profile: studioEditableProfile(profile) }
        : {
            title: title.trim(),
            profile: {
              ...studioEditableProfile(profile),
              brandName: profile.brandName.trim() || title.trim(),
            },
          },
    };
    persist(submission);
    try {
      const response = await client.json<{ project: StudioProject }>(
        project
          ? `/api/studio/projects/${encodeURIComponent(project.id)}/profile`
          : "/api/studio/projects",
        {
          method: project ? "PATCH" : "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": submission.key,
          },
          body: JSON.stringify(submission.body),
        },
      );
      const saved = readStudioProjects([response.project])[0];
      if (!mounted.current) return;
      persist();
      onSaved(saved);
    } catch (failure) {
      if (!mounted.current || failure instanceof StudioScopeChanged) return;
      if (!uncertainFailure(failure)) persist();
      setConflict(
        failure instanceof StudioResponseError && failure.status === 409,
      );
      setError(errorMessage(failure));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function reloadProfile() {
    if (!project || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const response = await client.json<{ project: StudioProject }>(
        `/api/studio/projects/${encodeURIComponent(project.id)}/profile`,
      );
      const current = readStudioProjects([response.project])[0];
      if (!mounted.current) return;
      setProfile(
        current.profile
          ? studioEditableProfile(current.profile)
          : studioProjectProfileDefaults("custom", current.title),
      );
      setRevision(current.profile?.revision || 0);
      setConflict(false);
      setError("");
    } catch (failure) {
      if (mounted.current && !(failure instanceof StudioScopeChanged))
        setError(errorMessage(failure));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <StudioDialog
      title={project ? "Brand details" : "New project"}
      busy={busy}
      onClose={onClose}
      description={
        project
          ? `${project.title} · These details guide new flows. Existing flows keep their saved brand context until you apply an update.`
          : "Give each account its own creative home. Start with a category, then make it yours."
      }
    >
      <form
        className={styles.body}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {pending ? (
          <p className={styles.pending} role="status">
            {busy
              ? "Saving this request…"
              : "The save is unconfirmed. Recover this same request before changing the details."}
          </p>
        ) : null}
        <fieldset disabled={!writable || busy || Boolean(pending) || conflict}>
          {!project ? (
            <label className={styles.field}>
              Project name
              <input
                className={styles.input}
                value={title}
                required
                maxLength={160}
                placeholder="e.g. My fashion account"
                onChange={(event) => {
                  const value = event.target.value;
                  setTitle(value);
                  if (!profile.brandName || profile.brandName === title)
                    update({ brandName: value });
                }}
              />
            </label>
          ) : null}
          <label className={styles.field}>
            Starting category
            <select
              className={styles.select}
              value={profile.category}
              onChange={(event) =>
                setProfile({
                  ...studioProjectProfileDefaults(
                    event.target.value as StudioProjectProfileInput["category"],
                    profile.brandName || title,
                  ),
                  audience: profile.audience,
                  channels: profile.channels,
                })
              }
            >
              {categories.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <small>
              Fills in editable suggestions for your content and visual style.
            </small>
          </label>
          <label className={styles.field}>
            Brand or account name
            <input
              className={styles.input}
              value={profile.brandName}
              maxLength={160}
              required={Boolean(project)}
              placeholder="The name used in your content"
              onChange={(event) => update({ brandName: event.target.value })}
            />
          </label>
          <details className={styles.details} open={Boolean(project)}>
            <summary>Audience, style and content</summary>
            <div>
              <label className={styles.field}>
                Audience
                <textarea
                  className={styles.textarea}
                  value={profile.audience}
                  maxLength={800}
                  onChange={(event) => update({ audience: event.target.value })}
                  placeholder="Who is this for?"
                />
              </label>
              <label className={styles.field}>
                Content themes
                <textarea
                  className={styles.textarea}
                  value={profile.contentPillars.join("\n")}
                  onChange={(event) =>
                    update({ contentPillars: event.target.value.split("\n") })
                  }
                  placeholder="One theme per line"
                />
                <small>One theme per line.</small>
              </label>
              <label className={styles.field}>
                Voice
                <textarea
                  className={styles.textarea}
                  value={profile.voice}
                  maxLength={800}
                  onChange={(event) => update({ voice: event.target.value })}
                  placeholder="e.g. Clear, curious and practical"
                />
              </label>
              <label className={styles.field}>
                Visual style
                <textarea
                  className={styles.textarea}
                  value={profile.visualStyle}
                  maxLength={1200}
                  onChange={(event) =>
                    update({ visualStyle: event.target.value })
                  }
                  placeholder="Colors, lighting, composition and recurring details"
                />
              </label>
              <label className={styles.field}>
                Additional guidance
                <textarea
                  className={styles.textarea}
                  value={profile.guidelines}
                  maxLength={2000}
                  onChange={(event) =>
                    update({ guidelines: event.target.value })
                  }
                  placeholder="What should every piece include or avoid?"
                />
              </label>
            </div>
          </details>
          <details className={styles.details}>
            <summary>
              Accounts and channels
              {profile.channels.length ? ` (${profile.channels.length})` : ""}
            </summary>
            <div>
              <p className={styles.support}>
                Keep the intended account with this project. These are labels
                and links; adding one does not connect an account or publish
                anything.
              </p>
              {profile.channels.map((channel, index) => (
                <div className={styles.channel} key={index}>
                  <label className={styles.field}>
                    Platform
                    <input
                      className={styles.input}
                      aria-label={`Platform ${index + 1}`}
                      required
                      value={channel.platform}
                      maxLength={80}
                      placeholder="Instagram, Threads, YouTube…"
                      onChange={(event) =>
                        update({
                          channels: profile.channels.map((item, i) =>
                            i === index
                              ? { ...item, platform: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className={styles.field}>
                    Handle (optional)
                    <input
                      className={styles.input}
                      aria-label={`Handle ${index + 1}`}
                      value={channel.handle}
                      maxLength={160}
                      placeholder="@youraccount"
                      onChange={(event) =>
                        update({
                          channels: profile.channels.map((item, i) =>
                            i === index
                              ? { ...item, handle: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className={styles.quiet}
                    aria-label={`Remove channel ${index + 1}`}
                    onClick={() =>
                      update({
                        channels: profile.channels.filter(
                          (_, i) => i !== index,
                        ),
                      })
                    }
                  >
                    <X size={16} />
                  </button>
                  <label className={`${styles.field} ${styles.channelUrl}`}>
                    Profile link (optional)
                    <input
                      type="url"
                      className={styles.input}
                      value={channel.url || ""}
                      maxLength={500}
                      placeholder="https://…"
                      onChange={(event) =>
                        update({
                          channels: profile.channels.map((item, i) =>
                            i === index
                              ? {
                                  ...item,
                                  url: event.target.value || undefined,
                                }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                </div>
              ))}
              <button
                type="button"
                className={styles.button}
                disabled={profile.channels.length >= 8}
                onClick={() =>
                  update({
                    channels: [
                      ...profile.channels,
                      { platform: "", handle: "" },
                    ],
                  })
                }
              >
                <Plus size={16} />
                Add a channel
              </button>
            </div>
          </details>
        </fieldset>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={onClose}
          >
            Close
          </button>
          {conflict ? (
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => void reloadProfile()}
            >
              Load latest details
            </button>
          ) : null}
          {writable ? (
            <button
              type="submit"
              className={styles.primary}
              disabled={
                busy || conflict || (!pending && !project && !title.trim())
              }
            >
              {busy
                ? "Saving…"
                : pending
                  ? "Recover save"
                  : project
                    ? "Save brand details"
                    : "Create project"}
            </button>
          ) : null}
        </div>
      </form>
    </StudioDialog>
  );
}

export function StudioFlowProjectDialog({
  mode,
  projects,
  currentProjectId,
  busy,
  onSubmit,
  onClose,
}: {
  mode: "copy" | "assign";
  projects: StudioProject[];
  currentProjectId?: string | null;
  busy: boolean;
  onSubmit: (projectId: string, retainReferences: boolean) => void;
  onClose: () => void;
}) {
  const targets = projects.filter(
    (project) =>
      project.id !== currentProjectId && project.status !== "archived",
  );
  const [target, setTarget] = useState(targets[0]?.id || "");
  const [retain, setRetain] = useState(false);
  return (
    <StudioDialog
      title={mode === "copy" ? "Use in another project" : "Assign to a project"}
      busy={busy}
      onClose={onClose}
      description={
        mode === "copy"
          ? "Make a new flow with the destination’s brand details. The original flow and its results stay where they are."
          : "Give this unassigned flow a project and capture its current brand details."
      }
    >
      <form
        className={styles.body}
        onSubmit={(event) => {
          event.preventDefault();
          if (target) onSubmit(target, retain);
        }}
      >
        {targets.length ? (
          <label className={styles.field}>
            Destination project
            <select
              className={styles.select}
              value={target}
              disabled={busy}
              onChange={(event) => setTarget(event.target.value)}
            >
              {targets.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className={styles.support}>
            Create another project from the saved-flow page first.
          </p>
        )}
        {mode === "copy" ? (
          <>
            <p className={styles.support}>
              Run history and generated results are not copied. Reference files
              are cleared by default so the new project starts with its own
              material.
            </p>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={retain}
                disabled={busy}
                onChange={(event) => setRetain(event.target.checked)}
              />
              Keep the selected reference files in this copy.
            </label>
          </>
        ) : null}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={styles.primary}
            type="submit"
            disabled={busy || !target}
          >
            {busy
              ? "Saving…"
              : mode === "copy"
                ? "Create project copy"
                : "Assign flow"}
          </button>
        </div>
      </form>
    </StudioDialog>
  );
}

export function StudioBrandSnapshotDialog({
  graph,
  onClose,
}: {
  graph: StudioGraph;
  onClose: () => void;
}) {
  const context = graph.projectContext;
  return (
    <StudioDialog
      title="Brand context in this flow"
      onClose={onClose}
      description="This saved snapshot is added to generation prompts. Changing project details leaves this snapshot unchanged until you apply the update."
    >
      <div className={styles.body}>
        {context ? (
          <dl className={styles.snapshot}>
            <dt>Brand</dt>
            <dd>{context.brandName}</dd>
            <dt>Saved version</dt>
            <dd>{context.profileRevision}</dd>
            <dt>Audience</dt>
            <dd>{context.audience || "Not set"}</dd>
            <dt>Content themes</dt>
            <dd>{context.contentPillars.join(", ") || "Not set"}</dd>
            <dt>Voice</dt>
            <dd>{context.voice || "Not set"}</dd>
            <dt>Visual style</dt>
            <dd>{context.visualStyle || "Not set"}</dd>
            <dt>Guidance</dt>
            <dd>{context.guidelines || "Not set"}</dd>
            {context.channels.length ? (
              <>
                <dt>Accounts</dt>
                <dd>
                  {context.channels
                    .map(
                      (channel) =>
                        `${channel.platform}${channel.handle ? `: ${channel.handle}` : ""}`,
                    )
                    .join("\n")}
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className={styles.support}>
            This flow has no saved brand context yet. Add brand details to its
            project, then apply them to this flow.
          </p>
        )}
        <p className={styles.support}>
          Open an image or video step, then “Advanced settings” → “Full
          submitted prompt,” to see the exact text that will be sent.
        </p>
        <div className={styles.actions}>
          <button className={styles.button} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </StudioDialog>
  );
}
