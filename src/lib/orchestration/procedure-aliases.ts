// A saved procedure starts only when the whole request invokes it by alias,
// optionally wrapped as [can/could/would you] [please] [run/start/...]
// [my/the/our] <alias> [now] [please]. A request that only mentions an alias,
// such as "why did my weekly digest fail?", "don't run my weekly digest", or
// "run my weekly digest and email Sam", stays on the bounded agent loop instead
// of starting static tool bindings that ignore the rest of the request.
const PROCEDURE_INVOCATION_LEADING_SLOTS: readonly (readonly string[])[] = [
  ["can you", "could you", "would you"],
  ["please"],
  ["run", "start", "execute", "launch", "trigger", "kick off"],
  ["my", "the", "our"],
];
const PROCEDURE_INVOCATION_TRAILING_SLOTS: readonly (readonly string[])[] = [
  ["please"],
  ["now"],
];

// Replies a conversation already uses to answer, steer, or stop a run. An
// alias that reads as one of them, or as a word of the invocation wrapper,
// would start its procedure in place of the reply.
const RESERVED_PROCEDURE_PHRASES: ReadonlySet<string> = new Set([
  ...PROCEDURE_INVOCATION_LEADING_SLOTS.flat(),
  ...PROCEDURE_INVOCATION_TRAILING_SLOTS.flat(),
  "yes", "yeah", "yep", "no", "nope", "ok", "okay", "sure", "fine",
  "stop", "cancel", "abort", "continue", "go", "go ahead", "proceed",
  "retry", "try again", "again", "approve", "approved", "reject", "deny",
  "undo", "help", "thanks", "thank you", "hi", "hello", "hey", "done",
  "next", "skip", "wait", "pause", "resume",
]);

export function normalizeProcedurePhrase(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function procedureInvocationPhrases(
  normalizedMessage: string,
): ReadonlySet<string> {
  let forms = [normalizedMessage];
  for (const slot of PROCEDURE_INVOCATION_TRAILING_SLOTS) {
    forms = forms.flatMap((form) => [
      form,
      ...slot.flatMap((phrase) =>
        form.endsWith(` ${phrase}`) ? [form.slice(0, -phrase.length - 1)] : []),
    ]);
  }
  for (const slot of PROCEDURE_INVOCATION_LEADING_SLOTS) {
    forms = forms.flatMap((form) => [
      form,
      ...slot.flatMap((phrase) =>
        form.startsWith(`${phrase} `) ? [form.slice(phrase.length + 1)] : []),
    ]);
  }
  return new Set(forms);
}

/**
 * Whether an alias can name a procedure: it must survive normalization with
 * at least three characters and must not read, with or without the
 * invocation wrapper, as a reserved reply.
 */
export function isUsableProcedureAlias(alias: string) {
  const normalized = normalizeProcedurePhrase(alias);
  if (normalized.length < 3) return false;
  for (const form of procedureInvocationPhrases(normalized)) {
    if (RESERVED_PROCEDURE_PHRASES.has(form)) return false;
  }
  return true;
}
