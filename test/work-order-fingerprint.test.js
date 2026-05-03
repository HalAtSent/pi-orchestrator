import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { canonicalJson, fingerprintWorkOrder } from "../src/kernel/work-order-fingerprint.js";

test("canonical JSON and fingerprint are stable across object key insertion order", () => {
  const left = {
    goal: "Add fingerprint primitive.",
    id: "WO-012",
    verification: {
      commands: [
        {
          id: "verify",
          actionClasses: ["write_repository", "read_repository", "read_repository"],
          command: "node --test test/work-order-fingerprint.test.js",
        },
      ],
    },
    approval: {
      approvedActionClasses: ["write_repository", "read_repository"],
      required: true,
    },
  };
  const right = {
    approval: {
      required: true,
      approvedActionClasses: ["read_repository", "write_repository"],
    },
    verification: {
      commands: [
        {
          command: "node --test test/work-order-fingerprint.test.js",
          actionClasses: ["read_repository", "write_repository"],
          id: "verify",
        },
      ],
    },
    id: "WO-012",
    goal: "Add fingerprint primitive.",
  };

  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(fingerprintWorkOrder(left), fingerprintWorkOrder(right));
});

test("fingerprint uses UTF-8 canonical JSON SHA-256 with sha256 lowercase hex format", () => {
  const workOrder = validWorkOrder();
  delete workOrder.extensions;
  const canonical = canonicalJson(workOrder);
  const expectedHash = crypto.createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex");

  assert.equal(fingerprintWorkOrder(workOrder), `sha256:${expectedHash}`);
  assert.match(fingerprintWorkOrder(workOrder), /^sha256:[a-f0-9]{64}$/);
});

test("only declared action-class arrays are de-duplicated and sorted as sets", () => {
  const base = validWorkOrder();
  const reordered = validWorkOrder();
  reordered.verification.commands[0].actionClasses = ["read_repository", "execute_local_command", "read_repository"];
  reordered.execution.modelToolRoute.tools = ["write_repository", "execute_local_command", "read_repository", "read_repository"];
  reordered.approval.approvedActionClasses = ["read_repository", "execute_local_command", "read_repository"];

  assert.equal(fingerprintWorkOrder(base), fingerprintWorkOrder(reordered));
});

test("non-action-class arrays remain order-sensitive", () => {
  assert.notEqual(
    fingerprintWorkOrder(validWorkOrder()),
    fingerprintWorkOrder(withMutation((workOrder) => workOrder.acceptance.reverse())),
  );
  assert.notEqual(
    fingerprintWorkOrder(validWorkOrder()),
    fingerprintWorkOrder(withMutation((workOrder) => workOrder.verification.commands.reverse())),
  );
  assert.notEqual(
    fingerprintWorkOrder(validWorkOrder()),
    fingerprintWorkOrder(withMutation((workOrder) => workOrder.context.files.reverse())),
  );
  assert.notEqual(
    fingerprintWorkOrder(validWorkOrder()),
    fingerprintWorkOrder(withMutation((workOrder) => workOrder.context.notes.reverse())),
  );
  assert.notEqual(
    fingerprintWorkOrder(validWorkOrder()),
    fingerprintWorkOrder(withMutation((workOrder) => workOrder.readiness.checks.reverse())),
  );
});

test("fingerprint changes when binding Work Order fields change", () => {
  assert.notEqual(
    fingerprintWorkOrder(validWorkOrder()),
    fingerprintWorkOrder(withMutation((workOrder) => {
      workOrder.goal = "Changed goal.";
    })),
  );
  assert.notEqual(
    fingerprintWorkOrder(validWorkOrder()),
    fingerprintWorkOrder(withMutation((workOrder) => {
      workOrder.verification.commands[0].command = "npm test";
    })),
  );
});

test("fingerprint ignores only volatile approval record fields", () => {
  const volatileChanged = withMutation((workOrder) => {
    workOrder.approval.approvalId = "approval-999";
    workOrder.approval.approvedAt = "2026-05-03T12:00:00Z";
    workOrder.approval.approvedBy = "different-reviewer";
    workOrder.approval.approvedFingerprint = `sha256:${"b".repeat(64)}`;
  });

  assert.equal(fingerprintWorkOrder(validWorkOrder()), fingerprintWorkOrder(volatileChanged));
  assert.notEqual(
    fingerprintWorkOrder(validWorkOrder()),
    fingerprintWorkOrder(withMutation((workOrder) => {
      workOrder.approval.required = false;
    })),
  );
});

test("fingerprint ignores undeclared top-level extensions content", () => {
  assert.equal(
    fingerprintWorkOrder(validWorkOrder()),
    fingerprintWorkOrder(withMutation((workOrder) => {
      delete workOrder.extensions;
    })),
  );
  assert.equal(
    fingerprintWorkOrder(validWorkOrder()),
    fingerprintWorkOrder(withMutation((workOrder) => {
      workOrder.extensions = {
        note: {
          details: ["draft-only", { reviewed: false }],
        },
      };
    })),
  );

  assert.equal(canonicalJson({ extensions: { note: "x" } }), '{"extensions":{"note":"x"}}');
});

test("canonical JSON preserves top-level own __proto__ keys from parsed JSON", () => {
  const withProto = JSON.parse('{"id":"WO","__proto__":{"binding":true}}');
  const withoutProto = JSON.parse('{"id":"WO"}');

  assert.equal(canonicalJson(withProto), '{"__proto__":{"binding":true},"id":"WO"}');
  assert.notEqual(canonicalJson(withProto), canonicalJson(withoutProto));
  assert.notEqual(fingerprintWorkOrder(withProto), fingerprintWorkOrder(withoutProto));
});

test("canonical JSON preserves nested own __proto__ keys from parsed JSON", () => {
  const withProto = JSON.parse('{"id":"WO","metadata":{"name":"example","__proto__":{"binding":true}}}');
  const withoutProto = JSON.parse('{"id":"WO","metadata":{"name":"example"}}');

  assert.equal(canonicalJson(withProto), '{"id":"WO","metadata":{"__proto__":{"binding":true},"name":"example"}}');
  assert.notEqual(canonicalJson(withProto), canonicalJson(withoutProto));
  assert.notEqual(fingerprintWorkOrder(withProto), fingerprintWorkOrder(withoutProto));
});

test("canonical JSON emits integer-like object keys in lexicographic order", () => {
  assert.equal(canonicalJson({ 10: "a", 2: "b", a: "c" }), '{"10":"a","2":"b","a":"c"}');
  assert.equal(
    canonicalJson({ outer: { 10: "a", 2: "b", a: "c" } }),
    '{"outer":{"10":"a","2":"b","a":"c"}}',
  );
});

function withMutation(mutate) {
  const workOrder = validWorkOrder();
  mutate(workOrder);
  return workOrder;
}

function validWorkOrder() {
  return {
    schemaVersion: 1,
    kind: "work_order",
    state: "active",
    id: "WO-012",
    goal: "Add reusable canonical JSON and fingerprint primitives.",
    repositoryRoot: ".",
    policyProfile: "default",
    readiness: {
      status: "ready",
      checks: [
        { id: "prereq-shape", status: "satisfied" },
        { id: "allowed-scope", status: "satisfied" },
      ],
    },
    change: {
      class: "contract_schema",
      reviewDepth: "low",
      patchBudget: {
        expectedFilesChanged: 2,
        maxApproxChangedLines: 160,
        allowedSurfaces: [
          "src/kernel/work-order-fingerprint.js",
          "test/work-order-fingerprint.test.js",
        ],
        mayMixSurfaces: false,
        incidentalRefactors: false,
      },
    },
    scope: {
      allowed: ["src/kernel/work-order-fingerprint.js", "test/work-order-fingerprint.test.js"],
      forbidden: ["src/kernel/work-order.js", "src/cli/pi.js", "docs/"],
      newFiles: "listed_only",
    },
    context: {
      files: ["src/kernel/work-order-fingerprint.js", "test/work-order-fingerprint.test.js"],
      notes: ["Keep separate from validator execution.", "Do not expose from validateWorkOrder()."],
    },
    acceptance: [
      { id: "canonical", text: "Canonical JSON is deterministic.", required: true },
      { id: "fingerprint", text: "Fingerprint is deterministic.", required: true },
    ],
    verification: {
      commands: [
        {
          id: "focused",
          command: "node --test test/work-order-fingerprint.test.js",
          cwd: ".",
          required: true,
          actionClasses: ["execute_local_command", "read_repository"],
          reason: "Run focused fingerprint tests.",
        },
        {
          id: "full",
          command: "npm test",
          cwd: ".",
          required: true,
          actionClasses: ["execute_local_command"],
          reason: "Run full test suite.",
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
        tools: ["read_repository", "execute_local_command", "write_repository"],
        rationale: "Local implementation and tests are sufficient.",
      },
      rolePackets: [],
      counterexampleReview: {
        required: false,
        reason: "Focused primitive implementation.",
      },
    },
    nonGoals: ["Do not change validator behavior."],
    risk: {
      level: "low",
      reasons: ["Small isolated primitive."],
    },
    operationalReadiness: {
      observability: {
        breakageDetection: "Focused and full node:test runs.",
        signals: ["node --test test/work-order-fingerprint.test.js", "npm test"],
        manualChecks: [],
      },
      rollbackRecovery: {
        required: false,
        plan: null,
        recoverySteps: [],
        notApplicableReason: "Small primitive can be reverted directly.",
      },
    },
    reviewFocus: ["Confirm primitive is separate from validateWorkOrder()."],
    approval: {
      required: true,
      approvalId: "approval-001",
      approvedAt: "2026-05-03T00:00:00Z",
      approvedBy: "reviewer",
      approvedFingerprint: `sha256:${"a".repeat(64)}`,
      approvedActionClasses: ["execute_local_command", "read_repository"],
    },
    repair: {
      maxLoops: 1,
      mayWidenScope: false,
    },
    extensions: {},
  };
}
