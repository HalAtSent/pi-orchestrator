import test from "node:test";
import assert from "node:assert/strict";

import { createPiAdapter } from "../src/pi-adapter.js";

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
