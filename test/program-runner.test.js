import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runExecutionProgram } from "../src/program-runner.js";
import { buildProjectLifecycleArtifacts } from "../src/project-workflows.js";

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function buildProgram() {
  const brief = loadFixture("project-brief.json");
  return buildProjectLifecycleArtifacts(brief).executionProgram;
}

test("program runner executes contracts in dependency order", async () => {
  const program = buildProgram();
  const shuffled = structuredClone(program);
  shuffled.contracts = [
    program.contracts[2],
    program.contracts[0],
    program.contracts[1],
    program.contracts[3],
    program.contracts[4]
  ];

  const executed = [];
  const journal = await runExecutionProgram(shuffled, {
    contractExecutor: async (contract) => {
      executed.push(contract.id);
      return {
        status: "success",
        summary: `Executed ${contract.id}.`,
        evidence: [],
        openQuestions: []
      };
    }
  });

  assert.equal(journal.status, "success");
  assert.deepEqual(executed, [
    "bootstrap-package",
    "freeze-lifecycle-contracts",
    "wire-execution-backend",
    "harden-regressions-and-audit",
    "package-readiness"
  ]);
  assert.deepEqual(journal.completedContractIds, executed);
  assert.deepEqual(journal.pendingContractIds, []);
});

test("program runner stops on the first blocked contract", async () => {
  const program = buildProgram();

  const journal = await runExecutionProgram(program, {
    contractExecutor: async (contract) => {
      if (contract.id === "freeze-lifecycle-contracts") {
        return {
          status: "blocked",
          summary: "Waiting for a dependency outside current scope.",
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

  assert.equal(journal.status, "blocked");
  assert.equal(journal.contractRuns.length, 2);
  assert.equal(journal.contractRuns[1].contractId, "freeze-lifecycle-contracts");
  assert.equal(journal.contractRuns[1].status, "blocked");
  assert.equal(journal.completedContractIds.length, 1);
  assert.deepEqual(journal.completedContractIds, ["bootstrap-package"]);
});

test("program runner reports pending contracts after a stop", async () => {
  const program = buildProgram();

  const journal = await runExecutionProgram(program, {
    contractExecutor: async (contract) => ({
      status: contract.id === "freeze-lifecycle-contracts" ? "blocked" : "success",
      summary: `Result for ${contract.id}.`,
      evidence: [],
      openQuestions: []
    })
  });

  assert.equal(journal.status, "blocked");
  assert.deepEqual(journal.completedContractIds, ["bootstrap-package"]);
  assert.deepEqual(journal.pendingContractIds, [
    "freeze-lifecycle-contracts",
    "wire-execution-backend",
    "harden-regressions-and-audit",
    "package-readiness"
  ]);
});

test("program runner blocks execution when a dependency id is missing", async () => {
  const program = buildProgram();
  const broken = structuredClone(program);
  broken.contracts[1].dependsOn = ["missing-contract-id"];
  const calls = [];

  const journal = await runExecutionProgram(broken, {
    contractExecutor: async (contract) => {
      calls.push(contract.id);
      return {
        status: "success",
        summary: `Executed ${contract.id}.`,
        evidence: [],
        openQuestions: []
      };
    }
  });

  assert.equal(journal.status, "blocked");
  assert.match(journal.stopReason, /missing contract id/i);
  assert.equal(journal.contractRuns.length, 0);
  assert.equal(calls.length, 0);
});

test("program runner blocks execution when dependencies contain a cycle", async () => {
  const program = buildProgram();
  const cyclic = structuredClone(program);
  cyclic.contracts[0].dependsOn = [cyclic.contracts[4].id];
  const calls = [];

  const journal = await runExecutionProgram(cyclic, {
    contractExecutor: async (contract) => {
      calls.push(contract.id);
      return {
        status: "success",
        summary: `Executed ${contract.id}.`,
        evidence: [],
        openQuestions: []
      };
    }
  });

  assert.equal(journal.status, "blocked");
  assert.match(journal.stopReason, /cycle/i);
  assert.equal(journal.contractRuns.length, 0);
  assert.equal(calls.length, 0);
});
