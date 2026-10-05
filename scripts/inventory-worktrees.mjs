#!/usr/bin/env node
// Read-only local inventory. No fetch, checkout, cleanup, or credential reads.
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: node scripts/inventory-worktrees.mjs [--base origin/main]\nRun from any checkout. Reports local Git state as JSON; does not fetch or remove anything.");
  process.exit(0);
}
if (args.length !== 0 && !(args.length === 2 && args[0] === "--base" && args[1])) {
  console.error("Expected no arguments or --base <revision>. Use --help.");
  process.exit(1);
}

const base = args[1] ?? "origin/main";
const deadline = Date.now() + 90_000;
const localPaths = [
  "node_modules", ".next", "apps/flutter/build", "apps/flutter/.dart_tool",
  ".vercel", "supabase/.temp", ".env", ".env.local", ".env.production",
];

function git(cwd, command, allowed = [0]) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Inventory exceeded its 90-second limit");
  const result = spawnSync("git", ["-C", cwd, ...command], {
    encoding: "utf8", timeout: Math.min(10_000, remaining), maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || !allowed.includes(result.status)) {
    throw new Error(`git ${command[0]} failed (${result.error?.code ?? result.status ?? result.signal})`);
  }
  return result;
}

function localState(cwd, relativePath) {
  let cursor = cwd;
  try {
    const segments = relativePath.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      cursor = join(cursor, segments[index]);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) return { path: relativePath, kind: "symlink_not_followed" };
      if (index === segments.length - 1) return { path: relativePath, kind: stat.isDirectory() ? "directory" : "file" };
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return { path: relativePath, kind: "unreadable" };
  }
  return null;
}

function statusCounts(output) {
  const entries = output.split("\0");
  let tracked = 0;
  let untracked = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    if (status === "??") untracked += 1;
    else tracked += 1;
    if (/[RC]/.test(status)) index += 1;
  }
  return { tracked, untrackedEntries: untracked, clean: tracked === 0 && untracked === 0 };
}

try {
  const repository = git(process.cwd(), ["rev-parse", "--show-toplevel"]).stdout.trim();
  const baseSha = git(repository, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).stdout.trim();
  const raw = git(repository, ["worktree", "list", "--porcelain", "-z"]).stdout;
  const records = raw.split("\0\0").filter(Boolean);
  if (records.length > 100) throw new Error("Refusing more than 100 worktrees in one inventory");
  const worktrees = records.map((record) => {
    const fields = Object.fromEntries(record.split("\0").filter(Boolean).map((line) => {
      const separator = line.indexOf(" ");
      return separator === -1 ? [line, true] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    const row = { path: fields.worktree, branch: typeof fields.branch === "string" ? fields.branch.replace(/^refs\/heads\//, "") : null, head: fields.HEAD ?? null, locked: Boolean(fields.locked), prunable: Boolean(fields.prunable) };
    try {
      if (!row.head || !/^[a-f0-9]{40,64}$/.test(row.head)) throw new Error("Missing or unsupported worktree HEAD");
      if (lstatSync(row.path).isSymbolicLink()) throw new Error("Worktree root is a symlink; not followed");
      const counts = git(repository, ["rev-list", "--left-right", "--count", `${baseSha}...${row.head}`]).stdout.trim().split(/\s+/).map(Number);
      row.behindBase = counts[0];
      row.aheadOfBase = counts[1];
      row.headReachableFromBase = git(repository, ["merge-base", "--is-ancestor", row.head, baseSha], [0, 1]).status === 0;
      row.status = statusCounts(git(row.path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]).stdout);
      row.localState = localPaths.map((path) => localState(row.path, path)).filter(Boolean);
      row.currentCheckout = resolve(row.path) === resolve(repository);
      row.review = row.headReachableFromBase ? "History reachable; review owner and ignored files before archiving" : "History not reachable; compare patches and preserve work before archiving";
    } catch (error) {
      row.error = error.message;
    }
    return row;
  });
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(), repository, base, baseSha,
    limits: { readOnly: true, fetchedRemote: false, localStateContentsRead: false, archiveDecisionsMade: false },
    summary: {
      total: worktrees.length,
      clean: worktrees.filter((row) => row.status?.clean).length,
      headReachableFromBase: worktrees.filter((row) => row.headReachableFromBase).length,
      errors: worktrees.filter((row) => row.error).length,
    },
    worktrees,
  }, null, 2));
  if (worktrees.some((row) => row.error)) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
