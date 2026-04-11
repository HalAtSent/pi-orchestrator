import { spawn } from "node:child_process";

import { getPiSpawnCommand } from "./pi-spawn.js";

export const PROCESS_MODEL_PROBE_DEFAULT_PROVIDER = "openai-codex";
export const PROCESS_MODEL_PROBE_DEFAULT_CANDIDATES = Object.freeze([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex"
]);
export const PROCESS_MODEL_PROBE_DEFAULT_PROMPT = "Reply with OK and stop.";
export const PROCESS_MODEL_PROBE_DEFAULT_TIMEOUT_MS = 30_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function unique(values) {
  return [...new Set(values)];
}

function asErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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

function normalizeModelCandidates(candidateModels) {
  assert(Array.isArray(candidateModels), "candidateModels must be an array");
  const normalized = unique(
    candidateModels
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0)
  );
  assert(normalized.length > 0, "candidateModels must contain at least one model id");
  return normalized;
}

function buildBlockedProbeResult({
  providerId,
  candidateModels,
  reason,
  spawnCommand
}) {
  return {
    providerId,
    candidateModels,
    supportedModels: [],
    attemptedAt: new Date().toISOString(),
    blockedReason: reason,
    spawnCommand: spawnCommand ?? null,
    probes: []
  };
}

export async function probeProcessModels({
  providerId = PROCESS_MODEL_PROBE_DEFAULT_PROVIDER,
  candidateModels = PROCESS_MODEL_PROBE_DEFAULT_CANDIDATES,
  prompt = PROCESS_MODEL_PROBE_DEFAULT_PROMPT,
  timeoutMs = PROCESS_MODEL_PROBE_DEFAULT_TIMEOUT_MS,
  workspaceRoot = process.cwd(),
  spawnCommandResolver = getPiSpawnCommand,
  runCommandFn = runCommand
} = {}) {
  assert(typeof providerId === "string" && providerId.trim().length > 0, "providerId must be a non-empty string");
  assert(typeof prompt === "string" && prompt.trim().length > 0, "prompt must be a non-empty string");
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0, "timeoutMs must be a positive integer");
  assert(typeof spawnCommandResolver === "function", "spawnCommandResolver(options) must be a function");
  assert(typeof runCommandFn === "function", "runCommandFn(request) must be a function");

  const normalizedProviderId = providerId.trim();
  const normalizedCandidates = normalizeModelCandidates(candidateModels);

  let spawnCommand;
  try {
    spawnCommand = await spawnCommandResolver({
      providerId: normalizedProviderId,
      workspaceRoot
    });
  } catch (error) {
    return buildBlockedProbeResult({
      providerId: normalizedProviderId,
      candidateModels: normalizedCandidates,
      reason: `pi spawn command resolution failed: ${asErrorMessage(error)}`,
      spawnCommand: null
    });
  }

  const command = typeof spawnCommand?.command === "string"
    ? spawnCommand.command.trim()
    : "";
  const argsPrefix = Array.isArray(spawnCommand?.argsPrefix)
    ? spawnCommand.argsPrefix.map((value) => String(value))
    : [];
  const hasResolvedPiScript = typeof spawnCommand?.piScriptPath === "string"
    && spawnCommand.piScriptPath.length > 0;

  if (!hasResolvedPiScript) {
    return buildBlockedProbeResult({
      providerId: normalizedProviderId,
      candidateModels: normalizedCandidates,
      reason: "Pi script path was not resolved; refusing fallback launcher for process model probe",
      spawnCommand: {
        launcher: spawnCommand?.launcher ?? "pi_cli_unresolved",
        launcherPath: spawnCommand?.launcherPath ?? null,
        piScriptPath: spawnCommand?.piScriptPath ?? null,
        piPackageRoot: spawnCommand?.piPackageRoot ?? null,
        resolutionMessage: spawnCommand?.resolutionMessage ?? null
      }
    });
  }

  if (command.length === 0) {
    return buildBlockedProbeResult({
      providerId: normalizedProviderId,
      candidateModels: normalizedCandidates,
      reason: "Pi launcher command is empty",
      spawnCommand: {
        launcher: spawnCommand?.launcher ?? "pi_cli_unresolved",
        launcherPath: spawnCommand?.launcherPath ?? null,
        piScriptPath: spawnCommand?.piScriptPath ?? null,
        piPackageRoot: spawnCommand?.piPackageRoot ?? null,
        resolutionMessage: spawnCommand?.resolutionMessage ?? null
      }
    });
  }

  const probes = [];
  const supportedModels = [];

  for (const model of normalizedCandidates) {
    const args = [
      ...argsPrefix,
      "-p",
      "--no-session",
      "--provider",
      normalizedProviderId,
      "--model",
      model,
      "--thinking",
      "off",
      prompt
    ];

    let commandResult;
    try {
      commandResult = await runCommandFn({
        command,
        args,
        cwd: workspaceRoot,
        timeoutMs
      });
    } catch (error) {
      commandResult = {
        command,
        args,
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

    const isSupported = commandResult.exitCode === 0 && !commandResult.timedOut && !commandResult.error;
    if (isSupported) {
      supportedModels.push(model);
    }

    const unsupportedReason = isSupported
      ? null
      : commandResult.error
        ? `launch_error:${asErrorMessage(commandResult.error)}`
        : commandResult.timedOut
          ? "timed_out"
          : `exit_code:${commandResult.exitCode ?? "unknown"}`;

    probes.push({
      model,
      supported: isSupported,
      reason: unsupportedReason,
      command: formatCommand(command, args),
      exitCode: commandResult.exitCode,
      timedOut: commandResult.timedOut === true,
      durationMs: Number.isInteger(commandResult.durationMs) ? commandResult.durationMs : 0,
      stdout: commandResult.stdout ?? "",
      stderr: commandResult.stderr ?? ""
    });
  }

  return {
    providerId: normalizedProviderId,
    candidateModels: normalizedCandidates,
    supportedModels,
    attemptedAt: new Date().toISOString(),
    blockedReason: null,
    spawnCommand: {
      launcher: spawnCommand?.launcher ?? "pi_cli",
      launcherPath: spawnCommand?.launcherPath ?? command,
      piScriptPath: spawnCommand?.piScriptPath ?? null,
      piPackageRoot: spawnCommand?.piPackageRoot ?? null,
      resolutionMessage: spawnCommand?.resolutionMessage ?? null
    },
    probes
  };
}

export function createCachedProcessModelProbe(options = {}) {
  const cache = new Map();
  const functionIdentityCache = new WeakMap();
  let nextFunctionIdentity = 1;

  function getFunctionIdentity(value) {
    if (typeof value !== "function") {
      return null;
    }

    if (!functionIdentityCache.has(value)) {
      functionIdentityCache.set(value, nextFunctionIdentity);
      nextFunctionIdentity += 1;
    }

    return functionIdentityCache.get(value);
  }

  function buildCacheKey(mergedOptions) {
    return JSON.stringify({
      providerId: mergedOptions.providerId,
      candidateModels: normalizeModelCandidates(mergedOptions.candidateModels),
      prompt: mergedOptions.prompt,
      timeoutMs: mergedOptions.timeoutMs,
      workspaceRoot: mergedOptions.workspaceRoot,
      spawnCommandResolverId: getFunctionIdentity(mergedOptions.spawnCommandResolver),
      runCommandFnId: getFunctionIdentity(mergedOptions.runCommandFn)
    });
  }

  return async function cachedProcessModelProbe(requestOptions = {}) {
    const mergedOptions = {
      ...options,
      ...requestOptions,
      providerId: requestOptions.providerId ?? options.providerId ?? PROCESS_MODEL_PROBE_DEFAULT_PROVIDER,
      candidateModels: requestOptions.candidateModels ?? options.candidateModels ?? PROCESS_MODEL_PROBE_DEFAULT_CANDIDATES,
      prompt: requestOptions.prompt ?? options.prompt ?? PROCESS_MODEL_PROBE_DEFAULT_PROMPT,
      timeoutMs: requestOptions.timeoutMs ?? options.timeoutMs ?? PROCESS_MODEL_PROBE_DEFAULT_TIMEOUT_MS,
      workspaceRoot: requestOptions.workspaceRoot ?? options.workspaceRoot ?? process.cwd(),
      spawnCommandResolver: requestOptions.spawnCommandResolver ?? options.spawnCommandResolver ?? getPiSpawnCommand,
      runCommandFn: requestOptions.runCommandFn ?? options.runCommandFn ?? runCommand
    };
    const cacheKey = buildCacheKey(mergedOptions);

    if (!cache.has(cacheKey)) {
      const probePromise = probeProcessModels(mergedOptions)
        .then((probeResult) => {
          if (probeResult?.blockedReason) {
            cache.delete(cacheKey);
          }
          return probeResult;
        })
        .catch((error) => {
          cache.delete(cacheKey);
          throw error;
        });
      cache.set(cacheKey, probePromise);
    }

    return cache.get(cacheKey);
  };
}
