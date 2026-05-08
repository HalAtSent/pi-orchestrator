import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkExistingRepoPathContainment,
  checkRepoFileParentContainment,
  isProtectedRepoPath,
  normalizeRepoRelativePath,
  repoRealpathCovers,
  repoPathCovers,
} from "../src/kernel/path-safety.js";

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

test("existing repo path containment accepts existing normalized targets inside repository root", async () => {
  const { repoRoot } = await createContainmentWorkspace();
  await writeFile(path.join(repoRoot, "src", "file.txt"), "inside");
  await symlink("src/file.txt", path.join(repoRoot, "inside-link.txt"));

  const fileRealpath = await realpath(path.join(repoRoot, "src", "file.txt"));
  const directoryRealpath = await realpath(path.join(repoRoot, "src"));
  const symlinkRealpath = await realpath(path.join(repoRoot, "inside-link.txt"));

  assert.deepEqual(checkExistingRepoPathContainment(repoRoot, "src/file.txt"), {
    ok: true,
    realpath: fileRealpath,
  });
  assert.deepEqual(checkExistingRepoPathContainment(repoRoot, "src"), {
    ok: true,
    realpath: directoryRealpath,
  });
  assert.deepEqual(checkExistingRepoPathContainment(repoRoot, "inside-link.txt"), {
    ok: true,
    realpath: symlinkRealpath,
  });
});

test("existing repo path containment rejects symlink realpath escapes outside repository root", async () => {
  const { repoRoot, outsideRoot } = await createContainmentWorkspace();
  await writeFile(path.join(outsideRoot, "outside.txt"), "outside");
  await symlink(path.join(outsideRoot, "outside.txt"), path.join(repoRoot, "outside-link.txt"));

  assert.deepEqual(checkExistingRepoPathContainment(repoRoot, "outside-link.txt"), {
    ok: false,
    reason: "outside_repository",
  });
});

test("existing repo path containment rejects repo-sibling prefix escapes", async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), "pi-path-containment-"));
  const repoRoot = path.join(baseRoot, "repo");
  const siblingRoot = path.join(baseRoot, "repo-sibling");
  await mkdirp(path.join(repoRoot, "links"));
  await mkdirp(siblingRoot);
  await writeFile(path.join(siblingRoot, "outside.txt"), "outside");
  await symlink(path.join(siblingRoot, "outside.txt"), path.join(repoRoot, "links", "sibling.txt"));

  assert.deepEqual(checkExistingRepoPathContainment(repoRoot, "links/sibling.txt"), {
    ok: false,
    reason: "outside_repository",
  });
});

test("existing repo path containment returns stable failures for invalid repository roots", async () => {
  const { repoRoot } = await createContainmentWorkspace();
  const fileRoot = path.join(repoRoot, "root-file.txt");
  await writeFile(fileRoot, "not a directory");

  const invalidRoots = [null, "", "   ", "relative/repo"];
  for (const repositoryRoot of invalidRoots) {
    assert.doesNotThrow(() => checkExistingRepoPathContainment(repositoryRoot, "src/file.txt"));
    assert.deepEqual(checkExistingRepoPathContainment(repositoryRoot, "src/file.txt"), {
      ok: false,
      reason: "invalid_repository_root",
    });
  }

  assert.deepEqual(checkExistingRepoPathContainment(path.join(repoRoot, "missing"), "src/file.txt"), {
    ok: false,
    reason: "repository_root_unavailable",
  });
  assert.deepEqual(checkExistingRepoPathContainment(fileRoot, "src/file.txt"), {
    ok: false,
    reason: "repository_root_unavailable",
  });
});

test("existing repo path containment returns stable failures for invalid repo-relative paths", async () => {
  const { repoRoot } = await createContainmentWorkspace();
  const invalidPaths = [null, "./src", "src//file", "src/../file", "/tmp/outside", "src\\file", "src/http:example"];

  for (const repoRelativePath of invalidPaths) {
    assert.doesNotThrow(() => checkExistingRepoPathContainment(repoRoot, repoRelativePath));
    assert.deepEqual(checkExistingRepoPathContainment(repoRoot, repoRelativePath), {
      ok: false,
      reason: "invalid_repo_path",
    });
  }
});

test("existing repo path containment returns missing_path for normalized target misses", async () => {
  const { repoRoot } = await createContainmentWorkspace();

  assert.deepEqual(checkExistingRepoPathContainment(repoRoot, "src/missing.txt"), {
    ok: false,
    reason: "missing_path",
  });
});

test("existing repo path containment rejects broken symlink target misses", async () => {
  const { repoRoot } = await createContainmentWorkspace();
  await symlink("../outside/missing.txt", path.join(repoRoot, "src", "broken-link"));

  assert.deepEqual(checkExistingRepoPathContainment(repoRoot, "src/broken-link"), {
    ok: false,
    reason: "outside_repository",
  });
});

test("existing repo path containment rejects missing targets under symlink directory escapes", async () => {
  const { repoRoot, outsideRoot } = await createContainmentWorkspace();
  await symlink(outsideRoot, path.join(repoRoot, "escape-link"));

  assert.deepEqual(checkExistingRepoPathContainment(repoRoot, "escape-link/new-file.js"), {
    ok: false,
    reason: "outside_repository",
  });
});

test("repo realpath coverage handles exact file, directory descendant, and directory exact coverage", async () => {
  const { repoRoot } = await createContainmentWorkspace();
  await mkdirp(path.join(repoRoot, "src", "private"));
  await writeFile(path.join(repoRoot, "src", "private", "file.txt"), "private");

  assert.deepEqual(repoRealpathCovers(repoRoot, "src/private/file.txt", "src/private/file.txt"), {
    ok: true,
    covered: true,
    relation: "exact",
  });
  assert.deepEqual(repoRealpathCovers(repoRoot, "src/private/", "src/private/file.txt"), {
    ok: true,
    covered: true,
    relation: "descendant",
  });
  assert.deepEqual(repoRealpathCovers(repoRoot, "src/private/", "src/private/"), {
    ok: true,
    covered: true,
    relation: "exact",
  });
});

test("repo realpath coverage compares contained symlink aliases by realpath", async () => {
  const { repoRoot } = await createContainmentWorkspace();
  await mkdirp(path.join(repoRoot, "src", "private"));
  await writeFile(path.join(repoRoot, "src", "private", "file.txt"), "private");
  await symlink(path.join(repoRoot, "src", "private"), path.join(repoRoot, "private-link"));
  await symlink(path.join(repoRoot, "src", "private", "file.txt"), path.join(repoRoot, "private-file-link.txt"));

  assert.deepEqual(repoRealpathCovers(repoRoot, "private-file-link.txt", "src/private/file.txt"), {
    ok: true,
    covered: true,
    relation: "exact",
  });
  assert.deepEqual(repoRealpathCovers(repoRoot, "private-link/", "src/private/file.txt"), {
    ok: true,
    covered: true,
    relation: "descendant",
  });
});

test("repo realpath coverage returns uncovered for sibling, file-intent directory, and sibling-prefix paths", async () => {
  const { repoRoot } = await createContainmentWorkspace();
  await mkdirp(path.join(repoRoot, "src", "private"));
  await mkdirp(path.join(repoRoot, "src2"));
  await writeFile(path.join(repoRoot, "src", "private", "file.txt"), "private");
  await writeFile(path.join(repoRoot, "src", "private", "sibling.txt"), "sibling");
  await writeFile(path.join(repoRoot, "src2", "file.txt"), "sibling prefix");

  assert.deepEqual(repoRealpathCovers(repoRoot, "src/private/file.txt", "src/private/sibling.txt"), {
    ok: true,
    covered: false,
  });
  assert.deepEqual(repoRealpathCovers(repoRoot, "src/private", "src/private/file.txt"), {
    ok: true,
    covered: false,
  });
  assert.deepEqual(repoRealpathCovers(repoRoot, "src/private/file.txt", "src/private/"), {
    ok: true,
    covered: false,
  });
  assert.deepEqual(repoRealpathCovers(repoRoot, "src/", "src2/file.txt"), {
    ok: true,
    covered: false,
  });
});

test("repo realpath coverage preserves stable failure reasons without throwing", async () => {
  const { repoRoot, outsideRoot } = await createContainmentWorkspace();
  const fileRoot = path.join(repoRoot, "root-file.txt");
  await writeFile(fileRoot, "not a directory");
  await writeFile(path.join(repoRoot, "src", "file.txt"), "inside");
  await writeFile(path.join(outsideRoot, "outside.txt"), "outside");
  await symlink(path.join(outsideRoot, "outside.txt"), path.join(repoRoot, "outside-link.txt"));

  assert.deepEqual(repoRealpathCovers(null, "src/file.txt", "src/file.txt"), {
    ok: false,
    reason: "invalid_repository_root",
  });
  assert.deepEqual(repoRealpathCovers(path.join(repoRoot, "missing"), "src/file.txt", "src/file.txt"), {
    ok: false,
    reason: "repository_root_unavailable",
  });
  assert.deepEqual(repoRealpathCovers(fileRoot, "src/file.txt", "src/file.txt"), {
    ok: false,
    reason: "repository_root_unavailable",
  });
  assert.deepEqual(repoRealpathCovers(repoRoot, "./src/file.txt", "src/file.txt"), {
    ok: false,
    reason: "invalid_repo_path",
  });
  assert.deepEqual(repoRealpathCovers(repoRoot, "src/file.txt", "src//file.txt"), {
    ok: false,
    reason: "invalid_repo_path",
  });
  assert.deepEqual(repoRealpathCovers(repoRoot, "src/missing.txt", "src/file.txt"), {
    ok: false,
    reason: "missing_path",
  });
  assert.deepEqual(repoRealpathCovers(repoRoot, "src/file.txt", "src/missing.txt"), {
    ok: false,
    reason: "missing_path",
  });
  assert.doesNotThrow(() => repoRealpathCovers(repoRoot, "outside-link.txt", "outside-link.txt"));
  assert.deepEqual(repoRealpathCovers(repoRoot, "outside-link.txt", "outside-link.txt"), {
    ok: false,
    reason: "outside_repository",
  });
});

test("repo file parent containment accepts missing target files with contained parents", async () => {
  const { repoRoot } = await createContainmentWorkspace();
  await symlink(path.join(repoRoot, "src"), path.join(repoRoot, "inside-link"));

  const repoRootRealpath = await realpath(repoRoot);
  const srcRealpath = await realpath(path.join(repoRoot, "src"));
  const insideLinkRealpath = await realpath(path.join(repoRoot, "inside-link"));

  assert.deepEqual(checkRepoFileParentContainment(repoRoot, "src/new-file.js"), {
    ok: true,
    parentRealpath: srcRealpath,
  });
  assert.deepEqual(checkRepoFileParentContainment(repoRoot, "new-file.js"), {
    ok: true,
    parentRealpath: repoRootRealpath,
  });
  assert.deepEqual(checkRepoFileParentContainment(repoRoot, "inside-link/new-file.js"), {
    ok: true,
    parentRealpath: insideLinkRealpath,
  });
});

test("repo file parent containment rejects symlink parent escapes outside repository root", async () => {
  const { repoRoot, outsideRoot } = await createContainmentWorkspace();
  await symlink(outsideRoot, path.join(repoRoot, "outside-link"));

  assert.deepEqual(checkRepoFileParentContainment(repoRoot, "outside-link/new-file.js"), {
    ok: false,
    reason: "outside_repository",
  });
});

test("repo file parent containment rejects repo-sibling prefix escapes", async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), "pi-file-parent-containment-"));
  const repoRoot = path.join(baseRoot, "repo");
  const siblingRoot = path.join(baseRoot, "repo-sibling");
  await mkdirp(repoRoot);
  await mkdirp(siblingRoot);
  await symlink(siblingRoot, path.join(repoRoot, "sibling-link"));

  assert.deepEqual(checkRepoFileParentContainment(repoRoot, "sibling-link/new-file.js"), {
    ok: false,
    reason: "outside_repository",
  });
});

test("repo file parent containment returns stable failures for invalid repository roots", async () => {
  const { repoRoot } = await createContainmentWorkspace();
  const fileRoot = path.join(repoRoot, "root-file.txt");
  await writeFile(fileRoot, "not a directory");

  const invalidRoots = [null, "", "   ", "relative/repo"];
  for (const repositoryRoot of invalidRoots) {
    assert.doesNotThrow(() => checkRepoFileParentContainment(repositoryRoot, "src/file.txt"));
    assert.deepEqual(checkRepoFileParentContainment(repositoryRoot, "src/file.txt"), {
      ok: false,
      reason: "invalid_repository_root",
    });
  }

  assert.deepEqual(checkRepoFileParentContainment(path.join(repoRoot, "missing"), "src/file.txt"), {
    ok: false,
    reason: "repository_root_unavailable",
  });
  assert.deepEqual(checkRepoFileParentContainment(fileRoot, "src/file.txt"), {
    ok: false,
    reason: "repository_root_unavailable",
  });
});

test("repo file parent containment returns stable failures for invalid repo-relative file paths", async () => {
  const { repoRoot } = await createContainmentWorkspace();
  const invalidPaths = [
    null,
    "./src/file.js",
    "src//file.js",
    "src/../file.js",
    "/tmp/outside",
    "src\\file.js",
    "src/http:example",
    "src/",
  ];

  for (const repoRelativePath of invalidPaths) {
    assert.doesNotThrow(() => checkRepoFileParentContainment(repoRoot, repoRelativePath));
    assert.deepEqual(checkRepoFileParentContainment(repoRoot, repoRelativePath), {
      ok: false,
      reason: "invalid_repo_path",
    });
  }
});

test("repo file parent containment returns parent_unavailable for missing or non-directory parents", async () => {
  const { repoRoot } = await createContainmentWorkspace();
  await writeFile(path.join(repoRoot, "parent-file"), "not a directory");

  assert.deepEqual(checkRepoFileParentContainment(repoRoot, "missing/new-file.js"), {
    ok: false,
    reason: "parent_unavailable",
  });
  assert.deepEqual(checkRepoFileParentContainment(repoRoot, "parent-file/new-file.js"), {
    ok: false,
    reason: "parent_unavailable",
  });
});

async function createContainmentWorkspace() {
  const baseRoot = await mkdtemp(path.join(tmpdir(), "pi-path-containment-"));
  const repoRoot = path.join(baseRoot, "repo");
  const outsideRoot = path.join(baseRoot, "outside");
  await mkdirp(path.join(repoRoot, "src"));
  await mkdirp(outsideRoot);
  return { repoRoot, outsideRoot };
}

async function mkdirp(pathValue) {
  await mkdir(pathValue, { recursive: true });
}
