import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { formatWorkflowExecution, runAutoWorkflow, runPlannedWorkflow } from "../src/auto-workflow.js";
import { createInitialWorkflow } from "../src/orchestrator.js";
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

test("runPlannedWorkflow tolerates non-cloneable context values", async () => {
  const workflow = createInitialWorkflow({
    goal: "Rename one helper in a local file",
    allowedFiles: ["src/helpers.js"]
  });
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Renamed the helper.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Implementer step passed."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified helper behavior.",
        changedFiles: [],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Verifier step passed."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runPlannedWorkflow({
    workflow,
    maxRepairLoops: 1,
    context: {
      workflowId: "function-bearing-context",
      callbacks: {
        onComplete() {
          return "done";
        }
      }
    }
  }, { runner });

  assert.equal(execution.status, "success");
  assert.deepEqual(execution.runs.map((run) => run.result.status), ["success", "success"]);

  const calls = runner.getCalls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].context.workflowId, workflow.workflowId);
  assert.equal(typeof calls[0].context.callbacks.onComplete, "string");
  assert.match(calls[0].context.callbacks.onComplete, /uncloneable/i);
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

test("formatWorkflowExecution includes run evidence and commands", () => {
  const formatted = formatWorkflowExecution({
    workflow: {
      workflowId: "workflow-evidence-smoke",
      risk: "high",
      humanGate: true
    },
    status: "success",
    stopReason: null,
    repairCount: 0,
    maxRepairLoops: 1,
    runs: [
      {
        packet: {
          role: "implementer"
        },
        result: {
          status: "success",
          summary: "Applied scoped changes.",
          changedFiles: ["docs/specs/model-evidence-smoke.md"],
          commandsRun: ["pi -p --provider openai-codex --model gpt-5.3-codex"],
          evidence: [
            "selected_provider: openai-codex",
            "selected_model: gpt-5.3-codex"
          ],
          openQuestions: []
        }
      }
    ]
  });

  assert.match(formatted, /launch_selection: openai-codex \(implementer=gpt-5\.3-codex\)/i);
  assert.match(formatted, /commands: pi -p --provider openai-codex --model gpt-5\.3-codex/i);
  assert.match(formatted, /selected_provider: openai-codex/i);
  assert.match(formatted, /selected_model: gpt-5\.3-codex/i);
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

test("auto workflow treats approvedHighRisk string false as no approval", async () => {
  const fixture = loadFixture("human-gate.json");
  const runner = createScriptedWorkerRunner(fixture.script);

  const execution = await runAutoWorkflow({
    ...fixture.input,
    approvedHighRisk: "false"
  }, { runner });

  assert.equal(execution.status, "human_gate_required");
  assert.equal(execution.workflow.humanGate, true);
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /Human approval is required/i);
});

test("auto workflow treats approvedHighRisk string true as explicit approval", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "explorer",
      result: {
        status: "success",
        summary: "Mapped scoped files.",
        changedFiles: [],
        commandsRun: ["rg --files"],
        evidence: ["Scope mapped."],
        openQuestions: []
      }
    },
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Applied the scoped migration changes.",
        changedFiles: ["platform/contracts/ingest/artifact.json"],
        commandsRun: ["node --check src/program-compiler.js"],
        evidence: ["Scoped changes complete."],
        openQuestions: []
      }
    },
    {
      role: "reviewer",
      result: {
        status: "success",
        summary: "Reviewed scoped changes.",
        changedFiles: [],
        commandsRun: ["git diff --stat"],
        evidence: ["Review completed."],
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

  const execution = await runAutoWorkflow({
    goal: "Apply a schema migration for event storage",
    allowedFiles: ["platform/contracts/ingest/artifact.json"],
    approvedHighRisk: "true"
  }, { runner });

  assert.equal(execution.status, "success");
  assert.equal(execution.workflow.humanGate, true);
  assert.deepEqual(
    execution.runs.map((run) => run.packet.role),
    ["explorer", "implementer", "reviewer", "verifier"]
  );
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

test("auto workflow blocks non-string allowedFiles entries during input normalization", async () => {
  const runner = createScriptedWorkerRunner([]);
  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: [{}]
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /scope path must be a string/i);
});

test("auto workflow blocks non-string forbiddenFiles entries during input normalization", async () => {
  const runner = createScriptedWorkerRunner([]);
  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    forbiddenFiles: [{}]
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /scope path must be a string/i);
});

test("auto workflow blocks non-string contextFiles entries during input normalization", async () => {
  const runner = createScriptedWorkerRunner([]);
  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    contextFiles: [{}]
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /scope path must be a string/i);
});

test("auto workflow still accepts valid string scope paths", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Patched the scoped helper.",
        changedFiles: ["web/src/utils/format.js"],
        commandsRun: ["node --check web/src/utils/format.js"],
        evidence: ["Patch applied in scoped file."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified scoped helper changes.",
        changedFiles: [],
        commandsRun: ["node --check web/src/utils/format.js"],
        evidence: ["Scoped verification passed."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["./web/src/utils/format.js"],
    forbiddenFiles: ["./web/src/utils/generated.js"],
    contextFiles: ["./README.md"]
  }, { runner });

  assert.equal(execution.status, "success");
  assert.equal(execution.runs.length, 2);
  assert.deepEqual(execution.runs.map((run) => run.packet.role), ["implementer", "verifier"]);
});

test("auto workflow stops with a structured failure when a role reports an out-of-scope file", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Patched an unexpected file.",
        changedFiles: ["web/src/utils/other.js"],
        commandsRun: [],
        evidence: ["Implemented the requested change."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"]
  }, { runner });

  assert.equal(execution.status, "failed");
  assert.equal(execution.runs.length, 1);
  assert.equal(execution.runs[0].packet.role, "implementer");
  assert.equal(execution.runs[0].result.status, "failed");
  assert.match(execution.stopReason, /outside its allowlist/i);
  assert.match(execution.stopReason, /web\/src\/utils\/other\.js/i);
});

test("auto workflow blocks planner failures when allow and forbidden paths match", async () => {
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
    allowedFiles: ["web/src/utils/format.js"],
    forbiddenFiles: ["web/src/utils/format.js"]
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /must not overlap by scope/i);
  assert.match(execution.stopReason, /web\/src\/utils\/format\.js/i);
});

test("auto workflow blocks planner failures when allow and forbidden scopes overlap", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Patched a forbidden file.",
        changedFiles: ["web/src/utils/format.js"],
        commandsRun: [],
        evidence: ["Patched the helper."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    forbiddenFiles: ["web/src/utils/"]
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /must not overlap by scope/i);
  assert.match(execution.stopReason, /web\/src\/utils\//i);
});

test("auto workflow blocks when maxRepairLoops is negative", async () => {
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
    allowedFiles: ["web/src/utils/format.js"],
    maxRepairLoops: -1
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /maxRepairLoops must be a non-negative integer/i);
});

test("auto workflow blocks when maxRepairLoops is not an integer", async () => {
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
    allowedFiles: ["web/src/utils/format.js"],
    maxRepairLoops: 1.5
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /maxRepairLoops must be a non-negative integer/i);
});

test("auto workflow blocks planner failures when allowlist includes protected paths", async () => {
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
    goal: "Patch vendored dependency",
    allowedFiles: ["node_modules/pkg/index.js"]
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /allowedFiles contains protected path/i);
  assert.match(execution.stopReason, /node_modules\/pkg\/index\.js/i);
});

test("auto workflow returns a structured stop when a read-only role reports file changes", async () => {
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

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"]
  }, { runner });

  assert.equal(execution.status, "failed");
  assert.equal(execution.runs.length, 2);
  assert.equal(execution.runs[1].packet.role, "verifier");
  assert.equal(execution.runs[1].result.status, "failed");
  assert.match(execution.stopReason, /verifier is read-only/i);
  assert.match(execution.stopReason, /web\/src\/utils\/format\.js/i);
});
