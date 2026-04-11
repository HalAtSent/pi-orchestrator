import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createAuditReport,
  createExecutionProgram,
  createProjectBlueprint,
  createProposalSet
} from "./project-contracts.js";
import {
  normalizeActionClasses,
  normalizeLineageDepth,
  normalizePolicyProfile,
  normalizeSourceArtifactIds,
  normalizeStopReasonCode,
  normalizeValidationArtifacts,
  normalizeValidationOutcome,
  toArtifactReference
} from "./run-evidence.js";

export const BUILD_SESSION_STORE_FORMAT_VERSION = 1;
export const BUILD_SESSION_STATUSES = Object.freeze([
  "awaiting_approval",
  "approved",
  "running",
  "success",
  "blocked",
  "failed",
  "repair_required"
]);

const DEFAULT_BUILD_SESSION_DIRECTORY = ".pi/build-sessions";
const BUILD_SESSION_ARTIFACT_TYPE = "build_session";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPlainObject(name, value) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
}

function assertIsoTimestamp(name, value) {
  assert(typeof value === "string" && value.trim().length > 0, `${name} must be a non-empty string`);
  assert(!Number.isNaN(Date.parse(value)), `${name} must be an ISO timestamp`);
}

function clone(value) {
  return structuredClone(value);
}

function normalizeBuildId(buildId) {
  assert(typeof buildId === "string" && buildId.trim().length > 0, "buildId must be a non-empty string");
  return buildId.trim();
}

function normalizeProgramId(programId) {
  assert(typeof programId === "string" && programId.trim().length > 0, "programId must be a non-empty string");
  return programId.trim();
}

function normalizeIntake(intakeInput) {
  assertPlainObject("buildSession.intake", intakeInput);
  assert(
    typeof intakeInput.goal === "string" && intakeInput.goal.trim().length > 0,
    "buildSession.intake.goal must be a non-empty string"
  );

  return clone(intakeInput);
}

function normalizeLifecycle(lifecycleInput) {
  assertPlainObject("buildSession.lifecycle", lifecycleInput);

  return {
    proposalSet: createProposalSet(clone(lifecycleInput.proposalSet)),
    blueprint: createProjectBlueprint(clone(lifecycleInput.blueprint)),
    executionProgram: createExecutionProgram(clone(lifecycleInput.executionProgram)),
    auditReport: createAuditReport(clone(lifecycleInput.auditReport))
  };
}

function normalizeApproval(approvalInput, { defaultApproved = false } = {}) {
  const nowIso = new Date().toISOString();
  const source = approvalInput && typeof approvalInput === "object" && !Array.isArray(approvalInput)
    ? approvalInput
    : {};
  const approved = source.approved ?? defaultApproved;

  assert(typeof approved === "boolean", "buildSession.approval.approved must be a boolean");

  const approvedAt = approved
    ? (source.approvedAt ?? nowIso)
    : null;

  if (approvedAt !== null) {
    assertIsoTimestamp("buildSession.approval.approvedAt", approvedAt);
  }

  return {
    approved,
    approvedAt
  };
}

function normalizeExecutionState(executionInput, {
  defaultStatus,
  defaultPendingContracts = 0,
  defaultProgramId = null,
  defaultActionClasses = [],
  defaultPolicyProfile = null,
  defaultValidationArtifacts = undefined
} = {}) {
  const nowIso = new Date().toISOString();
  const source = executionInput && typeof executionInput === "object" && !Array.isArray(executionInput)
    ? executionInput
    : {};

  const status = source.status ?? defaultStatus;
  assert(
    typeof status === "string" && BUILD_SESSION_STATUSES.includes(status),
    `buildSession.execution.status must be one of: ${BUILD_SESSION_STATUSES.join(", ")}`
  );

  const stopReason = source.stopReason === undefined || source.stopReason === null
    ? null
    : String(source.stopReason).trim();

  assert(
    stopReason === null || stopReason.length > 0,
    "buildSession.execution.stopReason must be null or a non-empty string"
  );

  const programId = source.programId === undefined || source.programId === null
    ? defaultProgramId
    : normalizeProgramId(source.programId);

  const stopReasonCode = normalizeStopReasonCode(null, {
    status,
    stopReason
  });

  const validationOutcome = normalizeValidationOutcome(null, {
    status
  });

  const completedContracts = source.completedContracts ?? 0;
  const pendingContracts = source.pendingContracts ?? defaultPendingContracts;

  assert(
    Number.isInteger(completedContracts) && completedContracts >= 0,
    "buildSession.execution.completedContracts must be an integer >= 0"
  );
  assert(
    Number.isInteger(pendingContracts) && pendingContracts >= 0,
    "buildSession.execution.pendingContracts must be an integer >= 0"
  );

  const updatedAt = source.updatedAt ?? nowIso;
  assertIsoTimestamp("buildSession.execution.updatedAt", updatedAt);

  const actionClasses = normalizeActionClasses(source.actionClasses ?? defaultActionClasses, {
    stopReasonCode
  });
  const policyProfile = normalizePolicyProfile(source.policyProfile ?? defaultPolicyProfile);
  const validationArtifacts = normalizeValidationArtifacts(
    source.validationArtifacts ?? defaultValidationArtifacts,
    { validationOutcome }
  );

  return {
    status,
    stopReason,
    stopReasonCode,
    validationOutcome,
    actionClasses,
    policyProfile,
    validationArtifacts,
    programId,
    completedContracts,
    pendingContracts,
    updatedAt
  };
}

function normalizePersistedBuildSessionRecord(recordInput, { existingCreatedAt, repositoryRoot } = {}) {
  assertPlainObject("buildSession", recordInput);
  assert(
    typeof repositoryRoot === "string" && repositoryRoot.trim().length > 0,
    "repositoryRoot must be a non-empty string"
  );

  const nowIso = new Date().toISOString();
  const buildId = normalizeBuildId(recordInput.buildId);
  const intake = normalizeIntake(recordInput.intake);
  const lifecycle = normalizeLifecycle(recordInput.lifecycle);
  const approval = normalizeApproval(recordInput.approval, {
    defaultApproved: false
  });
  const execution = normalizeExecutionState(recordInput.execution, {
    defaultStatus: approval.approved ? "approved" : "awaiting_approval",
    defaultPendingContracts: lifecycle.executionProgram.contracts.length,
    defaultProgramId: null,
    defaultActionClasses: [],
    defaultPolicyProfile: null
  });

  if (execution.programId !== null) {
    assert(
      execution.programId === lifecycle.executionProgram.id,
      "buildSession.execution.programId must match buildSession.lifecycle.executionProgram.id"
    );
  }

  const sourceArtifactIds = normalizeSourceArtifactIds(recordInput.sourceArtifactIds, {
    fallback: [
      toArtifactReference("proposal_set", lifecycle.proposalSet.id),
      toArtifactReference("project_blueprint", lifecycle.blueprint.id),
      toArtifactReference("execution_program", lifecycle.executionProgram.id),
      toArtifactReference("audit_report", lifecycle.auditReport.id)
    ].filter(Boolean)
  });
  const lineageDepth = normalizeLineageDepth(recordInput.lineageDepth, {
    fallback: 1
  });
  const artifactType = typeof recordInput.artifactType === "string" && recordInput.artifactType.trim().length > 0
    ? recordInput.artifactType.trim()
    : BUILD_SESSION_ARTIFACT_TYPE;
  const normalizedRepositoryRoot = typeof recordInput.repositoryRoot === "string" && recordInput.repositoryRoot.trim().length > 0
    ? recordInput.repositoryRoot.trim()
    : repositoryRoot;
  const programId = execution.programId ?? lifecycle.executionProgram.id;

  const createdAt = recordInput.createdAt ?? existingCreatedAt ?? nowIso;
  const updatedAt = recordInput.updatedAt ?? nowIso;
  assertIsoTimestamp("buildSession.createdAt", createdAt);
  assertIsoTimestamp("buildSession.updatedAt", updatedAt);

  return {
    artifactType,
    formatVersion: BUILD_SESSION_STORE_FORMAT_VERSION,
    repositoryRoot: normalizedRepositoryRoot,
    buildId,
    programId,
    sourceArtifactIds,
    lineageDepth,
    intake,
    lifecycle,
    approval,
    execution,
    createdAt,
    updatedAt
  };
}

function formatPersistedRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function createBuildSessionId() {
  return `build-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createBuildSessionStore({
  rootDir = process.cwd(),
  buildSessionsDirectory = DEFAULT_BUILD_SESSION_DIRECTORY
} = {}) {
  const normalizedRootDir = resolve(rootDir);
  const resolvedBuildSessionsDirectory = resolve(normalizedRootDir, buildSessionsDirectory);

  async function ensureBuildSessionsDirectory() {
    await mkdir(resolvedBuildSessionsDirectory, { recursive: true });
  }

  function resolveBuildSessionPath(buildId) {
    const normalizedBuildId = normalizeBuildId(buildId);
    return join(resolvedBuildSessionsDirectory, `${encodeURIComponent(normalizedBuildId)}.json`);
  }

  async function writeRecord(record) {
    const recordPath = resolveBuildSessionPath(record.buildId);
    const tempPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
    await ensureBuildSessionsDirectory();
    await writeFile(tempPath, formatPersistedRecord(record), "utf8");
    await rename(tempPath, recordPath);
  }

  return {
    rootDir: normalizedRootDir,
    buildSessionsDirectory: resolvedBuildSessionsDirectory,
    async createBuildSession({ intake, lifecycle, approvalRequested = false } = {}) {
      const approved = Boolean(approvalRequested);
      const buildId = createBuildSessionId();

      return this.saveBuildSession({
        buildId,
        intake,
        lifecycle,
        approval: {
          approved,
          approvedAt: approved ? new Date().toISOString() : null
        },
        execution: {
          status: approved ? "approved" : "awaiting_approval",
          stopReason: null,
          programId: null,
          completedContracts: 0,
          pendingContracts: Array.isArray(lifecycle?.executionProgram?.contracts)
            ? lifecycle.executionProgram.contracts.length
            : 0,
          updatedAt: new Date().toISOString()
        }
      });
    },
    async saveBuildSession(recordInput) {
      assertPlainObject("buildSession", recordInput);
      const normalizedBuildId = normalizeBuildId(recordInput.buildId);
      const nextValue = clone(recordInput);
      return this.updateBuildSession(normalizedBuildId, () => nextValue);
    },
    async loadBuildSession(buildId) {
      const normalizedBuildId = normalizeBuildId(buildId);
      const buildSessionPath = resolveBuildSessionPath(normalizedBuildId);

      let raw;
      try {
        raw = await readFile(buildSessionPath, "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") {
          return null;
        }

        throw error;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Persisted build session file is not valid JSON (${buildSessionPath}): ${error.message}`);
      }

      const record = normalizePersistedBuildSessionRecord(parsed, {
        repositoryRoot: normalizedRootDir
      });
      assert(record.buildId === normalizedBuildId, "Persisted build session id does not match requested build id");
      return record;
    },
    async updateBuildSession(buildId, updater) {
      const normalizedBuildId = normalizeBuildId(buildId);
      assert(typeof updater === "function", "updateBuildSession(buildId, updater) requires an updater function");

      const existing = await this.loadBuildSession(normalizedBuildId);
      const nextValue = await updater(clone(existing));
      assertPlainObject("updateBuildSession result", nextValue);

      const {
        formatVersion: _ignoredFormatVersion,
        artifactType: _ignoredArtifactType,
        repositoryRoot: _ignoredRepositoryRoot,
        programId: _ignoredProgramId,
        sourceArtifactIds: _ignoredSourceArtifactIds,
        lineageDepth: _ignoredLineageDepth,
        ...nextRecordInput
      } = nextValue;

      const record = normalizePersistedBuildSessionRecord({
        ...nextRecordInput,
        buildId: normalizedBuildId,
        updatedAt: new Date().toISOString()
      }, {
        existingCreatedAt: existing?.createdAt,
        repositoryRoot: normalizedRootDir
      });

      await writeRecord(record);
      return clone(record);
    }
  };
}
