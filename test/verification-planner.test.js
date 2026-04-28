import test from "node:test";
import assert from "node:assert/strict";

import {
  buildVerificationPlan,
  detectSpecDrift,
  evaluateVerificationPlanRun,
  formatVerificationPlanEvidence
} from "../src/verification-planner.js";

test("verification planner discovers relevant package scripts and nearby tests", async () => {
  const plan = await buildVerificationPlan({
    packageJson: {
      scripts: {
        dev: "vite --host 0.0.0.0",
        lint: "eslint .",
        test: "node --test",
        "test:unit": "node --test test/unit.test.js"
      }
    },
    plannedScope: ["src/helpers.js"],
    repoFiles: [
      "src/helpers.js",
      "test/helpers.test.js",
      "test/unrelated.test.js"
    ]
  });

  assert.deepEqual(
    plan.selectedChecks.map((check) => check.command),
    [
      "npm run lint",
      "npm test",
      "npm run test:unit",
      "node --test test/helpers.test.js"
    ]
  );
  assert.equal(plan.selectedChecks.every((check) => check.required === false), true);
  assert.equal(
    plan.skippedCandidateChecks.some((check) => (
      check.command === "npm run dev" &&
      /not test\/build\/lint\/check-like/u.test(check.reason)
    )),
    true
  );
  assert.equal(plan.confidence, "medium");
});

test("verification planner surfaces missing required verification commands", async () => {
  const requiredCommand = "node --test test/helpers.test.js";
  const plan = await buildVerificationPlan({
    contractVerificationPlan: [requiredCommand],
    packageJson: {
      scripts: {
        test: "node --test"
      }
    },
    plannedScope: ["src/helpers.js"],
    repoFiles: ["test/helpers.test.js"]
  });
  const evaluated = evaluateVerificationPlanRun(plan, {
    commandsRun: ["node --test test/other.test.js"]
  });

  assert.deepEqual(evaluated.requiredChecksNotRun.map((check) => check.command), [requiredCommand]);
  assert.equal(evaluated.confidence, "low");
  assert.equal(
    formatVerificationPlanEvidence(evaluated).includes(`verification_required_not_run: ${requiredCommand}`),
    true
  );
});

test("verification planner treats prose verification steps as advisory guidance", async () => {
  const plan = await buildVerificationPlan({
    contractVerificationPlan: [
      "Review the changed files against the declared scope paths.",
      "Make sure the diff is reviewed.",
      "Go through the changed files.",
      "Run the smallest targeted verification commands that exercise the contract outputs."
    ],
    packageJson: {
      scripts: {
        test: "node --test"
      }
    },
    plannedScope: ["src/helpers.js"],
    repoFiles: ["test/helpers.test.js"]
  });
  const evaluated = evaluateVerificationPlanRun(plan, {
    commandsRun: []
  });

  assert.equal(plan.selectedChecks.some((check) => check.required === true), false);
  assert.equal(
    plan.selectedChecks.some((check) => (
      check.source === "contract_verification_plan" &&
      /advisory non-command guidance/u.test(check.reason)
    )),
    true
  );
  assert.deepEqual(evaluated.requiredChecksNotRun, []);
});

test("verification planner still treats command-like contract verification entries as required", async () => {
  const requiredCommand = "npm test -- --runInBand";
  const plan = await buildVerificationPlan({
    contractVerificationPlan: [
      "Review the changed files against the declared scope paths.",
      requiredCommand
    ],
    packageJson: {
      scripts: {
        test: "node --test"
      }
    },
    plannedScope: ["src/helpers.js"],
    repoFiles: ["test/helpers.test.js"]
  });
  const evaluated = evaluateVerificationPlanRun(plan, {
    commandsRun: []
  });

  assert.deepEqual(evaluated.requiredChecksNotRun.map((check) => check.command), [requiredCommand]);
});

test("spec drift detection flags top-level path mentions outside declared scope", () => {
  const drift = detectSpecDrift({
    originalGoal: "Rename the helper without touching other files",
    contractGoal: "Rename the helper",
    boundedGoal: "Execute contract contract-low-risk: Rename the helper (scope-locked to declared contract paths).",
    allowedFileScope: ["src/helpers.js"],
    workerSummaries: ["Updated README.md"]
  });

  assert.equal(drift.outcome, "possible_drift");
  assert.equal(
    drift.signals.some((signal) => (
      signal.kind === "summary_or_evidence_mentions_outside_scope" &&
      signal.detail === "README.md"
    )),
    true
  );
});

test("spec drift detection flags changed surface outside declared scope as possible drift", () => {
  const drift = detectSpecDrift({
    originalGoal: "Rename the helper without touching other files",
    contractGoal: "Rename the helper",
    boundedGoal: "Execute contract contract-low-risk: Rename the helper (scope-locked to declared contract paths).",
    allowedFileScope: ["src/helpers.js"],
    changedSurface: {
      capture: "complete",
      paths: ["src/outside.js"]
    },
    workerSummaries: ["Changed src/outside.js while renaming the helper."],
    workerEvidence: ["Updated src/outside.js"],
    workerChangedFiles: ["src/outside.js"]
  });

  assert.equal(drift.outcome, "possible_drift");
  assert.equal(
    drift.signals.some((signal) => (
      signal.kind === "changed_surface_outside_scope" &&
      signal.detail === "src/outside.js"
    )),
    true
  );
});
