import test from "node:test";
import assert from "node:assert/strict";

import { createOperatorIntake } from "../src/operator-intake.js";

test("operator intake parses plain-English sections into planning input", () => {
  const intake = createOperatorIntake(`
Build a concierge onboarding portal for local bakeries.
Audience: Bakery owners
Constraints: no paid APIs; launch in 2 weeks
Success: Owners can publish their first menu in 10 minutes
Preferences: Node.js, markdown docs
Non-goals: native mobile app
  `);

  assert.equal(intake.goal, "Build a concierge onboarding portal for local bakeries.");
  assert.deepEqual(intake.targetUsers, ["Bakery owners", "local bakeries"]);
  assert.deepEqual(intake.constraints, ["no paid APIs", "launch in 2 weeks"]);
  assert.deepEqual(intake.successSignals, ["Owners can publish their first menu in 10 minutes"]);
  assert.deepEqual(intake.stackPreferences, ["Node.js", "markdown docs"]);
  assert.deepEqual(intake.nonGoals, ["native mobile app"]);
  assert.deepEqual(intake.planningInput.successCriteria, ["Owners can publish their first menu in 10 minutes"]);
  assert.equal(intake.approvalRequested, false);
});

test("operator intake accepts --approve flag in plain-English input", () => {
  const intake = createOperatorIntake("--approve Build an internal QA dashboard for support agents");

  assert.equal(intake.approvalRequested, true);
  assert.equal(intake.goal, "Build an internal QA dashboard for support agents");
});

test("operator intake strips wrapper quotes from copied approval commands", () => {
  const intake = createOperatorIntake("--approve \"Build an internal QA dashboard for support agents\"");

  assert.equal(intake.approvalRequested, true);
  assert.equal(intake.goal, "Build an internal QA dashboard for support agents");
});

test("operator intake allows explicit field overrides from object input", () => {
  const intake = createOperatorIntake({
    idea: "Build a project tracker.\nAudience: coordinators",
    goal: "Build a launch tracker for release coordinators",
    constraints: ["Must run offline"],
    targetAudience: "release coordinators",
    successCriteria: ["Coordinator can publish a weekly release summary"],
    approve: "yes"
  });

  assert.equal(intake.goal, "Build a launch tracker for release coordinators");
  assert.deepEqual(intake.targetUsers, ["coordinators", "release coordinators"]);
  assert.deepEqual(intake.constraints, ["Must run offline"]);
  assert.deepEqual(intake.successSignals, ["Coordinator can publish a weekly release summary"]);
  assert.equal(intake.approvalRequested, true);
});

test("operator intake rejects empty requests", () => {
  assert.throws(
    () => createOperatorIntake("   "),
    /Provide a plain-English idea or a JSON object/u
  );
});
