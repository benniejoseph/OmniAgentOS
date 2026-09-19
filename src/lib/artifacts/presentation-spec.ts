import { createHash } from "node:crypto";
import { z } from "zod";

const invalidXmlControlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;

function singleLine(label: string, maxLength: number) {
  return z.string()
    .trim()
    .min(1, `${label} is required.`)
    .max(maxLength, `${label} must be ${maxLength} characters or fewer.`)
    .refine((value) => !/[\r\n]/u.test(value), `${label} must be a single line.`)
    .refine(
      (value) => !invalidXmlControlCharacters.test(value),
      `${label} contains unsupported control characters.`,
    );
}

function multiLine(label: string, maxLength: number, maxLines: number) {
  return z.string()
    .trim()
    .min(1, `${label} is required.`)
    .max(maxLength, `${label} must be ${maxLength} characters or fewer.`)
    .refine(
      (value) => !invalidXmlControlCharacters.test(value),
      `${label} contains unsupported control characters.`,
    )
    .refine(
      (value) => value.split(/\r?\n/u).length <= maxLines,
      `${label} must use ${maxLines} lines or fewer.`,
    );
}

const speakerNotesSchema = multiLine("Speaker notes", 2_000, 40).optional();
const slideTitleSchema = singleLine("Slide title", 90);
const slideSubtitleSchema = multiLine("Slide subtitle", 260, 4).optional();
const bulletSchema = multiLine("Bullet", 120, 2);

const titleSlideSchema = z.object({
  kind: z.literal("title"),
  title: singleLine("Title-slide title", 100),
  subtitle: multiLine("Title-slide subtitle", 240, 4).optional(),
  eyebrow: singleLine("Title-slide eyebrow", 64).optional(),
  speakerNotes: speakerNotesSchema,
}).strict();

const sectionSlideSchema = z.object({
  kind: z.literal("section"),
  title: slideTitleSchema,
  subtitle: slideSubtitleSchema,
  speakerNotes: speakerNotesSchema,
}).strict();

const contentSlideSchema = z.object({
  kind: z.literal("content"),
  title: slideTitleSchema,
  kicker: singleLine("Content kicker", 64).optional(),
  body: multiLine("Content body", 420, 8).optional(),
  bullets: z.array(bulletSchema).min(1).max(5).optional(),
  speakerNotes: speakerNotesSchema,
}).strict();

const columnSchema = z.object({
  heading: singleLine("Column heading", 64),
  body: multiLine("Column body", 260, 6).optional(),
  bullets: z.array(bulletSchema.max(110)).min(1).max(4).optional(),
}).strict();

const twoColumnSlideSchema = z.object({
  kind: z.literal("two_column"),
  title: slideTitleSchema,
  subtitle: slideSubtitleSchema,
  left: columnSchema,
  right: columnSchema,
  speakerNotes: speakerNotesSchema,
}).strict();

const quoteSlideSchema = z.object({
  kind: z.literal("quote"),
  title: slideTitleSchema,
  quote: multiLine("Quote", 360, 8),
  attribution: singleLine("Quote attribution", 100),
  role: singleLine("Quote role", 100).optional(),
  speakerNotes: speakerNotesSchema,
}).strict();

const metricSchema = z.object({
  value: singleLine("Metric value", 24),
  label: singleLine("Metric label", 56),
  detail: multiLine("Metric detail", 120, 3).optional(),
}).strict();

const metricsSlideSchema = z.object({
  kind: z.literal("metrics"),
  title: slideTitleSchema,
  subtitle: slideSubtitleSchema,
  metrics: z.array(metricSchema).min(2).max(4),
  speakerNotes: speakerNotesSchema,
}).strict();

const closingSlideSchema = z.object({
  kind: z.literal("closing"),
  title: singleLine("Closing title", 90),
  subtitle: multiLine("Closing subtitle", 260, 4).optional(),
  callToAction: singleLine("Closing call to action", 120).optional(),
  contact: singleLine("Closing contact", 120).optional(),
  speakerNotes: speakerNotesSchema,
}).strict();

export const presentationSlideSchema = z.discriminatedUnion("kind", [
  titleSlideSchema,
  sectionSlideSchema,
  contentSlideSchema,
  twoColumnSlideSchema,
  quoteSlideSchema,
  metricsSlideSchema,
  closingSlideSchema,
]);

export const presentationBlueprintSchema = z.object({
  title: singleLine("Presentation title", 120),
  subtitle: multiLine("Presentation subtitle", 280, 4).optional(),
  theme: z.enum(["light", "dark", "aurora"]),
  slides: z.array(presentationSlideSchema).min(2).max(24),
}).strict().superRefine((blueprint, context) => {
  for (const [index, slide] of blueprint.slides.entries()) {
    if (slide.kind === "content") {
      if (!slide.body && !slide.bullets?.length) {
        context.addIssue({
          code: "custom",
          message: "A content slide requires a body or at least one bullet.",
          path: ["slides", index],
        });
      }
      const visibleCharacters = (slide.body?.length || 0)
        + (slide.bullets || []).reduce((sum, bullet) => sum + bullet.length, 0);
      if (visibleCharacters > 700) {
        context.addIssue({
          code: "custom",
          message: "Content exceeds the safe visible-text budget for one slide.",
          path: ["slides", index],
        });
      }
    }

    if (slide.kind === "two_column") {
      for (const side of ["left", "right"] as const) {
        const column = slide[side];
        if (!column.body && !column.bullets?.length) {
          context.addIssue({
            code: "custom",
            message: "Each column requires a body or at least one bullet.",
            path: ["slides", index, side],
          });
        }
        const visibleCharacters = (column.body?.length || 0)
          + (column.bullets || []).reduce((sum, bullet) => sum + bullet.length, 0);
        if (visibleCharacters > 430) {
          context.addIssue({
            code: "custom",
            message: "Column content exceeds the safe visible-text budget.",
            path: ["slides", index, side],
          });
        }
      }
    }
  }
});

export type PresentationBlueprint = z.infer<typeof presentationBlueprintSchema>;
export type PresentationSlide = z.infer<typeof presentationSlideSchema>;
export type PresentationSlideKind = PresentationSlide["kind"];
export type PresentationTheme = PresentationBlueprint["theme"];

export function parsePresentationBlueprint(input: unknown): PresentationBlueprint {
  return presentationBlueprintSchema.parse(input);
}

export function presentationSpecDigest(input: unknown): string {
  const blueprint = parsePresentationBlueprint(input);
  return createHash("sha256")
    .update(canonicalJson(blueprint), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}
