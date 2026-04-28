import { createTaskPacket } from "./contracts.js";
import { normalizeRelativeScopePath, scopesOverlap } from "./path-scopes.js";
import {
  classifyRisk,
  defaultAcceptanceChecks,
  defaultStopConditions,
  isProtectedPath,
  laneRequiresIndependentReview,
  requiresHumanGate,
  resolveTaskLane
} from "./policies.js";
import { buildPacketContextManifest } from "./context-manifest.js";

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeFiles(files = []) {
  return files.map((path, index) => normalizeRelativeScopePath(path, {
    fieldName: `files[${index}]`
  }));
}

function unique(values) {
  return [...new Set(values)];
}

function findProtectedAllowlistPaths(allowedFiles) {
  return unique(allowedFiles.filter((path) => isProtectedPath(path)));
}

function findSharedScopePaths(allowedFiles, forbiddenFiles) {
  return unique(allowedFiles.filter((allowedPath) => (
    forbiddenFiles.some((forbiddenPath) => scopesOverlap(allowedPath, forbiddenPath))
  )));
}

function validateScopeConfig({ allowedFiles = [], forbiddenFiles = [] }) {
  if (allowedFiles.length === 0) {
    throw new Error("allowedFiles must contain at least one file path");
  }

  const protectedAllowlistPaths = findProtectedAllowlistPaths(allowedFiles);
  if (protectedAllowlistPaths.length > 0) {
    throw new Error(`allowedFiles contains protected path(s): ${protectedAllowlistPaths.join(", ")}`);
  }

  const sharedScopePaths = findSharedScopePaths(allowedFiles, forbiddenFiles);
  if (sharedScopePaths.length > 0) {
    throw new Error(`allowedFiles and forbiddenFiles must not overlap by scope: ${sharedScopePaths.join(", ")}`);
  }
}

export function makeRoleSequence(risk, lane = null) {
  if (lane !== null && laneRequiresIndependentReview(lane)) {
    return ["explorer", "implementer", "reviewer", "verifier"];
  }

  if (risk === "high") {
    return ["explorer", "implementer", "reviewer", "verifier"];
  }

  if (risk === "medium") {
    return ["explorer", "implementer", "reviewer", "verifier"];
  }

  return ["implementer", "verifier"];
}

function roleNonGoals(role) {
  if (role === "explorer") {
    return [
      "Do not edit files.",
      "Do not treat reconnaissance as permission to widen scope.",
      "Do not propose broad refactors.",
      "Do not speculate when the code does not support a claim."
    ];
  }

  if (role === "reviewer") {
    return [
      "Do not edit files.",
      "Do not re-implement the task.",
      "Do not approve changes without evidence."
    ];
  }

  if (role === "verifier") {
    return [
      "Do not edit code except to fix the verification harness itself.",
      "Do not reinterpret failing output optimistically.",
      "Do not hide missing commands or skipped checks."
    ];
  }

  return [
    "Do not edit files outside the allowlist.",
    "Do not widen scope beyond the packet goal.",
    "Do not self-approve or skip evidence collection."
  ];
}

function roleCommands(role) {
  if (role === "explorer") {
    return ["rg --files", "rg -n '<symbol|pattern>' ."];
  }

  if (role === "reviewer") {
    return ["git diff --stat", "git diff -- <touched-files>"];
  }

  if (role === "verifier") {
    return ["<repo-specific test or lint command>", "<targeted repro command>"];
  }

  return ["<repo-specific edit and test commands>"];
}

function roleGoal(goal, role) {
  if (role === "explorer") {
    return `Inspect the scoped codebase context for this task, produce read-only reconnaissance, and report what the implementer should change: ${goal}`;
  }

  if (role === "reviewer") {
    return `Review the scoped implementation independently against the original goal and acceptance checks: ${goal}`;
  }

  if (role === "verifier") {
    return `Verify the scoped implementation against the original goal and acceptance checks: ${goal}`;
  }

  return goal;
}

export function buildTaskPacket(input) {
  const {
    goal,
    role,
    allowedFiles = [],
    forbiddenFiles = [],
    parentTaskId,
    risk,
    contextFiles = []
  } = input;
  const normalizedAllowedFiles = unique(normalizeFiles(allowedFiles));
  const normalizedForbiddenFiles = unique(normalizeFiles(forbiddenFiles));
  const normalizedContextFiles = normalizeFiles(contextFiles);
  const lane = resolveTaskLane({
    goal,
    allowedFiles: normalizedAllowedFiles,
    lane: input.lane,
    hasUserSuppliedLane: Object.prototype.hasOwnProperty.call(input, "lane")
  });
  validateScopeConfig({
    allowedFiles: normalizedAllowedFiles,
    forbiddenFiles: normalizedForbiddenFiles
  });
  const packetId = `${role}-${slugify(goal) || "task"}`;

  return createTaskPacket({
    id: packetId,
    parentTaskId,
    role,
    risk,
    lane,
    goal: roleGoal(goal, role),
    nonGoals: roleNonGoals(role),
    allowedFiles: normalizedAllowedFiles,
    forbiddenFiles: normalizedForbiddenFiles,
    acceptanceChecks: defaultAcceptanceChecks(risk, lane),
    stopConditions: defaultStopConditions(risk, lane),
    contextFiles: normalizedContextFiles,
    contextManifest: buildPacketContextManifest(normalizedContextFiles),
    commands: roleCommands(role)
  });
}

export function createInitialWorkflow(input) {
  const {
    goal,
    allowedFiles = [],
    forbiddenFiles = [],
    contextFiles = []
  } = input;
  const normalizedAllowedFiles = unique(normalizeFiles(allowedFiles));
  const normalizedForbiddenFiles = unique(normalizeFiles(forbiddenFiles));
  validateScopeConfig({
    allowedFiles: normalizedAllowedFiles,
    forbiddenFiles: normalizedForbiddenFiles
  });
  const risk = classifyRisk({ goal, allowedFiles: normalizedAllowedFiles });
  const lane = resolveTaskLane({
    goal,
    allowedFiles: normalizedAllowedFiles,
    lane: input.lane,
    hasUserSuppliedLane: Object.prototype.hasOwnProperty.call(input, "lane")
  });
  const roleSequence = makeRoleSequence(risk, lane);
  const humanGate = risk === "high" || requiresHumanGate({ goal, allowedFiles: normalizedAllowedFiles, lane });
  const workflowId = `workflow-${slugify(goal) || "task"}`;

  const packets = roleSequence.map((role) => buildTaskPacket({
    goal,
    role,
    allowedFiles: normalizedAllowedFiles,
    forbiddenFiles: normalizedForbiddenFiles,
    parentTaskId: workflowId,
    risk,
    lane,
    contextFiles
  }));

  return {
    workflowId,
    goal,
    risk,
    lane,
    humanGate,
    roleSequence,
    packets
  };
}
