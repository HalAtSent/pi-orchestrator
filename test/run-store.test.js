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
    assert.equal(saved.policyProfile, "default");
    assert.equal(saved.validationArtifacts.length, 1);
    assert.equal(saved.validationArtifacts[0].status, "not_captured");
    assert.deepEqual(saved.reviewability, {
      status: "not_reviewable",
      reasons: ["non_terminal_status"]
    });
    assert.equal(saved.lastStatus, "running");
    assert.equal(saved.stopReasonCode, null);
    assert.equal(saved.validationOutcome, "not_run");
    assert.equal(saved.pendingContractIds.length, program.contracts.length);
    assert.equal(saved.runJournal.artifactType, "run_journal");
    assert.deepEqual(saved.runJournal.sourceArtifactIds, [`execution_program:${program.id}`]);
    assert.equal(saved.runJournal.lineageDepth, 1);
    assert.deepEqual(saved.runJournal.actionClasses, []);
    assert.equal(saved.runJournal.policyProfile, "default");
    assert.equal(saved.runJournal.validationArtifacts.length, 1);
    assert.equal(saved.runJournal.validationArtifacts[0].status, "not_captured");
    assert.deepEqual(saved.runJournal.reviewability, {
      status: "not_reviewable",
      reasons: ["non_terminal_status"]
    });

    const loaded = await runStore.loadRun(program.id);
    assert.equal(loaded.artifactType, "persisted_run_record");
    assert.equal(loaded.repositoryRoot, rootDir);
    assert.equal(loaded.programId, program.id);
    assert.equal(loaded.lastStatus, "running");
    assert.equal(loaded.validationOutcome, "not_run");
    assert.deepEqual(loaded.reviewability, {
      status: "not_reviewable",
      reasons: ["non_terminal_status"]
    });
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
    assert.deepEqual(updated.reviewability, {
      status: "reviewable",
      reasons: []
    });
    assert.equal(updated.policyProfile, "default");
    assert.equal(updated.validationArtifacts.length, 1);
    assert.equal(updated.validationArtifacts[0].status, "not_captured");
    assert.equal(updated.createdAt <= updated.updatedAt, true);

    const loaded = await runStore.loadRun(program.id);
    assert.equal(loaded.lastStatus, "blocked");
    assert.equal(loaded.stopReasonCode, "missing_dependency");
    assert.equal(loaded.runJournal.validationOutcome, "blocked");
    assert.deepEqual(loaded.runJournal.actionClasses, ["read_repo", "write_allowed"]);
    assert.equal(loaded.runJournal.policyProfile, "default");
    assert.equal(loaded.runJournal.validationArtifacts.length, 1);
    assert.equal(loaded.runJournal.validationArtifacts[0].status, "not_captured");
    assert.deepEqual(loaded.runJournal.reviewability, {
      status: "reviewable",
      reasons: []
    });
    assert.equal(loaded.runJournal.contractRuns.length, 1);
    assert.deepEqual(loaded.runJournal.contractRuns[0].changedSurface, {
      capture: "not_captured",
      paths: []
    });
    assert.equal(loaded.createdAt, updated.createdAt);
  });
});

test("run store persists success with placeholder-only validation evidence unless captured artifacts are supplied", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });

    const placeholderSuccess = await runStore.saveRun({
      programId: `${program.id}-placeholder-success`,
      program: {
        ...program,
        id: `${program.id}-placeholder-success`
      },
      runJournal: {
        programId: `${program.id}-placeholder-success`,
        status: "success",
        stopReason: null,
        contractRuns: program.contracts.map((contract) => ({
          contractId: contract.id,
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        })),
        completedContractIds: program.contracts.map((contract) => contract.id),
        pendingContractIds: []
      }
    });

    assert.equal(placeholderSuccess.validationOutcome, "pass");
    assert.deepEqual(placeholderSuccess.validationArtifacts, [
      {
        artifactType: "validation_artifact",
        reference: null,
        status: "not_captured",
        validationOutcome: "pass"
      }
    ]);
    assert.deepEqual(placeholderSuccess.runJournal.validationArtifacts, [
      {
        artifactType: "validation_artifact",
        reference: null,
        status: "not_captured",
        validationOutcome: "pass"
      }
    ]);
    assert.deepEqual(placeholderSuccess.reviewability, {
      status: "not_reviewable",
      reasons: [
        "validation_artifacts_not_captured",
        "provider_model_evidence_requirement_unknown"
      ]
    });

    const capturedSuccessProgramId = `${program.id}-captured-success`;
    const capturedSuccess = await runStore.saveRun({
      programId: capturedSuccessProgramId,
      validationArtifacts: [
        {
          artifactType: "validation_artifact",
          reference: "test-run:node --test --test-isolation=none",
          status: "captured"
        }
      ],
      program: {
        ...program,
        id: capturedSuccessProgramId
      },
      runJournal: {
        programId: capturedSuccessProgramId,
        status: "success",
        stopReason: null,
        validationArtifacts: [
          {
            artifactType: "validation_artifact",
            reference: "test-run:node --test --test-isolation=none",
            status: "captured"
          }
        ],
        contractRuns: program.contracts.map((contract) => ({
          contractId: contract.id,
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        })),
        completedContractIds: program.contracts.map((contract) => contract.id),
        pendingContractIds: []
      }
    });

    assert.equal(capturedSuccess.validationArtifacts[0].status, "captured");
    assert.equal(capturedSuccess.validationArtifacts[0].reference, "test-run:node --test --test-isolation=none");
    assert.equal(capturedSuccess.runJournal.validationArtifacts[0].status, "captured");
    assert.equal(capturedSuccess.runJournal.validationArtifacts[0].reference, "test-run:node --test --test-isolation=none");
    assert.deepEqual(capturedSuccess.reviewability, {
      status: "unknown",
      reasons: ["provider_model_evidence_requirement_unknown"]
    });
  });
});

test("run store marks success reviewability as reviewable when captured validation and provider/model evidence are present", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const reviewableProgramId = `${program.id}-reviewable-success`;

    const saved = await runStore.saveRun({
      programId: reviewableProgramId,
      program: {
        ...program,
        id: reviewableProgramId
      },
      runJournal: {
        programId: reviewableProgramId,
        status: "success",
        stopReason: null,
        validationArtifacts: [
          {
            artifactType: "validation_artifact",
            reference: "test-run:node --test --test-isolation=none",
            status: "captured"
          }
        ],
        contractRuns: program.contracts.map((contract) => ({
          contractId: contract.id,
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [
            "selected_provider: openai-codex",
            "selected_model: gpt-5.4"
          ],
          openQuestions: []
        })),
        completedContractIds: program.contracts.map((contract) => contract.id),
        pendingContractIds: []
      }
    });

    assert.deepEqual(saved.reviewability, {
      status: "reviewable",
      reasons: []
    });
    assert.deepEqual(saved.runJournal.reviewability, {
      status: "reviewable",
      reasons: []
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(saved.runJournal.contractRuns[0], "providerModelSelections"),
      false
    );

    const loaded = await runStore.loadRun(reviewableProgramId);
    assert.deepEqual(loaded.reviewability, {
      status: "reviewable",
      reasons: []
    });
    assert.deepEqual(loaded.runJournal.reviewability, {
      status: "reviewable",
      reasons: []
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(loaded.runJournal.contractRuns[0], "providerModelSelections"),
      false
    );
  });
});

test("run store treats present empty providerModelSelections as authoritative and skips legacy fallback", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const emptyTypedProgramId = `${program.id}-empty-typed-provider-model`;

    const saved = await runStore.saveRun({
      programId: emptyTypedProgramId,
      program: {
        ...program,
        id: emptyTypedProgramId
      },
      runJournal: {
        programId: emptyTypedProgramId,
        status: "success",
        stopReason: null,
        validationArtifacts: [
          {
            artifactType: "validation_artifact",
            reference: "test-run:node --test --test-isolation=none",
            status: "captured"
          }
        ],
        contractRuns: program.contracts.map((contract) => ({
          contractId: contract.id,
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [
            "selected_provider: openai-codex",
            "selected_model: gpt-5.4"
          ],
          providerModelSelections: [],
          openQuestions: []
        })),
        completedContractIds: program.contracts.map((contract) => contract.id),
        pendingContractIds: []
      }
    });

    assert.deepEqual(saved.reviewability, {
      status: "unknown",
      reasons: ["provider_model_evidence_requirement_unknown"]
    });
    assert.deepEqual(saved.runJournal.contractRuns[0].providerModelSelections, []);

    const loaded = await runStore.loadRun(emptyTypedProgramId);
    assert.deepEqual(loaded.reviewability, {
      status: "unknown",
      reasons: ["provider_model_evidence_requirement_unknown"]
    });
    assert.deepEqual(loaded.runJournal.contractRuns[0].providerModelSelections, []);
  });
});

test("run store persists typed providerModelSelections and keeps execution-order entries intact", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const typedProgramId = `${program.id}-typed-provider-model`;

    const typedSelections = [
      {
        role: "implementer",
        iteration: 0,
        requestedProvider: "openai-codex",
        requestedModel: "gpt-5.3-codex",
        selectedProvider: "openai-codex",
        selectedModel: "gpt-5.3-codex"
      },
      {
        role: "reviewer",
        iteration: 0,
        requestedProvider: "openai-codex",
        requestedModel: "gpt-5.4",
        selectedProvider: "openai-codex",
        selectedModel: "gpt-5.4"
      },
      {
        role: "implementer",
        iteration: 1,
        requestedProvider: "openai-codex",
        requestedModel: "gpt-5.3-codex",
        selectedProvider: "openai-codex",
        selectedModel: "gpt-5.3-codex"
      }
    ];

    const saved = await runStore.saveRun({
      programId: typedProgramId,
      program: {
        ...program,
        id: typedProgramId
      },
      runJournal: {
        programId: typedProgramId,
        status: "success",
        stopReason: null,
        validationArtifacts: [
          {
            artifactType: "validation_artifact",
            reference: "test-run:node --test --test-isolation=none",
            status: "captured"
          }
        ],
        contractRuns: program.contracts.map((contract) => ({
          contractId: contract.id,
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          providerModelEvidenceRequirement: "required",
          providerModelSelections: typedSelections,
          openQuestions: []
        })),
        completedContractIds: program.contracts.map((contract) => contract.id),
        pendingContractIds: []
      }
    });

    assert.deepEqual(saved.runJournal.contractRuns[0].providerModelSelections, typedSelections);
    assert.equal(saved.runJournal.contractRuns[0].providerModelEvidenceRequirement, "required");
    assert.deepEqual(saved.reviewability, {
      status: "reviewable",
      reasons: []
    });

    const loaded = await runStore.loadRun(typedProgramId);
    assert.deepEqual(loaded.runJournal.contractRuns[0].providerModelSelections, typedSelections);
    assert.equal(loaded.runJournal.contractRuns[0].providerModelEvidenceRequirement, "required");
    assert.deepEqual(loaded.reviewability, {
      status: "reviewable",
      reasons: []
    });
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
    assert.equal(loaded.policyProfile, "default");
    assert.equal(loaded.validationArtifacts.length, 1);
    assert.equal(loaded.validationArtifacts[0].status, "not_captured");
    assert.deepEqual(loaded.reviewability, {
      status: "not_reviewable",
      reasons: ["non_terminal_status"]
    });
    assert.equal(loaded.runJournal.artifactType, "run_journal");
    assert.deepEqual(loaded.runJournal.sourceArtifactIds, [`execution_program:${program.id}`]);
    assert.equal(loaded.runJournal.lineageDepth, 1);
    assert.deepEqual(loaded.runJournal.actionClasses, []);
    assert.equal(loaded.runJournal.validationArtifacts.length, 1);
    assert.equal(loaded.runJournal.validationArtifacts[0].status, "not_captured");
    assert.deepEqual(loaded.runJournal.reviewability, {
      status: "not_reviewable",
      reasons: ["non_terminal_status"]
    });
    assert.equal(loaded.runJournal.contractRuns.length, 0);
  });
});

test("run store load rejects malformed present changed-surface evidence", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const runPath = join(rootDir, ".pi", "runs", `${encodeURIComponent(program.id)}.json`);

    await mkdir(join(rootDir, ".pi", "runs"), { recursive: true });
    await writeFile(runPath, `${JSON.stringify({
      artifactType: "persisted_run_record",
      formatVersion: 1,
      programId: program.id,
      program,
      runJournal: {
        artifactType: "run_journal",
        programId: program.id,
        status: "blocked",
        stopReason: "waiting for dependency",
        contractRuns: [
          {
            contractId: program.contracts[0].id,
            status: "success",
            summary: `Executed ${program.contracts[0].id}.`,
            evidence: [],
            changedSurface: {
              capture: "complete",
              paths: ["../outside.js"]
            },
            openQuestions: []
          }
        ],
        completedContractIds: [program.contracts[0].id],
        pendingContractIds: program.contracts.slice(1).map((contract) => contract.id)
      },
      completedContractIds: [program.contracts[0].id],
      pendingContractIds: program.contracts.slice(1).map((contract) => contract.id),
      lastStatus: "blocked",
      stopReason: "waiting for dependency",
      stopReasonCode: "missing_dependency",
      validationOutcome: "blocked",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8");

    await assert.rejects(
      () => runStore.loadRun(program.id),
      /runJournalEntry\.changedSurface\.paths\[0\] must not escape the repository root/u
    );
  });
});

test("run store load rejects malformed present provider/model evidence requirement values", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const runPath = join(rootDir, ".pi", "runs", `${encodeURIComponent(program.id)}.json`);

    await mkdir(join(rootDir, ".pi", "runs"), { recursive: true });
    await writeFile(runPath, `${JSON.stringify({
      artifactType: "persisted_run_record",
      formatVersion: 1,
      programId: program.id,
      program,
      runJournal: {
        artifactType: "run_journal",
        programId: program.id,
        status: "success",
        stopReason: null,
        validationArtifacts: [
          {
            artifactType: "validation_artifact",
            reference: "test-run:node --test --test-isolation=none",
            status: "captured"
          }
        ],
        contractRuns: [
          {
            contractId: program.contracts[0].id,
            status: "success",
            summary: `Executed ${program.contracts[0].id}.`,
            evidence: [],
            providerModelEvidenceRequirement: "not_applicable",
            providerModelSelections: [
              {
                role: "implementer",
                iteration: 0,
                requestedProvider: "openai-codex",
                requestedModel: "gpt-5.3-codex",
                selectedProvider: "openai-codex",
                selectedModel: "gpt-5.3-codex"
              }
            ],
            openQuestions: []
          }
        ],
        completedContractIds: [program.contracts[0].id],
        pendingContractIds: program.contracts.slice(1).map((contract) => contract.id)
      },
      completedContractIds: [program.contracts[0].id],
      pendingContractIds: program.contracts.slice(1).map((contract) => contract.id),
      lastStatus: "success",
      stopReason: null,
      stopReasonCode: null,
      validationOutcome: "pass",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8");

    await assert.rejects(
      () => runStore.loadRun(program.id),
      /runJournalEntry\.providerModelEvidenceRequirement must be one of: required, unknown/u
    );
  });
});

test("run store load rejects present envelope type or version drift", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const runPath = join(rootDir, ".pi", "runs", `${encodeURIComponent(program.id)}.json`);

    await mkdir(join(rootDir, ".pi", "runs"), { recursive: true });
    await writeFile(runPath, `${JSON.stringify({
      artifactType: "unexpected_run_record",
      formatVersion: 2,
      programId: program.id,
      program,
      runJournal: {
        artifactType: "run_journal",
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

    await assert.rejects(
      () => runStore.loadRun(program.id),
      /persistedRun\.artifactType must be persisted_run_record|persistedRun\.formatVersion must be 1/u
    );
  });
});

test("run store load rejects a present embedded run journal artifact type drift", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const runPath = join(rootDir, ".pi", "runs", `${encodeURIComponent(program.id)}.json`);

    await mkdir(join(rootDir, ".pi", "runs"), { recursive: true });
    await writeFile(runPath, `${JSON.stringify({
      artifactType: "persisted_run_record",
      formatVersion: 1,
      programId: program.id,
      program,
      runJournal: {
        artifactType: "journal_record",
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

    await assert.rejects(
      () => runStore.loadRun(program.id),
      /persistedRun\.runJournal\.artifactType must be run_journal/u
    );
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

test("run store infers install and git mutation classes from explicit command evidence markers", async () => {
  await withTempDir("pi-orchestrator-run-store-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });

    const saved = await runStore.saveRun({
      programId: program.id,
      program,
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
              "run implementer: success",
              "run implementer command: npm install --save-dev vitest",
              "run implementer command: git commit -m \"checkpoint\"",
              "run reviewer command: git diff --stat"
            ],
            openQuestions: []
          }
        ],
        completedContractIds: [program.contracts[0].id],
        pendingContractIds: program.contracts.slice(1).map((contract) => contract.id)
      }
    });

    assert.deepEqual(saved.actionClasses, ["write_allowed", "install_dependency", "mutate_git_state"]);
    assert.deepEqual(saved.runJournal.actionClasses, ["write_allowed", "install_dependency", "mutate_git_state"]);

    const loaded = await runStore.loadRun(program.id);
    assert.deepEqual(loaded.actionClasses, ["write_allowed", "install_dependency", "mutate_git_state"]);
    assert.deepEqual(loaded.runJournal.actionClasses, ["write_allowed", "install_dependency", "mutate_git_state"]);
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
