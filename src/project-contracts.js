import { RISK_LEVELS, ROLE_TYPES, validateTaskPacket } from "./contracts.js";

export const AUDIT_STATUSES = Object.freeze(["pass", "attention_required"]);
export const FINDING_SEVERITIES = Object.freeze(["low", "medium", "high"]);
export const CONTRACT_EXECUTION_STATUSES = Object.freeze([
  "success",
  "blocked",
  "failed",
  "repair_required"
]);
export const PROGRAM_RUN_STATUSES = Object.freeze([
  "running",
  "success",
  "blocked",
  "failed",
  "repair_required"
]);
const WORKER_ROLE_TYPES = Object.freeze(ROLE_TYPES.filter((role) => role !== "orchestrator"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertString(name, value) {
  assert(typeof value === "string" && value.trim().length > 0, `${name} must be a non-empty string`);
}

function assertStringArray(name, value) {
  assert(Array.isArray(value), `${name} must be an array`);
  for (const item of value) {
    assert(typeof item === "string", `${name} must only contain strings`);
  }
}

function assertPlainObject(name, value) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
}

function assertArrayOfObjects(name, value) {
  assert(Array.isArray(value), `${name} must be an array`);
  for (const item of value) {
    assertPlainObject(name, item);
  }
}

function assertPositiveInteger(name, value, minimum = 1) {
  assert(Number.isInteger(value) && value >= minimum, `${name} must be an integer >= ${minimum}`);
}

function clone(value) {
  return structuredClone(value);
}

function validateBriefContext(name, value) {
  assertPlainObject(name, value);
  assertString(`${name}.autonomyMode`, value.autonomyMode);
  assertStringArray(`${name}.constraints`, value.constraints);
  assertStringArray(`${name}.nonGoals`, value.nonGoals);
  assertStringArray(`${name}.targetUsers`, value.targetUsers);
  assertStringArray(`${name}.successCriteria`, value.successCriteria);
  assertStringArray(`${name}.stackPreferences`, value.stackPreferences);
}

export function validateProposalSet(proposalSet) {
  assertPlainObject("proposalSet", proposalSet);
  assertString("proposalSet.id", proposalSet.id);
  assertString("proposalSet.goal", proposalSet.goal);
  assertString("proposalSet.projectName", proposalSet.projectName);
  assertString("proposalSet.projectType", proposalSet.projectType);
  assertString("proposalSet.recommendedAlternativeId", proposalSet.recommendedAlternativeId);
  validateBriefContext("proposalSet.brief", proposalSet.brief);
  assertStringArray("proposalSet.assumptions", proposalSet.assumptions);
  assertStringArray("proposalSet.openDecisions", proposalSet.openDecisions);
  assertArrayOfObjects("proposalSet.alternatives", proposalSet.alternatives);
  assertArrayOfObjects("proposalSet.milestoneTrack", proposalSet.milestoneTrack);

  for (const alternative of proposalSet.alternatives) {
    assertString("proposalSet.alternatives[].id", alternative.id);
    assertString("proposalSet.alternatives[].title", alternative.title);
    assertString("proposalSet.alternatives[].summary", alternative.summary);
    assertStringArray("proposalSet.alternatives[].advantages", alternative.advantages);
    assertStringArray("proposalSet.alternatives[].tradeoffs", alternative.tradeoffs);
    assertStringArray("proposalSet.alternatives[].fitSignals", alternative.fitSignals);
    assertString("proposalSet.alternatives[].nextStep", alternative.nextStep);
  }

  assert(
    proposalSet.alternatives.some((alternative) => alternative.id === proposalSet.recommendedAlternativeId),
    "proposalSet.recommendedAlternativeId must match one of the alternatives"
  );

  for (const milestone of proposalSet.milestoneTrack) {
    assertString("proposalSet.milestoneTrack[].id", milestone.id);
    assertString("proposalSet.milestoneTrack[].title", milestone.title);
    assertString("proposalSet.milestoneTrack[].summary", milestone.summary);
    assertStringArray("proposalSet.milestoneTrack[].dependsOn", milestone.dependsOn);
    assertStringArray("proposalSet.milestoneTrack[].outputs", milestone.outputs);
  }

  return proposalSet;
}

export function validateProjectBlueprint(blueprint) {
  assertPlainObject("blueprint", blueprint);
  assertString("blueprint.id", blueprint.id);
  assertString("blueprint.goal", blueprint.goal);
  assertString("blueprint.projectName", blueprint.projectName);
  assertString("blueprint.projectType", blueprint.projectType);
  assertString("blueprint.selectedAlternativeId", blueprint.selectedAlternativeId);
  assertString("blueprint.summary", blueprint.summary);
  validateBriefContext("blueprint.brief", blueprint.brief);
  assertStringArray("blueprint.architectureDecisions", blueprint.architectureDecisions);
  assertStringArray("blueprint.qualityGates", blueprint.qualityGates);
  assertArrayOfObjects("blueprint.repositoryLayout", blueprint.repositoryLayout);
  assertArrayOfObjects("blueprint.modules", blueprint.modules);
  assertPlainObject("blueprint.executionProfile", blueprint.executionProfile);

  for (const entry of blueprint.repositoryLayout) {
    assertString("blueprint.repositoryLayout[].path", entry.path);
    assertString("blueprint.repositoryLayout[].purpose", entry.purpose);
  }

  for (const module of blueprint.modules) {
    assertString("blueprint.modules[].id", module.id);
    assertString("blueprint.modules[].name", module.name);
    assertString("blueprint.modules[].purpose", module.purpose);
    assertStringArray("blueprint.modules[].paths", module.paths);
    assertStringArray("blueprint.modules[].dependsOn", module.dependsOn);
  }

  const profile = blueprint.executionProfile;
  assertString("blueprint.executionProfile.autonomyMode", profile.autonomyMode);
  assertString("blueprint.executionProfile.humanGatePolicy", profile.humanGatePolicy);
  assertString("blueprint.executionProfile.verificationDepth", profile.verificationDepth);
  assertPositiveInteger("blueprint.executionProfile.maxRepairLoops", profile.maxRepairLoops, 0);
  assertPositiveInteger("blueprint.executionProfile.maxParallelWorkers", profile.maxParallelWorkers, 1);

  return blueprint;
}

export function validateExecutionProgram(program) {
  assertPlainObject("program", program);
  assertString("program.id", program.id);
  assertString("program.blueprintId", program.blueprintId);
  assertString("program.goal", program.goal);
  assertString("program.projectName", program.projectName);
  assertString("program.executionMode", program.executionMode);
  assertString("program.summary", program.summary);
  validateBriefContext("program.brief", program.brief);
  assertStringArray("program.integrationPoints", program.integrationPoints);
  assertStringArray("program.completionChecks", program.completionChecks);
  assertArrayOfObjects("program.contracts", program.contracts);

  for (const contract of program.contracts) {
    assertString("program.contracts[].id", contract.id);
    assertString("program.contracts[].title", contract.title);
    assertString("program.contracts[].goal", contract.goal);
    assertString("program.contracts[].summary", contract.summary);
    assertStringArray("program.contracts[].scopePaths", contract.scopePaths);
    assertStringArray("program.contracts[].dependsOn", contract.dependsOn);
    assertStringArray("program.contracts[].deliverables", contract.deliverables);
    assertStringArray("program.contracts[].constraints", contract.constraints);
    assertStringArray("program.contracts[].nonGoals", contract.nonGoals);
    assertStringArray("program.contracts[].successCriteria", contract.successCriteria);
    assert(RISK_LEVELS.includes(contract.risk), `program.contracts[].risk must be one of: ${RISK_LEVELS.join(", ")}`);
    assertStringArray("program.contracts[].acceptanceChecks", contract.acceptanceChecks);
    assertStringArray("program.contracts[].verificationPlan", contract.verificationPlan);
    assertStringArray("program.contracts[].stopConditions", contract.stopConditions);
  }

  return program;
}

export function validateBootstrapContract(contract) {
  assertPlainObject("bootstrapContract", contract);
  assertString("bootstrapContract.id", contract.id);
  assertString("bootstrapContract.title", contract.title);
  assertString("bootstrapContract.goal", contract.goal);
  assertString("bootstrapContract.summary", contract.summary);
  validateBriefContext("bootstrapContract.brief", contract.brief);
  assertStringArray("bootstrapContract.scopePaths", contract.scopePaths);
  assertStringArray("bootstrapContract.deliverables", contract.deliverables);
  assertStringArray("bootstrapContract.commands", contract.commands);
  assertStringArray("bootstrapContract.acceptanceChecks", contract.acceptanceChecks);
  assertStringArray("bootstrapContract.stopConditions", contract.stopConditions);
  return contract;
}

export function validateAuditReport(report) {
  assertPlainObject("auditReport", report);
  assertString("auditReport.id", report.id);
  assert(AUDIT_STATUSES.includes(report.status), `auditReport.status must be one of: ${AUDIT_STATUSES.join(", ")}`);
  assertString("auditReport.summary", report.summary);
  validateBriefContext("auditReport.brief", report.brief);
  assertStringArray("auditReport.strengths", report.strengths);
  assertStringArray("auditReport.recommendedNextContracts", report.recommendedNextContracts);
  assertStringArray("auditReport.evidence", report.evidence);
  assertArrayOfObjects("auditReport.findings", report.findings);

  for (const finding of report.findings) {
    assertString("auditReport.findings[].id", finding.id);
    assert(FINDING_SEVERITIES.includes(finding.severity), `auditReport.findings[].severity must be one of: ${FINDING_SEVERITIES.join(", ")}`);
    assertString("auditReport.findings[].summary", finding.summary);
    assertString("auditReport.findings[].recommendation", finding.recommendation);
  }

  return report;
}

export function validateContractExecutionResult(result) {
  assertPlainObject("contractExecutionResult", result);
  assert(
    CONTRACT_EXECUTION_STATUSES.includes(result.status),
    `contractExecutionResult.status must be one of: ${CONTRACT_EXECUTION_STATUSES.join(", ")}`
  );
  assertString("contractExecutionResult.summary", result.summary);
  assertStringArray("contractExecutionResult.evidence", result.evidence);
  assertStringArray("contractExecutionResult.openQuestions", result.openQuestions);
  return result;
}

export function validateRunJournalEntry(entry) {
  assertPlainObject("runJournalEntry", entry);
  assertString("runJournalEntry.contractId", entry.contractId);
  assert(
    CONTRACT_EXECUTION_STATUSES.includes(entry.status),
    `runJournalEntry.status must be one of: ${CONTRACT_EXECUTION_STATUSES.join(", ")}`
  );
  assertString("runJournalEntry.summary", entry.summary);
  assertStringArray("runJournalEntry.evidence", entry.evidence);
  assertStringArray("runJournalEntry.openQuestions", entry.openQuestions);
  return entry;
}

export function validateRunJournal(journal) {
  assertPlainObject("runJournal", journal);
  assertString("runJournal.programId", journal.programId);
  assert(
    PROGRAM_RUN_STATUSES.includes(journal.status),
    `runJournal.status must be one of: ${PROGRAM_RUN_STATUSES.join(", ")}`
  );
  if (journal.stopReason !== null && journal.stopReason !== undefined) {
    assertString("runJournal.stopReason", journal.stopReason);
  }
  assertArrayOfObjects("runJournal.contractRuns", journal.contractRuns);
  for (const entry of journal.contractRuns) {
    validateRunJournalEntry(entry);
  }
  assertStringArray("runJournal.completedContractIds", journal.completedContractIds);
  assertStringArray("runJournal.pendingContractIds", journal.pendingContractIds);
  return journal;
}

export function validateCompiledContractExecutionPlan(plan) {
  assertPlainObject("compiledContractExecutionPlan", plan);
  assertString("compiledContractExecutionPlan.contractId", plan.contractId);
  assertString("compiledContractExecutionPlan.goal", plan.goal);
  assertString("compiledContractExecutionPlan.boundedGoal", plan.boundedGoal);
  assertStringArray("compiledContractExecutionPlan.allowedFileScope", plan.allowedFileScope);
  assertStringArray("compiledContractExecutionPlan.contextFiles", plan.contextFiles);
  assertStringArray("compiledContractExecutionPlan.intendedRoleSequence", plan.intendedRoleSequence);
  for (const role of plan.intendedRoleSequence) {
    assert(
      WORKER_ROLE_TYPES.includes(role),
      `compiledContractExecutionPlan.intendedRoleSequence[] must be one of: ${WORKER_ROLE_TYPES.join(", ")}`
    );
  }
  assert(
    RISK_LEVELS.includes(plan.risk),
    `compiledContractExecutionPlan.risk must be one of: ${RISK_LEVELS.join(", ")}`
  );
  assertStringArray("compiledContractExecutionPlan.constraints", plan.constraints);
  assertStringArray("compiledContractExecutionPlan.nonGoals", plan.nonGoals);
  assertStringArray("compiledContractExecutionPlan.acceptanceChecks", plan.acceptanceChecks);
  assertStringArray("compiledContractExecutionPlan.stopConditions", plan.stopConditions);
  assertPlainObject("compiledContractExecutionPlan.workflow", plan.workflow);

  const workflow = plan.workflow;
  assertString("compiledContractExecutionPlan.workflow.workflowId", workflow.workflowId);
  assertString("compiledContractExecutionPlan.workflow.goal", workflow.goal);
  assert(
    RISK_LEVELS.includes(workflow.risk),
    `compiledContractExecutionPlan.workflow.risk must be one of: ${RISK_LEVELS.join(", ")}`
  );
  assert(typeof workflow.humanGate === "boolean", "compiledContractExecutionPlan.workflow.humanGate must be a boolean");
  assertStringArray("compiledContractExecutionPlan.workflow.roleSequence", workflow.roleSequence);
  for (const role of workflow.roleSequence) {
    assert(
      WORKER_ROLE_TYPES.includes(role),
      `compiledContractExecutionPlan.workflow.roleSequence[] must be one of: ${WORKER_ROLE_TYPES.join(", ")}`
    );
  }
  assertArrayOfObjects("compiledContractExecutionPlan.workflow.packets", workflow.packets);
  for (const packet of workflow.packets) {
    validateTaskPacket(packet);
  }

  return plan;
}

export function createProposalSet(proposalSet) {
  return validateProposalSet(clone(proposalSet));
}

export function createProjectBlueprint(blueprint) {
  return validateProjectBlueprint(clone(blueprint));
}

export function createExecutionProgram(program) {
  return validateExecutionProgram(clone(program));
}

export function createBootstrapContract(contract) {
  return validateBootstrapContract(clone(contract));
}

export function createAuditReport(report) {
  return validateAuditReport(clone(report));
}

export function createContractExecutionResult(result) {
  return validateContractExecutionResult(clone(result));
}

export function createRunJournal(journal) {
  return validateRunJournal(clone(journal));
}

export function createCompiledContractExecutionPlan(plan) {
  return validateCompiledContractExecutionPlan(clone(plan));
}
