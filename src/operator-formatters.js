import { getRunJournalResumePolicy } from "./program-runner.js";

function listLines(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return ["- none provided"];
  }

  return items.map((item) => `- ${item}`);
}

function summarizeMilestones(milestones) {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    return ["- Milestones will be generated from the lifecycle planner."];
  }

  return milestones.map((milestone, index) => (
    `- Stage ${index + 1}: ${milestone.title} (${milestone.summary})`
  ));
}

function quoteGoalForCommand(goal) {
  const normalized = String(goal).replace(/\s+/g, " ").trim();
  const escaped = normalized.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");

  if (escaped.length > 140) {
    return "\"<same idea as above>\"";
  }

  return `"${escaped}"`;
}

function formatApprovalState(approval) {
  if (!approval || approval.approved !== true) {
    return "pending";
  }

  return approval.approvedAt
    ? `approved at ${approval.approvedAt}`
    : "approved";
}

function formatBuildSessionNextAction(buildSession) {
  const approvalPending = !buildSession.approval || buildSession.approval.approved !== true;
  if (approvalPending || buildSession.execution.status === "awaiting_approval") {
    return `Approve kickoff with /build-approve ${buildSession.buildId}.`;
  }

  if (buildSession.execution.status === "approved") {
    return "Approval is recorded. Execution can start now.";
  }

  return formatOperatorBuildNextAction({
    programId: buildSession.execution.programId,
    status: buildSession.execution.status,
    stopReason: buildSession.execution.stopReason
  });
}

export function formatOperatorBuildNextAction(runJournal) {
  if (!runJournal) {
    return "Execution has not started yet.";
  }

  const policy = getRunJournalResumePolicy(runJournal.status);
  const hasProgramId = typeof runJournal.programId === "string" && runJournal.programId.trim().length > 0;

  if (policy === "resume" && hasProgramId) {
    return `Run is still in progress. Continue with /resume-program ${runJournal.programId}.`;
  }

  if (policy === "return_existing") {
    return "Review evidence and decide whether to run another /build for the next slice.";
  }

  if (policy === "reject_terminal") {
    return "Execution stopped in a terminal state and cannot be resumed. Review the stop reason, then start a new /build.";
  }

  return "Review the run status and stop reason before choosing the next command.";
}

export function formatOperatorIntakeSummary(intake) {
  return [
    "Intake Summary",
    `Goal: ${intake.goal}`,
    `Audience: ${intake.targetUsers.length > 0 ? intake.targetUsers.join(", ") : "not specified yet"}`,
    "Constraints:",
    ...listLines(intake.constraints),
    "Success signals:",
    ...listLines(intake.successSignals),
    "Preferences:",
    ...listLines(intake.stackPreferences),
    "Out of scope:",
    ...listLines(intake.nonGoals)
  ].join("\n");
}

export function formatOperatorStagedPlan(lifecycle) {
  const recommendedAlternative = lifecycle.proposalSet.alternatives.find((alternative) => (
    alternative.id === lifecycle.proposalSet.recommendedAlternativeId
  ));
  const contractCount = lifecycle.executionProgram.contracts.length;

  return [
    "Staged Plan",
    `1. Brainstorm: compared ${lifecycle.proposalSet.alternatives.length} options and recommended "${recommendedAlternative?.title ?? lifecycle.proposalSet.recommendedAlternativeId}".`,
    `2. Blueprint: locked a ${lifecycle.blueprint.projectType} plan in ${lifecycle.blueprint.executionProfile.autonomyMode} mode with ${lifecycle.blueprint.executionProfile.humanGatePolicy}.`,
    `3. Slice: generated ${contractCount} bounded contract(s) in ExecutionProgram ${lifecycle.executionProgram.id}.`,
    `4. Audit: current status is ${lifecycle.auditReport.status}.`,
    "Planned milestones:",
    ...summarizeMilestones(lifecycle.proposalSet.milestoneTrack)
  ].join("\n");
}

export function formatOperatorApprovalCheckpoint({
  intake,
  lifecycle,
  approvalRequested,
  runJournal = null,
  approvalCommand = null
}) {
  if (!approvalRequested) {
    const command = approvalCommand ?? `/build --approve ${quoteGoalForCommand(intake.goal)}`;
    return [
      "Approval Checkpoint",
      "No implementation has started yet.",
      "If this plan matches your intent, approve kickoff with:",
      command,
      "This routes into the existing lifecycle and execution system without manual JSON contracts."
    ].join("\n");
  }

  const baseLines = [
    "Approval Checkpoint",
    "Approval received. The command routed through the existing execution program runner.",
    `Execution program: ${lifecycle.executionProgram.id}`
  ];

  if (!runJournal) {
    return [
      ...baseLines,
      "Execution has not started yet."
    ].join("\n");
  }

  return [
    ...baseLines,
    `Run status: ${runJournal.status}`,
    `Stop reason: ${runJournal.stopReason ?? "none"}`,
    formatOperatorBuildNextAction(runJournal)
  ].join("\n");
}

export function formatOperatorBlockedMessage({ message }) {
  return [
    "Build Flow Blocked",
    `Reason: ${message}`,
    "Try again with one clear idea sentence, and optional lines for Audience:, Constraints:, and Success:."
  ].join("\n");
}

export function formatOperatorBuildSessionStatus(buildSession) {
  return [
    "Build Session",
    `Build ID: ${buildSession.buildId}`,
    `Goal: ${buildSession.intake.goal}`,
    `Approval: ${formatApprovalState(buildSession.approval)}`,
    `Execution status: ${buildSession.execution.status}`,
    `Program ID: ${buildSession.execution.programId ?? "not started"}`,
    `Stop reason: ${buildSession.execution.stopReason ?? "none"}`,
    `Completed contracts: ${buildSession.execution.completedContracts}`,
    `Pending contracts: ${buildSession.execution.pendingContracts}`,
    `Next action: ${formatBuildSessionNextAction(buildSession)}`
  ].join("\n");
}

export function formatOperatorBuildSessionLookupBlocked({ buildId = null, message }) {
  return [
    "Build Session Lookup Blocked",
    `Build ID: ${buildId ?? "not provided"}`,
    `Reason: ${message}`,
    "Use /build with a plain-English idea to create a new build session."
  ].join("\n");
}
