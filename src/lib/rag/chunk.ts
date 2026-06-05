export type TextChunk = {
  index: number;
  content: string;
};

export function chunkText(input: string, maxChars = 1200): TextChunk[] {
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
      current = "";
    }

    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }

    for (let i = 0; i < paragraph.length; i += maxChars) {
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
