import { posix, win32 } from "node:path";

export const REDACTION_PROCESS_WORKSPACE_PLACEHOLDER = "<process_workspace>";
export const REDACTION_ABSOLUTE_PATH_PLACEHOLDER = "<absolute_path>";

const ABSOLUTE_PATH_PATTERN = /[A-Za-z]:[\\/][^\s"'`<>()\[\]{}|,;:]+|(?<![A-Za-z0-9._-])\/(?:[^\s"'`<>()\[\]{}|,;:\/]+\/)+[^\s"'`<>()\[\]{}|,;:]*/gu;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createRedactionCounts() {
  return {
    repoPathRewrites: 0,
    workspacePathRewrites: 0,
    externalPathRewrites: 0
  };
}

function normalizeNonNegativeInteger(fieldName, value) {
  assert(Number.isInteger(value) && value >= 0, `${fieldName} must be a non-negative integer`);
  return value;
}

function createRedactionMetadataFromCounts(counts) {
  const repoPathRewrites = normalizeNonNegativeInteger("redaction.repoPathRewrites", counts.repoPathRewrites);
  const workspacePathRewrites = normalizeNonNegativeInteger("redaction.workspacePathRewrites", counts.workspacePathRewrites);
  const externalPathRewrites = normalizeNonNegativeInteger("redaction.externalPathRewrites", counts.externalPathRewrites);
  const totalRewrites = repoPathRewrites + workspacePathRewrites + externalPathRewrites;

  return {
    applied: totalRewrites > 0,
    repoPathRewrites,
    workspacePathRewrites,
    externalPathRewrites
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function classifyAbsolutePathStyle(pathValue) {
  const normalized = String(pathValue).trim();
  if (normalized.length === 0) {
    return null;
  }

  if (/^[A-Za-z]:[\\/]/u.test(normalized) || normalized.startsWith("\\\\")) {
    return "win32";
  }

  if (normalized.startsWith("/")) {
    return "posix";
  }

  return null;
}

function getPathModule(style) {
  return style === "win32" ? win32 : posix;
}

function normalizeWorkspaceRootEntries(processWorkspaceRoots) {
  if (!Array.isArray(processWorkspaceRoots)) {
    return [];
  }

  const entries = processWorkspaceRoots
    .filter((root) => typeof root === "string" && root.trim().length > 0)
    .map((root) => {
      const normalizedRoot = root.trim();
      const style = classifyAbsolutePathStyle(normalizedRoot);
      if (!style) {
        return null;
      }
      const pathModule = getPathModule(style);
      return {
        style,
        absolutePath: pathModule.resolve(normalizedRoot)
      };
    })
    .filter(Boolean);

  entries.sort((left, right) => right.absolutePath.length - left.absolutePath.length);
  return entries;
}

function normalizeRepositoryRootEntry(repositoryRoot) {
  assert(
    typeof repositoryRoot === "string" && repositoryRoot.trim().length > 0,
    "repositoryRoot must be a non-empty string"
  );
  const normalizedRepositoryRoot = repositoryRoot.trim();
  const style = classifyAbsolutePathStyle(normalizedRepositoryRoot);
  assert(style, "repositoryRoot must be an absolute path");
  const pathModule = getPathModule(style);
  return {
    style,
    absolutePath: pathModule.resolve(normalizedRepositoryRoot)
  };
}

function normalizeRelativePathForOutput(relativePath) {
  return String(relativePath)
    .replace(/\\/gu, "/")
    .replace(/^\.\/+/u, "");
}

function resolvePathRelation(candidatePath, rootEntry) {
  const pathModule = getPathModule(rootEntry.style);
  const candidateAbsolutePath = pathModule.resolve(candidatePath);
  const relativePath = pathModule.relative(rootEntry.absolutePath, candidateAbsolutePath);
  const isInside = relativePath === ""
    || (
      !relativePath.startsWith("..")
      && !pathModule.isAbsolute(relativePath)
    );

  return {
    isInside,
    relativePath: normalizeRelativePathForOutput(relativePath)
  };
}

function shouldIgnorePathMatch(value, matchOffset, matchText) {
  if (!matchText.startsWith("/")) {
    return false;
  }

  return matchOffset >= 2
    && value[matchOffset - 1] === "/"
    && value[matchOffset - 2] === ":";
}

function addRedactionCounts(target, source) {
  target.repoPathRewrites += source.repoPathRewrites;
  target.workspacePathRewrites += source.workspacePathRewrites;
  target.externalPathRewrites += source.externalPathRewrites;
}

function assertBoundaryRedactor(redactor) {
  assert(redactor && typeof redactor === "object", "redactor must be an object");
  assert(typeof redactor.redactString === "function", "redactor.redactString(value, options) is required");
  assert(typeof redactor.redactStringArray === "function", "redactor.redactStringArray(values, options) is required");
}

function normalizeCoveredStringField(field, index, fieldName) {
  assert(isPlainObject(field), `${fieldName}[${index}] must be an object`);
  assert(
    typeof field.fieldName === "string" && field.fieldName.trim().length > 0,
    `${fieldName}[${index}].fieldName must be a non-empty string`
  );
  return {
    fieldName: field.fieldName.trim(),
    value: field.value
  };
}

function redactionMetadataMatches(left, right) {
  return left.applied === right.applied
    && left.repoPathRewrites === right.repoPathRewrites
    && left.workspacePathRewrites === right.workspacePathRewrites
    && left.externalPathRewrites === right.externalPathRewrites;
}

function formatRedactionMetadataValue(metadata) {
  return `{"applied":${metadata.applied},"repoPathRewrites":${metadata.repoPathRewrites},"workspacePathRewrites":${metadata.workspacePathRewrites},"externalPathRewrites":${metadata.externalPathRewrites}}`;
}

export function normalizeRedactionMetadata(value, {
  fieldName = "redaction",
  allowMissing = true
} = {}) {
  if (value === undefined) {
    if (allowMissing) {
      return undefined;
    }
    throw new Error(`${fieldName} must be an object`);
  }

  assert(isPlainObject(value), `${fieldName} must be an object`);
  assert(typeof value.applied === "boolean", `${fieldName}.applied must be a boolean`);
  const repoPathRewrites = normalizeNonNegativeInteger(`${fieldName}.repoPathRewrites`, value.repoPathRewrites);
  const workspacePathRewrites = normalizeNonNegativeInteger(`${fieldName}.workspacePathRewrites`, value.workspacePathRewrites);
  const externalPathRewrites = normalizeNonNegativeInteger(`${fieldName}.externalPathRewrites`, value.externalPathRewrites);
  const expectedApplied = (repoPathRewrites + workspacePathRewrites + externalPathRewrites) > 0;
  assert(
    value.applied === expectedApplied,
    `${fieldName}.applied must be ${expectedApplied} when rewrite counts imply that value`
  );

  return {
    applied: expectedApplied,
    repoPathRewrites,
    workspacePathRewrites,
    externalPathRewrites
  };
}

export function mergeRedactionMetadata(...metadataValues) {
  const combinedCounts = createRedactionCounts();
  for (const [index, metadataValue] of metadataValues.entries()) {
    if (metadataValue === undefined || metadataValue === null) {
      continue;
    }
    const normalized = normalizeRedactionMetadata(metadataValue, {
      fieldName: `redaction[${index}]`,
      allowMissing: false
    });
    addRedactionCounts(combinedCounts, normalized);
  }
  return createRedactionMetadataFromCounts(combinedCounts);
}

export function recomputeRedactionMetadataFromCoveredStrings({
  redactor,
  stringFields = [],
  stringArrayFields = []
} = {}) {
  assertBoundaryRedactor(redactor);
  assert(Array.isArray(stringFields), "stringFields must be an array");
  assert(Array.isArray(stringArrayFields), "stringArrayFields must be an array");

  const metadataValues = [];
  for (const [index, field] of stringFields.entries()) {
    const normalizedField = normalizeCoveredStringField(field, index, "stringFields");
    const redacted = redactor.redactString(normalizedField.value, {
      fieldName: normalizedField.fieldName
    });
    metadataValues.push(redacted.redaction);
  }

  for (const [index, field] of stringArrayFields.entries()) {
    const normalizedField = normalizeCoveredStringField(field, index, "stringArrayFields");
    const redacted = redactor.redactStringArray(normalizedField.value, {
      fieldName: normalizedField.fieldName
    });
    metadataValues.push(redacted.redaction);
  }

  return mergeRedactionMetadata(...metadataValues);
}

export function assertRedactionMetadataMatchesCoveredStrings(redaction, {
  redactor,
  fieldName = "redaction",
  stringFields = [],
  stringArrayFields = []
} = {}) {
  const normalizedRedaction = normalizeRedactionMetadata(redaction, {
    fieldName,
    allowMissing: false
  });
  const recomputedRedaction = recomputeRedactionMetadataFromCoveredStrings({
    redactor,
    stringFields,
    stringArrayFields
  });
  assert(
    redactionMetadataMatches(normalizedRedaction, recomputedRedaction),
    `${fieldName} must exactly match redaction metadata recomputed from covered strings (expected ${formatRedactionMetadataValue(recomputedRedaction)}, received ${formatRedactionMetadataValue(normalizedRedaction)})`
  );
  return recomputedRedaction;
}

export function createBoundaryPathRedactor({
  repositoryRoot,
  processWorkspaceRoots = []
} = {}) {
  const repositoryRootEntry = normalizeRepositoryRootEntry(repositoryRoot);
  const workspaceRootEntries = normalizeWorkspaceRootEntries(processWorkspaceRoots);

  function rewriteAbsolutePathMatch(pathCandidate) {
    const style = classifyAbsolutePathStyle(pathCandidate);
    if (!style) {
      return {
        value: pathCandidate,
        redaction: createRedactionMetadataFromCounts(createRedactionCounts())
      };
    }

    const compatibleWorkspaceRoots = workspaceRootEntries.filter((entry) => entry.style === style);
    for (const workspaceRootEntry of compatibleWorkspaceRoots) {
      const relation = resolvePathRelation(pathCandidate, workspaceRootEntry);
      if (!relation.isInside) {
        continue;
      }

      const rewrittenValue = relation.relativePath.length > 0
        ? `${REDACTION_PROCESS_WORKSPACE_PLACEHOLDER}/${relation.relativePath}`
        : REDACTION_PROCESS_WORKSPACE_PLACEHOLDER;
      return {
        value: rewrittenValue,
        redaction: createRedactionMetadataFromCounts({
          repoPathRewrites: 0,
          workspacePathRewrites: 1,
          externalPathRewrites: 0
        })
      };
    }

    if (repositoryRootEntry.style === style) {
      const relation = resolvePathRelation(pathCandidate, repositoryRootEntry);
      if (relation.isInside) {
        return {
          value: relation.relativePath.length > 0 ? relation.relativePath : ".",
          redaction: createRedactionMetadataFromCounts({
            repoPathRewrites: 1,
            workspacePathRewrites: 0,
            externalPathRewrites: 0
          })
        };
      }
    }

    return {
      value: REDACTION_ABSOLUTE_PATH_PLACEHOLDER,
      redaction: createRedactionMetadataFromCounts({
        repoPathRewrites: 0,
        workspacePathRewrites: 0,
        externalPathRewrites: 1
      })
    };
  }

  function redactString(value, { fieldName = "value" } = {}) {
    assert(typeof value === "string", `${fieldName} must be a string`);
    const counts = createRedactionCounts();
    const redactedValue = value.replace(ABSOLUTE_PATH_PATTERN, (match, offset, source) => {
      if (shouldIgnorePathMatch(source, offset, match)) {
        return match;
      }

      const rewritten = rewriteAbsolutePathMatch(match);
      addRedactionCounts(counts, rewritten.redaction);
      return rewritten.value;
    });

    return {
      value: redactedValue,
      redaction: createRedactionMetadataFromCounts(counts)
    };
  }

  function redactStringArray(values, { fieldName = "values" } = {}) {
    assert(Array.isArray(values), `${fieldName} must be an array`);
    const redactedValues = [];
    const counts = createRedactionCounts();

    values.forEach((entry, index) => {
      assert(typeof entry === "string", `${fieldName}[${index}] must be a string`);
      const redacted = redactString(entry, {
        fieldName: `${fieldName}[${index}]`
      });
      redactedValues.push(redacted.value);
      addRedactionCounts(counts, redacted.redaction);
    });

    return {
      values: redactedValues,
      redaction: createRedactionMetadataFromCounts(counts)
    };
  }

  return {
    redactString,
    redactStringArray
  };
}
