import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

export type SqlMigrationLedgerRow = Readonly<{
  version: number;
  name: string;
  checksum: string;
}>;

/** One ordered migration file, parsed into statements the runner can execute. */
export type SqlMigrationFile = Readonly<{
  file: string;
  /** Top-level statements, without the file's own BEGIN and COMMIT. */
  statements: readonly string[];
  /** The file's own number for the first of those statements, from 1. */
  firstStatement: number;
  /** The omni_schema_version rows the file inserts. */
  ledger: readonly SqlMigrationLedgerRow[];
  /** Settings the file may change; the runner restores them afterwards. */
  settings: readonly string[];
}>;

const MIGRATION_FILE_NAME = /^\d{14}_[a-z0-9_]+\.sql$/;
const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$\u0080-\uffff]/;
const IDENTIFIER_RUN = /[A-Za-z0-9_$\u0080-\uffff]+/y;
const DOLLAR_QUOTE_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;
const TRANSACTION_CONTROL = new Set([
  "ABORT",
  "BEGIN",
  "COMMIT",
  "END",
  "PREPARE",
  "RELEASE",
  "ROLLBACK",
  "SAVEPOINT",
  "START",
]);

export function sqlMigrationFilePath(file: string) {
  if (!MIGRATION_FILE_NAME.test(file)) {
    throw new Error(`Invalid SQL migration file name: ${file}.`);
  }
  return path.join(process.cwd(), "supabase", "migrations", file);
}

export async function readSqlMigrationFile(file: string) {
  return parseSqlMigrationFile(file, await readFile(sqlMigrationFilePath(file), "utf8"));
}

/**
 * Parses a migration file for execution inside the runner's transaction. A
 * file may wrap itself in one BEGIN and COMMIT, which are removed as a pair;
 * any other transaction control or session-level setting is rejected because
 * it would commit, split, or outlive the runner's transaction.
 */
export function parseSqlMigrationFile(file: string, text: string): SqlMigrationFile {
  const statements = splitSqlStatements(text);
  const opens = isBareTransactionStatement(statements[0], "BEGIN");
  const closes = isBareTransactionStatement(statements.at(-1), "COMMIT");
  if (opens !== closes) {
    throw new Error(`${file} must begin with a plain BEGIN and end with a plain COMMIT, or have neither.`);
  }
  const body = opens ? statements.slice(1, -1) : statements;
  const firstStatement = opens ? 2 : 1;
  if (!body.length) {
    throw new Error(`${file} has no statements.`);
  }
  const ledger: SqlMigrationLedgerRow[] = [];
  const settings = new Set<string>();
  body.forEach((statement, index) => {
    const words = topLevelWords(statement);
    const [first, second, third] = words;
    const problem = TRANSACTION_CONTROL.has(first)
      ? "controls the transaction"
      : first === "RESET" || first === "DISCARD" ||
          (first === "SET" && second !== "LOCAL" && second !== "CONSTRAINTS") ||
          (first === "SET" && second === "LOCAL" && (third === "ROLE" || third === "SESSION"))
        ? "changes session state"
        : first === "VACUUM" || words.includes("CONCURRENTLY")
          ? "cannot run inside the migration transaction"
          : null;
    if (problem) {
      throw new Error(
        `${file} statement ${index + firstStatement} (${describeSqlStatement(statement)}) ${problem}.`,
      );
    }
    const localSetting = first === "SET" && second === "LOCAL"
      ? /^SET\s+LOCAL\s+([A-Za-z_][A-Za-z0-9_.]*)/i.exec(withoutLeadingComments(statement))
      : null;
    if (localSetting) {
      settings.add(localSetting[1].toLowerCase());
    }
    if (
      first === "INSERT" &&
      second === "INTO" &&
      (third === "OMNI_SCHEMA_VERSION" ||
        (third === "PUBLIC" && words[3] === "OMNI_SCHEMA_VERSION"))
    ) {
      ledger.push(...parseLedgerRows(file, statement));
    }
  });
  for (const match of text.matchAll(/set_config\(\s*'([A-Za-z0-9_.]+)'/g)) {
    settings.add(match[1].toLowerCase());
  }
  return Object.freeze({
    file,
    statements: Object.freeze(body),
    firstStatement,
    ledger: Object.freeze(ledger),
    settings: Object.freeze([...settings]),
  });
}

/**
 * Splits PostgreSQL script text into top-level statements. Comments, string
 * literals, quoted identifiers, dollar quotes, and parentheses are opaque, so
 * function bodies, DO blocks, and multi-statement rules stay whole. Empty and
 * comment-only statements are dropped.
 */
export function splitSqlStatements(text: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let index = 0;
  const push = (end: number) => {
    const statement = text.slice(start, end).trim();
    if (topLevelWords(statement).length) {
      statements.push(statement);
    }
  };
  while (index < text.length) {
    const skipped = skipOpaque(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const character = text[index];
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) {
        throw new Error("SQL has an unmatched closing parenthesis.");
      }
    } else if (character === ";" && depth === 0) {
      push(index);
      start = index + 1;
    }
    index += 1;
  }
  if (depth !== 0) {
    throw new Error("SQL has an unclosed parenthesis.");
  }
  push(text.length);
  return statements;
}

function withoutLeadingComments(statement: string) {
  let index = 0;
  while (index < statement.length) {
    if (/\s/.test(statement[index])) {
      index += 1;
    } else if (statement.startsWith("--", index) || statement.startsWith("/*", index)) {
      index = skipOpaque(statement, index);
    } else {
      break;
    }
  }
  return statement.slice(index);
}

/**
 * Upper-cased words outside comments, literals, and quoted identifiers. A word
 * is a whole run of identifier characters, so a keyword inside a longer
 * identifier is never read on its own.
 */
function topLevelWords(statement: string) {
  const words: string[] = [];
  let index = 0;
  while (index < statement.length) {
    const skipped = skipOpaque(statement, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    IDENTIFIER_RUN.lastIndex = index;
    const word = IDENTIFIER_RUN.exec(statement)?.[0];
    if (word) {
      words.push(word.toUpperCase());
      index += word.length;
      continue;
    }
    index += 1;
  }
  return words;
}

/**
 * Returns the index after the comment, literal, quoted identifier, or dollar
 * quote that starts at `index`, or `index` itself when none starts there.
 */
function skipOpaque(text: string, index: number) {
  const character = text[index];
  const next = text[index + 1];
  if (character === "-" && next === "-") {
    const end = text.indexOf("\n", index + 2);
    return end < 0 ? text.length : end + 1;
  }
  if (character === "/" && next === "*") {
    return skipBlockComment(text, index);
  }
  if (character === "'") {
    return skipQuoted(text, index, "'", isEscapeStringPrefix(text, index));
  }
  if (character === '"') {
    return skipQuoted(text, index, '"', false);
  }
  if (character === "$" && !IDENTIFIER_CHARACTER.test(text[index - 1] ?? " ")) {
    const tag = DOLLAR_QUOTE_TAG.exec(text.slice(index, index + 128))?.[0];
    if (tag) {
      const close = text.indexOf(tag, index + tag.length);
      if (close < 0) {
        throw new Error(`SQL has an unterminated ${tag} quote.`);
      }
      return close + tag.length;
    }
  }
  return index;
}

function skipBlockComment(text: string, index: number) {
  let depth = 0;
  let cursor = index;
  while (cursor < text.length) {
    if (text[cursor] === "/" && text[cursor + 1] === "*") {
      depth += 1;
      cursor += 2;
    } else if (text[cursor] === "*" && text[cursor + 1] === "/") {
      depth -= 1;
      cursor += 2;
      if (depth === 0) {
        return cursor;
      }
    } else {
      cursor += 1;
    }
  }
  throw new Error("SQL has an unterminated block comment.");
}

function skipQuoted(text: string, index: number, quote: string, backslashEscapes: boolean) {
  let cursor = index + 1;
  while (cursor < text.length) {
    const character = text[cursor];
    if (backslashEscapes && character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === quote) {
      if (text[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  throw new Error(`SQL has an unterminated ${quote} quote.`);
}

/** True for E'...' strings, where backslash escapes the next character. */
function isEscapeStringPrefix(text: string, quoteIndex: number) {
  const prefix = text[quoteIndex - 1];
  return (
    (prefix === "E" || prefix === "e") &&
    !IDENTIFIER_CHARACTER.test(text[quoteIndex - 2] ?? " ")
  );
}

function isBareTransactionStatement(statement: string | undefined, keyword: string) {
  if (!statement) return false;
  const words = topLevelWords(statement);
  return (
    words[0] === keyword &&
    (words.length === 1 ||
      (words.length === 2 && (words[1] === "TRANSACTION" || words[1] === "WORK")))
  );
}

function parseLedgerRows(file: string, statement: string): SqlMigrationLedgerRow[] {
  const rows = [
    ...statement.matchAll(/(\d+)\s*,\s*'([a-z0-9_]+)'\s*,\s*'([a-f0-9]{64})'/g),
  ].map((match) => Object.freeze({
    version: Number(match[1]),
    name: match[2],
    checksum: match[3],
  }));
  if (!rows.length) {
    throw new Error(`${file} writes omni_schema_version without a literal version row.`);
  }
  return rows;
}

/** A one-line, bounded description of a statement for error messages. */
export function describeSqlStatement(statement: string) {
  const text = (withoutLeadingComments(statement).split("\n")[0] ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

type MigrationSql = Readonly<{
  unsafe: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

/**
 * Runs a parsed migration file inside the caller's transaction. Settings the
 * file changes are put back afterwards so they cannot leak into later
 * migrations, and the ledger rows the file writes must match the manifest.
 */
export async function applySqlMigrationFile(
  sql: MigrationSql,
  migration: SqlMigrationFile,
  expected: readonly SqlMigrationLedgerRow[],
  restoredSettings: readonly string[],
) {
  const versions = expected.map((row) => row.version);
  if (!versions.length || !versions.every(Number.isSafeInteger)) {
    throw new Error(`${migration.file} has no valid expected versions.`);
  }
  assertLedgerRows(`${migration.file} declares`, migration.ledger, expected);
  const settings = [...new Set([...restoredSettings, ...migration.settings])];
  const before = await readSettings(sql, settings);
  for (const [index, statement] of migration.statements.entries()) {
    try {
      await sql.unsafe(statement);
    } catch (error) {
      throw new Error(
        `${migration.file} statement ${index + migration.firstStatement} (${describeSqlStatement(statement)}) failed: ${
          error instanceof Error ? error.message : "unknown statement error"
        }`,
        { cause: error },
      );
    }
  }
  const after = await readSettings(sql, settings);
  for (const [index, name] of settings.entries()) {
    if (after[index] !== before[index]) {
      await sql.unsafe("SELECT set_config($1, $2, true)", [name, before[index] ?? ""]);
    }
  }
  const recorded = await sql.unsafe(
    `SELECT version, name, checksum FROM omni_schema_version WHERE version IN (${versions.join(", ")})`,
  );
  assertLedgerRows(
    `${migration.file} wrote`,
    recorded.map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
    })),
    expected,
  );
}

async function readSettings(sql: MigrationSql, names: readonly string[]) {
  if (!names.length) return [];
  const [row] = await sql.unsafe(
    `SELECT ${names
      .map((_, index) => `current_setting($${index + 1}, true) AS setting_${index}`)
      .join(", ")}`,
    [...names],
  );
  return names.map((_, index) => {
    const value = row?.[`setting_${index}`];
    return value === null || value === undefined ? null : String(value);
  });
}

function assertLedgerRows(
  label: string,
  actual: readonly SqlMigrationLedgerRow[],
  expected: readonly SqlMigrationLedgerRow[],
) {
  const format = (rows: readonly SqlMigrationLedgerRow[]) =>
    rows
      .map((row) => `${row.version}:${row.name}:${row.checksum}`)
      .sort()
      .join(", ");
  if (format(actual) !== format(expected)) {
    throw new Error(
      `${label} migration ledger rows [${format(actual)}], but schema-migrations.json expects [${format(expected)}].`,
    );
  }
}
