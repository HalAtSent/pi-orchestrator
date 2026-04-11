import { createWorkerResult } from "./contracts.js";
import { resolvePiWorkerInvoker } from "./pi-runtime-diagnostics.js";

const DEFAULT_SUPPORTED_ROLES = Object.freeze(["explorer", "implementer", "reviewer", "verifier"]);
const SUPPORTED_RESULT_STATUSES = new Set(["success", "blocked", "failed", "repair_required"]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizePath(path) {
  return String(path).replace(/\\/g, "/");
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeStringArray(values = []) {
  if (!Array.isArray(values)) {
    return [String(values)];
  }

  return values.map((value) => String(value));
}

function normalizeStrictStringArray(values, fieldName) {
  if (!Array.isArray(values)) {
    return {
      ok: false,
      reason: `${fieldName} must be an array`
    };
  }

  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return {
        ok: false,
        reason: `${fieldName}[${index}] must be a non-empty string`
      };
    }
  }

  return {
    ok: true,
    value: [...values]
  };
}

function normalizeFileList(files = []) {
  return unique(normalizeStringArray(files).map((path) => normalizePath(path)));
}

function normalizeRole(role) {
  return typeof role === "string" ? role.trim() : "";
}

function normalizeSummary(summary, fallback) {
  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary.trim();
  }

  return fallback;
}

function createBlockedResult(request, summary, { evidence = [], openQuestions = [] } = {}) {
  const role = normalizeRole(request?.role) || "worker";
  return createWorkerResult({
    status: "blocked",
    summary: `${role} worker blocked: ${summary}`,
    changedFiles: [],
    commandsRun: [],
    evidence: normalizeStringArray(evidence),
    openQuestions: normalizeStringArray(openQuestions)
  });
}

function normalizeWorkerStatus(status) {
  return SUPPORTED_RESULT_STATUSES.has(status) ? status : null;
}

function hasDelegationSignal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return value.delegated === true
    || (Number.isInteger(value.delegationCount) && value.delegationCount > 0)
    || (Number.isInteger(value.spawnedWorkers) && value.spawnedWorkers > 0);
}

function normalizeSupportedRoles(supportedRoles) {
  assert(Array.isArray(supportedRoles), "supportedRoles must be an array");

  const normalized = unique(
    supportedRoles
      .map((role) => normalizeRole(role))
      .filter((role) => role.length > 0)
  );

  assert(normalized.length > 0, "supportedRoles must contain at least one role");
  return new Set(normalized);
}

function normalizeWorkerRequest(requestInput) {
  assert(requestInput && typeof requestInput === "object" && !Array.isArray(requestInput), "request must be an object");

  return {
    runId: normalizeSummary(requestInput.runId, "unknown-run"),
    role: normalizeRole(requestInput.role),
    goal: normalizeSummary(requestInput.goal, "No goal provided."),
    allowedFiles: normalizeFileList(requestInput.allowedFiles),
    forbiddenFiles: normalizeFileList(requestInput.forbiddenFiles),
    contextFiles: normalizeFileList(requestInput.contextFiles),
    acceptanceChecks: normalizeStringArray(requestInput.acceptanceChecks),
    stopConditions: normalizeStringArray(requestInput.stopConditions),
    commands: normalizeStringArray(requestInput.commands),
    modelProfile: clone(requestInput.modelProfile) ?? {},
    controls: clone(requestInput.controls) ?? {},
    context: clone(requestInput.context) ?? {}
  };
}

function createRuntimeContext(contextInput) {
  const context = contextInput && typeof contextInput === "object" && !Array.isArray(contextInput)
    ? contextInput
    : {};

  return {
    packet: clone(context.packet) ?? null,
    roleProfile: clone(context.roleProfile) ?? null,
    workflowContext: clone(context.context) ?? null
  };
}

function normalizeRuntimeWorkerResult(response, request, invocationLabel) {
  const normalizedResponse = response && typeof response === "object" && !Array.isArray(response)
    ? response
    : null;
  const candidate = normalizedResponse?.result && typeof normalizedResponse.result === "object" && !Array.isArray(normalizedResponse.result)
    ? normalizedResponse.result
    : normalizedResponse;

  if (!candidate) {
    return createBlockedResult(request, `Pi runtime (${invocationLabel}) returned a non-object worker payload.`);
  }

  if (hasDelegationSignal(normalizedResponse) || hasDelegationSignal(candidate)) {
    return createBlockedResult(request, "Pi runtime attempted recursive delegation.", {
      openQuestions: ["Use a single task-scoped worker invocation with no nested workers."]
    });
  }

  const status = normalizeWorkerStatus(candidate.status);
  if (!status) {
    return createBlockedResult(request, "Pi runtime response did not include a valid worker status.", {
      evidence: [`runtime status: ${String(candidate.status)}`]
    });
  }

  const summary = normalizeSummary(
    candidate.summary,
    `Pi runtime returned ${status} for ${request.role}.`
  );

  const normalizedStringArrayFields = {};
  for (const fieldName of ["commandsRun", "evidence", "openQuestions"]) {
    const candidateValue = Object.prototype.hasOwnProperty.call(candidate, fieldName)
      ? candidate[fieldName]
      : [];
    const normalizedField = normalizeStrictStringArray(candidateValue, `result.${fieldName}`);
    if (!normalizedField.ok) {
      return createBlockedResult(request, `Pi runtime (${invocationLabel}) returned malformed ${fieldName}.`, {
        evidence: [normalizedField.reason]
      });
    }

    normalizedStringArrayFields[fieldName] = normalizedField.value;
  }

  try {
    return createWorkerResult({
      status,
      summary,
      changedFiles: normalizeFileList(candidate.changedFiles ?? []),
      commandsRun: normalizedStringArrayFields.commandsRun,
      evidence: normalizedStringArrayFields.evidence,
      openQuestions: normalizedStringArrayFields.openQuestions
    });
  } catch (error) {
    return createBlockedResult(request, `Pi runtime (${invocationLabel}) returned invalid worker result payload.`, {
      evidence: [error.message]
    });
  }
}

function validateRequestSafety(request, supportedRoles) {
  if (request.role.length === 0) {
    return {
      ok: false,
      reason: "worker role is required"
    };
  }

  if (!supportedRoles.has(request.role)) {
    return {
      ok: false,
      reason: `role ${request.role} is not supported by the live Pi adapter`
    };
  }

  if (request.controls.noRecursiveDelegation !== true) {
    return {
      ok: false,
      reason: "request must enforce noRecursiveDelegation=true"
    };
  }

  if (request.controls.taskScoped !== true || request.controls.ephemeral !== true) {
    return {
      ok: false,
      reason: "request must enforce taskScoped=true and ephemeral=true"
    };
  }

  if (request.controls.writePolicy === "allowlist_only" && request.allowedFiles.length === 0) {
    return {
      ok: false,
      reason: "write-role request must include at least one allowed file"
    };
  }

  return { ok: true };
}

export function createPiAdapter({
  host = null,
  invokeWorker,
  supportedRoles = DEFAULT_SUPPORTED_ROLES
} = {}) {
  const normalizedSupportedRoles = normalizeSupportedRoles(supportedRoles);
  const calls = [];

  return {
    async runWorker(requestInput, contextInput = {}) {
      let request;
      try {
        request = normalizeWorkerRequest(requestInput);
      } catch (error) {
        return createBlockedResult({ role: "worker" }, `invalid worker request: ${error.message}`);
      }

      const runtimeContext = createRuntimeContext(contextInput);
      calls.push({
        request: clone(request),
        context: clone(runtimeContext)
      });

      const requestSafety = validateRequestSafety(request, normalizedSupportedRoles);
      if (!requestSafety.ok) {
        return createBlockedResult(request, requestSafety.reason);
      }

      const runtimeInvoker = resolvePiWorkerInvoker({
        host,
        invokeWorker
      });

      if (!runtimeInvoker) {
        return createBlockedResult(request, "Pi runtime does not expose runWorker(request, context).", {
          openQuestions: [
            "Expose host.runWorker(...) in the extension runtime or inject invokeWorker when creating the adapter."
          ]
        });
      }

      let runtimeResponse;
      try {
        runtimeResponse = await runtimeInvoker.invoke(clone(request), clone(runtimeContext));
      } catch (error) {
        return createBlockedResult(request, `Pi runtime invocation failed (${runtimeInvoker.label}): ${error.message}`, {
          openQuestions: ["Inspect the runtime worker invocation surface and retry."]
        });
      }

      return normalizeRuntimeWorkerResult(runtimeResponse, request, runtimeInvoker.label);
    },

    getCalls() {
      return clone(calls);
    }
  };
}

export const PI_ADAPTER_DEFAULT_SUPPORTED_ROLES = DEFAULT_SUPPORTED_ROLES;
