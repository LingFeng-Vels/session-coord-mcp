import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GitCommandError,
  GitService,
  parsePorcelainPaths,
  unquoteGitPath,
} from "../src/git/git-service.js";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-git-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "coord-test@example.com"]);
  runGit(repo, ["config", "user.name", "Coord Test"]);
  runGit(repo, ["config", "commit.gpgsign", "false"]);
  runGit(repo, ["config", "core.quotePath", "true"]);
  return repo;
}

test("porcelain parser keeps rename destinations and unquotes paths", () => {
  assert.deepEqual(parsePorcelainPaths('R  "old file.txt" -> "new file.txt"'), [
    "old file.txt",
    "new file.txt",
  ]);
  assert.deepEqual(parsePorcelainPaths('?? "\\346\\265\\213\\350\\257\\225.txt"'), ["测试.txt"]);
  assert.equal(unquoteGitPath('"docs/my notes.md"'), "docs/my notes.md");
  assert.deepEqual(parsePorcelainPaths("M  src/plain.ts"), ["src/plain.ts"]);
});

test("porcelain parser decodes raw and octal-escaped emoji paths as UTF-8", () => {
  assert.deepEqual(parsePorcelainPaths('?? "😀 file.ts"'), ["😀 file.ts"]);
  assert.deepEqual(parsePorcelainPaths('?? "\\360\\237\\230\\200 file.ts"'), ["😀 file.ts"]);
  assert.deepEqual(parsePorcelainPaths('R  "😀 old.ts" -> "测试 new.ts"'), [
    "😀 old.ts",
    "测试 new.ts",
  ]);
  assert.equal(
    parsePorcelainPaths('?? "😀 file.ts"').some((item) => item.includes("\uFFFD")),
    false,
  );
});

test("listChangedFiles returns an empty list for a clean repository", () => {
  const repo = createGitRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);

  assert.deepEqual(new GitService().listChangedFiles(repo), []);
});

test("listChangedFiles throws when git fails instead of looking like an empty diff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-not-git-"));
  const git = new GitService();

  assert.throws(
    () => git.listChangedFiles(dir),
    (error: unknown) => {
      assert.ok(error instanceof GitCommandError);
      assert.match(error.message, /not a git repository/i);
      return true;
    },
  );

  const repo = createGitRepo();
  assert.throws(
    () => git.listChangedFiles(repo, "does-not-exist"),
    (error: unknown) => error instanceof GitCommandError,
  );
});

test("listChangedFiles parses quoted paths and renames from a temp git repo", () => {
  const repo = createGitRepo();
  const original = "my file.txt";
  const renamed = "renamed file.txt";
  const unicodeName = "测试.txt";

  fs.writeFileSync(path.join(repo, original), "alpha\n");
  fs.writeFileSync(path.join(repo, unicodeName), "beta\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "add quoted names"]);
  runGit(repo, ["mv", original, renamed]);
  fs.appendFileSync(path.join(repo, unicodeName), "more\n");

  const changed = new GitService().listChangedFiles(repo);
  assert.ok(changed.includes(renamed), `expected renamed path, got ${changed.join(", ")}`);
  assert.ok(changed.includes(original), `expected original path, got ${changed.join(", ")}`);
  assert.ok(changed.includes(unicodeName), `expected unicode path, got ${changed.join(", ")}`);
  assert.equal(
    changed.some((item) => item.includes('"') || item.includes("->")),
    false,
  );
});

test("listChangedFiles keeps emoji and CJK filenames from a temp git repo", () => {
  const emojiName = "😀 file.ts";
  const cjkName = "测试 文件.ts";

  for (const quotePath of ["true", "false"]) {
    const repo = createGitRepo();
    runGit(repo, ["config", "core.quotePath", quotePath]);
    fs.writeFileSync(path.join(repo, emojiName), "emoji\n");
    fs.writeFileSync(path.join(repo, cjkName), "cjk\n");

    const changed = new GitService().listChangedFiles(repo);
    assert.ok(
      changed.includes(emojiName),
      `quotePath=${quotePath} expected ${emojiName}, got ${changed.join(", ")}`,
    );
    assert.ok(
      changed.includes(cjkName),
      `quotePath=${quotePath} expected ${cjkName}, got ${changed.join(", ")}`,
    );
    assert.equal(
      changed.some((item) => item.includes("\uFFFD") || item.includes('"')),
      false,
    );
  }
});
