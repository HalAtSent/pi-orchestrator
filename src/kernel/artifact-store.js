import fs from "node:fs";
import path from "node:path";

import { validateWorkOrder } from "./work-order.js";

const INVALID_REPOSITORY_ROOT = "invalid_repository_root";
const REPOSITORY_ROOT_UNAVAILABLE = "repository_root_unavailable";
const INVALID_RUN_ID = "invalid_run_id";
const STORAGE_UNAVAILABLE = "storage_unavailable";
const ARTIFACT_MISSING = "artifact_missing";
const ARTIFACT_UNAVAILABLE = "artifact_unavailable";
const READ_FAILED = "read_failed";
const INVALID_JSON = "invalid_json";

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export function ensureRunStoreDirectory(repositoryRoot, runId) {
  const repositoryRootResult = resolveRepositoryRoot(repositoryRoot);
  if (repositoryRootResult.ok === false) {
    return repositoryRootResult;
  }

  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    return reject(INVALID_RUN_ID);
  }

  const repositoryRootRealpath = repositoryRootResult.repositoryRootRealpath;
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

export function writeWorkOrderArtifact(repositoryRoot, runId, workOrder) {
  const serializedWorkOrderResult = serializeAndValidateWorkOrder(workOrder);
  if (serializedWorkOrderResult.ok === false) {
    return serializedWorkOrderResult.result;
  }

  const { serializedWorkOrder, parsedWorkOrder, validation } = serializedWorkOrderResult;

  if (validation.success === false) {
    return { ok: false, reason: "invalid_work_order", validation };
  }

  const repositoryRootResult = resolveRepositoryRoot(repositoryRoot);
  if (repositoryRootResult.ok === false) {
    return repositoryRootResult;
  }

  const workOrderRepositoryRootResult = resolveRepositoryRoot(parsedWorkOrder.repositoryRoot);
  if (
    workOrderRepositoryRootResult.ok === false ||
    workOrderRepositoryRootResult.repositoryRootRealpath !== repositoryRootResult.repositoryRootRealpath
  ) {
    return { ok: false, reason: "repository_root_mismatch" };
  }

  const storeResult = ensureRunStoreDirectory(repositoryRoot, runId);
  if (storeResult.ok === false) {
    return storeResult;
  }

  const artifactPath = path.join(storeResult.runDirectory, "work-order.json");
  if (lstatOrNull(artifactPath) !== null) {
    return { ok: false, reason: "artifact_exists" };
  }

  try {
    fs.writeFileSync(artifactPath, serializedWorkOrder, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      return { ok: false, reason: "artifact_exists" };
    }

    return { ok: false, reason: "write_failed" };
  }

  return { ok: true, artifactPath, validation };
}

export function loadWorkOrderArtifact(repositoryRoot, runId) {
  const storeResult = resolveExistingRunStoreDirectory(repositoryRoot, runId);
  if (storeResult.ok === false) {
    return storeResult;
  }

  const artifactPath = path.join(storeResult.runDirectory, "work-order.json");
  const artifactStat = lstatOrNull(artifactPath);
  if (artifactStat === null) {
    return reject(ARTIFACT_MISSING);
  }

  if (artifactStat.isSymbolicLink() || !artifactStat.isFile()) {
    return reject(ARTIFACT_UNAVAILABLE);
  }

  const readResult = readPlainFileNoFollow(artifactPath);
  if (readResult.ok === false) {
    return reject(readResult.reason);
  }

  let workOrder;
  try {
    workOrder = JSON.parse(readResult.bytes);
  } catch {
    return reject(INVALID_JSON);
  }

  const validation = validateWorkOrder(workOrder);
  if (validation.success === false) {
    return { ok: false, reason: "invalid_work_order", validation };
  }

  const workOrderRepositoryRootResult = resolveRepositoryRoot(workOrder.repositoryRoot);
  if (
    workOrderRepositoryRootResult.ok === false ||
    workOrderRepositoryRootResult.repositoryRootRealpath !== storeResult.repositoryRootRealpath
  ) {
    return { ok: false, reason: "repository_root_mismatch" };
  }

  return { ok: true, artifactPath, workOrder, validation };
}

function serializeAndValidateWorkOrder(workOrder) {
  let serializedWorkOrder;
  try {
    serializedWorkOrder = JSON.stringify(workOrder, null, 2);
  } catch {
    return invalidSerializedWorkOrder();
  }

  if (typeof serializedWorkOrder !== "string") {
    return invalidSerializedWorkOrder();
  }

  let parsedWorkOrder;
  try {
    parsedWorkOrder = JSON.parse(serializedWorkOrder);
  } catch {
    return invalidSerializedWorkOrder();
  }

  return {
    ok: true,
    serializedWorkOrder,
    parsedWorkOrder,
    validation: validateWorkOrder(parsedWorkOrder),
  };
}

function invalidSerializedWorkOrder() {
  return {
    ok: false,
    result: {
      ok: false,
      reason: "invalid_work_order",
      validation: validateWorkOrder(null),
    },
  };
}

function readPlainFileNoFollow(artifactPath) {
  let fd;
  try {
    fd = fs.openSync(artifactPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (fs.fstatSync(fd).isFile() === false) {
      return reject(ARTIFACT_UNAVAILABLE);
    }

    return { ok: true, bytes: fs.readFileSync(fd, "utf8") };
  } catch (error) {
    if (error?.code === "ELOOP") {
      return reject(ARTIFACT_UNAVAILABLE);
    }

    return reject(READ_FAILED);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The artifact load already failed or succeeded; close errors do not
        // change the persisted artifact contract.
      }
    }
  }
}

function resolveExistingRunStoreDirectory(repositoryRoot, runId) {
  const repositoryRootResult = resolveRepositoryRoot(repositoryRoot);
  if (repositoryRootResult.ok === false) {
    return repositoryRootResult;
  }

  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    return reject(INVALID_RUN_ID);
  }

  const repositoryRootRealpath = repositoryRootResult.repositoryRootRealpath;
  const piDirectory = path.join(repositoryRootRealpath, ".pi");
  const runsDirectory = path.join(piDirectory, "runs");
  const runDirectory = path.join(runsDirectory, runId);

  if (verifyStorageChain([piDirectory, runsDirectory, runDirectory], repositoryRootRealpath) === false) {
    return reject(STORAGE_UNAVAILABLE);
  }

  return { ok: true, runDirectory, repositoryRootRealpath };
}

function resolveRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.trim() === "" || !path.isAbsolute(repositoryRoot)) {
    return reject(INVALID_REPOSITORY_ROOT);
  }

  const repositoryRootRealpath = realpathOrNull(repositoryRoot);
  if (repositoryRootRealpath === null || !isDirectory(repositoryRootRealpath)) {
    return reject(REPOSITORY_ROOT_UNAVAILABLE);
  }

  return { ok: true, repositoryRootRealpath };
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
