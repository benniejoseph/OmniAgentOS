"use client";

import { useState } from "react";
import { Loader2, Network, Search, ShieldCheck, X } from "lucide-react";
import { clsx } from "clsx";

import styles from "@/components/memory-workspace.module.css";
import type {
  GraphRelationshipPath,
  GraphRetrievalReceipt,
} from "@/lib/entities/graph-retrieval";

type RelationshipPathPayload = {
  query: string;
  paths: GraphRelationshipPath[];
  receipt: GraphRetrievalReceipt;
};

export function RelationshipPathDialog({
  initialQuery,
  onClose,
}: {
  initialQuery?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery || "");
  const [payload, setPayload] = useState<RelationshipPathPayload>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function search(event: React.FormEvent) {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized) return;
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({
        view: "relationship_paths",
        q: normalized,
        maxHops: "2",
        limit: "12",
      });
      const response = await fetch(`/api/memory/graph?${params}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(
          result.message || result.error || "Relationship paths could not be loaded.",
        );
      }
      setPayload(result as RelationshipPathPayload);
    } catch (searchError) {
      setError(message(searchError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className={clsx(
        "memory-dialog-backdrop",
        styles.dialogBackdrop,
        styles.registryBackdrop,
      )}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={clsx(
          "memory-dialog",
          styles.dialog,
          styles.registryDialog,
          styles.relationshipDialog,
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="relationship-path-title"
      >
        <header className={styles.registryHeader}>
          <div>
            <p>Temporal graph</p>
            <h2 id="relationship-path-title">Relationship paths</h2>
            <span>
              Trace up to two evidence-backed hops. Every node and relationship
              is checked inside your private scope before it appears here.
            </span>
          </div>
          <div className={styles.registryHeaderActions}>
            <button type="button" onClick={onClose} aria-label="Close relationship paths">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        <form className={styles.relationshipSearch} onSubmit={search}>
          <Search size={15} aria-hidden="true" />
          <label className="sr-only" htmlFor="relationship-path-query">
            Entity or relationship question
          </label>
          <input
            id="relationship-path-query"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="How is Ada connected to Project Phoenix?"
            maxLength={4_000}
            autoFocus
          />
          <button type="submit" disabled={loading || !query.trim()}>
            {loading
              ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              : <Network size={14} aria-hidden="true" />}
            Trace
          </button>
        </form>

        {error ? <p className={styles.registryError} role="alert">{error}</p> : null}
        {payload ? (
          <>
            <div className={styles.registrySummary}>
              <span><strong>{payload.paths.length}</strong> paths</span>
              <span><strong>{payload.receipt.anchorCount}</strong> matched entities</span>
              <span><strong>{payload.receipt.authorizedRelationCount}</strong> eligible relations</span>
              <span><strong>{payload.receipt.rejectedRelationCount}</strong> held</span>
            </div>
            <section className={styles.registrySection}>
              <div className={styles.registrySectionHeading}>
                <div><p>Authorized explanation</p><h3>Paths and evidence</h3></div>
                <span>{payload.paths.length}</span>
              </div>
              {payload.paths.length ? (
                <div className={styles.relationshipPaths}>
                  {payload.paths.map((path) => (
                    <RelationshipPathCard key={path.pathId} path={path} />
                  ))}
                </div>
              ) : (
                <p className={styles.registryEmpty}>
                  No evidence-backed path matched an entity in that question.
                </p>
              )}
            </section>
          </>
        ) : (
          <div className={styles.relationshipEmpty}>
            <Network size={28} aria-hidden="true" />
            <strong>Ask about a known person, project, account, or other entity.</strong>
            <span>Unmatched adjacent nodes are never included in the response.</span>
          </div>
        )}
      </section>
    </div>
  );
}

function RelationshipPathCard({ path }: { path: GraphRelationshipPath }) {
  return (
    <article className={styles.relationshipPathCard}>
      <header>
        <div>
          <span>{path.hopCount} {path.hopCount === 1 ? "hop" : "hops"}</span>
          <h4>{path.anchor.label} <small>to</small> {path.terminal.label}</h4>
        </div>
        <strong>{Math.round(path.score * 100)}%</strong>
      </header>
      <p>{path.explanation}</p>
      <ol>
        {path.hops.map((hop, index) => (
          <li key={hop.revisionId}>
            <div className={styles.relationshipHopHeading}>
              <span>{index + 1}</span>
              <div>
                <strong>{hop.source.label} · {hop.relationLabel} · {hop.target.label}</strong>
                <small>
                  {hop.epistemicKind} · {Math.round(hop.confidenceBasisPoints / 100)}% confidence · {hop.direction === "reverse" ? "traversed in reverse" : hop.direction}
                </small>
              </div>
            </div>
            <div className={styles.relationshipEvidence}>
              {hop.evidence.map((evidence) => (
                <section key={evidence.evidenceId}>
                  <header>
                    <span><ShieldCheck size={12} aria-hidden="true" /> {evidence.kind === "memory" ? "Memory" : "Source evidence"}</span>
                    <small>{formatDate(evidence.observedAt)}</small>
                  </header>
                  <strong>{evidence.title}</strong>
                  <blockquote>{evidence.excerpt}</blockquote>
                  <small>{evidence.source}</small>
                </section>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </article>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
