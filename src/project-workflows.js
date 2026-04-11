import { classifyRisk } from "./policies.js";
import {
  createAuditReport,
  createBootstrapContract,
  createExecutionProgram,
  createProjectBlueprint,
  createProposalSet,
  validateExecutionProgram,
  validateProjectBlueprint,
  validateProposalSet
} from "./project-contracts.js";

const SUPPORTED_PROJECT_TYPES = Object.freeze(["automation-package", "service", "application", "library"]);
const SUPPORTED_AUTONOMY_MODES = Object.freeze(["autonomous", "guarded"]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

function normalizeStringArray(value) {
  if (value === undefined) {
    return [];
  }

  assert(Array.isArray(value), "expected an array of strings");
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeEnumString(name, value, supportedValues) {
  const normalized = String(value).trim().toLowerCase();
  assert(normalized.length > 0, `${name} must be a non-empty string`);
  assert(
    supportedValues.includes(normalized),
    `${name} must be one of: ${supportedValues.join(", ")}`
  );
  return normalized;
}

function normalizeProjectType(value) {
  return normalizeEnumString("projectType", value, SUPPORTED_PROJECT_TYPES);
}

function normalizeAutonomyMode(value) {
  return normalizeEnumString("autonomyMode", value, SUPPORTED_AUTONOMY_MODES);
}

function inferProjectType(goal) {
  const normalizedGoal = goal.toLowerCase();

  if (normalizedGoal.includes("orchestrator") || normalizedGoal.includes("workflow") || normalizedGoal.includes("package")) {
    return "automation-package";
  }

  if (normalizedGoal.includes("api") || normalizedGoal.includes("service")) {
    return "service";
  }

  if (normalizedGoal.includes("web") || normalizedGoal.includes("app") || normalizedGoal.includes("site")) {
    return "application";
  }

  return "library";
}

function formatProjectLabel(projectType) {
  if (projectType === "automation-package") {
    return "automation package";
  }

  if (projectType === "service") {
    return "service";
  }

  if (projectType === "application") {
    return "application";
  }

  return "library";
}

function normalizeBrief(input) {
  assert(input && typeof input === "object", "project brief must be an object");
  assert(typeof input.goal === "string" && input.goal.trim().length > 0, "goal must be a non-empty string");

  const goal = input.goal.trim();
  const projectType = input.projectType === undefined || input.projectType === null
    ? normalizeProjectType(inferProjectType(goal))
    : normalizeProjectType(input.projectType);
  const projectName = input.projectName
    ? String(input.projectName).trim()
    : slugify(input.repositoryName ? String(input.repositoryName) : goal) || "project";

  return {
    goal,
    projectName,
    projectType,
    constraints: normalizeStringArray(input.constraints),
    nonGoals: normalizeStringArray(input.nonGoals),
    targetUsers: normalizeStringArray(input.targetUsers),
    stackPreferences: normalizeStringArray(input.stackPreferences),
    successCriteria: normalizeStringArray(input.successCriteria),
    autonomyMode: input.autonomyMode === undefined || input.autonomyMode === null
      ? "autonomous"
      : normalizeAutonomyMode(input.autonomyMode)
  };
}

function createBriefContext(brief) {
  return {
    autonomyMode: brief.autonomyMode,
    constraints: [...brief.constraints],
    nonGoals: [...brief.nonGoals],
    targetUsers: [...brief.targetUsers],
    successCriteria: [...brief.successCriteria],
    stackPreferences: [...brief.stackPreferences]
  };
}

function defaultAssumptions(brief) {
  const assumptions = [
    `The first release should optimize for bounded automation in a ${formatProjectLabel(brief.projectType)} shape.`,
    "Control-plane policy remains encoded in source rather than delegated to prompts.",
    "Each milestone should end with deterministic evidence before the next milestone begins."
  ];

  if (brief.stackPreferences.length === 0) {
    assumptions.push("The initial stack can follow the repository's existing JavaScript/Node.js conventions.");
  } else {
    assumptions.push(`Preferred stack signals: ${brief.stackPreferences.join(", ")}.`);
  }

  return assumptions;
}

function defaultOpenDecisions(brief) {
  const openDecisions = [];

  if (brief.targetUsers.length === 0) {
    openDecisions.push("Clarify the primary operator or user persona for the first release.");
  }

  if (brief.successCriteria.length === 0) {
    openDecisions.push("Define the concrete release or demo conditions that count as complete.");
  }

  if (brief.constraints.length === 0) {
    openDecisions.push("State any hard delivery, runtime, or repository constraints before autonomous execution.");
  }

  return openDecisions;
}

function brainstormAlternatives(brief) {
  const label = formatProjectLabel(brief.projectType);

  return [
    {
      id: "control-plane-first",
      title: "Control Plane First",
      summary: `Lock the contracts, policies, and orchestration spine of the ${label} before broad feature work.`,
      advantages: [
        "Keeps autonomy behavior explicit and reviewable.",
        "Makes model hierarchy and worker isolation a code-level decision.",
        "Reduces rework when execution workflows expand later."
      ],
      tradeoffs: [
        "Delays visible user-facing output until the backbone is in place.",
        "Requires stronger upfront discipline on artifact schemas."
      ],
      fitSignals: [
        "Best when reliability and unattended execution matter more than immediate surface area.",
        "Fits internal tools, harnesses, and orchestrators especially well."
      ],
      nextStep: "Freeze the planning artifacts and compile them into milestone contracts."
    },
    {
      id: "bootstrap-first",
      title: "Bootstrap First",
      summary: `Create the repo, toolchain, docs, and verification surface for the ${label} before deep architecture work.`,
      advantages: [
        "Produces an initial working repository layout quickly.",
        "Makes contribution and verification commands visible early."
      ],
      tradeoffs: [
        "Can front-load scaffolding that later needs architectural adjustment.",
        "May postpone hard decisions about ownership boundaries."
      ],
      fitSignals: [
        "Best when the project currently has no usable repo skeleton.",
        "Useful if CI, docs, or deployment scaffolding are urgent."
      ],
      nextStep: "Generate the bootstrap contract and define the first architectural checkpoint."
    },
    {
      id: "vertical-slice-first",
      title: "Vertical Slice First",
      summary: `Ship one end-to-end slice of the ${label}, then harden the underlying architecture around that evidence.`,
      advantages: [
        "Creates user-visible progress quickly.",
        "Exercises verification and review loops against a real slice."
      ],
      tradeoffs: [
        "Early slices may entrench local decisions before the core platform is stable.",
        "Requires tighter repair discipline to avoid scope drift."
      ],
      fitSignals: [
        "Best when requirements are still moving but a demo is needed soon.",
        "Useful when the team learns fastest from shipping one concrete path."
      ],
      nextStep: "Choose the first slice and pin its ownership boundaries before execution."
    }
  ];
}

function recommendedAlternativeId(brief) {
  if (brief.projectType === "automation-package") {
    return "control-plane-first";
  }

  if (brief.autonomyMode === "autonomous") {
    return "vertical-slice-first";
  }

  return "bootstrap-first";
}

function milestoneTrackFor(brief) {
  if (brief.projectType === "automation-package") {
    return [
      {
        id: "bootstrap",
        title: "Bootstrap The Package",
        summary: "Establish repo layout, package metadata, extension entrypoints, and baseline tests.",
        dependsOn: [],
        outputs: ["BootstrapContract", "initial repository layout", "baseline verification commands"]
      },
      {
        id: "contracts",
        title: "Freeze Lifecycle Contracts",
        summary: "Define proposal, blueprint, execution, and audit artifacts in code.",
        dependsOn: ["bootstrap"],
        outputs: ["ProposalSet", "ProjectBlueprint", "ExecutionProgram"]
      },
      {
        id: "execution",
        title: "Wire Autonomous Execution",
        summary: "Connect execution planning to a bounded runner and verification flow.",
        dependsOn: ["contracts"],
        outputs: ["local runner abstraction", "auto workflow", "repair loop policy"]
      },
      {
        id: "hardening",
        title: "Harden Evidence And Audit",
        summary: "Add regression fixtures, audit workflows, and evidence-centric reports.",
        dependsOn: ["execution"],
        outputs: ["AuditReport", "regression fixtures", "verification coverage"]
      }
    ];
  }

  return [
    {
      id: "bootstrap",
      title: "Bootstrap The Repository",
      summary: "Create repo conventions, docs, and baseline automation.",
      dependsOn: [],
      outputs: ["repository layout", "toolchain", "starter docs"]
    },
    {
      id: "architecture",
      title: "Freeze The Architecture",
      summary: "Pick the boundaries, data flow, and ownership model before broad implementation.",
      dependsOn: ["bootstrap"],
      outputs: ["ProjectBlueprint", "module boundaries", "quality gates"]
    },
    {
      id: "delivery",
      title: "Deliver The First Slice",
      summary: "Ship the first narrow vertical slice with deterministic verification.",
      dependsOn: ["architecture"],
      outputs: ["ExecutionProgram", "first user-visible slice", "verification evidence"]
    },
    {
      id: "hardening",
      title: "Harden And Audit",
      summary: "Run independent review and tighten any release blockers.",
      dependsOn: ["delivery"],
      outputs: ["AuditReport", "stabilization backlog", "release readiness notes"]
    }
  ];
}

function repositoryLayoutFor(projectType) {
  if (projectType === "automation-package") {
    return [
      { path: "package.json", purpose: "Package manifest and Pi package metadata." },
      { path: "README.md", purpose: "Human-facing package overview and usage notes." },
      { path: "src/", purpose: "Control-plane logic, orchestration, contracts, and Pi extension entrypoints." },
      { path: "skills/", purpose: "Leaf worker instructions only." },
      { path: "test/", purpose: "Deterministic regression suites and fixtures." },
      { path: "examples/", purpose: "Sample inputs and reference artifacts." },
      { path: "docs/", purpose: "Frozen design notes and execution references." }
    ];
  }

  if (projectType === "service") {
    return [
      { path: "package.json", purpose: "Service package manifest and scripts." },
      { path: "README.md", purpose: "Service overview and operations guide." },
      { path: "src/", purpose: "Application code and interfaces." },
      { path: "test/", purpose: "Tests and fixtures." },
      { path: "docs/", purpose: "Architecture and runbook docs." },
      { path: "scripts/", purpose: "Operational scripts and helpers." }
    ];
  }

  if (projectType === "application") {
    return [
      { path: "package.json", purpose: "Application package manifest and scripts." },
      { path: "README.md", purpose: "Overview and local development guide." },
      { path: "src/", purpose: "Application code, UI, and domain logic." },
      { path: "test/", purpose: "Tests and fixtures." },
      { path: "public/", purpose: "Static assets and public resources." },
      { path: "docs/", purpose: "Design and release docs." }
    ];
  }

  return [
    { path: "package.json", purpose: "Library package manifest and scripts." },
    { path: "README.md", purpose: "Overview and API guidance." },
    { path: "src/", purpose: "Library source code." },
    { path: "test/", purpose: "Tests and fixtures." },
    { path: "docs/", purpose: "Design and release notes." }
  ];
}

function modulesFor(projectType) {
  if (projectType === "automation-package") {
    return [
      {
        id: "control-plane",
        name: "Control Plane",
        purpose: "Owns planning, policy, orchestration, and integration decisions.",
        paths: [
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
          "src/build-session-store.js",
          "src/run-evidence.js",
          "src/run-store.js",
          "src/safe-clone.js",
          "src/schema.js"
        ],
        dependsOn: []
      },
      {
        id: "pi-adapter",
        name: "Pi Adapter",
        purpose: "Exposes the control plane through Pi commands and tools.",
        paths: [
          "src/operator-formatters.js",
          "src/operator-intake.js",
          "src/pi-adapter.js",
          "src/pi-extension.js",
          "src/pi-runtime-diagnostics.js"
        ],
        dependsOn: ["control-plane"]
      },
      {
        id: "worker-plane",
        name: "Worker Plane",
        purpose: "Hosts bounded worker runner abstractions and leaf skills.",
        paths: [
          "src/auto-backend-runner.js",
          "src/process-model-probe.js",
          "src/pi-spawn.js",
          "src/pi-worker-runner.js",
          "src/process-worker-backend.js",
          "src/spike-worker-backend.js",
          "src/worker-runner.js",
          "skills/"
        ],
        dependsOn: ["control-plane"]
      },
      {
        id: "verification-surface",
        name: "Verification Surface",
        purpose: "Contains regression fixtures, examples, and audit evidence.",
        paths: ["test/", "examples/", "docs/"],
        dependsOn: ["control-plane", "worker-plane"]
      }
    ];
  }

  return [
    {
      id: "application-core",
      name: "Application Core",
      purpose: "Owns the primary domain logic and interfaces.",
      paths: ["src/"],
      dependsOn: []
    },
    {
      id: "verification-surface",
      name: "Verification Surface",
      purpose: "Holds tests, fixtures, and release evidence.",
      paths: ["test/", "docs/"],
      dependsOn: ["application-core"]
    }
  ];
}

function executionProfileFor(brief) {
  return {
    autonomyMode: brief.autonomyMode,
    humanGatePolicy: brief.autonomyMode === "autonomous" ? "preapprove-high-risk-at-launch" : "interactive-high-risk-gate",
    verificationDepth: "targeted-by-default",
    maxRepairLoops: 1,
    maxParallelWorkers: 1
  };
}

function qualityGatesFor(projectType) {
  const gates = [
    "Every milestone ends with explicit evidence, not narrative claims.",
    "One writer owns each file at a time.",
    "Independent review and verification stay outside the implementer path."
  ];

  if (projectType === "automation-package") {
    gates.push("Control-plane policies stay in code and regression fixtures.");
  }

  gates.push("High-risk work must match the declared autonomy and human-gate policy.");
  return gates;
}

function contractTemplate({
  id,
  title,
  goal,
  summary,
  scopePaths,
  dependsOn = [],
  deliverables,
  riskGoal,
  brief
}) {
  const normalizedScopePaths = scopePaths.map(normalizePath);
  const risk = classifyRisk({
    goal: riskGoal ?? goal,
    allowedFiles: normalizedScopePaths
  });
  const acceptanceChecks = [
    "Outputs match the declared contract without widening scope.",
    "Any future writer handoff can infer ownership and next checks from the artifact alone.",
    "The contract exposes concrete verification steps instead of relying on prose."
  ];
  const stopConditions = [
    "Stop if the contract requires new scope paths that were not declared.",
    "Stop if ownership boundaries are ambiguous.",
    "Stop if verification cannot be expressed as concrete commands or artifact checks."
  ];

  if (brief.successCriteria.length > 0) {
    acceptanceChecks.push(`Success criteria to preserve: ${brief.successCriteria.join(" | ")}`);
  }

  if (brief.constraints.length > 0) {
    stopConditions.push(`Stop if implementation would violate these constraints: ${brief.constraints.join(" | ")}`);
  }

  if (brief.nonGoals.length > 0) {
    stopConditions.push(`Stop if work drifts into these non-goals: ${brief.nonGoals.join(" | ")}`);
  }

  return {
    id,
    title,
    goal,
    summary,
    scopePaths: normalizedScopePaths,
    dependsOn,
    deliverables,
    constraints: [...brief.constraints],
    nonGoals: [...brief.nonGoals],
    successCriteria: [...brief.successCriteria],
    risk,
    acceptanceChecks,
    verificationPlan: [
      "Review the changed files against the declared scope paths.",
      "Run the smallest targeted verification commands that exercise the contract outputs.",
      "Record any remaining uncertainty explicitly."
    ],
    stopConditions
  };
}

function contractsForBlueprint(blueprint) {
  if (blueprint.projectType === "automation-package") {
    return [
      contractTemplate({
        id: "bootstrap-package",
        title: "Bootstrap Package Skeleton",
        goal: "Establish the package layout, docs surface, and baseline validation harness.",
        summary: "Create the repo skeleton and baseline package metadata required for later workflows.",
        scopePaths: ["package.json", "README.md", "src/", "skills/", "test/", "examples/", "docs/"],
        brief: blueprint.brief,
        deliverables: ["package manifest", "repo layout", "baseline test harness"]
      }),
      contractTemplate({
        id: "freeze-lifecycle-contracts",
        title: "Freeze Lifecycle Contracts",
        goal: "Define the planning and audit artifacts in code so the orchestrator can reason in structured contracts.",
        summary: "Add proposal, blueprint, execution, and audit contracts plus deterministic planners.",
        scopePaths: ["src/project-contracts.js", "src/project-workflows.js", "README.md", "examples/"],
        dependsOn: ["bootstrap-package"],
        brief: blueprint.brief,
        deliverables: ["ProposalSet contract", "ProjectBlueprint contract", "ExecutionProgram contract", "AuditReport contract"]
      }),
      contractTemplate({
        id: "wire-execution-backend",
        title: "Wire Execution Backend",
        goal: "Connect autonomous execution to the structured planning artifacts with bounded worker dispatch.",
        summary: "Bridge lifecycle planning to the existing auto workflow and runner surface.",
        scopePaths: ["src/auto-workflow.js", "src/orchestrator.js", "src/worker-runner.js", "src/pi-extension.js"],
        dependsOn: ["freeze-lifecycle-contracts"],
        brief: blueprint.brief,
        deliverables: ["execution bridge", "runner interface", "thin Pi commands and tools"]
      }),
      contractTemplate({
        id: "harden-regressions-and-audit",
        title: "Harden Regressions And Audit",
        goal: "Capture deterministic fixtures, lifecycle tests, and independent audit coverage.",
        summary: "Expand the regression surface and audit planning before release-readiness work.",
        scopePaths: ["test/", "examples/", "README.md", "docs/"],
        dependsOn: ["wire-execution-backend"],
        brief: blueprint.brief,
        deliverables: ["regression fixtures", "audit workflow coverage", "updated docs"]
      }),
      contractTemplate({
        id: "package-readiness",
        title: "Package Readiness Review",
        goal: "Prepare the package for real Pi runtime validation and a first production-like task.",
        summary: "Document runtime assumptions, validate commands, and define the first live smoke test.",
        scopePaths: ["README.md", "docs/", "examples/"],
        dependsOn: ["harden-regressions-and-audit"],
        brief: blueprint.brief,
        deliverables: ["runtime validation checklist", "first live smoke test plan", "release notes"]
      })
    ];
  }

  return [
    contractTemplate({
      id: "bootstrap-repository",
      title: "Bootstrap Repository",
      goal: "Create the repository structure, docs, and baseline commands.",
      summary: "Create the minimum viable repository skeleton.",
      scopePaths: blueprint.repositoryLayout.map((entry) => entry.path),
      brief: blueprint.brief,
      deliverables: ["repo layout", "toolchain", "baseline docs"]
    }),
    contractTemplate({
      id: "freeze-architecture",
      title: "Freeze Architecture",
      goal: "Define boundaries, contracts, and verification gates before broad implementation.",
      summary: "Capture the architecture in code and docs.",
      scopePaths: ["src/", "docs/"],
      dependsOn: ["bootstrap-repository"],
      brief: blueprint.brief,
      deliverables: ["architecture docs", "module boundaries", "quality gates"]
    }),
    contractTemplate({
      id: "deliver-first-slice",
      title: "Deliver First Slice",
      goal: "Ship the first end-to-end project slice with deterministic evidence.",
      summary: "Implement the narrowest useful vertical slice.",
      scopePaths: ["src/", "test/", "docs/"],
      dependsOn: ["freeze-architecture"],
      brief: blueprint.brief,
      deliverables: ["first slice", "targeted tests", "evidence log"]
    }),
    contractTemplate({
      id: "harden-and-audit",
      title: "Harden And Audit",
      goal: "Run independent review, tighten blockers, and prepare for release.",
      summary: "Use independent audit before broad rollout.",
      scopePaths: ["src/", "test/", "docs/"],
      dependsOn: ["deliver-first-slice"],
      brief: blueprint.brief,
      deliverables: ["audit coverage", "stabilization backlog", "release notes"]
    })
  ];
}

function bootstrapCommandsFor(projectType) {
  if (projectType === "automation-package") {
    return [
      "npm install",
      "node --check src/pi-extension.js",
      "node --test --test-isolation=none"
    ];
  }

  return [
    "npm install",
    "npm test"
  ];
}

export function brainstormProject(input) {
  const brief = normalizeBrief(input);

  return createProposalSet({
    id: `proposal-set-${brief.projectName}`,
    goal: brief.goal,
    projectName: brief.projectName,
    projectType: brief.projectType,
    brief: createBriefContext(brief),
    assumptions: defaultAssumptions(brief),
    openDecisions: defaultOpenDecisions(brief),
    recommendedAlternativeId: recommendedAlternativeId(brief),
    alternatives: brainstormAlternatives(brief),
    milestoneTrack: milestoneTrackFor(brief)
  });
}

export function blueprintProject({ proposalSet, selectedAlternativeId, autonomyMode } = {}) {
  validateProposalSet(proposalSet);
  const alternativeId = selectedAlternativeId || proposalSet.recommendedAlternativeId;

  assert(
    proposalSet.alternatives.some((alternative) => alternative.id === alternativeId),
    `selectedAlternativeId must match one of: ${proposalSet.alternatives.map((alternative) => alternative.id).join(", ")}`
  );

  const brief = normalizeBrief({
    goal: proposalSet.goal,
    projectName: proposalSet.projectName,
    projectType: proposalSet.projectType,
    autonomyMode: autonomyMode ?? proposalSet.brief.autonomyMode,
    constraints: proposalSet.brief.constraints,
    nonGoals: proposalSet.brief.nonGoals,
    targetUsers: proposalSet.brief.targetUsers,
    stackPreferences: proposalSet.brief.stackPreferences,
    successCriteria: proposalSet.brief.successCriteria
  });

  return createProjectBlueprint({
    id: `blueprint-${brief.projectName}`,
    goal: proposalSet.goal,
    projectName: proposalSet.projectName,
    projectType: brief.projectType,
    selectedAlternativeId: alternativeId,
    summary: `Blueprint for a ${formatProjectLabel(brief.projectType)} following the ${alternativeId} path.`,
    brief: createBriefContext(brief),
    architectureDecisions: [
      "Keep control-plane policy in code rather than prompt text.",
      "Use structured artifacts to move from brainstorming into execution.",
      "Preserve isolated worker contexts with explicit ownership and bounded repair loops."
    ],
    repositoryLayout: repositoryLayoutFor(brief.projectType),
    modules: modulesFor(brief.projectType),
    qualityGates: qualityGatesFor(brief.projectType),
    executionProfile: executionProfileFor(brief)
  });
}

export function sliceProject({ blueprint } = {}) {
  validateProjectBlueprint(blueprint);
  const brief = blueprint.brief;

  return createExecutionProgram({
    id: `program-${blueprint.projectName}`,
    blueprintId: blueprint.id,
    goal: blueprint.goal,
    projectName: blueprint.projectName,
    executionMode: blueprint.executionProfile.autonomyMode,
    summary: `Execution program for ${blueprint.projectName} with milestone contracts that can later compile into bounded worker tasks.`,
    brief: createBriefContext(brief),
    contracts: contractsForBlueprint({
      ...blueprint,
      brief
    }),
    integrationPoints: [
      "Freeze the selected alternative before autonomous execution begins.",
      "Compile each contract into one or more bounded task packets with exclusive file ownership.",
      "Run audit after the final delivery contract and before any release action."
    ],
    completionChecks: [
      "Every contract has explicit verification steps and stop conditions.",
      "The bootstrap contract precedes all other work.",
      "The final contract leaves a clear path to runtime validation or release readiness."
    ]
  });
}

export function bootstrapProject({ blueprint } = {}) {
  validateProjectBlueprint(blueprint);
  const program = sliceProject({ blueprint });
  const bootstrapContract = program.contracts[0];

  return createBootstrapContract({
    id: bootstrapContract.id,
    title: bootstrapContract.title,
    goal: bootstrapContract.goal,
    summary: bootstrapContract.summary,
    brief: createBriefContext(blueprint.brief),
    scopePaths: bootstrapContract.scopePaths,
    deliverables: bootstrapContract.deliverables,
    commands: bootstrapCommandsFor(blueprint.projectType),
    acceptanceChecks: bootstrapContract.acceptanceChecks,
    stopConditions: bootstrapContract.stopConditions
  });
}

function findDependencyCycle(contracts, contractIdSet) {
  const contractIndex = new Map();
  for (const contract of contracts) {
    if (!contractIndex.has(contract.id)) {
      contractIndex.set(contract.id, contract);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(contractId) {
    if (visiting.has(contractId)) {
      const cycleStart = stack.indexOf(contractId);
      return stack.slice(cycleStart).concat(contractId);
    }

    if (visited.has(contractId)) {
      return null;
    }

    const contract = contractIndex.get(contractId);
    if (!contract) {
      return null;
    }

    visiting.add(contractId);
    stack.push(contractId);

    for (const dependencyId of contract.dependsOn) {
      if (!contractIdSet.has(dependencyId)) {
        continue;
      }

      const cycle = visit(dependencyId);
      if (cycle) {
        return cycle;
      }
    }

    stack.pop();
    visiting.delete(contractId);
    visited.add(contractId);
    return null;
  }

  for (const contract of contracts) {
    const cycle = visit(contract.id);
    if (cycle) {
      return cycle;
    }
  }

  return null;
}

export function auditProject({ blueprint, executionProgram } = {}) {
  validateProjectBlueprint(blueprint);
  const program = executionProgram ?? sliceProject({ blueprint });
  validateExecutionProgram(program);
  const findings = [];

  const blueprintMatchesProgram = program.blueprintId === blueprint.id &&
    program.projectName === blueprint.projectName &&
    program.goal === blueprint.goal;

  if (!blueprintMatchesProgram) {
    findings.push({
      id: "mismatched-blueprint-program",
      severity: "high",
      summary: "The supplied execution program does not belong to the supplied blueprint.",
      recommendation: "Audit only a program compiled from the same blueprint id, goal, and project name."
    });
  }

  if (!blueprint.repositoryLayout.some((entry) => entry.path === "test/")) {
    findings.push({
      id: "missing-test-surface",
      severity: "high",
      summary: "The blueprint does not reserve a deterministic test surface.",
      recommendation: "Add a dedicated test path before autonomous execution."
    });
  }

  const bootstrapIndex = program.contracts.findIndex((contract) => contract.id.includes("bootstrap"));
  if (bootstrapIndex === -1 || bootstrapIndex !== 0) {
    findings.push({
      id: "bootstrap-not-first",
      severity: "medium",
      summary: "The execution program does not begin with a bootstrap milestone.",
      recommendation: "Insert an explicit bootstrap contract before architecture or feature work."
    });
  }

  const contractIdCounts = new Map();
  for (const contract of program.contracts) {
    contractIdCounts.set(contract.id, (contractIdCounts.get(contract.id) ?? 0) + 1);
  }

  const contractIds = new Set(contractIdCounts.keys());
  const duplicateContractIds = [...contractIdCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([contractId]) => contractId);

  for (const duplicateContractId of duplicateContractIds) {
    findings.push({
      id: `duplicate-contract-id-${duplicateContractId}`,
      severity: "high",
      summary: `Execution program contains duplicate contract id: ${duplicateContractId}.`,
      recommendation: "Ensure every contract id is unique so dependency resolution is deterministic."
    });
  }

  for (const contract of program.contracts) {
    const missingDependencies = contract.dependsOn.filter((dependencyId) => !contractIds.has(dependencyId));
    if (missingDependencies.length > 0) {
      findings.push({
        id: `missing-dependency-${contract.id}`,
        severity: "high",
        summary: `Contract ${contract.id} depends on undefined milestone ids: ${missingDependencies.join(", ")}.`,
        recommendation: "Ensure every dependsOn entry references a real contract id in the execution program."
      });
    }
  }

  const dependencyCycle = findDependencyCycle(program.contracts, contractIds);
  if (dependencyCycle) {
    findings.push({
      id: "dependency-cycle-detected",
      severity: "high",
      summary: `Execution program contains a dependency cycle: ${dependencyCycle.join(" -> ")}.`,
      recommendation: "Remove circular dependsOn references so milestone contracts form an acyclic graph."
    });
  }

  if (blueprint.executionProfile.autonomyMode === "autonomous" &&
    blueprint.executionProfile.humanGatePolicy === "interactive-high-risk-gate") {
    findings.push({
      id: "interactive-gate-conflict",
      severity: "high",
      summary: "Autonomous execution conflicts with an interactive high-risk gate policy.",
      recommendation: "Preapprove high-risk classes at launch time or switch the profile out of autonomous mode."
    });
  }

  if (program.contracts.some((contract) => contract.verificationPlan.length === 0)) {
    findings.push({
      id: "missing-verification-steps",
      severity: "high",
      summary: "One or more contracts are missing explicit verification steps.",
      recommendation: "Require a concrete verification plan on every contract before execution."
    });
  }

  const status = findings.length === 0 ? "pass" : "attention_required";

  return createAuditReport({
    id: `audit-${blueprint.projectName}`,
    status,
    summary: status === "pass"
      ? "The lifecycle scaffolding is internally consistent and ready for bounded execution planning."
      : "The lifecycle scaffolding has issues that should be fixed before autonomous execution.",
    brief: createBriefContext(blueprint.brief),
    strengths: [
      "The blueprint encodes execution policy explicitly.",
      "The execution program uses milestone contracts rather than free-form prompts.",
      "Verification expectations are attached to each contract."
    ],
    findings,
    recommendedNextContracts: status === "pass"
      ? program.contracts.slice(0, 2).map((contract) => contract.id)
      : findings.map((finding) => finding.id),
    evidence: [
      `Repository layout includes ${blueprint.repositoryLayout.length} planned paths.`,
      `Execution program contains ${program.contracts.length} milestone contracts.`,
      `Execution mode is ${blueprint.executionProfile.autonomyMode} with ${blueprint.executionProfile.humanGatePolicy}.`
    ]
  });
}

export function buildProjectLifecycleArtifacts(input, options = {}) {
  const proposalSet = brainstormProject(input);
  const blueprint = blueprintProject({
    proposalSet,
    selectedAlternativeId: options.selectedAlternativeId,
    autonomyMode: input?.autonomyMode
  });
  const executionProgram = sliceProject({ blueprint });
  const bootstrapContract = bootstrapProject({ blueprint });
  const auditReport = auditProject({ blueprint, executionProgram });

  return {
    proposalSet,
    blueprint,
    executionProgram,
    bootstrapContract,
    auditReport
  };
}
