function assertPathString(pathValue) {
  if (typeof pathValue !== "string") {
    throw new Error("scope path must be a string");
  }
}

function normalizeSlashes(pathValue) {
  assertPathString(pathValue);
  return pathValue.replace(/\\/g, "/");
}

const CASE_INSENSITIVE_PATHS_BY_DEFAULT = process.platform === "win32" || process.platform === "darwin";

function toComparableScopedPath(pathValue) {
  const normalizedPath = normalizeScopedPath(pathValue);
  return CASE_INSENSITIVE_PATHS_BY_DEFAULT ? normalizedPath.toLowerCase() : normalizedPath;
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

export function normalizeRelativeScopePath(pathValue, {
  fieldName = "scope path"
} = {}) {
  const normalizedPath = normalizeScopedPath(pathValue);
  const rawPath = normalizeSlashes(pathValue);
  const rawSegments = rawPath.split("/");
  const segments = normalizedPath.split("/");

  if (normalizedPath.length === 0 || rawPath.trim().length === 0) {
    throw new Error(`${fieldName} must not be empty`);
  }

  if (rawPath.startsWith("/") || /^[A-Za-z]:/u.test(rawPath)) {
    throw new Error(`${fieldName} must be a repository-relative path`);
  }

  if (rawSegments.some((segment) => segment === "..") || segments.some((segment) => segment === "..")) {
    throw new Error(`${fieldName} must not escape the repository root`);
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
