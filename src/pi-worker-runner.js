import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { createWorkerResult, validateTaskPacket } from "./contracts.js";
import { assertExistingPathHasNoSymlinkSegments, getPathLstat } from "./path-safety.js";
import { isPathWithinScope, normalizeScopedPath, scopesOverlap } from "./path-scopes.js";
import { findProtectedPacketPaths } from "./policies.js";
import { safeClone } from "./safe-clone.js";
import {
  getTrustedForwardedRedactionMetadata,
  getTrustedRuntimeRepositoryRoot,
  resolvePacketContextManifest,
  setTrustedForwardedRedactionMetadata,
  setTrustedRuntimeRepositoryRoot,
  validateRunContext
} from "./context-manifest.js";
import { sanitizeWorkerResultForBoundary } from "./worker-result-redaction.js";

const READ_ONLY_ACCESS = "read_only";
const WRITE_ACCESS = "write";
const DEFAULT_PI_PROVIDER = "openai-codex";
const DEFAULT_PI_MODEL_FALLBACKS = Object.freeze(["gpt-5.4", "gpt-5.3-codex"]);
const SNAPSHOT_DIRECTORY_BATCH_SIZE = 64;

export const DEFAULT_PI_ROLE_PROFILES = Object.freeze({
  explorer: Object.freeze({
    provider: DEFAULT_PI_PROVIDER,
    access: READ_ONLY_ACCESS,
    model: "gpt-5.5",
    thinking: "high",
    reasoningEffort: "high",
    objective: "Map code and constraints without editing files."
  }),
  implementer: Object.freeze({
    provider: DEFAULT_PI_PROVIDER,
    access: WRITE_ACCESS,
    model: "gpt-5.5",
    thinking: "medium",
    reasoningEffort: "medium",
    objective: "Deliver scoped code changes within the file allowlist."
  }),
  reviewer: Object.freeze({
    provider: DEFAULT_PI_PROVIDER,
    access: READ_ONLY_ACCESS,
    model: "gpt-5.5",
    thinking: "high",
    reasoningEffort: "high",
    objective: "Provide independent read-only review findings."
  }),
  verifier: Object.freeze({
    provider: DEFAULT_PI_PROVIDER,
    access: READ_ONLY_ACCESS,
    model: "gpt-5.5",
    thinking: "medium",
    reasoningEffort: "medium",
    objective: "Collect targeted verification evidence only."
  })
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function clone(value) {
  return safeClone(value);
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeFileList(files = []) {
  return unique(files.map((path) => normalizeScopedPath(path)));
}

async function visitDirectoryEntriesInBatches(entries, visitEntry) {
  for (let index = 0; index < entries.length; index += SNAPSHOT_DIRECTORY_BATCH_SIZE) {
    await Promise.all(entries.slice(index, index + SNAPSHOT_DIRECTORY_BATCH_SIZE).map(visitEntry));
  }
}

function normalizePacket(packet) {
  const normalized = validateTaskPacket(clone(packet));
  normalized.allowedFiles = normalizeFileList(normalized.allowedFiles);
  normalized.forbiddenFiles = normalizeFileList(normalized.forbiddenFiles);
  normalized.contextFiles = normalizeFileList(normalized.contextFiles ?? []);
  normalized.contextManifest = resolvePacketContextManifest({
    contextFiles: normalized.contextFiles,
    contextManifest: normalized.contextManifest,
    contextFilesFieldName: "packet.contextFiles",
    contextManifestFieldName: "packet.contextManifest"
  });
  normalized.commands = Array.isArray(normalized.commands) ? [...normalized.commands] : [];
  return normalized;
}

function hasStructuredRuntimeContextFields(context = {}) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(context, "contextManifest")
    || Object.prototype.hasOwnProperty.call(context, "priorResults")
    || Object.prototype.hasOwnProperty.call(context, "reviewResult")
    || Object.prototype.hasOwnProperty.call(context, "changedSurfaceContext")
    || Object.prototype.hasOwnProperty.call(context, "contextBudget");
}

function resolveRuntimeRepositoryRoot({
  context
} = {}) {
  return getTrustedRuntimeRepositoryRoot(context);
}

function normalizeRuntimeContext(packet, context = {}) {
  const trustedForwardedRedactionMetadata = getTrustedForwardedRedactionMetadata(context);
  const runtimeRepositoryRoot = resolveRuntimeRepositoryRoot({
    context
  });
  const normalizedContext = context && typeof context === "object" && !Array.isArray(context)
    ? clone(context)
    : {};

  if (!hasStructuredRuntimeContextFields(normalizedContext)) {
    if (trustedForwardedRedactionMetadata !== undefined) {
      setTrustedForwardedRedactionMetadata(normalizedContext, trustedForwardedRedactionMetadata);
    }
    setTrustedRuntimeRepositoryRoot(normalizedContext, runtimeRepositoryRoot, {
      fieldName: "context.repositoryRoot"
    });
    return normalizedContext;
  }

  const normalizedRunContext = validateRunContext({
    packetContextFiles: packet.contextFiles,
    contextManifest: normalizedContext.contextManifest,
    priorResults: normalizedContext.priorResults ?? [],
    reviewResult: normalizedContext.reviewResult ?? null,
    changedSurfaceContext: normalizedContext.changedSurfaceContext ?? [],
    contextBudget: normalizedContext.contextBudget,
    forwardedRedactionMetadata: trustedForwardedRedactionMetadata,
    repositoryRoot: runtimeRepositoryRoot,
    fieldName: "context"
  });

  normalizedContext.contextManifest = normalizedRunContext.contextManifest;
  if (
    normalizedRunContext.contextBudget !== undefined
    || Object.prototype.hasOwnProperty.call(normalizedContext, "contextBudget")
  ) {
    normalizedContext.contextBudget = normalizedRunContext.contextBudget ?? normalizedContext.contextBudget;
  }
  if (trustedForwardedRedactionMetadata !== undefined) {
    setTrustedForwardedRedactionMetadata(normalizedContext, trustedForwardedRedactionMetadata);
  }
  setTrustedRuntimeRepositoryRoot(normalizedContext, runtimeRepositoryRoot, {
    fieldName: "context.repositoryRoot"
  });

  return normalizedContext;
}

function createBlockedResult({ role, summary, evidence = [], openQuestions = [] }) {
  return createWorkerResult({
    status: "blocked",
    summary: `${role} worker blocked: ${summary}`,
    changedFiles: [],
    commandsRun: [],
    evidence,
    openQuestions
  });
}

function createFailedResult({ role, summary, evidence = [], openQuestions = [] }) {
  return createWorkerResult({
    status: "failed",
    summary: `${role} worker failed: ${summary}`,
    changedFiles: [],
    commandsRun: [],
    evidence,
    openQuestions
  });
}

function normalizeRoleProfiles(roleProfiles, {
  allowFallbacks = false
} = {}) {
  assert(roleProfiles && typeof roleProfiles === "object", "roleProfiles must be an object");

  const normalized = {};
  for (const [role, profile] of Object.entries(roleProfiles)) {
    assert(profile && typeof profile === "object", `role profile for ${role} must be an object`);

    const access = profile.access === WRITE_ACCESS
      ? WRITE_ACCESS
      : profile.access === READ_ONLY_ACCESS
        ? READ_ONLY_ACCESS
        : allowFallbacks
          ? READ_ONLY_ACCESS
          : null;
    const provider = typeof profile.provider === "string" && profile.provider.trim().length > 0
      ? profile.provider.trim()
      : allowFallbacks
        ? DEFAULT_PI_PROVIDER
        : null;
    const model = typeof profile.model === "string" && profile.model.trim().length > 0
      ? profile.model.trim()
      : null;
    const thinking = typeof profile.thinking === "string" && profile.thinking.trim().length > 0
      ? profile.thinking.trim()
      : typeof profile.reasoningEffort === "string" && profile.reasoningEffort.trim().length > 0
        ? profile.reasoningEffort.trim()
        : allowFallbacks
          ? "medium"
          : null;

    assert(access, `role profile for ${role} must include access`);
    assert(provider, `role profile for ${role} must include provider`);
    assert(model, `role profile for ${role} must include model`);
    assert(thinking, `role profile for ${role} must include thinking or reasoningEffort`);

    normalized[role] = Object.freeze({
      ...clone(profile),
      access,
      provider,
      model,
      thinking,
      reasoningEffort: typeof profile.reasoningEffort === "string" && profile.reasoningEffort.trim().length > 0
        ? profile.reasoningEffort.trim()
        : thinking
    });
  }

  return Object.freeze(normalized);
}

function normalizeModelFallbacks(modelFallbacks) {
  assert(Array.isArray(modelFallbacks), "modelFallbacks must be an array");
  return unique(
    modelFallbacks
      .map((model) => String(model).trim())
      .filter((model) => model.length > 0)
  );
}

function extractSupportedModels(probeResult) {
  return Array.isArray(probeResult?.supportedModels)
    ? unique(
      probeResult.supportedModels
        .map((model) => String(model).trim())
        .filter((model) => model.length > 0)
    )
    : [];
}

async function resolveRoleProfileModel({
  role,
  roleProfile,
  modelProbe,
  modelFallbacks,
  context
}) {
  const requestedProvider = roleProfile.provider;
  const requestedModel = roleProfile.model;

  if (typeof modelProbe !== "function") {
    return {
      ok: true,
      roleProfile,
      evidence: [
        `requested_provider: ${requestedProvider}`,
        `requested_model: ${requestedModel}`,
        `selected_provider: ${requestedProvider}`,
        `selected_model: ${requestedModel}`,
        "model_selection_mode: unprobed",
        "model_selection_reason: native_pi_model_probe_not_configured"
      ]
    };
  }

  const candidateModels = unique([requestedModel, ...modelFallbacks]);
  const probeResult = await modelProbe({
    providerId: requestedProvider,
    candidateModels,
    role,
    roleProfile: clone(roleProfile),
    context: clone(context)
  });
  const supportedModels = extractSupportedModels(probeResult);
  const supportedModelSet = new Set(supportedModels);
  const selectedModel = supportedModelSet.has(requestedModel)
    ? requestedModel
    : modelFallbacks.find((fallbackModel) => supportedModelSet.has(fallbackModel)) ?? null;

  const baseEvidence = [
    `requested_provider: ${requestedProvider}`,
    `requested_model: ${requestedModel}`,
    `supported_provider_models: ${supportedModels.length === 0 ? "none" : supportedModels.join(", ")}`
  ];

  if (selectedModel) {
    return {
      ok: true,
      roleProfile: Object.freeze({
        ...clone(roleProfile),
        model: selectedModel
      }),
      evidence: [
        ...baseEvidence,
        `selected_provider: ${requestedProvider}`,
        `selected_model: ${selectedModel}`,
        `model_selection_mode: ${selectedModel === requestedModel ? "direct" : "fallback"}`,
        `model_selection_reason: ${selectedModel === requestedModel ? "preferred_model_supported" : "preferred_model_unavailable"}`
      ]
    };
  }

  return {
    ok: false,
    reason: probeResult?.blockedReason
      ? `model probe failed: ${probeResult.blockedReason}`
      : `provider ${requestedProvider} does not support requested model ${requestedModel} or configured fallbacks`,
    evidence: [
      ...baseEvidence,
      "selected_provider: none",
      "selected_model: none",
      "model_selection_mode: blocked",
      "model_selection_reason: preferred_and_fallback_models_unavailable"
    ]
  };
}

function isWriteRole(roleProfile) {
  return roleProfile.access === WRITE_ACCESS;
}

function resolveObservedExecutionSnapshotScope() {
  return [""];
}

function isRealpathInsideRoot(rootRealpath, candidateRealpath) {
  const relativePath = relative(rootRealpath, candidateRealpath);
  return relativePath === ""
    || (
      !relativePath.startsWith("..")
      && !isAbsolute(relativePath)
    );
}

async function assertRepositorySymlinksResolveInsideRoot(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const rootRealpath = await realpath(root);

  async function visit(relativePath) {
    const absolutePath = resolve(root, relativePath);
    const entries = await readdir(absolutePath, { withFileTypes: true });

    await visitDirectoryEntriesInBatches(entries, async (entry) => {
      const entryRelativePath = relativePath.length > 0
        ? `${relativePath}/${entry.name}`
        : entry.name;
      const entryAbsolutePath = resolve(root, entryRelativePath);

      if (entry.isSymbolicLink()) {
        let targetRealpath;
        try {
          targetRealpath = await realpath(entryAbsolutePath);
        } catch (error) {
          throw new Error(`repository symlink target could not be resolved safely: ${entryRelativePath} (${error.message})`);
        }

        if (!isRealpathInsideRoot(rootRealpath, targetRealpath)) {
          throw new Error(`repository symlink resolves outside the repository: ${entryRelativePath}`);
        }
        return;
      }

      if (entry.isDirectory()) {
        await visit(entryRelativePath);
      }
    });
  }

  await visit("");
}

async function snapshotScopedFiles(repositoryRoot, scopedPaths) {
  const root = resolve(repositoryRoot);
  const snapshot = new Map();

  async function visit(relativePath) {
    const normalizedRelativePath = normalizeScopedPath(relativePath);
    const absolutePath = resolve(root, normalizedRelativePath);
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        snapshot.set(normalizedRelativePath, "missing");
        return;
      }
      throw error;
    }

    if (stats.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      snapshot.set(
        normalizedRelativePath,
        `symlink:${stats.size}:${stats.mode}:${stats.uid}:${stats.gid}:${stats.mtimeMs}:${stats.ctimeMs}:${target}`
      );
      return;
    }

    if (stats.isDirectory()) {
      snapshot.set(normalizedRelativePath.endsWith("/") ? normalizedRelativePath : `${normalizedRelativePath}/`, "directory");
      const entries = await readdir(absolutePath, { withFileTypes: true });
      await visitDirectoryEntriesInBatches(entries, async (entry) => {
        const directoryPrefix = normalizedRelativePath.replace(/\/$/u, "");
        await visit(directoryPrefix.length > 0 ? `${directoryPrefix}/${entry.name}` : entry.name);
      });
      return;
    }

    if (!stats.isFile()) {
      snapshot.set(normalizedRelativePath, `special:${stats.size}:${stats.mtimeMs}`);
      return;
    }

    const content = await readFile(absolutePath);
    const digest = createHash("sha256").update(content).digest("hex");
    snapshot.set(normalizedRelativePath, `file:${stats.size}:${digest}`);
  }

  for (const scopedPath of normalizeFileList(scopedPaths)) {
    await visit(scopedPath);
  }

  return snapshot;
}

function diffScopedSnapshots(beforeSnapshot, afterSnapshot) {
  const changed = [];
  const paths = unique([...beforeSnapshot.keys(), ...afterSnapshot.keys()]).sort();
  for (const path of paths) {
    if (beforeSnapshot.get(path) !== afterSnapshot.get(path)) {
      changed.push(path);
    }
  }
  return changed;
}

function assertObservedWritePolicy({ packet, roleProfile, observedChangedFiles }) {
  if (observedChangedFiles.length === 0) {
    return;
  }

  if (!isWriteRole(roleProfile)) {
    throw new Error(`${packet.role} is read-only and modified repository file(s): ${observedChangedFiles.join(", ")}`);
  }

  const outsideAllowedScope = [];
  const forbiddenScopeChanges = [];
  for (const changedFile of observedChangedFiles) {
    const withinAllowedScope = packet.allowedFiles.some((scopeEntry) => isPathWithinScope(changedFile, scopeEntry));
    const withinForbiddenScope = packet.forbiddenFiles.some((scopeEntry) => isPathWithinScope(changedFile, scopeEntry));
    if (!withinAllowedScope) {
      outsideAllowedScope.push(changedFile);
    }
    if (withinForbiddenScope) {
      forbiddenScopeChanges.push(changedFile);
    }
  }

  if (outsideAllowedScope.length > 0) {
    throw new Error(`${packet.role} modified file(s) outside its allowlist: ${outsideAllowedScope.join(", ")}`);
  }

  if (forbiddenScopeChanges.length > 0) {
    throw new Error(`${packet.role} modified forbidden file(s): ${forbiddenScopeChanges.join(", ")}`);
  }
}

async function assertObservedChangedFilesSafe({ repositoryRoot, observedChangedFiles }) {
  const root = resolve(repositoryRoot);
  for (const changedFile of observedChangedFiles) {
    const absolutePath = resolve(root, changedFile);
    await assertExistingPathHasNoSymlinkSegments(root, absolutePath, `observed changed file ${changedFile}`);
    const stats = await getPathLstat(absolutePath);
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`observed changed file must not be a symlink: ${changedFile}`);
    }
    if (stats.isFile() && Number.isInteger(stats.nlink) && stats.nlink > 1) {
      throw new Error(`observed changed file must not be hardlinked to multiple directory entries: ${changedFile}`);
    }
  }
}

function assertReportedChangedFilesWithinPolicy({ packet, roleProfile, reportedChangedFiles }) {
  const normalizedChangedFiles = normalizeFileList(reportedChangedFiles);
  if (!isWriteRole(roleProfile) || normalizedChangedFiles.length === 0) {
    return normalizedChangedFiles;
  }

  for (const changedFile of normalizedChangedFiles) {
    const withinAllowedScope = packet.allowedFiles.some((scopeEntry) => isPathWithinScope(changedFile, scopeEntry));
    const withinForbiddenScope = packet.forbiddenFiles.some((scopeEntry) => isPathWithinScope(changedFile, scopeEntry));
    assert(withinAllowedScope, `${packet.role} reported a file outside its allowlist: ${changedFile}`);
    assert(!withinForbiddenScope, `${packet.role} reported a forbidden file: ${changedFile}`);
  }

  return normalizedChangedFiles;
}

function formatChangedFileSet(values) {
  return values.length > 0 ? values.join(", ") : "none";
}

function createReportedObservedChangedFilesMismatchEvidence({
  reportedChangedFiles,
  observedChangedFiles
}) {
  const reportedSet = new Set(reportedChangedFiles);
  const observedSet = new Set(observedChangedFiles);
  const missingFromReport = observedChangedFiles.filter((file) => !reportedSet.has(file));
  const unobservedReported = reportedChangedFiles.filter((file) => !observedSet.has(file));

  if (missingFromReport.length === 0 && unobservedReported.length === 0) {
    return [];
  }

  return [
    `reported_changed_files_mismatch: reported=${formatChangedFileSet(reportedChangedFiles)} observed=${formatChangedFileSet(observedChangedFiles)}`,
    ...(missingFromReport.length > 0
      ? [`reported_changed_files_missing_observed: ${missingFromReport.join(", ")}`]
      : []),
    ...(unobservedReported.length > 0
      ? [`reported_changed_files_unobserved: ${unobservedReported.join(", ")}`]
      : [])
  ];
}

function validateResultWritePolicy({ packet, roleProfile, workerResult }) {
  const normalizedChangedFiles = normalizeFileList(workerResult.changedFiles);
  const allowedScopes = packet.allowedFiles;
  const forbiddenScopes = packet.forbiddenFiles;

  if (!isWriteRole(roleProfile) && normalizedChangedFiles.length > 0) {
    throw new Error(`${packet.role} is read-only and must not report changed files`);
  }

  for (const changedFile of normalizedChangedFiles) {
    const withinAllowedScope = allowedScopes.some((scopeEntry) => isPathWithinScope(changedFile, scopeEntry));
    const withinForbiddenScope = forbiddenScopes.some((scopeEntry) => isPathWithinScope(changedFile, scopeEntry));
    assert(withinAllowedScope, `${packet.role} reported a file outside its allowlist: ${changedFile}`);
    assert(!withinForbiddenScope, `${packet.role} reported a forbidden file: ${changedFile}`);
  }

  return createWorkerResult({
    ...workerResult,
    changedFiles: normalizedChangedFiles
  });
}

function buildWorkerRequest({ packet, context, roleProfile, runId }) {
  return {
    runId,
    role: packet.role,
    goal: packet.goal,
    allowedFiles: [...packet.allowedFiles],
    forbiddenFiles: [...packet.forbiddenFiles],
    contextFiles: [...packet.contextFiles],
    contextManifest: clone(packet.contextManifest),
    acceptanceChecks: [...packet.acceptanceChecks],
    stopConditions: [...packet.stopConditions],
    commands: [...packet.commands],
    modelProfile: clone(roleProfile),
    controls: {
      noRecursiveDelegation: true,
      taskScoped: true,
      ephemeral: true,
      writePolicy: isWriteRole(roleProfile) ? "allowlist_only" : "read_only"
    },
    context: clone(context)
  };
}

function extractWorkerResult(adapterResponse) {
  if (adapterResponse && typeof adapterResponse === "object" && !Array.isArray(adapterResponse) && adapterResponse.result) {
    return adapterResponse.result;
  }

  return adapterResponse;
}

function assertNoRecursiveDelegation(adapterResponse) {
  if (!adapterResponse || typeof adapterResponse !== "object" || Array.isArray(adapterResponse)) {
    return;
  }

  const delegated = adapterResponse.delegated === true
    || (Number.isInteger(adapterResponse.delegationCount) && adapterResponse.delegationCount > 0)
    || (Number.isInteger(adapterResponse.spawnedWorkers) && adapterResponse.spawnedWorkers > 0);

  assert(!delegated, "worker attempted recursive delegation");
}

async function assertPacketExecutionPathsHaveNoSymlinks({ repositoryRoot, packet }) {
  const scopedPaths = normalizeFileList([
    ...packet.allowedFiles,
    ...packet.forbiddenFiles,
    ...packet.contextFiles
  ]);

  await Promise.all(scopedPaths.map(async (scopedPath) => {
    await assertExistingPathHasNoSymlinkSegments(
      repositoryRoot,
      resolve(repositoryRoot, scopedPath),
      `packet path ${scopedPath}`
    );
  }));
}

export function createFileClaimRegistry() {
  const claims = new Map();

  return {
    claimMany(files, owner) {
      assert(typeof owner === "string" && owner.trim().length > 0, "claim owner must be a non-empty string");

      const normalizedFiles = normalizeFileList(files);
      const normalizedOwner = owner.trim();
      const conflicts = [];

      for (const file of normalizedFiles) {
        for (const [claimedScope, existingOwner] of claims.entries()) {
          if (existingOwner === normalizedOwner) {
            continue;
          }

          if (scopesOverlap(file, claimedScope)) {
            conflicts.push({
              file: claimedScope,
              owner: existingOwner
            });
          }
        }
      }

      if (conflicts.length > 0) {
        return {
          ok: false,
          owner: normalizedOwner,
          files: normalizedFiles,
          conflicts
        };
      }

      for (const file of normalizedFiles) {
        claims.set(file, normalizedOwner);
      }

      return {
        ok: true,
        owner: normalizedOwner,
        files: normalizedFiles,
        conflicts: []
      };
    },

    release(owner) {
      if (typeof owner !== "string" || owner.trim().length === 0) {
        return 0;
      }

      const normalizedOwner = owner.trim();
      let releasedCount = 0;

      for (const [file, fileOwner] of claims.entries()) {
        if (fileOwner === normalizedOwner) {
          claims.delete(file);
          releasedCount += 1;
        }
      }

      return releasedCount;
    },

    getOwner(file) {
      const normalizedFile = normalizeScopedPath(file);
      for (const [claimedScope, owner] of claims.entries()) {
        if (scopesOverlap(normalizedFile, claimedScope)) {
          return owner;
        }
      }

      return null;
    },

    snapshot() {
      return [...claims.entries()].map(([file, owner]) => ({ file, owner }));
    }
  };
}

export function createPiWorkerRunner({
  adapter,
  claimRegistry = createFileClaimRegistry(),
  roleProfiles = DEFAULT_PI_ROLE_PROFILES,
  allowRoleProfileFallbacks = false,
  modelProbe = null,
  modelFallbacks = DEFAULT_PI_MODEL_FALLBACKS
} = {}) {
  assert(adapter && typeof adapter.runWorker === "function", "adapter.runWorker(request, context) is required");
  assert(claimRegistry && typeof claimRegistry.claimMany === "function", "claimRegistry.claimMany(files, owner) is required");
  assert(typeof claimRegistry.release === "function", "claimRegistry.release(owner) is required");

  const normalizedRoleProfiles = normalizeRoleProfiles(roleProfiles, {
    allowFallbacks: allowRoleProfileFallbacks
  });
  const normalizedModelFallbacks = normalizeModelFallbacks(modelFallbacks);
  const calls = [];
  let runCounter = 0;

  return {
    async run(packetInput, context = {}) {
      let boundaryRepositoryRoot = process.cwd();
      const finalizeResult = (result) => sanitizeWorkerResultForBoundary(result, {
        repositoryRoot: boundaryRepositoryRoot,
        mergeExistingRedaction: true
      });
      let packet;
      try {
        packet = normalizePacket(packetInput);
      } catch (error) {
        const role = typeof packetInput?.role === "string" && packetInput.role.trim().length > 0
          ? packetInput.role.trim()
          : "unknown";
        return finalizeResult(createBlockedResult({
          role,
          summary: `invalid task packet (${error.message})`,
          evidence: ["packet validation failed before worker launch"],
          openQuestions: [
            "Provide a valid task packet before launching a Pi worker."
          ]
        }));
      }

      const protectedPacketPaths = findProtectedPacketPaths(packet);
      if (protectedPacketPaths.length > 0) {
        return finalizeResult(createBlockedResult({
          role: packet.role,
          summary: `packet references protected path(s): ${protectedPacketPaths.join(", ")}`,
          evidence: [
            "protected packet paths are blocked before worker launch",
            `protected paths: ${protectedPacketPaths.join(", ")}`
          ],
          openQuestions: [
            "Narrow the packet scope to repository files outside protected harness, dependency, build, coverage, and secret paths."
          ]
        }));
      }

      const roleProfile = normalizedRoleProfiles[packet.role];

      if (!roleProfile) {
        return finalizeResult(createBlockedResult({
          role: packet.role,
          summary: "no Pi role profile is configured for this worker role",
          openQuestions: [
            `Configure a Pi role profile for ${packet.role} before re-running.`
          ]
        }));
      }

      let runtimeContext;
      try {
        runtimeContext = normalizeRuntimeContext(packet, context);
      } catch (error) {
        return finalizeResult(createFailedResult({
          role: packet.role,
          summary: error.message,
          openQuestions: [
            "Ensure runtime context payloads match contextManifest[] before worker execution."
          ]
        }));
      }

      const runId = `${packet.id}:${packet.role}:${runCounter + 1}`;
      runCounter += 1;

      const writeFiles = isWriteRole(roleProfile) ? packet.allowedFiles : [];
      const claimOwner = isWriteRole(roleProfile) ? runId : null;

      if (claimOwner && writeFiles.length > 0) {
        const claimResult = claimRegistry.claimMany(writeFiles, claimOwner);

        if (!claimResult.ok) {
          const blockedFiles = claimResult.conflicts.map((conflict) => `${conflict.file} (owned by ${conflict.owner})`);
          return finalizeResult(createBlockedResult({
            role: packet.role,
            summary: `write scope already claimed: ${blockedFiles.join(", ")}`,
            evidence: [
              `blocked files: ${blockedFiles.join(", ")}`
            ],
            openQuestions: [
              "Wait for the active writer to complete or narrow this packet allowlist."
            ]
          }));
        }
      }

      let resolvedModelProfile;
      try {
        resolvedModelProfile = await resolveRoleProfileModel({
          role: packet.role,
          roleProfile,
          modelProbe,
          modelFallbacks: normalizedModelFallbacks,
          context: runtimeContext
        });
      } catch (error) {
        if (claimOwner) {
          claimRegistry.release(claimOwner);
        }
        return finalizeResult(createBlockedResult({
          role: packet.role,
          summary: `model availability probe failed (${error.message})`,
          evidence: [
            `requested_provider: ${roleProfile.provider}`,
            `requested_model: ${roleProfile.model}`,
            "model_selection_mode: blocked"
          ],
          openQuestions: [
            "Configure an available native Pi model or update the model probe before re-running."
          ]
        }));
      }

      if (!resolvedModelProfile.ok) {
        if (claimOwner) {
          claimRegistry.release(claimOwner);
        }
        return finalizeResult(createBlockedResult({
          role: packet.role,
          summary: resolvedModelProfile.reason,
          evidence: resolvedModelProfile.evidence,
          openQuestions: [
            "Configure an available native Pi model or explicit fallback before re-running."
          ]
        }));
      }

      const request = buildWorkerRequest({
        packet,
        context: runtimeContext,
        roleProfile: resolvedModelProfile.roleProfile,
        runId
      });

      calls.push({
        packet: clone(packet),
        context: clone(runtimeContext),
        request: clone(request)
      });

      try {
        const adapterContext = {
          packet: clone(packet),
          context: clone(runtimeContext),
          roleProfile: clone(resolvedModelProfile.roleProfile)
        };
        const trustedForwardedRedactionMetadata = getTrustedForwardedRedactionMetadata(runtimeContext);
        if (trustedForwardedRedactionMetadata !== undefined) {
          setTrustedForwardedRedactionMetadata(
            adapterContext.context,
            trustedForwardedRedactionMetadata
          );
        }
        const trustedRuntimeRepositoryRoot = getTrustedRuntimeRepositoryRoot(runtimeContext);
        if (trustedRuntimeRepositoryRoot !== undefined) {
          setTrustedRuntimeRepositoryRoot(
            adapterContext.context,
            trustedRuntimeRepositoryRoot,
            {
              fieldName: "context.repositoryRoot"
            }
          );
        }

        const trustedRunRepositoryRoot = getTrustedRuntimeRepositoryRoot(runtimeContext);
        const repositoryRoot = trustedRunRepositoryRoot ?? process.cwd();
        boundaryRepositoryRoot = repositoryRoot;
        let beforeSnapshot;
        const executionSnapshotScope = resolveObservedExecutionSnapshotScope(packet, resolvedModelProfile.roleProfile);
        try {
          await assertPacketExecutionPathsHaveNoSymlinks({
            repositoryRoot,
            packet
          });
          await assertRepositorySymlinksResolveInsideRoot(repositoryRoot);
          beforeSnapshot = await snapshotScopedFiles(repositoryRoot, executionSnapshotScope);
        } catch (error) {
          return finalizeResult(createBlockedResult({
            role: packet.role,
            summary: error.message,
            openQuestions: [
              "Remove repository symlinks from native Pi execution surfaces before re-running."
            ]
          }));
        }
        const adapterResponse = await adapter.runWorker(clone(request), adapterContext);
        const afterSnapshot = await snapshotScopedFiles(repositoryRoot, executionSnapshotScope);
        const observedChangedFiles = diffScopedSnapshots(beforeSnapshot, afterSnapshot);
        assertObservedWritePolicy({
          packet,
          roleProfile: resolvedModelProfile.roleProfile,
          observedChangedFiles
        });
        await assertObservedChangedFilesSafe({
          repositoryRoot,
          observedChangedFiles
        });
        assertNoRecursiveDelegation(adapterResponse);
        const rawWorkerResult = extractWorkerResult(adapterResponse);
        const reportedChangedFiles = assertReportedChangedFilesWithinPolicy({
          packet,
          roleProfile: resolvedModelProfile.roleProfile,
          reportedChangedFiles: rawWorkerResult?.changedFiles ?? []
        });
        const changedFilesMismatchEvidence = createReportedObservedChangedFilesMismatchEvidence({
          reportedChangedFiles,
          observedChangedFiles: normalizeFileList(observedChangedFiles)
        });
        if (
          isWriteRole(resolvedModelProfile.roleProfile)
          && rawWorkerResult?.status === "success"
          && observedChangedFiles.length === 0
        ) {
          throw new Error(`${packet.role} success is unproven: no repository changes were observed`);
        }
        const workerResult = createWorkerResult({
          ...rawWorkerResult,
          changedFiles: isWriteRole(resolvedModelProfile.roleProfile)
            ? observedChangedFiles
            : rawWorkerResult?.changedFiles,
          evidence: unique([
            ...(Array.isArray(rawWorkerResult?.evidence) ? rawWorkerResult.evidence : []),
            ...changedFilesMismatchEvidence,
            ...resolvedModelProfile.evidence
          ])
        });
        return finalizeResult(validateResultWritePolicy({
          packet,
          roleProfile: resolvedModelProfile.roleProfile,
          workerResult
        }));
      } catch (error) {
        return finalizeResult(createFailedResult({
          role: packet.role,
          summary: error.message,
          openQuestions: [
            "Inspect the Pi adapter output and bounded packet constraints."
          ]
        }));
      } finally {
        if (claimOwner) {
          claimRegistry.release(claimOwner);
        }
      }
    },

    getCalls() {
      return clone(calls);
    }
  };
}
