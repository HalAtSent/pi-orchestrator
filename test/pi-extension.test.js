import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildProjectLifecycleArtifacts } from "../src/project-workflows.js";
import { createPiWorkerRunner } from "../src/pi-worker-runner.js";
import { createScriptedWorkerRunner } from "../src/worker-runner.js";
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
    approvedHighRisk: true,
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

  const extension = createPiExtension({
    contractExecutor: async (contract) => {
      executedContracts.push(contract.id);
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
  assert.equal(registeredTools.has("run_execution_program"), true);
  assert.equal(registeredTools.has("resume_execution_program"), true);
  assert.equal(registeredTools.has("run_auto_workflow"), true);

  const program = buildProjectLifecycleArtifacts(loadFixture("project-brief.json")).executionProgram;
  const uiEvents = [];
  const runFromCommand = await registeredCommands.get("run-program").handler(JSON.stringify({ program }), {
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

  const runFromTool = await registeredTools.get("run_execution_program").execute("tool-call-1", { program });
  assert.equal(runFromTool.details.status, "success");
  assert.match(runFromTool.content[0].text, /^program:/m);
});

test("pi extension resume-program resumes a persisted execution program run", async () => {
  await withTempDir("pi-orchestrator-pi-extension-", async (rootDir) => {
    const { createPiExtension } = await import("../src/pi-extension.js");
    const registeredCommands = new Map();
    const runStore = createRunStore({ rootDir });
    const executionCounts = new Map();

    const extension = createPiExtension({
      runStore,
      contractExecutor: async (contract) => {
        const count = executionCounts.get(contract.id) ?? 0;
        executionCounts.set(contract.id, count + 1);

        if (contract.id === "freeze-lifecycle-contracts" && count === 0) {
          return {
            status: "blocked",
            summary: "Waiting for a one-time human decision.",
            evidence: [],
            openQuestions: []
          };
        }

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
    const ui = {
      notify() {},
      setStatus() {}
    };

    const firstRun = await registeredCommands.get("run-program").handler(JSON.stringify({ program }), { ui });
    assert.equal(firstRun.status, "blocked");

    const resumedRun = await registeredCommands.get("resume-program").handler(program.id, { ui });
    assert.equal(resumedRun.status, "success");

    assert.equal(executionCounts.get("bootstrap-package"), 1);
    assert.equal(executionCounts.get("freeze-lifecycle-contracts"), 2);
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

test("pi extension auto command runs through an injected Pi-backed runner", async () => {
  const { createPiExtension } = await import("../src/pi-extension.js");
  const requestedRoles = [];
  const runner = createPiWorkerRunner({
    adapter: {
      async runWorker(request) {
        requestedRoles.push(request.role);
        return {
          status: "success",
          summary: `${request.role} completed`,
          changedFiles: request.role === "implementer" ? ["src/helpers.js"] : [],
          commandsRun: [...request.commands],
          evidence: [`role=${request.role}`],
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
      notify() {},
      setStatus() {}
    }
  });

  assert.equal(execution.status, "success");
  assert.deepEqual(requestedRoles, ["implementer", "verifier"]);
  assert.equal(execution.runs.length, 2);
});
