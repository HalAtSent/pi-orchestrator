import {
  formatWorkflowExecution,
  runAutoWorkflow,
  summarizeWorkflowLaunchSelection
} from "./auto-workflow.js";
import {
  AUTO_BACKEND_MODES,
  createAutoBackendRunner
} from "./auto-backend-runner.js";
import { parseBooleanFlag } from "./boolean-flags.js";
import { validateWorkerResult } from "./contracts.js";
import { createInitialWorkflow } from "./orchestrator.js";
import {
  createPiAdapter,
  PI_ADAPTER_DEFAULT_SUPPORTED_ROLES
} from "./pi-adapter.js";
import {
  formatPiWorkerRuntimeStatus,
  inspectPiWorkerRuntime
} from "./pi-runtime-diagnostics.js";
import { createProgramContractExecutor } from "./program-contract-executor.js";
import { createPiWorkerRunner } from "./pi-worker-runner.js";
import {
  formatProgramRunJournal,
  resumeExecutionProgram,
  runExecutionProgram
} from "./program-runner.js";
import {
  brainstormProject,
  buildProjectLifecycleArtifacts
} from "./project-workflows.js";
import { createRunStore } from "./run-store.js";
import { Type } from "./schema.js";

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
  }),
  approvedHighRisk: Type.Boolean({
    description: "Whether a human explicitly approved high-risk contract execution.",
    default: false
  })
});

const resumeExecutionProgramSchema = Type.Object({
  programId: Type.String({
    description: "ExecutionProgram id to resume from local persisted run state."
  }),
  approvedHighRisk: Type.Boolean({
    description: "Whether a human explicitly approved high-risk contract execution.",
    default: false
  })
});

const inspectWorkerRuntimeSchema = Type.Object({});

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
    approvedHighRisk: parseBooleanFlag(parsed.approvedHighRisk, {
      flagName: "approvedHighRisk",
      defaultValue: false
    }),
    maxRepairLoops: parsed.maxRepairLoops ?? 1
  };
}

function coerceGoal(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "(invalid auto workflow input)";
}

function coerceRepairBudget(value) {
  return Number.isInteger(value) && value >= 0 ? value : 1;
}

function createBlockedAutoExecution({ goal, maxRepairLoops, stopReason }) {
  return {
    workflow: {
      workflowId: "workflow-invalid-auto-input",
      goal: coerceGoal(goal),
      risk: "low",
      humanGate: false,
      roleSequence: [],
      packets: []
    },
    status: "blocked",
    stopReason,
    repairCount: 0,
    maxRepairLoops: coerceRepairBudget(maxRepairLoops),
    runs: []
  };
}

function appendLaunchSelectionSummary(baseText, execution) {
  const launchSelectionSummary = summarizeWorkflowLaunchSelection(execution);
  return launchSelectionSummary
    ? `${baseText} (${launchSelectionSummary})`
    : baseText;
}

function summarizeAutoCommandResult(execution) {
  return appendLaunchSelectionSummary(execution.workflow.workflowId, execution);
}

function parseRunProgramArgs(args) {
  const parsed = parseJsonArgs(args);
  const approvedHighRisk = parseBooleanFlag(parsed.approvedHighRisk, {
    flagName: "approvedHighRisk",
    defaultValue: false
  });

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (parsed.program && typeof parsed.program === "object" && !Array.isArray(parsed.program)) {
      return {
        program: parsed.program,
        approvedHighRisk
      };
    }

    if (Array.isArray(parsed.contracts)) {
      return {
        program: parsed,
        approvedHighRisk
      };
    }
  }

  throw new Error("Provide an ExecutionProgram JSON object or {\"program\": { ... }}.");
}

function parseResumeProgramArgs(args) {
  if (typeof args === "string") {
    const raw = args.trim();
    if (raw.length === 0) {
      throw new Error("Provide a program id string or a JSON object with programId.");
    }

    if (raw.startsWith("{")) {
      return parseResumeProgramArgs(JSON.parse(raw));
    }

    return {
      programId: raw,
      approvedHighRisk: false
    };
  }

  if (Array.isArray(args)) {
    return parseResumeProgramArgs(args.join(" "));
  }

  if (args && typeof args === "object" && !Array.isArray(args)) {
    if (typeof args.programId === "string" && args.programId.trim().length > 0) {
      return {
        programId: args.programId.trim(),
        approvedHighRisk: parseBooleanFlag(args.approvedHighRisk, {
          flagName: "approvedHighRisk",
          defaultValue: false
        })
      };
    }
  }

  throw new Error("Provide a program id string or {\"programId\": \"...\"}.");
}

function buildLifecycleFromParams(params) {
  return buildProjectLifecycleArtifacts(params, {
    selectedAlternativeId: params.selectedAlternativeId
  });
}

function resolveContractExecutorInvoker(contractExecutor) {
  if (typeof contractExecutor === "function") {
    return contractExecutor;
  }

  if (contractExecutor && typeof contractExecutor.runContract === "function") {
    return contractExecutor.runContract.bind(contractExecutor);
  }

  if (contractExecutor && typeof contractExecutor.run === "function") {
    return contractExecutor.run.bind(contractExecutor);
  }

  throw new Error("contractExecutor(contract, context) is required");
}

export function createPiExtension({
  workerRunner = null,
  contractExecutor,
  runStore = null,
  workerAdapter,
  processWorkerBackend = null,
  autoBackendMode = AUTO_BACKEND_MODES.PI_RUNTIME,
  adapterSupportedRoles = PI_ADAPTER_DEFAULT_SUPPORTED_ROLES,
  adapterFactory = createPiAdapter,
  workerRunnerFactory = createPiWorkerRunner,
  autoRunnerFactory = createAutoBackendRunner
} = {}) {
  return function registerPiExtension(pi) {
    const resolvedWorkerAdapter = workerAdapter ?? adapterFactory({
      host: pi,
      supportedRoles: adapterSupportedRoles
    });
    const resolvedWorkerRunner = workerRunner ?? workerRunnerFactory({
      adapter: resolvedWorkerAdapter
    });
    const resolvedAutoRunner = autoRunnerFactory({
      defaultRunner: resolvedWorkerRunner,
      processBackend: processWorkerBackend,
      mode: autoBackendMode
    });
    const configuredContractExecutor = contractExecutor
      ? resolveContractExecutorInvoker(contractExecutor)
      : null;
    const createExecutionProgramExecutor = ({ approvedHighRisk = false } = {}) => {
      const resolvedApproval = parseBooleanFlag(approvedHighRisk, {
        flagName: "approvedHighRisk",
        defaultValue: false
      });

      if (configuredContractExecutor) {
        return async (contract, context = {}) => configuredContractExecutor(contract, {
          ...(context && typeof context === "object" && !Array.isArray(context) ? context : {}),
          approvedHighRisk: resolvedApproval
        });
      }

      return createProgramContractExecutor({
        runner: resolvedAutoRunner,
        approvedHighRisk: resolvedApproval
      });
    };

    pi.registerCommand("workflow-status", {
      description: "Show whether the orchestration package is loaded.",
      handler: async (_args, ctx) => {
        ctx.ui.notify("pi-orchestrator-workflow loaded", "info");
        ctx.ui.setStatus("workflow", "orchestrator package ready");
      }
    });

    pi.registerCommand("worker-runtime-status", {
      description: "Inspect whether the live Pi host exposes bounded worker execution.",
      handler: async (_args, ctx) => {
        const status = inspectPiWorkerRuntime({
          host: pi,
          supportedRoles: adapterSupportedRoles
        });
        const summary = status.selectedInvoker === "none"
          ? "worker runtime unavailable (no runWorker surface)"
          : `worker runtime ready (${status.selectedInvoker})`;

        ctx.ui.notify(summary, status.selectedInvoker === "none" ? "warning" : "info");
        ctx.ui.setStatus("workflow", summary);

        return {
          text: formatPiWorkerRuntimeStatus(status),
          details: status
        };
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
      description: "Plan and execute a bounded workflow with the configured worker runner.",
      handler: async (args, ctx) => {
        const input = parseAutoArgs(args);
        if (input.allowedFiles.length === 0) {
          const execution = createBlockedAutoExecution({
            goal: input.goal,
            maxRepairLoops: input.maxRepairLoops,
            stopReason: "allowedFiles must contain at least one file path for /auto workflows"
          });
          ctx.ui.notify(`auto workflow ${execution.status}: ${execution.stopReason}`, "warning");
          ctx.ui.setStatus("workflow", `${execution.status}: ${execution.workflow.workflowId}`);
          return {
            ...execution,
            summary: summarizeAutoCommandResult(execution),
            text: formatWorkflowExecution(execution),
            details: execution
          };
        }

        const execution = await runAutoWorkflow(input, {
          runner: resolvedAutoRunner
        });

        const notification = execution.status === "success"
          ? appendLaunchSelectionSummary("auto workflow success", execution)
          : `auto workflow ${execution.status}: ${execution.stopReason ?? "no stop reason reported"}`;

        ctx.ui.notify(notification, execution.status === "success" ? "info" : "warning");
        ctx.ui.setStatus(
          "workflow",
          appendLaunchSelectionSummary(`${execution.status}: ${execution.workflow.workflowId}`, execution)
        );

        return {
          ...execution,
          summary: summarizeAutoCommandResult(execution),
          text: formatWorkflowExecution(execution),
          details: execution
        };
      }
    });

    pi.registerCommand("run-program", {
      description: "Execute an ExecutionProgram contract-by-contract with a configured contract executor.",
      handler: async (args, ctx) => {
        const { program, approvedHighRisk } = parseRunProgramArgs(args);
        const runJournal = await runExecutionProgram(program, {
          contractExecutor: createExecutionProgramExecutor({ approvedHighRisk }),
          runStore
        });

        ctx.ui.notify(`execution program ${runJournal.status}`, runJournal.status === "success" ? "info" : "warning");
        ctx.ui.setStatus("workflow", `${runJournal.status}: ${runJournal.programId}`);

        return {
          ...runJournal,
          text: formatProgramRunJournal(runJournal),
          details: runJournal
        };
      }
    });

    pi.registerCommand("resume-program", {
      description: "Resume a persisted ExecutionProgram run from local run-state snapshots.",
      handler: async (args, ctx) => {
        const { programId, approvedHighRisk } = parseResumeProgramArgs(args);
        const runJournal = await resumeExecutionProgram(programId, {
          contractExecutor: createExecutionProgramExecutor({ approvedHighRisk }),
          runStore
        });

        ctx.ui.notify(`execution program ${runJournal.status}`, runJournal.status === "success" ? "info" : "warning");
        ctx.ui.setStatus("workflow", `${runJournal.status}: ${runJournal.programId}`);

        return {
          ...runJournal,
          text: formatProgramRunJournal(runJournal),
          details: runJournal
        };
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
      description: "Plan and execute a bounded workflow with the configured worker runner.",
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
          runner: resolvedAutoRunner
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
          contractExecutor: createExecutionProgramExecutor({
            approvedHighRisk: parseBooleanFlag(params.approvedHighRisk, {
              flagName: "approvedHighRisk",
              defaultValue: false
            })
          }),
          runStore
        });

        return {
          content: [{ type: "text", text: formatProgramRunJournal(runJournal) }],
          details: runJournal
        };
      }
    });

    pi.registerTool({
      name: "resume_execution_program",
      label: "Resume Execution Program",
      description: "Resume a persisted ExecutionProgram run from local run-state snapshots.",
      parameters: resumeExecutionProgramSchema,
      async execute(_toolCallId, params) {
        const runJournal = await resumeExecutionProgram(params.programId, {
          contractExecutor: createExecutionProgramExecutor({
            approvedHighRisk: parseBooleanFlag(params.approvedHighRisk, {
              flagName: "approvedHighRisk",
              defaultValue: false
            })
          }),
          runStore
        });

        return {
          content: [{ type: "text", text: formatProgramRunJournal(runJournal) }],
          details: runJournal
        };
      }
    });

    pi.registerTool({
      name: "inspect_worker_runtime",
      label: "Inspect Worker Runtime",
      description: "Inspect whether the live Pi host exposes bounded worker execution.",
      parameters: inspectWorkerRuntimeSchema,
      async execute() {
        const status = inspectPiWorkerRuntime({
          host: pi,
          supportedRoles: adapterSupportedRoles
        });

        return {
          content: [{ type: "text", text: formatPiWorkerRuntimeStatus(status) }],
          details: status
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

export default createPiExtension({
  runStore: createRunStore()
});
