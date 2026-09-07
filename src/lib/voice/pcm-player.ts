export const ASAEL_PCM_SAMPLE_RATE = 24_000;
export const ASAEL_VOICE_PROFILE_VERSION = "asael-voice:1";
export const ASAEL_VOICE_ENCODING = "pcm_s16le";
const MAX_SPEECH_TEXT_CHARACTERS = 3_800;

type VersionedSpeechInput = Readonly<{
  text: string;
  threadId?: string;
  runId?: string;
  agentId?: string;
}>;

/** Decodes arbitrarily chunked little-endian signed 16-bit PCM. */
export class Pcm16ChunkDecoder {
  private trailingByte: number | undefined;

  decode(chunk: Uint8Array) {
    const byteLength = chunk.byteLength +
      (this.trailingByte === undefined ? 0 : 1);
    const completeByteLength = byteLength - (byteLength % 2);
    const samples = new Float32Array(completeByteLength / 2);
    let chunkIndex = 0;
    let sampleIndex = 0;
    if (this.trailingByte !== undefined && completeByteLength) {
      samples[sampleIndex] = pcmSample(this.trailingByte, chunk[chunkIndex]);
      sampleIndex += 1;
      chunkIndex += 1;
      this.trailingByte = undefined;
    }
    while (chunkIndex + 1 < chunk.byteLength) {
      samples[sampleIndex] = pcmSample(
        chunk[chunkIndex],
        chunk[chunkIndex + 1],
      );
      sampleIndex += 1;
      chunkIndex += 2;
    }
    if (chunkIndex < chunk.byteLength) {
      this.trailingByte = chunk[chunkIndex];
    }
    return samples;
  }

  reset() {
    this.trailingByte = undefined;
  }
}

export class StreamingPcmPlayer {
  private context: AudioContext | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private generation = 0;
  private nextStartTime = 0;

  async play(
    stream: ReadableStream<Uint8Array>,
    options: {
      signal?: AbortSignal;
      onStarted?: () => void;
    } = {},
  ) {
    this.stop();
    const generation = this.generation;
    const context = new AudioContext({ sampleRate: ASAEL_PCM_SAMPLE_RATE });
    this.context = context;
    await context.resume();
    const reader = stream.getReader();
    this.reader = reader;
    const decoder = new Pcm16ChunkDecoder();
    let started = false;
    let sourceFailure: unknown;
    try {
      while (generation === this.generation) {
        options.signal?.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        const samples = decoder.decode(chunk.value);
        if (!samples.length) continue;
        if (!started) {
          started = true;
          options.onStarted?.();
        }
        this.schedule(context, samples, generation);
      }
      await this.waitForScheduledAudio(generation, options.signal);
    } catch (error) {
      sourceFailure = error;
      if (generation === this.generation) this.stop();
      throw error;
    } finally {
      if (this.reader === reader) this.reader = null;
      if (!sourceFailure && generation === this.generation) {
        await context.close().catch(() => undefined);
        if (this.context === context) this.context = null;
      }
    }
  }

  stop() {
    this.generation += 1;
    const reader = this.reader;
    this.reader = null;
    void reader?.cancel("playback_interrupted").catch(() => undefined);
    for (const source of this.sources) {
      try { source.stop(); } catch { /* Already stopped. */ }
    }
    this.sources.clear();
    const context = this.context;
    this.context = null;
    this.nextStartTime = 0;
    void context?.close().catch(() => undefined);
  }

  private schedule(
    context: AudioContext,
    samples: Float32Array,
    generation: number,
  ) {
    const buffer = context.createBuffer(
      1,
      samples.length,
      ASAEL_PCM_SAMPLE_RATE,
    );
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.addEventListener("ended", () => this.sources.delete(source), {
      once: true,
    });
    this.sources.add(source);
    const startsAt = Math.max(context.currentTime + 0.03, this.nextStartTime);
    this.nextStartTime = startsAt + buffer.duration;
    if (generation === this.generation) source.start(startsAt);
  }

  private async waitForScheduledAudio(
    generation: number,
    signal?: AbortSignal,
  ) {
    while (generation === this.generation && this.sources.size) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
}

export async function streamVersionedSpeech(
  input: VersionedSpeechInput,
  options: Readonly<{
    player: StreamingPcmPlayer;
    signal?: AbortSignal;
    onStarted?: () => void;
  }>,
) {
  const chunks = splitSpeechText(input.text);
  if (!chunks.length) throw new Error("There is no response to speak.");
  let started = false;
  for (const text of chunks) {
    options.signal?.throwIfAborted();
    const stream = await requestSpeechStream({ ...input, text }, options.signal);
    await options.player.play(stream, {
      signal: options.signal,
      onStarted: () => {
        if (started) return;
        started = true;
        options.onStarted?.();
      },
    });
  }
}

export function splitSpeechText(
  value: string,
  maxCharacters = MAX_SPEECH_TEXT_CHARACTERS,
) {
  const text = value.trim();
  if (!text) return [];
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error("Speech chunk size must be a positive integer.");
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxCharacters) {
    const window = remaining.slice(0, maxCharacters + 1);
    const sentenceBoundary = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("\n"),
    );
    const whitespaceBoundary = window.lastIndexOf(" ");
    const boundary = sentenceBoundary >= Math.floor(maxCharacters * 0.55)
      ? sentenceBoundary + (window[sentenceBoundary] === "\n" ? 0 : 1)
      : whitespaceBoundary > 0
        ? whitespaceBoundary
        : maxCharacters;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function requestSpeechStream(
  input: VersionedSpeechInput,
  signal?: AbortSignal,
) {
  const response = await fetch("/api/media/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: input.text,
      voiceProfileVersion: ASAEL_VOICE_PROFILE_VERSION,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => ({}));
    throw new Error(speechError(body, `Speech playback failed (${response.status}).`));
  }
  if (
    response.headers.get("content-type") !== "audio/pcm" ||
    response.headers.get("x-asael-audio-encoding") !== ASAEL_VOICE_ENCODING ||
    response.headers.get("x-asael-audio-sample-rate") !== String(ASAEL_PCM_SAMPLE_RATE) ||
    response.headers.get("x-asael-voice-profile") !== ASAEL_VOICE_PROFILE_VERSION ||
    !/^[a-f0-9]{64}$/.test(response.headers.get("x-asael-voice-profile-sha256") || "") ||
    !response.body
  ) {
    await response.body?.cancel("invalid_speech_contract").catch(() => undefined);
    throw new Error("The speech stream did not match Asael's active voice profile.");
  }
  return response.body;
}

function speechError(value: unknown, fallback: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" ? error.slice(0, 500) : fallback;
}

function pcmSample(low: number, high: number) {
  const unsigned = low | (high << 8);
  const signed = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
  return Math.max(-1, signed / 0x8000);
}
