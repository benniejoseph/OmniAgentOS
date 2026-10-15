"use client";

import { useEffect, useEffectEvent, useState } from "react";

type Review = { actionSha256: string; approval: { id: string; title: string; input: Record<string, unknown>; blockReason?: string } };
export type SpokenApprovalPresentation = { presentationId: string; expiresAt: string; executionId: string; runId: string; sessionId: string; reviewGeneration: number };

/** Display first, then attest that exact immutable action to the service. */
export function SpokenApprovalReview(props: {
  executionId: string; runId: string; sessionId: string; conversationId: string;
  isCurrent: () => boolean; onPresented: (value: SpokenApprovalPresentation) => boolean;
  onPresentationStart: () => number | undefined;
  disabled: boolean; onReviewAgain: () => void;
}) {
  const [review, setReview] = useState<Review>();
  const [notice, setNotice] = useState("Preparing spoken review…");
  const current = useEffectEvent(() => props.isCurrent());
  const presented = useEffectEvent((value: SpokenApprovalPresentation) => props.onPresented(value));
  const presentationStarted = useEffectEvent(() => props.onPresentationStart());
  useEffect(() => {
    if (props.disabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/approvals/${encodeURIComponent(props.executionId)}`, {
          method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ kind: "tool", voiceReview: { operation: "prepare", sessionId: props.sessionId,
            conversationId: props.conversationId, runId: props.runId } }),
        });
        const value = await response.json();
        if (!response.ok || value.schemaVersion !== 1 || value.approval?.id !== props.executionId ||
            typeof value.approval?.title !== "string" || !value.approval?.input ||
            !/^[a-f0-9]{64}$/.test(value.actionSha256) || JSON.stringify(value.approval).length > 12000) throw new Error();
        if (!controller.signal.aborted && current()) setReview(value);
      } catch { if (!controller.signal.aborted && current()) setNotice("Use the approval buttons below. Spoken review could not be prepared."); }
    })();
    return () => controller.abort();
  }, [props.executionId, props.runId, props.sessionId, props.conversationId, props.disabled]);
  useEffect(() => {
    if (!review || !current() || props.disabled) return;
    const reviewGeneration = presentationStarted();
    if (reviewGeneration === undefined) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/approvals/${encodeURIComponent(props.executionId)}`, {
          method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ kind: "tool", voiceReview: { operation: "present", sessionId: props.sessionId,
            conversationId: props.conversationId, runId: props.runId, actionSha256: review.actionSha256 } }),
        });
        const value = await response.json();
        if (!response.ok || value.actionSha256 !== review.actionSha256 || typeof value.presentationId !== "string" ||
            !(Date.parse(value.expiresAt) > Date.now())) throw new Error();
        if (controller.signal.aborted || !current()) return;
        const armed = presented({ presentationId: value.presentationId, expiresAt: value.expiresAt,
          executionId: props.executionId, runId: props.runId, sessionId: props.sessionId, reviewGeneration });
        setNotice(!armed ? 'The conversation changed during review. Review the action again before deciding.'
          : review.approval.blockReason ? 'Approval is unavailable for this action. You may say “reject this action”.' : 'For this action only, say “approve this action” or “reject this action”.');
      } catch { if (!controller.signal.aborted && current()) setNotice("Spoken review is unavailable. Use the approval buttons below."); }
    })();
    return () => controller.abort();
  }, [review, props.executionId, props.runId, props.sessionId, props.conversationId, props.disabled]);
  return <div aria-label="Exact action for spoken review">
    {review ? <><strong>{review.approval.title}</strong><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(review.approval.input, null, 2)}</pre>
      {review.approval.blockReason ? <p>{review.approval.blockReason}</p> : null}</> : null}
    <p role="status">{props.disabled ? "Spoken review is paused. Review the action again before a new spoken decision." : notice}</p>
    {props.disabled ? <button type="button" onClick={() => { setReview(undefined); props.onReviewAgain(); }}>Review again for a spoken decision</button> : null}
  </div>;
}
