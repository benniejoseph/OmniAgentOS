import { z } from "zod";

export const PROJECT_OBJECTIVE_LIMIT = 2_000;
export const WORK_ITEM_DETAIL_LIMIT = 1_000;

const operationSchema = z.enum([
  "app.projects.create",
  "app.projects.update",
  "app.work_items.create",
  "app.work_items.update",
]);
type ProjectMutationOperation = z.infer<typeof operationSchema>;

const preservationGuidance = "Shorten wording while preserving material acceptance criteria, owners, dates, dependencies, and unresolved conditions.";
const nextStep = `${preservationGuidance} Do not silently truncate or drop commitments. Submit the corrected input as a new tool call with a new idempotency identity, then read back the saved fields. If the material content cannot fit, explain the unresolved constraint instead of claiming it was saved.`;

const lengthRecoverySchema = z.object({
  version: z.literal(1),
  kind: z.literal("text_length"),
  operation: operationSchema,
  field: z.enum(["objective", "detail"]),
  actual: z.number().int().nonnegative(),
  limit: z.union([z.literal(PROJECT_OBJECTIVE_LIMIT), z.literal(WORK_ITEM_DETAIL_LIMIT)]),
  overBy: z.number().int().positive(),
  suggestedMax: z.union([z.literal(1_800), z.literal(900)]),
  normalization: z.literal("trim"),
  unit: z.literal("utf16_code_units"),
  mutationApplied: z.literal(false),
  retry: z.literal("revise_input"),
  nextStep: z.literal(nextStep),
}).strict().superRefine((value, context) => {
  const objective = value.operation.startsWith("app.projects.");
  if (value.field !== (objective ? "objective" : "detail") ||
      value.limit !== (objective ? PROJECT_OBJECTIVE_LIMIT : WORK_ITEM_DETAIL_LIMIT) ||
      value.suggestedMax !== (objective ? 1_800 : 900) ||
      value.actual - value.limit !== value.overBy) {
    context.addIssue({ code: "custom", message: "Project length recovery does not match its operation and limit." });
  }
});

export type ProjectMutationLengthRecovery = z.infer<typeof lengthRecoverySchema>;

/** Only service validation before a write may produce this recovery receipt. */
export class ProjectMutationValidationError extends Error {
  readonly recovery: ProjectMutationLengthRecovery;

  constructor(validation: z.ZodError, recovery: ProjectMutationLengthRecovery) {
    super(validation.message, { cause: validation });
    this.name = "ProjectMutationValidationError";
    this.recovery = recovery;
  }
}

export function projectTextLengthMessage(field: "objective" | "detail", actual?: number) {
  const objective = field === "objective";
  const label = objective ? "Project objective" : "Work-item detail";
  const limit = objective ? PROJECT_OBJECTIVE_LIMIT : WORK_ITEM_DETAIL_LIMIT;
  const suggestedMax = objective ? 1_800 : 900;
  const length = actual === undefined
    ? `${label} exceeds the ${limit}-character limit.`
    : `${label} has ${actual} characters after trimming; limit ${limit} (${actual - limit} over).`;
  return `${length} Aim for ${suggestedMax} or fewer. ${preservationGuidance}`;
}

/** Validate the entire patch before deriving a narrow, content-free recovery. */
export function parseProjectMutationInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  operation: ProjectMutationOperation,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;

  const objective = operation.startsWith("app.projects.");
  const field = objective ? "objective" : "detail";
  const limit = objective ? PROJECT_OBJECTIVE_LIMIT : WORK_ITEM_DETAIL_LIMIT;
  const [issue] = parsed.error.issues;
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)[field] : undefined;
  // A length correction alone is insufficient for an otherwise invalid patch.
  // Do not label unrelated validation, authorization or storage failures as a
  // safe-to-revise no-write outcome.
  if (parsed.error.issues.length === 1 && issue.code === "too_big" &&
      issue.origin === "string" && issue.maximum === limit && issue.inclusive === true &&
      issue.path.length === 1 && issue.path[0] === field && typeof value === "string") {
    const actual = value.trim().length;
    if (actual > limit) {
      throw new ProjectMutationValidationError(parsed.error, {
        version: 1, kind: "text_length", operation, field, actual, limit,
        overBy: actual - limit, suggestedMax: objective ? 1_800 : 900,
        normalization: "trim", unit: "utf16_code_units", mutationApplied: false,
        retry: "revise_input", nextStep,
      });
    }
  }
  throw parsed.error;
}

export function projectMutationLengthRecovery(error: unknown) {
  return error instanceof ProjectMutationValidationError ? error.recovery : undefined;
}

/** Decode persisted metadata only; never interpret arbitrary tool prose as recovery. */
export function readProjectMutationLengthRecovery(value: unknown, operation: string) {
  const parsed = lengthRecoverySchema.safeParse(value);
  return parsed.success && parsed.data.operation === operation ? parsed.data : undefined;
}
