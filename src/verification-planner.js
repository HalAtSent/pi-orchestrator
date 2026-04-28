import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { isPathWithinScope, normalizeRelativeScopePath, normalizeScopedPath } from "./path-scopes.js";

export const VERIFICATION_CONFIDENCE = Object.freeze([
  "high",
  "medium",
  "low",
  "unknown"
]);

export const SPEC_DRIFT_OUTCOMES = Object.freeze([
  "none_detected",
  "possible_drift",
  "drift_detected",
  "not_enough_evidence"
]);

const SKIPPED_SCAN_DIRS = new Set([
  ".git",
  ".pi",
  ".next",
  "coverage",
  "dist",
  "node_modules"
]);

const DIRECT_NODE_TEST_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".mjs"
]);

const GOAL_STOP_WORDS = new Set([
  "and",
  "are",
  "bounded",
  "contract",
  "declared",
  "execute",
  "file",
  "files",
  "for",
  "from",
  "goal",
  "into",
  "one",
  "scope",
  "scoped",
  "scope-locked",
  "the",
  "this",
  "with"
]);
const COMMAND_LIKE_EXECUTABLES = new Set([
  "bun",
  "cargo",
  "cmake",
  "deno",
  "dotnet",
  "gradle",
  "jest",
  "mvn",
  "node",
  "npm",
  "npx",
  "pnpm",
  "poetry",
  "pytest",
  "python",
  "python3",
  "ruby",
  "swift",
  "uv",
  "vitest",
  "xcodebuild",
  "yarn"
]);

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCommand(value) {
  return normalizeString(value).replace(/\s+/gu, " ");
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? unique(value.map(normalizeCommand).filter((entry) => entry.length > 0))
    : [];
}

export function isCommandLikeVerificationEntry(value) {
  const normalized = normalizeCommand(value);
  if (normalized.length === 0) {
    return false;
  }

  const [firstToken] = normalized.split(/\s+/u);
  if (!firstToken) {
    return false;
  }

  const executable = firstToken
    .replace(/^["']|["']$/gu, "")
    .split(/[\\/]/u)
    .at(-1)
    .toLowerCase();

  if (COMMAND_LIKE_EXECUTABLES.has(executable)) {
    return true;
  }

  return normalized.includes(" --")
    || normalized.includes(" | ")
    || normalized.includes(" && ")
    || normalized.includes(" || ");
}

function normalizeScopeList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const paths = [];
  for (const pathValue of value) {
    try {
      paths.push(normalizeRelativeScopePath(pathValue));
    } catch {
      const normalized = normalizeString(pathValue);
      if (normalized.length > 0) {
        paths.push(normalizeScopedPath(normalized));
      }
    }
  }

  return unique(paths.filter((entry) => entry.length > 0));
}

function commandAliases(command) {
  const normalized = normalizeCommand(command);
  if (normalized === "npm test") {
    return ["npm test", "npm run test"];
  }
  if (normalized === "npm run test") {
    return ["npm run test", "npm test"];
  }
  return [normalized];
}

function commandWasRun(command, commandsRun) {
  const observed = new Set(commandsRun.flatMap((entry) => commandAliases(entry)));
  return commandAliases(command).some((alias) => observed.has(alias));
}

async function readPackageJson(repositoryRoot) {
  try {
    const raw = await readFile(join(repositoryRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function scanRepoFiles(repositoryRoot, directory = "") {
  let entries;
  try {
    entries = await readdir(join(repositoryRoot, directory), {
      withFileTypes: true
    });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (SKIPPED_SCAN_DIRS.has(entry.name)) {
      continue;
    }

    const relativePath = normalizeScopedPath(directory.length > 0
      ? `${directory}/${entry.name}`
      : entry.name);
    if (entry.isDirectory()) {
      files.push(...await scanRepoFiles(repositoryRoot, relativePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

async function resolveRepoFiles({ repositoryRoot, repoFiles }) {
  if (Array.isArray(repoFiles)) {
    return unique(repoFiles
      .map((pathValue) => normalizeString(pathValue))
      .filter((pathValue) => pathValue.length > 0)
      .map((pathValue) => normalizeScopedPath(pathValue)));
  }

  return scanRepoFiles(repositoryRoot);
}

function scriptCommand(scriptName) {
  return scriptName === "test"
    ? "npm test"
    : `npm run ${scriptName}`;
}

function isVerificationScript(scriptName, scriptBody) {
  const normalizedName = normalizeString(scriptName).toLowerCase();
  const normalizedBody = normalizeString(scriptBody).toLowerCase();

  if (/(^|:)(test|unit|integration|e2e|spec|check|lint|typecheck|build)(:|$)/u.test(normalizedName)) {
    return true;
  }

  return /\b(node\s+--test|vitest|jest|mocha|tap|ava|eslint|tsc|biome|prettier\s+--check)\b/u.test(normalizedBody);
}

function packageScriptCandidates(packageJson) {
  const scripts = packageJson && typeof packageJson.scripts === "object" && !Array.isArray(packageJson.scripts)
    ? packageJson.scripts
    : {};
  return Object.keys(scripts)
    .sort()
    .map((scriptName) => {
      const body = normalizeString(scripts[scriptName]);
      const command = scriptCommand(scriptName);
      return {
        id: `package:${scriptName}`,
        command,
        source: "package_script",
        reason: isVerificationScript(scriptName, body)
          ? `package.json script "${scriptName}" is verification-like`
          : `package.json script "${scriptName}" is not test/build/lint/check-like`,
        required: false,
        verificationLike: isVerificationScript(scriptName, body)
      };
    });
}

function isTestLikeFile(pathValue) {
  const normalized = normalizeScopedPath(pathValue);
  const lower = normalized.toLowerCase();
  const base = basename(lower);
  return (
    /(^|\/)(__tests__|test|tests)\//u.test(lower)
    || /\.(test|spec)\.[cm]?jsx?$/u.test(base)
    || /[-_](test|spec)\.[cm]?jsx?$/u.test(base)
  );
}

function stripKnownTestSuffix(pathValue) {
  const base = basename(pathValue).toLowerCase();
  const withoutExtension = base.slice(0, base.length - extname(base).length);
  return withoutExtension
    .replace(/\.(test|spec)$/u, "")
    .replace(/[-_](test|spec)$/u, "");
}

function scopeStem(pathValue) {
  const normalized = normalizeScopedPath(pathValue);
  if (normalized.endsWith("/")) {
    const segments = normalized.split("/").filter(Boolean);
    return segments[segments.length - 1]?.toLowerCase() ?? "";
  }

  const base = basename(normalized).toLowerCase();
  return base.slice(0, base.length - extname(base).length);
}

function isNearScope(testFile, scopePaths) {
  const testStem = stripKnownTestSuffix(testFile);
  if (testStem.length === 0) {
    return false;
  }

  return scopePaths.some((scopePath) => {
    const stem = scopeStem(scopePath);
    return stem.length > 0 && testStem === stem;
  });
}

function testFileCommand(pathValue) {
  return `node --test ${pathValue}`;
}

function nearbyTestCandidates(repoFiles, scopePaths) {
  return repoFiles
    .filter(isTestLikeFile)
    .filter((pathValue) => isNearScope(pathValue, scopePaths))
    .sort()
    .map((pathValue) => {
      const extension = extname(pathValue).toLowerCase();
      const runnable = DIRECT_NODE_TEST_EXTENSIONS.has(extension);
      return {
        id: `nearby-test:${pathValue}`,
        command: testFileCommand(pathValue),
        source: "nearby_test_file",
        reason: runnable
          ? `test-like file near planned scope: ${pathValue}`
          : `test-like file near planned scope is not directly runnable by node --test: ${pathValue}`,
        required: false,
        runnable
      };
    });
}

function addSelectedCheck(selectedChecks, check) {
  if (selectedChecks.some((entry) => normalizeCommand(entry.command) === normalizeCommand(check.command))) {
    return false;
  }

  selectedChecks.push({
    id: check.id,
    command: normalizeCommand(check.command),
    source: check.source,
    reason: check.reason,
    required: check.required === true
  });
  return true;
}

function addSkippedCheck(skippedCandidateChecks, check, reason) {
  skippedCandidateChecks.push({
    id: check.id,
    command: normalizeCommand(check.command),
    source: check.source,
    reason
  });
}

function classifyPlanConfidence(selectedChecks) {
  if (selectedChecks.some((check) => check.source === "contract_verification_plan")) {
    return "high";
  }
  if (selectedChecks.some((check) => check.source === "nearby_test_file")) {
    return "medium";
  }
  if (selectedChecks.length > 0) {
    return "low";
  }
  return "unknown";
}

export async function buildVerificationPlan({
  contractVerificationPlan = [],
  packageJson = null,
  plannedScope = [],
  touchedScope = [],
  repositoryRoot = process.cwd(),
  repoFiles = null
} = {}) {
  const selectedChecks = [];
  const skippedCandidateChecks = [];
  const contractPlanEntries = normalizeStringList(contractVerificationPlan);
  const explicitCommands = contractPlanEntries.filter(isCommandLikeVerificationEntry);
  const advisoryVerificationGuidance = contractPlanEntries.filter((entry) => (
    !isCommandLikeVerificationEntry(entry)
  ));
  const scopePaths = unique([
    ...normalizeScopeList(plannedScope),
    ...normalizeScopeList(touchedScope)
  ]);

  for (const [index, command] of explicitCommands.entries()) {
    addSelectedCheck(selectedChecks, {
      id: `contract:${index + 1}`,
      command,
      source: "contract_verification_plan",
      reason: "declared by contract verificationPlan",
      required: true
    });
  }

  for (const [index, guidance] of advisoryVerificationGuidance.entries()) {
    addSelectedCheck(selectedChecks, {
      id: `contract-guidance:${index + 1}`,
      command: guidance,
      source: "contract_verification_plan",
      reason: "declared by contract verificationPlan as advisory non-command guidance",
      required: false
    });
  }

  const resolvedPackageJson = packageJson ?? await readPackageJson(repositoryRoot);
  const packageCandidates = packageScriptCandidates(resolvedPackageJson);
  const hasExplicitCommands = explicitCommands.length > 0;
  for (const candidate of packageCandidates) {
    if (!candidate.verificationLike) {
      addSkippedCheck(skippedCandidateChecks, candidate, candidate.reason);
      continue;
    }

    if (selectedChecks.some((entry) => normalizeCommand(entry.command) === normalizeCommand(candidate.command))) {
      addSkippedCheck(skippedCandidateChecks, candidate, "duplicate of an already selected check");
      continue;
    }

    if (hasExplicitCommands) {
      addSkippedCheck(
        skippedCandidateChecks,
        candidate,
        "contract verificationPlan already declares required verification checks"
      );
      continue;
    }

    addSelectedCheck(selectedChecks, candidate);
  }

  const resolvedRepoFiles = await resolveRepoFiles({
    repositoryRoot,
    repoFiles
  });
  for (const candidate of nearbyTestCandidates(resolvedRepoFiles, scopePaths)) {
    if (!candidate.runnable) {
      addSkippedCheck(skippedCandidateChecks, candidate, candidate.reason);
      continue;
    }

    if (selectedChecks.some((entry) => normalizeCommand(entry.command) === normalizeCommand(candidate.command))) {
      addSkippedCheck(skippedCandidateChecks, candidate, "duplicate of an already selected check");
      continue;
    }

    if (hasExplicitCommands) {
      addSkippedCheck(
        skippedCandidateChecks,
        candidate,
        "contract verificationPlan already declares required verification checks"
      );
      continue;
    }

    addSelectedCheck(selectedChecks, candidate);
  }

  return {
    selectedChecks,
    skippedCandidateChecks,
    requiredChecksNotRun: [],
    confidence: classifyPlanConfidence(selectedChecks)
  };
}

export function evaluateVerificationPlanRun(plan, { commandsRun = [] } = {}) {
  const selectedChecks = Array.isArray(plan?.selectedChecks) ? plan.selectedChecks : [];
  const observedCommands = normalizeStringList(commandsRun);
  const requiredChecksNotRun = selectedChecks
    .filter((check) => check?.required === true)
    .filter((check) => !commandWasRun(check.command, observedCommands))
    .map((check) => ({
      id: check.id,
      command: check.command,
      source: check.source,
      reason: "required verification check was not reported by verifier commandsRun"
    }));

  return {
    selectedChecks,
    skippedCandidateChecks: Array.isArray(plan?.skippedCandidateChecks) ? plan.skippedCandidateChecks : [],
    requiredChecksNotRun,
    confidence: requiredChecksNotRun.length > 0
      ? "low"
      : (VERIFICATION_CONFIDENCE.includes(plan?.confidence) ? plan.confidence : "unknown")
  };
}

export function formatVerificationPlanEvidence(plan) {
  const selectedChecks = Array.isArray(plan?.selectedChecks) ? plan.selectedChecks : [];
  const skippedCandidateChecks = Array.isArray(plan?.skippedCandidateChecks) ? plan.skippedCandidateChecks : [];
  const requiredChecksNotRun = Array.isArray(plan?.requiredChecksNotRun) ? plan.requiredChecksNotRun : [];
  const confidence = VERIFICATION_CONFIDENCE.includes(plan?.confidence) ? plan.confidence : "unknown";
  const lines = [`verification_plan_confidence: ${confidence}`];

  for (const check of selectedChecks) {
    if (check?.source === "contract_verification_plan" && check?.required === true) {
      lines.push(`required verification command: ${check.command}`);
    }
    lines.push(
      `verification_selected_check: ${check.required === true ? "required" : "advisory"} | ${check.source} | ${check.command} | ${check.reason}`
    );
  }

  for (const check of skippedCandidateChecks) {
    lines.push(`verification_skipped_candidate: ${check.source} | ${check.command} | ${check.reason}`);
  }

  for (const check of requiredChecksNotRun) {
    lines.push(`verification_required_not_run: ${check.command}`);
  }

  return lines;
}

function goalTokens(value) {
  return new Set(
    normalizeString(value)
      .toLowerCase()
      .split(/[^a-z0-9-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !GOAL_STOP_WORDS.has(token))
  );
}

function intersectionCount(left, right) {
  let count = 0;
  for (const entry of left) {
    if (right.has(entry)) {
      count += 1;
    }
  }
  return count;
}

function normalizeRepoPathCandidate(value) {
  const normalized = normalizeString(value);
  if (normalized.length === 0 || normalized.includes("://")) {
    return null;
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    return null;
  }

  try {
    return normalizeRelativeScopePath(normalized);
  } catch {
    return null;
  }
}

function pathWithinAnyScope(pathValue, scopePaths) {
  if (scopePaths.length === 0) {
    return false;
  }

  return scopePaths.some((scopePath) => isPathWithinScope(pathValue, scopePath));
}

function extractRepoPathMentions(textValues) {
  const mentions = [];
  const pattern = /(?:^|[\s("'`])((?:(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+))(?=$|[\s).,"'`])/gu;

  for (const textValue of textValues) {
    const text = normalizeString(textValue);
    if (text.length === 0) {
      continue;
    }

    for (const match of text.matchAll(pattern)) {
      const pathValue = normalizeRepoPathCandidate(match[1]);
      if (pathValue) {
        mentions.push(pathValue);
      }
    }
  }

  return unique(mentions);
}

function addSignal(signals, kind, detail) {
  signals.push({ kind, detail });
}

export function detectSpecDrift({
  originalGoal = null,
  contractGoal = null,
  boundedGoal = null,
  allowedFileScope = [],
  changedSurface = null,
  workerSummaries = [],
  workerEvidence = [],
  workerChangedFiles = []
} = {}) {
  const requestTokens = goalTokens(`${normalizeString(originalGoal)} ${normalizeString(contractGoal)}`);
  const boundedTokens = goalTokens(boundedGoal);
  const scopePaths = normalizeScopeList(allowedFileScope);
  const signals = [];

  if (requestTokens.size > 0 && boundedTokens.size > 0 && intersectionCount(requestTokens, boundedTokens) === 0) {
    addSignal(signals, "bounded_goal_token_mismatch", "compiled bounded goal has no significant token overlap with the requested or contract goal");
  }

  const changedSurfaceCapture = normalizeString(changedSurface?.capture);
  const changedSurfacePaths = Array.isArray(changedSurface?.paths)
    ? changedSurface.paths.map(normalizeRepoPathCandidate).filter(Boolean)
    : [];
  for (const pathValue of changedSurfacePaths) {
    if (!pathWithinAnyScope(pathValue, scopePaths)) {
      addSignal(signals, "changed_surface_outside_scope", pathValue);
    }
  }

  const reportedChangedFiles = normalizeScopeList(workerChangedFiles);
  for (const pathValue of reportedChangedFiles) {
    if (!pathWithinAnyScope(pathValue, scopePaths)) {
      addSignal(signals, "worker_changed_file_outside_scope", pathValue);
    }
  }

  const pathMentions = extractRepoPathMentions([
    ...normalizeStringList(workerSummaries),
    ...normalizeStringList(workerEvidence)
  ]);
  for (const pathValue of pathMentions) {
    if (!pathWithinAnyScope(pathValue, scopePaths)) {
      addSignal(signals, "summary_or_evidence_mentions_outside_scope", pathValue);
    }
  }

  const hasSummaryOrEvidence = normalizeStringList([
    ...workerSummaries,
    ...workerEvidence
  ]).length > 0;
  const hasChangedSurfaceEvidence = (changedSurfaceCapture === "complete" || changedSurfaceCapture === "partial")
    && changedSurfacePaths.length > 0;
  if (!hasSummaryOrEvidence && !hasChangedSurfaceEvidence) {
    return {
      outcome: "not_enough_evidence",
      signals: [
        {
          kind: "missing_summary_evidence_and_changed_surface",
          detail: "no worker summary/evidence or changed-surface paths were available for deterministic drift comparison"
        }
      ]
    };
  }

  if (signals.some((signal) => signal.kind === "bounded_goal_token_mismatch")) {
    return {
      outcome: "drift_detected",
      signals
    };
  }

  if (signals.length > 0) {
    return {
      outcome: "possible_drift",
      signals
    };
  }

  return {
    outcome: "none_detected",
    signals: []
  };
}

export function formatSpecDriftEvidence(specDrift) {
  const outcome = SPEC_DRIFT_OUTCOMES.includes(specDrift?.outcome)
    ? specDrift.outcome
    : "not_enough_evidence";
  const lines = [`spec_drift_outcome: ${outcome}`];
  const signals = Array.isArray(specDrift?.signals) ? specDrift.signals : [];
  for (const signal of signals) {
    const kind = normalizeString(signal?.kind) || "unknown_signal";
    const detail = normalizeString(signal?.detail) || "no detail";
    lines.push(`spec_drift_signal: ${kind}: ${detail}`);
  }
  return lines;
}
