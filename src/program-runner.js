import {
  createContractExecutionResult,
  createRunJournal,
  validateExecutionProgram
} from "./project-contracts.js";

const TERMINAL_STOP_STATUSES = new Set(["blocked", "failed", "repair_required"]);

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
  completedContractIds
}) {
  return createRunJournal({
    programId: program.id,
    status,
    stopReason,
    contractRuns,
    completedContractIds,
    pendingContractIds: pendingContractIds(program, completedContractIds)
  });
}

function stopProgram({
  program,
  status,
  stopReason,
  contractRuns,
  completedContractIds
}) {
  return createRunJournalSnapshot({
    program,
    status,
    stopReason,
    contractRuns,
    completedContractIds
  });
}

function createBlockedRunJournal(programId, stopReason) {
  return createRunJournal({
    programId,
    status: "blocked",
    stopReason,
    contractRuns: [],
    completedContractIds: [],
    pendingContractIds: []
  });
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
  error
}) {
  const message = error instanceof Error ? error.message : String(error);
  return stopProgram({
    program,
    status: "blocked",
    stopReason: `Run persistence failed: ${message}`,
    contractRuns: clone(contractRuns),
    completedContractIds: [...completedContractIds]
  });
}

async function persistJournal(runStore, program, runJournal) {
  if (!runStore) {
    return;
  }

  await runStore.updateRun(program.id, () => ({
    programId: program.id,
    program,
    runJournal
  }));
}

async function runProgramFromState(program, {
  executeContract,
  runStore,
  initialContractRuns = [],
  initialCompletedContractIds = []
}) {
  const topologyResult = validateProgramTopology(program);
  if (!topologyResult.ok) {
    return stopProgram({
      program,
      status: "blocked",
      stopReason: topologyResult.reason,
      contractRuns: [],
      completedContractIds: []
    });
  }

  const initialSnapshot = createRunJournalSnapshot({
    program,
    status: "running",
    stopReason: null,
    contractRuns: clone(initialContractRuns),
    completedContractIds: [...initialCompletedContractIds]
  });

  const completedContractIdSet = new Set(initialSnapshot.completedContractIds);
  const pendingContractIdSet = new Set(initialSnapshot.pendingContractIds);
  const contractRuns = clone(initialSnapshot.contractRuns);

  if (pendingContractIdSet.size === 0) {
    const finishedJournal = stopProgram({
      program,
      status: "success",
      stopReason: null,
      contractRuns,
      completedContractIds: [...completedContractIdSet]
    });

    try {
      await persistJournal(runStore, program, finishedJournal);
    } catch (error) {
      return createPersistenceFailureJournal({
        program,
        contractRuns,
        completedContractIds: [...completedContractIdSet],
        error
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
      error
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
        completedContractIds: [...completedContractIdSet]
      });

      try {
        await persistJournal(runStore, program, blockedJournal);
      } catch (error) {
        return createPersistenceFailureJournal({
          program,
          contractRuns,
          completedContractIds: [...completedContractIdSet],
          error
        });
      }

      return blockedJournal;
    }

    const rawResult = await executeContract(clone(contract), {
      programId: program.id,
      completedContractIds: [...completedContractIdSet],
      pendingContractIds: [...pendingContractIdSet],
      contractRuns: clone(contractRuns)
    });
    const result = createContractExecutionResult(rawResult);

    pendingContractIdSet.delete(contract.id);
    contractRuns.push({
      contractId: contract.id,
      status: result.status,
      summary: result.summary,
      evidence: result.evidence,
      openQuestions: result.openQuestions
    });

    if (result.status === "success") {
      completedContractIdSet.add(contract.id);

      const snapshotStatus = pendingContractIdSet.size === 0 ? "success" : "running";
      const snapshot = stopProgram({
        program,
        status: snapshotStatus,
        stopReason: null,
        contractRuns: clone(contractRuns),
        completedContractIds: [...completedContractIdSet]
      });

      try {
        await persistJournal(runStore, program, snapshot);
      } catch (error) {
        return createPersistenceFailureJournal({
          program,
          contractRuns,
          completedContractIds: [...completedContractIdSet],
          error
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

    const terminalJournal = stopProgram({
      program,
      status: result.status,
      stopReason: `Contract ${contract.id} returned ${result.status}: ${result.summary}`,
      contractRuns: clone(contractRuns),
      completedContractIds: [...completedContractIdSet]
    });

    try {
      await persistJournal(runStore, program, terminalJournal);
    } catch (error) {
      return createPersistenceFailureJournal({
        program,
        contractRuns,
        completedContractIds: [...completedContractIdSet],
        error
      });
    }

    return terminalJournal;
  }

  return stopProgram({
    program,
    status: "success",
    stopReason: null,
    contractRuns: clone(contractRuns),
    completedContractIds: [...completedContractIdSet]
  });
}

export async function runExecutionProgram(programInput, {
  contractExecutor,
  runStore
} = {}) {
  const program = validateExecutionProgram(clone(programInput));
  const executeContract = resolveContractExecutor(contractExecutor);
  const resolvedRunStore = resolveRunStore(runStore);

  return runProgramFromState(program, {
    executeContract,
    runStore: resolvedRunStore
  });
}

export async function resumeExecutionProgram(programIdInput, {
  contractExecutor,
  runStore
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

  if (runJournal.status === "success") {
    return runJournal;
  }

  return runProgramFromState(program, {
    executeContract,
    runStore: resolvedRunStore,
    initialContractRuns: runJournal.contractRuns,
    initialCompletedContractIds: runJournal.completedContractIds
  });
}

export function formatProgramRunJournal(journal) {
  const lines = [
    `program: ${journal.programId}`,
    `status: ${journal.status}`,
    `stop_reason: ${journal.stopReason ?? "none"}`,
    `completed: ${journal.completedContractIds.length}`,
    `pending: ${journal.pendingContractIds.length}`,
    "contracts:"
  ];

  if (journal.contractRuns.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of journal.contractRuns) {
      lines.push(`- ${entry.contractId} (${entry.status}): ${entry.summary}`);
    }
  }

  return lines.join("\n");
}
