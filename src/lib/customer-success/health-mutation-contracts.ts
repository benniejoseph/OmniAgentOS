import { z } from "zod";
import {
  customerHealthEvaluationId, customerHealthScoreId, customerHealthScoreSchema,
  type CustomerHealthScore,
} from "@/lib/customer-success/health-contracts";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

export const CUSTOMER_HEALTH_EVALUATION_REQUEST_CONTRACT = "customer-health-evaluation-request:1" as const;
export const CUSTOMER_HEALTH_EVALUATION_INTENT_CONTRACT = "customer-health-evaluation-intent:1" as const;
export const CUSTOMER_HEALTH_EVALUATION_ACCEPTANCE_CONTRACT = "customer-health-evaluation-acceptance:1" as const;
export const CUSTOMER_HEALTH_EVALUATION_READ_CONTRACT = "customer-health-evaluation-read:1" as const;
export const CUSTOMER_HEALTH_REVISION_MAX = 2_147_483_647;
const revision = z.number().int().min(1).max(CUSTOMER_HEALTH_REVISION_MAX);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const workspace = opaque.regex(/^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const accountId = z.string().regex(/^customer-account:[a-f0-9]{64}$/);
const canonicalActor = z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
export const customerHealthEvaluationIdSchema = z.string().regex(/^customer-health-evaluation:[a-f0-9]{64}$/);
const at = z.string().datetime({ offset: true }).refine((value) => new Date(value).toISOString() === value);
const basisPoints = z.number().int().min(0).max(10_000);
const accountRevisionId = z.string().regex(/^customer-account:[a-f0-9]{64}:v[1-9][0-9]*$/);

export const customerHealthEvaluationFieldsSchema = z.object({
  expectedAccountRevision: revision,
  expectedAccountSha256: digest,
  modelSuggestions: z.tuple([]),
}).strict();
export const customerHealthEvaluationRequestSchema = customerHealthEvaluationFieldsSchema.extend({
  contract: z.literal(CUSTOMER_HEALTH_EVALUATION_REQUEST_CONTRACT), workspaceId: workspace,
}).strict();
export const customerHealthEvaluationIntentSchema = z.object({
  schemaVersion: z.literal(1), contract: z.literal(CUSTOMER_HEALTH_EVALUATION_INTENT_CONTRACT),
  tenantId: opaque, workspaceId: workspace, accountId, evaluationId: customerHealthEvaluationIdSchema,
  canonicalActorId: canonicalActor, idempotencyKeySha256: digest,
  request: customerHealthEvaluationFieldsSchema,
}).strict();
export const customerHealthEvaluationCurrentAccountSchema = z.object({
  accountId, revisionId: accountRevisionId, revision, accountSha256: digest,
}).strict().refine((value) => value.revisionId === `${value.accountId}:v${value.revision}`, {
  message: "Current Account revision identity is inconsistent.",
});
export const customerHealthCurrentAccountSchema = customerHealthEvaluationCurrentAccountSchema;

const acceptanceBody = z.object({
  schemaVersion: z.literal(1), contract: z.literal(CUSTOMER_HEALTH_EVALUATION_ACCEPTANCE_CONTRACT),
  operation: z.literal("health.evaluate"), tenantId: opaque, workspaceId: workspace, accountId,
  canonicalActorId: canonicalActor, evaluationId: customerHealthEvaluationIdSchema,
  idempotencyKeySha256: digest, requestSha256: digest,
  accountRevisionId, accountRevision: revision, accountSha256: digest,
  scoreId: z.string().regex(/^customer-health-score:[a-f0-9]{64}$/),
  scoreRevisionId: z.string().regex(/^customer-health-score:[a-f0-9]{64}:v[1-9][0-9]*$/),
  scoreRevision: revision, scoreSha256: digest,
  policyId: z.string().regex(/^customer-health-policy:[a-f0-9]{64}$/), policySha256: digest, inputSha256: digest,
  scoreBasisPoints: basisPoints.nullable(), status: z.enum(["healthy", "watch", "at_risk", "unknown"]),
  confidenceBasisPoints: basisPoints, coverageBasisPoints: basisPoints,
  authority: z.literal("deterministic_policy"), acceptedAt: at,
});
export const customerHealthEvaluationAcceptanceSchema = acceptanceBody.extend({ acceptanceSha256: digest }).strict().superRefine((value, context) => {
  const { acceptanceSha256, ...body } = value;
  if (acceptanceSha256 !== canonicalJsonSha256(body) || value.accountRevisionId !== `${value.accountId}:v${value.accountRevision}` ||
    value.scoreId !== customerHealthScoreId({ tenantId: value.tenantId, workspaceId: value.workspaceId, accountId: value.accountId }) ||
    value.scoreRevisionId !== `${value.scoreId}:v${value.scoreRevision}` || value.policyId !== `customer-health-policy:${value.policySha256}` ||
    (value.scoreBasisPoints === null) !== (value.status === "unknown")) {
    context.addIssue({ code: "custom", message: "Health acceptance identity, outcome or digest is inconsistent." });
  }
});
export type CustomerHealthEvaluationRequest = z.infer<typeof customerHealthEvaluationRequestSchema>;
export type CustomerHealthEvaluationIntent = z.infer<typeof customerHealthEvaluationIntentSchema>;
export type CustomerHealthEvaluationAcceptance = z.infer<typeof customerHealthEvaluationAcceptanceSchema>;
export type CustomerHealthEvaluationCurrentAccount = z.infer<typeof customerHealthEvaluationCurrentAccountSchema>;
export type CustomerHealthCurrentAccount = CustomerHealthEvaluationCurrentAccount;

export function buildCustomerHealthEvaluationIntent(input: {
  tenantId: string; workspaceId: string; canonicalActorId: string; accountId: string; idempotencyKey: string;
  request: CustomerHealthEvaluationRequest;
}): CustomerHealthEvaluationIntent {
  const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/).parse(input.idempotencyKey);
  const request = customerHealthEvaluationRequestSchema.parse(input.request);
  if (request.workspaceId !== input.workspaceId) throw new Error("Reviewed health workspace differs from current authority.");
  return customerHealthEvaluationIntentSchema.parse({
    schemaVersion: 1, contract: CUSTOMER_HEALTH_EVALUATION_INTENT_CONTRACT,
    tenantId: input.tenantId, workspaceId: input.workspaceId, accountId: input.accountId, canonicalActorId: input.canonicalActorId,
    evaluationId: customerHealthEvaluationId({ accountId: input.accountId, idempotencyKey: key }),
    idempotencyKeySha256: idempotencyKeySha256({ tenantId: input.tenantId, idempotencyKey: key }),
    request: { expectedAccountRevision: request.expectedAccountRevision, expectedAccountSha256: request.expectedAccountSha256, modelSuggestions: [] },
  });
}

export function buildCustomerHealthEvaluationAcceptance(intentValue: CustomerHealthEvaluationIntent, scoreValue: CustomerHealthScore): CustomerHealthEvaluationAcceptance {
  const intent = customerHealthEvaluationIntentSchema.parse(intentValue), score = customerHealthScoreSchema.parse(scoreValue);
  if (score.tenantId !== intent.tenantId || score.workspaceId !== intent.workspaceId || score.accountId !== intent.accountId ||
    score.evaluationId !== intent.evaluationId || score.evaluatedByActorId !== intent.canonicalActorId || score.suggestions.length !== 0 ||
    score.accountRevisionId !== `${intent.accountId}:v${intent.request.expectedAccountRevision}` || score.accountSha256 !== intent.request.expectedAccountSha256) {
    throw new Error("The immutable health score does not match the exact accepted request.");
  }
  const body = acceptanceBody.parse({
    schemaVersion: 1, contract: CUSTOMER_HEALTH_EVALUATION_ACCEPTANCE_CONTRACT, operation: "health.evaluate",
    tenantId: intent.tenantId, workspaceId: intent.workspaceId, accountId: intent.accountId, canonicalActorId: intent.canonicalActorId,
    evaluationId: intent.evaluationId, idempotencyKeySha256: intent.idempotencyKeySha256, requestSha256: canonicalJsonSha256(intent),
    accountRevisionId: score.accountRevisionId, accountRevision: intent.request.expectedAccountRevision, accountSha256: score.accountSha256,
    scoreId: score.scoreId, scoreRevisionId: score.scoreRevisionId, scoreRevision: score.revision, scoreSha256: score.scoreSha256,
    policyId: score.policy.policyId, policySha256: score.policy.policySha256, inputSha256: score.inputSha256,
    scoreBasisPoints: score.scoreBasisPoints, status: score.status, confidenceBasisPoints: score.confidenceBasisPoints,
    coverageBasisPoints: score.coverageBasisPoints, authority: score.authority, acceptedAt: score.evaluatedAt,
  });
  return customerHealthEvaluationAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
}

export const customerHealthEvaluationRefusalCodeSchema = z.enum([
  "customer_health_account_changed", "customer_health_revision_exhausted", "customer_health_projection_limit",
]);
export class CustomerHealthEvaluationRefusedError extends Error {
  readonly status = 409;
  readonly admission = "not_admitted" as const;
  readonly code: z.infer<typeof customerHealthEvaluationRefusalCodeSchema>;
  readonly evaluationId: string;
  readonly requestSha256: string;
  constructor(input: { code: z.infer<typeof customerHealthEvaluationRefusalCodeSchema>; message: string; evaluationId: string; requestSha256: string }) {
    super(input.message); this.name = "CustomerHealthEvaluationRefusedError";
    this.code = customerHealthEvaluationRefusalCodeSchema.parse(input.code);
    this.evaluationId = customerHealthEvaluationIdSchema.parse(input.evaluationId);
    this.requestSha256 = digest.parse(input.requestSha256);
  }
}
