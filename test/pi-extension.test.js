import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildProjectLifecycleArtifacts } from "../src/project-workflows.js";
import { createScriptedWorkerRunner } from "../src/worker-runner.js";

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("pi extension entrypoint imports without undeclared runtime dependencies", async () => {
  const module = await import("../src/pi-extension.js");

  assert.equal(typeof module.default, "function");
  assert.equal(typeof module.createPiExtension, "function");
});

test("pi extension exposes run-program and run_execution_program", async () => {
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
  assert.equal(registeredCommands.has("auto"), true);
  assert.equal(registeredTools.has("run_execution_program"), true);
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
