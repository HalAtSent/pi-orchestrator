import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AUTO_BACKEND_MODES } from "../src/auto-backend-runner.js";
import { createProcessWorkerBackend } from "../src/process-worker-backend.js";
import {
  buildProjectLifecycleArtifacts,
  createExecutionProgramPlanFingerprint,
  deriveExecutionProgramActionClasses
} from "../src/project-workflows.js";
import { createPiWorkerRunner } from "../src/pi-worker-runner.js";
import { createScriptedWorkerRunner } from "../src/worker-runner.js";
import { createBuildSessionStore } from "../src/build-session-store.js";
import { createRunStore } from "../src/run-store.js";

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

async function withTempDir(prefix, callback) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createUiStub() {
  return {
    notify() {},
    setStatus() {}
  };
}

function createStubBuildSession({
  buildId = "build-stub",
  intake = { goal: "Build a scoped operator workflow" },
  lifecycle,
  approved = false,
  approval = {},
  execution = {}
}) {
  const planFingerprint = createExecutionProgramPlanFingerprint(lifecycle.executionProgram);
  const approvalActionClasses = deriveExecutionProgramActionClasses(lifecycle.executionProgram);

  return {
    buildId,
    planFingerprint,
    intake,
    lifecycle: {
      proposalSet: lifecycle.proposalSet,
      blueprint: lifecycle.blueprint,
      executionProgram: lifecycle.executionProgram,
      auditReport: lifecycle.auditReport
    },
    approval: {
      approved,
      approvedAt: approved ? new Date().toISOString() : null,
      programId: lifecycle.executionProgram.id,
      planFingerprint,
      actionClasses: approvalActionClasses,
      policyProfile: "default",
      ...approval
    },
    execution: {
      status: approved ? "approved" : "awaiting_approval",
      stopReason: null,
      actionClasses: [],
      policyProfile: "default",
      validationArtifacts: [
        {
          artifactType: "validation_artifact",
          reference: null,
          status: "not_captured",
          validationOutcome: "not_run"
        }
      ],
      programId: null,
      completedContracts: 0,
      pendingContracts: lifecycle.executionProgram.contracts.length,
      updatedAt: new Date().toISOString(),
      ...execution
    }
  };
}

function createInMemoryBuildSessionStore({
  initialSession = null,
  mutateCreatedSession = null
} = {}) {
  let currentSession = initialSession ? structuredClone(initialSession) : null;

  return {
    async createBuildSession({ intake, lifecycle, approvalRequested = false } = {}) {
      currentSession = createStubBuildSession({
        buildId: currentSession?.buildId ?? "build-in-memory",
        intake,
        lifecycle,
        approved: Boolean(approvalRequested)
      });

      if (typeof mutateCreatedSession === "function") {
        currentSession = structuredClone(mutateCreatedSession(structuredClone(currentSession)));
      }

      return structuredClone(currentSession);
    },
    async loadBuildSession(buildId) {
      if (!currentSession || currentSession.buildId !== buildId) {
        return null;
      }

      return structuredClone(currentSession);
    },
    async updateBuildSession(buildId, updater) {
      if (!currentSession || currentSession.buildId !== buildId) {
        throw new Error(`No build session found for build id: ${buildId}`);
      }

      currentSession = structuredClone(await updater(structuredClone(currentSession)));
      return structuredClone(currentSession);
    },
    getCurrentSession() {
      return structuredClone(currentSession);
    }
  };
}

function createFakeProcessLaunchResult(stdout) {
  return {
    launcher: "fake_process_launcher",
    command: "node",
    args: ["fake-process-launch.js"],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    error: null,
    durationMs: 3,
    commandsRun: ["node fake-process-launch.js"]
  };
}

function createProcessBackendForProgramTests(repositoryRoot) {
  return createProcessWorkerBackend({
    repositoryRoot,
    launcher: async ({ packet, targetAbsolutePath }) => {
      if (packet.role === "implementer") {
        await mkdir(dirname(targetAbsolutePath), { recursive: true });
        await writeFile(targetAbsolutePath, "process backend updated this file\n", "utf8");
        return createFakeProcessLaunchResult("implementer completed");
      }

      const readOnlyByRole = {
        explorer: {
          status: "success",
          summary: "Scoped files and dependencies identified.",
          evidence: ["Relevant files mapped."],
          openQuestions: []
        },
        reviewer: {
          status: "success",
          summary: "Independent review found no blocking issues.",
          evidence: ["Scoped review passed."],
          openQuestions: []
        },
        verifier: {
          status: "success",
          summary: "Verification checks passed.",
          evidence: ["Verification evidence collected."],
          openQuestions: []
        }
      };

      return createFakeProcessLaunchResult(JSON.stringify(readOnlyByRole[packet.role]));
    }
  });
}

function buildSingleContractProgram({
  contractId,
  contractRisk
}) {
  const baseProgram = buildProjectLifecycleArtifacts(loadFixture("project-brief.json")).executionProgram;
  const contract = structuredClone(baseProgram.contracts[0]);
  contract.id = contractId;
  contract.goal = "Rename one local helper in a single file";
  contract.summary = "Apply a scoped helper rename.";
  contract.scopePaths = ["src/helpers.js"];
  contract.risk = contractRisk;
  contract.dependsOn = [];

  const singleContractProgram = structuredClone(baseProgram);
  singleContractProgram.contracts = [contract];
  return singleContractProgram;
}

test("pi extension entrypoint imports without undeclared runtime dependencies", async () => {
  const module = await import("../src/pi-extension.js");

  assert.equal(typeof module.default, "function");
  assert.equal(typeof module.createPiExtension, "function");
});

test("default export routes /auto through the Pi adapter and worker runner", async () => {
  const module = await import("../src/pi-extension.js");
  const requestedRuns = [];
  const registeredCommands = new Map();

  module.default({
    async runWorker(request, runtimeContext) {
      requestedRuns.push({
        request,
        runtimeContext
      });

      return {
        status: "success",
        summary: `${request.role} completed`,
        changedFiles: request.role === "implementer" ? ["src/helpers.js"] : [],
        commandsRun: [...request.commands],
        evidence: [`role=${request.role}`],
        openQuestions: []
      };
    },
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    registerTool() {}
  });

  const execution = await registeredCommands.get("auto").handler(JSON.stringify({
    goal: "Rename a helper in one file",
    allowedFiles: ["src/helpers.js"],
    maxRepairLoops: 1
  }), {
    ui: {
      notify() {},
      setStatus() {}
    }
  });

  assert.equal(execution.status, "success");
  assert.deepEqual(requestedRuns.map((entry) => entry.request.role), ["implementer", "verifier"]);
  assert.equal(requestedRuns[0].request.controls.noRecursiveDelegation, true);
  assert.equal(requestedRuns[0].request.controls.writePolicy, "allowlist_only");
  assert.equal(requestedRuns[1].request.controls.writePolicy, "read_only");
});

test("default export blocks /auto when the allowlist is empty", async () => {
  const module = await import("../src/pi-extension.js");
  const requestedRuns = [];
  const registeredCommands = new Map();

  module.default({
    async runWorker(request, runtimeContext) {
      requestedRuns.push({
        request,
        runtimeContext
      });

      return {
        status: "success",
        summary: `${request.role} completed`,
        changedFiles: request.role === "implementer" ? ["src/helpers.js"] : [],
        commandsRun: [...request.commands],
        evidence: [`role=${request.role}`],
        openQuestions: []
      };
    },
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    registerTool() {}
  });

  const execution = await registeredCommands.get("auto").handler(JSON.stringify({
    goal: "Rename a helper in one file",
    allowedFiles: [],
    maxRepairLoops: 1
  }), {
    ui: {
      notify() {},
      setStatus() {}
    }
  });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(requestedRuns.length, 0);
  assert.match(execution.stopReason, /allowedFiles must contain at least one file path/i);
});

test("default export routes approved high-risk /auto runs through all worker roles", async () => {
  const module = await import("../src/pi-extension.js");
  const requestedRuns = [];
  const registeredCommands = new Map();

  module.default({
    async runWorker(request, runtimeContext) {
      requestedRuns.push({
        request,
        runtimeContext
      });

      return {
        status: "success",
        summary: `${request.role} completed`,
        changedFiles: request.role === "implementer" ? ["platform/contracts/ingest/artifact.json"] : [],
        commandsRun: [...request.commands],
        evidence: [`role=${request.role}`],
        openQuestions: []
      };
    },
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    registerTool() {}
  });

  const execution = await registeredCommands.get("auto").handler(JSON.stringify({
    goal: "Apply a schema migration for billing events",
    allowedFiles: ["platform/contracts/ingest/artifact.json"],
    approvedHighRisk: "true",
    maxRepairLoops: 1
  }), {
    ui: {
      notify() {},
      setStatus() {}
    }
  });

  assert.equal(execution.status, "success");
  assert.deepEqual(
    requestedRuns.map((entry) => entry.request.role),
    ["explorer", "implementer", "reviewer", "verifier"]
  );
});

test("default export keeps high-risk /auto gated when approvedHighRisk is string false", async () => {
  const module = await import("../src/pi-extension.js");
  const requestedRuns = [];
  const registeredCommands = new Map();

  module.default({
    async runWorker(request, runtimeContext) {
      requestedRuns.push({
        request,
        runtimeContext
      });

      return {
        status: "success",
        summary: `${request.role} completed`,
        changedFiles: request.role === "implementer" ? ["platform/contracts/ingest/artifact.json"] : [],
        commandsRun: [...request.commands],
        evidence: [`role=${request.role}`],
        openQuestions: []
      };
    },
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    registerTool() {}
  });

  const execution = await registeredCommands.get("auto").handler(JSON.stringify({
    goal: "Apply a schema migration for billing events",
    allowedFiles: ["platform/contracts/ingest/artifact.json"],
    approvedHighRisk: "false",
    maxRepairLoops: 1
  }), {
    ui: {
      notify() {},
      setStatus() {}
    }
  });

  assert.equal(execution.status, "human_gate_required");
  assert.equal(execution.runs.length, 0);
  assert.equal(requestedRuns.length, 0);
});

test("pi extension can route low-risk /auto implementer and verifier work through the process backend when explicitly configured", async () => {
  await withTempDir("pi-orchestrator-process-implementer-", async (repositoryRoot) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const processBackend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ packet, targetAbsolutePath }) => {
        if (packet.role === "implementer") {
          await mkdir(dirname(targetAbsolutePath), { recursive: true });
          await writeFile(targetAbsolutePath, "process backend updated this file\n", "utf8");
        }

        const stdout = packet.role === "verifier"
          ? JSON.stringify({
            status: "success",
            summary: "Verification checks passed.",
            evidence: ["Verification evidence collected."],
            openQuestions: []
          })
          : "ok";

        return {
          launcher: "fake_process_launcher",
          command: "node",
          args: ["fake-process-launch.js"],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout,
          stderr: "",
          error: null,
          durationMs: 3,
          commandsRun: ["node fake-process-launch.js"]
        };
      }
    });

    const registeredCommands = new Map();
    const extension = createPiExtension({
      processWorkerBackend: processBackend,
      autoBackendMode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
    });

    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const execution = await registeredCommands.get("auto").handler(JSON.stringify({
      goal: "Rename a helper in one file",
      allowedFiles: ["src/helpers.js"],
      maxRepairLoops: 1
    }), {
      ui: {
        notify() {},
        setStatus() {}
      }
    });

    assert.equal(execution.status, "success");
    assert.deepEqual(execution.runs.map((run) => run.packet.role), ["implementer", "verifier"]);
    assert.equal(processBackend.getCalls().length, 2);
    assert.equal(processBackend.getCalls()[0].packet.role, "implementer");
    assert.equal(processBackend.getCalls()[1].packet.role, "verifier");
  });
});

test("pi extension can route approved high-risk /auto work through process subagents when explicitly configured", async () => {
  await withTempDir("pi-orchestrator-process-subagents-", async (repositoryRoot) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const processBackend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ packet, targetAbsolutePath }) => {
        if (packet.role === "implementer") {
          await mkdir(dirname(targetAbsolutePath), { recursive: true });
          await writeFile(targetAbsolutePath, "process backend updated this file\n", "utf8");
          return {
            launcher: "fake_process_launcher",
            command: "node",
            args: ["fake-process-launch.js"],
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "implementer completed",
            stderr: "",
            error: null,
            durationMs: 3,
            commandsRun: ["node fake-process-launch.js"]
          };
        }

        const stdoutByRole = {
          explorer: JSON.stringify({
            status: "success",
            summary: "Scoped files and dependencies identified.",
            evidence: ["Relevant files mapped."],
            openQuestions: []
          }),
          reviewer: JSON.stringify({
            status: "success",
            summary: "Independent review found no blocking issues.",
            evidence: ["Scoped review passed."],
            openQuestions: []
          }),
          verifier: JSON.stringify({
            status: "success",
            summary: "Verification checks passed.",
            evidence: ["Verification evidence collected."],
            openQuestions: []
          })
        };

        return {
          launcher: "fake_process_launcher",
          command: "node",
          args: ["fake-process-launch.js"],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: stdoutByRole[packet.role],
          stderr: "",
          error: null,
          durationMs: 3,
          commandsRun: ["node fake-process-launch.js"]
        };
      }
    });

    const registeredCommands = new Map();
    const extension = createPiExtension({
      processWorkerBackend: processBackend,
      autoBackendMode: AUTO_BACKEND_MODES.PROCESS_SUBAGENTS
    });

    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const execution = await registeredCommands.get("auto").handler(JSON.stringify({
      goal: "Apply a schema migration for billing events",
      allowedFiles: ["platform/contracts/ingest/artifact.json"],
      approvedHighRisk: "true",
      maxRepairLoops: 1
    }), {
      ui: {
        notify() {},
        setStatus() {}
      }
    });

    assert.equal(execution.status, "success");
    assert.deepEqual(
      execution.runs.map((run) => run.packet.role),
      ["explorer", "implementer", "reviewer", "verifier"]
    );
    assert.deepEqual(
      processBackend.getCalls().map((call) => call.packet.role),
      ["explorer", "implementer", "reviewer", "verifier"]
    );
  });
});

test("pi extension exposes worker runtime diagnostics and blocked auto includes stop reason", async () => {
  const { createPiExtension } = await import("../src/pi-extension.js");
  const registeredCommands = new Map();
  const registeredTools = new Map();
  const uiEvents = [];

  const extension = createPiExtension();
  extension({
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    registerTool(config) {
      registeredTools.set(config.name, config);
    }
  });

  const runtimeStatus = await registeredCommands.get("worker-runtime-status").handler("", {
    ui: {
      notify(message, level) {
        uiEvents.push({ message, level });
      },
      setStatus(scope, value) {
        uiEvents.push({ scope, value });
      }
    }
  });

  assert.match(runtimeStatus.text, /selected_invoker: none/);
  assert.equal(registeredTools.has("inspect_worker_runtime"), true);

  const execution = await registeredCommands.get("auto").handler(JSON.stringify({
    goal: "Rename a helper in one file",
    allowedFiles: ["src/helpers.js"],
    maxRepairLoops: 1
  }), {
    ui: {
      notify(message, level) {
        uiEvents.push({ message, level });
      },
      setStatus(scope, value) {
        uiEvents.push({ scope, value });
      }
    }
  });

  assert.equal(execution.status, "blocked");
  assert.match(execution.stopReason, /does not expose runWorker/i);
  assert.equal(
    uiEvents.some((event) => event.message && /does not expose runWorker/i.test(event.message)),
    true
  );
});

test("pi extension exposes run-program/resume-program and execution tools", async () => {
  const { createPiExtension } = await import("../src/pi-extension.js");
  const registeredCommands = new Map();
  const registeredTools = new Map();
  const executedContracts = [];
  const observedApprovals = [];

  const extension = createPiExtension({
    contractExecutor: async (contract, context = {}) => {
      executedContracts.push(contract.id);
      observedApprovals.push(context.approvedHighRisk);
      return {
        status: "success",
        summary: `Executed ${contract.id}.`,
        evidence: [],
        openQuestions: []
      };
    }
  });

  extension({
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    registerTool(config) {
      registeredTools.set(config.name, config);
    }
  });

  assert.equal(registeredCommands.has("run-program"), true);
  assert.equal(registeredCommands.has("resume-program"), true);
  assert.equal(registeredCommands.has("auto"), true);
  assert.equal(registeredTools.has("plan_workflow"), true);
  assert.equal(registeredTools.has("run_execution_program"), true);
  assert.equal(registeredTools.has("resume_execution_program"), true);
  assert.equal(registeredTools.has("run_auto_workflow"), true);
  assert.equal(registeredTools.get("run_execution_program").parameters.properties.approvedHighRisk.default, false);
  assert.equal(registeredTools.get("resume_execution_program").parameters.properties.approvedHighRisk.default, false);

  await assert.rejects(
    () => registeredTools.get("plan_workflow").execute("tool-call-plan-empty", {
      goal: "Rename a helper in one file",
      allowedFiles: []
    }),
    /allowedFiles must contain at least one file path/i
  );

  await assert.rejects(
    () => registeredTools.get("plan_workflow").execute("tool-call-plan-overlap", {
      goal: "Rename a helper in one file",
      allowedFiles: ["src/foo.js"],
      forbiddenFiles: ["src/"]
    }),
    /must not overlap by scope/i
  );

  const program = buildProjectLifecycleArtifacts(loadFixture("project-brief.json")).executionProgram;
  const uiEvents = [];
  const runFromCommand = await registeredCommands.get("run-program").handler(JSON.stringify({
    program,
    approvedHighRisk: "true"
  }), {
    ui: {
      notify(message, level) {
        uiEvents.push({ message, level });
      },
      setStatus(scope, value) {
        uiEvents.push({ scope, value });
      }
    }
  });

  assert.equal(runFromCommand.status, "success");
  assert.equal(runFromCommand.programId, program.id);
  assert.equal(executedContracts.length, program.contracts.length);
  assert.equal(uiEvents.length >= 2, true);
  assert.deepEqual(observedApprovals, Array(program.contracts.length).fill(true));

  observedApprovals.length = 0;
  const runFromTool = await registeredTools.get("run_execution_program").execute("tool-call-1", {
    program,
    approvedHighRisk: true
  });
  assert.equal(runFromTool.details.status, "success");
  assert.match(runFromTool.content[0].text, /^program:/m);
  assert.deepEqual(observedApprovals, Array(program.contracts.length).fill(true));
});

test("pi extension resume-program resumes a persisted execution program run", async () => {
  await withTempDir("pi-orchestrator-pi-extension-", async (rootDir) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const runStore = createRunStore({ rootDir });
    const executionCounts = new Map();
    const observedApprovals = [];

    const extension = createPiExtension({
      runStore,
      contractExecutor: async (contract, context = {}) => {
        const count = executionCounts.get(contract.id) ?? 0;
        executionCounts.set(contract.id, count + 1);
        observedApprovals.push(context.approvedHighRisk);

        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [],
          openQuestions: []
        };
      }
    });

    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const program = buildProjectLifecycleArtifacts(loadFixture("project-brief.json")).executionProgram;
    const firstContract = program.contracts[0];
    const ui = {
      notify() {},
      setStatus() {}
    };

    await runStore.saveRun({
      programId: program.id,
      program,
      runJournal: {
        programId: program.id,
        status: "running",
        stopReason: null,
        contractRuns: [
          {
            contractId: firstContract.id,
            status: "success",
            summary: `Executed ${firstContract.id}.`,
            evidence: [],
            openQuestions: []
          }
        ],
        completedContractIds: [firstContract.id],
        pendingContractIds: program.contracts.slice(1).map((contract) => contract.id)
      }
    });

    const resumedRun = await registeredCommands.get("resume-program").handler(JSON.stringify({
      programId: program.id,
      approvedHighRisk: "true"
    }), { ui });
    assert.equal(resumedRun.status, "success");

    assert.equal(executionCounts.get("bootstrap-package") ?? 0, 0);
    assert.equal(executionCounts.get("freeze-lifecycle-contracts"), 1);
    assert.deepEqual(
      observedApprovals,
      Array(program.contracts.length - 1).fill(true)
    );
  });
});

test("pi extension run-program uses the backend-selected runner for low-risk execution contracts", async () => {
  await withTempDir("pi-orchestrator-run-program-low-risk-process-", async (repositoryRoot) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const defaultRunner = createScriptedWorkerRunner();
    const processBackend = createProcessBackendForProgramTests(repositoryRoot);

    const extension = createPiExtension({
      workerRunner: defaultRunner,
      processWorkerBackend: processBackend,
      autoBackendMode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
    });

    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const program = buildSingleContractProgram({
      contractId: "run-program-low-risk-process",
      contractRisk: "low"
    });
    const runJournal = await registeredCommands.get("run-program").handler(JSON.stringify({
      program
    }), {
      ui: createUiStub()
    });

    assert.equal(runJournal.status, "success");
    assert.equal(runJournal.contractRuns.length, 1);
    assert.equal(runJournal.contractRuns[0].status, "success");
    assert.deepEqual(
      processBackend.getCalls().map((call) => call.packet.role),
      ["implementer", "verifier"]
    );
    assert.equal(defaultRunner.getCalls().length, 0);
  });
});

test("pi extension resume-program uses the backend-selected runner for pending contracts", async () => {
  await withTempDir("pi-orchestrator-resume-program-low-risk-process-", async (rootDir) => {
    const repositoryRoot = join(rootDir, "repo");
    await mkdir(repositoryRoot, { recursive: true });

    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const runStore = createRunStore({ rootDir });
    const defaultRunner = createScriptedWorkerRunner();
    const processBackend = createProcessBackendForProgramTests(repositoryRoot);

    const extension = createPiExtension({
      runStore,
      workerRunner: defaultRunner,
      processWorkerBackend: processBackend,
      autoBackendMode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
    });

    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const program = buildSingleContractProgram({
      contractId: "resume-program-low-risk-process",
      contractRisk: "low"
    });
    await runStore.saveRun({
      programId: program.id,
      program,
      runJournal: {
        programId: program.id,
        status: "running",
        stopReason: null,
        contractRuns: [],
        completedContractIds: [],
        pendingContractIds: [program.contracts[0].id]
      }
    });

    const resumedRun = await registeredCommands.get("resume-program").handler(JSON.stringify({
      programId: program.id
    }), {
      ui: createUiStub()
    });

    assert.equal(resumedRun.status, "success");
    assert.equal(resumedRun.contractRuns.length, 1);
    assert.equal(resumedRun.contractRuns[0].status, "success");
    assert.deepEqual(
      processBackend.getCalls().map((call) => call.packet.role),
      ["implementer", "verifier"]
    );
    assert.equal(defaultRunner.getCalls().length, 0);
  });
});

test("pi extension run-program can execute approved high-risk contracts through process subagents", async () => {
  await withTempDir("pi-orchestrator-run-program-high-risk-process-subagents-", async (repositoryRoot) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const defaultRunner = createScriptedWorkerRunner();
    const processBackend = createProcessBackendForProgramTests(repositoryRoot);

    const extension = createPiExtension({
      workerRunner: defaultRunner,
      processWorkerBackend: processBackend,
      autoBackendMode: AUTO_BACKEND_MODES.PROCESS_SUBAGENTS
    });

    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const program = buildSingleContractProgram({
      contractId: "run-program-high-risk-process-subagents",
      contractRisk: "high"
    });
    const runJournal = await registeredCommands.get("run-program").handler(JSON.stringify({
      program,
      approvedHighRisk: "true"
    }), {
      ui: createUiStub()
    });

    assert.equal(runJournal.status, "success");
    assert.equal(runJournal.contractRuns.length, 1);
    assert.equal(runJournal.contractRuns[0].status, "success");
    assert.deepEqual(
      processBackend.getCalls().map((call) => call.packet.role),
      ["explorer", "implementer", "reviewer", "verifier"]
    );
    assert.equal(defaultRunner.getCalls().length, 0);
  });
});

test("pi extension run-program still requires explicit approval for high-risk contracts", async () => {
  await withTempDir("pi-orchestrator-run-program-high-risk-gate-", async (repositoryRoot) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const defaultRunner = createScriptedWorkerRunner();
    const processBackend = createProcessBackendForProgramTests(repositoryRoot);

    const extension = createPiExtension({
      workerRunner: defaultRunner,
      processWorkerBackend: processBackend,
      autoBackendMode: AUTO_BACKEND_MODES.PROCESS_SUBAGENTS
    });

    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const program = buildSingleContractProgram({
      contractId: "run-program-high-risk-requires-approval",
      contractRisk: "high"
    });
    const runJournal = await registeredCommands.get("run-program").handler(JSON.stringify({
      program
    }), {
      ui: createUiStub()
    });

    assert.equal(runJournal.status, "blocked");
    assert.equal(runJournal.contractRuns.length, 1);
    assert.equal(runJournal.contractRuns[0].status, "blocked");
    assert.match(runJournal.stopReason, /Human approval is required before executing this workflow/i);
    assert.equal(processBackend.getCalls().length, 0);
    assert.equal(defaultRunner.getCalls().length, 0);
  });
});

test("pi extension run-program uses the default compiler/executor path with a scripted runner", async () => {
  const { createPiExtension } = await import("../src/pi-extension.js");
  const registeredCommands = new Map();
  const runner = createScriptedWorkerRunner([
    {
      role: "explorer",
      result: {
        status: "success",
        summary: "Mapped the contract scope.",
        changedFiles: [],
        commandsRun: ["rg --files"],
        evidence: ["Scope files enumerated."],
        openQuestions: []
      }
    },
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Applied the scoped contract updates.",
        changedFiles: [],
        commandsRun: ["node --check src/pi-extension.js"],
        evidence: ["Scoped update completed."],
        openQuestions: []
      }
    },
    {
      role: "reviewer",
      result: {
        status: "success",
        summary: "Reviewed updates independently.",
        changedFiles: [],
        commandsRun: ["git diff --stat"],
        evidence: ["No findings."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Collected verification evidence.",
        changedFiles: [],
        commandsRun: ["node --test --test-isolation=none"],
        evidence: ["Verification command passed."],
        openQuestions: []
      }
    }
  ]);

  const extension = createPiExtension({
    workerRunner: runner
  });

  extension({
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    registerTool() {}
  });

  const program = buildProjectLifecycleArtifacts(loadFixture("project-brief.json")).executionProgram;
  const singleContractProgram = structuredClone(program);
  singleContractProgram.contracts = [program.contracts[0]];

  const runJournal = await registeredCommands.get("run-program").handler(JSON.stringify({
    program: singleContractProgram
  }), {
    ui: {
      notify() {},
      setStatus() {}
    }
  });

  assert.equal(runJournal.status, "success");
  assert.equal(runJournal.contractRuns.length, 1);
  assert.equal(runJournal.contractRuns[0].status, "success");
  assert.equal(runner.getPendingStepCount(), 0);
});

test("pi extension run-program executes a declared high-risk contract when approval is explicitly supplied", async () => {
  const { createPiExtension } = await import("../src/pi-extension.js");
  const registeredCommands = new Map();
  const runner = createScriptedWorkerRunner([
    {
      role: "explorer",
      result: {
        status: "success",
        summary: "Mapped the declared contract scope.",
        changedFiles: [],
        commandsRun: ["rg --files"],
        evidence: ["Scope files enumerated."],
        openQuestions: []
      }
    },
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Applied the scoped contract update.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Scoped update completed."],
        openQuestions: []
      }
    },
    {
      role: "reviewer",
      result: {
        status: "success",
        summary: "Reviewed updates independently.",
        changedFiles: [],
        commandsRun: ["git diff --stat"],
        evidence: ["No findings."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Collected verification evidence.",
        changedFiles: [],
        commandsRun: ["node --test --test-isolation=none"],
        evidence: ["Verification command passed."],
        openQuestions: []
      }
    }
  ]);

  const extension = createPiExtension({
    workerRunner: runner
  });

  extension({
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    registerTool() {}
  });

  const baseProgram = buildProjectLifecycleArtifacts(loadFixture("project-brief.json")).executionProgram;
  const highRiskContract = structuredClone(baseProgram.contracts[0]);
  highRiskContract.id = "declared-high-risk-contract";
  highRiskContract.goal = "Rename one local helper in a single file";
  highRiskContract.summary = "Apply a scoped helper rename.";
  highRiskContract.scopePaths = ["src/helpers.js"];
  highRiskContract.risk = "high";
  highRiskContract.dependsOn = [];

  const singleContractProgram = structuredClone(baseProgram);
  singleContractProgram.contracts = [highRiskContract];

  const runJournal = await registeredCommands.get("run-program").handler(JSON.stringify({
    program: singleContractProgram,
    approvedHighRisk: "true"
  }), {
    ui: {
      notify() {},
      setStatus() {}
    }
  });

  assert.equal(runJournal.status, "success");
  assert.equal(runJournal.contractRuns.length, 1);
  assert.equal(runJournal.contractRuns[0].status, "success");
  assert.deepEqual(
    runner.getCalls().map((call) => call.packet.role),
    ["explorer", "implementer", "reviewer", "verifier"]
  );
  assert.equal(runner.getPendingStepCount(), 0);
});

test("pi extension auto command runs through an injected Pi-backed runner", async () => {
  const { createPiExtension } = await import("../src/pi-extension.js");
  const requestedRoles = [];
  const notifications = [];
  const statuses = [];
  const runner = createPiWorkerRunner({
    adapter: {
      async runWorker(request) {
        requestedRoles.push(request.role);
        return {
          status: "success",
          summary: `${request.role} completed`,
          changedFiles: request.role === "implementer" ? ["src/helpers.js"] : [],
          commandsRun: [...request.commands],
          evidence: request.role === "implementer"
            ? [
              `role=${request.role}`,
              "selected_provider: openai-codex",
              "selected_model: gpt-5.3-codex"
            ]
            : [
              `role=${request.role}`,
              "selected_provider: openai-codex",
              "selected_model: gpt-5.4-mini"
            ],
          openQuestions: []
        };
      }
    }
  });
  const registeredCommands = new Map();

  const extension = createPiExtension({
    workerRunner: runner
  });

  extension({
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    registerTool() {}
  });

  const execution = await registeredCommands.get("auto").handler(JSON.stringify({
    goal: "Rename a helper in one file",
    allowedFiles: ["src/helpers.js"],
    maxRepairLoops: 1
  }), {
    ui: {
      notify(message, tone) {
        notifications.push({ message, tone });
      },
      setStatus(key, value) {
        statuses.push({ key, value });
      }
    }
  });

  assert.equal(execution.status, "success");
  assert.deepEqual(requestedRoles, ["implementer", "verifier"]);
  assert.equal(execution.runs.length, 2);
  assert.match(execution.summary, /openai-codex/i);
  assert.match(execution.summary, /implementer=gpt-5\.3-codex/i);
  assert.match(notifications[0].message, /openai-codex/i);
  assert.match(notifications[0].message, /implementer=gpt-5\.3-codex/i);
  assert.match(statuses[0].value, /openai-codex/i);
  assert.match(statuses[0].value, /implementer=gpt-5\.3-codex/i);
});

test("pi extension build command creates a persisted build session before approval", async () => {
  await withTempDir("pi-orchestrator-build-session-create-", async (rootDir) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const uiEvents = [];
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const runStore = createRunStore({ rootDir });

    const extension = createPiExtension({
      runStore,
      buildSessionStore,
      contractExecutor: async () => {
        throw new Error("build should not execute contracts before approval");
      }
    });

    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const result = await registeredCommands.get("build").handler(`
Build a product onboarding workspace for local shop owners.
Audience: non-technical shop owners
Constraints: avoid raw JSON input
Success: an owner can request their first build in one command
    `, {
      ui: {
        notify(message, tone) {
          uiEvents.push({ message, tone });
        },
        setStatus(scope, value) {
          uiEvents.push({ scope, value });
        }
      }
    });

    assert.equal(result.status, "awaiting_approval");
    assert.equal(typeof result.buildId, "string");
    assert.match(result.text, /Build Session/u);
    assert.match(result.text, /Changed surfaces:/u);
    assert.match(result.text, /Proof collected:/u);
    assert.match(result.text, /Unproven claims:/u);
    assert.match(result.text, /Reviewability:/u);
    assert.match(result.text, /Approval needed:/u);
    assert.match(result.text, /Recovery \/ undo notes:/u);
    assert.match(result.text, /Intake Summary/u);
    assert.match(result.text, /Staged Plan/u);
    assert.match(result.text, /Approval Checkpoint/u);
    assert.equal(result.recommendedNextAction, `/build-approve ${result.buildId}`);
    assert.equal(result.lifecycle.executionProgram.contracts.length > 0, true);

    const persisted = await buildSessionStore.loadBuildSession(result.buildId);
    const expectedPlanFingerprint = createExecutionProgramPlanFingerprint(persisted.lifecycle.executionProgram);
    const expectedApprovalActionClasses = deriveExecutionProgramActionClasses(persisted.lifecycle.executionProgram);
    assert.equal(persisted.buildId, result.buildId);
    assert.equal(persisted.planFingerprint, expectedPlanFingerprint);
    assert.equal(persisted.execution.status, "awaiting_approval");
    assert.equal(persisted.approval.programId, persisted.lifecycle.executionProgram.id);
    assert.equal(persisted.approval.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(persisted.approval.actionClasses, expectedApprovalActionClasses);
    assert.equal(persisted.approval.policyProfile, "default");
    assert.deepEqual(persisted.execution.actionClasses, []);
    assert.equal(persisted.execution.policyProfile, "default");
    assert.equal(persisted.execution.validationArtifacts.length, 1);
    assert.equal(persisted.execution.validationArtifacts[0].status, "not_captured");
    assert.equal(persisted.execution.validationArtifacts[0].validationOutcome, "not_run");
    assert.deepEqual(persisted.execution.reviewability, {
      status: "not_reviewable",
      reasons: ["non_terminal_status"]
    });
    assert.equal(
      uiEvents.some((event) => typeof event.message === "string" && /awaiting approval/i.test(event.message)),
      true
    );
  });
});

test("pi extension inline-approved build writes the approval binding before execution begins", async () => {
  await withTempDir("pi-orchestrator-build-session-inline-approve-", async (rootDir) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const runStore = createRunStore({ rootDir });
    let approvalDuringExecution = null;
    let inlineApprovedBuildId = null;
    const originalCreateBuildSession = buildSessionStore.createBuildSession.bind(buildSessionStore);

    buildSessionStore.createBuildSession = async function wrappedCreateBuildSession(args) {
      const created = await originalCreateBuildSession(args);
      inlineApprovedBuildId = created.buildId;
      return created;
    };

    const extension = createPiExtension({
      runStore,
      buildSessionStore,
      contractExecutor: async () => {
        if (approvalDuringExecution === null) {
          const persistedSessions = await buildSessionStore.loadBuildSession(inlineApprovedBuildId);
          approvalDuringExecution = persistedSessions?.approval ?? null;
        }

        return {
          status: "success",
          summary: "Executed the stored contract.",
          evidence: ["contract executed"],
          openQuestions: []
        };
      }
    });

    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const inlineApproved = await registeredCommands.get("build").handler(
      "--approve Build a local intake dashboard for operations managers",
      {
        ui: createUiStub()
      }
    );

    const expectedPlanFingerprint = createExecutionProgramPlanFingerprint(inlineApproved.lifecycle.executionProgram);
    const expectedApprovalActionClasses = deriveExecutionProgramActionClasses(inlineApproved.lifecycle.executionProgram);

    assert.equal(inlineApproved.status, "success");
    assert.equal(inlineApproved.buildSession.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(inlineApproved.buildSession.approval.actionClasses, expectedApprovalActionClasses);

    const persisted = await buildSessionStore.loadBuildSession(inlineApproved.buildId);
    assert.equal(persisted.planFingerprint, expectedPlanFingerprint);
    assert.equal(persisted.approval.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(persisted.approval.actionClasses, expectedApprovalActionClasses);
    assert.deepEqual(approvalDuringExecution, {
      approved: true,
      approvedAt: persisted.approval.approvedAt,
      programId: inlineApproved.lifecycle.executionProgram.id,
      planFingerprint: expectedPlanFingerprint,
      actionClasses: expectedApprovalActionClasses,
      policyProfile: "default"
    });
  });
});

test("pi extension build-approve executes a pending build session by build id", async () => {
  await withTempDir("pi-orchestrator-build-session-approve-", async (rootDir) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const executedContracts = [];
    let plannedBuildId = null;
    let approvalDuringExecution = null;
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const runStore = createRunStore({ rootDir });

    const extension = createPiExtension({
      runStore,
      buildSessionStore,
      contractExecutor: async (contract) => {
        if (plannedBuildId && approvalDuringExecution === null) {
          const persistedDuringExecution = await buildSessionStore.loadBuildSession(plannedBuildId);
          approvalDuringExecution = persistedDuringExecution?.approval ?? null;
        }
        executedContracts.push(contract.id);
        return {
          status: "success",
          summary: `Executed ${contract.id}.`,
          evidence: [`contract=${contract.id}`],
          openQuestions: []
        };
      }
    });

    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const planned = await registeredCommands.get("build").handler(
      "Build a lightweight launch planner for product operators",
      {
        ui: createUiStub()
      }
    );
    plannedBuildId = planned.buildId;

    const approved = await registeredCommands.get("build-approve").handler(planned.buildId, {
      ui: createUiStub()
    });
    const expectedPlanFingerprint = createExecutionProgramPlanFingerprint(approved.lifecycle.executionProgram);
    const expectedApprovalActionClasses = deriveExecutionProgramActionClasses(approved.lifecycle.executionProgram);

    assert.equal(approved.status, "success");
    assert.equal(approved.buildId, planned.buildId);
    assert.equal(approved.runJournal.status, "success");
    assert.equal(executedContracts.length, approved.lifecycle.executionProgram.contracts.length);
    assert.equal(approved.recommendedNextAction, `/build-status ${planned.buildId}`);
    assert.match(approved.text, /Approval Checkpoint/u);
    assert.match(approved.text, /Run status: success/u);
    assert.match(approved.text, /Changed surfaces: No observed changed-path evidence is persisted for recorded runs\./u);
    assert.match(approved.text, /Proof collected:/u);
    assert.match(approved.text, /Unproven claims:/u);
    assert.match(approved.text, /Reviewability:/u);
    assert.match(approved.text, /Approval needed:/u);
    assert.match(approved.text, /Recovery \/ undo notes:/u);

    const persisted = await buildSessionStore.loadBuildSession(planned.buildId);
    assert.equal(persisted.approval.approved, true);
    assert.equal(persisted.planFingerprint, expectedPlanFingerprint);
    assert.equal(persisted.approval.programId, approved.lifecycle.executionProgram.id);
    assert.equal(persisted.approval.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(persisted.approval.actionClasses, expectedApprovalActionClasses);
    assert.equal(persisted.approval.policyProfile, "default");
    assert.equal(persisted.execution.status, "success");
    assert.deepEqual(persisted.execution.actionClasses, []);
    assert.equal(persisted.execution.policyProfile, "default");
    assert.equal(persisted.execution.validationArtifacts.length, 1);
    assert.equal(persisted.execution.validationArtifacts[0].status, "not_captured");
    assert.equal(persisted.execution.validationArtifacts[0].validationOutcome, "pass");
    assert.deepEqual(persisted.execution.reviewability, {
      status: "not_reviewable",
      reasons: [
        "validation_artifacts_not_captured",
        "provider_model_evidence_requirement_unknown"
      ]
    });
    assert.equal(persisted.execution.programId, approved.lifecycle.executionProgram.id);
    assert.deepEqual(approvalDuringExecution, {
      approved: true,
      approvedAt: persisted.approval.approvedAt,
      programId: approved.lifecycle.executionProgram.id,
      planFingerprint: expectedPlanFingerprint,
      actionClasses: expectedApprovalActionClasses,
      policyProfile: "default"
    });
  });
});

test("pi extension build-approve blocks execution when the approved plan fingerprint no longer matches the stored plan", async () => {
  const { createPiExtension } = await import("../src/pi-extension.js");
  const registeredCommands = new Map();
  const lifecycle = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const buildSessionStore = createInMemoryBuildSessionStore({
    initialSession: createStubBuildSession({
      buildId: "build-stale-plan",
      lifecycle,
      approved: false,
      approval: {
        planFingerprint: "stale-plan-fingerprint"
      }
    })
  });
  let executedContracts = 0;

  const extension = createPiExtension({
    buildSessionStore,
    contractExecutor: async () => {
      executedContracts += 1;
      return {
        status: "success",
        summary: "unexpected contract execution",
        evidence: [],
        openQuestions: []
      };
    }
  });

  extension({
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    registerTool() {}
  });

  const blocked = await registeredCommands.get("build-approve").handler("build-stale-plan", {
    ui: createUiStub()
  });

  assert.equal(blocked.status, "blocked");
  assert.equal(executedContracts, 0);
  assert.match(blocked.stopReason, /Fresh approval is required before execution/u);
  assert.match(blocked.stopReason, /planFingerprint/u);
  assert.match(blocked.text, /Build Session/u);

  const persisted = buildSessionStore.getCurrentSession();
  assert.equal(persisted.approval.approved, true);
  assert.equal(persisted.execution.status, "blocked");
  assert.equal(persisted.execution.stopReason, blocked.stopReason);
  assert.equal(persisted.execution.programId, lifecycle.executionProgram.id);
});

test("pi extension inline-approved build blocks execution when the current action-class scope exceeds the approved scope", async () => {
  const { createPiExtension } = await import("../src/pi-extension.js");
  const registeredCommands = new Map();
  const buildSessionStore = createInMemoryBuildSessionStore({
    mutateCreatedSession(createdSession) {
      return {
        ...createdSession,
        approval: {
          ...createdSession.approval,
          actionClasses: ["read_repo", "write_allowed"]
        }
      };
    }
  });
  let executedContracts = 0;

  const extension = createPiExtension({
    buildSessionStore,
    contractExecutor: async () => {
      executedContracts += 1;
      return {
        status: "success",
        summary: "unexpected contract execution",
        evidence: [],
        openQuestions: []
      };
    }
  });

  extension({
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    registerTool() {}
  });

  const blocked = await registeredCommands.get("build").handler(
    "--approve Build an operator checklist for local support teams",
    {
      ui: createUiStub()
    }
  );

  assert.equal(blocked.status, "blocked");
  assert.equal(executedContracts, 0);
  assert.match(blocked.stopReason, /action classes outside the approved scope/u);
  assert.match(blocked.stopReason, /execute_local_command/u);
  assert.match(blocked.text, /Build Session/u);

  const persisted = buildSessionStore.getCurrentSession();
  assert.equal(persisted.approval.approved, true);
  assert.equal(persisted.execution.status, "blocked");
  assert.equal(persisted.execution.stopReason, blocked.stopReason);
  assert.equal(persisted.execution.programId, persisted.lifecycle.executionProgram.id);
});

test("pi extension build-approve blocks execution when newly derived install and git mutation classes exceed approved scope", async () => {
  const { createPiExtension } = await import("../src/pi-extension.js");
  const registeredCommands = new Map();
  const lifecycle = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  lifecycle.executionProgram.contracts[0].verificationPlan = [
    "npm install --save-dev vitest",
    "git commit -m \"checkpoint\""
  ];
  const buildSessionStore = createInMemoryBuildSessionStore({
    initialSession: createStubBuildSession({
      buildId: "build-missing-command-classes",
      lifecycle,
      approved: false,
      approval: {
        actionClasses: ["read_repo", "write_allowed", "execute_local_command"]
      }
    })
  });
  let executedContracts = 0;

  const extension = createPiExtension({
    buildSessionStore,
    contractExecutor: async () => {
      executedContracts += 1;
      return {
        status: "success",
        summary: "unexpected contract execution",
        evidence: [],
        openQuestions: []
      };
    }
  });

  extension({
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    registerTool() {}
  });

  const blocked = await registeredCommands.get("build-approve").handler("build-missing-command-classes", {
    ui: createUiStub()
  });

  assert.equal(blocked.status, "blocked");
  assert.equal(executedContracts, 0);
  assert.match(blocked.stopReason, /action classes outside the approved scope/u);
  assert.match(blocked.stopReason, /install_dependency/u);
  assert.match(blocked.stopReason, /mutate_git_state/u);
  assert.match(blocked.text, /Build Session/u);

  const persisted = buildSessionStore.getCurrentSession();
  assert.equal(persisted.approval.approved, true);
  assert.equal(persisted.execution.status, "blocked");
  assert.equal(persisted.execution.stopReason, blocked.stopReason);
  assert.equal(persisted.execution.programId, persisted.lifecycle.executionProgram.id);
});

test("pi extension build-status returns plain-English status and blocks unknown build ids", async () => {
  await withTempDir("pi-orchestrator-build-session-status-", async (rootDir) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const runStore = createRunStore({ rootDir });

    const extension = createPiExtension({
      runStore,
      buildSessionStore
    });
    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const planned = await registeredCommands.get("build").handler(
      "Build a support ticket triage assistant for local clinics",
      {
        ui: createUiStub()
      }
    );
    const status = await registeredCommands.get("build-status").handler(planned.buildId, {
      ui: createUiStub()
    });

    assert.equal(status.status, "awaiting_approval");
    assert.equal(status.buildId, planned.buildId);
    assert.equal(status.recommendedNextAction, `/build-approve ${planned.buildId}`);
    assert.match(status.text, /Build Session/u);
    assert.match(status.text, /Execution status: awaiting_approval/u);
    assert.match(status.text, /Changed surfaces:/u);
    assert.match(status.text, /Proof collected:/u);
    assert.match(status.text, /Unproven claims:/u);
    assert.match(status.text, /Reviewability:/u);
    assert.match(status.text, /Approval needed:/u);
    assert.match(status.text, /Recovery \/ undo notes:/u);

    const missing = await registeredCommands.get("build-status").handler("build-missing-id", {
      ui: createUiStub()
    });
    assert.equal(missing.status, "blocked");
    assert.equal(missing.buildId, "build-missing-id");
    assert.match(missing.text, /Build Session Lookup Blocked/u);

    const invalid = await registeredCommands.get("build-status").handler("   ", {
      ui: createUiStub()
    });
    assert.equal(invalid.status, "blocked");
    assert.match(invalid.text, /Build Session Lookup Blocked/u);
    assert.match(invalid.stopReason, /Provide a build id string/i);
  });
});

test("pi extension build-status syncs session state from persisted run-program journals", async () => {
  await withTempDir("pi-orchestrator-build-session-runstore-sync-", async (rootDir) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const runStore = createRunStore({ rootDir });

    const extension = createPiExtension({
      runStore,
      buildSessionStore,
      contractExecutor: async (contract) => ({
        status: "success",
        summary: `Executed ${contract.id}.`,
        evidence: [`contract=${contract.id}`],
        openQuestions: []
      })
    });

    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const planned = await registeredCommands.get("build").handler(
      "Build an onboarding checklist for product launch operators",
      {
        ui: createUiStub()
      }
    );
    const approved = await registeredCommands.get("build-approve").handler(planned.buildId, {
      ui: createUiStub()
    });
    assert.equal(approved.status, "success");
    const expectedPlanFingerprint = createExecutionProgramPlanFingerprint(approved.lifecycle.executionProgram);
    const expectedApprovalActionClasses = deriveExecutionProgramActionClasses(approved.lifecycle.executionProgram);

    await runStore.updateRun(approved.lifecycle.executionProgram.id, (existing) => ({
      ...existing,
      runJournal: {
        ...existing.runJournal,
        status: "running",
        stopReason: null
      }
    }));

    const status = await registeredCommands.get("build-status").handler(planned.buildId, {
      ui: createUiStub()
    });

    assert.equal(status.status, "running");
    assert.equal(status.recommendedNextAction, `/resume-program ${approved.lifecycle.executionProgram.id}`);

    const persisted = await buildSessionStore.loadBuildSession(planned.buildId);
    assert.equal(persisted.planFingerprint, expectedPlanFingerprint);
    assert.equal(persisted.execution.status, "running");
    assert.equal(persisted.approval.programId, approved.lifecycle.executionProgram.id);
    assert.equal(persisted.approval.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(persisted.approval.actionClasses, expectedApprovalActionClasses);
    assert.equal(persisted.approval.policyProfile, "default");
    assert.deepEqual(persisted.execution.actionClasses, []);
    assert.equal(persisted.execution.policyProfile, "default");
    assert.equal(persisted.execution.validationArtifacts.length, 1);
    assert.equal(persisted.execution.validationArtifacts[0].status, "not_captured");
    assert.equal(
      persisted.execution.validationArtifacts[0].validationOutcome,
      persisted.execution.validationOutcome
    );
    assert.deepEqual(persisted.execution.reviewability, {
      status: "not_reviewable",
      reasons: ["non_terminal_status"]
    });
  });
});

test("pi extension build-status sync normalizes unsupported action classes and uncaptured validation claims", async () => {
  await withTempDir("pi-orchestrator-build-session-runstore-evidence-sync-", async (rootDir) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const lifecycle = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
    const expectedPlanFingerprint = createExecutionProgramPlanFingerprint(lifecycle.executionProgram);
    const expectedApprovalActionClasses = deriveExecutionProgramActionClasses(lifecycle.executionProgram);
    const buildSession = await buildSessionStore.createBuildSession({
      intake: {
        goal: "Build a scoped release checklist for operators"
      },
      lifecycle: {
        proposalSet: lifecycle.proposalSet,
        blueprint: lifecycle.blueprint,
        executionProgram: lifecycle.executionProgram,
        auditReport: lifecycle.auditReport
      },
      approvalRequested: true
    });

    await buildSessionStore.updateBuildSession(buildSession.buildId, (existingSession) => ({
      ...existingSession,
      execution: {
        ...existingSession.execution,
        status: "running",
        stopReason: null,
        programId: lifecycle.executionProgram.id,
        completedContracts: 0,
        pendingContracts: lifecycle.executionProgram.contracts.length,
        updatedAt: new Date().toISOString()
      }
    }));

    const runStore = {
      async loadRun(programId) {
        return {
          programId,
          runJournal: {
            programId,
            status: "blocked",
            stopReason: "waiting for external dependency",
            stopReasonCode: null,
            validationOutcome: "blocked",
            actionClasses: ["access_secret", "mutate_git_state"],
            validationArtifacts: [
              {
                artifactType: "validation_artifact",
                reference: null,
                status: "captured"
              }
            ],
            contractRuns: [
              {
                contractId: lifecycle.executionProgram.contracts[0].id,
                status: "success",
                summary: "Executed first scoped contract.",
                evidence: ["run explorer: success"],
                openQuestions: []
              }
            ],
            completedContractIds: [lifecycle.executionProgram.contracts[0].id],
            pendingContractIds: lifecycle.executionProgram.contracts
              .slice(1)
              .map((contract) => contract.id)
          }
        };
      }
    };

    const extension = createPiExtension({
      runStore,
      buildSessionStore
    });
    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const status = await registeredCommands.get("build-status").handler(buildSession.buildId, {
      ui: createUiStub()
    });

    assert.equal(status.status, "blocked");
    assert.equal(status.buildId, buildSession.buildId);

    const persisted = await buildSessionStore.loadBuildSession(buildSession.buildId);
    assert.equal(persisted.planFingerprint, expectedPlanFingerprint);
    assert.equal(persisted.approval.programId, lifecycle.executionProgram.id);
    assert.equal(persisted.approval.planFingerprint, expectedPlanFingerprint);
    assert.deepEqual(persisted.approval.actionClasses, expectedApprovalActionClasses);
    assert.equal(persisted.approval.policyProfile, "default");
    assert.equal(persisted.execution.status, "blocked");
    assert.deepEqual(persisted.execution.actionClasses, []);
    assert.equal(persisted.execution.policyProfile, "default");
    assert.deepEqual(persisted.execution.validationArtifacts, [
      {
        artifactType: "validation_artifact",
        reference: null,
        status: "not_captured",
        validationOutcome: "blocked"
      }
    ]);
    assert.deepEqual(persisted.execution.reviewability, {
      status: "reviewable",
      reasons: []
    });
  });
});

test("pi extension build command returns a plain-English blocked message for invalid input", async () => {
  await withTempDir("pi-orchestrator-build-session-invalid-input-", async (rootDir) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const buildSessionStore = createBuildSessionStore({ rootDir });
    const runStore = createRunStore({ rootDir });

    const extension = createPiExtension({
      runStore,
      buildSessionStore
    });
    extension({
      registerCommand(name, config) {
        registeredCommands.set(name, config);
      },
      registerTool() {}
    });

    const result = await registeredCommands.get("build").handler("   ", {
      ui: createUiStub()
    });

    assert.equal(result.status, "blocked");
    assert.match(result.text, /Build Flow Blocked/u);
    assert.match(result.text, /Try again with one clear idea sentence/u);
  });
});
