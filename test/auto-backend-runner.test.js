import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_BACKEND_MODES,
  createAutoBackendRunner
} from "../src/auto-backend-runner.js";

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

test("auto backend runner routes low-risk implementer and verifier packets to the process backend", async () => {
  const defaultRunner = createStubRunner("default");
  const processBackend = createStubRunner("process");
  const runner = createAutoBackendRunner({
    defaultRunner,
    processBackend,
    mode: AUTO_BACKEND_MODES.LOW_RISK_PROCESS_IMPLEMENTER
  });

  await runner.run({
    role: "implementer",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low"
  });

  await runner.run({
    role: "verifier",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "low"
  });

  await runner.run({
    role: "implementer",
    allowedFiles: ["src/a.js"]
  }, {
    risk: "medium"
  });

  assert.equal(processBackend.getCalls().length, 2);
  assert.equal(defaultRunner.getCalls().length, 1);
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
