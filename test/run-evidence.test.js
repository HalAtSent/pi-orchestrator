import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveCommandObservationsFromCommands,
  derivePlannedActionClassesFromWorkflow,
  createFixtureRecommendationMetadata,
  inferActionClasses,
  inferActionClassesFromCommands,
  inferFailureClass,
  inferStopReasonCode,
  inferValidationOutcome,
  normalizeAcceptanceArtifact,
  normalizeActionClasses,
  normalizeApprovalBinding,
  normalizeClaimLedger,
  normalizeDeclaredActionClasses,
  normalizeLineageDepth,
  normalizePolicyProfile,
  normalizeChangedSurface,
  normalizeChangedSurfaceObservation,
  normalizeCommandObservations,
  normalizeFailureClass,
  normalizeProviderModelEvidenceRequirement,
  normalizeProviderModelSelection,
  normalizeProviderModelSelections,
  normalizeReviewFindings,
  normalizeReviewability,
  normalizeScopeOwnership,
  normalizeSourceArtifactIds,
  normalizeStopReasonCode,
  normalizeTraceability,
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

test("run evidence infers deterministic failure classes for terminal states", () => {
  assert.equal(
    inferFailureClass({
      status: "blocked",
      stopReasonCode: "approval_required",
      stopReason: "Human approval is required before executing this workflow."
    }),
    "approval_required"
  );
  assert.equal(
    inferFailureClass({
      status: "blocked",
      stopReasonCode: "scope_violation",
      stopReason: "implementer reported a file outside its allowlist"
    }),
    "scope_violation"
  );
  assert.equal(
    inferFailureClass({
      status: "blocked",
      stopReasonCode: "protected_path_violation",
      stopReason: "Execution program references protected path(s): .env"
    }),
    "protected_path_violation"
  );
  assert.equal(
    inferFailureClass({
      status: "blocked",
      stopReasonCode: "runtime_unavailable",
      stopReason: "process worker failed: launcher timed out"
    }),
    "model_or_runtime_unavailable"
  );
  assert.equal(
    inferFailureClass({
      status: "blocked",
      stopReasonCode: "invalid_worker_output",
      stopReason: "Contract executor returned an invalid result"
    }),
    "worker_output_invalid"
  );
  assert.equal(
    inferFailureClass({
      status: "failed",
      stopReasonCode: "validation_failed",
      stopReason: "Validation failed: node --test failed"
    }),
    "missing_validation"
  );
  assert.equal(
    inferFailureClass({
      status: "blocked",
      stopReason: "Contract blocked: deterministic spec drift was detected."
    }),
    "summary_overclaim"
  );
  assert.equal(inferFailureClass({ status: "success" }), null);
});

test("run evidence normalizes failure classes and fixture recommendations without creating fixtures", () => {
  assert.equal(
    normalizeFailureClass(null, {
      status: "blocked",
      stopReasonCode: "approval_required",
      stopReason: "Approval required."
    }),
    "approval_required"
  );
  assert.throws(
    () => normalizeFailureClass("scope_violation", {
      status: "blocked",
      stopReasonCode: "approval_required",
      stopReason: "Approval required."
    }),
    /must match inferred failure class approval_required/u
  );
  assert.throws(
    () => normalizeFailureClass("unknown", {
      status: "success"
    }),
    /must be omitted unless status is blocked, failed, or repair_required/u
  );
  assert.throws(
    () => normalizeFailureClass("unknown", {
      status: "running"
    }),
    /must be omitted unless status is blocked, failed, or repair_required/u
  );
  assert.deepEqual(
    createFixtureRecommendationMetadata("worker_output_invalid"),
    {
      recommended: true,
      autoCreate: false,
      failureClass: "worker_output_invalid",
      targetDirectory: "test/fixtures",
      reason: "Capture a deterministic regression fixture for failureClass=worker_output_invalid."
    }
  );
  assert.equal(createFixtureRecommendationMetadata("approval_required"), null);
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

test("run evidence detects package installs after package-manager global options", () => {
  for (const command of [
    "npm --prefix ./app install",
    "npm --workspace app install",
    "pnpm --filter app add",
    "yarn --cwd app add",
    "bun --cwd app add"
  ]) {
    assert.deepEqual(inferActionClassesFromCommands([command]), ["install_dependency"], command);
  }
});

test("run evidence derives execute/install/git classes from typed command observations", () => {
  assert.deepEqual(
    inferActionClasses({
      contractRuns: [
        {
          evidence: ["run implementer: success"],
          commandObservations: deriveCommandObservationsFromCommands([
            "npm install --save-dev vitest",
            "git commit -m \"checkpoint\""
          ], {
            source: "worker_reported"
          })
        }
      ]
    }),
    ["write_allowed", "execute_local_command", "install_dependency", "mutate_git_state"]
  );
});

test("run evidence conservatively classifies install and git mutations behind shell pipes", () => {
  assert.deepEqual(
    inferActionClasses({
      contractRuns: [
        {
          evidence: [
            "run implementer: success",
            "run implementer command: echo ok | npm install left-pad",
            "run implementer command: echo ok | git push origin HEAD"
          ]
        }
      ]
    }),
    ["write_allowed", "install_dependency", "mutate_git_state"]
  );

  assert.deepEqual(
    deriveCommandObservationsFromCommands([
      "echo ok | npm install left-pad",
      "echo ok | git push origin HEAD"
    ], {
      source: "worker_reported"
    }).map((observation) => observation.actionClasses).flat(),
    ["execute_local_command", "install_dependency", "execute_local_command", "mutate_git_state"]
  );
});

test("run evidence treats typed command observations as authoritative when present", () => {
  assert.deepEqual(
    inferActionClasses({
      contractRuns: [
        {
          evidence: [
            "run implementer: success",
            "run implementer command: npm install --save-dev vitest",
            "run implementer command: git commit -m \"checkpoint\""
          ],
          commandObservations: [
            {
              command: "node --test --test-name-pattern helpers",
              source: "worker_reported",
              actionClasses: ["execute_local_command"]
            }
          ]
        }
      ]
    }),
    ["write_allowed", "execute_local_command"]
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

test("run evidence normalizes typed approval lineage and fails closed on malformed present values", () => {
  assert.equal(
    normalizeApprovalBinding(undefined, {
      fieldName: "runJournal.approvalBinding",
      allowMissing: true
    }),
    null
  );

  assert.deepEqual(
    normalizeApprovalBinding({
      status: "approved",
      source: "build_session",
      buildId: " build-abc123 ",
      approvalId: " approval-xyz "
    }, {
      fieldName: "runJournal.approvalBinding",
      allowMissing: false
    }),
    {
      status: "approved",
      source: "build_session",
      buildId: "build-abc123",
      approvalId: "approval-xyz"
    }
  );

  assert.deepEqual(
    normalizeApprovalBinding({
      status: "approved",
      source: "build_session",
      buildId: "build-scoped",
      actionClasses: ["write_allowed", "read_repo", "write_allowed"],
      policyProfile: "default"
    }, {
      fieldName: "runJournal.approvalBinding",
      allowMissing: false
    }),
    {
      status: "approved",
      source: "build_session",
      buildId: "build-scoped",
      actionClasses: ["read_repo", "write_allowed"],
      policyProfile: "default"
    }
  );

  assert.throws(
    () => normalizeApprovalBinding({
      status: "approved_now",
      source: "build_session"
    }, {
      fieldName: "runJournal.approvalBinding",
      allowMissing: false
    }),
    /runJournal\.approvalBinding\.status must be one of: approved, unknown/u
  );

  assert.throws(
    () => normalizeApprovalBinding({
      status: "approved",
      source: "build_session",
      buildId: "   "
    }, {
      fieldName: "runJournal.approvalBinding",
      allowMissing: false
    }),
    /runJournal\.approvalBinding\.buildId must be a non-empty string when provided/u
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

test("run evidence normalizes typed command observations and fails closed on malformed present values", () => {
  assert.deepEqual(
    normalizeCommandObservations([
      {
        command: "npm install --save-dev vitest",
        source: "worker_reported",
        actionClasses: ["execute_local_command", "install_dependency"]
      }
    ], {
      fieldName: "runJournalEntry.commandObservations"
    }),
    [
      {
        command: "npm install --save-dev vitest",
        source: "worker_reported",
        actionClasses: ["execute_local_command", "install_dependency"]
      }
    ]
  );

  assert.throws(
    () => normalizeCommandObservations([
      {
        command: "npm install --save-dev vitest",
        source: "worker_reported",
        actionClasses: ["install_dependency"]
      }
    ], {
      fieldName: "runJournalEntry.commandObservations"
    }),
    /runJournalEntry\.commandObservations\[0\]\.actionClasses must include execute_local_command/u
  );

  assert.throws(
    () => normalizeCommandObservations([
      {
        command: "node --test --test-name-pattern helpers",
        source: "worker_reported",
        actionClasses: ["execute_local_command", "install_dependency"]
      }
    ], {
      fieldName: "runJournalEntry.commandObservations"
    }),
    /runJournalEntry\.commandObservations\[0\]\.actionClasses includes install_dependency, which is not command-detector-backed for this command/u
  );
});

test("run evidence normalizes review findings and fails closed on malformed present values", () => {
  assert.deepEqual(
    normalizeReviewFindings([
      {
        kind: "issue",
        severity: "high",
        message: "Missing assertion around renamed helper output.",
        path: "src\\helpers.js"
      },
      {
        kind: "gap",
        severity: "low",
        message: "No explicit rollback note in this contract run."
      }
    ], {
      fieldName: "runJournalEntry.reviewFindings"
    }),
    [
      {
        kind: "issue",
        severity: "high",
        message: "Missing assertion around renamed helper output.",
        path: "src/helpers.js"
      },
      {
        kind: "gap",
        severity: "low",
        message: "No explicit rollback note in this contract run."
      }
    ]
  );

  assert.equal(
    normalizeReviewFindings(undefined, {
      fieldName: "runJournalEntry.reviewFindings",
      allowMissing: true
    }),
    null
  );

  assert.throws(
    () => normalizeReviewFindings([
      {
        kind: "issue",
        severity: "critical",
        message: "Severity must be closed enum."
      }
    ], {
      fieldName: "runJournalEntry.reviewFindings"
    }),
    /runJournalEntry\.reviewFindings\[0\]\.severity must be one of: high, medium, low/u
  );

  assert.throws(
    () => normalizeReviewFindings([
      {
        kind: "risk",
        severity: "medium",
        message: "Path escaped root.",
        path: "../outside.js"
      }
    ], {
      fieldName: "runJournalEntry.reviewFindings"
    }),
    /runJournalEntry\.reviewFindings\[0\]\.path must not escape the repository root/u
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
          providerModelSelections: [
            {
              role: "implementer",
              iteration: 0,
              requestedProvider: "openai-codex",
              requestedModel: "gpt-5.4",
              selectedProvider: "openai-codex",
              selectedModel: "gpt-5.4"
            }
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
          reference: "test-run:node --test --test-isolation=none",
          status: "captured"
        }
      ],
      contractRuns: [
        {
          status: "success",
          providerModelSelections: [
            {
              role: "implementer",
              iteration: 0,
              requestedProvider: "openai-codex",
              requestedModel: "gpt-5.4",
              selectedProvider: "openai-codex",
              selectedModel: "gpt-5.4"
            }
          ],
          evidence: [
            "selected_provider: unknown",
            "selected_model: unknown"
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
          reference: "test-run:node --test --test-isolation=none",
          status: "captured"
        }
      ],
      contractRuns: [
        {
          status: "success",
          providerModelSelections: [],
          evidence: [
            "selected_provider: openai-codex",
            "selected_model: gpt-5.4"
          ]
        }
      ]
    }),
    {
      status: "unknown",
      reasons: ["provider_model_evidence_requirement_unknown"]
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
          providerModelEvidenceRequirement: "required",
          evidence: [
            "selected_provider: openai-codex",
            "selected_model: gpt-5.4"
          ]
        }
      ]
    }),
    {
      status: "not_reviewable",
      reasons: ["provider_model_evidence_missing"]
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
          providerModelEvidenceRequirement: "unknown",
          providerModelSelections: [
            {
              role: "implementer",
              iteration: 0,
              requestedProvider: "openai-codex",
              requestedModel: "gpt-5.4",
              selectedProvider: "openai-codex",
              selectedModel: "gpt-5.4"
            }
          ]
        }
      ]
    }),
    {
      status: "unknown",
      reasons: ["provider_model_evidence_requirement_unknown"]
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

test("run evidence normalizes typed scope ownership and fails closed on malformed present values", () => {
  assert.deepEqual(
    normalizeScopeOwnership({
      declaredScope: {
        mode: "explicit_paths",
        paths: ["src/", "src/helpers.js"]
      },
      observedChanges: {
        paths: ["src\\helpers.js"]
      },
      status: "aligned"
    }, {
      fieldName: "runJournalEntry.scopeOwnership"
    }),
    {
      declaredScope: {
        mode: "explicit_paths",
        paths: ["src/", "src/helpers.js"]
      },
      observedChanges: {
        paths: ["src/helpers.js"]
      },
      status: "aligned"
    }
  );

  assert.equal(
    normalizeScopeOwnership(undefined, {
      fieldName: "runJournalEntry.scopeOwnership",
      allowMissing: true
    }),
    null
  );

  assert.throws(
    () => normalizeScopeOwnership({
      declaredScope: {
        mode: "explicit_paths",
        paths: ["src/helpers.js"]
      },
      observedChanges: {
        paths: ["src/helpers.js"]
      },
      status: "not_supported"
    }, {
      fieldName: "runJournalEntry.scopeOwnership"
    }),
    /runJournalEntry\.scopeOwnership\.status must be one of: aligned, scope_violation, no_observed_changes, unknown/u
  );

  assert.throws(
    () => normalizeScopeOwnership({
      declaredScope: {
        mode: "explicit_paths",
        paths: ["src/helpers.js"]
      },
      observedChanges: {
        paths: []
      },
      status: "aligned"
    }, {
      fieldName: "runJournalEntry.scopeOwnership"
    }),
    /runJournalEntry\.scopeOwnership\.observedChanges\.paths must include at least one path when runJournalEntry\.scopeOwnership\.status is aligned/u
  );
});

test("run evidence normalizes typed provider/model selection fields and rejects unknown sentinels", () => {
  assert.deepEqual(
    normalizeProviderModelSelection({
      requestedProvider: "openai-codex",
      requestedModel: "gpt-5.3-codex",
      selectedProvider: "openai-codex",
      selectedModel: "gpt-5.3-codex"
    }),
    {
      requestedProvider: "openai-codex",
      requestedModel: "gpt-5.3-codex",
      selectedProvider: "openai-codex",
      selectedModel: "gpt-5.3-codex"
    }
  );

  assert.deepEqual(
    normalizeProviderModelSelections([
      {
        role: "implementer",
        iteration: 0,
        requestedProvider: "openai-codex",
        requestedModel: "gpt-5.3-codex",
        selectedProvider: "openai-codex",
        selectedModel: "gpt-5.3-codex"
      }
    ]),
    [
      {
        role: "implementer",
        iteration: 0,
        requestedProvider: "openai-codex",
        requestedModel: "gpt-5.3-codex",
        selectedProvider: "openai-codex",
        selectedModel: "gpt-5.3-codex"
      }
    ]
  );

  assert.throws(
    () => normalizeProviderModelSelection({
      requestedProvider: "openai-codex",
      requestedModel: "gpt-5.3-codex",
      selectedProvider: "unknown",
      selectedModel: "gpt-5.3-codex"
    }),
    /providerModelSelection\.selectedProvider must not be unknown/u
  );
});

test("run evidence normalizes provider/model evidence requirements and fails closed on malformed present values", () => {
  assert.equal(normalizeProviderModelEvidenceRequirement("required"), "required");
  assert.equal(
    normalizeProviderModelEvidenceRequirement(undefined, {
      allowMissing: true
    }),
    null
  );

  assert.throws(
    () => normalizeProviderModelEvidenceRequirement(null, {
      fieldName: "runJournalEntry.providerModelEvidenceRequirement"
    }),
    /runJournalEntry\.providerModelEvidenceRequirement must be a non-empty string/u
  );

  assert.throws(
    () => normalizeProviderModelEvidenceRequirement("not_applicable", {
      fieldName: "runJournalEntry.providerModelEvidenceRequirement"
    }),
    /runJournalEntry\.providerModelEvidenceRequirement must be one of: required, unknown/u
  );
});

test("run evidence normalizes typed acceptance artifacts, claim ledgers, and traceability", () => {
  assert.deepEqual(
    normalizeAcceptanceArtifact({
      status: "satisfied",
      items: [
        {
          id: "contract-1:acceptance_check:1",
          type: "acceptance_check",
          text: "Scoped behavior is verified.",
          required: true
        }
      ]
    }, {
      fieldName: "runJournalEntry.acceptanceArtifact"
    }),
    {
      status: "satisfied",
      items: [
        {
          id: "contract-1:acceptance_check:1",
          type: "acceptance_check",
          text: "Scoped behavior is verified.",
          required: true
        }
      ]
    }
  );

  assert.deepEqual(
    normalizeClaimLedger([
      {
        id: "contract-1:acceptance_check:1",
        type: "acceptance_check",
        text: "Scoped behavior is verified.",
        status: "proven",
        evidenceRefs: ["run:verifier:commandsRun[0]"]
      },
      {
        id: "contract-1:non_goal:1",
        type: "non_goal",
        text: "Do not edit generated files.",
        status: "unproven",
        reason: "Changed-path capture is not complete."
      }
    ], {
      fieldName: "runJournalEntry.claimLedger"
    }),
    [
      {
        id: "contract-1:acceptance_check:1",
        type: "acceptance_check",
        text: "Scoped behavior is verified.",
        status: "proven",
        required: true,
        evidenceRefs: ["run:verifier:commandsRun[0]"]
      },
      {
        id: "contract-1:non_goal:1",
        type: "non_goal",
        text: "Do not edit generated files.",
        status: "unproven",
        required: true,
        evidenceRefs: [],
        reason: "Changed-path capture is not complete."
      }
    ]
  );

  assert.deepEqual(
    normalizeTraceability({
      requirementChecks: [
        {
          id: "contract-1:acceptance_check:1",
          type: "acceptance_check",
          text: "Scoped behavior is verified.",
          claimIds: ["contract-1:acceptance_check:1"],
          changedFilesKnown: true,
          changedFiles: ["src\\helpers.js"],
          validationEvidenceKnown: true,
          validationEvidenceRefs: ["run:verifier:commandsRun[0]"]
        }
      ],
      nonGoals: [
        {
          id: "contract-1:non_goal:1",
          text: "Do not edit generated files.",
          preservationStatus: "unproven",
          claimIds: ["contract-1:non_goal:1"],
          changedFiles: ["src/helpers.js"],
          evidenceRefs: [],
          reason: "Changed-path capture is not complete."
        }
      ]
    }, {
      fieldName: "runJournalEntry.traceability"
    }),
    {
      requirementChecks: [
        {
          id: "contract-1:acceptance_check:1",
          type: "acceptance_check",
          text: "Scoped behavior is verified.",
          claimIds: ["contract-1:acceptance_check:1"],
          changedFilesKnown: true,
          changedFiles: ["src/helpers.js"],
          validationEvidenceKnown: true,
          validationEvidenceRefs: ["run:verifier:commandsRun[0]"]
        }
      ],
      nonGoals: [
        {
          id: "contract-1:non_goal:1",
          text: "Do not edit generated files.",
          preservationStatus: "unproven",
          claimIds: ["contract-1:non_goal:1"],
          changedFiles: ["src/helpers.js"],
          evidenceRefs: [],
          reason: "Changed-path capture is not complete."
        }
      ]
    }
  );
});

test("run evidence fails closed on malformed typed claim surfaces and unproven required claims block reviewability", () => {
  assert.throws(
    () => normalizeClaimLedger([
      {
        id: "contract-1:acceptance_check:1",
        type: "acceptance_check",
        text: "Scoped behavior is verified.",
        status: "proven",
        evidenceRefs: []
      }
    ], {
      fieldName: "runJournalEntry.claimLedger"
    }),
    /runJournalEntry\.claimLedger\[0\] must include evidenceRefs or evidenceSummary when status is proven/u
  );

  assert.throws(
    () => normalizeClaimLedger([
      {
        id: "contract-1:acceptance_check:1",
        type: "acceptance_check",
        text: "Scoped behavior is verified.",
        status: "unproven"
      }
    ], {
      fieldName: "runJournalEntry.claimLedger"
    }),
    /runJournalEntry\.claimLedger\[0\]\.reason is required when status is unproven/u
  );

  assert.deepEqual(
    normalizeReviewability(null, {
      status: "success",
      stopReason: null,
      stopReasonCode: null,
      validationArtifacts: [
        {
          artifactType: "validation_artifact",
          reference: "test-run:node --test",
          status: "captured"
        }
      ],
      contractRuns: [
        {
          status: "success",
          providerModelEvidenceRequirement: "required",
          providerModelSelections: [
            {
              role: "implementer",
              iteration: 0,
              requestedProvider: "openai-codex",
              requestedModel: "gpt-5.4",
              selectedProvider: "openai-codex",
              selectedModel: "gpt-5.4"
            }
          ],
          claimLedger: [
            {
              id: "contract-1:acceptance_check:1",
              type: "acceptance_check",
              text: "Scoped behavior is verified.",
              status: "unproven",
              reason: "No verifier evidence was captured."
            }
          ]
        }
      ]
    }),
    {
      status: "not_reviewable",
      reasons: ["required_claims_unproven"]
    }
  );
});
