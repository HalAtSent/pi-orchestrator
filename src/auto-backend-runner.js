import { safeClone } from "./safe-clone.js";
import { createWorkerResult, RISK_LEVELS } from "./contracts.js";
import { classifyRisk, findProtectedPacketPaths } from "./policies.js";
import { getTrustedProcessWorkerBackendRunProvenance } from "./process-worker-backend.js";

const AUTO_BACKEND_MODE_PI_RUNTIME = "pi_runtime";
const AUTO_BACKEND_MODE_LOW_RISK_PROCESS_IMPLEMENTER = "low_risk_process_implementer";
const AUTO_BACKEND_MODE_PROCESS_SUBAGENTS = "process_subagents";
const TRUSTED_CHANGED_SURFACE_OBSERVATION_RESULTS = new WeakSet();
const TRUSTED_PROVIDER_MODEL_SELECTION_RESULTS = new WeakSet();
const TRUSTED_EXTERNAL_SIDE_EFFECT_CONFINEMENT_RESULTS = new WeakSet();

export const AUTO_BACKEND_MODES = Object.freeze({
  PI_RUNTIME: AUTO_BACKEND_MODE_PI_RUNTIME,
  LOW_RISK_PROCESS_IMPLEMENTER: AUTO_BACKEND_MODE_LOW_RISK_PROCESS_IMPLEMENTER,
  PROCESS_SUBAGENTS: AUTO_BACKEND_MODE_PROCESS_SUBAGENTS
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function markTrustedProcessBackendResult(workerResult, provenance) {
  if (!isObject(workerResult)) {
    return workerResult;
  }

  if (workerResult?.changedSurfaceObservation?.capture === "complete") {
    TRUSTED_CHANGED_SURFACE_OBSERVATION_RESULTS.add(workerResult);
  }

  if (isObject(workerResult?.providerModelSelection)) {
    TRUSTED_PROVIDER_MODEL_SELECTION_RESULTS.add(workerResult);
  }

  if (provenance?.osSandbox === true && provenance?.trustBoundary === "os_sandbox") {
    TRUSTED_EXTERNAL_SIDE_EFFECT_CONFINEMENT_RESULTS.add(workerResult);
  }

  return workerResult;
}

export function isTrustedChangedSurfaceObservationResult(workerResult) {
  if (!isObject(workerResult)) {
    return false;
  }

  return TRUSTED_CHANGED_SURFACE_OBSERVATION_RESULTS.has(workerResult);
}

export function isTrustedProviderModelSelectionResult(workerResult) {
  if (!isObject(workerResult)) {
    return false;
  }

  return TRUSTED_PROVIDER_MODEL_SELECTION_RESULTS.has(workerResult);
}

export function isTrustedExternalSideEffectConfinementResult(workerResult) {
  if (!isObject(workerResult)) {
    return false;
  }

  return TRUSTED_EXTERNAL_SIDE_EFFECT_CONFINEMENT_RESULTS.has(workerResult);
}

function clone(value) {
  return safeClone(value);
}

function normalizeMode(mode) {
  if (typeof mode !== "string") {
    return AUTO_BACKEND_MODE_PI_RUNTIME;
  }

  const normalized = mode.trim();
  return normalized.length === 0 ? AUTO_BACKEND_MODE_PI_RUNTIME : normalized;
}

function validateMode(mode) {
  assert(
    mode === AUTO_BACKEND_MODE_PI_RUNTIME
      || mode === AUTO_BACKEND_MODE_LOW_RISK_PROCESS_IMPLEMENTER
      || mode === AUTO_BACKEND_MODE_PROCESS_SUBAGENTS,
    `auto backend mode must be one of: ${AUTO_BACKEND_MODE_PI_RUNTIME}, ${AUTO_BACKEND_MODE_LOW_RISK_PROCESS_IMPLEMENTER}, ${AUTO_BACKEND_MODE_PROCESS_SUBAGENTS}`
  );
}

function isValidRiskLevel(value) {
  return typeof value === "string" && RISK_LEVELS.includes(value);
}

function effectiveRisk(packet, context) {
  const declaredRisk = isValidRiskLevel(packet?.risk)
    ? packet.risk
    : isValidRiskLevel(context?.risk)
      ? context.risk
      : null;
  const heuristicRisk = classifyRisk({
    goal: typeof packet?.goal === "string"
      ? packet.goal
      : typeof context?.goal === "string"
        ? context.goal
        : "",
    allowedFiles: Array.isArray(packet?.allowedFiles) ? packet.allowedFiles : []
  });

  if (declaredRisk === "high" || heuristicRisk === "high") {
    return "high";
  }

  if (declaredRisk === "medium" || heuristicRisk === "medium") {
    return "medium";
  }

  if (declaredRisk === "low") {
    return "low";
  }

  return null;
}

function shouldUseProcessBackend({ mode, packet, context }) {
  if (mode === AUTO_BACKEND_MODE_PROCESS_SUBAGENTS) {
    return ["explorer", "implementer", "reviewer", "verifier"].includes(packet?.role);
  }

  if (mode !== AUTO_BACKEND_MODE_LOW_RISK_PROCESS_IMPLEMENTER) {
    return false;
  }

  return effectiveRisk(packet, context) === "low" && (packet?.role === "implementer" || packet?.role === "verifier");
}

function createProtectedPathBlockedResult(packet, protectedPaths) {
  const role = typeof packet?.role === "string" && packet.role.trim().length > 0
    ? packet.role.trim()
    : "unknown";
  return createWorkerResult({
    status: "blocked",
    summary: `${role} worker blocked: packet references protected path(s): ${protectedPaths.join(", ")}`,
    changedFiles: [],
    commandsRun: [],
    evidence: [
      "protected packet paths are blocked before backend selection",
      `protected paths: ${protectedPaths.join(", ")}`
    ],
    openQuestions: [
      "Narrow the packet scope to repository files outside protected harness, dependency, build, coverage, and secret paths."
    ]
  });
}

export function inferWorkflowProcessBackendRequirement({
  mode,
  workflow
} = {}) {
  const normalizedMode = normalizeMode(mode);
  validateMode(normalizedMode);

  if (normalizedMode === AUTO_BACKEND_MODE_PI_RUNTIME) {
    return false;
  }

  if (!workflow || typeof workflow !== "object" || !Array.isArray(workflow.packets)) {
    return null;
  }

  const risk = isValidRiskLevel(workflow.risk) ? workflow.risk : null;
  const context = risk ? { risk } : {};

  for (const packet of workflow.packets) {
    if (!packet || typeof packet !== "object") {
      return null;
    }

    if (typeof packet.role !== "string" || packet.role.trim().length === 0) {
      return null;
    }

    if (shouldUseProcessBackend({
      mode: normalizedMode,
      packet,
      context
    })) {
      return true;
    }
  }

  return false;
}

export function createAutoBackendRunner({
  defaultRunner,
  processBackend = null,
  mode = AUTO_BACKEND_MODE_PI_RUNTIME
} = {}) {
  assert(defaultRunner && typeof defaultRunner.run === "function", "defaultRunner.run(packet, context) is required");

  const normalizedMode = normalizeMode(mode);
  validateMode(normalizedMode);

  if (
    normalizedMode === AUTO_BACKEND_MODE_LOW_RISK_PROCESS_IMPLEMENTER
    || normalizedMode === AUTO_BACKEND_MODE_PROCESS_SUBAGENTS
  ) {
    assert(processBackend && typeof processBackend.run === "function", "processBackend.run(packet, context) is required for low_risk_process_implementer mode");
  }

  const calls = [];

  const getSelectedBackend = (packet, context = {}) => {
    const useProcessBackend = shouldUseProcessBackend({
      mode: normalizedMode,
      packet,
      context
    });
    return useProcessBackend ? "process_backend" : "default_runner";
  };

  return {
    async run(packet, context = {}) {
      const protectedPacketPaths = findProtectedPacketPaths(packet);
      if (protectedPacketPaths.length > 0) {
        return createProtectedPathBlockedResult(packet, protectedPacketPaths);
      }

      const selectedBackend = getSelectedBackend(packet, context);
      const useProcessBackend = selectedBackend === "process_backend";

      calls.push({
        packet: clone(packet),
        context: clone(context),
        selectedBackend
      });

      if (useProcessBackend) {
        const result = await processBackend.run(packet, context);
        const trustedProvenance = getTrustedProcessWorkerBackendRunProvenance(result);
        return trustedProvenance
          ? markTrustedProcessBackendResult(result, trustedProvenance)
          : result;
      }

      return defaultRunner.run(packet, context);
    },

    getCalls() {
      return clone(calls);
    },

    getExecutionBackendMode() {
      return normalizedMode;
    },

    getSelectedBackend,

    getTimeoutBudgetMs(packet, context = {}) {
      if (getSelectedBackend(packet, context) !== "process_backend") {
        return null;
      }

      if (typeof processBackend?.getTimeoutBudgetMs !== "function") {
        return null;
      }

      return processBackend.getTimeoutBudgetMs();
    },

    requiresProcessBackendForWorkflow(workflow) {
      return inferWorkflowProcessBackendRequirement({
        mode: normalizedMode,
        workflow
      });
    }
  };
}
