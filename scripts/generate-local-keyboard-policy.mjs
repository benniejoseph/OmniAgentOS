import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(await readFile(path.join(root, "src/lib/local-computer/keyboard-policy.json"), "utf8"));
const namePattern = /^[a-z0-9][a-z0-9_]*$/;
for (const [name, code] of Object.entries(policy.keys)) {
  if (!namePattern.test(name) || !Number.isInteger(code) || code < 0 || code > 127) {
    throw new Error("Invalid local keyboard key.");
  }
}
for (const [alias, target] of Object.entries(policy.aliases)) {
  if (!namePattern.test(alias) || alias in policy.keys || !(target in policy.keys)) {
    throw new Error("Invalid local keyboard alias.");
  }
}
if (!policy.legacyKeys.every((key) => key in policy.keys)) throw new Error("Invalid legacy keyboard key.");

const targets = [
  {
    file: "apps/flutter/macos/ComputerUseHelper/HelperMain.swift",
    lines: [
      "  private static let keyboardCodes: [String: CGKeyCode] = [",
      ...Object.entries(policy.keys).map(([key, code]) => `    "${key}": ${code},`),
      "  ]",
      "  private static let keyboardAliases: [String: String] = [",
      ...Object.entries(policy.aliases).map(([alias, key]) => `    "${alias}": "${key}",`),
      "  ]",
    ],
  },
  {
    file: "apps/flutter/lib/core/platform/local_computer_bridge.dart",
    lines: [
      "  static const _keyboardKeys = <String>{",
      ...[...Object.keys(policy.keys), ...Object.keys(policy.aliases)].map((key) => `    '${key}',`),
      "  };",
    ],
  },
];
for (const target of targets) {
  const file = path.join(root, target.file);
  const source = await readFile(file, "utf8");
  const start = "  // BEGIN GENERATED local keyboard policy";
  const end = "  // END GENERATED local keyboard policy";
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  if (from < 0 || to < from || source.indexOf(start, from + start.length) >= 0) {
    throw new Error(`Missing unique keyboard policy region in ${target.file}.`);
  }
  const replacement = [start,
    "  // From src/lib/local-computer/keyboard-policy.json; regenerate with",
    "  // node scripts/generate-local-keyboard-policy.mjs.",
    ...target.lines, end].join("\n");
  const updated = source.slice(0, from) + replacement + source.slice(to + end.length);
  if (source !== updated) await writeFile(file, updated);
}
