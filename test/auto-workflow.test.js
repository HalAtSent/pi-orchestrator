import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { formatWorkflowExecution, runAutoWorkflow } from "../src/auto-workflow.js";
import { createScriptedWorkerRunner } from "../src/worker-runner.js";

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("auto workflow executes a low-risk plan straight through the runner", async () => {
  const fixture = loadFixture("low-risk-success.json");
  const runner = createScriptedWorkerRunner(fixture.script);

  const execution = await runAutoWorkflow(fixture.input, { runner });

  assert.equal(execution.status, "success");
  assert.equal(execution.workflow.risk, "low");
  assert.deepEqual(execution.workflow.roleSequence, ["implementer", "verifier"]);
  assert.equal(execution.repairCount, 0);
  assert.deepEqual(execution.runs.map((run) => run.packet.role), ["implementer", "verifier"]);
  assert.equal(runner.getPendingStepCount(), 0);
});

test("auto workflow runs one repair loop after an independent review finding", async () => {
  const fixture = loadFixture("repair-loop.json");
  const runner = createScriptedWorkerRunner(fixture.script);

  const execution = await runAutoWorkflow(fixture.input, { runner });
  const calls = runner.getCalls();

  assert.equal(execution.status, "success");
  assert.equal(execution.workflow.risk, "medium");
  assert.equal(execution.repairCount, 1);
  assert.deepEqual(execution.runs.map((run) => run.packet.role), [
    "explorer",
    "implementer",
    "reviewer",
    "implementer",
    "reviewer",
    "verifier"
  ]);
  assert.equal(calls[3].context.repairCount, 1);
  assert.equal(calls[3].context.priorResults.at(-1).status, "repair_required");
  assert.equal(calls[3].context.priorResults.at(-1).role, "reviewer");
  assert.match(formatWorkflowExecution(execution), /repair_loops: 1\/1/);
  assert.equal(runner.getPendingStepCount(), 0);
});

test("auto workflow stops before execution when a human gate is required", async () => {
  const fixture = loadFixture("human-gate.json");
  const runner = createScriptedWorkerRunner(fixture.script);

  const execution = await runAutoWorkflow(fixture.input, { runner });

  assert.equal(execution.status, "human_gate_required");
  assert.equal(execution.workflow.humanGate, true);
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /Human approval is required/i);
});

test("auto workflow blocks empty allowlists during input normalization", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "This step should never run.",
        changedFiles: [],
        commandsRun: [],
        evidence: [],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: []
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /allowedFiles must contain at least one file path/i);
});

test("auto workflow rejects read-only roles that claim file changes", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Patched the helper.",
        changedFiles: ["web/src/utils/format.js"],
        commandsRun: [],
        evidence: ["Implemented the requested change."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Claimed verification while editing code.",
        changedFiles: ["web/src/utils/format.js"],
        commandsRun: [],
        evidence: [],
        openQuestions: []
      }
    }
  ]);

  await assert.rejects(
    runAutoWorkflow({
      goal: "Rename a local helper in one file",
      allowedFiles: ["web/src/utils/format.js"]
    }, { runner }),
    /verifier is read-only/
  );
});
