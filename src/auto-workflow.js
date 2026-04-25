import { buildTaskPacket, createInitialWorkflow } from "./orchestrator.js";
import { parseBooleanFlag } from "./boolean-flags.js";
import { isPathWithinScope, normalizeScopedPath } from "./path-scopes.js";
import { safeClone } from "./safe-clone.js";
import { validateTaskPacket } from "./contracts.js";
import {
  buildChangedSurfaceContextManifest,
  buildPriorResultContextManifest,
  buildReviewResultContextManifest,
  RUN_CONTEXT_BUDGET_LIMITS,
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

  return {
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
    const redaction = mergeRedactionMetadata(
      summary.redaction,
      changedFiles.redaction,
      commandsRun.redaction,
      evidence.redaction,
      openQuestions.redaction
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
    reviewResultTruncated: false,
    changedSurfaceTruncated: false,
    truncationCount: {
      priorResults: 0,
      evidenceEntries: 0,
      commandEntries: 0,
      changedFiles: 0,
      reviewResultEvidenceEntries: 0,
      reviewResultOpenQuestionEntries: 0,
      changedSurfacePaths: 0
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
      .filter((packetId) => typeof packetId === "string" && packetId.trim().length > 0);
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
      openQuestions: clone(priorResult?.openQuestions)
    };

    const changedFilesLength = Array.isArray(priorResult?.changedFiles) ? priorResult.changedFiles.length : 0;
    const commandLength = Array.isArray(priorResult?.commandsRun) ? priorResult.commandsRun.length : 0;
    const evidenceLength = Array.isArray(priorResult?.evidence) ? priorResult.evidence.length : 0;

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
    buildPriorResultContextManifest(priorResults),
    buildReviewResultContextManifest(normalizedReviewResult),
    buildChangedSurfaceContextManifest(
      changedSurfaceContext.map((entry) => `${entry.packetId}:${entry.role}`)
    )
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

function parseEvidenceValue(evidenceEntries, key) {
  const prefix = `${key}: `;
  const entry = evidenceEntries.find((item) => typeof item === "string" && item.startsWith(prefix));
  return entry ? entry.slice(prefix.length).trim() : null;
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
    const evidenceEntries = Array.isArray(run?.result?.evidence) ? run.result.evidence : [];
    const selectedProvider = parseEvidenceValue(evidenceEntries, "selected_provider");
    const selectedModel = parseEvidenceValue(evidenceEntries, "selected_model");

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

function createRepairPacket({ workflow, packet, role, repairCount }) {
  const repairPacket = buildTaskPacket({
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

  repairPacket.id = `${repairPacket.id}-repair-${repairCount}`;
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
    repairCount
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
    workflow = createInitialWorkflow({
      goal: normalizedInput.goal,
      allowedFiles: normalizedInput.allowedFiles,
      forbiddenFiles: normalizedInput.forbiddenFiles,
      contextFiles: normalizedInput.contextFiles
    });
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
