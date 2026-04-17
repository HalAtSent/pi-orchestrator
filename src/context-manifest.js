import {
  assertRedactionMetadataMatchesCoveredStrings,
  createBoundaryPathRedactor,
  normalizeRedactionMetadata
} from "./redaction.js";

const CONTEXT_MANIFEST_KIND = Object.freeze({
  CONTEXT_FILE: "context_file",
  PRIOR_RESULT: "prior_result",
  REVIEW_RESULT: "review_result",
  CHANGED_SURFACE: "changed_surface"
});

const CONTEXT_MANIFEST_SOURCE = Object.freeze({
  PACKET_CONTEXT_FILES: "packet_context_files",
  WORKFLOW_PRIOR_RUNS: "workflow_prior_runs",
  REPAIR_REVIEW: "repair_review",
  TRUSTED_CHANGED_SURFACE: "trusted_changed_surface"
});

const CONTEXT_MANIFEST_REASON = Object.freeze({
  EXPLICIT_REQUEST: "explicit_request",
  REPAIR_CONTEXT: "repair_context",
  EXECUTION_HISTORY: "execution_history",
  CHANGED_SCOPE_CARRY_FORWARD: "changed_scope_carry_forward"
});

export const CONTEXT_MANIFEST_KINDS = Object.freeze(Object.values(CONTEXT_MANIFEST_KIND));
export const CONTEXT_MANIFEST_SOURCES = Object.freeze(Object.values(CONTEXT_MANIFEST_SOURCE));
export const CONTEXT_MANIFEST_REASONS = Object.freeze(Object.values(CONTEXT_MANIFEST_REASON));

const CONTEXT_MANIFEST_KIND_SET = new Set(CONTEXT_MANIFEST_KINDS);
const CONTEXT_MANIFEST_SOURCE_SET = new Set(CONTEXT_MANIFEST_SOURCES);
const CONTEXT_MANIFEST_REASON_SET = new Set(CONTEXT_MANIFEST_REASONS);
const RUN_CONTEXT_ADMISSION_ERROR_PREFIX = "runtime context assembly invalid or drifted from contextManifest[]";
const TRUSTED_FORWARDED_REDACTION_METADATA_BY_CONTEXT = new WeakMap();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeEnumValue({ fieldName, value, allowedValues, allowedValueSet }) {
  assert(typeof value === "string" && value.trim().length > 0, `${fieldName} must be a non-empty string`);
  const normalized = value.trim();
  assert(
    allowedValueSet.has(normalized),
    `${fieldName} must be one of: ${allowedValues.join(", ")}`
  );
  return normalized;
}

function normalizeReference(fieldName, value) {
  assert(typeof value === "string" && value.trim().length > 0, `${fieldName} must be a non-empty string`);
  return value.trim();
}

function normalizeOptionalBoolean({ fieldName, value, defaultValue = false }) {
  if (value === undefined) {
    return defaultValue;
  }

  assert(typeof value === "boolean", `${fieldName} must be a boolean`);
  return value;
}

function normalizeNonNegativeInteger({ fieldName, value, defaultValue = 0 }) {
  if (value === undefined) {
    return defaultValue;
  }

  assert(Number.isInteger(value) && value >= 0, `${fieldName} must be a non-negative integer`);
  return value;
}

function normalizeStringArray(fieldName, value, { allowMissing = false } = {}) {
  if (value === undefined) {
    if (allowMissing) {
      return [];
    }

    throw new Error(`${fieldName} must be an array`);
  }

  assert(Array.isArray(value), `${fieldName} must be an array`);
  return value.map((entry, index) => normalizeReference(`${fieldName}[${index}]`, entry));
}

function contextManifestEntryKey(entry) {
  return `${entry.kind}::${entry.source}::${entry.reference}::${entry.reason}`;
}

function uniqueContextManifestEntries(entries) {
  const seen = new Set();
  const unique = [];

  for (const entry of entries) {
    const key = contextManifestEntryKey(entry);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(entry);
  }

  return unique;
}

function assertPacketContextManifestEntry(entry, { fieldName }) {
  assert(
    entry.kind === CONTEXT_MANIFEST_KIND.CONTEXT_FILE,
    `${fieldName}.kind must be ${CONTEXT_MANIFEST_KIND.CONTEXT_FILE} for packet-level context manifests`
  );
  assert(
    entry.source === CONTEXT_MANIFEST_SOURCE.PACKET_CONTEXT_FILES,
    `${fieldName}.source must be ${CONTEXT_MANIFEST_SOURCE.PACKET_CONTEXT_FILES} for packet-level context manifests`
  );
  assert(
    entry.reason === CONTEXT_MANIFEST_REASON.EXPLICIT_REQUEST,
    `${fieldName}.reason must be ${CONTEXT_MANIFEST_REASON.EXPLICIT_REQUEST} for packet-level context manifests`
  );
}

function assertCanonicalPacketManifestMatch({
  suppliedEntries,
  canonicalEntries,
  contextManifestFieldName,
  contextFilesFieldName
}) {
  const suppliedKeys = new Set(suppliedEntries.map((entry) => contextManifestEntryKey(entry)));
  const canonicalKeys = new Set(canonicalEntries.map((entry) => contextManifestEntryKey(entry)));

  const mismatch = suppliedEntries.length !== canonicalEntries.length
    || suppliedEntries.some((entry) => !canonicalKeys.has(contextManifestEntryKey(entry)))
    || canonicalEntries.some((entry) => !suppliedKeys.has(contextManifestEntryKey(entry)));

  assert(
    !mismatch,
    `${contextManifestFieldName} must exactly match canonical packet context_file entries derived from ${contextFilesFieldName}`
  );
}

export function createContextManifestEntry(entry, { fieldName = "contextManifestEntry" } = {}) {
  assert(entry && typeof entry === "object" && !Array.isArray(entry), `${fieldName} must be an object`);

  return {
    kind: normalizeEnumValue({
      fieldName: `${fieldName}.kind`,
      value: entry.kind,
      allowedValues: CONTEXT_MANIFEST_KINDS,
      allowedValueSet: CONTEXT_MANIFEST_KIND_SET
    }),
    source: normalizeEnumValue({
      fieldName: `${fieldName}.source`,
      value: entry.source,
      allowedValues: CONTEXT_MANIFEST_SOURCES,
      allowedValueSet: CONTEXT_MANIFEST_SOURCE_SET
    }),
    reference: normalizeReference(`${fieldName}.reference`, entry.reference),
    reason: normalizeEnumValue({
      fieldName: `${fieldName}.reason`,
      value: entry.reason,
      allowedValues: CONTEXT_MANIFEST_REASONS,
      allowedValueSet: CONTEXT_MANIFEST_REASON_SET
    })
  };
}

export function normalizeContextManifest(manifest, {
  fieldName = "contextManifest",
  allowMissing = true
} = {}) {
  if (manifest === undefined) {
    if (allowMissing) {
      return undefined;
    }
    throw new Error(`${fieldName} must be an array`);
  }

  assert(Array.isArray(manifest), `${fieldName} must be an array`);
  const entries = manifest.map((entry, index) => createContextManifestEntry(entry, {
    fieldName: `${fieldName}[${index}]`
  }));

  return uniqueContextManifestEntries(entries);
}

export function mergeContextManifestEntries(...entryGroups) {
  const entries = [];

  for (const entryGroup of entryGroups) {
    if (!Array.isArray(entryGroup)) {
      continue;
    }

    for (const entry of entryGroup) {
      entries.push(createContextManifestEntry(entry));
    }
  }

  return uniqueContextManifestEntries(entries);
}

function formatManifestEntriesForError(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "none";
  }

  return entries
    .map((entry) => `${entry.kind}:${entry.reference}`)
    .join(", ");
}

function compareManifestEntriesByKind({
  kind,
  actualEntries,
  expectedEntries
}) {
  const actualSet = new Set(actualEntries.map((entry) => contextManifestEntryKey(entry)));
  const expectedSet = new Set(expectedEntries.map((entry) => contextManifestEntryKey(entry)));

  const missingEntries = expectedEntries.filter((entry) => !actualSet.has(contextManifestEntryKey(entry)));
  const unexpectedEntries = actualEntries.filter((entry) => !expectedSet.has(contextManifestEntryKey(entry)));

  if (missingEntries.length === 0 && unexpectedEntries.length === 0) {
    return;
  }

  const details = [];
  if (missingEntries.length > 0) {
    details.push(`missing ${kind}: ${formatManifestEntriesForError(missingEntries)}`);
  }
  if (unexpectedEntries.length > 0) {
    details.push(`unexpected ${kind}: ${formatManifestEntriesForError(unexpectedEntries)}`);
  }

  throw new Error(`${RUN_CONTEXT_ADMISSION_ERROR_PREFIX}: ${details.join("; ")}`);
}

function redactionMetadataEqual(left, right) {
  return left.applied === right.applied
    && left.repoPathRewrites === right.repoPathRewrites
    && left.workspacePathRewrites === right.workspacePathRewrites
    && left.externalPathRewrites === right.externalPathRewrites;
}

function formatRedactionMetadata(metadata) {
  return `{"applied":${metadata.applied},"repoPathRewrites":${metadata.repoPathRewrites},"workspacePathRewrites":${metadata.workspacePathRewrites},"externalPathRewrites":${metadata.externalPathRewrites}}`;
}

function cloneExpectedForwardedRedactionMetadata(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  return {
    ...value
  };
}

function cloneExpectedPriorResultRedactionMetadata(value) {
  if (value === undefined) {
    return undefined;
  }

  return value.map((entry) => cloneExpectedForwardedRedactionMetadata(entry));
}

function cloneTrustedForwardedRedactionMetadata(value) {
  if (value === undefined) {
    return undefined;
  }

  return {
    priorResults: cloneExpectedPriorResultRedactionMetadata(value.priorResults),
    reviewResult: cloneExpectedForwardedRedactionMetadata(value.reviewResult)
  };
}

function assertRedactionMatchesTrustedForwardedMetadata(redaction, expectedRedactionMetadata, {
  fieldName
} = {}) {
  const normalizedRedaction = normalizeRedactionMetadata(redaction, {
    fieldName,
    allowMissing: false
  });
  assert(
    redactionMetadataEqual(normalizedRedaction, expectedRedactionMetadata),
    `${fieldName} must exactly match trusted forwarded redaction metadata (expected ${formatRedactionMetadata(expectedRedactionMetadata)}, received ${formatRedactionMetadata(normalizedRedaction)})`
  );
  return expectedRedactionMetadata;
}

function normalizeExpectedForwardedRedactionMetadata(value, {
  fieldName
} = {}) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  return normalizeRedactionMetadata(value, {
    fieldName,
    allowMissing: false
  });
}

function normalizeExpectedPriorResultRedactionMetadata(value, {
  fieldName
} = {}) {
  if (value === undefined) {
    return undefined;
  }

  assert(Array.isArray(value), `${fieldName} must be an array`);
  return value.map((entry, index) => normalizeExpectedForwardedRedactionMetadata(entry, {
    fieldName: `${fieldName}[${index}]`
  }));
}

function normalizeTrustedForwardedRedactionMetadata(value, {
  fieldName = "trustedForwardedRedactionMetadata"
} = {}) {
  if (value === undefined) {
    return undefined;
  }

  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${fieldName} must be an object`
  );

  return {
    priorResults: normalizeExpectedPriorResultRedactionMetadata(value.priorResults, {
      fieldName: `${fieldName}.priorResults`
    }),
    reviewResult: normalizeExpectedForwardedRedactionMetadata(value.reviewResult, {
      fieldName: `${fieldName}.reviewResult`
    })
  };
}

export function setTrustedForwardedRedactionMetadata(context, forwardedRedactionMetadata, {
  fieldName = "trustedForwardedRedactionMetadata"
} = {}) {
  assert(
    context && typeof context === "object" && !Array.isArray(context),
    "context must be an object"
  );

  const normalizedMetadata = normalizeTrustedForwardedRedactionMetadata(forwardedRedactionMetadata, {
    fieldName
  });
  if (normalizedMetadata === undefined) {
    TRUSTED_FORWARDED_REDACTION_METADATA_BY_CONTEXT.delete(context);
    return undefined;
  }

  const clonedMetadata = {
    priorResults: cloneExpectedPriorResultRedactionMetadata(normalizedMetadata.priorResults),
    reviewResult: cloneExpectedForwardedRedactionMetadata(normalizedMetadata.reviewResult)
  };
  TRUSTED_FORWARDED_REDACTION_METADATA_BY_CONTEXT.set(context, clonedMetadata);
  return cloneTrustedForwardedRedactionMetadata(clonedMetadata);
}

export function getTrustedForwardedRedactionMetadata(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return undefined;
  }

  const trustedMetadata = TRUSTED_FORWARDED_REDACTION_METADATA_BY_CONTEXT.get(context);
  if (trustedMetadata === undefined) {
    return undefined;
  }

  return cloneTrustedForwardedRedactionMetadata(trustedMetadata);
}

function normalizePriorResultReferences(priorResults, fieldName, {
  redactor,
  expectedRedactionMetadata
} = {}) {
  assert(Array.isArray(priorResults), `${fieldName} must be an array`);
  if (expectedRedactionMetadata !== undefined) {
    assert(
      expectedRedactionMetadata.length === priorResults.length,
      `${fieldName} trusted forwarded redaction metadata must contain one entry per prior result`
    );
  }

  return priorResults.map((priorResult, index) => {
    assert(
      priorResult && typeof priorResult === "object" && !Array.isArray(priorResult),
      `${fieldName}[${index}] must be an object`
    );
    const expectedPriorResultRedaction = expectedRedactionMetadata?.[index];
    if (expectedPriorResultRedaction !== undefined) {
      assert(
        Object.prototype.hasOwnProperty.call(priorResult, "redaction"),
        `${fieldName}[${index}].redaction must be present when trusted forwarded redaction metadata is provided`
      );
      priorResult.redaction = assertRedactionMatchesTrustedForwardedMetadata(
        priorResult.redaction,
        expectedPriorResultRedaction,
        {
          fieldName: `${fieldName}[${index}].redaction`
        }
      );
    } else if (Object.prototype.hasOwnProperty.call(priorResult, "redaction")) {
      priorResult.redaction = assertRedactionMetadataMatchesCoveredStrings(priorResult.redaction, {
        redactor,
        fieldName: `${fieldName}[${index}].redaction`,
        stringFields: [
          {
            fieldName: `${fieldName}[${index}].summary`,
            value: priorResult.summary
          }
        ],
        stringArrayFields: [
          {
            fieldName: `${fieldName}[${index}].changedFiles`,
            value: priorResult.changedFiles
          },
          {
            fieldName: `${fieldName}[${index}].commandsRun`,
            value: priorResult.commandsRun
          },
          {
            fieldName: `${fieldName}[${index}].evidence`,
            value: priorResult.evidence
          },
          {
            fieldName: `${fieldName}[${index}].openQuestions`,
            value: priorResult.openQuestions
          }
        ]
      });
    }
    return normalizeReference(`${fieldName}[${index}].packetId`, priorResult.packetId);
  });
}

function normalizeReviewResultPresence(reviewResult, fieldName, {
  redactor,
  expectedRedactionMetadata
} = {}) {
  if (reviewResult === null || reviewResult === undefined) {
    assert(
      expectedRedactionMetadata === undefined || expectedRedactionMetadata === null,
      `${fieldName} must be present when trusted forwarded redaction metadata is provided`
    );
    return null;
  }

  assert(
    reviewResult && typeof reviewResult === "object" && !Array.isArray(reviewResult),
    `${fieldName} must be an object or null`
  );
  if (expectedRedactionMetadata !== undefined && expectedRedactionMetadata !== null) {
    assert(
      Object.prototype.hasOwnProperty.call(reviewResult, "redaction"),
      `${fieldName}.redaction must be present when trusted forwarded redaction metadata is provided`
    );
    reviewResult.redaction = assertRedactionMatchesTrustedForwardedMetadata(
      reviewResult.redaction,
      expectedRedactionMetadata,
      {
        fieldName: `${fieldName}.redaction`
      }
    );
  } else if (Object.prototype.hasOwnProperty.call(reviewResult, "redaction")) {
    reviewResult.redaction = assertRedactionMetadataMatchesCoveredStrings(reviewResult.redaction, {
      redactor,
      fieldName: `${fieldName}.redaction`,
      stringFields: [
        {
          fieldName: `${fieldName}.summary`,
          value: reviewResult.summary
        }
      ],
      stringArrayFields: [
        {
          fieldName: `${fieldName}.evidence`,
          value: reviewResult.evidence
        },
        {
          fieldName: `${fieldName}.openQuestions`,
          value: reviewResult.openQuestions
        }
      ]
    });
  }

  return reviewResult;
}

function normalizeChangedSurfaceReferences(changedSurfaceContext, fieldName) {
  assert(Array.isArray(changedSurfaceContext), `${fieldName} must be an array`);

  return changedSurfaceContext.map((entry, index) => {
    assert(
      entry && typeof entry === "object" && !Array.isArray(entry),
      `${fieldName}[${index}] must be an object`
    );

    const packetId = normalizeReference(`${fieldName}[${index}].packetId`, entry.packetId);
    const role = normalizeReference(`${fieldName}[${index}].role`, entry.role);
    const paths = normalizeStringArray(`${fieldName}[${index}].paths`, entry.paths);
    assert(paths.length > 0, `${fieldName}[${index}].paths must contain at least one path`);

    return `${packetId}:${role}`;
  });
}

function assertContextBudgetTruncationFlag({
  fieldName,
  truncated,
  count
}) {
  const expected = count > 0;
  assert(
    truncated === expected,
    `${fieldName} must be ${expected} when truncation count is ${count}`
  );
}

function assertContextBudgetConsistency({
  contextBudget,
  priorResultReferences,
  fieldName
}) {
  if (!contextBudget) {
    return;
  }

  const truncatedPacketIds = contextBudget.truncatedPriorResultPacketIds;
  const priorResultCountSignal = (
    truncatedPacketIds.length > 0
    || contextBudget.truncationCount.priorResults > 0
  );
  assert(
    contextBudget.priorResultsTruncated === priorResultCountSignal,
    `${fieldName}.priorResultsTruncated must be true iff truncated prior-result ids are present or truncationCount.priorResults > 0`
  );

  const seenTruncatedPacketIds = new Set();
  for (const [index, packetId] of truncatedPacketIds.entries()) {
    assert(packetId.length > 0, `${fieldName}.truncatedPriorResultPacketIds[${index}] must be a non-empty string`);
    assert(
      !seenTruncatedPacketIds.has(packetId),
      `${fieldName}.truncatedPriorResultPacketIds[${index}] duplicates packetId ${packetId}`
    );
    seenTruncatedPacketIds.add(packetId);
  }

  const forwardedPacketIds = new Set(priorResultReferences);
  for (const packetId of seenTruncatedPacketIds) {
    assert(
      !forwardedPacketIds.has(packetId),
      `${fieldName}.truncatedPriorResultPacketIds must not overlap with forwarded priorResults[].packetId`
    );
  }

  assertContextBudgetTruncationFlag({
    fieldName: `${fieldName}.perResultEvidenceTruncated`,
    truncated: contextBudget.perResultEvidenceTruncated,
    count: contextBudget.truncationCount.evidenceEntries
  });
  assertContextBudgetTruncationFlag({
    fieldName: `${fieldName}.perResultCommandsTruncated`,
    truncated: contextBudget.perResultCommandsTruncated,
    count: contextBudget.truncationCount.commandEntries
  });
  assertContextBudgetTruncationFlag({
    fieldName: `${fieldName}.perResultChangedFilesTruncated`,
    truncated: contextBudget.perResultChangedFilesTruncated,
    count: contextBudget.truncationCount.changedFiles
  });
}

export function normalizeContextBudget(contextBudget, {
  fieldName = "contextBudget",
  allowMissing = true
} = {}) {
  if (contextBudget === undefined) {
    if (allowMissing) {
      return undefined;
    }

    throw new Error(`${fieldName} must be an object`);
  }

  assert(
    contextBudget && typeof contextBudget === "object" && !Array.isArray(contextBudget),
    `${fieldName} must be an object`
  );

  const truncationCount = contextBudget.truncationCount ?? {};
  assert(
    truncationCount && typeof truncationCount === "object" && !Array.isArray(truncationCount),
    `${fieldName}.truncationCount must be an object`
  );

  return {
    priorResultsTruncated: normalizeOptionalBoolean({
      fieldName: `${fieldName}.priorResultsTruncated`,
      value: contextBudget.priorResultsTruncated,
      defaultValue: false
    }),
    truncatedPriorResultPacketIds: normalizeStringArray(
      `${fieldName}.truncatedPriorResultPacketIds`,
      contextBudget.truncatedPriorResultPacketIds,
      { allowMissing: true }
    ),
    perResultEvidenceTruncated: normalizeOptionalBoolean({
      fieldName: `${fieldName}.perResultEvidenceTruncated`,
      value: contextBudget.perResultEvidenceTruncated,
      defaultValue: false
    }),
    perResultCommandsTruncated: normalizeOptionalBoolean({
      fieldName: `${fieldName}.perResultCommandsTruncated`,
      value: contextBudget.perResultCommandsTruncated,
      defaultValue: false
    }),
    perResultChangedFilesTruncated: normalizeOptionalBoolean({
      fieldName: `${fieldName}.perResultChangedFilesTruncated`,
      value: contextBudget.perResultChangedFilesTruncated,
      defaultValue: false
    }),
    truncationCount: {
      priorResults: normalizeNonNegativeInteger({
        fieldName: `${fieldName}.truncationCount.priorResults`,
        value: truncationCount.priorResults,
        defaultValue: 0
      }),
      evidenceEntries: normalizeNonNegativeInteger({
        fieldName: `${fieldName}.truncationCount.evidenceEntries`,
        value: truncationCount.evidenceEntries,
        defaultValue: 0
      }),
      commandEntries: normalizeNonNegativeInteger({
        fieldName: `${fieldName}.truncationCount.commandEntries`,
        value: truncationCount.commandEntries,
        defaultValue: 0
      }),
      changedFiles: normalizeNonNegativeInteger({
        fieldName: `${fieldName}.truncationCount.changedFiles`,
        value: truncationCount.changedFiles,
        defaultValue: 0
      })
    }
  };
}

export function validateRunContext({
  packetContextFiles = [],
  contextManifest,
  priorResults = [],
  reviewResult = null,
  changedSurfaceContext = [],
  contextBudget,
  forwardedRedactionMetadata,
  repositoryRoot = process.cwd(),
  fieldName = "context"
} = {}) {
  const redactor = createBoundaryPathRedactor({
    repositoryRoot
  });
  const expectedPriorResultRedactionMetadata = normalizeExpectedPriorResultRedactionMetadata(
    forwardedRedactionMetadata?.priorResults,
    {
      fieldName: `${fieldName}.forwardedRedactionMetadata.priorResults`
    }
  );
  const expectedReviewResultRedactionMetadata = normalizeExpectedForwardedRedactionMetadata(
    forwardedRedactionMetadata?.reviewResult,
    {
      fieldName: `${fieldName}.forwardedRedactionMetadata.reviewResult`
    }
  );
  const normalizedManifest = normalizeContextManifest(contextManifest, {
    fieldName: `${fieldName}.contextManifest`,
    allowMissing: false
  });

  const priorResultReferences = normalizePriorResultReferences(
    priorResults,
    `${fieldName}.priorResults`,
    {
      redactor,
      expectedRedactionMetadata: expectedPriorResultRedactionMetadata
    }
  );
  const normalizedReviewResult = normalizeReviewResultPresence(
    reviewResult,
    `${fieldName}.reviewResult`,
    {
      redactor,
      expectedRedactionMetadata: expectedReviewResultRedactionMetadata
    }
  );
  const changedSurfaceReferences = normalizeChangedSurfaceReferences(
    changedSurfaceContext,
    `${fieldName}.changedSurfaceContext`
  );
  const normalizedContextBudget = normalizeContextBudget(contextBudget, {
    fieldName: `${fieldName}.contextBudget`,
    allowMissing: true
  });
  assertContextBudgetConsistency({
    contextBudget: normalizedContextBudget,
    priorResultReferences,
    fieldName: `${fieldName}.contextBudget`
  });

  const expectedContextFileEntries = buildPacketContextManifest(packetContextFiles);
  const expectedPriorResultEntries = buildPriorResultContextManifest(
    priorResultReferences.map((packetId) => ({ packetId }))
  );
  const expectedReviewResultEntries = buildReviewResultContextManifest(normalizedReviewResult);
  const expectedChangedSurfaceEntries = buildChangedSurfaceContextManifest(changedSurfaceReferences);

  compareManifestEntriesByKind({
    kind: CONTEXT_MANIFEST_KIND.CONTEXT_FILE,
    actualEntries: normalizedManifest.filter((entry) => entry.kind === CONTEXT_MANIFEST_KIND.CONTEXT_FILE),
    expectedEntries: expectedContextFileEntries
  });
  compareManifestEntriesByKind({
    kind: CONTEXT_MANIFEST_KIND.PRIOR_RESULT,
    actualEntries: normalizedManifest.filter((entry) => entry.kind === CONTEXT_MANIFEST_KIND.PRIOR_RESULT),
    expectedEntries: expectedPriorResultEntries
  });
  compareManifestEntriesByKind({
    kind: CONTEXT_MANIFEST_KIND.REVIEW_RESULT,
    actualEntries: normalizedManifest.filter((entry) => entry.kind === CONTEXT_MANIFEST_KIND.REVIEW_RESULT),
    expectedEntries: expectedReviewResultEntries
  });
  compareManifestEntriesByKind({
    kind: CONTEXT_MANIFEST_KIND.CHANGED_SURFACE,
    actualEntries: normalizedManifest.filter((entry) => entry.kind === CONTEXT_MANIFEST_KIND.CHANGED_SURFACE),
    expectedEntries: expectedChangedSurfaceEntries
  });

  return {
    contextManifest: normalizedManifest,
    contextBudget: normalizedContextBudget
  };
}

export function buildPacketContextManifest(contextFiles = []) {
  if (!Array.isArray(contextFiles)) {
    return [];
  }

  const entries = contextFiles
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((reference) => ({
      kind: CONTEXT_MANIFEST_KIND.CONTEXT_FILE,
      source: CONTEXT_MANIFEST_SOURCE.PACKET_CONTEXT_FILES,
      reference,
      reason: CONTEXT_MANIFEST_REASON.EXPLICIT_REQUEST
    }));

  return mergeContextManifestEntries(entries);
}

export function resolvePacketContextManifest({
  contextFiles = [],
  contextManifest,
  contextFilesFieldName = "packet.contextFiles",
  contextManifestFieldName = "packet.contextManifest"
} = {}) {
  const canonicalEntries = buildPacketContextManifest(contextFiles);

  if (contextManifest === undefined) {
    return canonicalEntries;
  }

  const suppliedEntries = normalizeContextManifest(contextManifest, {
    fieldName: contextManifestFieldName,
    allowMissing: false
  });

  for (const [index, entry] of suppliedEntries.entries()) {
    assertPacketContextManifestEntry(entry, {
      fieldName: `${contextManifestFieldName}[${index}]`
    });
  }

  assertCanonicalPacketManifestMatch({
    suppliedEntries,
    canonicalEntries,
    contextManifestFieldName,
    contextFilesFieldName
  });

  return canonicalEntries;
}

export function buildPriorResultContextManifest(priorResults = []) {
  if (!Array.isArray(priorResults)) {
    return [];
  }

  const entries = priorResults
    .map((priorResult) => priorResult?.packetId)
    .filter((packetId) => typeof packetId === "string" && packetId.trim().length > 0)
    .map((packetId) => ({
      kind: CONTEXT_MANIFEST_KIND.PRIOR_RESULT,
      source: CONTEXT_MANIFEST_SOURCE.WORKFLOW_PRIOR_RUNS,
      reference: packetId,
      reason: CONTEXT_MANIFEST_REASON.EXECUTION_HISTORY
    }));

  return mergeContextManifestEntries(entries);
}

export function buildReviewResultContextManifest(reviewResult) {
  if (!reviewResult) {
    return [];
  }

  return mergeContextManifestEntries([
    {
      kind: CONTEXT_MANIFEST_KIND.REVIEW_RESULT,
      source: CONTEXT_MANIFEST_SOURCE.REPAIR_REVIEW,
      reference: "review_result",
      reason: CONTEXT_MANIFEST_REASON.REPAIR_CONTEXT
    }
  ]);
}

export function buildChangedSurfaceContextManifest(changedSurfaceReferences = []) {
  if (!Array.isArray(changedSurfaceReferences)) {
    return [];
  }

  const entries = changedSurfaceReferences
    .filter((reference) => typeof reference === "string" && reference.trim().length > 0)
    .map((reference) => ({
      kind: CONTEXT_MANIFEST_KIND.CHANGED_SURFACE,
      source: CONTEXT_MANIFEST_SOURCE.TRUSTED_CHANGED_SURFACE,
      reference,
      reason: CONTEXT_MANIFEST_REASON.CHANGED_SCOPE_CARRY_FORWARD
    }));

  return mergeContextManifestEntries(entries);
}

export {
  CONTEXT_MANIFEST_KIND,
  CONTEXT_MANIFEST_REASON,
  CONTEXT_MANIFEST_SOURCE
};
