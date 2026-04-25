import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, copyFile, cp, mkdtemp, readdir, rename, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { createTaskPacket, createWorkerResult, RESULT_STATUSES } from "./contracts.js";
import { isPathWithinScope, normalizeScopedPath } from "./path-scopes.js";
import {
  assertExistingPathHasNoSymlinkSegments,
  assertExistingPathRealpathWithinRoot,
  assertPathIsNotSymlink,
  assertWithinRoot,
  ensureDirectoryNoSymlinkSegments,
  getPathLstat
} from "./path-safety.js";
import {
  deriveCommandObservationsFromCommands,
  normalizeReviewFindings
} from "./run-evidence.js";
import {
  createCachedProcessModelProbe,
  PROCESS_MODEL_PROBE_DEFAULT_CANDIDATES,
  PROCESS_MODEL_PROBE_DEFAULT_PROVIDER
} from "./process-model-probe.js";
import { getPiSpawnCommand } from "./pi-spawn.js";
import {
  assertRedactionMetadataMatchesCoveredStrings,
  createBoundaryPathRedactor,
  mergeRedactionMetadata,
  normalizeRedactionMetadata,
  redactCoveredStringFields,
  truncateBoundaryString
} from "./redaction.js";
import { safeClone } from "./safe-clone.js";

const SUPPORTED_ROLES = Object.freeze(["explorer", "implementer", "reviewer", "verifier"]);
const READ_ONLY_ROLES = new Set(["explorer", "reviewer", "verifier"]);
const DEFAULT_TEMP_PREFIX = "pi-orchestrator-process-worker-";
const DEFAULT_APPLY_TEMP_PREFIX = ".pi-orchestrator-apply-";
const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_KILL_GRACE_MS = 2_000;
const DEFAULT_COMMAND_OUTPUT_BUFFER_MAX_CHARS = 1_000_000;
const READ_ONLY_RETRY_STDOUT_SNIPPET_MAX_CHARS = 600;
const LAUNCHER_STDOUT_SURFACE_MAX_CHARS = 1200;
const LAUNCHER_STDERR_SURFACE_MAX_CHARS = 1200;
const IMPLICIT_PI_DEFAULT_SELECTION = "implicit_pi_default";
const EXPLICIT_PROVIDER_MODEL_OVERRIDE_MODE = "explicit_provider_model_override";
const EXPLICIT_FLAG_WITHOUT_VALUE = "explicit_requested_without_value";
const COMMAND_OBSERVATION_SOURCE_PROCESS_BACKEND_LAUNCHER = "process_backend_launcher";
const TRUSTED_PROCESS_WORKER_BACKENDS = new WeakSet();
const TRUSTED_PROCESS_WORKER_LAUNCHERS = new WeakSet();
const PROCESS_SANDBOX_CAPABLE_LAUNCHERS = new WeakSet();
const TRUSTED_OS_SANDBOX_PROVIDERS = new WeakSet();
const TRUSTED_PROCESS_WORKER_BACKEND_PROVENANCE = new WeakMap();
const TRUSTED_PROCESS_WORKER_BACKEND_RUN_PROVENANCE = new WeakMap();
const LAUNCH_EVIDENCE_LABEL_PATTERN = /^(retry_)?(launcher_path|pi_script_path|pi_package_root|pi_spawn_resolution|launch_error):\s/iu;
const LAUNCH_DIAGNOSTIC_LABELS = new Set(["launch_error"]);
const BOUNDARY_LAUNCH_RESULT_STRING_FIELDS = Object.freeze([
  Object.freeze({
    keys: Object.freeze(["launcher_path", "launcherPath"]),
    fieldName: "result.launcherMetadata.launcher_path"
  }),
  Object.freeze({
    keys: Object.freeze(["pi_script_path", "piScriptPath"]),
    fieldName: "result.launcherMetadata.pi_script_path"
  }),
  Object.freeze({
    keys: Object.freeze(["pi_package_root", "piPackageRoot"]),
    fieldName: "result.launcherMetadata.pi_package_root"
  }),
  Object.freeze({
    keys: Object.freeze(["pi_spawn_resolution", "piSpawnResolution"]),
    fieldName: "result.launcherMetadata.pi_spawn_resolution"
  }),
  Object.freeze({
    keys: Object.freeze(["launch_error", "launchError"]),
    fieldName: "result.launchDiagnostics.launch_error"
  })
]);
const PROCESS_PROVIDER_OPENAI_CODEX = PROCESS_MODEL_PROBE_DEFAULT_PROVIDER;
const PROCESS_MODEL_FALLBACK = "gpt-5.4";
const MODEL_SELECTION_DIRECT = "direct";
const MODEL_SELECTION_FALLBACK = "fallback";
const MODEL_SELECTION_BLOCKED = "blocked";
const VALIDATION_EVIDENCE_KEYS = Object.freeze([
  "validationEvidence",
  "validation_evidence"
]);
const PROCESS_SANDBOX_REQUIRED = "required";
const PROCESS_SANDBOX_DISABLED = "disabled";
const PROCESS_SANDBOX_POLICIES = Object.freeze([
  PROCESS_SANDBOX_REQUIRED,
  PROCESS_SANDBOX_DISABLED
]);
const ROLE_CONTRACT_DOCS = Object.freeze({
  common: Object.freeze({
    label: "docs/agents/COMMON.md",
    url: new URL("../docs/agents/COMMON.md", import.meta.url),
    headings: [
      "Role Envelope Model",
      "Optimization Order",
      "Required Defaults",
      "Facts And Inference",
      "Forbidden Shortcuts",
      "Evidence Expectations",
      "Same-Slice Companion Updates",
      "Stop Or Escalate",
      "Output Discipline"
    ]
  }),
  explorer: Object.freeze({
    label: "docs/agents/EXPLORER.md",
    url: new URL("../docs/agents/EXPLORER.md", import.meta.url),
    headings: [
      "Capability Envelope",
      "Optimization Target",
      "Forbidden Actions",
      "Required Evidence",
      "Stop Or Block",
      "Output Shape"
    ]
  }),
  implementer: Object.freeze({
    label: "docs/agents/IMPLEMENTER.md",
    url: new URL("../docs/agents/IMPLEMENTER.md", import.meta.url),
    headings: [
      "Capability Envelope",
      "Optimization Order",
      "Allowed Actions",
      "Explicit Rules",
      "Stop Or Escalate",
      "Output Shape"
    ]
  }),
  reviewer: Object.freeze({
    label: "docs/agents/REVIEWER.md",
    url: new URL("../docs/agents/REVIEWER.md", import.meta.url),
    headings: [
      "Capability Envelope",
      "Optimization Target",
      "Explicit Rules",
      "Rejection Triggers",
      "Stop Or Block",
      "Output Shape"
    ]
  }),
  verifier: Object.freeze({
    label: "docs/agents/VERIFIER.md",
    url: new URL("../docs/agents/VERIFIER.md", import.meta.url),
    headings: [
      "Capability Envelope",
      "Optimization Target",
      "Explicit Rules",
      "Required Evidence",
      "Current Repo Evidence Limits",
      "Stop Or Block",
      "Output Shape"
    ]
  })
});
const FALLBACK_COMMON_ROLE_GUIDANCE = Object.freeze([
  "Advisory markdown for this worker is unavailable or incomplete; continue under code-enforced boundaries, status rules, and policy checks.",
  "Treat missing advisory markdown as non-authoritative and rely on the enforced task scope plus direct repository evidence."
]);
const FALLBACK_ROLE_GUIDANCE = Object.freeze({
  explorer: Object.freeze([
    "Stay read-only, answer with bounded repository facts, and surface uncertainty explicitly."
  ]),
  implementer: Object.freeze([
    "Work only inside ALLOWED_FILES, keep the change task-scoped, and stop after the scoped edit is complete."
  ]),
  reviewer: Object.freeze([
    "Ground repair findings in inspected evidence and use the enforced structured result fields."
  ]),
  verifier: Object.freeze([
    "Report only what was demonstrated from inspected artifacts or commands actually run."
  ])
});
const PROCESS_ROLE_PROFILES = Object.freeze({
  explorer: Object.freeze({
    provider: PROCESS_PROVIDER_OPENAI_CODEX,
    preferredModel: "gpt-5.5",
    thinking: "high"
  }),
  implementer: Object.freeze({
    provider: PROCESS_PROVIDER_OPENAI_CODEX,
    preferredModel: "gpt-5.5",
    thinking: "medium"
  }),
  reviewer: Object.freeze({
    provider: PROCESS_PROVIDER_OPENAI_CODEX,
    preferredModel: "gpt-5.5",
    thinking: "high"
  }),
  verifier: Object.freeze({
    provider: PROCESS_PROVIDER_OPENAI_CODEX,
    preferredModel: "gpt-5.5",
    thinking: "medium"
  })
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function isTrustedProcessWorkerBackend(backend) {
  return Boolean(backend) && typeof backend === "object" && TRUSTED_PROCESS_WORKER_BACKENDS.has(backend);
}

export function getTrustedProcessWorkerBackendProvenance(backend) {
  if (!isTrustedProcessWorkerBackend(backend)) {
    return null;
  }

  return TRUSTED_PROCESS_WORKER_BACKEND_PROVENANCE.get(backend) ?? null;
}

export function getTrustedProcessWorkerBackendRunProvenance(workerResult) {
  if (!workerResult || typeof workerResult !== "object") {
    return null;
  }

  return TRUSTED_PROCESS_WORKER_BACKEND_RUN_PROVENANCE.get(workerResult) ?? null;
}

function isTrustedProcessWorkerLauncher(launcher) {
  return typeof launcher === "function" && TRUSTED_PROCESS_WORKER_LAUNCHERS.has(launcher);
}

function isProcessSandboxCapableLauncher(launcher) {
  return typeof launcher === "function" && PROCESS_SANDBOX_CAPABLE_LAUNCHERS.has(launcher);
}

function createFrozenTrustedOsSandboxProvider(provider, fieldName = "provider") {
  assertValidSandboxProvider(provider, fieldName);
  assert(provider.osSandbox === true, `${fieldName}.osSandbox must be true`);
  assert(typeof provider.isAvailable === "function", `${fieldName}.isAvailable() must be a function`);

  return Object.freeze({
    id: provider.id.trim(),
    osSandbox: true,
    guarantees: Object.freeze(
      Array.isArray(provider.guarantees)
        ? provider.guarantees.map((value) => String(value))
        : []
    ),
    isAvailable: provider.isAvailable,
    prepareSpawn: provider.prepareSpawn
  });
}

function trustOsSandboxProvider(provider) {
  const trustedProvider = createFrozenTrustedOsSandboxProvider(provider);
  TRUSTED_OS_SANDBOX_PROVIDERS.add(trustedProvider);
  return trustedProvider;
}

function markTrustedProcessWorkerBackendRunResult(workerResult, provenance) {
  if (!workerResult || typeof workerResult !== "object" || !provenance) {
    return workerResult;
  }

  TRUSTED_PROCESS_WORKER_BACKEND_RUN_PROVENANCE.set(workerResult, Object.freeze({
    ...provenance
  }));
  return workerResult;
}

function isTrustedOsSandboxProvider(provider) {
  return Boolean(
    provider
      && typeof provider === "object"
      && provider.osSandbox === true
      && TRUSTED_OS_SANDBOX_PROVIDERS.has(provider)
  );
}

function clone(value) {
  return safeClone(value);
}

function unique(values) {
  return [...new Set(values)];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeProcessSandboxPolicy(policy) {
  if (typeof policy !== "string") {
    return PROCESS_SANDBOX_REQUIRED;
  }

  const normalized = policy.trim();
  return normalized.length === 0 ? PROCESS_SANDBOX_REQUIRED : normalized;
}

function validateProcessSandboxPolicy(policy) {
  assert(
    PROCESS_SANDBOX_POLICIES.includes(policy),
    `processSandbox must be one of: ${PROCESS_SANDBOX_POLICIES.join(", ")}`
  );
}

function createPlainSpawnOptions(cwd) {
  return {
    cwd,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  };
}

function normalizeProviderAvailability(value) {
  if (value === true) {
    return { available: true, reason: null };
  }

  if (value === false || value === undefined || value === null) {
    return { available: false, reason: "sandbox provider unavailable" };
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return {
      available: value.available === true,
      reason: typeof value.reason === "string" && value.reason.trim().length > 0
        ? value.reason.trim()
        : value.available === true
          ? null
          : "sandbox provider unavailable"
    };
  }

  return { available: false, reason: "sandbox provider returned invalid availability" };
}

async function getSandboxProviderAvailability(provider) {
  const trustedOsSandboxProvider = isTrustedOsSandboxProvider(provider);
  if (typeof provider?.isAvailable !== "function") {
    return {
      available: trustedOsSandboxProvider,
      reason: trustedOsSandboxProvider ? null : "sandbox provider is not an internally trusted OS sandbox provider"
    };
  }

  const availability = normalizeProviderAvailability(await provider.isAvailable());
  if (availability.available === true && !trustedOsSandboxProvider) {
    return {
      available: false,
      reason: "sandbox provider is not an internally trusted OS sandbox provider"
    };
  }

  return availability;
}

function assertValidSandboxProvider(provider, fieldName = "sandboxProvider") {
  assert(provider && typeof provider === "object", `${fieldName} must be an object`);
  assert(typeof provider.id === "string" && provider.id.trim().length > 0, `${fieldName}.id must be a non-empty string`);
  assert(typeof provider.prepareSpawn === "function", `${fieldName}.prepareSpawn(request) must be a function`);
}

function createUnavailableProcessSandboxProvider({ id, reason }) {
  const providerId = typeof id === "string" && id.trim().length > 0
    ? id.trim()
    : "unavailable-process-sandbox";
  const unavailableReason = typeof reason === "string" && reason.trim().length > 0
    ? reason.trim()
    : "no supported process sandbox provider is available";

  return {
    id: providerId,
    osSandbox: false,
    guarantees: [],
    async isAvailable() {
      return {
        available: false,
        reason: unavailableReason
      };
    },
    async prepareSpawn() {
      throw new Error(unavailableReason);
    }
  };
}

export function createUnsandboxedProcessSpawnProvider() {
  return {
    id: "unsandboxed-process-spawn",
    osSandbox: false,
    guarantees: [
      "ordinary child process; cwd isolation and post-run repository diff observation only",
      "does not confine reads, network, descendant spawning, or absolute-path writes while the worker runs"
    ],
    async isAvailable() {
      return { available: true, reason: null };
    },
    async prepareSpawn({ command, args, cwd }) {
      return {
        command,
        args: Array.isArray(args) ? args.map((value) => String(value)) : [],
        spawnOptions: createPlainSpawnOptions(cwd),
        evidence: [
          "unsandboxed_process_backend_opt_in: true"
        ]
      };
    }
  };
}

function sandboxProfileString(value) {
  return JSON.stringify(String(value));
}

function uniqueExistingStringPaths(paths) {
  return unique(
    paths
      .filter((pathValue) => typeof pathValue === "string" && pathValue.trim().length > 0)
      .map((pathValue) => resolve(pathValue))
  );
}

function buildMacOSSandboxProfile({
  workspaceRoot,
  extraReadRoots = []
}) {
  const readRoots = uniqueExistingStringPaths([
    workspaceRoot,
    ...extraReadRoots,
    "/bin",
    "/sbin",
    "/usr",
    "/System",
    "/Library"
  ]);
  const writeRoots = uniqueExistingStringPaths([workspaceRoot]);

  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    ...readRoots.map((pathValue) => `(allow file-read* (subpath ${sandboxProfileString(pathValue)}))`),
    ...writeRoots.map((pathValue) => `(allow file-write* (subpath ${sandboxProfileString(pathValue)}))`),
    "(deny network*)",
    ""
  ].join("\n");
}

export function createMacOSSandboxExecProvider({
  sandboxExecPath = "/usr/bin/sandbox-exec"
} = {}) {
  const implementation = Object.freeze({
    sandboxExecPath: String(sandboxExecPath)
  });

  const isAvailable = async () => {
    if (process.platform !== "darwin") {
      return {
        available: false,
        reason: `macos sandbox-exec provider is unavailable on ${process.platform}`
      };
    }

    try {
      await access(implementation.sandboxExecPath);
      return { available: true, reason: null };
    } catch {
      return {
        available: false,
        reason: `${implementation.sandboxExecPath} is not available`
      };
    }
  };

  const prepareSpawn = async ({
    command,
    args,
    cwd,
    workspaceRoot,
    extraReadRoots = []
  }) => {
    const availability = await isAvailable();
    if (availability.available !== true) {
      throw new Error(availability.reason ?? "macos sandbox-exec provider is unavailable");
    }

    const profilePath = join(
      workspaceRoot,
      `.pi-orchestrator-sandbox-${process.pid}-${Date.now()}.sb`
    );
    await writeFile(profilePath, buildMacOSSandboxProfile({
      workspaceRoot,
      extraReadRoots
    }), "utf8");

    return {
      command: implementation.sandboxExecPath,
      args: ["-f", profilePath, command, ...args.map((value) => String(value))],
      spawnOptions: createPlainSpawnOptions(cwd),
      evidence: [
        `process_sandbox_profile: ${profilePath}`
      ]
    };
  };

  return trustOsSandboxProvider({
    id: "macos-sandbox-exec",
    osSandbox: true,
    guarantees: [
      "sandbox-exec profile denies network access",
      "sandbox-exec profile denies default filesystem access and permits worker writes only under the temp workspace",
      "timeout cleanup signals the sandboxed process group"
    ],
    isAvailable,
    prepareSpawn
  });
}

export function createDefaultProcessSandboxProvider({
  platform = process.platform
} = {}) {
  if (platform === "darwin") {
    return createMacOSSandboxExecProvider();
  }

  if (platform === "linux") {
    return createUnavailableProcessSandboxProvider({
      id: "linux-process-sandbox-unavailable",
      reason: "linux process backend requires a configured namespace/seccomp/bubblewrap/firejail-style provider"
    });
  }

  if (platform === "win32") {
    return createUnavailableProcessSandboxProvider({
      id: "windows-process-sandbox-unavailable",
      reason: "windows process backend requires a configured restricted-token/job-object/AppContainer provider"
    });
  }

  return createUnavailableProcessSandboxProvider({
    id: `${platform}-process-sandbox-unavailable`,
    reason: `no process sandbox provider is configured for ${platform}`
  });
}

function createProcessSandboxConfig({
  processSandbox,
  sandboxProvider,
  unsandboxedProcessBackendOptIn
} = {}) {
  const policy = normalizeProcessSandboxPolicy(processSandbox);
  validateProcessSandboxPolicy(policy);

  if (policy === PROCESS_SANDBOX_DISABLED) {
    assert(
      unsandboxedProcessBackendOptIn === true,
      "processSandbox disabled requires unsandboxedProcessBackendOptIn: true"
    );
    const provider = sandboxProvider ?? createUnsandboxedProcessSpawnProvider();
    assertValidSandboxProvider(provider);
    return {
      policy,
      provider,
      osSandbox: false,
      trustBoundary: "observation_only",
      unsandboxedProcessBackendOptIn: true
    };
  }

  const provider = sandboxProvider ?? createDefaultProcessSandboxProvider();
  assertValidSandboxProvider(provider);
  const trustedOsSandboxProvider = isTrustedOsSandboxProvider(provider);
  return {
    policy,
    provider,
    osSandbox: trustedOsSandboxProvider,
    trustBoundary: trustedOsSandboxProvider ? "os_sandbox" : "unavailable",
    unsandboxedProcessBackendOptIn: false
  };
}

function stripMarkdownFormatting(value) {
  return String(value)
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractMarkdownSectionBlocks(markdown, heading) {
  const normalizedMarkdown = String(markdown ?? "").replace(/\r\n?/gu, "\n");
  const headingPattern = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "mu");
  const headingMatch = headingPattern.exec(normalizedMarkdown);
  assert(headingMatch, `missing markdown heading: ${heading}`);

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const remainingMarkdown = normalizedMarkdown.slice(sectionStart);
  const nextHeadingIndex = remainingMarkdown.search(/^##\s+/mu);
  const sectionBody = nextHeadingIndex === -1
    ? remainingMarkdown
    : remainingMarkdown.slice(0, nextHeadingIndex);

  const blocks = [];
  let currentBlock = null;
  const pushCurrentBlock = () => {
    if (!currentBlock) {
      return;
    }

    const normalizedBlock = stripMarkdownFormatting(currentBlock);
    if (normalizedBlock.length > 0) {
      blocks.push(normalizedBlock);
    }
    currentBlock = null;
  };

  for (const rawLine of sectionBody.split("\n")) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0) {
      pushCurrentBlock();
      continue;
    }

    const listMatch = trimmedLine.match(/^(-|\d+\.)\s+(.*)$/u);
    if (listMatch) {
      pushCurrentBlock();
      currentBlock = listMatch[2];
      continue;
    }

    currentBlock = currentBlock ? `${currentBlock} ${trimmedLine}` : trimmedLine;
  }

  pushCurrentBlock();
  return blocks;
}

function freezeRoleContractGuidanceEntry({ common, role, sourceLabels, diagnostics }) {
  return Object.freeze({
    common: Object.freeze([...common]),
    role: Object.freeze([...role]),
    sourceLabels: Object.freeze([...sourceLabels]),
    diagnostics: Object.freeze([...(diagnostics ?? [])])
  });
}

function loadRoleContractDocGuidance({
  doc,
  readFileFn,
  fallbackEntries,
  emptyGuidanceMessage
}) {
  try {
    const markdown = readFileFn(doc.url, "utf8");
    const guidance = doc.headings.flatMap((heading) => extractMarkdownSectionBlocks(markdown, heading));
    assert(guidance.length > 0, emptyGuidanceMessage);
    return {
      guidance,
      diagnostic: null
    };
  } catch (error) {
    return {
      guidance: fallbackEntries,
      diagnostic: `${doc.label} fallback active (${errorMessage(error)})`
    };
  }
}

export function loadRoleContractGuidance({
  readFileFn = readFileSync,
  roleContractDocs = ROLE_CONTRACT_DOCS
} = {}) {
  const commonDoc = roleContractDocs.common;
  const commonLoad = loadRoleContractDocGuidance({
    doc: commonDoc,
    readFileFn,
    fallbackEntries: FALLBACK_COMMON_ROLE_GUIDANCE,
    emptyGuidanceMessage: "common role contract guidance must not be empty"
  });

  const guidanceByRole = {};
  for (const role of SUPPORTED_ROLES) {
    const roleDoc = roleContractDocs[role];
    const roleLoad = loadRoleContractDocGuidance({
      doc: roleDoc,
      readFileFn,
      fallbackEntries: FALLBACK_ROLE_GUIDANCE[role] ?? [],
      emptyGuidanceMessage: `role contract guidance for ${role} must not be empty`
    });

    guidanceByRole[role] = freezeRoleContractGuidanceEntry({
      common: commonLoad.guidance,
      role: roleLoad.guidance,
      sourceLabels: [commonDoc.label, roleDoc.label],
      diagnostics: [commonLoad.diagnostic, roleLoad.diagnostic].filter(Boolean)
    });
  }

  return Object.freeze(guidanceByRole);
}

let cachedRoleContractGuidance = null;

function getRoleContractGuidance() {
  if (!cachedRoleContractGuidance) {
    cachedRoleContractGuidance = loadRoleContractGuidance();
  }

  return cachedRoleContractGuidance;
}

function normalizePath(pathValue) {
  return normalizeScopedPath(pathValue);
}

function findJsonObjectCandidate(text) {
  const normalized = String(text ?? "").trim();
  if (normalized.length === 0) {
    return null;
  }

  const fencedMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return normalized.slice(firstBrace, lastBrace + 1);
  }

  return normalized;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((value) => String(value));
}

function parseStructuredReadOnlyOutput({ role, stdout }) {
  const jsonCandidate = findJsonObjectCandidate(stdout);
  if (!jsonCandidate) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const status = typeof parsed.status === "string" ? parsed.status : null;
  const summary = typeof parsed.summary === "string" ? parsed.summary : null;
  if (!status || !summary || !RESULT_STATUSES.includes(status)) {
    return null;
  }

  const allowedStatusesByRole = {
    explorer: new Set(["success", "blocked"]),
    reviewer: new Set(["success", "repair_required", "blocked"]),
    verifier: new Set(["success", "failed", "blocked"])
  };

  const allowedStatuses = allowedStatusesByRole[role] ?? new Set(["success"]);
  if (!allowedStatuses.has(status)) {
    return null;
  }

  let normalizedReviewFindings = null;
  const hasReviewFindings = Object.prototype.hasOwnProperty.call(parsed, "reviewFindings");
  if (hasReviewFindings) {
    try {
      normalizedReviewFindings = normalizeReviewFindings(parsed.reviewFindings, {
        fieldName: "result.reviewFindings",
        allowMissing: false
      });
    } catch {
      return null;
    }
  }

  return {
    status,
    summary,
    evidence: normalizeStringArray(parsed.evidence),
    openQuestions: normalizeStringArray(parsed.openQuestions),
    ...(hasReviewFindings ? { reviewFindings: normalizedReviewFindings } : {})
  };
}

function quoteCommandPart(value) {
  const text = String(value);
  if (text.length === 0) {
    return "\"\"";
  }

  if (/[\s"]/u.test(text)) {
    return `"${text.replace(/"/g, "\\\"")}"`;
  }

  return text;
}

function formatCommand(command, args = []) {
  return [command, ...args].map((part) => quoteCommandPart(part)).join(" ");
}

function deriveProcessBackendCommandObservations(commandsRun) {
  return deriveCommandObservationsFromCommands(commandsRun, {
    source: COMMAND_OBSERVATION_SOURCE_PROCESS_BACKEND_LAUNCHER,
    fieldName: "result.commandObservations"
  });
}

function resolveObservedCommandsForTypedObservations({
  commandsRun = [],
  observedCommandsRun
} = {}) {
  if (observedCommandsRun === undefined || observedCommandsRun === null) {
    return normalizeStringArray(commandsRun);
  }
  return normalizeStringArray(observedCommandsRun);
}

function createBlockedResult(summary, {
  commandsRun = [],
  observedCommandsRun,
  evidence = [],
  openQuestions = [],
  providerModelSelection = null
} = {}) {
  const normalizedCommandsRun = normalizeStringArray(commandsRun);
  const commandObservationCommands = resolveObservedCommandsForTypedObservations({
    commandsRun: normalizedCommandsRun,
    observedCommandsRun
  });
  const commandObservations = deriveProcessBackendCommandObservations(commandObservationCommands);
  return createWorkerResult({
    status: "blocked",
    summary,
    changedFiles: [],
    commandsRun: normalizedCommandsRun,
    ...(commandObservations.length > 0 ? { commandObservations } : {}),
    evidence: normalizeStringArray(evidence),
    openQuestions: normalizeStringArray(openQuestions),
    providerModelSelection
  });
}

function createFailedResult(summary, {
  changedFiles = [],
  commandsRun = [],
  observedCommandsRun,
  evidence = [],
  openQuestions = [],
  providerModelSelection = null
} = {}) {
  const normalizedCommandsRun = normalizeStringArray(commandsRun);
  const commandObservationCommands = resolveObservedCommandsForTypedObservations({
    commandsRun: normalizedCommandsRun,
    observedCommandsRun
  });
  const commandObservations = deriveProcessBackendCommandObservations(commandObservationCommands);
  return createWorkerResult({
    status: "failed",
    summary,
    changedFiles: normalizeStringArray(changedFiles),
    commandsRun: normalizedCommandsRun,
    ...(commandObservations.length > 0 ? { commandObservations } : {}),
    evidence: normalizeStringArray(evidence),
    openQuestions: normalizeStringArray(openQuestions),
    providerModelSelection
  });
}

function createSuccessResult(summary, {
  changedFiles = [],
  commandsRun = [],
  observedCommandsRun,
  evidence = [],
  changedSurfaceObservation = null,
  providerModelSelection = null
} = {}) {
  const normalizedCommandsRun = normalizeStringArray(commandsRun);
  const commandObservationCommands = resolveObservedCommandsForTypedObservations({
    commandsRun: normalizedCommandsRun,
    observedCommandsRun
  });
  const commandObservations = deriveProcessBackendCommandObservations(commandObservationCommands);
  return createWorkerResult({
    status: "success",
    summary,
    changedFiles: normalizeStringArray(changedFiles),
    commandsRun: normalizedCommandsRun,
    ...(commandObservations.length > 0 ? { commandObservations } : {}),
    evidence: normalizeStringArray(evidence),
    openQuestions: [],
    changedSurfaceObservation,
    providerModelSelection
  });
}

function resolveLaunchEvidenceFieldName(label, { isRetry = false } = {}) {
  const category = LAUNCH_DIAGNOSTIC_LABELS.has(label)
    ? "launchDiagnostics"
    : "launcherMetadata";
  return `result.${isRetry ? "retry" : ""}${isRetry ? category[0].toUpperCase() + category.slice(1) : category}.${label}`;
}

function resolveEvidenceRedactionFieldName(entry, index) {
  const normalizedEntry = String(entry);
  const match = normalizedEntry.match(LAUNCH_EVIDENCE_LABEL_PATTERN);
  if (!match) {
    return `result.evidence[${index}]`;
  }

  const isRetry = Boolean(match[1]);
  const label = match[2];
  return resolveLaunchEvidenceFieldName(label, { isRetry });
}

function collectBoundaryLaunchResultStringFields(result) {
  const fields = [];
  for (const definition of BOUNDARY_LAUNCH_RESULT_STRING_FIELDS) {
    const presentKey = definition.keys.find((key) => Object.prototype.hasOwnProperty.call(result, key));
    if (!presentKey) {
      continue;
    }

    const value = result[presentKey];
    if (value === null || value === undefined) {
      continue;
    }
    assert(typeof value === "string", `result.${presentKey} must be a string when present`);

    fields.push({
      key: presentKey,
      fieldName: definition.fieldName,
      value
    });
  }
  return fields;
}

function buildEvidenceCoveredStringFields(evidence) {
  return evidence.map((entry, index) => ({
    fieldName: resolveEvidenceRedactionFieldName(entry, index),
    value: entry
  }));
}

function buildWorkerResultCoveredRedactionFields(result) {
  const stringFields = [
    {
      fieldName: "result.summary",
      value: result.summary
    }
  ];
  const stringArrayFields = [
    {
      fieldName: "result.changedFiles",
      value: result.changedFiles
    },
    {
      fieldName: "result.commandsRun",
      value: result.commandsRun
    },
    {
      fieldName: "result.openQuestions",
      value: result.openQuestions
    }
  ];

  buildEvidenceCoveredStringFields(result.evidence).forEach((field) => {
    stringFields.push(field);
  });

  collectBoundaryLaunchResultStringFields(result).forEach((field) => {
    stringFields.push({
      fieldName: field.fieldName,
      value: field.value
    });
  });

  if (Array.isArray(result.commandObservations)) {
    result.commandObservations.forEach((observation, index) => {
      stringFields.push({
        fieldName: `result.commandObservations[${index}].command`,
        value: observation.command
      });
    });
  }

  if (Array.isArray(result.reviewFindings)) {
    result.reviewFindings.forEach((finding, index) => {
      stringFields.push({
        fieldName: `result.reviewFindings[${index}].message`,
        value: finding.message
      });
    });
  }

  return {
    stringFields,
    stringArrayFields
  };
}

function redactWorkerResultForBoundary(result, {
  repositoryRoot,
  processWorkspaceRoots = []
}) {
  const redactor = createBoundaryPathRedactor({
    repositoryRoot,
    processWorkspaceRoots
  });
  const coveredRedactionFields = buildWorkerResultCoveredRedactionFields(result);

  const summary = redactor.redactString(result.summary, {
    fieldName: "result.summary"
  });
  const changedFiles = redactor.redactStringArray(result.changedFiles, {
    fieldName: "result.changedFiles"
  });
  const commandsRun = redactor.redactStringArray(result.commandsRun, {
    fieldName: "result.commandsRun"
  });
  const evidence = redactCoveredStringFields({
    redactor,
    stringFields: buildEvidenceCoveredStringFields(result.evidence)
  });
  const openQuestions = redactor.redactStringArray(result.openQuestions, {
    fieldName: "result.openQuestions"
  });
  const launchResultStringFields = collectBoundaryLaunchResultStringFields(result);
  const redactedLaunchResultStringFields = redactCoveredStringFields({
    redactor,
    stringFields: launchResultStringFields.map(({ fieldName, value }) => ({
      fieldName,
      value
    }))
  });

  const commandObservationRedactions = [];
  const commandObservations = Array.isArray(result.commandObservations)
    ? result.commandObservations.map((observation, index) => {
      const command = redactor.redactString(observation.command, {
        fieldName: `result.commandObservations[${index}].command`
      });
      commandObservationRedactions.push(command.redaction);
      return {
        ...observation,
        command: command.value
      };
    })
    : undefined;

  const reviewFindingRedactions = [];
  const reviewFindings = Array.isArray(result.reviewFindings)
    ? result.reviewFindings.map((finding, index) => {
      const message = redactor.redactString(finding.message, {
        fieldName: `result.reviewFindings[${index}].message`
      });
      reviewFindingRedactions.push(message.redaction);
      return {
        ...finding,
        message: message.value
      };
    })
    : undefined;

  if (Object.prototype.hasOwnProperty.call(result, "redaction")) {
    const normalizedExistingRedaction = normalizeRedactionMetadata(result.redaction, {
      fieldName: "result.redaction",
      allowMissing: false
    });
    assertRedactionMetadataMatchesCoveredStrings(normalizedExistingRedaction, {
      redactor,
      fieldName: "result.redaction",
      stringFields: coveredRedactionFields.stringFields,
      stringArrayFields: coveredRedactionFields.stringArrayFields
    });
  }

  const redacted = {
    ...result,
    summary: summary.value,
    changedFiles: changedFiles.values,
    commandsRun: commandsRun.values,
    evidence: evidence.values,
    openQuestions: openQuestions.values,
    redaction: mergeRedactionMetadata(
      summary.redaction,
      changedFiles.redaction,
      commandsRun.redaction,
      evidence.redaction,
      openQuestions.redaction,
      redactedLaunchResultStringFields.redaction,
      ...commandObservationRedactions,
      ...reviewFindingRedactions
    )
  };

  launchResultStringFields.forEach((field, index) => {
    redacted[field.key] = redactedLaunchResultStringFields.values[index];
  });

  if (commandObservations !== undefined) {
    redacted.commandObservations = commandObservations;
  }

  if (reviewFindings !== undefined) {
    redacted.reviewFindings = reviewFindings;
  }

  return createWorkerResult(redacted);
}

function getProviderModelSelectionFromLaunchSelection(launchSelection) {
  if (!launchSelection || typeof launchSelection !== "object" || Array.isArray(launchSelection)) {
    return null;
  }

  const hasKnownValue = (value) => typeof value === "string"
    && value.trim().length > 0
    && value.trim().toLowerCase() !== "unknown";

  const requestedProvider = typeof launchSelection.requestedProvider === "string" && launchSelection.requestedProvider.trim().length > 0
    ? launchSelection.requestedProvider.trim()
    : null;
  const requestedModel = typeof launchSelection.requestedModel === "string" && launchSelection.requestedModel.trim().length > 0
    ? launchSelection.requestedModel.trim()
    : null;
  const selectedProvider = typeof launchSelection.selectedProvider === "string" && launchSelection.selectedProvider.trim().length > 0
    ? launchSelection.selectedProvider.trim()
    : null;
  const selectedModel = typeof launchSelection.selectedModel === "string" && launchSelection.selectedModel.trim().length > 0
    ? launchSelection.selectedModel.trim()
    : null;

  if (
    !hasKnownValue(requestedProvider)
    || !hasKnownValue(requestedModel)
    || !hasKnownValue(selectedProvider)
    || !hasKnownValue(selectedModel)
  ) {
    return null;
  }

  return {
    requestedProvider,
    requestedModel,
    selectedProvider,
    selectedModel
  };
}

function normalizeRelativeFilePath(pathValue, fieldName) {
  const raw = String(pathValue);
  const normalized = normalizePath(raw);
  const segments = normalized.split("/");

  assert(normalized.length > 0, `${fieldName} entries must not be empty`);
  assert(!isAbsolute(raw), `${fieldName} entries must be relative paths`);
  assert(!segments.some((segment) => segment === ".."), `${fieldName} entries must not escape the workspace`);

  return normalized;
}

async function getPathStats(pathValue) {
  try {
    return await stat(pathValue);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function assertNoUnsafeHardlinks(pathStats, label) {
  if (!pathStats || !Number.isInteger(pathStats.nlink)) {
    return;
  }

  if (pathStats.nlink > 1) {
    throw new Error(`${label} must not be hardlinked to multiple directory entries`);
  }
}

async function assertWorkspaceChangedFileSourceSafe(rootPath, pathValue, changedFile) {
  await assertExistingPathHasNoSymlinkSegments(rootPath, pathValue, "workspace changed file");
  const pathStats = await getPathLstat(pathValue);
  if (!pathStats) {
    return null;
  }

  if (pathStats.isSymbolicLink()) {
    throw new Error(`workspace changed file must not be a symlink: ${changedFile}`);
  }

  if (!pathStats.isFile()) {
    throw new Error(`changed file source must be a regular file: ${changedFile}`);
  }

  assertNoUnsafeHardlinks(pathStats, "workspace changed file");
  return pathStats;
}

async function removeRollbackDestinationIfPresent(rootPath, pathValue, label) {
  await assertExistingPathHasNoSymlinkSegments(rootPath, dirname(pathValue), label);
  const pathStats = await getPathLstat(pathValue);
  if (!pathStats) {
    return;
  }

  if (pathStats.isDirectory()) {
    throw new Error(`${label} rollback destination must not be a directory`);
  }

  await rm(pathValue, { force: true });
}

async function assertExistingTreeHasNoSymlinks(pathValue, label) {
  const pathStats = await getPathLstat(pathValue);
  if (!pathStats) {
    return;
  }

  if (pathStats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }

  if (!pathStats.isDirectory()) {
    return;
  }

  const entries = await readdir(pathValue, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(pathValue, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} must not contain symlinks`);
    }

    if (entry.isDirectory()) {
      await assertExistingTreeHasNoSymlinks(childPath, label);
    }
  }
}

async function applyChangedFilesToRepository({
  repositoryRoot,
  workspaceRoot,
  changedFiles,
  moveFileFn = rename
}) {
  assert(typeof moveFileFn === "function", "moveFileFn(sourcePath, destinationPath) must be a function");

  const normalizedRepositoryRoot = resolve(repositoryRoot);
  const normalizedWorkspaceRoot = resolve(workspaceRoot);
  const applyRoot = await mkdtemp(join(normalizedRepositoryRoot, DEFAULT_APPLY_TEMP_PREFIX));
  const stagedRoot = resolve(applyRoot, "staged");
  const backupRoot = resolve(applyRoot, "backup");
  const operations = [];
  let commitStarted = false;

  try {
    for (const changedFileInput of changedFiles) {
      const changedFile = normalizeRelativeFilePath(changedFileInput, "changedFiles");
      const sourcePath = resolve(normalizedWorkspaceRoot, changedFile);
      assertWithinRoot(normalizedWorkspaceRoot, sourcePath, "workspace changed file");
      await assertExistingPathHasNoSymlinkSegments(normalizedWorkspaceRoot, dirname(sourcePath), "workspace changed file");
      await assertExistingPathRealpathWithinRoot(normalizedWorkspaceRoot, sourcePath, "workspace changed file");

      const destinationPath = resolve(normalizedRepositoryRoot, changedFile);
      assertWithinRoot(normalizedRepositoryRoot, destinationPath, "repository changed file");
      await assertExistingPathHasNoSymlinkSegments(normalizedRepositoryRoot, dirname(destinationPath), "repository changed file");
      await assertPathIsNotSymlink(destinationPath, "repository changed file");

      const sourceStats = await getPathStats(sourcePath);
      if (sourceStats && !sourceStats.isFile()) {
        throw new Error(`changed file source must be a regular file: ${changedFile}`);
      }

      const destinationStats = await getPathStats(destinationPath);
      if (destinationStats?.isDirectory()) {
        throw new Error(`cannot atomically replace directory destination: ${changedFile}`);
      }

      const stagedPath = resolve(stagedRoot, changedFile);
      assertWithinRoot(stagedRoot, stagedPath, "staged changed file");

      const backupPath = resolve(backupRoot, changedFile);
      assertWithinRoot(backupRoot, backupPath, "backup changed file");

      if (sourceStats) {
        const safeSourceStats = await assertWorkspaceChangedFileSourceSafe(normalizedWorkspaceRoot, sourcePath, changedFile);
        assert(safeSourceStats, `changed file source disappeared before staging: ${changedFile}`);
        await ensureDirectoryNoSymlinkSegments(stagedRoot, dirname(stagedPath), "staged changed file");
        await copyFile(sourcePath, stagedPath);
        const stagedStats = await getPathLstat(stagedPath);
        assert(stagedStats?.isFile(), `staged changed file must be a regular file: ${changedFile}`);
        assertNoUnsafeHardlinks(stagedStats, "staged changed file");
      }

      operations.push({
        changedFile,
        destinationPath,
        stagedPath,
        backupPath,
        sourceExists: Boolean(sourceStats),
        destinationExisted: Boolean(destinationStats),
        destinationApplied: false,
        backupCreated: false
      });
    }

    commitStarted = true;
    for (const operation of operations) {
      if (operation.destinationExisted) {
        await assertExistingPathHasNoSymlinkSegments(normalizedRepositoryRoot, dirname(operation.destinationPath), "repository changed file");
        await assertPathIsNotSymlink(operation.destinationPath, "repository changed file");
        await ensureDirectoryNoSymlinkSegments(backupRoot, dirname(operation.backupPath), "backup changed file");
        await moveFileFn(operation.destinationPath, operation.backupPath);
        await assertPathIsNotSymlink(operation.backupPath, "backup changed file");
        operation.backupCreated = true;
      }

      if (operation.sourceExists) {
        await assertWorkspaceChangedFileSourceSafe(stagedRoot, operation.stagedPath, operation.changedFile);
        await ensureDirectoryNoSymlinkSegments(normalizedRepositoryRoot, dirname(operation.destinationPath), "repository changed file");
        await assertPathIsNotSymlink(operation.destinationPath, "repository changed file");
        await moveFileFn(operation.stagedPath, operation.destinationPath);
        await assertPathIsNotSymlink(operation.destinationPath, "repository changed file");
        operation.destinationApplied = true;
      }
    }
  } catch (error) {
    if (commitStarted) {
      let rollbackError = null;
      for (const operation of [...operations].reverse()) {
        try {
          if (operation.destinationApplied) {
            await removeRollbackDestinationIfPresent(
              normalizedRepositoryRoot,
              operation.destinationPath,
              "repository changed file"
            );
            operation.destinationApplied = false;
          }

          if (operation.backupCreated) {
            await assertWorkspaceChangedFileSourceSafe(backupRoot, operation.backupPath, operation.changedFile);
            await removeRollbackDestinationIfPresent(
              normalizedRepositoryRoot,
              operation.destinationPath,
              "repository changed file"
            );
            await ensureDirectoryNoSymlinkSegments(normalizedRepositoryRoot, dirname(operation.destinationPath), "repository changed file");
            await moveFileFn(operation.backupPath, operation.destinationPath);
            await assertPathIsNotSymlink(operation.destinationPath, "repository changed file");
            operation.backupCreated = false;
          }
        } catch (rollbackFailure) {
          rollbackError = rollbackError ?? rollbackFailure;
        }
      }

      if (rollbackError) {
        throw new Error(
          `failed to apply changed files atomically and rollback failed: ${errorMessage(error)}; rollback_error: ${errorMessage(rollbackError)}`
        );
      }

      throw new Error(`failed to apply changed files atomically: ${errorMessage(error)}`);
    }

    throw new Error(`failed to prepare changed files for atomic apply: ${errorMessage(error)}`);
  } finally {
    await rm(applyRoot, { recursive: true, force: true });
  }
}

async function snapshotFiles(rootDir) {
  const snapshot = new Map();

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = normalizePath(relative(rootDir, absolutePath));
      const content = await readFile(absolutePath);
      const contentHash = createHash("sha256").update(content).digest("hex");
      snapshot.set(relativePath, contentHash);
    }
  }

  await walk(rootDir);
  return snapshot;
}

function diffSnapshots(beforeSnapshot, afterSnapshot) {
  const files = unique([
    ...beforeSnapshot.keys(),
    ...afterSnapshot.keys()
  ]).sort();

  return files.filter((file) => beforeSnapshot.get(file) !== afterSnapshot.get(file));
}

function getReadOnlyAllowedStatusInstruction(role) {
  return role === "reviewer"
    ? 'Allowed statuses: "success", "repair_required", "blocked".'
    : role === "verifier"
      ? 'Allowed statuses: "success", "failed", "blocked".'
      : 'Allowed statuses: "success", "blocked".';
}

function getReadOnlyWorkerObjective(packet) {
  if (packet.role === "explorer") {
    return "Inspect the allowed scope, describe the relevant context, and tell the implementer what should be created or changed.";
  }

  if (packet.role === "reviewer") {
    return "Review the scoped implementation independently against the original task and acceptance checks.";
  }

  return "Verify the scoped implementation against the original task and acceptance checks.";
}

function buildRoleContractPromptSection(role, roleContractGuidance = getRoleContractGuidance()) {
  const contractGuidance = roleContractGuidance[role];
  assert(contractGuidance, `missing role contract guidance for ${role}`);

  return [
    "ADVISORY_ROLE_CONTRACTS:",
    `- Source docs: ${contractGuidance.sourceLabels.join(", ")}`,
    "- These markdown contracts shape worker behavior only. Code-enforced boundaries, status rules, and policy checks remain authoritative.",
    ...contractGuidance.diagnostics.map((diagnostic) => `- Advisory doc status: ${diagnostic}.`),
    "COMMON_ROLE_GUIDANCE:",
    ...contractGuidance.common.map((entry) => `- ${entry}`),
    `${role.toUpperCase()}_ROLE_GUIDANCE:`,
    ...contractGuidance.role.map((entry) => `- ${entry}`)
  ];
}

function buildCodexPrompt(packet, roleContractGuidance = getRoleContractGuidance()) {
  if (READ_ONLY_ROLES.has(packet.role)) {
    const roleLabel = packet.role === "explorer"
      ? "explorer"
      : packet.role === "reviewer"
        ? "reviewer"
        : "verifier";
    const roleSpecificRules = packet.role === "explorer"
      ? [
        "- Inspect the allowed scope and identify the relevant code paths.",
        "- Return a structured summary of what matters for implementation.",
        "- If an allowed target file does not exist yet, report that fact and describe what the implementer should create; do not block solely because the file is absent."
      ]
      : packet.role === "reviewer"
        ? [
          "- Review the scoped changes independently against the goal and acceptance checks.",
          "- Return repair_required if the scoped change is insufficient or risky."
        ]
        : [
          "- Verify the scoped changes against the acceptance checks.",
          "- Return failed or blocked if the acceptance checks are not met."
        ];

    const lines = [
      `You are the ${roleLabel} worker for a bounded coding task.`,
      `Work only in the current working directory and stop after ${roleLabel === "explorer" ? "inspection" : "verification"}.`,
      "",
      `YOUR_READ_ONLY_OBJECTIVE: ${getReadOnlyWorkerObjective(packet)}`,
      `ORIGINAL_IMPLEMENTER_TASK: ${packet.goal}`,
      "",
      "Hard rules:",
      "- Do not modify any files.",
      "- Do not delegate work and do not spawn sub-workers.",
      ...roleSpecificRules,
      "",
      ...buildRoleContractPromptSection(packet.role, roleContractGuidance),
      "",
      "ALLOWED_SCOPE:",
      ...packet.allowedFiles.map((file) => `- ${file}`)
    ];

    if (packet.contextFiles.length > 0) {
      lines.push("", "CONTEXT_FILES:", ...packet.contextFiles.map((file) => `- ${file}`));
    }

    if (packet.acceptanceChecks.length > 0) {
      lines.push("", "ACCEPTANCE_CHECKS:", ...packet.acceptanceChecks.map((check) => `- ${check}`));
    }

    if (packet.stopConditions.length > 0) {
      lines.push("", "STOP_CONDITIONS:", ...packet.stopConditions.map((condition) => `- ${condition}`));
    }

    lines.push(
      "",
      "Return exactly one JSON object and nothing else.",
      "The JSON object must contain: status, summary, evidence, openQuestions.",
      getReadOnlyAllowedStatusInstruction(packet.role)
    );
    return lines.join("\n");
  }

  const lines = [
    "You are the implementer worker for a bounded coding task.",
    "Work only in the current working directory and then stop.",
    "",
    `Goal: ${packet.goal}`,
    "",
    "Hard rules:",
    "- Only modify files in ALLOWED_FILES.",
    "- Never modify files outside ALLOWED_FILES.",
    "- Never modify FORBIDDEN_FILES.",
    "- Do not delegate work and do not spawn sub-workers.",
    "- Keep changes task-scoped, but prefer the smallest sufficient correct change, not the smallest diff.",
    "",
    ...buildRoleContractPromptSection(packet.role, roleContractGuidance),
    "",
    "ALLOWED_FILES:",
    ...packet.allowedFiles.map((file) => `- ${file}`)
  ];

  if (packet.forbiddenFiles.length > 0) {
    lines.push("", "FORBIDDEN_FILES:", ...packet.forbiddenFiles.map((file) => `- ${file}`));
  }

  if (packet.contextFiles.length > 0) {
    lines.push("", "CONTEXT_FILES:", ...packet.contextFiles.map((file) => `- ${file}`));
  }

  if (packet.acceptanceChecks.length > 0) {
    lines.push("", "ACCEPTANCE_CHECKS:", ...packet.acceptanceChecks.map((check) => `- ${check}`));
  }

  if (packet.stopConditions.length > 0) {
    lines.push("", "STOP_CONDITIONS:", ...packet.stopConditions.map((condition) => `- ${condition}`));
  }

  lines.push("", "After applying the scoped edits, stop.");
  return lines.join("\n");
}

function buildStrictReadOnlyRetryPrompt(packet, previousStdout, roleContractGuidance = getRoleContractGuidance()) {
  const roleLabel = packet.role === "explorer"
    ? "explorer"
    : packet.role === "reviewer"
      ? "reviewer"
      : "verifier";
  const previousOutputSnippet = truncateBoundaryString(previousStdout ?? "", {
    maxLength: READ_ONLY_RETRY_STDOUT_SNIPPET_MAX_CHARS,
    fieldName: "previousStdout"
  }).replace(/\r?\n/gu, "\\n");
  const lines = [
    `You are the ${roleLabel} worker for a bounded coding task.`,
    "Your previous response was invalid because it was not valid structured JSON.",
    "Retry now and return exactly one JSON object only.",
    "",
    `YOUR_READ_ONLY_OBJECTIVE: ${getReadOnlyWorkerObjective(packet)}`,
    `ORIGINAL_IMPLEMENTER_TASK: ${packet.goal}`,
    "",
    "Hard rules:",
    "- Do not modify any files.",
    "- Do not delegate work and do not spawn sub-workers.",
    "- Output must be a single raw JSON object with no markdown, prose, or code fences.",
    "",
    ...buildRoleContractPromptSection(packet.role, roleContractGuidance),
    "",
    "ALLOWED_SCOPE:",
    ...packet.allowedFiles.map((file) => `- ${file}`)
  ];

  if (packet.contextFiles.length > 0) {
    lines.push("", "CONTEXT_FILES:", ...packet.contextFiles.map((file) => `- ${file}`));
  }

  if (packet.acceptanceChecks.length > 0) {
    lines.push("", "ACCEPTANCE_CHECKS:", ...packet.acceptanceChecks.map((check) => `- ${check}`));
  }

  lines.push(
    "",
    "SCHEMA_REMINDER:",
    '{"status":"<allowed_status>","summary":"<short summary>","evidence":["<fact>"],"openQuestions":["<optional question>"]}',
    getReadOnlyAllowedStatusInstruction(packet.role),
    "",
    "PREVIOUS_INVALID_OUTPUT_SNIPPET:",
    previousOutputSnippet.length > 0 ? previousOutputSnippet : "[empty]"
  );

  return lines.join("\n");
}

function appendBoundedOutput(currentValue, chunk, {
  maxChars
}) {
  if (currentValue.length >= maxChars) {
    return {
      value: currentValue,
      truncated: true
    };
  }

  const nextChunk = chunk.toString();
  const remainingChars = maxChars - currentValue.length;
  if (nextChunk.length <= remainingChars) {
    return {
      value: currentValue + nextChunk,
      truncated: false
    };
  }

  return {
    value: currentValue + nextChunk.slice(0, remainingChars),
    truncated: true
  };
}

function buildSandboxAttestation(provider, evidence = []) {
  const osSandbox = isTrustedOsSandboxProvider(provider);
  return {
    provider: provider.id,
    osSandbox,
    trustBoundary: osSandbox ? "os_sandbox" : "observation_only",
    guarantees: Array.isArray(provider.guarantees) ? provider.guarantees.map((value) => String(value)) : [],
    evidence: Array.isArray(evidence) ? evidence.map((value) => String(value)) : []
  };
}

async function runCommand({
  command,
  args,
  cwd,
  timeoutMs,
  timeoutKillGraceMs = DEFAULT_TIMEOUT_KILL_GRACE_MS,
  outputBufferMaxChars = DEFAULT_COMMAND_OUTPUT_BUFFER_MAX_CHARS,
  sandboxProvider = createUnsandboxedProcessSpawnProvider(),
  sandboxContext = {}
}) {
  const startedAt = Date.now();
  let spawnPlan;
  try {
    assertValidSandboxProvider(sandboxProvider, "sandboxProvider");
    spawnPlan = await sandboxProvider.prepareSpawn({
      command,
      args: Array.isArray(args) ? args.map((value) => String(value)) : [],
      cwd,
      ...sandboxContext
    });
  } catch (error) {
    return {
      command,
      args,
      cwd,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timeoutSignal: null,
      forcedKillSignal: null,
      forcedKillAttempted: false,
      processGroupCleanup: false,
      timeoutBudgetMs: timeoutMs,
      error,
      durationMs: Date.now() - startedAt,
      sandbox: buildSandboxAttestation(sandboxProvider)
    };
  }

  const spawnCommand = typeof spawnPlan?.command === "string" ? spawnPlan.command : command;
  const spawnArgs = Array.isArray(spawnPlan?.args) ? spawnPlan.args.map((value) => String(value)) : [];
  const spawnOptions = spawnPlan?.spawnOptions && typeof spawnPlan.spawnOptions === "object"
    ? spawnPlan.spawnOptions
    : createPlainSpawnOptions(cwd);
  const sandboxAttestation = buildSandboxAttestation(sandboxProvider, spawnPlan?.evidence);

  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let timeoutSignal = null;
    let forcedKillSignal = null;
    let forcedKillAttempted = false;
    let processGroupCleanup = false;
    let forcedKillHandle = null;

    let childProcess;
    try {
      childProcess = spawn(spawnCommand, spawnArgs, spawnOptions);
      processGroupCleanup = process.platform !== "win32" && Number.isInteger(childProcess.pid);
    } catch (error) {
      resolveResult({
        command,
        args,
        cwd,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timeoutSignal,
        forcedKillSignal,
        forcedKillAttempted,
        processGroupCleanup,
        timeoutBudgetMs: timeoutMs,
        sandbox: sandboxAttestation,
        error,
        durationMs: Date.now() - startedAt
      });
      return;
    }

    function signalChild(signal) {
      if (processGroupCleanup) {
        try {
          process.kill(-childProcess.pid, signal);
          return true;
        } catch (error) {
          if (error && error.code !== "ESRCH") {
            // Fall through to direct child signaling for platforms or launches
            // where process-group signaling is unavailable despite detached spawn.
          } else {
            return false;
          }
        }
      }

      try {
        return childProcess.kill(signal);
      } catch {
        return false;
      }
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      timeoutSignal = "SIGTERM";
      signalChild(timeoutSignal);
      forcedKillHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        forcedKillAttempted = true;
        forcedKillSignal = "SIGKILL";
        signalChild(forcedKillSignal);
      }, timeoutKillGraceMs);
      if (typeof forcedKillHandle.unref === "function") {
        forcedKillHandle.unref();
      }
    }, timeoutMs);

    function finalize(result) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      if (forcedKillHandle) {
        clearTimeout(forcedKillHandle);
      }
      resolveResult({
        ...result,
        timeoutSignal,
        forcedKillSignal,
        forcedKillAttempted,
        processGroupCleanup,
        timeoutBudgetMs: timeoutMs,
        sandbox: sandboxAttestation,
        durationMs: Date.now() - startedAt
      });
    }

    childProcess.stdout?.on("data", (chunk) => {
      const nextOutput = appendBoundedOutput(stdout, chunk, {
        maxChars: outputBufferMaxChars
      });
      stdout = nextOutput.value;
      stdoutTruncated = stdoutTruncated || nextOutput.truncated;
    });
    childProcess.stderr?.on("data", (chunk) => {
      const nextOutput = appendBoundedOutput(stderr, chunk, {
        maxChars: outputBufferMaxChars
      });
      stderr = nextOutput.value;
      stderrTruncated = stderrTruncated || nextOutput.truncated;
    });

    childProcess.on("error", (error) => {
      finalize({
        command,
        args,
        cwd,
        exitCode: null,
        signal: null,
        timedOut,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        error
      });
    });

    childProcess.on("close", (exitCode, signal) => {
      finalize({
        command,
        args,
        cwd,
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        error: null
      });
    });
  });
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function inferCommandsRun(launchResult) {
  if (Array.isArray(launchResult?.commandsRun) && launchResult.commandsRun.length > 0) {
    return normalizeStringArray(launchResult.commandsRun);
  }

  if (typeof launchResult?.command === "string") {
    const args = Array.isArray(launchResult.args) ? launchResult.args : [];
    return [formatCommand(launchResult.command, args)];
  }

  return [];
}

function inferObservedCommandsRun(launchResult) {
  if (Array.isArray(launchResult?.observedCommandsRun) && launchResult.observedCommandsRun.length > 0) {
    return normalizeStringArray(launchResult.observedCommandsRun);
  }

  if (launchResult?.error) {
    return [];
  }

  if (Array.isArray(launchResult?.commandsRun) && launchResult.commandsRun.length > 0) {
    return normalizeStringArray(launchResult.commandsRun);
  }

  return [];
}

function normalizeProcessRoleProfiles(roleProfilesInput, {
  allowFallbacks = false
} = {}) {
  assert(roleProfilesInput && typeof roleProfilesInput === "object", "roleProfiles must be an object");
  const normalized = {};

  for (const role of SUPPORTED_ROLES) {
    const profile = roleProfilesInput[role];
    assert(profile && typeof profile === "object", `role profile for ${role} must be an object`);

    const provider = typeof profile.provider === "string" && profile.provider.trim().length > 0
      ? profile.provider.trim()
      : allowFallbacks
        ? PROCESS_PROVIDER_OPENAI_CODEX
        : null;
    const preferredModel = typeof profile.preferredModel === "string" && profile.preferredModel.trim().length > 0
      ? profile.preferredModel.trim()
      : allowFallbacks
        ? PROCESS_MODEL_FALLBACK
        : null;
    const thinking = typeof profile.thinking === "string" && profile.thinking.trim().length > 0
      ? profile.thinking.trim()
      : allowFallbacks
        ? "off"
        : null;

    assert(provider, `role profile for ${role} must include provider`);
    assert(preferredModel, `role profile for ${role} must include preferredModel`);
    assert(thinking, `role profile for ${role} must include thinking`);

    normalized[role] = Object.freeze({
      provider,
      preferredModel,
      thinking
    });
  }

  return Object.freeze(normalized);
}

function resolveProcessModelProbeCandidates({ roleProfiles, fallbackModel }) {
  const preferredModels = Object.values(roleProfiles)
    .map((profile) => profile?.preferredModel)
    .filter((model) => typeof model === "string" && model.trim().length > 0)
    .map((model) => model.trim());
  const normalizedFallbackModel = typeof fallbackModel === "string" && fallbackModel.trim().length > 0
    ? fallbackModel.trim()
    : PROCESS_MODEL_FALLBACK;

  return unique([
    ...PROCESS_MODEL_PROBE_DEFAULT_CANDIDATES,
    ...preferredModels,
    normalizedFallbackModel
  ]);
}

function normalizeLauncherArgsBuilderOutput(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && "args" in value) {
    const argsValue = value.args;
    const args = Array.isArray(argsValue)
      ? argsValue.map((entry) => String(entry))
      : [String(argsValue)];

    const launchSelection = value.launchSelection && typeof value.launchSelection === "object" && !Array.isArray(value.launchSelection)
      ? clone(value.launchSelection)
      : null;

    return {
      args,
      launchSelection
    };
  }

  if (Array.isArray(value)) {
    return {
      args: value.map((entry) => String(entry)),
      launchSelection: null
    };
  }

  return {
    args: [String(value)],
    launchSelection: null
  };
}

function normalizeLaunchSelectionOverride(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const selectedProvider = typeof value.selectedProvider === "string" && value.selectedProvider.trim().length > 0
    ? value.selectedProvider.trim()
    : null;
  const selectedModel = typeof value.selectedModel === "string" && value.selectedModel.trim().length > 0
    ? value.selectedModel.trim()
    : null;
  const selectedThinking = typeof value.selectedThinking === "string" && value.selectedThinking.trim().length > 0
    ? value.selectedThinking.trim()
    : null;

  if (!selectedProvider || !selectedModel || !selectedThinking) {
    return null;
  }

  const requestedProvider = typeof value.requestedProvider === "string" && value.requestedProvider.trim().length > 0
    ? value.requestedProvider.trim()
    : selectedProvider;
  const requestedModel = typeof value.requestedModel === "string" && value.requestedModel.trim().length > 0
    ? value.requestedModel.trim()
    : selectedModel;
  const modelSelectionMode = typeof value.modelSelectionMode === "string" && value.modelSelectionMode.trim().length > 0
    ? value.modelSelectionMode.trim()
    : MODEL_SELECTION_DIRECT;
  const modelSelectionReason = typeof value.modelSelectionReason === "string" && value.modelSelectionReason.trim().length > 0
    ? value.modelSelectionReason.trim()
    : "retry_reused_previous_selection";
  const fallbackReason = typeof value.fallbackReason === "string" && value.fallbackReason.trim().length > 0
    ? value.fallbackReason.trim()
    : null;
  const supportedModels = Array.isArray(value.supportedModels) && value.supportedModels.length > 0
    ? unique(value.supportedModels.map((entry) => String(entry)))
    : [selectedModel];

  return {
    requestedProvider,
    requestedModel,
    selectedProvider,
    selectedModel,
    selectedThinking,
    modelSelectionMode,
    modelSelectionReason,
    fallbackReason,
    supportedModels
  };
}

function resolveRoleLaunchSelection({
  packetRole,
  roleProfiles,
  fallbackModel,
  modelProbeResult
}) {
  const roleProfile = roleProfiles[packetRole];
  assert(roleProfile, `process backend blocked: role profile missing for ${packetRole}`);

  const provider = roleProfile.provider;
  const requestedModel = roleProfile.preferredModel;
  const selectedThinking = roleProfile.thinking;

  const normalizedFallbackModel = typeof fallbackModel === "string" && fallbackModel.trim().length > 0
    ? fallbackModel.trim()
    : PROCESS_MODEL_FALLBACK;

  const supportedModels = Array.isArray(modelProbeResult?.supportedModels)
    ? unique(modelProbeResult.supportedModels.map((model) => String(model)))
    : [];
  const supportedModelSet = new Set(supportedModels);

  if (supportedModelSet.has(requestedModel)) {
    return {
      requestedProvider: provider,
      requestedModel,
      selectedProvider: provider,
      selectedModel: requestedModel,
      selectedThinking,
      modelSelectionMode: MODEL_SELECTION_DIRECT,
      modelSelectionReason: "preferred_model_supported",
      fallbackReason: null,
      supportedModels
    };
  }

  if (supportedModelSet.has(normalizedFallbackModel)) {
    return {
      requestedProvider: provider,
      requestedModel,
      selectedProvider: provider,
      selectedModel: normalizedFallbackModel,
      selectedThinking,
      modelSelectionMode: MODEL_SELECTION_FALLBACK,
      modelSelectionReason: "preferred_model_unavailable",
      fallbackReason: `preferred model unavailable: ${requestedModel}; fallback model selected: ${normalizedFallbackModel}`,
      supportedModels
    };
  }

  const blockedReason = supportedModels.length === 0
    ? `process backend blocked: no supported models resolved for provider ${provider}`
    : `process backend blocked: provider ${provider} does not support preferred model ${requestedModel} or fallback model ${normalizedFallbackModel}`;

  throw new Error(`${blockedReason}; supported models: ${supportedModels.length === 0 ? "none" : supportedModels.join(", ")}`);
}

export function createProcessRoleArgsBuilder({
  roleProfiles = PROCESS_ROLE_PROFILES,
  fallbackModel = PROCESS_MODEL_FALLBACK,
  allowRoleProfileFallbacks = false,
  modelProbe = createCachedProcessModelProbe({
    providerId: PROCESS_PROVIDER_OPENAI_CODEX,
    candidateModels: PROCESS_MODEL_PROBE_DEFAULT_CANDIDATES
  })
} = {}) {
  assert(typeof modelProbe === "function", "modelProbe(options) must be a function");
  const normalizedRoleProfiles = normalizeProcessRoleProfiles(roleProfiles, {
    allowFallbacks: allowRoleProfileFallbacks
  });
  const normalizedFallbackModel = typeof fallbackModel === "string" && fallbackModel.trim().length > 0
    ? fallbackModel.trim()
    : PROCESS_MODEL_FALLBACK;
  const probeCandidateModels = resolveProcessModelProbeCandidates({
    roleProfiles: normalizedRoleProfiles,
    fallbackModel: normalizedFallbackModel
  });

  return async function buildProcessRoleArgs({ packet, prompt, workspaceRoot, launchSelectionOverride }) {
    const roleProfile = normalizedRoleProfiles[packet.role];
    assert(roleProfile, `process backend blocked: role profile missing for ${packet.role}`);

    const forcedLaunchSelection = normalizeLaunchSelectionOverride(launchSelectionOverride);
    if (forcedLaunchSelection) {
      return {
        args: [
          "-p",
          "--no-session",
          "--provider",
          forcedLaunchSelection.selectedProvider,
          "--model",
          forcedLaunchSelection.selectedModel,
          "--thinking",
          forcedLaunchSelection.selectedThinking,
          prompt
        ],
        launchSelection: forcedLaunchSelection
      };
    }

    const probeResult = await modelProbe({
      providerId: roleProfile.provider,
      candidateModels: probeCandidateModels,
      workspaceRoot
    });

    if (probeResult?.blockedReason) {
      throw new Error(`process backend blocked: model probe failed for provider ${roleProfile.provider} (${probeResult.blockedReason})`);
    }

    const launchSelection = resolveRoleLaunchSelection({
      packetRole: packet.role,
      roleProfiles: normalizedRoleProfiles,
      fallbackModel: normalizedFallbackModel,
      modelProbeResult: probeResult
    });

    return {
      args: [
        "-p",
        "--no-session",
        "--provider",
        launchSelection.selectedProvider,
        "--model",
        launchSelection.selectedModel,
        "--thinking",
        launchSelection.selectedThinking,
        prompt
      ],
      launchSelection
    };
  };
}

function parseLongOptionValue(args, optionName) {
  const prefix = `${optionName}=`;
  let isPassed = false;
  let requestedValue = null;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    if (current === optionName) {
      isPassed = true;
      const next = args[index + 1];
      if (typeof next === "string" && !next.startsWith("-")) {
        requestedValue = next;
      } else {
        requestedValue = null;
      }
      continue;
    }

    if (current.startsWith(prefix)) {
      isPassed = true;
      const inlineValue = current.slice(prefix.length);
      requestedValue = inlineValue.length > 0 ? inlineValue : null;
    }
  }

  return { isPassed, requestedValue };
}

function describeLaunchProfile(argsInput) {
  const args = Array.isArray(argsInput) ? argsInput.map((value) => String(value)) : [];
  const provider = parseLongOptionValue(args, "--provider");
  const model = parseLongOptionValue(args, "--model");
  const thinking = parseLongOptionValue(args, "--thinking");

  return {
    providerFlagPassed: provider.isPassed,
    providerSelection: provider.isPassed
      ? provider.requestedValue ?? EXPLICIT_FLAG_WITHOUT_VALUE
      : IMPLICIT_PI_DEFAULT_SELECTION,
    modelFlagPassed: model.isPassed,
    modelSelection: model.isPassed
      ? model.requestedValue ?? EXPLICIT_FLAG_WITHOUT_VALUE
      : IMPLICIT_PI_DEFAULT_SELECTION,
    thinkingFlagPassed: thinking.isPassed,
    thinkingSelection: thinking.isPassed
      ? thinking.requestedValue ?? EXPLICIT_FLAG_WITHOUT_VALUE
      : "not_passed",
    effectiveLauncherMode: provider.isPassed || model.isPassed
      ? EXPLICIT_PROVIDER_MODEL_OVERRIDE_MODE
      : IMPLICIT_PI_DEFAULT_SELECTION
  };
}

function prefixEvidenceEntries(entries, prefix) {
  return normalizeStringArray(entries).map((entry) => `${prefix}${entry}`);
}

function buildProcessSandboxEvidence({
  sandboxConfig,
  launchResult = null,
  availability = null
} = {}) {
  const launchSandbox = launchResult?.sandbox && typeof launchResult.sandbox === "object"
    ? launchResult.sandbox
    : null;
  const providerId = launchSandbox?.provider ?? sandboxConfig?.provider?.id ?? "unknown";
  const osSandbox = availability?.available === false
    ? false
    : sandboxConfig?.osSandbox === true;
  const trustBoundary = availability?.available === false
    ? "unavailable"
    : sandboxConfig?.trustBoundary
    ?? (osSandbox ? "os_sandbox" : "observation_only");
  const guarantees = Array.isArray(launchSandbox?.guarantees)
    ? launchSandbox.guarantees
    : Array.isArray(sandboxConfig?.provider?.guarantees)
      ? sandboxConfig.provider.guarantees
      : [];
  const evidence = [
    `process_sandbox_policy: ${sandboxConfig?.policy ?? "unknown"}`,
    `process_backend_os_sandbox: ${osSandbox}`,
    `process_backend_trust_boundary: ${trustBoundary}`,
    `process_sandbox_provider: ${providerId}`,
    `process_sandbox_available: ${availability?.available === false ? "false" : "true"}`
  ];

  if (sandboxConfig?.policy === PROCESS_SANDBOX_DISABLED || sandboxConfig?.unsandboxedProcessBackendOptIn === true) {
    evidence.push("unsandboxed_process_backend_opt_in: true");
    evidence.push("process_backend_boundary: workspace copy plus allowlist apply checks; not an OS sandbox");
  }

  if (availability?.available === false && availability.reason) {
    evidence.push(`process_sandbox_unavailable_reason: ${availability.reason}`);
  }

  for (const guarantee of guarantees) {
    evidence.push(`process_sandbox_guarantee: ${guarantee}`);
  }

  if (Array.isArray(launchSandbox?.evidence)) {
    evidence.push(...launchSandbox.evidence);
  }

  return evidence.map((line) => String(line));
}

function buildEvidence({
  launchResult,
  repositoryRoot,
  workspaceRoot,
  allowedFiles,
  contextFiles,
  copiedSeedFiles,
  missingSeedFiles,
  changedFiles,
  sandboxConfig
}) {
  const launchProfile = describeLaunchProfile(launchResult?.args);
  const evidence = [
    `repository_root: ${repositoryRoot}`,
    `workspace: ${workspaceRoot}`,
    ...buildProcessSandboxEvidence({
      sandboxConfig,
      launchResult
    }),
    "changed_surface_observation_basis: launcher workspace file diff",
    `allowed_files: ${allowedFiles.join(", ")}`,
    `context_files: ${contextFiles.length === 0 ? "none" : contextFiles.join(", ")}`,
    `copied_seed_files: ${copiedSeedFiles.length === 0 ? "none" : copiedSeedFiles.join(", ")}`,
    `missing_seed_files: ${missingSeedFiles.length === 0 ? "none" : missingSeedFiles.join(", ")}`,
    `changed_files: ${changedFiles.length === 0 ? "none" : changedFiles.join(", ")}`,
    `provider_flag_passed: ${launchProfile.providerFlagPassed}`,
    `provider_selection: ${launchProfile.providerSelection}`,
    `model_flag_passed: ${launchProfile.modelFlagPassed}`,
    `model_selection: ${launchProfile.modelSelection}`,
    `thinking_flag_passed: ${launchProfile.thinkingFlagPassed}`,
    `thinking_selection: ${launchProfile.thinkingSelection}`,
    `effective_launcher_mode: ${launchProfile.effectiveLauncherMode}`
  ];

  if (launchResult?.launchSelection && typeof launchResult.launchSelection === "object") {
    const launchSelection = launchResult.launchSelection;
    evidence.push(`requested_provider: ${launchSelection.requestedProvider ?? "unknown"}`);
    evidence.push(`requested_model: ${launchSelection.requestedModel ?? "unknown"}`);
    evidence.push(`selected_provider: ${launchSelection.selectedProvider ?? "unknown"}`);
    evidence.push(`selected_model: ${launchSelection.selectedModel ?? "unknown"}`);
    evidence.push(`selected_thinking: ${launchSelection.selectedThinking ?? "unknown"}`);
    evidence.push(`model_selection_mode: ${launchSelection.modelSelectionMode ?? MODEL_SELECTION_BLOCKED}`);
    evidence.push(`model_selection_reason: ${launchSelection.modelSelectionReason ?? "none"}`);

    if (launchSelection.fallbackReason) {
      evidence.push(`model_fallback_reason: ${launchSelection.fallbackReason}`);
    }

    if (Array.isArray(launchSelection.supportedModels)) {
      evidence.push(
        `supported_provider_models: ${launchSelection.supportedModels.length === 0 ? "none" : launchSelection.supportedModels.join(", ")}`
      );
    }
  }

  if (launchResult?.launcher) {
    evidence.push(`launcher: ${launchResult.launcher}`);
  }

  if (launchResult?.launcherPath) {
    evidence.push(`launcher_path: ${launchResult.launcherPath}`);
  }

  if (launchResult?.piScriptPath) {
    evidence.push(`pi_script_path: ${launchResult.piScriptPath}`);
  }

  if (launchResult?.piPackageRoot) {
    evidence.push(`pi_package_root: ${launchResult.piPackageRoot}`);
  }

  if (launchResult?.piSpawnResolution) {
    evidence.push(`pi_spawn_resolution: ${launchResult.piSpawnResolution}`);
  }

  if (Number.isInteger(launchResult?.durationMs)) {
    evidence.push(`duration_ms: ${launchResult.durationMs}`);
  }

  if (Number.isInteger(launchResult?.timeoutBudgetMs)) {
    evidence.push(`timeout_budget_ms: ${launchResult.timeoutBudgetMs}`);
  }

  if (launchResult && launchResult.exitCode !== null && launchResult.exitCode !== undefined) {
    evidence.push(`exit_code: ${launchResult.exitCode}`);
  }

  if (launchResult?.signal) {
    evidence.push(`signal: ${launchResult.signal}`);
  }

  if (launchResult?.timedOut) {
    evidence.push("timed_out: true");
  }

  if (launchResult?.timeoutSignal) {
    evidence.push(`timeout_signal: ${launchResult.timeoutSignal}`);
  }

  if (launchResult?.forcedKillAttempted) {
    evidence.push("timeout_forced_termination_attempted: true");
  }

  if (launchResult?.forcedKillSignal) {
    evidence.push(`timeout_forced_signal: ${launchResult.forcedKillSignal}`);
  }

  if (typeof launchResult?.processGroupCleanup === "boolean") {
    evidence.push(`timeout_process_group_cleanup: ${launchResult.processGroupCleanup}`);
  }

  if (launchResult?.stdout) {
    evidence.push(`stdout: ${truncateBoundaryString(launchResult.stdout, {
      maxLength: LAUNCHER_STDOUT_SURFACE_MAX_CHARS,
      fieldName: "launchResult.stdout"
    })}`);
  }

  if (launchResult?.stdoutTruncated) {
    evidence.push("stdout_buffer_truncated: true");
  }

  if (launchResult?.stderr) {
    evidence.push(`stderr: ${truncateBoundaryString(launchResult.stderr, {
      maxLength: LAUNCHER_STDERR_SURFACE_MAX_CHARS,
      fieldName: "launchResult.stderr"
    })}`);
  }

  if (launchResult?.stderrTruncated) {
    evidence.push("stderr_buffer_truncated: true");
  }

  if (launchResult?.error) {
    evidence.push(`launch_error: ${errorMessage(launchResult.error)}`);
  }

  return evidence.map((line) => String(line));
}

function extractValidationEvidence(launchResult) {
  for (const key of VALIDATION_EVIDENCE_KEYS) {
    if (!Array.isArray(launchResult?.[key])) {
      continue;
    }

    return normalizeStringArray(launchResult[key])
      .filter((entry) => entry.trim().length > 0);
  }

  return [];
}

function implementerHasReviewableCompletionEvidence({
  changedFiles
} = {}) {
  return Array.isArray(changedFiles) && changedFiles.length > 0;
}

export function createProcessPiCliLauncher(options = {}) {
  const {
    timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
    timeoutKillGraceMs = DEFAULT_TIMEOUT_KILL_GRACE_MS,
    argsBuilder,
    roleProfiles = PROCESS_ROLE_PROFILES,
    fallbackModel = PROCESS_MODEL_FALLBACK,
    allowRoleProfileFallbacks = false,
    roleContractGuidanceLoader = getRoleContractGuidance,
    modelProbe = createCachedProcessModelProbe({
      providerId: PROCESS_PROVIDER_OPENAI_CODEX,
      candidateModels: PROCESS_MODEL_PROBE_DEFAULT_CANDIDATES
    }),
    spawnCommandResolver = getPiSpawnCommand,
    runCommandFn = runCommand
  } = options;
  const usesTrustedDefaultLaunchPipeline = !Object.prototype.hasOwnProperty.call(options, "argsBuilder")
    && !Object.prototype.hasOwnProperty.call(options, "roleProfiles")
    && !Object.prototype.hasOwnProperty.call(options, "fallbackModel")
    && !Object.prototype.hasOwnProperty.call(options, "allowRoleProfileFallbacks")
    && !Object.prototype.hasOwnProperty.call(options, "modelProbe")
    && !Object.prototype.hasOwnProperty.call(options, "spawnCommandResolver")
    && !Object.prototype.hasOwnProperty.call(options, "runCommandFn");
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0, "pi launcher timeoutMs must be a positive integer");
  assert(
    Number.isInteger(timeoutKillGraceMs) && timeoutKillGraceMs > 0,
    "pi launcher timeoutKillGraceMs must be a positive integer"
  );
  assert(typeof roleContractGuidanceLoader === "function", "roleContractGuidanceLoader() must be a function");
  assert(typeof spawnCommandResolver === "function", "spawnCommandResolver(options) must be a function");
  assert(typeof runCommandFn === "function", "runCommandFn(request) must be a function");
  const resolvedArgsBuilder = typeof argsBuilder === "function"
    ? argsBuilder
    : createProcessRoleArgsBuilder({
      roleProfiles,
      fallbackModel,
      allowRoleProfileFallbacks,
      modelProbe
    });

  const launchPiWorker = async function launchPiWorker({
    packet,
    context,
    repositoryRoot = null,
    workspaceRoot,
    sandboxProvider = createUnsandboxedProcessSpawnProvider(),
    promptOverride = null,
    launchSelectionOverride = null
  }) {
    const hasPromptOverride = typeof promptOverride === "string" && promptOverride.trim().length > 0;
    const roleContractGuidance = hasPromptOverride ? null : roleContractGuidanceLoader();
    const prompt = hasPromptOverride
      ? promptOverride
      : buildCodexPrompt(packet, roleContractGuidance);
    let argsBuilderOutput;
    try {
      argsBuilderOutput = await resolvedArgsBuilder({
        packet: clone(packet),
        context: clone(context),
        workspaceRoot,
        prompt,
        launchSelectionOverride: clone(launchSelectionOverride)
      });
    } catch (error) {
      return {
        command: "",
        args: [],
        cwd: workspaceRoot,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        error,
        durationMs: 0,
        timeoutBudgetMs: timeoutMs,
        launcher: "pi_cli_args_builder_error",
        launcherPath: null,
        piScriptPath: null,
        piPackageRoot: null,
        piSpawnResolution: "worker launcher arguments could not be resolved",
        commandsRun: [],
        observedCommandsRun: [],
        launchProfile: describeLaunchProfile([]),
        launchSelection: null
      };
    }

    const normalizedArgsOutput = normalizeLauncherArgsBuilderOutput(argsBuilderOutput);
    const args = normalizedArgsOutput.args;
    const launchSelection = normalizedArgsOutput.launchSelection;
    const inputLaunchProfile = describeLaunchProfile(args);

    let spawnCommand;
    try {
      spawnCommand = await spawnCommandResolver({
        packet: clone(packet),
        context: clone(context),
        workspaceRoot
      });
    } catch (error) {
      return {
        command: "",
        args,
        cwd: workspaceRoot,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        error,
        durationMs: 0,
        timeoutBudgetMs: timeoutMs,
        launcher: "pi_cli_resolution_error",
        launcherPath: null,
        piScriptPath: null,
        piPackageRoot: null,
        piSpawnResolution: `pi spawn command resolution failed: ${errorMessage(error)}`,
        commandsRun: [],
        observedCommandsRun: [],
        launchProfile: inputLaunchProfile,
        launchSelection
      };
    }

    const command = typeof spawnCommand?.command === "string"
      ? spawnCommand.command.trim()
      : "";
    const argsPrefix = Array.isArray(spawnCommand?.argsPrefix)
      ? spawnCommand.argsPrefix.map((value) => String(value))
      : [];
    const fullArgs = [...argsPrefix, ...args];
    const launchProfile = describeLaunchProfile(fullArgs);

    const hasResolvedPiScript = typeof spawnCommand?.piScriptPath === "string" && spawnCommand.piScriptPath.length > 0;
    if (!hasResolvedPiScript) {
      return {
        command,
        args: fullArgs,
        cwd: workspaceRoot,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        error: new Error("Pi script path was not resolved; refusing fallback launcher"),
        durationMs: 0,
        timeoutBudgetMs: timeoutMs,
        launcher: spawnCommand?.launcher ?? "pi_cli_unresolved",
        launcherPath: spawnCommand?.launcherPath ?? null,
        piScriptPath: spawnCommand?.piScriptPath ?? null,
        piPackageRoot: spawnCommand?.piPackageRoot ?? null,
        piSpawnResolution: spawnCommand?.resolutionMessage ?? "pi spawn command resolution returned no script path",
        commandsRun: [],
        observedCommandsRun: [],
        launchProfile,
        launchSelection
      };
    }

    if (command.length === 0) {
      return {
        command: "",
        args: fullArgs,
        cwd: workspaceRoot,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        error: new Error("Pi launcher command is empty"),
        durationMs: 0,
        timeoutBudgetMs: timeoutMs,
        launcher: spawnCommand?.launcher ?? "pi_cli",
        launcherPath: spawnCommand?.launcherPath ?? null,
        piScriptPath: spawnCommand?.piScriptPath ?? null,
        piPackageRoot: spawnCommand?.piPackageRoot ?? null,
        piSpawnResolution: spawnCommand?.resolutionMessage ?? "pi spawn command resolution returned an empty command",
        commandsRun: [],
        observedCommandsRun: [],
        launchProfile,
        launchSelection
      };
    }

    let launchResult;
    try {
      launchResult = await runCommandFn({
        command,
        args: fullArgs,
        cwd: workspaceRoot,
        timeoutMs,
        timeoutKillGraceMs,
        sandboxProvider,
        sandboxContext: {
          workspaceRoot,
          repositoryRoot,
          extraReadRoots: uniqueExistingStringPaths([
            dirname(command),
            spawnCommand?.launcherPath ? dirname(spawnCommand.launcherPath) : null,
            spawnCommand?.piScriptPath ? dirname(spawnCommand.piScriptPath) : null,
            spawnCommand?.piPackageRoot ?? null
          ])
        }
      });
    } catch (error) {
      launchResult = {
        command,
        args: fullArgs,
        cwd: workspaceRoot,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        error,
        durationMs: 0,
        timeoutBudgetMs: timeoutMs
      };
    }

    return {
      ...launchResult,
      launcher: spawnCommand?.launcher ?? "pi_cli",
      launcherPath: spawnCommand?.launcherPath ?? command,
      piScriptPath: spawnCommand?.piScriptPath ?? null,
      piPackageRoot: spawnCommand?.piPackageRoot ?? null,
      piSpawnResolution: spawnCommand?.resolutionMessage ?? null,
      timeoutBudgetMs: timeoutMs,
      commandsRun: [formatCommand(command, fullArgs)],
      observedCommandsRun: launchResult?.error ? [] : [formatCommand(command, fullArgs)],
      launchProfile,
      launchSelection
    };
  };
  launchPiWorker.getTimeoutBudgetMs = () => timeoutMs;
  if (!Object.prototype.hasOwnProperty.call(options, "runCommandFn")) {
    PROCESS_SANDBOX_CAPABLE_LAUNCHERS.add(launchPiWorker);
  }
  if (usesTrustedDefaultLaunchPipeline) {
    TRUSTED_PROCESS_WORKER_LAUNCHERS.add(launchPiWorker);
  }
  return launchPiWorker;
}

export function createPiCliLauncher(options = {}) {
  return createProcessPiCliLauncher(options);
}

export function createCodexCliLauncher(options = {}) {
  return createProcessPiCliLauncher(options);
}

export function createProcessWorkerBackend({
  launcher = createProcessPiCliLauncher(),
  repositoryRoot = process.cwd(),
  keepWorkspace = false,
  tempPrefix = DEFAULT_TEMP_PREFIX,
  moveFileFn = rename,
  processSandbox = PROCESS_SANDBOX_REQUIRED,
  sandboxProvider,
  unsandboxedProcessBackendOptIn = false
} = {}) {
  assert(typeof launcher === "function", "launcher(request) is required");
  assert(typeof repositoryRoot === "string" && repositoryRoot.length > 0, "repositoryRoot must be a non-empty string");
  assert(typeof keepWorkspace === "boolean", "keepWorkspace must be a boolean");
  assert(typeof tempPrefix === "string" && tempPrefix.length > 0, "tempPrefix must be a non-empty string");
  assert(typeof moveFileFn === "function", "moveFileFn(sourcePath, destinationPath) must be a function");

  const normalizedRepositoryRoot = resolve(repositoryRoot);
  const sandboxConfig = createProcessSandboxConfig({
    processSandbox,
    sandboxProvider,
    unsandboxedProcessBackendOptIn
  });
  const calls = [];
  const trustedBackendProvenance = isTrustedProcessWorkerLauncher(launcher) && moveFileFn === rename
    ? Object.freeze({
      identity: "pi-orchestrator/process-worker-backend",
      source: "createProcessWorkerBackend",
      evidenceKind: sandboxConfig.osSandbox
        ? "provider_model_selection_trusted_workspace_diff_os_sandboxed"
        : "provider_model_selection_trusted_workspace_diff_observation_only",
      osSandbox: sandboxConfig.osSandbox,
      sandboxProvider: sandboxConfig.provider.id,
      processSandbox: sandboxConfig.policy,
      trustBoundary: sandboxConfig.trustBoundary,
      unsandboxedProcessBackendOptIn: sandboxConfig.unsandboxedProcessBackendOptIn
    })
    : null;

  const backend = {
    async run(packetInput, contextInput = {}) {
      calls.push({
        packet: clone(packetInput),
        context: clone(contextInput)
      });

      let workspaceRoot = null;
      const finalizeWorkerResult = (result) => {
        const finalizedResult = redactWorkerResultForBoundary(result, {
          repositoryRoot: normalizedRepositoryRoot,
          processWorkspaceRoots: workspaceRoot ? [workspaceRoot] : []
        });
        return trustedBackendProvenance
          ? markTrustedProcessWorkerBackendRunResult(finalizedResult, trustedBackendProvenance)
          : finalizedResult;
      };
      const blockedResult = (summary, options = {}) => finalizeWorkerResult(createBlockedResult(summary, options));
      const failedResult = (summary, options = {}) => finalizeWorkerResult(createFailedResult(summary, options));
      const successResult = (summary, options = {}) => finalizeWorkerResult(createSuccessResult(summary, options));

      let packet;
      try {
        packet = createTaskPacket(clone(packetInput));
      } catch (error) {
        return blockedResult(`process worker blocked: invalid packet (${errorMessage(error)})`, {
          evidence: ["packet validation failed before worker launch"],
          openQuestions: ["Provide a valid task packet that matches src/contracts.js."]
        });
      }

      if (!SUPPORTED_ROLES.includes(packet.role)) {
        return blockedResult(`process worker blocked: unsupported role ${packet.role}`, {
          evidence: [`supported roles: ${SUPPORTED_ROLES.join(", ")}`],
          openQuestions: [`Send a packet with one of: ${SUPPORTED_ROLES.join(", ")}.`]
        });
      }

      let allowedFiles;
      let forbiddenFiles;
      let contextFiles;
      try {
        allowedFiles = unique(packet.allowedFiles.map((pathValue) => normalizeRelativeFilePath(pathValue, "packet.allowedFiles")));
        forbiddenFiles = unique(packet.forbiddenFiles.map((pathValue) => normalizeRelativeFilePath(pathValue, "packet.forbiddenFiles")));
        contextFiles = unique((packet.contextFiles ?? []).map((pathValue) => normalizeRelativeFilePath(pathValue, "packet.contextFiles")));
      } catch (error) {
        return blockedResult(`process worker blocked: ${errorMessage(error)}`, {
          evidence: ["packet file paths failed normalization"],
          openQuestions: ["Use only relative file paths inside packet allowlists and context files."]
        });
      }

      if (allowedFiles.length === 0) {
        return blockedResult("process worker blocked: packet.allowedFiles must contain at least one file", {
          openQuestions: ["Provide at least one allowed file path for implementer writes."]
        });
      }

      const normalizedPacket = {
        ...packet,
        allowedFiles,
        forbiddenFiles,
        contextFiles
      };

      let sandboxAvailability;
      try {
        sandboxAvailability = await getSandboxProviderAvailability(sandboxConfig.provider);
      } catch (error) {
        sandboxAvailability = {
          available: false,
          reason: errorMessage(error)
        };
      }

      if (sandboxConfig.policy === PROCESS_SANDBOX_REQUIRED && sandboxAvailability.available !== true) {
        return blockedResult("process worker blocked: required OS sandbox provider is unavailable", {
          evidence: buildProcessSandboxEvidence({
            sandboxConfig,
            availability: sandboxAvailability
          }),
          openQuestions: [
            "Configure a supported OS sandbox provider before enabling the process backend for execution."
          ]
        });
      }

      if (sandboxConfig.policy === PROCESS_SANDBOX_REQUIRED && !isProcessSandboxCapableLauncher(launcher)) {
        return blockedResult("process worker blocked: launcher does not support the process sandbox provider contract", {
          evidence: buildProcessSandboxEvidence({
            sandboxConfig,
            availability: sandboxAvailability
          }),
          openQuestions: [
            "Use createProcessPiCliLauncher without an injected runCommandFn, or disable process sandboxing only with explicit dev-mode opt-in."
          ]
        });
      }

      let changedFiles = [];
      let launchResult = null;
      let providerModelSelection = null;
      const copiedSeedFiles = [];
      const missingSeedFiles = [];

      try {
        workspaceRoot = await mkdtemp(join(tmpdir(), tempPrefix));

        const seedFiles = unique([
          ...allowedFiles,
          ...contextFiles
        ]);

        for (const seedFile of seedFiles) {
          const sourcePath = resolve(normalizedRepositoryRoot, seedFile);
          assertWithinRoot(normalizedRepositoryRoot, sourcePath, "seed source file");
          await assertExistingPathHasNoSymlinkSegments(normalizedRepositoryRoot, sourcePath, "seed source file");
          await assertExistingPathRealpathWithinRoot(normalizedRepositoryRoot, sourcePath, "seed source file");
          await assertExistingTreeHasNoSymlinks(sourcePath, "seed source file");

          const destinationPath = resolve(workspaceRoot, seedFile);
          assertWithinRoot(workspaceRoot, destinationPath, "seed destination file");

          const sourceStats = await getPathStats(sourcePath);
          if (sourceStats) {
            await assertExistingPathHasNoSymlinkSegments(normalizedRepositoryRoot, sourcePath, "seed source file");
            await assertExistingPathRealpathWithinRoot(normalizedRepositoryRoot, sourcePath, "seed source file");
            await assertExistingTreeHasNoSymlinks(sourcePath, "seed source file");
            await ensureDirectoryNoSymlinkSegments(workspaceRoot, dirname(destinationPath), "seed destination file");

            if (sourceStats.isDirectory()) {
              await cp(sourcePath, destinationPath, { recursive: true });
              await assertExistingTreeHasNoSymlinks(destinationPath, "seed destination file");
            } else {
              await copyFile(sourcePath, destinationPath);
              await assertPathIsNotSymlink(destinationPath, "seed destination file");
            }

            copiedSeedFiles.push(seedFile);
            continue;
          }

          missingSeedFiles.push(seedFile);
        }

        const targetAbsolutePaths = allowedFiles.map((allowedFile) => {
          const absolutePath = resolve(workspaceRoot, allowedFile);
          assertWithinRoot(workspaceRoot, absolutePath, "allowed file");
          return absolutePath;
        });
        for (const targetAbsolutePath of targetAbsolutePaths) {
          await ensureDirectoryNoSymlinkSegments(workspaceRoot, dirname(targetAbsolutePath), "allowed file parent");
        }

        const beforeSnapshot = await snapshotFiles(workspaceRoot);

        launchResult = await launcher({
          packet: clone(normalizedPacket),
          context: clone(contextInput),
          repositoryRoot: normalizedRepositoryRoot,
          workspaceRoot,
          processSandbox: sandboxConfig.policy,
          sandboxProvider: sandboxConfig.provider,
          targetRelativePaths: clone(allowedFiles),
          targetAbsolutePaths: clone(targetAbsolutePaths),
          targetRelativePath: allowedFiles[0] ?? null,
          targetAbsolutePath: targetAbsolutePaths[0] ?? null
        });
        const initialProviderModelSelection = getProviderModelSelectionFromLaunchSelection(launchResult?.launchSelection);
        if (initialProviderModelSelection) {
          providerModelSelection = initialProviderModelSelection;
        }

        const afterSnapshot = await snapshotFiles(workspaceRoot);
        changedFiles = diffSnapshots(beforeSnapshot, afterSnapshot);
        const isReadOnlyRole = READ_ONLY_ROLES.has(packet.role);
        let commandsRun = inferCommandsRun(launchResult);
        let observedCommandsRun = inferObservedCommandsRun(launchResult);
        let evidence = buildEvidence({
          launchResult,
          repositoryRoot: normalizedRepositoryRoot,
          workspaceRoot,
          allowedFiles,
          contextFiles,
          copiedSeedFiles,
          missingSeedFiles,
          changedFiles,
          sandboxConfig
        });
        let readOnlyStructuredOutputSource = null;

        const setReadOnlyRetryAttemptedEvidence = (attempted) => {
          if (!isReadOnlyRole) {
            return;
          }

          evidence = [
            ...evidence.filter((entry) => !entry.startsWith("read_only_json_repair_retry_attempted:")),
            `read_only_json_repair_retry_attempted: ${attempted}`
          ];
        };

        if (isReadOnlyRole) {
          setReadOnlyRetryAttemptedEvidence(false);
        }

        if (launchResult?.error) {
          return blockedResult(`process worker blocked: launcher invocation failed (${errorMessage(launchResult.error)})`, {
            commandsRun,
            observedCommandsRun,
            evidence: unique(evidence),
            openQuestions: [
              "Check local permissions, Pi resolution, and worker launcher availability."
            ]
          });
        }

        if (launchResult?.timedOut) {
          return failedResult("process worker failed: launcher timed out", {
            changedFiles,
            commandsRun,
            observedCommandsRun,
            evidence: unique(evidence),
            openQuestions: [
              "Reduce prompt complexity or increase launcher timeout."
            ],
            providerModelSelection
          });
        }

        if (launchResult?.exitCode !== 0) {
          return failedResult(`process worker failed: launcher exited with code ${launchResult?.exitCode ?? "unknown"}`, {
            changedFiles,
            commandsRun,
            observedCommandsRun,
            evidence: unique(evidence),
            openQuestions: [
              "Inspect launcher stdout/stderr and verify non-interactive worker command syntax."
            ],
            providerModelSelection
          });
        }

        if (isReadOnlyRole && changedFiles.length > 0) {
          return failedResult(`${packet.role} process worker failed: ${packet.role} modified files`, {
            changedFiles,
            commandsRun,
            observedCommandsRun,
            evidence: unique([
              ...evidence,
              `unexpected_read_only_changes: ${changedFiles.join(", ")}`
            ]),
            openQuestions: [
              `Tighten ${packet.role} prompt and runner constraints to keep the role read-only.`
            ],
            providerModelSelection
          });
        }

        let structuredReadOnlyOutput = isReadOnlyRole
          ? parseStructuredReadOnlyOutput({
            role: packet.role,
            stdout: launchResult?.stdout ?? ""
          })
          : null;

        if (isReadOnlyRole && !structuredReadOnlyOutput) {
          setReadOnlyRetryAttemptedEvidence(true);
          evidence = unique([
            ...evidence,
            "read_only_structured_output_valid_first_attempt: false"
          ]);

          const retryLaunchSelectionOverride = normalizeLaunchSelectionOverride(launchResult?.launchSelection);
          const retryPrompt = buildStrictReadOnlyRetryPrompt(
            normalizedPacket,
            launchResult?.stdout ?? "",
            getRoleContractGuidance()
          );

          launchResult = await launcher({
            packet: clone(normalizedPacket),
            context: clone(contextInput),
            repositoryRoot: normalizedRepositoryRoot,
            workspaceRoot,
            processSandbox: sandboxConfig.policy,
            sandboxProvider: sandboxConfig.provider,
            targetRelativePaths: clone(allowedFiles),
            targetAbsolutePaths: clone(targetAbsolutePaths),
            targetRelativePath: allowedFiles[0] ?? null,
            targetAbsolutePath: targetAbsolutePaths[0] ?? null,
            promptOverride: retryPrompt,
            launchSelectionOverride: retryLaunchSelectionOverride ? clone(retryLaunchSelectionOverride) : null
          });
          if (!providerModelSelection) {
            const retryProviderModelSelection = getProviderModelSelectionFromLaunchSelection(launchResult?.launchSelection);
            if (retryProviderModelSelection) {
              providerModelSelection = retryProviderModelSelection;
            }
          }

          const retrySnapshot = await snapshotFiles(workspaceRoot);
          changedFiles = diffSnapshots(beforeSnapshot, retrySnapshot);
          commandsRun = [...commandsRun, ...inferCommandsRun(launchResult)];
          observedCommandsRun = [...observedCommandsRun, ...inferObservedCommandsRun(launchResult)];
          evidence = unique([
            ...evidence,
            ...prefixEvidenceEntries(buildEvidence({
              launchResult,
              repositoryRoot: normalizedRepositoryRoot,
              workspaceRoot,
              allowedFiles,
              contextFiles,
              copiedSeedFiles,
              missingSeedFiles,
              changedFiles,
              sandboxConfig
            }), "retry_")
          ]);

          if (launchResult?.error) {
            return blockedResult(`process worker blocked: launcher invocation failed (${errorMessage(launchResult.error)})`, {
              commandsRun,
              observedCommandsRun,
              evidence: unique([
                ...evidence,
                "read_only_structured_output_valid_retry_attempt: false",
                "read_only_retry_failure_reason: retry_launcher_invocation_failed"
              ]),
              openQuestions: [
                "Check local permissions, Pi resolution, and worker launcher availability."
              ]
            });
          }

          if (launchResult?.timedOut) {
            return failedResult("process worker failed: launcher timed out", {
              changedFiles,
              commandsRun,
              observedCommandsRun,
              evidence: unique([
                ...evidence,
                "read_only_structured_output_valid_retry_attempt: false",
                "read_only_retry_failure_reason: retry_launcher_timed_out"
              ]),
              openQuestions: [
                "Reduce prompt complexity or increase launcher timeout."
              ],
              providerModelSelection
            });
          }

          if (launchResult?.exitCode !== 0) {
            return failedResult(`process worker failed: launcher exited with code ${launchResult?.exitCode ?? "unknown"}`, {
              changedFiles,
              commandsRun,
              observedCommandsRun,
              evidence: unique([
                ...evidence,
                "read_only_structured_output_valid_retry_attempt: false",
                `read_only_retry_failure_reason: retry_launcher_exit_code_${launchResult?.exitCode ?? "unknown"}`
              ]),
              openQuestions: [
                "Inspect launcher stdout/stderr and verify non-interactive worker command syntax."
              ],
              providerModelSelection
            });
          }

          if (changedFiles.length > 0) {
            return failedResult(`${packet.role} process worker failed: ${packet.role} modified files`, {
              changedFiles,
              commandsRun,
              observedCommandsRun,
              evidence: unique([
                ...evidence,
                "read_only_structured_output_valid_retry_attempt: false",
                `unexpected_read_only_changes: ${changedFiles.join(", ")}`
              ]),
              openQuestions: [
                `Tighten ${packet.role} prompt and runner constraints to keep the role read-only.`
              ],
              providerModelSelection
            });
          }

          structuredReadOnlyOutput = parseStructuredReadOnlyOutput({
            role: packet.role,
            stdout: launchResult?.stdout ?? ""
          });

          evidence = unique([
            ...evidence,
            `read_only_structured_output_valid_retry_attempt: ${Boolean(structuredReadOnlyOutput)}`
          ]);
          if (structuredReadOnlyOutput) {
            readOnlyStructuredOutputSource = "retry_attempt";
          }
        } else if (isReadOnlyRole && structuredReadOnlyOutput) {
          evidence = unique([
            ...evidence,
            "read_only_structured_output_valid_first_attempt: true"
          ]);
          readOnlyStructuredOutputSource = "first_attempt";
        }

        const changedOutsideAllowlist = changedFiles.filter((file) => !allowedFiles.some((scopeEntry) => isPathWithinScope(file, scopeEntry)));
        if (changedOutsideAllowlist.length > 0) {
          return failedResult("process worker failed: worker changed files outside the allowlist", {
            changedFiles,
            commandsRun,
            observedCommandsRun,
            evidence: unique([
              ...evidence,
              `unexpected_files: ${changedOutsideAllowlist.join(", ")}`
            ]),
            openQuestions: [
              "Tighten worker instructions to enforce allowlist-only writes."
            ],
            providerModelSelection
          });
        }

        const changedForbiddenFiles = changedFiles.filter((file) => forbiddenFiles.some((scopeEntry) => isPathWithinScope(file, scopeEntry)));
        if (changedForbiddenFiles.length > 0) {
          return failedResult("process worker failed: worker changed forbidden files", {
            changedFiles,
            commandsRun,
            observedCommandsRun,
            evidence: unique([
              ...evidence,
              `forbidden_files_changed: ${changedForbiddenFiles.join(", ")}`
            ]),
            openQuestions: [
              "Narrow the packet scope or remove conflicting forbidden paths."
            ],
            providerModelSelection
          });
        }

        if (isReadOnlyRole && structuredReadOnlyOutput) {
          const commandObservations = deriveProcessBackendCommandObservations(observedCommandsRun);
          return finalizeWorkerResult(createWorkerResult({
            status: structuredReadOnlyOutput.status,
            summary: structuredReadOnlyOutput.summary,
            changedFiles,
            commandsRun,
            ...(commandObservations.length > 0 ? { commandObservations } : {}),
            evidence: unique([
              ...evidence,
              ...structuredReadOnlyOutput.evidence,
              "read_only_structured_output_valid: true",
              `read_only_structured_output_source: ${readOnlyStructuredOutputSource ?? "unknown"}`,
              "allowlist_enforced: true",
              "recursive_delegation_forbidden: true",
              "repository_changes_applied: not_applicable"
            ]),
            openQuestions: structuredReadOnlyOutput.openQuestions,
            ...(Object.prototype.hasOwnProperty.call(structuredReadOnlyOutput, "reviewFindings")
              ? { reviewFindings: structuredReadOnlyOutput.reviewFindings }
              : {}),
            providerModelSelection
          }));
        }

        if (isReadOnlyRole && !structuredReadOnlyOutput) {
          return failedResult(`${packet.role} process worker failed: invalid structured read-only output after retry`, {
            changedFiles,
            commandsRun,
            observedCommandsRun,
            evidence: unique([
              ...evidence,
              "read_only_structured_output_valid_retry_attempt: false",
              "read_only_retry_failure_reason: first_and_retry_outputs_invalid_json",
              "read_only_structured_output_valid: false"
            ]),
            openQuestions: [
              `Return valid JSON for ${packet.role} with status, summary, evidence, and openQuestions; output one JSON object only.`
            ],
            providerModelSelection
          });
        }

        const sandboxSummary = sandboxConfig.osSandbox
          ? "inside an OS sandbox"
          : "not OS sandboxing";
        const successSummary = READ_ONLY_ROLES.has(packet.role)
          ? `${packet.role} process worker succeeded: non-interactive bounded read-only execution completed with workspace diff observation, ${sandboxSummary}`
          : `implementer process worker succeeded: non-interactive bounded worker launch completed with workspace diff observation, ${sandboxSummary}`;
        const validationEvidence = extractValidationEvidence(launchResult);

        if (
          packet.role === "implementer"
          && !implementerHasReviewableCompletionEvidence({
            changedFiles
          })
        ) {
          return blockedResult(
            "implementer process worker blocked: launcher exited 0 but no changed files were captured by workspace diff observation",
            {
              changedFiles,
              commandsRun,
              observedCommandsRun,
              evidence: unique([
                ...evidence,
                "implementer_completion_evidence: absent",
                "structured_result_captured: false",
                `validation_evidence_captured: ${validationEvidence.length > 0 ? "untrusted_launcher_reported" : "false"}`,
                "repository_changes_applied: false"
              ]),
              openQuestions: [
                "Capture a scoped file change before treating this implementer run as complete; launcher-reported validationEvidence alone is not completion proof."
              ],
              providerModelSelection
            }
          );
        }

        if (packet.role === "implementer" && changedFiles.length > 0) {
          await applyChangedFilesToRepository({
            repositoryRoot: normalizedRepositoryRoot,
            workspaceRoot,
            changedFiles,
            moveFileFn
          });
        }

        return successResult(successSummary, {
          changedFiles,
          commandsRun,
          observedCommandsRun,
          evidence: unique([
            ...evidence,
            ...validationEvidence.map((entry) => `validation_evidence: ${entry}`),
            packet.role === "implementer"
              ? `repository_changes_applied: ${changedFiles.length > 0 ? "true" : "false"}`
              : "repository_changes_applied: not_applicable",
            packet.role === "implementer"
              ? `validation_evidence_captured: ${validationEvidence.length > 0 ? "true" : "false"}`
              : "validation_evidence_captured: not_applicable",
            "allowlist_enforced: true",
            "recursive_delegation_forbidden: true"
          ]),
          changedSurfaceObservation: packet.role === "implementer"
            ? {
              capture: "complete",
              paths: changedFiles
            }
            : null,
          providerModelSelection
        });
      } catch (error) {
        const commandsRun = inferCommandsRun(launchResult);
        const observedCommandsRun = inferObservedCommandsRun(launchResult);
        const evidence = workspaceRoot
          ? buildEvidence({
            launchResult,
            repositoryRoot: normalizedRepositoryRoot,
            workspaceRoot,
            allowedFiles,
            contextFiles,
            copiedSeedFiles,
            missingSeedFiles,
            changedFiles,
            sandboxConfig
          })
          : ["workspace was not created"];

        return failedResult(`process worker failed: ${errorMessage(error)}`, {
          changedFiles,
          commandsRun,
          observedCommandsRun,
          evidence,
          openQuestions: ["Inspect process-worker-backend runtime logs and launcher setup."],
          providerModelSelection
        });
      } finally {
        if (!keepWorkspace && workspaceRoot) {
          try {
            await rm(workspaceRoot, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup only; worker result already carries execution evidence.
          }
        }
      }
    },

    getCalls() {
      return clone(calls);
    },

    getTimeoutBudgetMs() {
      if (typeof launcher.getTimeoutBudgetMs !== "function") {
        return null;
      }

      return launcher.getTimeoutBudgetMs();
    }
  };
  if (trustedBackendProvenance) {
    TRUSTED_PROCESS_WORKER_BACKENDS.add(backend);
    TRUSTED_PROCESS_WORKER_BACKEND_PROVENANCE.set(backend, trustedBackendProvenance);
  }
  return backend;
}

export const PROCESS_WORKER_SUPPORTED_ROLE = SUPPORTED_ROLES[0];
export const PROCESS_WORKER_SUPPORTED_ROLES = SUPPORTED_ROLES;
export const PROCESS_WORKER_DEFAULT_LAUNCH_TIMEOUT_MS = DEFAULT_LAUNCH_TIMEOUT_MS;
export const PROCESS_WORKER_PROVIDER_ID = PROCESS_PROVIDER_OPENAI_CODEX;
export const PROCESS_WORKER_MODEL_CANDIDATES = PROCESS_MODEL_PROBE_DEFAULT_CANDIDATES;
export const PROCESS_WORKER_FALLBACK_MODEL = PROCESS_MODEL_FALLBACK;
export const PROCESS_WORKER_ROLE_PROFILES = PROCESS_ROLE_PROFILES;
export const PROCESS_WORKER_SANDBOX_POLICIES = Object.freeze({
  REQUIRED: PROCESS_SANDBOX_REQUIRED,
  DISABLED: PROCESS_SANDBOX_DISABLED
});
