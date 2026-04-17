import { AUTO_BACKEND_MODES } from "./auto-backend-runner.js";

export const POLICY_ENFORCED_ACTION_CLASSES = Object.freeze([
  "execute_local_command",
  "install_dependency",
  "mutate_git_state"
]);

export const POLICY_DECISION_STATUSES = Object.freeze([
  "allowed",
  "blocked",
  "approval_required"
]);

export const POLICY_DECISION_REASONS = Object.freeze([
  "profile_allows_execution",
  "profile_disallows_process_backend",
  "profile_disallows_action_class",
  "profile_requires_human_gate",
  "unknown_profile"
]);

export const DEFAULT_POLICY_PROFILE = "default";

const POLICY_PROFILE_FIELDS = Object.freeze([
  "id",
  "allowedActionClasses",
  "allowProcessBackend",
  "requireHumanGateBeforeExecution"
]);

const PROCESS_SUBAGENT_ROLES = new Set([
  "explorer",
  "implementer",
  "reviewer",
  "verifier"
]);

const POLICY_PROFILE_REGISTRY = Object.freeze({
  default: Object.freeze({
    id: "default",
    allowedActionClasses: Object.freeze([...POLICY_ENFORCED_ACTION_CLASSES]),
    allowProcessBackend: true,
    requireHumanGateBeforeExecution: false
  })
});

export const VALID_POLICY_PROFILES = Object.freeze(Object.keys(POLICY_PROFILE_REGISTRY));

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
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeKnownActionClasses(value, { fieldName } = {}) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }

  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const actionClass = normalizeString(value[index]);
    if (actionClass.length === 0) {
      throw new Error(`${fieldName}[${index}] must be a non-empty string`);
    }
    if (!POLICY_ENFORCED_ACTION_CLASSES.includes(actionClass)) {
      throw new Error(
        `${fieldName}[${index}] must be one of: ${POLICY_ENFORCED_ACTION_CLASSES.join(", ")}`
      );
    }
    seen.add(actionClass);
  }

  return POLICY_ENFORCED_ACTION_CLASSES.filter((actionClass) => seen.has(actionClass));
}

function normalizeDetectedPolicyActionClasses(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }
    const actionClass = item.trim();
    if (actionClass.length === 0) {
      return null;
    }
    normalized.push(actionClass);
  }

  const detectedSet = new Set(unique(normalized));
  return POLICY_ENFORCED_ACTION_CLASSES.filter((actionClass) => detectedSet.has(actionClass));
}

function parseRequestedProfileIdForDecision(value) {
  if (value === undefined || value === null) {
    return DEFAULT_POLICY_PROFILE;
  }

  if (typeof value !== "string") {
    return "unknown";
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "unknown";
}

function decisionFor(profileId, status, reason) {
  return normalizePolicyDecision({
    profileId,
    status,
    reason
  }, {
    fieldName: "policyDecision",
    allowMissing: false
  });
}

function derivePacketRoles(workflow) {
  if (!isPlainObject(workflow) || !Array.isArray(workflow.packets)) {
    return null;
  }

  const roles = [];
  for (let index = 0; index < workflow.packets.length; index += 1) {
    const packet = workflow.packets[index];
    if (!isPlainObject(packet)) {
      return null;
    }

    const role = normalizeString(packet.role);
    if (role.length === 0) {
      return null;
    }
    roles.push(role);
  }

  return unique(roles);
}

function inferProcessBackendRequirementFromMode(mode, workflow) {
  const normalizedMode = normalizeString(mode);
  if (normalizedMode.length === 0) {
    return null;
  }

  if (normalizedMode === AUTO_BACKEND_MODES.PI_RUNTIME) {
    return false;
  }

  const roles = derivePacketRoles(workflow);
  if (!roles) {
    return null;
  }

  if (normalizedMode === AUTO_BACKEND_MODES.PROCESS_SUBAGENTS) {
    return roles.some((role) => PROCESS_SUBAGENT_ROLES.has(role));
  }

  if (normalizedMode === AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER) {
    const workflowRisk = normalizeString(workflow?.risk);
    if (workflowRisk.length === 0) {
      return null;
    }
    if (workflowRisk !== "low") {
      return false;
    }

    return roles.some((role) => role === "implementer" || role === "verifier");
  }

  return null;
}

export function normalizePolicyProfileId(value, {
  fieldName = "policyProfile",
  allowMissing = true
} = {}) {
  if (value === undefined || value === null) {
    if (!allowMissing) {
      throw new Error(`${fieldName} must be a non-empty string`);
    }

    return DEFAULT_POLICY_PROFILE;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  if (!VALID_POLICY_PROFILES.includes(normalized)) {
    throw new Error(`${fieldName} must be one of: ${VALID_POLICY_PROFILES.join(", ")}`);
  }

  return normalized;
}

export function normalizeCompiledPolicyProfile(value, {
  fieldName = "policyProfile",
  allowMissing = false
} = {}) {
  if (value === undefined || value === null) {
    if (allowMissing) {
      return null;
    }
    throw new Error(`${fieldName} must be an object`);
  }

  if (!isPlainObject(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  const extraFields = Object.keys(value).filter((key) => !POLICY_PROFILE_FIELDS.includes(key));
  if (extraFields.length > 0) {
    throw new Error(`${fieldName} has unsupported fields: ${extraFields.join(", ")}`);
  }

  const id = normalizePolicyProfileId(value.id, {
    fieldName: `${fieldName}.id`,
    allowMissing: false
  });
  const allowedActionClasses = normalizeKnownActionClasses(value.allowedActionClasses, {
    fieldName: `${fieldName}.allowedActionClasses`
  });

  if (typeof value.allowProcessBackend !== "boolean") {
    throw new Error(`${fieldName}.allowProcessBackend must be a boolean`);
  }
  if (typeof value.requireHumanGateBeforeExecution !== "boolean") {
    throw new Error(`${fieldName}.requireHumanGateBeforeExecution must be a boolean`);
  }

  return {
    id,
    allowedActionClasses,
    allowProcessBackend: value.allowProcessBackend,
    requireHumanGateBeforeExecution: value.requireHumanGateBeforeExecution
  };
}

export function resolveCompiledPolicyProfile(profileIdInput) {
  const profileId = normalizePolicyProfileId(profileIdInput, {
    allowMissing: true
  });
  const profile = POLICY_PROFILE_REGISTRY[profileId];
  if (!profile) {
    throw new Error(`policyProfile must be one of: ${VALID_POLICY_PROFILES.join(", ")}`);
  }

  return normalizeCompiledPolicyProfile(profile, {
    fieldName: "policyProfile",
    allowMissing: false
  });
}

export function normalizePolicyDecision(value, {
  fieldName = "policyDecision",
  allowMissing = true
} = {}) {
  if (value === undefined || value === null) {
    if (allowMissing) {
      return null;
    }
    throw new Error(`${fieldName} must be an object`);
  }

  if (!isPlainObject(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  const expectedFields = ["profileId", "status", "reason"];
  const extraFields = Object.keys(value).filter((key) => !expectedFields.includes(key));
  if (extraFields.length > 0) {
    throw new Error(`${fieldName} has unsupported fields: ${extraFields.join(", ")}`);
  }

  const status = normalizeString(value.status);
  if (status.length === 0) {
    throw new Error(`${fieldName}.status must be a non-empty string`);
  }
  if (!POLICY_DECISION_STATUSES.includes(status)) {
    throw new Error(`${fieldName}.status must be one of: ${POLICY_DECISION_STATUSES.join(", ")}`);
  }

  const reason = normalizeString(value.reason);
  if (reason.length === 0) {
    throw new Error(`${fieldName}.reason must be a non-empty string`);
  }
  if (!POLICY_DECISION_REASONS.includes(reason)) {
    throw new Error(`${fieldName}.reason must be one of: ${POLICY_DECISION_REASONS.join(", ")}`);
  }

  const profileId = reason === "unknown_profile"
    ? normalizeString(value.profileId)
    : normalizePolicyProfileId(value.profileId, {
      fieldName: `${fieldName}.profileId`,
      allowMissing: false
    });
  if (profileId.length === 0) {
    throw new Error(`${fieldName}.profileId must be a non-empty string`);
  }

  if (status === "allowed" && reason !== "profile_allows_execution") {
    throw new Error(
      `${fieldName}.reason must be profile_allows_execution when ${fieldName}.status is allowed`
    );
  }
  if (status === "approval_required" && reason !== "profile_requires_human_gate") {
    throw new Error(
      `${fieldName}.reason must be profile_requires_human_gate when ${fieldName}.status is approval_required`
    );
  }
  if (status === "blocked" && ![
    "profile_disallows_process_backend",
    "profile_disallows_action_class",
    "unknown_profile"
  ].includes(reason)) {
    throw new Error(
      `${fieldName}.reason must be one of: profile_disallows_process_backend, profile_disallows_action_class, unknown_profile when ${fieldName}.status is blocked`
    );
  }

  return {
    profileId,
    status,
    reason
  };
}

export function inferWorkflowRequiresProcessBackend({
  runner,
  workflow
} = {}) {
  if (runner && typeof runner.requiresProcessBackendForWorkflow === "function") {
    const required = runner.requiresProcessBackendForWorkflow(workflow);
    return typeof required === "boolean" ? required : null;
  }

  if (runner && typeof runner.getExecutionBackendMode === "function") {
    return inferProcessBackendRequirementFromMode(runner.getExecutionBackendMode(), workflow);
  }

  return null;
}

export function evaluatePolicyDecisionAgainstProfile(profileInput, {
  detectedActionClasses,
  requiresProcessBackend,
  humanGateApproved = false
} = {}) {
  const profile = normalizeCompiledPolicyProfile(profileInput, {
    fieldName: "policyProfile",
    allowMissing: false
  });
  const normalizedActionClasses = normalizeDetectedPolicyActionClasses(detectedActionClasses);
  if (!normalizedActionClasses) {
    return decisionFor(profile.id, "blocked", "profile_disallows_action_class");
  }

  const disallowedActionClasses = normalizedActionClasses.filter(
    (actionClass) => !profile.allowedActionClasses.includes(actionClass)
  );
  if (disallowedActionClasses.length > 0) {
    return decisionFor(profile.id, "blocked", "profile_disallows_action_class");
  }

  if (!profile.allowProcessBackend) {
    if (requiresProcessBackend !== false) {
      return decisionFor(profile.id, "blocked", "profile_disallows_process_backend");
    }
  }

  if (profile.requireHumanGateBeforeExecution && humanGateApproved !== true) {
    return decisionFor(profile.id, "approval_required", "profile_requires_human_gate");
  }

  return decisionFor(profile.id, "allowed", "profile_allows_execution");
}

export function evaluatePolicyDecision({
  profileId,
  detectedActionClasses,
  requiresProcessBackend,
  humanGateApproved = false
} = {}) {
  try {
    const profile = resolveCompiledPolicyProfile(profileId);
    return evaluatePolicyDecisionAgainstProfile(profile, {
      detectedActionClasses,
      requiresProcessBackend,
      humanGateApproved
    });
  } catch {
    const unresolvedProfileId = parseRequestedProfileIdForDecision(profileId);
    return decisionFor(unresolvedProfileId, "blocked", "unknown_profile");
  }
}
