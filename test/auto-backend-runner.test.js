import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_BACKEND_MODES,
  createAutoBackendRunner,
  isTrustedChangedSurfaceObservationResult
} from "../src/auto-backend-runner.js";
import { validateWorkerResult } from "../src/contracts.js";

function createStubRunner(label) {
  const calls = [];

  return {
    async run(packet, context = {}) {
      calls.push({
        packet: structuredClone(packet),
        context: structuredClone(context)
      });

      return {
        status: "success",
        summary: `${label} handled ${packet.role}`,
        changedFiles: packet.role === "implementer" ? [...packet.allowedFiles] : [],
        commandsRun: [],
        evidence: [label],
        openQuestions: []
      };
    },

    getCalls() {
      return structuredClone(calls);
    }
  };
}

function createLowRiskProcessModeRunner() {
  const defaultRunner = createStubRunner("default");
  const processBackend = createStubRunner("process");
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  return {
    defaultRunner,
    processBackend,
    runner
  };
}

test("auto backend runner uses the default runner in pi_runtime mode", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = createStubRunner("process");
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.PI_RUNTIME
  });

  await runner.run({
    role: "implementer",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low"
  });

  assert.equal(defaultRunner.getCalls().length, 1);
  assert.equal(processBackend.getCalls().length, 0);
});

test("auto backend runner routes low-risk implementer packets to the process backend from packet risk with empty context", async () => {
  const { defaultRunner, processBackend, runner } = createLowRiskProcessModeRunner();

  await runner.run({
    role: "implementer",
    risk: "low",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(processBackend.getCalls().length, 1);
  assert.equal(defaultRunner.getCalls().length, 0);
});

test("auto backend runner routes low-risk verifier packets to the process backend from packet risk with empty context", async () => {
  const { defaultRunner, processBackend, runner } = createLowRiskProcessModeRunner();

  await runner.run({
    role: "verifier",
    risk: "low",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(processBackend.getCalls().length, 1);
  assert.equal(defaultRunner.getCalls().length, 0);
});

test("auto backend runner does not route medium or high risk implementer/verifier packets to the low-risk process backend", async () => {
  const { defaultRunner, processBackend, runner } = createLowRiskProcessModeRunner();

  await runner.run({
    role: "implementer",
    risk: "medium",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low"
  });

  await runner.run({
    role: "verifier",
    risk: "high",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low"
  });

  assert.equal(processBackend.getCalls().length, 0);
  assert.equal(defaultRunner.getCalls().length, 2);
});

test("auto backend runner falls back to context risk when packet risk is missing or invalid", async () => {
  const { defaultRunner, processBackend, runner } = createLowRiskProcessModeRunner();

  await runner.run({
    role: "implementer",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low"
  });

  await runner.run({
    role: "verifier",
    risk: "not-a-risk",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low"
  });

  await runner.run({
    role: "implementer",
    risk: "not-a-risk",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "medium"
  });

  await runner.run({
    role: "verifier",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(processBackend.getCalls().length, 2);
  assert.equal(defaultRunner.getCalls().length, 2);
});

test("auto backend runner rejects low_risk_process_implementer mode without a process backend", () => {
  const defaultRunner = createStubRunner("default");

  assert.throws(
    () => createAutoBackendRunner({
      defaultRunner,
      mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
    }),
    /processbackend\.run/i
  );
});

test("auto backend runner routes all workflow roles to the process backend in process_subagents mode", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = createStubRunner("process");
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.PROCESS_SUBAGENTS
  });

  await runner.run({ role: "explorer", allowedFiles: ["src/a.js"] }, { risk: "medium" });
  await runner.run({ role: "implementer", allowedFiles: ["src/a.js"] }, { risk: "medium" });
  await runner.run({ role: "reviewer", allowedFiles: ["src/a.js"] }, { risk: "medium" });
  await runner.run({ role: "verifier", allowedFiles: ["src/a.js"] }, { risk: "medium" });

  assert.equal(processBackend.getCalls().length, 4);
  assert.equal(defaultRunner.getCalls().length, 0);
});

test("auto backend runner backend selection does not throw on non-cloneable context", async () => {
  const defaultRunner = {
    async run(packet) {
      return {
        status: "success",
        summary: `default handled ${packet.role}`,
        changedFiles: [],
        commandsRun: [],
        evidence: ["default"],
        openQuestions: []
      };
    }
  };
  const processBackend = {
    async run(packet) {
      return {
        status: "success",
        summary: `process handled ${packet.role}`,
        changedFiles: packet.role === "implementer" ? [...packet.allowedFiles] : [],
        commandsRun: [],
        evidence: ["process"],
        openQuestions: []
      };
    }
  };

  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  const result = await runner.run({
    role: "implementer",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low",
    hooks: {
      onRoute() {
        return "ok";
      }
    }
  });

  validateWorkerResult(result);
  assert.equal(result.status, "success");

  const calls = runner.getCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].selectedBackend, "process_backend");
  assert.equal(calls[0].context.risk, "low");
  assert.equal(typeof calls[0].context.hooks.onRoute, "string");
  assert.match(calls[0].context.hooks.onRoute, /uncloneable/i);
});

test("auto backend runner only attests changed-surface observations when process backend is selected", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = createStubRunner("process");
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  const trustedResult = await runner.run({
    role: "implementer",
    risk: "low",
    allowedFiles: ["src/a.js"]
  }, {});
  const untrustedResult = await runner.run({
    role: "implementer",
    risk: "medium",
    allowedFiles: ["src/a.js"]
  }, {});

  assert.equal(isTrustedChangedSurfaceObservationResult(trustedResult), true);
  assert.equal(isTrustedChangedSurfaceObservationResult(untrustedResult), false);
});

test("auto backend runner does not expose a public changed-surface trust marker", async () => {
  const moduleExports = await import("../src/auto-backend-runner.js");

  assert.equal(typeof moduleExports.markTrustedChangedSurfaceObservationResult, "undefined");
});

test("legacy worker-result-attestation helper module is not importable", async () => {
  await assert.rejects(
    import("../src/worker-result-attestation.js"),
    /ERR_MODULE_NOT_FOUND/i
  );
});
