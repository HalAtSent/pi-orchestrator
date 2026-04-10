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
  const backend = createProcessWorkerBackend({
    launcher: async ({ packet }) => ({
      launcher: "fake_launcher",
      exitCode: 0,
      stdout: `${packet.role} plain text output`,
      stderr: "",
      commandsRun: [`fake-worker --${packet.role}`]
    })
  });

  for (const role of ["explorer", "reviewer", "verifier"]) {
    const result = await backend.run(createPacket(role), {
      workflowId: `${role}-plain-text-output`
    });

    validateWorkerResult(result);
    assert.equal(result.status, "failed");
    assert.match(result.summary, /invalid structured read-only output/i);
    assert.equal(
      result.evidence.includes("read_only_structured_output_valid: false"),
      true
    );
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
