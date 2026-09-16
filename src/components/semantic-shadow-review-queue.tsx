"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Eye,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import styles from "@/components/semantic-shadow-review-queue.module.css";

const dimensions = [
  ["decision", "Decision"],
  ["commitment", "Commitment"],
  ["preference", "Preference"],
  ["procedure", "Procedure"],
  ["temporal_change", "Changed over time"],
  ["conflict_correction", "Correction"],
  ["multi_topic", "Multiple topics"],
  ["noisy_dialogue", "Noisy dialogue"],
  ["long_episode", "Long episode"],
  ["negative_control", "No durable memory"],
] as const;

type Dimension = typeof dimensions[number][0];
type Decision = "supported" | "unsupported";

type ReviewCase = {
  dimension: Dimension;
  importantFactCount: number;
  baselineImportantFactHitCount: number;
  semanticImportantFactHitCount: number;
  baselineFirstRelevantRank: number | null;
  semanticFirstRelevantRank: number | null;
  compressionJudgment: "good" | "needs_work";
  scopeLeakCount: number;
};

type ReviewRecord = {
  case: ReviewCase;
  itemDecisions: Array<{ itemId: string; decision: Decision }>;
  reviewSourceSha256: string;
  reviewedAt: string;
};

export type SemanticShadowReviewCandidate = {
  id: string;
  reviewSourceSha256: string;
  startsAt: string;
  endsAt: string;
  model: { provider: string; model: string };
  metrics: {
    sourceCharacterCount: number;
    outputCharacterCount: number;
    quoteBindingCount: number;
    validQuoteBindingCount: number;
    semanticItemCount: number;
    generationLatencyMs: number | null;
    deterministicReplayMatch: boolean;
  };
  sourceTurns?: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }>;
  deterministicSummary?: string;
  semanticItems?: Array<{
    id: string;
    kind: string;
    text: string;
    confidenceBasisPoints: number;
    evidence: Array<{
      turnId: string;
      quote: string;
      startOffset: number;
      endOffsetExclusive: number;
      valid: boolean;
    }>;
  }>;
  reviewable: boolean;
  unavailableReason?: string;
  latestReview?: ReviewRecord;
  latestRankProbe?: {
    baselineFirstRelevantRank: number;
    semanticFirstRelevantRank: number;
    rankDelta: number;
    corpusCount: number;
    probedAt: string;
  };
};

type GateReport = {
  caseCount: number;
  distinctThreadCount: number;
  rankProbeCaseCount: number;
  coveredDimensions: string[];
  missingDimensions: string[];
  failureCodes: string[];
  activationReady: boolean;
};

type WorkspaceResponse = {
  candidates: SemanticShadowReviewCandidate[];
  report: GateReport | null;
  reviewedCaseCount: number;
};

export type SemanticShadowReviewDraft = {
  dimension: Dimension | "";
  itemDecisions: Record<string, Decision | undefined>;
  importantFactCount: string;
  baselineImportantFactHitCount: string;
  semanticImportantFactHitCount: string;
  compressionJudgment: "good" | "needs_work" | "";
  scopeLeakCount: string;
  humanReviewed: boolean;
};

export function buildSemanticShadowReviewPayload(
  candidate: SemanticShadowReviewCandidate,
  draft: SemanticShadowReviewDraft,
) {
  const itemIds = candidate.semanticItems?.map(({ id }) => id) || [];
  if (!candidate.reviewable || !itemIds.length) {
    return { error: candidate.unavailableReason || "This episode is not ready to review." };
  }
  if (!draft.dimension) return { error: "Choose the episode’s evaluation scenario." };
  const itemDecisions = itemIds.flatMap((itemId) => {
    const decision = draft.itemDecisions[itemId];
    return decision ? [{ itemId, decision }] : [];
  });
  if (itemDecisions.length !== itemIds.length) {
    return { error: "Mark every semantic item as supported or unsupported." };
  }
  const importantFactCount = requiredCount(draft.importantFactCount);
  const baselineImportantFactHitCount = requiredCount(
    draft.baselineImportantFactHitCount,
  );
  const semanticImportantFactHitCount = requiredCount(
    draft.semanticImportantFactHitCount,
  );
  const scopeLeakCount = requiredCount(draft.scopeLeakCount);
  if (importantFactCount === undefined || importantFactCount < 1) {
    return { error: "Enter at least one important source fact." };
  }
  if (
    baselineImportantFactHitCount === undefined ||
    semanticImportantFactHitCount === undefined ||
    scopeLeakCount === undefined
  ) return { error: "Complete all required quality counts." };
  if (
    baselineImportantFactHitCount > importantFactCount ||
    semanticImportantFactHitCount > importantFactCount
  ) return { error: "Preserved facts cannot exceed important source facts." };
  if (!draft.compressionJudgment) {
    return { error: "Judge whether the semantic result is usefully compressed." };
  }
  if (!draft.humanReviewed) {
    return { error: "Confirm that you compared the source and both summaries." };
  }
  return {
    payload: {
      enrichmentId: candidate.id,
      reviewSourceSha256: candidate.reviewSourceSha256,
      dimension: draft.dimension,
      itemDecisions,
      importantFactCount,
      baselineImportantFactHitCount,
      semanticImportantFactHitCount,
      compressionJudgment: draft.compressionJudgment,
      scopeLeakCount,
      humanReviewed: true as const,
    },
  };
}

export function SemanticShadowReviewQueue(props: {
  onProgressChanged: () => Promise<void>;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceResponse>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<SemanticShadowReviewCandidate>();
  const [draft, setDraft] = useState<SemanticShadowReviewDraft>(emptyDraft());
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeQuery, setProbeQuery] = useState("");
  const [humanConfirmedTarget, setHumanConfirmedTarget] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const workspaceRequestRef = useRef<AbortController | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);

  const loadWorkspace = useCallback(async (preferredId?: string) => {
    workspaceRequestRef.current?.abort();
    const controller = new AbortController();
    workspaceRequestRef.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/api/memory/semantic-shadow?limit=24", {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(body, "Evaluation reviews could not be loaded."));
      const next = body as WorkspaceResponse;
      setWorkspace(next);
      const nextId = preferredId && next.candidates.some(({ id }) => id === preferredId)
        ? preferredId
        : next.candidates.find((candidate) => candidate.reviewable && !candidate.latestReview)?.id ||
          next.candidates.find((candidate) => candidate.reviewable)?.id;
      setSelectedId(nextId);
      if (!nextId) {
        setDetail(undefined);
        setDraft(emptyDraft());
      }
    } catch (loadError) {
      if (controller.signal.aborted) return;
      setError(message(loadError));
    } finally {
      if (workspaceRequestRef.current === controller) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (candidateId: string) => {
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    setDetailLoading(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/memory/semantic-shadow?limit=100&id=${encodeURIComponent(candidateId)}`,
        { cache: "no-store", signal: controller.signal },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(body, "This evaluation episode could not be opened."));
      const candidate = (body as WorkspaceResponse).candidates.find(
        ({ id }) => id === candidateId,
      );
      if (!candidate?.semanticItems || !candidate.sourceTurns) {
        throw new Error("This evaluation episode is no longer available.");
      }
      setDetail(candidate);
      setDraft(draftFromReview(candidate));
      setProbeQuery("");
      setHumanConfirmedTarget(false);
    } catch (loadError) {
      if (controller.signal.aborted) return;
      setDetail(undefined);
      setError(message(loadError));
    } finally {
      if (detailRequestRef.current === controller) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);

  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setTimeout(() => void loadDetail(selectedId), 0);
    return () => window.clearTimeout(timer);
  }, [loadDetail, selectedId]);

  useEffect(() => () => {
    workspaceRequestRef.current?.abort();
    detailRequestRef.current?.abort();
  }, []);

  const reviewedCount = workspace?.reviewedCaseCount || 0;
  const coveredDimensions = new Set(workspace?.report?.coveredDimensions || []);
  const payloadState = useMemo(
    () => detail ? buildSemanticShadowReviewPayload(detail, draft) : undefined,
    [detail, draft],
  );

  async function submitReview() {
    if (!detail || !payloadState?.payload || saving) {
      setError(payloadState?.error || "Open an evaluation episode first.");
      return;
    }
    setSaving(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/memory/semantic-shadow", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(payloadState.payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(body, "The evaluation review could not be saved."));
      setFeedback("Review saved as evaluation evidence. Live answers and memory ranking are unchanged.");
      await Promise.all([
        loadWorkspace(detail.id),
        loadDetail(detail.id),
        props.onProgressChanged(),
      ]);
    } catch (saveError) {
      setError(message(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function submitRankProbe() {
    if (!detail || probing) return;
    const query = probeQuery.trim();
    if (query.length < 3) {
      setError("Write a retrieval question with at least three characters.");
      return;
    }
    if (!humanConfirmedTarget) {
      setError("Confirm that this episode is a relevant answer to the query.");
      return;
    }
    setProbing(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/memory/semantic-shadow/rank-probe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          enrichmentId: detail.id,
          reviewSourceSha256: detail.reviewSourceSha256,
          query,
          humanConfirmedTarget: true,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(apiError(body, "The retrieval probe could not run."));
      }
      setFeedback(
        "Retrieval ranks measured and sealed. Live memory ranking is unchanged.",
      );
      await Promise.all([
        loadWorkspace(detail.id),
        loadDetail(detail.id),
        props.onProgressChanged(),
      ]);
    } catch (probeError) {
      setError(message(probeError));
    } finally {
      setProbing(false);
    }
  }

  return (
    <section className={styles.reviewBench} aria-labelledby="semantic-review-bench-title">
      <header className={styles.heading}>
        <div className={styles.headingIcon}><ClipboardCheck size={20} /></div>
        <div>
          <p>Step 2 · Human evidence check</p>
          <h3 id="semantic-review-bench-title">Semantic review bench</h3>
          <span>Compare each private source episode with the deterministic baseline and the proposed semantic memory.</span>
        </div>
        <button type="button" onClick={() => void loadWorkspace(selectedId)} disabled={loading || saving}>
          <RefreshCw size={14} className={loading ? styles.spin : undefined} /> Refresh
        </button>
      </header>

      <div className={styles.gateStrip}>
        <div><strong>{reviewedCount}</strong><span>of 24 reviewed cases</span></div>
        <div><strong>{workspace?.report?.distinctThreadCount || 0}</strong><span>of 6 conversations</span></div>
        <div><strong>{coveredDimensions.size}</strong><span>of 10 scenarios</span></div>
        <div><strong>{workspace?.report?.rankProbeCaseCount || 0}</strong><span>of {reviewedCount || 24} rank probes</span></div>
        <div data-ready={workspace?.report?.activationReady ? "true" : undefined}>
          <strong>{workspace?.report?.activationReady ? "Passed" : "Locked"}</strong>
          <span>activation gate</span>
        </div>
      </div>

      <div className={styles.dimensionRail} aria-label="Evaluation scenario coverage">
        {dimensions.map(([id, label]) => (
          <span key={id} data-covered={coveredDimensions.has(id) ? "true" : undefined}>
            {coveredDimensions.has(id) ? <BadgeCheck size={13} /> : <i />}{label}
          </span>
        ))}
      </div>

      {error ? <p className={styles.error} role="alert"><CircleAlert size={16} />{error}</p> : null}
      {feedback ? <p className={styles.feedback} role="status"><BadgeCheck size={16} />{feedback}</p> : null}

      <div className={styles.benchGrid}>
        <aside className={styles.queue} aria-label="Semantic evaluation episodes">
          <header><span>Evaluation episodes</span><small>{workspace?.candidates.length || 0} available</small></header>
          <div>
            {workspace?.candidates.map((candidate, index) => (
              <button
                type="button"
                key={candidate.id}
                className={candidate.id === selectedId ? styles.selected : undefined}
                onClick={() => setSelectedId(candidate.id)}
              >
                <i data-state={candidate.latestReview ? "reviewed" : candidate.reviewable ? "ready" : "blocked"} />
                <span>
                  <strong>Episode {index + 1}</strong>
                  <small>{formatDate(candidate.endsAt)} · {candidate.metrics.semanticItemCount} semantic items</small>
                  <em>{candidate.latestReview ? "Reviewed" : candidate.reviewable ? "Ready to judge" : "Needs recollection"}</em>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
            {!loading && !workspace?.candidates.length ? (
              <div className={styles.queueEmpty}><Eye size={20} /><strong>No episodes collected yet</strong><span>Use the collection step above when conversations contain complete 12-turn episodes.</span></div>
            ) : null}
            {loading ? <div className={styles.queueLoading}><LoaderCircle size={17} className={styles.spin} /> Loading episodes…</div> : null}
          </div>
        </aside>

        <div className={styles.reviewPane}>
          {detailLoading ? (
            <div className={styles.detailLoading}><LoaderCircle size={20} className={styles.spin} /> Opening private source evidence…</div>
          ) : detail ? (
            <ReviewForm
              candidate={detail}
              draft={draft}
              onDraft={setDraft}
              onSubmit={() => void submitReview()}
              probeQuery={probeQuery}
              onProbeQuery={setProbeQuery}
              humanConfirmedTarget={humanConfirmedTarget}
              onHumanConfirmedTarget={setHumanConfirmedTarget}
              onProbe={() => void submitRankProbe()}
              probing={probing}
              saving={saving}
              submitError={payloadState?.error}
            />
          ) : (
            <div className={styles.detailEmpty}><ClipboardCheck size={28} /><strong>Select an evaluation episode</strong><span>Source text is returned to this page only when you open an episode.</span></div>
          )}
        </div>
      </div>

      <p className={styles.boundary}>
        <ShieldCheck size={15} /> Source and model text are treated as untrusted evidence, never instructions. Saved reviews contain decisions and content-free metrics only; even a passing gate cannot activate semantic memory automatically.
      </p>
    </section>
  );
}

function ReviewForm(props: {
  candidate: SemanticShadowReviewCandidate;
  draft: SemanticShadowReviewDraft;
  onDraft: (draft: SemanticShadowReviewDraft) => void;
  onSubmit: () => void;
  probeQuery: string;
  onProbeQuery: (value: string) => void;
  humanConfirmedTarget: boolean;
  onHumanConfirmedTarget: (value: boolean) => void;
  onProbe: () => void;
  probing: boolean;
  saving: boolean;
  submitError?: string;
}) {
  const { candidate, draft } = props;
  const update = (patch: Partial<SemanticShadowReviewDraft>) =>
    props.onDraft({ ...draft, ...patch });
  return (
    <>
      <header className={styles.detailHeading}>
        <div><p>Private episode · {formatDate(candidate.endsAt)}</p><h4>Compare the evidence</h4></div>
        <span>{candidate.model.provider} · {candidate.model.model}</span>
      </header>
      {!candidate.reviewable ? <p className={styles.unavailable}><CircleAlert size={16} />{candidate.unavailableReason}</p> : null}
      <div className={styles.comparison}>
        <section className={styles.sourcePanel}>
          <header><span>1 · Source conversation</span><small>{candidate.metrics.sourceCharacterCount.toLocaleString()} characters</small></header>
          <div>{candidate.sourceTurns?.map((turn) => <article key={turn.id} data-role={turn.role}><strong>{turn.role === "user" ? "You" : "Asael"}</strong><p>{turn.content}</p></article>)}</div>
        </section>
        <section className={styles.baselinePanel}>
          <header><span>2 · Deterministic baseline</span><small>Current sealed summary</small></header>
          <p>{candidate.deterministicSummary}</p>
        </section>
      </div>

      <section className={styles.semanticPanel}>
        <header><div><span>3 · Proposed semantic memory</span><small>Every item needs a source-support decision</small></div><em>{candidate.metrics.validQuoteBindingCount}/{candidate.metrics.quoteBindingCount} exact quotes</em></header>
        <div>{candidate.semanticItems?.map((item) => (
          <article key={item.id}>
            <div className={styles.itemCopy}>
              <span>{startCase(item.kind)} · {Math.round(item.confidenceBasisPoints / 100)}% confidence</span>
              <p>{item.text}</p>
              {item.evidence.map((evidence, index) => <blockquote key={`${evidence.turnId}:${index}`} data-valid={evidence.valid ? "true" : undefined}>“{evidence.quote}” <small>{evidence.valid ? "Exact source span" : "Source mismatch"}</small></blockquote>)}
            </div>
            <fieldset>
              <legend>Is this fully supported?</legend>
              {(["supported", "unsupported"] as const).map((decision) => (
                <label key={decision} data-selected={draft.itemDecisions[item.id] === decision ? "true" : undefined}>
                  <input
                    type="radio"
                    name={`semantic-item-${item.id}`}
                    checked={draft.itemDecisions[item.id] === decision}
                    onChange={() => update({ itemDecisions: { ...draft.itemDecisions, [item.id]: decision } })}
                  />
                  {decision === "supported" ? "Supported" : "Unsupported"}
                </label>
              ))}
            </fieldset>
          </article>
        ))}</div>
      </section>

      <section className={styles.scorecard}>
        <header><span>4 · Quality scorecard</span><small>Count only important facts you can point to in the source.</small></header>
        <div className={styles.scoreGrid}>
          <label>Scenario<select value={draft.dimension} onChange={(event) => update({ dimension: event.target.value as Dimension })}><option value="">Choose one…</option>{dimensions.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
          <label>Important source facts<input type="number" min="1" max="128" inputMode="numeric" value={draft.importantFactCount} onChange={(event) => update({ importantFactCount: event.target.value })} /></label>
          <label>Facts in baseline<input type="number" min="0" max="128" inputMode="numeric" value={draft.baselineImportantFactHitCount} onChange={(event) => update({ baselineImportantFactHitCount: event.target.value })} /></label>
          <label>Facts in semantic result<input type="number" min="0" max="128" inputMode="numeric" value={draft.semanticImportantFactHitCount} onChange={(event) => update({ semanticImportantFactHitCount: event.target.value })} /></label>
          <label>Unrelated or cross-scope facts<input type="number" min="0" max="128" inputMode="numeric" value={draft.scopeLeakCount} onChange={(event) => update({ scopeLeakCount: event.target.value })} /></label>
          <label>Useful compression<select value={draft.compressionJudgment} onChange={(event) => update({ compressionJudgment: event.target.value as SemanticShadowReviewDraft["compressionJudgment"] })}><option value="">Choose…</option><option value="good">Good — concise and complete</option><option value="needs_work">Needs work</option></select></label>
        </div>
        <label className={styles.attestation}><input type="checkbox" checked={draft.humanReviewed} onChange={(event) => update({ humanReviewed: event.target.checked })} /><span><strong>I compared the source, baseline and every semantic item.</strong><small>This is a human evidence judgment, not an automatic model score.</small></span></label>
      </section>

      <section className={styles.rankProbe}>
        <header>
          <div><span>5 · Retrieval rank probe</span><small>Measured locally across the sealed evaluation corpus</small></div>
          {candidate.latestRankProbe ? (
            <em>Baseline #{candidate.latestRankProbe.baselineFirstRelevantRank} → Semantic #{candidate.latestRankProbe.semanticFirstRelevantRank}</em>
          ) : <em>Not measured</em>}
        </header>
        <p>Ask a question that this episode should answer. Asael ranks the same episode corpus once with deterministic summaries and once with semantic summaries; you cannot type or alter the resulting ranks.</p>
        <div className={styles.probeControls}>
          <label>
            Retrieval question
            <input
              type="text"
              maxLength={500}
              placeholder="What decision did we make about the Apollo release?"
              value={props.probeQuery}
              onChange={(event) => props.onProbeQuery(event.target.value)}
            />
          </label>
          <button type="button" onClick={props.onProbe} disabled={props.probing || !candidate.reviewable}>
            {props.probing ? <LoaderCircle size={16} className={styles.spin} /> : <Eye size={16} />}
            {props.probing ? "Measuring…" : "Measure ranks"}
          </button>
        </div>
        <label className={styles.probeAttestation}>
          <input
            type="checkbox"
            checked={props.humanConfirmedTarget}
            onChange={(event) => props.onHumanConfirmedTarget(event.target.checked)}
          />
          <span><strong>This episode is a relevant answer to my question.</strong><small>The question is used in-memory and only its SHA-256 digest is retained with the measured ranks.</small></span>
        </label>
        {candidate.latestRankProbe ? (
          <div className={styles.probeResult}>
            <span><strong>#{candidate.latestRankProbe.baselineFirstRelevantRank}</strong>Deterministic baseline</span>
            <span><strong>#{candidate.latestRankProbe.semanticFirstRelevantRank}</strong>Semantic memory</span>
            <span data-improved={candidate.latestRankProbe.rankDelta > 0 ? "true" : undefined}><strong>{candidate.latestRankProbe.rankDelta > 0 ? "+" : ""}{candidate.latestRankProbe.rankDelta}</strong>positions improved</span>
            <span><strong>{candidate.latestRankProbe.corpusCount}</strong>episode corpus</span>
          </div>
        ) : <p className={styles.rankNote}>Collect 24 reviewable episodes first. A separate measured probe is required for every reviewed case before the activation gate can pass.</p>}
      </section>

      <footer className={styles.submitBar}>
        <div><strong>{candidate.latestReview ? "Update this review" : "Save this review"}</strong><span>{props.submitError || "This records evaluation evidence only."}</span></div>
        <button type="button" onClick={props.onSubmit} disabled={props.saving || !candidate.reviewable || Boolean(props.submitError)}>{props.saving ? <LoaderCircle size={16} className={styles.spin} /> : <ClipboardCheck size={16} />}{props.saving ? "Saving evidence…" : candidate.latestReview ? "Update review" : "Save review"}</button>
      </footer>
    </>
  );
}

function emptyDraft(): SemanticShadowReviewDraft {
  return {
    dimension: "",
    itemDecisions: {},
    importantFactCount: "",
    baselineImportantFactHitCount: "",
    semanticImportantFactHitCount: "",
    compressionJudgment: "",
    scopeLeakCount: "0",
    humanReviewed: false,
  };
}

function draftFromReview(candidate: SemanticShadowReviewCandidate) {
  const review = candidate.latestReview;
  if (!review) return emptyDraft();
  return {
    dimension: review.case.dimension,
    itemDecisions: Object.fromEntries(review.itemDecisions.map(({ itemId, decision }) => [itemId, decision])),
    importantFactCount: String(review.case.importantFactCount),
    baselineImportantFactHitCount: String(review.case.baselineImportantFactHitCount),
    semanticImportantFactHitCount: String(review.case.semanticImportantFactHitCount),
    compressionJudgment: review.case.compressionJudgment,
    scopeLeakCount: String(review.case.scopeLeakCount),
    humanReviewed: false,
  } satisfies SemanticShadowReviewDraft;
}

function requiredCount(value: string) {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const count = Number(trimmed);
  return Number.isSafeInteger(count) && count <= 128 ? count : undefined;
}

function apiError(value: unknown, fallback: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  return typeof record.error === "string" ? record.error : fallback;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function startCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
