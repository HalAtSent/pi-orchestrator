import { RISK_LEVELS, createTaskPacket } from "./contracts.js";
import { buildTaskPacket, makeRoleSequence } from "./orchestrator.js";
import { requiresHumanGate } from "./policies.js";
import { createCompiledContractExecutionPlan } from "./project-contracts.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizePath(path) {
  return String(path).replace(/\\/g, "/");
}

function normalizeStringArray(name, value) {
  assert(Array.isArray(value), `${name} must be an array`);
  return value.map((item) => String(item));
}

function unique(values) {
  return [...new Set(values)];
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function validateExecutionContract(contract) {
  assert(contract && typeof contract === "object" && !Array.isArray(contract), "contract must be an object");
  assert(typeof contract.id === "string" && contract.id.trim().length > 0, "contract.id must be a non-empty string");
  assert(typeof contract.goal === "string" && contract.goal.trim().length > 0, "contract.goal must be a non-empty string");
  assert(RISK_LEVELS.includes(contract.risk), `contract.risk must be one of: ${RISK_LEVELS.join(", ")}`);

  return {
    id: contract.id.trim(),
    goal: contract.goal.trim(),
    scopePaths: normalizeStringArray("contract.scopePaths", contract.scopePaths).map(normalizePath),
    constraints: normalizeStringArray("contract.constraints", contract.constraints),
    nonGoals: normalizeStringArray("contract.nonGoals", contract.nonGoals),
    acceptanceChecks: normalizeStringArray("contract.acceptanceChecks", contract.acceptanceChecks),
    stopConditions: normalizeStringArray("contract.stopConditions", contract.stopConditions),
    deliverables: normalizeStringArray("contract.deliverables", contract.deliverables),
    risk: contract.risk
  };
}

function deriveBoundedGoal(contract) {
  return `Execute contract ${contract.id}: ${contract.goal} (scope-locked to declared contract paths).`;
}

function mergePacketPolicy(packet, contract) {
  return createTaskPacket({
    ...packet,
    nonGoals: unique([
      ...packet.nonGoals,
      ...contract.nonGoals
    ]),
    acceptanceChecks: unique([
      ...packet.acceptanceChecks,
      ...contract.acceptanceChecks
    ]),
    stopConditions: unique([
      ...packet.stopConditions,
      ...contract.stopConditions,
      ...contract.constraints.map((constraint) => `Stop if this contract constraint cannot be preserved: ${constraint}`)
    ])
  });
}

export function compileExecutionContract(contractInput, { contextFiles = [] } = {}) {
  const contract = validateExecutionContract(structuredClone(contractInput));
  const allowedFileScope = unique(contract.scopePaths);
  const normalizedContextFiles = unique(normalizeStringArray("contextFiles", contextFiles).map(normalizePath));
  const intendedRoleSequence = makeRoleSequence(contract.risk);
  const boundedGoal = deriveBoundedGoal(contract);
  const workflowId = `contract-${slugify(contract.id) || "task"}`;
  const packets = intendedRoleSequence.map((role) => mergePacketPolicy(
    buildTaskPacket({
      goal: boundedGoal,
      role,
      allowedFiles: allowedFileScope,
      forbiddenFiles: [],
      parentTaskId: workflowId,
      risk: contract.risk,
      contextFiles: normalizedContextFiles
    }),
    contract
  ));

  return createCompiledContractExecutionPlan({
    contractId: contract.id,
    goal: contract.goal,
    boundedGoal,
    allowedFileScope,
    contextFiles: normalizedContextFiles,
    intendedRoleSequence,
    risk: contract.risk,
    constraints: [...contract.constraints],
    nonGoals: [...contract.nonGoals],
    acceptanceChecks: [...contract.acceptanceChecks],
    stopConditions: [...contract.stopConditions],
    workflow: {
      workflowId,
      goal: boundedGoal,
      risk: contract.risk,
      humanGate: contract.risk === "high" || requiresHumanGate({
        goal: boundedGoal,
        allowedFiles: allowedFileScope
      }),
      roleSequence: intendedRoleSequence,
      packets
    }
  });
}
