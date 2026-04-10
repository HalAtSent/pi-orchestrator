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
  /^infra\//i,
  /^platform\/contracts\//i,
  /^docs\/specs\//i,
  /migration/i,
  /schema/i,
  /\.env/i
];

const PROTECTED_PATH_PATTERNS = [
  /^node_modules\//i,
  /^dist\//i,
  /^build\//i,
  /^coverage\//i,
  /\.env/i,
  /\.secret/i
];

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

export function isProtectedPath(path) {
  const normalized = normalizePath(path);
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function classifyRisk({ goal, allowedFiles = [] }) {
  const normalizedGoal = goal.toLowerCase();
  const normalizedFiles = allowedFiles.map(normalizePath);

  if (normalizedFiles.some((path) => HUMAN_GATE_PATH_PATTERNS.some((pattern) => pattern.test(path)))) {
    return "high";
  }

  if (HIGH_RISK_KEYWORDS.some((keyword) => normalizedGoal.includes(keyword))) {
    return "high";
  }

  if (normalizedFiles.length > 6) {
    return "medium";
  }

  if (normalizedFiles.some((path) => isProtectedPath(path))) {
    return "medium";
  }

  return "low";
}

export function requiresHumanGate({ goal, allowedFiles = [] }) {
  const normalizedGoal = goal.toLowerCase();
  const normalizedFiles = allowedFiles.map(normalizePath);

  return HIGH_RISK_KEYWORDS.some((keyword) => normalizedGoal.includes(keyword)) ||
    normalizedFiles.some((path) => HUMAN_GATE_PATH_PATTERNS.some((pattern) => pattern.test(path)));
}

export function defaultAcceptanceChecks(risk) {
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

  return checks;
}

export function defaultStopConditions(risk) {
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

  return stops;
}
