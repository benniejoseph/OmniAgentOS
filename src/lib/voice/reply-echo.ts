/**
 * How long after a spoken reply starts that detected speech is taken for the
 * reply's own echo, while the browser's echo canceller adapts to the new
 * audio. It is a heuristic to tune on real speakers and browsers.
 */
export const REPLY_ECHO_GUARD_MS = 500;

/** The share of a turn's word pairs that must occur in the reply. */
const ECHO_PAIR_SHARE = 0.6;

/** Shorter turns are kept, since a brief barge-in can repeat the reply. */
const MIN_ECHO_WORDS = 3;

const MAX_OVERLAPPING_TURNS = 32;

export type ReplyOverlapTurn = Readonly<{ itemId: string; echo: boolean }>;

/**
 * Tells a spoken reply's own echo from the owner talking over it. Browser
 * echo cancellation can miss audio played through Web Audio, on speakers or
 * in Safari, so the microphone may hear the reply. That echo must neither
 * interrupt the reply nor become the next command, since the reply can quote
 * untrusted tool or web content.
 */
export class ReplyEchoGuard {
  private reply = "";
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  private readonly overlapping = new Map<string, string>();

  /** The reply's audio began playing at `now`. */
  replyStarted(text: string, now: number) {
    this.reply = text;
    this.startedAt = now;
  }

  /** The reply's audio stopped at `now`. */
  replyEnded(now: number) {
    if (this.startedAt === null) return;
    this.startedAt = null;
    this.endedAt = now;
  }

  /**
   * Notes a turn whose speech began while the reply played, or just after it
   * ended, and returns whether that speech may interrupt the reply.
   */
  speechStarted(event: unknown, now: number) {
    const itemId = itemIdOf(event);
    const overlaps = this.startedAt !== null ||
      (this.endedAt !== null && now - this.endedAt < REPLY_ECHO_GUARD_MS);
    if (itemId && overlaps) {
      const oldest = this.overlapping.keys().next().value;
      if (this.overlapping.size >= MAX_OVERLAPPING_TURNS && oldest !== undefined) {
        this.overlapping.delete(oldest);
      }
      this.overlapping.set(itemId, this.reply);
    }
    return this.startedAt === null || now - this.startedAt >= REPLY_ECHO_GUARD_MS;
  }

  /**
   * The finished transcript of a turn that overlapped the reply, and whether
   * it only heard the reply. Any other event returns undefined.
   */
  finishedTurn(event: unknown): ReplyOverlapTurn | undefined {
    if (
      !isRecord(event) ||
      event.type !== "conversation.item.input_audio_transcription.completed"
    ) return undefined;
    const itemId = itemIdOf(event);
    const reply = itemId ? this.overlapping.get(itemId) : undefined;
    if (!itemId || reply === undefined) return undefined;
    this.overlapping.delete(itemId);
    return {
      itemId,
      echo: typeof event.transcript === "string" &&
        isReplyEcho(event.transcript, reply),
    };
  }
}

/** Whether most of a transcript's word pairs occur in the reply's text. */
export function isReplyEcho(transcript: string, reply: string) {
  const heard = words(transcript);
  if (heard.length < MIN_ECHO_WORDS) return false;
  const spoken = new Set(wordPairs(words(reply)));
  const pairs = wordPairs(heard);
  const matched = pairs.filter((pair) => spoken.has(pair)).length;
  return matched >= pairs.length * ECHO_PAIR_SHARE;
}

function words(text: string) {
  return text
    .slice(0, 100_000)
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function wordPairs(list: readonly string[]) {
  return list.slice(1).map((word, index) => `${list[index]} ${word}`);
}

function itemIdOf(event: unknown) {
  if (!isRecord(event) || typeof event.item_id !== "string") return "";
  const itemId = event.item_id.trim();
  return /^[A-Za-z0-9_:-]{1,200}$/.test(itemId) ? itemId : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
