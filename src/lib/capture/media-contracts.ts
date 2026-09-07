import { createHash } from "node:crypto";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const recordingIdSchema = z.string().trim().min(1).max(200);
const meetingIdSchema = z.string().regex(/^meeting:[0-9a-f-]{36}$/);
const languageTagSchema = z.string().trim().min(2).max(35).regex(
  /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/,
);

export const captureRawAudioRetentionSchema = z.object({
  mode: z.enum(["retain", "delete_after_processing"]),
  retainUntil: z.string().datetime({ offset: true }).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "delete_after_processing" && value.retainUntil) {
    context.addIssue({
      code: "custom",
      message: "Immediate deletion cannot also declare a retention deadline.",
      path: ["retainUntil"],
    });
  }
});

export const captureSpeakerMappingSchema = z.object({
  speakerLabel: z.string().trim().min(1).max(80),
  participantId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(160),
  confirmation: z.literal("user_confirmed"),
}).strict();

export const captureMediaProcessingRequestSchema = z.object({
  schemaVersion: z.literal(1),
  recordingId: recordingIdSchema,
  meetingId: meetingIdSchema.optional(),
  languageHints: z.array(languageTagSchema).max(12).default([]),
  speakerMappings: z.array(captureSpeakerMappingSchema).max(40).default([]),
  rawAudioRetention: captureRawAudioRetentionSchema,
}).strict().superRefine((value, context) => {
  const labels = new Set<string>();
  const participants = new Set<string>();
  for (const [index, mapping] of value.speakerMappings.entries()) {
    const label = mapping.speakerLabel.toLocaleLowerCase("en-US");
    if (labels.has(label)) {
      context.addIssue({
        code: "custom",
        message: "Each diarized speaker label may be mapped once.",
        path: ["speakerMappings", index, "speakerLabel"],
      });
    }
    labels.add(label);
    if (participants.has(mapping.participantId)) {
      context.addIssue({
        code: "custom",
        message: "Each participant may be mapped to one speaker label.",
        path: ["speakerMappings", index, "participantId"],
      });
    }
    participants.add(mapping.participantId);
  }
});

export const captureMediaSpeakerSchema = z.object({
  label: z.string().trim().min(1).max(80),
  identity: z.enum(["known", "diarized", "unknown"]),
  participantId: z.string().trim().min(1).max(200).optional(),
  displayName: z.string().trim().min(1).max(160).optional(),
}).strict().superRefine((value, context) => {
  if (value.identity === "known" && (!value.participantId || !value.displayName)) {
    context.addIssue({
      code: "custom",
      message: "Known speakers require a participant and display name.",
    });
  }
  if (value.identity !== "known" && (value.participantId || value.displayName)) {
    context.addIssue({
      code: "custom",
      message: "Unconfirmed speaker identities cannot name a participant.",
    });
  }
});

export const captureMediaTurnSchema = z.object({
  turnId: z.string().regex(/^media-turn:[a-f0-9]{64}$/),
  segmentId: z.string().trim().min(1).max(200),
  segmentIndex: z.number().int().min(0).max(1_439),
  sourceAudioSha256: sha256Schema,
  startMilliseconds: z.number().int().min(0).max(86_400_000),
  endMilliseconds: z.number().int().min(1).max(86_400_000),
  languageTag: languageTagSchema,
  speaker: captureMediaSpeakerSchema,
  text: z.string().trim().min(1).max(24_000),
}).strict().refine(
  (value) => value.endMilliseconds > value.startMilliseconds,
  { message: "A transcript turn must have a positive duration." },
);

export const captureSegmentMediaTurnSchema = z.object({
  startMilliseconds: z.number().int().min(0).max(600_000),
  endMilliseconds: z.number().int().min(1).max(600_000),
  languageTag: languageTagSchema,
  speaker: captureMediaSpeakerSchema,
  text: z.string().trim().min(1).max(24_000),
}).strict().refine(
  (value) => value.endMilliseconds > value.startMilliseconds,
  { message: "A segment transcript turn must have a positive duration." },
);

export const captureSegmentMediaTranscriptSchema = z.object({
  schemaVersion: z.literal(1),
  recordingId: recordingIdSchema,
  segmentId: z.string().trim().min(1).max(200),
  segmentIndex: z.number().int().min(0).max(1_439),
  sourceAudioSha256: sha256Schema,
  transcriptSha256: sha256Schema,
  model: z.string().trim().min(1).max(160),
  languageTags: z.array(languageTagSchema).min(1).max(24),
  turns: z.array(captureSegmentMediaTurnSchema).min(1).max(2_000),
  transcribedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  const languages = [...new Set(value.turns.map((turn) => turn.languageTag))]
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(languages) !== JSON.stringify(value.languageTags)) {
    context.addIssue({
      code: "custom",
      message: "Segment languages must exactly summarize its timestamped turns.",
      path: ["languageTags"],
    });
  }
  if (sha256Json(value.turns.map((turn) => turn.text).join("\n")) !== value.transcriptSha256) {
    context.addIssue({
      code: "custom",
      message: "Segment transcript digest does not match its turns.",
      path: ["transcriptSha256"],
    });
  }
});

export const captureMediaCitationSchema = z.object({
  turnId: z.string().regex(/^media-turn:[a-f0-9]{64}$/),
  segmentIndex: z.number().int().min(0).max(1_439),
  startMilliseconds: z.number().int().min(0).max(86_400_000),
  endMilliseconds: z.number().int().min(1).max(86_400_000),
  speakerLabel: z.string().trim().min(1).max(80),
  speakerParticipantId: z.string().trim().min(1).max(200).optional(),
}).strict();

const citedTextSchema = z.object({
  text: z.string().trim().min(1).max(12_000),
  citations: z.array(captureMediaCitationSchema).min(1).max(24),
}).strict();

export const captureMediaChapterSchema = citedTextSchema.extend({
  chapterId: z.string().regex(/^media-chapter:[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(180),
  startMilliseconds: z.number().int().min(0).max(86_400_000),
  endMilliseconds: z.number().int().min(1).max(86_400_000),
}).strict().refine(
  (value) => value.endMilliseconds > value.startMilliseconds,
  { message: "A chapter must have a positive duration." },
);

export const captureMediaActionItemSchema = citedTextSchema.extend({
  actionItemId: z.string().regex(/^media-action:[a-f0-9]{64}$/),
  ownerParticipantId: z.string().trim().min(1).max(200).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  ownershipEvidence: z.enum(["explicit", "unconfirmed"]),
  dueDateEvidence: z.enum(["explicit", "unconfirmed"]),
}).strict().superRefine((value, context) => {
  if (value.ownerParticipantId && value.ownershipEvidence !== "explicit") {
    context.addIssue({
      code: "custom",
      message: "An owner requires explicit transcript evidence.",
      path: ["ownershipEvidence"],
    });
  }
  if (value.dueAt && value.dueDateEvidence !== "explicit") {
    context.addIssue({
      code: "custom",
      message: "A due date requires explicit transcript evidence.",
      path: ["dueDateEvidence"],
    });
  }
});

export const captureMediaDecisionSchema = citedTextSchema.extend({
  decisionId: z.string().regex(/^media-decision:[a-f0-9]{64}$/),
}).strict();

export const captureMediaOutputSchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: z.string().trim().min(1).max(120),
  ownerActorId: z.string().trim().min(1).max(320),
  recordingId: recordingIdSchema,
  meetingId: meetingIdSchema.optional(),
  mediaRevision: z.number().int().min(1),
  mediaRevisionId: z.string().trim().min(1).max(260),
  sourceAudioManifestSha256: sha256Schema,
  outputSha256: sha256Schema,
  transcriptionModel: z.string().trim().min(1).max(160),
  extractionModel: z.string().trim().min(1).max(160),
  languageTags: z.array(languageTagSchema).min(1).max(24),
  turns: z.array(captureMediaTurnSchema).min(1).max(50_000),
  chapters: z.array(captureMediaChapterSchema).max(240),
  summary: citedTextSchema,
  actionItems: z.array(captureMediaActionItemSchema).max(500),
  decisions: z.array(captureMediaDecisionSchema).max(500),
  warnings: z.array(z.string().trim().min(1).max(240)).max(100),
  rawAudioRetention: captureRawAudioRetentionSchema,
  processedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.mediaRevisionId !== `${value.recordingId}:media:v${value.mediaRevision}`) {
    context.addIssue({
      code: "custom",
      message: "Media revision identifier does not match its recording and revision.",
      path: ["mediaRevisionId"],
    });
  }
  const expectedLanguages = [...new Set(value.turns.map((turn) => turn.languageTag))]
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(value.languageTags) !== JSON.stringify(expectedLanguages)) {
    context.addIssue({
      code: "custom",
      message: "Output languages must exactly summarize the timestamped turns.",
      path: ["languageTags"],
    });
  }
  const turns = new Map(value.turns.map((turn) => [turn.turnId, turn]));
  for (const citation of allOutputCitations(value)) {
    const turn = turns.get(citation.turnId);
    if (
      !turn ||
      citation.segmentIndex !== turn.segmentIndex ||
      citation.startMilliseconds !== turn.startMilliseconds ||
      citation.endMilliseconds !== turn.endMilliseconds ||
      citation.speakerLabel !== turn.speaker.label ||
      citation.speakerParticipantId !== turn.speaker.participantId
    ) {
      context.addIssue({
        code: "custom",
        message: "Every extraction citation must exactly reference a transcript turn.",
        path: ["summary"],
      });
      break;
    }
  }
  const unsigned = unsignedCaptureMediaOutput(value);
  if (sha256Json(unsigned) !== value.outputSha256) {
    context.addIssue({
      code: "custom",
      message: "Media output digest does not match its content.",
      path: ["outputSha256"],
    });
  }
});

export type CaptureMediaProcessingRequest = z.infer<
  typeof captureMediaProcessingRequestSchema
>;
export type CaptureRawAudioRetention = z.infer<
  typeof captureRawAudioRetentionSchema
>;
export type CaptureMediaTurn = z.infer<typeof captureMediaTurnSchema>;
export type CaptureSegmentMediaTranscript = z.infer<
  typeof captureSegmentMediaTranscriptSchema
>;
export type CaptureMediaCitation = z.infer<typeof captureMediaCitationSchema>;
export type CaptureMediaOutput = z.infer<typeof captureMediaOutputSchema>;

export function mediaTurnId(input: Omit<CaptureMediaTurn, "turnId">) {
  const { languageTag: _languageTag, ...stableIdentity } = input;
  return `media-turn:${sha256Json(stableIdentity)}`;
}

export function mediaCitationForTurn(turn: CaptureMediaTurn): CaptureMediaCitation {
  return {
    turnId: turn.turnId,
    segmentIndex: turn.segmentIndex,
    startMilliseconds: turn.startMilliseconds,
    endMilliseconds: turn.endMilliseconds,
    speakerLabel: turn.speaker.label,
    ...(turn.speaker.participantId
      ? { speakerParticipantId: turn.speaker.participantId }
      : {}),
  };
}

export function mediaArtifactId(
  kind: "chapter" | "action" | "decision",
  input: unknown,
) {
  return `media-${kind}:${sha256Json(input)}`;
}

export function withCaptureMediaOutputDigest(
  output: Omit<CaptureMediaOutput, "outputSha256">,
): CaptureMediaOutput {
  const candidate = {
    ...output,
    outputSha256: sha256Json(output),
  };
  return captureMediaOutputSchema.parse(candidate);
}

export function sha256Json(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function unsignedCaptureMediaOutput(output: CaptureMediaOutput) {
  const { outputSha256: _outputSha256, ...unsigned } = output;
  return unsigned;
}

function allOutputCitations(output: CaptureMediaOutput) {
  return [
    ...output.summary.citations,
    ...output.chapters.flatMap((chapter) => chapter.citations),
    ...output.actionItems.flatMap((item) => item.citations),
    ...output.decisions.flatMap((item) => item.citations),
  ];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
