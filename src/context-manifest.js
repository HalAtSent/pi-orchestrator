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
