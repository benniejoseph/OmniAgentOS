export type MarkdownTable = {
  headers: string[];
  alignments: Array<"left" | "center" | "right">;
  rows: string[][];
  nextIndex: number;
};

const MAX_COLUMNS = 12;
const MAX_ROWS = 100;
const MAX_LINE_LENGTH = 16_000;

// Deliberately supports plain pipe tables only. Ambiguous or incomplete tables
// stay as message text, including while an answer is still streaming.
export function parseMarkdownTable(lines: readonly string[], start: number): MarkdownTable | undefined {
  const separator = lines[start + 1];
  if (!separator || !/^\s*\|?\s*:?-{3,}/.test(separator)) return undefined;

  const headers = splitRow(lines[start]);
  const delimiters = splitRow(separator);
  if (!headers || !delimiters || headers.length < 2 || headers.length > MAX_COLUMNS ||
    headers.length !== delimiters.length || delimiters.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
    return undefined;
  }

  const rows: string[][] = [];
  let nextIndex = start + 2;
  while (nextIndex < lines.length) {
    const line = lines[nextIndex];
    if (!line.trim() || /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|`{3,}|~{3,})/.test(line.trimStart())) break;
    if (!line.includes("|")) break;
    const row = splitRow(line);
    if (!row || row.length !== headers.length || rows.length >= MAX_ROWS) return undefined;
    rows.push(row);
    nextIndex += 1;
  }
  if (!rows.length) return undefined;

  return {
    headers,
    alignments: delimiters.map((cell) => cell.endsWith(":")
      ? cell.startsWith(":") ? "center" : "right"
      : "left"),
    rows,
    nextIndex,
  };
}

function splitRow(line: string | undefined): string[] | undefined {
  if (!line || line.length > MAX_LINE_LENGTH) return undefined;
  const text = line.trim();
  const cells: string[] = [];
  let cell = "";
  let codeFence = 0;
  let trailingSeparator = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    trailingSeparator = false;
    if (character === "\\" && index + 1 < text.length && (!codeFence || text[index + 1] === "|")) {
      const next = text[index + 1];
      cell += next === "|" ? "|" : `${character}${next}`;
      index += 1;
    } else if (character === "`") {
      let length = 1;
      while (text[index + length] === "`") length += 1;
      if (!codeFence) codeFence = length;
      else if (codeFence === length) codeFence = 0;
      cell += "`".repeat(length);
      index += length - 1;
    } else if (character === "|" && !codeFence) {
      cells.push(cell.trim());
      cell = "";
      trailingSeparator = true;
    } else {
      cell += character;
    }
  }
  if (codeFence || !cells.length) return undefined;
  cells.push(cell.trim());
  if (text.startsWith("|")) cells.shift();
  if (trailingSeparator) cells.pop();
  return cells;
}
