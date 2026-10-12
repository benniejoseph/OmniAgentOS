import { describe, expect, it } from "vitest";
import { parseMarkdownTable } from "@/lib/command/markdown-table";

const parse = (text: string) => parseMarkdownTable(text.split("\n"), 0);

describe("message Markdown tables", () => {
  it("reads optional outside pipes, empty cells, and column alignment", () => {
    expect(parse([
      " Option | Evidence | Cost ",
      ":--- | :---: | ---:",
      "A | [web:one] | 12",
      "B | | 20",
      "",
      "Next paragraph",
    ].join("\n"))).toEqual({
      headers: ["Option", "Evidence", "Cost"],
      alignments: ["left", "center", "right"],
      rows: [["A", "[web:one]", "12"], ["B", "", "20"]],
      nextIndex: 4,
    });
  });

  it("keeps escaped pipes and pipes within matching inline code fences in one cell", () => {
    expect(parse([
      "| Syntax | Meaning |",
      "| --- | --- |",
      "| `a|b` | one\\|two |",
      "| ``a`|b`` | pipe\\| |",
    ].join("\n"))?.rows).toEqual([
      ["`a|b`", "one|two"],
      ["``a`|b``", "pipe|"],
    ]);
  });

  it("does not treat a pipe preceded by an escaped backslash as escaped", () => {
    expect(parse("A | B\n--- | ---\npath\\\\| value")?.rows).toEqual([["path\\\\", "value"]]);
  });

  it.each([
    "A | B\n--- | --\na | b",
    "A | B\n--- | --- | ---\na | b",
    "A | B\n--- | ---\na | b\nc | d | extra",
    "A | B\n--- | ---\n`unclosed | value",
    "A | B\n--- | ---",
    "| A |\n| --- |\n| a |",
  ])("leaves malformed or incomplete syntax as ordinary text: %s", (text) => {
    expect(parse(text)).toBeUndefined();
  });

  it.each(["# Heading | retained", "- List | retained", "1. List | retained", "> Quote | retained", "```text|example"])("stops before the next block: %s", (block) => {
    const result = parse(["A | B", "--- | ---", "a | b", block].join("\n"));
    expect(result?.nextIndex).toBe(3);
    expect(result?.rows).toEqual([["a", "b"]]);
  });

  it("falls back without truncating oversized tables", () => {
    expect(parse(["A | B", "--- | ---", ...Array.from({ length: 101 }, () => "a | b")].join("\n"))).toBeUndefined();
    expect(parse([Array(13).fill("A").join("|"), Array(13).fill("---").join("|"), Array(13).fill("a").join("|")].join("\n"))).toBeUndefined();
    expect(parse(`A | B\n--- | ---\n${"a".repeat(16_001)} | b`)).toBeUndefined();
  });
});
