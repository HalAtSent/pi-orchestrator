import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  auditProject,
  blueprintProject,
  bootstrapProject,
  brainstormProject,
  buildProjectLifecycleArtifacts,
  sliceProject
} from "../src/project-workflows.js";

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("brainstorm returns structured alternatives for an automation package", () => {
  const brief = loadFixture("project-brief.json");
  const proposalSet = brainstormProject(brief);

  assert.equal(proposalSet.projectType, "automation-package");
  assert.equal(proposalSet.recommendedAlternativeId, "control-plane-first");
  assert.equal(proposalSet.alternatives.length, 3);
  assert.ok(proposalSet.milestoneTrack.some((milestone) => milestone.id === "execution"));
});

test("blueprint freezes repository layout and execution profile", () => {
  const brief = loadFixture("project-brief.json");
  const proposalSet = brainstormProject(brief);
  const blueprint = blueprintProject({ proposalSet });

  assert.equal(blueprint.selectedAlternativeId, "control-plane-first");
  assert.equal(blueprint.executionProfile.autonomyMode, "autonomous");
  assert.equal(blueprint.executionProfile.humanGatePolicy, "preapprove-high-risk-at-launch");
  assert.equal(blueprint.executionProfile.maxParallelWorkers, 1);
  assert.deepEqual(blueprint.modules.map((module) => module.id), [
    "control-plane",
    "pi-adapter",
    "worker-plane",
    "verification-surface"
  ]);
  const modulePathsById = Object.fromEntries(
    blueprint.modules.map((module) => [module.id, module.paths])
  );
  assert.deepEqual(modulePathsById["control-plane"], [
    "src/contracts.js",
    "src/boolean-flags.js",
    "src/helpers.js",
    "src/orchestrator.js",
    "src/path-scopes.js",
    "src/policies.js",
    "src/program-compiler.js",
    "src/program-contract-executor.js",
    "src/program-runner.js",
    "src/project-contracts.js",
    "src/project-workflows.js",
    "src/auto-workflow.js",
    "src/run-store.js",
    "src/safe-clone.js",
    "src/schema.js"
  ]);
  assert.deepEqual(modulePathsById["pi-adapter"], [
    "src/pi-adapter.js",
    "src/pi-extension.js",
    "src/pi-runtime-diagnostics.js"
  ]);
  assert.deepEqual(modulePathsById["worker-plane"], [
    "src/auto-backend-runner.js",
    "src/process-model-probe.js",
    "src/pi-spawn.js",
    "src/pi-worker-runner.js",
    "src/process-worker-backend.js",
    "src/spike-worker-backend.js",
    "src/worker-runner.js",
    "skills/"
  ]);
  assert.deepEqual(modulePathsById["verification-surface"], ["test/", "examples/", "docs/"]);
  const mappedSourcePaths = [...new Set(
    blueprint.modules.flatMap((module) => module.paths.filter((path) => path.startsWith("src/") && path.endsWith(".js")))
  )].sort();
  const currentSourcePaths = readdirSync(new URL("../src/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => `src/${entry.name}`)
    .sort();
  assert.deepEqual(mappedSourcePaths, currentSourcePaths);
  assert.ok(blueprint.repositoryLayout.some((entry) => entry.path === "skills/"));
});

test("blueprint preserves guarded autonomy when compiled from a proposal set", () => {
  const proposalSet = brainstormProject({
    goal: "Build a guarded service",
    autonomyMode: "guarded"
  });
  const blueprint = blueprintProject({ proposalSet });

  assert.equal(proposalSet.brief.autonomyMode, "guarded");
  assert.equal(blueprint.brief.autonomyMode, "guarded");
  assert.equal(blueprint.executionProfile.autonomyMode, "guarded");
  assert.equal(blueprint.executionProfile.humanGatePolicy, "interactive-high-risk-gate");
  assert.equal(blueprint.executionProfile.maxParallelWorkers, 1);
});

test("slice returns an execution program with ordered milestone contracts", () => {
  const brief = loadFixture("project-brief.json");
  const { blueprint } = buildProjectLifecycleArtifacts(brief);
  const executionProgram = sliceProject({ blueprint });

  assert.equal(executionProgram.contracts[0].id, "bootstrap-package");
  assert.deepEqual(executionProgram.contracts[1].dependsOn, ["bootstrap-package"]);
  assert.ok(executionProgram.contracts.some((contract) => contract.id === "package-readiness"));
  assert.ok(executionProgram.completionChecks.length >= 3);
});

test("bootstrap extracts the first executable contract with commands", () => {
  const brief = loadFixture("project-brief.json");
  const { blueprint } = buildProjectLifecycleArtifacts(brief);
  const bootstrapContract = bootstrapProject({ blueprint });

  assert.equal(bootstrapContract.id, "bootstrap-package");
  assert.ok(bootstrapContract.commands.includes("node --test --test-isolation=none"));
  assert.deepEqual(bootstrapContract.brief.constraints, brief.constraints);
  assert.ok(bootstrapContract.scopePaths.includes("src/"));
});

test("audit passes on the generated lifecycle scaffolding", () => {
  const brief = loadFixture("project-brief.json");
  const { blueprint, executionProgram } = buildProjectLifecycleArtifacts(brief);
  const auditReport = auditProject({ blueprint, executionProgram });

  assert.equal(auditReport.status, "pass");
  assert.equal(auditReport.findings.length, 0);
  assert.ok(auditReport.recommendedNextContracts.includes("bootstrap-package"));
});

test("lifecycle artifacts preserve the original brief constraints and non-goals", () => {
  const brief = {
    ...loadFixture("project-brief.json"),
    constraints: ["Must run fully offline", "Do not use external APIs"],
    nonGoals: ["Do not require interactive approvals during autonomous mode"],
    targetUsers: ["single operator", "future collaborator"],
    successCriteria: ["Runs end to end with no external API dependency"],
    stackPreferences: ["Node.js", "Pi package", "offline-first"]
  };
  const lifecycle = buildProjectLifecycleArtifacts(brief);

  assert.deepEqual(lifecycle.proposalSet.brief.constraints, brief.constraints);
  assert.deepEqual(lifecycle.blueprint.brief.nonGoals, brief.nonGoals);
  assert.deepEqual(lifecycle.executionProgram.brief.targetUsers, brief.targetUsers);
  assert.deepEqual(lifecycle.executionProgram.contracts[0].constraints, brief.constraints);
  assert.ok(lifecycle.executionProgram.contracts[0].stopConditions.some((condition) => condition.includes("Must run fully offline")));
  assert.deepEqual(lifecycle.auditReport.brief.successCriteria, brief.successCriteria);
});

test("audit flags an autonomy profile that still requires interactive gates", () => {
  const brief = loadFixture("project-brief.json");
  const { blueprint, executionProgram } = buildProjectLifecycleArtifacts(brief);
  const riskyBlueprint = structuredClone(blueprint);
  riskyBlueprint.executionProfile.humanGatePolicy = "interactive-high-risk-gate";

  const auditReport = auditProject({ blueprint: riskyBlueprint, executionProgram });

  assert.equal(auditReport.status, "attention_required");
  assert.ok(auditReport.findings.some((finding) => finding.id === "interactive-gate-conflict"));
});

test("audit flags a mismatched execution program", () => {
  const alpha = buildProjectLifecycleArtifacts({
    ...loadFixture("project-brief.json"),
    projectName: "alpha"
  });
  const beta = buildProjectLifecycleArtifacts({
    ...loadFixture("project-brief.json"),
    projectName: "beta"
  });

  const auditReport = auditProject({
    blueprint: alpha.blueprint,
    executionProgram: beta.executionProgram
  });

  assert.equal(auditReport.status, "attention_required");
  assert.ok(auditReport.findings.some((finding) => finding.id === "mismatched-blueprint-program"));
});

test("audit flags an execution program where bootstrap is not first", () => {
  const brief = loadFixture("project-brief.json");
  const { blueprint, executionProgram } = buildProjectLifecycleArtifacts(brief);
  const reorderedProgram = structuredClone(executionProgram);
  reorderedProgram.contracts.push(reorderedProgram.contracts.shift());

  const auditReport = auditProject({
    blueprint,
    executionProgram: reorderedProgram
  });

  assert.equal(auditReport.status, "attention_required");
  assert.ok(auditReport.findings.some((finding) => finding.id === "bootstrap-not-first"));
});

test("audit flags a contract dependency on a missing milestone id", () => {
  const brief = loadFixture("project-brief.json");
  const { blueprint, executionProgram } = buildProjectLifecycleArtifacts(brief);
  const brokenProgram = structuredClone(executionProgram);
  brokenProgram.contracts[1].dependsOn = ["missing-contract"];

  const auditReport = auditProject({
    blueprint,
    executionProgram: brokenProgram
  });

  assert.equal(auditReport.status, "attention_required");
  assert.ok(auditReport.findings.some((finding) => finding.id === "missing-dependency-freeze-lifecycle-contracts"));
});

test("audit flags dependency cycles in execution-program topology", () => {
  const brief = loadFixture("project-brief.json");
  const { blueprint, executionProgram } = buildProjectLifecycleArtifacts(brief);
  const cyclicalProgram = structuredClone(executionProgram);
  const finalContractId = cyclicalProgram.contracts[cyclicalProgram.contracts.length - 1].id;
  cyclicalProgram.contracts[0].dependsOn = [finalContractId];

  const auditReport = auditProject({
    blueprint,
    executionProgram: cyclicalProgram
  });

  assert.equal(auditReport.status, "attention_required");
  assert.ok(auditReport.findings.some((finding) => finding.id === "dependency-cycle-detected"));
  assert.ok(auditReport.findings.some((finding) => finding.summary.includes("dependency cycle")));
});

test("audit flags duplicate contract ids in execution-program topology", () => {
  const brief = loadFixture("project-brief.json");
  const { blueprint, executionProgram } = buildProjectLifecycleArtifacts(brief);
  const duplicateProgram = structuredClone(executionProgram);
  const duplicateContract = structuredClone(duplicateProgram.contracts[0]);
  duplicateProgram.contracts.push(duplicateContract);

  const auditReport = auditProject({
    blueprint,
    executionProgram: duplicateProgram
  });

  assert.equal(auditReport.status, "attention_required");
  assert.ok(auditReport.findings.some((finding) => finding.id === `duplicate-contract-id-${duplicateContract.id}`));
  assert.ok(auditReport.findings.some((finding) => finding.summary.includes(`duplicate contract id: ${duplicateContract.id}`)));
});
