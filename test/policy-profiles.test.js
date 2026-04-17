import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePolicyDecision,
  evaluatePolicyDecisionAgainstProfile,
  normalizePolicyProfileId
} from "../src/policy-profiles.js";

test("policy profile id normalization accepts the supported default profile", () => {
  assert.equal(normalizePolicyProfileId("default"), "default");
  assert.equal(normalizePolicyProfileId(null), "default");
});

test("policy profile id normalization fails closed for unsupported ids", () => {
  assert.throws(
    () => normalizePolicyProfileId("operator_safe"),
    /policyProfile must be one of: default/u
  );

  const decision = evaluatePolicyDecision({
    profileId: "operator_safe",
    detectedActionClasses: [],
    requiresProcessBackend: false,
    humanGateApproved: true
  });
  assert.deepEqual(decision, {
    profileId: "operator_safe",
    status: "blocked",
    reason: "unknown_profile"
  });
});

test("live policy-profile registry resolves supported default profile to allowed across current enforced inputs", () => {
  const cases = [
    {
      detectedActionClasses: [],
      requiresProcessBackend: false,
      humanGateApproved: false
    },
    {
      detectedActionClasses: ["execute_local_command"],
      requiresProcessBackend: true,
      humanGateApproved: false
    },
    {
      detectedActionClasses: ["execute_local_command", "install_dependency", "mutate_git_state"],
      requiresProcessBackend: true,
      humanGateApproved: true
    }
  ];

  for (const policyInput of cases) {
    const decision = evaluatePolicyDecision({
      profileId: "default",
      ...policyInput
    });
    assert.deepEqual(decision, {
      profileId: "default",
      status: "allowed",
      reason: "profile_allows_execution"
    });
  }
});

// The following tests exercise helper-level compiled-profile logic only.
// They do not claim runtime reachability through the current live registry.
test("compiled-profile helper blocks when profile disallows process-backend execution", () => {
  const decision = evaluatePolicyDecisionAgainstProfile({
    id: "default",
    allowedActionClasses: ["execute_local_command", "install_dependency", "mutate_git_state"],
    allowProcessBackend: false,
    requireHumanGateBeforeExecution: false
  }, {
    detectedActionClasses: ["execute_local_command"],
    requiresProcessBackend: true,
    humanGateApproved: true
  });

  assert.deepEqual(decision, {
    profileId: "default",
    status: "blocked",
    reason: "profile_disallows_process_backend"
  });
});

test("compiled-profile helper blocks when profile disallows a detector-backed action class", () => {
  const decision = evaluatePolicyDecisionAgainstProfile({
    id: "default",
    allowedActionClasses: ["execute_local_command"],
    allowProcessBackend: true,
    requireHumanGateBeforeExecution: false
  }, {
    detectedActionClasses: ["execute_local_command", "install_dependency"],
    requiresProcessBackend: false,
    humanGateApproved: true
  });

  assert.deepEqual(decision, {
    profileId: "default",
    status: "blocked",
    reason: "profile_disallows_action_class"
  });
});

test("compiled-profile helper returns approval_required when profile requires a human gate and no approval signal exists", () => {
  const decision = evaluatePolicyDecisionAgainstProfile({
    id: "default",
    allowedActionClasses: ["execute_local_command", "install_dependency", "mutate_git_state"],
    allowProcessBackend: true,
    requireHumanGateBeforeExecution: true
  }, {
    detectedActionClasses: ["execute_local_command"],
    requiresProcessBackend: false,
    humanGateApproved: false
  });

  assert.deepEqual(decision, {
    profileId: "default",
    status: "approval_required",
    reason: "profile_requires_human_gate"
  });
});
