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

function formatApprovalScope(actionClasses) {
  if (!Array.isArray(actionClasses) || actionClasses.length === 0) {
    return "none recorded";
  }

  return actionClasses.join(", ");
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

function uniqueStrings(values) {
  return [...new Set(values)];
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function formatListPreview(values, { max = 6, fallback = "none recorded" } = {}) {
  if (!Array.isArray(values) || values.length === 0) {
    return fallback;
  }

  const preview = values.slice(0, max).join(", ");
  if (values.length <= max) {
    return preview;
  }

  return `${preview}, +${values.length - max} more`;
}

function collectExecutionProgramContracts(buildSession) {
  const contracts = buildSession?.lifecycle?.executionProgram?.contracts;
  return Array.isArray(contracts) ? contracts : [];
}

function collectContractScopePaths(contracts) {
  const paths = [];
  for (const contract of contracts) {
    const scopePaths = Array.isArray(contract?.scopePaths) ? contract.scopePaths : [];
    for (const scopePath of scopePaths) {
      const normalized = normalizeNonEmptyString(scopePath);
      if (normalized) {
        paths.push(normalized);
      }
    }
  }

  return uniqueStrings(paths);
}

function mapContractScopePathsById(contracts) {
  const map = new Map();
  for (const contract of contracts) {
    const contractId = normalizeNonEmptyString(contract?.id);
    if (!contractId) {
      continue;
    }

    const scopePaths = Array.isArray(contract.scopePaths)
      ? contract.scopePaths.map((scopePath) => normalizeNonEmptyString(scopePath)).filter(Boolean)
      : [];
    map.set(contractId, uniqueStrings(scopePaths));
  }

  return map;
}

function collectRunContractIds(runJournal) {
  if (!runJournal || !Array.isArray(runJournal.contractRuns)) {
    return [];
  }

  const contractIds = [];
  for (const contractRun of runJournal.contractRuns) {
    const contractId = normalizeNonEmptyString(contractRun?.contractId);
    if (contractId) {
      contractIds.push(contractId);
    }
  }

  return uniqueStrings(contractIds);
}

function collectValidationArtifacts(buildSession) {
  const validationArtifacts = buildSession?.execution?.validationArtifacts;
  return Array.isArray(validationArtifacts) ? validationArtifacts : [];
}

function collectRunOpenQuestions(runJournal) {
  if (!runJournal || !Array.isArray(runJournal.contractRuns)) {
    return [];
  }

  const openQuestions = [];
  for (const contractRun of runJournal.contractRuns) {
    const questions = Array.isArray(contractRun?.openQuestions) ? contractRun.openQuestions : [];
    for (const question of questions) {
      const normalized = normalizeNonEmptyString(question);
      if (normalized) {
        openQuestions.push(normalized);
      }
    }
  }

  return uniqueStrings(openQuestions);
}

function normalizeChangedSurfaceCapture(value) {
  const normalized = normalizeNonEmptyString(value);
  if (normalized === "complete" || normalized === "partial" || normalized === "not_captured") {
    return normalized;
  }

  return "not_captured";
}

function collectRunChangedSurfaceEvidence(runJournal) {
  const runEntries = Array.isArray(runJournal?.contractRuns) ? runJournal.contractRuns : [];
  const contractRuns = [];

  for (const runEntry of runEntries) {
    const contractId = normalizeNonEmptyString(runEntry?.contractId);
    const changedSurface = runEntry?.changedSurface;
    const capture = normalizeChangedSurfaceCapture(changedSurface?.capture);
    const paths = Array.isArray(changedSurface?.paths)
      ? uniqueStrings(changedSurface.paths.map((pathValue) => normalizeNonEmptyString(pathValue)).filter(Boolean))
      : [];

    contractRuns.push({
      contractId,
      capture,
      paths
    });
  }

  const observedPaths = uniqueStrings(contractRuns
    .filter((contractRun) => contractRun.capture === "complete" || contractRun.capture === "partial")
    .flatMap((contractRun) => contractRun.paths));
  const allComplete = contractRuns.length > 0 && contractRuns.every((contractRun) => contractRun.capture === "complete");
  const anyObserved = contractRuns.some((contractRun) => contractRun.capture === "complete" || contractRun.capture === "partial");
  const fallbackContractIds = uniqueStrings(contractRuns
    .filter((contractRun) => contractRun.capture !== "complete")
    .map((contractRun) => contractRun.contractId)
    .filter(Boolean));
  const allContractIds = uniqueStrings(contractRuns
    .map((contractRun) => contractRun.contractId)
    .filter(Boolean));

  return {
    hasRunEntries: contractRuns.length > 0,
    observedPaths,
    allComplete,
    anyObserved,
    fallbackContractIds,
    allContractIds
  };
}

function collectPlannedScopePathsForContractIds(contracts, contractIds) {
  if (!Array.isArray(contractIds) || contractIds.length === 0) {
    return [];
  }

  const contractScopePathsById = mapContractScopePathsById(contracts);
  return uniqueStrings(contractIds.flatMap((contractId) => (
    contractScopePathsById.get(contractId) ?? []
  )));
}

function formatChangedSurfaces(buildSession, runJournal) {
  const contracts = collectExecutionProgramContracts(buildSession);
  const changedSurfaceEvidence = collectRunChangedSurfaceEvidence(runJournal);

  if (!changedSurfaceEvidence.hasRunEntries) {
    const plannedScopePaths = collectContractScopePaths(contracts);
    if (plannedScopePaths.length === 0) {
      return "No executed change evidence is recorded, and no planned scope paths are stored.";
    }

    return `No executed change evidence is recorded yet. Planned scope for this build session: ${formatListPreview(plannedScopePaths)}.`;
  }

  if (changedSurfaceEvidence.allComplete) {
    if (changedSurfaceEvidence.observedPaths.length === 0) {
      return "Observed changed paths are exact for recorded runs: no files changed.";
    }

    return `Observed changed paths are exact for recorded runs: ${formatListPreview(changedSurfaceEvidence.observedPaths)}.`;
  }

  if (changedSurfaceEvidence.anyObserved) {
    const plannedFallbackPaths = collectPlannedScopePathsForContractIds(
      contracts,
      changedSurfaceEvidence.fallbackContractIds
    );

    const observedPreview = changedSurfaceEvidence.observedPaths.length === 0
      ? "none recorded"
      : formatListPreview(changedSurfaceEvidence.observedPaths);
    if (plannedFallbackPaths.length === 0) {
      return `Observed changed paths are partial for recorded runs: ${observedPreview}. Some recorded runs do not have complete changed-path capture, and their planned scope is not stored.`;
    }

    return `Observed changed paths are partial for recorded runs: ${observedPreview}. Planned scope for runs without complete changed-path capture: ${formatListPreview(plannedFallbackPaths)}.`;
  }

  const plannedScopeForRecordedRuns = collectPlannedScopePathsForContractIds(
    contracts,
    changedSurfaceEvidence.allContractIds.length > 0
      ? changedSurfaceEvidence.allContractIds
      : collectRunContractIds(runJournal)
  );

  if (plannedScopeForRecordedRuns.length === 0) {
    return "No observed changed-path evidence is persisted for recorded runs, and planned scope for those runs is not stored.";
  }

  return `No observed changed-path evidence is persisted for recorded runs. Planned scope for contracts with recorded runs: ${formatListPreview(plannedScopeForRecordedRuns)}.`;
}

function formatProofCollected(buildSession, runJournal) {
  const proofNotes = [];
  const runEntries = Array.isArray(runJournal?.contractRuns) ? runJournal.contractRuns : [];

  if (runEntries.length === 0) {
    proofNotes.push("No contract run records are captured yet.");
  } else {
    const statusCounts = new Map();
    for (const runEntry of runEntries) {
      const status = normalizeNonEmptyString(runEntry?.status) ?? "unknown";
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    }
    const runStatusSummary = [...statusCounts.entries()]
      .map(([status, count]) => `${count} ${status}`)
      .join(", ");

    proofNotes.push(`${runEntries.length} contract run record(s): ${runStatusSummary}.`);

    const evidenceCount = runEntries.reduce((count, runEntry) => (
      count + (Array.isArray(runEntry?.evidence) ? runEntry.evidence.length : 0)
    ), 0);
    if (evidenceCount > 0) {
      proofNotes.push(`${evidenceCount} run evidence note(s) are persisted in the journal.`);
    }
  }

  const validationArtifacts = collectValidationArtifacts(buildSession);
  if (validationArtifacts.length === 0) {
    proofNotes.push("No validation artifacts are persisted.");
  } else {
    const capturedReferences = validationArtifacts
      .filter((entry) => normalizeNonEmptyString(entry?.status) === "captured")
      .map((entry) => normalizeNonEmptyString(entry?.reference))
      .filter(Boolean);
    const notCapturedCount = validationArtifacts
      .filter((entry) => normalizeNonEmptyString(entry?.status) === "not_captured")
      .length;

    if (capturedReferences.length > 0) {
      proofNotes.push(`Captured validation artifacts: ${formatListPreview(uniqueStrings(capturedReferences), {
        max: 4
      })}.`);
    }
    if (notCapturedCount > 0) {
      proofNotes.push(`${notCapturedCount} validation artifact(s) are marked not captured.`);
    }
  }

  return proofNotes.join(" ");
}

function formatUnprovenClaims(buildSession, runJournal) {
  const claims = [];
  const changedSurfaceEvidence = collectRunChangedSurfaceEvidence(runJournal);

  if (!changedSurfaceEvidence.hasRunEntries || !changedSurfaceEvidence.anyObserved) {
    claims.push("Observed changed-path evidence is not persisted; changed surfaces may only reflect planned scope.");
  } else if (!changedSurfaceEvidence.allComplete) {
    claims.push("Changed-path capture is partial; some recorded runs still rely on planned scope.");
  }

  const validationArtifacts = collectValidationArtifacts(buildSession);
  const notCapturedValidationArtifacts = validationArtifacts
    .filter((entry) => normalizeNonEmptyString(entry?.status) === "not_captured")
    .length;

  if (notCapturedValidationArtifacts > 0) {
    claims.push(
      `Validation capture is incomplete (${notCapturedValidationArtifacts} artifact(s) marked not captured).`
    );
  }

  const runEntries = Array.isArray(runJournal?.contractRuns) ? runJournal.contractRuns : [];
  if (runEntries.length === 0) {
    if (buildSession.execution.status === "running") {
      claims.push("Execution is still running, so the final outcome is not yet proven.");
    } else if (
      buildSession.execution.status === "awaiting_approval" ||
      buildSession.execution.status === "approved"
    ) {
      claims.push("No contract run evidence is recorded yet.");
    }
  }

  if (claims.length === 0) {
    claims.push("No unproven changed-surface claims are recorded from persisted run evidence.");
  }

  return claims.join(" ");
}

const REVIEWABILITY_REASON_LABELS = Object.freeze({
  non_terminal_status: "Execution is not terminal yet.",
  validation_artifacts_not_captured: "Validation artifacts are placeholder-only or not captured.",
  missing_stop_reason: "Terminal stop reason is missing.",
  missing_stop_reason_code: "Terminal stop reason code is missing.",
  provider_model_evidence_missing: "Provider/model evidence is incomplete for a model-backed success path.",
  provider_model_evidence_requirement_unknown: "Current code cannot decide whether provider/model evidence was required."
});

function formatReviewability(buildSession, runJournal) {
  const reviewability = runJournal?.reviewability ?? buildSession?.execution?.reviewability ?? null;
  const status = normalizeNonEmptyString(reviewability?.status);
  const reasons = Array.isArray(reviewability?.reasons)
    ? uniqueStrings(reviewability.reasons.map((reason) => normalizeNonEmptyString(reason)).filter(Boolean))
    : [];

  if (status === "reviewable") {
    return "Machine assessment: reviewable based on persisted evidence.";
  }

  if (status === "unknown") {
    const reasonText = reasons.length > 0
      ? reasons.map((reason) => REVIEWABILITY_REASON_LABELS[reason] ?? reason).join(" ")
      : "Reason details are not captured.";
    return `Machine assessment: unknown. ${reasonText}`;
  }

  if (status === "not_reviewable") {
    const reasonText = reasons.length > 0
      ? reasons.map((reason) => REVIEWABILITY_REASON_LABELS[reason] ?? reason).join(" ")
      : "Reason details are not captured.";
    return `Machine assessment: not reviewable. ${reasonText}`;
  }

  return "Machine assessment is not captured in this record.";
}

function formatApprovalNeeded(buildSession) {
  const stopReasonCode = buildSession?.execution?.stopReasonCode ?? null;
  const stopReason = normalizeNonEmptyString(buildSession?.execution?.stopReason)?.toLowerCase() ?? "";
  const freshApprovalRequired = stopReasonCode === "approval_required" || stopReason.includes("fresh approval is required");

  if (freshApprovalRequired) {
    return `Yes. Fresh approval is required before execution can continue. Use /build-approve ${buildSession.buildId}.`;
  }

  if (!buildSession.approval || buildSession.approval.approved !== true || buildSession.execution.status === "awaiting_approval") {
    return `Yes. Approve kickoff with /build-approve ${buildSession.buildId}.`;
  }

  if (buildSession.execution.status === "approved") {
    return "No new approval is needed. Approval is already recorded for this stored plan.";
  }

  return "No new approval is needed for this stored plan unless the plan fingerprint or approval scope changes.";
}

function formatRecoveryUndoNotes(buildSession, runJournal) {
  const openQuestions = collectRunOpenQuestions(runJournal);
  if (openQuestions.length > 0) {
    return `Persisted guidance: ${formatListPreview(openQuestions, { max: 3 })}.`;
  }

  if (buildSession.execution.status === "blocked" ||
    buildSession.execution.status === "failed" ||
    buildSession.execution.status === "repair_required") {
    return `Recovery guidance is weak: no explicit undo notes are captured. Stop reason: ${buildSession.execution.stopReason ?? "none"}.`;
  }

  if (buildSession.execution.status === "success") {
    return "No recovery or undo notes are captured. If rollback is needed, a technical operator must define it.";
  }

  return "No recovery or undo notes are captured yet.";
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

export function formatOperatorBuildSessionStatus(buildSession, { runJournal = null } = {}) {
  return [
    "Build Session",
    `Build ID: ${buildSession.buildId}`,
    `Goal: ${buildSession.intake.goal}`,
    `Approval: ${formatApprovalState(buildSession.approval)}`,
    `Plan fingerprint: ${buildSession.planFingerprint ?? "not captured"}`,
    `Approval scope: ${formatApprovalScope(buildSession.approval?.actionClasses)}`,
    `Execution status: ${buildSession.execution.status}`,
    `Program ID: ${buildSession.execution.programId ?? "not started"}`,
    `Stop reason: ${buildSession.execution.stopReason ?? "none"}`,
    `Completed contracts: ${buildSession.execution.completedContracts}`,
    `Pending contracts: ${buildSession.execution.pendingContracts}`,
    `Changed surfaces: ${formatChangedSurfaces(buildSession, runJournal)}`,
    `Proof collected: ${formatProofCollected(buildSession, runJournal)}`,
    `Unproven claims: ${formatUnprovenClaims(buildSession, runJournal)}`,
    `Reviewability: ${formatReviewability(buildSession, runJournal)}`,
    `Approval needed: ${formatApprovalNeeded(buildSession)}`,
    `Recovery / undo notes: ${formatRecoveryUndoNotes(buildSession, runJournal)}`,
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
