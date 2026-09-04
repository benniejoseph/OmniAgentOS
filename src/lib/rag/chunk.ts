export type TextChunk = {
  index: number;
  content: string;
  /** Inclusive offset in the normalized extracted-text coordinate space. */
  characterStart: number;
  /** Exclusive offset in the normalized extracted-text coordinate space. */
  characterEnd: number;
};

export function normalizeTextForChunking(input: string) {
  return input
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function chunkText(input: string, maxChars = 1200, overlapChars = 160): TextChunk[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new RangeError("Chunk size must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(overlapChars) || overlapChars < 0) {
    throw new RangeError("Chunk overlap must be a non-negative safe integer.");
  }
  const boundedOverlap = Math.min(Math.max(overlapChars, 0), Math.floor(maxChars / 3));
  const paragraphValues = normalizeTextForChunking(input).split(/\n{2,}/).filter(Boolean);
  let normalizedCursor = 0;
  const paragraphs = paragraphValues.map((content) => {
    const characterStart = normalizedCursor;
    normalizedCursor += content.length + 2;
    return { content, characterStart };
  });

  const chunks: TextChunk[] = [];
  let current = "";
  let currentStart = 0;

  const pushChunk = (
    content: string,
    characterStart: number,
  ) => {
    chunks.push({
      index: chunks.length,
      content,
      characterStart,
      characterEnd: characterStart + content.length,
    });
  };

  for (const paragraph of paragraphs) {
    if (current.length + paragraph.content.length + 2 <= maxChars) {
      if (!current) currentStart = paragraph.characterStart;
      current = current
        ? `${current}\n\n${paragraph.content}`
        : paragraph.content;
      continue;
    }

    if (current) {
      pushChunk(current, currentStart);
      const overlap = overlapTail(current, boundedOverlap);
      currentStart += overlap.offset;
      current = overlap.content;
    }

    if (paragraph.content.length <= maxChars) {
      const next = current
        ? `${current}\n\n${paragraph.content}`
        : paragraph.content;
      if (next.length <= maxChars) {
        if (!current) currentStart = paragraph.characterStart;
        current = next;
      } else {
        current = paragraph.content;
        currentStart = paragraph.characterStart;
      }
      continue;
    }

    // A long paragraph is emitted directly below. Do not leave the overlap
    // tail from the preceding chunk in `current`, or it will be emitted again
    // as a standalone duplicate after the long paragraph.
    current = "";
    currentStart = 0;
    let characterStart = 0;
    while (characterStart < paragraph.content.length) {
      let characterEnd = Math.min(
        characterStart + maxChars,
        paragraph.content.length,
      );
      characterEnd = surrogateSafeEnd(
        paragraph.content,
        characterStart,
        characterEnd,
      );
      pushChunk(
        paragraph.content.slice(characterStart, characterEnd),
        paragraph.characterStart + characterStart,
      );
      if (characterEnd >= paragraph.content.length) break;

      let nextStart = Math.max(
        characterStart + 1,
        characterEnd - boundedOverlap,
      );
      if (
        nextStart > 0 &&
        isLowSurrogate(paragraph.content.charCodeAt(nextStart)) &&
        isHighSurrogate(paragraph.content.charCodeAt(nextStart - 1))
      ) {
        nextStart -= 1;
      }
      if (nextStart <= characterStart) nextStart = characterEnd;
      characterStart = nextStart;
    }
  }

  if (current) {
    pushChunk(current, currentStart);
  }

  return chunks;
}

function overlapTail(value: string, chars: number) {
  if (chars <= 0 || value.length <= chars) {
    return { content: "", offset: value.length };
  }

  let rawOffset = value.length - chars;
  if (
    rawOffset > 0 &&
    isLowSurrogate(value.charCodeAt(rawOffset)) &&
    isHighSurrogate(value.charCodeAt(rawOffset - 1))
  ) {
    rawOffset -= 1;
  }
  const raw = value.slice(rawOffset);
  const content = raw.trimStart();
  return {
    content,
    offset: rawOffset + raw.length - content.length,
  };
}

function surrogateSafeEnd(value: string, start: number, end: number) {
  if (
    end < value.length &&
    end > start &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    return end - start === 1 ? end + 1 : end - 1;
  }
  return end;
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}
