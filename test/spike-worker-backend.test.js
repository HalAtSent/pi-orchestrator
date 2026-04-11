import assert from "node:assert/strict";
import { dirname } from "node:path";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTaskPacket, validateWorkerResult } from "../src/contracts.js";
import {
  createPiCliLauncher
} from "../src/spike-worker-backend.js";
import {
  createProcessWorkerBackend,
  PROCESS_WORKER_PROVIDER_ID
} from "../src/process-worker-backend.js";

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

async function exists(pathValue) {
  try {
    await access(pathValue);
    return true;
  } catch {
    return false;
  }
}

function normalizeFilePath(pathValue) {
  return String(pathValue).replace(/\\/g, "/");
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

test("process backend handles non-cloneable context values without crashing", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-non-cloneable-context-"));

  try {
    let capturedContext;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ targetAbsolutePath, context }) => {
        capturedContext = context;

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
      workflowId: "workflow-with-function-context",
      callbacks: {
        onComplete() {
          return "done";
        }
      }
    });

    validateWorkerResult(result);
    assert.equal(result.status, "success");

    const calls = backend.getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].context.workflowId, "workflow-with-function-context");
    assert.equal(typeof calls[0].context.callbacks.onComplete, "string");
    assert.match(calls[0].context.callbacks.onComplete, /uncloneable/i);

    assert.equal(capturedContext.workflowId, "workflow-with-function-context");
    assert.equal(typeof capturedContext.callbacks.onComplete, "string");
    assert.match(capturedContext.callbacks.onComplete, /uncloneable/i);
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

test("process backend rolls back repository writes when apply fails mid-commit", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-atomic-"));

  try {
    await mkdir(join(repositoryRoot, "examples"), { recursive: true });
    await writeFile(join(repositoryRoot, "examples", "a.md"), "repo a original", "utf8");
    await writeFile(join(repositoryRoot, "examples", "b.md"), "repo b original", "utf8");

    let stagedMoveCount = 0;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      moveFileFn: async (sourcePath, destinationPath) => {
        const source = normalizeFilePath(sourcePath);
        const destination = normalizeFilePath(destinationPath);
        const isStagedWriteIntoRepo = source.includes("/.pi-orchestrator-apply-")
          && source.includes("/staged/")
          && destination.includes("/examples/");

        if (isStagedWriteIntoRepo) {
          stagedMoveCount += 1;
          if (stagedMoveCount === 2) {
            throw new Error("simulated mid-apply failure");
          }
        }

        await rename(sourcePath, destinationPath);
      },
      launcher: async ({ workspaceRoot }) => {
        await mkdir(join(workspaceRoot, "examples"), { recursive: true });
        await writeFile(join(workspaceRoot, "examples", "a.md"), "repo a updated", "utf8");
        await writeFile(join(workspaceRoot, "examples", "b.md"), "repo b updated", "utf8");
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: "updated two files",
          stderr: "",
          commandsRun: ["fake-worker --write-two-files"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["examples/a.md", "examples/b.md"]
    }), {
      workflowId: "spike-test-workflow"
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /failed to apply changed files atomically/i);

    const repoA = await readFile(join(repositoryRoot, "examples", "a.md"), "utf8");
    const repoB = await readFile(join(repositoryRoot, "examples", "b.md"), "utf8");
    assert.equal(repoA, "repo a original");
    assert.equal(repoB, "repo b original");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend seeds file scope entries into the isolated workspace", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-seed-file-"));

  try {
    const expectedContent = "export const seeded = true;\n";
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await writeFile(join(repositoryRoot, "src", "seeded-file.js"), expectedContent, "utf8");

    let seededContent = null;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ workspaceRoot }) => {
        seededContent = await readFile(join(workspaceRoot, "src", "seeded-file.js"), "utf8");
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --inspect-seeded-file"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["src/seeded-file.js"]
    }), {});

    assert.equal(result.status, "success");
    assert.equal(seededContent, expectedContent);
    assert.equal(result.evidence.includes("copied_seed_files: src/seeded-file.js"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend seeds directory scope entries into the isolated workspace", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-seed-dir-"));

  try {
    await mkdir(join(repositoryRoot, "docs", "nested"), { recursive: true });
    await writeFile(join(repositoryRoot, "docs", "guide.md"), "guide content", "utf8");
    await writeFile(join(repositoryRoot, "docs", "nested", "notes.md"), "nested notes", "utf8");

    let guideContent = null;
    let nestedContent = null;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ workspaceRoot }) => {
        guideContent = await readFile(join(workspaceRoot, "docs", "guide.md"), "utf8");
        nestedContent = await readFile(join(workspaceRoot, "docs", "nested", "notes.md"), "utf8");
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --inspect-seeded-directory"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["docs/"]
    }), {});

    assert.equal(result.status, "success");
    assert.equal(guideContent, "guide content");
    assert.equal(nestedContent, "nested notes");
    assert.equal(result.evidence.includes("copied_seed_files: docs/"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend reports missing directory scope seeds without failing", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-missing-dir-"));

  try {
    let docsDirectoryExistsInWorkspace = true;
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ workspaceRoot }) => {
        docsDirectoryExistsInWorkspace = await exists(join(workspaceRoot, "docs"));
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --inspect-missing-directory-seed"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["docs/"]
    }), {});

    assert.equal(result.status, "success");
    assert.equal(docsDirectoryExistsInWorkspace, false);
    assert.equal(result.evidence.includes("missing_seed_files: docs/"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend accepts nested changed files when allowlist contains a directory scope", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-dir-allowlist-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ workspaceRoot }) => {
        await mkdir(join(workspaceRoot, "docs"), { recursive: true });
        await writeFile(join(workspaceRoot, "docs", "guide.md"), "updated guide", "utf8");
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          commandsRun: ["fake-worker --write-docs-guide"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer", {
      allowedFiles: ["docs/"]
    }), {});

    assert.equal(result.status, "success");
    assert.deepEqual(result.changedFiles, ["docs/guide.md"]);
    const repoGuide = await readFile(join(repositoryRoot, "docs", "guide.md"), "utf8");
    assert.equal(repoGuide, "updated guide");
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

test("process backend does not fail open for read-only plain-text output", async () => {
  const launchAttemptsByRole = new Map();
  const backend = createProcessWorkerBackend({
    launcher: async ({ packet }) => {
      const currentAttempt = (launchAttemptsByRole.get(packet.role) ?? 0) + 1;
      launchAttemptsByRole.set(packet.role, currentAttempt);

      return {
        launcher: "fake_launcher",
        exitCode: 0,
        stdout: `${packet.role} plain text output attempt ${currentAttempt}`,
        stderr: `attempt-${currentAttempt}-stderr`,
        commandsRun: [`fake-worker --${packet.role}`]
      };
    }
  });

  for (const role of ["explorer", "reviewer", "verifier"]) {
    const result = await backend.run(createPacket(role), {
      workflowId: `${role}-plain-text-output`
    });

    validateWorkerResult(result);
    assert.equal(result.status, "failed");
    assert.match(result.summary, /invalid structured read-only output/i);
    assert.equal(launchAttemptsByRole.get(role), 2);
    assert.equal(
      result.evidence.includes("read_only_json_repair_retry_attempted: true"),
      true
    );
    assert.equal(
      result.evidence.includes("read_only_structured_output_valid_first_attempt: false"),
      true
    );
    assert.equal(
      result.evidence.includes("read_only_structured_output_valid_retry_attempt: false"),
      true
    );
    assert.equal(
      result.evidence.includes("read_only_retry_failure_reason: first_and_retry_outputs_invalid_json"),
      true
    );
    assert.equal(
      result.evidence.some((entry) => entry.startsWith("stdout: ")),
      true
    );
    assert.equal(
      result.evidence.some((entry) => entry.startsWith("retry_stdout: ")),
      true
    );
    assert.equal(
      result.evidence.includes("read_only_structured_output_valid: false"),
      true
    );
  }
});

test("process backend converts invalid read-only first output into structured retry output", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-readonly-retry-success-"));
  let launchCount = 0;

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async ({ packet }) => {
        launchCount += 1;
        return {
          launcher: "fake_launcher",
          exitCode: 0,
          stdout: launchCount === 1
            ? `${packet.role} plain text output`
            : JSON.stringify({
              status: "repair_required",
              summary: "Retry produced structured reviewer output.",
              evidence: ["Structured retry output parsed successfully."],
              openQuestions: ["Should reviewer strict mode become the default?"]
            }),
          stderr: "",
          commandsRun: [`fake-worker --${packet.role}`]
        };
      }
    });

    const result = await backend.run(createPacket("reviewer"), {
      workflowId: "reviewer-retry-success"
    });

    validateWorkerResult(result);
    assert.equal(launchCount, 2);
    assert.equal(result.status, "repair_required");
    assert.match(result.summary, /retry produced structured reviewer output/i);
    assert.equal(
      result.evidence.includes("read_only_json_repair_retry_attempted: true"),
      true
    );
    assert.equal(
      result.evidence.includes("read_only_structured_output_source: retry_attempt"),
      true
    );
    assert.equal(
      result.evidence.includes("read_only_structured_output_valid: true"),
      true
    );
    assert.equal(
      result.evidence.some((entry) => entry.startsWith("retry_stdout: ")),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend does not retry implementer runs for structured output parsing", async () => {
  let launchCount = 0;
  const backend = createProcessWorkerBackend({
    launcher: async () => {
      launchCount += 1;
      return {
        launcher: "fake_launcher",
        exitCode: 0,
        stdout: "implementer plain text output",
        stderr: "",
        commandsRun: ["fake-worker --implementer"]
      };
    }
  });

  const result = await backend.run(createPacket("implementer"), {
    workflowId: "implementer-no-retry"
  });

  validateWorkerResult(result);
  assert.equal(result.status, "success");
  assert.equal(launchCount, 1);
  assert.equal(
    result.evidence.some((entry) => entry.startsWith("read_only_json_repair_retry_attempted:")),
    false
  );
});

test("explorer launcher prompt treats a missing target file as inspectable context", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-explorer-prompt-"));
  let capturedPrompt = null;

  try {
    const launcher = createPiCliLauncher({
      argsBuilder: async ({ prompt }) => {
        capturedPrompt = prompt;
        return ["-p", "--no-session", "--thinking", "off", prompt];
      },
      spawnCommandResolver: async () => ({
        command: process.execPath,
        argsPrefix: [],
        launcher: "test_launcher",
        launcherPath: process.execPath,
        piScriptPath: __filename,
        piPackageRoot: dirname(__filename),
        resolutionMessage: "test resolution"
      }),
      runCommandFn: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "{\"status\":\"success\",\"summary\":\"inspected\",\"evidence\":[],\"openQuestions\":[]}",
        stderr: ""
      })
    });

    await launcher({
      packet: createPacket("explorer", {
        risk: "high",
        goal: "Inspect the scoped codebase context for this task and report what the implementer should change: Create docs/specs/model-evidence-smoke.md containing exactly MODEL EVIDENCE SMOKE OK and stop.",
        allowedFiles: ["docs/specs/model-evidence-smoke.md"]
      }),
      context: {},
      workspaceRoot
    });

    assert.equal(typeof capturedPrompt, "string");
    assert.match(
      capturedPrompt,
      /YOUR_READ_ONLY_OBJECTIVE: Inspect the allowed scope, describe the relevant context, and tell the implementer what should be created or changed\./i
    );
    assert.match(
      capturedPrompt,
      /ORIGINAL_IMPLEMENTER_TASK: Inspect the scoped codebase context for this task and report what the implementer should change: Create docs\/specs\/model-evidence-smoke\.md containing exactly MODEL EVIDENCE SMOKE OK and stop\./i
    );
    assert.match(
      capturedPrompt,
      /If an allowed target file does not exist yet, report that fact and describe what the implementer should create/i
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("pi launcher command evidence uses resolved pi script path in non-interactive mode", async () => {
  const launcher = createPiCliLauncher({
    modelProbe: async () => ({
      providerId: PROCESS_WORKER_PROVIDER_ID,
      supportedModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
      blockedReason: null
    }),
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
  assert.doesNotMatch(result.commandsRun[0], /^codex\b/u);
});

test("process backend launcher passes explicit openai-codex provider and preferred role model when supported", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-launch-profile-role-direct-"));

  try {
    let launchedArgs = [];
    const launcher = createPiCliLauncher({
      modelProbe: async () => ({
        providerId: PROCESS_WORKER_PROVIDER_ID,
        supportedModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
        blockedReason: null
      }),
      spawnCommandResolver: async () => ({
        command: "node",
        argsPrefix: ["/tmp/pi/dist/pi.js"],
        launcher: "pi_script_via_node",
        launcherPath: "node",
        piScriptPath: "/tmp/pi/dist/pi.js",
        piPackageRoot: "/tmp/pi",
        resolutionMessage: "pi bin resolved from /tmp/pi/package.json"
      }),
      runCommandFn: async ({ command, args, cwd }) => {
        launchedArgs = args;
        return {
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
        };
      }
    });

    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "direct-launch-profile-test"
    });

    assert.equal(result.status, "success");
    assert.equal(launchedArgs.includes("--provider"), true);
    assert.equal(launchedArgs.includes(PROCESS_WORKER_PROVIDER_ID), true);
    assert.equal(launchedArgs.includes("--model"), true);
    assert.equal(launchedArgs.includes("gpt-5.3-codex"), true);
    assert.equal(launchedArgs.includes("--thinking"), true);
    assert.equal(launchedArgs.includes("medium"), true);
    assert.equal(result.evidence.includes("provider_flag_passed: true"), true);
    assert.equal(result.evidence.includes(`provider_selection: ${PROCESS_WORKER_PROVIDER_ID}`), true);
    assert.equal(result.evidence.includes("model_flag_passed: true"), true);
    assert.equal(result.evidence.includes("model_selection: gpt-5.3-codex"), true);
    assert.equal(result.evidence.includes("requested_provider: openai-codex"), true);
    assert.equal(result.evidence.includes("requested_model: gpt-5.3-codex"), true);
    assert.equal(result.evidence.includes("selected_provider: openai-codex"), true);
    assert.equal(result.evidence.includes("selected_model: gpt-5.3-codex"), true);
    assert.equal(result.evidence.includes("model_selection_mode: direct"), true);
    assert.equal(result.evidence.includes("model_selection_reason: preferred_model_supported"), true);
    assert.equal(result.evidence.includes("effective_launcher_mode: explicit_provider_model_override"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend retry preserves explicit openai-codex provider/model selections", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-launch-profile-readonly-retry-"));
  const launchedArgs = [];
  let launchAttempt = 0;

  function readOptionValue(args, optionName) {
    const optionIndex = args.indexOf(optionName);
    if (optionIndex === -1) {
      return null;
    }

    return args[optionIndex + 1] ?? null;
  }

  try {
    const launcher = createPiCliLauncher({
      modelProbe: async () => ({
        providerId: PROCESS_WORKER_PROVIDER_ID,
        supportedModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
        blockedReason: null
      }),
      spawnCommandResolver: async () => ({
        command: "node",
        argsPrefix: ["/tmp/pi/dist/pi.js"],
        launcher: "pi_script_via_node",
        launcherPath: "node",
        piScriptPath: "/tmp/pi/dist/pi.js",
        piPackageRoot: "/tmp/pi",
        resolutionMessage: "pi bin resolved from /tmp/pi/package.json"
      }),
      runCommandFn: async ({ command, args, cwd }) => {
        launchAttempt += 1;
        launchedArgs.push([...args]);
        return {
          command,
          args,
          cwd,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: launchAttempt === 1
            ? "explorer plain text output"
            : JSON.stringify({
              status: "success",
              summary: "Structured retry output.",
              evidence: ["Retry response satisfied strict JSON contract."],
              openQuestions: []
            }),
          stderr: "",
          error: null,
          durationMs: 2
        };
      }
    });

    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("explorer"), {
      workflowId: "readonly-retry-launch-profile-test"
    });

    assert.equal(result.status, "success");
    assert.equal(launchedArgs.length, 2);
    assert.equal(readOptionValue(launchedArgs[0], "--provider"), PROCESS_WORKER_PROVIDER_ID);
    assert.equal(readOptionValue(launchedArgs[1], "--provider"), PROCESS_WORKER_PROVIDER_ID);
    assert.equal(readOptionValue(launchedArgs[0], "--model"), "gpt-5.4");
    assert.equal(readOptionValue(launchedArgs[1], "--model"), "gpt-5.4");
    assert.equal(readOptionValue(launchedArgs[0], "--thinking"), "high");
    assert.equal(readOptionValue(launchedArgs[1], "--thinking"), "high");
    assert.equal(
      result.evidence.includes("read_only_json_repair_retry_attempted: true"),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend falls back to gpt-5.4 when preferred role model is unavailable", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-launch-profile-role-fallback-"));

  try {
    const launcher = createPiCliLauncher({
      modelProbe: async () => ({
        providerId: PROCESS_WORKER_PROVIDER_ID,
        supportedModels: ["gpt-5.4", "gpt-5.4-mini"],
        blockedReason: null
      }),
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

    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "fallback-launch-profile-test"
    });

    assert.equal(result.status, "success");
    assert.equal(result.evidence.includes("model_selection: gpt-5.4"), true);
    assert.equal(result.evidence.includes("selected_model: gpt-5.4"), true);
    assert.equal(result.evidence.includes("model_selection_mode: fallback"), true);
    assert.equal(result.evidence.includes("model_selection_reason: preferred_model_unavailable"), true);
    assert.equal(
      result.evidence.some((entry) => /model_fallback_reason: preferred model unavailable: gpt-5\.3-codex; fallback model selected: gpt-5\.4/u.test(entry)),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend blocks cleanly when no valid openai-codex models can be resolved", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-launch-profile-role-blocked-"));

  try {
    const launcher = createPiCliLauncher({
      modelProbe: async () => ({
        providerId: PROCESS_WORKER_PROVIDER_ID,
        supportedModels: [],
        blockedReason: null
      }),
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

    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "blocked-launch-profile-test"
    });

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /launcher invocation failed/i);
    assert.equal(
      result.evidence.some((entry) => /launch_error: process backend blocked: no supported models resolved for provider openai-codex/i.test(entry)),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend evidence reports explicit provider/model selections when launcher args include overrides", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-launch-profile-explicit-"));

  try {
    const launcher = createPiCliLauncher({
      argsBuilder: ({ prompt }) => [
        "-p",
        "--no-session",
        "--provider",
        "openrouter",
        "--model",
        "openai/gpt-5",
        "--thinking",
        "high",
        prompt
      ],
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

    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "explicit-launch-profile-test"
    });

    assert.equal(result.status, "success");
    assert.equal(result.evidence.includes("provider_flag_passed: true"), true);
    assert.equal(result.evidence.includes("provider_selection: openrouter"), true);
    assert.equal(result.evidence.includes("model_flag_passed: true"), true);
    assert.equal(result.evidence.includes("model_selection: openai/gpt-5"), true);
    assert.equal(result.evidence.includes("thinking_flag_passed: true"), true);
    assert.equal(result.evidence.includes("thinking_selection: high"), true);
    assert.equal(result.evidence.includes("effective_launcher_mode: explicit_provider_model_override"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("pi launcher blocks when script resolution falls back to an unresolved command", async () => {
  const launcher = createPiCliLauncher({
    modelProbe: async () => ({
      providerId: PROCESS_WORKER_PROVIDER_ID,
      supportedModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
      blockedReason: null
    }),
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
