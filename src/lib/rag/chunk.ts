export type TextChunk = {
  index: number;
  content: string;
};

export function chunkText(input: string, maxChars = 1200, overlapChars = 160): TextChunk[] {
  const boundedOverlap = Math.min(Math.max(overlapChars, 0), Math.floor(maxChars / 3));
  const paragraphs = input
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: TextChunk[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 <= maxChars) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }

    if (current) {
      chunks.push({ index: chunks.length, content: current });
      current = overlapTail(current, boundedOverlap);
    }

    if (paragraph.length <= maxChars) {
      const next = current ? `${current}\n\n${paragraph}` : paragraph;
      if (next.length <= maxChars) {
        current = next;
      } else {
        current = paragraph;
      }
      continue;
    }

    // A long paragraph is emitted directly below. Do not leave the overlap
    // tail from the preceding chunk in `current`, or it will be emitted again
    // as a standalone duplicate after the long paragraph.
    current = "";
    const step = Math.max(1, maxChars - boundedOverlap);
    for (let i = 0; i < paragraph.length; i += step) {
      chunks.push({
        index: chunks.length,
        content: paragraph.slice(i, i + maxChars),
      });
    }
  }

  if (current) {
    chunks.push({ index: chunks.length, content: current });
  }

  return chunks;
}

function overlapTail(value: string, chars: number) {
  if (chars <= 0 || value.length <= chars) {
    return "";
  }

  return value.slice(-chars).trimStart();
}
