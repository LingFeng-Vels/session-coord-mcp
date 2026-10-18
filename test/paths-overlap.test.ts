import assert from "node:assert/strict";
import test from "node:test";

import { patternsOverlap } from "../src/utils/paths.js";

test("path overlap treats parent and child paths as overlapping", () => {
  assert.equal(patternsOverlap("src", "src/core/coordination-service.ts"), true);
  assert.equal(patternsOverlap("src/core/coordination-service.ts", "src"), true);
  assert.equal(patternsOverlap("src/core", "src/core"), true);
  assert.equal(patternsOverlap("src", "src2/file.ts"), false);
});

test("path overlap matches ** globs and rejects non-overlapping globs", () => {
  assert.equal(patternsOverlap("src/core/**", "src/core/coordination-service.ts"), true);
  assert.equal(patternsOverlap("src/**", "src/core/**"), true);
  assert.equal(patternsOverlap("**", "docs/tools.md"), true);
  assert.equal(patternsOverlap("src/**", "docs/**"), false);
  assert.equal(patternsOverlap("packages/a/**", "packages/b/**"), false);
  assert.equal(patternsOverlap("src/*.ts", "docs/*.ts"), false);
});
