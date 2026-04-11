import { createWorkerResult, validateTaskPacket } from "./contracts.js";
import { isPathWithinScope, normalizeScopedPath, scopesOverlap } from "./path-scopes.js";
import { safeClone } from "./safe-clone.js";

const READ_ONLY_ACCESS = "read_only";
const WRITE_ACCESS = "write";

export const DEFAULT_PI_ROLE_PROFILES = Object.freeze({
  explorer: Object.freeze({
    access: READ_ONLY_ACCESS,
    model: "gpt-5.4",
    reasoningEffort: "high",
    objective: "Map code and constraints without editing files."
  }),
  implementer: Object.freeze({
    access: WRITE_ACCESS,
    model: "gpt-5.3-codex-spark",
    reasoningEffort: "medium",
    objective: "Deliver scoped code changes within the file allowlist."
  }),
  reviewer: Object.freeze({
    access: READ_ONLY_ACCESS,
    model: "gpt-5.4",
    reasoningEffort: "high",
    objective: "Provide independent read-only review findings."
  }),
  verifier: Object.freeze({
    access: READ_ONLY_ACCESS,
    model: "gpt-5.4-mini",
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

function normalizePacket(packet) {
  const normalized = validateTaskPacket(clone(packet));
  normalized.allowedFiles = normalizeFileList(normalized.allowedFiles);
  normalized.forbiddenFiles = normalizeFileList(normalized.forbiddenFiles);
  normalized.contextFiles = normalizeFileList(normalized.contextFiles ?? []);
  normalized.commands = Array.isArray(normalized.commands) ? [...normalized.commands] : [];
  return normalized;
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

function normalizeRoleProfiles(roleProfiles) {
  assert(roleProfiles && typeof roleProfiles === "object", "roleProfiles must be an object");

  const normalized = {};
  for (const [role, profile] of Object.entries(roleProfiles)) {
    assert(profile && typeof profile === "object", `role profile for ${role} must be an object`);

    const access = profile.access === WRITE_ACCESS ? WRITE_ACCESS : READ_ONLY_ACCESS;
    normalized[role] = Object.freeze({
      ...clone(profile),
      access
    });
  }

  return Object.freeze(normalized);
}

function isWriteRole(roleProfile) {
  return roleProfile.access === WRITE_ACCESS;
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
  roleProfiles = DEFAULT_PI_ROLE_PROFILES
} = {}) {
  assert(adapter && typeof adapter.runWorker === "function", "adapter.runWorker(request, context) is required");
  assert(claimRegistry && typeof claimRegistry.claimMany === "function", "claimRegistry.claimMany(files, owner) is required");
  assert(typeof claimRegistry.release === "function", "claimRegistry.release(owner) is required");

  const normalizedRoleProfiles = normalizeRoleProfiles(roleProfiles);
  const calls = [];
  let runCounter = 0;

  return {
    async run(packetInput, context = {}) {
      const packet = normalizePacket(packetInput);
      const roleProfile = normalizedRoleProfiles[packet.role];

      if (!roleProfile) {
        return createBlockedResult({
          role: packet.role,
          summary: "no Pi role profile is configured for this worker role",
          openQuestions: [
            `Configure a Pi role profile for ${packet.role} before re-running.`
          ]
        });
      }

      const runId = `${packet.id}:${packet.role}:${runCounter + 1}`;
      runCounter += 1;

      const writeFiles = isWriteRole(roleProfile) ? packet.allowedFiles : [];
      const claimOwner = isWriteRole(roleProfile) ? runId : null;

      if (claimOwner && writeFiles.length > 0) {
        const claimResult = claimRegistry.claimMany(writeFiles, claimOwner);

        if (!claimResult.ok) {
          const blockedFiles = claimResult.conflicts.map((conflict) => `${conflict.file} (owned by ${conflict.owner})`);
          return createBlockedResult({
            role: packet.role,
            summary: `write scope already claimed: ${blockedFiles.join(", ")}`,
            evidence: [
              `blocked files: ${blockedFiles.join(", ")}`
            ],
            openQuestions: [
              "Wait for the active writer to complete or narrow this packet allowlist."
            ]
          });
        }
      }

      const request = buildWorkerRequest({
        packet,
        context,
        roleProfile,
        runId
      });

      calls.push({
        packet: clone(packet),
        context: clone(context),
        request: clone(request)
      });

      try {
        const adapterResponse = await adapter.runWorker(clone(request), {
          packet: clone(packet),
          context: clone(context),
          roleProfile: clone(roleProfile)
        });
        assertNoRecursiveDelegation(adapterResponse);
        const rawWorkerResult = extractWorkerResult(adapterResponse);
        const workerResult = createWorkerResult(rawWorkerResult);
        return validateResultWritePolicy({
          packet,
          roleProfile,
          workerResult
        });
      } catch (error) {
        return createFailedResult({
          role: packet.role,
          summary: error.message,
          openQuestions: [
            "Inspect the Pi adapter output and bounded packet constraints."
          ]
        });
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
