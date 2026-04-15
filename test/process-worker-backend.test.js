import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTaskPacket, validateWorkerResult } from "../src/contracts.js";
import {
  createPiCliLauncher,
  createProcessRoleArgsBuilder,
  createProcessWorkerBackend,
  loadRoleContractGuidance,
  PROCESS_WORKER_PROVIDER_ID,
  PROCESS_WORKER_ROLE_PROFILES
} from "../src/process-worker-backend.js";

function createPacket(role = "implementer", overrides = {}) {
  return createTaskPacket({
    id: `process-${role}-packet`,
    parentTaskId: "process-backend-test",
    role,
    risk: "low",
    goal: "Process worker bounded execution task",
    nonGoals: ["Do not edit files outside the allowlist."],
    allowedFiles: ["test/fixtures/process-worker-output.md"],
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

function createRoleProfilesWithOverrides(overrides = {}) {
  return {
    explorer: {
      ...PROCESS_WORKER_ROLE_PROFILES.explorer,
      ...(overrides.explorer ?? {})
    },
    implementer: {
      ...PROCESS_WORKER_ROLE_PROFILES.implementer,
      ...(overrides.implementer ?? {})
    },
    reviewer: {
      ...PROCESS_WORKER_ROLE_PROFILES.reviewer,
      ...(overrides.reviewer ?? {})
    },
    verifier: {
      ...PROCESS_WORKER_ROLE_PROFILES.verifier,
      ...(overrides.verifier ?? {})
    }
  };
}

function createPromptCaptureLauncher({ prompts, runCommandFn, launcherOptions = {} } = {}) {
  const resolvedRunCommandFn = runCommandFn ?? (async ({ command, args, cwd }) => ({
    command,
    args,
    cwd,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "ok",
    stderr: "",
    error: null,
    durationMs: 1
  }));

  return createPiCliLauncher({
    argsBuilder: async ({ prompt }) => {
      prompts.push(prompt);
      return ["-p", "--no-session", "--thinking", "off", prompt];
    },
    spawnCommandResolver: async () => ({
      command: process.execPath,
      argsPrefix: [],
      launcher: "test_launcher",
      launcherPath: process.execPath,
      piScriptPath: "C:/fake/pi.js",
      piPackageRoot: "C:/fake",
      resolutionMessage: "test resolution"
    }),
    runCommandFn: resolvedRunCommandFn,
    ...launcherOptions
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
          stdout: "created process output",
          stderr: "",
          commandsRun: ["fake-worker --write-output"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "process-test-workflow"
    });

    validateWorkerResult(result);
    assert.equal(result.status, "success");
    assert.deepEqual(result.changedFiles, ["test/fixtures/process-worker-output.md"]);
    assert.deepEqual(result.commandsRun, ["fake-worker --write-output"]);
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
          stdout: "created process output",
          stderr: "",
          commandsRun: ["fake-worker --write-output"]
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
          stdout: "created process output",
          stderr: "",
          commandsRun: ["fake-worker --write-output"]
        };
      }
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "process-test-workflow"
    });

    assert.equal(result.status, "success");
    const repoFile = await readFile(join(repositoryRoot, "test", "fixtures", "process-worker-output.md"), "utf8");
    assert.equal(repoFile, "updated from process backend");
    assert.equal(
      result.evidence.includes("repository_changes_applied: true"),
      true
    );
    assert.deepEqual(result.changedSurfaceObservation, {
      capture: "complete",
      paths: ["test/fixtures/process-worker-output.md"]
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process backend marks no-op implementer success as not applied while still reporting observed empty changed surface", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-noop-"));

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: async () => ({
        launcher: "fake_launcher",
        exitCode: 0,
        stdout: "no-op run",
        stderr: "",
        commandsRun: ["fake-worker --noop"]
      })
    });

    const result = await backend.run(createPacket("implementer"), {
      workflowId: "process-test-workflow-noop"
    });

    assert.equal(result.status, "success");
    assert.deepEqual(result.changedFiles, []);
    assert.equal(
      result.evidence.includes("repository_changes_applied: false"),
      true
    );
    assert.deepEqual(result.changedSurfaceObservation, {
      capture: "complete",
      paths: []
    });
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
      workflowId: "process-test-workflow"
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
        goal: "Inspect the scoped codebase context for this task and report what the implementer should change: Create test/fixtures/model-evidence-target.md containing exactly MODEL EVIDENCE TARGET OK and stop.",
        allowedFiles: ["test/fixtures/model-evidence-target.md"]
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
      /ORIGINAL_IMPLEMENTER_TASK: Inspect the scoped codebase context for this task and report what the implementer should change: Create test\/fixtures\/model-evidence-target\.md containing exactly MODEL EVIDENCE TARGET OK and stop\./i
    );
    assert.match(
      capturedPrompt,
      /If an allowed target file does not exist yet, report that fact and describe what the implementer should create/i
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("launcher prompt includes advisory common and role-specific contract guidance for each worker role", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-role-contract-prompts-"));
  const roleExpectations = [
    {
      role: "explorer",
      snippets: [
        /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/EXPLORER\.md/u,
        /Roles define what a worker may do, may not do, must prove, and when it must stop\./iu,
        /explorer is a read-only repo-understanding role\./iu,
        /Fail closed on ambiguity about correctness, scope, authority, or evidence\./iu,
        /open-ended planning or implementation advice when a factual answer is enough/iu,
        /Return exactly one JSON object using the enforced worker-result schema fields: status, summary, evidence, and openQuestions\./iu,
        /the smallest useful follow-up read, check, or handoff when one is needed\./iu
      ],
      legacyAbsent: [
        /\banswer\b:\s*the bounded factual answer to the repo question/iu,
        /\bevidence_refs\b/iu,
        /\bopen_uncertainties\b/iu,
        /\brecommended_next_step\b/iu
      ]
    },
    {
      role: "implementer",
      snippets: [
        /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/IMPLEMENTER\.md/u,
        /Roles define what a worker may do, may not do, must prove, and when it must stop\./iu,
        /implementer is the write-capable execution role for an approved slice\./iu,
        /semantic correctness/iu,
        /durability/iu,
        /Prefer the smallest sufficient correct change, not the smallest diff\./iu,
        /Treat markdown guidance as advisory behavior shaping, not as permission to bypass code-enforced policy\./iu,
        /Fix the root cause when it is visible and safely in scope\./iu,
        /what_was_verified: the tests, checks, or inspections actually performed/iu
      ]
    },
    {
      role: "reviewer",
      snippets: [
        /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/REVIEWER\.md/u,
        /Roles define what a worker may do, may not do, must prove, and when it must stop\./iu,
        /reviewer is a read-only ship or no-ship judgment role\./iu,
        /Attack the patch at the layer where it can fail: behavior, contracts, persistence, validation, operator surface, and maintainability\./iu,
        /the fix is at the wrong layer/iu,
        /Return exactly one JSON object using the enforced worker-result schema fields: status, summary, evidence, and openQuestions\./iu,
        /status: use success when no grounded finding requires repair and the inspected evidence is sufficient for the scoped claim; use repair_required when at least one grounded finding means the change should not ship yet; use blocked when the review cannot be completed honestly because required evidence is missing or the claim cannot be checked\./iu
      ],
      legacyAbsent: [
        /\bPASS\b/u,
        /\bREPAIR_REQUIRED\b/u,
        /\bBLOCKED\b/u
      ]
    },
    {
      role: "verifier",
      snippets: [
        /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/VERIFIER\.md/u,
        /Roles define what a worker may do, may not do, must prove, and when it must stop\./iu,
        /verifier is a proof and evidence-sufficiency role\./iu,
        /The verifier answers "was this demonstrated\?" not "should this ship\?"/iu,
        /In evidence, include commands_run: \.\.\. with the exact commands actually executed, or not run\./iu,
        /Current v1 now persists a narrow first-class reviewability object/iu,
        /Current v1 still does not persist a first-class providerModelEvidenceRequired field\./iu,
        /Return exactly one JSON object using the enforced worker-result schema fields: status, summary, evidence, and openQuestions\./iu,
        /summary: the short verification outcome, including whether the claim was demonstrated, disproved, or remains unproven\./iu
      ],
      legacyAbsent: [
        /\bverified\b/u,
        /\bnot_verified\b/u,
        /\bpartially_verified\b/u
      ]
    }
  ];

  try {
    for (const { role, snippets, legacyAbsent = [] } of roleExpectations) {
      const prompts = [];
      const launcher = createPromptCaptureLauncher({ prompts });

      await launcher({
        packet: createPacket(role),
        context: {},
        workspaceRoot
      });

      assert.equal(prompts.length, 1);
      assert.match(
        prompts[0],
        /These markdown contracts shape worker behavior only\. Code-enforced boundaries, status rules, and policy checks remain authoritative\./iu
      );

      if (role === "implementer") {
        assert.match(prompts[0], /Only modify files in ALLOWED_FILES\./iu);
        assert.match(
          prompts[0],
          /Keep changes task-scoped, but prefer the smallest sufficient correct change, not the smallest diff\./iu
        );
        assert.doesNotMatch(prompts[0], /Keep changes minimal and task-scoped\./iu);
      } else {
        assert.match(prompts[0], /Do not modify any files\./iu);
      }

      for (const snippet of snippets) {
        assert.match(prompts[0], snippet);
      }

      for (const legacySnippet of legacyAbsent) {
        assert.doesNotMatch(prompts[0], legacySnippet);
      }
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("process backend keeps implementer prompts usable when the advisory role doc is missing", async () => {
  const prompts = [];
  const backend = createProcessWorkerBackend({
    launcher: createPromptCaptureLauncher({
      prompts,
      launcherOptions: {
        roleContractGuidanceLoader: () => loadRoleContractGuidance({
          readFileFn: (url, encoding) => {
            if (String(url).endsWith("/IMPLEMENTER.md")) {
              throw new Error("advisory role doc missing");
            }

            return readFileSync(url, encoding);
          }
        })
      }
    })
  });

  const result = await backend.run(createPacket("implementer"), {
    workflowId: "implementer-missing-advisory-doc"
  });

  assert.equal(result.status, "success");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/IMPLEMENTER\.md/iu);
  assert.match(prompts[0], /Advisory doc status: docs\/agents\/IMPLEMENTER\.md fallback active \(advisory role doc missing\)\./iu);
  assert.match(
    prompts[0],
    /Work only inside ALLOWED_FILES, keep the change task-scoped, and stop after the scoped edit is complete\./iu
  );
  assert.match(prompts[0], /Treat markdown guidance as advisory behavior shaping, not as permission to bypass code-enforced policy\./iu);
  assert.match(prompts[0], /Only modify files in ALLOWED_FILES\./iu);
});

test("process backend keeps reviewer prompts usable when advisory common headings drift", async () => {
  const prompts = [];
  const backend = createProcessWorkerBackend({
    launcher: createPromptCaptureLauncher({
      prompts,
      runCommandFn: async ({ command, args, cwd }) => ({
        command,
        args,
        cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({
          status: "success",
          summary: "Fallback advisory guidance still produced a usable reviewer prompt.",
          evidence: ["Fallback guidance path exercised successfully."],
          openQuestions: []
        }),
        stderr: "",
        error: null,
        durationMs: 1
      }),
      launcherOptions: {
        roleContractGuidanceLoader: () => loadRoleContractGuidance({
          readFileFn: (url, encoding) => {
            const markdown = readFileSync(url, encoding);
            if (String(url).endsWith("/COMMON.md")) {
              return markdown.replace("## Output Discipline", "## Output Shape Drifted");
            }

            return markdown;
          }
        })
      }
    })
  });

  const result = await backend.run(createPacket("reviewer"), {
    workflowId: "reviewer-drifted-common-advisory-heading"
  });

  assert.equal(result.status, "success");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/REVIEWER\.md/iu);
  assert.match(prompts[0], /Advisory doc status: docs\/agents\/COMMON\.md fallback active \(missing markdown heading: Output Discipline\)\./iu);
  assert.match(
    prompts[0],
    /Treat missing advisory markdown as non-authoritative and rely on the enforced task scope plus direct repository evidence\./iu
  );
  assert.match(
    prompts[0],
    /Attack the patch at the layer where it can fail: behavior, contracts, persistence, validation, operator surface, and maintainability\./iu
  );
  assert.match(prompts[0], /Do not modify any files\./iu);
});

test("read-only retry prompt preserves role-contract guidance while enforcing strict JSON output", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-process-backend-readonly-retry-contracts-"));
  const prompts = [];
  let launchAttempt = 0;

  try {
    const backend = createProcessWorkerBackend({
      repositoryRoot,
      launcher: createPromptCaptureLauncher({
        prompts,
        runCommandFn: async ({ command, args, cwd }) => {
          launchAttempt += 1;
          return {
            command,
            args,
            cwd,
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: launchAttempt === 1
              ? "reviewer plain text output"
              : JSON.stringify({
                status: "repair_required",
                summary: "Retry produced structured reviewer output.",
                evidence: ["Structured retry output parsed successfully."],
                openQuestions: []
              }),
            stderr: "",
            error: null,
            durationMs: 1
          };
        }
      })
    });

    const result = await backend.run(createPacket("reviewer"), {
      workflowId: "reviewer-retry-contracts"
    });

    assert.equal(result.status, "repair_required");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Source docs: docs\/agents\/COMMON\.md, docs\/agents\/REVIEWER\.md/iu);
    assert.match(prompts[1], /Fail closed on ambiguity about correctness, scope, authority, or evidence\./iu);
    assert.match(prompts[1], /Attack the patch at the layer where it can fail: behavior, contracts, persistence, validation, operator surface, and maintainability\./iu);
    assert.match(prompts[1], /Output must be a single raw JSON object with no markdown, prose, or code fences\./iu);
    assert.match(prompts[1], /status: use success when no grounded finding requires repair and the inspected evidence is sufficient for the scoped claim; use repair_required when at least one grounded finding means the change should not ship yet; use blocked when the review cannot be completed honestly because required evidence is missing or the claim cannot be checked\./iu);
    assert.doesNotMatch(prompts[1], /\bPASS\b/u);
    assert.doesNotMatch(prompts[1], /\bREPAIR_REQUIRED\b/u);
    assert.doesNotMatch(prompts[1], /\bBLOCKED\b/u);
    assert.match(prompts[1], /PREVIOUS_INVALID_OUTPUT_SNIPPET:/iu);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("process role args builder probes custom preferred models and selects a custom preferred model", async () => {
  const customPreferredModel = "gpt-5.5-custom-implementer";
  const customFallbackModel = "gpt-5.5-custom-fallback";
  const roleProfiles = createRoleProfilesWithOverrides({
    implementer: {
      preferredModel: customPreferredModel
    }
  });
  const expectedPreferredModels = Object.values(roleProfiles).map((profile) => profile.preferredModel);
  const probeRequests = [];
  const argsBuilder = createProcessRoleArgsBuilder({
    roleProfiles,
    fallbackModel: customFallbackModel,
    modelProbe: async ({ providerId, candidateModels }) => {
      probeRequests.push({
        providerId,
        candidateModels: [...candidateModels]
      });
      return {
        providerId,
        supportedModels: [customPreferredModel, customFallbackModel],
        blockedReason: null
      };
    }
  });

  const { args, launchSelection } = await argsBuilder({
    packet: createPacket("implementer"),
    prompt: "Custom preferred probe selection",
    workspaceRoot: "/tmp/work"
  });

  assert.equal(probeRequests.length, 1);
  for (const model of expectedPreferredModels) {
    assert.equal(probeRequests[0].candidateModels.includes(model), true);
  }
  assert.equal(probeRequests[0].candidateModels.includes(customFallbackModel), true);
  assert.equal(args[args.indexOf("--model") + 1], customPreferredModel);
  assert.equal(launchSelection.selectedModel, customPreferredModel);
  assert.equal(launchSelection.modelSelectionMode, "direct");
});

test("process role args builder probes custom fallback model and selects fallback when preferred is unavailable", async () => {
  const customPreferredModel = "gpt-5.5-custom-unavailable";
  const customFallbackModel = "gpt-5.5-custom-fallback";
  const roleProfiles = createRoleProfilesWithOverrides({
    implementer: {
      preferredModel: customPreferredModel
    }
  });
  let observedCandidateModels = [];
  const argsBuilder = createProcessRoleArgsBuilder({
    roleProfiles,
    fallbackModel: customFallbackModel,
    modelProbe: async ({ providerId, candidateModels }) => {
      observedCandidateModels = [...candidateModels];
      return {
        providerId,
        supportedModels: [customFallbackModel],
        blockedReason: null
      };
    }
  });

  const { args, launchSelection } = await argsBuilder({
    packet: createPacket("implementer"),
    prompt: "Custom fallback probe selection",
    workspaceRoot: "/tmp/work"
  });

  assert.equal(observedCandidateModels.includes(customPreferredModel), true);
  assert.equal(observedCandidateModels.includes(customFallbackModel), true);
  assert.equal(args[args.indexOf("--model") + 1], customFallbackModel);
  assert.equal(launchSelection.selectedModel, customFallbackModel);
  assert.equal(launchSelection.modelSelectionMode, "fallback");
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
    context: { workflowId: "process-workflow" },
    workspaceRoot: "/tmp/work",
    targetRelativePath: "test/fixtures/process-worker-output.md",
    targetContent: "PROCESS WORKER OUTPUT OK"
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
