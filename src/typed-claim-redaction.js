import { mergeRedactionMetadata } from "./redaction.js";

function hasOwn(value, property) {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function collectTypedClaimSurfaceRedactionFields(entry, {
  fieldName = "entry"
} = {}) {
  const stringFields = [];
  const stringArrayFields = [];

  if (isObject(entry?.acceptanceArtifact) && Array.isArray(entry.acceptanceArtifact.items)) {
    entry.acceptanceArtifact.items.forEach((item, index) => {
      if (isObject(item) && hasOwn(item, "text")) {
        stringFields.push({
          fieldName: `${fieldName}.acceptanceArtifact.items[${index}].text`,
          value: item.text
        });
      }
    });
  }

  if (Array.isArray(entry?.claimLedger)) {
    entry.claimLedger.forEach((claim, index) => {
      if (!isObject(claim)) {
        return;
      }
      for (const property of ["text", "evidenceSummary", "reason"]) {
        if (hasOwn(claim, property)) {
          stringFields.push({
            fieldName: `${fieldName}.claimLedger[${index}].${property}`,
            value: claim[property]
          });
        }
      }
    });
  }

  if (isObject(entry?.traceability) && Array.isArray(entry.traceability.requirementChecks)) {
    entry.traceability.requirementChecks.forEach((check, index) => {
      if (!isObject(check)) {
        return;
      }
      if (hasOwn(check, "text")) {
        stringFields.push({
          fieldName: `${fieldName}.traceability.requirementChecks[${index}].text`,
          value: check.text
        });
      }
      if (hasOwn(check, "changedFiles")) {
        stringArrayFields.push({
          fieldName: `${fieldName}.traceability.requirementChecks[${index}].changedFiles`,
          value: check.changedFiles
        });
      }
    });
  }

  if (isObject(entry?.traceability) && Array.isArray(entry.traceability.nonGoals)) {
    entry.traceability.nonGoals.forEach((nonGoal, index) => {
      if (!isObject(nonGoal)) {
        return;
      }
      for (const property of ["text", "reason"]) {
        if (hasOwn(nonGoal, property)) {
          stringFields.push({
            fieldName: `${fieldName}.traceability.nonGoals[${index}].${property}`,
            value: nonGoal[property]
          });
        }
      }
      if (hasOwn(nonGoal, "changedFiles")) {
        stringArrayFields.push({
          fieldName: `${fieldName}.traceability.nonGoals[${index}].changedFiles`,
          value: nonGoal.changedFiles
        });
      }
    });
  }

  return {
    stringFields,
    stringArrayFields
  };
}

export function redactTypedClaimSurfaces(entry, {
  redactor,
  fieldName = "entry"
} = {}) {
  const redactions = [];

  function redactString(value, nestedFieldName) {
    const redacted = redactor.redactString(value, {
      fieldName: nestedFieldName
    });
    redactions.push(redacted.redaction);
    return redacted.value;
  }

  function redactStringArray(value, nestedFieldName) {
    const redacted = redactor.redactStringArray(value, {
      fieldName: nestedFieldName
    });
    redactions.push(redacted.redaction);
    return redacted.values;
  }

  const fields = {};

  if (isObject(entry?.acceptanceArtifact) && Array.isArray(entry.acceptanceArtifact.items)) {
    fields.acceptanceArtifact = {
      ...entry.acceptanceArtifact,
      items: entry.acceptanceArtifact.items.map((item, index) => ({
        ...item,
        text: redactString(item.text, `${fieldName}.acceptanceArtifact.items[${index}].text`)
      }))
    };
  }

  if (Array.isArray(entry?.claimLedger)) {
    fields.claimLedger = entry.claimLedger.map((claim, index) => ({
      ...claim,
      text: redactString(claim.text, `${fieldName}.claimLedger[${index}].text`),
      ...(hasOwn(claim, "evidenceSummary")
        ? {
          evidenceSummary: redactString(
            claim.evidenceSummary,
            `${fieldName}.claimLedger[${index}].evidenceSummary`
          )
        }
        : {}),
      ...(hasOwn(claim, "reason")
        ? {
          reason: redactString(claim.reason, `${fieldName}.claimLedger[${index}].reason`)
        }
        : {})
    }));
  }

  if (isObject(entry?.traceability)) {
    fields.traceability = {
      ...entry.traceability,
      ...(Array.isArray(entry.traceability.requirementChecks)
        ? {
          requirementChecks: entry.traceability.requirementChecks.map((check, index) => ({
            ...check,
            text: redactString(
              check.text,
              `${fieldName}.traceability.requirementChecks[${index}].text`
            ),
            changedFiles: redactStringArray(
              check.changedFiles,
              `${fieldName}.traceability.requirementChecks[${index}].changedFiles`
            )
          }))
        }
        : {}),
      ...(Array.isArray(entry.traceability.nonGoals)
        ? {
          nonGoals: entry.traceability.nonGoals.map((nonGoal, index) => ({
            ...nonGoal,
            text: redactString(nonGoal.text, `${fieldName}.traceability.nonGoals[${index}].text`),
            ...(hasOwn(nonGoal, "reason")
              ? {
                reason: redactString(nonGoal.reason, `${fieldName}.traceability.nonGoals[${index}].reason`)
              }
              : {}),
            changedFiles: redactStringArray(
              nonGoal.changedFiles,
              `${fieldName}.traceability.nonGoals[${index}].changedFiles`
            )
          }))
        }
        : {})
    };
  }

  return {
    fields,
    redaction: mergeRedactionMetadata(...redactions)
  };
}
