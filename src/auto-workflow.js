import { buildTaskPacket, createInitialWorkflow } from "./orchestrator.js";
import { parseBooleanFlag } from "./boolean-flags.js";
import { isPathWithinScope, normalizeScopedPath } from "./path-scopes.js";
import {
  laneRequiresHumanGate,
  laneRequiresIndependentReview,
  resolveTaskLane
} from "./policies.js";
import { safeClone } from "./safe-clone.js";
import { validateTaskPacket } from "./contracts.js";
import {
  buildChangedSurfaceContextManifest,
  buildPriorResultContextManifest,
  buildReviewResultContextManifest,
  normalizeReconArtifact,
  RUN_CONTEXT_BUDGET_LIMITS,
  sanitizeReconArtifactForBoundary,
  setTrustedForwardedRedactionMetadata,
  setTrustedRuntimeRepositoryRoot,
  mergeContextManifestEntries,
  resolvePacketContextManifest as resolveCanonicalPacketContextManifest,
  validateRunContext
} from "./context-manifest.js";
import {
  isTrustedChangedSurfaceObservationResult,
  isTrustedProviderModelSelectionResult
} from "./auto-backend-runner.js";
import { createBoundaryPathRedactor, mergeRedactionMetadata } from "./redaction.js";
import { sanitizeWorkerResultForBoundary } from "./worker-result-redaction.js";

const READ_ONLY_ROLES = new Set(["explorer", "reviewer", "verifier"]);
const RUN_CONTEXT_ADMISSION_ERROR_PREFIX = "runtime context assembly invalid or drifted from contextManifest[]";
const DEFAULT_PROCESS_BACKEND_HEARTBEAT_INTERVAL_MS = 30_000;
export { RUN_CONTEXT_BUDGET_LIMITS };

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizePath(path) {
  return normalizeScopedPath(path);
}

function unique(values) {
  return [...new Set(values)];
}

function clone(value) {
  return safeClone(value);
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

  const normalized = {
    goal: input.goal.trim(),
    allowedFiles,
    forbiddenFiles: Array.isArray(input.forbiddenFiles) ? input.forbiddenFiles.map(normalizePath) : [],
    contextFiles: Array.isArray(input.contextFiles) ? input.contextFiles.map(normalizePath) : [],
    approvedHighRisk: parseBooleanFlag(input.approvedHighRisk, {
      flagName: "approvedHighRisk",
      defaultValue: false
    }),
    maxRepairLoops: input.maxRepairLoops ?? 1
  };

  if (Object.prototype.hasOwnProperty.call(input, "lane")) {
    normalized.lane = input.lane;
  }

  return normalized;
}

function normalizePlannedWorkflowInput(input) {
  assert(input && typeof input === "object", "planned workflow input must be an object");
  assert(input.workflow && typeof input.workflow === "object", "planned workflow input must include a workflow object");
  assert(typeof input.workflow.workflowId === "string" && input.workflow.workflowId.trim().length > 0, "workflow.workflowId must be a non-empty string");
  assert(typeof input.workflow.goal === "string" && input.workflow.goal.trim().length > 0, "workflow.goal must be a non-empty string");
  assert(Array.isArray(input.workflow.roleSequence), "workflow.roleSequence must be an array");
  assert(Array.isArray(input.workflow.packets), "workflow.packets must be an array");

  const workflow = clone(input.workflow);
  workflow.packets = workflow.packets.map((packet, index) => {
    try {
      return validateTaskPacket(packet);
    } catch (error) {
      throw new Error(`workflow.packets[${index}] ${toErrorMessage(error)}`);
    }
  });
  const userSuppliedWorkflowLane = Object.prototype.hasOwnProperty.call(workflow, "lane");
  const packetLanes = unique(workflow.packets
    .filter((packet) => Object.prototype.hasOwnProperty.call(packet, "lane"))
    .map((packet) => packet.lane));
  if (!userSuppliedWorkflowLane && packetLanes.length > 1) {
    throw new Error("workflow.packets[].lane values must not conflict");
  }
  if (userSuppliedWorkflowLane && packetLanes.some((lane) => lane !== workflow.lane)) {
    throw new Error("workflow.packets[].lane must match workflow.lane");
  }
  const allowedFiles = unique(workflow.packets.flatMap((packet) => (
    Array.isArray(packet.allowedFiles) ? packet.allowedFiles : []
  )));
  workflow.lane = resolveTaskLane({
    goal: workflow.goal,
    allowedFiles,
    lane: userSuppliedWorkflowLane ? workflow.lane : packetLanes[0],
    hasUserSuppliedLane: userSuppliedWorkflowLane || packetLanes.length === 1
  });
  if (laneRequiresHumanGate(workflow.lane) && workflow.humanGate !== true) {
    throw new Error("workflow.humanGate must be true for human-gated task lanes");
  }
  if (
    laneRequiresIndependentReview(workflow.lane) &&
    (
      !workflow.roleSequence.includes("reviewer") ||
      !workflow.packets.some((packet) => packet.role === "reviewer")
    )
  ) {
    throw new Error("workflow.roleSequence and workflow.packets must include reviewer for review-gated task lanes");
  }
  workflow.packets = workflow.packets.map((packet) => ({
    ...packet,
    lane: workflow.lane
  }));

  return {
    workflow,
    approvedHighRisk: parseBooleanFlag(input.approvedHighRisk, {
      flagName: "approvedHighRisk",
      defaultValue: false
    }),
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

function sanitizePriorResults(runs, { redactor }) {
  return runs.map(({ packet, result }) => {
    const fieldPrefix = `priorResults[${packet.id}]`;
    const summary = redactor.redactString(result.summary, {
      fieldName: `${fieldPrefix}.summary`
    });
    const changedFiles = redactor.redactStringArray(clone(result.changedFiles), {
      fieldName: `${fieldPrefix}.changedFiles`
    });
    const commandsRun = redactor.redactStringArray(clone(result.commandsRun), {
      fieldName: `${fieldPrefix}.commandsRun`
    });
    const evidence = redactor.redactStringArray(clone(result.evidence), {
      fieldName: `${fieldPrefix}.evidence`
    });
    const openQuestions = redactor.redactStringArray(clone(result.openQuestions), {
      fieldName: `${fieldPrefix}.openQuestions`
    });
    const sanitizedRecon = Object.prototype.hasOwnProperty.call(result, "recon")
      ? sanitizeReconArtifactForBoundary(result.recon, {
        redactor,
        fieldName: `${fieldPrefix}.recon`
      })
      : {
        recon: undefined,
        redaction: undefined
      };
    const redaction = mergeRedactionMetadata(
      result.redaction,
      summary.redaction,
      changedFiles.redaction,
      commandsRun.redaction,
      evidence.redaction,
      openQuestions.redaction,
      sanitizedRecon.redaction
    );

    return {
      packetId: packet.id,
      role: packet.role,
      status: result.status,
      summary: summary.value,
      changedFiles: changedFiles.values,
      commandsRun: commandsRun.values,
      evidence: evidence.values,
      openQuestions: openQuestions.values,
      ...(sanitizedRecon.recon !== undefined ? { recon: sanitizedRecon.recon } : {}),
      redaction
    };
  });
}

function createContextBudget() {
  return {
    priorResultsTruncated: false,
    truncatedPriorResultPacketIds: [],
    perResultEvidenceTruncated: false,
    perResultCommandsTruncated: false,
    perResultChangedFilesTruncated: false,
    perResultOpenQuestionsTruncated: false,
    reviewResultTruncated: false,
    changedSurfaceTruncated: false,
    promptContextTruncated: false,
    truncationCount: {
      priorResults: 0,
      evidenceEntries: 0,
      commandEntries: 0,
      changedFiles: 0,
      openQuestionEntries: 0,
      reviewResultEvidenceEntries: 0,
      reviewResultOpenQuestionEntries: 0,
      changedSurfacePaths: 0,
      promptContextChars: 0
    }
  };
}

function truncateStringArray(values, maxEntries) {
  if (!Array.isArray(values)) {
    return [];
  }

  if (values.length <= maxEntries) {
    return clone(values);
  }

  return clone(values.slice(0, maxEntries));
}

function applyPriorResultContextBudget(priorResults) {
  const budget = createContextBudget();
  let boundedPriorResults = Array.isArray(priorResults) ? clone(priorResults) : [];

  if (boundedPriorResults.length > RUN_CONTEXT_BUDGET_LIMITS.maxPriorResults) {
    const droppedResults = boundedPriorResults.slice(
      0,
      boundedPriorResults.length - RUN_CONTEXT_BUDGET_LIMITS.maxPriorResults
    );
    budget.priorResultsTruncated = true;
    budget.truncatedPriorResultPacketIds = droppedResults
      .map((entry) => entry?.packetId)
      .filter((packetId) => typeof packetId === "string" && packetId.trim().length > 0)
      .slice(0, RUN_CONTEXT_BUDGET_LIMITS.maxTruncatedPriorResultPacketIds);
    budget.truncationCount.priorResults = droppedResults.length;
    boundedPriorResults = boundedPriorResults.slice(-RUN_CONTEXT_BUDGET_LIMITS.maxPriorResults);
  }

  boundedPriorResults = boundedPriorResults.map((priorResult) => {
    const bounded = {
      ...clone(priorResult),
      changedFiles: truncateStringArray(
        priorResult?.changedFiles,
        RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultChangedFiles
      ),
      commandsRun: truncateStringArray(
        priorResult?.commandsRun,
        RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultCommands
      ),
      evidence: truncateStringArray(
        priorResult?.evidence,
        RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultEvidence
      ),
      openQuestions: truncateStringArray(
        priorResult?.openQuestions,
        RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultOpenQuestions
      )
    };

    const changedFilesLength = Array.isArray(priorResult?.changedFiles) ? priorResult.changedFiles.length : 0;
    const commandLength = Array.isArray(priorResult?.commandsRun) ? priorResult.commandsRun.length : 0;
    const evidenceLength = Array.isArray(priorResult?.evidence) ? priorResult.evidence.length : 0;
    const openQuestionLength = Array.isArray(priorResult?.openQuestions) ? priorResult.openQuestions.length : 0;

    if (changedFilesLength > RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultChangedFiles) {
      budget.perResultChangedFilesTruncated = true;
      budget.truncationCount.changedFiles += (
        changedFilesLength - RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultChangedFiles
      );
    }

    if (commandLength > RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultCommands) {
      budget.perResultCommandsTruncated = true;
      budget.truncationCount.commandEntries += (
        commandLength - RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultCommands
      );
    }

    if (evidenceLength > RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultEvidence) {
      budget.perResultEvidenceTruncated = true;
      budget.truncationCount.evidenceEntries += (
        evidenceLength - RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultEvidence
      );
    }

    if (openQuestionLength > RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultOpenQuestions) {
      budget.perResultOpenQuestionsTruncated = true;
      budget.truncationCount.openQuestionEntries += (
        openQuestionLength - RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultOpenQuestions
      );
    }

    return bounded;
  });

  return {
    priorResults: boundedPriorResults,
    contextBudget: budget
  };
}

function sanitizeReviewResult(reviewResult, { redactor, contextBudget }) {
  if (!reviewResult) {
    return null;
  }

  const maxReviewEvidence = RUN_CONTEXT_BUDGET_LIMITS.maxReviewResultEvidence;
  const maxReviewOpenQuestions = RUN_CONTEXT_BUDGET_LIMITS.maxReviewResultOpenQuestions;
  const reviewEvidenceLength = Array.isArray(reviewResult?.evidence) ? reviewResult.evidence.length : 0;
  const reviewOpenQuestionLength = Array.isArray(reviewResult?.openQuestions) ? reviewResult.openQuestions.length : 0;
  const boundedEvidence = truncateStringArray(reviewResult?.evidence, maxReviewEvidence);
  const boundedOpenQuestions = truncateStringArray(reviewResult?.openQuestions, maxReviewOpenQuestions);

  if (reviewEvidenceLength > maxReviewEvidence) {
    contextBudget.reviewResultTruncated = true;
    contextBudget.truncationCount.reviewResultEvidenceEntries += reviewEvidenceLength - maxReviewEvidence;
  }

  if (reviewOpenQuestionLength > maxReviewOpenQuestions) {
    contextBudget.reviewResultTruncated = true;
    contextBudget.truncationCount.reviewResultOpenQuestionEntries += (
      reviewOpenQuestionLength - maxReviewOpenQuestions
    );
  }

  const fieldPrefix = "reviewResult";
  const summary = redactor.redactString(reviewResult.summary, {
    fieldName: `${fieldPrefix}.summary`
  });
  const evidence = redactor.redactStringArray(boundedEvidence, {
    fieldName: `${fieldPrefix}.evidence`
  });
  const openQuestions = redactor.redactStringArray(boundedOpenQuestions, {
    fieldName: `${fieldPrefix}.openQuestions`
  });
  const redaction = mergeRedactionMetadata(
    reviewResult.redaction,
    summary.redaction,
    evidence.redaction,
    openQuestions.redaction
  );

  return {
    status: reviewResult.status,
    summary: summary.value,
    evidence: evidence.values,
    openQuestions: openQuestions.values,
    redaction
  };
}

function resolvePacketContextManifest(packet) {
  return resolveCanonicalPacketContextManifest({
    contextFiles: packet.contextFiles ?? [],
    contextManifest: packet.contextManifest,
    contextFilesFieldName: "packet.contextFiles",
    contextManifestFieldName: "packet.contextManifest"
  });
}

function sanitizeChangedSurfaceContext(runs, { contextBudget }) {
  const changedSurfaceContext = [];
  const maxChangedSurfacePaths = RUN_CONTEXT_BUDGET_LIMITS.maxChangedSurfacePaths;

  for (const run of runs) {
    if (run?.provenance?.changedSurfaceObservationTrusted !== true) {
      continue;
    }

    const packetId = typeof run?.packet?.id === "string" && run.packet.id.trim().length > 0
      ? run.packet.id
      : null;
    const role = typeof run?.packet?.role === "string" && run.packet.role.trim().length > 0
      ? run.packet.role
      : null;
    if (!packetId || !role) {
      continue;
    }

    const observation = run?.result?.changedSurfaceObservation;
    if (!observation || observation.capture !== "complete") {
      continue;
    }

    const observedPaths = Array.isArray(observation.paths)
      ? unique(
        observation.paths
          .filter((pathValue) => typeof pathValue === "string" && pathValue.trim().length > 0)
          .map(normalizePath)
      )
      : [];
    if (observedPaths.length === 0) {
      continue;
    }

    let boundedObservedPaths = observedPaths;
    if (observedPaths.length > maxChangedSurfacePaths) {
      contextBudget.changedSurfaceTruncated = true;
      contextBudget.truncationCount.changedSurfacePaths += observedPaths.length - maxChangedSurfacePaths;
      boundedObservedPaths = observedPaths.slice(0, maxChangedSurfacePaths);
    }

    changedSurfaceContext.push({
      packetId,
      role,
      paths: clone(boundedObservedPaths)
    });
  }

  return changedSurfaceContext;
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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

function normalizeHeartbeatIntervalMs(value) {
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_PROCESS_BACKEND_HEARTBEAT_INTERVAL_MS;
}

function resolveSelectedBackend(runner, packet, context) {
  if (typeof runner?.getSelectedBackend !== "function") {
    return null;
  }

  try {
    const selectedBackend = runner.getSelectedBackend(packet, context);
    return typeof selectedBackend === "string" && selectedBackend.trim().length > 0
      ? selectedBackend.trim()
      : null;
  } catch {
    return null;
  }
}

function resolveTimeoutBudgetMs(runner, packet, context) {
  if (typeof runner?.getTimeoutBudgetMs !== "function") {
    return null;
  }

  try {
    const timeoutBudgetMs = runner.getTimeoutBudgetMs(packet, context);
    return Number.isInteger(timeoutBudgetMs) && timeoutBudgetMs > 0
      ? timeoutBudgetMs
      : null;
  } catch {
    return null;
  }
}

function progressContextIds(baseContext) {
  return {
    programId: typeof baseContext?.programId === "string" ? baseContext.programId : null,
    contractId: typeof baseContext?.contractId === "string"
      ? baseContext.contractId
      : typeof baseContext?.currentContractId === "string"
        ? baseContext.currentContractId
        : null
  };
}

function createProcessBackendHeartbeat({
  onProgress,
  packet,
  workflow,
  iteration,
  repairCount,
  selectedBackend,
  timeoutBudgetMs,
  baseContext,
  heartbeatIntervalMs
}) {
  if (typeof onProgress !== "function" || selectedBackend !== "process_backend") {
    return () => {};
  }

  const startedAt = Date.now();
  const intervalHandle = setInterval(() => {
    void emitProgress(onProgress, {
      type: "packet_heartbeat",
      packetId: packet.id,
      role: packet.role,
      workflowId: workflow.workflowId,
      ...progressContextIds(baseContext),
      iteration,
      repairCount,
      selectedBackend,
      elapsedMs: Date.now() - startedAt,
      timeoutBudgetMs
    });
  }, normalizeHeartbeatIntervalMs(heartbeatIntervalMs));
  if (typeof intervalHandle.unref === "function") {
    intervalHandle.unref();
  }

  return () => {
    clearInterval(intervalHandle);
  };
}

function resolveContextRepositoryRoot() {
  return process.cwd();
}

function sanitizeWorkflowWorkerResult(result) {
  const repositoryRoot = resolveContextRepositoryRoot();
  const sanitizedResult = sanitizeWorkerResultForBoundary(result, {
    repositoryRoot,
    mergeExistingRedaction: true
  });
  if (!Object.prototype.hasOwnProperty.call(sanitizedResult, "recon")) {
    return sanitizedResult;
  }

  const redactor = createBoundaryPathRedactor({
    repositoryRoot
  });
  const sanitizedRecon = sanitizeReconArtifactForBoundary(sanitizedResult.recon, {
    redactor,
    fieldName: "result.recon"
  });

  return {
    ...sanitizedResult,
    recon: sanitizedRecon.recon,
    redaction: mergeRedactionMetadata(
      sanitizedResult.redaction,
      sanitizedRecon.redaction
    )
  };
}

function toContextAdmissionFailureReason(error) {
  const message = toErrorMessage(error);

  if (message.includes(RUN_CONTEXT_ADMISSION_ERROR_PREFIX)) {
    return message;
  }

  return `${RUN_CONTEXT_ADMISSION_ERROR_PREFIX}: ${message}`;
}

function createExecutionFailureResult({
  packet,
  failureKind,
  reason,
  priorResult = null
}) {
  const priorCommands = Array.isArray(priorResult?.commandsRun) ? priorResult.commandsRun : [];
  const priorEvidence = Array.isArray(priorResult?.evidence) ? priorResult.evidence : [];
  const priorQuestions = Array.isArray(priorResult?.openQuestions) ? priorResult.openQuestions : [];

  return {
    status: "failed",
    summary: `${packet.role} ${failureKind} failed safely: ${reason}`,
    changedFiles: [],
    commandsRun: clone(priorCommands),
    evidence: unique([
      ...priorEvidence,
      `${failureKind}_failure: ${reason}`
    ]),
    openQuestions: unique([
      ...priorQuestions,
      `Inspect ${packet.role} packet ${packet.id} for ${failureKind} violations.`
    ])
  };
}

function buildRunContext({ workflow, packet, runs, repairCount, reviewResult, baseContext = {} }) {
  const repositoryRoot = resolveContextRepositoryRoot();
  const redactor = createBoundaryPathRedactor({
    repositoryRoot
  });
  const sanitizedPriorResults = sanitizePriorResults(runs, {
    redactor
  });
  const {
    priorResults,
    contextBudget
  } = applyPriorResultContextBudget(sanitizedPriorResults);
  const normalizedReviewResult = sanitizeReviewResult(reviewResult, {
    redactor,
    contextBudget
  });
  const changedSurfaceContext = sanitizeChangedSurfaceContext(runs, {
    contextBudget
  });
  const contextManifest = mergeContextManifestEntries(
    resolvePacketContextManifest(packet),
    buildPriorResultContextManifest(priorResults, {
      includeMetadata: true
    }),
    buildReviewResultContextManifest(normalizedReviewResult, {
      includeMetadata: true
    }),
    buildChangedSurfaceContextManifest(changedSurfaceContext, {
      includeMetadata: true
    })
  );

  const runContext = {
    ...clone(baseContext),
    workflowId: workflow.workflowId,
    goal: workflow.goal,
    risk: workflow.risk,
    roleSequence: clone(workflow.roleSequence),
    repairCount,
    contextManifest,
    priorResults,
    reviewResult: normalizedReviewResult,
    changedSurfaceContext,
    contextBudget
  };
  const forwardedRedactionMetadata = {
    priorResults: priorResults.map((priorResult) => priorResult?.redaction),
    reviewResult: normalizedReviewResult?.redaction,
    contextBudgetTruncation: {
      reviewResultEvidenceEntries: contextBudget.truncationCount.reviewResultEvidenceEntries,
      reviewResultOpenQuestionEntries: contextBudget.truncationCount.reviewResultOpenQuestionEntries,
      changedSurfacePaths: contextBudget.truncationCount.changedSurfacePaths
    }
  };

  const normalizedRunContext = validateRunContext({
    packetContextFiles: packet.contextFiles ?? [],
    contextManifest: runContext.contextManifest,
    priorResults: runContext.priorResults,
    reviewResult: runContext.reviewResult,
    changedSurfaceContext: runContext.changedSurfaceContext,
    contextBudget: runContext.contextBudget,
    forwardedRedactionMetadata,
    repositoryRoot,
    fieldName: "context"
  });

  const normalizedContext = {
    ...runContext,
    contextManifest: normalizedRunContext.contextManifest,
    contextBudget: normalizedRunContext.contextBudget ?? runContext.contextBudget
  };
  setTrustedForwardedRedactionMetadata(normalizedContext, forwardedRedactionMetadata);
  setTrustedRuntimeRepositoryRoot(normalizedContext, repositoryRoot, {
    fieldName: "context.repositoryRoot"
  });
  return normalizedContext;
}

function validateChangedFiles(packet, result) {
  const changedFiles = result.changedFiles.map(normalizePath);
  const allowedFiles = packet.allowedFiles.map(normalizePath);
  const forbiddenFiles = packet.forbiddenFiles.map(normalizePath);

  if (READ_ONLY_ROLES.has(packet.role) && changedFiles.length > 0) {
    throw new Error(`${packet.role} is read-only and must not report changed files: ${changedFiles.join(", ")}`);
  }

  for (const changedFile of changedFiles) {
    assert(
      allowedFiles.some((scopeEntry) => isPathWithinScope(changedFile, scopeEntry)),
      `${packet.role} reported a file outside its allowlist: ${changedFile}`
    );
    assert(
      !forbiddenFiles.some((scopeEntry) => isPathWithinScope(changedFile, scopeEntry)),
      `${packet.role} reported a forbidden file: ${changedFile}`
    );
  }
}

function validateReconResult(packet, result) {
  if (!Object.prototype.hasOwnProperty.call(result ?? {}, "recon")) {
    return;
  }

  result.recon = normalizeReconArtifact(result.recon, {
    fieldName: "result.recon"
  });
  assert(
    READ_ONLY_ROLES.has(packet.role),
    "recon artifacts are read-only and may only be reported by read-only roles"
  );
  assert(
    Array.isArray(result.changedFiles) && result.changedFiles.length === 0,
    "recon artifacts are read-only and require changedFiles to be empty"
  );
}

async function executePacket({
  runner,
  packet,
  workflow,
  runs,
  repairCount,
  reviewResult = null,
  iteration = 0,
  baseContext = {},
  onProgress = null,
  heartbeatIntervalMs = DEFAULT_PROCESS_BACKEND_HEARTBEAT_INTERVAL_MS
}) {
  await emitProgress(onProgress, {
    type: "packet_start",
    packetId: packet.id,
    role: packet.role,
    workflowId: workflow.workflowId,
    ...progressContextIds(baseContext),
    iteration,
    repairCount
  });

  let context;

  try {
    context = buildRunContext({
      workflow,
      packet,
      runs,
      repairCount,
      reviewResult,
      baseContext
    });
  } catch (error) {
    const result = createExecutionFailureResult({
      packet,
      failureKind: "context_admission",
      reason: toContextAdmissionFailureReason(error)
    });
    result = sanitizeWorkflowWorkerResult(result);
    const run = {
      packet: clone(packet),
      result: clone(result),
      provenance: {
        changedSurfaceObservationTrusted: false,
        providerModelSelectionTrusted: false
      },
      iteration
    };

    runs.push(run);
    await emitProgress(onProgress, {
      type: "packet_finish",
      packetId: packet.id,
      role: packet.role,
      workflowId: workflow.workflowId,
      ...progressContextIds(baseContext),
      iteration,
      repairCount,
      status: result.status,
      summary: result.summary
    });
    return run;
  }

  let result;
  let changedSurfaceObservationTrusted = false;
  let providerModelSelectionTrusted = false;
  const selectedBackend = resolveSelectedBackend(runner, packet, context);
  const timeoutBudgetMs = resolveTimeoutBudgetMs(runner, packet, context);
  const stopHeartbeat = createProcessBackendHeartbeat({
    onProgress,
    packet,
    workflow,
    iteration,
    repairCount,
    selectedBackend,
    timeoutBudgetMs,
    baseContext,
    heartbeatIntervalMs
  });

  try {
    result = await runner.run(packet, context);
    changedSurfaceObservationTrusted = isTrustedChangedSurfaceObservationResult(result);
    providerModelSelectionTrusted = isTrustedProviderModelSelectionResult(result);
  } catch (error) {
    result = createExecutionFailureResult({
      packet,
      failureKind: "runner",
      reason: toErrorMessage(error)
    });
  } finally {
    stopHeartbeat();
  }

  try {
    validateReconResult(packet, result);
    validateChangedFiles(packet, result);
  } catch (error) {
    const preservedChangedSurfaceObservation = (
      changedSurfaceObservationTrusted === true
      && result?.changedSurfaceObservation
    )
      ? clone(result.changedSurfaceObservation)
      : null;
    result = createExecutionFailureResult({
      packet,
      failureKind: "validation",
      reason: toErrorMessage(error),
      priorResult: result
    });
    if (preservedChangedSurfaceObservation) {
      result.changedSurfaceObservation = preservedChangedSurfaceObservation;
      changedSurfaceObservationTrusted = true;
    } else {
      changedSurfaceObservationTrusted = false;
    }
    providerModelSelectionTrusted = false;
  }

  result = sanitizeWorkflowWorkerResult(result);
  const run = {
    packet: clone(packet),
    result: clone(result),
    provenance: {
      changedSurfaceObservationTrusted,
      providerModelSelectionTrusted
    },
    iteration
  };

  runs.push(run);
  await emitProgress(onProgress, {
    type: "packet_finish",
    packetId: packet.id,
    role: packet.role,
    workflowId: workflow.workflowId,
    ...progressContextIds(baseContext),
    iteration,
    repairCount,
    status: result.status,
    summary: result.summary
  });
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

function mergeStringFields(...values) {
  return unique(
    values
      .flatMap((value) => Array.isArray(value) ? value : [])
      .filter((value) => typeof value === "string" && value.trim().length > 0)
  );
}

function findWorkflowPacket(workflow, role) {
  return Array.isArray(workflow?.packets)
    ? workflow.packets.find((candidate) => candidate?.role === role) ?? null
    : null;
}

function normalizeOptionalRepairText(value, fallback) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function isWithinAnyScope(pathValue, scopeEntries) {
  return scopeEntries.some((scopeEntry) => isPathWithinScope(pathValue, scopeEntry));
}

function resolveRepairTargetFiles(finding, originalAllowedFiles) {
  if (typeof finding?.path !== "string" || finding.path.trim().length === 0) {
    return [];
  }

  const targetFile = normalizePath(finding.path);
  return isWithinAnyScope(targetFile, originalAllowedFiles) ? [targetFile] : [];
}

function concreteRepairCommands(values) {
  return unique(
    values
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim())
      .filter((value) => !value.startsWith("<"))
  );
}

function createRepairContractForbiddenChanges({ targetFiles, originalAllowedFiles, originalForbiddenFiles }) {
  return unique([
    "Do not modify files outside the repair packet allowedFiles.",
    ...(targetFiles.length > 0
      ? [`Limit code changes for this finding to: ${targetFiles.join(", ")}.`]
      : ["Do not widen beyond the original packet allowlist when no finding target file is known."]),
    ...originalForbiddenFiles.map((pathValue) => `Do not modify forbidden scope: ${pathValue}.`),
    `Original packet allowlist boundary: ${originalAllowedFiles.join(", ")}.`
  ]);
}

function buildRepairContracts({ workflow, reviewerPacket, reviewResult, repairCount }) {
  const originalAllowedFiles = reviewerPacket.allowedFiles.map(normalizePath);
  const originalForbiddenFiles = reviewerPacket.forbiddenFiles.map(normalizePath);
  const reviewFindings = Array.isArray(reviewResult?.reviewFindings)
    ? reviewResult.reviewFindings
    : [];
  const findings = reviewFindings.length > 0
    ? reviewFindings
    : [
      {
        kind: "issue",
        severity: "medium",
        message: "Resolve the blocking reviewer result without widening the original packet scope."
      }
    ];
  const sourcePackets = [
    findWorkflowPacket(workflow, "implementer"),
    reviewerPacket,
    findWorkflowPacket(workflow, "verifier")
  ].filter(Boolean);
  const expectedVerification = concreteRepairCommands([
    ...sourcePackets.flatMap((sourcePacket) => sourcePacket.commands ?? []),
    ...(Array.isArray(reviewResult?.commandsRun) ? reviewResult.commandsRun : [])
  ]);

  const contracts = findings.map((finding, index) => {
    const targetFiles = resolveRepairTargetFiles(finding, originalAllowedFiles);
    return {
      findingId: `${reviewerPacket.id}-repair-${repairCount}-finding-${index + 1}`,
      targetFiles,
      requiredCorrection: normalizeOptionalRepairText(
        finding.message,
        "Resolve the blocking reviewer finding."
      ),
      forbiddenChanges: createRepairContractForbiddenChanges({
        targetFiles,
        originalAllowedFiles,
        originalForbiddenFiles
      }),
      expectedVerification
    };
  });

  const targetedAllowedFiles = unique(contracts.flatMap((contract) => contract.targetFiles));
  const repairAllowedFiles = targetedAllowedFiles.length > 0
    ? targetedAllowedFiles
    : originalAllowedFiles;
  assert(
    repairAllowedFiles.every((pathValue) => isWithinAnyScope(pathValue, originalAllowedFiles)),
    "repair packet scope must not exceed the original packet allowlist"
  );

  return {
    contracts,
    repairAllowedFiles,
    originalAllowedFiles
  };
}

function repairContractAcceptanceChecks(repairContracts) {
  return repairContracts.flatMap((contract) => [
    `Repair finding ${contract.findingId}: ${contract.requiredCorrection}`,
    ...(contract.targetFiles.length > 0
      ? [`Repair finding ${contract.findingId} target files: ${contract.targetFiles.join(", ")}`]
      : [`Repair finding ${contract.findingId} target files: not specified by reviewer; keep original scope bounded.`]),
    ...(contract.expectedVerification.length > 0
      ? [`Repair finding ${contract.findingId} expected verification: ${contract.expectedVerification.join(" | ")}`]
      : [])
  ]);
}

function repairContractNonGoals(repairContracts) {
  return repairContracts.flatMap((contract) => (
    contract.forbiddenChanges.map((forbiddenChange) => (
      `Repair finding ${contract.findingId}: ${forbiddenChange}`
    ))
  ));
}

function mergeRepairPacketGuards(repairPacket, sourcePackets) {
  const sourcePacketList = sourcePackets.filter(Boolean);
  const mergedContextFiles = mergeStringFields(
    ...sourcePacketList.map((sourcePacket) => sourcePacket.contextFiles),
    repairPacket.contextFiles
  );

  return validateTaskPacket({
    ...repairPacket,
    nonGoals: mergeStringFields(
      ...sourcePacketList.map((sourcePacket) => sourcePacket.nonGoals),
      repairPacket.nonGoals
    ),
    acceptanceChecks: mergeStringFields(
      ...sourcePacketList.map((sourcePacket) => sourcePacket.acceptanceChecks),
      repairPacket.acceptanceChecks
    ),
    stopConditions: mergeStringFields(
      ...sourcePacketList.map((sourcePacket) => sourcePacket.stopConditions),
      repairPacket.stopConditions
    ),
    commands: mergeStringFields(
      ...sourcePacketList.map((sourcePacket) => sourcePacket.commands),
      repairPacket.commands
    ),
    contextFiles: mergedContextFiles,
    contextManifest: resolveCanonicalPacketContextManifest({
      contextFiles: mergedContextFiles,
      contextManifest: undefined,
      contextFilesFieldName: "repairPacket.contextFiles",
      contextManifestFieldName: "repairPacket.contextManifest"
    })
  });
}

export function summarizeWorkflowLaunchSelection(execution) {
  if (!execution || !Array.isArray(execution.runs)) {
    return null;
  }

  const roleSelections = new Map();
  for (const run of execution.runs) {
    const selection = run?.result?.providerModelSelection;
    if (run?.provenance?.providerModelSelectionTrusted !== true || !selection) {
      continue;
    }
    const selectedProvider = selection.selectedProvider;
    const selectedModel = selection.selectedModel;

    if (selectedProvider || selectedModel) {
      roleSelections.set(run.packet.role, {
        provider: selectedProvider,
        model: selectedModel
      });
    }
  }

  if (roleSelections.size === 0) {
    return null;
  }

  const workflowRoles = Array.isArray(execution?.workflow?.roleSequence)
    ? execution.workflow.roleSequence
    : [];
  const orderedRoles = [
    ...workflowRoles,
    ...[...roleSelections.keys()].filter((role) => !workflowRoles.includes(role))
  ];
  const uniqueProviders = unique(
    [...roleSelections.values()]
      .map((selection) => selection.provider)
      .filter((provider) => typeof provider === "string" && provider.length > 0)
  );

  const roleSummaries = orderedRoles
    .filter((role) => roleSelections.has(role))
    .map((role) => {
      const selection = roleSelections.get(role);
      if (uniqueProviders.length === 1 && selection.model) {
        return `${role}=${selection.model}`;
      }

      if (selection.provider && selection.model) {
        return `${role}=${selection.provider}/${selection.model}`;
      }

      return `${role}=${selection.model ?? selection.provider ?? "unknown"}`;
    });

  if (roleSummaries.length === 0) {
    return null;
  }

  if (uniqueProviders.length === 1) {
    return `${uniqueProviders[0]} (${roleSummaries.join(", ")})`;
  }

  return roleSummaries.join(", ");
}

function createRepairPacket({ workflow, packet, role, repairCount, reviewResult }) {
  const repairContractPacket = buildRepairContracts({
    workflow,
    reviewerPacket: packet,
    reviewResult,
    repairCount
  });
  const repairPacket = buildTaskPacket({
    goal: `${role === "implementer" ? "Apply scoped repair contracts for" : "Re-review scoped repair contracts for"}: ${workflow.goal}`,
    role,
    allowedFiles: repairContractPacket.repairAllowedFiles,
    forbiddenFiles: packet.forbiddenFiles,
    parentTaskId: `${workflow.workflowId}-repair-${repairCount}`,
    risk: workflow.risk,
    contextFiles: unique([
      ...packet.contextFiles,
      ...repairContractPacket.repairAllowedFiles
    ])
  });

  repairPacket.id = `${repairPacket.id}-repair-${repairCount}`;
  repairPacket.repairContracts = clone(repairContractPacket.contracts);
  repairPacket.repairScope = {
    originalAllowedFiles: clone(repairContractPacket.originalAllowedFiles),
    allowedFiles: clone(repairContractPacket.repairAllowedFiles)
  };
  repairPacket.acceptanceChecks = mergeStringFields(
    repairPacket.acceptanceChecks,
    repairContractAcceptanceChecks(repairContractPacket.contracts)
  );
  repairPacket.nonGoals = mergeStringFields(
    repairPacket.nonGoals,
    repairContractNonGoals(repairContractPacket.contracts)
  );
  repairPacket.commands = mergeStringFields(
    repairPacket.commands,
    ...repairContractPacket.contracts.map((contract) => contract.expectedVerification)
  );
  const originalRolePacket = findWorkflowPacket(workflow, role);
  const originalImplementerPacket = findWorkflowPacket(workflow, "implementer");
  return mergeRepairPacketGuards(repairPacket, [
    originalImplementerPacket,
    originalRolePacket,
    packet
  ]);
}

async function runRepairLoop({
  runner,
  workflow,
  reviewerPacket,
  reviewResult,
  runs,
  repairCount,
  baseContext,
  onProgress,
  heartbeatIntervalMs
}) {
  const implementerPacket = createRepairPacket({
    workflow,
    packet: reviewerPacket,
    role: "implementer",
    repairCount,
    reviewResult
  });
  const repairRun = await executePacket({
    runner,
    packet: implementerPacket,
    workflow,
    runs,
    repairCount,
    iteration: repairCount,
    baseContext,
    onProgress,
    heartbeatIntervalMs
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
    repairCount,
    reviewResult
  });
  const rereviewRun = await executePacket({
    runner,
    packet: rereviewPacket,
    workflow,
    runs,
    repairCount,
    reviewResult: repairRun.result,
    iteration: repairCount,
    baseContext,
    onProgress,
    heartbeatIntervalMs
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

export async function runPlannedWorkflow(input, {
  runner,
  onProgress = null,
  heartbeatIntervalMs = DEFAULT_PROCESS_BACKEND_HEARTBEAT_INTERVAL_MS
} = {}) {
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
      baseContext,
      onProgress,
      heartbeatIntervalMs
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
        reviewResult: run.result,
        runs,
        repairCount,
        baseContext,
        onProgress,
        heartbeatIntervalMs
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

export async function runAutoWorkflow(input, {
  runner,
  onProgress = null,
  heartbeatIntervalMs = DEFAULT_PROCESS_BACKEND_HEARTBEAT_INTERVAL_MS
} = {}) {
  let normalizedInput;
  let workflow;

  try {
    normalizedInput = normalizeWorkflowInput(input);
  } catch (error) {
    return blockedInputExecution({
      goal: input?.goal,
      maxRepairLoops: input?.maxRepairLoops,
      stopReason: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    const workflowInput = {
      goal: normalizedInput.goal,
      allowedFiles: normalizedInput.allowedFiles,
      forbiddenFiles: normalizedInput.forbiddenFiles,
      contextFiles: normalizedInput.contextFiles
    };
    if (Object.prototype.hasOwnProperty.call(normalizedInput, "lane")) {
      workflowInput.lane = normalizedInput.lane;
    }
    workflow = createInitialWorkflow(workflowInput);
  } catch (error) {
    return blockedInputExecution({
      goal: normalizedInput.goal,
      maxRepairLoops: normalizedInput.maxRepairLoops,
      stopReason: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    assertRepairBudget(normalizedInput.maxRepairLoops);
  } catch (error) {
    return blockedInputExecution({
      goal: normalizedInput.goal,
      maxRepairLoops: normalizedInput.maxRepairLoops,
      stopReason: error instanceof Error ? error.message : String(error)
    });
  }

  return runPlannedWorkflow({
    workflow,
    approvedHighRisk: normalizedInput.approvedHighRisk,
    maxRepairLoops: normalizedInput.maxRepairLoops
  }, { runner, onProgress, heartbeatIntervalMs });
}

export function formatWorkflowExecution(execution) {
  const launchSelectionSummary = summarizeWorkflowLaunchSelection(execution);
  const lines = [
    `workflow: ${execution.workflow.workflowId}`,
    `status: ${execution.status}`,
    `risk: ${execution.workflow.risk}`,
    ...(execution.workflow.lane ? [`lane: ${execution.workflow.lane}`] : []),
    `human_gate: ${execution.workflow.humanGate ? "required" : "not-required"}`,
    `repair_loops: ${execution.repairCount}/${execution.maxRepairLoops}`,
    `stop_reason: ${execution.stopReason ?? "none"}`,
    `launch_selection: ${launchSelectionSummary ?? "none"}`,
    "runs:"
  ];

  if (execution.runs.length === 0) {
    lines.push("- none");
  } else {
    for (const run of execution.runs) {
      lines.push(`- ${run.packet.role} (${run.result.status}): ${run.result.summary}`);
      if (run.result.commandsRun.length > 0) {
        lines.push(`  commands: ${run.result.commandsRun.join(" | ")}`);
      }
      if (run.result.evidence.length > 0) {
        lines.push("  evidence:");
        for (const evidence of run.result.evidence) {
          lines.push(`  - ${evidence}`);
        }
      }
      if (run.result.openQuestions.length > 0) {
        lines.push("  open_questions:");
        for (const openQuestion of run.result.openQuestions) {
          lines.push(`  - ${openQuestion}`);
        }
      }
    }
  }

  return lines.join("\n");
}
