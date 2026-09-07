import { createHash } from "node:crypto";
import { z } from "zod";

import { customerFactOwnerSchema } from "@/lib/customer-success/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  workspaceTemplateProjectSchema,
  type WorkspaceTemplateProject,
} from "@/lib/workspace-templates/contracts";

export const CUSTOMER_SUCCESS_WORKFLOW_CONTRACT_VERSION =
  "p10.13-customer-success-workflow:1" as const;
export const CUSTOMER_SUCCESS_PACK_VERSION = "asael-csm-pack:1" as const;

export const CUSTOMER_SUCCESS_WORKFLOW_IDS = Object.freeze([
  "onboarding",
  "adoption_review",
  "risk_escalation",
  "renewal_planning",
  "qbr_ebr",
  "meeting_prep_follow_up",
  "support_escalation",
  "expansion_discovery",
] as const);

export const CUSTOMER_SUCCESS_WORKFLOW_EVENT_TYPES = Object.freeze({
  started: "customer.success.workflow.started",
  outcomeRecorded: "customer.success.workflow.outcome_recorded",
} as const);

const opaqueIdSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const workspaceIdSchema = opaqueIdSchema.regex(
  /^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const accountIdSchema = z.string().regex(/^customer-account:[a-f0-9]{64}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  { message: "Timestamp must use canonical UTC ISO format." },
);
const nullableTimestampSchema = canonicalTimestampSchema.nullable();
const shortTextSchema = z.string().trim().min(1).max(500);
const boundedTextListSchema = z.array(shortTextSchema).min(1).max(20);
const boundedIdListSchema = z.array(opaqueIdSchema).min(1).max(50);

const commonInputShape = {
  objective: z.string().trim().min(1).max(2_000),
  targetDate: nullableTimestampSchema.default(null),
};

export const customerSuccessWorkflowInputSchema = z.discriminatedUnion("workflowId", [
  z.object({
    workflowId: z.literal("onboarding"),
    ...commonInputShape,
    successCriteria: boundedTextListSchema,
    productNames: z.array(z.string().trim().min(1).max(240)).max(20).default([]),
    stakeholderIds: z.array(opaqueIdSchema).max(50).default([]),
  }).strict(),
  z.object({
    workflowId: z.literal("adoption_review"),
    ...commonInputShape,
    periodStartAt: canonicalTimestampSchema,
    periodEndAt: canonicalTimestampSchema,
    adoptionGoals: boundedTextListSchema,
    productIds: z.array(opaqueIdSchema).max(20).default([]),
  }).strict().refine(
    (value) => value.periodEndAt > value.periodStartAt,
    { path: ["periodEndAt"], message: "Adoption review period must be non-empty." },
  ),
  z.object({
    workflowId: z.literal("risk_escalation"),
    ...commonInputShape,
    riskTitle: z.string().trim().min(1).max(500),
    severity: z.enum(["low", "medium", "high", "critical"]),
    signals: boundedTextListSchema,
    executiveSponsorId: opaqueIdSchema.nullable().default(null),
  }).strict(),
  z.object({
    workflowId: z.literal("renewal_planning"),
    ...commonInputShape,
    renewalAt: canonicalTimestampSchema,
    renewalGoals: boundedTextListSchema,
    amountMinor: z.number().int().nonnegative().nullable().default(null),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  }).strict().refine(
    (value) => (value.amountMinor === null) === (value.currency === null),
    { path: ["currency"], message: "Renewal amount and currency must be provided together." },
  ),
  z.object({
    workflowId: z.literal("qbr_ebr"),
    ...commonInputShape,
    reviewKind: z.enum(["qbr", "ebr"]),
    meetingAt: canonicalTimestampSchema,
    periodStartAt: canonicalTimestampSchema,
    periodEndAt: canonicalTimestampSchema,
    audience: boundedTextListSchema,
    agendaObjectives: boundedTextListSchema,
  }).strict().refine(
    (value) => value.periodEndAt > value.periodStartAt,
    { path: ["periodEndAt"], message: "Business review period must be non-empty." },
  ),
  z.object({
    workflowId: z.literal("meeting_prep_follow_up"),
    ...commonInputShape,
    meetingId: opaqueIdSchema,
    phase: z.enum(["prep", "follow_up"]),
    participantIds: boundedIdListSchema,
    meetingObjectives: boundedTextListSchema,
  }).strict(),
  z.object({
    workflowId: z.literal("support_escalation"),
    ...commonInputShape,
    caseIds: boundedIdListSchema,
    severity: z.enum(["medium", "high", "critical"]),
    customerImpact: z.string().trim().min(1).max(2_000),
    requestedOutcome: z.string().trim().min(1).max(1_000),
  }).strict(),
  z.object({
    workflowId: z.literal("expansion_discovery"),
    ...commonInputShape,
    hypotheses: boundedTextListSchema,
    stakeholderIds: boundedIdListSchema,
    discoveryWindowEndAt: canonicalTimestampSchema,
  }).strict(),
]);

const inputFieldSchema = z.object({
  fieldId: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  label: z.string().trim().min(1).max(120),
  valueType: z.enum([
    "text", "text_list", "id", "id_list", "timestamp", "enum", "money",
  ]),
  required: z.boolean(),
  allowedValues: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
}).strict();

const artifactRequirementSchema = z.object({
  artifactKey: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().min(1).max(1_000),
  required: z.boolean(),
}).strict();

const evidenceRequirementSchema = z.object({
  evidenceKey: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().min(1).max(1_000),
  required: z.boolean(),
  allowedSourceKinds: z.array(z.enum([
    "account_fact", "customer_health", "meeting", "project_artifact",
    "support_case", "crm_revision", "operator_confirmation",
  ])).min(1).max(10),
}).strict();

const externalActionPolicySchema = z.object({
  communicationMode: z.literal("draft_only_until_governed_delivery"),
  crmMode: z.literal("proposal_only_until_governed_write"),
  allowedCommunicationToolIds: z.array(z.literal("app.communications.drafts.create")),
  allowedCrmToolIdPrefixes: z.array(z.literal("app.customer_accounts.salesforce.")),
  directExternalEffectsAllowed: z.literal(false),
}).strict();

const customerSuccessWorkflowDefinitionBodySchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(CUSTOMER_SUCCESS_WORKFLOW_CONTRACT_VERSION),
  packVersion: z.literal(CUSTOMER_SUCCESS_PACK_VERSION),
  workflowId: z.enum(CUSTOMER_SUCCESS_WORKFLOW_IDS),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_000),
  inputFields: z.array(inputFieldSchema).min(3).max(20),
  acceptanceCriteria: z.array(shortTextSchema).min(1).max(20),
  artifacts: z.array(artifactRequirementSchema).min(1).max(20),
  evidenceRequirements: z.array(evidenceRequirementSchema).min(1).max(20),
  projectTemplate: workspaceTemplateProjectSchema,
  defaultNextAction: z.string().trim().min(1).max(500),
  externalActionPolicy: externalActionPolicySchema,
}).strict().superRefine((definition, context) => {
  assertUnique(definition.inputFields.map((item) => item.fieldId), context, "inputFields");
  assertUnique(definition.artifacts.map((item) => item.artifactKey), context, "artifacts");
  assertUnique(
    definition.evidenceRequirements.map((item) => item.evidenceKey),
    context,
    "evidenceRequirements",
  );
});

export const customerSuccessWorkflowDefinitionSchema =
  customerSuccessWorkflowDefinitionBodySchema.extend({
    definitionSha256: sha256Schema,
  }).strict().superRefine((definition, context) => {
    const { definitionSha256, ...body } = definition;
    if (canonicalJsonSha256(body) !== definitionSha256) {
      context.addIssue({
        code: "custom",
        path: ["definitionSha256"],
        message: "Workflow definition digest does not match.",
      });
    }
  });

const artifactReceiptSchema = z.object({
  artifactKey: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
  projectArtifactId: opaqueIdSchema,
  evidenceKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,79}$/)).max(20),
  evidenceRefs: z.array(opaqueIdSchema).max(100),
}).strict();

const outcomeReceiptBodySchema = z.object({
  status: z.enum(["in_progress", "completed", "blocked", "cancelled"]),
  summary: z.string().trim().max(4_000),
  artifactReceipts: z.array(artifactReceiptSchema).max(20),
  nextAction: z.string().trim().min(1).max(500),
  recordedByActorId: opaqueIdSchema,
  recordedAt: canonicalTimestampSchema,
}).strict();

export const customerSuccessOutcomeReceiptSchema = outcomeReceiptBodySchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((receipt, context) => {
  const { receiptSha256, ...body } = receipt;
  if (canonicalJsonSha256(body) !== receiptSha256) {
    context.addIssue({ code: "custom", path: ["receiptSha256"], message: "Outcome receipt digest does not match." });
  }
  if (receipt.status === "in_progress" && (receipt.summary || receipt.artifactReceipts.length)) {
    context.addIssue({ code: "custom", message: "An in-progress receipt cannot claim outcomes." });
  }
});

const workflowRunRevisionBodySchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(CUSTOMER_SUCCESS_WORKFLOW_CONTRACT_VERSION),
  tenantId: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  accountId: accountIdSchema,
  accountRevisionId: opaqueIdSchema,
  accountRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  accountSha256: sha256Schema,
  runId: z.string().regex(/^customer-success-run:[a-f0-9]{64}$/),
  runRevisionId: opaqueIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  previousRunRevisionId: opaqueIdSchema.nullable(),
  workflowId: z.enum(CUSTOMER_SUCCESS_WORKFLOW_IDS),
  definitionSha256: sha256Schema,
  input: customerSuccessWorkflowInputSchema,
  inputSha256: sha256Schema,
  owner: customerFactOwnerSchema,
  ownerActorId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  projectTaskIds: z.array(z.object({
    taskKey: opaqueIdSchema,
    projectTaskId: opaqueIdSchema,
  }).strict()).min(1).max(20),
  allowedPurposeIds: z.tuple([z.literal("customer_success.account.read")]),
  outcome: customerSuccessOutcomeReceiptSchema,
}).strict().superRefine((run, context) => {
  if (run.runRevisionId !== `${run.runId}:v${run.revision}`) {
    context.addIssue({ code: "custom", path: ["runRevisionId"], message: "Run revision identity is inconsistent." });
  }
  const expectedPrevious = run.revision === 1 ? null : `${run.runId}:v${run.revision - 1}`;
  if (run.previousRunRevisionId !== expectedPrevious) {
    context.addIssue({ code: "custom", path: ["previousRunRevisionId"], message: "Run revision lineage is inconsistent." });
  }
  if (run.input.workflowId !== run.workflowId || canonicalJsonSha256(run.input) !== run.inputSha256) {
    context.addIssue({ code: "custom", path: ["input"], message: "Run input snapshot is inconsistent." });
  }
});

export const customerSuccessWorkflowRunRevisionSchema = workflowRunRevisionBodySchema.extend({
  runSha256: sha256Schema,
}).strict().superRefine((run, context) => {
  const { runSha256, ...body } = run;
  if (canonicalJsonSha256(body) !== runSha256) {
    context.addIssue({ code: "custom", path: ["runSha256"], message: "Run revision digest does not match." });
  }
});

export type CustomerSuccessWorkflowId = typeof CUSTOMER_SUCCESS_WORKFLOW_IDS[number];
export type CustomerSuccessWorkflowInput = Readonly<z.infer<typeof customerSuccessWorkflowInputSchema>>;
export type CustomerSuccessWorkflowDefinition = Readonly<z.infer<typeof customerSuccessWorkflowDefinitionSchema>>;
export type CustomerSuccessOutcomeReceipt = Readonly<z.infer<typeof customerSuccessOutcomeReceiptSchema>>;
export type CustomerSuccessWorkflowRunRevision = Readonly<z.infer<typeof customerSuccessWorkflowRunRevisionSchema>>;

type DefinitionInput = Omit<z.input<typeof customerSuccessWorkflowDefinitionBodySchema>,
  "schemaVersion" | "contractVersion" | "packVersion" | "externalActionPolicy">;

const field = (
  fieldId: string,
  label: string,
  valueType: z.input<typeof inputFieldSchema>["valueType"],
  required: boolean,
  allowedValues: string[] = [],
) => ({ fieldId, label, valueType, required, allowedValues });
const artifact = (artifactKey: string, title: string, description: string, required = true) =>
  ({ artifactKey, title, description, required });
const evidence = (
  evidenceKey: string,
  title: string,
  description: string,
  allowedSourceKinds: z.input<typeof evidenceRequirementSchema>["allowedSourceKinds"],
  required = true,
) => ({ evidenceKey, title, description, allowedSourceKinds, required });
const task = (
  key: string,
  title: string,
  detail: string,
  dependsOnKeys: string[] = [],
) => ({ key, title, detail, priority: "high" as const, agentId: "atlas" as const, dependsOnKeys });

const COMMON_FIELDS = [
  field("objective", "Objective", "text", true),
  field("targetDate", "Target date", "timestamp", false),
] as const;
const ACCOUNT_EVIDENCE = evidence(
  "account_snapshot",
  "Current Account 360 evidence",
  "Cite exact current account facts or customer-health evidence used by the workflow.",
  ["account_fact", "customer_health"],
);

const DEFINITION_INPUTS: readonly DefinitionInput[] = [
  {
    workflowId: "onboarding",
    name: "Customer onboarding",
    description: "Turn sold outcomes into an owned, evidence-backed onboarding plan.",
    inputFields: [...COMMON_FIELDS, field("successCriteria", "Success criteria", "text_list", true), field("productNames", "Products", "text_list", false), field("stakeholderIds", "Stakeholders", "id_list", false)],
    acceptanceCriteria: ["Every success criterion has an owner, evidence source, and review date.", "Risks, dependencies, and the next customer checkpoint are explicit."],
    artifacts: [artifact("success_plan", "Mutual success plan", "Owned milestones, measures, dependencies, and dates."), artifact("kickoff_brief", "Kickoff brief", "Internal brief plus an unsent customer-facing agenda draft.")],
    evidenceRequirements: [ACCOUNT_EVIDENCE, evidence("stakeholder_confirmation", "Stakeholder confirmation", "Confirmed owners or an explicit unresolved stakeholder gap.", ["operator_confirmation", "meeting"])],
    projectTemplate: { title: "Customer onboarding", objective: "Create an evidence-backed onboarding plan.", status: "active", tasks: [task("baseline", "Baseline outcomes and stakeholders", "Resolve current Account 360 facts and record evidence references."), task("plan", "Build the mutual success plan", "Create the success_plan artifact with owners, measures, and dates.", ["baseline"]), task("kickoff", "Prepare the kickoff", "Create kickoff_brief as an internal brief and governed unsent communication draft.", ["plan"])] },
    defaultNextAction: "Review the account baseline and confirm success owners.",
  },
  {
    workflowId: "adoption_review",
    name: "Adoption review",
    description: "Compare observed product use with declared adoption goals and agree interventions.",
    inputFields: [...COMMON_FIELDS, field("periodStartAt", "Period start", "timestamp", true), field("periodEndAt", "Period end", "timestamp", true), field("adoptionGoals", "Adoption goals", "text_list", true), field("productIds", "Products", "id_list", false)],
    acceptanceCriteria: ["Every adoption claim cites an exact usage or operator-confirmed source.", "Gaps have an owner, intervention, target, and review date."],
    artifacts: [artifact("adoption_scorecard", "Adoption scorecard", "Goal-by-goal observed adoption with cited evidence."), artifact("adoption_action_plan", "Adoption action plan", "Owned interventions and review dates.")],
    evidenceRequirements: [ACCOUNT_EVIDENCE, evidence("usage_evidence", "Usage evidence", "Exact product-usage facts for the review period.", ["account_fact", "operator_confirmation"])],
    projectTemplate: { title: "Adoption review", objective: "Review evidence-backed customer adoption.", status: "active", tasks: [task("collect", "Collect adoption evidence", "Resolve usage facts for the exact review period."), task("scorecard", "Build adoption scorecard", "Create adoption_scorecard and label missing evidence.", ["collect"]), task("actions", "Agree adoption interventions", "Create adoption_action_plan; any customer message remains an unsent governed draft.", ["scorecard"])] },
    defaultNextAction: "Collect current usage evidence for the review period.",
  },
  {
    workflowId: "risk_escalation",
    name: "Risk escalation",
    description: "Contain a customer risk with an accountable mitigation and governed escalation path.",
    inputFields: [...COMMON_FIELDS, field("riskTitle", "Risk title", "text", true), field("severity", "Severity", "enum", true, ["low", "medium", "high", "critical"]), field("signals", "Observed signals", "text_list", true), field("executiveSponsorId", "Executive sponsor", "id", false)],
    acceptanceCriteria: ["Risk severity and customer impact are supported by cited evidence.", "Mitigation, escalation owner, checkpoint, and exit criteria are explicit."],
    artifacts: [artifact("risk_brief", "Risk brief", "Evidence, impact, severity, and unresolved uncertainty."), artifact("mitigation_plan", "Mitigation plan", "Owned containment, recovery, escalation, and exit criteria.")],
    evidenceRequirements: [ACCOUNT_EVIDENCE, evidence("risk_signal", "Risk signals", "Exact facts, cases, meetings, or operator confirmations supporting the risk.", ["account_fact", "support_case", "meeting", "operator_confirmation"])],
    projectTemplate: { title: "Customer risk escalation", objective: "Contain and resolve an evidence-backed customer risk.", status: "active", tasks: [task("triage", "Triage risk evidence", "Validate severity and create risk_brief without inventing customer claims."), task("mitigate", "Define mitigation and exit criteria", "Create mitigation_plan with owners and checkpoints.", ["triage"]), task("escalate", "Prepare governed escalation", "Prepare internal escalation and unsent external draft; CRM changes must use governed Salesforce tools.", ["mitigate"])] },
    defaultNextAction: "Validate the risk signal and assign the mitigation owner.",
  },
  {
    workflowId: "renewal_planning",
    name: "Renewal planning",
    description: "Build a time-bound renewal plan from value, stakeholder, risk, and commercial evidence.",
    inputFields: [...COMMON_FIELDS, field("renewalAt", "Renewal date", "timestamp", true), field("renewalGoals", "Renewal goals", "text_list", true), field("amountMinor", "Renewal amount", "money", false), field("currency", "Currency", "enum", false)],
    acceptanceCriteria: ["Renewal position separates observed evidence, operator judgment, and unknowns.", "The plan has milestones, owner, next action, and governed commitment boundaries."],
    artifacts: [artifact("renewal_brief", "Renewal brief", "Value, stakeholder, risk, timeline, and commercial evidence."), artifact("renewal_plan", "Renewal plan", "Owned milestones, negotiation dependencies, and next action.")],
    evidenceRequirements: [ACCOUNT_EVIDENCE, evidence("renewal_evidence", "Renewal evidence", "Exact renewal, opportunity, health, and stakeholder sources.", ["account_fact", "customer_health", "crm_revision", "operator_confirmation"])],
    projectTemplate: { title: "Renewal planning", objective: "Create an evidence-backed, governed renewal plan.", status: "active", tasks: [task("position", "Assess renewal position", "Create renewal_brief from exact facts and explicit unknowns."), task("plan", "Build renewal milestones", "Create renewal_plan with owners, timing, and decision gates.", ["position"]), task("commitments", "Prepare governed commitments", "Commercial promises stay proposals; CRM changes and delivery require governed tools.", ["plan"])] },
    defaultNextAction: "Confirm the renewal timeline and evidence gaps.",
  },
  {
    workflowId: "qbr_ebr",
    name: "QBR / EBR",
    description: "Prepare a cited business review that connects outcomes, adoption, risk, and next-quarter commitments.",
    inputFields: [...COMMON_FIELDS, field("reviewKind", "Review kind", "enum", true, ["qbr", "ebr"]), field("meetingAt", "Meeting time", "timestamp", true), field("periodStartAt", "Period start", "timestamp", true), field("periodEndAt", "Period end", "timestamp", true), field("audience", "Audience", "text_list", true), field("agendaObjectives", "Agenda objectives", "text_list", true)],
    acceptanceCriteria: ["Every business-result claim is cited or clearly labeled as an operator assertion.", "The review closes with owned next actions and no unapproved external commitment."],
    artifacts: [artifact("business_review_brief", "Business review brief", "Audience, agenda, narrative, evidence, and open questions."), artifact("business_review_deck", "Business review deck", "Outcome, adoption, risk, roadmap, and next-action narrative."), artifact("follow_up_draft", "Follow-up draft", "Unsent governed summary and proposed actions.")],
    evidenceRequirements: [ACCOUNT_EVIDENCE, evidence("period_outcomes", "Period outcomes", "Cited outcome, adoption, project, support, and meeting evidence.", ["account_fact", "customer_health", "meeting", "project_artifact", "support_case"])],
    projectTemplate: { title: "Customer business review", objective: "Prepare and close an evidence-backed business review.", status: "active", tasks: [task("brief", "Resolve review evidence", "Create business_review_brief with citations and explicit gaps."), task("deck", "Build the business review", "Create business_review_deck for the declared audience.", ["brief"]), task("followup", "Prepare review follow-up", "Create follow_up_draft; do not deliver or update CRM outside governed tools.", ["deck"])] },
    defaultNextAction: "Resolve the review-period evidence and audience decisions.",
  },
  {
    workflowId: "meeting_prep_follow_up",
    name: "Meeting prep / follow-up",
    description: "Prepare or close a customer meeting from the exact meeting revision and Account 360 evidence.",
    inputFields: [...COMMON_FIELDS, field("meetingId", "Meeting", "id", true), field("phase", "Phase", "enum", true, ["prep", "follow_up"]), field("participantIds", "Participants", "id_list", true), field("meetingObjectives", "Meeting objectives", "text_list", true)],
    acceptanceCriteria: ["The artifact cites the exact meeting and relevant Account 360 evidence.", "Decisions and proposed commitments retain owners, evidence, and confirmation state."],
    artifacts: [artifact("meeting_brief", "Meeting brief", "Participants, context, objectives, questions, and risks."), artifact("meeting_follow_up", "Meeting follow-up", "Decisions, proposed commitments, owners, and unsent communication draft.", false)],
    evidenceRequirements: [ACCOUNT_EVIDENCE, evidence("meeting_revision", "Meeting revision", "Exact governed meeting revision and cited processed-media evidence when available.", ["meeting"])],
    projectTemplate: { title: "Customer meeting workflow", objective: "Prepare or close a governed customer meeting.", status: "active", tasks: [task("context", "Resolve meeting context", "Read the exact meeting revision, participants, and Account 360 evidence."), task("artifact", "Create the meeting artifact", "Create meeting_brief for prep or meeting_follow_up for follow-up.", ["context"]), task("actions", "Route proposed actions", "Use meeting commitment confirmation for work and governed communication for any delivery.", ["artifact"])] },
    defaultNextAction: "Resolve the exact meeting revision and participant context.",
  },
  {
    workflowId: "support_escalation",
    name: "Support escalation",
    description: "Coordinate customer-impacting support work without making unsupported recovery commitments.",
    inputFields: [...COMMON_FIELDS, field("caseIds", "Support cases", "id_list", true), field("severity", "Severity", "enum", true, ["medium", "high", "critical"]), field("customerImpact", "Customer impact", "text", true), field("requestedOutcome", "Requested outcome", "text", true)],
    acceptanceCriteria: ["Impact and case status cite exact sources and distinguish facts from estimates.", "The recovery plan has technical owner, customer owner, update cadence, and exit criteria."],
    artifacts: [artifact("escalation_brief", "Support escalation brief", "Cases, impact, timeline, knowns, unknowns, and ownership."), artifact("recovery_plan", "Recovery plan", "Containment, resolution, communication cadence, and exit criteria.")],
    evidenceRequirements: [ACCOUNT_EVIDENCE, evidence("case_evidence", "Support case evidence", "Exact support-case revisions and operator-confirmed customer impact.", ["support_case", "account_fact", "operator_confirmation"])],
    projectTemplate: { title: "Customer support escalation", objective: "Coordinate an evidence-backed support recovery.", status: "active", tasks: [task("triage", "Triage cases and impact", "Create escalation_brief from exact case evidence."), task("recovery", "Build recovery plan", "Create recovery_plan with owners, cadence, and exit criteria.", ["triage"]), task("updates", "Prepare governed updates", "Customer updates remain drafts until governed delivery; CRM case changes use governed writes.", ["recovery"])] },
    defaultNextAction: "Confirm case revisions, impact, and escalation ownership.",
  },
  {
    workflowId: "expansion_discovery",
    name: "Expansion discovery",
    description: "Test expansion hypotheses against customer outcomes and evidence before proposing opportunity changes.",
    inputFields: [...COMMON_FIELDS, field("hypotheses", "Expansion hypotheses", "text_list", true), field("stakeholderIds", "Stakeholders", "id_list", true), field("discoveryWindowEndAt", "Discovery window end", "timestamp", true)],
    acceptanceCriteria: ["Each hypothesis is supported, rejected, or left unknown with cited evidence.", "Any commercial next step remains a proposal until governed approval and CRM write."],
    artifacts: [artifact("expansion_hypothesis_map", "Expansion hypothesis map", "Outcome, stakeholder, evidence, confidence, and disconfirming signals."), artifact("discovery_plan", "Expansion discovery plan", "Questions, owners, checkpoints, and decision criteria.")],
    evidenceRequirements: [ACCOUNT_EVIDENCE, evidence("expansion_evidence", "Expansion evidence", "Exact product, usage, stakeholder, project, and opportunity sources.", ["account_fact", "project_artifact", "crm_revision", "operator_confirmation"])],
    projectTemplate: { title: "Expansion discovery", objective: "Test evidence-backed customer expansion hypotheses.", status: "active", tasks: [task("map", "Map hypotheses to evidence", "Create expansion_hypothesis_map and include disconfirming evidence."), task("discover", "Build discovery plan", "Create discovery_plan with owners and decision criteria.", ["map"]), task("proposal", "Prepare governed commercial proposal", "Do not create or update an opportunity except through an approved governed Salesforce write.", ["discover"])] },
    defaultNextAction: "Map the first expansion hypothesis to current customer evidence.",
  },
];

export const CUSTOMER_SUCCESS_WORKFLOW_PACK = Object.freeze(
  DEFINITION_INPUTS.map(buildDefinition),
);

export function getCustomerSuccessWorkflowDefinition(workflowId: CustomerSuccessWorkflowId) {
  const definition = CUSTOMER_SUCCESS_WORKFLOW_PACK.find((item) => item.workflowId === workflowId);
  if (!definition) throw new Error("Customer-success workflow definition is unavailable.");
  return definition;
}

export function customerSuccessRunId(input: {
  tenantId: string;
  workspaceId: string;
  accountId: string;
  idempotencyKey: string;
}) {
  return `customer-success-run:${canonicalJsonSha256(input)}`;
}

export function customerSuccessProjectTaskIdempotencyKey(runId: string, taskKey: string) {
  return `customer-success-task:${createHash("sha256")
    .update(`${runId}:${taskKey}`, "utf8")
    .digest("hex")}`;
}

export function buildCustomerSuccessOutcomeReceipt(
  input: z.input<typeof outcomeReceiptBodySchema>,
): CustomerSuccessOutcomeReceipt {
  const body = outcomeReceiptBodySchema.parse(input);
  return deepFreeze(customerSuccessOutcomeReceiptSchema.parse({
    ...body,
    receiptSha256: canonicalJsonSha256(body),
  }));
}

export function buildCustomerSuccessWorkflowRunRevision(
  input: Omit<z.input<typeof workflowRunRevisionBodySchema>,
    "schemaVersion" | "contractVersion" | "runRevisionId" |
    "previousRunRevisionId" | "inputSha256">,
): CustomerSuccessWorkflowRunRevision {
  const parsedInput = customerSuccessWorkflowInputSchema.parse(input.input);
  const body = workflowRunRevisionBodySchema.parse({
    ...input,
    schemaVersion: 1,
    contractVersion: CUSTOMER_SUCCESS_WORKFLOW_CONTRACT_VERSION,
    runRevisionId: `${input.runId}:v${input.revision}`,
    previousRunRevisionId: input.revision === 1 ? null : `${input.runId}:v${input.revision - 1}`,
    input: parsedInput,
    inputSha256: canonicalJsonSha256(parsedInput),
  });
  return deepFreeze(customerSuccessWorkflowRunRevisionSchema.parse({
    ...body,
    runSha256: canonicalJsonSha256(body),
  }));
}

export function validateCompletedWorkflowArtifacts(input: {
  definition: CustomerSuccessWorkflowDefinition;
  outcome: CustomerSuccessOutcomeReceipt;
}) {
  if (input.outcome.status !== "completed") return;
  const artifactKeys = new Set(input.outcome.artifactReceipts.map((item) => item.artifactKey));
  const evidenceKeys = new Set(input.outcome.artifactReceipts.flatMap((item) => item.evidenceKeys));
  for (const requirement of input.definition.artifacts) {
    if (requirement.required && !artifactKeys.has(requirement.artifactKey)) {
      throw new Error(`Completed workflow is missing required artifact: ${requirement.artifactKey}.`);
    }
  }
  for (const requirement of input.definition.evidenceRequirements) {
    if (requirement.required && !evidenceKeys.has(requirement.evidenceKey)) {
      throw new Error(`Completed workflow is missing required evidence: ${requirement.evidenceKey}.`);
    }
  }
}

function buildDefinition(input: DefinitionInput): CustomerSuccessWorkflowDefinition {
  const body = customerSuccessWorkflowDefinitionBodySchema.parse({
    ...input,
    schemaVersion: 1,
    contractVersion: CUSTOMER_SUCCESS_WORKFLOW_CONTRACT_VERSION,
    packVersion: CUSTOMER_SUCCESS_PACK_VERSION,
    externalActionPolicy: {
      communicationMode: "draft_only_until_governed_delivery",
      crmMode: "proposal_only_until_governed_write",
      allowedCommunicationToolIds: ["app.communications.drafts.create"],
      allowedCrmToolIdPrefixes: ["app.customer_accounts.salesforce."],
      directExternalEffectsAllowed: false,
    },
  });
  return deepFreeze(customerSuccessWorkflowDefinitionSchema.parse({
    ...body,
    definitionSha256: canonicalJsonSha256(body),
  }));
}

function assertUnique(values: readonly string[], context: z.RefinementCtx, path: string) {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path: [path], message: `${path} must be unique.` });
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

export type CustomerSuccessProjectTemplate = WorkspaceTemplateProject;
