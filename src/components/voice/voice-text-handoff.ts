/** Preserve an existing typed draft; a handoff grants no send/approval consent. */
export function voiceTextDraft(draft: string, transcript: string) {
  const text = transcript.trim();
  if (!text) throw new Error("There is no transcript to move into the composer.");
  const result = draft.trim() ? `${draft}\n\n${text}` : text;
  if (result.length > 100_000) throw new Error("The combined draft is too long. Shorten the transcript before continuing in text.");
  return result;
}
