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

function validContextManifestEntry(overrides = {}) {
  return {
    kind: "context_file",
    source: "packet_context_files",
    reference: "README.md",
    reason: "explicit_request",
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

test("createTaskPacket rejects absolute and escaping scope paths", () => {
  for (const [fieldName, value] of [
    ["allowedFiles", "/tmp/outside.txt"],
    ["allowedFiles", "../outside.txt"],
    ["allowedFiles", "C:outside.txt"],
    ["forbiddenFiles", "src/../outside.txt"],
    ["contextFiles", "docs/../../outside.txt"]
  ]) {
    assert.throws(
      () => createTaskPacket(validTaskPacket({
        [fieldName]: [value],
        contextManifest: undefined
      })),
      /must be a repository-relative path|must not escape the repository root/u,
      `${fieldName}: ${value}`
    );
  }
});

test("createTaskPacket rejects malformed contextManifest entries", () => {
  assert.throws(
    () => createTaskPacket(validTaskPacket({
      contextManifest: [
        validContextManifestEntry({
          reference: "   "
        })
      ]
    })),
    /packet\.contextManifest\[0\]\.reference must be a non-empty string/u
  );
});

test("createTaskPacket rejects unknown contextManifest enum values", () => {
  assert.throws(
    () => createTaskPacket(validTaskPacket({
      contextManifest: [
        validContextManifestEntry({
          kind: "context_blob"
        })
      ]
    })),
    /packet\.contextManifest\[0\]\.kind must be one of: context_file, prior_result, review_result, changed_surface/u
  );

  assert.throws(
    () => createTaskPacket(validTaskPacket({
      contextManifest: [
        validContextManifestEntry({
          source: "packet_inputs"
        })
      ]
    })),
    /packet\.contextManifest\[0\]\.source must be one of: packet_context_files, workflow_prior_runs, repair_review, trusted_changed_surface/u
  );

  assert.throws(
    () => createTaskPacket(validTaskPacket({
      contextManifest: [
        validContextManifestEntry({
          reason: "operator_hint"
        })
      ]
    })),
    /packet\.contextManifest\[0\]\.reason must be one of: explicit_request, repair_context, execution_history, changed_scope_carry_forward/u
  );
});

test("createTaskPacket materializes canonical contextManifest from contextFiles when omitted", () => {
  const packet = createTaskPacket(validTaskPacket({
    contextFiles: ["README.md", "docs/OPERATING-GUIDE.md"],
    contextManifest: undefined
  }));

  assert.deepEqual(packet.contextManifest, [
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
  ]);
});

test("createTaskPacket accepts explicit packet contextManifest when it matches contextFiles", () => {
  const packet = createTaskPacket(validTaskPacket({
    contextFiles: ["README.md", "docs/OPERATING-GUIDE.md"],
    contextManifest: [
      validContextManifestEntry({
        reference: "README.md"
      }),
      validContextManifestEntry({
        reference: "docs/OPERATING-GUIDE.md"
      })
    ]
  }));

  assert.deepEqual(packet.contextManifest, [
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
  ]);
});

test("createTaskPacket rejects packet contextManifest drift from contextFiles", () => {
  assert.throws(
    () => createTaskPacket(validTaskPacket({
      contextFiles: ["README.md"],
      contextManifest: [
        validContextManifestEntry({
          reference: "docs/OPERATING-GUIDE.md"
        })
      ]
    })),
    /packet\.contextManifest must exactly match canonical packet context_file entries derived from packet\.contextFiles/u
  );
});

test("createTaskPacket rejects runtime-only contextManifest kinds on packet input", () => {
  assert.throws(
    () => createTaskPacket(validTaskPacket({
      contextFiles: ["README.md"],
      contextManifest: [
        validContextManifestEntry({
          kind: "prior_result",
          source: "workflow_prior_runs",
          reference: "implementer-task-1",
          reason: "execution_history"
        })
      ]
    })),
    /packet\.contextManifest\[0\]\.kind must be context_file for packet-level context manifests/u
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

test("createWorkerResult rejects malformed commandObservations payloads", () => {
  assert.throws(
    () => createWorkerResult(validWorkerResult({
      commandObservations: [
        {
          command: "npm install",
          source: "untrusted_source",
          actionClasses: ["execute_local_command", "install_dependency"]
        }
      ]
    })),
    /result\.commandObservations\[0\]\.source must be one of: worker_reported, process_backend_launcher/u
  );
});

test("createWorkerResult rejects malformed reviewFindings payloads", () => {
  assert.throws(
    () => createWorkerResult(validWorkerResult({
      reviewFindings: [
        {
          kind: "issue",
          severity: "critical",
          message: "Potential regression in helper validation."
        }
      ]
    })),
    /result\.reviewFindings\[0\]\.severity must be one of: high, medium, low/u
  );

  assert.throws(
    () => createWorkerResult(validWorkerResult({
      reviewFindings: [
        {
          kind: "risk",
          severity: "medium",
          message: "Touches an out-of-scope file.",
          path: "../outside.js"
        }
      ]
    })),
    /result\.reviewFindings\[0\]\.path must not escape the repository root/u
  );
});

test("createWorkerResult rejects malformed providerModelSelection payloads", () => {
  assert.throws(
    () => createWorkerResult(validWorkerResult({
      providerModelSelection: {
        requestedProvider: "openai-codex",
        requestedModel: "gpt-5.3-codex",
        selectedProvider: "unknown",
        selectedModel: "gpt-5.3-codex"
      }
    })),
    /result\.providerModelSelection\.selectedProvider must not be unknown/u
  );
});

test("existing valid payloads still pass and optional arrays can be omitted", () => {
  assert.doesNotThrow(() => createTaskPacket(validTaskPacket()));
  assert.doesNotThrow(() => createTaskPacket(validTaskPacket({
    contextFiles: undefined,
    contextManifest: undefined,
    commands: undefined
  })));
  assert.doesNotThrow(() => createTaskPacket(validTaskPacket({
    contextManifest: [validContextManifestEntry()]
  })));
  assert.doesNotThrow(() => createWorkerResult(validWorkerResult()));
  assert.doesNotThrow(() => createWorkerResult(validWorkerResult({
    commandObservations: [
      {
        command: "npm install --save-dev vitest",
        source: "worker_reported",
        actionClasses: ["execute_local_command", "install_dependency"]
      }
    ],
    reviewFindings: [
      {
        kind: "issue",
        severity: "high",
        message: "Missing regression assertion for scoped rename.",
        path: "src\\contracts.js"
      }
    ],
    providerModelSelection: {
      requestedProvider: "openai-codex",
      requestedModel: "gpt-5.3-codex",
      selectedProvider: "openai-codex",
      selectedModel: "gpt-5.3-codex"
    }
  })));
});
