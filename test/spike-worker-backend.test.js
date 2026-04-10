import assert from "node:assert/strict";
import { dirname } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTaskPacket, validateWorkerResult } from "../src/contracts.js";
import {
  createPiCliLauncher
} from "../src/spike-worker-backend.js";
import { createProcessWorkerBackend } from "../src/process-worker-backend.js";

function createPacket(role = "implementer", overrides = {}) {
  return createTaskPacket({
    id: `spike-${role}-packet`,
    parentTaskId: "spike-backend-test",
    role,
    risk: "low",
    goal: "Spike worker bounded smoke task",
    nonGoals: ["Do not edit files outside the allowlist."],
    allowedFiles: ["examples/smoke-worker-output.md"],
    forbiddenFiles: [],
    acceptanceChecks: ["The allowed file contains exact deterministic content."],
    stopConditions: ["Stop if the worker launcher cannot execute."],
    contextFiles: [],
    commands: [],
    ...overrides
  });
}

test("process backend blocks cleanly for unsupported roles", async () => {
  let launchCount = 0;
  const backend = createProcessWorkerBackend({
    launcher: async () => {
      launchCount += 1;
      return {
        exitCode: 0
      };
    }
  });

  const result = await backend.run(createPacket("orchestrator"), {});

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /unsupported role/i);
  assert.equal(launchCount, 0);
});

test("process backend blocks cleanly for malformed packets", async () => {
  let launchCount = 0;
  const backend = createProcessWorkerBackend({
    launcher: async () => {
      launchCount += 1;
      return {
        exitCode: 0
      };
    }
  });

  const result = await backend.run({
    role: "implementer"
  }, {});

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /invalid packet/i);
  assert.equal(launchCount, 0);
});

test("process backend maps launcher output into a contract-compatible worker result", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-contract-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ targetAbsolutePath }) => {
        await mkdir(dirname(targetAbsolutePath), { recursive: true });
        await writeFile(targetAbsolutePath, "updated from process backend", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "created smoke output",
          stderr: "",
          commandsRun: ["fake-worker --write-smoke"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "spike-test-workflow"
    });

    validateWorkerResult(result);
    assert.equal(result.status, "success");
    assert.deepEqual(result.changedFiles, ["examples/smoke-worker-output.md"]);
    assert.deepEqual(result.commandsRun, ["fake-worker --write-smoke"]);
    assert.equal(result.openQuestions.length, 0);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend applies implementer changes back to the repository root on success", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-repo-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ targetAbsolutePath }) => {
        await mkdir(dirname(targetAbsolutePath), { recursive: true });
        await writeFile(targetAbsolutePath, "updated from process backend", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "created smoke output",
          stderr: "",
          commandsRun: ["fake-worker --write-smoke"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "spike-test-workflow"
    });

    assert.equal(result.status, "success");
    const repoFile = await readFile(join(repositoryRoot, "examples", "smoke-worker-output.md"), "utf8");
    assert.equal(repoFile, "updated from process backend");
    assert.equal(
      result.evidence.includes("repository_changes_applied: true"),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend maps reviewer JSON output to repair_required without file changes", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-reviewer-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async () => ({
        launcher: "fake_launcher",
        exitCode: 0,
        stdout: JSON.stringify({
          status: "repair_required",
          summary: "Missing a targeted regression test.",
          evidence: ["No regression test command was present."],
          openQuestions: ["Should the fix add a unit test or an integration test?"]
        }),
        stderr: "",
        commandsRun: ["fake-worker --review"]
      })
    });

    const result = await backend.run(createPacket("reviewer"), {
      workflowId: "reviewer-test-workflow"
    });

    validateWorkerResult(result);
    assert.equal(result.status, "repair_required");
    assert.equal(result.changedFiles.length, 0);
    assert.match(result.summary, /missing a targeted regression test/i);
    assert.equal(
      result.evidence.includes("No regression test command was present."),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("pi launcher command evidence uses resolved pi script path in non-interactive mode", async () => {
  const launcher = createPiCliLauncher({
    spawnCommandResolver: async () => ({
      command: "node",
      argsPrefix: ["/tmp/pi/dist/pi.js"],
      launcher: "pi_script_via_node",
      launcherPath: "node",
      piScriptPath: "/tmp/pi/dist/pi.js",
      piPackageRoot: "/tmp/pi",
      resolutionMessage: "pi bin resolved from /tmp/pi/package.json"
    }),
    runCommandFn: async ({ command, args, cwd }) => ({
      command,
      args,
      cwd,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "ok",
      stderr: "",
      error: null,
      durationMs: 2
    })
  });

  const result = await launcher({
    packet: createPacket("implementer"),
    context: { workflowId: "spike-workflow" },
    workspaceRoot: "/tmp/work",
    targetRelativePath: "examples/smoke-worker-output.md",
    targetContent: "SMOKE TEST OK"
  });

  assert.equal(result.launcher, "pi_script_via_node");
  assert.equal(result.launcherPath, "node");
  assert.equal(result.piScriptPath, "/tmp/pi/dist/pi.js");
  assert.equal(result.commandsRun.length, 1);
  assert.match(result.commandsRun[0], /^node \/tmp\/pi\/dist\/pi\.js -p --no-session /u);
  assert.doesNotMatch(result.commandsRun[0], /\bcodex\b/u);
});

test("pi launcher blocks when script resolution falls back to an unresolved command", async () => {
  const launcher = createPiCliLauncher({
    spawnCommandResolver: async () => ({
      command: "pi",
      argsPrefix: [],
      launcher: "pi_cli_fallback",
      launcherPath: "pi",
      piScriptPath: null,
      piPackageRoot: null,
      resolutionMessage: "pi package resolution unavailable"
    })
  });

  const result = await launcher({
    packet: createPacket("implementer"),
    context: {},
    workspaceRoot: "/tmp/work"
  });

  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /script path was not resolved/i);
});
