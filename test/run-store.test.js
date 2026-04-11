import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildProjectLifecycleArtifacts } from "../src/project-workflows.js";
import { createRunStore } from "../src/run-store.js";

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function buildProgram() {
  const brief = loadFixture("project-brief.json");
  return buildProjectLifecycleArtifacts(brief).executionProgram;
}

function createDeferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTempDir(prefix, callback) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("run store saves and loads a persisted run journal snapshot", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const initialRun = {
      programId: program.id,
      program,
      runJournal: {
        programId: program.id,
        status: "running",
        stopReason: null,
        contractRuns: [],
        completedContractIds: [],
        pendingContractIds: program.contracts.map((contract) => contract.id)
      }
    };

    const saved = await runStore.saveRun(initialRun);
    assert.equal(saved.artifactType, "persisted_run_record");
    assert.equal(saved.repositoryRoot, rootDir);
    assert.equal(saved.programId, program.id);
    assert.deepEqual(saved.sourceArtifactIds, [
      `execution_program:${program.id}`,
      `run_journal:${program.id}`
    ]);
    assert.equal(saved.lineageDepth, 2);
    assert.deepEqual(saved.actionClasses, []);
    assert.equal(saved.policyProfile, null);
    assert.equal(saved.validationArtifacts.length, 1);
    assert.equal(saved.validationArtifacts[0].status, "not_captured");
    assert.equal(saved.lastStatus, "running");
    assert.equal(saved.stopReasonCode, null);
    assert.equal(saved.validationOutcome, "not_run");
    assert.equal(saved.pendingContractIds.length, program.contracts.length);
    assert.equal(saved.runJournal.artifactType, "run_journal");
    assert.deepEqual(saved.runJournal.sourceArtifactIds, [`execution_program:${program.id}`]);
    assert.equal(saved.runJournal.lineageDepth, 1);
    assert.deepEqual(saved.runJournal.actionClasses, []);
    assert.equal(saved.runJournal.policyProfile, null);
    assert.equal(saved.runJournal.validationArtifacts.length, 1);
    assert.equal(saved.runJournal.validationArtifacts[0].status, "not_captured");

    const loaded = await runStore.loadRun(program.id);
    assert.equal(loaded.artifactType, "persisted_run_record");
    assert.equal(loaded.repositoryRoot, rootDir);
    assert.equal(loaded.programId, program.id);
    assert.equal(loaded.lastStatus, "running");
    assert.equal(loaded.validationOutcome, "not_run");
    assert.deepEqual(loaded.runJournal.pendingContractIds, initialRun.runJournal.pendingContractIds);

    const runFilePath = join(rootDir, ".pi", "runs", `${encodeURIComponent(program.id)}.json`);
    const persistedOnDisk = JSON.parse(await readFile(runFilePath, "utf8"));
    assert.equal(persistedOnDisk.artifactType, "persisted_run_record");
    assert.equal(persistedOnDisk.repositoryRoot, rootDir);
    assert.equal(persistedOnDisk.programId, program.id);
    assert.deepEqual(persistedOnDisk.sourceArtifactIds, [
      `execution_program:${program.id}`,
      `run_journal:${program.id}`
    ]);
    assert.equal(persistedOnDisk.runJournal.status, "running");
    assert.equal(persistedOnDisk.runJournal.artifactType, "run_journal");
  });
});

test("run store updates a persisted run journal and preserves createdAt", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });

    await runStore.saveRun({
      programId: program.id,
      program,
      runJournal: {
        programId: program.id,
        status: "running",
        stopReason: null,
        contractRuns: [],
        completedContractIds: [],
        pendingContractIds: program.contracts.map((contract) => contract.id)
      }
    });

    const updated = await runStore.updateRun(program.id, (existing) => ({
      ...existing,
      runJournal: {
        programId: program.id,
        status: "blocked",
        stopReason: "waiting for external dependency",
        contractRuns: [
          {
            contractId: program.contracts[0].id,
            status: "success",
            summary: `Executed ${program.contracts[0].id}.`,
            evidence: [
              "roles: explorer -> implementer -> verifier",
              "run explorer: success",
              "run implementer: success",
              "run verifier: success"
            ],
            openQuestions: []
          }
        ],
        completedContractIds: [program.contracts[0].id],
        pendingContractIds: program.contracts.slice(1).map((contract) => contract.id)
      }
    }));

    assert.equal(updated.lastStatus, "blocked");
    assert.equal(updated.stopReason, "waiting for external dependency");
    assert.equal(updated.stopReasonCode, "missing_dependency");
    assert.equal(updated.validationOutcome, "blocked");
    assert.deepEqual(updated.actionClasses, ["read_repo", "write_allowed"]);
    assert.equal(updated.policyProfile, null);
    assert.equal(updated.validationArtifacts.length, 1);
    assert.equal(updated.validationArtifacts[0].status, "not_captured");
    assert.equal(updated.createdAt <= updated.updatedAt, true);

    const loaded = await runStore.loadRun(program.id);
    assert.equal(loaded.lastStatus, "blocked");
    assert.equal(loaded.stopReasonCode, "missing_dependency");
    assert.equal(loaded.runJournal.validationOutcome, "blocked");
    assert.deepEqual(loaded.runJournal.actionClasses, ["read_repo", "write_allowed"]);
    assert.equal(loaded.runJournal.policyProfile, null);
    assert.equal(loaded.runJournal.validationArtifacts.length, 1);
    assert.equal(loaded.runJournal.validationArtifacts[0].status, "not_captured");
    assert.equal(loaded.runJournal.contractRuns.length, 1);
    assert.equal(loaded.createdAt, updated.createdAt);
  });
});

test("run store load backfills lineage and evidence metadata for legacy persisted records", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const runPath = join(rootDir, ".pi", "runs", `${encodeURIComponent(program.id)}.json`);

    await mkdir(join(rootDir, ".pi", "runs"), { recursive: true });
    await writeFile(runPath, `${JSON.stringify({
      formatVersion: 1,
      programId: program.id,
      program,
      runJournal: {
        programId: program.id,
        status: "running",
        stopReason: null,
        contractRuns: [],
        completedContractIds: [],
        pendingContractIds: program.contracts.map((contract) => contract.id)
      },
      completedContractIds: [],
      pendingContractIds: program.contracts.map((contract) => contract.id),
      lastStatus: "running",
      stopReason: null,
      stopReasonCode: null,
      validationOutcome: "not_run",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8");

    const loaded = await runStore.loadRun(program.id);
    assert.equal(loaded.artifactType, "persisted_run_record");
    assert.equal(loaded.repositoryRoot, rootDir);
    assert.deepEqual(loaded.sourceArtifactIds, [
      `execution_program:${program.id}`,
      `run_journal:${program.id}`
    ]);
    assert.equal(loaded.lineageDepth, 2);
    assert.deepEqual(loaded.actionClasses, []);
    assert.equal(loaded.policyProfile, null);
    assert.equal(loaded.validationArtifacts.length, 1);
    assert.equal(loaded.validationArtifacts[0].status, "not_captured");
    assert.equal(loaded.runJournal.artifactType, "run_journal");
    assert.deepEqual(loaded.runJournal.sourceArtifactIds, [`execution_program:${program.id}`]);
    assert.equal(loaded.runJournal.lineageDepth, 1);
    assert.deepEqual(loaded.runJournal.actionClasses, []);
    assert.equal(loaded.runJournal.validationArtifacts.length, 1);
    assert.equal(loaded.runJournal.validationArtifacts[0].status, "not_captured");
  });
});

test("run store normalizes unsupported action classes and uncaptured validation claims before persistence", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });

    const saved = await runStore.saveRun({
      programId: program.id,
      actionClasses: ["access_secret", "mutate_git_state"],
      validationArtifacts: [
        {
          artifactType: "validation_artifact",
          reference: null,
          status: "captured"
        }
      ],
      program,
      runJournal: {
        programId: program.id,
        status: "blocked",
        stopReason: "waiting for external dependency",
        actionClasses: ["access_network", "access_secret"],
        validationArtifacts: [
          {
            artifactType: "validation_artifact",
            reference: null,
            status: "captured"
          }
        ],
        contractRuns: [
          {
            contractId: program.contracts[0].id,
            status: "success",
            summary: `Executed ${program.contracts[0].id}.`,
            evidence: [
              "run explorer: success"
            ],
            openQuestions: []
          }
        ],
        completedContractIds: [program.contracts[0].id],
        pendingContractIds: program.contracts.slice(1).map((contract) => contract.id)
      }
    });

    assert.deepEqual(saved.actionClasses, ["read_repo"]);
    assert.deepEqual(saved.runJournal.actionClasses, ["read_repo"]);
    assert.deepEqual(saved.validationArtifacts, [
      {
        artifactType: "validation_artifact",
        reference: null,
        status: "not_captured",
        validationOutcome: "blocked"
      }
    ]);
    assert.deepEqual(saved.runJournal.validationArtifacts, [
      {
        artifactType: "validation_artifact",
        reference: null,
        status: "not_captured",
        validationOutcome: "blocked"
      }
    ]);

    const loaded = await runStore.loadRun(program.id);
    assert.deepEqual(loaded.actionClasses, ["read_repo"]);
    assert.deepEqual(loaded.runJournal.actionClasses, ["read_repo"]);
    assert.deepEqual(loaded.validationArtifacts, [
      {
        artifactType: "validation_artifact",
        reference: null,
        status: "not_captured",
        validationOutcome: "blocked"
      }
    ]);
    assert.deepEqual(loaded.runJournal.validationArtifacts, [
      {
        artifactType: "validation_artifact",
        reference: null,
        status: "not_captured",
        validationOutcome: "blocked"
      }
    ]);
  });
});

test("run store serializes overlapping updateRun calls so updates are not clobbered", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const [firstContract, secondContract] = program.contracts;
    assert.ok(firstContract);
    assert.ok(secondContract);

    await runStore.saveRun({
      programId: program.id,
      program,
      runJournal: {
        programId: program.id,
        status: "running",
        stopReason: null,
        contractRuns: [],
        completedContractIds: [],
        pendingContractIds: program.contracts.map((contract) => contract.id)
      }
    });

    function appendSuccessfulRun(existing, contractId) {
      return {
        ...existing,
        runJournal: {
          ...existing.runJournal,
          status: "running",
          stopReason: null,
          contractRuns: [
            ...existing.runJournal.contractRuns,
            {
              contractId,
              status: "success",
              summary: `Executed ${contractId}.`,
              evidence: [],
              openQuestions: []
            }
          ],
          completedContractIds: [
            ...existing.runJournal.completedContractIds,
            contractId
          ],
          pendingContractIds: existing.runJournal.pendingContractIds.filter((pendingId) => pendingId !== contractId)
        }
      };
    }

    const firstUpdaterStarted = createDeferred();
    const allowFirstUpdaterToFinish = createDeferred();
    let secondObservedCompletedContractIds = null;

    const firstUpdate = runStore.updateRun(program.id, async (existing) => {
      firstUpdaterStarted.resolve();
      await allowFirstUpdaterToFinish.promise;
      return appendSuccessfulRun(existing, firstContract.id);
    });

    await firstUpdaterStarted.promise;
    const secondUpdate = runStore.updateRun(program.id, async (existing) => {
      secondObservedCompletedContractIds = [...existing.runJournal.completedContractIds];
      return appendSuccessfulRun(existing, secondContract.id);
    });

    allowFirstUpdaterToFinish.resolve();
    await Promise.all([firstUpdate, secondUpdate]);

    assert.deepEqual(secondObservedCompletedContractIds, [firstContract.id]);

    const loaded = await runStore.loadRun(program.id);
    assert.equal(loaded.runJournal.contractRuns.length, 2);
    assert.deepEqual(
      new Set(loaded.runJournal.completedContractIds),
      new Set([firstContract.id, secondContract.id])
    );
  });
});

test("run store serializes concurrent saveRun and updateRun calls so writes are not clobbered", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const [firstContract, secondContract] = program.contracts;
    assert.ok(firstContract);
    assert.ok(secondContract);

    await runStore.saveRun({
      programId: program.id,
      program,
      runJournal: {
        programId: program.id,
        status: "running",
        stopReason: null,
        contractRuns: [],
        completedContractIds: [],
        pendingContractIds: program.contracts.map((contract) => contract.id)
      }
    });

    function createSuccessfulContractRun(contractId) {
      return {
        contractId,
        status: "success",
        summary: `Executed ${contractId}.`,
        evidence: [],
        openQuestions: []
      };
    }

    function appendSuccessfulRun(existing, contractId) {
      return {
        ...existing,
        runJournal: {
          ...existing.runJournal,
          status: "running",
          stopReason: null,
          contractRuns: [
            ...existing.runJournal.contractRuns,
            createSuccessfulContractRun(contractId)
          ],
          completedContractIds: [
            ...existing.runJournal.completedContractIds,
            contractId
          ],
          pendingContractIds: existing.runJournal.pendingContractIds.filter((pendingId) => pendingId !== contractId)
        }
      };
    }

    const updateStarted = createDeferred();
    const allowUpdateToFinish = createDeferred();

    const updatePromise = runStore.updateRun(program.id, async (existing) => {
      updateStarted.resolve();
      await allowUpdateToFinish.promise;
      return appendSuccessfulRun(existing, firstContract.id);
    });

    await updateStarted.promise;
    const savePromise = runStore.saveRun({
      programId: program.id,
      program,
      runJournal: {
        programId: program.id,
        status: "running",
        stopReason: null,
        contractRuns: [
          createSuccessfulContractRun(firstContract.id),
          createSuccessfulContractRun(secondContract.id)
        ],
        completedContractIds: [firstContract.id, secondContract.id],
        pendingContractIds: program.contracts
          .map((contract) => contract.id)
          .filter((contractId) => !new Set([firstContract.id, secondContract.id]).has(contractId))
      }
    });

    allowUpdateToFinish.resolve();
    await Promise.all([updatePromise, savePromise]);

    const loaded = await runStore.loadRun(program.id);
    assert.equal(loaded.runJournal.contractRuns.length, 2);
    assert.deepEqual(
      new Set(loaded.runJournal.completedContractIds),
      new Set([firstContract.id, secondContract.id])
    );
  });
});

test("run store renews long-held update locks so they are not overtaken as stale", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({
      rootDir,
      runUpdateLockRetryDelayMs: 5,
      runUpdateLockTimeoutMs: 1000,
      runUpdateLockStaleMs: 80,
      runUpdateLockHeartbeatIntervalMs: 20
    });
    const [firstContract, secondContract] = program.contracts;
    assert.ok(firstContract);
    assert.ok(secondContract);

    await runStore.saveRun({
      programId: program.id,
      program,
      runJournal: {
        programId: program.id,
        status: "running",
        stopReason: null,
        contractRuns: [],
        completedContractIds: [],
        pendingContractIds: program.contracts.map((contract) => contract.id)
      }
    });

    function appendSuccessfulRun(existing, contractId) {
      return {
        ...existing,
        runJournal: {
          ...existing.runJournal,
          status: "running",
          stopReason: null,
          contractRuns: [
            ...existing.runJournal.contractRuns,
            {
              contractId,
              status: "success",
              summary: `Executed ${contractId}.`,
              evidence: [],
              openQuestions: []
            }
          ],
          completedContractIds: [
            ...existing.runJournal.completedContractIds,
            contractId
          ],
          pendingContractIds: existing.runJournal.pendingContractIds.filter((pendingId) => pendingId !== contractId)
        }
      };
    }

    const firstUpdaterStarted = createDeferred();
    const allowFirstUpdaterToFinish = createDeferred();
    let secondUpdaterEntered = false;
    let secondObservedCompletedContractIds = null;

    const firstUpdate = runStore.updateRun(program.id, async (existing) => {
      firstUpdaterStarted.resolve();
      await allowFirstUpdaterToFinish.promise;
      return appendSuccessfulRun(existing, firstContract.id);
    });

    await firstUpdaterStarted.promise;
    const secondUpdate = runStore.updateRun(program.id, async (existing) => {
      secondUpdaterEntered = true;
      secondObservedCompletedContractIds = [...existing.runJournal.completedContractIds];
      return appendSuccessfulRun(existing, secondContract.id);
    });

    await sleep(200);
    assert.equal(secondUpdaterEntered, false);

    allowFirstUpdaterToFinish.resolve();
    await Promise.all([firstUpdate, secondUpdate]);

    assert.deepEqual(secondObservedCompletedContractIds, [firstContract.id]);

    const loaded = await runStore.loadRun(program.id);
    assert.deepEqual(
      new Set(loaded.runJournal.completedContractIds),
      new Set([firstContract.id, secondContract.id])
    );
  });
});

test("run store stale lock cleanup does not delete a newer lock created during stale-check race", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const initialStore = createRunStore({ rootDir });

    await initialStore.saveRun({
      programId: program.id,
      program,
      runJournal: {
        programId: program.id,
        status: "running",
        stopReason: null,
        contractRuns: [],
        completedContractIds: [],
        pendingContractIds: program.contracts.map((contract) => contract.id)
      }
    });

    const lockPath = join(rootDir, ".pi", "runs", `${encodeURIComponent(program.id)}.json.lock`);
    const staleLockId = "stale-lock-under-observation";
    const newerLockId = "newer-lock-must-survive";
    await writeFile(lockPath, `${JSON.stringify({
      pid: 123,
      lockId: staleLockId,
      acquiredAt: new Date(Date.now() - 10_000).toISOString()
    })}\n`, "utf8");
    const staleTime = new Date(Date.now() - 10_000);
    await utimes(lockPath, staleTime, staleTime);

    let raceInjected = false;
    let updaterInvoked = false;
    const runStore = createRunStore({
      rootDir,
      runUpdateLockRetryDelayMs: 5,
      runUpdateLockTimeoutMs: 120,
      runUpdateLockStaleMs: 500,
      runUpdateLockHeartbeatIntervalMs: 100,
      onStaleLockObserved: async ({ lockPath: observedLockPath, lockId }) => {
        if (lockId !== staleLockId) {
          return;
        }

        raceInjected = true;
        await writeFile(observedLockPath, `${JSON.stringify({
          pid: 456,
          lockId: newerLockId,
          acquiredAt: new Date().toISOString()
        })}\n`, "utf8");
      }
    });

    await assert.rejects(
      () => runStore.updateRun(program.id, (existing) => {
        updaterInvoked = true;
        return existing;
      }),
      /Timed out acquiring run update lock/
    );

    assert.equal(raceInjected, true);
    assert.equal(updaterInvoked, false);
    const remainingLock = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(remainingLock.lockId, newerLockId);
  });
});
