import assert from "node:assert/strict";
import test from "node:test";

import { fingerprintWorkOrder } from "../src/kernel/work-order-fingerprint.js";
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

test("valid Work Order result includes non-authoritative summary copied from source fields", () => {
  const workOrder = validWorkOrder();
  workOrder.change.class = "infrastructure_tooling";
  workOrder.change.reviewDepth = "high";
  workOrder.change.patchBudget = {
    expectedFilesChanged: 1,
    maxApproxChangedLines: 42,
    allowedSurfaces: ["src/kernel/work-order.js"],
    mayMixSurfaces: true,
    incidentalRefactors: true,
  };
  workOrder.execution.autonomyLevel = "scoped_edit";
  workOrder.execution.counterexampleReview.required = true;
  workOrder.risk.level = "medium";
  workOrder.verification.commands = [
    {
      id: "verify-summary",
      command: "node --test test/work-order-schema.test.js",
      cwd: ".",
      required: true,
      actionClasses: ["read_repository", "execute_local_command"],
      reason: "Verify copied Work Order summary.",
    },
  ];

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, true);
  assert.deepEqual(result.summary, {
    changeClass: workOrder.change.class,
    riskLevel: workOrder.risk.level,
    autonomyLevel: workOrder.execution.autonomyLevel,
    reviewDepth: workOrder.change.reviewDepth,
    patchBudget: workOrder.change.patchBudget,
    verificationCommands: workOrder.verification.commands,
    counterexampleReviewRequired: workOrder.execution.counterexampleReview.required,
  });
});

test("summary does not default missing source fields or change validation semantics", () => {
  const workOrder = validWorkOrder();
  delete workOrder.change.class;
  delete workOrder.execution.counterexampleReview.required;

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assert.equal(result.status, "invalid");
  assert.equal(result.executable, false);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.hardFailures, result.errors);
  assertError(result, "$.change.class", "required");
  assertError(result, "$.execution.counterexampleReview.required", "required");
  assert.deepEqual(result.summary, {
    changeClass: undefined,
    riskLevel: workOrder.risk.level,
    autonomyLevel: workOrder.execution.autonomyLevel,
    reviewDepth: workOrder.change.reviewDepth,
    patchBudget: workOrder.change.patchBudget,
    verificationCommands: workOrder.verification.commands,
    counterexampleReviewRequired: undefined,
  });
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
    approvedActionClasses: ["execute_local_command", "read_repository"],
  };

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.approval.approvedAt", "malformed_approval");
  assertError(result, "$.approval.approvedFingerprint", "malformed_approval");
});

test("approval-required missing approved action class fails closed", () => {
  const workOrder = validWorkOrder();
  workOrder.verification.commands[0].actionClasses = ["read_repository", "execute_local_command"];
  workOrder.approval = validRequiredApproval({ approvedActionClasses: ["read_repository"] });

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assert.equal(result.executable, false);
  assertError(result, "$.approval.approvedActionClasses", "approval_action_classes_mismatch");
});

test("approval-required extra approved action class fails closed", () => {
  const workOrder = validWorkOrder();
  workOrder.verification.commands[0].actionClasses = ["read_repository"];
  workOrder.approval = validRequiredApproval({
    approvedActionClasses: ["read_repository", "execute_local_command"],
  });

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assert.equal(result.executable, false);
  assertError(result, "$.approval.approvedActionClasses", "approval_action_classes_mismatch");
});

test("approval-required non-canonical approved action class order fails closed", () => {
  const workOrder = validWorkOrder();
  workOrder.verification.commands[0].actionClasses = ["read_repository", "execute_local_command"];
  workOrder.approval = validRequiredApproval({
    approvedActionClasses: ["read_repository", "execute_local_command"],
  });

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.approval.approvedActionClasses", "approval_action_classes_mismatch");
});

test("approval-required duplicate approved action class fails closed", () => {
  const workOrder = validWorkOrder();
  workOrder.verification.commands[0].actionClasses = ["read_repository"];
  workOrder.approval = validRequiredApproval({
    approvedActionClasses: ["read_repository", "read_repository"],
  });

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.approval.approvedActionClasses", "approval_action_classes_mismatch");
});

test("approval-required equivalent requested action classes pass with canonical approval", () => {
  const workOrder = validWorkOrder();
  workOrder.verification.commands = [
    {
      id: "verify-read",
      command: "git status --short",
      cwd: ".",
      required: true,
      actionClasses: ["read_repository", "execute_local_command", "read_repository"],
      reason: "Read repository state.",
    },
    {
      id: "verify-test",
      command: "node --test test/work-order-schema.test.js",
      cwd: ".",
      required: true,
      actionClasses: ["execute_local_command"],
      reason: "Run focused schema tests.",
    },
  ];
  approveWorkOrder(workOrder, {
    approvedActionClasses: ["execute_local_command", "read_repository"],
  });

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, true);
  assert.equal(result.executable, true);
  assert.deepEqual(result.errors, []);
});

test("approval-required exact canonical fingerprint passes", () => {
  const workOrder = validWorkOrder();
  approveWorkOrder(workOrder, {
    approvedActionClasses: ["execute_local_command", "read_repository"],
  });

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, true);
  assert.equal(result.executable, true);
  assert.deepEqual(result.hardFailures, []);
  assert.deepEqual(result.errors, []);
});

test("approval-required stale fingerprint fails closed", () => {
  const workOrder = validWorkOrder();
  approveWorkOrder(workOrder);
  workOrder.goal = "Changed after approval.";

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assert.equal(result.executable, false);
  assert.deepEqual(result.hardFailures, result.errors);
  assertError(result, "$.approval.approvedFingerprint", "approval_fingerprint_mismatch");
});

test("approval-required verification command changes stale prior fingerprint", () => {
  const workOrder = validWorkOrder();
  approveWorkOrder(workOrder);
  workOrder.verification.commands[0].command = "npm test";

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.approval.approvedFingerprint", "approval_fingerprint_mismatch");
});

test("approval-required valid approvedAt UTC timestamp formats pass", () => {
  const cases = [
    "2024-02-29T00:00:00Z",
    "2024-02-29T00:00:00.123Z",
  ];

  for (const approvedAt of cases) {
    const workOrder = validWorkOrder();
    approveWorkOrder(workOrder, { approvedAt });

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

test("write-scope paths use lexical normalization without mutating source values", () => {
  const workOrder = validWorkOrder();
  workOrder.scope.allowed[0] = "./src/./kernel/";
  workOrder.scope.forbidden[0] = "./.pi/";
  workOrder.scope.allowedNewFiles[0] = "./src/./kernel/work-order.js";

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, true);
  assert.equal(workOrder.scope.allowed[0], "./src/./kernel/");
  assert.equal(workOrder.scope.forbidden[0], "./.pi/");
  assert.equal(workOrder.scope.allowedNewFiles[0], "./src/./kernel/work-order.js");
});

test("protected paths in scope.allowed fail with invalid_path at the write-scope field", () => {
  const cases = [
    [".git/", ".git/"],
    ["./.pi/runs/", "./.pi/runs/"],
    ["packages/app/node_modules/lib.js", "packages/app/node_modules/lib.js"],
    ["src/.env.local", "src/.env.local"],
    [".GIT/config", ".GIT/config"],
  ];

  for (const [name, protectedPath] of cases) {
    const workOrder = validWorkOrder();
    workOrder.scope.allowed[0] = protectedPath;

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, false, name);
    assertError(result, "$.scope.allowed[0]", "invalid_path");
    assert.equal(workOrder.scope.allowed[0], protectedPath);
  }
});

test("protected paths in scope.allowedNewFiles fail with invalid_path at the write-scope field", () => {
  const cases = [
    ["dist/output.js", "dist/output.js"],
    ["keys/deploy.key", "keys/deploy.key"],
    ["config/credentials.json", "config/credentials.json"],
  ];

  for (const [name, protectedPath] of cases) {
    const workOrder = validWorkOrder();
    workOrder.scope.allowedNewFiles[0] = protectedPath;

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, false, name);
    assertError(result, "$.scope.allowedNewFiles[0]", "invalid_path");
    assert.equal(workOrder.scope.allowedNewFiles[0], protectedPath);
  }
});

test("protected paths in scope.forbidden remain valid denial metadata", () => {
  const workOrder = validWorkOrder();
  workOrder.scope.forbidden = [".git/", "./.pi/runs/", "packages/app/node_modules/lib.js", "src/.env.local"];

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, true);
  assert.deepEqual(workOrder.scope.forbidden, [".git/", "./.pi/runs/", "packages/app/node_modules/lib.js", "src/.env.local"]);
});

test("unsafe write-scope path forms fail with invalid_path at the write-scope field", () => {
  const cases = [
    ["nested url-like allowed path", (workOrder) => (workOrder.scope.allowed[0] = "src/http:example"), "$.scope.allowed[0]"],
    ["nested drive-qualified allowed path", (workOrder) => (workOrder.scope.allowed[0] = "src/C:outside"), "$.scope.allowed[0]"],
    ["root allowed path", (workOrder) => (workOrder.scope.allowed[0] = "."), "$.scope.allowed[0]"],
    ["traversal allowed path", (workOrder) => (workOrder.scope.allowed[0] = "src/../outside"), "$.scope.allowed[0]"],
    ["absolute forbidden path", (workOrder) => (workOrder.scope.forbidden[0] = "/tmp/outside"), "$.scope.forbidden[0]"],
    ["backslash allowed-new-file path", (workOrder) => (workOrder.scope.allowedNewFiles[0] = "src\\kernel"), "$.scope.allowedNewFiles[0]"],
  ];

  for (const [name, mutate, expectedPath] of cases) {
    const workOrder = validWorkOrder();
    mutate(workOrder);

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, false, name);
    assertError(result, expectedPath, "invalid_path");
  }
});

test("allowedNewFiles remains exact-file-only after write-scope normalization", () => {
  const cases = [
    {
      name: "normalized trailing slash directory",
      allowed: ["src/kernel/"],
      allowedNewFiles: ["./src/./kernel/"],
    },
    {
      name: "matching terminal-dot directory alias",
      allowed: ["src/kernel/."],
      allowedNewFiles: ["src/kernel/."],
    },
    {
      name: "covered child terminal-dot directory alias",
      allowed: ["src/kernel/"],
      allowedNewFiles: ["src/kernel/new-file.js/."],
    },
  ];

  for (const { name, allowed, allowedNewFiles } of cases) {
    const workOrder = validWorkOrder();
    workOrder.scope.allowed = [...allowed];
    workOrder.scope.allowedNewFiles = [...allowedNewFiles];

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, false, name);
    assertError(result, "$.scope.allowedNewFiles[0]", "invalid_path");
    assert.deepEqual(workOrder.scope.allowed, allowed, name);
    assert.deepEqual(workOrder.scope.allowedNewFiles, allowedNewFiles, name);
  }
});

test("allowedNewFiles entries pass when covered by allowed write scope", () => {
  const cases = [
    {
      name: "directory scope covers child file",
      allowed: ["src/kernel/"],
      allowedNewFiles: ["src/kernel/new-file.js"],
    },
    {
      name: "exact file scope covers matching new file",
      allowed: ["src/kernel/new-file.js"],
      allowedNewFiles: ["src/kernel/new-file.js"],
    },
    {
      name: "normalized allowed directory covers new file without mutation",
      allowed: ["./src/./kernel/"],
      allowedNewFiles: ["src/kernel/new-file.js"],
    },
    {
      name: "normalized new-file path is compared without mutation",
      allowed: ["src/kernel/"],
      allowedNewFiles: ["./src/kernel/./new-file.js"],
    },
  ];

  for (const { name, allowed, allowedNewFiles } of cases) {
    const workOrder = validWorkOrder();
    workOrder.scope.allowed = [...allowed];
    workOrder.scope.allowedNewFiles = [...allowedNewFiles];

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, true, name);
    assert.deepEqual(workOrder.scope.allowed, allowed, name);
    assert.deepEqual(workOrder.scope.allowedNewFiles, allowedNewFiles, name);
  }
});

test("allowedNewFiles containment is skipped when new files are forbidden", () => {
  const workOrder = validWorkOrder();
  workOrder.scope.allowed = ["src/kernel/"];
  workOrder.scope.newFiles = "forbidden";
  workOrder.scope.allowedNewFiles = ["test/new-file.js"];

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, true);
  assert.deepEqual(workOrder.scope.allowed, ["src/kernel/"]);
  assert.equal(workOrder.scope.newFiles, "forbidden");
  assert.deepEqual(workOrder.scope.allowedNewFiles, ["test/new-file.js"]);
});

test("allowedNewFiles entries fail when outside allowed write scope", () => {
  const cases = [
    {
      name: "directory scope does not cover unrelated test file",
      allowed: ["src/kernel/"],
      allowedNewFiles: ["test/new-file.js"],
    },
    {
      name: "exact file scope does not cover sibling file",
      allowed: ["src/kernel/existing.js"],
      allowedNewFiles: ["src/kernel/new-file.js"],
    },
    {
      name: "directory coverage is segment bounded",
      allowed: ["src/"],
      allowedNewFiles: ["src2/new-file.js"],
    },
  ];

  for (const { name, allowed, allowedNewFiles } of cases) {
    const workOrder = validWorkOrder();
    workOrder.scope.allowed = allowed;
    workOrder.scope.allowedNewFiles = allowedNewFiles;

    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, false, name);
    assertError(result, "$.scope.allowedNewFiles[0]", "invalid_path");
  }
});

test("listed_only allowedNewFiles containment still rejects outside write scope", () => {
  const workOrder = validWorkOrder();
  workOrder.scope.allowed = ["src/kernel/"];
  workOrder.scope.newFiles = "listed_only";
  workOrder.scope.allowedNewFiles = ["test/new-file.js"];

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.scope.allowedNewFiles[0]", "invalid_path");
  assert.deepEqual(workOrder.scope.allowed, ["src/kernel/"]);
  assert.equal(workOrder.scope.newFiles, "listed_only");
  assert.deepEqual(workOrder.scope.allowedNewFiles, ["test/new-file.js"]);
});

test("allowedNewFiles containment skips entries with existing path failures", () => {
  const cases = [
    {
      name: "protected new file only reports existing protected-path error",
      mutate: (workOrder) => {
        workOrder.scope.allowed = ["src/kernel/"];
        workOrder.scope.allowedNewFiles = ["dist/output.js"];
      },
    },
    {
      name: "directory new file only reports existing exact-file error",
      mutate: (workOrder) => {
        workOrder.scope.allowed = ["src/kernel/"];
        workOrder.scope.allowedNewFiles = ["src/kernel/"];
      },
    },
    {
      name: "invalid lexical new file only reports existing lexical error",
      mutate: (workOrder) => {
        workOrder.scope.allowed = ["src/kernel/"];
        workOrder.scope.allowedNewFiles = ["src\\kernel\\new-file.js"];
      },
    },
    {
      name: "invalid terminal-dot new file only reports existing lexical error",
      mutate: (workOrder) => {
        workOrder.scope.allowed = ["src/kernel/"];
        workOrder.scope.allowedNewFiles = ["src\\kernel\\."];
      },
    },
  ];

  for (const { name, mutate } of cases) {
    const workOrder = validWorkOrder();
    mutate(workOrder);

    const result = validateWorkOrder(workOrder);
    const pathErrors = result.errors.filter((error) => error.path === "$.scope.allowedNewFiles[0]");

    assert.equal(result.success, false, name);
    assert.equal(pathErrors.length, 1, `${name}: ${JSON.stringify(result.errors, null, 2)}`);
    assert.equal(pathErrors[0].code, "invalid_path", name);
  }
});

test("allowedNewFiles containment ignores invalid allowed write-scope entries", () => {
  const workOrder = validWorkOrder();
  workOrder.scope.allowed = ["src\\kernel\\", "test/"];
  workOrder.scope.allowedNewFiles = ["src/kernel/new-file.js"];

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, false);
  assertError(result, "$.scope.allowed[0]", "invalid_path");
  assertError(result, "$.scope.allowedNewFiles[0]", "invalid_path");
});

test("command cwd dot behavior remains valid outside write-scope normalization", () => {
  const workOrder = validWorkOrder();
  workOrder.verification.commands[0].cwd = ".";

  const result = validateWorkOrder(workOrder);

  assert.equal(result.success, true);
  assert.equal(workOrder.verification.commands[0].cwd, ".");
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

function validRequiredApproval({
  approvedAt = "2024-02-29T00:00:00Z",
  approvedFingerprint = `sha256:${"a".repeat(64)}`,
  approvedActionClasses = ["execute_local_command", "read_repository"],
} = {}) {
  return {
    required: true,
    approvalId: "approval-001",
    approvedAt,
    approvedBy: "reviewer",
    approvedFingerprint,
    approvedActionClasses,
  };
}

function approveWorkOrder(workOrder, approval = {}) {
  workOrder.approval = validRequiredApproval(approval);
  workOrder.approval.approvedFingerprint = fingerprintWorkOrder(workOrder);
}

function assertError(result, expectedPath, expectedCode) {
  assert.ok(
    result.errors.some((error) => error.path === expectedPath && error.code === expectedCode),
    `Expected ${expectedCode} error at ${expectedPath}; got ${JSON.stringify(result.errors, null, 2)}`,
  );
}
