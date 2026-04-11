import test from "node:test";
import assert from "node:assert/strict";

import {
  inferActionClasses,
  inferStopReasonCode,
  inferValidationOutcome,
  normalizeActionClasses,
  normalizeLineageDepth,
  normalizePolicyProfile,
  normalizeSourceArtifactIds,
  normalizeStopReasonCode,
  normalizeValidationArtifacts,
  normalizeValidationOutcome
} from "../src/run-evidence.js";

test("run evidence infers validation outcomes from execution status", () => {
  assert.equal(inferValidationOutcome("awaiting_approval"), "not_run");
  assert.equal(inferValidationOutcome("running"), "not_run");
  assert.equal(inferValidationOutcome("success"), "pass");
  assert.equal(inferValidationOutcome("blocked"), "blocked");
  assert.equal(inferValidationOutcome("failed"), "fail");
  assert.equal(inferValidationOutcome("repair_required"), "fail");
});

test("run evidence infers stop reason codes from common terminal reasons", () => {
  assert.equal(
    inferStopReasonCode({
      status: "blocked",
      stopReason: "Human approval is required before executing this workflow."
    }),
    "approval_required"
  );
  assert.equal(
    inferStopReasonCode({
      status: "blocked",
      stopReason: "Execution program dependency cycle detected: a -> b -> a"
    }),
    "dependency_cycle"
  );
  assert.equal(
    inferStopReasonCode({
      status: "blocked",
      stopReason: "Persisted run cannot be resumed because status \"failed\" is terminal."
    }),
    "terminal_resume_rejected"
  );
  assert.equal(
    inferStopReasonCode({
      status: "failed",
      stopReason: "process worker failed: launcher timed out"
    }),
    "runtime_unavailable"
  );
});

test("run evidence normalizers fall back to inferred values when fields are omitted", () => {
  assert.equal(normalizeValidationOutcome(null, { status: "success" }), "pass");
  assert.equal(
    normalizeStopReasonCode(null, {
      status: "blocked",
      stopReason: "Persisted run state is invalid: corrupted payload"
    }),
    "invalid_artifact"
  );
});

test("run evidence infers action classes from role evidence and stop reason codes", () => {
  assert.deepEqual(
    inferActionClasses({
      contractRuns: [
        {
          evidence: [
            "roles: explorer -> implementer -> verifier",
            "run explorer: success",
            "run implementer: success"
          ]
        }
      ],
      stopReasonCode: "scope_violation"
    }),
    ["read_repo", "write_allowed", "write_forbidden"]
  );
});

test("run evidence normalizes policy profile, lineage metadata, and validation placeholders", () => {
  assert.equal(normalizePolicyProfile(null), null);
  assert.equal(normalizePolicyProfile(" default "), "default");
  assert.equal(normalizeLineageDepth(null, { fallback: 2 }), 2);
  assert.deepEqual(
    normalizeSourceArtifactIds(null, { fallback: ["execution_program:program-1", "", "execution_program:program-1"] }),
    ["execution_program:program-1"]
  );

  const validationArtifacts = normalizeValidationArtifacts(null, {
    validationOutcome: "not_run"
  });
  assert.equal(validationArtifacts.length, 1);
  assert.equal(validationArtifacts[0].artifactType, "validation_artifact");
  assert.equal(validationArtifacts[0].status, "not_captured");
  assert.equal(validationArtifacts[0].validationOutcome, "not_run");

  assert.deepEqual(
    normalizeActionClasses(["read_repo"], {
      contractRuns: [
        {
          evidence: ["run implementer: success"]
        }
      ]
    }),
    ["write_allowed"]
  );
});

test("run evidence action class normalization does not persist unsupported caller assertions", () => {
  assert.deepEqual(
    normalizeActionClasses(["access_secret", "mutate_git_state"], {
      contractRuns: [
        {
          evidence: ["run explorer: success"]
        }
      ]
    }),
    ["read_repo"]
  );
});

test("run evidence validation artifacts normalize capture claims without references to not_captured", () => {
  const normalized = normalizeValidationArtifacts([
    {
      artifactType: "validation_artifact",
      reference: null,
      status: "captured"
    }
  ], {
    validationOutcome: "fail"
  });

  assert.deepEqual(normalized, [
    {
      artifactType: "validation_artifact",
      reference: null,
      status: "not_captured",
      validationOutcome: "fail"
    }
  ]);
});
