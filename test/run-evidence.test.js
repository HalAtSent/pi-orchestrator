import test from "node:test";
import assert from "node:assert/strict";

import {
  derivePlannedActionClassesFromWorkflow,
  inferActionClasses,
  inferStopReasonCode,
  inferValidationOutcome,
  normalizeActionClasses,
  normalizeDeclaredActionClasses,
  normalizeLineageDepth,
  normalizePolicyProfile,
  normalizeChangedSurface,
  normalizeChangedSurfaceObservation,
  normalizeReviewability,
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

test("run evidence infers install and git mutation classes only from explicit command evidence markers", () => {
  assert.deepEqual(
    inferActionClasses({
      contractRuns: [
        {
          evidence: [
            "run implementer: success",
            "run implementer command: npm install --save-dev vitest",
            "run implementer command: git commit -m \"checkpoint\"",
            "run reviewer command: git diff --stat"
          ]
        }
      ]
    }),
    ["write_allowed", "install_dependency", "mutate_git_state"]
  );

  assert.deepEqual(
    inferActionClasses({
      contractRuns: [
        {
          evidence: [
            "run implementer: success",
            "run implementer command: npm test -- --runInBand",
            "run reviewer command: git status",
            "run reviewer command: git diff --stat"
          ]
        }
      ]
    }),
    ["write_allowed"]
  );
});

test("run evidence derives planned action classes from workflow packets without post-hoc inference", () => {
  assert.deepEqual(
    derivePlannedActionClassesFromWorkflow({
      roleSequence: ["explorer", "implementer", "verifier"],
      packets: [
        {
          role: "explorer",
          commands: ["rg --files"]
        },
        {
          role: "implementer",
          commands: ["node --check src/helpers.js"]
        },
        {
          role: "verifier",
          commands: ["node --test"]
        }
      ]
    }),
    ["read_repo", "write_allowed", "execute_local_command"]
  );

  assert.deepEqual(
    normalizeDeclaredActionClasses(["execute_local_command", "read_repo", "read_repo"]),
    ["read_repo", "execute_local_command"]
  );
});

test("run evidence derives install and git mutation classes only from concrete workflow commands", () => {
  assert.deepEqual(
    derivePlannedActionClassesFromWorkflow({
      roleSequence: ["implementer"],
      packets: [
        {
          role: "implementer",
          commands: [
            "npm install --save-dev vitest",
            "git commit -m \"checkpoint\"",
            "git diff --stat"
          ]
        }
      ]
    }),
    ["read_repo", "write_allowed", "execute_local_command", "install_dependency", "mutate_git_state"]
  );

  assert.deepEqual(
    derivePlannedActionClassesFromWorkflow({
      roleSequence: ["implementer"],
      packets: [
        {
          role: "implementer",
          commands: [
            "npm test -- --runInBand",
            "git status"
          ]
        }
      ]
    }),
    ["read_repo", "write_allowed", "execute_local_command"]
  );
});

test("run evidence normalizes policy profile, lineage metadata, and validation placeholders", () => {
  assert.equal(normalizePolicyProfile(null), "default");
  assert.equal(normalizePolicyProfile(" default "), "default");
  assert.throws(() => normalizePolicyProfile("strict"), /must be one of: default/);
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

test("run evidence validation artifacts reject unsupported types and statuses", () => {
  assert.throws(
    () => normalizeValidationArtifacts([
      {
        artifactType: "test_result",
        reference: "test-run:node --test",
        status: "captured"
      }
    ], {
      validationOutcome: "pass"
    }),
    /validationArtifacts\[\]\.artifactType must be validation_artifact/u
  );

  assert.throws(
    () => normalizeValidationArtifacts([
      {
        artifactType: "validation_artifact",
        reference: "test-run:node --test",
        status: "stored"
      }
    ], {
      validationOutcome: "pass"
    }),
    /validationArtifacts\[\]\.status must be one of: captured, not_captured/u
  );
});

test("run evidence validation artifacts downgrade contradictory status and reference pairs to placeholders", () => {
  const normalized = normalizeValidationArtifacts([
    {
      artifactType: "validation_artifact",
      reference: "test-run:node --test",
      status: "not_captured"
    }
  ], {
    validationOutcome: "pass"
  });

  assert.deepEqual(normalized, [
    {
      artifactType: "validation_artifact",
      reference: null,
      status: "not_captured",
      validationOutcome: "pass"
    }
  ]);
});

test("run evidence infers reviewability states from terminal evidence truthfully", () => {
  assert.deepEqual(
    normalizeReviewability(null, {
      status: "running",
      stopReason: null,
      stopReasonCode: null,
      validationArtifacts: null,
      contractRuns: []
    }),
    {
      status: "not_reviewable",
      reasons: ["non_terminal_status"]
    }
  );

  assert.deepEqual(
    normalizeReviewability(null, {
      status: "success",
      stopReason: null,
      stopReasonCode: null,
      validationArtifacts: [
        {
          artifactType: "validation_artifact",
          reference: "test-run:node --test --test-isolation=none",
          status: "captured"
        }
      ],
      contractRuns: [
        {
          status: "success",
          evidence: [
            "selected_provider: openai-codex",
            "selected_model: gpt-5.4"
          ]
        }
      ]
    }),
    {
      status: "reviewable",
      reasons: []
    }
  );

  assert.deepEqual(
    normalizeReviewability(null, {
      status: "success",
      stopReason: null,
      stopReasonCode: null,
      validationArtifacts: [
        {
          artifactType: "validation_artifact",
          reference: null,
          status: "not_captured"
        }
      ],
      contractRuns: [
        {
          status: "success",
          evidence: []
        }
      ]
    }),
    {
      status: "not_reviewable",
      reasons: [
        "validation_artifacts_not_captured",
        "provider_model_evidence_requirement_unknown"
      ]
    }
  );

  assert.deepEqual(
    normalizeReviewability(null, {
      status: "blocked",
      stopReason: "Waiting for required approval.",
      stopReasonCode: "approval_required",
      validationArtifacts: null,
      contractRuns: []
    }),
    {
      status: "reviewable",
      reasons: []
    }
  );

  assert.deepEqual(
    normalizeReviewability(null, {
      status: "failed",
      stopReason: null,
      stopReasonCode: "execution_error",
      validationArtifacts: null,
      contractRuns: []
    }),
    {
      status: "not_reviewable",
      reasons: ["missing_stop_reason"]
    }
  );

  assert.deepEqual(
    normalizeReviewability(null, {
      status: "repair_required",
      stopReason: "Verifier requested repair after bounded retry.",
      stopReasonCode: "validation_failed",
      validationArtifacts: null,
      contractRuns: []
    }),
    {
      status: "reviewable",
      reasons: []
    }
  );
});

test("run evidence reviewability normalization rejects invalid explicit status/reason combinations", () => {
  assert.deepEqual(
    normalizeReviewability({
      status: "unknown",
      reasons: ["provider_model_evidence_requirement_unknown"]
    }),
    {
      status: "unknown",
      reasons: ["provider_model_evidence_requirement_unknown"]
    }
  );

  assert.throws(
    () => normalizeReviewability({
      status: "reviewable",
      reasons: ["validation_artifacts_not_captured"]
    }),
    /status reviewable does not match reasons-derived status not_reviewable/u
  );

  assert.throws(
    () => normalizeReviewability({
      status: "unknown",
      reasons: ["missing_stop_reason"]
    }),
    /status unknown does not match reasons-derived status not_reviewable/u
  );
});

test("run evidence normalizes changed-surface capture and defaults legacy omissions to not_captured", () => {
  assert.deepEqual(normalizeChangedSurface(null), {
    capture: "not_captured",
    paths: []
  });

  assert.deepEqual(normalizeChangedSurface({
    capture: "complete",
    paths: ["src\\helpers.js", "./src/helpers.js", "src/helpers.js"]
  }), {
    capture: "complete",
    paths: ["src/helpers.js"]
  });
});

test("run evidence changed-surface normalization fails closed on malformed present values", () => {
  assert.throws(
    () => normalizeChangedSurface({
      capture: "unknown",
      paths: []
    }, {
      fieldName: "runJournalEntry.changedSurface"
    }),
    /runJournalEntry\.changedSurface\.capture must be one of: complete, partial, not_captured/u
  );

  assert.throws(
    () => normalizeChangedSurface({
      capture: "not_captured",
      paths: ["src/helpers.js"]
    }, {
      fieldName: "runJournalEntry.changedSurface"
    }),
    /runJournalEntry\.changedSurface\.paths must be empty when runJournalEntry\.changedSurface\.capture is not_captured/u
  );

  assert.throws(
    () => normalizeChangedSurface({
      capture: "complete",
      paths: ["../outside.js"]
    }, {
      fieldName: "runJournalEntry.changedSurface"
    }),
    /must not escape the repository root/u
  );
});

test("run evidence changed-surface observation normalization allows complete/not_captured only", () => {
  assert.equal(normalizeChangedSurfaceObservation(null), null);

  assert.deepEqual(normalizeChangedSurfaceObservation({
    capture: "complete",
    paths: ["src\\helpers.js", "src/helpers.js"]
  }), {
    capture: "complete",
    paths: ["src/helpers.js"]
  });

  assert.throws(
    () => normalizeChangedSurfaceObservation({
      capture: "partial",
      paths: ["src/helpers.js"]
    }, {
      fieldName: "result.changedSurfaceObservation"
    }),
    /result\.changedSurfaceObservation\.capture must be one of: complete, not_captured/u
  );
});
