import { normalizeScopedPath } from "./path-scopes.js";

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

function isDirectoryScope(path) {
  return normalizePath(path).endsWith("/");
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
