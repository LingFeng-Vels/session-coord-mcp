import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Database as BetterSqliteDatabase } from "better-sqlite3";

import { createConfig } from "../src/config.js";
import { CoordinationService } from "../src/core/coordination-service.js";
import { createDatabase } from "../src/db/database.js";
import { GitCommandError, GitService } from "../src/git/git-service.js";
import { VERSION } from "../src/version.js";

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-scope-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "coord-test@example.com"]);
  runGit(repo, ["config", "user.name", "Coord Test"]);
  runGit(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

function createService(workspaceRoot: string, defaultTtlMinutes = 30, stateRoot = workspaceRoot) {
  const dbPath = path.join(stateRoot, ".session-coord", "state.db");
  const db = createDatabase(dbPath);
  const config = createConfig({
    workspaceRoot,
    dbPath,
    defaultTtlMinutes,
  });
  return {
    db,
    service: new CoordinationService(db, config, new GitService()),
  };
}

function claimExpiry(db: BetterSqliteDatabase, sessionId: string, pathPattern: string): string {
  const row = db
    .prepare(
      `
        SELECT expires_at
        FROM path_claims
        WHERE session_id = ? AND path_pattern = ?
      `,
    )
    .get(sessionId, pathPattern) as { expires_at: string };
  return row.expires_at;
}

test("version is read from package.json", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(VERSION, packageJson.version);
  assert.equal(VERSION, "0.1.1");
});

test("task takeover fails without force_reason and succeeds with it", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-task-"));
  const { service } = createService(workspaceRoot);
  const owner = service.registerSession({ agent_name: "owner", host_type: "codex" });
  const other = service.registerSession({ agent_name: "other", host_type: "claude-code" });
  const created = service.createTask({
    title: "Ship scope checks",
    owner_session_id: owner.session_id,
  });

  assert.throws(
    () =>
      service.claimTask({
        task_id: created.task.id,
        session_id: other.session_id,
      }),
    /force_reason/,
  );

  const taken = service.claimTask({
    task_id: created.task.id,
    session_id: other.session_id,
    force_reason: "owner session is offline",
  });
  assert.equal(taken.forced, true);
  assert.equal(taken.task.owner_session_id, other.session_id);
});

test("validate_scope reports unclaimed files and keeps claimed files in scope", () => {
  const repo = createGitRepo();
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "claimed.ts"), "export const claimed = 1;\n");
  fs.writeFileSync(path.join(repo, "docs", "notes.md"), "# notes\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  fs.appendFileSync(path.join(repo, "src", "claimed.ts"), "export const extra = 2;\n");
  fs.appendFileSync(path.join(repo, "docs", "notes.md"), "more\n");

  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-state-"));
  const { service } = createService(repo, 30, stateRoot);
  const registered = service.registerSession({
    agent_name: "worker",
    host_type: "codex",
    worktree_path: repo,
  });
  service.claimPaths({
    session_id: registered.session_id,
    paths: ["src/claimed.ts"],
    claim_mode: "exclusive",
    reason: "edit claimed file",
  });

  const report = service.validateScope({ session_id: registered.session_id });
  assert.ok(report.changed_paths.includes("src/claimed.ts"));
  assert.ok(report.changed_paths.includes("docs/notes.md"));
  assert.deepEqual(report.out_of_scope_paths, ["docs/notes.md"]);
});

test("validate_scope keeps claimed emoji and CJK files in scope", () => {
  const emojiName = "😀 file.ts";
  const cjkName = "测试 文件.ts";
  const repo = createGitRepo();
  runGit(repo, ["config", "core.quotePath", "false"]);
  fs.writeFileSync(path.join(repo, emojiName), "emoji\n");
  fs.writeFileSync(path.join(repo, cjkName), "cjk\n");
  fs.writeFileSync(path.join(repo, "notes.md"), "plain\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "add unicode names"]);
  fs.appendFileSync(path.join(repo, emojiName), "more\n");
  fs.appendFileSync(path.join(repo, cjkName), "more\n");
  fs.appendFileSync(path.join(repo, "notes.md"), "more\n");

  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-state-"));
  const { service } = createService(repo, 30, stateRoot);
  const registered = service.registerSession({
    agent_name: "worker",
    host_type: "codex",
    worktree_path: repo,
  });
  service.claimPaths({
    session_id: registered.session_id,
    paths: [emojiName, cjkName],
    claim_mode: "exclusive",
    reason: "edit unicode files",
  });

  const report = service.validateScope({ session_id: registered.session_id });
  assert.ok(report.changed_paths.includes(emojiName));
  assert.ok(report.changed_paths.includes(cjkName));
  assert.equal(report.changed_paths.some((item) => item.includes("\uFFFD")), false);
  assert.deepEqual(report.out_of_scope_paths, ["notes.md"]);
});

test("validate_scope throws when git fails instead of reporting an empty scope", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-nogit-"));
  const { service } = createService(workspaceRoot);
  const registered = service.registerSession({
    agent_name: "worker",
    host_type: "codex",
    worktree_path: workspaceRoot,
  });

  assert.throws(
    () => service.validateScope({ session_id: registered.session_id }),
    (error: unknown) => error instanceof GitCommandError,
  );
});

test("heartbeat extends only that session's unexpired claims", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-heartbeat-"));
  const { db, service } = createService(workspaceRoot, 30);
  const owner = service.registerSession({ agent_name: "owner", host_type: "codex" });
  const other = service.registerSession({ agent_name: "other", host_type: "codex" });

  service.claimPaths({
    session_id: owner.session_id,
    paths: ["src/short.ts", "src/long.ts"],
    claim_mode: "exclusive",
    ttl_minutes: 5,
  });
  db.prepare(
    `
      UPDATE path_claims
      SET expires_at = ?
      WHERE session_id = ? AND path_pattern = ?
    `,
  ).run(
    new Date(Date.now() + 120 * 60 * 1000).toISOString(),
    owner.session_id,
    "src/long.ts",
  );
  service.claimPaths({
    session_id: other.session_id,
    paths: ["docs/**"],
    claim_mode: "exclusive",
    ttl_minutes: 5,
  });

  const shortBefore = claimExpiry(db, owner.session_id, "src/short.ts");
  const longBefore = claimExpiry(db, owner.session_id, "src/long.ts");
  const otherBefore = claimExpiry(db, other.session_id, "docs/**");

  const heartbeat = service.heartbeat({ session_id: owner.session_id });
  const shortAfter = claimExpiry(db, owner.session_id, "src/short.ts");
  const longAfter = claimExpiry(db, owner.session_id, "src/long.ts");
  const otherAfter = claimExpiry(db, other.session_id, "docs/**");

  assert.equal(heartbeat.claims_extended, 1);
  assert.ok(new Date(shortAfter).getTime() > new Date(shortBefore).getTime());
  const extendedForMinutes =
    (new Date(shortAfter).getTime() - new Date(heartbeat.heartbeat_at).getTime()) / 60_000;
  assert.ok(extendedForMinutes > 29 && extendedForMinutes < 31);
  assert.equal(longAfter, longBefore);
  assert.equal(otherAfter, otherBefore);

  db.prepare("UPDATE path_claims SET expires_at = ? WHERE session_id = ?").run(
    new Date(Date.now() - 60_000).toISOString(),
    owner.session_id,
  );
  const expiredHeartbeat = service.heartbeat({ session_id: owner.session_id });
  const remaining = db
    .prepare("SELECT COUNT(*) AS count FROM path_claims WHERE session_id = ?")
    .get(owner.session_id) as { count: number };
  assert.equal(expiredHeartbeat.claims_extended, 0);
  assert.equal(remaining.count, 0);
});

test("completeTask writes a completion update", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-complete-"));
  const { service } = createService(workspaceRoot);
  const registered = service.registerSession({ agent_name: "owner", host_type: "codex" });
  const created = service.createTask({
    title: "Finish the claim flow",
    owner_session_id: registered.session_id,
  });
  service.claimPaths({
    session_id: registered.session_id,
    task_id: created.task.id,
    paths: ["src/core/**"],
    claim_mode: "exclusive",
  });

  const completed = service.completeTask({
    task_id: created.task.id,
    session_id: registered.session_id,
  });
  const updates = service.getUpdates({ task_id: created.task.id });

  assert.equal(completed.task.status, "done");
  assert.equal(updates.total, 1);
  assert.equal(updates.updates[0]?.kind, "progress");
  assert.match(updates.updates[0]?.message ?? "", /Finish the claim flow/);
  assert.equal(updates.updates[0]?.details.event, "task_completed");
  assert.equal(service.releasePaths({ session_id: registered.session_id }).released_count, 0);
});

test("checkConflicts includes related tasks and recent decisions in the same scope", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-conflicts-"));
  const { service } = createService(workspaceRoot);
  const owner = service.registerSession({ agent_name: "owner", host_type: "codex" });
  const reader = service.registerSession({ agent_name: "reader", host_type: "claude-code" });
  const related = service.createTask({
    title: "Core service work",
    planned_paths: ["src/core/**"],
    owner_session_id: owner.session_id,
  });
  service.createTask({
    title: "Docs only",
    planned_paths: ["docs/**"],
    owner_session_id: owner.session_id,
  });
  service.claimPaths({
    session_id: owner.session_id,
    task_id: related.task.id,
    paths: ["src/core/**"],
    claim_mode: "exclusive",
  });
  service.recordDecision({
    session_id: owner.session_id,
    scope_key: "src/core",
    title: "Keep claims transactional",
    summary: "Insert every path claim in one transaction.",
  });
  service.recordDecision({
    session_id: owner.session_id,
    scope_key: "docs",
    title: "Docs stay separate",
    summary: "Documentation edits do not overlap the core service.",
  });

  const report = service.checkConflicts({
    session_id: reader.session_id,
    paths: ["src/core/coordination-service.ts"],
  });
  const entry = report.conflicts[0];

  assert.equal(entry?.matches.length, 1);
  assert.equal(entry?.owners[0]?.session_id, owner.session_id);
  assert.deepEqual(
    entry?.related_tasks.map((task) => task.id),
    [related.task.id],
  );
  assert.deepEqual(
    entry?.recent_decisions.map((decision) => decision.scope_key),
    ["src/core"],
  );
});

test("multi-path claim inserts every path or none when a path conflicts", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-tx-"));
  const { db, service } = createService(workspaceRoot);
  const owner = service.registerSession({ agent_name: "owner", host_type: "codex" });
  const other = service.registerSession({ agent_name: "other", host_type: "codex" });

  const claimed = service.claimPaths({
    session_id: owner.session_id,
    paths: ["src/a.ts", "src/b.ts"],
    claim_mode: "exclusive",
    reason: "edit both files together",
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.claims?.length, 2);
  assert.equal(new Set(claimed.claims?.map((claim) => claim.created_at)).size, 1);

  const conflicted = service.claimPaths({
    session_id: other.session_id,
    paths: ["src/a.ts", "docs/c.ts"],
    claim_mode: "exclusive",
  });
  assert.equal(conflicted.ok, false);
  const otherClaims = db
    .prepare("SELECT COUNT(*) AS count FROM path_claims WHERE session_id = ?")
    .get(other.session_id) as { count: number };
  assert.equal(otherClaims.count, 0);
});
