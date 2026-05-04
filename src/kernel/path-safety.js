const INVALID_TYPE = "invalid_type";
const EMPTY_PATH = "empty_path";
const ABSOLUTE_PATH = "absolute_path";
const URL_LIKE_PATH = "url_like_path";
const BACKSLASH_PATH = "backslash_path";
const PATH_TRAVERSAL = "path_traversal";
const ROOT_PATH = "root_path";

const DRIVE_QUALIFIED_PATTERN = /^[A-Za-z]:/;
const URL_LIKE_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const PROTECTED_DIRECTORY_REASONS = new Map([
  [".git", "git"],
  [".pi", "pi_runtime"],
  ["node_modules", "dependency"],
  ["vendor", "dependency"],
  [".venv", "dependency"],
  ["dist", "build_output"],
  ["build", "build_output"],
  ["coverage", "build_output"],
  [".next", "build_output"],
]);
const PROTECTED_SECRET_BASENAMES = new Set([".npmrc", ".pypirc", ".netrc", "credentials.json"]);
const PROTECTED_SECRET_SEGMENT_PAIRS = [
  [".aws", "credentials"],
  [".ssh", "id_rsa"],
];

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

export function isProtectedRepoPath(pathValue) {
  if (typeof pathValue !== "string") {
    return protectedReject();
  }

  if (pathValue.trim() === "") {
    return protectedReject();
  }

  if (DRIVE_QUALIFIED_PATTERN.test(pathValue)) {
    return protectedReject();
  }

  if (pathValue.startsWith("/")) {
    return protectedReject();
  }

  if (URL_LIKE_PATTERN.test(pathValue)) {
    return protectedReject();
  }

  if (pathValue.includes("\\") || pathValue.includes("//")) {
    return protectedReject();
  }

  const segments = pathValue.split("/");
  if (segments.length === 0 || segments.includes(".") || segments.includes("..")) {
    return protectedReject();
  }

  if (segments.at(-1) === "") {
    segments.pop();
  }

  if (segments.length === 0 || segments.includes("")) {
    return protectedReject();
  }

  for (const segment of segments) {
    if (DRIVE_QUALIFIED_PATTERN.test(segment) || URL_LIKE_PATTERN.test(segment)) {
      return protectedReject();
    }

    const reason = PROTECTED_DIRECTORY_REASONS.get(segment.toLowerCase());
    if (reason !== undefined) {
      return { protected: true, reason };
    }
  }

  const basename = segments.at(-1);
  const normalizedBasename = basename.toLowerCase();
  if (PROTECTED_SECRET_BASENAMES.has(normalizedBasename) || hasProtectedSegmentPair(segments)) {
    return { protected: true, reason: "secret" };
  }

  if (
    normalizedBasename === ".env" ||
    normalizedBasename.startsWith(".env.") ||
    normalizedBasename.endsWith(".pem") ||
    normalizedBasename.endsWith(".key")
  ) {
    return { protected: true, reason: "secret" };
  }

  return { protected: false };
}

export function repoPathCovers(scopePath, candidatePath) {
  if (!isNormalizedRepoRelativePath(scopePath) || !isNormalizedRepoRelativePath(candidatePath)) {
    return { ok: false, reason: "invalid_input" };
  }

  if (scopePath === candidatePath) {
    return { ok: true, covered: true, relation: "exact" };
  }

  if (scopePath.endsWith("/") && candidatePath.startsWith(scopePath)) {
    return { ok: true, covered: true, relation: "descendant" };
  }

  return { ok: true, covered: false };
}

function reject(reason) {
  return { ok: false, reason };
}

function protectedReject() {
  return { protected: false, reason: "invalid_input" };
}

function isNormalizedRepoRelativePath(pathValue) {
  const result = normalizeRepoRelativePath(pathValue);
  return result.ok === true && result.path === pathValue;
}

function hasProtectedSegmentPair(segments) {
  return PROTECTED_SECRET_SEGMENT_PAIRS.some(([parentSegment, childSegment]) =>
    segments.some(
      (segment, index) =>
        segment.toLowerCase() === parentSegment && segments[index + 1]?.toLowerCase() === childSegment,
    ),
  );
}
