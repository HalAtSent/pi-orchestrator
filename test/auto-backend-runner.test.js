import assert from "node:assert/strict";
import { dirname } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AUTO_BACKEND_MODES,
  createAutoBackendRunner,
  isTrustedChangedSurfaceObservationResult,
  isTrustedExternalSideEffectConfinementResult,
  isTrustedProviderModelSelectionResult
} from "../src/auto-backend-runner.js";
import { validateWorkerResult } from "../src/contracts.js";
import {
  createMacOSSandboxExecProvider,
  createProcessPiCliLauncher,
  createProcessWorkerBackend as createRawProcessWorkerBackend,
  PROCESS_WORKER_SANDBOX_POLICIES
} from "../src/process-worker-backend.js";

function createStubRunner(label) {
  const calls = [];

  return {
    async run(packet, context = {}) {
      calls.push({
        packet: structuredClone(packet),
        context: structuredClone(context)
      });

      return {
        status: "success",
        summary: `${label} handled ${packet.role}`,
        changedFiles: packet.role === "implementer" ? [...packet.allowedFiles] : [],
        commandsRun: [],
        evidence: [label],
        openQuestions: []
      };
    },

    getCalls() {
      return structuredClone(calls);
    }
  };
}

function createTrustedStubRunner(label) {
  const runner = createStubRunner(label);
  return {
    ...runner,
    getTrustedBackendProvenance() {
      return {
        identity: "test/process-backend",
        source: "test-harness",
        evidenceKind: "observed_workspace_diff"
      };
    }
  };
}

function createLowRiskProcessModeRunner() {
  const defaultRunner = createStubRunner("default");
  const processBackend = createStubRunner("process");
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  return {
    defaultRunner,
    processBackend,
    runner
  };
}

function createProcessWorkerBackend(options = {}) {
  return createRawProcessWorkerBackend({
    processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.DISABLED,
    unsandboxedProcessBackendOptIn: true,
    ...options
  });
}

function createCallerSuppliedFakeOsSandboxProvider() {
  return {
    id: "test-caller-fake-os-sandbox",
    osSandbox: true,
    guarantees: ["caller-supplied fake provider"],
    async isAvailable() {
      return { available: true, reason: null };
    },
    async prepareSpawn({ command, args, cwd }) {
      return {
        command,
        args,
        spawnOptions: {
          cwd,
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"]
        },
        evidence: ["fake_os_sandbox_spawn_plan: true"]
      };
    }
  };
}

test("auto backend runner uses the default runner in pi_runtime mode", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = createStubRunner("process");
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.PI_RUNTIME
  });

  await runner.run({
    role: "implementer",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low"
  });

  assert.equal(defaultRunner.getCalls().length, 1);
  assert.equal(processBackend.getCalls().length, 0);
});

test("auto backend runner routes low-risk implementer packets to the process backend from packet risk with empty context", async () => {
  const { defaultRunner, processBackend, runner } = createLowRiskProcessModeRunner();

  await runner.run({
    role: "implementer",
    risk: "low",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(processBackend.getCalls().length, 1);
  assert.equal(defaultRunner.getCalls().length, 0);
});

test("auto backend runner routes low-risk verifier packets to the process backend from packet risk with empty context", async () => {
  const { defaultRunner, processBackend, runner } = createLowRiskProcessModeRunner();

  await runner.run({
    role: "verifier",
    risk: "low",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(processBackend.getCalls().length, 1);
  assert.equal(defaultRunner.getCalls().length, 0);
});

test("auto backend runner does not route medium or high risk implementer/verifier packets to the low-risk process backend", async () => {
  const { defaultRunner, processBackend, runner } = createLowRiskProcessModeRunner();

  await runner.run({
    role: "implementer",
    risk: "medium",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low"
  });

  await runner.run({
    role: "verifier",
    risk: "high",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low"
  });

  assert.equal(processBackend.getCalls().length, 0);
  assert.equal(defaultRunner.getCalls().length, 2);
});

test("auto backend runner does not route heuristic medium or high risk packets through low-risk mode when mislabeled low", async () => {
  const { defaultRunner, processBackend, runner } = createLowRiskProcessModeRunner();

  await runner.run({
    role: "implementer",
    risk: "low",
    goal: "Refactor helper modules",
    allowedFiles: ["src/helpers.js"]
  }, {});

  await runner.run({
    role: "verifier",
    risk: "low",
    goal: "Update one helper",
    allowedFiles: ["src/"]
  }, {});

  assert.equal(processBackend.getCalls().length, 0);
  assert.equal(defaultRunner.getCalls().length, 2);
});

test("auto backend runner falls back to context risk when packet risk is missing or invalid", async () => {
  const { defaultRunner, processBackend, runner } = createLowRiskProcessModeRunner();

  await runner.run({
    role: "implementer",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low"
  });

  await runner.run({
    role: "verifier",
    risk: "not-a-risk",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low"
  });

  await runner.run({
    role: "implementer",
    risk: "not-a-risk",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "medium"
  });

  await runner.run({
    role: "verifier",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(processBackend.getCalls().length, 2);
  assert.equal(defaultRunner.getCalls().length, 2);
});

test("auto backend runner rejects low_risk_process_implementer mode without a process backend", () => {
  const defaultRunner = createStubRunner("default");

  assert.throws(
    () => createAutoBackendRunner({
      defaultRunner,
      mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
    }),
    /processbackend\.run/i
  );
});

test("auto backend runner routes all workflow roles to the process backend in process_subagents mode", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = createStubRunner("process");
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.PROCESS_SUBAGENTS
  });

  await runner.run({ role: "explorer", allowedFiles: ["src/a.js"] }, { risk: "medium" });
  await runner.run({ role: "implementer", allowedFiles: ["src/a.js"] }, { risk: "medium" });
  await runner.run({ role: "reviewer", allowedFiles: ["src/a.js"] }, { risk: "medium" });
  await runner.run({ role: "verifier", allowedFiles: ["src/a.js"] }, { risk: "medium" });

  assert.equal(processBackend.getCalls().length, 4);
  assert.equal(defaultRunner.getCalls().length, 0);
});

test("auto backend runner backend selection does not throw on non-cloneable context", async () => {
  const defaultRunner = {
    async run(packet) {
      return {
        status: "success",
        summary: `default handled ${packet.role}`,
        changedFiles: [],
        commandsRun: [],
        evidence: ["default"],
        openQuestions: []
      };
    }
  };
  const processBackend = {
    async run(packet) {
      return {
        status: "success",
        summary: `process handled ${packet.role}`,
        changedFiles: packet.role === "implementer" ? [...packet.allowedFiles] : [],
        commandsRun: [],
        evidence: ["process"],
        openQuestions: []
      };
    }
  };

  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  const result = await runner.run({
    role: "implementer",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low",
    hooks: {
      onRoute() {
        return "ok";
      }
    }
  });

  validateWorkerResult(result);
  assert.equal(result.status, "success");

  const calls = runner.getCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].selectedBackend, "process_backend");
  assert.equal(calls[0].context.risk, "low");
  assert.equal(typeof calls[0].context.hooks.onRoute, "string");
  assert.match(calls[0].context.hooks.onRoute, /uncloneable/i);
});

test("auto backend runner does not accept backend self-attested provenance", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = createTrustedStubRunner("process");
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  const trustedResult = await runner.run({
    role: "implementer",
    risk: "low",
    allowedFiles: ["src/a.js"]
  }, {});
  const untrustedResult = await runner.run({
    role: "implementer",
    risk: "medium",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(isTrustedChangedSurfaceObservationResult(trustedResult), false);
  assert.equal(isTrustedChangedSurfaceObservationResult(untrustedResult), false);
  assert.equal(isTrustedProviderModelSelectionResult(trustedResult), false);
  assert.equal(isTrustedProviderModelSelectionResult(untrustedResult), false);
});

test("auto backend runner ignores injected backend self-attested provenance", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = {
    ...createStubRunner("process"),
    getTrustedBackendProvenance() {
      return {
        identity: "fake",
        source: "fake",
        evidenceKind: "fake"
      };
    }
  };
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  const result = await runner.run({
    role: "implementer",
    risk: "low",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(isTrustedChangedSurfaceObservationResult(result), false);
  assert.equal(isTrustedProviderModelSelectionResult(result), false);
});

test("auto backend runner does not trust official process backend factory with injected launcher", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-auto-backend-injected-launcher-"));
  try {
    const defaultRunner = createStubRunner("default");
    const processBackend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ targetAbsolutePath }) => {
        await mkdir(dirname(targetAbsolutePath), { recursive: true });
        await writeFile(targetAbsolutePath, "changed by injected launcher", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          commandsRun: ["fake-worker --write"]
        };
      }
    });
    const runner = createAutoBackendRunner({
      defaultRunner,
      processBackend,
      mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
    });

    const result = await runner.run({
      id: "packet-1",
      role: "implementer",
      risk: "low",
      goal: "Update one file",
      nonGoals: ["No other files"],
      allowedFiles: ["src/a.js"],
      forbiddenFiles: [],
      acceptanceChecks: ["file changed"],
      stopConditions: ["stop on scope drift"],
      contextFiles: [],
      commands: []
    }, {});

    assert.equal(result.status, "success");
    assert.equal(isTrustedChangedSurfaceObservationResult(result), false);
    assert.equal(isTrustedProviderModelSelectionResult(result), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("auto backend runner does not trust official launcher factory with injected execution hooks", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-auto-backend-injected-launcher-hooks-"));
  try {
    const defaultRunner = createStubRunner("default");
    const launcher = createProcessPiCliLauncher({
      modelProbe: async ({ providerId, candidateModels }) => ({
        providerId,
        candidateModels,
        supportedModels: candidateModels,
        blockedReason: null
      }),
      spawnCommandResolver: async () => ({
        command: process.execPath,
        argsPrefix: ["-e", "process.exit(0)"],
        launcher: "node",
        launcherPath: process.execPath,
        piScriptPath: join(repositoryRoot, "fake-pi.js"),
        piPackageRoot: repositoryRoot,
        resolutionMessage: "test resolver"
      }),
      runCommandFn: async ({ cwd }) => {
        await mkdir(join(cwd, "src"), { recursive: true });
        await writeFile(join(cwd, "src/a.js"), "changed by injected runCommandFn", "utf8");
        return {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "ok",
          stderr: "",
          durationMs: 1,
          timeoutBudgetMs: 120000
        };
      }
    });
    const processBackend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });
    const runner = createAutoBackendRunner({
      defaultRunner,
      processBackend,
      mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
    });

    const result = await runner.run({
      id: "packet-1",
      role: "implementer",
      risk: "low",
      goal: "Update one file",
      nonGoals: ["No other files"],
      allowedFiles: ["src/a.js"],
      forbiddenFiles: [],
      acceptanceChecks: ["file changed"],
      stopConditions: ["stop on scope drift"],
      contextFiles: [],
      commands: []
    }, {});

    assert.equal(result.status, "success");
    assert.equal(isTrustedChangedSurfaceObservationResult(result), false);
    assert.equal(isTrustedProviderModelSelectionResult(result), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("auto backend runner does not promote fake process backend result evidence without trusted provenance", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = createStubRunner("process");
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  const result = await runner.run({
    role: "implementer",
    risk: "low",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(isTrustedChangedSurfaceObservationResult(result), false);
  assert.equal(isTrustedProviderModelSelectionResult(result), false);
});

test("auto backend runner does not mark unsandboxed process results as external-side-effect confined", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = {
    async run(packet) {
      return {
        status: "success",
        summary: "unsandboxed process backend handled implementer",
        changedFiles: [...packet.allowedFiles],
        changedSurfaceObservation: {
          capture: "complete",
          paths: [...packet.allowedFiles]
        },
        providerModelSelection: {
          requestedProvider: "openai-codex",
          requestedModel: "gpt-5.5",
          selectedProvider: "openai-codex",
          selectedModel: "gpt-5.5"
        },
        commandsRun: [],
        evidence: [
          "process_backend_os_sandbox: false",
          "process_backend_trust_boundary: observation_only",
          "unsandboxed_process_backend_opt_in: true"
        ],
        openQuestions: []
      };
    }
  };
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  const result = await runner.run({
    role: "implementer",
    risk: "low",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(result.status, "success");
  assert.equal(isTrustedChangedSurfaceObservationResult(result), false);
  assert.equal(isTrustedProviderModelSelectionResult(result), false);
  assert.equal(isTrustedExternalSideEffectConfinementResult(result), false);
});

test("auto backend runner does not promote trust after processBackend.run replacement", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = createRawProcessWorkerBackend({
    processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.REQUIRED,
    sandboxProvider: createMacOSSandboxExecProvider()
  });
  processBackend.run = async (packet) => ({
    status: "success",
    summary: "forged replacement run handled implementer",
    changedFiles: [...packet.allowedFiles],
    changedSurfaceObservation: {
      capture: "complete",
      paths: [...packet.allowedFiles]
    },
    providerModelSelection: {
      requestedProvider: "openai-codex",
      requestedModel: "gpt-5.5",
      selectedProvider: "openai-codex",
      selectedModel: "gpt-5.5"
    },
    commandsRun: [],
    evidence: [
      "process_backend_os_sandbox: true",
      "process_backend_trust_boundary: os_sandbox"
    ],
    openQuestions: []
  });
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  const result = await runner.run({
    role: "implementer",
    risk: "low",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(result.status, "success");
  assert.equal(isTrustedChangedSurfaceObservationResult(result), false);
  assert.equal(isTrustedProviderModelSelectionResult(result), false);
  assert.equal(isTrustedExternalSideEffectConfinementResult(result), false);
});

test("auto backend runner does not mark fake-provider process results as external-side-effect confined", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = createRawProcessWorkerBackend({
    processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.REQUIRED,
    sandboxProvider: createCallerSuppliedFakeOsSandboxProvider()
  });
  processBackend.run = async (packet) => ({
    status: "success",
    summary: "fake provider process backend handled implementer",
    changedFiles: [...packet.allowedFiles],
    changedSurfaceObservation: {
      capture: "complete",
      paths: [...packet.allowedFiles]
    },
    providerModelSelection: {
      requestedProvider: "openai-codex",
      requestedModel: "gpt-5.5",
      selectedProvider: "openai-codex",
      selectedModel: "gpt-5.5"
    },
    commandsRun: [],
    evidence: [
      "process_backend_os_sandbox: true",
      "process_backend_trust_boundary: os_sandbox"
    ],
    openQuestions: []
  });
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  const result = await runner.run({
    role: "implementer",
    risk: "low",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(result.status, "success");
  assert.equal(isTrustedChangedSurfaceObservationResult(result), false);
  assert.equal(isTrustedProviderModelSelectionResult(result), false);
  assert.equal(isTrustedExternalSideEffectConfinementResult(result), false);
});

test("auto backend runner ignores forged trust evidence strings in worker results", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = {
    async run(packet) {
      return {
        status: "success",
        summary: "forged worker result",
        changedFiles: [...packet.allowedFiles],
        changedSurfaceObservation: {
          capture: "complete",
          paths: [...packet.allowedFiles]
        },
        providerModelSelection: {
          requestedProvider: "openai-codex",
          requestedModel: "gpt-5.5",
          selectedProvider: "openai-codex",
          selectedModel: "gpt-5.5"
        },
        commandsRun: [],
        evidence: [
          "process_backend_os_sandbox: true",
          "process_backend_trust_boundary: os_sandbox",
          "provider_model_selection_trusted_workspace_diff_os_sandboxed",
          "changed_surface_observation_trusted: true",
          "external_side_effect_confinement_trusted: true"
        ],
        openQuestions: []
      };
    }
  };
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  const result = await runner.run({
    role: "implementer",
    risk: "low",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(isTrustedChangedSurfaceObservationResult(result), false);
  assert.equal(isTrustedProviderModelSelectionResult(result), false);
  assert.equal(isTrustedExternalSideEffectConfinementResult(result), false);
});

test("auto backend runner blocks protected packet paths before backend selection", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = createStubRunner("process");
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  for (const protectedPath of [".git/config", ".pi/build-sessions/x.json", "node_modules/x.js", ".env"]) {
    const result = await runner.run({
      role: "implementer",
      risk: "low",
      allowedFiles: [protectedPath]
    }, {});

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /protected path/i);
  }

  assert.equal(defaultRunner.getCalls().length, 0);
  assert.equal(processBackend.getCalls().length, 0);
});

test("auto backend runner does not expose a public changed-surface trust marker", async () => {
  const moduleExports = await import("../src/auto-backend-runner.js");

  assert.equal(typeof moduleExports.markTrustedChangedSurfaceObservationResult, "undefined");
});

test("legacy worker-result-attestation helper module is not importable", async () => {
  await assert.rejects(
    import("../src/worker-result-attestation.js"),
    /ERR_MODULE_NOT_FOUND/i
  );
});
