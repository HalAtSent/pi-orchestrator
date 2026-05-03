import assert from "node:assert/strict";
import test from "node:test";

import { validateWorkOrder } from "../src/kernel/work-order.js";

test("valid minimal Work Order passes", () => {
  const result = validateWorkOrder(validWorkOrder());

  assert.equal(result.success, true);
  assert.equal(result.status, "valid");
  assert.equal(result.executable, true);
  assert.deepEqual(result.hardFailures, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.errors, []);
});

test("active Work Orders are executable only when valid and ready", () => {
  const result = validateWorkOrder(validWorkOrder());

  assert.equal(result.success, true);
  assert.equal(result.executable, true);
});

test("planned and completed Work Orders are valid but not executable", () => {
  for (const state of ["planned", "completed"]) {
    const workOrder = validWorkOrder();
    workOrder.state = state;

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, true, state);
    assert.equal(result.executable, false, state);
    assert.deepEqual(result.errors, [], state);
  }
});

test("validation result returns structured errors", () => {
  const result = validateWorkOrder({
    schemaVersion: 2,
    kind: "work_order",
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "invalid");
  assert.equal(result.executable, false);
  assert.deepEqual(result.warnings, []);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.length > 0);
  assert.deepEqual(result.hardFailures, result.errors);
  assert.ok(result.errors.every((error) => typeof error.path === "string"));
  assert.ok(result.errors.every((error) => typeof error.code === "string"));
  assert.ok(result.errors.every((error) => typeof error.message === "string"));
  assertError(result, "$.schemaVersion", "unsupported_value");
});

test("missing required fields fail closed", () => {
  const cases = [
    ["schemaVersion", (workOrder) => delete workOrder.schemaVersion, "$.schemaVersion"],
    ["kind", (workOrder) => delete workOrder.kind, "$.kind"],
    ["state", (workOrder) => delete workOrder.state, "$.state"],
    ["id", (workOrder) => delete workOrder.id, "$.id"],
    ["goal", (workOrder) => delete workOrder.goal, "$.goal"],
    ["repositoryRoot", (workOrder) => delete workOrder.repositoryRoot, "$.repositoryRoot"],
    ["policyProfile", (workOrder) => delete workOrder.policyProfile, "$.policyProfile"],
    ["readiness.status", (workOrder) => delete workOrder.readiness.status, "$.readiness.status"],
    ["change.class", (workOrder) => delete workOrder.change.class, "$.change.class"],
    ["change.reviewDepth", (workOrder) => delete workOrder.change.reviewDepth, "$.change.reviewDepth"],
    ["scope.allowed", (workOrder) => delete workOrder.scope.allowed, "$.scope.allowed"],
    ["scope.forbidden", (workOrder) => delete workOrder.scope.forbidden, "$.scope.forbidden"],
    ["scope.newFiles", (workOrder) => delete workOrder.scope.newFiles, "$.scope.newFiles"],
    ["context", (workOrder) => delete workOrder.context, "$.context"],
    ["acceptance", (workOrder) => delete workOrder.acceptance, "$.acceptance"],
    ["verification", (workOrder) => delete workOrder.verification, "$.verification"],
    ["execution.autonomyLevel", (workOrder) => delete workOrder.execution.autonomyLevel, "$.execution.autonomyLevel"],
    ["execution.rolePackets", (workOrder) => delete workOrder.execution.rolePackets, "$.execution.rolePackets"],
    ["risk.level", (workOrder) => delete workOrder.risk.level, "$.risk.level"],
    ["operationalReadiness", (workOrder) => delete workOrder.operationalReadiness, "$.operationalReadiness"],
    ["approval", (workOrder) => delete workOrder.approval, "$.approval"],
    ["repair.maxLoops", (workOrder) => delete workOrder.repair.maxLoops, "$.repair.maxLoops"],
  ];

  for (const [name, mutate, expectedPath] of cases) {
    const workOrder = validWorkOrder();
    mutate(workOrder);

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, false, name);
    assertError(result, expectedPath, "required");
  }
});

test("wrong kind fails closed", () => {
  const workOrder = validWorkOrder();
  workOrder.kind = "evidence_pack";

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.kind", "unsupported_value");
});

test("unsupported schemaVersion fails closed", () => {
  const workOrder = validWorkOrder();
  workOrder.schemaVersion = 2;

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.schemaVersion", "unsupported_value");
});

test("unknown policyProfile fails closed", () => {
  const workOrder = validWorkOrder();
  workOrder.policyProfile = "permissive";

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.policyProfile", "unsupported_value");
});

test("non-ready Work Orders fail closed", () => {
  for (const status of ["blocked", "draft"]) {
    const workOrder = validWorkOrder();
    workOrder.readiness.status = status;

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, false, status);
    assert.equal(result.executable, false, status);
    assertError(result, "$.readiness.status", "not_ready");
  }
});

test("missing patchBudget fails closed", () => {
  const workOrder = validWorkOrder();
  delete workOrder.change.patchBudget;

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.change.patchBudget", "required");
});

test("missing model/tool route fails closed", () => {
  const workOrder = validWorkOrder();
  delete workOrder.execution.modelToolRoute;

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.execution.modelToolRoute", "required");
});

test("missing counterexampleReview declaration fails closed", () => {
  const workOrder = validWorkOrder();
  delete workOrder.execution.counterexampleReview;

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.execution.counterexampleReview", "required");
});

test("no required acceptance item fails closed", () => {
  const workOrder = validWorkOrder();
  workOrder.acceptance = [
    {
      id: "acc-optional",
      text: "Optional polish may be included.",
      required: false,
    },
  ];

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.acceptance", "missing_required_acceptance");
});

test("unsupported enum vocabularies fail closed", () => {
  const cases = [
    ["artifact state", (workOrder) => (workOrder.state = "archived"), "$.state"],
    ["change class", (workOrder) => (workOrder.change.class = "feature"), "$.change.class"],
    ["review depth", (workOrder) => (workOrder.change.reviewDepth = "deep"), "$.change.reviewDepth"],
    ["autonomy level", (workOrder) => (workOrder.execution.autonomyLevel = "unbounded"), "$.execution.autonomyLevel"],
    ["risk level", (workOrder) => (workOrder.risk.level = "critical"), "$.risk.level"],
    ["new-file policy", (workOrder) => (workOrder.scope.newFiles = "maybe"), "$.scope.newFiles"],
    [
      "readiness check status",
      (workOrder) => (workOrder.readiness.checks[0].status = "unknown"),
      "$.readiness.checks[0].status",
    ],
  ];

  for (const [name, mutate, expectedPath] of cases) {
    const workOrder = validWorkOrder();
    mutate(workOrder);

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, false, name);
    assertError(result, expectedPath, "unsupported_value");
  }
});

test("unsupported action class fails closed", () => {
  const workOrder = validWorkOrder();
  workOrder.verification.commands[0].actionClasses = ["read_repository", "deploy_production"];

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.verification.commands[0].actionClasses[1]", "unsupported_value");
});

test("required verification with no commands and derived commands disabled fails closed", () => {
  const workOrder = validWorkOrder();
  workOrder.verification.commands = [];
  workOrder.verification.allowDerivedCommands = false;

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.verification", "verification_impossible");
});

test("approval-required metadata missing fails closed", () => {
  const workOrder = validWorkOrder();
  workOrder.approval = {
    required: true,
  };

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.approval.approvalId", "required");
  assertError(result, "$.approval.approvedAt", "required");
  assertError(result, "$.approval.approvedBy", "required");
  assertError(result, "$.approval.approvedFingerprint", "required");
  assertError(result, "$.approval.approvedActionClasses", "required");
});

test("approval-required malformed metadata fails closed without fingerprint equality checks", () => {
  const workOrder = validWorkOrder();
  workOrder.approval = {
    required: true,
    approvalId: "approval-001",
    approvedAt: "not-a-date",
    approvedBy: "reviewer",
    approvedFingerprint: "sha256:not-valid",
    approvedActionClasses: ["read_repository"],
  };

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.approval.approvedAt", "malformed_approval");
  assertError(result, "$.approval.approvedFingerprint", "malformed_approval");
});

test("approval-required valid approvedAt UTC timestamp formats pass", () => {
  const cases = [
    "2024-02-29T00:00:00Z",
    "2024-02-29T00:00:00.123Z",
  ];

  for (const approvedAt of cases) {
    const workOrder = validWorkOrder();
    workOrder.approval = validRequiredApproval({ approvedAt });

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, true, approvedAt);
    assert.deepEqual(result.errors, []);
  }
});

test("approval-required rejects approvedAt timestamps normalized by Date.parse", () => {
  const cases = [
    "2024-02-30T00:00:00Z",
    "2024-04-31T00:00:00Z",
  ];

  for (const approvedAt of cases) {
    const workOrder = validWorkOrder();
    workOrder.approval = validRequiredApproval({ approvedAt });

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, false, approvedAt);
    assertError(result, "$.approval.approvedAt", "malformed_approval");
  }
});

test("shallow repo-relative path syntax checks fail closed", () => {
  const cases = [
    ["absolute path", (workOrder) => (workOrder.scope.allowed[0] = "/tmp/outside"), "$.scope.allowed[0]"],
    ["path traversal", (workOrder) => (workOrder.scope.allowed[0] = "../outside"), "$.scope.allowed[0]"],
    ["url-like path", (workOrder) => (workOrder.context.files[0].path = "https://example.test/file"), "$.context.files[0].path"],
    ["write-scope dot", (workOrder) => (workOrder.scope.allowed[0] = "."), "$.scope.allowed[0]"],
    ["backslash separators", (workOrder) => (workOrder.scope.allowed[0] = "src\\kernel"), "$.scope.allowed[0]"],
  ];

  for (const [name, mutate, expectedPath] of cases) {
    const workOrder = validWorkOrder();
    mutate(workOrder);

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, false, name);
    assertError(result, expectedPath, "invalid_path");
  }
});

function validWorkOrder() {
  return {
    schemaVersion: 1,
    kind: "work_order",
    state: "active",
    id: "wo-minimal-validation",
    goal: "Add focused Work Order schema validation tests.",
    repositoryRoot: "/absolute/path/to/pi-orchestrator",
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
      class: "contract_schema",
      reviewDepth: "medium",
      patchBudget: {
        expectedFilesChanged: 3,
        maxApproxChangedLines: 900,
        allowedSurfaces: ["src", "test"],
        mayMixSurfaces: false,
        incidentalRefactors: false,
      },
    },
    scope: {
      allowed: ["package.json", "src/kernel/work-order.js", "test/work-order-schema.test.js"],
      forbidden: [".git/", ".pi/", "node_modules/", "dist/", ".env"],
      newFiles: "listed_only",
      allowedNewFiles: ["src/kernel/work-order.js", "test/work-order-schema.test.js"],
    },
    context: {
      files: [
        {
          path: "docs/WORK-ORDER-SCHEMA.md",
          required: true,
          reason: "Schema source of truth.",
        },
      ],
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
        text: "Invalid Work Orders fail before execution.",
        required: true,
      },
    ],
    verification: {
      commands: [
        {
          id: "verify-node-test",
          command: "node --test test/work-order-schema.test.js",
          cwd: ".",
          required: true,
          actionClasses: ["read_repository", "execute_local_command"],
          reason: "Run focused Work Order schema tests.",
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
        reason: "Focused schema validation implementation.",
      },
    },
    nonGoals: [
      "Do not implement Evidence Pack validation.",
      "Do not implement canonical fingerprinting.",
      "Do not implement worker execution.",
    ],
    risk: {
      level: "low",
      reasons: ["Small isolated schema validation module."],
    },
    operationalReadiness: {
      observability: {
        breakageDetection: "Focused node:test coverage and diff whitespace checks catch schema validation regressions.",
        signals: ["node --test test/work-order-schema.test.js", "git diff --check"],
        manualChecks: [],
      },
      rollbackRecovery: {
        required: false,
        plan: null,
        recoverySteps: [],
        notApplicableReason: "Small validation-only patch can be reverted directly.",
      },
    },
    reviewFocus: ["Confirm validation remains limited to Work Order schema v1."],
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

function validRequiredApproval({ approvedAt }) {
  return {
    required: true,
    approvalId: "approval-001",
    approvedAt,
    approvedBy: "reviewer",
    approvedFingerprint: `sha256:${"a".repeat(64)}`,
    approvedActionClasses: ["read_repository"],
  };
}

function assertError(result, expectedPath, expectedCode) {
  assert.ok(
    result.errors.some((error) => error.path === expectedPath && error.code === expectedCode),
    `Expected ${expectedCode} error at ${expectedPath}; got ${JSON.stringify(result.errors, null, 2)}`,
  );
}
