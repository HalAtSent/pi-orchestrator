import test from "node:test";
import assert from "node:assert/strict";

import { validateWorkerResult } from "../src/contracts.js";
import { createLocalWorkerRunner, createScriptedWorkerRunner } from "../src/worker-runner.js";

function createPacket(role, overrides = {}) {
  return {
    id: `${role}-packet`,
    role,
    allowedFiles: ["src/helpers.js"],
    ...overrides
  };
}

test("local worker runner bookkeeping tolerates non-cloneable context values", async () => {
  let capturedContext;
  const runner = createLocalWorkerRunner({
    handlers: {
      implementer: async ({ context }) => {
        capturedContext = context;
        return {
          status: "success",
          summary: "Renamed the helper.",
          changedFiles: ["src/helpers.js"],
          commandsRun: ["node --check src/helpers.js"],
          evidence: ["Implementer step passed."],
          openQuestions: []
        };
      }
    }
  });

  const result = await runner.run(createPacket("implementer"), {
    workflowId: "local-function-context",
    callbacks: {
      onComplete() {
        return "done";
      }
    }
  });

  validateWorkerResult(result);
  assert.equal(result.status, "success");

  const calls = runner.getCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.workflowId, "local-function-context");
  assert.equal(typeof calls[0].context.callbacks.onComplete, "string");
  assert.match(calls[0].context.callbacks.onComplete, /uncloneable/i);

  assert.equal(capturedContext.workflowId, "local-function-context");
  assert.equal(typeof capturedContext.callbacks.onComplete, "string");
  assert.match(capturedContext.callbacks.onComplete, /uncloneable/i);
});

test("scripted worker runner bookkeeping tolerates non-cloneable context values", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      packetId: "implementer-scripted-packet",
      result: {
        status: "success",
        summary: "Scripted implementer step passed.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Scripted step executed."],
        openQuestions: []
      }
    }
  ]);

  const result = await runner.run(createPacket("implementer", {
    id: "implementer-scripted-packet"
  }), {
    workflowId: "scripted-function-context",
    callbacks: {
      onStep() {
        return "ok";
      }
    }
  });

  validateWorkerResult(result);
  assert.equal(result.status, "success");
  assert.equal(runner.getPendingStepCount(), 0);

  const calls = runner.getCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.workflowId, "scripted-function-context");
  assert.equal(typeof calls[0].context.callbacks.onStep, "string");
  assert.match(calls[0].context.callbacks.onStep, /uncloneable/i);
});
