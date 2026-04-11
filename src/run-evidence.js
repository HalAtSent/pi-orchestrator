export const VALIDATION_OUTCOMES = Object.freeze([
  "pass",
  "fail",
  "blocked",
  "not_run"
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

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function unique(values) {
  return [...new Set(values)];
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
      }
    }
  }

  const normalizedStopReasonCode = normalizeString(stopReasonCode);
  for (const actionClass of STOP_REASON_CODE_TO_ACTION_CLASSES[normalizedStopReasonCode] ?? []) {
    inferred.add(actionClass);
  }

  return ACTION_CLASSES.filter((actionClass) => inferred.has(actionClass));
}

export function normalizeActionClasses(value, { contractRuns = [], stopReasonCode = null } = {}) {
  const inferred = inferActionClasses({
    contractRuns,
    stopReasonCode
  });
  if (value !== undefined && value !== null) {
    if (!Array.isArray(value)) {
      throw new Error("must be an array");
    }

    for (let index = 0; index < value.length; index += 1) {
      const normalized = normalizeString(value[index]);
      if (normalized.length === 0) {
        throw new Error(`actionClasses[${index}] must be a non-empty string`);
      }
      if (!ACTION_CLASSES.includes(normalized)) {
        throw new Error(`actionClasses[${index}] must be one of: ${ACTION_CLASSES.join(", ")}`);
      }
    }
  }

  return inferred;
}

export function normalizePolicyProfile(value) {
  const normalized = normalizeString(value);
  return normalized.length > 0 ? normalized : null;
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

  if (!hasReference && (normalizedStatus === null || normalizedStatus !== "not_captured")) {
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
