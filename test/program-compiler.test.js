import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { compileExecutionContract } from "../src/program-compiler.js";
import { buildProjectLifecycleArtifacts } from "../src/project-workflows.js";

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("compiler preserves contract scope, constraints, and contract guards", () => {
  const program = buildProjectLifecycleArtifacts(loadFixture("project-brief.json")).executionProgram;
  const contract = program.contracts[1];
  const compiled = compileExecutionContract(contract, {
    contextFiles: ["README.md"]
  });

  assert.equal(compiled.contractId, contract.id);
  assert.equal(compiled.goal, contract.goal);
  assert.deepEqual(compiled.allowedFileScope, contract.scopePaths);
  assert.deepEqual(compiled.constraints, contract.constraints);
  assert.deepEqual(compiled.nonGoals, contract.nonGoals);
  assert.deepEqual(compiled.acceptanceChecks, contract.acceptanceChecks);
  assert.deepEqual(compiled.stopConditions, contract.stopConditions);
  assert.deepEqual(compiled.contextFiles, ["README.md"]);

  for (const packet of compiled.workflow.packets) {
    assert.deepEqual(packet.allowedFiles, contract.scopePaths);
    for (const check of contract.acceptanceChecks) {
      assert.equal(packet.acceptanceChecks.includes(check), true);
    }
    for (const stopCondition of contract.stopConditions) {
      assert.equal(packet.stopConditions.includes(stopCondition), true);
    }
    for (const nonGoal of contract.nonGoals) {
      assert.equal(packet.nonGoals.includes(nonGoal), true);
    }
  }
});

test("compiler derives role sequence from contract risk policy", () => {
  const contract = {
    id: "risk-high-contract",
    goal: "Apply a schema migration for billing events",
    scopePaths: ["platform/contracts/ingest/artifact.json"],
    constraints: ["Keep migration steps reversible."],
    nonGoals: ["Do not modify unrelated ingestion paths."],
    acceptanceChecks: ["Migration plan is explicit and reviewable."],
    stopConditions: ["Stop if migration scope expands beyond the declared contract."],
    deliverables: ["Schema migration plan"],
    risk: "high"
  };

  const compiled = compileExecutionContract(contract);

  assert.equal(compiled.risk, "high");
  assert.deepEqual(compiled.intendedRoleSequence, ["explorer", "implementer", "reviewer", "verifier"]);
  assert.deepEqual(compiled.workflow.roleSequence, ["explorer", "implementer", "reviewer", "verifier"]);
  assert.equal(compiled.workflow.humanGate, true);
});
