import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { validateWorkOrder } from "../src/kernel/work-order.js";

const cliPath = path.resolve("src/cli/pi.js");
const repositoryRoot = path.resolve(".");

test("validate-work-order prints validator JSON and exits 0 for a valid Work Order", async () => {
  await withTempWorkOrder(validWorkOrder(), async ({ filePath, workOrder }) => {
    const result = runCli(filePath);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), validateWorkOrder(workOrder));
  });
});

test("validate-work-order prints validator JSON and exits nonzero for an invalid Work Order", async () => {
  const workOrder = validWorkOrder();
  delete workOrder.goal;

  await withTempWorkOrder(workOrder, async ({ filePath }) => {
    const result = runCli(filePath);
    const expected = validateWorkOrder(workOrder);

    assert.notEqual(result.status, 0);
    assert.equal(expected.status, "invalid");
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), expected);
  });
});

test("validate-work-order flushes large piped validator JSON before exiting", async () => {
  const workOrder = validWorkOrder();
  workOrder.context.files = Array.from({ length: 12000 }, (_, index) => ({
    path: `generated/path-${index}.js`,
    required: "yes",
    reason: "",
  }));

  await withTempWorkOrder(workOrder, async ({ filePath }) => {
    const result = await runCliWithPipedStdout(filePath);
    const expected = validateWorkOrder(workOrder);

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "");
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.deepEqual(JSON.parse(result.stdout), expected);
  });
});

test("validate-work-order preserves JSON diagnostics and stderr for input errors", async () => {
  await withTempJson("{ invalid json", async ({ filePath }) => {
    const result = runCli(filePath);
    const diagnostic = JSON.parse(result.stdout);

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(diagnostic.diagnostic, true);
    assert.equal(diagnostic.code, "input_error");
    assert.match(diagnostic.message, /JSON/);
  });
});

async function withTempWorkOrder(workOrder, callback) {
  await withTempJson(JSON.stringify(workOrder), async ({ filePath }) => {
    await callback({ filePath, workOrder });
  });
}

async function withTempJson(contents, callback) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-work-order-cli-"));
  const filePath = path.join(tempDir, "work-order.json");

  try {
    await writeFile(filePath, contents, "utf8");
    await callback({ filePath });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runCli(filePath) {
  return spawnSync(process.execPath, [cliPath, "validate-work-order", filePath], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
}

function runCliWithPipedStdout(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "validate-work-order", filePath], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function validWorkOrder() {
  return {
    schemaVersion: 1,
    kind: "work_order",
    state: "active",
    id: "wo-cli-validation",
    goal: "Validate a Work Order through the CLI wrapper.",
    repositoryRoot,
    policyProfile: "default",
    readiness: {
      status: "ready",
      checks: [
        {
          id: "authority-cited",
          status: "satisfied",
          evidence: "docs/WORK-ORDER-SCHEMA.md",
        },
      ],
      blockers: [],
    },
    change: {
      class: "infrastructure_tooling",
      reviewDepth: "low",
      patchBudget: {
        expectedFilesChanged: 3,
        maxApproxChangedLines: 100,
        allowedSurfaces: ["src/cli/pi.js", "test/work-order-cli.test.js", "package.json"],
        mayMixSurfaces: false,
        incidentalRefactors: false,
      },
    },
    scope: {
      allowed: ["src/cli/pi.js", "test/work-order-cli.test.js", "package.json"],
      forbidden: [".git/", ".pi/", "node_modules/", "dist/", ".env"],
      newFiles: "listed_only",
      allowedNewFiles: ["src/cli/pi.js", "test/work-order-cli.test.js"],
    },
    context: {
      files: [],
      notes: [],
      priorArtifacts: [],
      manifest: [],
      budget: {
        maxTokens: 120000,
        truncationPolicy: "fail_if_required_context_truncated",
      },
    },
    acceptance: [
      {
        id: "acc-001",
        text: "The CLI prints the validator result as JSON.",
        required: true,
      },
    ],
    verification: {
      commands: [
        {
          id: "verify-cli",
          command: "node --test test/work-order-cli.test.js",
          cwd: ".",
          required: true,
          actionClasses: ["read_repository", "execute_local_command"],
          reason: "Run focused Work Order CLI tests.",
        },
      ],
      allowDerivedCommands: true,
      required: true,
    },
    execution: {
      autonomyLevel: "bounded_patch",
      modelToolRoute: {
        routeRequired: false,
        preferredWorker: "deterministic_local",
        preferredModels: [],
        tools: ["read_repository", "write_repository", "execute_local_command"],
        rationale: "Local deterministic validation and tests are sufficient.",
      },
      rolePackets: [],
      counterexampleReview: {
        required: false,
        reason: "Focused CLI wrapper implementation.",
      },
    },
    nonGoals: ["Do not change validator behavior."],
    risk: {
      level: "low",
      reasons: ["Thin CLI wrapper over existing validation."],
    },
    operationalReadiness: {
      observability: {
        breakageDetection: "Focused node:test coverage catches CLI wrapper regressions.",
        signals: ["node --test test/work-order-cli.test.js"],
        manualChecks: [],
      },
      rollbackRecovery: {
        required: false,
        plan: null,
        recoverySteps: [],
        notApplicableReason: "Small wrapper-only patch can be reverted directly.",
      },
    },
    reviewFocus: ["Confirm CLI stdout equals validateWorkOrder(parsedJson)."],
    approval: {
      required: false,
      approvalId: null,
      approvedAt: null,
      approvedBy: null,
      approvedFingerprint: null,
      approvedActionClasses: [],
    },
    repair: {
      maxLoops: 1,
      mayWidenScope: false,
    },
    extensions: {},
  };
}
