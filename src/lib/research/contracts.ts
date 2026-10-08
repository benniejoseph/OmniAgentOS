import { z } from "zod";

/** Public research preferences narrow the run; they never grant tool authority. */
export const researchOptionsSchema = z.object({
  depth: z.enum(["quick", "deep"]).default("quick"),
  questions: z.array(z.string().trim().min(1).max(500)).max(6).default([]),
  sourceGuidance: z.string().trim().max(1_500).default(""),
  allowedDomains: z.array(z.string().trim().toLowerCase().max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)).max(10).default([]),
}).strict().refine((value) => value.depth !== "quick" || value.questions.length <= 3, {
  message: "Quick research supports up to three focus questions. Choose Deep for more.", path: ["questions"],
});

export type ResearchOptions = z.infer<typeof researchOptionsSchema>;

export const RESEARCH_WORKFLOW_METADATA_KEY = "researchOptionsV1";

export const RESEARCH_DEPTH_LIMITS = {
  quick: { searches: 4, reads: 8, questions: 3, gapRounds: 1, evidenceChars: 48_000, reportWords: "1,200–2,000" },
  deep: { searches: 10, reads: 18, questions: 6, gapRounds: 2, evidenceChars: 72_000, reportWords: "1,800–3,000" },
} as const;

export const researchProgressSchema = z.object({
  schemaVersion: z.literal(1),
  depth: z.enum(["quick", "deep"]),
  stage: z.enum(["planning", "searching", "reading", "reviewing", "writing", "complete"]),
  questions: z.array(z.string().max(500)).max(6),
  searches: z.number().int().min(0).max(10),
  sourcesRead: z.number().int().min(0).max(18),
  gaps: z.array(z.string().max(2_000)).max(32),
  limitations: z.array(z.string().max(2_000)).max(32),
  reportStatus: z.enum(["ready", "partial"]).optional(),
}).strict();

export type ResearchProgress = z.infer<typeof researchProgressSchema>;
