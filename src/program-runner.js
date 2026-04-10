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

function stopProgram({
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

export async function runExecutionProgram(programInput, { contractExecutor } = {}) {
  const program = validateExecutionProgram(clone(programInput));
  const executeContract = resolveContractExecutor(contractExecutor);

  const contractIndexResult = createContractIndex(program);
  if (!contractIndexResult.ok) {
    return stopProgram({
      program,
      status: "blocked",
      stopReason: contractIndexResult.reason,
      contractRuns: [],
      completedContractIds: []
    });
  }

  const contractIndex = contractIndexResult.index;
  const dependencyReferenceResult = validateDependencyReferences(program, contractIndex);
  if (!dependencyReferenceResult.ok) {
    return stopProgram({
      program,
      status: "blocked",
      stopReason: dependencyReferenceResult.reason,
      contractRuns: [],
      completedContractIds: []
    });
  }

  const cycle = findDependencyCycle(program, contractIndex);
  if (cycle) {
    return stopProgram({
      program,
      status: "blocked",
      stopReason: `Execution program dependency cycle detected: ${cycle.join(" -> ")}`,
      contractRuns: [],
      completedContractIds: []
    });
  }

  const pendingContractIdSet = new Set(program.contracts.map((contract) => contract.id));
  const completedContractIdSet = new Set();
  const contractRuns = [];

  while (pendingContractIdSet.size > 0) {
    const contract = nextReadyContract(program, pendingContractIdSet, completedContractIdSet);
    if (!contract) {
      return stopProgram({
        program,
        status: "blocked",
        stopReason: "No contracts are ready to run with the current dependency state.",
        contractRuns: clone(contractRuns),
        completedContractIds: [...completedContractIdSet]
      });
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
      continue;
    }

    assert(
      TERMINAL_STOP_STATUSES.has(result.status),
      `Unexpected terminal contract result status: ${result.status}`
    );

    return stopProgram({
      program,
      status: result.status,
      stopReason: `Contract ${contract.id} returned ${result.status}: ${result.summary}`,
      contractRuns: clone(contractRuns),
      completedContractIds: [...completedContractIdSet]
    });
  }

  return stopProgram({
    program,
    status: "success",
    stopReason: null,
    contractRuns: clone(contractRuns),
    completedContractIds: [...completedContractIdSet]
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
