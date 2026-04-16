import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  createAuditReport,
  createExecutionProgram
} from "../src/project-contracts.js";
import {
  DOCTRINE_EVALUATION_CRITERION_IDS,
  getDoctrineEvaluationDefinitions
} from "../src/doctrine-evaluation.js";

import {
  auditProject,
  blueprintProject,
  bootstrapProject,
  brainstormProject,
  buildProjectLifecycleArtifacts,
  createExecutionProgramPlanFingerprint,
  deriveExecutionProgramActionClasses,
  sliceProject
} from "../src/project-workflows.js";

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function findEntryIndexBy(entries, key, value) {
  const index = entries.findIndex((entry) => entry[key] === value);
  assert.notEqual(index, -1, `expected ${key}=${value} to exist in fixture`);
  return index;
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
    "src/doctrine-evaluation.js",
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
    "src/build-session-store.js",
    "src/run-evidence.js",
    "src/run-store.js",
    "src/safe-clone.js",
    "src/schema.js"
  ]);
  assert.deepEqual(modulePathsById["pi-adapter"], [
    "src/operator-formatters.js",
    "src/operator-intake.js",
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

test("ExecutionProgram rejects whitespace-only scopePaths, dependsOn, and completionChecks", () => {
  const { executionProgram } = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));

  const whitespaceScopePaths = structuredClone(executionProgram);
  whitespaceScopePaths.contracts[0].scopePaths[0] = "   ";
  assert.throws(
    () => createExecutionProgram(whitespaceScopePaths),
    /program\.contracts\[\]\.scopePaths\[0\] must be a non-empty string/u
  );

  const whitespaceDependsOn = structuredClone(executionProgram);
  whitespaceDependsOn.contracts[1].dependsOn = [" \t "];
  assert.throws(
    () => createExecutionProgram(whitespaceDependsOn),
    /program\.contracts\[\]\.dependsOn\[0\] must be a non-empty string/u
  );

  const whitespaceCompletionChecks = structuredClone(executionProgram);
  whitespaceCompletionChecks.completionChecks = ["\n  "];
  assert.throws(
    () => createExecutionProgram(whitespaceCompletionChecks),
    /program\.completionChecks\[0\] must be a non-empty string/u
  );
});

test("brief normalization trims and validates autonomyMode and projectType deterministically", () => {
  const proposalSet = brainstormProject({
    goal: "Build a service workflow",
    projectType: "  SERVICE ",
    autonomyMode: "  GUARDED ",
    constraints: [" keep control-plane policy in code "]
  });

  assert.equal(proposalSet.projectType, "service");
  assert.equal(proposalSet.brief.autonomyMode, "guarded");
  assert.deepEqual(proposalSet.brief.constraints, ["keep control-plane policy in code"]);

  const blueprint = blueprintProject({
    proposalSet,
    autonomyMode: "  autonomous  "
  });
  assert.equal(blueprint.projectType, "service");
  assert.equal(blueprint.executionProfile.autonomyMode, "autonomous");
  assert.equal(blueprint.executionProfile.humanGatePolicy, "preapprove-high-risk-at-launch");

  assert.throws(
    () => brainstormProject({
      goal: "Build a project",
      projectType: "  unknown-type  "
    }),
    /projectType must be one of:/u
  );

  assert.throws(
    () => brainstormProject({
      goal: "Build a project",
      autonomyMode: "  semi-auto  "
    }),
    /autonomyMode must be one of:/u
  );

  assert.throws(
    () => blueprintProject({
      proposalSet,
      autonomyMode: "   "
    }),
    /autonomyMode must be a non-empty string/u
  );
});

test("slice returns an execution program with ordered milestone contracts", () => {
  const brief = loadFixture("project-brief.json");
  const { blueprint } = buildProjectLifecycleArtifacts(brief);
  const executionProgram = sliceProject({ blueprint });
  const canonicalCriteria = getDoctrineEvaluationDefinitions();

  assert.equal(executionProgram.contracts[0].id, "bootstrap-package");
  assert.deepEqual(executionProgram.contracts[1].dependsOn, ["bootstrap-package"]);
  assert.ok(executionProgram.contracts.some((contract) => contract.id === "package-readiness"));
  assert.ok(executionProgram.completionChecks.length >= 3);
  assert.equal(executionProgram.evaluationCriteria.length, canonicalCriteria.length);
  assert.deepEqual(
    executionProgram.evaluationCriteria.map((criterion) => criterion.id),
    canonicalCriteria.map((criterion) => criterion.id)
  );
  assert.deepEqual(
    executionProgram.evaluationCriteria.map((criterion) => criterion.artifactHooks),
    canonicalCriteria.map((criterion) => criterion.artifactHooks)
  );
});

test("execution program approval helpers derive a stable fingerprint and pre-execution action classes", () => {
  const brief = loadFixture("project-brief.json");
  const { executionProgram } = buildProjectLifecycleArtifacts(brief);
  const fingerprint = createExecutionProgramPlanFingerprint(executionProgram);
  const actionClasses = deriveExecutionProgramActionClasses(executionProgram);
  const modifiedProgram = structuredClone(executionProgram);

  modifiedProgram.contracts[0].summary = `${modifiedProgram.contracts[0].summary} (changed)`;

  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(actionClasses, ["read_repo", "write_allowed", "execute_local_command"]);
  assert.notEqual(
    createExecutionProgramPlanFingerprint(modifiedProgram),
    fingerprint
  );
});

test("execution program approval helpers promote install and git mutation classes from explicit verification commands", () => {
  const brief = loadFixture("project-brief.json");
  const { executionProgram } = buildProjectLifecycleArtifacts(brief);
  const programWithCommandSignals = structuredClone(executionProgram);

  programWithCommandSignals.contracts[0].verificationPlan = [
    "npm install --save-dev vitest",
    "git commit -m \"checkpoint\""
  ];

  assert.deepEqual(
    deriveExecutionProgramActionClasses(programWithCommandSignals),
    ["read_repo", "write_allowed", "execute_local_command", "install_dependency", "mutate_git_state"]
  );
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
  assert.equal(auditReport.evaluationCoverage.length, DOCTRINE_EVALUATION_CRITERION_IDS.length);
  assert.deepEqual(
    auditReport.evaluationCoverage.map((entry) => entry.criterionId),
    DOCTRINE_EVALUATION_CRITERION_IDS
  );
  assert.ok(auditReport.evaluationCoverage.every((entry) => entry.status === "covered"));
});

test("audit marks doctrine coverage as missing when required structural hooks are empty", () => {
  const brief = loadFixture("project-brief.json");
  const { blueprint, executionProgram } = buildProjectLifecycleArtifacts(brief);
  const brokenProgram = structuredClone(executionProgram);
  brokenProgram.completionChecks = [];
  brokenProgram.contracts[0].verificationPlan = [];

  const auditReport = auditProject({
    blueprint,
    executionProgram: brokenProgram
  });

  assert.equal(auditReport.status, "attention_required");
  assert.ok(
    auditReport.evaluationCoverage.some((entry) => {
      return entry.status === "missing" && entry.missingHooks.includes("program.completionChecks");
    })
  );
  assert.ok(
    auditReport.findings.some((finding) => finding.id.startsWith("empty-evaluation-hook-targets-"))
  );
});

test("ExecutionProgram rejects malformed evaluationCriteria hook refs", () => {
  const { executionProgram } = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const malformedCriteria = structuredClone(executionProgram);
  malformedCriteria.evaluationCriteria[0].artifactHooks = ["program.invalidHook"];

  assert.throws(
    () => createExecutionProgram(malformedCriteria),
    /program\.evaluationCriteria\[0\]\.artifactHooks contains unsupported hook ref: program\.invalidHook/u
  );
});

test("ExecutionProgram rejects criterion-specific evaluation hook drift", () => {
  const { executionProgram } = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const driftedCriteria = structuredClone(executionProgram);
  const criterionIndex = findEntryIndexBy(driftedCriteria.evaluationCriteria, "id", "trustworthy_output");
  driftedCriteria.evaluationCriteria[criterionIndex].artifactHooks = ["blueprint.qualityGates"];

  assert.throws(
    () => createExecutionProgram(driftedCriteria),
    /program\.evaluationCriteria\[\d+\]\.artifactHooks must match canonical hook refs for criterion trustworthy_output/u
  );
});

test("ExecutionProgram rejects criterion-specific evaluation question drift", () => {
  const { executionProgram } = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const driftedCriteria = structuredClone(executionProgram);
  const criterionIndex = findEntryIndexBy(driftedCriteria.evaluationCriteria, "id", "trustworthy_output");
  driftedCriteria.evaluationCriteria[criterionIndex].question = "Edited question drift";

  assert.throws(
    () => createExecutionProgram(driftedCriteria),
    /program\.evaluationCriteria\[\d+\]\.question must match canonical question for criterion trustworthy_output/u
  );
});

test("ExecutionProgram rejects missing canonical doctrine evaluation criteria", () => {
  const { executionProgram } = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const missingCriterionProgram = structuredClone(executionProgram);
  missingCriterionProgram.evaluationCriteria = missingCriterionProgram.evaluationCriteria.filter((criterion) => {
    return criterion.id !== "operator_clarity";
  });

  assert.throws(
    () => createExecutionProgram(missingCriterionProgram),
    /program\.evaluationCriteria must contain exactly 6 canonical criteria/u
  );
});

test("ExecutionProgram rejects reordered canonical doctrine evaluation criteria", () => {
  const { executionProgram } = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const reorderedCriteriaProgram = structuredClone(executionProgram);
  [reorderedCriteriaProgram.evaluationCriteria[0], reorderedCriteriaProgram.evaluationCriteria[1]] = [
    reorderedCriteriaProgram.evaluationCriteria[1],
    reorderedCriteriaProgram.evaluationCriteria[0]
  ];

  assert.throws(
    () => createExecutionProgram(reorderedCriteriaProgram),
    /program\.evaluationCriteria\[0\]\.id must be canonical id trustworthy_output at index 0/u
  );
});

test("AuditReport rejects malformed evaluationCoverage entries", () => {
  const { auditReport } = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const malformedCoverage = structuredClone(auditReport);
  malformedCoverage.evaluationCoverage[0].status = "pass";

  assert.throws(
    () => createAuditReport(malformedCoverage),
    /auditReport\.evaluationCoverage\[0\]\.status must be one of: covered, missing/u
  );
});

test("AuditReport rejects evaluationCoverage hook drift across criteria", () => {
  const { auditReport } = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const malformedCoverage = structuredClone(auditReport);
  const coverageIndex = findEntryIndexBy(malformedCoverage.evaluationCoverage, "criterionId", "trustworthy_output");
  malformedCoverage.evaluationCoverage[coverageIndex].status = "missing";
  malformedCoverage.evaluationCoverage[coverageIndex].evidenceHooks = ["blueprint.qualityGates"];
  malformedCoverage.evaluationCoverage[coverageIndex].missingHooks = [
    "brief.successCriteria",
    "program.completionChecks",
    "program.contracts[].successCriteria"
  ];

  assert.throws(
    () => createAuditReport(malformedCoverage),
    /auditReport\.evaluationCoverage\[\d+\]\.evidenceHooks contains hook ref not allowed for criterion trustworthy_output: blueprint\.qualityGates/u
  );
});

test("AuditReport rejects evaluationCoverage partitions that omit canonical hooks", () => {
  const { auditReport } = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const malformedCoverage = structuredClone(auditReport);
  const coverageIndex = findEntryIndexBy(malformedCoverage.evaluationCoverage, "criterionId", "trustworthy_output");
  malformedCoverage.evaluationCoverage[coverageIndex].status = "missing";
  malformedCoverage.evaluationCoverage[coverageIndex].evidenceHooks = ["brief.successCriteria"];
  malformedCoverage.evaluationCoverage[coverageIndex].missingHooks = ["program.completionChecks"];

  assert.throws(
    () => createAuditReport(malformedCoverage),
    /auditReport\.evaluationCoverage\[\d+\] must partition canonical hook refs for criterion trustworthy_output; missing from evidenceHooks and missingHooks: program\.contracts\[\]\.successCriteria/u
  );
});

test("AuditReport rejects evaluationCoverage partitions with hook overlap", () => {
  const { auditReport } = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const malformedCoverage = structuredClone(auditReport);
  const coverageIndex = findEntryIndexBy(malformedCoverage.evaluationCoverage, "criterionId", "trustworthy_output");
  malformedCoverage.evaluationCoverage[coverageIndex].status = "missing";
  malformedCoverage.evaluationCoverage[coverageIndex].evidenceHooks = ["brief.successCriteria"];
  malformedCoverage.evaluationCoverage[coverageIndex].missingHooks = [
    "brief.successCriteria",
    "program.completionChecks",
    "program.contracts[].successCriteria"
  ];

  assert.throws(
    () => createAuditReport(malformedCoverage),
    /auditReport\.evaluationCoverage\[\d+\]\.evidenceHooks and auditReport\.evaluationCoverage\[\d+\]\.missingHooks must not overlap for criterion trustworthy_output/u
  );
});

test("AuditReport rejects covered status when missingHooks are present", () => {
  const { auditReport } = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const malformedCoverage = structuredClone(auditReport);
  const coverageIndex = findEntryIndexBy(malformedCoverage.evaluationCoverage, "criterionId", "trustworthy_output");
  malformedCoverage.evaluationCoverage[coverageIndex].status = "covered";
  malformedCoverage.evaluationCoverage[coverageIndex].evidenceHooks = ["brief.successCriteria"];
  malformedCoverage.evaluationCoverage[coverageIndex].missingHooks = [
    "program.completionChecks",
    "program.contracts[].successCriteria"
  ];

  assert.throws(
    () => createAuditReport(malformedCoverage),
    /auditReport\.evaluationCoverage\[\d+\]\.status cannot be covered when missingHooks is non-empty for criterion trustworthy_output/u
  );
});

test("AuditReport rejects missing status when canonical hooks are fully covered", () => {
  const { auditReport } = buildProjectLifecycleArtifacts(loadFixture("project-brief.json"));
  const malformedCoverage = structuredClone(auditReport);
  const coverageIndex = findEntryIndexBy(malformedCoverage.evaluationCoverage, "criterionId", "trustworthy_output");
  malformedCoverage.evaluationCoverage[coverageIndex].status = "missing";
  malformedCoverage.evaluationCoverage[coverageIndex].evidenceHooks = [
    "brief.successCriteria",
    "program.completionChecks",
    "program.contracts[].successCriteria"
  ];
  malformedCoverage.evaluationCoverage[coverageIndex].missingHooks = [];

  assert.throws(
    () => createAuditReport(malformedCoverage),
    /auditReport\.evaluationCoverage\[\d+\]\.status cannot be missing when canonical hooks are fully covered for criterion trustworthy_output/u
  );
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

test("audit flags contracts that omit scope paths", () => {
  const brief = loadFixture("project-brief.json");
  const { blueprint, executionProgram } = buildProjectLifecycleArtifacts(brief);
  const brokenProgram = structuredClone(executionProgram);
  brokenProgram.contracts[0].scopePaths = [];

  const auditReport = auditProject({
    blueprint,
    executionProgram: brokenProgram
  });

  assert.equal(auditReport.status, "attention_required");
  assert.ok(auditReport.findings.some((finding) => finding.id === "missing-scope-paths-bootstrap-package"));
  assert.ok(auditReport.findings.some((finding) => finding.summary.includes("does not declare any scope paths")));
});
