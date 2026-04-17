import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { createPiAdapter } from "../src/pi-adapter.js";
import { setTrustedRuntimeRepositoryRoot } from "../src/context-manifest.js";

const TEST_CONTEXT_FILE_REFERENCE = "src/__context_root_probe__.js";

function createWorkerRequest(role = "implementer", overrides = {}) {
  const writeRole = role === "implementer";
  return {
    runId: `${role}-run-1`,
    role,
    goal: "Apply a bounded helper update.",
    allowedFiles: ["src/helpers.js"],
    forbiddenFiles: ["src/forbidden.js"],
    contextFiles: ["README.md"],
    contextManifest: [
      {
        kind: "context_file",
        source: "packet_context_files",
        reference: "README.md",
        reason: "explicit_request"
      }
    ],
    acceptanceChecks: ["Changes compile and stay in scope."],
    stopConditions: ["Stop when scope drift is required."],
    commands: ["node --check src/helpers.js"],
    modelProfile: {
      model: writeRole ? "gpt-5.3-codex-spark" : "gpt-5.4-mini",
      reasoningEffort: writeRole ? "medium" : "medium",
      access: writeRole ? "write" : "read_only"
    },
    controls: {
      noRecursiveDelegation: true,
      taskScoped: true,
      ephemeral: true,
      writePolicy: writeRole ? "allowlist_only" : "read_only"
    },
    context: {
      workflowId: "workflow-test"
    },
    ...overrides
  };
}

function createPacketContextManifest(reference) {
  return [
    {
      kind: "context_file",
      source: "packet_context_files",
      reference,
      reason: "explicit_request"
    }
  ];
}

function resolveRepositoryReference(repositoryRoot, reference) {
  return join(repositoryRoot, ...reference.split("/"));
}

test("adapter forwards bounded worker request fields to the runtime host", async () => {
  const calls = [];
  const adapter = createPiAdapter({
    supportedRoles: ["implementer", "verifier"],
    host: {
      async runWorker(request, context) {
        calls.push({ request, context });
        return {
          status: "success",
          summary: `${request.role} completed`,
          changedFiles: request.role === "implementer" ? [request.allowedFiles[0]] : [],
          commandsRun: request.commands,
          evidence: [`role=${request.role}`],
          openQuestions: []
        };
      }
    }
  });

  const request = createWorkerRequest("implementer");
  const result = await adapter.runWorker(request, {
    packet: { id: "packet-1" },
    roleProfile: { access: "write" },
    context: { workflowId: "workflow-test" }
  });

  assert.equal(result.status, "success");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.role, "implementer");
  assert.equal(calls[0].request.goal, "Apply a bounded helper update.");
  assert.deepEqual(calls[0].request.allowedFiles, ["src/helpers.js"]);
  assert.deepEqual(calls[0].request.forbiddenFiles, ["src/forbidden.js"]);
  assert.deepEqual(calls[0].request.contextFiles, ["README.md"]);
  assert.deepEqual(calls[0].request.contextManifest, [
    {
      kind: "context_file",
      source: "packet_context_files",
      reference: "README.md",
      reason: "explicit_request"
    }
  ]);
  assert.deepEqual(calls[0].request.acceptanceChecks, ["Changes compile and stay in scope."]);
  assert.deepEqual(calls[0].request.stopConditions, ["Stop when scope drift is required."]);
  assert.deepEqual(calls[0].request.commands, ["node --check src/helpers.js"]);
  assert.equal(calls[0].request.controls.noRecursiveDelegation, true);
  assert.equal(calls[0].request.controls.writePolicy, "allowlist_only");
  assert.equal(calls[0].context.packet.id, "packet-1");
});

test("adapter preserves runtime typed review findings when provided", async () => {
  const adapter = createPiAdapter({
    supportedRoles: ["reviewer"],
    host: {
      async runWorker() {
        return {
          status: "success",
          summary: "Review completed.",
          changedFiles: [],
          commandsRun: ["git diff --stat"],
          evidence: ["Scoped review completed."],
          openQuestions: [],
          reviewFindings: [
            {
              kind: "issue",
              severity: "high",
              message: "Missing scoped regression assertion.",
              path: "src\\helpers.js"
            }
          ]
        };
      }
    }
  });

  const result = await adapter.runWorker(createWorkerRequest("reviewer"), {});

  assert.equal(result.status, "success");
  assert.deepEqual(result.reviewFindings, [
    {
      kind: "issue",
      severity: "high",
      message: "Missing scoped regression assertion.",
      path: "src/helpers.js"
    }
  ]);
});

test("adapter blocks cleanly when the Pi runtime does not expose worker execution", async () => {
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {}
  });

  const result = await adapter.runWorker(createWorkerRequest("implementer"), {});

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /does not expose runWorker/i);
});

test("adapter blocks roles that are outside its configured live support", async () => {
  let runtimeCallCount = 0;
  const adapter = createPiAdapter({
    supportedRoles: ["implementer", "verifier"],
    host: {
      async runWorker() {
        runtimeCallCount += 1;
        return {
          status: "success",
          summary: "unexpected",
          changedFiles: [],
          commandsRun: [],
          evidence: [],
          openQuestions: []
        };
      }
    }
  });

  const result = await adapter.runWorker(createWorkerRequest("reviewer"), {});

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /not supported/i);
  assert.equal(runtimeCallCount, 0);
});

test("adapter blocks runtime responses that signal recursive delegation", async () => {
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {
      async runWorker(request) {
        return {
          delegated: true,
          result: {
            status: "success",
            summary: `${request.role} completed`,
            changedFiles: [request.allowedFiles[0]],
            commandsRun: [],
            evidence: [],
            openQuestions: []
          }
        };
      }
    }
  });

  const result = await adapter.runWorker(createWorkerRequest("implementer"), {});

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /recursive delegation/i);
});

test("adapter fails closed when workflowContext payloads drift from contextManifest", async () => {
  let runtimeCallCount = 0;
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {
      async runWorker() {
        runtimeCallCount += 1;
        return {
          status: "success",
          summary: "unexpected",
          changedFiles: ["src/helpers.js"],
          commandsRun: [],
          evidence: [],
          openQuestions: []
        };
      }
    }
  });

  const request = createWorkerRequest("implementer");
  const result = await adapter.runWorker(request, {
    context: {
      priorResults: [
        {
          packetId: "explorer-packet-1",
          role: "explorer",
          status: "success",
          summary: "Mapped scope.",
          changedFiles: [],
          commandsRun: ["rg --files"],
          evidence: ["Scope mapped."],
          openQuestions: []
        }
      ],
      contextManifest: [
        {
          kind: "context_file",
          source: "packet_context_files",
          reference: "README.md",
          reason: "explicit_request"
        }
      ]
    }
  });

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /runtime context assembly invalid or drifted from contextManifest\[\]/i);
  assert.equal(runtimeCallCount, 0);
});

test("adapter fails closed on missing workflowContext context_file runtime references", async () => {
  let runtimeCallCount = 0;
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {
      async runWorker() {
        runtimeCallCount += 1;
        return {
          status: "success",
          summary: "unexpected",
          changedFiles: ["src/helpers.js"],
          commandsRun: [],
          evidence: [],
          openQuestions: []
        };
      }
    }
  });

  const missingReference = "docs/DOES-NOT-EXIST.md";
  const request = createWorkerRequest("implementer", {
    contextFiles: [missingReference],
    contextManifest: [
      {
        kind: "context_file",
        source: "packet_context_files",
        reference: missingReference,
        reason: "explicit_request"
      }
    ]
  });
  const result = await adapter.runWorker(request, {
    context: {
      contextManifest: [
        {
          kind: "context_file",
          source: "packet_context_files",
          reference: missingReference,
          reason: "explicit_request"
        }
      ]
    }
  });

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /context\.workflowContext\.packetContextFiles\[0\] must reference an existing repository file/i);
  assert.equal(runtimeCallCount, 0);
});

test("adapter ignores caller-authored constructor repositoryRoot when resolving context_file admission", async () => {
  const forgedRepositoryRoot = mkdtempSync(join(tmpdir(), "pi-adapter-context-constructor-forged-root-"));
  const spoofedReference = "src/__adapter_constructor_spoof_probe__.js";
  mkdirSync(join(forgedRepositoryRoot, "src"), { recursive: true });
  writeFileSync(
    resolveRepositoryReference(forgedRepositoryRoot, spoofedReference),
    "export const forged = true;\n",
    "utf8"
  );
  const contextManifest = createPacketContextManifest(spoofedReference);

  let runtimeCallCount = 0;
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    repositoryRoot: forgedRepositoryRoot,
    host: {
      async runWorker() {
        runtimeCallCount += 1;
        return {
          status: "success",
          summary: "unexpected",
          changedFiles: ["src/helpers.js"],
          commandsRun: [],
          evidence: [],
          openQuestions: []
        };
      }
    }
  });

  try {
    const request = createWorkerRequest("implementer", {
      contextFiles: [spoofedReference],
      contextManifest
    });
    const result = await adapter.runWorker(request, {
      context: {
        contextManifest
      }
    });

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /context\.workflowContext\.packetContextFiles\[0\] must reference an existing repository file/i);
    assert.equal(runtimeCallCount, 0);
  } finally {
    rmSync(forgedRepositoryRoot, { recursive: true, force: true });
  }
});

test("adapter validates workflowContext context_file references against trusted runtime repositoryRoot metadata", async () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "pi-adapter-context-root-"));
  mkdirSync(join(repositoryRoot, "src"), { recursive: true });
  writeFileSync(
    resolveRepositoryReference(repositoryRoot, TEST_CONTEXT_FILE_REFERENCE),
    "export const contextProbe = true;\n",
    "utf8"
  );
  const contextManifest = createPacketContextManifest(TEST_CONTEXT_FILE_REFERENCE);

  let runtimeCallCount = 0;
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {
      async runWorker(request) {
        runtimeCallCount += 1;
        return {
          status: "success",
          summary: `${request.role} completed`,
          changedFiles: [request.allowedFiles[0]],
          commandsRun: request.commands,
          evidence: ["runtime call accepted"],
          openQuestions: []
        };
      }
    }
  });

  try {
    const request = createWorkerRequest("implementer", {
      contextFiles: [TEST_CONTEXT_FILE_REFERENCE],
      contextManifest
    });
    const workflowContext = {
      contextManifest
    };
    setTrustedRuntimeRepositoryRoot(workflowContext, repositoryRoot, {
      fieldName: "test.workflowContext.repositoryRoot"
    });
    const result = await adapter.runWorker(request, {
      context: workflowContext
    });

    assert.equal(result.status, "success");
    assert.equal(runtimeCallCount, 1);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("adapter trusted runtime repositoryRoot still fails closed on missing workflowContext context_file references", async () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "pi-adapter-context-missing-"));
  const missingReference = "src/__missing_context_probe__.js";
  const contextManifest = createPacketContextManifest(missingReference);

  let runtimeCallCount = 0;
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {
      async runWorker() {
        runtimeCallCount += 1;
        return {
          status: "success",
          summary: "unexpected",
          changedFiles: ["src/helpers.js"],
          commandsRun: [],
          evidence: [],
          openQuestions: []
        };
      }
    }
  });

  try {
    const request = createWorkerRequest("implementer", {
      contextFiles: [missingReference],
      contextManifest
    });
    const workflowContext = {
      contextManifest
    };
    setTrustedRuntimeRepositoryRoot(workflowContext, repositoryRoot, {
      fieldName: "test.workflowContext.repositoryRoot"
    });
    const result = await adapter.runWorker(request, {
      context: workflowContext
    });

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /context\.workflowContext\.packetContextFiles\[0\] must reference an existing repository file/i);
    assert.equal(runtimeCallCount, 0);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("adapter trusted runtime repositoryRoot still fails closed when workflowContext context_file escapes the repository root", async () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "pi-adapter-context-escape-root-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "pi-adapter-context-escape-outside-"));
  const outsideFile = join(outsideRoot, "__context_escape_probe__.js");
  writeFileSync(outsideFile, "export const escaped = true;\n", "utf8");
  const escapeReference = relative(repositoryRoot, outsideFile).replace(/\\/g, "/");
  assert.match(escapeReference, /^\.\.\//u);
  const contextManifest = createPacketContextManifest(escapeReference);

  let runtimeCallCount = 0;
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {
      async runWorker() {
        runtimeCallCount += 1;
        return {
          status: "success",
          summary: "unexpected",
          changedFiles: ["src/helpers.js"],
          commandsRun: [],
          evidence: [],
          openQuestions: []
        };
      }
    }
  });

  try {
    const request = createWorkerRequest("implementer", {
      contextFiles: [escapeReference],
      contextManifest
    });
    const workflowContext = {
      contextManifest
    };
    setTrustedRuntimeRepositoryRoot(workflowContext, repositoryRoot, {
      fieldName: "test.workflowContext.repositoryRoot"
    });
    const result = await adapter.runWorker(request, {
      context: workflowContext
    });

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /context\.workflowContext\.packetContextFiles\[0\] must resolve within the repository root/i);
    assert.equal(runtimeCallCount, 0);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("adapter ignores caller-authored plain workflowContext.repositoryRoot when trusted root metadata is present", async () => {
  const trustedRepositoryRoot = mkdtempSync(join(tmpdir(), "pi-adapter-context-trusted-root-"));
  const forgedRepositoryRoot = mkdtempSync(join(tmpdir(), "pi-adapter-context-forged-root-"));
  mkdirSync(join(forgedRepositoryRoot, "src"), { recursive: true });
  writeFileSync(
    resolveRepositoryReference(forgedRepositoryRoot, TEST_CONTEXT_FILE_REFERENCE),
    "export const forged = true;\n",
    "utf8"
  );
  const contextManifest = createPacketContextManifest(TEST_CONTEXT_FILE_REFERENCE);

  let runtimeCallCount = 0;
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {
      async runWorker() {
        runtimeCallCount += 1;
        return {
          status: "success",
          summary: "unexpected",
          changedFiles: ["src/helpers.js"],
          commandsRun: [],
          evidence: [],
          openQuestions: []
        };
      }
    }
  });

  try {
    const request = createWorkerRequest("implementer", {
      contextFiles: [TEST_CONTEXT_FILE_REFERENCE],
      contextManifest
    });
    const workflowContext = {
      contextManifest,
      repositoryRoot: forgedRepositoryRoot
    };
    setTrustedRuntimeRepositoryRoot(workflowContext, trustedRepositoryRoot, {
      fieldName: "test.workflowContext.repositoryRoot"
    });
    const result = await adapter.runWorker(request, {
      context: workflowContext
    });

    assert.equal(result.status, "blocked");
    assert.match(result.summary, /context\.workflowContext\.packetContextFiles\[0\] must reference an existing repository file/i);
    assert.equal(runtimeCallCount, 0);
  } finally {
    rmSync(trustedRepositoryRoot, { recursive: true, force: true });
    rmSync(forgedRepositoryRoot, { recursive: true, force: true });
  }
});

test("adapter fails closed on duplicate workflowContext prior-result packet ids", async () => {
  let runtimeCallCount = 0;
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {
      async runWorker() {
        runtimeCallCount += 1;
        return {
          status: "success",
          summary: "unexpected",
          changedFiles: ["src/helpers.js"],
          commandsRun: [],
          evidence: [],
          openQuestions: []
        };
      }
    }
  });

  const duplicatePriorResult = {
    packetId: "explorer-packet-1",
    role: "explorer",
    status: "success",
    summary: "Mapped scope.",
    changedFiles: [],
    commandsRun: ["rg --files"],
    evidence: ["Scope mapped."],
    openQuestions: []
  };
  const request = createWorkerRequest("implementer");
  const result = await adapter.runWorker(request, {
    context: {
      priorResults: [
        duplicatePriorResult,
        {
          ...duplicatePriorResult,
          summary: "Second payload entry with the same packet id."
        }
      ],
      contextManifest: [
        {
          kind: "context_file",
          source: "packet_context_files",
          reference: "README.md",
          reason: "explicit_request"
        },
        {
          kind: "prior_result",
          source: "workflow_prior_runs",
          reference: "explorer-packet-1",
          reason: "execution_history"
        }
      ]
    }
  });

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /duplicates packetId/i);
  assert.equal(runtimeCallCount, 0);
});

test("adapter fails closed on contradictory workflowContext.contextBudget metadata", async () => {
  let runtimeCallCount = 0;
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {
      async runWorker() {
        runtimeCallCount += 1;
        return {
          status: "success",
          summary: "unexpected",
          changedFiles: ["src/helpers.js"],
          commandsRun: [],
          evidence: [],
          openQuestions: []
        };
      }
    }
  });

  const request = createWorkerRequest("implementer");
  const result = await adapter.runWorker(request, {
    context: {
      priorResults: [
        {
          packetId: "explorer-packet-1",
          role: "explorer",
          status: "success",
          summary: "Mapped scope.",
          changedFiles: [],
          commandsRun: ["rg --files"],
          evidence: ["Scope mapped."],
          openQuestions: []
        }
      ],
      contextManifest: [
        {
          kind: "context_file",
          source: "packet_context_files",
          reference: "README.md",
          reason: "explicit_request"
        },
        {
          kind: "prior_result",
          source: "workflow_prior_runs",
          reference: "explorer-packet-1",
          reason: "execution_history"
        }
      ],
      contextBudget: {
        priorResultsTruncated: false,
        truncatedPriorResultPacketIds: ["omitted-prior-result"],
        perResultEvidenceTruncated: false,
        perResultCommandsTruncated: false,
        perResultChangedFilesTruncated: false,
        truncationCount: {
          priorResults: 0,
          evidenceEntries: 0,
          commandEntries: 0,
          changedFiles: 0
        }
      }
    }
  });

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /context\.workflowContext\.contextBudget\.priorResultsTruncated/i);
  assert.equal(runtimeCallCount, 0);
});

test("adapter fails closed on contradictory workflowContext changed-surface contextBudget metadata", async () => {
  let runtimeCallCount = 0;
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {
      async runWorker() {
        runtimeCallCount += 1;
        return {
          status: "success",
          summary: "unexpected",
          changedFiles: ["src/helpers.js"],
          commandsRun: [],
          evidence: [],
          openQuestions: []
        };
      }
    }
  });

  const request = createWorkerRequest("implementer");
  const result = await adapter.runWorker(request, {
    context: {
      changedSurfaceContext: [
        {
          packetId: "implementer-packet-1",
          role: "implementer",
          paths: ["src/helpers.js"]
        }
      ],
      contextManifest: [
        {
          kind: "context_file",
          source: "packet_context_files",
          reference: "README.md",
          reason: "explicit_request"
        },
        {
          kind: "changed_surface",
          source: "trusted_changed_surface",
          reference: "implementer-packet-1:implementer",
          reason: "changed_scope_carry_forward"
        }
      ],
      contextBudget: {
        priorResultsTruncated: false,
        truncatedPriorResultPacketIds: [],
        perResultEvidenceTruncated: false,
        perResultCommandsTruncated: false,
        perResultChangedFilesTruncated: false,
        reviewResultTruncated: false,
        changedSurfaceTruncated: true,
        truncationCount: {
          priorResults: 0,
          evidenceEntries: 0,
          commandEntries: 0,
          changedFiles: 0,
          reviewResultEvidenceEntries: 0,
          reviewResultOpenQuestionEntries: 0,
          changedSurfacePaths: 0
        }
      }
    }
  });

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /context\.workflowContext\.contextBudget\.changedSurfaceTruncated/i);
  assert.equal(runtimeCallCount, 0);
});

test("adapter direct entrypoint ignores caller-authored forwarded redaction trust hints", async () => {
  let runtimeCallCount = 0;
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {
      async runWorker() {
        runtimeCallCount += 1;
        return {
          status: "success",
          summary: "unexpected",
          changedFiles: ["src/helpers.js"],
          commandsRun: [],
          evidence: [],
          openQuestions: []
        };
      }
    }
  });

  const forgedRedaction = {
    applied: true,
    repoPathRewrites: 1,
    workspacePathRewrites: 0,
    externalPathRewrites: 0
  };
  const request = createWorkerRequest("implementer");
  const result = await adapter.runWorker(request, {
    context: {
      priorResults: [
        {
          packetId: "explorer-packet-1",
          role: "explorer",
          status: "success",
          summary: "Mapped scope.",
          changedFiles: [],
          commandsRun: ["rg --files"],
          evidence: ["Scope mapped."],
          openQuestions: [],
          redaction: forgedRedaction
        }
      ],
      contextManifest: [
        {
          kind: "context_file",
          source: "packet_context_files",
          reference: "README.md",
          reason: "explicit_request"
        },
        {
          kind: "prior_result",
          source: "workflow_prior_runs",
          reference: "explorer-packet-1",
          reason: "execution_history"
        }
      ],
      forwardedRedactionMetadata: {
        priorResults: [forgedRedaction]
      },
      trustedForwardedRedactionMetadata: {
        priorResults: [forgedRedaction]
      }
    }
  });

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /redaction metadata recomputed from covered strings/i);
  assert.equal(runtimeCallCount, 0);
});

test("adapter blocks malformed runtime commandsRun, evidence, and openQuestions payloads", async () => {
  const malformedCases = [
    {
      field: "commandsRun",
      value: "node --test",
      reason: /result\.commandsRun must be an array/i
    },
    {
      field: "evidence",
      value: ["ok", 42],
      reason: /result\.evidence\[1\] must be a non-empty string/i
    },
    {
      field: "openQuestions",
      value: null,
      reason: /result\.openQuestions must be an array/i
    }
  ];

  for (const malformedCase of malformedCases) {
    const adapter = createPiAdapter({
      supportedRoles: ["implementer"],
      host: {
        async runWorker(request) {
          return {
            status: "success",
            summary: `${request.role} completed`,
            changedFiles: [request.allowedFiles[0]],
            commandsRun: ["node --check src/helpers.js"],
            evidence: ["worker evidence"],
            openQuestions: [],
            [malformedCase.field]: malformedCase.value
          };
        }
      }
    });

    const result = await adapter.runWorker(createWorkerRequest("implementer"), {});

    assert.equal(result.status, "blocked");
    assert.match(result.summary, new RegExp(`malformed ${malformedCase.field}`, "i"));
    assert.match(result.evidence.join("\n"), malformedCase.reason);
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(result.commandsRun, []);
  }
});

test("adapter can use host.runtime.runWorker when available", async () => {
  const adapter = createPiAdapter({
    supportedRoles: ["implementer"],
    host: {
      runtime: {
        async runWorker(request) {
          return {
            status: "success",
            summary: `${request.role} completed`,
            changedFiles: [request.allowedFiles[0]],
            commandsRun: request.commands,
            evidence: ["runtime.runWorker"],
            openQuestions: []
          };
        }
      }
    }
  });

  const result = await adapter.runWorker(createWorkerRequest("implementer"), {});

  assert.equal(result.status, "success");
  assert.deepEqual(result.changedFiles, ["src/helpers.js"]);
});
