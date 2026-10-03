import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve("src");

type Repository = {
  read: (file: string) => string;
  isFile: (file: string) => boolean;
};

type Forbidden = { modules: string[]; packages: string[] };

const TODAY_ENTRIES = ["app/layout.tsx", "app/app/layout.tsx", "app/app/page.tsx"];

// The agent engines and the packages only they use. Today read them through
// the approval queue, a workflow's Command context and project execution, and
// a cold dashboard load spent its budget evaluating 7.9 MB of server chunks.
const AGENT_ENGINES: Forbidden = {
  modules: [
    "lib/app-services/tool-dispatcher.ts",
    "lib/command/context-reference-runtime.ts",
    "lib/connectors/mcp-client.ts",
    "lib/delegation/runtime.ts",
    "lib/diagnostics/health.ts",
    "lib/operations/recovery.ts",
    "lib/projects/execution.ts",
    "lib/storage/object-plane.ts",
    "lib/subagents/scheduler.ts",
    "lib/tools/executor.ts",
    "lib/workflows/executor.ts",
    "lib/workflows/runner.ts",
    "lib/workflows/triggers.ts",
  ],
  packages: [
    "@modelcontextprotocol/sdk",
    "@simplewebauthn/server",
    "@vercel/blob",
    "@vercel/sandbox",
    "ajv",
    "ffmpeg-static",
    "jszip",
    "pptxgenjs",
    "undici",
    "yaml",
  ],
};

/** The specifiers a module loads as it is evaluated, other than types. */
function staticImports(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (!importsOnlyTypes(statement.importClause)) imports.push(statement.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      if (!exportsOnlyTypes(statement)) imports.push(statement.moduleSpecifier.text);
    }
  }
  return imports;
}

function importsOnlyTypes(clause: ts.ImportClause | undefined) {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    !clause.name &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function exportsOnlyTypes(declaration: ts.ExportDeclaration) {
  if (declaration.isTypeOnly) return true;
  const clause = declaration.exportClause;
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  );
}

function resolveModule(repository: Repository, from: string, specifier: string) {
  const base = specifier.startsWith("@/")
    ? path.join(sourceRoot, specifier.slice(2))
    : path.resolve(path.dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]
    .find((candidate) => /\.tsx?$/.test(candidate) && repository.isFile(candidate));
}

function packageName(specifier: string) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/**
 * The chain to each forbidden module or package a server render of the
 * entries loads before it runs. A dynamic `import()` loads only when it is
 * called, so it is not followed, and neither is a forbidden module's own graph.
 */
function forbiddenInServerGraph(repository: Repository, entries: string[], forbidden: Forbidden) {
  const modules = new Set(forbidden.modules);
  const packages = new Set(forbidden.packages);
  const parents = new Map<string, string | undefined>();
  const queue = entries.map((entry) => path.join(sourceRoot, entry));
  for (const file of queue) parents.set(file, undefined);
  const chainTo = (file: string) => {
    const chain: string[] = [];
    for (let link: string | undefined = file; link; link = parents.get(link)) {
      chain.unshift(path.relative(sourceRoot, link));
    }
    return chain;
  };
  const found: string[] = [];
  const reportedPackages = new Set<string>();
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (modules.has(path.relative(sourceRoot, next))) {
      found.push(chainTo(next).join(" -> "));
      continue;
    }
    for (const specifier of staticImports(next, repository.read(next))) {
      if (specifier.startsWith("@/") || specifier.startsWith(".")) {
        const resolved = resolveModule(repository, next, specifier);
        if (resolved && !parents.has(resolved)) {
          parents.set(resolved, next);
          queue.push(resolved);
        }
        continue;
      }
      const name = packageName(specifier);
      if (packages.has(name) && !reportedPackages.has(name)) {
        reportedPackages.add(name);
        found.push([...chainTo(next), name].join(" -> "));
      }
    }
  }
  return { found, reached: parents.size };
}

const sourceTree: Repository = {
  read: (file) => readFileSync(file, "utf8"),
  isFile: (file) => existsSync(file) && statSync(file).isFile(),
};

function repositoryOf(sources: Record<string, string>): Repository {
  const files = Object.keys(sources).map((name) => path.join(sourceRoot, name));
  return {
    read: (file) => sources[path.relative(sourceRoot, file)]!,
    isFile: (file) => files.includes(file),
  };
}

describe("what a Today render loads on the server", () => {
  it("loads none of the agent engines", () => {
    const { found, reached } = forbiddenInServerGraph(sourceTree, TODAY_ENTRIES, AGENT_ENGINES);

    // Every page shares one function, and the dashboard's first cold
    // response has to fit its budget; an engine Today needs at run time
    // belongs behind a dynamic import.
    expect(found).toEqual([]);
    expect(reached).toBeGreaterThan(100);
  }, 60_000);

  it("names the chain to each one, following only what a render loads", () => {
    const { found, reached } = forbiddenInServerGraph(repositoryOf({
      "app/app/page.tsx": [
        'import "server-only";',
        'import { today } from "@/lib/today";',
        'import type { Run } from "@/lib/runner";',
        'import { type Step } from "@/lib/steps";',
        'export type { Plan } from "@/lib/plans";',
        'export { widget } from "./widgets";',
        'const later = () => import("@/lib/lazy");',
      ].join("\n"),
      "app/app/widgets/index.ts": 'import { put } from "@vercel/blob/client";',
      "lib/today.ts": 'import { summary } from "./summary";\nimport { z } from "zod";',
      "lib/summary.ts": 'export * from "@/lib/runner";\nimport { put } from "@vercel/blob";',
      "lib/runner.ts": 'import { Sandbox } from "@vercel/sandbox";',
      "lib/steps.ts": 'import YAML from "yaml";',
      "lib/plans.ts": 'import YAML from "yaml";',
      "lib/lazy.ts": 'import JSZip from "jszip";',
    }), ["app/app/page.tsx"], {
      modules: ["lib/runner.ts"],
      packages: ["@vercel/blob", "@vercel/sandbox", "jszip", "yaml"],
    });

    expect(found).toEqual([
      "app/app/page.tsx -> app/app/widgets/index.ts -> @vercel/blob",
      "app/app/page.tsx -> lib/today.ts -> lib/summary.ts -> lib/runner.ts",
    ]);
    expect(reached).toBe(5);
  });
});
