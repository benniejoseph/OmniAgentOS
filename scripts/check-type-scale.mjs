#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The smallest size in the type scale in DESIGN.md: Detail, 12px. */
export const MINIMUM_FONT_PX = 12;

const ROOT_FONT_PX = 16;
const SOURCE_DIRECTORY = fileURLToPath(new URL("../src/", import.meta.url));
const SIZE = String.raw`(?<size>\d*\.?\d+)`;
const CSS_SIZES = [
  new RegExp(String.raw`font-size\s*:\s*${SIZE}(?<unit>px|rem)\b`, "g"),
  // A clamp's first argument is the smallest size it allows.
  new RegExp(String.raw`font-size\s*:\s*clamp\(\s*${SIZE}(?<unit>px|rem)\b`, "g"),
];
// A Tailwind arbitrary size, with or without a variant.
const CLASS_SIZES = [
  new RegExp(String.raw`(?<![\w-])text-\[${SIZE}(?<unit>px|rem)\]`, "g"),
];
const COMPONENT_SIZES = [
  ...CLASS_SIZES,
  // An inline style or an SVG attribute, where a bare number is pixels.
  new RegExp(String.raw`\bfontSize\s*[:=]\s*\{?\s*["'\x60]?${SIZE}(?<unit>px|rem)?(?![\w.%])`, "g"),
];

/**
 * Lists the type a file sets below the minimum: a CSS font-size or clamp
 * floor in px or rem, a Tailwind arbitrary text size, or a component's
 * inline fontSize. Sizes relative to their parent, in em or %, are not
 * judged, nor are other modules' fontSize values, which may be points in a
 * generated document.
 */
export function findSmallType(file, text) {
  const patterns = file.endsWith(".css")
    ? CSS_SIZES
    : /\.[jt]sx$/.test(file)
      ? COMPONENT_SIZES
      : CLASS_SIZES;
  const findings = [];
  text.split("\n").forEach((line, index) => {
    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        const { size, unit = "px" } = match.groups;
        const px = Number(size) * (unit === "rem" ? ROOT_FONT_PX : 1);
        if (px < MINIMUM_FONT_PX) {
          findings.push({ file, line: index + 1, text: match[0].replace(/[\s"'\x60{]/g, ""), px });
        }
      }
    }
  });
  return findings;
}

/** The stylesheets and components under a directory, without their tests. */
export async function listTypeSources(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(css|[cm]?[jt]sx?)$/.test(entry.name) &&
        !/\.test\.[cm]?[jt]sx?$/.test(entry.name),
    )
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function main() {
  const directory = process.argv[2] ? path.resolve(process.argv[2]) : SOURCE_DIRECTORY;
  const files = await listTypeSources(directory);
  const findings = [];
  for (const file of files) {
    findings.push(...findSmallType(file, await readFile(file, "utf8")));
  }
  if (findings.length > 0) {
    for (const { file, line, text, px } of findings) {
      console.error(
        `FAIL ${path.relative(process.cwd(), file)}:${line} sets ${text}, ${Number(px.toFixed(2))}px, below the ${MINIMUM_FONT_PX}px Detail size.`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${files.length} files set no type below ${MINIMUM_FONT_PX}px.`);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(
      `FAIL ${error instanceof Error ? error.message : "the type scale could not be checked."}`,
    );
    process.exitCode = 1;
  });
}
