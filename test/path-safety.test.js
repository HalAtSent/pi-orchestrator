import assert from "node:assert/strict";
import test from "node:test";

import { isProtectedRepoPath, normalizeRepoRelativePath, repoPathCovers } from "../src/kernel/path-safety.js";

test("repo-relative path normalization accepts safe lexical forms", () => {
  const cases = [
    ["./src/./kernel/work-order.js", { ok: true, path: "src/kernel/work-order.js" }],
    ["src//kernel///work-order.js", { ok: true, path: "src/kernel/work-order.js" }],
    ["src/kernel/", { ok: true, path: "src/kernel/" }],
    ["src/kernel//", { ok: true, path: "src/kernel/" }],
    ["./src/kernel/./", { ok: true, path: "src/kernel/" }],
  ];

  for (const [pathValue, expected] of cases) {
    assert.deepEqual(normalizeRepoRelativePath(pathValue), expected);
  }
});

test("repo-relative path normalization rejects invalid inputs without throwing", () => {
  const cases = [
    [null, "invalid_type"],
    [123, "invalid_type"],
    [{ path: "src/kernel" }, "invalid_type"],
    ["", "empty_path"],
    ["   ", "empty_path"],
    ["/tmp/outside", "absolute_path"],
    ["//outside", "absolute_path"],
    ["//server/share", "absolute_path"],
    ["C:/outside", "absolute_path"],
    ["C:outside", "absolute_path"],
    ["./C:/outside", "absolute_path"],
    ["src/C:/outside", "absolute_path"],
    ["src/C:outside", "absolute_path"],
    ["https://example.test/file", "url_like_path"],
    ["file:/tmp/x", "url_like_path"],
    ["http:/example", "url_like_path"],
    ["http:example", "url_like_path"],
    ["./file:/tmp/x", "url_like_path"],
    ["./http:example", "url_like_path"],
    ["./https://example.test/file", "url_like_path"],
    ["src/http://example", "url_like_path"],
    ["foo/https://bar", "url_like_path"],
    ["src/file:/tmp/x", "url_like_path"],
    ["src/http:example", "url_like_path"],
    ["src\\kernel", "backslash_path"],
    ["../outside", "path_traversal"],
    ["src/../outside", "path_traversal"],
    [".", "root_path"],
    ["./", "root_path"],
  ];

  for (const [pathValue, reason] of cases) {
    assert.doesNotThrow(() => normalizeRepoRelativePath(pathValue));
    assert.deepEqual(normalizeRepoRelativePath(pathValue), { ok: false, reason });
  }
});

test("protected repo path detection rejects invalid inputs without throwing", () => {
  const cases = [
    null,
    123,
    { path: "src/kernel" },
    "",
    "   ",
    "./src",
    "src//file",
    "src/../file",
    "/tmp/outside",
  ];

  for (const pathValue of cases) {
    assert.doesNotThrow(() => isProtectedRepoPath(pathValue));
    assert.deepEqual(isProtectedRepoPath(pathValue), { protected: false, reason: "invalid_input" });
  }
});

test("protected repo path detection matches protected directory segments", () => {
  const cases = [
    [".git", "git"],
    [".git/", "git"],
    [".git/config", "git"],
    ["src/.git/config", "git"],
    [".pi", "pi_runtime"],
    [".pi/", "pi_runtime"],
    [".pi/runs/run.json", "pi_runtime"],
    ["packages/app/.pi/state.json", "pi_runtime"],
    ["node_modules/", "dependency"],
    ["packages/app/node_modules/lib.js", "dependency"],
    ["vendor/", "dependency"],
    ["src/vendor/package.json", "dependency"],
    [".venv/", "dependency"],
    ["tools/.venv/bin/python", "dependency"],
    ["dist/", "build_output"],
    ["app/dist/bundle.js", "build_output"],
    ["build/", "build_output"],
    ["app/build/output.js", "build_output"],
    ["coverage/", "build_output"],
    ["reports/coverage/index.html", "build_output"],
    [".next/", "build_output"],
    ["web/.next/server.js", "build_output"],
  ];

  for (const [pathValue, reason] of cases) {
    assert.deepEqual(isProtectedRepoPath(pathValue), { protected: true, reason });
  }
});

test("protected repo path detection matches case variants of protected directory segments", () => {
  const cases = [
    [".GIT/config", "git"],
    ["src/.Git/config", "git"],
    [".PI/state", "pi_runtime"],
    ["Node_Modules/pkg/index.js", "dependency"],
    ["Build/output.js", "build_output"],
  ];

  for (const [pathValue, reason] of cases) {
    assert.deepEqual(isProtectedRepoPath(pathValue), { protected: true, reason });
  }
});

test("protected repo path detection does not match protected substrings", () => {
  const cases = [
    ".github/workflows/x.yml",
    "distillery/file",
    "docs/credentials-guide.md",
    "src/mycredentials.json",
    "src/netrc-parser.js",
  ];

  for (const pathValue of cases) {
    assert.deepEqual(isProtectedRepoPath(pathValue), { protected: false });
  }
});

test("protected repo path detection matches secret-like basenames only", () => {
  const protectedCases = [
    [".env", "secret"],
    ["app/.env.local", "secret"],
    ["certs/secret.pem", "secret"],
    ["keys/deploy.key", "secret"],
    [".ENV.local", "secret"],
    ["certs/DEPLOY.PEM", "secret"],
    ["keys/deploy.KEY", "secret"],
  ];

  for (const [pathValue, reason] of protectedCases) {
    assert.deepEqual(isProtectedRepoPath(pathValue), { protected: true, reason });
  }

  const nonProtectedCases = ["src/keynote.md", "src/pemfile.txt"];

  for (const pathValue of nonProtectedCases) {
    assert.deepEqual(isProtectedRepoPath(pathValue), { protected: false });
  }
});

test("protected repo path detection matches credential-store paths without loose substrings", () => {
  const protectedCases = [
    ".npmrc",
    "config/.npmrc",
    ".pypirc",
    "config/.pypirc",
    ".netrc",
    "config/.netrc",
    ".aws/credentials",
    "config/.aws/credentials",
    ".ssh/id_rsa",
    "config/.ssh/id_rsa",
    "credentials.json",
    "config/credentials.json",
  ];

  for (const pathValue of protectedCases) {
    assert.deepEqual(isProtectedRepoPath(pathValue), { protected: true, reason: "secret" });
  }

  const nonProtectedCases = [
    "config/npmrc",
    "config/pypirc",
    "config/netrc",
    ".aws/mycredentials",
    ".ssh/id_rsa.pub",
  ];

  for (const pathValue of nonProtectedCases) {
    assert.deepEqual(isProtectedRepoPath(pathValue), { protected: false });
  }
});

test("repo path coverage handles exact file scopes", () => {
  const cases = [
    ["src/app.js", "src/app.js", { ok: true, covered: true, relation: "exact" }],
    ["src/app.js", "src/app.test.js", { ok: true, covered: false }],
    ["src/app.js", "src/app.js/child", { ok: true, covered: false }],
  ];

  for (const [scopePath, candidatePath, expected] of cases) {
    assert.deepEqual(repoPathCovers(scopePath, candidatePath), expected);
  }
});

test("repo path coverage handles trailing-slash directory scopes with segment bounds", () => {
  const cases = [
    ["src/", "src/", { ok: true, covered: true, relation: "exact" }],
    ["src/", "src/app.js", { ok: true, covered: true, relation: "descendant" }],
    ["src/", "src/nested/app.js", { ok: true, covered: true, relation: "descendant" }],
    ["src/", "src2/app.js", { ok: true, covered: false }],
    ["dist/", "distillery/file", { ok: true, covered: false }],
  ];

  for (const [scopePath, candidatePath, expected] of cases) {
    assert.deepEqual(repoPathCovers(scopePath, candidatePath), expected);
  }
});

test("repo path coverage rejects invalid or unnormalized inputs without throwing", () => {
  const invalidInputs = [
    null,
    123,
    { path: "src/file" },
    "",
    "   ",
    ".",
    "./src",
    "src//file",
    "src/../file",
    "/tmp/outside",
    "src\\file",
    "src/http:example",
    "src/http://example",
    "C:/outside",
  ];

  for (const pathValue of invalidInputs) {
    assert.doesNotThrow(() => repoPathCovers(pathValue, "src/app.js"));
    assert.deepEqual(repoPathCovers(pathValue, "src/app.js"), { ok: false, reason: "invalid_input" });
    assert.doesNotThrow(() => repoPathCovers("src/", pathValue));
    assert.deepEqual(repoPathCovers("src/", pathValue), { ok: false, reason: "invalid_input" });
  }
});
