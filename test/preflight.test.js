import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPreflightStopReason,
  PREFLIGHT_CHECK_IDS,
  runPreflight
} from "../src/preflight.js";

async function withTempRepo(callback, {
  packageJson = {
    name: "preflight-test-repo",
    type: "module",
    scripts: {
      test: "node --test"
    }
  }
} = {}) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-orchestrator-preflight-"));
  try {
    if (packageJson !== null) {
      await writeFile(
        join(repositoryRoot, "package.json"),
        `${JSON.stringify(packageJson, null, 2)}\n`,
        "utf8"
      );
    }
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await writeFile(join(repositoryRoot, "src", "helpers.js"), "export const value = 1;\n", "utf8");
    return await callback(repositoryRoot);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}

function checkById(result, id) {
  return result.checks.find((check) => check.id === id);
}

test("preflight passes with clean fake git, test script, safe scope, sandbox, and model probe", async () => {
  await withTempRepo(async (repositoryRoot) => {
    const sandboxCalls = [];
    const modelProbeCalls = [];
    const result = await runPreflight({
      repositoryRoot,
      plannedScopePaths: ["src/helpers.js"],
      gitStatus: async () => ({ available: true, stdout: "" }),
      processBackendRequired: true,
      processBackend: {
        async run() {},
        async checkSandboxAvailability() {
          sandboxCalls.push("called");
          return { available: true, reason: "fake sandbox available" };
        }
      },
      modelProbe: async (request) => {
        modelProbeCalls.push(request);
        return {
          providerId: request.providerId,
          candidateModels: request.candidateModels,
          supportedModels: ["gpt-5.5"],
          reason: "fake probe completed",
          blockedReason: null
        };
      }
    });

    assert.equal(result.status, "pass");
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.REPOSITORY_ROOT).status, "pass");
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.PACKAGE_TEST_SCRIPT).status, "pass");
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.GIT_WORKTREE).status, "pass");
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.PROTECTED_PATHS).status, "pass");
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.PROCESS_BACKEND).status, "pass");
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.PROCESS_SANDBOX).status, "pass");
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.MODEL_PROBE).status, "pass");
    assert.equal(sandboxCalls.length, 1);
    assert.equal(modelProbeCalls.length, 1);
  });
});

test("preflight warns for missing test script and dirty fake git state", async () => {
  await withTempRepo(async (repositoryRoot) => {
    const result = await runPreflight({
      repositoryRoot,
      plannedScopePaths: ["src/helpers.js"],
      gitStatus: async () => " M src/helpers.js\n?? test/preflight.test.js\n",
      processBackendRequired: false
    });

    assert.equal(result.status, "warning");
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.PACKAGE_TEST_SCRIPT).status, "warning");
    assert.match(checkById(result, PREFLIGHT_CHECK_IDS.PACKAGE_TEST_SCRIPT).reason, /scripts\.test/u);
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.GIT_WORKTREE).status, "warning");
    assert.deepEqual(
      checkById(result, PREFLIGHT_CHECK_IDS.GIT_WORKTREE).details.changedPaths,
      ["src/helpers.js", "test/preflight.test.js"]
    );
  }, {
    packageJson: {
      name: "preflight-test-repo",
      type: "module",
      scripts: {}
    }
  });
});

test("preflight blocks protected paths in planned scope with operator next action", async () => {
  await withTempRepo(async (repositoryRoot) => {
    const result = await runPreflight({
      repositoryRoot,
      plannedScopePaths: ["src/helpers.js", ".env"],
      gitStatus: async () => ({ available: true, stdout: "" }),
      processBackendRequired: false
    });

    assert.equal(result.status, "blocked");
    const protectedCheck = checkById(result, PREFLIGHT_CHECK_IDS.PROTECTED_PATHS);
    assert.equal(protectedCheck.status, "blocked");
    assert.match(protectedCheck.reason, /\.env/u);
    assert.match(protectedCheck.nextAction, /Remove protected path/u);
    assert.match(createPreflightStopReason(result), /protected_paths: Planned scope references protected path/u);
    assert.match(createPreflightStopReason(result), /Next action:/u);
  });
});

test("preflight blocks when a process backend is required but absent", async () => {
  await withTempRepo(async (repositoryRoot) => {
    const result = await runPreflight({
      repositoryRoot,
      plannedScopePaths: ["src/helpers.js"],
      gitStatus: async () => ({ available: true, stdout: "" }),
      processBackendRequired: true
    });

    assert.equal(result.status, "blocked");
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.PROCESS_BACKEND).status, "blocked");
    assert.match(checkById(result, PREFLIGHT_CHECK_IDS.PROCESS_BACKEND).reason, /required/u);
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.PROCESS_SANDBOX).status, "blocked");
  });
});

test("preflight blocks unavailable sandbox from fake process backend readiness probe", async () => {
  await withTempRepo(async (repositoryRoot) => {
    const result = await runPreflight({
      repositoryRoot,
      plannedScopePaths: ["src/helpers.js"],
      gitStatus: async () => ({ available: true, stdout: "" }),
      processBackendRequired: true,
      processBackend: {
        async run() {},
        async checkSandboxAvailability() {
          return {
            available: false,
            reason: "test sandbox provider missing"
          };
        }
      }
    });

    assert.equal(result.status, "blocked");
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.PROCESS_BACKEND).status, "pass");
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.PROCESS_SANDBOX).status, "blocked");
    assert.match(checkById(result, PREFLIGHT_CHECK_IDS.PROCESS_SANDBOX).reason, /test sandbox provider missing/u);
  });
});

test("preflight blocks when exposed model probe finds no supported model", async () => {
  await withTempRepo(async (repositoryRoot) => {
    const result = await runPreflight({
      repositoryRoot,
      plannedScopePaths: ["src/helpers.js"],
      gitStatus: async () => ({ available: true, stdout: "" }),
      processBackendRequired: false,
      modelProbe: async () => ({
        providerId: "openai-codex",
        candidateModels: ["gpt-5.5"],
        supportedModels: [],
        blockedReason: null
      })
    });

    assert.equal(result.status, "blocked");
    const modelCheck = checkById(result, PREFLIGHT_CHECK_IDS.MODEL_PROBE);
    assert.equal(modelCheck.status, "blocked");
    assert.match(modelCheck.reason, /no supported models/u);
    assert.match(modelCheck.nextAction, /Configure an available model/u);
  });
});

test("preflight reports unknown warnings instead of certainty when probes are unavailable", async () => {
  await withTempRepo(async (repositoryRoot) => {
    const result = await runPreflight({
      repositoryRoot,
      plannedScopePaths: ["src/helpers.js"],
      gitStatus: async () => ({
        available: false,
        reason: "git missing in test"
      }),
      processBackendRequired: false,
      modelProbeRequired: true
    });

    assert.equal(result.status, "warning");
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.GIT_WORKTREE).certainty, "unknown");
    assert.match(checkById(result, PREFLIGHT_CHECK_IDS.GIT_WORKTREE).reason, /git missing in test/u);
    assert.equal(checkById(result, PREFLIGHT_CHECK_IDS.MODEL_PROBE).certainty, "unknown");
    assert.match(checkById(result, PREFLIGHT_CHECK_IDS.MODEL_PROBE).reason, /no model probe is exposed/u);
  });
});
