const AUTO_BACKEND_MODE_PI_RUNTIME = "pi_runtime";
const AUTO_BACKEND_MODE_LOW_RISK_PROCESS_IMPLEMENTER = "low_risk_process_implementer";
const AUTO_BACKEND_MODE_PROCESS_SUBAGENTS = "process_subagents";

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

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
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

function shouldUseProcessBackend({ mode, packet, context }) {
  if (mode === AUTO_BACKEND_MODE_PROCESS_SUBAGENTS) {
    return ["explorer", "implementer", "reviewer", "verifier"].includes(packet?.role);
  }

  if (mode !== AUTO_BACKEND_MODE_LOW_RISK_PROCESS_IMPLEMENTER) {
    return false;
  }

  return context?.risk === "low" && (packet?.role === "implementer" || packet?.role === "verifier");
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

  return {
    async run(packet, context = {}) {
      const useProcessBackend = shouldUseProcessBackend({
        mode: normalizedMode,
        packet,
        context
      });
      const selectedBackend = useProcessBackend ? "process_backend" : "default_runner";

      calls.push({
        packet: clone(packet),
        context: clone(context),
        selectedBackend
      });

      if (useProcessBackend) {
        return processBackend.run(packet, context);
      }

      return defaultRunner.run(packet, context);
    },

    getCalls() {
      return clone(calls);
    }
  };
}
