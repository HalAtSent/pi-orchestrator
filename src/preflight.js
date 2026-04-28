import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { promisify } from "node:util";

import {
  getTrustedProcessWorkerBackendProvenance,
  PROCESS_WORKER_MODEL_CANDIDATES,
  PROCESS_WORKER_PROVIDER_ID
} from "./process-worker-backend.js";
import { findProtectedPaths } from "./policies.js";

const execFileAsync = promisify(execFile);

export const PREFLIGHT_STATUSES = Object.freeze(["pass", "warning", "blocked"]);
export const PREFLIGHT_CERTAINTY = Object.freeze(["known", "unknown", "not_applicable"]);
export const PREFLIGHT_CHECK_IDS = Object.freeze({
  REPOSITORY_ROOT: "repository_root",
  PACKAGE_TEST_SCRIPT: "package_test_script",
  GIT_WORKTREE: "git_worktree",
  PROTECTED_PATHS: "protected_paths",
  PROCESS_BACKEND: "process_backend",
  PROCESS_SANDBOX: "process_sandbox",
  MODEL_PROBE: "model_probe"
});

const MAX_PREVIEW_ITEMS = 8;
const GIT_STATUS_TIMEOUT_MS = 5_000;
const GIT_STATUS_MAX_BUFFER = 256 * 1024;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function uniqueStrings(values) {
  return [...new Set(values
    .map((value) => normalizeString(value))
    .filter(Boolean))];
}

function formatPreview(values) {
  const normalized = uniqueStrings(values);
  if (normalized.length === 0) {
    return "none";
  }

  const preview = normalized.slice(0, MAX_PREVIEW_ITEMS).join(", ");
  return normalized.length <= MAX_PREVIEW_ITEMS
    ? preview
    : `${preview}, +${normalized.length - MAX_PREVIEW_ITEMS} more`;
}

function normalizePreflightCheck({
  id,
  status,
  reason,
  nextAction = null,
  certainty = "known",
  evidence = [],
  details = {}
}) {
  assert(typeof id === "string" && id.trim().length > 0, "preflight check id must be a non-empty string");
  assert(PREFLIGHT_STATUSES.includes(status), `preflight check status must be one of: ${PREFLIGHT_STATUSES.join(", ")}`);
  assert(PREFLIGHT_CERTAINTY.includes(certainty), `preflight check certainty must be one of: ${PREFLIGHT_CERTAINTY.join(", ")}`);
  assert(typeof reason === "string" && reason.trim().length > 0, "preflight check reason must be a non-empty string");

  if (status === "blocked") {
    assert(
      typeof nextAction === "string" && nextAction.trim().length > 0,
      "blocked preflight checks must include an operator next action"
    );
  }

  return {
    id: id.trim(),
    status,
    certainty,
    reason: reason.trim(),
    nextAction: normalizeString(nextAction),
    evidence: uniqueStrings(Array.isArray(evidence) ? evidence : []),
    details: isObject(details) ? structuredClone(details) : {}
  };
}

function passCheck(id, reason, options = {}) {
  return normalizePreflightCheck({
    id,
    status: "pass",
    reason,
    ...options
  });
}

function warningCheck(id, reason, {
  nextAction,
  certainty = "known",
  evidence = [],
  details = {}
} = {}) {
  return normalizePreflightCheck({
    id,
    status: "warning",
    certainty,
    reason,
    nextAction,
    evidence,
    details
  });
}

function blockedCheck(id, reason, {
  nextAction,
  evidence = [],
  details = {}
} = {}) {
  return normalizePreflightCheck({
    id,
    status: "blocked",
    reason,
    nextAction,
    evidence,
    details
  });
}

export function createPreflightResult(checks) {
  assert(Array.isArray(checks), "preflight checks must be an array");
  const normalizedChecks = checks.map((check) => normalizePreflightCheck(check));
  const status = normalizedChecks.some((check) => check.status === "blocked")
    ? "blocked"
    : normalizedChecks.some((check) => check.status === "warning")
      ? "warning"
      : "pass";

  return {
    status,
    checks: normalizedChecks,
    blocked: normalizedChecks.filter((check) => check.status === "blocked"),
    warnings: normalizedChecks.filter((check) => check.status === "warning")
  };
}

function errorMessage(error) {
  if (error instanceof Error && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return String(error);
}

function normalizeRepositoryRootInput(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.trim().length === 0) {
    return null;
  }

  return resolve(repositoryRoot.trim());
}

function isObviouslyInvalidRepositoryRoot(repositoryRoot) {
  if (parse(repositoryRoot).root === repositoryRoot) {
    return "repository root must not be the filesystem root";
  }

  const leaf = repositoryRoot.split(/[\\/]/u).filter(Boolean).at(-1)?.toLowerCase();
  if (leaf === ".git" || leaf === ".pi" || leaf === "node_modules") {
    return `repository root points at protected runtime/dependency directory: ${leaf}`;
  }

  return null;
}

async function checkRepositoryRoot(repositoryRootInput, { statFn = stat } = {}) {
  const repositoryRoot = normalizeRepositoryRootInput(repositoryRootInput);
  if (!repositoryRoot) {
    return blockedCheck(
      PREFLIGHT_CHECK_IDS.REPOSITORY_ROOT,
      "Repository root is missing or empty.",
      {
        nextAction: "Provide an absolute or resolvable repository root before launching workers."
      }
    );
  }

  const invalidReason = isObviouslyInvalidRepositoryRoot(repositoryRoot);
  if (invalidReason) {
    return blockedCheck(
      PREFLIGHT_CHECK_IDS.REPOSITORY_ROOT,
      `Repository root is obviously invalid: ${invalidReason}.`,
      {
        nextAction: "Point the harness at the actual project repository root before launching workers.",
        details: { repositoryRoot }
      }
    );
  }

  try {
    const rootStats = await statFn(repositoryRoot);
    if (!rootStats?.isDirectory || !rootStats.isDirectory()) {
      return blockedCheck(
        PREFLIGHT_CHECK_IDS.REPOSITORY_ROOT,
        `Repository root is not a directory: ${repositoryRoot}`,
        {
          nextAction: "Use an existing project directory as the repository root before launching workers.",
          details: { repositoryRoot }
        }
      );
    }

    return passCheck(
      PREFLIGHT_CHECK_IDS.REPOSITORY_ROOT,
      "Repository root exists and is a directory.",
      {
        details: { repositoryRoot }
      }
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return blockedCheck(
        PREFLIGHT_CHECK_IDS.REPOSITORY_ROOT,
        `Repository root does not exist: ${repositoryRoot}`,
        {
          nextAction: "Create or select the intended repository root before launching workers.",
          details: { repositoryRoot }
        }
      );
    }

    return warningCheck(
      PREFLIGHT_CHECK_IDS.REPOSITORY_ROOT,
      `Repository root could not be fully inspected: ${errorMessage(error)}`,
      {
        certainty: "unknown",
        nextAction: "Check filesystem permissions for the repository root before relying on this run.",
        details: { repositoryRoot }
      }
    );
  }
}

async function checkPackageTestScript(repositoryRoot, {
  readFileFn = readFile
} = {}) {
  if (!repositoryRoot) {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.PACKAGE_TEST_SCRIPT,
      "package.json test script could not be inspected because the repository root is invalid.",
      {
        certainty: "unknown",
        nextAction: "Fix the repository root, then re-run preflight."
      }
    );
  }

  const packageJsonPath = join(repositoryRoot, "package.json");
  let packageJson;
  try {
    packageJson = await readFileFn(packageJsonPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return warningCheck(
        PREFLIGHT_CHECK_IDS.PACKAGE_TEST_SCRIPT,
        "package.json was not found, so the default test command could not be discovered.",
        {
          nextAction: "Add a package.json scripts.test entry or provide explicit verification commands in the plan.",
          details: { packageJsonPath }
        }
      );
    }

    return warningCheck(
      PREFLIGHT_CHECK_IDS.PACKAGE_TEST_SCRIPT,
      `package.json could not be read: ${errorMessage(error)}`,
      {
        certainty: "unknown",
        nextAction: "Check package.json permissions or provide explicit verification commands.",
        details: { packageJsonPath }
      }
    );
  }

  let parsedPackage;
  try {
    parsedPackage = JSON.parse(packageJson);
  } catch (error) {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.PACKAGE_TEST_SCRIPT,
      `package.json is not valid JSON: ${errorMessage(error)}`,
      {
        nextAction: "Fix package.json parsing or provide explicit verification commands before relying on test discovery.",
        details: { packageJsonPath }
      }
    );
  }

  const testScript = normalizeString(parsedPackage?.scripts?.test);
  if (!testScript) {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.PACKAGE_TEST_SCRIPT,
      "package.json does not expose a non-empty scripts.test command.",
      {
        nextAction: "Add a package.json scripts.test entry or include explicit verification commands in the execution program.",
        details: { packageJsonPath }
      }
    );
  }

  return passCheck(
    PREFLIGHT_CHECK_IDS.PACKAGE_TEST_SCRIPT,
    "package.json exposes a test script.",
    {
      evidence: [`scripts.test: ${testScript}`],
      details: {
        packageJsonPath,
        testScript
      }
    }
  );
}

async function defaultGitStatus({ repositoryRoot }) {
  try {
    const { stdout } = await execFileAsync("git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all"
    ], {
      cwd: repositoryRoot,
      timeout: GIT_STATUS_TIMEOUT_MS,
      maxBuffer: GIT_STATUS_MAX_BUFFER
    });

    return {
      available: true,
      stdout
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        available: false,
        reason: "git command is unavailable"
      };
    }

    const stderr = normalizeString(error?.stderr);
    return {
      available: false,
      reason: stderr ?? `git status failed: ${errorMessage(error)}`
    };
  }
}

function parseGitPorcelainPaths(output) {
  if (typeof output !== "string" || output.trim().length === 0) {
    return [];
  }

  return uniqueStrings(output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const rawPath = (/^.{1,2}\s+(.*)$/u.exec(line)?.[1] ?? line).trim();
      const renameSeparator = " -> ";
      return rawPath.includes(renameSeparator)
        ? rawPath.slice(rawPath.lastIndexOf(renameSeparator) + renameSeparator.length)
        : rawPath;
    }));
}

function normalizeGitStatusResult(result) {
  if (typeof result === "string") {
    const changedPaths = parseGitPorcelainPaths(result);
    return {
      available: true,
      dirty: result.trim().length > 0,
      changedPaths,
      reason: null
    };
  }

  if (!isObject(result)) {
    return {
      available: false,
      dirty: null,
      changedPaths: [],
      reason: "git status probe returned no structured result"
    };
  }

  if (result.available === false) {
    return {
      available: false,
      dirty: null,
      changedPaths: [],
      reason: normalizeString(result.reason) ?? "git status is unavailable"
    };
  }

  const output = normalizeString(result.stdout)
    ?? normalizeString(result.output)
    ?? normalizeString(result.porcelain)
    ?? "";
  const changedPaths = Array.isArray(result.changedPaths)
    ? uniqueStrings(result.changedPaths)
    : parseGitPorcelainPaths(output);
  const dirty = typeof result.dirty === "boolean"
    ? result.dirty
    : output.trim().length > 0 || changedPaths.length > 0;

  return {
    available: true,
    dirty,
    changedPaths,
    reason: normalizeString(result.reason)
  };
}

async function checkGitWorktree(repositoryRoot, {
  gitStatus = defaultGitStatus
} = {}) {
  if (!repositoryRoot) {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.GIT_WORKTREE,
      "Git worktree state could not be inspected because the repository root is invalid.",
      {
        certainty: "unknown",
        nextAction: "Fix the repository root, then re-run preflight."
      }
    );
  }

  if (typeof gitStatus !== "function") {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.GIT_WORKTREE,
      "Git worktree state was not checked because no git status probe is configured.",
      {
        certainty: "unknown",
        nextAction: "Provide a git status probe or manually verify the worktree baseline before launching workers."
      }
    );
  }

  let probeResult;
  try {
    probeResult = await gitStatus({ repositoryRoot });
  } catch (error) {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.GIT_WORKTREE,
      `Git worktree state is unknown because the git status probe failed: ${errorMessage(error)}`,
      {
        certainty: "unknown",
        nextAction: "Manually inspect git status before treating changed-surface evidence as clean-baseline evidence."
      }
    );
  }

  const normalized = normalizeGitStatusResult(probeResult);
  if (!normalized.available) {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.GIT_WORKTREE,
      `Git worktree state is unknown: ${normalized.reason}`,
      {
        certainty: "unknown",
        nextAction: "Manually inspect the repository baseline before treating changed-surface evidence as clean.",
        details: { repositoryRoot }
      }
    );
  }

  if (normalized.dirty) {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.GIT_WORKTREE,
      `Git worktree has pre-existing changes: ${formatPreview(normalized.changedPaths)}`,
      {
        nextAction: "Commit, stash, or explicitly account for the existing changes before launching workers.",
        evidence: normalized.changedPaths.map((pathValue) => `dirty_path: ${pathValue}`),
        details: {
          repositoryRoot,
          changedPaths: normalized.changedPaths
        }
      }
    );
  }

  return passCheck(
    PREFLIGHT_CHECK_IDS.GIT_WORKTREE,
    "Git worktree appears clean.",
    {
      details: { repositoryRoot }
    }
  );
}

function collectPlannedScopePaths({
  plannedScopePaths,
  program,
  workflow,
  packet
} = {}) {
  if (Array.isArray(plannedScopePaths)) {
    return uniqueStrings(plannedScopePaths);
  }

  const paths = [];
  if (isObject(program) && Array.isArray(program.contracts)) {
    for (const contract of program.contracts) {
      if (Array.isArray(contract?.scopePaths)) {
        paths.push(...contract.scopePaths);
      }
    }
  }

  const workflows = [];
  if (isObject(workflow)) {
    workflows.push(workflow);
  }
  if (isObject(program) && Array.isArray(program.workflows)) {
    workflows.push(...program.workflows.filter(isObject));
  }
  for (const candidateWorkflow of workflows) {
    if (!Array.isArray(candidateWorkflow.packets)) {
      continue;
    }

    for (const workflowPacket of candidateWorkflow.packets) {
      if (Array.isArray(workflowPacket?.allowedFiles)) {
        paths.push(...workflowPacket.allowedFiles);
      }
      if (Array.isArray(workflowPacket?.forbiddenFiles)) {
        paths.push(...workflowPacket.forbiddenFiles);
      }
      if (Array.isArray(workflowPacket?.contextFiles)) {
        paths.push(...workflowPacket.contextFiles);
      }
    }
  }

  if (isObject(packet)) {
    if (Array.isArray(packet.allowedFiles)) {
      paths.push(...packet.allowedFiles);
    }
    if (Array.isArray(packet.forbiddenFiles)) {
      paths.push(...packet.forbiddenFiles);
    }
    if (Array.isArray(packet.contextFiles)) {
      paths.push(...packet.contextFiles);
    }
  }

  return uniqueStrings(paths);
}

function checkProtectedPlannedPaths(options = {}) {
  const plannedPaths = collectPlannedScopePaths(options);
  if (plannedPaths.length === 0) {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.PROTECTED_PATHS,
      "Planned file scope was not supplied, so protected-path conflicts could not be checked.",
      {
        certainty: "unknown",
        nextAction: "Provide execution-program scopePaths or worker packet file scope before launching workers."
      }
    );
  }

  const protectedPaths = uniqueStrings(findProtectedPaths(plannedPaths));
  if (protectedPaths.length > 0) {
    return blockedCheck(
      PREFLIGHT_CHECK_IDS.PROTECTED_PATHS,
      `Planned scope references protected path(s): ${formatPreview(protectedPaths)}`,
      {
        nextAction: "Remove protected path(s) from the planned scope or replan around non-protected repository files.",
        evidence: protectedPaths.map((pathValue) => `protected_path: ${pathValue}`),
        details: {
          plannedPaths,
          protectedPaths
        }
      }
    );
  }

  return passCheck(
    PREFLIGHT_CHECK_IDS.PROTECTED_PATHS,
    "Planned scope does not reference protected paths.",
    {
      details: { plannedPaths }
    }
  );
}

async function resolveProcessBackendRequirement({
  processBackendRequired,
  runner,
  workflow
} = {}) {
  if (typeof processBackendRequired === "boolean") {
    return {
      known: true,
      required: processBackendRequired,
      reason: null
    };
  }

  if (isObject(runner) && typeof runner.requiresProcessBackendForWorkflow === "function" && isObject(workflow)) {
    try {
      const required = await runner.requiresProcessBackendForWorkflow(workflow);
      if (typeof required === "boolean") {
        return {
          known: true,
          required,
          reason: null
        };
      }

      return {
        known: false,
        required: null,
        reason: "runner returned an unknown process backend requirement"
      };
    } catch (error) {
      return {
        known: false,
        required: null,
        reason: `runner process backend requirement probe failed: ${errorMessage(error)}`
      };
    }
  }

  return {
    known: false,
    required: null,
    reason: "no process backend requirement signal was provided"
  };
}

function resolveProcessBackend({
  processBackend,
  backend,
  runner
} = {}) {
  if (isObject(processBackend)) {
    return processBackend;
  }

  if (isObject(backend)) {
    return backend;
  }

  if (isObject(runner) && typeof runner.getProcessBackend === "function") {
    try {
      const resolved = runner.getProcessBackend();
      return isObject(resolved) ? resolved : null;
    } catch {
      return null;
    }
  }

  return null;
}

function checkProcessBackend(processRequirement, options = {}) {
  const backend = resolveProcessBackend(options);

  if (!processRequirement.known) {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.PROCESS_BACKEND,
      `Process backend requirement is unknown: ${processRequirement.reason}`,
      {
        certainty: "unknown",
        nextAction: "Use a runner/backend that exposes process-backend requirements or provide processBackendRequired explicitly."
      }
    );
  }

  if (!processRequirement.required) {
    return passCheck(
      PREFLIGHT_CHECK_IDS.PROCESS_BACKEND,
      "Process backend is not required for the planned run.",
      {
        certainty: "not_applicable"
      }
    );
  }

  if (!backend || typeof backend.run !== "function") {
    return blockedCheck(
      PREFLIGHT_CHECK_IDS.PROCESS_BACKEND,
      "Process backend is required but no runnable process backend is configured.",
      {
        nextAction: "Configure processWorkerBackend or select a non-process backend mode before launching workers."
      }
    );
  }

  return passCheck(
    PREFLIGHT_CHECK_IDS.PROCESS_BACKEND,
    "Process backend is configured for a process-backed run."
  );
}

function normalizeSandboxAvailability(value) {
  if (value === true) {
    return {
      state: "available",
      reason: "sandbox availability probe returned available",
      details: {}
    };
  }

  if (value === false) {
    return {
      state: "unavailable",
      reason: "sandbox availability probe returned unavailable",
      details: {}
    };
  }

  if (!isObject(value)) {
    return {
      state: "unknown",
      reason: "sandbox availability probe returned no structured result",
      details: {}
    };
  }

  const status = normalizeString(value.status);
  const reason = normalizeString(value.reason)
    ?? normalizeString(value.blockedReason)
    ?? normalizeString(value.message);

  if (status === "blocked" || value.available === false) {
    return {
      state: "unavailable",
      reason: reason ?? "sandbox is unavailable",
      details: structuredClone(value)
    };
  }

  if (status === "warning" || value.warning === true || value.osSandbox === false) {
    return {
      state: "warning",
      reason: reason ?? "sandbox readiness is degraded",
      details: structuredClone(value)
    };
  }

  if (status === "pass" || value.available === true || value.osSandbox === true) {
    return {
      state: "available",
      reason: reason ?? "sandbox is available",
      details: structuredClone(value)
    };
  }

  return {
    state: "unknown",
    reason: reason ?? "sandbox readiness is unknown",
    details: structuredClone(value)
  };
}

async function callOptionalBackendMethod(backend, methodNames) {
  for (const methodName of methodNames) {
    if (typeof backend?.[methodName] !== "function") {
      continue;
    }

    return {
      called: true,
      value: await backend[methodName]()
    };
  }

  return {
    called: false,
    value: null
  };
}

function getBackendProvenance(backend) {
  const trustedProvenance = getTrustedProcessWorkerBackendProvenance(backend);
  if (trustedProvenance) {
    return trustedProvenance;
  }

  if (typeof backend?.getTrustedBackendProvenance !== "function") {
    return null;
  }

  try {
    const provenance = backend.getTrustedBackendProvenance();
    return isObject(provenance) ? provenance : null;
  } catch {
    return null;
  }
}

function sandboxReadinessFromProvenance(provenance) {
  if (!isObject(provenance)) {
    return null;
  }

  const processSandbox = normalizeString(provenance.processSandbox);
  if (processSandbox === "disabled" || provenance.unsandboxedProcessBackendOptIn === true) {
    return {
      state: "warning",
      reason: "process backend is configured in explicit unsandboxed mode",
      details: structuredClone(provenance)
    };
  }

  if (processSandbox === "required" && provenance.osSandbox !== true) {
    const provider = normalizeString(provenance.sandboxProvider) ?? "unknown";
    const boundary = normalizeString(provenance.trustBoundary) ?? "unknown";
    return {
      state: "unavailable",
      reason: `required OS sandbox is not available or trusted (provider: ${provider}; boundary: ${boundary})`,
      details: structuredClone(provenance)
    };
  }

  if (provenance.osSandbox === true) {
    return {
      state: "unknown",
      reason: "trusted OS sandbox provider is configured, but no availability probe is exposed",
      details: structuredClone(provenance)
    };
  }

  return null;
}

async function resolveSandboxReadiness(backend) {
  try {
    const methodResult = await callOptionalBackendMethod(backend, [
      "checkSandboxAvailability",
      "getSandboxAvailability",
      "inspectSandboxAvailability"
    ]);
    if (methodResult.called) {
      return normalizeSandboxAvailability(methodResult.value);
    }
  } catch (error) {
    return {
      state: "unknown",
      reason: `sandbox availability probe failed: ${errorMessage(error)}`,
      details: {}
    };
  }

  const provenanceReadiness = sandboxReadinessFromProvenance(getBackendProvenance(backend));
  if (provenanceReadiness) {
    return provenanceReadiness;
  }

  return {
    state: "unknown",
    reason: "process backend does not expose sandbox availability",
    details: {}
  };
}

async function checkProcessSandbox(processRequirement, options = {}) {
  const backend = resolveProcessBackend(options);

  if (!processRequirement.known) {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.PROCESS_SANDBOX,
      `Process sandbox readiness is unknown because process backend requirement is unknown: ${processRequirement.reason}`,
      {
        certainty: "unknown",
        nextAction: "Expose process-backend requirement and sandbox availability before relying on sandbox readiness."
      }
    );
  }

  if (!processRequirement.required) {
    return passCheck(
      PREFLIGHT_CHECK_IDS.PROCESS_SANDBOX,
      "Process sandbox is not required because the process backend is not required.",
      {
        certainty: "not_applicable"
      }
    );
  }

  if (!backend || typeof backend.run !== "function") {
    return blockedCheck(
      PREFLIGHT_CHECK_IDS.PROCESS_SANDBOX,
      "Process sandbox readiness cannot be checked because the required process backend is missing.",
      {
        nextAction: "Configure a process backend with sandbox readiness before launching workers."
      }
    );
  }

  const readiness = await resolveSandboxReadiness(backend);
  if (readiness.state === "available") {
    return passCheck(
      PREFLIGHT_CHECK_IDS.PROCESS_SANDBOX,
      `Process sandbox is available: ${readiness.reason}`,
      {
        details: readiness.details
      }
    );
  }

  if (readiness.state === "unavailable") {
    return blockedCheck(
      PREFLIGHT_CHECK_IDS.PROCESS_SANDBOX,
      `Process backend requires sandbox readiness but sandbox is unavailable: ${readiness.reason}`,
      {
        nextAction: "Configure a supported OS sandbox provider or use an explicitly approved non-process execution mode.",
        details: readiness.details
      }
    );
  }

  if (readiness.state === "warning") {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.PROCESS_SANDBOX,
      `Process sandbox readiness is degraded: ${readiness.reason}`,
      {
        nextAction: "Use a supported OS sandbox provider before treating process execution as sandbox-confined.",
        details: readiness.details
      }
    );
  }

  return warningCheck(
    PREFLIGHT_CHECK_IDS.PROCESS_SANDBOX,
    `Process sandbox readiness is unknown: ${readiness.reason}`,
    {
      certainty: "unknown",
      nextAction: "Use a backend that exposes sandbox availability before relying on sandbox readiness.",
      details: readiness.details
    }
  );
}

function resolveModelProbe({
  modelProbe,
  runner,
  processBackend,
  backend
} = {}) {
  if (typeof modelProbe === "function") {
    return modelProbe;
  }

  for (const candidate of [runner, processBackend, backend]) {
    if (!isObject(candidate)) {
      continue;
    }

    if (typeof candidate.probeModels === "function") {
      return candidate.probeModels.bind(candidate);
    }
    if (typeof candidate.checkModelAvailability === "function") {
      return candidate.checkModelAvailability.bind(candidate);
    }
    if (typeof candidate.getModelProbe === "function") {
      try {
        const probe = candidate.getModelProbe();
        if (typeof probe === "function") {
          return probe;
        }
      } catch {
        // Keep probing other exposure patterns.
      }
    }
  }

  return null;
}

function normalizeModelProbeRequest(modelProbeRequest = {}) {
  const providerId = normalizeString(modelProbeRequest.providerId) ?? PROCESS_WORKER_PROVIDER_ID;
  const candidateModels = Array.isArray(modelProbeRequest.candidateModels)
    ? uniqueStrings(modelProbeRequest.candidateModels)
    : [...PROCESS_WORKER_MODEL_CANDIDATES];

  return {
    ...modelProbeRequest,
    providerId,
    candidateModels: candidateModels.length > 0 ? candidateModels : [...PROCESS_WORKER_MODEL_CANDIDATES]
  };
}

function normalizeModelProbeResult(result) {
  if (!isObject(result)) {
    return {
      state: "unknown",
      reason: "model probe returned no structured result",
      supportedModels: []
    };
  }

  const blockedReason = normalizeString(result.blockedReason);
  if (result.available === false || result.status === "blocked" || blockedReason) {
    return {
      state: "blocked",
      reason: blockedReason ?? normalizeString(result.reason) ?? "model probe reported unavailable",
      supportedModels: []
    };
  }

  const supportedModels = Array.isArray(result.supportedModels)
    ? uniqueStrings(result.supportedModels)
    : Array.isArray(result.models)
      ? uniqueStrings(result.models)
      : [];

  if (supportedModels.length > 0 || result.available === true || result.status === "pass") {
    return {
      state: "available",
      reason: "model probe found at least one supported model",
      supportedModels
    };
  }

  return {
    state: "blocked",
    reason: "model probe found no supported models",
    supportedModels
  };
}

async function checkModelProbe(options = {}) {
  const probe = resolveModelProbe(options);
  const modelProbeRequired = options.modelProbeRequired === true;

  if (!probe) {
    if (modelProbeRequired) {
      return warningCheck(
        PREFLIGHT_CHECK_IDS.MODEL_PROBE,
        "Model availability is unknown because no model probe is exposed.",
        {
          certainty: "unknown",
          nextAction: "Expose a model probe or verify provider/model availability before launching workers."
        }
      );
    }

    return passCheck(
      PREFLIGHT_CHECK_IDS.MODEL_PROBE,
      "No model probe is exposed; preflight did not claim model availability.",
      {
        certainty: "not_applicable"
      }
    );
  }

  const request = normalizeModelProbeRequest(options.modelProbeRequest);
  let probeResult;
  try {
    probeResult = await probe(request);
  } catch (error) {
    return warningCheck(
      PREFLIGHT_CHECK_IDS.MODEL_PROBE,
      `Model availability is unknown because the model probe failed: ${errorMessage(error)}`,
      {
        certainty: "unknown",
        nextAction: "Fix the model probe or manually verify provider/model availability before launching workers.",
        details: {
          providerId: request.providerId,
          candidateModels: request.candidateModels
        }
      }
    );
  }

  const normalized = normalizeModelProbeResult(probeResult);
  if (normalized.state === "available") {
    return passCheck(
      PREFLIGHT_CHECK_IDS.MODEL_PROBE,
      `Model probe passed for provider ${request.providerId}.`,
      {
        evidence: normalized.supportedModels.map((model) => `supported_model: ${model}`),
        details: {
          providerId: request.providerId,
          candidateModels: request.candidateModels,
          supportedModels: normalized.supportedModels
        }
      }
    );
  }

  if (normalized.state === "blocked") {
    return blockedCheck(
      PREFLIGHT_CHECK_IDS.MODEL_PROBE,
      `Model probe blocked execution for provider ${request.providerId}: ${normalized.reason}`,
      {
        nextAction: "Configure an available model/provider combination or update the planned backend before launching workers.",
        details: {
          providerId: request.providerId,
          candidateModels: request.candidateModels,
          supportedModels: normalized.supportedModels
        }
      }
    );
  }

  return warningCheck(
    PREFLIGHT_CHECK_IDS.MODEL_PROBE,
    `Model availability is unknown for provider ${request.providerId}: ${normalized.reason}`,
    {
      certainty: "unknown",
      nextAction: "Manually verify provider/model availability before launching workers.",
      details: {
        providerId: request.providerId,
        candidateModels: request.candidateModels
      }
    }
  );
}

export async function runPreflight(options = {}) {
  const repositoryRoot = normalizeRepositoryRootInput(options.repositoryRoot ?? process.cwd());
  const repositoryRootCheck = await checkRepositoryRoot(repositoryRoot, options);
  const usableRepositoryRoot = repositoryRootCheck.status === "blocked"
    ? null
    : repositoryRootCheck.details.repositoryRoot;
  const processRequirement = await resolveProcessBackendRequirement(options);

  const checks = [
    repositoryRootCheck,
    await checkPackageTestScript(usableRepositoryRoot, options),
    await checkGitWorktree(usableRepositoryRoot, options),
    checkProtectedPlannedPaths(options),
    checkProcessBackend(processRequirement, options),
    await checkProcessSandbox(processRequirement, options),
    await checkModelProbe(options)
  ];

  return createPreflightResult(checks);
}

export function createPreflightStopReason(preflightResult) {
  const blockedChecks = Array.isArray(preflightResult?.blocked)
    ? preflightResult.blocked
    : [];
  if (blockedChecks.length === 0) {
    return null;
  }

  return `Preflight blocked execution: ${blockedChecks.map((check) => (
    `${check.id}: ${check.reason} Next action: ${check.nextAction}`
  )).join("; ")}`;
}

export function createPreflightWarningSummary(preflightResult) {
  const warnings = Array.isArray(preflightResult?.warnings)
    ? preflightResult.warnings
    : [];
  if (warnings.length === 0) {
    return null;
  }

  return `Preflight warning(s): ${warnings.map((check) => (
    `${check.id}: ${check.reason}`
  )).join("; ")}`;
}

export function formatPreflightResult(preflightResult) {
  const checks = Array.isArray(preflightResult?.checks)
    ? preflightResult.checks
    : [];
  return [
    `preflight: ${preflightResult?.status ?? "unknown"}`,
    ...checks.map((check) => {
      const nextAction = check.nextAction ? ` next_action: ${check.nextAction}` : "";
      return `- ${check.id}: ${check.status} (${check.certainty}) ${check.reason}${nextAction}`;
    })
  ].join("\n");
}
