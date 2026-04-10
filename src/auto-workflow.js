import { buildTaskPacket, createInitialWorkflow } from "./orchestrator.js";

const READ_ONLY_ROLES = new Set(["explorer", "reviewer", "verifier"]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizePath(path) {
  return path.replace(/\\/g, "/");
}

function unique(values) {
  return [...new Set(values)];
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function coerceGoal(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "(invalid auto workflow input)";
}

function coerceRepairBudget(value) {
  return Number.isInteger(value) && value >= 0 ? value : 1;
}

function blockedInputExecution({ goal, maxRepairLoops, stopReason }) {
  return {
    workflow: {
      workflowId: "workflow-invalid-auto-input",
      goal: coerceGoal(goal),
      risk: "low",
      humanGate: false,
      roleSequence: [],
      packets: []
    },
    status: "blocked",
    stopReason,
    repairCount: 0,
    maxRepairLoops: coerceRepairBudget(maxRepairLoops),
    runs: []
  };
}

function normalizeWorkflowInput(input) {
  assert(input && typeof input === "object", "workflow input must be an object");
  assert(typeof input.goal === "string" && input.goal.trim().length > 0, "goal must be a non-empty string");
  const allowedFiles = Array.isArray(input.allowedFiles) ? unique(input.allowedFiles.map(normalizePath)) : [];
  assert(
    allowedFiles.length > 0,
    "allowedFiles must contain at least one file path for /auto workflows"
  );

  return {
    goal: input.goal.trim(),
    allowedFiles,
    forbiddenFiles: Array.isArray(input.forbiddenFiles) ? input.forbiddenFiles.map(normalizePath) : [],
    contextFiles: Array.isArray(input.contextFiles) ? input.contextFiles.map(normalizePath) : [],
    approvedHighRisk: Boolean(input.approvedHighRisk),
    maxRepairLoops: input.maxRepairLoops ?? 1
  };
}

function normalizePlannedWorkflowInput(input) {
  assert(input && typeof input === "object", "planned workflow input must be an object");
  assert(input.workflow && typeof input.workflow === "object", "planned workflow input must include a workflow object");
  assert(typeof input.workflow.workflowId === "string" && input.workflow.workflowId.trim().length > 0, "workflow.workflowId must be a non-empty string");
  assert(typeof input.workflow.goal === "string" && input.workflow.goal.trim().length > 0, "workflow.goal must be a non-empty string");
  assert(Array.isArray(input.workflow.roleSequence), "workflow.roleSequence must be an array");
  assert(Array.isArray(input.workflow.packets), "workflow.packets must be an array");

  return {
    workflow: clone(input.workflow),
    approvedHighRisk: Boolean(input.approvedHighRisk),
    maxRepairLoops: input.maxRepairLoops ?? 1,
    context: input.context && typeof input.context === "object" && !Array.isArray(input.context)
      ? clone(input.context)
      : {}
  };
}

function assertRunner(runner) {
  assert(runner && typeof runner.run === "function", "runner.run(packet, context) is required");
}

function assertRepairBudget(maxRepairLoops) {
  assert(Number.isInteger(maxRepairLoops) && maxRepairLoops >= 0, "maxRepairLoops must be a non-negative integer");
}

function sanitizePriorResults(runs) {
  return runs.map(({ packet, result }) => ({
    packetId: packet.id,
    role: packet.role,
    status: result.status,
    summary: result.summary,
    changedFiles: clone(result.changedFiles),
    commandsRun: clone(result.commandsRun),
    evidence: clone(result.evidence),
    openQuestions: clone(result.openQuestions)
  }));
}

function buildRunContext({ workflow, runs, repairCount, reviewResult, baseContext = {} }) {
  return {
    ...clone(baseContext),
    workflowId: workflow.workflowId,
    goal: workflow.goal,
    risk: workflow.risk,
    roleSequence: clone(workflow.roleSequence),
    repairCount,
    priorResults: sanitizePriorResults(runs),
    reviewResult: reviewResult ? {
      status: reviewResult.status,
      summary: reviewResult.summary,
      evidence: clone(reviewResult.evidence),
      openQuestions: clone(reviewResult.openQuestions)
    } : null
  };
}

function validateChangedFiles(packet, result) {
  const changedFiles = result.changedFiles.map(normalizePath);
  const allowedFiles = new Set(packet.allowedFiles.map(normalizePath));
  const forbiddenFiles = new Set(packet.forbiddenFiles.map(normalizePath));

  if (READ_ONLY_ROLES.has(packet.role) && changedFiles.length > 0) {
    throw new Error(`${packet.role} is read-only and must not report changed files`);
  }

  for (const changedFile of changedFiles) {
    assert(allowedFiles.has(changedFile), `${packet.role} reported a file outside its allowlist: ${changedFile}`);
    assert(!forbiddenFiles.has(changedFile), `${packet.role} reported a forbidden file: ${changedFile}`);
  }
}

async function executePacket({
  runner,
  packet,
  workflow,
  runs,
  repairCount,
  reviewResult = null,
  iteration = 0,
  baseContext = {}
}) {
  const context = buildRunContext({
    workflow,
    runs,
    repairCount,
    reviewResult,
    baseContext
  });
  const result = await runner.run(packet, context);

  validateChangedFiles(packet, result);

  const run = {
    packet: clone(packet),
    result: clone(result),
    iteration
  };

  runs.push(run);
  return run;
}

function stopExecution({ workflow, runs, repairCount, maxRepairLoops, status, stopReason }) {
  return {
    workflow,
    status,
    stopReason,
    repairCount,
    maxRepairLoops,
    runs: clone(runs)
  };
}

function createRepairPacket({ workflow, packet, role, repairCount }) {
  return buildTaskPacket({
    goal: `${role === "implementer" ? "Address review findings for" : "Re-review repaired patch for"}: ${workflow.goal}`,
    role,
    allowedFiles: packet.allowedFiles,
    forbiddenFiles: packet.forbiddenFiles,
    parentTaskId: `${workflow.workflowId}-repair-${repairCount}`,
    risk: workflow.risk,
    contextFiles: unique([
      ...packet.contextFiles,
      ...packet.allowedFiles
    ])
  });
}

async function runRepairLoop({ runner, workflow, reviewerPacket, runs, repairCount, baseContext }) {
  const implementerPacket = createRepairPacket({
    workflow,
    packet: reviewerPacket,
    role: "implementer",
    repairCount
  });
  const repairRun = await executePacket({
    runner,
    packet: implementerPacket,
    workflow,
    runs,
    repairCount,
    iteration: repairCount,
    baseContext
  });

  if (repairRun.result.status !== "success") {
    return {
      status: repairRun.result.status,
      stopReason: `Repair implementation did not succeed: ${repairRun.result.summary}`
    };
  }

  const rereviewPacket = createRepairPacket({
    workflow,
    packet: reviewerPacket,
    role: "reviewer",
    repairCount
  });
  const rereviewRun = await executePacket({
    runner,
    packet: rereviewPacket,
    workflow,
    runs,
    repairCount,
    reviewResult: repairRun.result,
    iteration: repairCount,
    baseContext
  });

  return {
    status: rereviewRun.result.status,
    stopReason: rereviewRun.result.status === "repair_required"
      ? `Review still requires repair after ${repairCount} repair loop(s).`
      : rereviewRun.result.status === "success"
        ? null
        : `Repair review did not complete successfully: ${rereviewRun.result.summary}`
  };
}

export async function runPlannedWorkflow(input, { runner } = {}) {
  assertRunner(runner);
  const normalizedInput = normalizePlannedWorkflowInput(input);
  const workflow = normalizedInput.workflow;
  const baseContext = normalizedInput.context;
  assertRepairBudget(normalizedInput.maxRepairLoops);
  const runs = [];
  let repairCount = 0;

  if (workflow.humanGate && !normalizedInput.approvedHighRisk) {
    return stopExecution({
      workflow,
      runs,
      repairCount,
      maxRepairLoops: normalizedInput.maxRepairLoops,
      status: "human_gate_required",
      stopReason: "Human approval is required before executing this workflow."
    });
  }

  for (const packet of workflow.packets) {
    const run = await executePacket({
      runner,
      packet,
      workflow,
      runs,
      repairCount,
      baseContext
    });

    if (packet.role === "reviewer" && run.result.status === "repair_required") {
      if (repairCount >= normalizedInput.maxRepairLoops) {
        return stopExecution({
          workflow,
          runs,
          repairCount,
          maxRepairLoops: normalizedInput.maxRepairLoops,
          status: "repair_required",
          stopReason: `Review requested repair but the repair budget of ${normalizedInput.maxRepairLoops} was exhausted.`
        });
      }

      repairCount += 1;
      const repairOutcome = await runRepairLoop({
        runner,
        workflow,
        reviewerPacket: packet,
        runs,
        repairCount,
        baseContext
      });

      if (repairOutcome.status !== "success") {
        return stopExecution({
          workflow,
          runs,
          repairCount,
          maxRepairLoops: normalizedInput.maxRepairLoops,
          status: repairOutcome.status,
          stopReason: repairOutcome.stopReason
        });
      }

      continue;
    }

    if (run.result.status !== "success") {
      return stopExecution({
        workflow,
        runs,
        repairCount,
        maxRepairLoops: normalizedInput.maxRepairLoops,
        status: run.result.status,
        stopReason: `The ${packet.role} step stopped the workflow: ${run.result.summary}`
      });
    }
  }

  return stopExecution({
    workflow,
    runs,
    repairCount,
    maxRepairLoops: normalizedInput.maxRepairLoops,
    status: "success",
    stopReason: null
  });
}

export async function runAutoWorkflow(input, { runner } = {}) {
  let normalizedInput;

  try {
    normalizedInput = normalizeWorkflowInput(input);
  } catch (error) {
    return blockedInputExecution({
      goal: input?.goal,
      maxRepairLoops: input?.maxRepairLoops,
      stopReason: error instanceof Error ? error.message : String(error)
    });
  }

  const workflow = createInitialWorkflow({
    goal: normalizedInput.goal,
    allowedFiles: normalizedInput.allowedFiles,
    forbiddenFiles: normalizedInput.forbiddenFiles,
    contextFiles: normalizedInput.contextFiles
  });

  return runPlannedWorkflow({
    workflow,
    approvedHighRisk: normalizedInput.approvedHighRisk,
    maxRepairLoops: normalizedInput.maxRepairLoops
  }, { runner });
}

export function formatWorkflowExecution(execution) {
  const lines = [
    `workflow: ${execution.workflow.workflowId}`,
    `status: ${execution.status}`,
    `risk: ${execution.workflow.risk}`,
    `human_gate: ${execution.workflow.humanGate ? "required" : "not-required"}`,
    `repair_loops: ${execution.repairCount}/${execution.maxRepairLoops}`,
    `stop_reason: ${execution.stopReason ?? "none"}`,
    "runs:"
  ];

  if (execution.runs.length === 0) {
    lines.push("- none");
  } else {
    for (const run of execution.runs) {
      lines.push(`- ${run.packet.role} (${run.result.status}): ${run.result.summary}`);
    }
  }

  return lines.join("\n");
}
