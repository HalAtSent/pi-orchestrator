import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createExecutionProgram, createRunJournal } from "./project-contracts.js";

export const RUN_STORE_FORMAT_VERSION = 1;
const DEFAULT_RUN_DIRECTORY = ".pi/runs";

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

function normalizePersistedRunRecord(recordInput, { existingCreatedAt } = {}) {
  assertPlainObject("persistedRun", recordInput);
  assertPlainObject("persistedRun.program", recordInput.program);
  assertPlainObject("persistedRun.runJournal", recordInput.runJournal);

  const nowIso = new Date().toISOString();
  const program = createExecutionProgram(clone(recordInput.program));
  const runJournal = createRunJournal(clone(recordInput.runJournal));
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

  const createdAt = recordInput.createdAt ?? existingCreatedAt ?? nowIso;
  const updatedAt = recordInput.updatedAt ?? nowIso;
  assertIsoTimestamp("persistedRun.createdAt", createdAt);
  assertIsoTimestamp("persistedRun.updatedAt", updatedAt);

  return {
    formatVersion: RUN_STORE_FORMAT_VERSION,
    programId,
    program,
    runJournal,
    completedContractIds: [...runJournal.completedContractIds],
    pendingContractIds: [...runJournal.pendingContractIds],
    lastStatus: runJournal.status,
    stopReason: normalizedStopReason,
    createdAt,
    updatedAt
  };
}

function formatPersistedRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function createRunStore({
  rootDir = process.cwd(),
  runsDirectory = DEFAULT_RUN_DIRECTORY
} = {}) {
  const normalizedRootDir = resolve(rootDir);
  const resolvedRunsDirectory = resolve(normalizedRootDir, runsDirectory);

  async function ensureRunsDirectory() {
    await mkdir(resolvedRunsDirectory, { recursive: true });
  }

  function resolveRunPath(programId) {
    const normalizedProgramId = normalizeProgramId(programId);
    return join(resolvedRunsDirectory, `${encodeURIComponent(normalizedProgramId)}.json`);
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
    runsDirectory: resolvedRunsDirectory,
    async saveRun(recordInput) {
      const record = normalizePersistedRunRecord(recordInput);
      await writeRecord(record);
      return clone(record);
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

      const record = normalizePersistedRunRecord(parsed);
      assert(record.programId === normalizedProgramId, "Persisted run programId does not match requested programId");
      return record;
    },
    async updateRun(programId, updater) {
      const normalizedProgramId = normalizeProgramId(programId);
      assert(typeof updater === "function", "updateRun(programId, updater) requires an updater function");

      const existing = await this.loadRun(normalizedProgramId);
      const nextValue = await updater(clone(existing));
      assertPlainObject("updateRun result", nextValue);
      const {
        completedContractIds: _ignoredCompletedContractIds,
        pendingContractIds: _ignoredPendingContractIds,
        lastStatus: _ignoredLastStatus,
        stopReason: _ignoredStopReason,
        ...nextRecordInput
      } = nextValue;

      const record = normalizePersistedRunRecord({
        ...nextRecordInput,
        programId: normalizedProgramId,
        updatedAt: new Date().toISOString()
      }, {
        existingCreatedAt: existing?.createdAt
      });
      await writeRecord(record);
      return clone(record);
    }
  };
}
