import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve("src");
const nodeModules = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

type Repository = {
  files: string[];
  read: (file: string) => string;
  isFile: (file: string) => boolean;
};

type Module = { imports: string[]; directives: string[] };

function parseModule(file: string, text: string): Module {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!importsOnlyTypes(node.importClause)) imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!exportsOnlyTypes(node)) imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const directives: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    directives.push(statement.expression.text);
  }
  return { imports, directives };
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

/** The repository module a specifier names, or undefined for a package. */
function resolveModule(repository: Repository, from: string, specifier: string) {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(sourceRoot, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return undefined;
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]
    .find((candidate) => /\.tsx?$/.test(candidate) && repository.isFile(candidate));
}

/**
 * Each Node built-in the browser would be sent: one a "use client" module
 * reaches through imports not marked as types only. A server action module
 * reaches the browser only as a reference, so its imports are not followed.
 */
function nodeImportsInClientGraph(repository: Repository) {
  const modules = new Map<string, Module>();
  const read = (file: string) => {
    let parsed = modules.get(file);
    if (!parsed) {
      parsed = parseModule(file, repository.read(file));
      modules.set(file, parsed);
    }
    return parsed;
  };
  const parents = new Map<string, string | undefined>();
  const queue: string[] = [];
  for (const file of repository.files) {
    if (read(file).directives.includes("use client")) {
      parents.set(file, undefined);
      queue.push(file);
    }
  }
  const clientModules = queue.length;
  const found: string[] = [];
  for (let next = queue.shift(); next; next = queue.shift()) {
    for (const specifier of read(next).imports) {
      if (nodeModules.has(specifier) || specifier === "server-only") {
        const chain = [specifier];
        for (let file: string | undefined = next; file; file = parents.get(file)) {
          chain.unshift(path.relative(sourceRoot, file));
        }
        found.push(chain.join(" -> "));
        continue;
      }
      const resolved = resolveModule(repository, next, specifier);
      if (resolved && !parents.has(resolved) && !read(resolved).directives.includes("use server")) {
        parents.set(resolved, next);
        queue.push(resolved);
      }
    }
  }
  return { found, clientModules, reached: parents.size };
}

const sourceTree: Repository = {
  files: readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
    .map((name) => path.join(sourceRoot, name)),
  read: (file) => readFileSync(file, "utf8"),
  isFile: (file) => existsSync(file) && statSync(file).isFile(),
};

function repositoryOf(sources: Record<string, string>): Repository {
  const files = Object.keys(sources).map((name) => path.join(sourceRoot, name));
  return {
    files,
    read: (file) => sources[path.relative(sourceRoot, file)]!,
    isFile: (file) => files.includes(file),
  };
}

describe("what the browser bundle can reach", () => {
  it("never reaches a Node built-in from a client module", () => {
    const { found, clientModules, reached } = nodeImportsInClientGraph(sourceTree);
    // A Node module in this graph is bundled for the browser, through a
    // polyfill: Node's crypto alone added 553 KB to the accounts page.
    expect(found).toEqual([]);
    expect(clientModules).toBeGreaterThan(50);
    expect(reached).toBeGreaterThan(clientModules);
  }, 60_000);

  it("names the chain to each one, following only what the browser loads", () => {
    const { found, clientModules } = nodeImportsInClientGraph(repositoryOf({
      "components/panel.tsx": [
        '"use client";',
        'import { kinds } from "@/lib/kinds";',
        'import { save } from "@/lib/action";',
        'import type { Row } from "@/lib/rows";',
        'import { type Cell } from "@/lib/cells";',
        'export type { Grid } from "@/lib/grids";',
        'export { type Shape } from "@/lib/shapes";',
        'export { widget } from "@/lib/widgets";',
        'import { z } from "zod";',
        'const later = () => import("./lazy");',
      ].join("\n"),
      "components/lazy.tsx": 'export * from "../lib/reexport";',
      "lib/kinds.ts": 'import { createHash } from "crypto";',
      "lib/action.ts": '"use server";\nimport { randomUUID } from "node:crypto";',
      "lib/rows.ts": 'import fs from "node:fs";',
      "lib/cells.ts": 'import fs from "node:fs";',
      "lib/grids.ts": 'import fs from "node:fs";',
      "lib/shapes.ts": 'import fs from "node:fs";',
      "lib/widgets/index.ts": 'import os from "node:os";',
      "lib/reexport.ts": 'import "server-only";',
      "lib/server.ts": 'import net from "node:net";\n"use client";',
    }));

    expect(clientModules).toBe(1);
    expect(found).toEqual([
      "components/panel.tsx -> lib/kinds.ts -> crypto",
      "components/panel.tsx -> lib/widgets/index.ts -> node:os",
      "components/panel.tsx -> components/lazy.tsx -> lib/reexport.ts -> server-only",
    ]);
  });
});
