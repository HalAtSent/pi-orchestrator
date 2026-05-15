import assert from "node:assert/strict";
import fs from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureRunStoreDirectory, writeWorkOrderArtifact } from "../src/kernel/artifact-store.js";
import { validateWorkOrder } from "../src/kernel/work-order.js";

test("valid Work Order artifact writes exactly one artifact under the run store", async () => {
  const { repoRoot } = await createArtifactStoreWorkspace();
  const repositoryRootRealpath = await realpath(repoRoot);
  const runId = "run_20260515_001";
  const workOrder = validWorkOrder(repoRoot);
  const originalWorkOrder = structuredClone(workOrder);
  const expectedArtifactPath = path.join(repositoryRootRealpath, ".pi", "runs", runId, "work-order.json");

  const result = writeWorkOrderArtifact(repoRoot, runId, workOrder);
  const persistedWorkOrder = JSON.parse(await readFile(expectedArtifactPath, "utf8"));
  const persistedValidation = validateWorkOrder(persistedWorkOrder);

  assert.deepEqual(result, {
    ok: true,
    artifactPath: expectedArtifactPath,
    validation: persistedValidation,
  });
  assert.deepEqual(persistedWorkOrder, originalWorkOrder);
  assert.deepEqual(workOrder, originalWorkOrder);
  assert.deepEqual(await pathKind(path.join(repositoryRootRealpath, ".pi")), "directory");
  assert.deepEqual(await pathKind(path.join(repositoryRootRealpath, ".pi", "runs")), "directory");
  assert.deepEqual(await pathKind(path.dirname(expectedArtifactPath)), "directory");
});

test("Work Order artifact writes validate non-enumerable toJSON serialized form before storage creation", async (t) => {
  const { repoRoot } = await createArtifactStoreWorkspace();
  const workOrder = validWorkOrder(repoRoot);
  const serializedWorkOrder = { kind: "not_work_order" };
  const validation = validateWorkOrder(serializedWorkOrder);
  const writeCalls = [];
  const mkdirCalls = [];

  Object.defineProperty(workOrder, "toJSON", {
    enumerable: false,
    value: () => serializedWorkOrder,
  });

  t.mock.method(fs, "mkdirSync", (...args) => {
    mkdirCalls.push(args);
    assert.fail("invalid serialized Work Order attempted to create run storage");
  });
  t.mock.method(fs, "writeFileSync", (...args) => {
    writeCalls.push(args);
    assert.fail("invalid serialized Work Order attempted to write an artifact");
  });

  assert.deepEqual(writeWorkOrderArtifact(repoRoot, "run_20260515_001", workOrder), {
    ok: false,
    reason: "invalid_work_order",
    validation,
  });
  assert.deepEqual(mkdirCalls, []);
  assert.deepEqual(writeCalls, []);
  assert.equal(await pathExists(path.join(repoRoot, ".pi")), false);
});

test("Work Order artifact writes reject unparseable or no-bytes serialization before storage creation", async (t) => {
  const cases = [
    {
      name: "throwing toJSON",
      workOrder: (repoRoot) => {
        const workOrder = validWorkOrder(repoRoot);
        Object.defineProperty(workOrder, "toJSON", {
          enumerable: false,
          value: () => {
            throw new Error("cannot serialize");
          },
        });
        return workOrder;
      },
    },
    {
      name: "no JSON bytes",
      workOrder: () => undefined,
    },
  ];

  for (const { name, workOrder } of cases) {
    await t.test(name, async (t) => {
      const { repoRoot } = await createArtifactStoreWorkspace();
      const validation = validateWorkOrder(null);
      const writeCalls = [];
      const mkdirCalls = [];

      t.mock.method(fs, "mkdirSync", (...args) => {
        mkdirCalls.push(args);
        assert.fail(`${name} attempted to create run storage`);
      });
      t.mock.method(fs, "writeFileSync", (...args) => {
        writeCalls.push(args);
        assert.fail(`${name} attempted to write an artifact`);
      });

      assert.deepEqual(writeWorkOrderArtifact(repoRoot, "run_20260515_001", workOrder(repoRoot)), {
        ok: false,
        reason: "invalid_work_order",
        validation,
      });
      assert.deepEqual(mkdirCalls, []);
      assert.deepEqual(writeCalls, []);
      assert.equal(await pathExists(path.join(repoRoot, ".pi")), false);
    });
  }
});

test("invalid Work Order artifact writes fail before storage creation or artifact writes", async (t) => {
  const { repoRoot } = await createArtifactStoreWorkspace();
  const workOrder = validWorkOrder(repoRoot);
  delete workOrder.goal;
  const validation = validateWorkOrder(workOrder);
  const writeCalls = [];
  const mkdirCalls = [];

  t.mock.method(fs, "mkdirSync", (...args) => {
    mkdirCalls.push(args);
    assert.fail("invalid Work Order attempted to create run storage");
  });
  t.mock.method(fs, "writeFileSync", (...args) => {
    writeCalls.push(args);
    assert.fail("invalid Work Order attempted to write an artifact");
  });

  assert.deepEqual(writeWorkOrderArtifact(repoRoot, "run_20260515_001", workOrder), {
    ok: false,
    reason: "invalid_work_order",
    validation,
  });
  assert.deepEqual(mkdirCalls, []);
  assert.deepEqual(writeCalls, []);
  assert.equal(await pathExists(path.join(repoRoot, ".pi")), false);
});

test("mismatched Work Order repository root fails before storage creation or artifact writes", async (t) => {
  const { repoRoot, outsideRoot } = await createArtifactStoreWorkspace();
  const workOrder = validWorkOrder(outsideRoot);
  const writeCalls = [];
  const mkdirCalls = [];

  t.mock.method(fs, "mkdirSync", (...args) => {
    mkdirCalls.push(args);
    assert.fail("repository root mismatch attempted to create run storage");
  });
  t.mock.method(fs, "writeFileSync", (...args) => {
    writeCalls.push(args);
    assert.fail("repository root mismatch attempted to write an artifact");
  });

  assert.deepEqual(writeWorkOrderArtifact(repoRoot, "run_20260515_001", workOrder), {
    ok: false,
    reason: "repository_root_mismatch",
  });
  assert.deepEqual(mkdirCalls, []);
  assert.deepEqual(writeCalls, []);
  assert.equal(await pathExists(path.join(repoRoot, ".pi")), false);
  assert.equal(await pathExists(path.join(repoRoot, ".pi", "runs", "run_20260515_001", "work-order.json")), false);
  assert.equal(await pathExists(path.join(outsideRoot, ".pi")), false);
});

test("invalid Work Order validation short-circuits before repository root mismatch", async () => {
  const { repoRoot, outsideRoot } = await createArtifactStoreWorkspace();
  const workOrder = validWorkOrder(outsideRoot);
  delete workOrder.goal;
  const validation = validateWorkOrder(workOrder);

  assert.deepEqual(writeWorkOrderArtifact(repoRoot, "run_20260515_001", workOrder), {
    ok: false,
    reason: "invalid_work_order",
    validation,
  });
  assert.equal(await pathExists(path.join(repoRoot, ".pi")), false);
  assert.equal(await pathExists(path.join(outsideRoot, ".pi")), false);
});

test("invalid or unavailable storage repository roots fail before repository root mismatch", async () => {
  const { repoRoot, outsideRoot } = await createArtifactStoreWorkspace();
  const missingRoot = path.join(repoRoot, "missing");
  const workOrder = validWorkOrder(outsideRoot);

  for (const repositoryRoot of [null, "", " ", "relative/repo"]) {
    assert.deepEqual(writeWorkOrderArtifact(repositoryRoot, "run_20260515_001", workOrder), {
      ok: false,
      reason: "invalid_repository_root",
    });
  }

  assert.deepEqual(writeWorkOrderArtifact(missingRoot, "run_20260515_001", workOrder), {
    ok: false,
    reason: "repository_root_unavailable",
  });
  assert.equal(await pathExists(path.join(repoRoot, ".pi")), false);
  assert.equal(await pathExists(path.join(outsideRoot, ".pi")), false);
});

test("Work Order repository root binding accepts matching realpaths through a symlink", async () => {
  const { repoRoot, outsideRoot } = await createArtifactStoreWorkspace();
  const repoAlias = path.join(outsideRoot, "repo-alias");
  await symlink(repoRoot, repoAlias);
  const repositoryRootRealpath = await realpath(repoRoot);
  const runId = "run_20260515_001";
  const workOrder = validWorkOrder(repoAlias);
  const expectedArtifactPath = path.join(repositoryRootRealpath, ".pi", "runs", runId, "work-order.json");
  const expectedValidation = validateWorkOrder(workOrder);

  assert.deepEqual(writeWorkOrderArtifact(repoRoot, runId, workOrder), {
    ok: true,
    artifactPath: expectedArtifactPath,
    validation: expectedValidation,
  });
  assert.deepEqual(JSON.parse(await readFile(expectedArtifactPath, "utf8")), workOrder);
});

test("valid Work Order with invalid run id returns run-store failure without creating .pi", async () => {
  const { repoRoot } = await createArtifactStoreWorkspace();
  const workOrder = validWorkOrder(repoRoot);

  assert.deepEqual(writeWorkOrderArtifact(repoRoot, "../run", workOrder), {
    ok: false,
    reason: "invalid_run_id",
  });
  assert.equal(await pathExists(path.join(repoRoot, ".pi")), false);
});

test("Work Order artifact writes are create-only for existing file directory and symlink conflicts", async (t) => {
  const cases = [
    {
      name: "file",
      setup: async ({ artifactPath }) => {
        await writeFile(artifactPath, "existing artifact");
      },
      assertOutside: async () => {},
    },
    {
      name: "directory",
      setup: async ({ artifactPath }) => {
        await mkdir(artifactPath);
      },
      assertOutside: async () => {},
    },
    {
      name: "symlink",
      setup: async ({ artifactPath, outsideRoot }) => {
        const outsideTarget = path.join(outsideRoot, "outside-work-order.json");
        await writeFile(outsideTarget, "outside original");
        await symlink(outsideTarget, artifactPath);
      },
      assertOutside: async ({ outsideRoot }) => {
        const outsideTarget = path.join(outsideRoot, "outside-work-order.json");
        assert.equal(await readFile(outsideTarget, "utf8"), "outside original");
      },
    },
  ];

  for (const { name, setup, assertOutside } of cases) {
    await t.test(name, async () => {
      const { repoRoot, outsideRoot } = await createArtifactStoreWorkspace();
      const runId = "run_20260515_001";
      const workOrder = validWorkOrder(repoRoot);
      const storeResult = ensureRunStoreDirectory(repoRoot, runId);
      assert.equal(storeResult.ok, true);
      const artifactPath = path.join(storeResult.runDirectory, "work-order.json");
      await setup({ artifactPath, outsideRoot });

      assert.deepEqual(writeWorkOrderArtifact(repoRoot, runId, workOrder), {
        ok: false,
        reason: "artifact_exists",
      });
      await assertOutside({ outsideRoot });
    });
  }
});

test("non-EEXIST Work Order artifact write failure returns write_failed", async (t) => {
  const { repoRoot } = await createArtifactStoreWorkspace();
  const workOrder = validWorkOrder(repoRoot);
  const originalWriteFileSync = fs.writeFileSync;
  let simulated = false;

  t.mock.method(fs, "writeFileSync", (pathValue, data, options) => {
    if (path.basename(pathValue) === "work-order.json" && simulated === false) {
      simulated = true;
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }

    return originalWriteFileSync(pathValue, data, options);
  });

  assert.deepEqual(writeWorkOrderArtifact(repoRoot, "run_20260515_001", workOrder), {
    ok: false,
    reason: "write_failed",
  });
  assert.equal(simulated, true);
});

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

function validWorkOrder(repositoryRoot) {
  return {
    schemaVersion: 1,
    kind: "work_order",
    state: "active",
    id: "wo-artifact-write",
    goal: "Write a validated Work Order artifact.",
    repositoryRoot,
    policyProfile: "default",
    readiness: {
      status: "ready",
      checks: [
        {
          id: "authority-cited",
          status: "satisfied",
          evidence: "docs/WORK-ORDER-SCHEMA.md",
        },
      ],
      blockers: [],
    },
    change: {
      class: "infrastructure_tooling",
      reviewDepth: "medium",
      patchBudget: {
        expectedFilesChanged: 2,
        maxApproxChangedLines: 250,
        allowedSurfaces: ["src/kernel/artifact-store.js", "test/artifact-store.test.js"],
        mayMixSurfaces: false,
        incidentalRefactors: false,
      },
    },
    scope: {
      allowed: ["work-order.json"],
      forbidden: [".git/", ".pi/", "node_modules/", "dist/", ".env"],
      newFiles: "listed_only",
      allowedNewFiles: ["work-order.json"],
    },
    context: {
      files: [
        {
          path: "src/kernel/artifact-store.js",
          required: true,
          reason: "Artifact-store primitive under test.",
        },
      ],
      notes: [],
      priorArtifacts: [],
      manifest: [],
      budget: {
        maxTokens: 120000,
        truncationPolicy: "fail_if_required_context_truncated",
      },
    },
    acceptance: [
      {
        id: "acc-001",
        text: "A valid Work Order writes one artifact.",
        required: true,
      },
    ],
    verification: {
      commands: [
        {
          id: "verify-artifact-store",
          command: "node --test test/artifact-store.test.js",
          cwd: ".",
          required: true,
          actionClasses: ["read_repository", "execute_local_command"],
          reason: "Run focused artifact-store tests.",
        },
      ],
      allowDerivedCommands: true,
      required: true,
    },
    execution: {
      autonomyLevel: "bounded_patch",
      modelToolRoute: {
        routeRequired: false,
        preferredWorker: "deterministic_local",
        preferredModels: [],
        tools: ["read_repository", "write_repository", "execute_local_command"],
        rationale: "Local deterministic validation and tests are sufficient.",
      },
      rolePackets: [],
      counterexampleReview: {
        required: false,
        reason: "Focused artifact-store primitive.",
      },
    },
    nonGoals: [
      "Do not load Work Order artifacts.",
      "Do not write Evidence Pack artifacts.",
      "Do not change CLI behavior.",
    ],
    risk: {
      level: "medium",
      reasons: ["Filesystem write primitive must fail closed."],
    },
    operationalReadiness: {
      observability: {
        breakageDetection: "Focused node:test coverage and diff whitespace checks catch regressions.",
        signals: ["node --test test/artifact-store.test.js", "git diff --check"],
        manualChecks: [],
      },
      rollbackRecovery: {
        required: false,
        plan: null,
        recoverySteps: [],
        notApplicableReason: "Small artifact-store patch can be reverted directly.",
      },
    },
    reviewFocus: ["Confirm Work Order validation happens before storage writes."],
    approval: {
      required: false,
      approvalId: null,
      approvedAt: null,
      approvedBy: null,
      approvedFingerprint: null,
      approvedActionClasses: [],
    },
    repair: {
      maxLoops: 1,
      mayWidenScope: false,
    },
    extensions: {},
  };
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
