import test from "node:test";
import assert from "node:assert/strict";

import { createInitialWorkflow } from "../src/orchestrator.js";
import { classifyRisk, isProtectedPath, requiresHumanGate } from "../src/policies.js";
import { validateWorkerResult } from "../src/contracts.js";

test("protected paths are recognized", () => {
  assert.equal(isProtectedPath(".env"), true);
  assert.equal(isProtectedPath("node_modules/react/index.js"), true);
  assert.equal(isProtectedPath("src/app.ts"), false);
});

test("risk becomes high for schema work", () => {
  const risk = classifyRisk({
    goal: "Add a schema migration for event storage",
    allowedFiles: ["platform/contracts/ingest/artifact.json"]
  });

  assert.equal(risk, "high");
});

test("human gate is required for spec and infra changes", () => {
  assert.equal(requiresHumanGate({
    goal: "Update deployment config",
    allowedFiles: ["infra/prod/main.tf"]
  }), true);
});

test("low risk workflow uses implementer and verifier only", () => {
  const workflow = createInitialWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"]
  });

  assert.equal(workflow.risk, "low");
  assert.deepEqual(workflow.roleSequence, ["implementer", "verifier"]);
  assert.equal(workflow.humanGate, false);
});

test("medium and high risk workflows include independent review", () => {
  const workflow = createInitialWorkflow({
    goal: "Refactor auth flow to support a new provider",
    allowedFiles: ["platform/src/auth/flow.js", "platform/src/auth/provider.js"]
  });

  assert.equal(workflow.risk, "high");
  assert.deepEqual(workflow.roleSequence, ["explorer", "implementer", "reviewer", "verifier"]);
});

test("worker result validation enforces the output contract", () => {
  const result = validateWorkerResult({
    status: "success",
    summary: "Patched the formatter and ran a targeted test.",
    changedFiles: ["web/src/utils/format.js"],
    commandsRun: ["node --test test/format.test.js"],
    evidence: ["Targeted test passed locally."],
    openQuestions: []
  });

  assert.equal(result.status, "success");
});
