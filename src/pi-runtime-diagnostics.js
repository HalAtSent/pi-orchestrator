function unique(values) {
  return [...new Set(values)];
}

function normalizeRole(role) {
  return typeof role === "string" ? role.trim() : "";
}

function normalizeSupportedRoles(supportedRoles = []) {
  if (!Array.isArray(supportedRoles)) {
    return [];
  }

  return unique(
    supportedRoles
      .map((role) => normalizeRole(role))
      .filter((role) => role.length > 0)
  );
}

export function resolvePiWorkerInvoker({ host, invokeWorker } = {}) {
  if (typeof invokeWorker === "function") {
    return {
      label: "invokeWorker",
      invoke: invokeWorker
    };
  }

  if (host && typeof host.runWorker === "function") {
    return {
      label: "host.runWorker",
      invoke: host.runWorker.bind(host)
    };
  }

  if (host?.runtime && typeof host.runtime.runWorker === "function") {
    return {
      label: "host.runtime.runWorker",
      invoke: host.runtime.runWorker.bind(host.runtime)
    };
  }

  return null;
}

export function inspectPiWorkerRuntime({
  host = null,
  invokeWorker,
  supportedRoles = []
} = {}) {
  const resolvedInvoker = resolvePiWorkerInvoker({ host, invokeWorker });

  return {
    hasHostRunWorker: Boolean(host && typeof host.runWorker === "function"),
    hasRuntimeRunWorker: Boolean(host?.runtime && typeof host.runtime.runWorker === "function"),
    selectedInvoker: resolvedInvoker?.label ?? "none",
    supportedRoles: normalizeSupportedRoles(supportedRoles)
  };
}

export function formatPiWorkerRuntimeStatus(status) {
  const supportedRoles = status.supportedRoles.length > 0
    ? status.supportedRoles.join(", ")
    : "none";

  return [
    `host_run_worker: ${status.hasHostRunWorker ? "yes" : "no"}`,
    `runtime_run_worker: ${status.hasRuntimeRunWorker ? "yes" : "no"}`,
    `selected_invoker: ${status.selectedInvoker}`,
    `supported_roles: ${supportedRoles}`
  ].join("\n");
}
