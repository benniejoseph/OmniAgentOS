import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findSmallType,
  listTypeSources,
  MINIMUM_FONT_PX,
} from "../../scripts/check-type-scale.mjs";

const script = path.resolve("scripts/check-type-scale.mjs");
const directories: string[] = [];

function directoryWith(files: Record<string, string>) {
  const directory = mkdtempSync(path.join(tmpdir(), "type-scale-"));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), text);
  }
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the type scale", () => {
  it("finds stylesheet sizes below the Detail size", () => {
    expect(MINIMUM_FONT_PX).toBe(12);
    const css = [
      ".a { font-size: .74rem; }",
      ".b { font-size: 0.75rem; }",
      ".c { font-size:11.5px }",
      ".d { font-size: 12px; }",
      ".e { font-size: clamp(.6rem, 1vw, 1rem); }",
      ".f { font-size: clamp(1rem, 2vw, 2rem); }",
      ".g { font-size: .8em; font-size: 80%; font-size: var(--size); }",
    ].join("\n");

    expect(findSmallType("view.module.css", css).map(({ line, text, px }) => [line, text, px]))
      .toEqual([
        [1, "font-size:.74rem", 11.84],
        [3, "font-size:11.5px", 11.5],
        [5, "font-size:clamp(.6rem", 9.6],
      ]);
  });

  it("finds a component's small Tailwind and inline sizes", () => {
    const component = [
      '<p className="text-[11px] sm:text-[10px] text-xs">',
      '<p className="text-[12px] text-[0.75rem] context-[9px]">',
      '<text fontSize="10" /><span style={{ fontSize: 11 }} /><b style={{ fontSize: "0.7rem" }} />',
      '<span style={{ fontSize: 12 }} /><code className="text-[0.7em]" />',
      '<i style={{ fontSize: "0.7em" }} /><i style={{ fontSize: "80%" }} />',
    ].join("\n");

    expect(findSmallType("view.tsx", component).map(({ line, text }) => [line, text])).toEqual([
      [1, "text-[11px]"],
      [1, "text-[10px]"],
      [3, "fontSize=10"],
      [3, "fontSize:11"],
      [3, "fontSize:0.7rem"],
    ]);
    // Elsewhere a fontSize may be points in a generated document.
    expect(
      findSmallType("slides.ts", 'addText("Note", { fontSize: 9 }); const label = "text-[10px]";')
        .map(({ text }) => text),
    ).toEqual(["text-[10px]"]);
  });

  it("checks stylesheets and modules, but not tests", async () => {
    const directory = directoryWith(Object.fromEntries(
      ["a.css", "nested/b.tsx", "nested/c.ts", "d.mjs", "e.test.ts", "nested/f.test.tsx", "g.md"]
        .map((name) => [name, ""]),
    ));

    expect((await listTypeSources(directory)).map((file: string) => path.relative(directory, file)))
      .toEqual(["a.css", "d.mjs", "nested/b.tsx", "nested/c.ts"]);
  });
});

describe("checking the type scale", () => {
  it("passes the repository's components", () => {
    const run = spawnSync(process.execPath, [script], { encoding: "utf8" });

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^PASS \d+ files set no type below 12px\.\n$/);
  });

  it("fails a directory that sets small type, naming each place", () => {
    const directory = directoryWith({
      "view.module.css": ".a {\n  font-size: .6rem;\n}\n",
      "nested/view.tsx": '<p className="text-[11px]" />\n',
      "view.test.tsx": '<p className="text-[9px]" />\n',
    });
    const run = spawnSync(process.execPath, [script, "."], { cwd: directory, encoding: "utf8" });

    expect(run.status).toBe(1);
    expect(run.stderr).toBe([
      "FAIL nested/view.tsx:1 sets text-[11px], 11px, below the 12px Detail size.",
      "FAIL view.module.css:2 sets font-size:.6rem, 9.6px, below the 12px Detail size.",
      "",
    ].join("\n"));
  });
});
