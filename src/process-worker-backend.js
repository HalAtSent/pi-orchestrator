import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, rename, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { createTaskPacket, createWorkerResult, RESULT_STATUSES } from "./contracts.js";
import { isPathWithinScope, normalizeScopedPath } from "./path-scopes.js";
import {
  createCachedProcessModelProbe,
  PROCESS_MODEL_PROBE_DEFAULT_CANDIDATES,
  PROCESS_MODEL_PROBE_DEFAULT_PROVIDER
} from "./process-model-probe.js";
import { getPiSpawnCommand } from "./pi-spawn.js";
import { safeClone } from "./safe-clone.js";

const SUPPORTED_ROLES = Object.freeze(["explorer", "implementer", "reviewer", "verifier"]);
const READ_ONLY_ROLES = new Set(["explorer", "reviewer", "verifier"]);
const DEFAULT_TEMP_PREFIX = "pi-orchestrator-process-worker-";
const DEFAULT_APPLY_TEMP_PREFIX = ".pi-orchestrator-apply-";
const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000;
const IMPLICIT_PI_DEFAULT_SELECTION = "implicit_pi_default";
const EXPLICIT_PROVIDER_MODEL_OVERRIDE_MODE = "explicit_provider_model_override";
const EXPLICIT_FLAG_WITHOUT_VALUE = "explicit_requested_without_value";
const PROCESS_PROVIDER_OPENAI_CODEX = PROCESS_MODEL_PROBE_DEFAULT_PROVIDER;
const PROCESS_MODEL_FALLBACK = "gpt-5.4";
const MODEL_SELECTION_DIRECT = "direct";
const MODEL_SELECTION_FALLBACK = "fallback";
const MODEL_SELECTION_BLOCKED = "blocked";
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
    preferredModel: "gpt-5.4",
    thinking: "high"
  }),
  implementer: Object.freeze({
    provider: PROCESS_PROVIDER_OPENAI_CODEX,
    preferredModel: "gpt-5.3-codex",
    thinking: "medium"
  }),
  reviewer: Object.freeze({
    provider: PROCESS_PROVIDER_OPENAI_CODEX,
    preferredModel: "gpt-5.4",
    thinking: "high"
  }),
  verifier: Object.freeze({
    provider: PROCESS_PROVIDER_OPENAI_CODEX,
    preferredModel: "gpt-5.4-mini",
    thinking: "medium"
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

function truncate(text, maxLength = 1200) {
  const normalized = String(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...[truncated ${normalized.length - maxLength} chars]`;
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

  return {
    status,
    summary,
    evidence: normalizeStringArray(parsed.evidence),
    openQuestions: normalizeStringArray(parsed.openQuestions)
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

function createBlockedResult(summary, {
  commandsRun = [],
  evidence = [],
  openQuestions = []
} = {}) {
  return createWorkerResult({
    status: "blocked",
    summary,
    changedFiles: [],
    commandsRun: normalizeStringArray(commandsRun),
    evidence: normalizeStringArray(evidence),
    openQuestions: normalizeStringArray(openQuestions)
  });
}

function createFailedResult(summary, {
  changedFiles = [],
  commandsRun = [],
  evidence = [],
  openQuestions = [],
  providerModelSelection = null
} = {}) {
  return createWorkerResult({
    status: "failed",
    summary,
    changedFiles: normalizeStringArray(changedFiles),
    commandsRun: normalizeStringArray(commandsRun),
    evidence: normalizeStringArray(evidence),
    openQuestions: normalizeStringArray(openQuestions),
    providerModelSelection
  });
}

function createSuccessResult(summary, {
  changedFiles = [],
  commandsRun = [],
  evidence = [],
  changedSurfaceObservation = null,
  providerModelSelection = null
} = {}) {
  return createWorkerResult({
    status: "success",
    summary,
    changedFiles: normalizeStringArray(changedFiles),
    commandsRun: normalizeStringArray(commandsRun),
    evidence: normalizeStringArray(evidence),
    openQuestions: [],
    changedSurfaceObservation,
    providerModelSelection
  });
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

function assertWithinRoot(rootPath, absolutePath, label) {
  const relativePath = normalizePath(relative(rootPath, absolutePath));
  const outsideRoot = relativePath === ".." || relativePath.startsWith("../");
  assert(!outsideRoot, `${label} resolves outside the expected root`);
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

      const destinationPath = resolve(normalizedRepositoryRoot, changedFile);
      assertWithinRoot(normalizedRepositoryRoot, destinationPath, "repository changed file");

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
        await mkdir(dirname(stagedPath), { recursive: true });
        await copyFile(sourcePath, stagedPath);
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
        await mkdir(dirname(operation.backupPath), { recursive: true });
        await moveFileFn(operation.destinationPath, operation.backupPath);
        operation.backupCreated = true;
      }

      if (operation.sourceExists) {
        await mkdir(dirname(operation.destinationPath), { recursive: true });
        await moveFileFn(operation.stagedPath, operation.destinationPath);
        operation.destinationApplied = true;
      }
    }
  } catch (error) {
    if (commitStarted) {
      let rollbackError = null;
      for (const operation of [...operations].reverse()) {
        try {
          if (operation.destinationApplied) {
            await rm(operation.destinationPath, { force: true });
            operation.destinationApplied = false;
          }

          if (operation.backupCreated) {
            await mkdir(dirname(operation.destinationPath), { recursive: true });
            await moveFileFn(operation.backupPath, operation.destinationPath);
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
  const previousOutputSnippet = truncate(previousStdout ?? "", 600).replace(/\r?\n/gu, "\\n");
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

async function runCommand({ command, args, cwd, timeoutMs }) {
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    let childProcess;
    try {
      childProcess = spawn(command, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
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
        error,
        durationMs: Date.now() - startedAt
      });
      return;
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      childProcess.kill();
    }, timeoutMs);

    function finalize(result) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolveResult({
        ...result,
        durationMs: Date.now() - startedAt
      });
    }

    childProcess.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    childProcess.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
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

function normalizeProcessRoleProfiles(roleProfilesInput) {
  assert(roleProfilesInput && typeof roleProfilesInput === "object", "roleProfiles must be an object");
  const normalized = {};

  for (const role of SUPPORTED_ROLES) {
    const profile = roleProfilesInput[role];
    assert(profile && typeof profile === "object", `role profile for ${role} must be an object`);

    const provider = typeof profile.provider === "string" && profile.provider.trim().length > 0
      ? profile.provider.trim()
      : PROCESS_PROVIDER_OPENAI_CODEX;
    const preferredModel = typeof profile.preferredModel === "string" && profile.preferredModel.trim().length > 0
      ? profile.preferredModel.trim()
      : PROCESS_MODEL_FALLBACK;
    const thinking = typeof profile.thinking === "string" && profile.thinking.trim().length > 0
      ? profile.thinking.trim()
      : "off";

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
  modelProbe = createCachedProcessModelProbe({
    providerId: PROCESS_PROVIDER_OPENAI_CODEX,
    candidateModels: PROCESS_MODEL_PROBE_DEFAULT_CANDIDATES
  })
} = {}) {
  assert(typeof modelProbe === "function", "modelProbe(options) must be a function");
  const normalizedRoleProfiles = normalizeProcessRoleProfiles(roleProfiles);
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

function buildEvidence({
  launchResult,
  repositoryRoot,
  workspaceRoot,
  allowedFiles,
  contextFiles,
  copiedSeedFiles,
  missingSeedFiles,
  changedFiles
}) {
  const launchProfile = describeLaunchProfile(launchResult?.args);
  const evidence = [
    `repository_root: ${repositoryRoot}`,
    `workspace: ${workspaceRoot}`,
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

  if (launchResult && launchResult.exitCode !== null && launchResult.exitCode !== undefined) {
    evidence.push(`exit_code: ${launchResult.exitCode}`);
  }

  if (launchResult?.signal) {
    evidence.push(`signal: ${launchResult.signal}`);
  }

  if (launchResult?.timedOut) {
    evidence.push("timed_out: true");
  }

  if (launchResult?.stdout) {
    evidence.push(`stdout: ${truncate(launchResult.stdout)}`);
  }

  if (launchResult?.stderr) {
    evidence.push(`stderr: ${truncate(launchResult.stderr)}`);
  }

  if (launchResult?.error) {
    evidence.push(`launch_error: ${errorMessage(launchResult.error)}`);
  }

  return evidence.map((line) => String(line));
}

export function createProcessPiCliLauncher({
  timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
  argsBuilder,
  roleProfiles = PROCESS_ROLE_PROFILES,
  fallbackModel = PROCESS_MODEL_FALLBACK,
  roleContractGuidanceLoader = getRoleContractGuidance,
  modelProbe = createCachedProcessModelProbe({
    providerId: PROCESS_PROVIDER_OPENAI_CODEX,
    candidateModels: PROCESS_MODEL_PROBE_DEFAULT_CANDIDATES
  }),
  spawnCommandResolver = getPiSpawnCommand,
  runCommandFn = runCommand
} = {}) {
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0, "pi launcher timeoutMs must be a positive integer");
  assert(typeof roleContractGuidanceLoader === "function", "roleContractGuidanceLoader() must be a function");
  assert(typeof spawnCommandResolver === "function", "spawnCommandResolver(options) must be a function");
  assert(typeof runCommandFn === "function", "runCommandFn(request) must be a function");
  const resolvedArgsBuilder = typeof argsBuilder === "function"
    ? argsBuilder
    : createProcessRoleArgsBuilder({
      roleProfiles,
      fallbackModel,
      modelProbe
    });

  return async function launchPiWorker({
    packet,
    context,
    workspaceRoot,
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
        launcher: "pi_cli_args_builder_error",
        launcherPath: null,
        piScriptPath: null,
        piPackageRoot: null,
        piSpawnResolution: "worker launcher arguments could not be resolved",
        commandsRun: [],
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
        launcher: "pi_cli_resolution_error",
        launcherPath: null,
        piScriptPath: null,
        piPackageRoot: null,
        piSpawnResolution: `pi spawn command resolution failed: ${errorMessage(error)}`,
        commandsRun: [],
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
        launcher: spawnCommand?.launcher ?? "pi_cli_unresolved",
        launcherPath: spawnCommand?.launcherPath ?? null,
        piScriptPath: spawnCommand?.piScriptPath ?? null,
        piPackageRoot: spawnCommand?.piPackageRoot ?? null,
        piSpawnResolution: spawnCommand?.resolutionMessage ?? "pi spawn command resolution returned no script path",
        commandsRun: [],
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
        launcher: spawnCommand?.launcher ?? "pi_cli",
        launcherPath: spawnCommand?.launcherPath ?? null,
        piScriptPath: spawnCommand?.piScriptPath ?? null,
        piPackageRoot: spawnCommand?.piPackageRoot ?? null,
        piSpawnResolution: spawnCommand?.resolutionMessage ?? "pi spawn command resolution returned an empty command",
        commandsRun: [],
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
        timeoutMs
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
        durationMs: 0
      };
    }

    return {
      ...launchResult,
      launcher: spawnCommand?.launcher ?? "pi_cli",
      launcherPath: spawnCommand?.launcherPath ?? command,
      piScriptPath: spawnCommand?.piScriptPath ?? null,
      piPackageRoot: spawnCommand?.piPackageRoot ?? null,
      piSpawnResolution: spawnCommand?.resolutionMessage ?? null,
      commandsRun: [formatCommand(command, fullArgs)],
      launchProfile,
      launchSelection
    };
  };
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
  moveFileFn = rename
} = {}) {
  assert(typeof launcher === "function", "launcher(request) is required");
  assert(typeof repositoryRoot === "string" && repositoryRoot.length > 0, "repositoryRoot must be a non-empty string");
  assert(typeof keepWorkspace === "boolean", "keepWorkspace must be a boolean");
  assert(typeof tempPrefix === "string" && tempPrefix.length > 0, "tempPrefix must be a non-empty string");
  assert(typeof moveFileFn === "function", "moveFileFn(sourcePath, destinationPath) must be a function");

  const normalizedRepositoryRoot = resolve(repositoryRoot);
  const calls = [];

  return {
    async run(packetInput, contextInput = {}) {
      calls.push({
        packet: clone(packetInput),
        context: clone(contextInput)
      });

      let packet;
      try {
        packet = createTaskPacket(clone(packetInput));
      } catch (error) {
        return createBlockedResult(`process worker blocked: invalid packet (${errorMessage(error)})`, {
          evidence: ["packet validation failed before worker launch"],
          openQuestions: ["Provide a valid task packet that matches src/contracts.js."]
        });
      }

      if (!SUPPORTED_ROLES.includes(packet.role)) {
        return createBlockedResult(`process worker blocked: unsupported role ${packet.role}`, {
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
        return createBlockedResult(`process worker blocked: ${errorMessage(error)}`, {
          evidence: ["packet file paths failed normalization"],
          openQuestions: ["Use only relative file paths inside packet allowlists and context files."]
        });
      }

      if (allowedFiles.length === 0) {
        return createBlockedResult("process worker blocked: packet.allowedFiles must contain at least one file", {
          openQuestions: ["Provide at least one allowed file path for implementer writes."]
        });
      }

      const normalizedPacket = {
        ...packet,
        allowedFiles,
        forbiddenFiles,
        contextFiles
      };

      let workspaceRoot = null;
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

          const destinationPath = resolve(workspaceRoot, seedFile);
          assertWithinRoot(workspaceRoot, destinationPath, "seed destination file");

          const sourceStats = await getPathStats(sourcePath);
          if (sourceStats) {
            await mkdir(dirname(destinationPath), { recursive: true });

            if (sourceStats.isDirectory()) {
              await cp(sourcePath, destinationPath, { recursive: true });
            } else {
              await copyFile(sourcePath, destinationPath);
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
          await mkdir(dirname(targetAbsolutePath), { recursive: true });
        }

        const beforeSnapshot = await snapshotFiles(workspaceRoot);

        launchResult = await launcher({
          packet: clone(normalizedPacket),
          context: clone(contextInput),
          repositoryRoot: normalizedRepositoryRoot,
          workspaceRoot,
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
        let evidence = buildEvidence({
          launchResult,
          repositoryRoot: normalizedRepositoryRoot,
          workspaceRoot,
          allowedFiles,
          contextFiles,
          copiedSeedFiles,
          missingSeedFiles,
          changedFiles
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
          return createBlockedResult(`process worker blocked: launcher invocation failed (${errorMessage(launchResult.error)})`, {
            commandsRun,
            evidence: unique(evidence),
            openQuestions: [
              "Check local permissions, Pi resolution, and worker launcher availability."
            ]
          });
        }

        if (launchResult?.timedOut) {
          return createFailedResult("process worker failed: launcher timed out", {
            changedFiles,
            commandsRun,
            evidence: unique(evidence),
            openQuestions: [
              "Reduce prompt complexity or increase launcher timeout."
            ],
            providerModelSelection
          });
        }

        if (launchResult?.exitCode !== 0) {
          return createFailedResult(`process worker failed: launcher exited with code ${launchResult?.exitCode ?? "unknown"}`, {
            changedFiles,
            commandsRun,
            evidence: unique(evidence),
            openQuestions: [
              "Inspect launcher stdout/stderr and verify non-interactive worker command syntax."
            ],
            providerModelSelection
          });
        }

        if (isReadOnlyRole && changedFiles.length > 0) {
          return createFailedResult(`${packet.role} process worker failed: ${packet.role} modified files`, {
            changedFiles,
            commandsRun,
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
              changedFiles
            }), "retry_")
          ]);

          if (launchResult?.error) {
            return createBlockedResult(`process worker blocked: launcher invocation failed (${errorMessage(launchResult.error)})`, {
              commandsRun,
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
            return createFailedResult("process worker failed: launcher timed out", {
              changedFiles,
              commandsRun,
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
            return createFailedResult(`process worker failed: launcher exited with code ${launchResult?.exitCode ?? "unknown"}`, {
              changedFiles,
              commandsRun,
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
            return createFailedResult(`${packet.role} process worker failed: ${packet.role} modified files`, {
              changedFiles,
              commandsRun,
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
          return createFailedResult("process worker failed: worker changed files outside the allowlist", {
            changedFiles,
            commandsRun,
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
          return createFailedResult("process worker failed: worker changed forbidden files", {
            changedFiles,
            commandsRun,
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
          return createWorkerResult({
            status: structuredReadOnlyOutput.status,
            summary: structuredReadOnlyOutput.summary,
            changedFiles,
            commandsRun,
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
            providerModelSelection
          });
        }

        if (isReadOnlyRole && !structuredReadOnlyOutput) {
          return createFailedResult(`${packet.role} process worker failed: invalid structured read-only output after retry`, {
            changedFiles,
            commandsRun,
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

        const successSummary = READ_ONLY_ROLES.has(packet.role)
          ? `${packet.role} process worker succeeded: non-interactive bounded read-only execution completed in isolated workspace`
          : "implementer process worker succeeded: non-interactive bounded worker launch completed in isolated workspace";

        if (packet.role === "implementer" && changedFiles.length > 0) {
          await applyChangedFilesToRepository({
            repositoryRoot: normalizedRepositoryRoot,
            workspaceRoot,
            changedFiles,
            moveFileFn
          });
        }

        return createSuccessResult(successSummary, {
          changedFiles,
          commandsRun,
          evidence: unique([
            ...evidence,
            packet.role === "implementer"
              ? `repository_changes_applied: ${changedFiles.length > 0 ? "true" : "false"}`
              : "repository_changes_applied: not_applicable",
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
        const evidence = workspaceRoot
          ? buildEvidence({
            launchResult,
            repositoryRoot: normalizedRepositoryRoot,
            workspaceRoot,
            allowedFiles,
            contextFiles,
            copiedSeedFiles,
            missingSeedFiles,
            changedFiles
          })
          : ["workspace was not created"];

        return createFailedResult(`process worker failed: ${errorMessage(error)}`, {
          changedFiles,
          commandsRun,
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
    }
  };
}

export const PROCESS_WORKER_SUPPORTED_ROLE = SUPPORTED_ROLES[0];
export const PROCESS_WORKER_SUPPORTED_ROLES = SUPPORTED_ROLES;
export const PROCESS_WORKER_DEFAULT_LAUNCH_TIMEOUT_MS = DEFAULT_LAUNCH_TIMEOUT_MS;
export const PROCESS_WORKER_PROVIDER_ID = PROCESS_PROVIDER_OPENAI_CODEX;
export const PROCESS_WORKER_MODEL_CANDIDATES = PROCESS_MODEL_PROBE_DEFAULT_CANDIDATES;
export const PROCESS_WORKER_FALLBACK_MODEL = PROCESS_MODEL_FALLBACK;
export const PROCESS_WORKER_ROLE_PROFILES = PROCESS_ROLE_PROFILES;
