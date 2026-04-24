import { runPlannedWorkflow } from "./auto-workflow.js";
import { parseBooleanFlag } from "./boolean-flags.js";
import { compileExecutionContract } from "./program-compiler.js";
import {
  derivePlannedActionClassesFromWorkflow,
  normalizeChangedSurface,
  normalizeChangedSurfaceObservation,
  deriveCommandObservationsFromCommands,
  normalizeProviderModelSelection,
  normalizeReviewFindings,
  normalizeScopeOwnership
} from "./run-evidence.js";
import {
  evaluatePolicyDecision,
  inferWorkflowRequiresProcessBackend,
  normalizePolicyProfileId,
  POLICY_ENFORCED_ACTION_CLASSES
} from "./policy-profiles.js";
import { isPathWithinScope } from "./path-scopes.js";

const IMPLEMENTER_ROLE = "implementer";
const PROVIDER_MODEL_EVIDENCE_REQUIREMENT_REQUIRED = "required";
const PROVIDER_MODEL_EVIDENCE_REQUIREMENT_UNKNOWN = "unknown";
const COMMAND_OBSERVATION_SOURCE_WORKER_REPORTED = "worker_reported";
const COMMAND_OBSERVATION_SOURCE_PROCESS_BACKEND_LAUNCHER = "process_backend_launcher";
const REVIEW_ORIENTED_ROLES = new Set(["reviewer", "verifier"]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function unique(values) {
  return [...new Set(values)];
}

function toBlockedContractResult(contractId, reason, {
  evidence = [],
  openQuestions = [],
  policyDecision = null
} = {}) {
  const result = {
    status: "blocked",
    summary: `Execution blocked for ${contractId}: ${reason}`,
    evidence: [...evidence],
    providerModelEvidenceRequirement: PROVIDER_MODEL_EVIDENCE_REQUIREMENT_UNKNOWN,
    changedSurface: normalizeChangedSurface(null),
    openQuestions: [
      ...openQuestions
    ]
  };

  if (policyDecision) {
    result.policyDecision = policyDecision;
  }

  return result;
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

function getObservedProviderModelSelection(runResult) {
  try {
    return normalizeProviderModelSelection(runResult?.providerModelSelection, {
      fieldName: "workerResult.providerModelSelection"
    });
  } catch {
    return null;
  }
}

function deriveCommandObservationSource(run) {
  if (
    run?.provenance?.providerModelSelectionTrusted === true
    || run?.provenance?.changedSurfaceObservationTrusted === true
  ) {
    return COMMAND_OBSERVATION_SOURCE_PROCESS_BACKEND_LAUNCHER;
  }
  return COMMAND_OBSERVATION_SOURCE_WORKER_REPORTED;
}

function hasOwnCommandObservations(runResult) {
  return Boolean(runResult)
    && typeof runResult === "object"
    && !Array.isArray(runResult)
    && Object.prototype.hasOwnProperty.call(runResult, "commandObservations");
}

function hasOwnReviewFindings(runResult) {
  return Boolean(runResult)
    && typeof runResult === "object"
    && !Array.isArray(runResult)
    && Object.prototype.hasOwnProperty.call(runResult, "reviewFindings");
}

function deriveCommandObservations(execution) {
  const runs = Array.isArray(execution?.runs) ? execution.runs : [];
  const observations = [];

  for (const run of runs) {
    const runResult = run?.result;
    const source = deriveCommandObservationSource(run);
    const status = typeof runResult?.status === "string" ? runResult.status : "";

    if (hasOwnCommandObservations(runResult)) {
      const typedObservations = Array.isArray(runResult?.commandObservations)
        ? runResult.commandObservations
        : [];
      observations.push(...typedObservations);
      continue;
    }

    if (source === COMMAND_OBSERVATION_SOURCE_PROCESS_BACKEND_LAUNCHER && status === "blocked") {
      continue;
    }

    const commandsRun = Array.isArray(runResult?.commandsRun) ? runResult.commandsRun : [];
    if (commandsRun.length === 0) {
      continue;
    }

    observations.push(...deriveCommandObservationsFromCommands(commandsRun, {
      source,
      fieldName: "contractExecutionResult.commandObservations"
    }));
  }

  return observations;
}

function deriveChangedSurface(execution) {
  const runs = Array.isArray(execution?.runs) ? execution.runs : [];
  const implementerRuns = runs.filter((run) => run?.packet?.role === IMPLEMENTER_ROLE);

  if (implementerRuns.length === 0) {
    return normalizeChangedSurface(null);
  }

  const observedRuns = implementerRuns
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

  const capture = observedRuns.length === implementerRuns.length
    ? "complete"
    : "partial";

  return normalizeChangedSurface({
    capture,
    paths: observedPaths
  });
}

function deriveDeclaredScopePaths(compiledPlan) {
  const allowedFileScope = Array.isArray(compiledPlan?.allowedFileScope)
    ? compiledPlan.allowedFileScope
    : [];
  const declaredScopePaths = allowedFileScope
    .filter((pathValue) => typeof pathValue === "string" && pathValue.trim().length > 0);
  if (declaredScopePaths.length === 0) {
    return [];
  }
  return unique(declaredScopePaths);
}

function hasObservedScopeViolation(observedPaths, declaredScopePaths) {
  return observedPaths.some((observedPath) => (
    !declaredScopePaths.some((scopePath) => isPathWithinScope(observedPath, scopePath))
  ));
}

function deriveScopeOwnership(compiledPlan, changedSurface) {
  const declaredScopePaths = deriveDeclaredScopePaths(compiledPlan);
  if (declaredScopePaths.length === 0) {
    return null;
  }

  const observedPaths = Array.isArray(changedSurface?.paths)
    ? changedSurface.paths
    : [];
  const capture = typeof changedSurface?.capture === "string"
    ? changedSurface.capture
    : "not_captured";
  const observedScopeViolation = hasObservedScopeViolation(observedPaths, declaredScopePaths);

  let status = "unknown";
  if (capture === "complete") {
    if (observedPaths.length === 0) {
      status = "no_observed_changes";
    } else {
      status = observedScopeViolation ? "scope_violation" : "aligned";
    }
  } else if (capture === "partial") {
    status = observedScopeViolation ? "scope_violation" : "unknown";
  }

  return normalizeScopeOwnership({
    declaredScope: {
      mode: "explicit_paths",
      paths: declaredScopePaths
    },
    observedChanges: {
      paths: observedPaths
    },
    status
  }, {
    fieldName: "contractExecutionResult.scopeOwnership",
    allowMissing: false
  });
}

function deriveProviderModelSelections(execution) {
  const runs = Array.isArray(execution?.runs) ? execution.runs : [];
  const observedSelections = [];

  for (const run of runs) {
    if (run?.provenance?.providerModelSelectionTrusted !== true) {
      continue;
    }

    const selection = getObservedProviderModelSelection(run?.result);
    if (!selection) {
      continue;
    }

    const role = typeof run?.packet?.role === "string" && run.packet.role.trim().length > 0
      ? run.packet.role.trim()
      : null;
    if (!role) {
      continue;
    }

    const iteration = Number.isInteger(run?.iteration) && run.iteration >= 0
      ? run.iteration
      : 0;

    observedSelections.push({
      role,
      iteration,
      requestedProvider: selection.requestedProvider,
      requestedModel: selection.requestedModel,
      selectedProvider: selection.selectedProvider,
      selectedModel: selection.selectedModel
    });
  }

  return observedSelections;
}

function deriveProviderModelEvidenceRequirement(execution) {
  const runs = Array.isArray(execution?.runs) ? execution.runs : [];
  const hasTrustedProviderModelProvenance = runs.some(
    (run) => run?.provenance?.providerModelSelectionTrusted === true
  );

  return hasTrustedProviderModelProvenance
    ? PROVIDER_MODEL_EVIDENCE_REQUIREMENT_REQUIRED
    : PROVIDER_MODEL_EVIDENCE_REQUIREMENT_UNKNOWN;
}

function deriveReviewFindings(execution) {
  const runs = Array.isArray(execution?.runs) ? execution.runs : [];
  const reviewFindings = [];

  for (const run of runs) {
    const role = typeof run?.packet?.role === "string"
      ? run.packet.role.trim()
      : "";
    if (!REVIEW_ORIENTED_ROLES.has(role)) {
      continue;
    }

    const runResult = run?.result;
    if (!hasOwnReviewFindings(runResult)) {
      continue;
    }

    const typedReviewFindings = normalizeReviewFindings(runResult.reviewFindings, {
      fieldName: "workerResult.reviewFindings",
      allowMissing: false
    });
    if (typedReviewFindings.length === 0) {
      continue;
    }

    reviewFindings.push(...typedReviewFindings);
  }

  return reviewFindings;
}

function mapWorkflowExecutionToContractResult(contractId, compiledPlan, execution, {
  policyDecision = null
} = {}) {
  const status = normalizeContractStatus(execution.status);
  const evidence = createExecutionEvidence(compiledPlan, execution);
  const openQuestions = createExecutionOpenQuestions(execution);
  const changedSurface = deriveChangedSurface(execution);
  const scopeOwnership = deriveScopeOwnership(compiledPlan, changedSurface);
  const commandObservations = deriveCommandObservations(execution);
  const providerModelSelections = deriveProviderModelSelections(execution);
  const providerModelEvidenceRequirement = deriveProviderModelEvidenceRequirement(execution);
  const reviewFindings = deriveReviewFindings(execution);
  const summary = status === "success"
    ? `Executed ${contractId} through ${execution.runs.length} bounded packet run(s).`
    : `Contract ${contractId} ${status}: ${execution.stopReason ?? "execution stopped without an explicit reason"}`;

  const contractResult = {
    status,
    summary,
    evidence,
    providerModelEvidenceRequirement,
    changedSurface,
    openQuestions
  };
  if (scopeOwnership) {
    contractResult.scopeOwnership = scopeOwnership;
  }

  if (commandObservations.length > 0) {
    contractResult.commandObservations = commandObservations;
  }
  if (reviewFindings.length > 0) {
    contractResult.reviewFindings = reviewFindings;
  }
  if (providerModelSelections.length > 0) {
    contractResult.providerModelSelections = providerModelSelections;
  }
  if (policyDecision) {
    contractResult.policyDecision = policyDecision;
  }

  return contractResult;
}

function createPolicyGateReason(policyDecision) {
  const profileId = policyDecision.profileId;

  if (policyDecision.reason === "unknown_profile") {
    return `policy denied because profile "${profileId}" is unknown or invalid`;
  }
  if (policyDecision.reason === "profile_disallows_process_backend") {
    return `policy denied because profile "${profileId}" disallows process-backend execution`;
  }
  if (policyDecision.reason === "profile_disallows_action_class") {
    return `policy denied because profile "${profileId}" disallows one or more detector-backed action classes`;
  }
  if (policyDecision.reason === "profile_requires_human_gate") {
    return `approval required because profile "${profileId}" requires explicit human approval before execution`;
  }

  return `policy denied because profile "${profileId}" rejected execution`;
}

function createPolicyGateOpenQuestions(policyDecision) {
  if (policyDecision.reason === "profile_requires_human_gate") {
    return [
      "Provide explicit human approval and re-run this contract."
    ];
  }

  if (policyDecision.reason === "unknown_profile") {
    return [
      "Use a supported policy profile id before re-running this contract."
    ];
  }

  return [
    "Adjust the active policy profile or narrow the planned contract actions before re-running."
  ];
}

function createPolicyGateEvidence({
  policyDecision,
  detectedActionClasses,
  requiresProcessBackend
}) {
  const evidence = [
    `policy_profile: ${policyDecision.profileId}`,
    `policy_decision_status: ${policyDecision.status}`,
    `policy_decision_reason: ${policyDecision.reason}`
  ];

  const detectorBackedClasses = Array.isArray(detectedActionClasses)
    ? detectedActionClasses
    : [];
  evidence.push(
    `policy_detected_action_classes: ${
      detectorBackedClasses.length > 0 ? detectorBackedClasses.join(", ") : "none"
    }`
  );

  if (typeof requiresProcessBackend === "boolean") {
    evidence.push(`policy_requires_process_backend: ${requiresProcessBackend}`);
  } else {
    evidence.push("policy_requires_process_backend: unknown");
  }

  return evidence;
}

export function createProgramContractExecutor({
  runner,
  compiler = compileExecutionContract,
  executePlannedWorkflow = runPlannedWorkflow,
  approvedHighRisk = false,
  policyProfile = null,
  maxRepairLoops = 1,
  onProgress = null
} = {}) {
  assert(runner && typeof runner.run === "function", "runner.run(packet, context) is required");
  assert(typeof compiler === "function", "compiler(contract) is required");
  assert(typeof executePlannedWorkflow === "function", "executePlannedWorkflow(input, options) is required");
  const defaultApprovedHighRisk = parseBooleanFlag(approvedHighRisk, {
    flagName: "approvedHighRisk",
    defaultValue: false
  });
  const defaultPolicyProfile = normalizePolicyProfileId(policyProfile, {
    fieldName: "policyProfile",
    allowMissing: true
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

    let policyDecision = null;

    try {
      const invocationApprovedHighRisk = parseBooleanFlag(context?.approvedHighRisk, {
        flagName: "approvedHighRisk",
        defaultValue: defaultApprovedHighRisk
      });
      const requestedPolicyProfile = (
        context
        && typeof context === "object"
        && !Array.isArray(context)
        && Object.prototype.hasOwnProperty.call(context, "policyProfile")
      )
        ? context.policyProfile
        : defaultPolicyProfile;
      const detectedActionClasses = derivePlannedActionClassesFromWorkflow(compiledPlan.workflow)
        .filter((actionClass) => POLICY_ENFORCED_ACTION_CLASSES.includes(actionClass));
      const requiresProcessBackend = inferWorkflowRequiresProcessBackend({
        runner,
        workflow: compiledPlan.workflow
      });
      policyDecision = evaluatePolicyDecision({
        profileId: requestedPolicyProfile,
        detectedActionClasses,
        requiresProcessBackend,
        humanGateApproved: invocationApprovedHighRisk
      });

      if (policyDecision.status !== "allowed") {
        return toBlockedContractResult(
          contractId,
          createPolicyGateReason(policyDecision),
          {
            evidence: createPolicyGateEvidence({
              policyDecision,
              detectedActionClasses,
              requiresProcessBackend
            }),
            openQuestions: createPolicyGateOpenQuestions(policyDecision),
            policyDecision
          }
        );
      }

      const execution = await executePlannedWorkflow({
        workflow: compiledPlan.workflow,
        approvedHighRisk: invocationApprovedHighRisk,
        maxRepairLoops,
        context
      }, {
        runner,
        onProgress
      });

      return mapWorkflowExecutionToContractResult(contractId, compiledPlan, execution, {
        policyDecision
      });
    } catch (error) {
      return toBlockedContractResult(contractId, `bounded execution failed safely: ${error.message}`, {
        evidence: [
          `compiled workflow: ${compiledPlan.workflow.workflowId}`
        ],
        openQuestions: [
          "Inspect runner behavior and packet validation for this contract."
        ],
        policyDecision
      });
    }
  };
}
