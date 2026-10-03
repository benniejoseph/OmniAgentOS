"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import {
  createSemanticReviewGate,
  freezeSemanticSubmission,
  parseSemanticProbeReceipt,
  parseSemanticReviewReceipt,
  parseSemanticReviewWorkspace,
  preserveSemanticDraft,
  reviewTargetKey,
  semanticProbeQuerySha256,
  type AcceptedSemanticReceipt,
  type BoundReviewDraft,
  type ReviewTarget,
  type ReviewWorkspace,
} from "@/components/semantic-shadow-review-state";

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
  const { session, status } = useWorkspaceSession();
  const permissionReason = permissionMessage(session, status, "write.memory");
  const [gate] = useState(createSemanticReviewGate);
  const [workspace, setWorkspace] = useState<ReviewWorkspace>();
  const [selected, setSelected] = useState<ReviewTarget>();
  const [detail, setDetail] = useState<SemanticShadowReviewCandidate>();
  const [draftState, setDraftState] = useState<BoundReviewDraft>();
  const [queryState, setQueryState] = useState<{ key: string; value: { query: string; confirmed: boolean } }>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pending, setPending] = useState<"review" | "probe">();
  const [error, setError] = useState<string>();
  const [workspaceLoadError, setWorkspaceLoadError] = useState<string>();
  const [workspaceNeedsRefresh, setWorkspaceNeedsRefresh] = useState(false);
  const [detailLoadError, setDetailLoadError] = useState<string>();
  const [versionNotice, setVersionNotice] = useState("");
  const [receipt, setReceipt] = useState<AcceptedSemanticReceipt>();
  const [overviewRefreshError, setOverviewRefreshError] = useState("");
  const workspaceRequestRef = useRef<AbortController | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);
  const loadedTargetRef = useRef("");
  const feedbackRevision = useRef(0);
  const permissionRef = useRef(permissionReason);
  const selectedId = selected?.id;
  const selectedKey = reviewTargetKey(selected);
  const detailKey = reviewTargetKey(detail);
  const saving = pending === "review";
  const probing = pending === "probe";
  const busy = Boolean(pending);
  const draft = draftState?.key === detailKey ? draftState.value : emptyDraft();
  const probeQuery = queryState?.key === detailKey ? queryState.value.query : "";
  const humanConfirmedTarget = queryState?.key === detailKey ? queryState.value.confirmed : false;
  const actionReason = permissionReason || (busy ? "An evaluation request is in progress. Episode selection and edits are paused until its receipt returns." : undefined) ||
    (detailKey !== selectedKey ? "The episode source changed. Wait for current evidence before judging it again." : undefined) ||
    (detailLoadError ? "Current episode evidence could not be verified. Retry the evidence read before submitting." : undefined);
  const feedback = receipt ? receipt.kind === "review"
    ? "Review saved as evaluation evidence. Live answers and memory ranking are unchanged."
    : "Retrieval ranks measured and sealed. Live memory ranking is unchanged." : undefined;

  useLayoutEffect(() => { permissionRef.current = permissionReason; }, [permissionReason]);

  useLayoutEffect(() => {
    gate.mount();
    return () => {
      gate.dispose();
      feedbackRevision.current += 1;
      workspaceRequestRef.current?.abort();
      detailRequestRef.current?.abort();
    };
  }, [gate]);

  const selectTarget = useCallback((target: ReviewTarget | undefined) => {
    if (!gate.select(target)) return;
    workspaceRequestRef.current?.abort();
    detailRequestRef.current?.abort();
    setSelected(target);
    setLoading(false);
    setDetailLoading(false);
    setDetailLoadError(undefined);
  }, [gate]);

  const loadWorkspace = useCallback(async () => {
    if (!gate.isMounted() || gate.isBusy()) return;
    workspaceRequestRef.current?.abort();
    const controller = new AbortController();
    workspaceRequestRef.current = controller;
    const latest = gate.read("workspace");
    const current = () => latest() && !controller.signal.aborted;
    setLoading(true);
    try {
      const response = await fetch("/api/memory/semantic-shadow?limit=24", {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok) throw new Error(apiError(body, "Evaluation reviews could not be loaded."));
      const next = parseSemanticReviewWorkspace(body, 24);
      if (!next) throw new Error("The evaluation list response could not be verified. Previously loaded records are retained.");
      setWorkspace(next);
      setWorkspaceLoadError(undefined);
      setWorkspaceNeedsRefresh(false);
      const previous = gate.target();
      const candidate = previous ? next.candidates.find((row) => row.id === previous.id)
        : next.candidates.find((row) => row.reviewable && !row.latestReview) || next.candidates.find((row) => row.reviewable);
      if (candidate) {
        if (previous && reviewTargetKey(candidate) !== reviewTargetKey(previous)) {
          setVersionNotice("This episode has a new source version. Previous evidence is shown until the current version loads; compare it again before submitting.");
        }
        selectTarget({ id: candidate.id, reviewSourceSha256: candidate.reviewSourceSha256 });
      } else if (previous) {
        setDetailLoadError("The selected episode was not returned in this 24-episode list. Retry its evidence read to check the current source.");
      }
    } catch (loadError) {
      if (!current()) return;
      setWorkspaceLoadError(message(loadError));
    } finally {
      if (current()) setLoading(false);
    }
  }, [gate, selectTarget]);

  const loadDetail = useCallback(async (target: ReviewTarget) => {
    if (!gate.isMounted() || gate.isBusy() || reviewTargetKey(gate.target()) !== reviewTargetKey(target)) return;
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    const latest = gate.read("detail");
    const current = () => latest() && !controller.signal.aborted;
    setDetailLoading(true);
    try {
      const response = await fetch(
        `/api/memory/semantic-shadow?limit=100&id=${encodeURIComponent(target.id)}`,
        { cache: "no-store", signal: controller.signal },
      );
      const body = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok) throw new Error(apiError(body, "This evaluation episode could not be opened."));
      const next = parseSemanticReviewWorkspace(body, 100, target.id);
      if (!next) throw new Error("The episode evidence response could not be verified. Your existing draft is retained.");
      const candidate = next.candidates.find(({ id }) => id === target.id);
      if (!candidate?.semanticItems || !candidate.sourceTurns) {
        throw new Error("This evaluation episode is no longer available.");
      }
      const key = reviewTargetKey(candidate);
      if (key !== reviewTargetKey(target)) setWorkspaceNeedsRefresh(true);
      setVersionNotice((currentNotice) => key !== reviewTargetKey(target) || currentNotice ? "The current source version is loaded. Compare the evidence and attest again; judgments from the previous version were not carried forward." : "");
      loadedTargetRef.current = key;
      selectTarget({ id: candidate.id, reviewSourceSha256: candidate.reviewSourceSha256 });
      setDetail(candidate);
      setDetailLoadError(undefined);
      setError(undefined);
      setDraftState((previous) => preserveSemanticDraft(previous, key, draftFromReview(candidate)));
      setQueryState((previous) => preserveSemanticDraft(previous, key, { query: "", confirmed: false }));
      setDetailLoading(false);
    } catch (loadError) {
      if (!current()) return;
      setDetailLoadError(message(loadError));
    } finally {
      if (current()) setDetailLoading(false);
    }
  }, [gate, selectTarget]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);

  useEffect(() => {
    if (!selected || loadedTargetRef.current === selectedKey) return;
    const timer = window.setTimeout(() => void loadDetail(selected), 0);
    return () => window.clearTimeout(timer);
  }, [loadDetail, selected, selectedKey]);

  const reviewedCount = workspace?.reviewedCaseCount || 0;
  const coveredDimensions = new Set(workspace?.report?.coveredDimensions || []);
  const payloadState = useMemo(
    () => detail ? buildSemanticShadowReviewPayload(detail, draft) : undefined,
    [detail, draft],
  );

  async function submitEvaluation(kind: "review" | "probe") {
    if (gate.isBusy()) return;
    if (!detail || actionReason || !detail.reviewable || detailKey !== selectedKey) {
      setError(actionReason || detail?.unavailableReason || "Open a reviewable evaluation episode first.");
      return;
    }
    if (kind === "review" && !payloadState?.payload) {
      setError(payloadState?.error || "Complete the human review first.");
      return;
    }
    const query = probeQuery.trim();
    if (kind === "probe" && (query.length < 3 || query.length > 500 || !humanConfirmedTarget)) {
      setError(!humanConfirmedTarget ? "Confirm that this episode is a relevant answer to the query." : "Write a retrieval question with 3 to 500 characters.");
      return;
    }
    const token = gate.begin();
    if (!token) return;
    const submitted = kind === "review" && payloadState?.payload ? freezeSemanticSubmission(payloadState.payload) : undefined;
    const selectedDetail = detail;
    const revision = ++feedbackRevision.current;
    workspaceRequestRef.current?.abort();
    detailRequestRef.current?.abort();
    setLoading(false);
    setDetailLoading(false);
    setPending(kind);
    setError(undefined);
    setOverviewRefreshError("");
    let sent = false;
    try {
      const querySha256 = kind === "probe" ? await semanticProbeQuerySha256(query) : "";
      if (!gate.current(token)) return;
      if (permissionRef.current) { setError(permissionRef.current); return; }
      const requestBody = submitted || { enrichmentId: token.target.id, reviewSourceSha256: token.target.reviewSourceSha256, query, humanConfirmedTarget: true };
      sent = true;
      const response = await fetch(kind === "review" ? "/api/memory/semantic-shadow" : "/api/memory/semantic-shadow/rank-probe", {
        method: "POST",
        headers: { "content-type": "application/json", "x-idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(requestBody),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!gate.current(token)) return;
      if (!response.ok) {
        const failure = apiError(body, "The evaluation request was not accepted.");
        setError(failure);
        if (response.status === 409) setDetailLoadError("The server could not accept this episode version or evaluation context. Retry its evidence read before submitting again.");
        return;
      }
      const accepted = submitted ? parseSemanticReviewReceipt(body, submitted, selectedDetail) : parseSemanticProbeReceipt(body, token.target, querySha256);
      if (!accepted) {
        setError("The evaluation response could not confirm the submitted result. It may have been recorded. Refresh the episode evidence before deciding whether to submit again.");
        setDetailLoadError("The submitted outcome is unconfirmed. Retry the evidence read to check for a recorded result.");
        return;
      }
      setReceipt(accepted);
      setWorkspaceNeedsRefresh(true);
      setDetail((current) => reviewTargetKey(current) === reviewTargetKey(token.target) && current ? {
        ...current, ...(accepted.kind === "review" ? { latestReview: accepted.review } : { latestRankProbe: accepted.probe }),
      } : current);
      if (accepted.kind === "review") setDraftState((current) => current?.key === reviewTargetKey(token.target) ? { ...current, value: { ...current.value, humanReviewed: false } } : current);
      else setQueryState((current) => current?.key === reviewTargetKey(token.target) ? { ...current, value: { ...current.value, confirmed: false } } : current);
      // A confirmed write ends pending before any independent read starts.
      gate.finish(token);
      setPending(undefined);
      void loadWorkspace();
      void loadDetail(token.target);
      void props.onProgressChanged().catch(() => {
        if (gate.isMounted() && feedbackRevision.current === revision) setOverviewRefreshError("The accepted receipt is retained. Memory overview counts could not be refreshed.");
      });
    } catch {
      if (gate.current(token)) {
        setError(sent ? "The evaluation outcome is unconfirmed. The request may have reached the server; refresh episode evidence before submitting again." : "The evaluation request could not be prepared. No request was sent.");
        if (sent) setDetailLoadError("The submitted outcome is unconfirmed. Retry the evidence read to check for a recorded result.");
      }
    } finally {
      if (gate.current(token)) { gate.finish(token); setPending(undefined); }
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
        <button type="button" onClick={() => void loadWorkspace()} disabled={busy} aria-label="Refresh semantic evaluation episodes" aria-describedby="semantic-review-resource-state semantic-review-action-state">
          <RefreshCw size={14} className={loading ? styles.spin : undefined} /> Refresh
        </button>
      </header>

      <div className={styles.gateStrip}>
        <div><strong>{workspace ? reviewedCount : loading ? "Loading…" : "Unavailable"}</strong><span>of 24 reviewed cases</span></div>
        <div><strong>{workspace?.report ? workspace.report.distinctThreadCount : workspace ? "Not evaluated" : loading ? "Loading…" : "Unavailable"}</strong><span>of 6 conversations</span></div>
        <div><strong>{workspace?.report ? coveredDimensions.size : workspace ? "Not evaluated" : loading ? "Loading…" : "Unavailable"}</strong><span>of 10 scenarios</span></div>
        <div><strong>{workspace?.report ? workspace.report.rankProbeCaseCount : workspace ? "Not evaluated" : loading ? "Loading…" : "Unavailable"}</strong><span>of {reviewedCount || 24} rank probes</span></div>
        <div data-ready={workspace?.report?.activationReady ? "true" : undefined}>
          <strong>{workspace?.report ? workspace.report.activationReady ? "Passed" : "Locked" : workspace ? "Not evaluated" : loading ? "Loading…" : "Unavailable"}</strong>
          <span>activation gate</span>
        </div>
      </div>
      <p id="semantic-review-resource-state" className={styles.resourceState} role="status">{busy ? saving ? "Saving an evaluation review. Read refresh is paused until its receipt returns." : "Measuring retrieval ranks. Read refresh is paused until its receipt returns." : workspace && (workspaceLoadError || loading || workspaceNeedsRefresh) ? "Showing last loaded evaluation counts and episodes." : !workspace && workspaceLoadError ? "Evaluation counts and episodes could not be checked." : loading ? "Loading evaluation counts and episodes…" : "Counts and gate results describe the loaded 24-episode window."}</p>
      <p className={styles.error} role="alert">{workspaceLoadError ? <><CircleAlert size={16} aria-hidden="true" />{workspaceLoadError}</> : null}</p>

      {workspace?.report ? <div className={styles.dimensionRail} aria-label="Evaluation scenario coverage">
        {dimensions.map(([id, label]) => (
          <span key={id} data-covered={coveredDimensions.has(id) ? "true" : undefined}>
            {coveredDimensions.has(id) ? <BadgeCheck size={13} aria-hidden="true" /> : null}{label}<small>{coveredDimensions.has(id) ? "Covered" : "Not covered"}</small>
          </span>
        ))}
      </div> : null}

      <p className={styles.error} role="alert">{error ? <><CircleAlert size={16} aria-hidden="true" />{error}</> : null}</p>
      <p className={styles.feedback} role="status">{feedback ? <><BadgeCheck size={16} aria-hidden="true" />{feedback}</> : null}</p>
      {receipt ? <details className={styles.evaluationIdentity}>
        <summary>Confirmed evaluation receipt</summary>
        <dl>
          <div><dt>Recorded result</dt><dd>{receipt.kind === "review" ? "Human review" : "Measured rank probe"} · {formatDate(receipt.at)}</dd></div>
          <div><dt>Episode</dt><dd><code>{receipt.target.id}</code></dd></div>
          <div><dt>Source digest</dt><dd><code>{receipt.target.reviewSourceSha256}</code></dd></div>
          {receipt.kind === "probe" ? <>
            <div><dt>Query digest</dt><dd><code>{receipt.querySha256}</code></dd></div>
            <div><dt>Corpus digest</dt><dd><code>{receipt.corpusSha256}</code></dd></div>
          </> : null}
        </dl>
      </details> : null}
      <p className={styles.resourceState} role="status">{overviewRefreshError}</p>
      <p id="semantic-review-action-state" className={styles.resourceState} role="status">{actionReason}{busy ? " Leaving Reviews does not cancel a request already sent to the server." : ""}</p>

      <div className={styles.benchGrid}>
        <aside className={styles.queue} aria-label="Semantic evaluation episodes">
          <header><span>Evaluation episodes</span><small>{workspace ? `${workspace.candidates.length} available${workspaceLoadError || loading || workspaceNeedsRefresh ? " · Last loaded" : ""}` : loading ? "Loading…" : "Unavailable"}</small></header>
          <div role="region" aria-label="Available evaluation episodes" tabIndex={0}>
            {workspace?.candidates.map((candidate, index) => (
              <button
                type="button"
                key={candidate.id}
                className={candidate.id === selectedId ? styles.selected : undefined}
                onClick={() => {
                  if (gate.isBusy() || gate.target()?.id === candidate.id) return;
                  setVersionNotice("");
                  setError(undefined);
                  selectTarget({ id: candidate.id, reviewSourceSha256: candidate.reviewSourceSha256 });
                }}
                disabled={busy}
                aria-describedby={busy ? "semantic-review-action-state" : undefined}
                aria-pressed={candidate.id === selectedId}
              >
                <span>
                  <strong>Episode {index + 1}</strong>
                  <small>{formatDate(candidate.endsAt)} · {candidate.metrics.semanticItemCount} semantic items</small>
                  <em>{candidate.latestReview ? "Reviewed" : candidate.reviewable ? "Ready to judge" : "Needs recollection"}</em>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
            {!loading && workspace && !workspaceLoadError && !workspaceNeedsRefresh && !workspace.candidates.length ? (
              <div className={styles.queueEmpty}><Eye size={20} /><strong>No episodes collected yet</strong><span>Use the collection step above when conversations contain complete 12-turn episodes.</span></div>
            ) : null}
            {loading ? <div className={styles.queueLoading} role="status">Loading episodes…</div> : null}
          </div>
        </aside>

        <div className={styles.reviewPane}>
          <div className={styles.detailReadState}>
            <p role="status">{[detailLoading ? detail?.id === selectedId ? "Refreshing episode evidence. Your current draft is retained." : "Opening private source evidence…" : "", detailLoadError || versionNotice].filter(Boolean).join(" ")}</p>
            {selected ? <button type="button" onClick={() => void loadDetail(selected)} disabled={busy} aria-describedby="semantic-review-action-state">Retry episode evidence</button> : null}
          </div>
          {detail && detail.id === selectedId ? (
            <ReviewForm
              candidate={detail}
              draft={draft}
              onDraft={(value) => { if (!gate.isBusy() && detailKey === reviewTargetKey(gate.target())) setDraftState({ key: detailKey, value }); }}
              onSubmit={() => void submitEvaluation("review")}
              probeQuery={probeQuery}
              onProbeQuery={(query) => { if (!gate.isBusy() && detailKey === reviewTargetKey(gate.target())) setQueryState({ key: detailKey, value: { query, confirmed: humanConfirmedTarget } }); }}
              humanConfirmedTarget={humanConfirmedTarget}
              onHumanConfirmedTarget={(confirmed) => { if (!gate.isBusy() && detailKey === reviewTargetKey(gate.target())) setQueryState({ key: detailKey, value: { query: probeQuery, confirmed } }); }}
              onProbe={() => void submitEvaluation("probe")}
              probing={probing}
              saving={saving}
              editsDisabled={busy || detailKey !== selectedKey}
              blockedReason={actionReason}
              submitError={payloadState?.error}
            />
          ) : (
            <div className={styles.detailEmpty}><ClipboardCheck size={28} aria-hidden="true" /><strong>{detailLoadError && selectedId ? "Episode evidence is unavailable" : selectedId ? "Opening selected episode…" : "Select an evaluation episode"}</strong><span>{detailLoadError && selectedId ? detailLoadError : "Source text is returned to this page only when you open an episode."}</span></div>
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
  editsDisabled: boolean;
  blockedReason?: string;
  submitError?: string;
}) {
  const { candidate, draft } = props;
  const submitHelpId = useId();
  const unavailableId = useId();
  const update = (patch: Partial<SemanticShadowReviewDraft>) =>
    props.onDraft({ ...draft, ...patch });
  return (
    <>
      <header className={styles.detailHeading}>
        <div><p>Private episode · {formatDate(candidate.endsAt)}</p><h4>Compare the evidence</h4></div>
        <span>{candidate.model.provider} · {candidate.model.model}</span>
      </header>
      {!candidate.reviewable ? <p id={unavailableId} className={styles.unavailable}><CircleAlert size={16} aria-hidden="true" />{candidate.unavailableReason || "This episode is not ready to review."}</p> : null}
      <details className={styles.evaluationIdentity}>
        <summary>Evaluation identity</summary>
        <dl>
          <div><dt>Episode</dt><dd><code>{candidate.id}</code></dd></div>
          <div><dt>Source digest</dt><dd><code>{candidate.reviewSourceSha256}</code></dd></div>
          <div><dt>Generation model</dt><dd>{candidate.model.provider} · {candidate.model.model}</dd></div>
        </dl>
      </details>
      <div className={styles.comparison}>
        <section className={styles.sourcePanel}>
          <header><span>1 · Source conversation</span><small>{candidate.metrics.sourceCharacterCount.toLocaleString()} characters</small></header>
          <div role="region" aria-label="Source conversation evidence" tabIndex={0}>{candidate.sourceTurns?.length ? candidate.sourceTurns.map((turn) => <article key={turn.id} data-role={turn.role}><strong>{turn.role === "user" ? "You" : "Asael"}</strong><p>{turn.content}</p></article>) : <p>No source turns were returned for this episode.</p>}</div>
        </section>
        <section className={styles.baselinePanel}>
          <header><span>2 · Deterministic baseline</span><small>Current sealed summary</small></header>
          <div role="region" aria-label="Deterministic baseline evidence" tabIndex={0}><p>{candidate.deterministicSummary || "No deterministic summary was returned for this episode."}</p></div>
        </section>
      </div>

      <section className={styles.semanticPanel}>
        <header><div><span>3 · Proposed semantic memory</span><small>Every item needs a source-support decision</small></div><em>{candidate.metrics.validQuoteBindingCount}/{candidate.metrics.quoteBindingCount} exact quotes</em></header>
        <div>{candidate.semanticItems?.map((item) => (
          <article key={item.id}>
            <div className={styles.itemCopy}>
              <span>{startCase(item.kind)} · {Math.round(item.confidenceBasisPoints / 100)}% confidence</span>
              <p>{item.text}</p>
              {item.evidence.length ? item.evidence.map((evidence, index) => <blockquote key={`${evidence.turnId}:${index}`} data-valid={evidence.valid ? "true" : undefined}><p>{evidence.quote}</p><small>{evidence.valid ? "Exact source span" : "Source mismatch"}</small></blockquote>) : <p className={styles.missingEvidence}>No supporting quote was returned for this item.</p>}
            </div>
            <fieldset disabled={props.editsDisabled} aria-describedby={props.editsDisabled ? "semantic-review-action-state" : undefined}>
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
        ))}{!candidate.semanticItems?.length ? <p className={styles.missingEvidence}>No proposed semantic items were returned for this episode.</p> : null}</div>
      </section>

      <section className={styles.scorecard}>
        <header><span>4 · Quality scorecard</span><small>Count only important facts you can point to in the source.</small></header>
        <div className={styles.scoreGrid}>
          <label>Scenario<select disabled={props.editsDisabled} value={draft.dimension} onChange={(event) => update({ dimension: event.target.value as Dimension })}><option value="">Choose one…</option>{dimensions.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
          <label>Important source facts<input disabled={props.editsDisabled} type="number" min="1" max="128" inputMode="numeric" value={draft.importantFactCount} onChange={(event) => update({ importantFactCount: event.target.value })} /></label>
          <label>Facts in baseline<input disabled={props.editsDisabled} type="number" min="0" max="128" inputMode="numeric" value={draft.baselineImportantFactHitCount} onChange={(event) => update({ baselineImportantFactHitCount: event.target.value })} /></label>
          <label>Facts in semantic result<input disabled={props.editsDisabled} type="number" min="0" max="128" inputMode="numeric" value={draft.semanticImportantFactHitCount} onChange={(event) => update({ semanticImportantFactHitCount: event.target.value })} /></label>
          <label>Unrelated or cross-scope facts<input disabled={props.editsDisabled} type="number" min="0" max="128" inputMode="numeric" value={draft.scopeLeakCount} onChange={(event) => update({ scopeLeakCount: event.target.value })} /></label>
          <label>Useful compression<select disabled={props.editsDisabled} value={draft.compressionJudgment} onChange={(event) => update({ compressionJudgment: event.target.value as SemanticShadowReviewDraft["compressionJudgment"] })}><option value="">Choose…</option><option value="good">Good — concise and complete</option><option value="needs_work">Needs work</option></select></label>
        </div>
        <label className={styles.attestation}><input disabled={props.editsDisabled} type="checkbox" checked={draft.humanReviewed} onChange={(event) => update({ humanReviewed: event.target.checked })} /><span><strong>I compared the source, baseline and every semantic item.</strong><small>This is a human evidence judgment, not an automatic model score.</small></span></label>
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
              disabled={props.editsDisabled}
              maxLength={500}
              placeholder="What decision did we make about the Apollo release?"
              value={props.probeQuery}
              onChange={(event) => props.onProbeQuery(event.target.value)}
            />
          </label>
          <button type="button" onClick={props.onProbe} disabled={props.probing || Boolean(props.blockedReason) || !candidate.reviewable} aria-describedby={`semantic-review-action-state${!candidate.reviewable ? ` ${unavailableId}` : ""}`}>
            {props.probing ? <LoaderCircle size={16} className={styles.spin} /> : <Eye size={16} />}
            {props.probing ? "Measuring…" : "Measure ranks"}
          </button>
        </div>
        <label className={styles.probeAttestation}>
          <input
            type="checkbox"
            disabled={props.editsDisabled}
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
        <div><strong>{candidate.latestReview ? "Update this review" : "Save this review"}</strong><span id={submitHelpId}>{props.submitError || "This records evaluation evidence only."}</span></div>
        <button type="button" onClick={props.onSubmit} disabled={props.saving || Boolean(props.blockedReason) || !candidate.reviewable || Boolean(props.submitError)} aria-describedby={`${submitHelpId} semantic-review-action-state`}>{props.saving ? <LoaderCircle size={16} className={styles.spin} /> : <ClipboardCheck size={16} />}{props.saving ? "Saving evidence…" : candidate.latestReview ? "Update review" : "Save review"}</button>
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
  return typeof record.message === "string" && record.message.trim() ? record.message : typeof record.error === "string" ? record.error : fallback;
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
