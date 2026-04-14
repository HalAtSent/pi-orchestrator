import test from "node:test";
import assert from "node:assert/strict";

import { createProgramContractExecutor } from "../src/program-contract-executor.js";
import { AUTO_BACKEND_MODES, createAutoBackendRunner } from "../src/auto-backend-runner.js";
import { createLocalWorkerRunner, createScriptedWorkerRunner } from "../src/worker-runner.js";

function buildLowRiskContract(overrides = {}) {
  return {
    id: "contract-low-risk",
    goal: "Rename one local helper in a single file",
    scopePaths: ["src/helpers.js"],
    constraints: [],
    nonGoals: ["Do not edit files outside src/helpers.js"],
    acceptanceChecks: ["Changes stay inside the declared scope."],
    stopConditions: ["Stop if additional files are required."],
    deliverables: ["Renamed helper"],
    risk: "low",
    ...overrides
  };
}

function buildDeclaredHighRiskContract(overrides = {}) {
  return {
    id: "contract-declared-high-risk",
    goal: "Rename one local helper in a single file",
    scopePaths: ["src/helpers.js"],
    constraints: [],
    nonGoals: ["Do not edit files outside src/helpers.js"],
    acceptanceChecks: ["Changes stay inside the declared scope."],
    stopConditions: ["Stop if additional files are required."],
    deliverables: ["Renamed helper"],
    risk: "high",
    ...overrides
  };
}

test("default program contract executor returns blocked when no worker handler exists", async () => {
  const runner = createLocalWorkerRunner();
  const executeContract = createProgramContractExecutor({ runner });

  const result = await executeContract(buildLowRiskContract());

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /No local worker handler is configured for the implementer role/i);
  assert.equal(result.evidence.some((line) => line.includes("compiled workflow:")), true);
});

test("default program contract executor can succeed with a scripted worker runner", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Renamed the helper.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --test --test-name-pattern helpers"],
        evidence: ["Targeted helper tests passed."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified helper behavior.",
        changedFiles: [],
        commandsRun: ["node --test --test-name-pattern helpers"],
        evidence: ["Verification command passed."],
        openQuestions: []
      }
    }
  ]);
  const executeContract = createProgramContractExecutor({ runner });

  const result = await executeContract(buildLowRiskContract());

  assert.equal(result.status, "success");
  assert.match(result.summary, /Executed contract-low-risk through 2 bounded packet run\(s\)\./);
  assert.deepEqual(result.changedSurface, {
    capture: "not_captured",
    paths: []
  });
  assert.equal(runner.getPendingStepCount(), 0);
});

test("program contract executor does not promote exact changed-surface evidence from untrusted typed runtime observation", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Renamed the helper.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["repository_changes_applied: true"],
        openQuestions: [],
        changedSurfaceObservation: {
          capture: "complete",
          paths: ["src/helpers.js"]
        }
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified helper behavior.",
        changedFiles: [],
        commandsRun: ["node --test --test-name-pattern helpers"],
        evidence: ["Verification command passed."],
        openQuestions: []
      }
    }
  ]);
  const executeContract = createProgramContractExecutor({ runner });

  const result = await executeContract(buildLowRiskContract());

  assert.equal(result.status, "success");
  assert.deepEqual(result.changedSurface, {
    capture: "not_captured",
    paths: []
  });
});

test("program contract executor promotes exact changed-surface evidence only for trusted process-backend runs", async () => {
  const defaultRunner = createScriptedWorkerRunner([]);
  const processBackend = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Renamed the helper.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["repository_changes_applied: true"],
        openQuestions: [],
        changedSurfaceObservation: {
          capture: "complete",
          paths: ["src/helpers.js"]
        }
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified helper behavior.",
        changedFiles: [],
        commandsRun: ["node --test --test-name-pattern helpers"],
        evidence: ["Verification command passed."],
        openQuestions: []
      }
    }
  ]);
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.PROCESS_SUBAGENTS
  });
  const executeContract = createProgramContractExecutor({ runner });

  const result = await executeContract(buildLowRiskContract());

  assert.equal(result.status, "success");
  assert.deepEqual(result.changedSurface, {
    capture: "complete",
    paths: ["src/helpers.js"]
  });
  assert.equal(defaultRunner.getCalls().length, 0);
  assert.equal(processBackend.getPendingStepCount(), 0);
});

test("program contract executor does not promote changed-surface capture from legacy evidence markers alone", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Renamed the helper.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: [
          "repository_changes_applied: true",
          "changed_surface_capture: observed_complete"
        ],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified helper behavior.",
        changedFiles: [],
        commandsRun: ["node --test --test-name-pattern helpers"],
        evidence: ["Verification command passed."],
        openQuestions: []
      }
    }
  ]);
  const executeContract = createProgramContractExecutor({ runner });

  const result = await executeContract(buildLowRiskContract());

  assert.equal(result.status, "success");
  assert.deepEqual(result.changedSurface, {
    capture: "not_captured",
    paths: []
  });
});

test("program contract executor marks changed-surface evidence partial when only some implementer runs are observed", async () => {
  const defaultRunner = createScriptedWorkerRunner([]);
  const processBackend = createScriptedWorkerRunner([
    {
      role: "explorer",
      result: {
        status: "success",
        summary: "Mapped the scope.",
        changedFiles: [],
        commandsRun: ["rg --files"],
        evidence: ["Scope files enumerated."],
        openQuestions: []
      }
    },
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Applied first scoped update.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["repository_changes_applied: true"],
        openQuestions: [],
        changedSurfaceObservation: {
          capture: "complete",
          paths: ["src/helpers.js"]
        }
      }
    },
    {
      role: "reviewer",
      result: {
        status: "repair_required",
        summary: "Need one more scoped revision.",
        changedFiles: [],
        commandsRun: ["git diff --stat"],
        evidence: ["repair needed"],
        openQuestions: ["Apply one more scoped rename."]
      }
    },
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Applied repair update.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["repository_changes_applied: true"],
        openQuestions: []
      }
    },
    {
      role: "reviewer",
      result: {
        status: "success",
        summary: "Repair looks good now.",
        changedFiles: [],
        commandsRun: ["git diff --stat"],
        evidence: ["No further findings."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verification checks passed.",
        changedFiles: [],
        commandsRun: ["node --test --test-isolation=none"],
        evidence: ["verification passed"],
        openQuestions: []
      }
    }
  ]);
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.PROCESS_SUBAGENTS
  });
  const executeContract = createProgramContractExecutor({ runner });

  const result = await executeContract(buildDeclaredHighRiskContract(), {
    approvedHighRisk: true
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.changedSurface, {
    capture: "partial",
    paths: ["src/helpers.js"]
  });
  assert.equal(defaultRunner.getCalls().length, 0);
  assert.equal(processBackend.getPendingStepCount(), 0);
});

test("program contract executor threads program execution context into packet workers", async () => {
  const runner = createLocalWorkerRunner({
    handlers: {
      implementer: async () => ({
        status: "success",
        summary: "Renamed the helper.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Implementer step passed."],
        openQuestions: []
      }),
      verifier: async () => ({
        status: "success",
        summary: "Verified the helper rename.",
        changedFiles: [],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Verifier step passed."],
        openQuestions: []
      })
    }
  });
  const executeContract = createProgramContractExecutor({ runner });
  const contractContext = {
    programId: "program-smoke",
    completedContractIds: ["bootstrap-package"],
    pendingContractIds: ["contract-low-risk"],
    contractRuns: [
      {
        contractId: "bootstrap-package",
        status: "success",
        summary: "Bootstrap completed.",
        evidence: [],
        openQuestions: []
      }
    ]
  };

  const result = await executeContract(buildLowRiskContract(), contractContext);
  const calls = runner.getCalls();

  assert.equal(result.status, "success");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].context.programId, "program-smoke");
  assert.deepEqual(calls[0].context.completedContractIds, ["bootstrap-package"]);
  assert.deepEqual(calls[0].context.pendingContractIds, ["contract-low-risk"]);
  assert.equal(calls[0].context.contractRuns.length, 1);
  assert.equal(calls[0].context.priorResults.length, 0);
  assert.equal(calls[1].context.programId, "program-smoke");
  assert.equal(calls[1].context.priorResults.at(-1).role, "implementer");
  assert.equal(calls[1].context.priorResults.at(-1).status, "success");
});

test("program contract executor supports per-invocation approvedHighRisk overrides", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "explorer",
      result: {
        status: "success",
        summary: "Mapped the contract scope.",
        changedFiles: [],
        commandsRun: ["rg --files"],
        evidence: ["Scope files enumerated."],
        openQuestions: []
      }
    },
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Applied scoped updates.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Scoped update completed."],
        openQuestions: []
      }
    },
    {
      role: "reviewer",
      result: {
        status: "success",
        summary: "Reviewed scoped updates.",
        changedFiles: [],
        commandsRun: ["git diff --stat"],
        evidence: ["No findings."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verification checks passed.",
        changedFiles: [],
        commandsRun: ["node --test --test-isolation=none"],
        evidence: ["Verification passed."],
        openQuestions: []
      }
    }
  ]);
  const executeContract = createProgramContractExecutor({
    runner,
    approvedHighRisk: false
  });

  const blockedWithoutApproval = await executeContract(buildDeclaredHighRiskContract());
  assert.equal(blockedWithoutApproval.status, "blocked");
  assert.equal(runner.getCalls().length, 0);

  const allowedWithPerCallApproval = await executeContract(buildDeclaredHighRiskContract(), {
    approvedHighRisk: "true"
  });
  assert.equal(allowedWithPerCallApproval.status, "success");
  assert.deepEqual(
    runner.getCalls().map((call) => call.packet.role),
    ["explorer", "implementer", "reviewer", "verifier"]
  );
  assert.equal(runner.getPendingStepCount(), 0);
});
