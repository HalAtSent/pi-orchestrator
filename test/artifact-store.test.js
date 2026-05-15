import assert from "node:assert/strict";
import fs from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureRunStoreDirectory } from "../src/kernel/artifact-store.js";

test("run store directory creation is idempotent under repository root realpath", async () => {
  const { repoRoot } = await createArtifactStoreWorkspace();
  const repositoryRootRealpath = await realpath(repoRoot);
  const expectedRunDirectory = path.join(repositoryRootRealpath, ".pi", "runs", "run_20260509_001");

  assert.deepEqual(ensureRunStoreDirectory(repoRoot, "run_20260509_001"), {
    ok: true,
    runDirectory: expectedRunDirectory,
  });
  assert.deepEqual(await pathKind(path.join(repositoryRootRealpath, ".pi")), "directory");
  assert.deepEqual(await pathKind(path.join(repositoryRootRealpath, ".pi", "runs")), "directory");
  assert.deepEqual(await pathKind(expectedRunDirectory), "directory");

  assert.deepEqual(ensureRunStoreDirectory(repoRoot, "run_20260509_001"), {
    ok: true,
    runDirectory: expectedRunDirectory,
  });
  assert.deepEqual(await pathKind(path.join(repositoryRootRealpath, ".pi")), "directory");
  assert.deepEqual(await pathKind(path.join(repositoryRootRealpath, ".pi", "runs")), "directory");
  assert.deepEqual(await pathKind(expectedRunDirectory), "directory");
});

test("run store directory creation accepts valid competing EEXIST creators at each storage level", async (t) => {
  const cases = [
    {
      name: ".pi",
      target: (repositoryRootRealpath) => path.join(repositoryRootRealpath, ".pi"),
    },
    {
      name: ".pi/runs",
      target: (repositoryRootRealpath) => path.join(repositoryRootRealpath, ".pi", "runs"),
    },
    {
      name: ".pi/runs/<runId>",
      target: (repositoryRootRealpath, runId) => path.join(repositoryRootRealpath, ".pi", "runs", runId),
    },
  ];

  for (const { name, target } of cases) {
    await t.test(name, async (t) => {
      const { repoRoot } = await createArtifactStoreWorkspace();
      const repositoryRootRealpath = await realpath(repoRoot);
      const runId = "run_20260509_001";
      const expectedRunDirectory = path.join(repositoryRootRealpath, ".pi", "runs", runId);
      const competingPath = target(repositoryRootRealpath, runId);
      const originalMkdirSync = fs.mkdirSync;
      let simulated = false;

      t.mock.method(fs, "mkdirSync", (pathValue, options) => {
        if (pathValue === competingPath && simulated === false) {
          simulated = true;
          originalMkdirSync(pathValue, options);
          throw Object.assign(new Error("competing creator made the directory"), { code: "EEXIST" });
        }

        return originalMkdirSync(pathValue, options);
      });

      assert.deepEqual(ensureRunStoreDirectory(repoRoot, runId), {
        ok: true,
        runDirectory: expectedRunDirectory,
      });
      assert.equal(simulated, true);
      assert.deepEqual(await pathKind(path.join(repositoryRootRealpath, ".pi")), "directory");
      assert.deepEqual(await pathKind(path.join(repositoryRootRealpath, ".pi", "runs")), "directory");
      assert.deepEqual(await pathKind(expectedRunDirectory), "directory");
    });
  }
});

test("run store directory creation rejects EEXIST when the resulting path is not a plain contained directory", async (t) => {
  const { repoRoot, outsideRoot } = await createArtifactStoreWorkspace();
  const repositoryRootRealpath = await realpath(repoRoot);
  const piDirectory = path.join(repositoryRootRealpath, ".pi");
  const originalMkdirSync = fs.mkdirSync;
  let simulated = false;

  t.mock.method(fs, "mkdirSync", (pathValue, options) => {
    if (pathValue === piDirectory && simulated === false) {
      simulated = true;
      fs.symlinkSync(outsideRoot, piDirectory);
      throw Object.assign(new Error("competing creator made an unsafe shape"), { code: "EEXIST" });
    }

    return originalMkdirSync(pathValue, options);
  });

  assert.deepEqual(ensureRunStoreDirectory(repoRoot, "run_20260509_001"), {
    ok: false,
    reason: "storage_unavailable",
  });
  assert.equal(simulated, true);
  assert.deepEqual(await pathKind(piDirectory), "symlink");
  assert.equal(await pathExists(path.join(outsideRoot, "runs", "run_20260509_001")), false);
});

test("run store directory creation rejects non-EEXIST mkdir failures", async (t) => {
  const { repoRoot } = await createArtifactStoreWorkspace();
  const repositoryRootRealpath = await realpath(repoRoot);
  const piDirectory = path.join(repositoryRootRealpath, ".pi");
  const originalMkdirSync = fs.mkdirSync;
  let simulated = false;

  t.mock.method(fs, "mkdirSync", (pathValue, options) => {
    if (pathValue === piDirectory && simulated === false) {
      simulated = true;
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }

    return originalMkdirSync(pathValue, options);
  });

  assert.deepEqual(ensureRunStoreDirectory(repoRoot, "run_20260509_001"), {
    ok: false,
    reason: "storage_unavailable",
  });
  assert.equal(simulated, true);
  assert.equal(await pathExists(piDirectory), false);
});

test("invalid run ids fail without creating .pi", async () => {
  const invalidRunIds = [
    "",
    " ",
    ".",
    "..",
    "../run",
    "run/child",
    "run\\child",
    "/tmp/run",
    "http:run",
    "RunUpper",
    "run id",
    ".hidden",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ];

  for (const runId of invalidRunIds) {
    const { repoRoot } = await createArtifactStoreWorkspace();

    assert.doesNotThrow(() => ensureRunStoreDirectory(repoRoot, runId));
    assert.deepEqual(ensureRunStoreDirectory(repoRoot, runId), {
      ok: false,
      reason: "invalid_run_id",
    });
    assert.equal(await pathExists(path.join(repoRoot, ".pi")), false);
  }
});

test("invalid repository roots return stable failures without throwing", async () => {
  const { repoRoot } = await createArtifactStoreWorkspace();
  const fileRoot = path.join(repoRoot, "root-file.txt");
  await writeFile(fileRoot, "not a directory");

  for (const repositoryRoot of [null, "", " ", "relative/repo"]) {
    assert.doesNotThrow(() => ensureRunStoreDirectory(repositoryRoot, "run_20260509_001"));
    assert.deepEqual(ensureRunStoreDirectory(repositoryRoot, "run_20260509_001"), {
      ok: false,
      reason: "invalid_repository_root",
    });
    assert.equal(await pathExists(path.join(repoRoot, ".pi")), false);
  }

  const missingRoot = path.join(repoRoot, "missing");
  assert.deepEqual(ensureRunStoreDirectory(missingRoot, "run_20260509_001"), {
    ok: false,
    reason: "repository_root_unavailable",
  });
  assert.equal(await pathExists(path.join(missingRoot, ".pi")), false);
  assert.equal(await pathExists(path.join(repoRoot, ".pi")), false);

  assert.deepEqual(ensureRunStoreDirectory(fileRoot, "run_20260509_001"), {
    ok: false,
    reason: "repository_root_unavailable",
  });
  assert.equal(await pathExists(path.join(fileRoot, ".pi")), false);
  assert.equal(await pathExists(path.join(repoRoot, ".pi")), false);
});

test("non-directory storage shapes fail closed", async () => {
  const cases = [
    async (repoRoot) => {
      await writeFile(path.join(repoRoot, ".pi"), "not a directory");
    },
    async (repoRoot) => {
      await mkdir(path.join(repoRoot, ".pi"));
      await writeFile(path.join(repoRoot, ".pi", "runs"), "not a directory");
    },
    async (repoRoot) => {
      await mkdir(path.join(repoRoot, ".pi", "runs"), { recursive: true });
      await writeFile(path.join(repoRoot, ".pi", "runs", "run_20260509_001"), "not a directory");
    },
  ];

  for (const setup of cases) {
    const { repoRoot } = await createArtifactStoreWorkspace();
    await setup(repoRoot);

    assert.doesNotThrow(() => ensureRunStoreDirectory(repoRoot, "run_20260509_001"));
    assert.deepEqual(ensureRunStoreDirectory(repoRoot, "run_20260509_001"), {
      ok: false,
      reason: "storage_unavailable",
    });
  }
});

test("symlinked storage shapes fail closed without creating outside repository", async () => {
  const symlinkCases = [
    async ({ repoRoot, outsideRoot }) => {
      await symlink(outsideRoot, path.join(repoRoot, ".pi"));
    },
    async ({ repoRoot, outsideRoot }) => {
      await mkdir(path.join(repoRoot, ".pi"));
      await symlink(outsideRoot, path.join(repoRoot, ".pi", "runs"));
    },
    async ({ repoRoot, outsideRoot }) => {
      await mkdir(path.join(repoRoot, ".pi", "runs"), { recursive: true });
      await symlink(outsideRoot, path.join(repoRoot, ".pi", "runs", "run_20260509_001"));
    },
  ];

  for (const setup of symlinkCases) {
    const workspace = await createArtifactStoreWorkspace();
    await setup(workspace);

    assert.doesNotThrow(() => ensureRunStoreDirectory(workspace.repoRoot, "run_20260509_001"));
    assert.deepEqual(ensureRunStoreDirectory(workspace.repoRoot, "run_20260509_001"), {
      ok: false,
      reason: "storage_unavailable",
    });
    assert.equal(await pathExists(path.join(workspace.outsideRoot, "runs", "run_20260509_001")), false);
    assert.equal(await pathExists(path.join(workspace.outsideRoot, "run_20260509_001")), false);
  }
});

// These mocked swaps assert only detected-swap coverage: parent changes the
// portable path-based helper can observe before the relevant mkdir call. They
// do not prove atomic no-outside-mkdir protection against an external parent
// swap during final path resolution.
test("run store creation rejects a test-visible .pi symlink swap before runs directory creation", async (t) => {
  const { repoRoot, outsideRoot } = await createArtifactStoreWorkspace();
  const repositoryRootRealpath = await realpath(repoRoot);
  const piDirectory = path.join(repositoryRootRealpath, ".pi");
  const runsDirectory = path.join(piDirectory, "runs");
  const outsideRunsDirectory = path.join(outsideRoot, "runs");

  const originalLstatSync = fs.lstatSync;
  let swapped = false;
  t.mock.method(fs, "lstatSync", (pathValue, options) => {
    if (pathValue === runsDirectory && swapped === false) {
      swapped = true;
      fs.rmSync(piDirectory, { recursive: true, force: true });
      fs.symlinkSync(outsideRoot, piDirectory);
    }

    return originalLstatSync(pathValue, options);
  });

  const originalMkdirSync = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", (pathValue, options) => {
    if (pathValue === runsDirectory && fs.lstatSync(piDirectory).isSymbolicLink()) {
      assert.fail("mkdirSync reached .pi/runs after the test-visible .pi symlink swap");
    }

    return originalMkdirSync(pathValue, options);
  });

  assert.deepEqual(ensureRunStoreDirectory(repoRoot, "run_20260509_001"), {
    ok: false,
    reason: "storage_unavailable",
  });
  assert.equal(swapped, true);
  assert.equal(await pathKind(piDirectory), "symlink");
  assert.equal(await pathExists(outsideRunsDirectory), false);
});

test("run store creation rejects a test-visible runs symlink swap before run directory creation", async (t) => {
  const { repoRoot, outsideRoot } = await createArtifactStoreWorkspace();
  const repositoryRootRealpath = await realpath(repoRoot);
  const piDirectory = path.join(repositoryRootRealpath, ".pi");
  const runsDirectory = path.join(piDirectory, "runs");
  const runDirectory = path.join(runsDirectory, "run_20260509_001");
  const outsideRunDirectory = path.join(outsideRoot, "run_20260509_001");

  const originalLstatSync = fs.lstatSync;
  let swapped = false;
  t.mock.method(fs, "lstatSync", (pathValue, options) => {
    if (pathValue === runDirectory && swapped === false) {
      swapped = true;
      fs.rmSync(runsDirectory, { recursive: true, force: true });
      fs.symlinkSync(outsideRoot, runsDirectory);
    }

    return originalLstatSync(pathValue, options);
  });

  const originalMkdirSync = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", (pathValue, options) => {
    if (pathValue === runDirectory && fs.lstatSync(runsDirectory).isSymbolicLink()) {
      assert.fail("mkdirSync reached .pi/runs/<runId> after the test-visible runs symlink swap");
    }

    return originalMkdirSync(pathValue, options);
  });

  assert.deepEqual(ensureRunStoreDirectory(repoRoot, "run_20260509_001"), {
    ok: false,
    reason: "storage_unavailable",
  });
  assert.equal(swapped, true);
  assert.equal(await pathKind(path.join(repositoryRootRealpath, ".pi")), "directory");
  assert.equal(await pathKind(runsDirectory), "symlink");
  assert.equal(await pathExists(runDirectory), false);
  assert.equal(await pathExists(outsideRunDirectory), false);
});

test("run store creation fails closed when final run directory realpath resolves outside repository", async (t) => {
  const { repoRoot, outsideRoot } = await createArtifactStoreWorkspace();
  const repositoryRootRealpath = await realpath(repoRoot);
  const runDirectory = path.join(repositoryRootRealpath, ".pi", "runs", "run_20260509_001");

  const originalRealpathSync = fs.realpathSync;
  t.mock.method(fs, "realpathSync", (pathValue, options) => {
    if (pathValue === runDirectory) {
      return path.join(outsideRoot, "run_20260509_001");
    }

    return originalRealpathSync(pathValue, options);
  });

  assert.deepEqual(ensureRunStoreDirectory(repoRoot, "run_20260509_001"), {
    ok: false,
    reason: "storage_unavailable",
  });
});

async function createArtifactStoreWorkspace() {
  const baseRoot = await mkdtemp(path.join(tmpdir(), "pi-artifact-store-"));
  const repoRoot = path.join(baseRoot, "repo");
  const outsideRoot = path.join(baseRoot, "outside");
  await mkdir(repoRoot);
  await mkdir(outsideRoot);
  return { repoRoot, outsideRoot };
}

async function pathExists(pathValue) {
  try {
    await lstat(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function pathKind(pathValue) {
  const stat = await lstat(pathValue);
  if (stat.isDirectory()) {
    return "directory";
  }

  if (stat.isSymbolicLink()) {
    return "symlink";
  }

  return "other";
}
