export type AppBuilderSentinelVerdict = "passed" | "blocked";

type SentinelReviewActivity = Readonly<{
  eventType: string;
  detail: Record<string, unknown>;
}>;

type SentinelReviewVerification = Readonly<{
  id: string;
  checkpointId: string;
  workspaceSha256: string;
}>;

export function parseAppBuilderSentinelVerdict(response: string): AppBuilderSentinelVerdict {
  const opening = response.trimStart().slice(0, 240);
  const match = opening.match(/^(?:#{1,6}\s*)?(?:\*\*)?(PASS|BLOCK)\b/i);
  return match?.[1]?.toUpperCase() === "PASS" ? "passed" : "blocked";
}

export function findAppBuilderSentinelReview(
  activity: readonly SentinelReviewActivity[],
  verification: SentinelReviewVerification | undefined,
) {
  if (!verification) return undefined;
  return activity.find((item) =>
    item.eventType === "app_builder.sentinel.reviewed" &&
    item.detail.verificationId === verification.id &&
    item.detail.checkpointId === verification.checkpointId &&
    item.detail.workspaceSha256 === verification.workspaceSha256 &&
    (item.detail.verdict === "passed" || item.detail.verdict === "blocked")
  );
}

export function hasPassingAppBuilderSentinelReview(
  activity: readonly SentinelReviewActivity[],
  verification: SentinelReviewVerification | undefined,
) {
  return findAppBuilderSentinelReview(activity, verification)?.detail.verdict === "passed";
}
