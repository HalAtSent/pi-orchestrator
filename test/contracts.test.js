import test from "node:test";
import assert from "node:assert/strict";

import { createTaskPacket, createWorkerResult } from "../src/contracts.js";

function validTaskPacket(overrides = {}) {
  return {
    id: "task-1",
    parentTaskId: "parent-1",
    role: "implementer",
    risk: "low",
    goal: "Apply a bounded change",
    nonGoals: ["No broad refactors"],
    allowedFiles: ["src/contracts.js"],
    forbiddenFiles: ["src/generated.js"],
    acceptanceChecks: ["Tests pass"],
    stopConditions: ["Stop on scope drift"],
    contextFiles: ["README.md"],
    commands: ["node --check src/contracts.js"],
    ...overrides
  };
}

function validWorkerResult(overrides = {}) {
  return {
    status: "success",
    summary: "Change completed",
    changedFiles: ["src/contracts.js"],
    commandsRun: ["node --test --test-isolation=none"],
    evidence: ["Unit tests passed"],
    openQuestions: ["Should we add broader coverage?"],
    ...overrides
  };
}

test("createTaskPacket rejects empty allowedFiles entries", () => {
  assert.throws(
    () => createTaskPacket(validTaskPacket({
      allowedFiles: [""]
    })),
    /packet\.allowedFiles\[0\] must be a non-empty string/u
  );
});

test("createTaskPacket rejects whitespace-only entries in forbiddenFiles and commands", () => {
  assert.throws(
    () => createTaskPacket(validTaskPacket({
      forbiddenFiles: ["   "]
    })),
    /packet\.forbiddenFiles\[0\] must be a non-empty string/u
  );

  assert.throws(
    () => createTaskPacket(validTaskPacket({
      commands: ["\t  "]
    })),
    /packet\.commands\[0\] must be a non-empty string/u
  );
});

test("createWorkerResult rejects empty evidence and openQuestions entries", () => {
  assert.throws(
    () => createWorkerResult(validWorkerResult({
      evidence: [""]
    })),
    /result\.evidence\[0\] must be a non-empty string/u
  );

  assert.throws(
    () => createWorkerResult(validWorkerResult({
      openQuestions: ["   "]
    })),
    /result\.openQuestions\[0\] must be a non-empty string/u
  );
});

test("createWorkerResult rejects malformed changedSurfaceObservation payloads", () => {
  assert.throws(
    () => createWorkerResult(validWorkerResult({
      changedSurfaceObservation: {
        capture: "partial",
        paths: ["src/contracts.js"]
      }
    })),
    /result\.changedSurfaceObservation\.capture must be one of: complete, not_captured/u
  );
});

test("existing valid payloads still pass and optional arrays can be omitted", () => {
  assert.doesNotThrow(() => createTaskPacket(validTaskPacket()));
  assert.doesNotThrow(() => createTaskPacket(validTaskPacket({
    contextFiles: undefined,
    commands: undefined
  })));
  assert.doesNotThrow(() => createWorkerResult(validWorkerResult()));
});
