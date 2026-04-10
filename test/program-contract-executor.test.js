import test from "node:test";
import assert from "node:assert/strict";

import { createProgramContractExecutor } from "../src/program-contract-executor.js";
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
  assert.equal(runner.getPendingStepCount(), 0);
});
