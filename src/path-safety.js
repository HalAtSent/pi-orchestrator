import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { normalizeScopedPath } from "./path-scopes.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertWithinRoot(rootPath, absolutePath, label) {
  const relativePath = normalizeScopedPath(relative(resolve(rootPath), resolve(absolutePath)));
  const outsideRoot = relativePath === ".." || relativePath.startsWith("../");
  assert(!outsideRoot, `${label} resolves outside the expected root`);
}

export async function getPathLstat(pathValue) {
  try {
    return await lstat(pathValue);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function assertPathIsNotSymlink(pathValue, label) {
  const pathStats = await getPathLstat(pathValue);
  if (!pathStats) {
    return;
  }

  if (pathStats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }
}

export async function assertExistingPathHasNoSymlinkSegments(rootPath, pathValue, label) {
  const normalizedRoot = resolve(rootPath);
  const normalizedPath = resolve(pathValue);
  assertWithinRoot(normalizedRoot, normalizedPath, label);

  const relativePath = normalizeScopedPath(relative(normalizedRoot, normalizedPath));
  if (relativePath === "") {
    await assertPathIsNotSymlink(normalizedRoot, label);
    return;
  }

  await assertPathIsNotSymlink(normalizedRoot, label);
  let currentPath = normalizedRoot;
  for (const segment of relativePath.split("/")) {
    currentPath = resolve(currentPath, segment);
    const pathStats = await getPathLstat(currentPath);
    if (!pathStats) {
      return;
    }

    if (pathStats.isSymbolicLink()) {
      throw new Error(`${label} must not contain symlinks`);
    }
  }
}

export async function assertExistingPathRealpathWithinRoot(rootPath, pathValue, label) {
  const pathStats = await getPathLstat(pathValue);
  if (!pathStats) {
    return;
  }

  if (pathStats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }

  const resolvedRoot = await realpath(rootPath);
  const resolvedPath = await realpath(pathValue);
  assertWithinRoot(resolvedRoot, resolvedPath, label);
}

export async function ensureDirectoryNoSymlinkSegments(rootPath, directoryPath, label) {
  const normalizedRoot = resolve(rootPath);
  const normalizedDirectory = resolve(directoryPath);
  const relativeDirectory = normalizeScopedPath(relative(normalizedRoot, normalizedDirectory));
  if (relativeDirectory !== "") {
    await assertExistingPathHasNoSymlinkSegments(normalizedRoot, dirname(normalizedDirectory), label);
  }
  await mkdir(normalizedDirectory, { recursive: true });
  await assertExistingPathHasNoSymlinkSegments(normalizedRoot, normalizedDirectory, label);
  await assertExistingPathRealpathWithinRoot(normalizedRoot, normalizedDirectory, label);
}

export async function assertStoreDirectorySafe(rootPath, storeDirectoryPath, label) {
  const normalizedRoot = resolve(rootPath);
  const normalizedStoreDirectory = resolve(storeDirectoryPath);
  assertWithinRoot(normalizedRoot, normalizedStoreDirectory, label);
  await ensureDirectoryNoSymlinkSegments(normalizedRoot, normalizedStoreDirectory, label);
}
