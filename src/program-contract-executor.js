import { runPlannedWorkflow } from "./auto-workflow.js";
import { parseBooleanFlag } from "./boolean-flags.js";
import { compileExecutionContract } from "./program-compiler.js";
import { normalizeChangedSurface, normalizeChangedSurfaceObservation } from "./run-evidence.js";

const IMPLEMENTER_ROLE = "implementer";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function unique(values) {
  return [...new Set(values)];
}

function toBlockedContractResult(contractId, reason, { evidence = [], openQuestions = [] } = {}) {
  return {
    status: "blocked",
    summary: `Execution blocked for ${contractId}: ${reason}`,
    evidence: [...evidence],
    changedSurface: normalizeChangedSurface(null),
    openQuestions: [
      ...openQuestions
    ]
  };
}

function normalizeContractStatus(status) {
  if (status === "human_gate_required") {
    return "blocked";
  }

  if (status === "success" || status === "blocked" || status === "failed" || status === "repair_required") {
    return status;
  }

  return "failed";
}

function createExecutionEvidence(compiledPlan, execution) {
  const runEvidence = execution.runs.flatMap((run) => {
    const evidence = [`run ${run.packet.role}: ${run.result.status}`];
    const commandsRun = Array.isArray(run?.result?.commandsRun) ? run.result.commandsRun : [];

    for (const command of commandsRun) {
      if (typeof command !== "string" || command.trim().length === 0) {
        continue;
      }
      evidence.push(`run ${run.packet.role} command: ${command.trim()}`);
    }

    return evidence;
  });

  return [
    `compiled workflow: ${compiledPlan.workflow.workflowId}`,
    `risk: ${compiledPlan.risk}`,
    `roles: ${compiledPlan.intendedRoleSequence.join(" -> ")}`,
    ...runEvidence
  ];
}

function createExecutionOpenQuestions(execution) {
  const fromRuns = execution.runs.flatMap((run) => run.result.openQuestions);

  if (execution.status === "human_gate_required") {
    return unique([
      ...fromRuns,
      "Obtain explicit human approval for this high-risk contract before re-running."
    ]);
  }

  return unique(fromRuns);
}

function getObservedChangedSurface(runResult) {
  try {
    return normalizeChangedSurfaceObservation(runResult?.changedSurfaceObservation, {
      fieldName: "workerResult.changedSurfaceObservation"
    });
  } catch {
    return null;
  }
}

function deriveChangedSurface(execution) {
  const runs = Array.isArray(execution?.runs) ? execution.runs : [];
  const successfulImplementerRuns = runs.filter((run) => (
    run?.packet?.role === IMPLEMENTER_ROLE && run?.result?.status === "success"
  ));

  if (successfulImplementerRuns.length === 0) {
    return normalizeChangedSurface(null);
  }

  const observedRuns = successfulImplementerRuns
    .map((run) => ({
      run,
      trusted: run?.provenance?.changedSurfaceObservationTrusted === true,
      observation: getObservedChangedSurface(run?.result)
    }))
    .filter((entry) => entry.trusted && entry.observation?.capture === "complete");
  if (observedRuns.length === 0) {
    return normalizeChangedSurface(null);
  }

  const observedPaths = observedRuns.flatMap((entry) => (
    Array.isArray(entry.observation?.paths) ? entry.observation.paths : []
  ));

  const capture = observedRuns.length === successfulImplementerRuns.length
    ? "complete"
    : "partial";

  return normalizeChangedSurface({
    capture,
    paths: observedPaths
  });
}

function mapWorkflowExecutionToContractResult(contractId, compiledPlan, execution) {
  const status = normalizeContractStatus(execution.status);
  const evidence = createExecutionEvidence(compiledPlan, execution);
  const openQuestions = createExecutionOpenQuestions(execution);
  const changedSurface = deriveChangedSurface(execution);

  if (status === "success") {
    return {
      status,
      summary: `Executed ${contractId} through ${execution.runs.length} bounded packet run(s).`,
      evidence,
      changedSurface,
      openQuestions
    };
  }

  const reason = execution.stopReason ?? "execution stopped without an explicit reason";
  return {
    status,
    summary: `Contract ${contractId} ${status}: ${reason}`,
    evidence,
    changedSurface,
    openQuestions
  };
}

export function createProgramContractExecutor({
  runner,
  compiler = compileExecutionContract,
  executePlannedWorkflow = runPlannedWorkflow,
  approvedHighRisk = false,
  maxRepairLoops = 1
} = {}) {
  assert(runner && typeof runner.run === "function", "runner.run(packet, context) is required");
  assert(typeof compiler === "function", "compiler(contract) is required");
  assert(typeof executePlannedWorkflow === "function", "executePlannedWorkflow(input, options) is required");
  const defaultApprovedHighRisk = parseBooleanFlag(approvedHighRisk, {
    flagName: "approvedHighRisk",
    defaultValue: false
  });

  return async function executeContract(contract, context = {}) {
    const contractId = typeof contract?.id === "string" && contract.id.trim().length > 0
      ? contract.id
      : "unknown-contract";

    let compiledPlan;
    try {
      compiledPlan = compiler(contract, {
        contextFiles: []
      });
    } catch (error) {
      return toBlockedContractResult(contractId, `compile step failed safely: ${error.message}`, {
        evidence: [],
        openQuestions: [
          "Fix the contract payload so it can be compiled into bounded packets."
        ]
      });
    }

    try {
      const invocationApprovedHighRisk = parseBooleanFlag(context?.approvedHighRisk, {
        flagName: "approvedHighRisk",
        defaultValue: defaultApprovedHighRisk
      });
      const execution = await executePlannedWorkflow({
        workflow: compiledPlan.workflow,
        approvedHighRisk: invocationApprovedHighRisk,
        maxRepairLoops,
        context
      }, {
        runner
      });

      return mapWorkflowExecutionToContractResult(contractId, compiledPlan, execution);
    } catch (error) {
      return toBlockedContractResult(contractId, `bounded execution failed safely: ${error.message}`, {
        evidence: [
          `compiled workflow: ${compiledPlan.workflow.workflowId}`
        ],
        openQuestions: [
          "Inspect runner behavior and packet validation for this contract."
        ]
      });
    }
  };
}
