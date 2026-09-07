export const MAX_REALTIME_TRANSCRIPT_CHARACTERS = 100_000;

export type RealtimeTranscriptState = Readonly<{
  manualText: string;
  itemOrder: readonly string[];
  itemText: Readonly<Record<string, string>>;
  completedItemIds: readonly string[];
  ignoredItemIds: readonly string[];
  turnCount: number;
}>;

export const EMPTY_REALTIME_TRANSCRIPT: RealtimeTranscriptState = Object.freeze({
  manualText: "",
  itemOrder: Object.freeze([]),
  itemText: Object.freeze({}),
  completedItemIds: Object.freeze([]),
  ignoredItemIds: Object.freeze([]),
  turnCount: 0,
});

/**
 * Reduces only the allowlisted, content-bearing transcription fields from an
 * untrusted Realtime server event. Provider metadata can never become UI
 * instructions or application authority through this projection.
 */
export function applyRealtimeTranscriptEvent(
  state: RealtimeTranscriptState,
  event: unknown,
): RealtimeTranscriptState {
  if (!isRecord(event)) return state;
  const type = event.type;
  if (
    type !== "conversation.item.input_audio_transcription.delta" &&
    type !== "conversation.item.input_audio_transcription.completed"
  ) return state;

  const itemId = safeItemId(event.item_id);
  if (!itemId || state.ignoredItemIds.includes(itemId)) return state;
  if (
    type === "conversation.item.input_audio_transcription.delta" &&
    state.completedItemIds.includes(itemId)
  ) return state;

  const content = type.endsWith(".delta")
    ? safeText(event.delta, 8_000)
    : safeText(event.transcript, MAX_REALTIME_TRANSCRIPT_CHARACTERS);
  if (!content) return state;

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

  return boundedState({
    ...state,
    itemOrder,
    itemText,
    completedItemIds,
    turnCount: type.endsWith(".completed")
      ? Math.min(state.turnCount + 1, 1_000)
      : state.turnCount,
  });
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
    completedItemIds: [],
    ignoredItemIds: [...new Set([
      ...state.ignoredItemIds,
      ...state.itemOrder,
    ])].slice(-1_000),
    turnCount: state.turnCount,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
