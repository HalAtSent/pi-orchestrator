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

test("normalized infra scope paths are high risk and human-gated", () => {
  assert.equal(classifyRisk({
    goal: "Update infra module inputs",
    allowedFiles: ["./infra/main.tf"]
  }), "high");
  assert.equal(requiresHumanGate({
    goal: "Update infra module inputs",
    allowedFiles: ["./infra/main.tf"]
  }), true);
});

test("directory scopes are not classified as low risk by default", () => {
  assert.equal(classifyRisk({
    goal: "Rename local helpers",
    allowedFiles: ["src/"]
  }), "medium");
});

test("sensitive directory scopes remain high risk and human-gated", () => {
  assert.equal(classifyRisk({
    goal: "Tighten deployment docs wording",
    allowedFiles: ["./docs/specs/"]
  }), "high");
  assert.equal(requiresHumanGate({
    goal: "Tighten deployment docs wording",
    allowedFiles: ["./docs/specs/"]
  }), true);
});

test("protected allowlist entries are rejected before packet creation", () => {
  assert.throws(
    () => createInitialWorkflow({
      goal: "Update an installed dependency shim",
      allowedFiles: ["node_modules/pkg/index.js"]
    }),
    /allowedFiles contains protected path\(s\): node_modules\/pkg\/index\.js/u
  );
});

test("matching allow and forbidden paths are rejected before packet creation", () => {
  assert.throws(
    () => createInitialWorkflow({
      goal: "Rename helper in one file",
      allowedFiles: ["web/src/utils/format.js"],
      forbiddenFiles: ["web/src/utils/format.js"]
    }),
    /allowedFiles and forbiddenFiles must not contain the same path/u
  );
});

test("non-protected allowlists still produce packets without allow-forbid overlap", () => {
  const workflow = createInitialWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    forbiddenFiles: ["web/src/utils/generated.js"]
  });

  assert.equal(workflow.packets.length > 0, true);

  for (const packet of workflow.packets) {
    const forbiddenSet = new Set(packet.forbiddenFiles);
    const sharedPaths = packet.allowedFiles.filter((path) => forbiddenSet.has(path));
    assert.deepEqual(sharedPaths, []);
  }
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

test("initial workflow uses role-specific packet goals for read-only roles", () => {
  const workflow = createInitialWorkflow({
    goal: "Create docs/specs/model-evidence-smoke.md containing exactly MODEL EVIDENCE SMOKE OK and stop.",
    allowedFiles: ["docs/specs/model-evidence-smoke.md"]
  });

  const explorerPacket = workflow.packets.find((packet) => packet.role === "explorer");
  const reviewerPacket = workflow.packets.find((packet) => packet.role === "reviewer");
  const verifierPacket = workflow.packets.find((packet) => packet.role === "verifier");
  const implementerPacket = workflow.packets.find((packet) => packet.role === "implementer");

  assert.match(explorerPacket.goal, /^Inspect the scoped codebase context for this task/i);
  assert.match(reviewerPacket.goal, /^Review the scoped implementation independently/i);
  assert.match(verifierPacket.goal, /^Verify the scoped implementation against the original goal/i);
  assert.equal(
    implementerPacket.goal,
    "Create docs/specs/model-evidence-smoke.md containing exactly MODEL EVIDENCE SMOKE OK and stop."
  );
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
