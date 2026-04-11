import test from "node:test";
import assert from "node:assert/strict";

import { createTaskPacket, validateWorkerResult } from "../src/contracts.js";
import { runAutoWorkflow } from "../src/auto-workflow.js";
import { createFileClaimRegistry, createPiWorkerRunner } from "../src/pi-worker-runner.js";

function createPacket(role, overrides = {}) {
  const base = {
    id: `${role}-packet`,
    parentTaskId: "workflow-test",
    role,
    risk: "low",
    goal: "Rename a helper in the declared file scope",
    nonGoals: ["Do not edit files outside the allowlist."],
    allowedFiles: ["src/helpers.js"],
    forbiddenFiles: ["src/forbidden.js"],
    acceptanceChecks: ["Changes stay inside src/helpers.js."],
    stopConditions: ["Stop if additional files are required."],
    contextFiles: ["README.md"],
    commands: ["node --check src/helpers.js"]
  };

  return createTaskPacket({
    ...base,
    ...overrides
  });
}

function successResultForRequest(request, overrides = {}) {
  const changedFiles = request.role === "implementer" ? [request.allowedFiles[0]] : [];
  return {
    status: "success",
    summary: `${request.role} completed the bounded packet.`,
    changedFiles,
    commandsRun: [...request.commands],
    evidence: [`role=${request.role}`],
    openQuestions: [],
    ...overrides
  };
}

test("writer role claims allowlist files and releases claims after completion", async () => {
  const claimRegistry = createFileClaimRegistry();
  const claimSnapshots = [];
  const runner = createPiWorkerRunner({
    claimRegistry,
    adapter: {
      async runWorker(request) {
        claimSnapshots.push(claimRegistry.snapshot());
        return successResultForRequest(request);
      }
    }
  });

  const result = await runner.run(createPacket("implementer"), {
    workflowId: "workflow-test"
  });

  assert.equal(result.status, "success");
  assert.equal(claimSnapshots.length, 1);
  assert.deepEqual(
    claimSnapshots[0].map((entry) => entry.file),
    ["src/helpers.js"]
  );
  assert.equal(claimRegistry.snapshot().length, 0);
});

test("second writer is blocked while an overlapping file claim is active", async () => {
  const claimRegistry = createFileClaimRegistry();
  let adapterCallCount = 0;
  let releaseFirstRun;
  let markFirstRunStarted;
  const firstRunStarted = new Promise((resolve) => {
    markFirstRunStarted = resolve;
  });

  const firstRunGate = new Promise((resolve) => {
    releaseFirstRun = resolve;
  });

  const runner = createPiWorkerRunner({
    claimRegistry,
    adapter: {
      async runWorker(request) {
        adapterCallCount += 1;
        if (adapterCallCount === 1) {
          markFirstRunStarted();
          await firstRunGate;
        }
        return successResultForRequest(request);
      }
    }
  });

  const firstRunPromise = runner.run(createPacket("implementer", {
    id: "implementer-first"
  }), {});
  await firstRunStarted;

  const blockedResult = await runner.run(createPacket("implementer", {
    id: "implementer-second"
  }), {});

  assert.equal(blockedResult.status, "blocked");
  assert.match(blockedResult.summary, /already claimed/i);
  assert.equal(adapterCallCount, 1);

  releaseFirstRun();
  const firstResult = await firstRunPromise;
  assert.equal(firstResult.status, "success");
  assert.equal(claimRegistry.snapshot().length, 0);
});

test("read-only roles do not claim files before execution", async () => {
  const claimRegistry = createFileClaimRegistry();
  const snapshots = [];
  const runner = createPiWorkerRunner({
    claimRegistry,
    adapter: {
      async runWorker(request) {
        snapshots.push(claimRegistry.snapshot());
        return successResultForRequest(request, {
          changedFiles: []
        });
      }
    }
  });

  const result = await runner.run(createPacket("explorer"), {});

  assert.equal(result.status, "success");
  assert.deepEqual(snapshots, [[]]);
  assert.equal(claimRegistry.snapshot().length, 0);
});

test("runner builds the expected worker request payload", async () => {
  let capturedRequest;
  const runner = createPiWorkerRunner({
    adapter: {
      async runWorker(request) {
        capturedRequest = request;
        return successResultForRequest(request);
      }
    }
  });

  const packet = createPacket("implementer", {
    goal: "Implement bounded helper rename",
    allowedFiles: ["src/helpers.js", "src/utils.js"],
    forbiddenFiles: ["src/forbidden.js", "src/generated.js"],
    contextFiles: ["README.md", "docs/OPERATING-GUIDE.md"],
    acceptanceChecks: ["helper rename compiles", "tests pass"],
    stopConditions: ["stop on scope drift"],
    commands: ["node --check src/helpers.js", "node --test --test-isolation=none"]
  });
  const context = {
    workflowId: "workflow-check",
    priorResults: [{ role: "explorer", status: "success" }]
  };

  const result = await runner.run(packet, context);

  assert.equal(result.status, "success");
  assert.equal(capturedRequest.role, "implementer");
  assert.equal(capturedRequest.goal, "Implement bounded helper rename");
  assert.deepEqual(capturedRequest.allowedFiles, ["src/helpers.js", "src/utils.js"]);
  assert.deepEqual(capturedRequest.forbiddenFiles, ["src/forbidden.js", "src/generated.js"]);
  assert.deepEqual(capturedRequest.contextFiles, ["README.md", "docs/OPERATING-GUIDE.md"]);
  assert.deepEqual(capturedRequest.acceptanceChecks, ["helper rename compiles", "tests pass"]);
  assert.deepEqual(capturedRequest.stopConditions, ["stop on scope drift"]);
  assert.deepEqual(capturedRequest.commands, ["node --check src/helpers.js", "node --test --test-isolation=none"]);
  assert.equal(capturedRequest.controls.noRecursiveDelegation, true);
  assert.equal(capturedRequest.controls.writePolicy, "allowlist_only");
  assert.equal(capturedRequest.modelProfile.model, "gpt-5.3-codex-spark");
  assert.deepEqual(capturedRequest.context, context);
});

test("adapter response maps back into a valid worker result", async () => {
  const runner = createPiWorkerRunner({
    adapter: {
      async runWorker(request) {
        return {
          result: successResultForRequest(request)
        };
      }
    }
  });

  const result = await runner.run(createPacket("implementer"), {});

  assert.equal(result.status, "success");
  assert.equal(result.summary, "implementer completed the bounded packet.");
  assert.deepEqual(result.changedFiles, ["src/helpers.js"]);
  assert.deepEqual(result.openQuestions, []);
});

test("runner handles non-cloneable context values without crashing", async () => {
  let capturedRuntimeContext;
  const runner = createPiWorkerRunner({
    adapter: {
      async runWorker(request, runtimeContext) {
        capturedRuntimeContext = runtimeContext;
        return successResultForRequest(request);
      }
    }
  });

  const result = await runner.run(createPacket("implementer"), {
    workflowId: "workflow-with-function-context",
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
  assert.equal(calls[0].context.workflowId, "workflow-with-function-context");
  assert.equal(typeof calls[0].context.callbacks.onComplete, "string");
  assert.match(calls[0].context.callbacks.onComplete, /uncloneable/i);

  assert.equal(capturedRuntimeContext.context.workflowId, "workflow-with-function-context");
  assert.equal(typeof capturedRuntimeContext.context.callbacks.onComplete, "string");
  assert.match(capturedRuntimeContext.context.callbacks.onComplete, /uncloneable/i);
});

test("runner rejects write claims for read-only roles", async () => {
  const runner = createPiWorkerRunner({
    adapter: {
      async runWorker(request) {
        return successResultForRequest(request, {
          changedFiles: ["src/helpers.js"]
        });
      }
    }
  });

  const result = await runner.run(createPacket("reviewer"), {});

  assert.equal(result.status, "failed");
  assert.match(result.summary, /read-only/i);
});

test("runner rejects writer changes outside of the allowlist", async () => {
  const runner = createPiWorkerRunner({
    adapter: {
      async runWorker(request) {
        return successResultForRequest(request, {
          changedFiles: ["src/other-file.js"]
        });
      }
    }
  });

  const result = await runner.run(createPacket("implementer"), {});

  assert.equal(result.status, "failed");
  assert.match(result.summary, /outside its allowlist/i);
});

test("runner accepts nested writes under a directory scope", async () => {
  const runner = createPiWorkerRunner({
    adapter: {
      async runWorker(request) {
        return successResultForRequest(request, {
          changedFiles: ["docs/guide.md"]
        });
      }
    }
  });

  const result = await runner.run(createPacket("implementer", {
    allowedFiles: ["docs/"],
    forbiddenFiles: []
  }), {});

  assert.equal(result.status, "success");
  assert.deepEqual(result.changedFiles, ["docs/guide.md"]);
});

test("claim registry blocks overlapping directory and file claims in both directions", () => {
  const directoryFirstRegistry = createFileClaimRegistry();
  const directoryFirstClaim = directoryFirstRegistry.claimMany(["docs/"], "writer-a");
  assert.equal(directoryFirstClaim.ok, true);

  const fileAfterDirectoryClaim = directoryFirstRegistry.claimMany(["docs/guide.md"], "writer-b");
  assert.equal(fileAfterDirectoryClaim.ok, false);
  assert.equal(fileAfterDirectoryClaim.conflicts[0].owner, "writer-a");
  assert.equal(fileAfterDirectoryClaim.conflicts[0].file, "docs/");

  const fileFirstRegistry = createFileClaimRegistry();
  const fileFirstClaim = fileFirstRegistry.claimMany(["docs/guide.md"], "writer-a");
  assert.equal(fileFirstClaim.ok, true);

  const directoryAfterFileClaim = fileFirstRegistry.claimMany(["docs/"], "writer-b");
  assert.equal(directoryAfterFileClaim.ok, false);
  assert.equal(directoryAfterFileClaim.conflicts[0].owner, "writer-a");
  assert.equal(directoryAfterFileClaim.conflicts[0].file, "docs/guide.md");
});

test("runner treats ./ and non-./ scoped paths as equivalent", async () => {
  const runner = createPiWorkerRunner({
    adapter: {
      async runWorker(request) {
        return successResultForRequest(request, {
          changedFiles: ["src/helpers.js"]
        });
      }
    }
  });

  const result = await runner.run(createPacket("implementer", {
    allowedFiles: ["./src/helpers.js"],
    forbiddenFiles: ["./src/forbidden.js"]
  }), {});

  assert.equal(result.status, "success");
  assert.deepEqual(result.changedFiles, ["src/helpers.js"]);
});

test("runAutoWorkflow executes through the Pi-backed runner with a fake adapter", async () => {
  const requestedRoles = [];
  const runner = createPiWorkerRunner({
    adapter: {
      async runWorker(request) {
        requestedRoles.push(request.role);
        return successResultForRequest(request);
      }
    }
  });

  const execution = await runAutoWorkflow({
    goal: "Rename one helper in a local file",
    allowedFiles: ["src/helpers.js"],
    maxRepairLoops: 1
  }, { runner });

  assert.equal(execution.status, "success");
  assert.deepEqual(requestedRoles, ["implementer", "verifier"]);
  assert.equal(execution.runs.length, 2);
});
