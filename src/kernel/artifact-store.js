import fs from "node:fs";
import path from "node:path";

const INVALID_REPOSITORY_ROOT = "invalid_repository_root";
const REPOSITORY_ROOT_UNAVAILABLE = "repository_root_unavailable";
const INVALID_RUN_ID = "invalid_run_id";
const STORAGE_UNAVAILABLE = "storage_unavailable";

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export function ensureRunStoreDirectory(repositoryRoot, runId) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.trim() === "" || !path.isAbsolute(repositoryRoot)) {
    return reject(INVALID_REPOSITORY_ROOT);
  }

  const repositoryRootRealpath = realpathOrNull(repositoryRoot);
  if (repositoryRootRealpath === null || !isDirectory(repositoryRootRealpath)) {
    return reject(REPOSITORY_ROOT_UNAVAILABLE);
  }

  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    return reject(INVALID_RUN_ID);
  }

  const piDirectory = path.join(repositoryRootRealpath, ".pi");
  const runsDirectory = path.join(piDirectory, "runs");
  const runDirectory = path.join(runsDirectory, runId);

  if (ensureDetectedPlainDirectory(piDirectory, repositoryRootRealpath) === false) {
    return reject(STORAGE_UNAVAILABLE);
  }

  if (ensureDetectedPlainDirectory(runsDirectory, repositoryRootRealpath, [piDirectory]) === false) {
    return reject(STORAGE_UNAVAILABLE);
  }

  if (ensureDetectedPlainDirectory(runDirectory, repositoryRootRealpath, [piDirectory, runsDirectory]) === false) {
    return reject(STORAGE_UNAVAILABLE);
  }

  if (verifyStorageChain([piDirectory, runsDirectory, runDirectory], repositoryRootRealpath) === false) {
    return reject(STORAGE_UNAVAILABLE);
  }

  return { ok: true, runDirectory };
}

function ensureDetectedPlainDirectory(pathValue, repositoryRootRealpath, parentDirectories = []) {
  if (verifyStorageChain(parentDirectories, repositoryRootRealpath) === false) {
    return false;
  }

  const before = lstatOrNull(pathValue);
  if (before !== null) {
    return isPlainContainedDirectory(pathValue, repositoryRootRealpath);
  }

  if (verifyStorageChain(parentDirectories, repositoryRootRealpath) === false) {
    return false;
  }

  if (verifyImmediateParent(pathValue, repositoryRootRealpath) === false) {
    return false;
  }

  // This portable path-based helper is limited to detected guarantees:
  // pre-existing bad storage shapes, test-visible parent swaps before mkdir,
  // and post-create containment failures. It is not an fd-anchored/no-follow
  // primitive and does not prove atomic no-outside-mkdir protection against an
  // external parent swap during final path resolution.
  try {
    fs.mkdirSync(pathValue);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      return false;
    }
  }

  return isPlainContainedDirectory(pathValue, repositoryRootRealpath);
}

function verifyStorageChain(pathValues, repositoryRootRealpath) {
  return pathValues.every((pathValue) => isPlainContainedDirectory(pathValue, repositoryRootRealpath));
}

function verifyImmediateParent(pathValue, repositoryRootRealpath) {
  const parentDirectory = path.dirname(pathValue);
  return parentDirectory === repositoryRootRealpath || isPlainContainedDirectory(parentDirectory, repositoryRootRealpath);
}

function isPlainContainedDirectory(pathValue, repositoryRootRealpath) {
  const stat = lstatOrNull(pathValue);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
    return false;
  }

  const pathRealpath = realpathOrNull(pathValue);
  return pathRealpath !== null && isContainedPath(repositoryRootRealpath, pathRealpath);
}

function isContainedPath(parentRealpath, childRealpath) {
  const relativePath = path.relative(parentRealpath, childRealpath);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function reject(reason) {
  return { ok: false, reason };
}

function realpathOrNull(pathValue) {
  try {
    return fs.realpathSync(pathValue);
  } catch {
    return null;
  }
}

function lstatOrNull(pathValue) {
  try {
    return fs.lstatSync(pathValue);
  } catch {
    return null;
  }
}

function isDirectory(pathValue) {
  try {
    return fs.statSync(pathValue).isDirectory();
  } catch {
    return false;
  }
}
