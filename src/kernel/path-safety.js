const INVALID_TYPE = "invalid_type";
const EMPTY_PATH = "empty_path";
const ABSOLUTE_PATH = "absolute_path";
const URL_LIKE_PATH = "url_like_path";
const BACKSLASH_PATH = "backslash_path";
const PATH_TRAVERSAL = "path_traversal";
const ROOT_PATH = "root_path";

const DRIVE_QUALIFIED_PATTERN = /^[A-Za-z]:/;
const URL_LIKE_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function normalizeRepoRelativePath(pathValue) {
  if (typeof pathValue !== "string") {
    return reject(INVALID_TYPE);
  }

  if (pathValue.trim() === "") {
    return reject(EMPTY_PATH);
  }

  if (DRIVE_QUALIFIED_PATTERN.test(pathValue)) {
    return reject(ABSOLUTE_PATH);
  }

  if (pathValue.startsWith("/")) {
    return reject(ABSOLUTE_PATH);
  }

  if (URL_LIKE_PATTERN.test(pathValue)) {
    return reject(URL_LIKE_PATH);
  }

  if (pathValue.includes("\\")) {
    return reject(BACKSLASH_PATH);
  }

  const segments = pathValue.split("/");
  if (segments.includes("..")) {
    return reject(PATH_TRAVERSAL);
  }

  const normalizedSegments = segments.filter((segment) => segment !== "" && segment !== ".");
  if (normalizedSegments.length === 0) {
    return reject(ROOT_PATH);
  }

  for (const segment of normalizedSegments) {
    if (DRIVE_QUALIFIED_PATTERN.test(segment)) {
      return reject(ABSOLUTE_PATH);
    }

    if (URL_LIKE_PATTERN.test(segment)) {
      return reject(URL_LIKE_PATH);
    }
  }

  const normalizedPath = normalizedSegments.join("/");
  if (DRIVE_QUALIFIED_PATTERN.test(normalizedPath)) {
    return reject(ABSOLUTE_PATH);
  }

  if (URL_LIKE_PATTERN.test(normalizedPath)) {
    return reject(URL_LIKE_PATH);
  }

  if (pathValue.endsWith("/")) {
    return { ok: true, path: `${normalizedPath}/` };
  }

  return { ok: true, path: normalizedPath };
}

function reject(reason) {
  return { ok: false, reason };
}
