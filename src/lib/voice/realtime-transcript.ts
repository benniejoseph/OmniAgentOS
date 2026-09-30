export const MAX_REALTIME_TRANSCRIPT_CHARACTERS = 100_000;

/** Stands in the draft for speech the provider did not transcribe. */
export const REALTIME_TRANSCRIPT_GAP = "[not transcribed]";

export type RealtimeTranscriptState = Readonly<{
  manualText: string;
  itemOrder: readonly string[];
  itemText: Readonly<Record<string, string>>;
  itemConfidence: Readonly<Record<string, RealtimeItemConfidence>>;
  completedItemIds: readonly string[];
  failedItemIds: readonly string[];
  ignoredItemIds: readonly string[];
  turnCount: number;
  manuallyEdited: boolean;
}>;

type RealtimeItemConfidence = Readonly<{
  mean: number;
  minimum: number;
  sampleCount: number;
}>;

export type RealtimeTranscriptConfidence = Readonly<{
  band: "high" | "low" | "unavailable" | "edited";
  mean?: number;
  minimum?: number;
  sampleCount: number;
  requiresExplicitAttestation: boolean;
}>;

export const EMPTY_REALTIME_TRANSCRIPT: RealtimeTranscriptState = Object.freeze({
  manualText: "",
  itemOrder: Object.freeze([]),
  itemText: Object.freeze({}),
  itemConfidence: Object.freeze({}),
  completedItemIds: Object.freeze([]),
  failedItemIds: Object.freeze([]),
  ignoredItemIds: Object.freeze([]),
  turnCount: 0,
  manuallyEdited: false,
});

/**
 * Reduces only the allowlisted transcription fields from an untrusted Realtime
 * server event. Provider metadata can never become UI instructions or
 * application authority through this projection.
 */
export function applyRealtimeTranscriptEvent(
  state: RealtimeTranscriptState,
  event: unknown,
): RealtimeTranscriptState {
  if (!isRecord(event)) return state;
  const type = event.type;
  if (
    type !== "input_audio_buffer.committed" &&
    type !== "conversation.item.input_audio_transcription.delta" &&
    type !== "conversation.item.input_audio_transcription.completed" &&
    type !== "conversation.item.input_audio_transcription.failed"
  ) return state;

  const itemId = safeItemId(event.item_id);
  if (!itemId || state.ignoredItemIds.includes(itemId)) return state;
  // Transcripts can finish out of order, so each turn takes its place when
  // its audio is committed.
  if (type === "input_audio_buffer.committed") {
    if (state.itemOrder.includes(itemId)) return state;
    return { ...state, itemOrder: [...state.itemOrder, itemId].slice(-1_000) };
  }
  if (
    state.failedItemIds.includes(itemId) ||
    (type !== "conversation.item.input_audio_transcription.completed" &&
      state.completedItemIds.includes(itemId))
  ) return state;
  if (type === "conversation.item.input_audio_transcription.failed") {
    return markUntranscribed(state, [itemId]);
  }

  const content = type.endsWith(".delta")
    ? safeText(event.delta, 8_000)
    : safeText(event.transcript, MAX_REALTIME_TRANSCRIPT_CHARACTERS);
  if (!content) {
    // A turn that finished with no words holds nothing back.
    if (type.endsWith(".delta") || state.completedItemIds.includes(itemId)) return state;
    return {
      ...state,
      completedItemIds: [...state.completedItemIds, itemId].slice(-1_000),
    };
  }

  const itemOrder = state.itemOrder.includes(itemId)
    ? [...state.itemOrder]
    : [...state.itemOrder, itemId].slice(-1_000);
  const itemText = { ...state.itemText };
  itemText[itemId] = type.endsWith(".delta")
    ? `${itemText[itemId] || ""}${content}`.slice(
        0,
        MAX_REALTIME_TRANSCRIPT_CHARACTERS,
      )
    : content;
  const completedItemIds = type.endsWith(".completed")
    ? [...new Set([...state.completedItemIds, itemId])].slice(-1_000)
    : [...state.completedItemIds];
  const itemConfidence = { ...state.itemConfidence };
  if (type.endsWith(".completed")) {
    const confidence = confidenceFromLogprobs(event.logprobs);
    if (confidence) itemConfidence[itemId] = confidence;
  }

  return boundedState({
    ...state,
    itemOrder,
    itemText,
    itemConfidence,
    completedItemIds,
    turnCount: type.endsWith(".completed")
      ? Math.min(state.turnCount + 1, 1_000)
      : state.turnCount,
  });
}

/**
 * Whether a committed turn is still waiting for its final transcript, so
 * review can wait for it instead of for a fixed delay.
 */
export function realtimeTranscriptPending(state: RealtimeTranscriptState) {
  return state.itemOrder.some((itemId) => isUnfinished(state, itemId));
}

/**
 * Ends the draft for review: a turn whose transcript never arrived shows as a
 * gap rather than disappearing from the command.
 */
export function closeRealtimeTranscript(
  state: RealtimeTranscriptState,
): RealtimeTranscriptState {
  const unfinished = state.itemOrder.filter((itemId) => isUnfinished(state, itemId));
  return unfinished.length ? markUntranscribed(state, unfinished) : state;
}

/** Converts the visible provider draft into user-owned editable text. */
export function editRealtimeTranscript(
  state: RealtimeTranscriptState,
  text: string,
): RealtimeTranscriptState {
  return {
    manualText: safeText(text, MAX_REALTIME_TRANSCRIPT_CHARACTERS),
    itemOrder: [],
    itemText: {},
    itemConfidence: {},
    completedItemIds: [],
    failedItemIds: [],
    ignoredItemIds: [...new Set([
      ...state.ignoredItemIds,
      ...state.itemOrder,
    ])].slice(-1_000),
    turnCount: state.turnCount,
    manuallyEdited: true,
  };
}

/**
 * Projects provider token log probabilities into content-free review metadata.
 * Tokens and bytes are deliberately discarded and can never become authority.
 * Only a draft whose every turn finished with a score can be banded; a turn
 * still arriving, failed, or unscored leaves the confidence unavailable.
 */
export function realtimeTranscriptConfidence(
  state: RealtimeTranscriptState,
): RealtimeTranscriptConfidence {
  if (state.manuallyEdited) {
    return {
      band: "edited",
      sampleCount: 0,
      requiresExplicitAttestation: true,
    };
  }
  const unscored = state.itemOrder.some((itemId) =>
    !state.completedItemIds.includes(itemId) ||
    (Boolean(state.itemText[itemId]) && !state.itemConfidence[itemId]));
  const summaries = state.itemOrder
    .map((itemId) => state.itemConfidence[itemId])
    .filter((value): value is RealtimeItemConfidence => Boolean(value));
  const sampleCount = summaries.reduce(
    (total, summary) => total + summary.sampleCount,
    0,
  );
  if (unscored || !sampleCount) {
    return {
      band: "unavailable",
      sampleCount: 0,
      requiresExplicitAttestation: true,
    };
  }
  const mean = summaries.reduce(
    (total, summary) => total + summary.mean * summary.sampleCount,
    0,
  ) / sampleCount;
  const minimum = Math.min(...summaries.map((summary) => summary.minimum));
  const band = mean >= 0.65 && minimum >= 0.1 ? "high" : "low";
  return {
    band,
    mean: roundedConfidence(mean),
    minimum: roundedConfidence(minimum),
    sampleCount,
    requiresExplicitAttestation: band !== "high",
  };
}

export function realtimeTranscriptText(state: RealtimeTranscriptState) {
  return unboundedTranscriptText(state).slice(
    0,
    MAX_REALTIME_TRANSCRIPT_CHARACTERS,
  );
}

function unboundedTranscriptText(state: RealtimeTranscriptState) {
  return [
    state.manualText,
    ...state.itemOrder.map((itemId) => state.itemText[itemId] || ""),
  ].reduce(joinTranscriptParts, "");
}

function isUnfinished(state: RealtimeTranscriptState, itemId: string) {
  return !state.completedItemIds.includes(itemId) && !state.failedItemIds.includes(itemId);
}

/** Keeps any words that arrived and marks where the rest are missing. */
function markUntranscribed(
  state: RealtimeTranscriptState,
  itemIds: readonly string[],
): RealtimeTranscriptState {
  const itemText = { ...state.itemText };
  for (const itemId of itemIds) {
    itemText[itemId] = joinTranscriptParts(itemText[itemId] || "", REALTIME_TRANSCRIPT_GAP);
  }
  return boundedState({
    ...state,
    itemOrder: [...new Set([...state.itemOrder, ...itemIds])].slice(-1_000),
    itemText,
    failedItemIds: [...new Set([...state.failedItemIds, ...itemIds])].slice(-1_000),
  });
}

function boundedState(state: RealtimeTranscriptState) {
  const visible = unboundedTranscriptText(state);
  if (visible.length <= MAX_REALTIME_TRANSCRIPT_CHARACTERS) return state;
  return editRealtimeTranscript(state, visible);
}

function joinTranscriptParts(current: string, next: string) {
  if (!next) return current;
  if (!current) return next;
  if (/\s$/.test(current) || /^\s|^[,.;:!?)]/.test(next)) {
    return `${current}${next}`;
  }
  return `${current} ${next}`;
}

function safeItemId(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return /^[A-Za-z0-9_:-]{1,200}$/.test(normalized) ? normalized : "";
}

function safeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, maxLength);
}

function confidenceFromLogprobs(value: unknown): RealtimeItemConfidence | undefined {
  if (!Array.isArray(value)) return undefined;
  const probabilities = value
    .slice(0, 10_000)
    .map((entry) => {
      if (!isRecord(entry) || typeof entry.logprob !== "number") return undefined;
      if (!Number.isFinite(entry.logprob) || entry.logprob > 0) return undefined;
      return Math.exp(Math.max(-100, entry.logprob));
    })
    .filter((probability): probability is number => probability !== undefined);
  if (!probabilities.length) return undefined;
  return {
    mean: probabilities.reduce((total, probability) => total + probability, 0) /
      probabilities.length,
    minimum: Math.min(...probabilities),
    sampleCount: probabilities.length,
  };
}

function roundedConfidence(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
