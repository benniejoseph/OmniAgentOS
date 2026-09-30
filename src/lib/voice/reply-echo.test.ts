import { describe, expect, it } from "vitest";
import { isReplyEcho, REPLY_ECHO_GUARD_MS, ReplyEchoGuard } from "@/lib/voice/reply-echo";

const reply = "Here are the three results I found for flights to Lisbon on Friday.";
const speech = (itemId: string) => ({
  type: "input_audio_buffer.speech_started",
  item_id: itemId,
  audio_start_ms: 0,
});
const finished = (itemId: string, transcript: unknown) => ({
  type: "conversation.item.input_audio_transcription.completed",
  item_id: itemId,
  transcript,
});

describe("reply echo guard", () => {
  it("lets speech interrupt a reply once the echo canceller has had time to adapt", () => {
    const guard = new ReplyEchoGuard();
    expect(guard.speechStarted(speech("item_before"), 0)).toBe(true);

    guard.replyStarted(reply, 1_000);
    expect(guard.speechStarted(speech("item_onset"), 1_000 + REPLY_ECHO_GUARD_MS - 1)).toBe(false);
    expect(guard.speechStarted(speech("item_barge_in"), 1_000 + REPLY_ECHO_GUARD_MS)).toBe(true);

    guard.replyEnded(2_000);
    expect(guard.speechStarted(speech("item_after"), 2_001)).toBe(true);
  });

  it("drops a turn that only heard the reply and keeps the owner's words", () => {
    const guard = new ReplyEchoGuard();
    guard.replyStarted(reply, 0);
    for (const itemId of ["item_echo", "item_owner", "item_short"]) {
      guard.speechStarted(speech(itemId), 100);
    }

    expect(guard.finishedTurn(finished("item_echo", "here are the three results i found for flights")))
      .toEqual({ itemId: "item_echo", echo: true });
    expect(guard.finishedTurn(finished("item_owner", "No, book the train instead.")))
      .toEqual({ itemId: "item_owner", echo: false });
    expect(guard.finishedTurn(finished("item_short", "Three results.")))
      .toEqual({ itemId: "item_short", echo: false });
    // Each turn is judged once.
    expect(guard.finishedTurn(finished("item_echo", reply))).toBeUndefined();
  });

  it("judges only turns that began while the reply played or just after", () => {
    const guard = new ReplyEchoGuard();
    guard.replyEnded(0);
    guard.speechStarted(speech("item_before"), 1);
    guard.replyStarted(reply, 1_000);
    guard.replyEnded(5_000);
    guard.speechStarted(speech("item_tail"), 5_000 + REPLY_ECHO_GUARD_MS - 1);
    guard.speechStarted(speech("item_later"), 5_000 + REPLY_ECHO_GUARD_MS);

    expect(guard.finishedTurn(finished("item_before", reply))).toBeUndefined();
    expect(guard.finishedTurn(finished("item_tail", reply))?.echo).toBe(true);
    expect(guard.finishedTurn(finished("item_later", reply))).toBeUndefined();
  });

  it("reads turns the way the transcript does, and nothing else", () => {
    const guard = new ReplyEchoGuard();
    guard.replyStarted(reply, 0);
    guard.speechStarted(speech(" item_padded "), 0);
    guard.speechStarted(speech("bad id!"), 0);
    guard.speechStarted(speech("item_other"), 0);

    expect(guard.finishedTurn(finished("bad id!", reply))).toBeUndefined();
    expect(guard.finishedTurn({
      ...finished("item_padded", reply),
      type: "conversation.item.input_audio_transcription.delta",
    })).toBeUndefined();
    expect(guard.finishedTurn(finished("item_padded", reply))?.echo).toBe(true);
    expect(guard.finishedTurn(finished("item_other", 42))).toEqual({ itemId: "item_other", echo: false });
  });

  it("remembers a bounded number of overlapping turns", () => {
    const guard = new ReplyEchoGuard();
    guard.replyStarted(reply, 0);
    for (let index = 0; index <= 32; index += 1) guard.speechStarted(speech(`item_${index}`), 0);

    expect(guard.finishedTurn(finished("item_0", reply))).toBeUndefined();
    expect(guard.finishedTurn(finished("item_1", reply))?.echo).toBe(true);
    expect(guard.finishedTurn(finished("item_32", reply))?.echo).toBe(true);
  });
});

describe("reply echo", () => {
  it("needs most of a turn's word pairs to occur in the reply", () => {
    expect(isReplyEcho("Here are the three cats today", reply)).toBe(true);
    expect(isReplyEcho("Here are the dogs now", reply)).toBe(false);
  });

  it("compares words across case, punctuation, and Unicode forms", () => {
    expect(isReplyEcho("HERE ARE the three... results!", reply)).toBe(true);
    const accented = "Le café est déjà ouvert à Lisbonne.";
    expect(isReplyEcho(accented.normalize("NFD"), accented)).toBe(true);
    expect(isReplyEcho("आप कैसे", "नमस्ते, आप कैसे हैं?")).toBe(false);
    expect(isReplyEcho("नमस्ते आप कैसे", "नमस्ते, आप कैसे हैं?")).toBe(true);
  });
});
