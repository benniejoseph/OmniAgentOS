// Copies the This Mac command program policy into the native validators, so
// the server, the Flutter bridge, the app, and the command helper admit the
// same programs. With --check it only reports copies that have drifted.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const COMMAND_PROGRAM_POLICY_FILE =
  "src/lib/local-computer/command-program-policy.json";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const beginMarker = "// BEGIN GENERATED command program policy";
const endMarker = "// END GENERATED command program policy";
const programName = /^[a-z0-9][a-z0-9._+-]{0,63}$/;
const swiftLineWidth = 100;

export const COMMAND_PROGRAM_POLICY_TARGETS = Object.freeze([
  Object.freeze({
    file: "apps/flutter/macos/CommandRunnerHelper/HelperMain.swift",
    render: (policy, indent) => [
      ...swiftSet(indent, "static let programs", policy.programs),
      ...swiftSet(indent, "static let refusedTargets", policy.refusedTargets),
    ],
  }),
  Object.freeze({
    file: "apps/flutter/macos/Runner/AppDelegate.swift",
    render: (policy, indent) =>
      swiftSet(indent, "private static let commandPrograms", policy.programs),
  }),
  Object.freeze({
    file: "apps/flutter/lib/core/platform/local_computer_bridge.dart",
    render: (policy, indent) => [
      `${indent}static const _commandPrograms = <String>{`,
      ...policy.programs.map((name) => `${indent}  '${name}',`),
      `${indent}};`,
    ],
  }),
]);

/** Lists what is wrong with a policy; an empty list means it can be copied. */
export function commandProgramPolicyProblems(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["The policy must be an object."];
  }
  const problems = [];
  if (Object.keys(policy).sort().join() !== "programs,refusedTargets") {
    problems.push("The policy must hold only programs and refusedTargets.");
  }
  for (const key of ["programs", "refusedTargets"]) {
    const names = policy[key];
    if (!Array.isArray(names) || names.length === 0) {
      problems.push(`${key} must be a non-empty list.`);
      continue;
    }
    for (const name of names) {
      if (typeof name !== "string" || !programName.test(name)) {
        problems.push(`${key} holds an invalid program name: ${JSON.stringify(name)}.`);
      }
    }
    const ordered = [...new Set(names)].sort();
    if (ordered.length !== names.length || ordered.some((name, index) => name !== names[index])) {
      problems.push(`${key} must be sorted and hold each name once.`);
    }
  }
  if (Array.isArray(policy.programs) && Array.isArray(policy.refusedTargets)) {
    const refused = new Set(policy.refusedTargets);
    for (const name of policy.programs.filter((item) => refused.has(item))) {
      problems.push(`${name} is both a program and a refused target.`);
    }
  }
  return problems;
}

/** Reads the policy and returns each target file as it is and as it should be. */
export async function commandProgramPolicyOutputs(root = repositoryRoot) {
  const policy = JSON.parse(await readFile(path.join(root, COMMAND_PROGRAM_POLICY_FILE), "utf8"));
  const problems = commandProgramPolicyProblems(policy);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return Promise.all(COMMAND_PROGRAM_POLICY_TARGETS.map(async (target) => {
    const current = await readFile(path.join(root, target.file), "utf8");
    return { file: target.file, current, expected: renderRegion(current, target, policy) };
  }));
}

function renderRegion(source, target, policy) {
  const lines = source.split("\n");
  const markerLines = (marker) =>
    lines.flatMap((line, index) => (line.trim() === marker ? [index] : []));
  const begins = markerLines(beginMarker);
  const ends = markerLines(endMarker);
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
    throw new Error(`${target.file} must hold one generated command program policy region.`);
  }
  const [begin] = begins;
  const indent = lines[begin].slice(0, lines[begin].length - lines[begin].trimStart().length);
  return [
    ...lines.slice(0, begin),
    `${indent}${beginMarker}`,
    `${indent}// From ${COMMAND_PROGRAM_POLICY_FILE}; regenerate with`,
    `${indent}// npm run generate:command-program-policy.`,
    ...target.render(policy, indent),
    `${indent}${endMarker}`,
    ...lines.slice(ends[0] + 1),
  ].join("\n");
}

function swiftSet(indent, declaration, names) {
  const itemIndent = `${indent}  `;
  const lines = [`${indent}${declaration}: Set<String> = [`];
  let line = "";
  for (const item of names.map((name) => `"${name}",`)) {
    if (line && itemIndent.length + line.length + 1 + item.length > swiftLineWidth) {
      lines.push(itemIndent + line);
      line = item;
    } else {
      line = line ? `${line} ${item}` : item;
    }
  }
  if (line) lines.push(itemIndent + line);
  lines.push(`${indent}]`);
  return lines;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const stale = (await commandProgramPolicyOutputs())
    .filter((output) => output.current !== output.expected);
  if (checkOnly) {
    if (stale.length > 0) {
      throw new Error(
        `Stale command program policy in ${stale.map((output) => output.file).join(", ")}. ` +
          "Run npm run generate:command-program-policy.",
      );
    }
    console.log("Command program policy copies are current.");
    return;
  }
  for (const output of stale) {
    await writeFile(path.join(repositoryRoot, output.file), output.expected);
    console.log(`Updated ${output.file}`);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
