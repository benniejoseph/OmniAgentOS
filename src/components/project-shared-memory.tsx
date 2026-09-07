"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Brain, Loader2, Plus, RefreshCw } from "lucide-react";

type SharedMemoryRecord = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  updatedAt: string;
};

type SharedContext = {
  accessLevel: "reader" | "contributor" | "manager";
  canWrite: boolean;
  authoritySha256: string;
};

export function ProjectSharedMemory({
  projectId,
  projectTitle,
}: {
  projectId: string;
  projectTitle: string;
}) {
  const [memories, setMemories] = useState<SharedMemoryRecord[]>([]);
  const [context, setContext] = useState<SharedContext>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string>();

  async function load(signal?: AbortSignal) {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/memory/shared?scope=project&projectId=${encodeURIComponent(projectId)}&limit=30`,
        { cache: "no-store", signal },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload.error || "Project knowledge could not be loaded."));
      }
      setMemories(Array.isArray(payload.memories) ? payload.memories : []);
      setContext(payload.context as SharedContext);
      setError(undefined);
    } catch (loadError) {
      if (signal?.aborted) return;
      setError(message(loadError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // The selected project is the complete read boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !content.trim() || !context?.canWrite) return;
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/memory/shared", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          scope: "project",
          projectId,
          title: title.trim(),
          content: content.trim(),
          type: "knowledge",
          tier: "semantic",
          importance: 0.8,
          confidence: 0.95,
          tags: ["project-knowledge"],
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload.error || "Project knowledge could not be saved."));
      }
      setMemories((current) => [payload.record as SharedMemoryRecord, ...current]);
      setTitle("");
      setContent("");
    } catch (saveError) {
      setError(message(saveError));
    } finally {
      setSaving(false);
    }
  }

  const commandHref = `/app/command?project=${encodeURIComponent(projectId)}&context=project&prompt=${encodeURIComponent(`Use ${projectTitle}'s shared knowledge to help with: `)}`;

  return (
    <section className="project-artifact-ledger" aria-labelledby={`project-knowledge-${projectId}`}>
      <div className="project-artifact-heading">
        <div>
          <p className="projects-kicker">Shared context</p>
          <h3 id={`project-knowledge-${projectId}`}>Project knowledge</h3>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span><Brain size={13} aria-hidden="true" /> {memories.length} durable note{memories.length === 1 ? "" : "s"}</span>
          <Link href={commandHref} className="action-button">
            Use in Command <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted">
        Knowledge saved here is available only through this project membership. It is not copied into personal or agent-private memory.
      </p>

      {error ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm" role="alert">
          <span>{error}</span>
          <button type="button" className="action-button" onClick={() => void load()}>
            <RefreshCw size={13} aria-hidden="true" /> Retry
          </button>
        </div>
      ) : null}

      {context?.canWrite ? (
        <form className="mt-4 grid gap-3 rounded-xl border border-line bg-background p-4" onSubmit={save}>
          <div className="grid gap-3 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
            <label className="grid gap-1 text-xs font-semibold text-muted">
              Title
              <input className="min-h-10 rounded-lg border border-line bg-surface px-3 text-sm text-foreground outline-none focus:border-primary" value={title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={240} placeholder="Decision, constraint, or reusable fact" />
            </label>
            <label className="grid gap-1 text-xs font-semibold text-muted">
              Shared knowledge
              <textarea className="min-h-20 rounded-lg border border-line bg-surface px-3 py-2 text-sm leading-6 text-foreground outline-none focus:border-primary" value={content} onChange={(event) => setContent(event.currentTarget.value)} maxLength={200_000} rows={2} placeholder="What should everyone working in this project know?" />
            </label>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted">{context.accessLevel} access · exact project scope</span>
            <button type="submit" className="primary-button" disabled={saving || !title.trim() || !content.trim()}>
              {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
              Save knowledge
            </button>
          </div>
        </form>
      ) : context ? (
        <p className="mt-4 rounded-lg border border-line bg-background p-3 text-sm text-muted">
          You can read this project knowledge. Contributor access is required to add notes.
        </p>
      ) : null}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {loading ? (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-background p-4 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading project knowledge…
          </div>
        ) : memories.length ? memories.map((memory) => (
          <article key={memory.id} className="rounded-lg border border-line bg-background p-4">
            <h4 className="font-semibold text-foreground">{memory.title}</h4>
            <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-muted">{memory.content}</p>
            <footer className="mt-3 flex items-center justify-between gap-3 text-xs text-muted">
              <span>{formatTimestamp(memory.updatedAt)}</span>
              <code title={memory.id}>{memory.id.slice(0, 12)}</code>
            </footer>
          </article>
        )) : (
          <div className="rounded-lg border border-dashed border-line bg-background p-4 text-sm leading-6 text-muted">
            No shared knowledge yet. Add the first durable decision, constraint, or reusable fact above.
          </div>
        )}
      </div>
    </section>
  );
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Project knowledge is unavailable.";
}
