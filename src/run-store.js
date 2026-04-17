import { mkdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createExecutionProgram, createRunJournal } from "./project-contracts.js";
import {
  normalizeActionClasses,
  normalizeLineageDepth,
  normalizePolicyProfile,
  normalizeReviewability,
  normalizeSourceArtifactIds,
  normalizeValidationArtifacts,
  toArtifactReference
} from "./run-evidence.js";
import {
  assertRedactionMetadataMatchesCoveredStrings,
  createBoundaryPathRedactor,
  mergeRedactionMetadata,
} from "./redaction.js";

export const RUN_STORE_FORMAT_VERSION = 1;
const DEFAULT_RUN_DIRECTORY = ".pi/runs";
const RUN_UPDATE_LOCK_RETRY_DELAY_MS = 25;
const RUN_UPDATE_LOCK_TIMEOUT_MS = 5000;
const RUN_UPDATE_LOCK_STALE_MS = 30000;
const RUN_UPDATE_LOCK_HEARTBEAT_INTERVAL_MS = Math.floor(RUN_UPDATE_LOCK_STALE_MS / 3);
const PERSISTED_RUN_RECORD_ARTIFACT_TYPE = "persisted_run_record";
const RUN_JOURNAL_ARTIFACT_TYPE = "run_journal";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function clone(value) {
  return structuredClone(value);
}

function normalizeProgramId(programId) {
  assert(typeof programId === "string" && programId.trim().length > 0, "programId must be a non-empty string");
  return programId.trim();
}

function assertPlainObject(name, value) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
}

function assertIsoTimestamp(name, value) {
  assert(typeof value === "string" && value.trim().length > 0, `${name} must be a non-empty string`);
  assert(!Number.isNaN(Date.parse(value)), `${name} must be an ISO timestamp`);
}

function normalizeExactArtifactType(name, value, expected) {
  if (value === undefined || value === null) {
    return expected;
  }

  assert(typeof value === "string" && value.trim().length > 0, `${name} must be a non-empty string`);
  const normalized = value.trim();
  assert(normalized === expected, `${name} must be ${expected}`);
  return expected;
}

function normalizeFormatVersion(name, value, expected) {
  if (value === undefined || value === null) {
    return expected;
  }

  assert(Number.isInteger(value), `${name} must be an integer`);
  assert(value === expected, `${name} must be ${expected}`);
  return expected;
}

function stringArraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function redactRunJournalContractRuns(runJournal, { repositoryRoot }) {
  const redactor = createBoundaryPathRedactor({
    repositoryRoot
  });

  return {
    ...runJournal,
    contractRuns: runJournal.contractRuns.map((entry, index) => {
      const summary = redactor.redactString(entry.summary, {
        fieldName: `runJournal.contractRuns[${index}].summary`
      });
      const evidence = redactor.redactStringArray(entry.evidence, {
        fieldName: `runJournal.contractRuns[${index}].evidence`
      });
      const openQuestions = redactor.redactStringArray(entry.openQuestions, {
        fieldName: `runJournal.contractRuns[${index}].openQuestions`
      });
      const boundaryRedaction = mergeRedactionMetadata(
        summary.redaction,
        evidence.redaction,
        openQuestions.redaction
      );
      if (Object.prototype.hasOwnProperty.call(entry, "redaction")) {
        assertRedactionMetadataMatchesCoveredStrings(entry.redaction, {
          redactor,
          fieldName: `runJournal.contractRuns[${index}].redaction`,
          stringFields: [
            {
              fieldName: `runJournal.contractRuns[${index}].summary`,
              value: entry.summary
            }
          ],
          stringArrayFields: [
            {
              fieldName: `runJournal.contractRuns[${index}].evidence`,
              value: entry.evidence
            },
            {
              fieldName: `runJournal.contractRuns[${index}].openQuestions`,
              value: entry.openQuestions
            }
          ]
        });
      }

      return {
        ...entry,
        summary: summary.value,
        evidence: evidence.values,
        openQuestions: openQuestions.values,
        redaction: boundaryRedaction
      };
    })
  };
}

function normalizePersistedRunRecord(recordInput, { existingCreatedAt, repositoryRoot } = {}) {
  assertPlainObject("persistedRun", recordInput);
  assertPlainObject("persistedRun.program", recordInput.program);
  assertPlainObject("persistedRun.runJournal", recordInput.runJournal);
  assert(
    typeof repositoryRoot === "string" && repositoryRoot.trim().length > 0,
    "repositoryRoot must be a non-empty string"
  );

  const nowIso = new Date().toISOString();
  const program = createExecutionProgram(clone(recordInput.program));
  const runJournal = createRunJournal(redactRunJournalContractRuns(
    createRunJournal(clone(recordInput.runJournal)),
    { repositoryRoot }
  ));
  const programId = normalizeProgramId(recordInput.programId ?? program.id);

  assert(program.id === programId, "persistedRun.program.id must match persistedRun.programId");
  assert(runJournal.programId === programId, "persistedRun.runJournal.programId must match persistedRun.programId");

  if (recordInput.completedContractIds !== undefined) {
    assert(Array.isArray(recordInput.completedContractIds), "persistedRun.completedContractIds must be an array");
    assert(
      stringArraysEqual(recordInput.completedContractIds, runJournal.completedContractIds),
      "persistedRun.completedContractIds must match runJournal.completedContractIds"
    );
  }

  if (recordInput.pendingContractIds !== undefined) {
    assert(Array.isArray(recordInput.pendingContractIds), "persistedRun.pendingContractIds must be an array");
    assert(
      stringArraysEqual(recordInput.pendingContractIds, runJournal.pendingContractIds),
      "persistedRun.pendingContractIds must match runJournal.pendingContractIds"
    );
  }

  if (recordInput.lastStatus !== undefined) {
    assert(recordInput.lastStatus === runJournal.status, "persistedRun.lastStatus must match runJournal.status");
  }

  const normalizedStopReason = runJournal.stopReason ?? null;
  if (recordInput.stopReason !== undefined) {
    assert(
      (recordInput.stopReason ?? null) === normalizedStopReason,
      "persistedRun.stopReason must match runJournal.stopReason"
    );
  }

  const normalizedStopReasonCode = runJournal.stopReasonCode ?? null;
  if (recordInput.stopReasonCode !== undefined) {
    assert(
      (recordInput.stopReasonCode ?? null) === normalizedStopReasonCode,
      "persistedRun.stopReasonCode must match runJournal.stopReasonCode"
    );
  }

  if (recordInput.validationOutcome !== undefined) {
    assert(
      recordInput.validationOutcome === runJournal.validationOutcome,
      "persistedRun.validationOutcome must match runJournal.validationOutcome"
    );
  }

  const normalizedRunJournalSourceArtifactIds = normalizeSourceArtifactIds(runJournal.sourceArtifactIds, {
    fallback: [toArtifactReference("execution_program", programId)].filter(Boolean)
  });
  const normalizedRunJournalLineageDepth = normalizeLineageDepth(runJournal.lineageDepth, {
    fallback: 1
  });
  const normalizedRunJournalActionClasses = normalizeActionClasses(runJournal.actionClasses, {
    contractRuns: runJournal.contractRuns,
    stopReasonCode: normalizedStopReasonCode
  });
  const normalizedRunJournalPolicyProfile = normalizePolicyProfile(runJournal.policyProfile);
  const normalizedRunJournalValidationArtifacts = normalizeValidationArtifacts(runJournal.validationArtifacts, {
    validationOutcome: runJournal.validationOutcome
  });
  const normalizedRunJournalReviewability = normalizeReviewability(null, {
    status: runJournal.status,
    stopReason: normalizedStopReason,
    stopReasonCode: normalizedStopReasonCode,
    validationArtifacts: normalizedRunJournalValidationArtifacts,
    contractRuns: runJournal.contractRuns
  });
  if (runJournal.reviewability !== undefined && runJournal.reviewability !== null) {
    normalizeReviewability(runJournal.reviewability, {
      status: runJournal.status,
      stopReason: normalizedStopReason,
      stopReasonCode: normalizedStopReasonCode,
      validationArtifacts: normalizedRunJournalValidationArtifacts,
      contractRuns: runJournal.contractRuns
    });
  }
  const normalizedRunJournalArtifactType = normalizeExactArtifactType(
    "persistedRun.runJournal.artifactType",
    runJournal.artifactType,
    RUN_JOURNAL_ARTIFACT_TYPE
  );

  const normalizedRunJournal = {
    ...runJournal,
    artifactType: normalizedRunJournalArtifactType,
    sourceArtifactIds: normalizedRunJournalSourceArtifactIds,
    lineageDepth: normalizedRunJournalLineageDepth,
    actionClasses: normalizedRunJournalActionClasses,
    policyProfile: normalizedRunJournalPolicyProfile,
    validationArtifacts: normalizedRunJournalValidationArtifacts,
    reviewability: normalizedRunJournalReviewability
  };

  const defaultSourceArtifactIds = [
    toArtifactReference("execution_program", programId),
    toArtifactReference("run_journal", programId)
  ].filter(Boolean);
  const sourceArtifactIds = normalizeSourceArtifactIds(recordInput.sourceArtifactIds, {
    fallback: defaultSourceArtifactIds
  });
  const lineageDepth = normalizeLineageDepth(recordInput.lineageDepth, {
    fallback: normalizedRunJournalLineageDepth + 1
  });
  const actionClasses = normalizeActionClasses(recordInput.actionClasses, {
    contractRuns: normalizedRunJournal.contractRuns,
    stopReasonCode: normalizedStopReasonCode
  });
  const policyProfile = normalizePolicyProfile(recordInput.policyProfile ?? normalizedRunJournalPolicyProfile);
  const validationArtifacts = normalizeValidationArtifacts(
    recordInput.validationArtifacts ?? normalizedRunJournalValidationArtifacts,
    { validationOutcome: runJournal.validationOutcome }
  );
  if (recordInput.reviewability !== undefined && recordInput.reviewability !== null) {
    normalizeReviewability(recordInput.reviewability, {
      status: normalizedRunJournal.status,
      stopReason: normalizedStopReason,
      stopReasonCode: normalizedStopReasonCode,
      validationArtifacts: normalizedRunJournalValidationArtifacts,
      contractRuns: normalizedRunJournal.contractRuns
    });
  }
  const normalizedRepositoryRoot = typeof recordInput.repositoryRoot === "string" && recordInput.repositoryRoot.trim().length > 0
    ? recordInput.repositoryRoot.trim()
    : repositoryRoot;
  const artifactType = normalizeExactArtifactType(
    "persistedRun.artifactType",
    recordInput.artifactType,
    PERSISTED_RUN_RECORD_ARTIFACT_TYPE
  );
  const formatVersion = normalizeFormatVersion(
    "persistedRun.formatVersion",
    recordInput.formatVersion,
    RUN_STORE_FORMAT_VERSION
  );

  const createdAt = recordInput.createdAt ?? existingCreatedAt ?? nowIso;
  const updatedAt = recordInput.updatedAt ?? nowIso;
  assertIsoTimestamp("persistedRun.createdAt", createdAt);
  assertIsoTimestamp("persistedRun.updatedAt", updatedAt);

  return {
    artifactType,
    formatVersion,
    repositoryRoot: normalizedRepositoryRoot,
    programId,
    sourceArtifactIds,
    lineageDepth,
    program,
    runJournal: normalizedRunJournal,
    completedContractIds: [...normalizedRunJournal.completedContractIds],
    pendingContractIds: [...normalizedRunJournal.pendingContractIds],
    lastStatus: normalizedRunJournal.status,
    stopReason: normalizedStopReason,
    stopReasonCode: normalizedStopReasonCode,
    validationOutcome: runJournal.validationOutcome,
    actionClasses,
    policyProfile,
    validationArtifacts,
    reviewability: normalizedRunJournalReviewability,
    createdAt,
    updatedAt
  };
}

function formatPersistedRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function wait(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function parseRunUpdateLockPayload(rawLockPayload) {
  try {
    const parsed = JSON.parse(rawLockPayload);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const lockId = typeof parsed.lockId === "string" && parsed.lockId.trim().length > 0
      ? parsed.lockId.trim()
      : null;
    if (!lockId) {
      return null;
    }

    return {
      ...parsed,
      lockId
    };
  } catch {
    return null;
  }
}

export function createRunStore({
  rootDir = process.cwd(),
  runsDirectory = DEFAULT_RUN_DIRECTORY,
  runUpdateLockRetryDelayMs = RUN_UPDATE_LOCK_RETRY_DELAY_MS,
  runUpdateLockTimeoutMs = RUN_UPDATE_LOCK_TIMEOUT_MS,
  runUpdateLockStaleMs = RUN_UPDATE_LOCK_STALE_MS,
  runUpdateLockHeartbeatIntervalMs = RUN_UPDATE_LOCK_HEARTBEAT_INTERVAL_MS,
  onStaleLockObserved = null
} = {}) {
  const normalizedRootDir = resolve(rootDir);
  const resolvedRunsDirectory = resolve(normalizedRootDir, runsDirectory);
  const lockRetryDelayMs = runUpdateLockRetryDelayMs;
  const lockTimeoutMs = runUpdateLockTimeoutMs;
  const lockStaleMs = runUpdateLockStaleMs;
  const lockHeartbeatIntervalMs = runUpdateLockHeartbeatIntervalMs;

  assert(Number.isFinite(lockRetryDelayMs) && lockRetryDelayMs > 0, "runUpdateLockRetryDelayMs must be > 0");
  assert(Number.isFinite(lockTimeoutMs) && lockTimeoutMs > 0, "runUpdateLockTimeoutMs must be > 0");
  assert(Number.isFinite(lockStaleMs) && lockStaleMs > 0, "runUpdateLockStaleMs must be > 0");
  assert(
    Number.isFinite(lockHeartbeatIntervalMs) && lockHeartbeatIntervalMs > 0,
    "runUpdateLockHeartbeatIntervalMs must be > 0"
  );
  assert(
    lockHeartbeatIntervalMs < lockStaleMs,
    "runUpdateLockHeartbeatIntervalMs must be less than runUpdateLockStaleMs"
  );
  assert(
    onStaleLockObserved === null || typeof onStaleLockObserved === "function",
    "onStaleLockObserved must be a function when provided"
  );

  async function ensureRunsDirectory() {
    await mkdir(resolvedRunsDirectory, { recursive: true });
  }

  function resolveRunPath(programId) {
    const normalizedProgramId = normalizeProgramId(programId);
    return join(resolvedRunsDirectory, `${encodeURIComponent(normalizedProgramId)}.json`);
  }

  function resolveRunLockPath(programId) {
    return `${resolveRunPath(programId)}.lock`;
  }

  async function acquireRunUpdateLock(programId) {
    const normalizedProgramId = normalizeProgramId(programId);
    const lockPath = resolveRunLockPath(normalizedProgramId);
    const startedAt = Date.now();
    await ensureRunsDirectory();

    while (true) {
      const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const lockPayload = `${JSON.stringify({ pid: process.pid, lockId, acquiredAt: new Date().toISOString() })}\n`;
      try {
        await writeFile(lockPath, lockPayload, {
          encoding: "utf8",
          flag: "wx"
        });
        const heartbeatTimer = setInterval(() => {
          const now = new Date();
          void utimes(lockPath, now, now).catch((heartbeatError) => {
            if (heartbeatError && heartbeatError.code === "ENOENT") {
              return;
            }
          });
        }, lockHeartbeatIntervalMs);
        if (typeof heartbeatTimer.unref === "function") {
          heartbeatTimer.unref();
        }
        let released = false;
        return async () => {
          if (released) {
            return;
          }
          released = true;
          clearInterval(heartbeatTimer);
          try {
            const rawLock = await readFile(lockPath, "utf8");
            const parsedLock = parseRunUpdateLockPayload(rawLock);
            if (!parsedLock || parsedLock.lockId !== lockId) {
              return;
            }
            await unlink(lockPath);
          } catch (error) {
            if (error && error.code === "ENOENT") {
              return;
            }
            throw error;
          }
        };
      } catch (error) {
        if (!error || error.code !== "EEXIST") {
          throw error;
        }
      }

      let staleLockRemoved = false;
      try {
        const lockStats = await stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > lockStaleMs) {
          let observedStaleLockId = null;
          try {
            const observedRawLock = await readFile(lockPath, "utf8");
            observedStaleLockId = parseRunUpdateLockPayload(observedRawLock)?.lockId ?? null;
          } catch (error) {
            if (error && error.code === "ENOENT") {
              staleLockRemoved = true;
            } else {
              throw error;
            }
          }

          if (!staleLockRemoved && observedStaleLockId) {
            if (typeof onStaleLockObserved === "function") {
              await onStaleLockObserved({
                lockPath,
                lockId: observedStaleLockId
              });
            }

            try {
              const currentRawLock = await readFile(lockPath, "utf8");
              const currentLockId = parseRunUpdateLockPayload(currentRawLock)?.lockId ?? null;
              if (currentLockId === observedStaleLockId) {
                await unlink(lockPath);
                staleLockRemoved = true;
              }
            } catch (error) {
              if (error && error.code === "ENOENT") {
                staleLockRemoved = true;
              } else {
                throw error;
              }
            }
          }
        }
      } catch (error) {
        if (error && error.code === "ENOENT") {
          staleLockRemoved = true;
        } else {
          throw error;
        }
      }

      if (staleLockRemoved) {
        continue;
      }

      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error(`Timed out acquiring run update lock for programId: ${normalizedProgramId}`);
      }

      await wait(lockRetryDelayMs);
    }
  }

  async function writeRecord(record) {
    const runPath = resolveRunPath(record.programId);
    const tempPath = `${runPath}.${process.pid}.${Date.now()}.tmp`;
    await ensureRunsDirectory();
    await writeFile(tempPath, formatPersistedRecord(record), "utf8");
    await rename(tempPath, runPath);
  }

  return {
    rootDir: normalizedRootDir,
    repositoryRoot: normalizedRootDir,
    getRepositoryRoot() {
      return normalizedRootDir;
    },
    runsDirectory: resolvedRunsDirectory,
    async saveRun(recordInput) {
      assertPlainObject("persistedRun", recordInput);
      const normalizedProgramId = normalizeProgramId(recordInput.programId ?? recordInput.program?.id);
      const nextValue = clone(recordInput);
      return this.updateRun(normalizedProgramId, () => nextValue);
    },
    async loadRun(programId) {
      const normalizedProgramId = normalizeProgramId(programId);
      const runPath = resolveRunPath(normalizedProgramId);

      let raw;
      try {
        raw = await readFile(runPath, "utf8");
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
        throw new Error(`Persisted run file is not valid JSON (${runPath}): ${error.message}`);
      }

      const record = normalizePersistedRunRecord(parsed, {
        repositoryRoot: normalizedRootDir
      });
      assert(record.programId === normalizedProgramId, "Persisted run programId does not match requested programId");
      return record;
    },
    async updateRun(programId, updater) {
      const normalizedProgramId = normalizeProgramId(programId);
      assert(typeof updater === "function", "updateRun(programId, updater) requires an updater function");
      const releaseLock = await acquireRunUpdateLock(normalizedProgramId);
      try {
        const existing = await this.loadRun(normalizedProgramId);
        const nextValue = await updater(clone(existing));
        assertPlainObject("updateRun result", nextValue);
        const {
          completedContractIds: _ignoredCompletedContractIds,
          pendingContractIds: _ignoredPendingContractIds,
          lastStatus: _ignoredLastStatus,
          stopReason: _ignoredStopReason,
          stopReasonCode: _ignoredStopReasonCode,
          validationOutcome: _ignoredValidationOutcome,
          reviewability: _ignoredReviewability,
          artifactType: _ignoredArtifactType,
          repositoryRoot: _ignoredRepositoryRoot,
          sourceArtifactIds: _ignoredSourceArtifactIds,
          lineageDepth: _ignoredLineageDepth,
          actionClasses: _ignoredActionClasses,
          policyProfile: _ignoredPolicyProfile,
          validationArtifacts: _ignoredValidationArtifacts,
          ...nextRecordInput
        } = nextValue;

        const record = normalizePersistedRunRecord({
          ...nextRecordInput,
          programId: normalizedProgramId,
          updatedAt: new Date().toISOString()
        }, {
          existingCreatedAt: existing?.createdAt,
          repositoryRoot: normalizedRootDir
        });
        await writeRecord(record);
        return clone(record);
      } finally {
        await releaseLock();
      }
    }
  };
}
