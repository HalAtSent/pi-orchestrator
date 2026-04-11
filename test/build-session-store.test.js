import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBuildSessionStore } from "../src/build-session-store.js";
import { createOperatorIntake } from "../src/operator-intake.js";
import { buildProjectLifecycleArtifacts } from "../src/project-workflows.js";

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
    assert.equal(created.execution.status, "awaiting_approval");
    assert.equal(created.execution.stopReasonCode, null);
    assert.equal(created.execution.validationOutcome, "not_run");
    assert.deepEqual(created.execution.actionClasses, []);
    assert.equal(created.execution.policyProfile, null);
    assert.equal(created.execution.validationArtifacts.length, 1);
    assert.equal(created.execution.validationArtifacts[0].status, "not_captured");
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
    assert.deepEqual(loaded.execution.actionClasses, []);
    assert.equal(loaded.execution.policyProfile, null);
    assert.equal(loaded.execution.validationArtifacts.length, 1);
    assert.equal(loaded.execution.validationArtifacts[0].status, "not_captured");

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
    assert.equal(persisted.execution.status, "awaiting_approval");
  });
});

test("build session store update can record approval and execution summary", async () => {
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
    assert.equal(updated.execution.status, "success");
    assert.equal(updated.execution.stopReasonCode, null);
    assert.equal(updated.execution.validationOutcome, "pass");
    assert.deepEqual(updated.execution.actionClasses, []);
    assert.equal(updated.execution.policyProfile, null);
    assert.equal(updated.execution.validationArtifacts.length, 1);
    assert.equal(updated.execution.validationArtifacts[0].reference, "test-run:node --test --test-isolation=none");
    assert.equal(updated.execution.programId, lifecycle.executionProgram.id);
    assert.equal(updated.execution.completedContracts, lifecycle.executionProgram.contracts.length);
    assert.equal(updated.execution.pendingContracts, 0);

    const loaded = await buildSessionStore.loadBuildSession(created.buildId);
    assert.equal(loaded.execution.status, "success");
    assert.equal(loaded.execution.validationOutcome, "pass");
    assert.deepEqual(loaded.execution.actionClasses, []);
    assert.equal(loaded.execution.policyProfile, null);
    assert.equal(loaded.execution.validationArtifacts.length, 1);
    assert.equal(loaded.execution.validationArtifacts[0].reference, "test-run:node --test --test-isolation=none");
    assert.equal(loaded.execution.programId, lifecycle.executionProgram.id);
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
  });
});

test("build session store load backfills lineage and evidence defaults for legacy records", async () => {
  await withTempDir("pi-orchestrator-build-session-store-", async (rootDir) => {
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const intake = createOperatorIntake("Build a launch dashboard for product operators");
    const lifecycle = createLifecycleForTests();
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
    assert.deepEqual(loaded.sourceArtifactIds, [
      `proposal_set:${lifecycle.proposalSet.id}`,
      `project_blueprint:${lifecycle.blueprint.id}`,
      `execution_program:${lifecycle.executionProgram.id}`,
      `audit_report:${lifecycle.auditReport.id}`
    ]);
    assert.equal(loaded.lineageDepth, 1);
    assert.deepEqual(loaded.execution.actionClasses, []);
    assert.equal(loaded.execution.policyProfile, null);
    assert.equal(loaded.execution.validationArtifacts.length, 1);
    assert.equal(loaded.execution.validationArtifacts[0].status, "not_captured");
    assert.equal(loaded.execution.validationArtifacts[0].validationOutcome, "not_run");
  });
});

test("build session store load returns null when build id is not found", async () => {
  await withTempDir("pi-orchestrator-build-session-store-", async (rootDir) => {
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const missing = await buildSessionStore.loadBuildSession("build-missing-id");
    assert.equal(missing, null);
  });
});
