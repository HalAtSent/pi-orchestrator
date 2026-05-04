import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRepoRelativePath } from "../src/kernel/path-safety.js";

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
