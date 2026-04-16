export const VALIDATION_OUTCOMES = Object.freeze([
  "pass",
  "fail",
  "blocked",
  "not_run"
]);

export const VALIDATION_ARTIFACT_STATUSES = Object.freeze([
  "captured",
  "not_captured"
]);

export const REVIEWABILITY_STATUSES = Object.freeze([
  "reviewable",
  "not_reviewable",
  "unknown"
]);

export const REVIEWABILITY_REASONS = Object.freeze([
  "non_terminal_status",
  "validation_artifacts_not_captured",
  "missing_stop_reason",
  "missing_stop_reason_code",
  "provider_model_evidence_missing",
  "provider_model_evidence_requirement_unknown"
]);

export const STOP_REASON_CODES = Object.freeze([
  "approval_required",
  "invalid_input",
  "invalid_artifact",
  "invalid_worker_output",
  "scope_violation",
  "protected_path_violation",
  "policy_denied",
  "runtime_unavailable",
  "execution_error",
  "validation_failed",
  "dependency_cycle",
  "missing_dependency",
  "terminal_resume_rejected",
  "unknown"
]);

export const ACTION_CLASSES = Object.freeze([
  "read_repo",
  "read_protected",
  "write_allowed",
  "write_forbidden",
  "write_protected",
  "execute_local_command",
  "install_dependency",
  "mutate_git_state",
  "access_network",
  "access_connector",
  "access_secret",
  "irreversible_side_effect",
  "recursive_delegate"
]);

export const VALID_POLICY_PROFILES = Object.freeze([
  "default"
]);

export const DEFAULT_POLICY_PROFILE = "default";
export const CHANGED_SURFACE_CAPTURE_MODES = Object.freeze([
  "complete",
  "partial",
  "not_captured"
]);
export const CHANGED_SURFACE_OBSERVATION_CAPTURE_MODES = Object.freeze([
  "complete",
  "not_captured"
]);
export const PROVIDER_MODEL_SELECTION_FIELDS = Object.freeze([
  "requestedProvider",
  "requestedModel",
  "selectedProvider",
  "selectedModel"
]);
export const PROVIDER_MODEL_SELECTION_ENTRY_FIELDS = Object.freeze([
  "role",
  "iteration",
  ...PROVIDER_MODEL_SELECTION_FIELDS
]);
export const PROVIDER_MODEL_EVIDENCE_REQUIREMENTS = Object.freeze([
  "required",
  "unknown"
]);

const ROLE_TO_ACTION_CLASSES = Object.freeze({
  explorer: ["read_repo"],
  implementer: ["write_allowed"],
  reviewer: ["read_repo"],
  verifier: ["read_repo"]
});

const STOP_REASON_CODE_TO_ACTION_CLASSES = Object.freeze({
  scope_violation: ["write_forbidden"],
  protected_path_violation: ["write_protected"]
});

const TERMINAL_REVIEWABILITY_STATUSES = new Set([
  "success",
  "blocked",
  "failed",
  "repair_required"
]);
const REVIEWABILITY_BLOCKING_REASONS = new Set([
  "non_terminal_status",
  "validation_artifacts_not_captured",
  "missing_stop_reason",
  "missing_stop_reason_code",
  "provider_model_evidence_missing"
]);
const PROVIDER_MODEL_EVIDENCE_KEYS = new Set([
  "requested_provider",
  "requested_model",
  "selected_provider",
  "selected_model"
]);

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function unique(values) {
  return [...new Set(values)];
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function sortReviewabilityReasons(reasons) {
  const order = new Map(REVIEWABILITY_REASONS.map((reason, index) => [reason, index]));
  return [...reasons].sort((left, right) => (
    (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function classifyReviewabilityStatusFromReasons(reasons) {
  if (reasons.length === 0) {
    return "reviewable";
  }

  if (reasons.some((reason) => REVIEWABILITY_BLOCKING_REASONS.has(reason))) {
    return "not_reviewable";
  }

  return "unknown";
}

function parseEvidenceKeyValue(entry) {
  const normalizedEntry = normalizeString(entry);
  if (normalizedEntry.length === 0) {
    return null;
  }

  const separatorIndex = normalizedEntry.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = normalizedEntry.slice(0, separatorIndex).trim().toLowerCase();
  const value = normalizedEntry.slice(separatorIndex + 1).trim();
  if (key.length === 0) {
    return null;
  }

  return {
    key,
    value
  };
}

function hasOwnProviderModelSelections(value) {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "providerModelSelections");
}

function hasOwnProviderModelEvidenceRequirement(value) {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "providerModelEvidenceRequirement");
}

function normalizeProviderModelFieldValue(value, { fieldName } = {}) {
  const normalized = normalizeString(value);
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  if (normalized.toLowerCase() === "unknown") {
    throw new Error(`${fieldName} must not be unknown`);
  }
  return normalized;
}

function collectProviderModelEvidenceSignals(contractRuns) {
  let hasAnySignals = false;
  let hasSelectedProvider = false;
  let hasSelectedModel = false;

  for (const contractRun of contractRuns) {
    if (hasOwnProviderModelSelections(contractRun)) {
      const providerModelSelections = Array.isArray(contractRun.providerModelSelections)
        ? contractRun.providerModelSelections
        : [];

      for (const selection of providerModelSelections) {
        if (!isPlainObject(selection)) {
          continue;
        }

        hasAnySignals = true;
        const selectedProvider = normalizeString(selection.selectedProvider);
        const selectedModel = normalizeString(selection.selectedModel);
        if (selectedProvider.length > 0 && selectedProvider.toLowerCase() !== "unknown") {
          hasSelectedProvider = true;
        }
        if (selectedModel.length > 0 && selectedModel.toLowerCase() !== "unknown") {
          hasSelectedModel = true;
        }
      }

      continue;
    }

    const evidenceEntries = Array.isArray(contractRun?.evidence) ? contractRun.evidence : [];
    for (const evidenceEntry of evidenceEntries) {
      const parsed = parseEvidenceKeyValue(evidenceEntry);
      if (!parsed || !PROVIDER_MODEL_EVIDENCE_KEYS.has(parsed.key)) {
        continue;
      }

      hasAnySignals = true;
      if (parsed.key === "selected_provider" && parsed.value.length > 0 && parsed.value !== "unknown") {
        hasSelectedProvider = true;
      } else if (parsed.key === "selected_model" && parsed.value.length > 0 && parsed.value !== "unknown") {
        hasSelectedModel = true;
      }
    }
  }

  return {
    hasAnySignals,
    hasSelectedProvider,
    hasSelectedModel
  };
}

function collectProviderModelEvidenceSignalsFromTypedSelections(contractRun) {
  let hasAnySignals = false;
  let hasSelectedProvider = false;
  let hasSelectedModel = false;

  if (!hasOwnProviderModelSelections(contractRun)) {
    return {
      hasAnySignals,
      hasSelectedProvider,
      hasSelectedModel
    };
  }

  const providerModelSelections = Array.isArray(contractRun.providerModelSelections)
    ? contractRun.providerModelSelections
    : [];
  for (const selection of providerModelSelections) {
    if (!isPlainObject(selection)) {
      continue;
    }

    hasAnySignals = true;
    const selectedProvider = normalizeString(selection.selectedProvider);
    const selectedModel = normalizeString(selection.selectedModel);
    if (selectedProvider.length > 0 && selectedProvider.toLowerCase() !== "unknown") {
      hasSelectedProvider = true;
    }
    if (selectedModel.length > 0 && selectedModel.toLowerCase() !== "unknown") {
      hasSelectedModel = true;
    }
  }

  return {
    hasAnySignals,
    hasSelectedProvider,
    hasSelectedModel
  };
}

function normalizeProviderModelSelectionEntry(value, {
  fieldName = "providerModelSelections[]"
} = {}) {
  if (!isPlainObject(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  const role = normalizeString(value.role);
  if (role.length === 0) {
    throw new Error(`${fieldName}.role must be a non-empty string`);
  }

  if (!Number.isInteger(value.iteration) || value.iteration < 0) {
    throw new Error(`${fieldName}.iteration must be an integer >= 0`);
  }

  return {
    role,
    iteration: value.iteration,
    requestedProvider: normalizeProviderModelFieldValue(value.requestedProvider, {
      fieldName: `${fieldName}.requestedProvider`
    }),
    requestedModel: normalizeProviderModelFieldValue(value.requestedModel, {
      fieldName: `${fieldName}.requestedModel`
    }),
    selectedProvider: normalizeProviderModelFieldValue(value.selectedProvider, {
      fieldName: `${fieldName}.selectedProvider`
    }),
    selectedModel: normalizeProviderModelFieldValue(value.selectedModel, {
      fieldName: `${fieldName}.selectedModel`
    })
  };
}

export function normalizeProviderModelSelection(value, {
  fieldName = "providerModelSelection"
} = {}) {
  if (value === undefined || value === null) {
    return null;
  }

  if (!isPlainObject(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return {
    requestedProvider: normalizeProviderModelFieldValue(value.requestedProvider, {
      fieldName: `${fieldName}.requestedProvider`
    }),
    requestedModel: normalizeProviderModelFieldValue(value.requestedModel, {
      fieldName: `${fieldName}.requestedModel`
    }),
    selectedProvider: normalizeProviderModelFieldValue(value.selectedProvider, {
      fieldName: `${fieldName}.selectedProvider`
    }),
    selectedModel: normalizeProviderModelFieldValue(value.selectedModel, {
      fieldName: `${fieldName}.selectedModel`
    })
  };
}

export function normalizeProviderModelSelections(value, {
  fieldName = "providerModelSelections",
  allowMissing = false
} = {}) {
  if (value === undefined || value === null) {
    return allowMissing ? null : [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }

  return value.map((entry, index) => normalizeProviderModelSelectionEntry(entry, {
    fieldName: `${fieldName}[${index}]`
  }));
}

export function normalizeProviderModelEvidenceRequirement(value, {
  fieldName = "providerModelEvidenceRequirement",
  allowMissing = false
} = {}) {
  if (value === undefined || value === null) {
    if (allowMissing) {
      return null;
    }
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  const normalized = normalizeString(value);
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  if (!PROVIDER_MODEL_EVIDENCE_REQUIREMENTS.includes(normalized)) {
    throw new Error(`${fieldName} must be one of: ${PROVIDER_MODEL_EVIDENCE_REQUIREMENTS.join(", ")}`);
  }

  return normalized;
}

function splitCommandSegments(command) {
  const normalized = normalizeString(command);
  if (normalized.length === 0) {
    return [];
  }

  return normalized
    .split(/&&|\|\||;|\r?\n/gu)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function normalizeCommandToken(token) {
  return normalizeString(token)
    .replace(/^['"`]+|['"`]+$/gu, "")
    .toLowerCase();
}

function tokenizeCommandSegment(segment) {
  return normalizeString(segment)
    .split(/\s+/u)
    .map((token) => normalizeCommandToken(token))
    .filter((token) => token.length > 0);
}

function isEnvironmentAssignmentToken(token) {
  return /^[a-z_][a-z0-9_]*=/iu.test(token);
}

function unwrapCommandWrapper(tokens) {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "sudo" || token === "time" || token === "command" || token === "env") {
      index += 1;
      continue;
    }
    if (token === "cmd" && (tokens[index + 1] === "/c" || tokens[index + 1] === "/k")) {
      index += 2;
      continue;
    }
    if (token === "bash" || token === "sh" || token === "zsh") {
      if (tokens[index + 1] === "-c" || tokens[index + 1] === "-lc") {
        index += 2;
        continue;
      }
    }
    if (isEnvironmentAssignmentToken(token)) {
      index += 1;
      continue;
    }
    break;
  }

  return tokens.slice(index);
}

function nextNonOptionToken(tokens, startIndex = 0) {
  for (let index = startIndex; index < tokens.length; index += 1) {
    if (!tokens[index].startsWith("-")) {
      return tokens[index];
    }
  }
  return null;
}

function includesPythonPipInstall(tokens) {
  for (let index = 1; index < tokens.length - 2; index += 1) {
    if (tokens[index] === "-m" && tokens[index + 1] === "pip" && tokens[index + 2] === "install") {
      return true;
    }
  }
  return false;
}

function includesUvPipInstall(tokens) {
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "pip" && tokens[index + 1] === "install") {
      return true;
    }
  }
  return false;
}

function isInstallDependencyCommand(command) {
  const segments = splitCommandSegments(command);
  for (const segment of segments) {
    const tokens = unwrapCommandWrapper(tokenizeCommandSegment(segment));
    if (tokens.length === 0) {
      continue;
    }

    const executable = tokens[0];
    if (executable === "npm") {
      const subcommand = nextNonOptionToken(tokens, 1);
      if (subcommand && ["install", "i", "ci", "add"].includes(subcommand)) {
        return true;
      }
      continue;
    }

    if (executable === "pnpm") {
      const subcommand = nextNonOptionToken(tokens, 1);
      if (subcommand && ["install", "i", "add"].includes(subcommand)) {
        return true;
      }
      continue;
    }

    if (executable === "yarn" || executable === "bun") {
      const subcommand = nextNonOptionToken(tokens, 1);
      if (subcommand && ["install", "add"].includes(subcommand)) {
        return true;
      }
      continue;
    }

    if (executable === "pip" || executable === "pip3") {
      if (nextNonOptionToken(tokens, 1) === "install") {
        return true;
      }
      continue;
    }

    if (["python", "python3", "py"].includes(executable) && includesPythonPipInstall(tokens)) {
      return true;
    }

    if (executable === "uv" && includesUvPipInstall(tokens)) {
      return true;
    }

    if (executable === "poetry") {
      const subcommand = nextNonOptionToken(tokens, 1);
      if (subcommand && ["add", "install"].includes(subcommand)) {
        return true;
      }
      continue;
    }

    if (executable === "go" && nextNonOptionToken(tokens, 1) === "get") {
      return true;
    }
  }

  return false;
}

const GIT_GLOBAL_OPTIONS_WITH_VALUE = Object.freeze(new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--exec-path",
  "--config-env"
]));

function parseGitSubcommand(tokens) {
  let index = 1;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token === "--") {
      index += 1;
      break;
    }

    if (token.startsWith("-")) {
      index += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token) ? 2 : 1;
      continue;
    }

    return {
      subcommand: token,
      arguments: tokens.slice(index + 1)
    };
  }

  if (index < tokens.length) {
    return {
      subcommand: tokens[index],
      arguments: tokens.slice(index + 1)
    };
  }

  return {
    subcommand: null,
    arguments: []
  };
}

function isMutatingGitSubcommand(subcommand, args) {
  if (subcommand === null) {
    return false;
  }

  if ([
    "add",
    "am",
    "apply",
    "checkout",
    "cherry-pick",
    "clean",
    "commit",
    "merge",
    "mv",
    "pull",
    "push",
    "rebase",
    "reset",
    "restore",
    "revert",
    "rm",
    "stash",
    "switch"
  ].includes(subcommand)) {
    return true;
  }

  if (subcommand === "bisect") {
    return args.length > 0;
  }

  if (subcommand === "branch") {
    if (args.length === 0) {
      return false;
    }
    return !args.every((argument) => argument === "--list" || argument === "-a");
  }

  if (subcommand === "tag") {
    return args.length > 0;
  }

  if (subcommand === "worktree") {
    const nested = nextNonOptionToken(args, 0);
    return nested !== null && ["add", "remove", "move", "prune"].includes(nested);
  }

  return false;
}

function isMutateGitStateCommand(command) {
  const segments = splitCommandSegments(command);
  for (const segment of segments) {
    const tokens = unwrapCommandWrapper(tokenizeCommandSegment(segment));
    if (tokens[0] !== "git") {
      continue;
    }

    const parsed = parseGitSubcommand(tokens);
    if (isMutatingGitSubcommand(parsed.subcommand, parsed.arguments)) {
      return true;
    }
  }

  return false;
}

function extractCommandsFromEvidenceEntry(evidenceEntry) {
  if (typeof evidenceEntry !== "string") {
    return [];
  }

  const trimmed = evidenceEntry.trim();
  const runCommandMatch = /^run\s+[a-z_]+\s+command:\s*(.+)$/iu.exec(trimmed);
  if (runCommandMatch) {
    return [runCommandMatch[1].trim()].filter((command) => command.length > 0);
  }

  if (trimmed.toLowerCase().startsWith("command:")) {
    const command = trimmed.slice("command:".length).trim();
    return command.length > 0 ? [command] : [];
  }

  return [];
}

export function inferActionClassesFromCommands(commandsInput) {
  const inferred = new Set();
  const commands = Array.isArray(commandsInput) ? commandsInput : [];

  for (const rawCommand of commands) {
    const command = normalizeString(rawCommand);
    if (command.length === 0) {
      continue;
    }

    if (isInstallDependencyCommand(command)) {
      inferred.add("install_dependency");
    }

    if (isMutateGitStateCommand(command)) {
      inferred.add("mutate_git_state");
    }
  }

  return ACTION_CLASSES.filter((actionClass) => inferred.has(actionClass));
}

function normalizeRepoRelativePath(value, { fieldName = "path" } = {}) {
  const raw = normalizeString(value);
  if (raw.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  const normalized = raw.replace(/\\/gu, "/");
  const segments = normalized.split("/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error(`${fieldName} must be repo-relative`);
  }
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${fieldName} must not escape the repository root`);
  }

  const canonicalSegments = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    canonicalSegments.push(segment);
  }

  const canonical = canonicalSegments.join("/");
  if (canonical.length === 0) {
    throw new Error(`${fieldName} must be a non-empty path`);
  }

  return canonical;
}

function normalizeExplicitActionClasses(value, { fieldName = "actionClasses" } = {}) {
  if (!Array.isArray(value)) {
    throw new Error("must be an array");
  }

  const normalized = [];
  const seen = new Set();

  for (let index = 0; index < value.length; index += 1) {
    const actionClass = normalizeString(value[index]);
    if (actionClass.length === 0) {
      throw new Error(`${fieldName}[${index}] must be a non-empty string`);
    }
    if (!ACTION_CLASSES.includes(actionClass)) {
      throw new Error(`${fieldName}[${index}] must be one of: ${ACTION_CLASSES.join(", ")}`);
    }
    if (seen.has(actionClass)) {
      continue;
    }

    seen.add(actionClass);
    normalized.push(actionClass);
  }

  return ACTION_CLASSES.filter((actionClass) => seen.has(actionClass));
}

function extractRolesFromEvidenceEntry(evidenceEntry) {
  if (typeof evidenceEntry !== "string") {
    return [];
  }

  const trimmed = evidenceEntry.trim();
  const normalized = trimmed.toLowerCase();

  if (normalized.startsWith("roles:")) {
    const rawRoles = trimmed.slice("roles:".length).split("->");
    return rawRoles
      .map((rawRole) => rawRole.trim().toLowerCase())
      .filter((role) => ROLE_TO_ACTION_CLASSES[role]);
  }

  if (normalized.startsWith("run ")) {
    const rawRole = trimmed.slice("run ".length).split(":")[0];
    const role = rawRole.trim().toLowerCase();
    return ROLE_TO_ACTION_CLASSES[role] ? [role] : [];
  }

  return [];
}

export function inferValidationOutcome(status) {
  const normalizedStatus = normalizeString(status);

  switch (normalizedStatus) {
    case "success":
      return "pass";
    case "blocked":
      return "blocked";
    case "failed":
    case "repair_required":
      return "fail";
    case "awaiting_approval":
    case "approved":
    case "running":
    default:
      return "not_run";
  }
}

export function inferStopReasonCode({ status, stopReason } = {}) {
  const normalizedStatus = normalizeString(status);
  const normalizedReason = normalizeString(stopReason).toLowerCase();

  if (normalizedReason.length === 0) {
    if (normalizedStatus === "repair_required") {
      return "validation_failed";
    }

    if (normalizedStatus === "blocked" || normalizedStatus === "failed") {
      return "unknown";
    }

    return null;
  }

  if (normalizedReason.includes("cannot be resumed")) {
    return "terminal_resume_rejected";
  }

  if (normalizedReason.includes("approval")) {
    return "approval_required";
  }

  if (
    normalizedReason.includes("persisted run state is invalid") ||
    normalizedReason.includes("persisted run state is inconsistent") ||
    normalizedReason.includes("persisted execution program does not match") ||
    normalizedReason.includes("programid does not match")
  ) {
    return "invalid_artifact";
  }

  if (
    normalizedReason.includes("invalid result") ||
    normalizedReason.includes("invalid structured")
  ) {
    return "invalid_worker_output";
  }

  if (
    normalizedReason.includes("scope path") ||
    normalizedReason.includes("allowlist") ||
    normalizedReason.includes("outside current scope") ||
    normalizedReason.includes("forbidden files") ||
    normalizedReason.includes("write scope already claimed")
  ) {
    return "scope_violation";
  }

  if (normalizedReason.includes("protected path")) {
    return "protected_path_violation";
  }

  if (
    normalizedReason.includes("run persistence store is not configured") ||
    normalizedReason.includes("failed to load persisted run") ||
    normalizedReason.includes("runtime") ||
    normalizedReason.includes("runworker") ||
    normalizedReason.includes("launcher") ||
    normalizedReason.includes("spawn command resolution")
  ) {
    return "runtime_unavailable";
  }

  if (
    normalizedReason.includes("validation failed") ||
    normalizedReason.includes("acceptance checks") ||
    normalizedReason.includes("test failed") ||
    normalizedReason.includes("tests fail") ||
    normalizedReason.includes("lint failed") ||
    normalizedReason.includes("build failed")
  ) {
    return "validation_failed";
  }

  if (
    normalizedReason.includes("dependency cycle") ||
    /\bcycle\b/.test(normalizedReason) ||
    /\bcyclic\b/.test(normalizedReason)
  ) {
    return "dependency_cycle";
  }

  if (
    normalizedReason.includes("missing contract id") ||
    normalizedReason.includes("missing dependency") ||
    normalizedReason.includes("external dependency") ||
    normalizedReason.includes("no contracts are ready to run with the current dependency state")
  ) {
    return "missing_dependency";
  }

  if (
    normalizedReason.includes("must be a non-empty string") ||
    normalizedReason.includes("must be an array") ||
    normalizedReason.includes("must be an object") ||
    normalizedReason.includes("provide a ")
  ) {
    return "invalid_input";
  }

  if (
    normalizedReason.includes("denied") ||
    normalizedReason.includes("not permitted")
  ) {
    return "policy_denied";
  }

  if (normalizedStatus === "repair_required") {
    return "validation_failed";
  }

  if (
    normalizedReason.includes("execution threw") ||
    normalizedReason.includes("executor crashed") ||
    normalizedReason.includes("timed out") ||
    normalizedReason.includes("failed to apply") ||
    normalizedReason.includes("failed to prepare")
  ) {
    return "execution_error";
  }

  if (normalizedStatus === "failed") {
    return "execution_error";
  }

  if (normalizedStatus === "blocked") {
    return "unknown";
  }

  return null;
}

export function normalizeValidationOutcome(value, { status } = {}) {
  const normalizedValue = normalizeString(value);
  if (normalizedValue.length === 0) {
    return inferValidationOutcome(status);
  }

  if (!VALIDATION_OUTCOMES.includes(normalizedValue)) {
    throw new Error(`must be one of: ${VALIDATION_OUTCOMES.join(", ")}`);
  }

  return normalizedValue;
}

export function normalizeStopReasonCode(value, { status, stopReason } = {}) {
  const normalizedValue = normalizeString(value);
  if (normalizedValue.length === 0) {
    return inferStopReasonCode({ status, stopReason });
  }

  if (!STOP_REASON_CODES.includes(normalizedValue)) {
    throw new Error(`must be one of: ${STOP_REASON_CODES.join(", ")}`);
  }

  return normalizedValue;
}

export function inferActionClasses({ contractRuns = [], stopReasonCode = null } = {}) {
  const inferred = new Set();

  if (Array.isArray(contractRuns)) {
    for (const run of contractRuns) {
      if (!run || typeof run !== "object") {
        continue;
      }

      const evidenceEntries = Array.isArray(run.evidence) ? run.evidence : [];
      for (const evidenceEntry of evidenceEntries) {
        const roles = extractRolesFromEvidenceEntry(evidenceEntry);
        for (const role of roles) {
          for (const actionClass of ROLE_TO_ACTION_CLASSES[role] ?? []) {
            inferred.add(actionClass);
          }
        }

        const commandActionClasses = inferActionClassesFromCommands(
          extractCommandsFromEvidenceEntry(evidenceEntry)
        );
        for (const actionClass of commandActionClasses) {
          inferred.add(actionClass);
        }
      }
    }
  }

  const normalizedStopReasonCode = normalizeString(stopReasonCode);
  for (const actionClass of STOP_REASON_CODE_TO_ACTION_CLASSES[normalizedStopReasonCode] ?? []) {
    inferred.add(actionClass);
  }

  return ACTION_CLASSES.filter((actionClass) => inferred.has(actionClass));
}

export function normalizeDeclaredActionClasses(value, { fallback = [] } = {}) {
  const source = value === undefined || value === null ? fallback : value;
  return normalizeExplicitActionClasses(source);
}

export function normalizeActionClasses(value, { contractRuns = [], stopReasonCode = null } = {}) {
  const inferred = inferActionClasses({
    contractRuns,
    stopReasonCode
  });
  if (value !== undefined && value !== null) {
    normalizeExplicitActionClasses(value);
  }

  return inferred;
}

export function derivePlannedActionClassesFromWorkflow(workflowInput) {
  if (!workflowInput || typeof workflowInput !== "object") {
    return [];
  }

  const planned = new Set();
  const packets = Array.isArray(workflowInput.packets) ? workflowInput.packets : [];
  const roleSequence = Array.isArray(workflowInput.roleSequence) ? workflowInput.roleSequence : [];

  for (const packet of packets) {
    if (!packet || typeof packet !== "object") {
      continue;
    }

    planned.add("read_repo");

    if (normalizeString(packet.role) === "implementer") {
      planned.add("write_allowed");
    }

    if (Array.isArray(packet.commands) && packet.commands.some((command) => normalizeString(command).length > 0)) {
      planned.add("execute_local_command");
    }

    for (const actionClass of inferActionClassesFromCommands(packet.commands)) {
      planned.add(actionClass);
    }
  }

  if (packets.length === 0) {
    for (const rawRole of roleSequence) {
      const role = normalizeString(rawRole);
      if (role.length === 0) {
        continue;
      }

      planned.add("read_repo");
      if (role === "implementer") {
        planned.add("write_allowed");
      }
    }
  }

  return ACTION_CLASSES.filter((actionClass) => planned.has(actionClass));
}

export function normalizePolicyProfile(value) {
  const normalized = normalizeString(value);
  const resolved = normalized.length > 0 ? normalized : DEFAULT_POLICY_PROFILE;

  if (!VALID_POLICY_PROFILES.includes(resolved)) {
    throw new Error(`must be one of: ${VALID_POLICY_PROFILES.join(", ")}`);
  }

  return resolved;
}

function createValidationArtifactsPlaceholder(validationOutcome, { artifactType = "validation_artifact" } = {}) {
  const normalizedOutcome = normalizeString(validationOutcome);
  const normalizedArtifactType = normalizeString(artifactType);
  return {
    artifactType: normalizedArtifactType.length > 0 ? normalizedArtifactType : "validation_artifact",
    reference: null,
    status: "not_captured",
    validationOutcome: normalizedOutcome.length > 0 ? normalizedOutcome : null
  };
}

function normalizeValidationArtifactEntry(entry, { validationOutcome = null } = {}) {
  const normalizedOutcome = normalizeString(validationOutcome);

  if (typeof entry === "string") {
    const reference = normalizeString(entry);
    if (reference.length === 0) {
      throw new Error("validationArtifacts[] string entries must be non-empty");
    }

    return {
      artifactType: "validation_artifact",
      reference,
      status: "captured"
    };
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("validationArtifacts[] entries must be strings or objects");
  }

  const normalizedEntry = structuredClone(entry);
  const normalizedArtifactType = normalizeString(normalizedEntry.artifactType);
  normalizedEntry.artifactType = normalizedArtifactType.length > 0
    ? normalizedArtifactType
    : "validation_artifact";
  if (normalizedEntry.artifactType !== "validation_artifact") {
    throw new Error("validationArtifacts[].artifactType must be validation_artifact");
  }

  if (normalizedEntry.reference !== undefined && normalizedEntry.reference !== null) {
    const normalizedReference = normalizeString(normalizedEntry.reference);
    if (normalizedReference.length === 0) {
      throw new Error("validationArtifacts[].reference must be a non-empty string when provided");
    }
    normalizedEntry.reference = normalizedReference;
  } else {
    normalizedEntry.reference = null;
  }

  if (normalizedEntry.status !== undefined && normalizedEntry.status !== null) {
    const normalizedStatus = normalizeString(normalizedEntry.status);
    if (normalizedStatus.length === 0) {
      throw new Error("validationArtifacts[].status must be a non-empty string when provided");
    }
    if (!VALIDATION_ARTIFACT_STATUSES.includes(normalizedStatus)) {
      throw new Error(
        `validationArtifacts[].status must be one of: ${VALIDATION_ARTIFACT_STATUSES.join(", ")}`
      );
    }
    normalizedEntry.status = normalizedStatus;
  }

  if (normalizedEntry.validationOutcome !== undefined && normalizedEntry.validationOutcome !== null) {
    const entryOutcome = normalizeString(normalizedEntry.validationOutcome);
    normalizedEntry.validationOutcome = entryOutcome.length > 0 ? entryOutcome : null;
  }

  const hasReference = normalizedEntry.reference !== null;
  const normalizedStatus = normalizedEntry.status ?? null;
  const fallbackValidationOutcome = normalizedOutcome.length > 0
    ? normalizedOutcome
    : (normalizedEntry.validationOutcome ?? null);

  if (
    !hasReference &&
    (normalizedStatus === null || normalizedStatus === "captured")
  ) {
    return createValidationArtifactsPlaceholder(fallbackValidationOutcome, {
      artifactType: normalizedEntry.artifactType
    });
  }

  if (hasReference && normalizedStatus === "not_captured") {
    return createValidationArtifactsPlaceholder(fallbackValidationOutcome, {
      artifactType: normalizedEntry.artifactType
    });
  }

  if (hasReference && normalizedStatus === null) {
    normalizedEntry.status = "captured";
  }

  if (normalizedEntry.status === "not_captured") {
    normalizedEntry.validationOutcome = fallbackValidationOutcome;
  }

  return normalizedEntry;
}

export function normalizeValidationArtifacts(value, { validationOutcome = null } = {}) {
  if (value === undefined || value === null) {
    return [createValidationArtifactsPlaceholder(validationOutcome)];
  }

  if (!Array.isArray(value)) {
    throw new Error("must be an array");
  }

  const normalized = value.map((entry) => normalizeValidationArtifactEntry(entry, {
    validationOutcome
  }));
  if (normalized.length === 0) {
    return [createValidationArtifactsPlaceholder(validationOutcome)];
  }

  return normalized;
}

export function inferReviewability({
  status,
  stopReason = null,
  stopReasonCode = null,
  validationArtifacts = null,
  contractRuns = []
} = {}) {
  const normalizedStatus = normalizeString(status);
  if (!TERMINAL_REVIEWABILITY_STATUSES.has(normalizedStatus)) {
    return {
      status: "not_reviewable",
      reasons: ["non_terminal_status"]
    };
  }

  const reasons = [];
  if (normalizedStatus === "success") {
    const validationOutcome = normalizeValidationOutcome(null, {
      status: normalizedStatus
    });
    const normalizedValidationArtifacts = normalizeValidationArtifacts(validationArtifacts, {
      validationOutcome
    });
    const capturedValidationArtifacts = normalizedValidationArtifacts
      .filter((entry) => normalizeString(entry?.status) === "captured");
    if (capturedValidationArtifacts.length === 0) {
      reasons.push("validation_artifacts_not_captured");
    }

    const successfulContractRuns = Array.isArray(contractRuns)
      ? contractRuns.filter((contractRun) => normalizeString(contractRun?.status) === "success")
      : [];
    if (successfulContractRuns.length > 0) {
      const legacyContractRuns = [];

      for (const contractRun of successfulContractRuns) {
        if (!hasOwnProviderModelEvidenceRequirement(contractRun)) {
          legacyContractRuns.push(contractRun);
          continue;
        }

        const requirement = normalizeProviderModelEvidenceRequirement(contractRun.providerModelEvidenceRequirement, {
          fieldName: "contractRuns[].providerModelEvidenceRequirement"
        });
        if (requirement === "unknown") {
          reasons.push("provider_model_evidence_requirement_unknown");
          continue;
        }

        const typedSignals = collectProviderModelEvidenceSignalsFromTypedSelections(contractRun);
        if (!typedSignals.hasAnySignals || !typedSignals.hasSelectedProvider || !typedSignals.hasSelectedModel) {
          reasons.push("provider_model_evidence_missing");
        }
      }

      if (legacyContractRuns.length > 0) {
        const providerModelSignals = collectProviderModelEvidenceSignals(legacyContractRuns);
        if (!providerModelSignals.hasAnySignals) {
          reasons.push("provider_model_evidence_requirement_unknown");
        } else if (!providerModelSignals.hasSelectedProvider || !providerModelSignals.hasSelectedModel) {
          reasons.push("provider_model_evidence_missing");
        }
      }
    }
  } else {
    if (normalizeString(stopReason).length === 0) {
      reasons.push("missing_stop_reason");
    }
    if (normalizeString(stopReasonCode).length === 0) {
      reasons.push("missing_stop_reason_code");
    }
  }

  const normalizedReasons = sortReviewabilityReasons(unique(reasons));
  return {
    status: classifyReviewabilityStatusFromReasons(normalizedReasons),
    reasons: normalizedReasons
  };
}

export function normalizeReviewability(value, {
  status,
  stopReason = null,
  stopReasonCode = null,
  validationArtifacts = null,
  contractRuns = []
} = {}) {
  if (value === undefined || value === null) {
    return inferReviewability({
      status,
      stopReason,
      stopReasonCode,
      validationArtifacts,
      contractRuns
    });
  }

  if (!isPlainObject(value)) {
    throw new Error("must be an object");
  }

  const normalizedStatus = normalizeString(value.status);
  if (normalizedStatus.length === 0) {
    throw new Error("status must be a non-empty string");
  }
  if (!REVIEWABILITY_STATUSES.includes(normalizedStatus)) {
    throw new Error(`status must be one of: ${REVIEWABILITY_STATUSES.join(", ")}`);
  }

  const sourceReasons = value.reasons ?? [];
  if (!Array.isArray(sourceReasons)) {
    throw new Error("reasons must be an array");
  }
  const normalizedReasons = sortReviewabilityReasons(unique(sourceReasons.map((reason) => {
    const normalizedReason = normalizeString(reason);
    if (normalizedReason.length === 0) {
      throw new Error("reasons[] entries must be non-empty strings");
    }
    if (!REVIEWABILITY_REASONS.includes(normalizedReason)) {
      throw new Error(`reasons[] entries must be one of: ${REVIEWABILITY_REASONS.join(", ")}`);
    }
    return normalizedReason;
  })));

  const expectedStatus = classifyReviewabilityStatusFromReasons(normalizedReasons);
  if (normalizedStatus !== expectedStatus) {
    throw new Error(`status ${normalizedStatus} does not match reasons-derived status ${expectedStatus}`);
  }

  return {
    status: normalizedStatus,
    reasons: normalizedReasons
  };
}

export function normalizeChangedSurface(value, {
  fieldName = "changedSurface"
} = {}) {
  if (value === undefined || value === null) {
    return {
      capture: "not_captured",
      paths: []
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  const capture = normalizeString(value.capture);
  if (capture.length === 0) {
    throw new Error(`${fieldName}.capture must be a non-empty string`);
  }
  if (!CHANGED_SURFACE_CAPTURE_MODES.includes(capture)) {
    throw new Error(
      `${fieldName}.capture must be one of: ${CHANGED_SURFACE_CAPTURE_MODES.join(", ")}`
    );
  }

  const rawPaths = value.paths ?? [];
  if (!Array.isArray(rawPaths)) {
    throw new Error(`${fieldName}.paths must be an array`);
  }

  const paths = unique(rawPaths.map((pathValue, index) => (
    normalizeRepoRelativePath(pathValue, {
      fieldName: `${fieldName}.paths[${index}]`
    })
  )));

  if (capture === "not_captured" && paths.length > 0) {
    throw new Error(`${fieldName}.paths must be empty when ${fieldName}.capture is not_captured`);
  }

  return {
    capture,
    paths
  };
}

export function normalizeChangedSurfaceObservation(value, {
  fieldName = "changedSurfaceObservation"
} = {}) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = normalizeChangedSurface(value, {
    fieldName
  });

  if (!CHANGED_SURFACE_OBSERVATION_CAPTURE_MODES.includes(normalized.capture)) {
    throw new Error(
      `${fieldName}.capture must be one of: ${CHANGED_SURFACE_OBSERVATION_CAPTURE_MODES.join(", ")}`
    );
  }

  return normalized;
}

export function toArtifactReference(artifactType, artifactId) {
  const normalizedArtifactType = normalizeString(artifactType);
  const normalizedArtifactId = normalizeString(artifactId);
  if (normalizedArtifactType.length === 0 || normalizedArtifactId.length === 0) {
    return null;
  }
  return `${normalizedArtifactType}:${normalizedArtifactId}`;
}

export function normalizeSourceArtifactIds(value, { fallback = [] } = {}) {
  const source = value === undefined || value === null ? fallback : value;
  if (!Array.isArray(source)) {
    throw new Error("must be an array");
  }

  return unique(source
    .map((item) => normalizeString(item))
    .filter((item) => item.length > 0));
}

export function normalizeLineageDepth(value, { fallback = 0 } = {}) {
  const source = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(source) || source < 0) {
    throw new Error("must be an integer >= 0");
  }
  return source;
}
