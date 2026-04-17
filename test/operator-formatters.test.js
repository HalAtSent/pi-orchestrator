import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildProjectLifecycleArtifacts,
  createExecutionProgramPlanFingerprint,
  deriveExecutionProgramActionClasses
} from "../src/project-workflows.js";
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
  const planFingerprint = createExecutionProgramPlanFingerprint(lifecycle.executionProgram);
  const approvalActionClasses = deriveExecutionProgramActionClasses(lifecycle.executionProgram);
  return {
    buildId: "build-abc123",
    planFingerprint,
    intake: createSampleIntake(),
    lifecycle: {
      proposalSet: lifecycle.proposalSet,
      blueprint: lifecycle.blueprint,
      executionProgram: lifecycle.executionProgram,
      auditReport: lifecycle.auditReport
    },
    approval: {
      approved: false,
      approvedAt: null,
      programId: lifecycle.executionProgram.id,
      planFingerprint,
      actionClasses: approvalActionClasses,
      policyProfile: "default"
    },
    execution: {
      status: "awaiting_approval",
      stopReason: null,
      actionClasses: [],
      policyProfile: "default",
      validationArtifacts: [],
      reviewability: {
        status: "not_reviewable",
        reasons: ["non_terminal_status"]
      },
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
  assert.match(status, /Operator Summary/u);
  assert.match(status, /requested outcome: Build an onboarding portal/u);
  assert.match(status, /actual outcome: status: awaiting_approval/u);
  assert.match(status, /unproven claims: Execution has not started, so the requested outcome is not yet proven\./u);
  assert.match(status, /next step: Approve kickoff with \/build-approve build-abc123\./u);
  assert.match(status, /Approval: pending/u);
  assert.match(status, /Plan fingerprint: /u);
  assert.match(status, /Approval scope: read_repo, write_allowed, execute_local_command/u);
  assert.match(status, /Execution status: awaiting_approval/u);
  assert.match(status, /Changed surfaces:/u);
  assert.match(status, /Proof collected:/u);
  assert.match(status, /Unproven claims:/u);
  assert.match(status, /Reviewability: Machine assessment: not reviewable\./u);
  assert.match(status, /Approval needed: Yes\. Approve kickoff with \/build-approve build-abc123\./u);
  assert.match(status, /Recovery \/ undo notes:/u);
  assert.match(status, /Next action: Approve kickoff with \/build-approve build-abc123\./u);
});

test("build session status distinguishes planned scope from executed evidence when run data exists", () => {
  const buildSession = createSampleBuildSession();
  const firstContract = buildSession.lifecycle.executionProgram.contracts[0];

  const status = formatOperatorBuildSessionStatus(buildSession, {
    runJournal: {
      programId: buildSession.lifecycle.executionProgram.id,
      status: "blocked",
      stopReason: "waiting for dependency",
      contractRuns: [
        {
          contractId: firstContract.id,
          status: "success",
          summary: "Executed one scoped contract.",
          evidence: ["run explorer: success"],
          changedSurface: {
            capture: "not_captured",
            paths: []
          },
          openQuestions: ["Restore previous file versions manually if rollback is needed."]
        }
      ],
      completedContractIds: [firstContract.id],
      pendingContractIds: buildSession.lifecycle.executionProgram.contracts.slice(1).map((contract) => contract.id)
    }
  });

  assert.match(status, /Changed surfaces: No observed changed-path evidence is persisted for recorded runs\./u);
  assert.match(status, /Planned scope for contracts with recorded runs:/u);
  assert.match(status, /Proof collected: 1 contract run record\(s\): 1 success\./u);
  assert.match(status, /Recovery \/ undo notes: Persisted guidance:/u);
});

test("build session status reports exact observed changed paths when complete capture exists", () => {
  const buildSession = createSampleBuildSession();
  const firstContract = buildSession.lifecycle.executionProgram.contracts[0];
  buildSession.approval.approved = true;
  buildSession.approval.approvedAt = new Date().toISOString();
  buildSession.execution.status = "success";
  buildSession.execution.programId = buildSession.lifecycle.executionProgram.id;
  buildSession.execution.completedContracts = 1;
  buildSession.execution.pendingContracts = 0;

  const status = formatOperatorBuildSessionStatus(buildSession, {
    runJournal: {
      programId: buildSession.lifecycle.executionProgram.id,
      status: "success",
      stopReason: null,
      contractRuns: [
        {
          contractId: firstContract.id,
          status: "success",
          summary: "Executed one scoped contract.",
          evidence: ["run implementer: success"],
          changedSurface: {
            capture: "complete",
            paths: ["src/helpers.js"]
          },
          openQuestions: []
        }
      ],
      completedContractIds: [firstContract.id],
      pendingContractIds: []
    }
  });

  assert.match(status, /Operator Summary/u);
  assert.match(status, /requested outcome: Build an onboarding portal/u);
  assert.match(status, /actual outcome: status: success/u);
  assert.match(status, /unproven claims: No unproven claims are recorded from persisted evidence\./u);
  assert.match(status, /next step: Review evidence and decide whether to run another \/build for the next slice\./u);
  assert.match(status, /Changed surfaces: Observed changed paths are exact for recorded runs: src\/helpers\.js\./u);
  assert.doesNotMatch(status, /Changed-path capture is partial/u);
});

test("blocked run summary distinguishes requested outcome from actual outcome", () => {
  const buildSession = createSampleBuildSession();
  const status = formatOperatorBuildSessionStatus(buildSession, {
    runJournal: {
      programId: buildSession.lifecycle.executionProgram.id,
      status: "blocked",
      stopReason: "waiting for dependency",
      contractRuns: [],
      completedContractIds: [],
      pendingContractIds: buildSession.lifecycle.executionProgram.contracts.map((contract) => contract.id)
    }
  });

  assert.match(status, /requested outcome: Build an onboarding portal/u);
  assert.match(status, /actual outcome: status: blocked; stop reason: waiting for dependency/u);
  assert.doesNotMatch(status, /actual outcome: status: success/u);
});

test("unproven outcomes surface a truthful unproven claims section from typed fields", () => {
  const buildSession = createSampleBuildSession();
  const firstContract = buildSession.lifecycle.executionProgram.contracts[0];
  buildSession.lifecycle.auditReport.evaluationCoverage[0].status = "missing";

  const status = formatOperatorBuildSessionStatus(buildSession, {
    runJournal: {
      programId: buildSession.lifecycle.executionProgram.id,
      status: "success",
      stopReason: null,
      contractRuns: [
        {
          contractId: firstContract.id,
          status: "success",
          summary: "Executed one scoped contract.",
          evidence: ["run reviewer: success"],
          changedSurface: {
            capture: "complete",
            paths: ["src/helpers.js"]
          },
          reviewFindings: [
            {
              kind: "risk",
              severity: "high",
              message: "Regression evidence is incomplete."
            }
          ],
          openQuestions: []
        }
      ],
      completedContractIds: [firstContract.id],
      pendingContractIds: []
    }
  });

  assert.match(status, /unproven claims: .*typed review finding\(s\) are recorded/u);
  assert.match(status, /Audit evaluation coverage marks 1 criterion\/criteria as missing/u);
});

test("summary labels still render when newer typed fields are absent", () => {
  const buildSession = createSampleBuildSession();
  const firstContract = buildSession.lifecycle.executionProgram.contracts[0];
  delete buildSession.lifecycle.auditReport.evaluationCoverage;

  const status = formatOperatorBuildSessionStatus(buildSession, {
    runJournal: {
      programId: buildSession.lifecycle.executionProgram.id,
      status: "success",
      stopReason: null,
      contractRuns: [
        {
          contractId: firstContract.id,
          status: "success",
          summary: "Executed one scoped contract.",
          evidence: ["legacy evidence note"],
          openQuestions: []
        }
      ],
      completedContractIds: [firstContract.id],
      pendingContractIds: []
    }
  });

  assert.match(status, /Operator Summary/u);
  assert.match(status, /requested outcome:/u);
  assert.match(status, /actual outcome: status: success/u);
  assert.match(status, /unproven claims:/u);
  assert.match(status, /next step:/u);
});

test("policy and blocked states stay visible in the summary and guidance", () => {
  const buildSession = createSampleBuildSession();
  const firstContract = buildSession.lifecycle.executionProgram.contracts[0];
  buildSession.execution.status = "blocked";
  buildSession.execution.programId = buildSession.lifecycle.executionProgram.id;
  buildSession.execution.stopReason = "Human gate policy requires explicit approval.";
  buildSession.execution.stopReasonCode = "approval_required";

  const status = formatOperatorBuildSessionStatus(buildSession, {
    runJournal: {
      programId: buildSession.lifecycle.executionProgram.id,
      status: "blocked",
      stopReason: "Human gate policy requires explicit approval.",
      stopReasonCode: "approval_required",
      contractRuns: [
        {
          contractId: firstContract.id,
          status: "blocked",
          summary: "Execution blocked for policy gate.",
          evidence: ["policy gate denied execution"],
          changedSurface: {
            capture: "not_captured",
            paths: []
          },
          policyDecision: {
            profileId: "default",
            status: "approval_required",
            reason: "profile_requires_human_gate"
          },
          openQuestions: []
        }
      ],
      completedContractIds: [],
      pendingContractIds: buildSession.lifecycle.executionProgram.contracts.map((contract) => contract.id)
    }
  });

  assert.match(status, /actual outcome: status: blocked; stop reason code: approval_required/u);
  assert.match(status, /policy decisions: 1 approval_required; non-allowed reasons: profile_requires_human_gate/u);
  assert.match(status, /Approval needed: Yes\. Fresh approval is required before execution can continue\. Use \/build-approve build-abc123\./u);
  assert.match(status, /next step: Approve kickoff with \/build-approve build-abc123\./u);
});

test("build session status reports partial observed changed paths honestly", () => {
  const buildSession = createSampleBuildSession();
  const [firstContract, secondContract] = buildSession.lifecycle.executionProgram.contracts;

  const status = formatOperatorBuildSessionStatus(buildSession, {
    runJournal: {
      programId: buildSession.lifecycle.executionProgram.id,
      status: "blocked",
      stopReason: "waiting for dependency",
      contractRuns: [
        {
          contractId: firstContract.id,
          status: "success",
          summary: "Executed one scoped contract.",
          evidence: ["run implementer: success"],
          changedSurface: {
            capture: "partial",
            paths: ["src/helpers.js"]
          },
          openQuestions: []
        },
        {
          contractId: secondContract.id,
          status: "blocked",
          summary: "Waiting for dependency.",
          evidence: ["run explorer: blocked"],
          changedSurface: {
            capture: "not_captured",
            paths: []
          },
          openQuestions: ["Retry once dependency is available."]
        }
      ],
      completedContractIds: [firstContract.id],
      pendingContractIds: [secondContract.id]
    }
  });

  assert.match(status, /Changed surfaces: Observed changed paths are partial for recorded runs: src\/helpers\.js\./u);
  assert.match(status, /Planned scope for runs without complete changed-path capture:/u);
  assert.match(status, /Unproven claims: .*Changed-path capture is partial;/u);
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
