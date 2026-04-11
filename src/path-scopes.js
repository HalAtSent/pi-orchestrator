function normalizeSlashes(pathValue) {
  return String(pathValue).replace(/\\/g, "/");
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

  if (isDirectoryScope(normalizedScopeEntry)) {
    return normalizedChangedPath.startsWith(normalizedScopeEntry);
  }

  return normalizedChangedPath === normalizedScopeEntry;
}

export function scopesOverlap(a, b) {
  const normalizedA = normalizeScopedPath(a);
  const normalizedB = normalizeScopedPath(b);
  const aIsDirectory = isDirectoryScope(normalizedA);
  const bIsDirectory = isDirectoryScope(normalizedB);

  if (!aIsDirectory && !bIsDirectory) {
    return normalizedA === normalizedB;
  }

  if (aIsDirectory && bIsDirectory) {
    return normalizedA.startsWith(normalizedB) || normalizedB.startsWith(normalizedA);
  }

  if (aIsDirectory) {
    return normalizedB.startsWith(normalizedA);
  }

  return normalizedA.startsWith(normalizedB);
}
