import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { access, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTaskPacket, validateWorkerResult } from "../src/contracts.js";
import {
  BOUNDARY_TRUNCATION_MARKER_PREFIX,
  BOUNDARY_TRUNCATION_MARKER_SUFFIX
} from "../src/redaction.js";
import {
  createPiCliLauncher,
  createProcessRoleArgsBuilder,
  createProcessWorkerBackend as createRawProcessWorkerBackend,
  createDefaultProcessSandboxProvider,
  createMacOSSandboxExecProvider,
  getTrustedProcessWorkerBackendProvenance,
  loadRoleContractGuidance,
  PROCESS_WORKER_PROVIDER_ID,
  PROCESS_WORKER_ROLE_PROFILES,
  PROCESS_WORKER_SANDBOX_POLICIES
} from "../src/process-worker-backend.js";

const PROCESS_WORKER_BACKEND_TEST_SUPPORT_KEY = Symbol.for("pi-orchestrator.process-worker-backend.test-support");

function createPacket(role = "implementer", overrides = {}) {
  return createTaskPacket({
    id: `process-${role}-packet`,
    parentTaskId: "process-backend-test",
    role,
    risk: "low",
    goal: "Process worker bounded execution task",
    nonGoals: ["Do not edit files outside the allowlist."],
    allowedFiles: ["test/fixtures/process-worker-output.md"],
    forbiddenFiles: [],
    acceptanceChecks: ["The allowed file contains exact deterministic content."],
    stopConditions: ["Stop if the worker launcher cannot execute."],
    contextFiles: [],
    commands: [],
    ...overrides
  });
}

function createProcessWorkerBackend(options = {}) {
  return createRawProcessWorkerBackend({
    processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.DISABLED,
    unsandboxedProcessBackendOptIn: true,
    ...options
  });
}

function createFakeSandboxProvider({
  id = "test-fake-os-sandbox",
  available = true,
  reason = "test sandbox unavailable"
} = {}) {
  return {
    id,
    osSandbox: true,
    guarantees: [
      "test provider owns command construction and spawn options"
    ],
    async isAvailable() {
      return available
        ? { available: true, reason: null }
        : { available: false, reason };
    },
    async prepareSpawn({ command, args, cwd }) {
      if (!available) {
        throw new Error(reason);
      }

      return {
        command,
        args,
        spawnOptions: {
          cwd,
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"]
        },
        evidence: ["test_sandbox_spawn_plan: true"]
      };
    }
  };
}

function createFakeNonOsSandboxProvider({
  id = "test-fake-non-os-sandbox",
  available = true,
  reason = "test non-os sandbox unavailable"
} = {}) {
  return {
    id,
    osSandbox: false,
    guarantees: [
      "test provider does not provide OS sandbox guarantees"
    ],
    async isAvailable() {
      return available
        ? { available: true, reason: null }
        : { available: false, reason };
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
        evidence: ["test_non_os_spawn_plan: true"]
      };
    }
  };
}

async function exists(pathValue) {
  try {
    await access(pathValue);
    return true;
  } catch {
    return false;
  }
}

function normalizeFilePath(pathValue) {
  return String(pathValue).replace(/\\/g, "/");
}

function createRoleProfilesWithOverrides(overrides = {}) {
  return {
    explorer: {
      ...PROCESS_WORKER_ROLE_PROFILES.explorer,
      ...(overrides.explorer ?? {})
    },
    implementer: {
      ...PROCESS_WORKER_ROLE_PROFILES.implementer,
      ...(overrides.implementer ?? {})
    },
    reviewer: {
      ...PROCESS_WORKER_ROLE_PROFILES.reviewer,
      ...(overrides.reviewer ?? {})
    },
    verifier: {
      ...PROCESS_WORKER_ROLE_PROFILES.verifier,
      ...(overrides.verifier ?? {})
    }
  };
}

function createPromptCaptureLauncher({ prompts, runCommandFn, launcherOptions = {} } = {}) {
  const resolvedRunCommandFn = runCommandFn ?? (async ({ command, args, cwd }) => ({
    command,
    args,
    cwd,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "ok",
    stderr: "",
    error: null,
    durationMs: 1
  }));

  return createPiCliLauncher({
    argsBuilder: async ({ prompt }) => {
      prompts.push(prompt);
      return ["-p", "--no-session", "--thinking", "off", prompt];
    },
    spawnCommandResolver: async () => ({
      command: process.execPath,
      argsPrefix: [],
      launcher: "test_launcher",
      launcherPath: process.execPath,
      piScriptPath: "C:/fake/pi.js",
      piPackageRoot: "C:/fake",
      resolutionMessage: "test resolution"
    }),
    runCommandFn: resolvedRunCommandFn,
    ...launcherOptions
  });
}

function createFreshProcessWorkerBackendModuleUrl() {
  return new URL(`../src/process-worker-backend.js?test=${Date.now()}-${Math.random().toString(16).slice(2)}`, import.meta.url);
}

function createTestSpawnOptions(cwd) {
  return {
    cwd,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  };
}

async function getMacOSSandboxProviderAvailability(provider = createMacOSSandboxExecProvider()) {
  return provider.isAvailable();
}

test("process backend production module does not export trusted test sandbox provider branding", async () => {
  const moduleExports = await import("../src/process-worker-backend.js");

  assert.equal(typeof moduleExports.createTrustedProcessSandboxProviderForTests, "undefined");
});

test("setting NODE_TEST_CONTEXT before production import does not expose a global test-support branding helper", async () => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;

  try {
    process.env.NODE_TEST_CONTEXT = "child-v8";

    const moduleExports = await import(createFreshProcessWorkerBackendModuleUrl().href);

    assert.equal(typeof moduleExports.createTrustedProcessSandboxProviderForTests, "undefined");
    assert.equal(Object.prototype.hasOwnProperty.call(globalThis, PROCESS_WORKER_BACKEND_TEST_SUPPORT_KEY), false);
    assert.equal(globalThis[PROCESS_WORKER_BACKEND_TEST_SUPPORT_KEY], undefined);
  } finally {
    if (previousNodeTestContext === undefined) {
      delete process.env.NODE_TEST_CONTEXT;
    } else {
      process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    }
  }
});

test("process backend production import leaves no global test-support symbol", async () => {
  await import("../src/process-worker-backend.js");

  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, PROCESS_WORKER_BACKEND_TEST_SUPPORT_KEY), false);
  assert.equal(globalThis[PROCESS_WORKER_BACKEND_TEST_SUPPORT_KEY], undefined);
});

test("process backend forged stack text cannot brand a caller fake osSandbox provider", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-forged-stack-fake-provider-"));
  const originalPrepareStackTrace = Error.prepareStackTrace;
  let launchCount = 0;

  try {
    Error.prepareStackTrace = () => "/tmp/project/test/forged-stack.test.js";
    const backend = createRawProcessWorkerBackend({
      repositoryRoot,
      processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.REQUIRED,
      sandboxProvider: createFakeSandboxProvider({
        id: "test-forged-stack-fake-os-sandbox",
        available: true
      }),
      launcher: async () => {
        launchCount += 1;
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --should-not-run"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {});

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /required OS sandbox provider is unavailable/i);
    assert.equal(launchCount, 0);
    assert.equal(result.evidence.includes("process_sandbox_provider: test-forged-stack-fake-os-sandbox"), true);
    assert.equal(
      result.evidence.includes("process_sandbox_unavailable_reason: sandbox provider is not an internally trusted OS sandbox provider"),
      true
    );
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace;
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend blocks cleanly for unsupported roles", async () => {
  let launchCount = 0;
  const backend = createProcessWorkerBackend({
    launcher: async () => {
      launchCount += 1;
      return {
        exitCode: 0
      };
    }
  });

  const result = await backend.run(createPacket("orchestrator"), {});

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /unsupported role/i);
  assert.equal(launchCount, 0);
});

test("process backend blocks cleanly for malformed packets", async () => {
  let launchCount = 0;
  const backend = createProcessWorkerBackend({
    launcher: async () => {
      launchCount += 1;
      return {
        exitCode: 0
      };
    }
  });

  const result = await backend.run({
    role: "implementer"
  }, {});

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /invalid packet/i);
  assert.equal(launchCount, 0);
});

test("process backend does not emit typed command observations for args-builder launcher failures", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-args-builder-failure-"));

  try {
    const launcher = createPiCliLauncher({
      argsBuilder: async () => {
        throw new Error("args builder exploded before command execution");
      },
      spawnCommandResolver: async () => ({
        command: process.execPath,
        argsPrefix: [],
        launcher: "test_launcher",
        launcherPath: process.execPath,
        piScriptPath: __filename,
        piPackageRoot: dirname(__filename),
        resolutionMessage: "test resolution"
      })
    });
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "args-builder-failure"
    });

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /launcher invocation failed/i);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "commandObservations"), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend does not emit typed command observations when runCommandFn throws before execution", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-pre-exec-failure-"));

  try {
    const launcher = createPiCliLauncher({
      argsBuilder: async ({ prompt }) => ["-p", "--no-session", "--thinking", "off", prompt],
      spawnCommandResolver: async () => ({
        command: process.execPath,
        argsPrefix: [],
        launcher: "test_launcher",
        launcherPath: process.execPath,
        piScriptPath: __filename,
        piPackageRoot: dirname(__filename),
        resolutionMessage: "test resolution"
      }),
      runCommandFn: async () => {
        throw new Error("pre-exec launcher failure");
      }
    });
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "pre-exec-launcher-failure"
    });

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /launcher invocation failed/i);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "commandObservations"), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend maps launcher output into a contract-compatible worker result", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-contract-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ targetAbsolutePath }) => {
        await mkdir(dirname(targetAbsolutePath), { recursive: true });
        await writeFile(targetAbsolutePath, "updated from process backend", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "created process output",
          stderr: "",
          commandsRun: ["fake-worker --write-output"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "process-test-workflow"
    });

    validateWorkerResult(result);
    assert.equal(result.status, "success");
    assert.match(result.summary, /not OS sandboxing/i);
    assert.equal(result.evidence.includes("process_backend_os_sandbox: false"), true);
    assert.equal(
      result.evidence.includes("process_backend_boundary: workspace copy plus allowlist apply checks; not an OS sandbox"),
      true
    );
    assert.deepEqual(result.changedFiles, ["test/fixtures/process-worker-output.md"]);
    assert.deepEqual(result.commandsRun, ["fake-worker --write-output"]);
    assert.deepEqual(result.commandObservations, [
      {
        command: "fake-worker --write-output",
        source: "process_backend_launcher",
        actionClasses: ["execute_local_command"]
      }
    ]);
    assert.equal(result.openQuestions.length, 0);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend fails closed before launch when required sandbox provider is unavailable", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-required-sandbox-unavailable-"));
  let launchCount = 0;

  try {
    const backend = createRawProcessWorkerBackend({
      repositoryRoot,
      processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.REQUIRED,
      sandboxProvider: createFakeSandboxProvider({
        id: "test-unavailable-sandbox",
        available: false,
        reason: "test provider intentionally unavailable"
      }),
      launcher: async () => {
        launchCount += 1;
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --should-not-run"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {});

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /required OS sandbox provider is unavailable/i);
    assert.equal(launchCount, 0);
    assert.equal(result.evidence.includes("process_sandbox_policy: required"), true);
    assert.equal(result.evidence.includes("process_backend_os_sandbox: false"), true);
    assert.equal(result.evidence.includes("process_backend_trust_boundary: unavailable"), true);
    assert.equal(result.evidence.includes("process_sandbox_provider: test-unavailable-sandbox"), true);
    assert.equal(result.evidence.includes("process_sandbox_available: false"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("trusted macos sandbox provider methods are immutable after creation", () => {
  const provider = createMacOSSandboxExecProvider();
  const forgedIsAvailable = async () => ({ available: true, reason: null });
  const forgedPrepareSpawn = async ({ command, args, cwd }) => ({
    command,
    args,
    spawnOptions: createTestSpawnOptions(cwd),
    evidence: ["forged_unsandboxed_spawn_plan: true"]
  });

  assert.equal(Object.isFrozen(provider), true);
  assert.equal(Object.isFrozen(provider.guarantees), true);
  assert.throws(() => {
    provider.isAvailable = forgedIsAvailable;
  }, TypeError);
  assert.throws(() => {
    provider.prepareSpawn = forgedPrepareSpawn;
  }, TypeError);
  assert.notEqual(provider.isAvailable, forgedIsAvailable);
  assert.notEqual(provider.prepareSpawn, forgedPrepareSpawn);
});

test("trusted macos sandbox provider guarantees are immutable after creation", () => {
  const provider = createMacOSSandboxExecProvider();
  const originalGuarantees = [...provider.guarantees];

  assert.throws(() => {
    provider.guarantees.push("forged guarantee");
  }, TypeError);
  assert.deepEqual(provider.guarantees, originalGuarantees);
});

test("process backend fails closed before launch when required provider is available but not an OS sandbox", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-required-non-os-sandbox-"));
  let launchCount = 0;

  try {
    const backend = createRawProcessWorkerBackend({
      repositoryRoot,
      processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.REQUIRED,
      sandboxProvider: createFakeNonOsSandboxProvider({
        id: "test-available-non-os-sandbox"
      }),
      launcher: async () => {
        launchCount += 1;
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --should-not-run"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {});

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /required OS sandbox provider is unavailable/i);
    assert.equal(launchCount, 0);
    assert.equal(result.evidence.includes("process_sandbox_policy: required"), true);
    assert.equal(result.evidence.includes("process_backend_os_sandbox: false"), true);
    assert.equal(result.evidence.includes("process_backend_trust_boundary: unavailable"), true);
    assert.equal(result.evidence.includes("process_sandbox_provider: test-available-non-os-sandbox"), true);
    assert.equal(result.evidence.includes("process_sandbox_available: false"), true);
    assert.equal(
      result.evidence.includes("process_sandbox_unavailable_reason: sandbox provider is not an internally trusted OS sandbox provider"),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend does not trust caller-supplied fake osSandbox providers in required mode", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-required-fake-os-sandbox-"));
  let launchCount = 0;

  try {
    const backend = createRawProcessWorkerBackend({
      repositoryRoot,
      processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.REQUIRED,
      sandboxProvider: createFakeSandboxProvider({
        id: "test-caller-fake-os-sandbox",
        available: true
      }),
      launcher: async () => {
        launchCount += 1;
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --should-not-run"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {});
    const provenanceBackend = createRawProcessWorkerBackend({
      repositoryRoot,
      processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.REQUIRED,
      sandboxProvider: createFakeSandboxProvider({
        id: "test-caller-fake-os-sandbox",
        available: true
      })
    });
    const provenance = getTrustedProcessWorkerBackendProvenance(provenanceBackend);

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /required OS sandbox provider is unavailable/i);
    assert.equal(launchCount, 0);
    assert.equal(result.evidence.includes("process_backend_os_sandbox: false"), true);
    assert.equal(result.evidence.includes("process_backend_trust_boundary: unavailable"), true);
    assert.equal(result.evidence.includes("process_sandbox_provider: test-caller-fake-os-sandbox"), true);
    assert.equal(result.evidence.includes("process_sandbox_available: false"), true);
    assert.equal(result.evidence.includes("process_backend_os_sandbox: true"), false);
    assert.equal(provenance?.osSandbox, false);
    assert.equal(provenance?.trustBoundary, "unavailable");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend disabled sandbox mode requires explicit unsandboxed opt-in", () => {
  assert.throws(
    () => createRawProcessWorkerBackend({
      processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.DISABLED
    }),
    /unsandboxedProcessBackendOptIn: true/u
  );
});

test("process backend records weaker observation-only evidence for explicit unsandboxed mode", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-unsandboxed-opt-in-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ targetAbsolutePath }) => {
        await mkdir(dirname(targetAbsolutePath), { recursive: true });
        await writeFile(targetAbsolutePath, "updated without OS sandbox", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "created process output",
          stderr: "",
          commandsRun: ["fake-worker --write-output"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {});

    assert.equal(result.status, "success");
    assert.equal(result.evidence.includes("process_sandbox_policy: disabled"), true);
    assert.equal(result.evidence.includes("process_backend_os_sandbox: false"), true);
    assert.equal(result.evidence.includes("process_backend_trust_boundary: observation_only"), true);
    assert.equal(result.evidence.includes("unsandboxed_process_backend_opt_in: true"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("mutating the returned trusted macos provider cannot force a plain unsandboxed spawn plan", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-mutated-official-provider-"));
  const provider = createMacOSSandboxExecProvider();
  const availability = await getMacOSSandboxProviderAvailability(provider);
  let forgedPrepareSpawnCalls = 0;

  try {
    try {
      provider.isAvailable = async () => ({ available: true, reason: null });
    } catch {}
    try {
      provider.prepareSpawn = async ({ command, args, cwd }) => {
        forgedPrepareSpawnCalls += 1;
        return {
          command,
          args: Array.isArray(args) ? args.map((value) => String(value)) : [],
          spawnOptions: createTestSpawnOptions(cwd),
          evidence: ["forged_unsandboxed_spawn_plan: true"]
        };
      };
    } catch {}

    const launcher = createPiCliLauncher({
      argsBuilder: async () => [],
      spawnCommandResolver: async ({ workspaceRoot }) => {
        const outputPath = join(workspaceRoot, "test", "fixtures", "process-worker-output.md");
        return {
          command: "/bin/sh",
          argsPrefix: [
            "-c",
            "mkdir -p \"$(dirname \"$1\")\" && printf '%s' 'mutation bypass failed' > \"$1\"",
            "sh",
            outputPath
          ],
          launcher: "sh_test_mutation_bypass_launcher",
          launcherPath: "/bin/sh",
          piScriptPath: "/bin/sh",
          piPackageRoot: "/bin",
          resolutionMessage: "test mutation bypass launcher"
        };
      }
    });
    const backend = createRawProcessWorkerBackend({
      repositoryRoot,
      launcher,
      processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.REQUIRED,
      sandboxProvider: provider
    });

    const result = await backend.run(createPacket("implementer"), {});

    assert.equal(forgedPrepareSpawnCalls, 0);
    assert.equal(result.evidence.includes("forged_unsandboxed_spawn_plan: true"), false);

    if (availability.available === true) {
      assert.notEqual(result.status, "blocked");
      assert.equal(result.evidence.includes("process_backend_os_sandbox: true"), true);
      assert.equal(result.evidence.includes("process_backend_trust_boundary: os_sandbox"), true);
      assert.equal(result.evidence.includes("process_sandbox_available: true"), true);
    } else {
      assert.equal(result.status, "blocked");
      assert.match(result.summary, /required OS sandbox provider is unavailable/i);
      assert.equal(result.evidence.includes("process_backend_os_sandbox: false"), true);
      assert.equal(result.evidence.includes("process_backend_trust_boundary: unavailable"), true);
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend records sandbox provider identity when required sandbox mode launches", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-required-sandbox-launch-"));
  const repositoryOutputPath = join(repositoryRoot, "test", "fixtures", "process-worker-output.md");

  try {
    const sandboxProvider = createMacOSSandboxExecProvider();
    const availability = await getMacOSSandboxProviderAvailability(sandboxProvider);
    if (availability.available !== true) {
      t.skip(availability.reason ?? "macos sandbox-exec provider unavailable");
      return;
    }

    const launcher = createPiCliLauncher({
      argsBuilder: async () => [],
      spawnCommandResolver: async ({ workspaceRoot }) => {
        const outputPath = join(workspaceRoot, "test", "fixtures", "process-worker-output.md");
        return {
          command: "/bin/sh",
          argsPrefix: [
            "-c",
            "mkdir -p \"$(dirname \"$1\")\" && printf '%s' 'updated from sandboxed process backend' > \"$1\"",
            "sh",
            outputPath
          ],
          launcher: "sh_test_sandbox_launcher",
          launcherPath: "/bin/sh",
          piScriptPath: "/bin/sh",
          piPackageRoot: "/bin",
          resolutionMessage: "test sandbox-capable launcher"
        };
      }
    });
    const backend = createRawProcessWorkerBackend({
      repositoryRoot,
      launcher,
      processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.REQUIRED,
      sandboxProvider
    });

    const result = await backend.run(createPacket("implementer"), {});

    assert.equal(result.evidence.includes("process_sandbox_policy: required"), true);
    assert.equal(result.evidence.includes("process_backend_os_sandbox: true"), true);
    assert.equal(result.evidence.includes("process_backend_trust_boundary: os_sandbox"), true);
    assert.equal(result.evidence.includes("process_sandbox_provider: macos-sandbox-exec"), true);
    assert.equal(result.evidence.includes("process_sandbox_available: true"), true);
    assert.equal(result.evidence.some((entry) => entry.startsWith("process_sandbox_profile: ")), true);
    assert.notEqual(result.status, "blocked");
    if (result.status === "success") {
      assert.equal(await readFile(repositoryOutputPath, "utf8"), "updated from sandboxed process backend");
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("sandboxed process worker cannot mutate repository allowlist paths directly during execution", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-required-repo-write-denied-"));
  const repositoryOutputPath = join(repositoryRoot, "test", "fixtures", "process-worker-output.md");

  try {
    const sandboxProvider = createMacOSSandboxExecProvider();
    const availability = await getMacOSSandboxProviderAvailability(sandboxProvider);
    if (availability.available !== true) {
      t.skip(availability.reason ?? "macos sandbox-exec provider unavailable");
      return;
    }

    await mkdir(dirname(repositoryOutputPath), { recursive: true });
    await writeFile(repositoryOutputPath, "original repository content", "utf8");

    const launcher = createPiCliLauncher({
      argsBuilder: async () => [],
      spawnCommandResolver: async () => {
        return {
          command: "/bin/sh",
          argsPrefix: [
            "-c",
            "printf '%s' 'direct repository mutation' > \"$1\"",
            "sh",
            repositoryOutputPath
          ],
          launcher: "sh_test_direct_repo_write_launcher",
          launcherPath: "/bin/sh",
          piScriptPath: "/bin/sh",
          piPackageRoot: "/bin",
          resolutionMessage: "test direct repository write launcher"
        };
      }
    });
    const backend = createRawProcessWorkerBackend({
      repositoryRoot,
      launcher,
      processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.REQUIRED,
      sandboxProvider
    });

    const result = await backend.run(createPacket("implementer"), {});

    assert.equal(result.status, "failed");
    assert.match(result.summary, /launcher exited with code/i);
    assert.equal(result.evidence.includes("process_backend_os_sandbox: true"), true);
    assert.equal(result.evidence.includes("process_sandbox_provider: macos-sandbox-exec"), true);
    assert.equal(result.evidence.some((entry) => entry.startsWith("process_sandbox_profile: ")), true);
    assert.equal(await readFile(repositoryOutputPath, "utf8"), "original repository content");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend platform-unavailable sandbox path fails closed without unsandboxed fallback", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-platform-unavailable-"));
  let launchCount = 0;

  try {
    const backend = createRawProcessWorkerBackend({
      repositoryRoot,
      processSandbox: PROCESS_WORKER_SANDBOX_POLICIES.REQUIRED,
      sandboxProvider: createDefaultProcessSandboxProvider({ platform: "linux" }),
      launcher: async () => {
        launchCount += 1;
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --should-not-run"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {});

    assert.equal(result.status, "blocked");
    assert.equal(launchCount, 0);
    assert.match(result.summary, /required OS sandbox provider is unavailable/i);
    assert.equal(result.evidence.includes("process_sandbox_policy: required"), true);
    assert.equal(result.evidence.includes("process_backend_os_sandbox: false"), true);
    assert.equal(result.evidence.includes("process_sandbox_provider: linux-process-sandbox-unavailable"), true);
    assert.equal(result.evidence.includes("process_sandbox_available: false"), true);
    assert.equal(result.evidence.includes("unsandboxed_process_backend_opt_in: true"), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend reports launcher output buffer truncation evidence", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-output-buffer-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async () => ({
        launcher: "fake_launcher",
        exitCode: 0,
        stdout: "x".repeat(10),
        stderr: "y".repeat(10),
        stdoutTruncated: true,
        stderrTruncated: true,
        commandsRun: ["fake-worker --noisy-output"]
      })
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "output-buffer-truncation"
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.evidence.includes("stdout_buffer_truncated: true"), true);
    assert.equal(result.evidence.includes("stderr_buffer_truncated: true"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend redacts launcher-derived repo/workspace/external absolute paths in stdout and stderr", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-redaction-"));
  const repoAbsolutePath = join(repositoryRoot, "src", "launcher-output.js");
  const externalAbsolutePath = process.platform === "win32"
    ? "D:\\outside\\launcher-output.txt"
    : "/opt/outside/launcher-output.txt";
  const relativePath = "src/relative-output.js";
  let observedTargetAbsolutePath = null;

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ targetAbsolutePath }) => {
        observedTargetAbsolutePath = targetAbsolutePath;
        await mkdir(dirname(targetAbsolutePath), { recursive: true });
        await writeFile(targetAbsolutePath, "updated from process backend", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: [
            `repo_output: ${repoAbsolutePath}`,
            `workspace_output: ${targetAbsolutePath}`,
            `external_output: ${externalAbsolutePath}`,
            `relative_output: ${relativePath}`
          ].join(" "),
          stderr: [
            `repo_stderr: ${repoAbsolutePath}`,
            `workspace_stderr: ${targetAbsolutePath}`,
            `external_stderr: ${externalAbsolutePath}`,
            `relative_stderr: ${relativePath}`
          ].join(" "),
          commandsRun: ["fake-worker --write-output"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "process-redaction-workflow"
    });

    assert.equal(result.status, "success");
    assert.equal(
      result.evidence.some((entry) => entry.includes(repoAbsolutePath)),
      false
    );
    assert.equal(
      result.evidence.some((entry) => observedTargetAbsolutePath && entry.includes(observedTargetAbsolutePath)),
      false
    );
    assert.equal(
      result.evidence.some((entry) => entry.includes(externalAbsolutePath)),
      false
    );
    const stdoutEvidenceEntry = result.evidence.find((entry) => entry.startsWith("stdout: "));
    assert.equal(Boolean(stdoutEvidenceEntry), true);
    assert.equal(stdoutEvidenceEntry?.includes("repo_output: src/launcher-output.js"), true);
    assert.equal(stdoutEvidenceEntry?.includes("workspace_output: <process_workspace>/test/fixtures/process-worker-output.md"), true);
    assert.equal(stdoutEvidenceEntry?.includes("external_output: <absolute_path>"), true);
    assert.equal(stdoutEvidenceEntry?.includes(`relative_output: ${relativePath}`), true);

    const stderrEvidenceEntry = result.evidence.find((entry) => entry.startsWith("stderr: "));
    assert.equal(Boolean(stderrEvidenceEntry), true);
    assert.equal(stderrEvidenceEntry?.includes("repo_stderr: src/launcher-output.js"), true);
    assert.equal(stderrEvidenceEntry?.includes("workspace_stderr: <process_workspace>/test/fixtures/process-worker-output.md"), true);
    assert.equal(stderrEvidenceEntry?.includes("external_stderr: <absolute_path>"), true);
    assert.equal(stderrEvidenceEntry?.includes(`relative_stderr: ${relativePath}`), true);

    assert.equal(
      result.evidence.some((entry) => entry.includes("<process_workspace>")),
      true
    );
    assert.equal(
      result.evidence.some((entry) => entry.includes("<absolute_path>")),
      true
    );
    assert.equal(result.redaction.applied, true);
    assert.equal(result.redaction.repoPathRewrites > 0, true);
    assert.equal(result.redaction.workspacePathRewrites > 0, true);
    assert.equal(result.redaction.externalPathRewrites > 0, true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend redacts launcher metadata evidence and launch diagnostics with truthful boundary metadata", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-launch-metadata-redaction-"));
  const repoLauncherPath = join(repositoryRoot, "tools", "pi-launcher.js");
  const repoResolutionPath = join(repositoryRoot, "pi", "resolved", "pi.js");
  const repoErrorPath = join(repositoryRoot, "errors", "launch-error.js");
  const externalAbsolutePath = process.platform === "win32"
    ? "D:\\outside\\pi\\runtime"
    : "/opt/outside/pi/runtime";
  const relativeResolutionPath = "scripts/relative-pi.js";
  const relativeErrorPath = "logs/worker.log";
  let observedWorkspaceScriptPath = null;
  let observedWorkspaceResolutionPath = null;
  let observedWorkspaceErrorPath = null;

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ workspaceRoot }) => {
        observedWorkspaceScriptPath = join(workspaceRoot, "bin", "pi-worker.js");
        observedWorkspaceResolutionPath = join(workspaceRoot, "resolved", "pi-worker.js");
        observedWorkspaceErrorPath = join(workspaceRoot, "errors", "pi-worker-error.log");
        return {
          launcher: "fake_launcher",
          launcherPath: repoLauncherPath,
          piScriptPath: observedWorkspaceScriptPath,
          piPackageRoot: externalAbsolutePath,
          piSpawnResolution: [
            `repo_resolution: ${repoResolutionPath}`,
            `workspace_resolution: ${observedWorkspaceResolutionPath}`,
            `external_resolution: ${externalAbsolutePath}`,
            `relative_resolution: ${relativeResolutionPath}`
          ].join(" "),
          exitCode: null,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          error: new Error([
            "launcher resolution failed",
            `repo_error: ${repoErrorPath}`,
            `workspace_error: ${observedWorkspaceErrorPath}`,
            `external_error: ${externalAbsolutePath}`,
            `relative_error: ${relativeErrorPath}`
          ].join(" ")),
          durationMs: 4,
          commandsRun: ["fake-worker --launch-check"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "process-launch-metadata-redaction"
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.evidence.some((entry) => entry.includes(repoLauncherPath)), false);
    assert.equal(
      result.evidence.some((entry) => observedWorkspaceScriptPath && entry.includes(observedWorkspaceScriptPath)),
      false
    );
    assert.equal(result.evidence.some((entry) => entry.includes(externalAbsolutePath)), false);
    assert.equal(result.summary.includes(repoErrorPath), false);
    assert.equal(result.summary.includes(observedWorkspaceErrorPath ?? ""), false);
    assert.equal(result.summary.includes(externalAbsolutePath), false);

    assert.equal(result.evidence.includes("launcher_path: tools/pi-launcher.js"), true);
    assert.equal(result.evidence.includes("pi_script_path: <process_workspace>/bin/pi-worker.js"), true);
    assert.equal(result.evidence.includes("pi_package_root: <absolute_path>"), true);

    const spawnResolutionEntry = result.evidence.find((entry) => entry.startsWith("pi_spawn_resolution: "));
    assert.equal(Boolean(spawnResolutionEntry), true);
    assert.equal(spawnResolutionEntry?.includes("repo_resolution: pi/resolved/pi.js"), true);
    assert.equal(spawnResolutionEntry?.includes("workspace_resolution: <process_workspace>/resolved/pi-worker.js"), true);
    assert.equal(spawnResolutionEntry?.includes("external_resolution: <absolute_path>"), true);
    assert.equal(spawnResolutionEntry?.includes(`relative_resolution: ${relativeResolutionPath}`), true);

    const launchErrorEntry = result.evidence.find((entry) => entry.startsWith("launch_error: "));
    assert.equal(Boolean(launchErrorEntry), true);
    assert.equal(launchErrorEntry?.includes("repo_error: errors/launch-error.js"), true);
    assert.equal(launchErrorEntry?.includes("workspace_error: <process_workspace>/errors/pi-worker-error.log"), true);
    assert.equal(launchErrorEntry?.includes("external_error: <absolute_path>"), true);
    assert.equal(launchErrorEntry?.includes(`relative_error: ${relativeErrorPath}`), true);

    assert.equal(result.summary.includes("repo_error: errors/launch-error.js"), true);
    assert.equal(result.summary.includes("workspace_error: <process_workspace>/errors/pi-worker-error.log"), true);
    assert.equal(result.summary.includes("external_error: <absolute_path>"), true);
    assert.equal(result.summary.includes(`relative_error: ${relativeErrorPath}`), true);

    assert.deepEqual(result.redaction, {
      applied: true,
      repoPathRewrites: 5,
      workspacePathRewrites: 5,
      externalPathRewrites: 4
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend preserves relative launcher metadata evidence paths", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-relative-launch-metadata-"));
  const relativeLauncherPath = "bin/pi";
  const relativeScriptPath = "scripts/pi.js";
  const relativePackageRoot = "vendor/pi";
  const relativeResolutionPath = "scripts/resolve-pi.js";
  const relativeErrorPath = "logs/pi-error.log";

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async () => ({
        launcher: "fake_launcher",
        launcherPath: relativeLauncherPath,
        piScriptPath: relativeScriptPath,
        piPackageRoot: relativePackageRoot,
        piSpawnResolution: `relative_resolution: ${relativeResolutionPath}`,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        error: new Error(`relative_error: ${relativeErrorPath}`),
        durationMs: 1,
        commandsRun: ["fake-worker --relative-launch-metadata"]
      })
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "process-relative-launch-metadata"
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.evidence.includes(`launcher_path: ${relativeLauncherPath}`), true);
    assert.equal(result.evidence.includes(`pi_script_path: ${relativeScriptPath}`), true);
    assert.equal(result.evidence.includes(`pi_package_root: ${relativePackageRoot}`), true);
    assert.equal(result.evidence.includes(`pi_spawn_resolution: relative_resolution: ${relativeResolutionPath}`), true);
    assert.equal(result.evidence.includes(`launch_error: relative_error: ${relativeErrorPath}`), true);
    assert.equal(result.summary.includes(`relative_error: ${relativeErrorPath}`), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend deterministically truncates oversized stdout with an explicit marker before boundary redaction", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-stdout-cap-"));
  const repoAbsolutePath = join(repositoryRoot, "src", "long-stdout-path.js");
  const relativePath = "src/relative-stdout-path.js";
  const truncatedTailSentinel = "stdout-tail-should-not-survive-cap";
  const oversizedStdout = [
    `repo_stdout: ${repoAbsolutePath}`,
    `relative_stdout: ${relativePath}`,
    "payload:",
    "x".repeat(3000),
    truncatedTailSentinel
  ].join(" ");

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ targetAbsolutePath }) => {
        await mkdir(dirname(targetAbsolutePath), { recursive: true });
        await writeFile(targetAbsolutePath, "updated from process backend", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: oversizedStdout,
          stderr: "",
          commandsRun: ["fake-worker --write-output"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "process-stdout-cap-workflow"
    });

    assert.equal(result.status, "success");
    const stdoutEvidenceEntry = result.evidence.find((entry) => entry.startsWith("stdout: "));
    assert.equal(Boolean(stdoutEvidenceEntry), true);
    assert.equal(stdoutEvidenceEntry?.includes(BOUNDARY_TRUNCATION_MARKER_PREFIX), true);
    assert.equal(stdoutEvidenceEntry?.includes(BOUNDARY_TRUNCATION_MARKER_SUFFIX), true);
    assert.equal(stdoutEvidenceEntry?.includes(truncatedTailSentinel), false);
    assert.equal(stdoutEvidenceEntry?.includes(repoAbsolutePath), false);
    assert.equal(stdoutEvidenceEntry?.includes("repo_stdout: src/long-stdout-path.js"), true);
    assert.equal(stdoutEvidenceEntry?.includes(`relative_stdout: ${relativePath}`), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend deterministically truncates oversized stderr with an explicit marker before boundary redaction", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-stderr-cap-"));
  const repoAbsolutePath = join(repositoryRoot, "src", "long-stderr-path.js");
  const externalAbsolutePath = process.platform === "win32"
    ? "D:\\outside\\long-stderr-path.txt"
    : "/opt/outside/long-stderr-path.txt";
  const relativePath = "src/relative-stderr-path.js";
  const truncatedTailSentinel = "stderr-tail-should-not-survive-cap";
  const oversizedStderr = [
    `repo_stderr: ${repoAbsolutePath}`,
    `external_stderr: ${externalAbsolutePath}`,
    `relative_stderr: ${relativePath}`,
    "payload:",
    "y".repeat(3000),
    truncatedTailSentinel
  ].join(" ");

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ targetAbsolutePath }) => {
        await mkdir(dirname(targetAbsolutePath), { recursive: true });
        await writeFile(targetAbsolutePath, "updated from process backend", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "ok",
          stderr: oversizedStderr,
          commandsRun: ["fake-worker --write-output"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "process-stderr-cap-workflow"
    });

    assert.equal(result.status, "success");
    const stderrEvidenceEntry = result.evidence.find((entry) => entry.startsWith("stderr: "));
    assert.equal(Boolean(stderrEvidenceEntry), true);
    assert.equal(stderrEvidenceEntry?.includes(BOUNDARY_TRUNCATION_MARKER_PREFIX), true);
    assert.equal(stderrEvidenceEntry?.includes(BOUNDARY_TRUNCATION_MARKER_SUFFIX), true);
    assert.equal(stderrEvidenceEntry?.includes(truncatedTailSentinel), false);
    assert.equal(stderrEvidenceEntry?.includes(repoAbsolutePath), false);
    assert.equal(stderrEvidenceEntry?.includes(externalAbsolutePath), false);
    assert.equal(stderrEvidenceEntry?.includes("repo_stderr: src/long-stderr-path.js"), true);
    assert.equal(stderrEvidenceEntry?.includes("external_stderr: <absolute_path>"), true);
    assert.equal(stderrEvidenceEntry?.includes(`relative_stderr: ${relativePath}`), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend redacts read-only structured stdout path fields and preserves relative paths", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-readonly-redaction-"));
  const repoSummaryPath = join(repositoryRoot, "notes", "summary.md");
  const repoEvidencePath = join(repositoryRoot, "notes", "evidence.md");
  const repoQuestionPath = join(repositoryRoot, "notes", "question.md");
  const externalAbsolutePath = process.platform === "win32"
    ? "D:\\outside\\readonly-launcher-output.txt"
    : "/opt/outside/readonly-launcher-output.txt";
  const relativePath = "notes/relative-path.md";
  let observedWorkspacePath = null;

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ workspaceRoot }) => {
        observedWorkspacePath = join(workspaceRoot, "notes", "workspace.md");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: JSON.stringify({
            status: "blocked",
            summary: [
              `repo_summary: ${repoSummaryPath}`,
              `workspace_summary: ${observedWorkspacePath}`,
              `external_summary: ${externalAbsolutePath}`,
              `relative_summary: ${relativePath}`
            ].join(" "),
            evidence: [
              `repo_evidence: ${repoEvidencePath}`,
              `workspace_evidence: ${observedWorkspacePath}`,
              `external_evidence: ${externalAbsolutePath}`,
              `relative_evidence: ${relativePath}`
            ],
            openQuestions: [
              `repo_question: ${repoQuestionPath}`,
              `workspace_question: ${observedWorkspacePath}`,
              `external_question: ${externalAbsolutePath}`,
              `relative_question: ${relativePath}`
            ]
          }),
          stderr: [
            `workspace_stderr: ${observedWorkspacePath}`,
            `external_stderr: ${externalAbsolutePath}`,
            `relative_stderr: ${relativePath}`
          ].join(" "),
          commandsRun: ["fake-worker --reviewer"]
        };
      }
    });

    const result = await backend.run(createPacket("reviewer"), {
      workflowId: "process-readonly-redaction-workflow"
    });

    validateWorkerResult(result);
    assert.equal(result.status, "blocked");
    assert.equal(result.summary.includes(repoSummaryPath), false);
    assert.equal(result.summary.includes(observedWorkspacePath ?? ""), false);
    assert.equal(result.summary.includes(externalAbsolutePath), false);
    assert.equal(result.summary.includes("repo_summary: notes/summary.md"), true);
    assert.equal(result.summary.includes("workspace_summary: <process_workspace>/notes/workspace.md"), true);
    assert.equal(result.summary.includes("external_summary: <absolute_path>"), true);
    assert.equal(result.summary.includes(`relative_summary: ${relativePath}`), true);

    assert.equal(result.evidence.some((entry) => entry.includes(repoEvidencePath)), false);
    assert.equal(result.evidence.some((entry) => observedWorkspacePath && entry.includes(observedWorkspacePath)), false);
    assert.equal(result.evidence.some((entry) => entry.includes(externalAbsolutePath)), false);
    assert.equal(result.evidence.includes("repo_evidence: notes/evidence.md"), true);
    assert.equal(result.evidence.includes("workspace_evidence: <process_workspace>/notes/workspace.md"), true);
    assert.equal(result.evidence.includes("external_evidence: <absolute_path>"), true);
    assert.equal(result.evidence.includes(`relative_evidence: ${relativePath}`), true);

    assert.equal(result.openQuestions.some((entry) => entry.includes(repoQuestionPath)), false);
    assert.equal(result.openQuestions.some((entry) => observedWorkspacePath && entry.includes(observedWorkspacePath)), false);
    assert.equal(result.openQuestions.some((entry) => entry.includes(externalAbsolutePath)), false);
    assert.equal(result.openQuestions.includes("repo_question: notes/question.md"), true);
    assert.equal(result.openQuestions.includes("workspace_question: <process_workspace>/notes/workspace.md"), true);
    assert.equal(result.openQuestions.includes("external_question: <absolute_path>"), true);
    assert.equal(result.openQuestions.includes(`relative_question: ${relativePath}`), true);

    const stderrEvidenceEntry = result.evidence.find((entry) => entry.startsWith("stderr: "));
    assert.equal(Boolean(stderrEvidenceEntry), true);
    assert.equal(stderrEvidenceEntry?.includes("workspace_stderr: <process_workspace>/notes/workspace.md"), true);
    assert.equal(stderrEvidenceEntry?.includes("external_stderr: <absolute_path>"), true);
    assert.equal(stderrEvidenceEntry?.includes(`relative_stderr: ${relativePath}`), true);

    assert.equal(result.redaction.applied, true);
    assert.equal(result.redaction.repoPathRewrites > 0, true);
    assert.equal(result.redaction.workspacePathRewrites > 0, true);
    assert.equal(result.redaction.externalPathRewrites > 0, true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend redacts review finding messages and reports truthful boundary redaction metadata", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-review-findings-redaction-"));
  const repoAbsolutePath = join(repositoryRoot, "src", "review-finding-message.js");
  const externalAbsolutePath = process.platform === "win32"
    ? "D:\\outside\\review-finding-message.txt"
    : "/opt/outside/review-finding-message.txt";
  const relativePath = "src/relative-review-finding-message.js";
  const findingPath = "src\\existing-finding-path.js";
  let observedWorkspacePath = null;

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ workspaceRoot }) => {
        observedWorkspacePath = join(workspaceRoot, "notes", "workspace-review-finding.md");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: JSON.stringify({
            status: "repair_required",
            summary: "Review identified one blocking issue.",
            evidence: ["Scoped review completed."],
            openQuestions: [],
            reviewFindings: [
              {
                kind: "issue",
                severity: "high",
                message: `repo_message: ${repoAbsolutePath}`,
                path: findingPath
              },
              {
                kind: "risk",
                severity: "medium",
                message: `workspace_message: ${observedWorkspacePath}`
              },
              {
                kind: "gap",
                severity: "low",
                message: `external_message: ${externalAbsolutePath}`
              },
              {
                kind: "gap",
                severity: "low",
                message: `relative_message: ${relativePath}`
              }
            ]
          }),
          stderr: "",
          commandsRun: ["fake-worker --review"]
        };
      }
    });

    const result = await backend.run(createPacket("reviewer"), {
      workflowId: "process-review-findings-redaction-workflow"
    });

    validateWorkerResult(result);
    assert.equal(result.status, "repair_required");
    assert.deepEqual(result.reviewFindings, [
      {
        kind: "issue",
        severity: "high",
        message: "repo_message: src/review-finding-message.js",
        path: "src/existing-finding-path.js"
      },
      {
        kind: "risk",
        severity: "medium",
        message: "workspace_message: <process_workspace>/notes/workspace-review-finding.md"
      },
      {
        kind: "gap",
        severity: "low",
        message: "external_message: <absolute_path>"
      },
      {
        kind: "gap",
        severity: "low",
        message: `relative_message: ${relativePath}`
      }
    ]);

    assert.equal(
      result.reviewFindings.some((entry) => entry.message.includes(repoAbsolutePath)),
      false
    );
    assert.equal(
      result.reviewFindings.some((entry) => observedWorkspacePath && entry.message.includes(observedWorkspacePath)),
      false
    );
    assert.equal(
      result.reviewFindings.some((entry) => entry.message.includes(externalAbsolutePath)),
      false
    );

    assert.deepEqual(result.redaction, {
      applied: true,
      repoPathRewrites: 3,
      workspacePathRewrites: 3,
      externalPathRewrites: 2
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend preserves trusted provider/model selection on launcher timeout failures", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-timeout-selection-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async () => ({
        launcher: "fake_launcher",
        exitCode: null,
        timedOut: true,
        stdout: "",
        stderr: "",
        commandsRun: ["fake-worker --timeout"],
        launchSelection: {
          requestedProvider: "openai-codex",
          requestedModel: "gpt-5.3-codex",
          selectedProvider: "openai-codex",
          selectedModel: "gpt-5.3-codex"
        }
      })
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "timeout-selection-failure"
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /launcher timed out/i);
    assert.deepEqual(result.providerModelSelection, {
      requestedProvider: "openai-codex",
      requestedModel: "gpt-5.3-codex",
      selectedProvider: "openai-codex",
      selectedModel: "gpt-5.3-codex"
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend launcher timeout escalates from SIGTERM to forced termination", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-timeout-escalation-"));
  const ignoreSigtermScript = "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);";

  try {
    const launcher = createPiCliLauncher({
      timeoutMs: 50,
      timeoutKillGraceMs: 50,
      argsBuilder: async ({ prompt }) => ["-p", "--no-session", prompt],
      spawnCommandResolver: async () => ({
        command: process.execPath,
        argsPrefix: ["-e", ignoreSigtermScript, "--"],
        launcher: "node_ignores_sigterm",
        launcherPath: process.execPath,
        piScriptPath: process.execPath,
        piPackageRoot: dirname(process.execPath),
        resolutionMessage: "test node process ignores SIGTERM"
      })
    });
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "timeout-escalation"
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /launcher timed out/i);
    assert.equal(result.evidence.includes("timed_out: true"), true);
    assert.equal(result.evidence.includes("timeout_signal: SIGTERM"), true);
    assert.equal(result.evidence.includes("timeout_forced_termination_attempted: true"), true);
    assert.equal(result.evidence.includes("timeout_forced_signal: SIGKILL"), true);
    assert.equal(result.evidence.includes("timeout_budget_ms: 50"), true);
    assert.equal(backend.getTimeoutBudgetMs(), 50);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend preserves trusted provider/model selection on launcher non-zero exit failures", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-exit-selection-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async () => ({
        launcher: "fake_launcher",
        exitCode: 9,
        timedOut: false,
        stdout: "",
        stderr: "non-zero exit",
        commandsRun: ["fake-worker --non-zero"],
        launchSelection: {
          requestedProvider: "openai-codex",
          requestedModel: "gpt-5.4-mini",
          selectedProvider: "openai-codex",
          selectedModel: "gpt-5.4-mini"
        }
      })
    });

    const result = await backend.run(createPacket("verifier"), {
      workflowId: "non-zero-selection-failure"
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /launcher exited with code 9/i);
    assert.deepEqual(result.providerModelSelection, {
      requestedProvider: "openai-codex",
      requestedModel: "gpt-5.4-mini",
      selectedProvider: "openai-codex",
      selectedModel: "gpt-5.4-mini"
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend handles non-cloneable context values without crashing", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-non-cloneable-context-"));

  try {
    let capturedContext;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ targetAbsolutePath, context }) => {
        capturedContext = context;

        await mkdir(dirname(targetAbsolutePath), { recursive: true });
        await writeFile(targetAbsolutePath, "updated from process backend", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "created process output",
          stderr: "",
          commandsRun: ["fake-worker --write-output"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "workflow-with-function-context",
      callbacks: {
        onComplete() {
          return "done";
        }
      }
    });

    validateWorkerResult(result);
    assert.equal(result.status, "success");

    const calls = backend.getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].context.workflowId, "workflow-with-function-context");
    assert.equal(typeof calls[0].context.callbacks.onComplete, "string");
    assert.match(calls[0].context.callbacks.onComplete, /uncloneable/i);

    assert.equal(capturedContext.workflowId, "workflow-with-function-context");
    assert.equal(typeof capturedContext.callbacks.onComplete, "string");
    assert.match(capturedContext.callbacks.onComplete, /uncloneable/i);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend applies implementer changes back to the repository root on success", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-repo-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ targetAbsolutePath }) => {
        await mkdir(dirname(targetAbsolutePath), { recursive: true });
        await writeFile(targetAbsolutePath, "updated from process backend", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "created process output",
          stderr: "",
          commandsRun: ["fake-worker --write-output"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "process-test-workflow"
    });

    assert.equal(result.status, "success");
    const repoFile = await readFile(join(repositoryRoot, "test", "fixtures", "process-worker-output.md"), "utf8");
    assert.equal(repoFile, "updated from process backend");
    assert.equal(
      result.evidence.includes("repository_changes_applied: true"),
      true
    );
    assert.deepEqual(result.changedSurfaceObservation, {
      capture: "complete",
      paths: ["test/fixtures/process-worker-output.md"]
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend blocks exit-zero implementer runs with no changes or validation evidence", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-noop-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async () => ({
        launcher: "fake_launcher",
        exitCode: 0,
        stdout: "no-op run",
        stderr: "",
        commandsRun: ["fake-worker --noop"]
      })
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "process-test-workflow-noop"
    });

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /no changed files were captured/i);
    assert.deepEqual(result.changedFiles, []);
    assert.equal(
      result.evidence.includes("repository_changes_applied: false"),
      true
    );
    assert.equal(result.evidence.includes("validation_evidence_captured: false"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend blocks no-op implementer runs with launcher-reported validation evidence only", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-noop-validation-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async () => ({
        launcher: "fake_launcher",
        exitCode: 0,
        stdout: "no-op validation run",
        stderr: "",
        commandsRun: ["fake-worker --validate"],
        validationEvidence: ["targeted validation command exited 0"]
      })
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "process-test-workflow-noop-validation"
    });

    assert.equal(result.status, "blocked");
    assert.deepEqual(result.changedFiles, []);
    assert.equal(result.evidence.includes("validation_evidence_captured: untrusted_launcher_reported"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend rolls back repository writes when apply fails mid-commit", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-atomic-"));

  try {
    await mkdir(join(repositoryRoot, "examples"), { recursive: true });
    await writeFile(join(repositoryRoot, "examples", "a.md"), "repo a original", "utf8");
    await writeFile(join(repositoryRoot, "examples", "b.md"), "repo b original", "utf8");

    let stagedMoveCount = 0;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      moveFileFn: async (sourcePath, destinationPath) => {
        const source = normalizeFilePath(sourcePath);
        const destination = normalizeFilePath(destinationPath);
        const isStagedWriteIntoRepo = source.includes("/.pi-orchestrator-apply-")
          && source.includes("/staged/")
          && destination.includes("/examples/");

        if (isStagedWriteIntoRepo) {
          stagedMoveCount += 1;
          if (stagedMoveCount === 2) {
            throw new Error("simulated mid-apply failure");
          }
        }

        await rename(sourcePath, destinationPath);
      },
      launcher: async ({ workspaceRoot }) => {
        await mkdir(join(workspaceRoot, "examples"), { recursive: true });
        await writeFile(join(workspaceRoot, "examples", "a.md"), "repo a updated", "utf8");
        await writeFile(join(workspaceRoot, "examples", "b.md"), "repo b updated", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "updated two files",
          stderr: "",
          commandsRun: ["fake-worker --write-two-files"],
          launchSelection: {
            requestedProvider: "openai-codex",
            requestedModel: "gpt-5.3-codex",
            selectedProvider: "openai-codex",
            selectedModel: "gpt-5.3-codex"
          }
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["examples/a.md", "examples/b.md"]
    }), {
      workflowId: "process-test-workflow"
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /failed to apply changed files atomically/i);
    assert.deepEqual(result.providerModelSelection, {
      requestedProvider: "openai-codex",
      requestedModel: "gpt-5.3-codex",
      selectedProvider: "openai-codex",
      selectedModel: "gpt-5.3-codex"
    });

    const repoA = await readFile(join(repositoryRoot, "examples", "a.md"), "utf8");
    const repoB = await readFile(join(repositoryRoot, "examples", "b.md"), "utf8");
    assert.equal(repoA, "repo a original");
    assert.equal(repoB, "repo b original");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend rejects hardlinked workspace changed files before apply", {
  skip: process.platform === "win32"
}, async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-hardlink-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ workspaceRoot }) => {
        await mkdir(join(workspaceRoot, "docs"), { recursive: true });
        const changedPath = join(workspaceRoot, "docs", "guide.md");
        await writeFile(changedPath, "hardlinked content", "utf8");
        await link(changedPath, join(workspaceRoot, "docs", "guide-alias.md"));
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "created hardlinked files",
          stderr: "",
          commandsRun: ["fake-worker --hardlink-output"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["docs/"]
    }), {
      workflowId: "hardlink-apply-rejection"
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /hardlinked to multiple directory entries/i);
    assert.equal(await exists(join(repositoryRoot, "docs", "guide.md")), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend rejects repository destination symlink swaps at apply write boundary and rolls back", {
  skip: process.platform === "win32"
}, async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-symlink-swap-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-symlink-swap-outside-"));

  try {
    await mkdir(join(repositoryRoot, "docs"), { recursive: true });
    await writeFile(join(repositoryRoot, "docs", "guide.md"), "repo original", "utf8");
    await writeFile(join(outsideRoot, "outside.md"), "outside original", "utf8");

    let swapped = false;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      moveFileFn: async (sourcePath, destinationPath) => {
        await rename(sourcePath, destinationPath);
        if (!swapped && normalizeFilePath(sourcePath).endsWith("/docs/guide.md")) {
          swapped = true;
          await symlink(join(outsideRoot, "outside.md"), join(repositoryRoot, "docs", "guide.md"));
        }
      },
      launcher: async ({ workspaceRoot }) => {
        await mkdir(join(workspaceRoot, "docs"), { recursive: true });
        await writeFile(join(workspaceRoot, "docs", "guide.md"), "repo updated", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "updated guide",
          stderr: "",
          commandsRun: ["fake-worker --write-guide"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["docs/guide.md"]
    }), {
      workflowId: "symlink-swap-apply-rejection"
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /repository changed file must not be a symlink/i);
    assert.equal(await readFile(join(repositoryRoot, "docs", "guide.md"), "utf8"), "repo original");
    assert.equal(await readFile(join(outsideRoot, "outside.md"), "utf8"), "outside original");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("process backend seeds file scope entries into the isolated workspace", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-seed-file-"));

  try {
    const expectedContent = "export const seeded = true;\n";
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await writeFile(join(repositoryRoot, "src", "seeded-file.js"), expectedContent, "utf8");

    let seededContent = null;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ workspaceRoot }) => {
        seededContent = await readFile(join(workspaceRoot, "src", "seeded-file.js"), "utf8");
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --inspect-seeded-file"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["src/seeded-file.js"]
    }), {});

    assert.equal(result.status, "blocked");
    assert.equal(seededContent, expectedContent);
    assert.equal(result.evidence.includes("copied_seed_files: src/seeded-file.js"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend seeds directory scope entries into the isolated workspace", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-seed-dir-"));

  try {
    await mkdir(join(repositoryRoot, "docs", "nested"), { recursive: true });
    await writeFile(join(repositoryRoot, "docs", "guide.md"), "guide content", "utf8");
    await writeFile(join(repositoryRoot, "docs", "nested", "notes.md"), "nested notes", "utf8");

    let guideContent = null;
    let nestedContent = null;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ workspaceRoot }) => {
        guideContent = await readFile(join(workspaceRoot, "docs", "guide.md"), "utf8");
        nestedContent = await readFile(join(workspaceRoot, "docs", "nested", "notes.md"), "utf8");
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --inspect-seeded-directory"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["docs/"]
    }), {});

    assert.equal(result.status, "blocked");
    assert.equal(guideContent, "guide content");
    assert.equal(nestedContent, "nested notes");
    assert.equal(result.evidence.includes("copied_seed_files: docs/"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend rejects symlink directory scope seeds before launch", {
  skip: process.platform === "win32"
}, async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-symlink-scope-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-outside-"));

  try {
    await writeFile(join(outsideRoot, "outside.txt"), "outside original", "utf8");
    await symlink(outsideRoot, join(repositoryRoot, "linkdir"), "dir");

    let launchCount = 0;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async () => {
        launchCount += 1;
        await writeFile(join(outsideRoot, "outside.txt"), "mutated outside", "utf8");
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --mutate-symlink-target"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["linkdir/"]
    }), {});

    assert.equal(result.status, "failed");
    assert.match(result.summary, /seed source file.*symlink/i);
    assert.equal(launchCount, 0);
    assert.equal(await readFile(join(outsideRoot, "outside.txt"), "utf8"), "outside original");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("process backend rejects nested symlinks in directory scope seeds before launch", {
  skip: process.platform === "win32"
}, async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-nested-symlink-scope-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-outside-"));

  try {
    await mkdir(join(repositoryRoot, "docs"), { recursive: true });
    await writeFile(join(repositoryRoot, "docs", "guide.md"), "guide content", "utf8");
    await writeFile(join(outsideRoot, "outside.txt"), "outside original", "utf8");
    await symlink(outsideRoot, join(repositoryRoot, "docs", "outside-link"), "dir");

    let launchCount = 0;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async () => {
        launchCount += 1;
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --inspect-seeded-directory"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["docs/"]
    }), {});

    assert.equal(result.status, "failed");
    assert.match(result.summary, /seed source file.*symlink/i);
    assert.equal(launchCount, 0);
    assert.equal(await readFile(join(outsideRoot, "outside.txt"), "utf8"), "outside original");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("process backend reports missing directory scope seeds without failing", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-missing-dir-"));

  try {
    let docsDirectoryExistsInWorkspace = true;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ workspaceRoot }) => {
        docsDirectoryExistsInWorkspace = await exists(join(workspaceRoot, "docs"));
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --inspect-missing-directory-seed"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["docs/"]
    }), {});

    assert.equal(result.status, "blocked");
    assert.equal(docsDirectoryExistsInWorkspace, false);
    assert.equal(result.evidence.includes("missing_seed_files: docs/"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend accepts nested changed files when allowlist contains a directory scope", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-dir-allowlist-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ workspaceRoot }) => {
        await mkdir(join(workspaceRoot, "docs"), { recursive: true });
        await writeFile(join(workspaceRoot, "docs", "guide.md"), "updated guide", "utf8");
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --write-docs-guide"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["docs/"]
    }), {});

    assert.equal(result.status, "success");
    assert.deepEqual(result.changedFiles, ["docs/guide.md"]);
    const repoGuide = await readFile(join(repositoryRoot, "docs", "guide.md"), "utf8");
    assert.equal(repoGuide, "updated guide");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend maps reviewer JSON output to repair_required without file changes", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-reviewer-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async () => ({
        launcher: "fake_launcher",
        exitCode: 0,
        stdout: JSON.stringify({
          status: "repair_required",
          summary: "Missing a targeted regression test.",
          evidence: ["No regression test command was present."],
          openQuestions: ["Should the fix add a unit test or an integration test?"]
        }),
        stderr: "",
        commandsRun: ["fake-worker --review"]
      })
    });

    const result = await backend.run(createPacket("reviewer"), {
      workflowId: "reviewer-test-workflow"
    });

    validateWorkerResult(result);
    assert.equal(result.status, "repair_required");
    assert.equal(result.changedFiles.length, 0);
    assert.match(result.summary, /missing a targeted regression test/i);
    assert.equal(
      result.evidence.includes("No regression test command was present."),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend preserves typed review findings from structured read-only reviewer JSON", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-reviewer-findings-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async () => ({
        launcher: "fake_launcher",
        exitCode: 0,
        stdout: JSON.stringify({
          status: "repair_required",
          summary: "Review identified one blocking issue.",
          evidence: ["Scoped review completed."],
          openQuestions: [],
          reviewFindings: [
            {
              kind: "issue",
              severity: "high",
              message: "Missing guard around optional helper output.",
              path: "src\\helpers.js"
            },
            {
              kind: "gap",
              severity: "medium",
              message: "No regression test artifact was captured."
            }
          ]
        }),
        stderr: "",
        commandsRun: ["fake-worker --review"]
      })
    });

    const result = await backend.run(createPacket("reviewer"), {
      workflowId: "reviewer-findings-test-workflow"
    });

    validateWorkerResult(result);
    assert.equal(result.status, "repair_required");
    assert.deepEqual(result.reviewFindings, [
      {
        kind: "issue",
        severity: "high",
        message: "Missing guard around optional helper output.",
        path: "src/helpers.js"
      },
      {
        kind: "gap",
        severity: "medium",
        message: "No regression test artifact was captured."
      }
    ]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend does not fail open for read-only plain-text output", async () => {
  const launchAttemptsByRole = new Map();
  const backend = createProcessWorkerBackend({
    launcher: async ({ packet }) => {
      const currentAttempt = (launchAttemptsByRole.get(packet.role) ?? 0) + 1;
      launchAttemptsByRole.set(packet.role, currentAttempt);

      return {
        launcher: "fake_launcher",
        exitCode: 0,
        stdout: `${packet.role} plain text output attempt ${currentAttempt}`,
        stderr: `attempt-${currentAttempt}-stderr`,
        commandsRun: [`fake-worker --${packet.role}`]
      };
    }
  });

  for (const role of ["explorer", "reviewer", "verifier"]) {
    const result = await backend.run(createPacket(role), {
      workflowId: `${role}-plain-text-output`
    });

    validateWorkerResult(result);
    assert.equal(result.status, "failed");
    assert.match(result.summary, /invalid structured read-only output/i);
    assert.equal(launchAttemptsByRole.get(role), 2);
    assert.equal(
      result.evidence.includes("read_only_json_repair_retry_attempted: true"),
      true
    );
    assert.equal(
      result.evidence.includes("read_only_structured_output_valid_first_attempt: false"),
      true
    );
    assert.equal(
      result.evidence.includes("read_only_structured_output_valid_retry_attempt: false"),
      true
    );
    assert.equal(
      result.evidence.includes("read_only_retry_failure_reason: first_and_retry_outputs_invalid_json"),
      true
    );
    assert.equal(
      result.evidence.some((entry) => entry.startsWith("stdout: ")),
      true
    );
    assert.equal(
      result.evidence.some((entry) => entry.startsWith("retry_stdout: ")),
      true
    );
    assert.equal(
      result.evidence.includes("read_only_structured_output_valid: false"),
      true
    );
  }
});

test("process backend preserves trusted provider/model selection on invalid structured read-only output after retry", async () => {
  const backend = createProcessWorkerBackend({
    launcher: async () => ({
      launcher: "fake_launcher",
      exitCode: 0,
      stdout: "reviewer plain text output",
      stderr: "",
      commandsRun: ["fake-worker --reviewer"],
      launchSelection: {
        requestedProvider: "openai-codex",
        requestedModel: "gpt-5.4",
        selectedProvider: "openai-codex",
        selectedModel: "gpt-5.4"
      }
    })
  });

  const result = await backend.run(createPacket("reviewer"), {
    workflowId: "reviewer-invalid-json-selection"
  });

  validateWorkerResult(result);
  assert.equal(result.status, "failed");
  assert.match(result.summary, /invalid structured read-only output/i);
  assert.deepEqual(result.providerModelSelection, {
    requestedProvider: "openai-codex",
    requestedModel: "gpt-5.4",
    selectedProvider: "openai-codex",
    selectedModel: "gpt-5.4"
  });
});

test("process backend converts invalid read-only first output into structured retry output", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-readonly-retry-success-"));
  let launchCount = 0;

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ packet }) => {
        launchCount += 1;
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: launchCount === 1
            ? `${packet.role} plain text output`
            : JSON.stringify({
              status: "repair_required",
              summary: "Retry produced structured reviewer output.",
              evidence: ["Structured retry output parsed successfully."],
              openQuestions: ["Should reviewer strict mode become the default?"]
            }),
          stderr: "",
          commandsRun: [`fake-worker --${packet.role}`]
        };
      }
    });

    const result = await backend.run(createPacket("reviewer"), {
      workflowId: "reviewer-retry-success"
    });

    validateWorkerResult(result);
    assert.equal(launchCount, 2);
    assert.equal(result.status, "repair_required");
    assert.match(result.summary, /retry produced structured reviewer output/i);
    assert.equal(
      result.evidence.includes("read_only_json_repair_retry_attempted: true"),
      true
    );
    assert.equal(
      result.evidence.includes("read_only_structured_output_source: retry_attempt"),
      true
    );
    assert.equal(
      result.evidence.includes("read_only_structured_output_valid: true"),
      true
    );
    assert.equal(
      result.evidence.some((entry) => entry.startsWith("retry_stdout: ")),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend does not retry implementer runs for structured output parsing", async () => {
  let launchCount = 0;
  const backend = createProcessWorkerBackend({
    launcher: async () => {
      launchCount += 1;
      return {
        launcher: "fake_launcher",
        exitCode: 0,
        stdout: "implementer plain text output",
        stderr: "",
        commandsRun: ["fake-worker --implementer"]
      };
    }
  });

  const result = await backend.run(createPacket("implementer"), {
    workflowId: "implementer-no-retry"
  });

  validateWorkerResult(result);
  assert.equal(result.status, "blocked");
  assert.equal(launchCount, 1);
  assert.equal(
    result.evidence.some((entry) => entry.startsWith("read_only_json_repair_retry_attempted:")),
    false
  );
});

test("explorer launcher prompt treats a missing target file as inspectable context", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-explorer-prompt-"));
  let capturedPrompt = null;

  try {
    const launcher = createPiCliLauncher({
      argsBuilder: async ({ prompt }) => {
        capturedPrompt = prompt;
        return ["-p", "--no-session", "--thinking", "off", prompt];
      },
      spawnCommandResolver: async () => ({
        command: process.execPath,
        argsPrefix: [],
        launcher: "test_launcher",
        launcherPath: process.execPath,
        piScriptPath: __filename,
        piPackageRoot: dirname(__filename),
        resolutionMessage: "test resolution"
      }),
      runCommandFn: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "{\"status\":\"success\",\"summary\":\"inspected\",\"evidence\":[],\"openQuestions\":[]}",
        stderr: ""
      })
    });

    await launcher({
      packet: createPacket("explorer", {
        risk: "high",
        goal: "Inspect the scoped codebase context for this task and report what the implementer should change: Create test/fixtures/model-evidence-target.md containing exactly MODEL EVIDENCE TARGET OK and stop.",
        allowedFiles: ["test/fixtures/model-evidence-target.md"]
      }),
      context: {},
      workspaceRoot
    });

    assert.equal(typeof capturedPrompt, "string");
    assert.match(
      capturedPrompt,
      /YOUR_READ_ONLY_OBJECTIVE: Inspect the allowed scope, describe the relevant context, and tell the implementer what should be created or changed\./i
    );
    assert.match(
      capturedPrompt,
      /ORIGINAL_IMPLEMENTER_TASK: Inspect the scoped codebase context for this task and report what the implementer should change: Create test\/fixtures\/model-evidence-target\.md containing exactly MODEL EVIDENCE TARGET OK and stop\./i
    );
    assert.match(
      capturedPrompt,
      /If an allowed target file does not exist yet, report that fact and describe what the implementer should create/i
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("launcher prompt includes advisory common and role-specific contract guidance for each worker role", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-role-contract-prompts-"));
  const roleExpectations = [
    {
      role: "explorer",
      snippets: [
        /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/EXPLORER\.md/u,
        /Roles define what a worker may do, may not do, must prove, and when it must stop\./iu,
        /explorer is a read-only repo-understanding role\./iu,
        /Fail closed on ambiguity about correctness, scope, authority, or evidence\./iu,
        /open-ended planning or implementation advice when a factual answer is enough/iu,
        /Return exactly one JSON object using the enforced worker-result schema fields: status, summary, evidence, and openQuestions\./iu,
        /the smallest useful follow-up read, check, or handoff when one is needed\./iu
      ],
      legacyAbsent: [
        /\banswer\b:\s*the bounded factual answer to the repo question/iu,
        /\bevidence_refs\b/iu,
        /\bopen_uncertainties\b/iu,
        /\brecommended_next_step\b/iu
      ]
    },
    {
      role: "implementer",
      snippets: [
        /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/IMPLEMENTER\.md/u,
        /Roles define what a worker may do, may not do, must prove, and when it must stop\./iu,
        /implementer is the write-capable execution role for an approved slice\./iu,
        /semantic correctness/iu,
        /durability/iu,
        /Prefer the smallest sufficient correct change, not the smallest diff\./iu,
        /Treat markdown guidance as advisory behavior shaping, not as permission to bypass code-enforced policy\./iu,
        /Fix the root cause when it is visible and safely in scope\./iu,
        /what_was_verified: the tests, checks, or inspections actually performed/iu
      ]
    },
    {
      role: "reviewer",
      snippets: [
        /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/REVIEWER\.md/u,
        /Roles define what a worker may do, may not do, must prove, and when it must stop\./iu,
        /reviewer is a read-only ship or no-ship judgment role\./iu,
        /Attack the patch at the layer where it can fail: behavior, contracts, persistence, validation, operator surface, and maintainability\./iu,
        /the fix is at the wrong layer/iu,
        /Return exactly one JSON object using the enforced worker-result schema fields: status, summary, evidence, and openQuestions\./iu,
        /status: use success when no grounded finding requires repair and the inspected evidence is sufficient for the scoped claim; use repair_required when at least one grounded finding means the change should not ship yet; use blocked when the review cannot be completed honestly because required evidence is missing or the claim cannot be checked\./iu
      ],
      legacyAbsent: [
        /\bPASS\b/u,
        /\bREPAIR_REQUIRED\b/u,
        /\bBLOCKED\b/u
      ]
    },
    {
      role: "verifier",
      snippets: [
        /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/VERIFIER\.md/u,
        /Roles define what a worker may do, may not do, must prove, and when it must stop\./iu,
        /verifier is a proof and evidence-sufficiency role\./iu,
        /The verifier answers "was this demonstrated\?" not "should this ship\?"/iu,
        /In evidence, include commands_run: \.\.\. with the exact commands actually executed, or not run\./iu,
        /Current v1 now persists a narrow first-class reviewability object/iu,
        /run_journal\.contractRuns\[\]\.providerModelEvidenceRequirement/iu,
        /required\s*\|\s*unknown/iu,
        /Return exactly one JSON object using the enforced worker-result schema fields: status, summary, evidence, and openQuestions\./iu,
        /summary: the short verification outcome, including whether the claim was demonstrated, disproved, or remains unproven\./iu
      ],
      legacyAbsent: [
        /\bverified\b/u,
        /\bnot_verified\b/u,
        /\bpartially_verified\b/u
      ]
    }
  ];

  try {
    for (const { role, snippets, legacyAbsent = [] } of roleExpectations) {
      const prompts = [];
      const launcher = createPromptCaptureLauncher({ prompts });

      await launcher({
        packet: createPacket(role),
        context: {},
        workspaceRoot
      });

      assert.equal(prompts.length, 1);
      assert.match(
        prompts[0],
        /These markdown contracts shape worker behavior only\. Code-enforced boundaries, status rules, and policy checks remain authoritative\./iu
      );

      if (role === "implementer") {
        assert.match(prompts[0], /Only modify files in ALLOWED_FILES\./iu);
        assert.match(
          prompts[0],
          /Keep changes task-scoped, but prefer the smallest sufficient correct change, not the smallest diff\./iu
        );
        assert.doesNotMatch(prompts[0], /Keep changes minimal and task-scoped\./iu);
      } else {
        assert.match(prompts[0], /Do not modify any files\./iu);
      }

      for (const snippet of snippets) {
        assert.match(prompts[0], snippet);
      }

      for (const legacySnippet of legacyAbsent) {
        assert.doesNotMatch(prompts[0], legacySnippet);
      }
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("process backend keeps implementer prompts usable when the advisory role doc is missing", async () => {
  const prompts = [];
  const backend = createProcessWorkerBackend({
    launcher: createPromptCaptureLauncher({
      prompts,
      launcherOptions: {
        roleContractGuidanceLoader: () => loadRoleContractGuidance({
          readFileFn: (url, encoding) => {
            if (String(url).endsWith("/IMPLEMENTER.md")) {
              throw new Error("advisory role doc missing");
            }

            return readFileSync(url, encoding);
          }
        })
      }
    })
  });

  const result = await backend.run(createPacket("implementer"), {
    workflowId: "implementer-missing-advisory-doc"
  });

  assert.equal(result.status, "blocked");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/IMPLEMENTER\.md/iu);
  assert.match(prompts[0], /Advisory doc status: docs\/agents\/IMPLEMENTER\.md fallback active \(advisory role doc missing\)\./iu);
  assert.match(
    prompts[0],
    /Work only inside ALLOWED_FILES, keep the change task-scoped, and stop after the scoped edit is complete\./iu
  );
  assert.match(prompts[0], /Treat markdown guidance as advisory behavior shaping, not as permission to bypass code-enforced policy\./iu);
  assert.match(prompts[0], /Only modify files in ALLOWED_FILES\./iu);
});

test("process backend keeps reviewer prompts usable when advisory common headings drift", async () => {
  const prompts = [];
  const backend = createProcessWorkerBackend({
    launcher: createPromptCaptureLauncher({
      prompts,
      runCommandFn: async ({ command, args, cwd }) => ({
        command,
        args,
        cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({
          status: "success",
          summary: "Fallback advisory guidance still produced a usable reviewer prompt.",
          evidence: ["Fallback guidance path exercised successfully."],
          openQuestions: []
        }),
        stderr: "",
        error: null,
        durationMs: 1
      }),
      launcherOptions: {
        roleContractGuidanceLoader: () => loadRoleContractGuidance({
          readFileFn: (url, encoding) => {
            const markdown = readFileSync(url, encoding);
            if (String(url).endsWith("/COMMON.md")) {
              return markdown.replace("## Output Discipline", "## Output Shape Drifted");
            }

            return markdown;
          }
        })
      }
    })
  });

  const result = await backend.run(createPacket("reviewer"), {
    workflowId: "reviewer-drifted-common-advisory-heading"
  });

  assert.equal(result.status, "success");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/REVIEWER\.md/iu);
  assert.match(prompts[0], /Advisory doc status: docs\/agents\/COMMON\.md fallback active \(missing markdown heading: Output Discipline\)\./iu);
  assert.match(
    prompts[0],
    /Treat missing advisory markdown as non-authoritative and rely on the enforced task scope plus direct repository evidence\./iu
  );
  assert.match(
    prompts[0],
    /Attack the patch at the layer where it can fail: behavior, contracts, persistence, validation, operator surface, and maintainability\./iu
  );
  assert.match(prompts[0], /Do not modify any files\./iu);
});

test("read-only retry prompt preserves role-contract guidance while enforcing strict JSON output", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-readonly-retry-contracts-"));
  const prompts = [];
  let launchAttempt = 0;

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: createPromptCaptureLauncher({
        prompts,
        runCommandFn: async ({ command, args, cwd }) => {
          launchAttempt += 1;
          return {
            command,
            args,
            cwd,
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: launchAttempt === 1
              ? "reviewer plain text output"
              : JSON.stringify({
                status: "repair_required",
                summary: "Retry produced structured reviewer output.",
                evidence: ["Structured retry output parsed successfully."],
                openQuestions: []
              }),
            stderr: "",
            error: null,
            durationMs: 1
          };
        }
      })
    });

    const result = await backend.run(createPacket("reviewer"), {
      workflowId: "reviewer-retry-contracts"
    });

    assert.equal(result.status, "repair_required");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/REVIEWER\.md/iu);
    assert.match(prompts[1], /Fail closed on ambiguity about correctness, scope, authority, or evidence\./iu);
    assert.match(prompts[1], /Attack the patch at the layer where it can fail: behavior, contracts, persistence, validation, operator surface, and maintainability\./iu);
    assert.match(prompts[1], /Output must be a single raw JSON object with no markdown, prose, or code fences\./iu);
    assert.match(prompts[1], /status: use success when no grounded finding requires repair and the inspected evidence is sufficient for the scoped claim; use repair_required when at least one grounded finding means the change should not ship yet; use blocked when the review cannot be completed honestly because required evidence is missing or the claim cannot be checked\./iu);
    assert.doesNotMatch(prompts[1], /\bPASS\b/u);
    assert.doesNotMatch(prompts[1], /\bREPAIR_REQUIRED\b/u);
    assert.doesNotMatch(prompts[1], /\bBLOCKED\b/u);
    assert.match(prompts[1], /PREVIOUS_INVALID_OUTPUT_SNIPPET:/iu);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process role args builder probes custom preferred models and selects a custom preferred model", async () => {
  const customPreferredModel = "gpt-5.5-custom-implementer";
  const customFallbackModel = "gpt-5.5-custom-fallback";
  const roleProfiles = createRoleProfilesWithOverrides({
    implementer: {
      preferredModel: customPreferredModel
    }
  });
  const expectedPreferredModels = Object.values(roleProfiles).map((profile) => profile.preferredModel);
  const probeRequests = [];
  const argsBuilder = createProcessRoleArgsBuilder({
    roleProfiles,
    fallbackModel: customFallbackModel,
    modelProbe: async ({ providerId, candidateModels }) => {
      probeRequests.push({
        providerId,
        candidateModels: [...candidateModels]
      });
      return {
        providerId,
        supportedModels: [customPreferredModel, customFallbackModel],
        blockedReason: null
      };
    }
  });

  const { args, launchSelection } = await argsBuilder({
    packet: createPacket("implementer"),
    prompt: "Custom preferred probe selection",
    workspaceRoot: "/tmp/work"
  });

  assert.equal(probeRequests.length, 1);
  for (const model of expectedPreferredModels) {
    assert.equal(probeRequests[0].candidateModels.includes(model), true);
  }
  assert.equal(probeRequests[0].candidateModels.includes(customFallbackModel), true);
  assert.equal(args[args.indexOf("--model") + 1], customPreferredModel);
  assert.equal(launchSelection.selectedModel, customPreferredModel);
  assert.equal(launchSelection.modelSelectionMode, "direct");
});

test("process role args builder probes custom fallback model and selects fallback when preferred is unavailable", async () => {
  const customPreferredModel = "gpt-5.5-custom-unavailable";
  const customFallbackModel = "gpt-5.5-custom-fallback";
  const roleProfiles = createRoleProfilesWithOverrides({
    implementer: {
      preferredModel: customPreferredModel
    }
  });
  let observedCandidateModels = [];
  const argsBuilder = createProcessRoleArgsBuilder({
    roleProfiles,
    fallbackModel: customFallbackModel,
    modelProbe: async ({ providerId, candidateModels }) => {
      observedCandidateModels = [...candidateModels];
      return {
        providerId,
        supportedModels: [customFallbackModel],
        blockedReason: null
      };
    }
  });

  const { args, launchSelection } = await argsBuilder({
    packet: createPacket("implementer"),
    prompt: "Custom fallback probe selection",
    workspaceRoot: "/tmp/work"
  });

  assert.equal(observedCandidateModels.includes(customPreferredModel), true);
  assert.equal(observedCandidateModels.includes(customFallbackModel), true);
  assert.equal(args[args.indexOf("--model") + 1], customFallbackModel);
  assert.equal(launchSelection.selectedModel, customFallbackModel);
  assert.equal(launchSelection.modelSelectionMode, "fallback");
});

test("process role args builder fails closed on malformed role profiles", () => {
  const malformedProfiles = createRoleProfilesWithOverrides({
    implementer: {
      preferredModel: undefined,
      modelTypo: "gpt-5.5"
    }
  });
  delete malformedProfiles.implementer.preferredModel;

  assert.throws(
    () => createProcessRoleArgsBuilder({
      roleProfiles: malformedProfiles,
      modelProbe: async () => ({
        providerId: PROCESS_WORKER_PROVIDER_ID,
        supportedModels: ["gpt-5.4"],
        blockedReason: null
      })
    }),
    /role profile for implementer must include preferredModel/u
  );
});

test("pi launcher command evidence uses resolved pi script path in non-interactive mode", async () => {
  const launcher = createPiCliLauncher({
    modelProbe: async () => ({
      providerId: PROCESS_WORKER_PROVIDER_ID,
      supportedModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
      blockedReason: null
    }),
    spawnCommandResolver: async () => ({
      command: "node",
      argsPrefix: ["/tmp/pi/dist/pi.js"],
      launcher: "pi_script_via_node",
      launcherPath: "node",
      piScriptPath: "/tmp/pi/dist/pi.js",
      piPackageRoot: "/tmp/pi",
      resolutionMessage: "pi bin resolved from /tmp/pi/package.json"
    }),
    runCommandFn: async ({ command, args, cwd }) => ({
      command,
      args,
      cwd,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "ok",
      stderr: "",
      error: null,
      durationMs: 2
    })
  });

  const result = await launcher({
    packet: createPacket("implementer"),
    context: { workflowId: "process-workflow" },
    workspaceRoot: "/tmp/work",
    targetRelativePath: "test/fixtures/process-worker-output.md",
    targetContent: "PROCESS WORKER OUTPUT OK"
  });

  assert.equal(result.launcher, "pi_script_via_node");
  assert.equal(result.launcherPath, "node");
  assert.equal(result.piScriptPath, "/tmp/pi/dist/pi.js");
  assert.equal(result.commandsRun.length, 1);
  assert.match(result.commandsRun[0], /^node \/tmp\/pi\/dist\/pi\.js -p --no-session /u);
  assert.doesNotMatch(result.commandsRun[0], /^codex\b/u);
});

test("process backend launcher passes explicit openai-codex provider and preferred role model when supported", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-launch-profile-role-direct-"));

  try {
    let launchedArgs = [];
    const launcher = createPiCliLauncher({
      modelProbe: async () => ({
        providerId: PROCESS_WORKER_PROVIDER_ID,
        supportedModels: ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex"],
        blockedReason: null
      }),
      spawnCommandResolver: async () => ({
        command: "node",
        argsPrefix: ["/tmp/pi/dist/pi.js"],
        launcher: "pi_script_via_node",
        launcherPath: "node",
        piScriptPath: "/tmp/pi/dist/pi.js",
        piPackageRoot: "/tmp/pi",
        resolutionMessage: "pi bin resolved from /tmp/pi/package.json"
      }),
      runCommandFn: async ({ command, args, cwd }) => {
        launchedArgs = args;
        return {
          command,
          args,
          cwd,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "ok",
          stderr: "",
          error: null,
          durationMs: 2
        };
      }
    });

    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "direct-launch-profile-test"
    });

    assert.equal(result.status, "blocked");
    assert.equal(launchedArgs.includes("--provider"), true);
    assert.equal(launchedArgs.includes(PROCESS_WORKER_PROVIDER_ID), true);
    assert.equal(launchedArgs.includes("--model"), true);
    assert.equal(launchedArgs.includes("gpt-5.5"), true);
    assert.equal(launchedArgs.includes("--thinking"), true);
    assert.equal(launchedArgs.includes("medium"), true);
    assert.equal(result.evidence.includes("provider_flag_passed: true"), true);
    assert.equal(result.evidence.includes(`provider_selection: ${PROCESS_WORKER_PROVIDER_ID}`), true);
    assert.equal(result.evidence.includes("model_flag_passed: true"), true);
    assert.equal(result.evidence.includes("model_selection: gpt-5.5"), true);
    assert.equal(result.evidence.includes("requested_provider: openai-codex"), true);
    assert.equal(result.evidence.includes("requested_model: gpt-5.5"), true);
    assert.equal(result.evidence.includes("selected_provider: openai-codex"), true);
    assert.equal(result.evidence.includes("selected_model: gpt-5.5"), true);
    assert.equal(result.evidence.includes("model_selection_mode: direct"), true);
    assert.equal(result.evidence.includes("model_selection_reason: preferred_model_supported"), true);
    assert.equal(result.evidence.includes("effective_launcher_mode: explicit_provider_model_override"), true);
    assert.deepEqual(result.providerModelSelection, {
      requestedProvider: "openai-codex",
      requestedModel: "gpt-5.5",
      selectedProvider: "openai-codex",
      selectedModel: "gpt-5.5"
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend retry preserves explicit openai-codex provider/model selections", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-launch-profile-readonly-retry-"));
  const launchedArgs = [];
  let launchAttempt = 0;

  function readOptionValue(args, optionName) {
    const optionIndex = args.indexOf(optionName);
    if (optionIndex === -1) {
      return null;
    }

    return args[optionIndex + 1] ?? null;
  }

  try {
    const launcher = createPiCliLauncher({
      modelProbe: async () => ({
        providerId: PROCESS_WORKER_PROVIDER_ID,
        supportedModels: ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex"],
        blockedReason: null
      }),
      spawnCommandResolver: async () => ({
        command: "node",
        argsPrefix: ["/tmp/pi/dist/pi.js"],
        launcher: "pi_script_via_node",
        launcherPath: "node",
        piScriptPath: "/tmp/pi/dist/pi.js",
        piPackageRoot: "/tmp/pi",
        resolutionMessage: "pi bin resolved from /tmp/pi/package.json"
      }),
      runCommandFn: async ({ command, args, cwd }) => {
        launchAttempt += 1;
        launchedArgs.push([...args]);
        return {
          command,
          args,
          cwd,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: launchAttempt === 1
            ? "explorer plain text output"
            : JSON.stringify({
              status: "success",
              summary: "Structured retry output.",
              evidence: ["Retry response satisfied strict JSON contract."],
              openQuestions: []
            }),
          stderr: "",
          error: null,
          durationMs: 2
        };
      }
    });

    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("explorer"), {
      workflowId: "readonly-retry-launch-profile-test"
    });

    assert.equal(result.status, "success");
    assert.equal(launchedArgs.length, 2);
    assert.equal(readOptionValue(launchedArgs[0], "--provider"), PROCESS_WORKER_PROVIDER_ID);
    assert.equal(readOptionValue(launchedArgs[1], "--provider"), PROCESS_WORKER_PROVIDER_ID);
    assert.equal(readOptionValue(launchedArgs[0], "--model"), "gpt-5.5");
    assert.equal(readOptionValue(launchedArgs[1], "--model"), "gpt-5.5");
    assert.equal(readOptionValue(launchedArgs[0], "--thinking"), "high");
    assert.equal(readOptionValue(launchedArgs[1], "--thinking"), "high");
    assert.equal(
      result.evidence.includes("read_only_json_repair_retry_attempted: true"),
      true
    );
    assert.deepEqual(result.providerModelSelection, {
      requestedProvider: "openai-codex",
      requestedModel: "gpt-5.5",
      selectedProvider: "openai-codex",
      selectedModel: "gpt-5.5"
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend falls back to gpt-5.4 when preferred role model is unavailable", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-launch-profile-role-fallback-"));

  try {
    const launcher = createPiCliLauncher({
      modelProbe: async () => ({
        providerId: PROCESS_WORKER_PROVIDER_ID,
        supportedModels: ["gpt-5.4", "gpt-5.4-mini"],
        blockedReason: null
      }),
      spawnCommandResolver: async () => ({
        command: "node",
        argsPrefix: ["/tmp/pi/dist/pi.js"],
        launcher: "pi_script_via_node",
        launcherPath: "node",
        piScriptPath: "/tmp/pi/dist/pi.js",
        piPackageRoot: "/tmp/pi",
        resolutionMessage: "pi bin resolved from /tmp/pi/package.json"
      }),
      runCommandFn: async ({ command, args, cwd }) => ({
        command,
        args,
        cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok",
        stderr: "",
        error: null,
        durationMs: 2
      })
    });

    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "fallback-launch-profile-test"
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.evidence.includes("model_selection: gpt-5.4"), true);
    assert.equal(result.evidence.includes("selected_model: gpt-5.4"), true);
    assert.equal(result.evidence.includes("model_selection_mode: fallback"), true);
    assert.equal(result.evidence.includes("model_selection_reason: preferred_model_unavailable"), true);
    assert.equal(
      result.evidence.some((entry) => /model_fallback_reason: preferred model unavailable: gpt-5\.5; fallback model selected: gpt-5\.4/u.test(entry)),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend blocks cleanly when no valid openai-codex models can be resolved", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-launch-profile-role-blocked-"));

  try {
    const launcher = createPiCliLauncher({
      modelProbe: async () => ({
        providerId: PROCESS_WORKER_PROVIDER_ID,
        supportedModels: [],
        blockedReason: null
      }),
      spawnCommandResolver: async () => ({
        command: "node",
        argsPrefix: ["/tmp/pi/dist/pi.js"],
        launcher: "pi_script_via_node",
        launcherPath: "node",
        piScriptPath: "/tmp/pi/dist/pi.js",
        piPackageRoot: "/tmp/pi",
        resolutionMessage: "pi bin resolved from /tmp/pi/package.json"
      }),
      runCommandFn: async ({ command, args, cwd }) => ({
        command,
        args,
        cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok",
        stderr: "",
        error: null,
        durationMs: 2
      })
    });

    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "blocked-launch-profile-test"
    });

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /launcher invocation failed/i);
    assert.equal(
      result.evidence.some((entry) => /launch_error: process backend blocked: no supported models resolved for provider openai-codex/i.test(entry)),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend evidence reports explicit provider/model selections when launcher args include overrides", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-launch-profile-explicit-"));

  try {
    const launcher = createPiCliLauncher({
      argsBuilder: ({ prompt }) => [
        "-p",
        "--no-session",
        "--provider",
        "openrouter",
        "--model",
        "openai/gpt-5",
        "--thinking",
        "high",
        prompt
      ],
      spawnCommandResolver: async () => ({
        command: "node",
        argsPrefix: ["/tmp/pi/dist/pi.js"],
        launcher: "pi_script_via_node",
        launcherPath: "node",
        piScriptPath: "/tmp/pi/dist/pi.js",
        piPackageRoot: "/tmp/pi",
        resolutionMessage: "pi bin resolved from /tmp/pi/package.json"
      }),
      runCommandFn: async ({ command, args, cwd }) => ({
        command,
        args,
        cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok",
        stderr: "",
        error: null,
        durationMs: 2
      })
    });

    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "explicit-launch-profile-test"
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.evidence.includes("provider_flag_passed: true"), true);
    assert.equal(result.evidence.includes("provider_selection: openrouter"), true);
    assert.equal(result.evidence.includes("model_flag_passed: true"), true);
    assert.equal(result.evidence.includes("model_selection: openai/gpt-5"), true);
    assert.equal(result.evidence.includes("thinking_flag_passed: true"), true);
    assert.equal(result.evidence.includes("thinking_selection: high"), true);
    assert.equal(result.evidence.includes("effective_launcher_mode: explicit_provider_model_override"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("pi launcher blocks when script resolution falls back to an unresolved command", async () => {
  const launcher = createPiCliLauncher({
    modelProbe: async () => ({
      providerId: PROCESS_WORKER_PROVIDER_ID,
      supportedModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
      blockedReason: null
    }),
    spawnCommandResolver: async () => ({
      command: "pi",
      argsPrefix: [],
      launcher: "pi_cli_fallback",
      launcherPath: "pi",
      piScriptPath: null,
      piPackageRoot: null,
      resolutionMessage: "pi package resolution unavailable"
    })
  });

  const result = await launcher({
    packet: createPacket("implementer"),
    context: {},
    workspaceRoot: "/tmp/work"
  });

  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /script path was not resolved/i);
});
