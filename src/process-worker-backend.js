import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readdir, rename, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { createTaskPacket, createWorkerResult, RESULT_STATUSES } from "./contracts.js";
import { getPiSpawnCommand } from "./pi-spawn.js";

const SUPPORTED_ROLES = Object.freeze(["explorer", "implementer", "reviewer", "verifier"]);
const READ_ONLY_ROLES = new Set(["explorer", "reviewer", "verifier"]);
const DEFAULT_TEMP_PREFIX = "pi-orchestrator-process-worker-";
const DEFAULT_APPLY_TEMP_PREFIX = ".pi-orchestrator-apply-";
const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function unique(values) {
  return [...new Set(values)];
}

function normalizePath(pathValue) {
  return String(pathValue).replace(/\\/g, "/");
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
  openQuestions = []
} = {}) {
  return createWorkerResult({
    status: "failed",
    summary,
    changedFiles: normalizeStringArray(changedFiles),
    commandsRun: normalizeStringArray(commandsRun),
    evidence: normalizeStringArray(evidence),
    openQuestions: normalizeStringArray(openQuestions)
  });
}

function createSuccessResult(summary, {
  changedFiles = [],
  commandsRun = [],
  evidence = []
} = {}) {
  return createWorkerResult({
    status: "success",
    summary,
    changedFiles: normalizeStringArray(changedFiles),
    commandsRun: normalizeStringArray(commandsRun),
    evidence: normalizeStringArray(evidence),
    openQuestions: []
  });
}

function normalizeRelativeFilePath(pathValue, fieldName) {
  const raw = String(pathValue);
  const normalized = normalizePath(raw).replace(/^\.\/+/u, "");
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

function buildCodexPrompt(packet) {
  if (READ_ONLY_ROLES.has(packet.role)) {
    const roleLabel = packet.role === "explorer"
      ? "explorer"
      : packet.role === "reviewer"
        ? "reviewer"
        : "verifier";
    const roleSpecificRules = packet.role === "explorer"
      ? [
        "- Inspect the allowed scope and identify the relevant code paths.",
        "- Return a structured summary of what matters for implementation."
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
      `Goal: ${packet.goal}`,
      "",
      "Hard rules:",
      "- Do not modify any files.",
      "- Do not delegate work and do not spawn sub-workers.",
      ...roleSpecificRules,
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
      packet.role === "reviewer"
        ? 'Allowed statuses: "success", "repair_required", "blocked".'
        : packet.role === "verifier"
          ? 'Allowed statuses: "success", "failed", "blocked".'
          : 'Allowed statuses: "success", "blocked".'
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
    "- Keep changes minimal and task-scoped.",
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
  const evidence = [
    `repository_root: ${repositoryRoot}`,
    `workspace: ${workspaceRoot}`,
    `allowed_files: ${allowedFiles.join(", ")}`,
    `context_files: ${contextFiles.length === 0 ? "none" : contextFiles.join(", ")}`,
    `copied_seed_files: ${copiedSeedFiles.length === 0 ? "none" : copiedSeedFiles.join(", ")}`,
    `missing_seed_files: ${missingSeedFiles.length === 0 ? "none" : missingSeedFiles.join(", ")}`,
    `changed_files: ${changedFiles.length === 0 ? "none" : changedFiles.join(", ")}`
  ];

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
  spawnCommandResolver = getPiSpawnCommand,
  runCommandFn = runCommand
} = {}) {
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0, "pi launcher timeoutMs must be a positive integer");
  assert(typeof spawnCommandResolver === "function", "spawnCommandResolver(options) must be a function");
  assert(typeof runCommandFn === "function", "runCommandFn(request) must be a function");

  return async function launchPiWorker({
    packet,
    context,
    workspaceRoot
  }) {
    const prompt = buildCodexPrompt(packet);
    const rawArgs = typeof argsBuilder === "function"
      ? argsBuilder({
        packet: clone(packet),
        context: clone(context),
        workspaceRoot,
        prompt
      })
      : ["-p", "--no-session", "--thinking", "off", prompt];
    const args = Array.isArray(rawArgs) ? rawArgs.map((value) => String(value)) : [String(rawArgs)];

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
        args: [],
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
        commandsRun: []
      };
    }

    const command = typeof spawnCommand?.command === "string"
      ? spawnCommand.command.trim()
      : "";
    const argsPrefix = Array.isArray(spawnCommand?.argsPrefix)
      ? spawnCommand.argsPrefix.map((value) => String(value))
      : [];
    const fullArgs = [...argsPrefix, ...args];

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
        commandsRun: []
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
        commandsRun: []
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
      commandsRun: [formatCommand(command, fullArgs)]
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

        const afterSnapshot = await snapshotFiles(workspaceRoot);
        changedFiles = diffSnapshots(beforeSnapshot, afterSnapshot);
        const commandsRun = inferCommandsRun(launchResult);
        const evidence = buildEvidence({
          launchResult,
          repositoryRoot: normalizedRepositoryRoot,
          workspaceRoot,
          allowedFiles,
          contextFiles,
          copiedSeedFiles,
          missingSeedFiles,
          changedFiles
        });

        if (launchResult?.error) {
          return createBlockedResult(`process worker blocked: launcher invocation failed (${errorMessage(launchResult.error)})`, {
            commandsRun,
            evidence,
            openQuestions: [
              "Check local permissions, Pi resolution, and worker launcher availability."
            ]
          });
        }

        if (launchResult?.timedOut) {
          return createFailedResult("process worker failed: launcher timed out", {
            changedFiles,
            commandsRun,
            evidence,
            openQuestions: [
              "Reduce prompt complexity or increase launcher timeout."
            ]
          });
        }

        if (launchResult?.exitCode !== 0) {
          return createFailedResult(`process worker failed: launcher exited with code ${launchResult?.exitCode ?? "unknown"}`, {
            changedFiles,
            commandsRun,
            evidence,
            openQuestions: [
              "Inspect launcher stdout/stderr and verify non-interactive worker command syntax."
            ]
          });
        }

        const allowedFileSet = new Set(allowedFiles);
        const forbiddenFileSet = new Set(forbiddenFiles);

        if (READ_ONLY_ROLES.has(packet.role) && changedFiles.length > 0) {
          return createFailedResult(`${packet.role} process worker failed: ${packet.role} modified files`, {
            changedFiles,
            commandsRun,
            evidence: [
              ...evidence,
              `unexpected_read_only_changes: ${changedFiles.join(", ")}`
            ],
            openQuestions: [
              `Tighten ${packet.role} prompt and runner constraints to keep the role read-only.`
            ]
          });
        }

        const changedOutsideAllowlist = changedFiles.filter((file) => !allowedFileSet.has(file));
        if (changedOutsideAllowlist.length > 0) {
          return createFailedResult("process worker failed: worker changed files outside the allowlist", {
            changedFiles,
            commandsRun,
            evidence: [
              ...evidence,
              `unexpected_files: ${changedOutsideAllowlist.join(", ")}`
            ],
            openQuestions: [
              "Tighten worker instructions to enforce allowlist-only writes."
            ]
          });
        }

        const changedForbiddenFiles = changedFiles.filter((file) => forbiddenFileSet.has(file));
        if (changedForbiddenFiles.length > 0) {
          return createFailedResult("process worker failed: worker changed forbidden files", {
            changedFiles,
            commandsRun,
            evidence: [
              ...evidence,
              `forbidden_files_changed: ${changedForbiddenFiles.join(", ")}`
            ],
            openQuestions: [
              "Narrow the packet scope or remove conflicting forbidden paths."
            ]
          });
        }

        const structuredReadOnlyOutput = READ_ONLY_ROLES.has(packet.role)
          ? parseStructuredReadOnlyOutput({
            role: packet.role,
            stdout: launchResult?.stdout ?? ""
          })
          : null;

        if (READ_ONLY_ROLES.has(packet.role) && structuredReadOnlyOutput) {
          return createWorkerResult({
            status: structuredReadOnlyOutput.status,
            summary: structuredReadOnlyOutput.summary,
            changedFiles,
            commandsRun,
            evidence: unique([
              ...evidence,
              ...structuredReadOnlyOutput.evidence,
              "allowlist_enforced: true",
              "recursive_delegation_forbidden: true",
              "repository_changes_applied: not_applicable"
            ]),
            openQuestions: structuredReadOnlyOutput.openQuestions
          });
        }

        if (READ_ONLY_ROLES.has(packet.role) && !structuredReadOnlyOutput) {
          return createFailedResult(`${packet.role} process worker failed: invalid structured read-only output`, {
            changedFiles,
            commandsRun,
            evidence: unique([
              ...evidence,
              "read_only_structured_output_valid: false"
            ]),
            openQuestions: [
              `Return valid JSON for ${packet.role} with status, summary, evidence, and openQuestions.`
            ]
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
              ? "repository_changes_applied: true"
              : "repository_changes_applied: not_applicable",
            "allowlist_enforced: true",
            "recursive_delegation_forbidden: true"
          ])
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
          openQuestions: ["Inspect process-worker-backend runtime logs and launcher setup."]
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
