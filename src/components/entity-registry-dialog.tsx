"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  GitMerge,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { clsx } from "clsx";

import styles from "@/components/memory-workspace.module.css";

export type EntityRegistryPayload = {
  schemaVersion: 1;
  entities: EntityRegistryItem[];
  aliases: Array<{
    aliasId: string;
    entityId: string;
    alias: string;
    createdAt: string;
  }>;
  resolutions: EntityResolutionItem[];
  mergeReviews: EntityMergeReviewItem[];
};

type EntityRegistryItem = {
  entityId: string;
  entityTypeId: string;
  canonicalLabel: string;
  state: "active" | "merged";
  mergedIntoEntityId: string | null;
  lineageCount: number;
  createdAt: string;
  updatedAt: string;
};

type EntityResolutionItem = {
  resolutionId: string;
  entityTypeId: string;
  decision: "auto_link" | "review_required" | "create_new";
  selectedEntityId: string | null;
  candidateEntityIds: string[];
  matchMethod: string;
  scoreBasisPoints: number;
  decidedAt: string;
};

type EntityMergeReviewItem = {
  reviewId: string;
  resolutionId: string;
  sourceEntityId: string;
  targetEntityId: string;
  decision: "approved" | "rejected" | "reversed";
  previousReviewId: string | null;
  reviewedAt: string;
};

export function countPendingEntityMergeReviews(
  registry: EntityRegistryPayload | undefined,
) {
  if (!registry) return 0;
  const terminalResolutionIds = new Set(
    registry.mergeReviews
      .filter((review) => review.decision !== "reversed")
      .map((review) => review.resolutionId),
  );
  const activeEntityIds = new Set(
    registry.entities
      .filter((entity) => entity.state === "active")
      .map((entity) => entity.entityId),
  );
  return registry.resolutions.filter((resolution) =>
    resolution.decision === "review_required" &&
    !terminalResolutionIds.has(resolution.resolutionId) &&
    resolution.candidateEntityIds.filter((id) => activeEntityIds.has(id)).length >= 2
  ).length;
}

export function EntityRegistryDialog({
  registry,
  loadError,
  onClose,
  onReload,
  onAnnouncement,
}: {
  registry: EntityRegistryPayload | undefined;
  loadError: string | undefined;
  onClose: () => void;
  onReload: () => Promise<EntityRegistryPayload | undefined>;
  onAnnouncement: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const terminalResolutionIds = useMemo(() => new Set(
    registry?.mergeReviews
      .filter((review) => review.decision !== "reversed")
      .map((review) => review.resolutionId) || [],
  ), [registry]);
  const activeEntityIds = useMemo(() => new Set(
    registry?.entities
      .filter((entity) => entity.state === "active")
      .map((entity) => entity.entityId) || [],
  ), [registry]);
  const pendingResolutions = useMemo(() =>
    registry?.resolutions.filter((resolution) =>
      resolution.decision === "review_required" &&
      !terminalResolutionIds.has(resolution.resolutionId) &&
      resolution.candidateEntityIds.filter((id) => activeEntityIds.has(id)).length >= 2
    ) || [],
  [activeEntityIds, registry, terminalResolutionIds]);
  const heldResolutions = useMemo(() =>
    registry?.resolutions.filter((resolution) =>
      resolution.decision === "review_required" &&
      !terminalResolutionIds.has(resolution.resolutionId) &&
      resolution.candidateEntityIds.filter((id) => activeEntityIds.has(id)).length < 2
    ) || [],
  [activeEntityIds, registry, terminalResolutionIds]);
  const reversibleReviews = useMemo(() => {
    const reversedReviewIds = new Set(
      registry?.mergeReviews
        .filter((review) => review.decision === "reversed")
        .map((review) => review.previousReviewId)
        .filter((id): id is string => Boolean(id)) || [],
    );
    return registry?.mergeReviews.filter((review) =>
      review.decision === "approved" && !reversedReviewIds.has(review.reviewId)
    ) || [];
  }, [registry]);
  const filteredEntities = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return registry?.entities || [];
    return registry?.entities.filter((entity) => {
      const aliases = registry.aliases
        .filter((alias) => alias.entityId === entity.entityId)
        .map((alias) => alias.alias)
        .join(" ");
      return `${entity.canonicalLabel} ${entity.entityTypeId} ${aliases}`
        .toLocaleLowerCase()
        .includes(normalized);
    }) || [];
  }, [query, registry]);

  async function reload() {
    setRefreshing(true);
    setActionError(undefined);
    const loaded = await onReload();
    if (loaded) onAnnouncement("Private entity registry refreshed.");
    setRefreshing(false);
  }

  return (
    <div
      className={clsx("memory-dialog-backdrop", styles.dialogBackdrop, styles.registryBackdrop)}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={clsx("memory-dialog", styles.dialog, styles.registryDialog)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="entity-registry-title"
      >
        <header className={styles.registryHeader}>
          <div>
            <p>Actor-private knowledge</p>
            <h2 id="entity-registry-title">Entity registry</h2>
            <span>Canonical people, projects, organizations, and other records extracted from your explicit memories.</span>
          </div>
          <div className={styles.registryHeaderActions}>
            <button type="button" onClick={() => void reload()} disabled={refreshing} aria-label="Refresh entity registry">
              <RefreshCw size={15} className={refreshing ? "animate-spin" : undefined} aria-hidden="true" />
            </button>
            <button type="button" onClick={onClose} aria-label="Close entity registry"><X size={16} aria-hidden="true" /></button>
          </div>
        </header>

        {loadError || actionError ? <p className={styles.registryError} role="alert">{actionError || loadError}</p> : null}

        <div className={styles.registrySummary}>
          <span><strong>{registry?.entities.length || 0}</strong> records</span>
          <span><strong>{pendingResolutions.length}</strong> merge reviews</span>
          <span><strong>{heldResolutions.length}</strong> held matches</span>
        </div>

        {pendingResolutions.length ? (
          <section className={styles.registrySection} aria-labelledby="merge-review-heading">
            <div className={styles.registrySectionHeading}>
              <div><p>Needs judgment</p><h3 id="merge-review-heading">Ambiguous merges</h3></div>
              <GitMerge size={17} aria-hidden="true" />
            </div>
            <p className={styles.registrySectionCopy}>Choose which duplicate record should be merged and which should survive. Every decision is recorded and can be reversed.</p>
            <div className={styles.registryReviewList}>
              {pendingResolutions.map((resolution) => (
                <MergeReviewRow
                  key={resolution.resolutionId}
                  resolution={resolution}
                  entities={registry!.entities}
                  onReviewed={async (message) => {
                    const loaded = await onReload();
                    if (loaded) onAnnouncement(message);
                  }}
                  onError={setActionError}
                />
              ))}
            </div>
          </section>
        ) : null}

        {heldResolutions.length ? (
          <section className={clsx(styles.registrySection, styles.registryHeld)} aria-labelledby="held-review-heading">
            <div className={styles.registrySectionHeading}>
              <div><p>Fail-closed</p><h3 id="held-review-heading">Held fuzzy matches</h3></div>
              <ShieldCheck size={17} aria-hidden="true" />
            </div>
            <p className={styles.registrySectionCopy}>{heldResolutions.length} single-candidate match{heldResolutions.length === 1 ? " is" : "es are"} visible but cannot be merged until source-entity formation is governed. No record was changed automatically.</p>
          </section>
        ) : null}

        {reversibleReviews.length ? (
          <section className={styles.registrySection} aria-labelledby="merge-history-heading">
            <div className={styles.registrySectionHeading}>
              <div><p>Auditable history</p><h3 id="merge-history-heading">Reversible merges</h3></div>
              <RotateCcw size={17} aria-hidden="true" />
            </div>
            <div className={styles.registryHistoryList}>
              {reversibleReviews.map((review) => (
                <ReversibleReviewRow
                  key={review.reviewId}
                  review={review}
                  entities={registry!.entities}
                  onReversed={async () => {
                    const loaded = await onReload();
                    if (loaded) onAnnouncement("Entity merge reversed and the source record restored.");
                  }}
                  onError={setActionError}
                />
              ))}
            </div>
          </section>
        ) : null}

        <section className={styles.registrySection} aria-labelledby="entity-records-heading">
          <div className={styles.registrySectionHeading}>
            <div><p>Canonical index</p><h3 id="entity-records-heading">Entity records</h3></div>
            <span>{filteredEntities.length}</span>
          </div>
          <label className={styles.registrySearch}>
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">Search entity records</span>
            <input autoFocus value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search labels, aliases, or types" />
          </label>
          <div className={styles.registryEntityList}>
            {filteredEntities.length ? filteredEntities.map((entity) => {
              const aliases = registry?.aliases.filter((alias) => alias.entityId === entity.entityId) || [];
              const target = entity.mergedIntoEntityId
                ? registry?.entities.find((candidate) => candidate.entityId === entity.mergedIntoEntityId)
                : undefined;
              return (
                <article key={entity.entityId} className={styles.registryEntityRow}>
                  <div>
                    <strong>{entity.canonicalLabel}</strong>
                    <span>{humanize(entity.entityTypeId)} · {entity.lineageCount} lineage reference{entity.lineageCount === 1 ? "" : "s"}</span>
                    {aliases.length ? <small>Also known as {aliases.map((alias) => alias.alias).join(", ")}</small> : null}
                    {target ? <small>Merged into {target.canonicalLabel}</small> : null}
                  </div>
                  <span className={clsx(styles.registryState, entity.state === "merged" && styles.registryStateMerged)}>{entity.state}</span>
                </article>
              );
            }) : <p className={styles.registryEmpty}>{registry ? "No entity records match this search." : "The registry is not available yet."}</p>}
          </div>
        </section>
      </section>
    </div>
  );
}

function MergeReviewRow({
  resolution,
  entities,
  onReviewed,
  onError,
}: {
  resolution: EntityResolutionItem;
  entities: EntityRegistryItem[];
  onReviewed: (message: string) => Promise<void>;
  onError: (message: string | undefined) => void;
}) {
  const candidates = resolution.candidateEntityIds
    .map((id) => entities.find((entity) => entity.entityId === id))
    .filter((entity): entity is EntityRegistryItem => entity?.state === "active");
  const [sourceEntityId, setSourceEntityId] = useState(candidates[0]?.entityId || "");
  const [targetEntityId, setTargetEntityId] = useState(candidates[1]?.entityId || "");
  const [saving, setSaving] = useState<"approved" | "rejected">();
  const invalid = !sourceEntityId || !targetEntityId || sourceEntityId === targetEntityId;

  async function review(decision: "approved" | "rejected") {
    if (invalid) return;
    setSaving(decision);
    onError(undefined);
    try {
      await postReview({
        resolutionId: resolution.resolutionId,
        sourceEntityId,
        targetEntityId,
        decision,
      });
      await onReviewed(decision === "approved"
        ? "Entity merge approved and recorded."
        : "Entity candidates kept separate and the review recorded.");
    } catch (error) {
      onError(errorMessage(error));
      setSaving(undefined);
    }
  }

  return (
    <article className={styles.registryReviewRow}>
      <div className={styles.registryReviewMeta}>
        <span>{humanize(resolution.entityTypeId)}</span>
        <small>{resolution.matchMethod === "ambiguous_exact" ? "Exact labels conflict" : `${Math.round(resolution.scoreBasisPoints / 100)}% similarity`}</small>
      </div>
      <div className={styles.registryMergeFields}>
        <label>Merge this record<select value={sourceEntityId} onChange={(event) => setSourceEntityId(event.currentTarget.value)}>{candidates.map((candidate) => <option key={candidate.entityId} value={candidate.entityId}>{candidate.canonicalLabel}</option>)}</select></label>
        <span aria-hidden="true">into</span>
        <label>Surviving record<select value={targetEntityId} onChange={(event) => setTargetEntityId(event.currentTarget.value)}>{candidates.map((candidate) => <option key={candidate.entityId} value={candidate.entityId}>{candidate.canonicalLabel}</option>)}</select></label>
      </div>
      {invalid ? <p className={styles.registryInlineWarning}>Source and surviving record must be different.</p> : null}
      <div className={styles.registryReviewActions}>
        <button type="button" onClick={() => void review("rejected")} disabled={Boolean(saving) || invalid}>{saving === "rejected" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <X size={13} aria-hidden="true" />} Keep separate</button>
        <button type="button" onClick={() => void review("approved")} disabled={Boolean(saving) || invalid}>{saving === "approved" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />} Approve merge</button>
      </div>
    </article>
  );
}

function ReversibleReviewRow({
  review,
  entities,
  onReversed,
  onError,
}: {
  review: EntityMergeReviewItem;
  entities: EntityRegistryItem[];
  onReversed: () => Promise<void>;
  onError: (message: string | undefined) => void;
}) {
  const [saving, setSaving] = useState(false);
  const source = entities.find((entity) => entity.entityId === review.sourceEntityId);
  const target = entities.find((entity) => entity.entityId === review.targetEntityId);

  async function reverse() {
    setSaving(true);
    onError(undefined);
    try {
      await postReview({
        resolutionId: review.resolutionId,
        sourceEntityId: review.sourceEntityId,
        targetEntityId: review.targetEntityId,
        decision: "reversed",
        previousReviewId: review.reviewId,
      });
      await onReversed();
    } catch (error) {
      onError(errorMessage(error));
      setSaving(false);
    }
  }

  return (
    <article>
      <div><strong>{source?.canonicalLabel || "Merged record"}</strong><span> merged into {target?.canonicalLabel || "surviving record"}</span></div>
      <button type="button" onClick={() => void reverse()} disabled={saving}>{saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />} Reverse</button>
    </article>
  );
}

async function postReview(input: {
  resolutionId: string;
  sourceEntityId: string;
  targetEntityId: string;
  decision: "approved" | "rejected" | "reversed";
  previousReviewId?: string;
}) {
  const response = await fetch("/api/entities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "review_merge", ...input }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "Entity review failed.");
  }
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Entity review failed.";
}
