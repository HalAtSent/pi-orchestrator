import { formatWorkflowExecution, runAutoWorkflow } from "./auto-workflow.js";
import { validateWorkerResult } from "./contracts.js";
import { createInitialWorkflow } from "./orchestrator.js";
import { createProgramContractExecutor } from "./program-contract-executor.js";
import { formatProgramRunJournal, runExecutionProgram } from "./program-runner.js";
import {
  brainstormProject,
  buildProjectLifecycleArtifacts
} from "./project-workflows.js";
import { Type } from "./schema.js";
import { createLocalWorkerRunner } from "./worker-runner.js";

const projectBriefSchema = Type.Object({
  goal: Type.String({ description: "The project or package goal." }),
  projectName: Type.Optional(Type.String({ description: "Optional explicit project name." })),
  projectType: Type.Optional(Type.String({ description: "Optional project type override." })),
  constraints: Type.Array(Type.String(), {
    description: "Hard constraints that should shape the project plan.",
    default: []
  }),
  nonGoals: Type.Array(Type.String(), {
    description: "Things the project should explicitly avoid.",
    default: []
  }),
  targetUsers: Type.Array(Type.String(), {
    description: "Primary operators or users for the first release.",
    default: []
  }),
  stackPreferences: Type.Array(Type.String(), {
    description: "Stack preferences to carry into planning.",
    default: []
  }),
  successCriteria: Type.Array(Type.String(), {
    description: "Concrete completion criteria for the first release.",
    default: []
  }),
  autonomyMode: Type.String({
    description: "Execution mode, usually autonomous or guarded.",
    default: "autonomous"
  })
});

const projectCompilationSchema = Type.Object({
  goal: Type.String({ description: "The project or package goal." }),
  projectName: Type.Optional(Type.String({ description: "Optional explicit project name." })),
  projectType: Type.Optional(Type.String({ description: "Optional project type override." })),
  constraints: Type.Array(Type.String(), { default: [] }),
  nonGoals: Type.Array(Type.String(), { default: [] }),
  targetUsers: Type.Array(Type.String(), { default: [] }),
  stackPreferences: Type.Array(Type.String(), { default: [] }),
  successCriteria: Type.Array(Type.String(), { default: [] }),
  autonomyMode: Type.String({ default: "autonomous" }),
  selectedAlternativeId: Type.Optional(Type.String({
    description: "Optional alternative id from brainstorm output."
  }))
});

const runExecutionProgramSchema = Type.Object({
  program: Type.Object({}, {
    description: "ExecutionProgram artifact to execute contract-by-contract.",
    additionalProperties: true
  })
});

function formatWorkflow(workflow) {
  const packetLines = workflow.packets.map((packet) => {
    const scope = packet.allowedFiles.length === 0 ? "(no file scope provided)" : packet.allowedFiles.join(", ");
    return `- ${packet.role}: ${scope}`;
  });

  return [
    `workflow: ${workflow.workflowId}`,
    `risk: ${workflow.risk}`,
    `human_gate: ${workflow.humanGate ? "required" : "not-required"}`,
    "roles:",
    ...packetLines
  ].join("\n");
}

function formatProposalSet(proposalSet) {
  return [
    `proposal_set: ${proposalSet.id}`,
    `project: ${proposalSet.projectName}`,
    `type: ${proposalSet.projectType}`,
    `recommended: ${proposalSet.recommendedAlternativeId}`,
    "alternatives:",
    ...proposalSet.alternatives.map((alternative) => `- ${alternative.id}: ${alternative.summary}`)
  ].join("\n");
}

function formatBlueprint(blueprint) {
  return [
    `blueprint: ${blueprint.id}`,
    `selected_path: ${blueprint.selectedAlternativeId}`,
    `mode: ${blueprint.executionProfile.autonomyMode}`,
    `human_gate_policy: ${blueprint.executionProfile.humanGatePolicy}`,
    "modules:",
    ...blueprint.modules.map((module) => `- ${module.id}: ${module.paths.join(", ")}`)
  ].join("\n");
}

function formatExecutionProgram(program) {
  return [
    `execution_program: ${program.id}`,
    `mode: ${program.executionMode}`,
    "contracts:",
    ...program.contracts.map((contract) => `- ${contract.id} (${contract.risk}): ${contract.summary}`)
  ].join("\n");
}

function formatBootstrapContract(contract) {
  return [
    `bootstrap_contract: ${contract.id}`,
    `goal: ${contract.goal}`,
    "scope:",
    ...contract.scopePaths.map((path) => `- ${path}`),
    "commands:",
    ...contract.commands.map((command) => `- ${command}`)
  ].join("\n");
}

function formatAuditReport(report) {
  const findings = report.findings.length === 0
    ? ["- none"]
    : report.findings.map((finding) => `- ${finding.id} (${finding.severity}): ${finding.summary}`);

  return [
    `audit: ${report.id}`,
    `status: ${report.status}`,
    `summary: ${report.summary}`,
    "findings:",
    ...findings
  ].join("\n");
}

function normalizeStringArray(value) {
  if (value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  return [String(value)];
}

function parseJsonArgs(args) {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args;
  }

  if (typeof args === "string") {
    const raw = args.trim();
    return raw.startsWith("{") ? JSON.parse(raw) : { goal: raw };
  }

  if (Array.isArray(args)) {
    const raw = args.join(" ").trim();
    return raw.startsWith("{") ? JSON.parse(raw) : { goal: raw };
  }

  throw new Error("Provide a goal string or a JSON object.");
}

function parseProjectBriefArgs(args) {
  const parsed = parseJsonArgs(args);

  return {
    goal: String(parsed.goal ?? "").trim(),
    projectName: parsed.projectName ? String(parsed.projectName).trim() : undefined,
    projectType: parsed.projectType ? String(parsed.projectType).trim() : undefined,
    constraints: normalizeStringArray(parsed.constraints),
    nonGoals: normalizeStringArray(parsed.nonGoals),
    targetUsers: normalizeStringArray(parsed.targetUsers),
    stackPreferences: normalizeStringArray(parsed.stackPreferences),
    successCriteria: normalizeStringArray(parsed.successCriteria),
    autonomyMode: parsed.autonomyMode ? String(parsed.autonomyMode).trim() : "autonomous",
    selectedAlternativeId: parsed.selectedAlternativeId ? String(parsed.selectedAlternativeId).trim() : undefined
  };
}

function parseAutoArgs(args) {
  const parsed = parseJsonArgs(args);

  return {
    goal: String(parsed.goal ?? "").trim(),
    allowedFiles: normalizeStringArray(parsed.allowedFiles),
    forbiddenFiles: normalizeStringArray(parsed.forbiddenFiles),
    contextFiles: normalizeStringArray(parsed.contextFiles),
    approvedHighRisk: Boolean(parsed.approvedHighRisk),
    maxRepairLoops: parsed.maxRepairLoops ?? 1
  };
}

function parseRunProgramArgs(args) {
  const parsed = parseJsonArgs(args);

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (parsed.program && typeof parsed.program === "object" && !Array.isArray(parsed.program)) {
      return {
        program: parsed.program
      };
    }

    if (Array.isArray(parsed.contracts)) {
      return {
        program: parsed
      };
    }
  }

  throw new Error("Provide an ExecutionProgram JSON object or {\"program\": { ... }}.");
}

function buildLifecycleFromParams(params) {
  return buildProjectLifecycleArtifacts(params, {
    selectedAlternativeId: params.selectedAlternativeId
  });
}

export function createPiExtension({
  workerRunner = createLocalWorkerRunner(),
  contractExecutor
} = {}) {
  const resolvedContractExecutor = contractExecutor ?? createProgramContractExecutor({
    runner: workerRunner
  });

  return function registerPiExtension(pi) {
    pi.registerCommand("workflow-status", {
      description: "Show whether the orchestration package is loaded.",
      handler: async (_args, ctx) => {
        ctx.ui.notify("pi-orchestrator-workflow loaded", "info");
        ctx.ui.setStatus("workflow", "orchestrator package ready");
      }
    });

    pi.registerCommand("brainstorm", {
      description: "Generate structured alternatives and milestone tracks for a project goal.",
      handler: async (args, ctx) => {
        const proposalSet = brainstormProject(parseProjectBriefArgs(args));
        ctx.ui.notify(`brainstorm ready: ${proposalSet.recommendedAlternativeId}`, "info");
        ctx.ui.setStatus("workflow", `brainstorm: ${proposalSet.id}`);
        return proposalSet;
      }
    });

    pi.registerCommand("blueprint", {
      description: "Freeze a project blueprint from a brief or selected brainstorm path.",
      handler: async (args, ctx) => {
        const lifecycle = buildLifecycleFromParams(parseProjectBriefArgs(args));
        ctx.ui.notify(`blueprint ready: ${lifecycle.blueprint.selectedAlternativeId}`, "info");
        ctx.ui.setStatus("workflow", `blueprint: ${lifecycle.blueprint.id}`);
        return lifecycle.blueprint;
      }
    });

    pi.registerCommand("slice", {
      description: "Compile a project brief into milestone execution contracts.",
      handler: async (args, ctx) => {
        const lifecycle = buildLifecycleFromParams(parseProjectBriefArgs(args));
        ctx.ui.notify(`execution program ready: ${lifecycle.executionProgram.contracts.length} contracts`, "info");
        ctx.ui.setStatus("workflow", `slice: ${lifecycle.executionProgram.id}`);
        return lifecycle.executionProgram;
      }
    });

    pi.registerCommand("bootstrap", {
      description: "Produce the first bootstrap contract for a project brief.",
      handler: async (args, ctx) => {
        const lifecycle = buildLifecycleFromParams(parseProjectBriefArgs(args));
        ctx.ui.notify(`bootstrap contract ready: ${lifecycle.bootstrapContract.id}`, "info");
        ctx.ui.setStatus("workflow", `bootstrap: ${lifecycle.bootstrapContract.id}`);
        return lifecycle.bootstrapContract;
      }
    });

    pi.registerCommand("audit", {
      description: "Audit the lifecycle scaffolding for a project brief.",
      handler: async (args, ctx) => {
        const lifecycle = buildLifecycleFromParams(parseProjectBriefArgs(args));
        ctx.ui.notify(`audit ${lifecycle.auditReport.status}`, lifecycle.auditReport.status === "pass" ? "info" : "warning");
        ctx.ui.setStatus("workflow", `audit: ${lifecycle.auditReport.id}`);
        return lifecycle.auditReport;
      }
    });

    pi.registerCommand("auto", {
      description: "Plan and execute a bounded workflow with the configured local worker runner.",
      handler: async (args, ctx) => {
        const execution = await runAutoWorkflow(parseAutoArgs(args), {
          runner: workerRunner
        });

        ctx.ui.notify(`auto workflow ${execution.status}`, execution.status === "success" ? "info" : "warning");
        ctx.ui.setStatus("workflow", `${execution.status}: ${execution.workflow.workflowId}`);

        return execution;
      }
    });

    pi.registerCommand("run-program", {
      description: "Execute an ExecutionProgram contract-by-contract with a configured contract executor.",
      handler: async (args, ctx) => {
        const { program } = parseRunProgramArgs(args);
        const runJournal = await runExecutionProgram(program, {
          contractExecutor: resolvedContractExecutor
        });

        ctx.ui.notify(`execution program ${runJournal.status}`, runJournal.status === "success" ? "info" : "warning");
        ctx.ui.setStatus("workflow", `${runJournal.status}: ${runJournal.programId}`);

        return runJournal;
      }
    });

    pi.registerTool({
      name: "plan_workflow",
      label: "Plan Workflow",
      description: "Turn a coding request into a bounded execution plan with worker packets.",
      parameters: Type.Object({
        goal: Type.String({ description: "The coding task to orchestrate." }),
        allowedFiles: Type.Array(Type.String(), {
          description: "The file scope workers may touch.",
          default: []
        }),
        forbiddenFiles: Type.Array(Type.String(), {
          description: "Files or directories workers must not touch.",
          default: []
        }),
        contextFiles: Type.Array(Type.String(), {
          description: "Files that provide extra context without widening write scope.",
          default: []
        })
      }),
      async execute(_toolCallId, params) {
        const workflow = createInitialWorkflow(params);
        return {
          content: [{ type: "text", text: formatWorkflow(workflow) }],
          details: workflow
        };
      }
    });

    pi.registerTool({
      name: "brainstorm_project",
      label: "Brainstorm Project",
      description: "Generate structured alternatives and milestone tracks for a project brief.",
      parameters: projectBriefSchema,
      async execute(_toolCallId, params) {
        const proposalSet = brainstormProject(params);
        return {
          content: [{ type: "text", text: formatProposalSet(proposalSet) }],
          details: proposalSet
        };
      }
    });

    pi.registerTool({
      name: "blueprint_project",
      label: "Blueprint Project",
      description: "Compile a project brief into a frozen project blueprint.",
      parameters: projectCompilationSchema,
      async execute(_toolCallId, params) {
        const lifecycle = buildLifecycleFromParams(params);
        return {
          content: [{ type: "text", text: formatBlueprint(lifecycle.blueprint) }],
          details: {
            proposalSet: lifecycle.proposalSet,
            blueprint: lifecycle.blueprint
          }
        };
      }
    });

    pi.registerTool({
      name: "slice_project",
      label: "Slice Project",
      description: "Compile a project brief into milestone execution contracts.",
      parameters: projectCompilationSchema,
      async execute(_toolCallId, params) {
        const lifecycle = buildLifecycleFromParams(params);
        return {
          content: [{ type: "text", text: formatExecutionProgram(lifecycle.executionProgram) }],
          details: {
            proposalSet: lifecycle.proposalSet,
            blueprint: lifecycle.blueprint,
            executionProgram: lifecycle.executionProgram
          }
        };
      }
    });

    pi.registerTool({
      name: "bootstrap_project",
      label: "Bootstrap Project",
      description: "Produce the first bootstrap contract for a project brief.",
      parameters: projectCompilationSchema,
      async execute(_toolCallId, params) {
        const lifecycle = buildLifecycleFromParams(params);
        return {
          content: [{ type: "text", text: formatBootstrapContract(lifecycle.bootstrapContract) }],
          details: {
            proposalSet: lifecycle.proposalSet,
            blueprint: lifecycle.blueprint,
            bootstrapContract: lifecycle.bootstrapContract
          }
        };
      }
    });

    pi.registerTool({
      name: "audit_project",
      label: "Audit Project",
      description: "Audit the lifecycle scaffolding for a project brief.",
      parameters: projectCompilationSchema,
      async execute(_toolCallId, params) {
        const lifecycle = buildLifecycleFromParams(params);
        return {
          content: [{ type: "text", text: formatAuditReport(lifecycle.auditReport) }],
          details: {
            proposalSet: lifecycle.proposalSet,
            blueprint: lifecycle.blueprint,
            executionProgram: lifecycle.executionProgram,
            auditReport: lifecycle.auditReport
          }
        };
      }
    });

    pi.registerTool({
      name: "run_auto_workflow",
      label: "Run Auto Workflow",
      description: "Plan and execute a bounded workflow with the configured local worker runner.",
      parameters: Type.Object({
        goal: Type.String({ description: "The coding task to orchestrate and execute." }),
        allowedFiles: Type.Array(Type.String(), {
          description: "The file scope workers may touch.",
          default: []
        }),
        forbiddenFiles: Type.Array(Type.String(), {
          description: "Files or directories workers must not touch.",
          default: []
        }),
        contextFiles: Type.Array(Type.String(), {
          description: "Files that provide extra context without widening write scope.",
          default: []
        }),
        approvedHighRisk: Type.Boolean({
          description: "Whether a human explicitly approved high-risk execution.",
          default: false
        }),
        maxRepairLoops: Type.Integer({
          description: "Maximum number of implementer/reviewer repair loops.",
          default: 1,
          minimum: 0
        })
      }),
      async execute(_toolCallId, params) {
        const execution = await runAutoWorkflow(params, {
          runner: workerRunner
        });

        return {
          content: [{ type: "text", text: formatWorkflowExecution(execution) }],
          details: execution
        };
      }
    });

    pi.registerTool({
      name: "run_execution_program",
      label: "Run Execution Program",
      description: "Execute an ExecutionProgram sequentially with dependency-aware contract gating.",
      parameters: runExecutionProgramSchema,
      async execute(_toolCallId, params) {
        const runJournal = await runExecutionProgram(params.program, {
          contractExecutor: resolvedContractExecutor
        });

        return {
          content: [{ type: "text", text: formatProgramRunJournal(runJournal) }],
          details: runJournal
        };
      }
    });

    pi.registerTool({
      name: "validate_worker_result",
      label: "Validate Worker Result",
      description: "Validate a worker result payload against the expected contract.",
      parameters: Type.Object({
        status: Type.String(),
        summary: Type.String(),
        changedFiles: Type.Array(Type.String()),
        commandsRun: Type.Array(Type.String()),
        evidence: Type.Array(Type.String()),
        openQuestions: Type.Array(Type.String())
      }),
      async execute(_toolCallId, params) {
        validateWorkerResult(params);
        return {
          content: [{ type: "text", text: "worker result is valid" }],
          details: { valid: true }
        };
      }
    });
  };
}

export default createPiExtension();
