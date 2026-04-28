import { normalizeScopedPath } from "./path-scopes.js";

export const TASK_LANES = Object.freeze([
  "tiny_edit",
  "docs_only",
  "test_only",
  "bounded_bugfix",
  "feature_slice",
  "refactor",
  "migration",
  "policy_or_harness_change"
]);

const HIGH_RISK_KEYWORDS = [
  "migration",
  "schema",
  "auth",
  "permission",
  "secret",
  "oauth",
  "billing",
  "payment",
  "crypto",
  "delete",
  "remove",
  "refactor",
  "infra",
  "deploy",
  "public api"
];

const HUMAN_GATE_PATH_PATTERNS = [
  /^\.git(?:\/|$)/i,
  /^\.pi(?:\/|$)/i,
  /^infra\//i,
  /^platform\/contracts\//i,
  /^docs\/agents\//i,
  /^docs\/HARNESS-CONTRACT\.md$/i,
  /^docs\/RUN-EVIDENCE-SCHEMA\.md$/i,
  /^docs\/POLICY-PROFILES\.md$/i,
  /migration/i,
  /schema/i,
  /\.env/i
];

const DOC_PATH_PATTERNS = [
  /^docs\//i,
  /^README\.md$/i,
  /^CHANGELOG\.md$/i,
  /^CONTRIBUTING\.md$/i,
  /^LICENSE(?:\.md)?$/i,
  /\.mdx?$/i
];

const TEST_PATH_PATTERNS = [
  /^test\//i,
  /^tests\//i,
  /^__tests__\//i,
  /\/__tests__\//i,
  /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i
];

const HARNESS_POLICY_PATH_PATTERNS = [
  /^src\/policies\.js$/i,
  /^src\/policy-profiles\.js$/i,
  /^src\/orchestrator\.js$/i,
  /^src\/program-compiler\.js$/i,
  /^src\/program-contract-executor\.js$/i,
  /^src\/auto-workflow\.js$/i,
  /^src\/auto-backend-runner\.js$/i,
  /^src\/project-contracts\.js$/i,
  /^src\/contracts\.js$/i,
  /^src\/run-evidence\.js$/i,
  /^src\/run-store\.js$/i,
  /^src\/build-session-store\.js$/i,
  /^src\/pi-extension\.js$/i,
  /^docs\/HARNESS-CONTRACT\.md$/i,
  /^docs\/RUN-EVIDENCE-SCHEMA\.md$/i,
  /^docs\/POLICY-PROFILES\.md$/i
];

const HARNESS_POLICY_GOAL_PATTERNS = [
  /\bharness\b/i,
  /\borchestrator\b/i,
  /\bapproval\s+(?:binding|gate|policy|semantics|scope)\b/i,
  /\bhuman\s+gate\b/i,
  /\brisk\s+classif(?:y|ier|ication)\b/i,
  /\btask\s+lane(s)?\b/i,
  /\brole\s+sequence\b/i,
  /\bworker\s+boundary\b/i,
  /\btask\s+packet\b/i,
  /\bevidence\s+schema\b/i,
  /\brun\s+journal\b/i,
  /\bpolicy\s+profile(s)?\b/i
];

const MIGRATION_PATH_PATTERNS = [
  /(?:^|\/)migrations?\//i,
  /(?:^|\/)schema\//i,
  /(?:^|\/)db\/migrate/i,
  /migration/i
];

const MIGRATION_GOAL_PATTERNS = [
  /\bschema\s+migration\b/i,
  /\bdata\s+migration\b/i,
  /\bdatabase\s+migration\b/i,
  /\bmigrat(?:e|es|ed|ing|ion|ions)\b/i
];

const REFACTOR_GOAL_PATTERNS = [
  /\brefactor(?:s|ed|ing)?\b/i,
  /\brestructure(?:s|d|ing)?\b/i,
  /\breorganize(?:s|d|ing)?\b/i,
  /\bextract\s+(?:a\s+)?(?:helper|module|component|service)\b/i
];

const BUGFIX_GOAL_PATTERNS = [
  /\bfix(?:es|ed|ing)?\b/i,
  /\bbug(?:fix)?\b/i,
  /\bregression\b/i,
  /\bcrash(?:es|ed|ing)?\b/i,
  /\bfail(?:ing|ed|s)?\b/i,
  /\berror\b/i,
  /\brepair\b/i
];

const FEATURE_GOAL_PATTERNS = [
  /\badd(?:s|ed|ing)?\b/i,
  /\bimplement(?:s|ed|ing)?\b/i,
  /\bintroduce(?:s|d|ing)?\b/i,
  /\bsupport(?:s|ed|ing)?\b/i,
  /\bcreate(?:s|d|ing)?\b/i,
  /\bwire(?:s|d|ing)?\b/i,
  /\bbuild(?:s|ing)?\b/i
];

const TINY_EDIT_GOAL_PATTERNS = [
  /\btiny\b/i,
  /\bsmall\b/i,
  /\bone[-\s]?line\b/i,
  /\btypo\b/i,
  /\brename(?:s|d|ing)?\b/i,
  /\bcopy\s+edit\b/i,
  /\bwording\b/i,
  /\bcomment\b/i,
  /\bformat(?:s|ted|ting)?\b/i
];

const HUMAN_GATE_LANES = new Set([
  "refactor",
  "migration",
  "policy_or_harness_change"
]);

const INDEPENDENT_REVIEW_LANES = new Set([
  "refactor",
  "migration",
  "policy_or_harness_change"
]);

const PROTECTED_PATH_PATTERNS = [
  /^\.git(?:\/|$)/i,
  /^\.pi(?:\/|$)/i,
  /^node_modules\//i,
  /^dist\//i,
  /^build\//i,
  /^coverage\//i,
  /\.env/i,
  /\.secret/i
];

function normalizePath(value) {
  return normalizeScopedPath(value);
}

function normalizeGoal(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isDirectoryScope(path) {
  return normalizePath(path).endsWith("/");
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function allFilesMatch(files, patterns) {
  return files.length > 0 && files.every((file) => matchesAny(file, patterns));
}

function hasOnlyFileScopes(files) {
  return files.every((file) => !isDirectoryScope(file));
}

export function validateTaskLane(value, { fieldName = "lane" } = {}) {
  if (!TASK_LANES.includes(value)) {
    throw new Error(`${fieldName} must be one of: ${TASK_LANES.join(", ")}`);
  }

  return value;
}

export function classifyTaskLane({ goal, allowedFiles = [] } = {}) {
  const normalizedGoal = normalizeGoal(goal);
  const normalizedFiles = allowedFiles
    .filter((path) => typeof path === "string")
    .map(normalizePath);

  if (
    normalizedFiles.some((path) => matchesAny(path, HARNESS_POLICY_PATH_PATTERNS)) ||
    matchesAny(normalizedGoal, HARNESS_POLICY_GOAL_PATTERNS)
  ) {
    return "policy_or_harness_change";
  }

  if (allFilesMatch(normalizedFiles, DOC_PATH_PATTERNS)) {
    return "docs_only";
  }

  if (allFilesMatch(normalizedFiles, TEST_PATH_PATTERNS)) {
    return "test_only";
  }

  if (
    normalizedFiles.some((path) => matchesAny(path, MIGRATION_PATH_PATTERNS)) ||
    matchesAny(normalizedGoal, MIGRATION_GOAL_PATTERNS)
  ) {
    return "migration";
  }

  if (matchesAny(normalizedGoal, REFACTOR_GOAL_PATTERNS)) {
    return "refactor";
  }

  if (matchesAny(normalizedGoal, BUGFIX_GOAL_PATTERNS)) {
    return "bounded_bugfix";
  }

  if (
    normalizedFiles.length > 0 &&
    normalizedFiles.length <= 2 &&
    hasOnlyFileScopes(normalizedFiles) &&
    matchesAny(normalizedGoal, TINY_EDIT_GOAL_PATTERNS)
  ) {
    return "tiny_edit";
  }

  if (matchesAny(normalizedGoal, FEATURE_GOAL_PATTERNS)) {
    return "feature_slice";
  }

  return "feature_slice";
}

export function resolveTaskLane({
  goal,
  allowedFiles = [],
  lane,
  hasUserSuppliedLane = false,
  fieldName = "lane"
} = {}) {
  const inferredLane = classifyTaskLane({ goal, allowedFiles });

  if (hasUserSuppliedLane) {
    const suppliedLane = validateTaskLane(lane, { fieldName });
    if (suppliedLane === inferredLane) {
      return suppliedLane;
    }
    if (HUMAN_GATE_LANES.has(suppliedLane) && !HUMAN_GATE_LANES.has(inferredLane)) {
      return suppliedLane;
    }
    throw new Error(`${fieldName} conflicts with inferred task lane: ${inferredLane}`);
  }

  return inferredLane;
}

export function laneRequiresHumanGate(lane) {
  return HUMAN_GATE_LANES.has(validateTaskLane(lane));
}

export function laneRequiresIndependentReview(lane) {
  return INDEPENDENT_REVIEW_LANES.has(validateTaskLane(lane));
}

export function isProtectedPath(path) {
  const normalized = normalizePath(path);
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function findProtectedPaths(paths = []) {
  return paths
    .filter((path) => typeof path === "string")
    .map(normalizePath)
    .filter((path) => path.length > 0 && isProtectedPath(path));
}

export function findProtectedPacketPaths(packet = {}) {
  return findProtectedPaths([
    ...(Array.isArray(packet?.allowedFiles) ? packet.allowedFiles : []),
    ...(Array.isArray(packet?.forbiddenFiles) ? packet.forbiddenFiles : []),
    ...(Array.isArray(packet?.contextFiles) ? packet.contextFiles : [])
  ]);
}

export function classifyRisk({ goal, allowedFiles = [] }) {
  const normalizedGoal = typeof goal === "string" ? goal.toLowerCase() : "";
  const normalizedFiles = allowedFiles.map(normalizePath);

  if (normalizedFiles.some((path) => HUMAN_GATE_PATH_PATTERNS.some((pattern) => pattern.test(path)))) {
    return "high";
  }

  if (HIGH_RISK_KEYWORDS.some((keyword) => normalizedGoal.includes(keyword))) {
    return "high";
  }

  if (normalizedFiles.some((path) => isDirectoryScope(path))) {
    return "medium";
  }

  if (normalizedFiles.length > 6) {
    return "medium";
  }

  if (normalizedFiles.some((path) => isProtectedPath(path))) {
    return "medium";
  }

  return "low";
}

export function requiresHumanGate({ goal, allowedFiles = [], lane } = {}) {
  const normalizedGoal = normalizeGoal(goal).toLowerCase();
  const normalizedFiles = allowedFiles.map(normalizePath);
  const resolvedLane = resolveTaskLane({
    goal,
    allowedFiles: normalizedFiles,
    lane,
    hasUserSuppliedLane: lane !== undefined
  });

  return laneRequiresHumanGate(resolvedLane) ||
    HIGH_RISK_KEYWORDS.some((keyword) => normalizedGoal.includes(keyword)) ||
    normalizedFiles.some((path) => HUMAN_GATE_PATH_PATTERNS.some((pattern) => pattern.test(path)));
}

export function defaultAcceptanceChecks(risk, lane = "feature_slice") {
  const resolvedLane = validateTaskLane(lane);
  const checks = [
    "Changes stay within the declared file scope.",
    "Behavior matches the task goal without widening scope.",
    "Claims are backed by explicit tool or test evidence."
  ];

  if (risk !== "low") {
    checks.push("Review must be performed by an agent that did not implement the patch.");
  }

  if (risk === "high") {
    checks.push("Human approval is required before merge or destructive operations.");
  }

  if (resolvedLane === "docs_only") {
    checks.push("Documentation describes implemented behavior only, not aspirational behavior.");
  } else if (resolvedLane === "test_only") {
    checks.push("Changed tests map to implemented behavior and do not weaken assertions to pass.");
  } else if (resolvedLane === "migration") {
    checks.push("Migration, rollback, and compatibility impact are explicit and independently reviewed.");
  } else if (resolvedLane === "refactor") {
    checks.push("Behavior preservation is evidenced for the refactored surface.");
  } else if (resolvedLane === "policy_or_harness_change") {
    checks.push("Policy, scope, approval, and evidence semantics stay code-owned and documented truthfully.");
  }

  return checks;
}

export function defaultStopConditions(risk, lane = "feature_slice") {
  const resolvedLane = validateTaskLane(lane);
  const stops = [
    "Stop if the task requires editing files outside the allowlist.",
    "Stop if the relevant code path cannot be located with high confidence.",
    "Stop if tests fail and the failure source is unclear."
  ];

  if (risk !== "low") {
    stops.push("Stop if the requested change alters public behavior beyond the stated goal.");
  }

  if (risk === "high") {
    stops.push("Stop and escalate before schema, auth, infra, or destructive changes.");
  }

  if (resolvedLane === "docs_only") {
    stops.push("Stop if the documentation change would describe behavior not implemented in code.");
  } else if (resolvedLane === "test_only") {
    stops.push("Stop if the test change requires production behavior changes outside the allowlist.");
  } else if (resolvedLane === "migration") {
    stops.push("Stop before migration or data-shape changes without explicit human approval.");
  } else if (resolvedLane === "refactor") {
    stops.push("Stop if behavior preservation cannot be checked for the refactored path.");
  } else if (resolvedLane === "policy_or_harness_change") {
    stops.push("Stop before changing policy, approval, or evidence semantics without explicit human approval.");
  }

  return stops;
}
