import { describe, expect, it } from "vitest";
import { balanceCodeFences, speakableText } from "@/lib/voice/speech-text";

describe("speakable reply text", () => {
  it("reads a reply's words without its markup", () => {
    expect(speakableText([
      "## Plan #",
      "Here is **the plan** with *care*, _stress_, __weight__, ~~old~~ and `npm test`.",
      "- First [step](https://example.com/docs/(a)?b=c)",
      "* [x] Second ![diagram](https://img.example.com/x.png)",
      "2) Numbered [item][ref]",
      "> > Quoted <kbd>line</kbd><!-- hidden -->",
      "See https://www.example.com/path/to?q=1. Or <https://docs.example.org/a>",
      "",
      "",
      "",
      "Setext title",
      "===",
      "***",
      "[ref]: https://example.com/reference",
    ].join("\r\n"))).toBe([
      "Plan.",
      "Here is the plan with care, stress, weight, old and npm test.",
      "First step.",
      "Second diagram.",
      "2. Numbered item.",
      "Quoted line",
      "See example.com. Or docs.example.org",
      "",
      "Setext title",
    ].join("\n"));
  });

  it("keeps identifiers, arithmetic and escaped symbols as written", () => {
    expect(speakableText(
      "Set max_tokens to 2*3*4, not \\*bold\\*, in file_name_here.",
    )).toBe("Set max_tokens to 2*3*4, not *bold*, in file_name_here.");
  });

  it("points to the screen for code and tables instead of reading them", () => {
    expect(speakableText([
      "Run this:",
      "```ts",
      "const token = \"secret\";",
      "```",
      "~~~",
      "more code",
      "~~~",
      "Then compare:",
      "",
      "| Name | Age |",
      "| --- | ---: |",
      "| Ada | 36 |",
      "After the table.",
      "```` an unclosed fence runs to the end",
      "```",
      "a shorter fence does not close it",
      "```` nor does a fence with text",
      "still code",
    ].join("\n"))).toBe([
      "Run this:",
      "The code is on screen.",
      "Then compare:",
      "",
      "The table is on screen.",
      "After the table.",
      "The code is on screen.",
    ].join("\n"));
  });

  it("does not take a code span or divider for a code block or table", () => {
    expect(speakableText("```js `x` here\nA | B\n---\nEnd")).toBe("js x here\nA | B\n\nEnd");
  });

  it("points to the screen when nothing else can be read aloud", () => {
    expect(speakableText("![](https://example.com/x.png)\n---\n<br>")).toBe(
      "The answer is on screen.",
    );
  });
});

describe("speech chunk code fences", () => {
  it("closes a code block a split leaves open and reopens it in the next chunk", () => {
    const chunks = balanceCodeFences([
      "Intro.\n```ts\nconst a = 1;",
      "const b = 2;",
      "const c = 3;\n```\nAfter code.",
      "Plain.",
    ]);

    expect(chunks).toEqual([
      "Intro.\n```ts\nconst a = 1;\n```",
      "```\nconst b = 2;\n```",
      "```\nconst c = 3;\n```\nAfter code.",
      "Plain.",
    ]);
    expect(chunks.map(speakableText)).toEqual([
      "Intro.\nThe code is on screen.",
      "The code is on screen.",
      "The code is on screen.\nAfter code.",
      "Plain.",
    ]);
  });

  it("bounds the marker it adds, so a chunk grows by only a few characters", () => {
    const long = "`".repeat(30);
    const short = "`".repeat(20);
    const chunks = balanceCodeFences([`Intro.\n${long}`, `code\n${long}\nAfter.`]);

    expect(chunks).toEqual([`Intro.\n${long}\n${short}`, `${short}\ncode\n${long}\nAfter.`]);
    expect(speakableText(chunks[1])).toBe("The code is on screen.\nAfter.");
  });
});
