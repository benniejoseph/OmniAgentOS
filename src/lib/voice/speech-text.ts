/** Spoken in place of a fenced code block. */
const CODE_NOTICE = "The code is on screen.";

/** Spoken in place of a table. */
const TABLE_NOTICE = "The table is on screen.";

/** Spoken when nothing in the text can be read aloud. */
const EMPTY_NOTICE = "The answer is on screen.";

/** Longer fence markers are shortened when a split block is reopened. */
const MAX_REOPENED_FENCE_CHARACTERS = 20;

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TABLE_DELIMITER = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const SETEXT_UNDERLINE = /^ {0,3}=+\s*$/;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*\S+/;
const HEADING = /^ {0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const BLOCKQUOTE = /^ {0,3}(?:>\s?)+/;
const BULLET = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/;
const ORDERED = /^\s*(\d{1,9})[.)]\s+(?:\[[ xX]\]\s+)?/;
const WEB_ADDRESS = /\bhttps?:\/\/[^\s<>()[\]]+/g;

/**
 * The words of a Markdown reply that make sense aloud. Code and tables stay
 * on screen, so speech mentions them instead of reading their symbols, and
 * the rest keeps its words without the markup.
 */
export function speakableText(markdown: string) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const spoken: string[] = [];
  const say = (line: string) => {
    const previous = spoken.findLast((entry) => entry !== "");
    if ((line === CODE_NOTICE || line === TABLE_NOTICE) && previous === line) return;
    spoken.push(line);
  };
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = nextFence(line, fence);
    if (fence || next) {
      if (!fence) say(CODE_NOTICE);
      fence = next;
      continue;
    }
    const delimiter = lines[index + 1] ?? "";
    if (line.includes("|") && delimiter.includes("|") && TABLE_DELIMITER.test(delimiter)) {
      index += 1;
      while (index + 1 < lines.length && lines[index + 1].includes("|")) index += 1;
      say(TABLE_NOTICE);
      continue;
    }
    if (
      THEMATIC_BREAK.test(line) ||
      SETEXT_UNDERLINE.test(line) ||
      REFERENCE_DEFINITION.test(line)
    ) {
      spoken.push("");
      continue;
    }
    spoken.push(spokenLine(line));
  }
  const text = spoken
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || EMPTY_NOTICE;
}

/**
 * Closes a code block that a split leaves open at the end of one chunk and
 * reopens it at the start of the next, so each chunk tells code from prose on
 * its own.
 */
export function balanceCodeFences(chunks: readonly string[]) {
  let open: string | undefined;
  return chunks.map((chunk) => {
    const text = open ? `${open}\n${chunk}` : chunk;
    open = text.split("\n").reduce(
      (fence: string | undefined, line) => nextFence(line, fence),
      undefined,
    )?.slice(0, MAX_REOPENED_FENCE_CHARACTERS);
    return open ? `${text}\n${open}` : text;
  });
}

/**
 * The code fence open after a line: a new marker when the line opens a
 * block, none when it closes the open one, and the open one otherwise.
 */
function nextFence(line: string, open: string | undefined) {
  const match = FENCE_LINE.exec(line);
  if (!match) return open;
  const [, marker, rest] = match;
  if (open) {
    return marker[0] === open[0] && marker.length >= open.length && !rest.trim()
      ? undefined
      : open;
  }
  return marker[0] === "`" && rest.includes("`") ? undefined : marker;
}

function spokenLine(line: string) {
  const heading = HEADING.exec(line);
  if (heading) return withStop(inlineText(heading[1] ?? ""));
  const quoted = line.replace(BLOCKQUOTE, "");
  const ordered = ORDERED.exec(quoted);
  if (ordered) {
    return withStop(`${ordered[1]}. ${inlineText(quoted.slice(ordered[0].length))}`);
  }
  if (BULLET.test(quoted)) return withStop(inlineText(quoted.replace(BULLET, "")));
  return inlineText(quoted);
}

function inlineText(text: string) {
  return text
    .replace(/<!--.*?-->/g, " ")
    .replace(/(`+)(.+?)\1/g, "$2")
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(WEB_ADDRESS, spokenUrl)
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, " ")
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}*\\])\*(?=\S)([^*]*?)(?<=\S)\*(?![\p{L}\p{N}*])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_\\])_(?=\S)([^_]*?)(?<=\S)_(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A web address read as its site, since paths and queries are noise aloud. */
function spokenUrl(match: string) {
  const trailing = /[.,;:!?'"]+$/.exec(match)?.[0] ?? "";
  try {
    const host = new URL(match.slice(0, match.length - trailing.length)).hostname;
    return `${host.replace(/^www\./, "")}${trailing}`;
  } catch {
    return trailing;
  }
}

function withStop(text: string) {
  return !text || /\p{P}$/u.test(text) ? text : `${text}.`;
}
