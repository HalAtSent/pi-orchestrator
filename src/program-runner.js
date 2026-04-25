import {
  createContractExecutionResult,
  createRunJournal,
  validateExecutionProgram
} from "./project-contracts.js";
import { createExecutionProgramPlanFingerprint } from "./project-workflows.js";
import { findProtectedPaths } from "./policies.js";
import {
  normalizeApprovalBinding,
  normalizeReviewability,
  normalizeStopReasonCode,
  normalizeValidationOutcome
} from "./run-evidence.js";
import {
  assertRedactionMetadataMatchesCoveredStrings,
  createBoundaryPathRedactor,
  mergeRedactionMetadata,
} from "./redaction.js";

const TERMINAL_STOP_STATUSES = new Set(["blocked", "failed", "repair_required"]);
// Only journals that still represent in-progress work are resumable.
const RUN_JOURNAL_RESUME_POLICY = Object.freeze({
  running: "resume",
  success: "return_existing",
  blocked: "reject_terminal",
  failed: "reject_terminal",
  repair_required: "reject_terminal"
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function clone(value) {
  return structuredClone(value);
}

function describeError(error) {
  if (error instanceof Error) {
    const message = typeof error.message === "string" ? error.message.trim() : "";
    if (message.length > 0) {
      return `${error.name}: ${message}`;
    }

    return error.name;
  }

  const message = String(error);
  return message.trim().length > 0 ? message : "Unknown error";
}

async function emitProgress(onProgress, event) {
  if (typeof onProgress !== "function") {
    return;
  }

  try {
    await onProgress(clone(event));
  } catch {
    // Progress reporting is observational and must not change execution outcome.
  }
}

function createInvalidExecutorResult(message) {
  return {
    status: "blocked",
    summary: message,
    evidence: [],
    openQuestions: []
  };
}

function redactContractRunEntryForPersistence(contractRunEntry, { redactor }) {
  const summary = redactor.redactString(contractRunEntry.summary, {
    fieldName: "contractRunEntry.summary"
  });
  const evidence = redactor.redactStringArray(contractRunEntry.evidence, {
    fieldName: "contractRunEntry.evidence"
  });
  const openQuestions = redactor.redactStringArray(contractRunEntry.openQuestions, {
    fieldName: "contractRunEntry.openQuestions"
  });
  const reviewFindingMessages = Array.isArray(contractRunEntry.reviewFindings)
    ? contractRunEntry.reviewFindings.map((finding) => finding.message)
    : [];
  const redactedReviewFindingMessages = redactor.redactStringArray(reviewFindingMessages, {
    fieldName: "contractRunEntry.reviewFindings[].message"
  });
  const redactedReviewFindings = Array.isArray(contractRunEntry.reviewFindings)
    ? contractRunEntry.reviewFindings.map((finding, index) => ({
      ...finding,
      message: redactedReviewFindingMessages.values[index]
    }))
    : contractRunEntry.reviewFindings;
  const boundaryRedaction = mergeRedactionMetadata(
    summary.redaction,
    evidence.redaction,
    openQuestions.redaction,
    redactedReviewFindingMessages.redaction
  );
  if (Object.prototype.hasOwnProperty.call(contractRunEntry, "redaction")) {
    assertRedactionMetadataMatchesCoveredStrings(contractRunEntry.redaction, {
      redactor,
      fieldName: "contractRunEntry.redaction",
      stringFields: [
        {
          fieldName: "contractRunEntry.summary",
          value: contractRunEntry.summary
        }
      ],
      stringArrayFields: [
        {
          fieldName: "contractRunEntry.evidence",
          value: contractRunEntry.evidence
        },
        {
          fieldName: "contractRunEntry.openQuestions",
          value: contractRunEntry.openQuestions
        },
        {
          fieldName: "contractRunEntry.reviewFindings[].message",
          value: reviewFindingMessages
        }
      ]
    });
  }

  return {
    ...contractRunEntry,
    summary: summary.value,
    evidence: evidence.values,
    openQuestions: openQuestions.values,
    ...(Array.isArray(redactedReviewFindings) ? { reviewFindings: redactedReviewFindings } : {}),
    redaction: boundaryRedaction
  };
}

function normalizeProgramId(programId) {
  assert(typeof programId === "string" && programId.trim().length > 0, "programId must be a non-empty string");
  return programId.trim();
}

function resolveContractExecutor(contractExecutor) {
  if (typeof contractExecutor === "function") {
    return contractExecutor;
  }

  if (contractExecutor && typeof contractExecutor.runContract === "function") {
    return contractExecutor.runContract.bind(contractExecutor);
  }

  if (contractExecutor && typeof contractExecutor.run === "function") {
    return contractExecutor.run.bind(contractExecutor);
  }

  throw new Error("contractExecutor(contract, context) is required");
}

function resolveRunStore(runStore, { requireLoad = false } = {}) {
  if (runStore === undefined || runStore === null) {
    return null;
  }

  assert(typeof runStore.updateRun === "function", "runStore.updateRun(programId, updater) is required");
  if (requireLoad) {
    assert(typeof runStore.loadRun === "function", "runStore.loadRun(programId) is required");
  }

  return runStore;
}

function isAbsolutePathValue(value) {
  return /^[A-Za-z]:[\\/]/u.test(value)
    || value.startsWith("\\\\")
    || value.startsWith("/");
}

function normalizeKnownRepositoryRoot(candidate) {
  if (typeof candidate !== "string") {
    return null;
  }

  const normalized = candidate.trim();
  if (normalized.length === 0 || !isAbsolutePathValue(normalized)) {
    return null;
  }

  return normalized;
}

function resolvePersistenceRepositoryRoot(runStore) {
  if (!runStore) {
    return process.cwd();
  }

  if (typeof runStore.getRepositoryRoot === "function") {
    try {
      const accessorRoot = normalizeKnownRepositoryRoot(runStore.getRepositoryRoot());
      if (accessorRoot) {
        return accessorRoot;
      }
    } catch {
      // Fall through to other known runStore root fields.
    }
  }

  const directRoot = normalizeKnownRepositoryRoot(runStore.repositoryRoot);
  if (directRoot) {
    return directRoot;
  }

  const rootDir = normalizeKnownRepositoryRoot(runStore.rootDir);
  if (rootDir) {
    return rootDir;
  }

  return process.cwd();
}

function createContractIndex(program) {
  const index = new Map();

  for (const contract of program.contracts) {
    if (index.has(contract.id)) {
      return {
        ok: false,
        reason: `Execution program has duplicate contract id: ${contract.id}`
      };
    }

    index.set(contract.id, contract);
  }

  return {
    ok: true,
    index
  };
}

function validateDependencyReferences(program, index) {
  for (const contract of program.contracts) {
    for (const dependencyId of contract.dependsOn) {
      if (!index.has(dependencyId)) {
        return {
          ok: false,
          reason: `Contract ${contract.id} depends on missing contract id: ${dependencyId}`
        };
      }
    }
  }

  return { ok: true };
}

function findDependencyCycle(program, index) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(contractId) {
    if (visiting.has(contractId)) {
      const cycleStart = stack.indexOf(contractId);
      const cycle = stack.slice(cycleStart).concat(contractId);
      return cycle;
    }

    if (visited.has(contractId)) {
      return null;
    }

    visiting.add(contractId);
    stack.push(contractId);

    const contract = index.get(contractId);
    for (const dependencyId of contract.dependsOn) {
      const cycle = visit(dependencyId);
      if (cycle) {
        return cycle;
      }
    }

    stack.pop();
    visiting.delete(contractId);
    visited.add(contractId);
    return null;
  }

  for (const contract of program.contracts) {
    const cycle = visit(contract.id);
    if (cycle) {
      return cycle;
    }
  }

  return null;
}

function pendingContractIds(program, completedContractIds) {
  const completedSet = new Set(completedContractIds);
  return program.contracts
    .map((contract) => contract.id)
    .filter((contractId) => !completedSet.has(contractId));
}

function createRunJournalSnapshot({
  program,
  status,
  stopReason,
  contractRuns,
  completedContractIds,
  approvalBinding = null
}) {
  const journal = {
    programId: program.id,
    status,
    stopReason,
    stopReasonCode: normalizeStopReasonCode(null, {
      status,
      stopReason
    }),
    validationOutcome: normalizeValidationOutcome(null, {
      status
    }),
    contractRuns,
    completedContractIds,
    pendingContractIds: pendingContractIds(program, completedContractIds)
  };
  if (approvalBinding !== null) {
    journal.approvalBinding = approvalBinding;
  }
  return createRunJournal(journal);
}

function stopProgram({
  program,
  status,
  stopReason,
  contractRuns,
  completedContractIds,
  approvalBinding = null
}) {
  return createRunJournalSnapshot({
    program,
    status,
    stopReason,
    contractRuns,
    completedContractIds,
    approvalBinding
  });
}

function createBlockedRunJournal(programId, stopReason, { approvalBinding = null } = {}) {
  const journal = {
    programId,
    status: "blocked",
    stopReason,
    stopReasonCode: normalizeStopReasonCode(null, {
      status: "blocked",
      stopReason
    }),
    validationOutcome: normalizeValidationOutcome(null, {
      status: "blocked"
    }),
    contractRuns: [],
    completedContractIds: [],
    pendingContractIds: []
  };
  if (approvalBinding !== null) {
    journal.approvalBinding = approvalBinding;
  }
  return createRunJournal(journal);
}

async function persistBlockedJournal(runStore, program, stopReason) {
  const journal = createBlockedRunJournal(program.id, stopReason);
  try {
    await persistJournal(runStore, program, journal);
  } catch {
    // Admission failures must remain blocked even if optional persistence fails.
  }
  return journal;
}

function findProtectedExecutionProgramPaths(program) {
  return findProtectedPaths(program.contracts.flatMap((contract) => (
    Array.isArray(contract.scopePaths) ? contract.scopePaths : []
  )));
}

async function validateApprovedBuildSessionBinding({
  program,
  buildId,
  buildSessionStore
}) {
  const normalizedBuildId = typeof buildId === "string" && buildId.trim().length > 0
    ? buildId.trim()
    : null;
  assert(normalizedBuildId, "buildId is required for approved build-session execution");
  assert(
    buildSessionStore && typeof buildSessionStore.loadBuildSession === "function",
    "buildSessionStore.loadBuildSession(buildId) is required for approved build-session execution"
  );

  const buildSession = await buildSessionStore.loadBuildSession(normalizedBuildId);
  assert(buildSession, `No approved build session found for buildId: ${normalizedBuildId}`);
  assert(buildSession.approval?.approved === true, `Build session ${normalizedBuildId} is not approved`);
  assert(
    buildSession.approval?.programId === program.id,
    `Build session ${normalizedBuildId} approval does not match execution program ${program.id}`
  );

  const programFingerprint = createExecutionProgramPlanFingerprint(program);
  assert(
    buildSession.planFingerprint === programFingerprint,
    `Build session ${normalizedBuildId} plan fingerprint does not match execution program content`
  );
  assert(
    buildSession.approval?.planFingerprint === programFingerprint,
    `Build session ${normalizedBuildId} approval fingerprint does not match execution program content`
  );

  return normalizeApprovalBinding({
    status: "approved",
    source: "build_session",
    buildId: normalizedBuildId
  }, {
    fieldName: "runExecutionProgramFromApprovedBuildSession.approvalBinding",
    allowMissing: false
  });
}

function createTerminalResumeRejectedJournal(program, runJournal) {
  const priorStopReason = runJournal.stopReason
    ? ` Previous stop reason: ${runJournal.stopReason}`
    : "";

  return stopProgram({
    program,
    status: "blocked",
    stopReason: `Persisted run cannot be resumed because status "${runJournal.status}" is terminal.${priorStopReason}`,
    contractRuns: clone(runJournal.contractRuns),
    completedContractIds: [...runJournal.completedContractIds],
    approvalBinding: runJournal.approvalBinding ?? null
  });
}

export function getRunJournalResumePolicy(status) {
  if (typeof status !== "string") {
    return null;
  }

  return RUN_JOURNAL_RESUME_POLICY[status] ?? null;
}

function resolveRunJournalResumePolicy(runJournal) {
  const policy = getRunJournalResumePolicy(runJournal.status);
  assert(policy, `Unexpected run journal status: ${runJournal.status}`);
  return policy;
}

function nextReadyContract(program, pendingContractIdSet, completedContractIdSet) {
  for (const contract of program.contracts) {
    if (!pendingContractIdSet.has(contract.id)) {
      continue;
    }

    const ready = contract.dependsOn.every((dependencyId) => completedContractIdSet.has(dependencyId));
    if (ready) {
      return contract;
    }
  }

  return null;
}

function validateProgramTopology(program) {
  const contractIndexResult = createContractIndex(program);
  if (!contractIndexResult.ok) {
    return contractIndexResult;
  }

  const contractIndex = contractIndexResult.index;
  const dependencyReferenceResult = validateDependencyReferences(program, contractIndex);
  if (!dependencyReferenceResult.ok) {
    return dependencyReferenceResult;
  }

  const cycle = findDependencyCycle(program, contractIndex);
  if (cycle) {
    return {
      ok: false,
      reason: `Execution program dependency cycle detected: ${cycle.join(" -> ")}`
    };
  }

  return { ok: true };
}

function arraysEqual(left, right) {
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

function validateResumeState(program, journal) {
  const contractIds = program.contracts.map((contract) => contract.id);
  const contractIdSet = new Set(contractIds);
  const completedSet = new Set();
  const pendingSet = new Set();

  for (const contractId of journal.completedContractIds) {
    if (!contractIdSet.has(contractId)) {
      return {
        ok: false,
        reason: `Completed contract id is not present in the execution program: ${contractId}`
      };
    }

    if (completedSet.has(contractId)) {
      return {
        ok: false,
        reason: `Completed contract id is duplicated in persisted state: ${contractId}`
      };
    }
    completedSet.add(contractId);
  }

  for (const contractId of journal.pendingContractIds) {
    if (!contractIdSet.has(contractId)) {
      return {
        ok: false,
        reason: `Pending contract id is not present in the execution program: ${contractId}`
      };
    }

    if (pendingSet.has(contractId)) {
      return {
        ok: false,
        reason: `Pending contract id is duplicated in persisted state: ${contractId}`
      };
    }

    if (completedSet.has(contractId)) {
      return {
        ok: false,
        reason: `Contract id appears in both completed and pending sets: ${contractId}`
      };
    }

    pendingSet.add(contractId);
  }

  const expectedPending = pendingContractIds(program, journal.completedContractIds);
  if (!arraysEqual(expectedPending, journal.pendingContractIds)) {
    return {
      ok: false,
      reason: "Pending contract ids do not match the execution program ordering and completed state."
    };
  }

  const successContractIds = new Set();
  for (const entry of journal.contractRuns) {
    if (!contractIdSet.has(entry.contractId)) {
      return {
        ok: false,
        reason: `Run journal includes unknown contract id: ${entry.contractId}`
      };
    }

    if (entry.status === "success") {
      successContractIds.add(entry.contractId);
    }
  }

  for (const contractId of successContractIds) {
    if (!completedSet.has(contractId)) {
      return {
        ok: false,
        reason: `A successful contract run is missing from completedContractIds: ${contractId}`
      };
    }
  }

  for (const contractId of completedSet) {
    if (!successContractIds.has(contractId)) {
      return {
        ok: false,
        reason: `A completed contract is missing a successful run record: ${contractId}`
      };
    }
  }

  if (journal.status === "success" && journal.pendingContractIds.length > 0) {
    return {
      ok: false,
      reason: "A successful run journal must not contain pending contracts."
    };
  }

  if (journal.status === "running" && journal.stopReason !== null && journal.stopReason !== undefined) {
    return {
      ok: false,
      reason: "A running run journal must not include a stop reason."
    };
  }

  return { ok: true };
}

function createPersistenceFailureJournal({
  program,
  contractRuns,
  completedContractIds,
  error,
  approvalBinding = null
}) {
  const message = error instanceof Error ? error.message : String(error);
  return stopProgram({
    program,
    status: "blocked",
    stopReason: `Run persistence failed: ${message}`,
    contractRuns: clone(contractRuns),
    completedContractIds: [...completedContractIds],
    approvalBinding
  });
}

function stripPersistedRunJournalRedaction(runJournal) {
  return {
    ...runJournal,
    contractRuns: runJournal.contractRuns.map((entry) => {
      if (!Object.prototype.hasOwnProperty.call(entry, "redaction")) {
        return entry;
      }

      const {
        redaction: _ignoredRedaction,
        ...withoutRedaction
      } = entry;
      return withoutRedaction;
    })
  };
}

async function persistJournal(runStore, program, runJournal) {
  if (!runStore) {
    return;
  }

  const persistedRunJournal = stripPersistedRunJournalRedaction(runJournal);
  await runStore.updateRun(program.id, () => ({
    programId: program.id,
    program,
    runJournal: persistedRunJournal
  }));
}

async function runProgramFromState(program, {
  executeContract,
  runStore,
  initialContractRuns = [],
  initialCompletedContractIds = [],
  approvalBinding = null,
  onProgress = null
}) {
  const topologyResult = validateProgramTopology(program);
  if (!topologyResult.ok) {
    return stopProgram({
      program,
      status: "blocked",
      stopReason: topologyResult.reason,
      contractRuns: [],
      completedContractIds: [],
      approvalBinding
    });
  }

  const initialSnapshot = createRunJournalSnapshot({
    program,
    status: "running",
    stopReason: null,
    contractRuns: clone(initialContractRuns),
    completedContractIds: [...initialCompletedContractIds],
    approvalBinding
  });

  const completedContractIdSet = new Set(initialSnapshot.completedContractIds);
  const pendingContractIdSet = new Set(initialSnapshot.pendingContractIds);
  const contractRuns = clone(initialSnapshot.contractRuns);
  const persistenceRepositoryRoot = resolvePersistenceRepositoryRoot(runStore);
  const persistenceBoundaryRedactor = createBoundaryPathRedactor({
    repositoryRoot: persistenceRepositoryRoot
  });

  if (pendingContractIdSet.size === 0) {
    const finishedJournal = stopProgram({
      program,
      status: "success",
      stopReason: null,
      contractRuns,
      completedContractIds: [...completedContractIdSet],
      approvalBinding
    });

    try {
      await persistJournal(runStore, program, finishedJournal);
    } catch (error) {
      return createPersistenceFailureJournal({
        program,
        contractRuns,
        completedContractIds: [...completedContractIdSet],
        error,
        approvalBinding
      });
    }

    return finishedJournal;
  }

  try {
    await persistJournal(runStore, program, initialSnapshot);
  } catch (error) {
    return createPersistenceFailureJournal({
      program,
      contractRuns,
      completedContractIds: [...completedContractIdSet],
      error,
      approvalBinding
    });
  }

  while (pendingContractIdSet.size > 0) {
    const contract = nextReadyContract(program, pendingContractIdSet, completedContractIdSet);
    if (!contract) {
      const blockedJournal = stopProgram({
        program,
        status: "blocked",
        stopReason: "No contracts are ready to run with the current dependency state.",
        contractRuns: clone(contractRuns),
        completedContractIds: [...completedContractIdSet],
        approvalBinding
      });

      try {
        await persistJournal(runStore, program, blockedJournal);
      } catch (error) {
        return createPersistenceFailureJournal({
          program,
          contractRuns,
          completedContractIds: [...completedContractIdSet],
          error,
          approvalBinding
        });
      }

      return blockedJournal;
    }

    await emitProgress(onProgress, {
      type: "contract_start",
      programId: program.id,
      contractId: contract.id,
      completedContractIds: [...completedContractIdSet],
      pendingContractIds: [...pendingContractIdSet]
    });

    let rawResult;
    let executionFailure = null;
    try {
      rawResult = await executeContract(clone(contract), {
        programId: program.id,
        contractId: contract.id,
        currentContractId: contract.id,
        completedContractIds: [...completedContractIdSet],
        pendingContractIds: [...pendingContractIdSet],
        contractRuns: clone(contractRuns)
      });
    } catch (error) {
      const message = describeError(error);
      executionFailure = {
        kind: "threw",
        message
      };
      rawResult = createInvalidExecutorResult(`Contract executor threw: ${message}`);
    }

    let result;
    try {
      result = createContractExecutionResult(rawResult);
    } catch (error) {
      const message = describeError(error);
      executionFailure = {
        kind: "malformed_result",
        message
      };
      result = createContractExecutionResult(
        createInvalidExecutorResult(`Contract executor returned an invalid result: ${message}`)
      );
    }

    pendingContractIdSet.delete(contract.id);
    const contractRunEntry = redactContractRunEntryForPersistence({
      contractId: contract.id,
      status: result.status,
      summary: result.summary,
      evidence: result.evidence,
      ...(Object.prototype.hasOwnProperty.call(result, "policyDecision")
        ? { policyDecision: result.policyDecision }
        : {}),
      ...(Array.isArray(result.commandObservations) && result.commandObservations.length > 0
        ? { commandObservations: result.commandObservations }
        : {}),
      ...(Array.isArray(result.reviewFindings) && result.reviewFindings.length > 0
        ? { reviewFindings: result.reviewFindings }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(result, "scopeOwnership")
        ? { scopeOwnership: result.scopeOwnership }
        : {}),
      providerModelEvidenceRequirement: result.providerModelEvidenceRequirement,
      openQuestions: result.openQuestions,
      changedSurface: result.changedSurface,
      validationOutcome: normalizeValidationOutcome(null, {
        status: result.status
      })
    }, {
      redactor: persistenceBoundaryRedactor
    });
    if (Array.isArray(result.providerModelSelections) && result.providerModelSelections.length > 0) {
      contractRunEntry.providerModelSelections = result.providerModelSelections;
    }
    contractRuns.push(contractRunEntry);

    await emitProgress(onProgress, {
      type: "contract_finish",
      programId: program.id,
      contractId: contract.id,
      status: result.status,
      summary: result.summary,
      completedContractIds: [...completedContractIdSet],
      pendingContractIds: [...pendingContractIdSet]
    });

    if (result.status === "success") {
      completedContractIdSet.add(contract.id);

      const snapshotStatus = pendingContractIdSet.size === 0 ? "success" : "running";
      const snapshot = stopProgram({
        program,
        status: snapshotStatus,
        stopReason: null,
        contractRuns: clone(contractRuns),
        completedContractIds: [...completedContractIdSet],
        approvalBinding
      });

      try {
        await persistJournal(runStore, program, snapshot);
      } catch (error) {
        return createPersistenceFailureJournal({
          program,
          contractRuns,
          completedContractIds: [...completedContractIdSet],
          error,
          approvalBinding
        });
      }

      if (snapshotStatus === "success") {
        return snapshot;
      }

      continue;
    }

    assert(
      TERMINAL_STOP_STATUSES.has(result.status),
      `Unexpected terminal contract result status: ${result.status}`
    );

    const terminalStopReason = executionFailure === null
      ? `Contract ${contract.id} returned ${result.status}: ${result.summary}`
      : executionFailure.kind === "threw"
        ? `Contract ${contract.id} execution threw: ${executionFailure.message}`
        : `Contract ${contract.id} execution returned an invalid result: ${executionFailure.message}`;

    const terminalJournal = stopProgram({
      program,
      status: result.status,
      stopReason: terminalStopReason,
      contractRuns: clone(contractRuns),
      completedContractIds: [...completedContractIdSet],
      approvalBinding
    });

    try {
      await persistJournal(runStore, program, terminalJournal);
    } catch (error) {
      return createPersistenceFailureJournal({
        program,
        contractRuns,
        completedContractIds: [...completedContractIdSet],
        error,
        approvalBinding
      });
    }

    return terminalJournal;
  }

  return stopProgram({
    program,
    status: "success",
    stopReason: null,
    contractRuns: clone(contractRuns),
    completedContractIds: [...completedContractIdSet],
    approvalBinding
  });
}

export async function runExecutionProgram(programInput, {
  contractExecutor,
  runStore,
  onProgress = null
} = {}) {
  const program = validateExecutionProgram(clone(programInput));
  const executeContract = resolveContractExecutor(contractExecutor);
  const resolvedRunStore = resolveRunStore(runStore);
  const protectedPaths = findProtectedExecutionProgramPaths(program);
  if (protectedPaths.length > 0) {
    return persistBlockedJournal(
      resolvedRunStore,
      program,
      `Execution program references protected path(s): ${protectedPaths.join(", ")}`
    );
  }

  return runProgramFromState(program, {
    executeContract,
    runStore: resolvedRunStore,
    // Generic callers must not inject persisted approval lineage directly.
    approvalBinding: null,
    onProgress
  });
}

export async function runExecutionProgramFromApprovedBuildSession(programInput, {
  contractExecutor,
  runStore,
  buildSessionStore = null,
  buildId = null,
  onProgress = null
} = {}) {
  const program = validateExecutionProgram(clone(programInput));
  const executeContract = resolveContractExecutor(contractExecutor);
  const resolvedRunStore = resolveRunStore(runStore);
  const protectedPaths = findProtectedExecutionProgramPaths(program);
  if (protectedPaths.length > 0) {
    return persistBlockedJournal(
      resolvedRunStore,
      program,
      `Execution program references protected path(s): ${protectedPaths.join(", ")}`
    );
  }

  let trustedApprovalBinding;
  try {
    trustedApprovalBinding = await validateApprovedBuildSessionBinding({
      program,
      buildId,
      buildSessionStore
    });
  } catch (error) {
    return persistBlockedJournal(
      resolvedRunStore,
      program,
      `Approved build-session execution rejected: ${error.message}`
    );
  }

  return runProgramFromState(program, {
    executeContract,
    runStore: resolvedRunStore,
    approvalBinding: trustedApprovalBinding,
    onProgress
  });
}

export async function resumeExecutionProgram(programIdInput, {
  contractExecutor,
  runStore,
  onProgress = null
} = {}) {
  const programId = normalizeProgramId(programIdInput);
  const executeContract = resolveContractExecutor(contractExecutor);
  const resolvedRunStore = resolveRunStore(runStore, { requireLoad: true });

  if (!resolvedRunStore) {
    return createBlockedRunJournal(programId, "Run persistence store is not configured.");
  }

  let persistedRun;
  try {
    persistedRun = await resolvedRunStore.loadRun(programId);
  } catch (error) {
    return createBlockedRunJournal(programId, `Failed to load persisted run: ${error.message}`);
  }

  if (!persistedRun) {
    return createBlockedRunJournal(programId, `No persisted run found for program id: ${programId}`);
  }

  let program;
  let runJournal;
  try {
    program = validateExecutionProgram(clone(persistedRun.program));
    runJournal = createRunJournal(clone(persistedRun.runJournal));
  } catch (error) {
    return createBlockedRunJournal(programId, `Persisted run state is invalid: ${error.message}`);
  }

  if (persistedRun.programId !== programId) {
    return createBlockedRunJournal(programId, "Persisted run programId does not match the requested program id.");
  }

  if (program.id !== programId || runJournal.programId !== programId) {
    return createBlockedRunJournal(programId, "Persisted execution program does not match the requested program id.");
  }

  const resumeState = validateResumeState(program, runJournal);
  if (!resumeState.ok) {
    return createBlockedRunJournal(programId, `Persisted run state is inconsistent: ${resumeState.reason}`);
  }

  const resumePolicy = resolveRunJournalResumePolicy(runJournal);
  if (resumePolicy === "return_existing") {
    return runJournal;
  }

  if (resumePolicy === "reject_terminal") {
    return createTerminalResumeRejectedJournal(program, runJournal);
  }

  return runProgramFromState(program, {
    executeContract,
    runStore: resolvedRunStore,
    initialContractRuns: runJournal.contractRuns,
    initialCompletedContractIds: runJournal.completedContractIds,
    approvalBinding: runJournal.approvalBinding ?? null,
    onProgress
  });
}

export function formatProgramRunJournal(journal) {
  const journalStopReasonCode = journal.stopReasonCode ?? normalizeStopReasonCode(null, {
    status: journal.status,
    stopReason: journal.stopReason
  });
  const journalValidationOutcome = journal.validationOutcome ?? normalizeValidationOutcome(null, {
    status: journal.status
  });
  const journalReviewability = normalizeReviewability(journal.reviewability, {
    status: journal.status,
    stopReason: journal.stopReason,
    stopReasonCode: journalStopReasonCode,
    validationArtifacts: journal.validationArtifacts,
    contractRuns: journal.contractRuns
  });
  const journalApprovalBinding = normalizeApprovalBinding(journal.approvalBinding, {
    fieldName: "journal.approvalBinding",
    allowMissing: true
  });
  const lines = [
    `program: ${journal.programId}`,
    `status: ${journal.status}`,
    `stop_reason: ${journal.stopReason ?? "none"}`,
    `stop_reason_code: ${journalStopReasonCode ?? "none"}`,
    `validation_outcome: ${journalValidationOutcome}`,
    `reviewability_status: ${journalReviewability.status}`,
    `reviewability_reasons: ${journalReviewability.reasons.length > 0 ? journalReviewability.reasons.join(", ") : "none"}`,
    `completed: ${journal.completedContractIds.length}`,
    `pending: ${journal.pendingContractIds.length}`,
    "contracts:"
  ];
  if (journalApprovalBinding) {
    lines.splice(lines.length - 1, 0,
      `approval_binding_status: ${journalApprovalBinding.status}`,
      `approval_binding_source: ${journalApprovalBinding.source}`,
      `approval_binding_build_id: ${journalApprovalBinding.buildId ?? "none"}`,
      `approval_binding_approval_id: ${journalApprovalBinding.approvalId ?? "none"}`
    );
  }

  if (journal.contractRuns.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of journal.contractRuns) {
      const entryValidationOutcome = entry.validationOutcome ?? normalizeValidationOutcome(null, {
        status: entry.status
      });
      lines.push(`- ${entry.contractId} (${entry.status}): ${entry.summary}`);
      lines.push(`  validation_outcome: ${entryValidationOutcome}`);
      if (entry.policyDecision) {
        lines.push(`  policy_decision_profile: ${entry.policyDecision.profileId}`);
        lines.push(`  policy_decision_status: ${entry.policyDecision.status}`);
        lines.push(`  policy_decision_reason: ${entry.policyDecision.reason}`);
      }
      if (entry.scopeOwnership) {
        lines.push(`  scope_ownership_status: ${entry.scopeOwnership.status}`);
        lines.push(`  scope_declared_mode: ${entry.scopeOwnership.declaredScope.mode}`);
        lines.push("  scope_declared_paths:");
        if (entry.scopeOwnership.declaredScope.paths.length === 0) {
          lines.push("  - none");
        } else {
          for (const declaredPath of entry.scopeOwnership.declaredScope.paths) {
            lines.push(`  - ${declaredPath}`);
          }
        }
        lines.push("  scope_observed_paths:");
        if (entry.scopeOwnership.observedChanges.paths.length === 0) {
          lines.push("  - none");
        } else {
          for (const observedPath of entry.scopeOwnership.observedChanges.paths) {
            lines.push(`  - ${observedPath}`);
          }
        }
      }
      lines.push(`  changed_surface_capture: ${entry.changedSurface.capture}`);
      if (entry.changedSurface.paths.length > 0) {
        lines.push("  changed_paths:");
        for (const changedPath of entry.changedSurface.paths) {
          lines.push(`  - ${changedPath}`);
        }
      }
      if (Array.isArray(entry.reviewFindings) && entry.reviewFindings.length > 0) {
        lines.push("  review_findings:");
        for (const finding of entry.reviewFindings) {
          const findingPrefix = `${finding.severity}/${finding.kind}: ${finding.message}`;
          const findingLine = typeof finding.path === "string" && finding.path.length > 0
            ? `${findingPrefix} (path: ${finding.path})`
            : findingPrefix;
          lines.push(`  - ${findingLine}`);
        }
      }
      if (entry.evidence.length > 0) {
        lines.push("  evidence:");
        for (const evidence of entry.evidence) {
          lines.push(`  - ${evidence}`);
        }
      }
      if (entry.openQuestions.length > 0) {
        lines.push("  open_questions:");
        for (const openQuestion of entry.openQuestions) {
          lines.push(`  - ${openQuestion}`);
        }
      }
    }
  }

  return lines.join("\n");
}
