import { createTaskPacket } from "./contracts.js";
import {
  classifyRisk,
  defaultAcceptanceChecks,
  defaultStopConditions,
  isProtectedPath,
  requiresHumanGate
} from "./policies.js";

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeFiles(files = []) {
  return files.map((path) => path.replace(/\\/g, "/"));
}

function unique(values) {
  return [...new Set(values)];
}

export function makeRoleSequence(risk) {
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

export function buildTaskPacket({
  goal,
  role,
  allowedFiles = [],
  forbiddenFiles = [],
  parentTaskId,
  risk,
  contextFiles = []
}) {
  const normalizedAllowedFiles = normalizeFiles(allowedFiles);
  const normalizedForbiddenFiles = unique([
    ...normalizeFiles(forbiddenFiles),
    ...normalizedAllowedFiles.filter((path) => isProtectedPath(path))
  ]);
  const packetId = `${role}-${slugify(goal) || "task"}`;

  return createTaskPacket({
    id: packetId,
    parentTaskId,
    role,
    risk,
    goal,
    nonGoals: roleNonGoals(role),
    allowedFiles: normalizedAllowedFiles,
    forbiddenFiles: normalizedForbiddenFiles,
    acceptanceChecks: defaultAcceptanceChecks(risk),
    stopConditions: defaultStopConditions(risk),
    contextFiles: normalizeFiles(contextFiles),
    commands: roleCommands(role)
  });
}

export function createInitialWorkflow({
  goal,
  allowedFiles = [],
  forbiddenFiles = [],
  contextFiles = []
}) {
  const normalizedAllowedFiles = normalizeFiles(allowedFiles);
  const risk = classifyRisk({ goal, allowedFiles: normalizedAllowedFiles });
  const roleSequence = makeRoleSequence(risk);
  const humanGate = requiresHumanGate({ goal, allowedFiles: normalizedAllowedFiles });
  const workflowId = `workflow-${slugify(goal) || "task"}`;

  const packets = roleSequence.map((role) => buildTaskPacket({
    goal,
    role,
    allowedFiles: normalizedAllowedFiles,
    forbiddenFiles,
    parentTaskId: workflowId,
    risk,
    contextFiles
  }));

  return {
    workflowId,
    goal,
    risk,
    humanGate,
    roleSequence,
    packets
  };
}
