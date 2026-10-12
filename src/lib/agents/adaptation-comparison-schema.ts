import { z } from "zod";

export const ADAPTATION_COMPARISON_VERSION = "agent-text-comparison:1" as const;
export const ADAPTATION_SCORER_VERSION = "literal-output-assertions:1" as const;
export const ADAPTATION_COMPARISON_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const phrases = z.array(z.string().trim().min(1).max(120)).max(5);
export const adaptationComparisonSuiteSchema = z.object({
  cases: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    task: z.string().trim().min(10).max(2_000),
    assertions: z.object({
      allOf: phrases,
      noneOf: phrases,
      minLength: z.number().int().min(1).max(8_000),
      maxLength: z.number().int().min(1).max(8_000),
    }).strict().refine((value) => value.maxLength >= value.minLength, "Maximum length must be at least minimum length."),
  }).strict()).min(3).max(10),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.cases.map((item) => item.id)).size !== value.cases.length ||
      new Set(value.cases.map((item) => item.task.toLowerCase().replace(/\s+/g, " "))).size !== value.cases.length) {
    ctx.addIssue({ code: "custom", message: "Provide 3–10 different tasks with unique IDs." });
  }
  for (const item of value.cases) {
    if (item.assertions.allOf.some((phrase) => item.assertions.noneOf.some((excluded) => phrase.toLowerCase().includes(excluded.toLowerCase())))) {
      ctx.addIssue({ code: "custom", message: "A required phrase contains a forbidden phrase." });
    }
  }
});
export const adaptationComparisonPinsSchema = z.object({
  definitionVersion: z.number().int().positive(),
  definitionSha256: digest,
  principalSha256: digest,
  baselineGuidanceSha256: digest,
  candidateEffectSha256: digest,
  promptContractVersion: z.string().min(1).max(100),
  baselineInstructionsSha256: digest,
  candidateInstructionsSha256: digest,
  runtime: z.object({
    provider: z.enum(["openai", "google", "anthropic", "aws_bedrock"]),
    model: z.string().min(1).max(240),
    tier: z.enum(["fast", "reasoning"]),
    source: z.enum(["tenant_assignment", "deployment_environment"]),
    assignmentId: z.string().nullable(),
    assignmentRevision: z.number().int().positive().nullable(),
    assignmentConfigurationSha256: digest.nullable(),
  }).strict(),
  clock: timestamp,
  mode: z.literal("orchestrate"),
  environment: z.literal("text_only_no_tools_memory_or_retrieval"),
  maxOutputTokens: z.literal(1_000),
  maxCalls: z.number().int().min(6).max(20),
  timeoutMs: z.literal(120_000),
}).strict();
export const observationSchema = z.object({
  status: z.enum(["completed", "failed", "not_run"]),
  output: z.string().max(8_000).nullable(),
  costUsd: z.number().finite().min(0).nullable(),
  failure: z.enum(["model_failed", "route_changed", "empty_or_oversized_output", "cancelled", "stale_configuration"]).nullable(),
}).strict().refine((value) => value.status === "completed" ? value.output !== null && value.output.length > 0 && value.failure === null : value.output === null, "Observation status must match its output.");
export const adaptationComparisonSchema = z.object({
  version: z.literal(ADAPTATION_COMPARISON_VERSION),
  scorerVersion: z.literal(ADAPTATION_SCORER_VERSION),
  comparisonId: z.string().uuid(),
  adaptationId: z.string().regex(/^agent-adaptation:[a-f0-9]{64}$/),
  suite: adaptationComparisonSuiteSchema,
  suiteSha256: digest,
  pins: adaptationComparisonPinsSchema,
  results: z.array(z.object({
    caseId: z.string(),
    baseline: observationSchema,
    candidate: observationSchema,
    baselinePassed: z.boolean(),
    candidatePassed: z.boolean(),
  }).strict()).min(3).max(10),
  verdict: z.enum(["improved", "no_change", "regressed", "incomplete"]),
  baselinePassed: z.number().int().min(0).max(10),
  candidatePassed: z.number().int().min(0).max(10),
  costUsd: z.number().finite().min(0).nullable(),
  completedAt: timestamp,
  comparisonSha256: digest,
}).strict();
export type AdaptationComparisonSuite = z.infer<typeof adaptationComparisonSuiteSchema>;
export type AdaptationComparisonPins = z.infer<typeof adaptationComparisonPinsSchema>;
export type AdaptationComparisonObservation = z.infer<typeof observationSchema>;
export type AdaptationComparison = z.infer<typeof adaptationComparisonSchema>;

/** Literal, case-insensitive phrase checks and Unicode code point lengths. No model judges. */
export function scoreAdaptationOutput(task: AdaptationComparisonSuite["cases"][number], observation: AdaptationComparisonObservation) {
  if (observation.status !== "completed" || !observation.output) return false;
  const text = observation.output.toLowerCase();
  const length = Array.from(observation.output).length;
  return task.assertions.allOf.every((phrase) => text.includes(phrase.toLowerCase())) &&
    task.assertions.noneOf.every((phrase) => !text.includes(phrase.toLowerCase())) &&
    length >= task.assertions.minLength && length <= task.assertions.maxLength;
}
