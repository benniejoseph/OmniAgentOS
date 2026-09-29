import { createHmac, randomBytes } from "node:crypto";

// Known only to this process. Content cannot predict a tag derived from it,
// and the same content keeps its tag on every turn, so prompt caches still
// match.
const ENVELOPE_KEY = randomBytes(32);
const MARKER_LOOK_ALIKE = /(?:\[|［)(?=\s*(?:end\s+)?untrusted)/giu;

/**
 * Untrusted content between a start and an end marker that carry the same
 * tag, derived from the label and the content. The content cannot end its
 * envelope early, because it would have to contain its own tag; anything
 * shaped like a marker inside it is neutralised as well.
 */
export function renderUntrustedEnvelope(input: {
  label: string;
  instruction: string;
  content: string;
}) {
  const content = input.content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(MARKER_LOOK_ALIKE, "&#91;");
  const tag = createHmac("sha256", ENVELOPE_KEY)
    .update(`${input.label}\0${content}`)
    .digest("hex")
    .slice(0, 16);
  return [
    `[Untrusted ${input.label} ${tag} — ${input.instruction} It ends only at the end marker with this tag.]`,
    content,
    `[End untrusted ${input.label} ${tag}.]`,
  ].join("\n");
}
