import { createWorkerResult } from "./contracts.js";
import { resolvePiWorkerInvoker } from "./pi-runtime-diagnostics.js";
import { isPathWithinScope, normalizeRelativeScopePath } from "./path-scopes.js";
import { findProtectedPaths } from "./policies.js";
import {
  getTrustedForwardedRedactionMetadata,
  getTrustedRuntimeRepositoryRoot,
  normalizeContextManifest,
  setTrustedRuntimeRepositoryRoot,
  validateRunContext
} from "./context-manifest.js";
import { sanitizeWorkerResultForBoundary } from "./worker-result-redaction.js";

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
  return normalizeRelativeScopePath(path, {
    fieldName: "request path"
  });
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

function resolveBoundaryRepositoryRoot(runtimeContext = null) {
  return getTrustedRuntimeRepositoryRoot(runtimeContext?.workflowContext) ?? process.cwd();
}

function sanitizeAdapterWorkerResult(result, runtimeContext = null) {
  return sanitizeWorkerResultForBoundary(result, {
    repositoryRoot: resolveBoundaryRepositoryRoot(runtimeContext),
    mergeExistingRedaction: true
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
    contextManifest: normalizeContextManifest(requestInput.contextManifest, {
      fieldName: "request.contextManifest",
      allowMissing: true
    }) ?? [],
    acceptanceChecks: normalizeStringArray(requestInput.acceptanceChecks),
    stopConditions: normalizeStringArray(requestInput.stopConditions),
    commands: normalizeStringArray(requestInput.commands),
    modelProfile: clone(requestInput.modelProfile) ?? {},
    controls: clone(requestInput.controls) ?? {},
    context: clone(requestInput.context) ?? {}
  };
}

function hasStructuredRuntimeContextFields(context = {}) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(context, "contextManifest")
    || Object.prototype.hasOwnProperty.call(context, "priorResults")
    || Object.prototype.hasOwnProperty.call(context, "reviewResult")
    || Object.prototype.hasOwnProperty.call(context, "changedSurfaceContext")
    || Object.prototype.hasOwnProperty.call(context, "contextBudget");
}

function resolveRuntimeRepositoryRoot(contextInput) {
  const trustedRepositoryRoot = getTrustedRuntimeRepositoryRoot(contextInput?.context);
  if (trustedRepositoryRoot !== undefined) {
    return trustedRepositoryRoot;
  }

  return undefined;
}

function createRuntimeContext(contextInput, request) {
  const context = contextInput && typeof contextInput === "object" && !Array.isArray(contextInput)
    ? contextInput
    : {};
  const runtimeRepositoryRoot = resolveRuntimeRepositoryRoot(context);
  const trustedForwardedRedactionMetadata = getTrustedForwardedRedactionMetadata(context.context);
  const workflowContext = clone(context.context) ?? null;

  if (workflowContext && hasStructuredRuntimeContextFields(workflowContext)) {
    const normalizedRunContext = validateRunContext({
      packetContextFiles: request.contextFiles,
      contextManifest: workflowContext.contextManifest,
      priorResults: workflowContext.priorResults ?? [],
      reviewResult: workflowContext.reviewResult ?? null,
      changedSurfaceContext: workflowContext.changedSurfaceContext ?? [],
      contextBudget: workflowContext.contextBudget,
      forwardedRedactionMetadata: trustedForwardedRedactionMetadata,
      repositoryRoot: runtimeRepositoryRoot,
      fieldName: "context.workflowContext"
    });

    workflowContext.contextManifest = normalizedRunContext.contextManifest;
    if (
      normalizedRunContext.contextBudget !== undefined
      || Object.prototype.hasOwnProperty.call(workflowContext, "contextBudget")
    ) {
      workflowContext.contextBudget = normalizedRunContext.contextBudget ?? workflowContext.contextBudget;
    }
  }
  if (workflowContext) {
    setTrustedRuntimeRepositoryRoot(workflowContext, runtimeRepositoryRoot, {
      fieldName: "context.workflowContext.repositoryRoot"
    });
  }

  return {
    packet: clone(context.packet) ?? null,
    roleProfile: clone(context.roleProfile) ?? null,
    workflowContext
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

  let changedFiles;
  try {
    changedFiles = normalizeFileList(candidate.changedFiles ?? []);
  } catch (error) {
    return createBlockedResult(request, `Pi runtime (${invocationLabel}) returned invalid changedFiles.`, {
      evidence: [error.message]
    });
  }

  if (request.role !== "implementer" && changedFiles.length > 0) {
    return createBlockedResult(request, `Pi runtime (${invocationLabel}) returned writes for read-only ${request.role}.`, {
      evidence: [`unexpected_read_only_changes: ${changedFiles.join(", ")}`],
      openQuestions: [`Keep ${request.role} runtime results read-only; changedFiles must be empty.`]
    });
  }

  if (request.role === "implementer") {
    const changedOutsideAllowlist = changedFiles
      .filter((file) => !request.allowedFiles.some((scopeEntry) => isPathWithinScope(file, scopeEntry)));
    if (changedOutsideAllowlist.length > 0) {
      return createBlockedResult(request, `Pi runtime (${invocationLabel}) returned changedFiles outside the allowlist.`, {
        evidence: [`unexpected_files: ${changedOutsideAllowlist.join(", ")}`],
        openQuestions: ["Return only changedFiles covered by the implementer allowlist."]
      });
    }

    const changedForbiddenFiles = changedFiles.filter((file) => request.forbiddenFiles.some((scopeEntry) => isPathWithinScope(file, scopeEntry)));
    if (changedForbiddenFiles.length > 0) {
      return createBlockedResult(request, `Pi runtime (${invocationLabel}) returned changedFiles in forbidden paths.`, {
        evidence: [`forbidden_files_changed: ${changedForbiddenFiles.join(", ")}`],
        openQuestions: ["Narrow the runtime result to non-forbidden changedFiles."]
      });
    }

    const changedProtectedFiles = findProtectedPaths(changedFiles);
    if (changedProtectedFiles.length > 0) {
      return createBlockedResult(request, `Pi runtime (${invocationLabel}) returned changedFiles in protected paths.`, {
        evidence: [`protected_files_changed: ${changedProtectedFiles.join(", ")}`],
        openQuestions: ["Narrow the runtime result to non-protected repository files."]
      });
    }
  }

  try {
    return createWorkerResult({
      status,
      summary,
      changedFiles,
      commandsRun: normalizedStringArrayFields.commandsRun,
      evidence: normalizedStringArrayFields.evidence,
      openQuestions: normalizedStringArrayFields.openQuestions,
      ...(Object.prototype.hasOwnProperty.call(candidate, "reviewFindings")
        ? { reviewFindings: candidate.reviewFindings }
        : {})
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

  if (request.role === "implementer" && request.controls.writePolicy !== "allowlist_only") {
    return {
      ok: false,
      reason: "implementer request must use allowlist_only writePolicy"
    };
  }

  if (request.role === "implementer" && request.allowedFiles.length === 0) {
    return {
      ok: false,
      reason: "implementer request must include at least one allowed file"
    };
  }

  if (request.role === "implementer" && request.modelProfile?.access !== "write") {
    return {
      ok: false,
      reason: "implementer request must use a write-capable model profile"
    };
  }

  if (request.role !== "implementer" && request.controls.writePolicy !== "read_only") {
    return {
      ok: false,
      reason: `${request.role} request must use read_only writePolicy`
    };
  }

  if (request.role !== "implementer" && request.modelProfile?.access === "write") {
    return {
      ok: false,
      reason: `${request.role} request must use a read-only model profile`
    };
  }

  const protectedPaths = findProtectedPaths([
    ...request.allowedFiles,
    ...request.forbiddenFiles,
    ...request.contextFiles
  ]);
  if (protectedPaths.length > 0) {
    return {
      ok: false,
      reason: `request references protected path(s): ${protectedPaths.join(", ")}`
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
        return sanitizeAdapterWorkerResult(
          createBlockedResult({ role: "worker" }, `invalid worker request: ${error.message}`)
        );
      }

      let runtimeContext;
      try {
        runtimeContext = createRuntimeContext(contextInput, request);
      } catch (error) {
        return sanitizeAdapterWorkerResult(
          createBlockedResult(request, error.message, {
            openQuestions: ["Ensure runtime context payloads match contextManifest[] before invocation."]
          })
        );
      }

      calls.push({
        request: clone(request),
        context: clone(runtimeContext)
      });

      const requestSafety = validateRequestSafety(request, normalizedSupportedRoles);
      if (!requestSafety.ok) {
        return sanitizeAdapterWorkerResult(createBlockedResult(request, requestSafety.reason), runtimeContext);
      }

      const runtimeInvoker = resolvePiWorkerInvoker({
        host,
        invokeWorker
      });

      if (!runtimeInvoker) {
        return sanitizeAdapterWorkerResult(
          createBlockedResult(request, "Pi runtime does not expose runWorker(request, context).", {
            openQuestions: [
              "Expose host.runWorker(...) in the extension runtime or inject invokeWorker when creating the adapter."
            ]
          }),
          runtimeContext
        );
      }

      let runtimeResponse;
      try {
        runtimeResponse = await runtimeInvoker.invoke(clone(request), clone(runtimeContext));
      } catch (error) {
        return sanitizeAdapterWorkerResult(
          createBlockedResult(request, `Pi runtime invocation failed (${runtimeInvoker.label}): ${error.message}`, {
            openQuestions: ["Inspect the runtime worker invocation surface and retry."]
          }),
          runtimeContext
        );
      }

      return sanitizeAdapterWorkerResult(
        normalizeRuntimeWorkerResult(runtimeResponse, request, runtimeInvoker.label),
        runtimeContext
      );
    },

    getCalls() {
      return clone(calls);
    }
  };
}

export const PI_ADAPTER_DEFAULT_SUPPORTED_ROLES = DEFAULT_SUPPORTED_ROLES;
