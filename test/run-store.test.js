import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    assert.equal(saved.programId, program.id);
    assert.equal(saved.lastStatus, "running");
    assert.equal(saved.pendingContractIds.length, program.contracts.length);

    const loaded = await runStore.loadRun(program.id);
    assert.equal(loaded.programId, program.id);
    assert.equal(loaded.lastStatus, "running");
    assert.deepEqual(loaded.runJournal.pendingContractIds, initialRun.runJournal.pendingContractIds);

    const runFilePath = join(rootDir, ".pi", "runs", `${encodeURIComponent(program.id)}.json`);
    const persistedOnDisk = JSON.parse(await readFile(runFilePath, "utf8"));
    assert.equal(persistedOnDisk.programId, program.id);
    assert.equal(persistedOnDisk.runJournal.status, "running");
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
            evidence: [],
            openQuestions: []
          }
        ],
        completedContractIds: [program.contracts[0].id],
        pendingContractIds: program.contracts.slice(1).map((contract) => contract.id)
      }
    }));

    assert.equal(updated.lastStatus, "blocked");
    assert.equal(updated.stopReason, "waiting for external dependency");
    assert.equal(updated.createdAt <= updated.updatedAt, true);

    const loaded = await runStore.loadRun(program.id);
    assert.equal(loaded.lastStatus, "blocked");
    assert.equal(loaded.runJournal.contractRuns.length, 1);
    assert.equal(loaded.createdAt, updated.createdAt);
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
