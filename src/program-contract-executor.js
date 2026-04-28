import { runPlannedWorkflow } from "./auto-workflow.js";
import { parseBooleanFlag } from "./boolean-flags.js";
import { compileExecutionContract } from "./program-compiler.js";
import {
  derivePlannedActionClassesFromWorkflow,
  normalizeAcceptanceArtifact,
  normalizeChangedSurface,
  normalizeChangedSurfaceObservation,
  normalizeClaimLedger,
  deriveCommandObservationsFromCommands,
  normalizeProviderModelSelection,
  normalizeReviewFindings,
  normalizeScopeOwnership,
  normalizeTraceability
} from "./run-evidence.js";
import {
  evaluatePolicyDecision,
  inferWorkflowRequiresProcessBackend,
  normalizePolicyProfileId,
  POLICY_ENFORCED_ACTION_CLASSES
} from "./policy-profiles.js";
import {
  buildVerificationPlan,
  detectSpecDrift,
  evaluateVerificationPlanRun,
  formatSpecDriftEvidence,
  formatVerificationPlanEvidence,
  isCommandLikeVerificationEntry
} from "./verification-planner.js";
import { isPathWithinScope } from "./path-scopes.js";
import { truncateBoundaryString } from "./redaction.js";
import { sanitizeWorkerResultForBoundary } from "./worker-result-redaction.js";

const IMPLEMENTER_ROLE = "implementer";
const PROVIDER_MODEL_EVIDENCE_REQUIREMENT_REQUIRED = "required";
const PROVIDER_MODEL_EVIDENCE_REQUIREMENT_UNKNOWN = "unknown";
const COMMAND_OBSERVATION_SOURCE_WORKER_REPORTED = "worker_reported";
const COMMAND_OBSERVATION_SOURCE_PROCESS_BACKEND_LAUNCHER = "process_backend_launcher";
const REVIEW_ORIENTED_ROLES = new Set(["reviewer", "verifier"]);
const MAX_PERSISTED_WORKER_EVIDENCE_PER_RUN = 12;
const MAX_PERSISTED_WORKER_EVIDENCE_CHARS = 1_000;

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
  policyDecision = null,
  contract = null,
  compiledPlan = null
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

  return {
    ...result,
    ...createContractReviewArtifacts({
      contractId,
      contract,
      compiledPlan,
      status: result.status,
      execution: null,
      changedSurface: result.changedSurface,
      scopeOwnership: null,
      missingVerificationCommands: [],
      specDrift: null
    })
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

function sanitizeWorkflowExecutionForContractBoundary(execution) {
  return {
    ...execution,
    runs: Array.isArray(execution?.runs)
      ? execution.runs.map((run) => ({
        ...run,
        packet: structuredClone(run.packet),
        result: sanitizeWorkerResultForBoundary(run.result, {
          repositoryRoot: process.cwd(),
          mergeExistingRedaction: true
        }),
        provenance: structuredClone(run.provenance ?? {})
      }))
      : []
  };
}

function boundedWorkerEvidenceLine(run, evidence, index) {
  const role = typeof run?.packet?.role === "string" && run.packet.role.trim().length > 0
    ? run.packet.role.trim()
    : "unknown";
  const packetId = typeof run?.packet?.id === "string" && run.packet.id.trim().length > 0
    ? run.packet.id.trim()
    : "unknown-packet";
  const boundedEvidence = truncateBoundaryString(String(evidence).trim(), {
    maxLength: MAX_PERSISTED_WORKER_EVIDENCE_CHARS,
    fieldName: `contractExecutionResult.workerEvidence[${packetId}][${index}]`
  });
  return `run ${role} evidence (${packetId}): ${boundedEvidence}`;
}

function createWorkerEvidenceLines(run) {
  const workerEvidence = Array.isArray(run?.result?.evidence) ? run.result.evidence : [];
  const boundedEvidence = workerEvidence
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .slice(0, MAX_PERSISTED_WORKER_EVIDENCE_PER_RUN)
    .map((entry, index) => boundedWorkerEvidenceLine(run, entry, index));

  if (workerEvidence.length > MAX_PERSISTED_WORKER_EVIDENCE_PER_RUN) {
    const role = typeof run?.packet?.role === "string" && run.packet.role.trim().length > 0
      ? run.packet.role.trim()
      : "unknown";
    boundedEvidence.push(
      `run ${role} evidence_truncated: ${workerEvidence.length - MAX_PERSISTED_WORKER_EVIDENCE_PER_RUN} entr${workerEvidence.length - MAX_PERSISTED_WORKER_EVIDENCE_PER_RUN === 1 ? "y" : "ies"} omitted`
    );
  }

  return boundedEvidence;
}

function normalizeCommandText(command) {
  return typeof command === "string" ? command.trim() : "";
}

function getVerifierCommandsRun(execution) {
  return unique(
    (Array.isArray(execution?.runs) ? execution.runs : [])
      .filter((run) => run?.packet?.role === "verifier")
      .flatMap((run) => Array.isArray(run?.result?.commandsRun) ? run.result.commandsRun : [])
      .map(normalizeCommandText)
      .filter((command) => command.length > 0)
  );
}

function createExecutionEvidence(compiledPlan, execution, verificationPlanEvidence, specDrift) {
  const runEvidence = execution.runs.flatMap((run) => {
    const evidence = [`run ${run.packet.role}: ${run.result.status}`];
    const commandsRun = Array.isArray(run?.result?.commandsRun) ? run.result.commandsRun : [];

    for (const command of commandsRun) {
      if (typeof command !== "string" || command.trim().length === 0) {
        continue;
      }
      evidence.push(`run ${run.packet.role} command: ${command.trim()}`);
    }

    evidence.push(...createWorkerEvidenceLines(run));
    return evidence;
  });

  return [
    `compiled workflow: ${compiledPlan.workflow.workflowId}`,
    `risk: ${compiledPlan.risk}`,
    `lane: ${compiledPlan.lane}`,
    `roles: ${compiledPlan.intendedRoleSequence.join(" -> ")}`,
    ...formatVerificationPlanEvidence(verificationPlanEvidence),
    ...formatSpecDriftEvidence(specDrift),
    ...runEvidence
  ];
}

function createExecutionOpenQuestions(execution) {
  const fromRuns = execution.runs.flatMap((run) => run.result.openQuestions);

  if (execution.status === "human_gate_required") {
    return unique([
      ...fromRuns,
      "Obtain explicit human approval for this gated contract before re-running."
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

function normalizeContractStringList(value) {
  return Array.isArray(value)
    ? unique(value.map((entry) => normalizeCommandText(entry)).filter((entry) => entry.length > 0))
    : [];
}

function acceptanceItemId(contractId, type, index) {
  return `${contractId}:${type}:${index + 1}`;
}

function createAcceptanceItems({ contractId, contract, compiledPlan }) {
  const successCriteria = normalizeContractStringList(contract?.successCriteria);
  const acceptanceChecks = normalizeContractStringList(
    compiledPlan?.acceptanceChecks ?? contract?.acceptanceChecks
  );
  const verificationPlan = normalizeContractStringList(
    compiledPlan?.verificationPlan ?? contract?.verificationPlan
  ).filter(isCommandLikeVerificationEntry);
  const nonGoals = normalizeContractStringList(
    compiledPlan?.nonGoals ?? contract?.nonGoals
  );
  const items = [];

  for (const [index, text] of successCriteria.entries()) {
    items.push({
      id: acceptanceItemId(contractId, "success_criterion", index),
      type: "success_criterion",
      text,
      required: true
    });
  }
  for (const [index, text] of acceptanceChecks.entries()) {
    items.push({
      id: acceptanceItemId(contractId, "acceptance_check", index),
      type: "acceptance_check",
      text,
      required: true
    });
  }
  for (const [index, text] of verificationPlan.entries()) {
    items.push({
      id: acceptanceItemId(contractId, "verification", index),
      type: "verification",
      text,
      required: true
    });
  }
  for (const [index, text] of nonGoals.entries()) {
    items.push({
      id: acceptanceItemId(contractId, "non_goal", index),
      type: "non_goal",
      text,
      required: true
    });
  }

  return items;
}

function collectVerifierValidationEvidence(execution) {
  const refs = [];
  const commands = [];
  const evidenceRefsByCommand = new Map();
  const runs = Array.isArray(execution?.runs) ? execution.runs : [];

  for (const [runIndex, run] of runs.entries()) {
    if (run?.packet?.role !== "verifier") {
      continue;
    }

    const packetId = typeof run?.packet?.id === "string" && run.packet.id.trim().length > 0
      ? run.packet.id.trim()
      : `verifier-${runIndex}`;
    const commandsRun = Array.isArray(run?.result?.commandsRun) ? run.result.commandsRun : [];
    for (const [commandIndex, rawCommand] of commandsRun.entries()) {
      const command = normalizeCommandText(rawCommand);
      if (command.length === 0) {
        continue;
      }
      const ref = `run:${packetId}:commandsRun[${commandIndex}]`;
      refs.push(ref);
      commands.push(command);
      if (!evidenceRefsByCommand.has(command)) {
        evidenceRefsByCommand.set(command, []);
      }
      evidenceRefsByCommand.get(command).push(ref);
    }

    const evidence = Array.isArray(run?.result?.evidence) ? run.result.evidence : [];
    for (const [evidenceIndex, rawEvidence] of evidence.entries()) {
      const evidenceEntry = normalizeCommandText(rawEvidence);
      if (evidenceEntry.length === 0) {
        continue;
      }
      refs.push(`run:${packetId}:evidence[${evidenceIndex}]`);
    }
  }

  return {
    refs: unique(refs),
    commands: unique(commands),
    evidenceRefsByCommand
  };
}

function commandPreview(commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return "verifier evidence recorded";
  }

  const preview = commands.slice(0, 3).join(" | ");
  return commands.length > 3
    ? `${preview} | +${commands.length - 3} more`
    : preview;
}

function createClaim({
  id,
  type,
  text,
  status,
  evidenceRefs = [],
  evidenceSummary = null,
  reason = null,
  required = true
}) {
  return {
    id,
    type,
    text,
    status,
    required,
    evidenceRefs: unique(evidenceRefs),
    ...(evidenceSummary ? { evidenceSummary } : {}),
    ...(reason ? { reason } : {})
  };
}

function deriveNonGoalClaimStatus({ status, changedSurface, scopeOwnership }) {
  if (status !== "success") {
    return {
      status: "unproven",
      reason: `Contract ended with status ${status}.`
    };
  }

  if (scopeOwnership?.status === "aligned" || scopeOwnership?.status === "no_observed_changes") {
    return {
      status: "proven",
      evidenceSummary: `Observed changed surface is ${scopeOwnership.status}.`
    };
  }

  if (
    changedSurface?.capture === "complete"
    && Array.isArray(changedSurface.paths)
    && changedSurface.paths.length === 0
  ) {
    return {
      status: "proven",
      evidenceSummary: "Complete changed-path capture recorded no changed files."
    };
  }

  if (changedSurface?.capture === "partial") {
    return {
      status: "partial",
      reason: "Changed-path capture is partial, so non-goal preservation is not fully proven.",
      evidenceSummary: "Partial changed-path capture is available."
    };
  }

  return {
    status: "unproven",
    reason: "Changed-path capture is not complete enough to prove non-goal preservation."
  };
}

function createClaimLedger({
  contractId,
  status,
  acceptanceItems,
  execution,
  changedSurface,
  scopeOwnership,
  missingVerificationCommands,
  specDrift = null
}) {
  const validationEvidence = collectVerifierValidationEvidence(execution);
  const hasValidationEvidence = validationEvidence.refs.length > 0;
  const missingVerificationCommandSet = new Set(missingVerificationCommands);
  const verifierCommandSet = new Set(validationEvidence.commands);
  const claims = [
    createClaim({
      id: `${contractId}:terminal_state:success`,
      type: "terminal_state",
      text: `Contract ${contractId} reaches terminal success.`,
      status: status === "success" ? "proven" : "unproven",
      evidenceRefs: ["contractRun.summary"],
      evidenceSummary: status === "success" ? "Contract result status is success." : null,
      reason: status === "success" ? null : `Contract ended with status ${status}.`
    })
  ];

  for (const item of acceptanceItems) {
    if (item.type === "verification") {
      if (status === "success" && verifierCommandSet.has(item.text) && !missingVerificationCommandSet.has(item.text)) {
        claims.push(createClaim({
          id: item.id,
          type: item.type,
          text: item.text,
          status: "proven",
          evidenceRefs: validationEvidence.evidenceRefsByCommand.get(item.text) ?? [],
          evidenceSummary: `Verifier reported required command: ${item.text}.`,
          required: item.required
        }));
      } else {
        const reason = missingVerificationCommandSet.has(item.text)
          ? "Required verificationPlan command was not reported by the verifier."
          : status === "success"
            ? "Required verificationPlan command was not reported by the verifier."
            : `Contract ended with status ${status}.`;
        claims.push(createClaim({
          id: item.id,
          type: item.type,
          text: item.text,
          status: "unproven",
          reason,
          required: item.required
        }));
      }
      continue;
    }

    if (item.type === "non_goal") {
      const nonGoalStatus = deriveNonGoalClaimStatus({
        status,
        changedSurface,
        scopeOwnership
      });
      claims.push(createClaim({
        id: item.id,
        type: item.type,
        text: item.text,
        status: nonGoalStatus.status,
        evidenceRefs: nonGoalStatus.status === "proven" || nonGoalStatus.status === "partial"
          ? ["contractRun.changedSurface", ...(scopeOwnership ? ["contractRun.scopeOwnership"] : [])]
          : [],
        evidenceSummary: nonGoalStatus.evidenceSummary ?? null,
        reason: nonGoalStatus.reason ?? null,
        required: item.required
      }));
      continue;
    }

    if (status !== "success") {
      claims.push(createClaim({
        id: item.id,
        type: item.type,
        text: item.text,
        status: "unproven",
        reason: `Contract ended with status ${status}.`,
        required: item.required
      }));
      continue;
    }

    if (!hasValidationEvidence) {
      claims.push(createClaim({
        id: item.id,
        type: item.type,
        text: item.text,
        status: "unproven",
        reason: "No verifier command or verifier evidence was captured for this claim.",
        required: item.required
      }));
      continue;
    }

    claims.push(createClaim({
      id: item.id,
      type: item.type,
      text: item.text,
      status: "proven",
      evidenceRefs: validationEvidence.refs,
      evidenceSummary: `Verifier evidence captured: ${commandPreview(validationEvidence.commands)}.`,
      required: item.required
    }));
  }

  if (specDrift?.outcome && specDrift.outcome !== "none_detected") {
    const signalSummary = Array.isArray(specDrift.signals) && specDrift.signals.length > 0
      ? specDrift.signals.map((signal) => `${signal.kind}: ${signal.detail}`).join("; ")
      : "No deterministic drift signal details were captured.";
    claims.push(createClaim({
      id: `${contractId}:verification:spec-drift`,
      type: "verification",
      text: "Contract output stays aligned with the requested goal, bounded goal, changed surface, and worker evidence.",
      status: "unproven",
      required: true,
      reason: `Spec drift outcome is ${specDrift.outcome}. ${signalSummary}`
    }));
  }

  return claims;
}

function deriveAcceptanceStatus(acceptanceItems, claimLedger) {
  if (acceptanceItems.length === 0) {
    return "not_applicable";
  }

  const claimById = new Map(claimLedger.map((claim) => [claim.id, claim]));
  const acceptanceClaims = acceptanceItems
    .map((item) => claimById.get(item.id))
    .filter(Boolean);
  if (acceptanceClaims.length === 0) {
    return "not_applicable";
  }
  if (acceptanceClaims.some((claim) => claim.status === "unproven")) {
    return "unsatisfied";
  }
  if (acceptanceClaims.some((claim) => claim.status === "partial")) {
    return "partial";
  }
  return "satisfied";
}

function createTraceability({ acceptanceItems, claimLedger, changedSurface }) {
  const claimById = new Map(claimLedger.map((claim) => [claim.id, claim]));
  const changedFilesKnown = changedSurface?.capture === "complete" || changedSurface?.capture === "partial";
  const changedFiles = changedFilesKnown && Array.isArray(changedSurface?.paths)
    ? changedSurface.paths
    : [];

  return {
    requirementChecks: acceptanceItems
      .filter((item) => item.type !== "non_goal")
      .map((item) => {
        const claim = claimById.get(item.id);
        const validationEvidenceRefs = claim?.status === "proven" || claim?.status === "partial"
          ? claim.evidenceRefs ?? []
          : [];
        return {
          id: item.id,
          type: item.type,
          text: item.text,
          claimIds: claim ? [claim.id] : [],
          changedFilesKnown,
          changedFiles,
          validationEvidenceKnown: validationEvidenceRefs.length > 0,
          validationEvidenceRefs
        };
      }),
    nonGoals: acceptanceItems
      .filter((item) => item.type === "non_goal")
      .map((item) => {
        const claim = claimById.get(item.id);
        const preservationStatus = claim?.status === "proven"
          ? "preserved"
          : claim?.status === "not_applicable"
            ? "not_applicable"
            : "unproven";
        return {
          id: item.id,
          text: item.text,
          preservationStatus,
          claimIds: claim ? [claim.id] : [],
          changedFiles,
          evidenceRefs: claim?.status === "proven" || claim?.status === "partial"
            ? claim.evidenceRefs ?? []
            : [],
          ...(preservationStatus === "preserved" ? {} : {
            reason: claim?.reason ?? "Non-goal preservation is not proven by captured evidence."
          })
        };
      })
  };
}

function createContractReviewArtifacts({
  contractId,
  contract,
  compiledPlan,
  status,
  execution,
  changedSurface,
  scopeOwnership,
  missingVerificationCommands,
  specDrift = null
}) {
  const acceptanceItems = createAcceptanceItems({
    contractId,
    contract,
    compiledPlan
  });
  const claimLedger = createClaimLedger({
    contractId,
    status,
    acceptanceItems,
    execution,
    changedSurface,
    scopeOwnership,
    missingVerificationCommands,
    specDrift
  });
  const acceptanceArtifact = {
    status: deriveAcceptanceStatus(acceptanceItems, claimLedger),
    items: acceptanceItems
  };
  const traceability = createTraceability({
    acceptanceItems,
    claimLedger,
    changedSurface
  });

  return {
    acceptanceArtifact: normalizeAcceptanceArtifact(acceptanceArtifact, {
      fieldName: "contractExecutionResult.acceptanceArtifact"
    }),
    claimLedger: normalizeClaimLedger(claimLedger, {
      fieldName: "contractExecutionResult.claimLedger"
    }),
    traceability: normalizeTraceability(traceability, {
      fieldName: "contractExecutionResult.traceability"
    })
  };
}

function mapWorkflowExecutionToContractResult(contractId, compiledPlan, execution, {
  contract = null,
  policyDecision = null,
  verificationPlan = null,
  originalGoal = null
} = {}) {
  const sanitizedExecution = sanitizeWorkflowExecutionForContractBoundary(execution);
  const verificationPlanEvidence = evaluateVerificationPlanRun(verificationPlan, {
    commandsRun: getVerifierCommandsRun(sanitizedExecution)
  });
  const missingVerificationCommands = verificationPlanEvidence.requiredChecksNotRun.map((check) => check.command);
  const terminalSuccessBlockedByVerification = sanitizedExecution.status === "success" && missingVerificationCommands.length > 0;
  const changedSurface = deriveChangedSurface(sanitizedExecution);
  const specDrift = detectSpecDrift({
    originalGoal: originalGoal ?? contract?.goal ?? compiledPlan.goal,
    contractGoal: contract?.goal ?? compiledPlan.goal,
    boundedGoal: compiledPlan.boundedGoal,
    allowedFileScope: compiledPlan.allowedFileScope,
    changedSurface,
    workerSummaries: sanitizedExecution.runs.map((run) => run?.result?.summary),
    workerEvidence: sanitizedExecution.runs.flatMap((run) => (
      Array.isArray(run?.result?.evidence) ? run.result.evidence : []
    )),
    workerChangedFiles: sanitizedExecution.runs.flatMap((run) => (
      Array.isArray(run?.result?.changedFiles) ? run.result.changedFiles : []
    ))
  });
  const terminalSuccessBlockedByDrift = sanitizedExecution.status === "success" && specDrift.outcome === "drift_detected";
  const status = terminalSuccessBlockedByVerification || terminalSuccessBlockedByDrift
    ? "blocked"
    : normalizeContractStatus(sanitizedExecution.status);
  const evidence = [
    ...createExecutionEvidence(compiledPlan, sanitizedExecution, verificationPlanEvidence, specDrift),
    ...(missingVerificationCommands.length > 0
      ? [`missing_verification_commands: ${missingVerificationCommands.join(" | ")}`]
      : [])
  ];
  const openQuestions = unique([
    ...createExecutionOpenQuestions(sanitizedExecution),
    ...(terminalSuccessBlockedByVerification
      ? ["Run the required verificationPlan command(s) and report them in verifier commandsRun before claiming success."]
      : []),
    ...(terminalSuccessBlockedByDrift
      ? ["Reconcile the compiled bounded goal with the original contract goal before claiming success."]
      : [])
  ]);
  const scopeOwnership = deriveScopeOwnership(compiledPlan, changedSurface);
  const commandObservations = deriveCommandObservations(sanitizedExecution);
  const providerModelSelections = deriveProviderModelSelections(sanitizedExecution);
  const providerModelEvidenceRequirement = deriveProviderModelEvidenceRequirement(sanitizedExecution);
  const reviewFindings = deriveReviewFindings(sanitizedExecution);
  const summary = status === "success"
    ? `Executed ${contractId} through ${sanitizedExecution.runs.length} bounded packet run(s).`
    : terminalSuccessBlockedByVerification
      ? `Contract ${contractId} blocked: required verificationPlan command(s) were not reported by the verifier.`
      : terminalSuccessBlockedByDrift
        ? `Contract ${contractId} blocked: deterministic spec drift was detected.`
      : `Contract ${contractId} ${status}: ${sanitizedExecution.stopReason ?? "execution stopped without an explicit reason"}`;

  const contractResult = {
    status,
    summary,
    evidence,
    verificationPlanEvidence,
    specDrift,
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

  return {
    ...contractResult,
    ...createContractReviewArtifacts({
      contractId,
      contract,
      compiledPlan,
      status,
      execution: sanitizedExecution,
      changedSurface,
      scopeOwnership,
      missingVerificationCommands,
      specDrift
    })
  };
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
  onProgress = null,
  heartbeatIntervalMs = null
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
        contract,
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
            policyDecision,
            contract,
            compiledPlan
          }
        );
      }

      const verificationPlan = await buildVerificationPlan({
        contractVerificationPlan: compiledPlan.verificationPlan,
        plannedScope: compiledPlan.allowedFileScope,
        repositoryRoot: process.cwd()
      });

      const execution = await executePlannedWorkflow({
        workflow: compiledPlan.workflow,
        approvedHighRisk: invocationApprovedHighRisk,
        maxRepairLoops,
        context: {
          ...context,
          contractVerificationPlan: compiledPlan.verificationPlan
        }
      }, {
        runner,
        onProgress,
        ...(Number.isInteger(heartbeatIntervalMs) && heartbeatIntervalMs > 0 ? { heartbeatIntervalMs } : {})
      });

      return mapWorkflowExecutionToContractResult(contractId, compiledPlan, execution, {
        contract,
        policyDecision,
        verificationPlan,
        originalGoal: context?.originalGoal ?? context?.programGoal ?? null
      });
    } catch (error) {
      return toBlockedContractResult(contractId, `bounded execution failed safely: ${error.message}`, {
        evidence: [
          `compiled workflow: ${compiledPlan.workflow.workflowId}`
        ],
        openQuestions: [
          "Inspect runner behavior and packet validation for this contract."
        ],
        policyDecision,
        contract,
        compiledPlan
      });
    }
  };
}
