import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBuildSessionStore } from "../src/build-session-store.js";
import { createOperatorIntake } from "../src/operator-intake.js";
import {
  buildProjectLifecycleArtifacts,
  createExecutionProgramPlanFingerprint,
  deriveExecutionProgramActionClasses
} from "../src/project-workflows.js";

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

async function withTempDir(prefix, callback) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createLifecycleForTests() {
  const lifecycle = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  return {
    proposalSet: lifecycle.proposalSet,
    blueprint: lifecycle.blueprint,
    executionProgram: lifecycle.executionProgram,
    auditReport: lifecycle.auditReport
  };
}

test("build session store creates and loads a persisted build session", async () => {
  await withTempDir("pi-orchestrator-build-session-store-", async (rootDir) => {
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const intake = createOperatorIntake("Build a launch dashboard for product operators");
    const lifecycle = createLifecycleForTests();
    const expectedPlanFingerprint = createExecutionProgramPlanFingerprint(lifecycle.executionProgram);
    const expectedApprovalActionClasses = deriveExecutionProgramActionClasses(lifecycle.executionProgram);

    const created = await buildSessionStore.createBuildSession({
      intake,
      lifecycle,
      approvalRequested: false
    });

    assert.equal(created.artifactType, "build_session");
    assert.equal(created.repositoryRoot, rootDir);
    assert.equal(typeof created.buildId, "string");
    assert.equal(created.programId, lifecycle.executionProgram.id);
    assert.deepEqual(created.sourceArtifactIds, [
      `proposal_set:${lifecycle.proposalSet.id}`,
      `project_blueprint:${lifecycle.blueprint.id}`,
      `execution_program:${lifecycle.executionProgram.id}`,
      `audit_report:${lifecycle.auditReport.id}`
    ]);
    assert.equal(created.lineageDepth, 1);
    assert.equal(created.planFingerprint, expectedPlanFingerprint);
    assert.equal(created.execution.status, "awaiting_approval");
    assert.equal(created.execution.stopReasonCode, null);
    assert.equal(created.execution.validationOutcome, "not_run");
    assert.equal(created.approval.programId, lifecycle.executionProgram.id);
    assert.equal(created.approval.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(created.approval.actionClasses, expectedApprovalActionClasses);
    assert.equal(created.approval.policyProfile, "default");
    assert.deepEqual(created.execution.actionClasses, []);
    assert.equal(created.execution.policyProfile, "default");
    assert.equal(created.execution.validationArtifacts.length, 1);
    assert.equal(created.execution.validationArtifacts[0].status, "not_captured");
    assert.deepEqual(created.execution.reviewability, {
      status: "not_reviewable",
      reasons: ["non_terminal_status"]
    });
    assert.equal(created.execution.programId, null);
    assert.equal(created.execution.completedContracts, 0);
    assert.equal(created.execution.pendingContracts, lifecycle.executionProgram.contracts.length);

    const loaded = await buildSessionStore.loadBuildSession(created.buildId);
    assert.equal(loaded.artifactType, "build_session");
    assert.equal(loaded.repositoryRoot, rootDir);
    assert.equal(loaded.buildId, created.buildId);
    assert.equal(loaded.programId, lifecycle.executionProgram.id);
    assert.deepEqual(loaded.sourceArtifactIds, [
      `proposal_set:${lifecycle.proposalSet.id}`,
      `project_blueprint:${lifecycle.blueprint.id}`,
      `execution_program:${lifecycle.executionProgram.id}`,
      `audit_report:${lifecycle.auditReport.id}`
    ]);
    assert.equal(loaded.execution.status, "awaiting_approval");
    assert.equal(loaded.execution.validationOutcome, "not_run");
    assert.equal(loaded.planFingerprint, expectedPlanFingerprint);
    assert.equal(loaded.approval.programId, lifecycle.executionProgram.id);
    assert.equal(loaded.approval.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(loaded.approval.actionClasses, expectedApprovalActionClasses);
    assert.equal(loaded.approval.policyProfile, "default");
    assert.deepEqual(loaded.execution.actionClasses, []);
    assert.equal(loaded.execution.policyProfile, "default");
    assert.equal(loaded.execution.validationArtifacts.length, 1);
    assert.equal(loaded.execution.validationArtifacts[0].status, "not_captured");
    assert.deepEqual(loaded.execution.reviewability, {
      status: "not_reviewable",
      reasons: ["non_terminal_status"]
    });

    const persistedPath = join(rootDir, ".pi", "build-sessions", `${encodeURIComponent(created.buildId)}.json`);
    const persisted = JSON.parse(await readFile(persistedPath, "utf8"));
    assert.equal(persisted.artifactType, "build_session");
    assert.equal(persisted.repositoryRoot, rootDir);
    assert.equal(persisted.buildId, created.buildId);
    assert.equal(persisted.programId, lifecycle.executionProgram.id);
    assert.deepEqual(persisted.sourceArtifactIds, [
      `proposal_set:${lifecycle.proposalSet.id}`,
      `project_blueprint:${lifecycle.blueprint.id}`,
      `execution_program:${lifecycle.executionProgram.id}`,
      `audit_report:${lifecycle.auditReport.id}`
    ]);
    assert.equal(persisted.planFingerprint, expectedPlanFingerprint);
    assert.equal(persisted.approval.programId, lifecycle.executionProgram.id);
    assert.equal(persisted.approval.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(persisted.approval.actionClasses, expectedApprovalActionClasses);
    assert.equal(persisted.approval.policyProfile, "default");
    assert.equal(persisted.execution.status, "awaiting_approval");
  });
});

test("build session store rejects symlinked .pi build-session store paths before persistence", {
  skip: process.platform === "win32"
}, async () => {
  const outsideRoot = await mkdtemp(join(tmpdir(), "pi-orchestrator-build-session-store-outside-"));
  try {
    await withTempDir("pi-orchestrator-build-session-store-symlink-", async (rootDir) => {
      await mkdir(join(rootDir, ".pi"), { recursive: true });
      await mkdir(join(outsideRoot, "build-sessions"), { recursive: true });
      await symlink(join(outsideRoot, "build-sessions"), join(rootDir, ".pi", "build-sessions"), "dir");

      const buildSessionStore = createBuildSessionStore({ rootDir });
      await assert.rejects(
        () => buildSessionStore.createBuildSession({
          intake: createOperatorIntake("Build a launch dashboard for product operators"),
          lifecycle: createLifecycleForTests(),
          approvalRequested: false
        }),
        /build session store directory must not contain symlinks/u
      );
    });
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("build session store update can record approval and execution summary", async () => {
  await withTempDir("pi-orchestrator-build-session-store-", async (rootDir) => {
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const intake = createOperatorIntake("Build a launch dashboard for product operators");
    const lifecycle = createLifecycleForTests();
    const expectedPlanFingerprint = createExecutionProgramPlanFingerprint(lifecycle.executionProgram);
    const expectedApprovalActionClasses = deriveExecutionProgramActionClasses(lifecycle.executionProgram);

    const created = await buildSessionStore.createBuildSession({
      intake,
      lifecycle,
      approvalRequested: false
    });

    const updated = await buildSessionStore.updateBuildSession(created.buildId, (existingSession) => ({
      ...existingSession,
      approval: {
        ...existingSession.approval,
        approved: true,
        approvedAt: new Date().toISOString()
      },
      execution: {
        ...existingSession.execution,
        status: "success",
        stopReason: null,
        programId: existingSession.lifecycle.executionProgram.id,
        actionClasses: ["read_repo", "write_allowed"],
        policyProfile: null,
        validationArtifacts: [
          {
            artifactType: "validation_artifact",
            reference: "test-run:node --test --test-isolation=none",
            status: "captured"
          }
        ],
        completedContracts: existingSession.lifecycle.executionProgram.contracts.length,
        pendingContracts: 0,
        updatedAt: new Date().toISOString()
      }
    }));

    assert.equal(updated.approval.approved, true);
    assert.equal(typeof updated.approval.approvedAt, "string");
    assert.equal(updated.approval.programId, lifecycle.executionProgram.id);
    assert.equal(updated.approval.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(updated.approval.actionClasses, expectedApprovalActionClasses);
    assert.equal(updated.approval.policyProfile, "default");
    assert.equal(updated.execution.status, "success");
    assert.equal(updated.execution.stopReasonCode, null);
    assert.equal(updated.execution.validationOutcome, "pass");
    assert.deepEqual(updated.execution.actionClasses, []);
    assert.equal(updated.execution.policyProfile, "default");
    assert.equal(updated.execution.validationArtifacts.length, 1);
    assert.equal(updated.execution.validationArtifacts[0].reference, "test-run:node --test --test-isolation=none");
    assert.deepEqual(updated.execution.reviewability, {
      status: "reviewable",
      reasons: []
    });
    assert.equal(updated.execution.programId, lifecycle.executionProgram.id);
    assert.equal(updated.execution.completedContracts, lifecycle.executionProgram.contracts.length);
    assert.equal(updated.execution.pendingContracts, 0);

    const loaded = await buildSessionStore.loadBuildSession(created.buildId);
    assert.equal(loaded.approval.programId, lifecycle.executionProgram.id);
    assert.equal(loaded.approval.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(loaded.approval.actionClasses, expectedApprovalActionClasses);
    assert.equal(loaded.approval.policyProfile, "default");
    assert.equal(loaded.execution.status, "success");
    assert.equal(loaded.execution.validationOutcome, "pass");
    assert.deepEqual(loaded.execution.actionClasses, []);
    assert.equal(loaded.execution.policyProfile, "default");
    assert.equal(loaded.execution.validationArtifacts.length, 1);
    assert.equal(loaded.execution.validationArtifacts[0].reference, "test-run:node --test --test-isolation=none");
    assert.deepEqual(loaded.execution.reviewability, {
      status: "reviewable",
      reasons: []
    });
    assert.equal(loaded.execution.programId, lifecycle.executionProgram.id);
  });
});

test("build session store serializes overlapping updates so fields are not clobbered", async () => {
  await withTempDir("pi-orchestrator-build-session-store-lock-", async (rootDir) => {
    const buildSessionStore = createBuildSessionStore({
      rootDir,
      buildSessionUpdateLockRetryDelayMs: 5,
      buildSessionUpdateLockTimeoutMs: 2000,
      buildSessionUpdateLockStaleMs: 5000,
      buildSessionUpdateLockHeartbeatIntervalMs: 1000
    });
    const intake = createOperatorIntake("Build a launch dashboard for product operators");
    const lifecycle = createLifecycleForTests();

    const created = await buildSessionStore.createBuildSession({
      intake,
      lifecycle,
      approvalRequested: false
    });

    let firstUpdaterEntered;
    const firstUpdaterStarted = new Promise((resolve) => {
      firstUpdaterEntered = resolve;
    });
    let releaseFirstUpdater;
    const firstUpdaterRelease = new Promise((resolve) => {
      releaseFirstUpdater = resolve;
    });
    let secondUpdaterSawApproval = false;

    const firstUpdate = buildSessionStore.updateBuildSession(created.buildId, async (existingSession) => {
      firstUpdaterEntered();
      await firstUpdaterRelease;
      return {
        ...existingSession,
        approval: {
          ...existingSession.approval,
          approved: true,
          approvedAt: new Date().toISOString()
        }
      };
    });

    await firstUpdaterStarted;

    const secondUpdate = buildSessionStore.updateBuildSession(created.buildId, async (existingSession) => {
      secondUpdaterSawApproval = existingSession.approval.approved;
      return {
        ...existingSession,
        execution: {
          ...existingSession.execution,
          status: "approved",
          updatedAt: new Date().toISOString()
        }
      };
    });

    await wait(25);
    releaseFirstUpdater();
    await Promise.all([firstUpdate, secondUpdate]);

    const loaded = await buildSessionStore.loadBuildSession(created.buildId);
    assert.equal(secondUpdaterSawApproval, true);
    assert.equal(loaded.approval.approved, true);
    assert.equal(loaded.execution.status, "approved");
  });
});

test("build session store normalizes unsupported action classes and uncaptured validation evidence", async () => {
  await withTempDir("pi-orchestrator-build-session-store-", async (rootDir) => {
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const intake = createOperatorIntake("Build a launch dashboard for product operators");
    const lifecycle = createLifecycleForTests();

    const created = await buildSessionStore.createBuildSession({
      intake,
      lifecycle,
      approvalRequested: false
    });

    const updated = await buildSessionStore.updateBuildSession(created.buildId, (existingSession) => ({
      ...existingSession,
      execution: {
        ...existingSession.execution,
        status: "success",
        stopReason: null,
        programId: existingSession.lifecycle.executionProgram.id,
        actionClasses: ["access_secret", "mutate_git_state"],
        validationArtifacts: [
          {
            artifactType: "validation_artifact",
            reference: null,
            status: "captured"
          }
        ],
        completedContracts: existingSession.lifecycle.executionProgram.contracts.length,
        pendingContracts: 0,
        updatedAt: new Date().toISOString()
      }
    }));

    assert.deepEqual(updated.execution.actionClasses, []);
    assert.deepEqual(updated.execution.validationArtifacts, [
      {
        artifactType: "validation_artifact",
        reference: null,
        status: "not_captured",
        validationOutcome: "pass"
      }
    ]);
    assert.deepEqual(updated.execution.reviewability, {
      status: "not_reviewable",
      reasons: ["validation_artifacts_not_captured"]
    });

    const loaded = await buildSessionStore.loadBuildSession(created.buildId);
    assert.deepEqual(loaded.execution.actionClasses, []);
    assert.deepEqual(loaded.execution.validationArtifacts, [
      {
        artifactType: "validation_artifact",
        reference: null,
        status: "not_captured",
        validationOutcome: "pass"
      }
    ]);
    assert.deepEqual(loaded.execution.reviewability, {
      status: "not_reviewable",
      reasons: ["validation_artifacts_not_captured"]
    });
  });
});

test("build session store preserves explicit run-journal-derived reviewability summaries", async () => {
  await withTempDir("pi-orchestrator-build-session-store-", async (rootDir) => {
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const intake = createOperatorIntake("Build a launch dashboard for product operators");
    const lifecycle = createLifecycleForTests();

    const created = await buildSessionStore.createBuildSession({
      intake,
      lifecycle,
      approvalRequested: true
    });

    const updated = await buildSessionStore.updateBuildSession(created.buildId, (existingSession) => ({
      ...existingSession,
      execution: {
        ...existingSession.execution,
        status: "success",
        stopReason: null,
        programId: existingSession.lifecycle.executionProgram.id,
        validationArtifacts: [
          {
            artifactType: "validation_artifact",
            reference: "test-run:node --test --test-isolation=none",
            status: "captured"
          }
        ],
        reviewability: {
          status: "reviewable",
          reasons: []
        },
        completedContracts: existingSession.lifecycle.executionProgram.contracts.length,
        pendingContracts: 0,
        updatedAt: new Date().toISOString()
      }
    }));

    assert.deepEqual(updated.execution.reviewability, {
      status: "reviewable",
      reasons: []
    });

    const loaded = await buildSessionStore.loadBuildSession(created.buildId);
    assert.deepEqual(loaded.execution.reviewability, {
      status: "reviewable",
      reasons: []
    });
  });
});

test("build session store load backfills lineage and evidence defaults for legacy records", async () => {
  await withTempDir("pi-orchestrator-build-session-store-", async (rootDir) => {
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const intake = createOperatorIntake("Build a launch dashboard for product operators");
    const lifecycle = createLifecycleForTests();
    const expectedPlanFingerprint = createExecutionProgramPlanFingerprint(lifecycle.executionProgram);
    const expectedApprovalActionClasses = deriveExecutionProgramActionClasses(lifecycle.executionProgram);
    const buildId = "build-legacy-record";
    const persistedPath = join(rootDir, ".pi", "build-sessions", `${encodeURIComponent(buildId)}.json`);

    await mkdir(join(rootDir, ".pi", "build-sessions"), { recursive: true });
    await writeFile(persistedPath, `${JSON.stringify({
      formatVersion: 1,
      buildId,
      intake,
      lifecycle,
      approval: {
        approved: false,
        approvedAt: null
      },
      execution: {
        status: "awaiting_approval",
        stopReason: null,
        stopReasonCode: null,
        validationOutcome: "not_run",
        programId: null,
        completedContracts: 0,
        pendingContracts: lifecycle.executionProgram.contracts.length,
        updatedAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8");

    const loaded = await buildSessionStore.loadBuildSession(buildId);
    assert.equal(loaded.artifactType, "build_session");
    assert.equal(loaded.repositoryRoot, rootDir);
    assert.equal(loaded.programId, lifecycle.executionProgram.id);
    assert.equal(loaded.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(loaded.sourceArtifactIds, [
      `proposal_set:${lifecycle.proposalSet.id}`,
      `project_blueprint:${lifecycle.blueprint.id}`,
      `execution_program:${lifecycle.executionProgram.id}`,
      `audit_report:${lifecycle.auditReport.id}`
    ]);
    assert.equal(loaded.lineageDepth, 1);
    assert.equal(loaded.approval.programId, lifecycle.executionProgram.id);
    assert.equal(loaded.approval.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(loaded.approval.actionClasses, expectedApprovalActionClasses);
    assert.equal(loaded.approval.policyProfile, "default");
    assert.deepEqual(loaded.execution.actionClasses, []);
    assert.equal(loaded.execution.policyProfile, "default");
    assert.equal(loaded.execution.validationArtifacts.length, 1);
    assert.equal(loaded.execution.validationArtifacts[0].status, "not_captured");
    assert.equal(loaded.execution.validationArtifacts[0].validationOutcome, "not_run");
    assert.deepEqual(loaded.execution.reviewability, {
      status: "not_reviewable",
      reasons: ["non_terminal_status"]
    });
  });
});

test("build session store load rejects present envelope type or version drift", async () => {
  await withTempDir("pi-orchestrator-build-session-store-", async (rootDir) => {
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const intake = createOperatorIntake("Build a launch dashboard for product operators");
    const lifecycle = createLifecycleForTests();
    const buildId = "build-invalid-envelope";
    const persistedPath = join(rootDir, ".pi", "build-sessions", `${encodeURIComponent(buildId)}.json`);

    await mkdir(join(rootDir, ".pi", "build-sessions"), { recursive: true });
    await writeFile(persistedPath, `${JSON.stringify({
      artifactType: "unexpected_build_session",
      formatVersion: 2,
      buildId,
      intake,
      lifecycle,
      approval: {
        approved: false,
        approvedAt: null
      },
      execution: {
        status: "awaiting_approval",
        stopReason: null,
        stopReasonCode: null,
        validationOutcome: "not_run",
        programId: null,
        completedContracts: 0,
        pendingContracts: lifecycle.executionProgram.contracts.length,
        updatedAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8");

    await assert.rejects(
      () => buildSessionStore.loadBuildSession(buildId),
      /buildSession\.artifactType must be build_session|buildSession\.formatVersion must be 1/u
    );
  });
});

test("build session store load returns null when build id is not found", async () => {
  await withTempDir("pi-orchestrator-build-session-store-", async (rootDir) => {
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const missing = await buildSessionStore.loadBuildSession("build-missing-id");
    assert.equal(missing, null);
  });
});
