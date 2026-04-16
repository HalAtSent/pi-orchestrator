import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatProgramRunJournal,
  getRunJournalResumePolicy,
  resumeExecutionProgram,
  runExecutionProgram
} from "../src/program-runner.js";
import { createProgramContractExecutor } from "../src/program-contract-executor.js";
import { AUTO_BACKEND_MODES, createAutoBackendRunner } from "../src/auto-backend-runner.js";
import { buildProjectLifecycleArtifacts } from "../src/project-workflows.js";
import { createRunStore } from "../src/run-store.js";
import { createLocalWorkerRunner, createScriptedWorkerRunner } from "../src/worker-runner.js";

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function buildProgram() {
  const brief = loadFixture("project-brief.json");
  return buildProjectLifecycleArtifacts(brief).executionProgram;
}

async function withTempDir(prefix, callback) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createPersistedRunJournal(program, {
  status,
  stopReason,
  contractRuns,
  completedContractIds
}) {
  const completedSet = new Set(completedContractIds);

  return {
    programId: program.id,
    status,
    stopReason,
    contractRuns,
    completedContractIds,
    pendingContractIds: program.contracts
      .map((contract) => contract.id)
      .filter((contractId) => !completedSet.has(contractId))
  };
}

test("program runner executes contracts in dependency order", async () => {
  const program = buildProgram();
  const shuffled = structuredClone(program);
  shuffled.contracts = [
    program.contracts[2],
    program.contracts[0],
    program.contracts[1],
    program.contracts[3],
    program.contracts[4]
  ];

  const executed = [];
  const journal = await runExecutionProgram(shuffled, {
    contractExecutor: async (contract) => {
      executed.push(contract.id);
      return {
        status: "success",
        summary: `Executed ${contract.id}.`,
        evidence: [],
        openQuestions: []
      };
    }
  });

  assert.equal(journal.status, "success");
  assert.equal(journal.stopReasonCode, null);
  assert.equal(journal.validationOutcome, "pass");
  assert.deepEqual(executed, [
    "bootstrap-package",
    "freeze-lifecycle-contracts",
    "wire-execution-backend",
    "harden-regressions-and-audit",
    "package-readiness"
  ]);
  assert.deepEqual(journal.completedContractIds, executed);
  assert.deepEqual(journal.pendingContractIds, []);
});

test("runExecutionProgram omits empty providerModelSelections from contract runs", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });

    const journal = await runExecutionProgram(program, {
      contractExecutor: async (contract) => ({
        status: "success",
        summary: `Executed ${contract.id}.`,
        evidence: [
          "selected_provider: openai-codex",
          "selected_model: gpt-5.4"
        ],
        providerModelSelections: [],
        openQuestions: []
      }),
      runStore
    });

    assert.equal(journal.status, "success");
    for (const entry of journal.contractRuns) {
      assert.equal(entry.providerModelEvidenceRequirement, "unknown");
      assert.equal(Object.prototype.hasOwnProperty.call(entry, "providerModelSelections"), false);
    }

    const persisted = await runStore.loadRun(program.id);
    for (const entry of persisted.runJournal.contractRuns) {
      assert.equal(entry.providerModelEvidenceRequirement, "unknown");
      assert.equal(Object.prototype.hasOwnProperty.call(entry, "providerModelSelections"), false);
    }
  });
});

test("runExecutionProgram persists required provider/model evidence requirement from trusted process-backed execution", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const defaultRunner = createScriptedWorkerRunner([]);
    const processBackend = createLocalWorkerRunner({
      handlers: {
        explorer: async () => ({
          status: "success",
          summary: "Explorer step completed.",
          changedFiles: [],
          commandsRun: ["rg --files"],
          evidence: ["explorer succeeded"],
          openQuestions: [],
          providerModelSelection: {
            requestedProvider: "openai-codex",
            requestedModel: "gpt-5.3-codex",
            selectedProvider: "openai-codex",
            selectedModel: "gpt-5.3-codex"
          }
        }),
        implementer: async () => ({
          status: "success",
          summary: "Implementer step completed.",
          changedFiles: [],
          commandsRun: ["node --check src/helpers.js"],
          evidence: ["implementer succeeded"],
          openQuestions: [],
          providerModelSelection: {
            requestedProvider: "openai-codex",
            requestedModel: "gpt-5.3-codex",
            selectedProvider: "openai-codex",
            selectedModel: "gpt-5.3-codex"
          }
        }),
        reviewer: async () => ({
          status: "success",
          summary: "Reviewer step completed.",
          changedFiles: [],
          commandsRun: ["git diff --stat"],
          evidence: ["reviewer succeeded"],
          openQuestions: [],
          providerModelSelection: {
            requestedProvider: "openai-codex",
            requestedModel: "gpt-5.4",
            selectedProvider: "openai-codex",
            selectedModel: "gpt-5.4"
          }
        }),
        verifier: async () => ({
          status: "success",
          summary: "Verifier step completed.",
          changedFiles: [],
          commandsRun: ["node --test"],
          evidence: ["verifier succeeded"],
          openQuestions: [],
          providerModelSelection: {
            requestedProvider: "openai-codex",
            requestedModel: "gpt-5.4-mini",
            selectedProvider: "openai-codex",
            selectedModel: "gpt-5.4-mini"
          }
        })
      }
    });
    const runner = createAutoBackendRunner({
      defaultRunner,
      processBackend,
      mode: AUTO_BACKEND_MODES.PROCESS_SUBAGENTS
    });
    const contractExecutor = createProgramContractExecutor({ runner });

    const journal = await runExecutionProgram(program, {
      contractExecutor,
      runStore
    });

    assert.equal(journal.status, "success");
    for (const entry of journal.contractRuns) {
      assert.equal(entry.providerModelEvidenceRequirement, "required");
    }

    const persisted = await runStore.loadRun(program.id);
    for (const entry of persisted.runJournal.contractRuns) {
      assert.equal(entry.providerModelEvidenceRequirement, "required");
    }
  });
});

test("program runner stops on the first blocked contract", async () => {
  const program = buildProgram();

  const journal = await runExecutionProgram(program, {
    contractExecutor: async (contract) => {
      if (contract.id === "freeze-lifecycle-contracts") {
        return {
          status: "blocked",
          summary: "Waiting for a dependency outside current scope.",
          evidence: [],
          openQuestions: []
        };
      }

      return {
        status: "success",
        summary: `Executed ${contract.id}.`,
        evidence: [],
        openQuestions: []
      };
    }
  });

  assert.equal(journal.status, "blocked");
  assert.equal(journal.contractRuns.length, 2);
  assert.equal(journal.contractRuns[1].contractId, "freeze-lifecycle-contracts");
  assert.equal(journal.contractRuns[1].status, "blocked");
  assert.equal(journal.completedContractIds.length, 1);
  assert.deepEqual(journal.completedContractIds, ["bootstrap-package"]);
});

test("runExecutionProgram converts thrown contract executor errors into a blocked journal", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const firstContractId = program.contracts[0].id;
    const failingContractId = program.contracts[1].id;

    const journal = await runExecutionProgram(program, {
      contractExecutor: async (contract) => {
        if (contract.id === failingContractId) {
          throw new Error("executor crashed during contract execution");
        }

        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        };
      },
      runStore
    });

    assert.equal(journal.status, "blocked");
    assert.equal(journal.stopReasonCode, "execution_error");
    assert.equal(journal.validationOutcome, "blocked");
    assert.match(journal.stopReason, /execution threw/i);
    assert.match(journal.stopReason, /executor crashed during contract execution/i);
    assert.equal(journal.contractRuns.length, 2);
    assert.equal(journal.contractRuns[1].contractId, failingContractId);
    assert.equal(journal.contractRuns[1].status, "blocked");
    assert.equal(journal.contractRuns[1].validationOutcome, "blocked");
    assert.match(journal.contractRuns[1].summary, /contract executor threw/i);
    assert.deepEqual(journal.completedContractIds, [firstContractId]);
    assert.deepEqual(journal.pendingContractIds, program.contracts.slice(1).map((contract) => contract.id));

    const persisted = await runStore.loadRun(program.id);
    assert.equal(persisted.lastStatus, "blocked");
    assert.equal(persisted.runJournal.stopReason, journal.stopReason);
  });
});

test("runExecutionProgram converts invalid contract status returns into a blocked journal", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const firstContractId = program.contracts[0].id;
    const failingContractId = program.contracts[1].id;

    const journal = await runExecutionProgram(program, {
      contractExecutor: async (contract) => {
        if (contract.id === failingContractId) {
          return {
            status: "not-a-status",
            summary: "Malformed executor status.",
            evidence: [],
            openQuestions: []
          };
        }

        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        };
      },
      runStore
    });

    assert.equal(journal.status, "blocked");
    assert.match(journal.stopReason, /returned an invalid result/i);
    assert.match(journal.stopReason, /contractExecutionResult\.status must be one of/i);
    assert.equal(journal.contractRuns.length, 2);
    assert.equal(journal.contractRuns[1].contractId, failingContractId);
    assert.equal(journal.contractRuns[1].status, "blocked");
    assert.match(journal.contractRuns[1].summary, /returned an invalid result/i);
    assert.deepEqual(journal.completedContractIds, [firstContractId]);
    assert.deepEqual(journal.pendingContractIds, program.contracts.slice(1).map((contract) => contract.id));

    const persisted = await runStore.loadRun(program.id);
    assert.equal(persisted.lastStatus, "blocked");
    assert.equal(persisted.runJournal.stopReason, journal.stopReason);
  });
});

test("runExecutionProgram converts malformed evidence/openQuestions returns into a blocked journal", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const firstContractId = program.contracts[0].id;
    const failingContractId = program.contracts[1].id;

    const journal = await runExecutionProgram(program, {
      contractExecutor: async (contract) => {
        if (contract.id === failingContractId) {
          return {
            status: "blocked",
            summary: "Malformed arrays.",
            evidence: "not-an-array",
            openQuestions: []
          };
        }

        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        };
      },
      runStore
    });

    assert.equal(journal.status, "blocked");
    assert.match(journal.stopReason, /returned an invalid result/i);
    assert.match(journal.stopReason, /contractExecutionResult\.evidence must be an array/i);
    assert.equal(journal.contractRuns.length, 2);
    assert.equal(journal.contractRuns[1].contractId, failingContractId);
    assert.equal(journal.contractRuns[1].status, "blocked");
    assert.match(journal.contractRuns[1].summary, /returned an invalid result/i);
    assert.deepEqual(journal.completedContractIds, [firstContractId]);
    assert.deepEqual(journal.pendingContractIds, program.contracts.slice(1).map((contract) => contract.id));

    const persisted = await runStore.loadRun(program.id);
    assert.equal(persisted.lastStatus, "blocked");
    assert.equal(persisted.runJournal.stopReason, journal.stopReason);
  });
});

test("runExecutionProgram fails closed when contract executor returns malformed provider/model evidence requirement", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const firstContractId = program.contracts[0].id;
    const failingContractId = program.contracts[1].id;

    const journal = await runExecutionProgram(program, {
      contractExecutor: async (contract) => {
        if (contract.id === failingContractId) {
          return {
            status: "blocked",
            summary: "Malformed provider/model requirement payload.",
            evidence: [],
            providerModelEvidenceRequirement: "not_applicable",
            openQuestions: []
          };
        }

        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        };
      },
      runStore
    });

    assert.equal(journal.status, "blocked");
    assert.match(journal.stopReason, /returned an invalid result/i);
    assert.match(
      journal.stopReason,
      /contractExecutionResult\.providerModelEvidenceRequirement must be one of: required, unknown/i
    );
    assert.equal(journal.contractRuns.length, 2);
    assert.equal(journal.contractRuns[1].contractId, failingContractId);
    assert.equal(journal.contractRuns[1].status, "blocked");
    assert.match(journal.contractRuns[1].summary, /returned an invalid result/i);
    assert.deepEqual(journal.completedContractIds, [firstContractId]);
    assert.deepEqual(journal.pendingContractIds, program.contracts.slice(1).map((contract) => contract.id));
  });
});

test("runExecutionProgram fails closed when contract executor returns malformed changed-surface evidence", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const firstContractId = program.contracts[0].id;
    const failingContractId = program.contracts[1].id;

    const journal = await runExecutionProgram(program, {
      contractExecutor: async (contract) => {
        if (contract.id === failingContractId) {
          return {
            status: "blocked",
            summary: "Malformed changed-surface payload.",
            evidence: [],
            changedSurface: {
              capture: "complete",
              paths: ["../outside.js"]
            },
            openQuestions: []
          };
        }

        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        };
      },
      runStore
    });

    assert.equal(journal.status, "blocked");
    assert.match(journal.stopReason, /returned an invalid result/i);
    assert.match(journal.stopReason, /contractExecutionResult\.changedSurface\.paths\[0\] must not escape the repository root/i);
    assert.equal(journal.contractRuns.length, 2);
    assert.equal(journal.contractRuns[1].contractId, failingContractId);
    assert.equal(journal.contractRuns[1].status, "blocked");
    assert.match(journal.contractRuns[1].summary, /returned an invalid result/i);
    assert.deepEqual(journal.completedContractIds, [firstContractId]);
    assert.deepEqual(journal.pendingContractIds, program.contracts.slice(1).map((contract) => contract.id));

    const persisted = await runStore.loadRun(program.id);
    assert.equal(persisted.lastStatus, "blocked");
    assert.equal(persisted.runJournal.stopReason, journal.stopReason);
  });
});

test("runExecutionProgram converts missing summary returns into a blocked journal", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const firstContractId = program.contracts[0].id;
    const failingContractId = program.contracts[1].id;

    const journal = await runExecutionProgram(program, {
      contractExecutor: async (contract) => {
        if (contract.id === failingContractId) {
          return {
            status: "blocked",
            evidence: [],
            openQuestions: []
          };
        }

        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        };
      },
      runStore
    });

    assert.equal(journal.status, "blocked");
    assert.match(journal.stopReason, /returned an invalid result/i);
    assert.match(journal.stopReason, /contractExecutionResult\.summary must be a non-empty string/i);
    assert.equal(journal.contractRuns.length, 2);
    assert.equal(journal.contractRuns[1].contractId, failingContractId);
    assert.equal(journal.contractRuns[1].status, "blocked");
    assert.match(journal.contractRuns[1].summary, /returned an invalid result/i);
    assert.deepEqual(journal.completedContractIds, [firstContractId]);
    assert.deepEqual(journal.pendingContractIds, program.contracts.slice(1).map((contract) => contract.id));

    const persisted = await runStore.loadRun(program.id);
    assert.equal(persisted.lastStatus, "blocked");
    assert.equal(persisted.runJournal.stopReason, journal.stopReason);
  });
});

test("program runner reports pending contracts after a stop", async () => {
  const program = buildProgram();

  const journal = await runExecutionProgram(program, {
    contractExecutor: async (contract) => ({
      status: contract.id === "freeze-lifecycle-contracts" ? "blocked" : "success",
      summary: `Result for ${contract.id}.`,
      evidence: [],
      openQuestions: []
    })
  });

  assert.equal(journal.status, "blocked");
  assert.deepEqual(journal.completedContractIds, ["bootstrap-package"]);
  assert.deepEqual(journal.pendingContractIds, [
    "freeze-lifecycle-contracts",
    "wire-execution-backend",
    "harden-regressions-and-audit",
    "package-readiness"
  ]);
});

test("program runner persists success with placeholder validation artifacts when no captured validation evidence is recorded", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });

    const journal = await runExecutionProgram(program, {
      contractExecutor: async (contract) => ({
        status: "success",
        summary: `Executed ${contract.id}.`,
        evidence: [],
        openQuestions: []
      }),
      runStore
    });

    assert.equal(journal.status, "success");

    const persisted = await runStore.loadRun(program.id);
    assert.equal(persisted.lastStatus, "success");
    assert.deepEqual(persisted.validationArtifacts, [
      {
        artifactType: "validation_artifact",
        reference: null,
        status: "not_captured",
        validationOutcome: "pass"
      }
    ]);
    assert.deepEqual(persisted.runJournal.validationArtifacts, [
      {
        artifactType: "validation_artifact",
        reference: null,
        status: "not_captured",
        validationOutcome: "pass"
      }
    ]);
  });
});

test("resumeExecutionProgram converts thrown contract executor errors into a blocked journal", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const firstContract = program.contracts[0];
    const failingContractId = program.contracts[1].id;

    await runStore.saveRun({
      programId: program.id,
      program,
      runJournal: {
        programId: program.id,
        status: "running",
        stopReason: null,
        contractRuns: [
          {
            contractId: firstContract.id,
            status: "success",
            summary: `Executed ${firstContract.id}.`,
            evidence: [],
            openQuestions: []
          }
        ],
        completedContractIds: [firstContract.id],
        pendingContractIds: program.contracts.slice(1).map((contract) => contract.id)
      }
    });

    const resumedJournal = await resumeExecutionProgram(program.id, {
      contractExecutor: async (contract) => {
        if (contract.id === failingContractId) {
          throw new Error("executor crashed while resuming");
        }

        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        };
      },
      runStore
    });

    assert.equal(resumedJournal.status, "blocked");
    assert.match(resumedJournal.stopReason, /execution threw/i);
    assert.match(resumedJournal.stopReason, /executor crashed while resuming/i);
    assert.equal(resumedJournal.contractRuns.length, 2);
    assert.equal(resumedJournal.contractRuns[0].contractId, firstContract.id);
    assert.equal(resumedJournal.contractRuns[1].contractId, failingContractId);
    assert.equal(resumedJournal.contractRuns[1].status, "blocked");
    assert.match(resumedJournal.contractRuns[1].summary, /contract executor threw/i);
    assert.deepEqual(resumedJournal.completedContractIds, [firstContract.id]);
    assert.deepEqual(resumedJournal.pendingContractIds, program.contracts.slice(1).map((contract) => contract.id));

    const persisted = await runStore.loadRun(program.id);
    assert.equal(persisted.lastStatus, "blocked");
    assert.equal(persisted.runJournal.stopReason, resumedJournal.stopReason);
  });
});

test("resumeExecutionProgram does not rerun contracts for a persisted failed journal", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });

    const failedJournal = await runExecutionProgram(program, {
      contractExecutor: async (contract) => ({
        status: contract.id === "freeze-lifecycle-contracts" ? "failed" : "success",
        summary: `Result for ${contract.id}.`,
        evidence: [],
        openQuestions: []
      }),
      runStore
    });

    assert.equal(failedJournal.status, "failed");

    const attemptedContracts = [];
    const resumedJournal = await resumeExecutionProgram(program.id, {
      contractExecutor: async (contract) => {
        attemptedContracts.push(contract.id);
        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        };
      },
      runStore
    });

    assert.equal(resumedJournal.status, "blocked");
    assert.match(resumedJournal.stopReason, /cannot be resumed/i);
    assert.match(resumedJournal.stopReason, /failed/i);
    assert.equal(attemptedContracts.length, 0);
    assert.equal(resumedJournal.contractRuns.length, failedJournal.contractRuns.length);
    assert.deepEqual(resumedJournal.completedContractIds, failedJournal.completedContractIds);
    assert.deepEqual(resumedJournal.pendingContractIds, failedJournal.pendingContractIds);

    const persisted = await runStore.loadRun(program.id);
    assert.equal(persisted.lastStatus, "failed");
    assert.equal(persisted.runJournal.status, "failed");
  });
});

test("resumeExecutionProgram does not rerun contracts for a persisted blocked journal", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });

    const blockedJournal = await runExecutionProgram(program, {
      contractExecutor: async (contract) => ({
        status: contract.id === "freeze-lifecycle-contracts" ? "blocked" : "success",
        summary: `Result for ${contract.id}.`,
        evidence: [],
        openQuestions: []
      }),
      runStore
    });

    assert.equal(blockedJournal.status, "blocked");

    const attemptedContracts = [];
    const resumedJournal = await resumeExecutionProgram(program.id, {
      contractExecutor: async (contract) => {
        attemptedContracts.push(contract.id);
        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        };
      },
      runStore
    });

    assert.equal(resumedJournal.status, "blocked");
    assert.match(resumedJournal.stopReason, /cannot be resumed/i);
    assert.match(resumedJournal.stopReason, /blocked/i);
    assert.equal(attemptedContracts.length, 0);
    assert.equal(resumedJournal.contractRuns.length, blockedJournal.contractRuns.length);
    assert.deepEqual(resumedJournal.completedContractIds, blockedJournal.completedContractIds);
    assert.deepEqual(resumedJournal.pendingContractIds, blockedJournal.pendingContractIds);

    const persisted = await runStore.loadRun(program.id);
    assert.equal(persisted.lastStatus, "blocked");
    assert.equal(persisted.runJournal.status, "blocked");
  });
});

test("program runner blocks execution when a dependency id is missing", async () => {
  const program = buildProgram();
  const broken = structuredClone(program);
  broken.contracts[1].dependsOn = ["missing-contract-id"];
  const calls = [];

  const journal = await runExecutionProgram(broken, {
    contractExecutor: async (contract) => {
      calls.push(contract.id);
      return {
        status: "success",
        summary: `Executed ${contract.id}.`,
        evidence: [],
        openQuestions: []
      };
    }
  });

  assert.equal(journal.status, "blocked");
  assert.match(journal.stopReason, /missing contract id/i);
  assert.equal(journal.contractRuns.length, 0);
  assert.equal(calls.length, 0);
});

test("program runner blocks execution when dependencies contain a cycle", async () => {
  const program = buildProgram();
  const cyclic = structuredClone(program);
  cyclic.contracts[0].dependsOn = [cyclic.contracts[4].id];
  const calls = [];

  const journal = await runExecutionProgram(cyclic, {
    contractExecutor: async (contract) => {
      calls.push(contract.id);
      return {
        status: "success",
        summary: `Executed ${contract.id}.`,
        evidence: [],
        openQuestions: []
      };
    }
  });

  assert.equal(journal.status, "blocked");
  assert.equal(journal.stopReasonCode, "dependency_cycle");
  assert.match(journal.stopReason, /cycle/i);
  assert.equal(journal.contractRuns.length, 0);
  assert.equal(calls.length, 0);
});

test("resumeExecutionProgram resumes a persisted running journal from the next pending contract", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });
    const firstContract = program.contracts[0];

    await runStore.saveRun({
      programId: program.id,
      program,
      runJournal: createPersistedRunJournal(program, {
        status: "running",
        stopReason: null,
        contractRuns: [
          {
            contractId: firstContract.id,
            status: "success",
            summary: `Executed ${firstContract.id}.`,
            evidence: [],
            openQuestions: []
          }
        ],
        completedContractIds: [firstContract.id]
      })
    });

    const resumedContracts = [];
    const resumedJournal = await resumeExecutionProgram(program.id, {
      contractExecutor: async (contract) => {
        resumedContracts.push(contract.id);
        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        };
      },
      runStore
    });

    assert.equal(resumedJournal.status, "success");
    assert.deepEqual(resumedContracts, [
      "freeze-lifecycle-contracts",
      "wire-execution-backend",
      "harden-regressions-and-audit",
      "package-readiness"
    ]);

    const persisted = await runStore.loadRun(program.id);
    assert.equal(persisted.lastStatus, "success");
    assert.equal(persisted.runJournal.status, "success");
  });
});

test("formatProgramRunJournal includes contract evidence", () => {
  const formatted = formatProgramRunJournal({
    programId: "program-evidence-check",
    status: "success",
    stopReason: null,
    validationOutcome: "pass",
    completedContractIds: ["contract-a"],
    pendingContractIds: [],
    contractRuns: [
      {
        contractId: "contract-a",
        status: "success",
        summary: "Executed contract-a.",
        changedSurface: {
          capture: "complete",
          paths: ["src/helpers.js"]
        },
        validationOutcome: "pass",
        evidence: [
          "selected_provider: openai-codex",
          "selected_model: gpt-5.4"
        ],
        openQuestions: []
      }
    ]
  });

  assert.match(formatted, /selected_provider: openai-codex/i);
  assert.match(formatted, /selected_model: gpt-5\.4/i);
  assert.match(formatted, /changed_surface_capture: complete/i);
  assert.match(formatted, /src\/helpers\.js/i);
  assert.match(formatted, /validation_outcome: pass/i);
});

test("program runner exports shared resume-policy mapping for operator surfaces", () => {
  assert.equal(getRunJournalResumePolicy("running"), "resume");
  assert.equal(getRunJournalResumePolicy("success"), "return_existing");
  assert.equal(getRunJournalResumePolicy("blocked"), "reject_terminal");
  assert.equal(getRunJournalResumePolicy("failed"), "reject_terminal");
  assert.equal(getRunJournalResumePolicy("repair_required"), "reject_terminal");
  assert.equal(getRunJournalResumePolicy("unknown-status"), null);
  assert.equal(getRunJournalResumePolicy(null), null);
});

test("program runner blocks resume when persisted state is inconsistent", async () => {
  await withTempDir("pi-orchestrator-program-runner-", async (rootDir) => {
    const program = buildProgram();
    const runStore = createRunStore({ rootDir });

    await runStore.saveRun({
      programId: program.id,
      program,
      runJournal: {
        programId: program.id,
        status: "blocked",
        stopReason: "manually corrupted state",
        contractRuns: [],
        completedContractIds: ["missing-contract-id"],
        pendingContractIds: []
      }
    });

    const attemptedContracts = [];
    const resumedJournal = await resumeExecutionProgram(program.id, {
      contractExecutor: async (contract) => {
        attemptedContracts.push(contract.id);
        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        };
      },
      runStore
    });

    assert.equal(resumedJournal.status, "blocked");
    assert.match(resumedJournal.stopReason, /inconsistent/i);
    assert.equal(attemptedContracts.length, 0);
  });
});
