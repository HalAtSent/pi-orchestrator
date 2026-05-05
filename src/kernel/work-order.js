import path from "node:path";

import { isProtectedRepoPath, normalizeRepoRelativePath, repoPathCovers } from "./path-safety.js";
import { fingerprintWorkOrder } from "./work-order-fingerprint.js";

const SUPPORTED_SCHEMA_VERSION = 1;
const SUPPORTED_POLICY_PROFILE = "default";

const SUPPORTED_ARTIFACT_STATES = new Set(["planned", "active", "completed"]);

const SUPPORTED_CHANGE_CLASSES = new Set([
  "product_behavior",
  "contract_schema",
  "refactor",
  "test_only",
  "documentation",
  "infrastructure_tooling",
  "migration_data_change",
]);

const SUPPORTED_REVIEW_DEPTHS = new Set(["low", "medium", "high"]);
const SUPPORTED_AUTONOMY_LEVELS = new Set([
  "assist",
  "scoped_edit",
  "bounded_patch",
  "supervised_agent",
  "autonomous_run",
]);
const SUPPORTED_RISK_LEVELS = new Set(["low", "medium", "high"]);
const SUPPORTED_NEW_FILE_POLICIES = new Set(["forbidden", "allowed", "listed_only"]);
const SUPPORTED_READINESS_STATUSES = new Set(["ready", "blocked", "draft"]);
const SUPPORTED_READINESS_CHECK_STATUSES = new Set([
  "satisfied",
  "partial",
  "missing",
  "blocked",
]);
const SUPPORTED_ACTION_CLASSES = new Set([
  "read_repository",
  "write_repository",
  "execute_local_command",
]);

const ISO_DATE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/;
const SHA256_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const URL_LIKE_PATH = /^[a-z][a-z0-9+.-]*:/i;

export function validateWorkOrder(workOrder) {
  const validator = new WorkOrderValidator();
  validator.validate(workOrder);
  const success = validator.errors.length === 0;
  const summary = buildWorkOrderSummary(workOrder);

  return {
    success,
    status: success ? "valid" : "invalid",
    executable: success && workOrder.state === "active" && workOrder.readiness.status === "ready",
    summary,
    hardFailures: validator.errors,
    warnings: [],
    errors: validator.errors,
  };
}

function buildWorkOrderSummary(workOrder) {
  return {
    changeClass: workOrder?.change?.class,
    riskLevel: workOrder?.risk?.level,
    autonomyLevel: workOrder?.execution?.autonomyLevel,
    reviewDepth: workOrder?.change?.reviewDepth,
    patchBudget: workOrder?.change?.patchBudget,
    verificationCommands: workOrder?.verification?.commands,
    counterexampleReviewRequired: workOrder?.execution?.counterexampleReview?.required,
  };
}

function isRawDirectoryAlias(pathValue) {
  return typeof pathValue === "string" && (pathValue.endsWith("/") || pathValue.split("/").at(-1) === ".");
}

class WorkOrderValidator {
  constructor() {
    this.errors = [];
  }

  validate(workOrder) {
    if (!isPlainObject(workOrder)) {
      this.addError("$", "invalid_type", "Work Order must be an object.", {
        expected: "object",
        actual: describeType(workOrder),
      });
      return;
    }

    this.validateSchemaVersion(workOrder.schemaVersion);
    this.validateKind(workOrder.kind);
    this.validateEnum(workOrder.state, "$.state", SUPPORTED_ARTIFACT_STATES);
    this.requireNonEmptyString(workOrder.id, "$.id");
    this.requireNonEmptyString(workOrder.goal, "$.goal");
    this.validateRepositoryRoot(workOrder.repositoryRoot);
    this.validatePolicyProfile(workOrder.policyProfile);
    this.validateReadiness(workOrder.readiness);
    this.validateChange(workOrder.change);
    this.validateScope(workOrder.scope);
    this.validateContext(workOrder.context);
    this.validateAcceptance(workOrder.acceptance);
    this.validateVerification(workOrder.verification);
    this.validateExecution(workOrder.execution);
    this.validateRisk(workOrder.risk);
    this.validateOperationalReadiness(workOrder.operationalReadiness);
    this.validateApproval(workOrder.approval, canonicalRequestedActionClasses(workOrder.verification), workOrder);
    this.validateRepair(workOrder.repair);
  }

  validateSchemaVersion(schemaVersion) {
    if (schemaVersion === undefined) {
      this.addError("$.schemaVersion", "required", "schemaVersion is required.");
      return;
    }

    if (!Number.isInteger(schemaVersion)) {
      this.addError("$.schemaVersion", "invalid_type", "schemaVersion must be an integer.", {
        expected: "integer",
        actual: describeType(schemaVersion),
      });
      return;
    }

    if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      this.addError("$.schemaVersion", "unsupported_value", "Unsupported Work Order schemaVersion.", {
        supported: [SUPPORTED_SCHEMA_VERSION],
        actual: schemaVersion,
      });
    }
  }

  validateKind(kind) {
    if (kind === undefined) {
      this.addError("$.kind", "required", "kind is required.");
      return;
    }

    if (kind !== "work_order") {
      this.addError("$.kind", "unsupported_value", "kind must be work_order.", {
        supported: ["work_order"],
        actual: kind,
      });
    }
  }

  validateRepositoryRoot(repositoryRoot) {
    if (!this.requireNonEmptyString(repositoryRoot, "$.repositoryRoot")) {
      return;
    }

    if (!path.isAbsolute(repositoryRoot)) {
      this.addError("$.repositoryRoot", "invalid_path", "repositoryRoot must be an absolute path.");
    }
  }

  validatePolicyProfile(policyProfile) {
    if (policyProfile === undefined) {
      this.addError("$.policyProfile", "required", "policyProfile is required.");
      return;
    }

    if (policyProfile !== SUPPORTED_POLICY_PROFILE) {
      this.addError("$.policyProfile", "unsupported_value", "Unsupported policyProfile.", {
        supported: [SUPPORTED_POLICY_PROFILE],
        actual: policyProfile,
      });
    }
  }

  validateReadiness(readiness) {
    if (!this.requirePlainObject(readiness, "$.readiness")) {
      return;
    }

    this.validateEnum(readiness.status, "$.readiness.status", SUPPORTED_READINESS_STATUSES);
    if (readiness.status !== "ready") {
      this.addError("$.readiness.status", "not_ready", "Executable Work Orders must have readiness.status ready.", {
        actual: readiness.status,
      });
    }

    if (!this.requireArray(readiness.checks, "$.readiness.checks")) {
      return;
    }
    for (let index = 0; index < readiness.checks.length; index += 1) {
      const check = readiness.checks[index];
      const checkPath = `$.readiness.checks[${index}]`;
      if (!this.requirePlainObject(check, checkPath)) {
        continue;
      }
      this.requireNonEmptyString(check.id, `${checkPath}.id`);
      this.validateEnum(check.status, `${checkPath}.status`, SUPPORTED_READINESS_CHECK_STATUSES);
    }

    this.requireArray(readiness.blockers, "$.readiness.blockers");
  }

  validateChange(change) {
    if (!this.requirePlainObject(change, "$.change")) {
      return;
    }

    this.validateEnum(change.class, "$.change.class", SUPPORTED_CHANGE_CLASSES);
    this.validateEnum(change.reviewDepth, "$.change.reviewDepth", SUPPORTED_REVIEW_DEPTHS);
    this.validatePatchBudget(change.patchBudget);
  }

  validatePatchBudget(patchBudget) {
    if (!this.requirePlainObject(patchBudget, "$.change.patchBudget")) {
      return;
    }

    this.requireNonNegativeInteger(patchBudget.expectedFilesChanged, "$.change.patchBudget.expectedFilesChanged");
    this.requireNonNegativeInteger(patchBudget.maxApproxChangedLines, "$.change.patchBudget.maxApproxChangedLines");
    this.requireStringArray(patchBudget.allowedSurfaces, "$.change.patchBudget.allowedSurfaces", {
      minItems: 1,
    });
    this.requireBoolean(patchBudget.mayMixSurfaces, "$.change.patchBudget.mayMixSurfaces");
    this.requireBoolean(patchBudget.incidentalRefactors, "$.change.patchBudget.incidentalRefactors");
  }

  validateScope(scope) {
    if (!this.requirePlainObject(scope, "$.scope")) {
      return;
    }

    const allowedCoverageCandidates = [];
    if (this.requireArray(scope.allowed, "$.scope.allowed", { minItems: 1 })) {
      for (let index = 0; index < scope.allowed.length; index += 1) {
        const allowedPath = scope.allowed[index];
        const allowedPathValid = this.validateRepoRelativePath(allowedPath, `$.scope.allowed[${index}]`, {
          allowDot: false,
          rejectProtected: true,
          writeScope: true,
        });
        if (allowedPathValid) {
          allowedCoverageCandidates.push(normalizeRepoRelativePath(allowedPath).path);
        }
      }
    }

    if (this.requireArray(scope.forbidden, "$.scope.forbidden")) {
      for (let index = 0; index < scope.forbidden.length; index += 1) {
        this.validateRepoRelativePath(scope.forbidden[index], `$.scope.forbidden[${index}]`, {
          allowDot: false,
          writeScope: true,
        });
      }
    }

    this.validateEnum(scope.newFiles, "$.scope.newFiles", SUPPORTED_NEW_FILE_POLICIES);
    if (scope.allowedNewFiles === undefined) {
      if (scope.newFiles === "listed_only") {
        this.addError("$.scope.allowedNewFiles", "required", "allowedNewFiles is required when scope.newFiles is listed_only.");
      }
      return;
    }

    const minItems = scope.newFiles === "listed_only" ? 1 : 0;
    if (this.requireArray(scope.allowedNewFiles, "$.scope.allowedNewFiles", { minItems })) {
      for (let index = 0; index < scope.allowedNewFiles.length; index += 1) {
        const currentPath = scope.allowedNewFiles[index];
        const currentFieldPath = `$.scope.allowedNewFiles[${index}]`;
        const currentPathValid = this.validateRepoRelativePath(currentPath, currentFieldPath, {
          allowDot: false,
          rejectProtected: true,
          writeScope: true,
        });
        if (currentPathValid && isRawDirectoryAlias(currentPath)) {
          this.addError(
            currentFieldPath,
            "invalid_path",
            "allowedNewFiles entries must be exact file paths, not directories.",
          );
          continue;
        }

        if (!currentPathValid) {
          continue;
        }

        if (scope.newFiles !== "forbidden") {
          const normalizedNewFilePath = normalizeRepoRelativePath(currentPath).path;
          const covered = allowedCoverageCandidates.some((allowedPath) => {
            const coverage = repoPathCovers(allowedPath, normalizedNewFilePath);
            return coverage.ok && coverage.covered;
          });

          if (!covered) {
            this.addError(
              currentFieldPath,
              "invalid_path",
              "allowedNewFiles entries must be inside declared allowed write scope.",
            );
          }
        }
      }
    }
  }

  validateContext(context) {
    if (!this.requirePlainObject(context, "$.context")) {
      return;
    }

    if (this.requireArray(context.files, "$.context.files")) {
      for (let index = 0; index < context.files.length; index += 1) {
        const contextFile = context.files[index];
        const filePath = `$.context.files[${index}]`;
        if (!this.requirePlainObject(contextFile, filePath)) {
          continue;
        }
        this.validateRepoRelativePath(contextFile.path, `${filePath}.path`, { allowDot: false });
        this.requireBoolean(contextFile.required, `${filePath}.required`);
        this.requireNonEmptyString(contextFile.reason, `${filePath}.reason`);
      }
    }

    if (this.requireArray(context.notes, "$.context.notes")) {
      for (let index = 0; index < context.notes.length; index += 1) {
        const note = context.notes[index];
        const notePath = `$.context.notes[${index}]`;
        if (!this.requirePlainObject(note, notePath)) {
          continue;
        }
        this.requireNonEmptyString(note.text, `${notePath}.text`);
        this.requireNonEmptyString(note.source, `${notePath}.source`);
      }
    }

    this.requireArray(context.priorArtifacts, "$.context.priorArtifacts");
    this.requireArray(context.manifest, "$.context.manifest");

    if (this.requirePlainObject(context.budget, "$.context.budget")) {
      this.requireNonNegativeInteger(context.budget.maxTokens, "$.context.budget.maxTokens");
      this.requireNonEmptyString(context.budget.truncationPolicy, "$.context.budget.truncationPolicy");
    }
  }

  validateAcceptance(acceptance) {
    if (!this.requireArray(acceptance, "$.acceptance", { minItems: 1 })) {
      return;
    }

    let requiredCount = 0;
    for (let index = 0; index < acceptance.length; index += 1) {
      const item = acceptance[index];
      const itemPath = `$.acceptance[${index}]`;
      if (!this.requirePlainObject(item, itemPath)) {
        continue;
      }

      this.requireNonEmptyString(item.id, `${itemPath}.id`);
      this.requireNonEmptyString(item.text, `${itemPath}.text`);
      if (this.requireBoolean(item.required, `${itemPath}.required`) && item.required) {
        requiredCount += 1;
      }
      if (item.evidenceRequired !== undefined) {
        this.requireBoolean(item.evidenceRequired, `${itemPath}.evidenceRequired`);
      }
    }

    if (requiredCount === 0) {
      this.addError("$.acceptance", "missing_required_acceptance", "At least one acceptance item must be required.");
    }
  }

  validateVerification(verification) {
    if (!this.requirePlainObject(verification, "$.verification")) {
      return;
    }

    let commandCount = 0;
    if (this.requireArray(verification.commands, "$.verification.commands")) {
      commandCount = verification.commands.length;
      for (let index = 0; index < verification.commands.length; index += 1) {
        this.validateVerificationCommand(verification.commands[index], `$.verification.commands[${index}]`);
      }
    }

    this.requireBoolean(verification.allowDerivedCommands, "$.verification.allowDerivedCommands");
    this.requireBoolean(verification.required, "$.verification.required");

    if (
      verification.required === true &&
      verification.allowDerivedCommands === false &&
      commandCount === 0
    ) {
      this.addError(
        "$.verification",
        "verification_impossible",
        "Required verification needs at least one explicit command when derived commands are disabled.",
      );
    }
  }

  validateVerificationCommand(command, commandPath) {
    if (!this.requirePlainObject(command, commandPath)) {
      return;
    }

    this.requireNonEmptyString(command.id, `${commandPath}.id`);
    this.requireNonEmptyString(command.command, `${commandPath}.command`);
    if (command.cwd === undefined) {
      this.addError(`${commandPath}.cwd`, "required", "verification command cwd is required.");
    } else {
      this.validateRepoRelativePath(command.cwd, `${commandPath}.cwd`, { allowDot: true });
    }
    this.requireBoolean(command.required, `${commandPath}.required`);
    this.validateActionClasses(command.actionClasses, `${commandPath}.actionClasses`);
    this.requireNonEmptyString(command.reason, `${commandPath}.reason`);
  }

  validateExecution(execution) {
    if (!this.requirePlainObject(execution, "$.execution")) {
      return;
    }

    this.validateEnum(execution.autonomyLevel, "$.execution.autonomyLevel", SUPPORTED_AUTONOMY_LEVELS);
    this.validateModelToolRoute(execution.modelToolRoute);

    if (this.requireArray(execution.rolePackets, "$.execution.rolePackets")) {
      for (let index = 0; index < execution.rolePackets.length; index += 1) {
        const rolePacket = execution.rolePackets[index];
        const rolePacketPath = `$.execution.rolePackets[${index}]`;
        if (!this.requirePlainObject(rolePacket, rolePacketPath)) {
          continue;
        }
        this.requireNonEmptyString(rolePacket.role, `${rolePacketPath}.role`);
        this.requireNonEmptyString(rolePacket.packetVersion, `${rolePacketPath}.packetVersion`);
        this.requireBoolean(rolePacket.required, `${rolePacketPath}.required`);
      }

      if (
        execution.rolePackets.length === 0 &&
        isPlainObject(execution.modelToolRoute) &&
        !["deterministic_local", "manual"].includes(execution.modelToolRoute.preferredWorker)
      ) {
        this.addError(
          "$.execution.rolePackets",
          "missing_role_packets",
          "rolePackets may be empty only for deterministic_local or manual worker routes.",
        );
      }
    }

    this.validateCounterexampleReview(execution.counterexampleReview);
  }

  validateModelToolRoute(modelToolRoute) {
    if (!this.requirePlainObject(modelToolRoute, "$.execution.modelToolRoute")) {
      return;
    }

    this.requireBoolean(modelToolRoute.routeRequired, "$.execution.modelToolRoute.routeRequired");
    this.requireNonEmptyString(modelToolRoute.preferredWorker, "$.execution.modelToolRoute.preferredWorker");
    this.requireArray(modelToolRoute.preferredModels, "$.execution.modelToolRoute.preferredModels");
    this.validateActionClasses(modelToolRoute.tools, "$.execution.modelToolRoute.tools");
    this.requireNonEmptyString(modelToolRoute.rationale, "$.execution.modelToolRoute.rationale");
  }

  validateCounterexampleReview(counterexampleReview) {
    if (!this.requirePlainObject(counterexampleReview, "$.execution.counterexampleReview")) {
      return;
    }

    this.requireBoolean(counterexampleReview.required, "$.execution.counterexampleReview.required");
    this.requireNonEmptyString(counterexampleReview.reason, "$.execution.counterexampleReview.reason");
  }

  validateRisk(risk) {
    if (!this.requirePlainObject(risk, "$.risk")) {
      return;
    }

    this.validateEnum(risk.level, "$.risk.level", SUPPORTED_RISK_LEVELS);
    this.requireStringArray(risk.reasons, "$.risk.reasons", { minItems: 1 });
  }

  validateOperationalReadiness(operationalReadiness) {
    if (!this.requirePlainObject(operationalReadiness, "$.operationalReadiness")) {
      return;
    }

    const observabilityPath = "$.operationalReadiness.observability";
    if (this.requirePlainObject(operationalReadiness.observability, observabilityPath)) {
      this.requireNonEmptyString(
        operationalReadiness.observability.breakageDetection,
        `${observabilityPath}.breakageDetection`,
      );
      this.requireStringArray(operationalReadiness.observability.signals, `${observabilityPath}.signals`, {
        minItems: 1,
      });
      this.requireStringArray(
        operationalReadiness.observability.manualChecks,
        `${observabilityPath}.manualChecks`,
      );
    }

    const rollbackPath = "$.operationalReadiness.rollbackRecovery";
    if (this.requirePlainObject(operationalReadiness.rollbackRecovery, rollbackPath)) {
      this.requireBoolean(operationalReadiness.rollbackRecovery.required, `${rollbackPath}.required`);
      if (
        operationalReadiness.rollbackRecovery.plan !== null &&
        operationalReadiness.rollbackRecovery.plan !== undefined
      ) {
        this.requireNonEmptyString(operationalReadiness.rollbackRecovery.plan, `${rollbackPath}.plan`);
      }
      this.requireStringArray(operationalReadiness.rollbackRecovery.recoverySteps, `${rollbackPath}.recoverySteps`);
      if (operationalReadiness.rollbackRecovery.required === false) {
        this.requireNonEmptyString(
          operationalReadiness.rollbackRecovery.notApplicableReason,
          `${rollbackPath}.notApplicableReason`,
        );
      }
      if (operationalReadiness.rollbackRecovery.required === true) {
        this.requireNonEmptyString(operationalReadiness.rollbackRecovery.plan, `${rollbackPath}.plan`);
      }
    }
  }

  validateApproval(approval, requestedActionClasses, workOrder) {
    if (!this.requirePlainObject(approval, "$.approval")) {
      return;
    }

    this.requireBoolean(approval.required, "$.approval.required");
    const approvedActionClassesAreValid =
      this.requireArray(approval.approvedActionClasses, "$.approval.approvedActionClasses") &&
      this.validateActionClasses(approval.approvedActionClasses, "$.approval.approvedActionClasses");

    if (approval.required !== true) {
      return;
    }

    if (
      approvedActionClassesAreValid &&
      requestedActionClasses !== null &&
      !arraysEqual(approval.approvedActionClasses, requestedActionClasses)
    ) {
      this.addError(
        "$.approval.approvedActionClasses",
        "approval_action_classes_mismatch",
        "approvedActionClasses must equal the canonical requested verification action-class set.",
      );
    }

    this.requireNonEmptyString(approval.approvalId, "$.approval.approvalId");
    if (this.requireNonEmptyString(approval.approvedAt, "$.approval.approvedAt")) {
      if (!isValidUtcTimestamp(approval.approvedAt)) {
        this.addError("$.approval.approvedAt", "malformed_approval", "approvedAt must be an ISO-8601 UTC timestamp.");
      }
    }
    this.requireNonEmptyString(approval.approvedBy, "$.approval.approvedBy");
    if (this.requireNonEmptyString(approval.approvedFingerprint, "$.approval.approvedFingerprint")) {
      if (!SHA256_FINGERPRINT.test(approval.approvedFingerprint)) {
        this.addError(
          "$.approval.approvedFingerprint",
          "malformed_approval",
          "approvedFingerprint must use sha256:<64 lowercase hex> format.",
        );
      } else if (approval.approvedFingerprint !== fingerprintWorkOrder(workOrder)) {
        this.addError(
          "$.approval.approvedFingerprint",
          "approval_fingerprint_mismatch",
          "approvedFingerprint must equal the canonical Work Order fingerprint.",
        );
      }
    }
  }

  validateRepair(repair) {
    if (!this.requirePlainObject(repair, "$.repair")) {
      return;
    }

    this.requireNonNegativeInteger(repair.maxLoops, "$.repair.maxLoops");
    if (repair.mayWidenScope !== undefined && repair.mayWidenScope !== false) {
      this.addError("$.repair.mayWidenScope", "unsupported_value", "repair.mayWidenScope must be false for schemaVersion 1.");
    }
  }

  validateActionClasses(actionClasses, fieldPath) {
    if (!this.requireArray(actionClasses, fieldPath)) {
      return false;
    }

    for (let index = 0; index < actionClasses.length; index += 1) {
      this.validateEnum(actionClasses[index], `${fieldPath}[${index}]`, SUPPORTED_ACTION_CLASSES);
    }
    return true;
  }

  validateEnum(value, fieldPath, supportedValues) {
    if (value === undefined) {
      this.addError(fieldPath, "required", `${fieldPath} is required.`);
      return false;
    }

    if (!supportedValues.has(value)) {
      this.addError(fieldPath, "unsupported_value", `${fieldPath} has an unsupported value.`, {
        supported: [...supportedValues],
        actual: value,
      });
      return false;
    }

    return true;
  }

  validateRepoRelativePath(value, fieldPath, options = {}) {
    const { allowDot = false, rejectProtected = false, writeScope = false } = options;
    if (!this.requireNonEmptyString(value, fieldPath)) {
      return false;
    }

    if (writeScope) {
      const normalized = normalizeRepoRelativePath(value);
      if (!normalized.ok) {
        this.addError(fieldPath, "invalid_path", "Path must be a safe repo-relative write-scope path.");
        return false;
      }

      if (rejectProtected && isProtectedRepoPath(normalized.path).protected) {
        this.addError(fieldPath, "invalid_path", "Path must be a safe repo-relative write-scope path.");
        return false;
      }

      return true;
    }

    if (value.includes("\\")) {
      this.addError(fieldPath, "invalid_path", "Repo-relative paths must use / separators.");
      return false;
    }

    if (value.startsWith("/") || value.startsWith("//") || URL_LIKE_PATH.test(value)) {
      this.addError(fieldPath, "invalid_path", "Path must be repo-relative, not absolute or URL-like.");
      return false;
    }

    if (value === "." && !allowDot) {
      this.addError(fieldPath, "invalid_path", ". is not valid write scope.");
      return false;
    }

    if (value.split("/").includes("..")) {
      this.addError(fieldPath, "invalid_path", "Path traversal is not allowed.");
      return false;
    }

    return true;
  }

  requirePlainObject(value, fieldPath) {
    if (value === undefined) {
      this.addError(fieldPath, "required", `${fieldPath} is required.`);
      return false;
    }

    if (!isPlainObject(value)) {
      this.addError(fieldPath, "invalid_type", `${fieldPath} must be an object.`, {
        expected: "object",
        actual: describeType(value),
      });
      return false;
    }

    return true;
  }

  requireArray(value, fieldPath, options = {}) {
    if (value === undefined) {
      this.addError(fieldPath, "required", `${fieldPath} is required.`);
      return false;
    }

    if (!Array.isArray(value)) {
      this.addError(fieldPath, "invalid_type", `${fieldPath} must be an array.`, {
        expected: "array",
        actual: describeType(value),
      });
      return false;
    }

    if (options.minItems !== undefined && value.length < options.minItems) {
      this.addError(fieldPath, "too_few_items", `${fieldPath} must contain at least ${options.minItems} item(s).`, {
        minimum: options.minItems,
        actual: value.length,
      });
      return false;
    }

    return true;
  }

  requireStringArray(value, fieldPath, options = {}) {
    if (!this.requireArray(value, fieldPath, options)) {
      return false;
    }

    for (let index = 0; index < value.length; index += 1) {
      this.requireNonEmptyString(value[index], `${fieldPath}[${index}]`);
    }

    return true;
  }

  requireNonEmptyString(value, fieldPath) {
    if (value === undefined) {
      this.addError(fieldPath, "required", `${fieldPath} is required.`);
      return false;
    }

    if (typeof value !== "string" || value.trim() === "") {
      this.addError(fieldPath, "invalid_type", `${fieldPath} must be a non-empty string.`, {
        expected: "non-empty string",
        actual: describeType(value),
      });
      return false;
    }

    return true;
  }

  requireBoolean(value, fieldPath) {
    if (value === undefined) {
      this.addError(fieldPath, "required", `${fieldPath} is required.`);
      return false;
    }

    if (typeof value !== "boolean") {
      this.addError(fieldPath, "invalid_type", `${fieldPath} must be a boolean.`, {
        expected: "boolean",
        actual: describeType(value),
      });
      return false;
    }

    return true;
  }

  requireNonNegativeInteger(value, fieldPath) {
    if (value === undefined) {
      this.addError(fieldPath, "required", `${fieldPath} is required.`);
      return false;
    }

    if (!Number.isInteger(value) || value < 0) {
      this.addError(fieldPath, "invalid_type", `${fieldPath} must be a non-negative integer.`, {
        expected: "non-negative integer",
        actual: describeType(value),
      });
      return false;
    }

    return true;
  }

  addError(fieldPath, code, message, details = {}) {
    this.errors.push({
      path: fieldPath,
      code,
      message,
      ...details,
    });
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidUtcTimestamp(value) {
  const match = ISO_DATE.exec(value);
  if (match === null) {
    return false;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return false;
  }

  const expectedIso = `${match[1]}.${match[2] ?? "000"}Z`;
  return new Date(parsed).toISOString() === expectedIso;
}

function canonicalRequestedActionClasses(verification) {
  if (!isPlainObject(verification) || !Array.isArray(verification.commands)) {
    return null;
  }

  const requestedActionClasses = new Set();
  for (const command of verification.commands) {
    if (!isPlainObject(command) || !Array.isArray(command.actionClasses)) {
      return null;
    }

    for (const actionClass of command.actionClasses) {
      if (!SUPPORTED_ACTION_CLASSES.has(actionClass)) {
        return null;
      }
      requestedActionClasses.add(actionClass);
    }
  }

  return [...requestedActionClasses].sort();
}

function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function describeType(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}
