import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  formatWorkflowExecution,
  RUN_CONTEXT_BUDGET_LIMITS,
  runAutoWorkflow,
  runPlannedWorkflow
} from "../src/auto-workflow.js";
import { createAutoBackendRunner } from "../src/auto-backend-runner.js";
import { createInitialWorkflow } from "../src/orchestrator.js";
import { validateRunContext } from "../src/context-manifest.js";
import {
  createBoundaryPathRedactor,
  mergeRedactionMetadata
} from "../src/redaction.js";
import { createScriptedWorkerRunner } from "../src/worker-runner.js";

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function createTrustedScriptedProcessBackend(script) {
  const backend = createScriptedWorkerRunner(script);
  return {
    ...backend,
    getTrustedBackendProvenance() {
      return {
        identity: "test/process-backend",
        source: "test-harness",
        evidenceKind: "observed_workspace_diff"
      };
    }
  };
}

function buildRuntimeContextFixture() {
  const packetContextFiles = ["README.md"];
  const priorResults = [
    {
      packetId: "implementer-task-1",
      role: "implementer",
      status: "success",
      summary: "Applied the scoped change.",
      changedFiles: ["src/helpers.js"],
      commandsRun: ["node --check src/helpers.js"],
      evidence: ["helper update complete"],
      openQuestions: []
    }
  ];
  const reviewResult = {
    status: "success",
    summary: "Review passed.",
    evidence: ["review complete"],
    openQuestions: []
  };
  const changedSurfaceContext = [
    {
      packetId: "implementer-task-1",
      role: "implementer",
      paths: ["src/helpers.js"]
    }
  ];
  const contextManifest = [
    {
      kind: "context_file",
      source: "packet_context_files",
      reference: "README.md",
      reason: "explicit_request"
    },
    {
      kind: "prior_result",
      source: "workflow_prior_runs",
      reference: "implementer-task-1",
      reason: "execution_history"
    },
    {
      kind: "review_result",
      source: "repair_review",
      reference: "review_result",
      reason: "repair_context"
    },
    {
      kind: "changed_surface",
      source: "trusted_changed_surface",
      reference: "implementer-task-1:implementer",
      reason: "changed_scope_carry_forward"
    }
  ];

  return {
    packetContextFiles,
    priorResults,
    reviewResult,
    changedSurfaceContext,
    contextManifest
  };
}

function buildContextBudgetFixture(overrides = {}) {
  const defaultTruncationCount = {
    priorResults: 0,
    evidenceEntries: 0,
    commandEntries: 0,
    changedFiles: 0,
    reviewResultEvidenceEntries: 0,
    reviewResultOpenQuestionEntries: 0,
    changedSurfacePaths: 0
  };

  return {
    priorResultsTruncated: false,
    truncatedPriorResultPacketIds: [],
    perResultEvidenceTruncated: false,
    perResultCommandsTruncated: false,
    perResultChangedFilesTruncated: false,
    reviewResultTruncated: false,
    changedSurfaceTruncated: false,
    ...overrides,
    truncationCount: {
      ...defaultTruncationCount,
      ...(overrides.truncationCount ?? {})
    }
  };
}

function setSinglePacketContextFileReference(fixture, reference) {
  fixture.packetContextFiles = [reference];
  fixture.contextManifest = fixture.contextManifest.map((entry) => (
    entry.kind === "context_file"
      ? {
        ...entry,
        reference
      }
      : entry
  ));
}

function normalizeRepairLoopFixtureForExistingPaths(fixture) {
  fixture.input.allowedFiles = [
    "src/auto-workflow.js",
    "src/context-manifest.js",
    "src/pi-worker-runner.js",
    "src/pi-adapter.js",
    "src/orchestrator.js",
    "src/contracts.js",
    "README.md"
  ];
  fixture.script[1].result.changedFiles = ["src/auto-workflow.js"];
  fixture.script[3].result.changedFiles = ["src/auto-workflow.js"];
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("auto workflow executes a low-risk plan straight through the runner", async () => {
  const fixture = loadFixture("low-risk-success.json");
  const runner = createScriptedWorkerRunner(fixture.script);

  const execution = await runAutoWorkflow(fixture.input, { runner });

  assert.equal(execution.status, "success");
  assert.equal(execution.workflow.risk, "low");
  assert.deepEqual(execution.workflow.roleSequence, ["implementer", "verifier"]);
  assert.equal(execution.repairCount, 0);
  assert.deepEqual(execution.runs.map((run) => run.packet.role), ["implementer", "verifier"]);
  assert.equal(runner.getPendingStepCount(), 0);
});

test("runPlannedWorkflow tolerates non-cloneable context values", async () => {
  const workflow = createInitialWorkflow({
    goal: "Rename one helper in a local file",
    allowedFiles: ["src/helpers.js"],
    contextFiles: ["README.md"]
  });
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Renamed the helper.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Implementer step passed."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified helper behavior.",
        changedFiles: [],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Verifier step passed."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runPlannedWorkflow({
    workflow,
    maxRepairLoops: 1,
    context: {
      workflowId: "function-bearing-context",
      callbacks: {
        onComplete() {
          return "done";
        }
      }
    }
  }, { runner });

  assert.equal(execution.status, "success");
  assert.deepEqual(execution.runs.map((run) => run.result.status), ["success", "success"]);

  const calls = runner.getCalls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].context.workflowId, workflow.workflowId);
  assert.equal(typeof calls[0].context.callbacks.onComplete, "string");
  assert.match(calls[0].context.callbacks.onComplete, /uncloneable/i);
  assert.deepEqual(calls[0].context.contextManifest, [
    {
      kind: "context_file",
      source: "packet_context_files",
      reference: "README.md",
      reason: "explicit_request"
    }
  ]);
  assert.ok(calls[1].context.contextManifest.some((entry) => {
    return entry.kind === "prior_result"
      && entry.source === "workflow_prior_runs"
      && entry.reason === "execution_history"
      && entry.reference === calls[0].packet.id;
  }));
});

test("runPlannedWorkflow redacts absolute paths in forwarded priorResults context", async () => {
  const workflow = createInitialWorkflow({
    goal: "Redaction forwarding check",
    allowedFiles: ["src/helpers.js"],
    contextFiles: ["README.md"]
  });
  const repositoryRoot = process.cwd();
  const absoluteRepoPath = join(repositoryRoot, "src", "helpers.js");
  const externalAbsolutePath = process.platform === "win32"
    ? "D:\\outside\\notes.txt"
    : "/opt/outside/notes.txt";

  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: `Updated helper at ${absoluteRepoPath}`,
        changedFiles: ["src/helpers.js"],
        commandsRun: [`node --check ${absoluteRepoPath}`],
        evidence: [
          `repo_path_seen: ${absoluteRepoPath}`,
          `external_path_seen: ${externalAbsolutePath}`
        ],
        openQuestions: [`Confirm external reference ${externalAbsolutePath} is expected.`]
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified helper behavior.",
        changedFiles: [],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Verifier step passed."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runPlannedWorkflow({
    workflow
  }, { runner });
  const calls = runner.getCalls();
  const forwardedPriorResult = calls[1].context.priorResults[0];

  assert.equal(execution.status, "success");
  assert.equal(forwardedPriorResult.summary.includes(absoluteRepoPath), false);
  assert.equal(forwardedPriorResult.summary.includes("src/helpers.js"), true);
  assert.equal(
    forwardedPriorResult.evidence.includes(`repo_path_seen: ${absoluteRepoPath}`),
    false
  );
  assert.equal(
    forwardedPriorResult.evidence.includes("repo_path_seen: src/helpers.js"),
    true
  );
  assert.equal(
    forwardedPriorResult.evidence.includes(`external_path_seen: ${externalAbsolutePath}`),
    false
  );
  assert.equal(
    forwardedPriorResult.evidence.includes("external_path_seen: <absolute_path>"),
    true
  );
  assert.equal(
    forwardedPriorResult.openQuestions.includes(`Confirm external reference ${externalAbsolutePath} is expected.`),
    false
  );
  assert.equal(
    forwardedPriorResult.openQuestions.includes("Confirm external reference <absolute_path> is expected."),
    true
  );
  assert.deepEqual(forwardedPriorResult.changedFiles, ["src/helpers.js"]);
  assert.deepEqual(forwardedPriorResult.redaction, {
    applied: true,
    repoPathRewrites: 3,
    workspacePathRewrites: 0,
    externalPathRewrites: 2
  });
});

test("runPlannedWorkflow does not trust context.repositoryRoot for repo-relative forwarding rewrites", async () => {
  const workflow = createInitialWorkflow({
    goal: "Untrusted root forwarding check",
    allowedFiles: ["src/helpers.js"],
    contextFiles: ["README.md"]
  });
  const fakeRepositoryRoot = process.platform === "win32"
    ? "C:\\opt\\outside-root"
    : "/opt/outside-root";
  const fakeRepoAbsolutePath = join(fakeRepositoryRoot, "src", "secret.js");
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: `Observed file at ${fakeRepoAbsolutePath}`,
        changedFiles: ["src/helpers.js"],
        commandsRun: [`node --check ${fakeRepoAbsolutePath}`],
        evidence: [`external_path_seen: ${fakeRepoAbsolutePath}`],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified helper behavior.",
        changedFiles: [],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Verifier step passed."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runPlannedWorkflow({
    workflow,
    context: {
      repositoryRoot: fakeRepositoryRoot
    }
  }, { runner });
  const calls = runner.getCalls();
  const forwardedPriorResult = calls[1].context.priorResults[0];

  assert.equal(execution.status, "success");
  assert.equal(forwardedPriorResult.summary.includes(fakeRepoAbsolutePath), false);
  assert.equal(forwardedPriorResult.summary.includes("src/secret.js"), false);
  assert.equal(forwardedPriorResult.summary.includes("<absolute_path>"), true);
  assert.equal(
    forwardedPriorResult.evidence.includes(`external_path_seen: ${fakeRepoAbsolutePath}`),
    false
  );
  assert.equal(
    forwardedPriorResult.evidence.includes("external_path_seen: <absolute_path>"),
    true
  );
  assert.equal(forwardedPriorResult.redaction.repoPathRewrites, 0);
  assert.equal(forwardedPriorResult.redaction.externalPathRewrites, 3);
});

test("runAutoWorkflow forwards nonzero reviewResult redaction metadata for repair-loop admission rewrites", async () => {
  const fixture = loadFixture("repair-loop.json");
  normalizeRepairLoopFixtureForExistingPaths(fixture);
  const repositoryRoot = process.cwd();
  const absoluteRepoPath = join(repositoryRoot, "src", "helpers.js");
  const externalAbsolutePath = process.platform === "win32"
    ? "D:\\outside\\repair.txt"
    : "/opt/outside/repair.txt";

  fixture.script[3].result.summary = `Repair applied at ${absoluteRepoPath}`;
  fixture.script[3].result.evidence = [
    `repair_repo_path_seen: ${absoluteRepoPath}`,
    `repair_external_path_seen: ${externalAbsolutePath}`
  ];
  fixture.script[3].result.openQuestions = [
    `Confirm external repair reference ${externalAbsolutePath} is expected.`
  ];

  const runner = createScriptedWorkerRunner(fixture.script);
  const execution = await runAutoWorkflow(fixture.input, { runner });
  const calls = runner.getCalls();
  const forwardedReviewResult = calls[4].context.reviewResult;

  assert.equal(execution.status, "success");
  assert.equal(forwardedReviewResult.summary.includes(absoluteRepoPath), false);
  assert.equal(forwardedReviewResult.summary.includes("src/helpers.js"), true);
  assert.equal(
    forwardedReviewResult.evidence.includes(`repair_repo_path_seen: ${absoluteRepoPath}`),
    false
  );
  assert.equal(
    forwardedReviewResult.evidence.includes("repair_repo_path_seen: src/helpers.js"),
    true
  );
  assert.equal(
    forwardedReviewResult.evidence.includes(`repair_external_path_seen: ${externalAbsolutePath}`),
    false
  );
  assert.equal(
    forwardedReviewResult.evidence.includes("repair_external_path_seen: <absolute_path>"),
    true
  );
  assert.equal(
    forwardedReviewResult.openQuestions.includes(`Confirm external repair reference ${externalAbsolutePath} is expected.`),
    false
  );
  assert.equal(
    forwardedReviewResult.openQuestions.includes("Confirm external repair reference <absolute_path> is expected."),
    true
  );
  assert.deepEqual(forwardedReviewResult.redaction, {
    applied: true,
    repoPathRewrites: 2,
    workspacePathRewrites: 0,
    externalPathRewrites: 2
  });
});

test("validateRunContext accepts matching runtime payloads and context_file packet entries", () => {
  const fixture = buildRuntimeContextFixture();

  assert.doesNotThrow(() => {
    validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext,
      contextBudget: buildContextBudgetFixture()
    });
  });
});

test("validateRunContext fails closed when packetContextFiles references a missing context file", () => {
  const fixture = buildRuntimeContextFixture();
  setSinglePacketContextFileReference(fixture, "docs/DOES-NOT-EXIST.md");

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext,
      contextBudget: buildContextBudgetFixture()
    }),
    /context\.packetContextFiles\[0\] must reference an existing repository file/i
  );
});

test("validateRunContext fails closed when packetContextFiles escapes the repository root", () => {
  const fixture = buildRuntimeContextFixture();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-orchestrator-context-"));
  const escapedContextFile = join(temporaryDirectory, "escaped-context.md");
  writeFileSync(escapedContextFile, "outside of repository root");
  const repoEscapeReference = relative(process.cwd(), escapedContextFile).replace(/\\/g, "/");
  assert.match(repoEscapeReference, /^\.\.\//u);
  setSinglePacketContextFileReference(fixture, repoEscapeReference);

  try {
    assert.throws(
      () => validateRunContext({
        packetContextFiles: fixture.packetContextFiles,
        contextManifest: fixture.contextManifest,
        priorResults: fixture.priorResults,
        reviewResult: fixture.reviewResult,
        changedSurfaceContext: fixture.changedSurfaceContext,
        contextBudget: buildContextBudgetFixture()
      }),
      /context\.packetContextFiles\[0\] must resolve within the repository root/i
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("validateRunContext accepts existing repo-relative packetContextFiles references", () => {
  const fixture = buildRuntimeContextFixture();
  setSinglePacketContextFileReference(fixture, "docs/OPERATING-GUIDE.md");

  assert.doesNotThrow(() => {
    validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext,
      contextBudget: buildContextBudgetFixture()
    });
  });
});

test("validateRunContext rejects duplicate priorResults packet ids", () => {
  const fixture = buildRuntimeContextFixture();
  fixture.priorResults.push({
    ...fixture.priorResults[0],
    status: "repair_required",
    summary: "Repeated packet identity should fail admission."
  });

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext,
      contextBudget: buildContextBudgetFixture()
    }),
    /duplicates packetId/i
  );
});

test("validateRunContext rejects duplicate contextManifest kind/reference pairs", () => {
  const fixture = buildRuntimeContextFixture();
  fixture.contextManifest.push({
    kind: "prior_result",
    source: "repair_review",
    reference: fixture.priorResults[0].packetId,
    reason: "repair_context"
  });

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext,
      contextBudget: buildContextBudgetFixture()
    }),
    /duplicates \(kind, reference\) pair/i
  );
});

test("validateRunContext rejects duplicate changed-surface references", () => {
  const fixture = buildRuntimeContextFixture();
  fixture.changedSurfaceContext.push({
    packetId: fixture.changedSurfaceContext[0].packetId,
    role: fixture.changedSurfaceContext[0].role,
    paths: ["src/another-helper.js"]
  });

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext,
      contextBudget: buildContextBudgetFixture()
    }),
    /duplicates changed-surface reference/i
  );
});

test("validateRunContext accepts structurally deduplicated runtime context", () => {
  const fixture = buildRuntimeContextFixture();
  const duplicatedPriorResults = [
    fixture.priorResults[0],
    {
      ...fixture.priorResults[0]
    }
  ];
  const duplicatedChangedSurfaceContext = [
    fixture.changedSurfaceContext[0],
    {
      ...fixture.changedSurfaceContext[0],
      paths: ["src/another-helper.js"]
    }
  ];
  const duplicatedManifest = [
    ...fixture.contextManifest,
    {
      ...fixture.contextManifest[1]
    }
  ];
  const deduplicatedManifest = Array.from(
    new Map(
      duplicatedManifest.map((entry) => [`${entry.kind}::${entry.reference}`, entry])
    ).values()
  );

  assert.doesNotThrow(() => {
    validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: deduplicatedManifest,
      priorResults: [duplicatedPriorResults[0]],
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: [duplicatedChangedSurfaceContext[0]],
      contextBudget: buildContextBudgetFixture()
    });
  });
});

test("validateRunContext rejects contradictory contextBudget truncation flags and counts", () => {
  const fixture = buildRuntimeContextFixture();
  const testCases = [
    {
      name: "priorResultsTruncated false with non-empty truncated prior packet ids",
      contextBudget: buildContextBudgetFixture({
        truncatedPriorResultPacketIds: ["omitted-prior-result"]
      }),
      errorPattern: /context\.contextBudget\.priorResultsTruncated/i
    },
    {
      name: "priorResultsTruncated false with positive truncationCount.priorResults",
      contextBudget: buildContextBudgetFixture({
        truncationCount: {
          priorResults: 1
        }
      }),
      errorPattern: /context\.contextBudget\.priorResultsTruncated/i
    },
    {
      name: "priorResultsTruncated true with no truncated packet ids and zero priorResults count",
      contextBudget: buildContextBudgetFixture({
        priorResultsTruncated: true
      }),
      errorPattern: /context\.contextBudget\.priorResultsTruncated/i
    },
    {
      name: "perResultEvidenceTruncated true with zero evidence truncation count",
      contextBudget: buildContextBudgetFixture({
        perResultEvidenceTruncated: true
      }),
      errorPattern: /context\.contextBudget\.perResultEvidenceTruncated/i
    },
    {
      name: "perResultCommandsTruncated true with zero command truncation count",
      contextBudget: buildContextBudgetFixture({
        perResultCommandsTruncated: true
      }),
      errorPattern: /context\.contextBudget\.perResultCommandsTruncated/i
    },
    {
      name: "perResultChangedFilesTruncated true with zero changedFiles truncation count",
      contextBudget: buildContextBudgetFixture({
        perResultChangedFilesTruncated: true
      }),
      errorPattern: /context\.contextBudget\.perResultChangedFilesTruncated/i
    },
    {
      name: "reviewResultTruncated true with zero review-result truncation counts",
      contextBudget: buildContextBudgetFixture({
        reviewResultTruncated: true
      }),
      errorPattern: /context\.contextBudget\.reviewResultTruncated/i
    },
    {
      name: "changedSurfaceTruncated true with zero changed-surface truncation count",
      contextBudget: buildContextBudgetFixture({
        changedSurfaceTruncated: true
      }),
      errorPattern: /context\.contextBudget\.changedSurfaceTruncated/i
    }
  ];

  for (const testCase of testCases) {
    assert.throws(
      () => validateRunContext({
        packetContextFiles: fixture.packetContextFiles,
        contextManifest: fixture.contextManifest,
        priorResults: fixture.priorResults,
        reviewResult: fixture.reviewResult,
        changedSurfaceContext: fixture.changedSurfaceContext,
        contextBudget: testCase.contextBudget
      }),
      testCase.errorPattern,
      testCase.name
    );
  }
});

test("validateRunContext rejects untrusted nonzero review-result and changed-surface truncation counts", () => {
  const fixture = buildRuntimeContextFixture();
  fixture.reviewResult.evidence = Array.from(
    { length: RUN_CONTEXT_BUDGET_LIMITS.maxReviewResultEvidence },
    (_, index) => `review evidence ${index}`
  );
  fixture.changedSurfaceContext[0].paths = Array.from(
    { length: RUN_CONTEXT_BUDGET_LIMITS.maxChangedSurfacePaths },
    (_, index) => `src/helpers-${index}.js`
  );

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext,
      contextBudget: buildContextBudgetFixture({
        reviewResultTruncated: true,
        truncationCount: {
          reviewResultEvidenceEntries: 99
        }
      })
    }),
    /context\.contextBudget\.truncationCount\.reviewResultEvidenceEntries must be 0 unless trusted forwarded truncation metadata is provided/i
  );

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext,
      contextBudget: buildContextBudgetFixture({
        changedSurfaceTruncated: true,
        truncationCount: {
          changedSurfacePaths: 3
        }
      })
    }),
    /context\.contextBudget\.truncationCount\.changedSurfacePaths must be 0 unless trusted forwarded truncation metadata is provided/i
  );
});

test("validateRunContext rejects review-result truncation counts when forwarded payload is not capped", () => {
  const fixture = buildRuntimeContextFixture();

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext,
      contextBudget: buildContextBudgetFixture({
        reviewResultTruncated: true,
        truncationCount: {
          reviewResultEvidenceEntries: 1
        }
      }),
      forwardedRedactionMetadata: {
        contextBudgetTruncation: {
          reviewResultEvidenceEntries: 1,
          reviewResultOpenQuestionEntries: 0,
          changedSurfacePaths: 0
        }
      }
    }),
    /requires forwarded reviewResult\.evidence to contain exactly/i
  );
});

test("validateRunContext rejects overlap between truncated and forwarded prior-result packet ids", () => {
  const fixture = buildRuntimeContextFixture();

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext,
      contextBudget: buildContextBudgetFixture({
        priorResultsTruncated: true,
        truncatedPriorResultPacketIds: [fixture.priorResults[0].packetId],
        truncationCount: {
          priorResults: 1
        }
      })
    }),
    /must not overlap with forwarded priorResults\[\]\.packetId/i
  );
});

test("validateRunContext rejects malformed present redaction metadata", () => {
  const fixture = buildRuntimeContextFixture();
  fixture.priorResults[0].redaction = {
    applied: true,
    repoPathRewrites: 0,
    workspacePathRewrites: 0,
    externalPathRewrites: 0
  };

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext
    }),
    /context\.priorResults\[0\]\.redaction\.applied must be false/u
  );
});

test("validateRunContext rejects fabricated priorResults redaction metadata on relative-only strings", () => {
  const fixture = buildRuntimeContextFixture();
  fixture.priorResults[0].redaction = {
    applied: true,
    repoPathRewrites: 2,
    workspacePathRewrites: 0,
    externalPathRewrites: 0
  };

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext
    }),
    /context\.priorResults\[0\]\.redaction must exactly match redaction metadata recomputed from covered strings/u
  );
});

test("validateRunContext rejects fabricated reviewResult redaction metadata on relative-only strings", () => {
  const fixture = buildRuntimeContextFixture();
  fixture.reviewResult.redaction = {
    applied: true,
    repoPathRewrites: 1,
    workspacePathRewrites: 0,
    externalPathRewrites: 0
  };

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext
    }),
    /context\.reviewResult\.redaction must exactly match redaction metadata recomputed from covered strings/u
  );
});

test("validateRunContext accepts generated redaction metadata from actual rewrites", () => {
  const fixture = buildRuntimeContextFixture();
  const repositoryRoot = process.cwd();
  const repoAbsolutePath = join(repositoryRoot, "src", "helpers.js");
  const externalAbsolutePath = process.platform === "win32"
    ? "D:\\outside\\review.txt"
    : "/opt/outside/review.txt";
  const redactor = createBoundaryPathRedactor({
    repositoryRoot
  });

  fixture.priorResults[0].summary = `Applied update in ${repoAbsolutePath}`;
  fixture.priorResults[0].evidence = [`external_evidence: ${externalAbsolutePath}`];
  fixture.reviewResult.summary = `Reviewed ${repoAbsolutePath}`;
  fixture.reviewResult.evidence = [`review_external: ${externalAbsolutePath}`];

  const priorSummary = redactor.redactString(fixture.priorResults[0].summary, {
    fieldName: "priorResults[0].summary"
  });
  const priorChangedFiles = redactor.redactStringArray(fixture.priorResults[0].changedFiles, {
    fieldName: "priorResults[0].changedFiles"
  });
  const priorCommands = redactor.redactStringArray(fixture.priorResults[0].commandsRun, {
    fieldName: "priorResults[0].commandsRun"
  });
  const priorEvidence = redactor.redactStringArray(fixture.priorResults[0].evidence, {
    fieldName: "priorResults[0].evidence"
  });
  const priorOpenQuestions = redactor.redactStringArray(fixture.priorResults[0].openQuestions, {
    fieldName: "priorResults[0].openQuestions"
  });
  fixture.priorResults[0] = {
    ...fixture.priorResults[0],
    summary: priorSummary.value,
    changedFiles: priorChangedFiles.values,
    commandsRun: priorCommands.values,
    evidence: priorEvidence.values,
    openQuestions: priorOpenQuestions.values,
    redaction: mergeRedactionMetadata(
      priorSummary.redaction,
      priorChangedFiles.redaction,
      priorCommands.redaction,
      priorEvidence.redaction,
      priorOpenQuestions.redaction
    )
  };

  const reviewSummary = redactor.redactString(fixture.reviewResult.summary, {
    fieldName: "reviewResult.summary"
  });
  const reviewEvidence = redactor.redactStringArray(fixture.reviewResult.evidence, {
    fieldName: "reviewResult.evidence"
  });
  const reviewOpenQuestions = redactor.redactStringArray(fixture.reviewResult.openQuestions, {
    fieldName: "reviewResult.openQuestions"
  });
  fixture.reviewResult = {
    ...fixture.reviewResult,
    summary: reviewSummary.value,
    evidence: reviewEvidence.values,
    openQuestions: reviewOpenQuestions.values,
    redaction: mergeRedactionMetadata(
      reviewSummary.redaction,
      reviewEvidence.redaction,
      reviewOpenQuestions.redaction
    )
  };

  assert.doesNotThrow(() => {
    validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext,
      forwardedRedactionMetadata: {
        priorResults: [fixture.priorResults[0].redaction],
        reviewResult: fixture.reviewResult.redaction
      },
      repositoryRoot
    });
  });
});

test("validateRunContext rejects duplicate truncatedPriorResultPacketIds entries", () => {
  const fixture = buildRuntimeContextFixture();

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext,
      contextBudget: buildContextBudgetFixture({
        priorResultsTruncated: true,
        truncatedPriorResultPacketIds: ["omitted-packet", "omitted-packet"],
        truncationCount: {
          priorResults: 2
        }
      })
    }),
    /duplicates packetId/i
  );
});

test("validateRunContext fails closed when a forwarded prior result is missing from contextManifest", () => {
  const fixture = buildRuntimeContextFixture();
  const manifestWithoutPriorResult = fixture.contextManifest.filter((entry) => entry.kind !== "prior_result");

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: manifestWithoutPriorResult,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext
    }),
    /runtime context assembly invalid or drifted from contextManifest\[\]/i
  );
});

test("validateRunContext fails closed when contextManifest references a missing prior result", () => {
  const fixture = buildRuntimeContextFixture();

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: [],
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext
    }),
    /runtime context assembly invalid or drifted from contextManifest\[\]/i
  );
});

test("validateRunContext fails closed when reviewResult is forwarded without a matching manifest entry", () => {
  const fixture = buildRuntimeContextFixture();
  const manifestWithoutReviewResult = fixture.contextManifest.filter((entry) => entry.kind !== "review_result");

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: manifestWithoutReviewResult,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: fixture.changedSurfaceContext
    }),
    /runtime context assembly invalid or drifted from contextManifest\[\]/i
  );
});

test("validateRunContext fails closed when contextManifest includes review_result but no review payload", () => {
  const fixture = buildRuntimeContextFixture();

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: null,
      changedSurfaceContext: fixture.changedSurfaceContext
    }),
    /runtime context assembly invalid or drifted from contextManifest\[\]/i
  );
});

test("validateRunContext fails closed on changed-surface context drift", () => {
  const fixture = buildRuntimeContextFixture();
  const driftedChangedSurface = [
    {
      packetId: "implementer-task-1",
      role: "reviewer",
      paths: ["src/helpers.js"]
    }
  ];

  assert.throws(
    () => validateRunContext({
      packetContextFiles: fixture.packetContextFiles,
      contextManifest: fixture.contextManifest,
      priorResults: fixture.priorResults,
      reviewResult: fixture.reviewResult,
      changedSurfaceContext: driftedChangedSurface
    }),
    /runtime context assembly invalid or drifted from contextManifest\[\]/i
  );
});

test("auto workflow runs one repair loop after an independent review finding", async () => {
  const fixture = loadFixture("repair-loop.json");
  normalizeRepairLoopFixtureForExistingPaths(fixture);
  const runner = createScriptedWorkerRunner(fixture.script);

  const execution = await runAutoWorkflow(fixture.input, { runner });
  const calls = runner.getCalls();

  assert.equal(execution.status, "success");
  assert.equal(execution.workflow.risk, "medium");
  assert.equal(execution.repairCount, 1);
  assert.deepEqual(execution.runs.map((run) => run.packet.role), [
    "explorer",
    "implementer",
    "reviewer",
    "implementer",
    "reviewer",
    "verifier"
  ]);
  assert.equal(calls[3].context.repairCount, 1);
  assert.equal(calls[3].context.priorResults.at(-1).status, "repair_required");
  assert.equal(calls[3].context.priorResults.at(-1).role, "reviewer");
  assert.ok(calls[3].context.contextManifest.some((entry) => {
    return entry.kind === "prior_result"
      && entry.source === "workflow_prior_runs"
      && entry.reason === "execution_history"
      && entry.reference === calls[2].packet.id;
  }));
  assert.ok(calls[4].context.contextManifest.some((entry) => {
    return entry.kind === "review_result"
      && entry.source === "repair_review"
      && entry.reference === "review_result"
      && entry.reason === "repair_context";
  }));

  const finalVerifierContext = calls.at(-1).context;
  const expectedMaxPriorResults = RUN_CONTEXT_BUDGET_LIMITS.maxPriorResults;
  assert.equal(
    finalVerifierContext.priorResults.length,
    Math.min(expectedMaxPriorResults, calls.length - 1)
  );
  assert.equal(finalVerifierContext.contextBudget.priorResultsTruncated, true);
  assert.equal(finalVerifierContext.contextBudget.truncatedPriorResultPacketIds.length, 1);
  assert.equal(
    finalVerifierContext.contextBudget.truncatedPriorResultPacketIds[0],
    calls[0].packet.id
  );
  assert.equal(finalVerifierContext.contextBudget.truncationCount.priorResults, 1);
  assert.equal(
    finalVerifierContext.contextManifest.some((entry) => {
      return entry.kind === "prior_result" && entry.reference === calls[0].packet.id;
    }),
    false
  );

  assert.match(formatWorkflowExecution(execution), /repair_loops: 1\/1/);
  assert.equal(runner.getPendingStepCount(), 0);
});

test("repair packets preserve original guard rails and context files", async () => {
  const workflow = createInitialWorkflow({
    goal: "Repair guard preservation check",
    allowedFiles: [
      "src/helpers.js",
      "src/orchestrator.js",
      "src/contracts.js",
      "src/auto-workflow.js",
      "src/pi-worker-runner.js",
      "src/pi-adapter.js",
      "README.md"
    ],
    contextFiles: ["README.md"]
  });
  const implementerPacket = workflow.packets.find((packet) => packet.role === "implementer");
  const reviewerPacket = workflow.packets.find((packet) => packet.role === "reviewer");
  implementerPacket.nonGoals = ["Preserve original non-goal."];
  implementerPacket.acceptanceChecks = ["Original acceptance check must survive repair."];
  implementerPacket.stopConditions = ["Original stop condition must survive repair."];
  implementerPacket.contextFiles = ["README.md", "docs/OPERATING-GUIDE.md"];
  implementerPacket.contextManifest = [
    {
      kind: "context_file",
      source: "packet_context_files",
      reference: "README.md",
      reason: "explicit_request"
    },
    {
      kind: "context_file",
      source: "packet_context_files",
      reference: "docs/OPERATING-GUIDE.md",
      reason: "explicit_request"
    }
  ];
  reviewerPacket.acceptanceChecks = ["Reviewer-specific acceptance check must survive repair."];

  const runner = createScriptedWorkerRunner([
    {
      role: "explorer",
      result: {
        status: "success",
        summary: "Mapped scope.",
        changedFiles: [],
        commandsRun: ["rg --files"],
        evidence: ["Scope mapped."],
        openQuestions: []
      }
    },
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Initial implementation complete.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Initial check passed."],
        openQuestions: []
      }
    },
    {
      role: "reviewer",
      result: {
        status: "repair_required",
        summary: "Repair required.",
        changedFiles: [],
        commandsRun: ["git diff -- src/helpers.js"],
        evidence: ["Review found a gap."],
        openQuestions: []
      }
    },
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Repair complete.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Repair check passed."],
        openQuestions: []
      }
    },
    {
      role: "reviewer",
      result: {
        status: "success",
        summary: "Repair review passed.",
        changedFiles: [],
        commandsRun: ["git diff -- src/helpers.js"],
        evidence: ["Review passed."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified.",
        changedFiles: [],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Verification passed."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runPlannedWorkflow({
    workflow,
    maxRepairLoops: 1
  }, { runner });
  const repairImplementerPacket = runner.getCalls()[3].packet;
  const repairReviewerPacket = runner.getCalls()[4].packet;

  assert.equal(execution.status, "success");
  assert.equal(repairImplementerPacket.nonGoals.includes("Preserve original non-goal."), true);
  assert.equal(
    repairImplementerPacket.acceptanceChecks.includes("Original acceptance check must survive repair."),
    true
  );
  assert.equal(
    repairImplementerPacket.acceptanceChecks.includes("Reviewer-specific acceptance check must survive repair."),
    true
  );
  assert.equal(
    repairImplementerPacket.stopConditions.includes("Original stop condition must survive repair."),
    true
  );
  assert.equal(repairImplementerPacket.contextFiles.includes("docs/OPERATING-GUIDE.md"), true);
  assert.equal(
    repairImplementerPacket.contextManifest.some((entry) => entry.reference === "docs/OPERATING-GUIDE.md"),
    true
  );
  assert.equal(
    repairReviewerPacket.acceptanceChecks.includes("Original acceptance check must survive repair."),
    true
  );
});

test("runPlannedWorkflow keeps legacy packets without contextManifest compatible", async () => {
  const workflow = createInitialWorkflow({
    goal: "Rename one helper in a local file",
    allowedFiles: ["src/helpers.js"],
    contextFiles: ["README.md"]
  });
  for (const packet of workflow.packets) {
    delete packet.contextManifest;
  }

  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Renamed the helper.",
        changedFiles: ["src/helpers.js"],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Implementer step passed."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified helper behavior.",
        changedFiles: [],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Verifier step passed."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runPlannedWorkflow({
    workflow
  }, { runner });
  const calls = runner.getCalls();

  assert.equal(execution.status, "success");
  assert.deepEqual(calls[0].context.contextManifest, [
    {
      kind: "context_file",
      source: "packet_context_files",
      reference: "README.md",
      reason: "explicit_request"
    }
  ]);
});

test("runPlannedWorkflow reports per-result context truncation in contextBudget", async () => {
  const workflow = createInitialWorkflow({
    goal: "Rename one helper in a local file",
    allowedFiles: ["src/helpers.js"],
    contextFiles: ["README.md"]
  });

  const oversizedChangedFiles = new Array(RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultChangedFiles + 3)
    .fill("src/helpers.js");
  const oversizedCommands = new Array(RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultCommands + 4)
    .fill("node --check src/helpers.js");
  const oversizedEvidence = new Array(RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultEvidence + 5)
    .fill("helper check evidence");

  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Applied a scoped helper change.",
        changedFiles: oversizedChangedFiles,
        commandsRun: oversizedCommands,
        evidence: oversizedEvidence,
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified helper behavior.",
        changedFiles: [],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Verifier step passed."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runPlannedWorkflow({
    workflow
  }, { runner });
  const calls = runner.getCalls();

  assert.equal(execution.status, "success");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].context.contextBudget.perResultChangedFilesTruncated, true);
  assert.equal(calls[1].context.contextBudget.perResultCommandsTruncated, true);
  assert.equal(calls[1].context.contextBudget.perResultEvidenceTruncated, true);
  assert.equal(
    calls[1].context.priorResults[0].changedFiles.length,
    RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultChangedFiles
  );
  assert.equal(
    calls[1].context.priorResults[0].commandsRun.length,
    RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultCommands
  );
  assert.equal(
    calls[1].context.priorResults[0].evidence.length,
    RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultEvidence
  );
  assert.equal(
    calls[1].context.contextBudget.truncationCount.changedFiles,
    oversizedChangedFiles.length - RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultChangedFiles
  );
  assert.equal(
    calls[1].context.contextBudget.truncationCount.commandEntries,
    oversizedCommands.length - RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultCommands
  );
  assert.equal(
    calls[1].context.contextBudget.truncationCount.evidenceEntries,
    oversizedEvidence.length - RUN_CONTEXT_BUDGET_LIMITS.maxPriorResultEvidence
  );
  assert.doesNotThrow(() => {
    validateRunContext({
      packetContextFiles: calls[1].packet.contextFiles,
      contextManifest: calls[1].context.contextManifest,
      priorResults: calls[1].context.priorResults,
      reviewResult: calls[1].context.reviewResult,
      changedSurfaceContext: calls[1].context.changedSurfaceContext,
      contextBudget: calls[1].context.contextBudget
    });
  });
});

test("runAutoWorkflow reports explicit review-result truncation in contextBudget", async () => {
  const fixture = loadFixture("repair-loop.json");
  normalizeRepairLoopFixtureForExistingPaths(fixture);
  const oversizedReviewEvidence = new Array(RUN_CONTEXT_BUDGET_LIMITS.maxReviewResultEvidence + 2)
    .fill("repair evidence entry");
  const oversizedReviewOpenQuestions = new Array(RUN_CONTEXT_BUDGET_LIMITS.maxReviewResultOpenQuestions + 3)
    .fill("repair open question");
  fixture.script[3].result.evidence = oversizedReviewEvidence;
  fixture.script[3].result.openQuestions = oversizedReviewOpenQuestions;

  const runner = createScriptedWorkerRunner(fixture.script);
  const execution = await runAutoWorkflow(fixture.input, { runner });
  const calls = runner.getCalls();
  const rereviewContext = calls[4].context;

  assert.equal(execution.status, "success");
  assert.equal(
    rereviewContext.reviewResult.evidence.length,
    RUN_CONTEXT_BUDGET_LIMITS.maxReviewResultEvidence
  );
  assert.equal(
    rereviewContext.reviewResult.openQuestions.length,
    RUN_CONTEXT_BUDGET_LIMITS.maxReviewResultOpenQuestions
  );
  assert.equal(rereviewContext.contextBudget.reviewResultTruncated, true);
  assert.equal(
    rereviewContext.contextBudget.truncationCount.reviewResultEvidenceEntries,
    oversizedReviewEvidence.length - RUN_CONTEXT_BUDGET_LIMITS.maxReviewResultEvidence
  );
  assert.equal(
    rereviewContext.contextBudget.truncationCount.reviewResultOpenQuestionEntries,
    oversizedReviewOpenQuestions.length - RUN_CONTEXT_BUDGET_LIMITS.maxReviewResultOpenQuestions
  );
  assert.ok(rereviewContext.contextManifest.some((entry) => {
    return entry.kind === "review_result"
      && entry.source === "repair_review"
      && entry.reason === "repair_context"
      && entry.reference === "review_result";
  }));
  assert.doesNotThrow(() => {
    validateRunContext({
      packetContextFiles: calls[4].packet.contextFiles,
      contextManifest: rereviewContext.contextManifest,
      priorResults: rereviewContext.priorResults,
      reviewResult: rereviewContext.reviewResult,
      changedSurfaceContext: rereviewContext.changedSurfaceContext,
      contextBudget: rereviewContext.contextBudget,
      forwardedRedactionMetadata: {
        priorResults: rereviewContext.priorResults.map((priorResult) => priorResult.redaction),
        reviewResult: rereviewContext.reviewResult?.redaction,
        contextBudgetTruncation: {
          reviewResultEvidenceEntries: (
            rereviewContext.contextBudget.truncationCount.reviewResultEvidenceEntries
          ),
          reviewResultOpenQuestionEntries: (
            rereviewContext.contextBudget.truncationCount.reviewResultOpenQuestionEntries
          ),
          changedSurfacePaths: rereviewContext.contextBudget.truncationCount.changedSurfacePaths
        }
      }
    });
  });
});

test("runAutoWorkflow ignores self-attested changed-surface truncation in contextBudget", async () => {
  const oversizedChangedSurfacePaths = Array.from(
    {
      length: RUN_CONTEXT_BUDGET_LIMITS.maxChangedSurfacePaths + 4
    },
    (_, index) => `src/helpers-${index}.js`
  );
  const processBackend = createTrustedScriptedProcessBackend([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Renamed the helper.",
        changedFiles: ["src/helpers.js"],
        changedSurfaceObservation: {
          capture: "complete",
          paths: oversizedChangedSurfacePaths
        },
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Implementer step passed."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified helper behavior.",
        changedFiles: [],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Verifier step passed."],
        openQuestions: []
      }
    }
  ]);
  const runner = createAutoBackendRunner({
    defaultRunner: createScriptedWorkerRunner([]),
    processBackend,
    mode: "low_risk_process_implementer"
  });

  const execution = await runAutoWorkflow({
    goal: "Rename one helper in a local file",
    allowedFiles: ["src/helpers.js"]
  }, { runner });
  const calls = runner.getCalls();
  const verifierContext = calls[1].context;

  assert.equal(execution.status, "success");
  assert.equal(calls.length, 2);
  assert.equal(verifierContext.changedSurfaceContext.length, 0);
  assert.equal(verifierContext.contextBudget.changedSurfaceTruncated, false);
  assert.equal(verifierContext.contextBudget.truncationCount.changedSurfacePaths, 0);
  assert.equal(verifierContext.contextManifest.some((entry) => {
    return entry.kind === "changed_surface"
      && entry.source === "trusted_changed_surface"
      && entry.reason === "changed_scope_carry_forward"
      && entry.reference === `${calls[0].packet.id}:implementer`;
  }), false);
  assert.doesNotThrow(() => {
    validateRunContext({
      packetContextFiles: calls[1].packet.contextFiles,
      contextManifest: verifierContext.contextManifest,
      priorResults: verifierContext.priorResults,
      reviewResult: verifierContext.reviewResult,
      changedSurfaceContext: verifierContext.changedSurfaceContext,
      contextBudget: verifierContext.contextBudget,
      forwardedRedactionMetadata: {
        priorResults: verifierContext.priorResults.map((priorResult) => priorResult.redaction),
        reviewResult: verifierContext.reviewResult?.redaction,
        contextBudgetTruncation: {
          reviewResultEvidenceEntries: (
            verifierContext.contextBudget.truncationCount.reviewResultEvidenceEntries
          ),
          reviewResultOpenQuestionEntries: (
            verifierContext.contextBudget.truncationCount.reviewResultOpenQuestionEntries
          ),
          changedSurfacePaths: verifierContext.contextBudget.truncationCount.changedSurfacePaths
        }
      }
    });
  });
});

test("auto workflow does not carry self-attested changed-surface references into contextManifest", async () => {
  const processBackend = createTrustedScriptedProcessBackend([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Renamed the helper.",
        changedFiles: ["src/helpers.js"],
        changedSurfaceObservation: {
          capture: "complete",
          paths: ["src/helpers.js"]
        },
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Implementer step passed."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified helper behavior.",
        changedFiles: [],
        commandsRun: ["node --check src/helpers.js"],
        evidence: ["Verifier step passed."],
        openQuestions: []
      }
    }
  ]);
  const runner = createAutoBackendRunner({
    defaultRunner: createScriptedWorkerRunner([]),
    processBackend,
    mode: "low_risk_process_implementer"
  });

  const execution = await runAutoWorkflow({
    goal: "Rename one helper in a local file",
    allowedFiles: ["src/helpers.js"]
  }, { runner });
  const calls = runner.getCalls();

  assert.equal(execution.status, "success");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].context.changedSurfaceContext, []);
  assert.equal(calls[1].context.contextManifest.some((entry) => {
    return entry.kind === "changed_surface"
      && entry.source === "trusted_changed_surface"
      && entry.reason === "changed_scope_carry_forward"
      && entry.reference === `${calls[0].packet.id}:implementer`;
  }), false);
});

test("formatWorkflowExecution includes run evidence and commands", () => {
  const formatted = formatWorkflowExecution({
    workflow: {
      workflowId: "workflow-evidence-check",
      risk: "high",
      humanGate: true
    },
    status: "success",
    stopReason: null,
    repairCount: 0,
    maxRepairLoops: 1,
    runs: [
      {
        packet: {
          role: "implementer"
        },
        result: {
          status: "success",
          summary: "Applied scoped changes.",
          changedFiles: ["test/fixtures/model-evidence-target.md"],
          commandsRun: ["pi -p --provider openai-codex --model gpt-5.3-codex"],
          evidence: [
            "selected_provider: openai-codex",
            "selected_model: gpt-5.3-codex"
          ],
          openQuestions: []
        }
      }
    ]
  });

  assert.match(formatted, /launch_selection: openai-codex \(implementer=gpt-5\.3-codex\)/i);
  assert.match(formatted, /commands: pi -p --provider openai-codex --model gpt-5\.3-codex/i);
  assert.match(formatted, /selected_provider: openai-codex/i);
  assert.match(formatted, /selected_model: gpt-5\.3-codex/i);
});

test("auto workflow stops before execution when a human gate is required", async () => {
  const fixture = loadFixture("human-gate.json");
  const runner = createScriptedWorkerRunner(fixture.script);

  const execution = await runAutoWorkflow(fixture.input, { runner });

  assert.equal(execution.status, "human_gate_required");
  assert.equal(execution.workflow.humanGate, true);
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /Human approval is required/i);
});

test("auto workflow treats approvedHighRisk string false as no approval", async () => {
  const fixture = loadFixture("human-gate.json");
  const runner = createScriptedWorkerRunner(fixture.script);

  const execution = await runAutoWorkflow({
    ...fixture.input,
    approvedHighRisk: "false"
  }, { runner });

  assert.equal(execution.status, "human_gate_required");
  assert.equal(execution.workflow.humanGate, true);
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /Human approval is required/i);
});

test("auto workflow treats approvedHighRisk string true as explicit approval", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "explorer",
      result: {
        status: "success",
        summary: "Mapped scoped files.",
        changedFiles: [],
        commandsRun: ["rg --files"],
        evidence: ["Scope mapped."],
        openQuestions: []
      }
    },
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Applied the scoped migration changes.",
        changedFiles: ["platform/contracts/ingest/artifact.json"],
        commandsRun: ["node --check src/program-compiler.js"],
        evidence: ["Scoped changes complete."],
        openQuestions: []
      }
    },
    {
      role: "reviewer",
      result: {
        status: "success",
        summary: "Reviewed scoped changes.",
        changedFiles: [],
        commandsRun: ["git diff --stat"],
        evidence: ["Review completed."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verification checks passed.",
        changedFiles: [],
        commandsRun: ["node --test --test-isolation=none"],
        evidence: ["Verification passed."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Apply a schema migration for event storage",
    allowedFiles: ["platform/contracts/ingest/artifact.json"],
    approvedHighRisk: "true"
  }, { runner });

  assert.equal(execution.status, "success");
  assert.equal(execution.workflow.humanGate, true);
  assert.deepEqual(
    execution.runs.map((run) => run.packet.role),
    ["explorer", "implementer", "reviewer", "verifier"]
  );
});

test("auto workflow blocks empty allowlists during input normalization", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "This step should never run.",
        changedFiles: [],
        commandsRun: [],
        evidence: [],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: []
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /allowedFiles must contain at least one file path/i);
});

test("auto workflow blocks non-string allowedFiles entries during input normalization", async () => {
  const runner = createScriptedWorkerRunner([]);
  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: [{}]
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /scope path must be a string/i);
});

test("auto workflow blocks non-string forbiddenFiles entries during input normalization", async () => {
  const runner = createScriptedWorkerRunner([]);
  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    forbiddenFiles: [{}]
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /scope path must be a string/i);
});

test("auto workflow blocks non-string contextFiles entries during input normalization", async () => {
  const runner = createScriptedWorkerRunner([]);
  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    contextFiles: [{}]
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /scope path must be a string/i);
});

test("runPlannedWorkflow fails closed on malformed packet contextManifest values", async () => {
  const workflow = createInitialWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    contextFiles: ["README.md"]
  });
  workflow.packets[0].contextManifest = [
    {
      kind: "unknown_kind",
      source: "packet_context_files",
      reference: "README.md",
      reason: "explicit_request"
    }
  ];

  const runner = createScriptedWorkerRunner([]);
  await assert.rejects(
    () => runPlannedWorkflow({ workflow }, { runner }),
    /workflow\.packets\[0\] packet\.contextManifest\[0\]\.kind must be one of: context_file, prior_result, review_result, changed_surface/i
  );
});

test("runPlannedWorkflow fails closed on packet contextManifest drift from contextFiles", async () => {
  const workflow = createInitialWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    contextFiles: ["README.md"]
  });
  workflow.packets[0].contextManifest = [
    {
      kind: "context_file",
      source: "packet_context_files",
      reference: "docs/OPERATING-GUIDE.md",
      reason: "explicit_request"
    }
  ];

  const runner = createScriptedWorkerRunner([]);
  await assert.rejects(
    () => runPlannedWorkflow({ workflow }, { runner }),
    /workflow\.packets\[0\] packet\.contextManifest must exactly match canonical packet context_file entries derived from packet\.contextFiles/i
  );
});

test("runPlannedWorkflow fails closed on runtime-only packet contextManifest kinds", async () => {
  const workflow = createInitialWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    contextFiles: ["README.md"]
  });
  workflow.packets[0].contextManifest = [
    {
      kind: "prior_result",
      source: "workflow_prior_runs",
      reference: "implementer-task-1",
      reason: "execution_history"
    }
  ];

  const runner = createScriptedWorkerRunner([]);
  await assert.rejects(
    () => runPlannedWorkflow({ workflow }, { runner }),
    /workflow\.packets\[0\] packet\.contextManifest\[0\]\.kind must be context_file for packet-level context manifests/i
  );
});

test("auto workflow still accepts valid string scope paths", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Patched the scoped helper.",
        changedFiles: ["web/src/utils/format.js"],
        commandsRun: ["node --check web/src/utils/format.js"],
        evidence: ["Patch applied in scoped file."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Verified scoped helper changes.",
        changedFiles: [],
        commandsRun: ["node --check web/src/utils/format.js"],
        evidence: ["Scoped verification passed."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["./web/src/utils/format.js"],
    forbiddenFiles: ["./web/src/utils/generated.js"],
    contextFiles: ["./README.md"]
  }, { runner });

  assert.equal(execution.status, "success");
  assert.equal(execution.runs.length, 2);
  assert.deepEqual(execution.runs.map((run) => run.packet.role), ["implementer", "verifier"]);
});

test("auto workflow stops with a structured failure when a role reports an out-of-scope file", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Patched an unexpected file.",
        changedFiles: ["web/src/utils/other.js"],
        commandsRun: [],
        evidence: ["Implemented the requested change."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"]
  }, { runner });

  assert.equal(execution.status, "failed");
  assert.equal(execution.runs.length, 1);
  assert.equal(execution.runs[0].packet.role, "implementer");
  assert.equal(execution.runs[0].result.status, "failed");
  assert.match(execution.stopReason, /outside its allowlist/i);
  assert.match(execution.stopReason, /web\/src\/utils\/other\.js/i);
});

test("auto workflow blocks planner failures when allow and forbidden paths match", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "This step should never run.",
        changedFiles: [],
        commandsRun: [],
        evidence: [],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    forbiddenFiles: ["web/src/utils/format.js"]
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /must not overlap by scope/i);
  assert.match(execution.stopReason, /web\/src\/utils\/format\.js/i);
});

test("auto workflow blocks planner failures when allow and forbidden scopes overlap", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Patched a forbidden file.",
        changedFiles: ["web/src/utils/format.js"],
        commandsRun: [],
        evidence: ["Patched the helper."],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    forbiddenFiles: ["web/src/utils/"]
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /must not overlap by scope/i);
  assert.match(execution.stopReason, /web\/src\/utils\//i);
});

test("auto workflow blocks when maxRepairLoops is negative", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "This step should never run.",
        changedFiles: [],
        commandsRun: [],
        evidence: [],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    maxRepairLoops: -1
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /maxRepairLoops must be a non-negative integer/i);
});

test("auto workflow blocks when maxRepairLoops is not an integer", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "This step should never run.",
        changedFiles: [],
        commandsRun: [],
        evidence: [],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"],
    maxRepairLoops: 1.5
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /maxRepairLoops must be a non-negative integer/i);
});

test("auto workflow blocks planner failures when allowlist includes protected paths", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "This step should never run.",
        changedFiles: [],
        commandsRun: [],
        evidence: [],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Patch vendored dependency",
    allowedFiles: ["node_modules/pkg/index.js"]
  }, { runner });

  assert.equal(execution.status, "blocked");
  assert.equal(execution.runs.length, 0);
  assert.equal(runner.getCalls().length, 0);
  assert.match(execution.stopReason, /allowedFiles contains protected path/i);
  assert.match(execution.stopReason, /node_modules\/pkg\/index\.js/i);
});

test("process-backed workflow emits heartbeats with run context and stops them after completion", async () => {
  const workflow = createInitialWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"]
  });
  workflow.packets = [workflow.packets[0]];
  workflow.roleSequence = ["implementer"];

  const events = [];
  const runner = {
    getSelectedBackend() {
      return "process_backend";
    },
    getTimeoutBudgetMs() {
      return 120;
    },
    async run() {
      await sleep(35);
      return {
        status: "success",
        summary: "Patched the helper.",
        changedFiles: ["web/src/utils/format.js"],
        commandsRun: [],
        evidence: ["Implemented the requested change."],
        openQuestions: []
      };
    }
  };

  const execution = await runPlannedWorkflow({
    workflow,
    approvedHighRisk: false,
    maxRepairLoops: 0,
    context: {
      programId: "program-heartbeat",
      contractId: "contract-heartbeat"
    }
  }, {
    runner,
    heartbeatIntervalMs: 10,
    onProgress: (event) => {
      events.push(event);
    }
  });

  assert.equal(execution.status, "success");
  const heartbeatEvents = events.filter((event) => event.type === "packet_heartbeat");
  assert.equal(heartbeatEvents.length >= 2, true);
  assert.equal(heartbeatEvents.every((event) => event.programId === "program-heartbeat"), true);
  assert.equal(heartbeatEvents.every((event) => event.contractId === "contract-heartbeat"), true);
  assert.equal(heartbeatEvents.every((event) => event.role === "implementer"), true);
  assert.equal(heartbeatEvents.every((event) => event.selectedBackend === "process_backend"), true);
  assert.equal(heartbeatEvents.every((event) => event.timeoutBudgetMs === 120), true);

  const heartbeatCountAtCompletion = heartbeatEvents.length;
  await sleep(30);
  assert.equal(
    events.filter((event) => event.type === "packet_heartbeat").length,
    heartbeatCountAtCompletion
  );
});

test("process-backed workflow clears heartbeat intervals when runner fails", async () => {
  const workflow = createInitialWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"]
  });
  workflow.packets = [workflow.packets[0]];
  workflow.roleSequence = ["implementer"];

  const events = [];
  const runner = {
    getSelectedBackend() {
      return "process_backend";
    },
    getTimeoutBudgetMs() {
      return 120;
    },
    async run() {
      await sleep(25);
      throw new Error("launcher unavailable");
    }
  };

  const execution = await runPlannedWorkflow({
    workflow,
    approvedHighRisk: false,
    maxRepairLoops: 0,
    context: {
      programId: "program-failed-heartbeat",
      contractId: "contract-failed-heartbeat"
    }
  }, {
    runner,
    heartbeatIntervalMs: 10,
    onProgress: (event) => {
      events.push(event);
    }
  });

  assert.equal(execution.status, "failed");
  assert.equal(events.some((event) => event.type === "packet_heartbeat"), true);
  const heartbeatCountAtFailure = events.filter((event) => event.type === "packet_heartbeat").length;
  await sleep(30);
  assert.equal(
    events.filter((event) => event.type === "packet_heartbeat").length,
    heartbeatCountAtFailure
  );
});

test("auto workflow returns a structured stop when a read-only role reports file changes", async () => {
  const runner = createScriptedWorkerRunner([
    {
      role: "implementer",
      result: {
        status: "success",
        summary: "Patched the helper.",
        changedFiles: ["web/src/utils/format.js"],
        commandsRun: [],
        evidence: ["Implemented the requested change."],
        openQuestions: []
      }
    },
    {
      role: "verifier",
      result: {
        status: "success",
        summary: "Claimed verification while editing code.",
        changedFiles: ["web/src/utils/format.js"],
        commandsRun: [],
        evidence: [],
        openQuestions: []
      }
    }
  ]);

  const execution = await runAutoWorkflow({
    goal: "Rename a local helper in one file",
    allowedFiles: ["web/src/utils/format.js"]
  }, { runner });

  assert.equal(execution.status, "failed");
  assert.equal(execution.runs.length, 2);
  assert.equal(execution.runs[1].packet.role, "verifier");
  assert.equal(execution.runs[1].result.status, "failed");
  assert.match(execution.stopReason, /verifier is read-only/i);
  assert.match(execution.stopReason, /web\/src\/utils\/format\.js/i);
});
