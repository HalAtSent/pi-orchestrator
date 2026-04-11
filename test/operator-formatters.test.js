import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildProjectLifecycleArtifacts } from "../src/project-workflows.js";
import {
  formatOperatorApprovalCheckpoint,
  formatOperatorBuildSessionLookupBlocked,
  formatOperatorBuildSessionStatus,
  formatOperatorBuildNextAction,
  formatOperatorBlockedMessage,
  formatOperatorIntakeSummary,
  formatOperatorStagedPlan
} from "../src/operator-formatters.js";

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function createSampleIntake() {
  return {
    goal: "Build an onboarding portal for non-technical operators",
    targetUsers: ["operators"],
    constraints: ["No raw JSON inputs in the primary path"],
    successSignals: ["An operator can kick off work from one plain-English prompt"],
    stackPreferences: ["Node.js"],
    nonGoals: ["No recursive delegation"]
  };
}

function createSampleBuildSession() {
  const lifecycle = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  return {
    buildId: "build-abc123",
    intake: createSampleIntake(),
    lifecycle: {
      proposalSet: lifecycle.proposalSet,
      blueprint: lifecycle.blueprint,
      executionProgram: lifecycle.executionProgram,
      auditReport: lifecycle.auditReport
    },
    approval: {
      approved: false,
      approvedAt: null
    },
    execution: {
      status: "awaiting_approval",
      stopReason: null,
      programId: null,
      completedContracts: 0,
      pendingContracts: lifecycle.executionProgram.contracts.length,
      updatedAt: new Date().toISOString()
    }
  };
}

test("operator intake summary stays plain-English and readable", () => {
  const summary = formatOperatorIntakeSummary(createSampleIntake());

  assert.match(summary, /Intake Summary/u);
  assert.match(summary, /Goal: Build an onboarding portal/u);
  assert.match(summary, /Audience: operators/u);
  assert.match(summary, /Constraints:/u);
  assert.match(summary, /Success signals:/u);
});

test("operator staged plan mirrors existing lifecycle outputs", () => {
  const lifecycle = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const plan = formatOperatorStagedPlan(lifecycle);

  assert.match(plan, /Staged Plan/u);
  assert.match(plan, /Brainstorm: compared 3 options/u);
  assert.match(plan, /Control Plane First/u);
  assert.match(plan, /Slice: generated \d+ bounded contract\(s\)/u);
  assert.match(plan, /Audit: current status is/u);
});

test("approval checkpoint tells operators how to approve without raw contracts", () => {
  const lifecycle = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const checkpoint = formatOperatorApprovalCheckpoint({
    intake: createSampleIntake(),
    lifecycle,
    approvalRequested: false
  });

  assert.match(checkpoint, /Approval Checkpoint/u);
  assert.match(checkpoint, /No implementation has started yet/u);
  assert.match(checkpoint, /\/build --approve/u);
  assert.match(checkpoint, /without manual JSON contracts/u);
});

test("approval checkpoint reports terminal non-resumable status guidance once approved", () => {
  const lifecycle = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const checkpoint = formatOperatorApprovalCheckpoint({
    intake: createSampleIntake(),
    lifecycle,
    approvalRequested: true,
    runJournal: {
      programId: lifecycle.executionProgram.id,
      status: "blocked",
      stopReason: "Human approval is required before executing this workflow."
    }
  });

  assert.match(checkpoint, /Approval received/u);
  assert.match(checkpoint, /Run status: blocked/u);
  assert.match(checkpoint, /cannot be resumed/u);
  assert.doesNotMatch(checkpoint, /\/resume-program/u);
});

test("build next action recommends resume only for running journals", () => {
  const action = formatOperatorBuildNextAction({
    programId: "program-123",
    status: "running",
    stopReason: null
  });

  assert.match(action, /\/resume-program program-123/u);
});

test("build next action avoids resume guidance for terminal journals", () => {
  const action = formatOperatorBuildNextAction({
    programId: "program-456",
    status: "failed",
    stopReason: "Validation failed"
  });

  assert.match(action, /cannot be resumed/u);
  assert.doesNotMatch(action, /\/resume-program/u);
});

test("blocked formatter gives a clear plain-English retry message", () => {
  const text = formatOperatorBlockedMessage({
    message: "goal must be a non-empty string"
  });

  assert.match(text, /Build Flow Blocked/u);
  assert.match(text, /goal must be a non-empty string/u);
  assert.match(text, /Try again with one clear idea sentence/u);
});

test("build session status formatter shows a plain-English status snapshot", () => {
  const status = formatOperatorBuildSessionStatus(createSampleBuildSession());

  assert.match(status, /Build Session/u);
  assert.match(status, /Build ID: build-abc123/u);
  assert.match(status, /Approval: pending/u);
  assert.match(status, /Execution status: awaiting_approval/u);
  assert.match(status, /Next action: Approve kickoff with \/build-approve build-abc123\./u);
});

test("build session blocked lookup formatter stays operator-friendly", () => {
  const text = formatOperatorBuildSessionLookupBlocked({
    buildId: "build-missing",
    message: "No persisted build session found for build id: build-missing"
  });

  assert.match(text, /Build Session Lookup Blocked/u);
  assert.match(text, /Build ID: build-missing/u);
  assert.match(text, /No persisted build session found for build id/u);
  assert.match(text, /Use \/build with a plain-English idea/u);
});
