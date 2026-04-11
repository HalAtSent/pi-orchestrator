function assertPathString(pathValue) {
  if (typeof pathValue !== "string") {
    throw new Error("scope path must be a string");
  }
}

function normalizeSlashes(pathValue) {
  assertPathString(pathValue);
  return pathValue.replace(/\\/g, "/");
}

const WINDOWS_CASE_INSENSITIVE_PATHS = process.platform === "win32";

function toComparableScopedPath(pathValue) {
  const normalizedPath = normalizeScopedPath(pathValue);
  return WINDOWS_CASE_INSENSITIVE_PATHS ? normalizedPath.toLowerCase() : normalizedPath;
}

export function normalizeScopedPath(pathValue) {
  const normalizedSlashes = normalizeSlashes(pathValue);
  const hasLeadingSlash = normalizedSlashes.startsWith("/");
  const hasTrailingSlash = normalizedSlashes.endsWith("/");
  const normalizedSegments = [];

  for (const segment of normalizedSlashes.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (normalizedSegments.length > 0 && normalizedSegments[normalizedSegments.length - 1] !== "..") {
        normalizedSegments.pop();
      } else {
        normalizedSegments.push("..");
      }
      continue;
    }

    normalizedSegments.push(segment);
  }

  let normalizedPath = normalizedSegments.join("/");

  if (hasLeadingSlash) {
    normalizedPath = `/${normalizedPath}`;
  }

  if (hasTrailingSlash && normalizedPath.length > 0 && !normalizedPath.endsWith("/")) {
    normalizedPath = `${normalizedPath}/`;
  }

  return normalizedPath;
}

function isDirectoryScope(scopeEntry) {
  return normalizeScopedPath(scopeEntry).endsWith("/");
}

export function isPathWithinScope(changedPath, scopeEntry) {
  const normalizedChangedPath = normalizeScopedPath(changedPath);
  const normalizedScopeEntry = normalizeScopedPath(scopeEntry);
  const comparableChangedPath = toComparableScopedPath(normalizedChangedPath);
  const comparableScopeEntry = toComparableScopedPath(normalizedScopeEntry);

  if (isDirectoryScope(normalizedScopeEntry)) {
    return comparableChangedPath.startsWith(comparableScopeEntry);
  }

  return comparableChangedPath === comparableScopeEntry;
}

export function scopesOverlap(a, b) {
  const normalizedA = normalizeScopedPath(a);
  const normalizedB = normalizeScopedPath(b);
  const comparableA = toComparableScopedPath(normalizedA);
  const comparableB = toComparableScopedPath(normalizedB);
  const aIsDirectory = isDirectoryScope(normalizedA);
  const bIsDirectory = isDirectoryScope(normalizedB);

  if (!aIsDirectory && !bIsDirectory) {
    return comparableA === comparableB;
  }

  if (aIsDirectory && bIsDirectory) {
    return comparableA.startsWith(comparableB) || comparableB.startsWith(comparableA);
  }

  if (aIsDirectory) {
    return comparableB.startsWith(comparableA);
  }

  return comparableA.startsWith(comparableB);
}
