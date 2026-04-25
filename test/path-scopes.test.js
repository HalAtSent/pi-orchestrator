import test from "node:test";
import assert from "node:assert/strict";

import {
  isPathWithinScope,
  normalizeRelativeScopePath,
  normalizeScopedPath,
  scopesOverlap
} from "../src/path-scopes.js";

test("normalizeScopedPath collapses dot segments while keeping relative paths", () => {
  assert.equal(normalizeScopedPath("./src/a.js"), "src/a.js");
  assert.equal(normalizeScopedPath("src/a.js"), "src/a.js");
  assert.equal(normalizeScopedPath("src/./nested/../a.js"), "src/a.js");
  assert.equal(normalizeScopedPath("./test/fixtures/"), "test/fixtures/");
});

test("normalizeScopedPath rejects non-string values", () => {
  assert.throws(
    () => normalizeScopedPath({}),
    /scope path must be a string/u
  );
});

test("normalizeRelativeScopePath accepts only non-escaping repo-relative paths", () => {
  assert.equal(normalizeRelativeScopePath("./src/a.js"), "src/a.js");
  assert.equal(normalizeRelativeScopePath("docs/"), "docs/");

  for (const pathValue of [
    "",
    "   ",
    "/tmp/outside.txt",
    "../outside.txt",
    "src/../outside.txt",
    "foo/../../outside.txt",
    "C:outside.txt",
    "C:\\Users\\hal\\outside.txt"
  ]) {
    assert.throws(
      () => normalizeRelativeScopePath(pathValue),
      /must not be empty|must be a repository-relative path|must not escape the repository root/u,
      pathValue
    );
  }
});

test("isPathWithinScope rejects traversal escapes from directory scopes", () => {
  assert.equal(isPathWithinScope("src/../secrets.txt", "src/"), false);
  assert.equal(isPathWithinScope("./src/a.js", "src/"), true);
  assert.equal(isPathWithinScope("src/a.js", "src/"), true);
  assert.equal(isPathWithinScope("src/a.js", "src/a.js"), true);
});

test("scopesOverlap does not treat traversal forms as nested directory files", () => {
  assert.equal(scopesOverlap("src/", "src/nested/file.js"), true);
  assert.equal(scopesOverlap("src/", "src/../secrets.txt"), false);
  assert.equal(scopesOverlap("src/../secrets.txt", "src/"), false);
  assert.equal(scopesOverlap("docs/", "docs/guide.md"), true);
});

test("isPathWithinScope compares path casing case-insensitively on Windows", {
  skip: process.platform !== "win32"
}, () => {
  assert.equal(isPathWithinScope("SRC/File.js", "src/"), true);
});

test("scopesOverlap compares scope casing case-insensitively on Windows", {
  skip: process.platform !== "win32"
}, () => {
  assert.equal(scopesOverlap("src/file.js", "SRC/file.js"), true);
});

test("scope comparisons are conservative for common case-insensitive macOS volumes", {
  skip: process.platform !== "darwin"
}, () => {
  assert.equal(isPathWithinScope("SRC/File.js", "src/"), true);
  assert.equal(scopesOverlap("src/file.js", "SRC/file.js"), true);
});
