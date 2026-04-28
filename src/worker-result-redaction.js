import { createWorkerResult } from "./contracts.js";
import {
  assertRedactionMetadataMatchesCoveredStrings,
  createBoundaryPathRedactor,
  mergeRedactionMetadata,
  normalizeRedactionMetadata,
  redactCoveredStringFields
} from "./redaction.js";

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function defaultEvidenceFieldName(_entry, index) {
  return `result.evidence[${index}]`;
}

function collectWorkerResultCoveredRedactionFields(result, {
  evidenceFieldNameResolver = defaultEvidenceFieldName,
  extraStringFields = []
} = {}) {
  const stringFields = [
    {
      fieldName: "result.summary",
      value: result.summary
    }
  ];
  const stringArrayFields = [
    {
      fieldName: "result.changedFiles",
      value: result.changedFiles
    },
    {
      fieldName: "result.commandsRun",
      value: result.commandsRun
    },
    {
      fieldName: "result.openQuestions",
      value: result.openQuestions
    }
  ];

  result.evidence.forEach((entry, index) => {
    stringFields.push({
      fieldName: evidenceFieldNameResolver(entry, index),
      value: entry
    });
  });

  extraStringFields.forEach((field) => {
    stringFields.push({
      fieldName: field.fieldName,
      value: field.value
    });
  });

  if (Array.isArray(result.commandObservations)) {
    result.commandObservations.forEach((observation, index) => {
      stringFields.push({
        fieldName: `result.commandObservations[${index}].command`,
        value: observation.command
      });
    });
  }

  if (Array.isArray(result.reviewFindings)) {
    result.reviewFindings.forEach((finding, index) => {
      stringFields.push({
        fieldName: `result.reviewFindings[${index}].message`,
        value: finding.message
      });
    });
  }

  return {
    stringFields,
    stringArrayFields
  };
}

function normalizeExtraStringFields(extraStringFields) {
  if (!Array.isArray(extraStringFields)) {
    return [];
  }

  return extraStringFields
    .filter((field) => field && typeof field === "object")
    .filter((field) => typeof field.key === "string" && field.key.length > 0)
    .filter((field) => typeof field.fieldName === "string" && field.fieldName.length > 0)
    .filter((field) => field.value !== undefined && field.value !== null)
    .map((field) => ({
      key: field.key,
      fieldName: field.fieldName,
      value: String(field.value)
    }));
}

export function sanitizeWorkerResultForBoundary(result, {
  repositoryRoot,
  processWorkspaceRoots = [],
  evidenceFieldNameResolver = defaultEvidenceFieldName,
  extraStringFields = [],
  validateExistingRedaction = false,
  mergeExistingRedaction = true
} = {}) {
  const normalizedResult = createWorkerResult(result);
  const normalizedExtraStringFields = normalizeExtraStringFields(extraStringFields);
  const redactor = createBoundaryPathRedactor({
    repositoryRoot,
    processWorkspaceRoots
  });
  const coveredRedactionFields = collectWorkerResultCoveredRedactionFields(normalizedResult, {
    evidenceFieldNameResolver,
    extraStringFields: normalizedExtraStringFields
  });

  const summary = redactor.redactString(normalizedResult.summary, {
    fieldName: "result.summary"
  });
  const changedFiles = redactor.redactStringArray(normalizedResult.changedFiles, {
    fieldName: "result.changedFiles"
  });
  const commandsRun = redactor.redactStringArray(normalizedResult.commandsRun, {
    fieldName: "result.commandsRun"
  });
  const evidence = redactCoveredStringFields({
    redactor,
    stringFields: normalizedResult.evidence.map((entry, index) => ({
      fieldName: evidenceFieldNameResolver(entry, index),
      value: entry
    }))
  });
  const openQuestions = redactor.redactStringArray(normalizedResult.openQuestions, {
    fieldName: "result.openQuestions"
  });
  const extraRedacted = redactCoveredStringFields({
    redactor,
    stringFields: normalizedExtraStringFields.map(({ fieldName, value }) => ({
      fieldName,
      value
    }))
  });

  const commandObservationRedactions = [];
  const commandObservations = Array.isArray(normalizedResult.commandObservations)
    ? normalizedResult.commandObservations.map((observation, index) => {
      const command = redactor.redactString(observation.command, {
        fieldName: `result.commandObservations[${index}].command`
      });
      commandObservationRedactions.push(command.redaction);
      return {
        ...observation,
        command: command.value
      };
    })
    : undefined;

  const reviewFindingRedactions = [];
  const reviewFindings = Array.isArray(normalizedResult.reviewFindings)
    ? normalizedResult.reviewFindings.map((finding, index) => {
      const message = redactor.redactString(finding.message, {
        fieldName: `result.reviewFindings[${index}].message`
      });
      reviewFindingRedactions.push(message.redaction);
      return {
        ...finding,
        message: message.value
      };
    })
    : undefined;

  let existingRedaction = null;
  if (hasOwn(normalizedResult, "redaction")) {
    existingRedaction = normalizeRedactionMetadata(normalizedResult.redaction, {
      fieldName: "result.redaction",
      allowMissing: false
    });
    if (validateExistingRedaction) {
      assertRedactionMetadataMatchesCoveredStrings(existingRedaction, {
        redactor,
        fieldName: "result.redaction",
        stringFields: coveredRedactionFields.stringFields,
        stringArrayFields: coveredRedactionFields.stringArrayFields
      });
    }
  }

  const redacted = {
    ...normalizedResult,
    summary: summary.value,
    changedFiles: changedFiles.values,
    commandsRun: commandsRun.values,
    evidence: evidence.values,
    openQuestions: openQuestions.values,
    redaction: mergeRedactionMetadata(
      ...(mergeExistingRedaction && existingRedaction ? [existingRedaction] : []),
      summary.redaction,
      changedFiles.redaction,
      commandsRun.redaction,
      evidence.redaction,
      openQuestions.redaction,
      extraRedacted.redaction,
      ...commandObservationRedactions,
      ...reviewFindingRedactions
    )
  };

  normalizedExtraStringFields.forEach((field, index) => {
    redacted[field.key] = extraRedacted.values[index];
  });

  if (commandObservations !== undefined) {
    redacted.commandObservations = commandObservations;
  }

  if (reviewFindings !== undefined) {
    redacted.reviewFindings = reviewFindings;
  }

  return createWorkerResult(redacted);
}
