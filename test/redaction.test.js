import test from "node:test";
import assert from "node:assert/strict";

import {
  BOUNDARY_TRUNCATION_MARKER_PREFIX,
  BOUNDARY_TRUNCATION_MARKER_SUFFIX,
  assertRedactionMetadataMatchesCoveredStrings,
  createBoundaryPathRedactor,
  mergeRedactionMetadata,
  normalizeRedactionMetadata,
  recomputeRedactionMetadataFromCoveredStrings,
  truncateBoundaryString
} from "../src/redaction.js";

function buildPathFixture() {
  if (process.platform === "win32") {
    return {
      repositoryRoot: "C:\\repo\\project",
      workspaceRoot: "C:\\tmp\\pi-orchestrator-process-worker-abc",
      repoFilePath: "C:\\repo\\project\\src\\index.js",
      workspaceFilePath: "C:\\tmp\\pi-orchestrator-process-worker-abc\\src\\scratch.js",
      externalPath: "D:\\outside\\secrets.txt"
    };
  }

  return {
    repositoryRoot: "/repo/project",
    workspaceRoot: "/tmp/pi-orchestrator-process-worker-abc",
    repoFilePath: "/repo/project/src/index.js",
    workspaceFilePath: "/tmp/pi-orchestrator-process-worker-abc/src/scratch.js",
    externalPath: "/opt/outside/secrets.txt"
  };
}

test("truncateBoundaryString keeps values at or below the configured cap unchanged", () => {
  assert.equal(truncateBoundaryString("abcd", { maxLength: 4 }), "abcd");
  assert.equal(truncateBoundaryString("ab", { maxLength: 4 }), "ab");
});

test("truncateBoundaryString appends a stable marker when values exceed the configured cap", () => {
  const truncated = truncateBoundaryString("abcdef", { maxLength: 4 });
  assert.equal(
    truncated,
    `abcd${BOUNDARY_TRUNCATION_MARKER_PREFIX}2${BOUNDARY_TRUNCATION_MARKER_SUFFIX}`
  );
});

test("boundary path redactor rewrites repo/workspace/external absolute paths deterministically", () => {
  const fixture = buildPathFixture();
  const redactor = createBoundaryPathRedactor({
    repositoryRoot: fixture.repositoryRoot,
    processWorkspaceRoots: [fixture.workspaceRoot]
  });

  const repo = redactor.redactString(`repo_file: ${fixture.repoFilePath}`);
  assert.equal(repo.value, "repo_file: src/index.js");
  assert.deepEqual(repo.redaction, {
    applied: true,
    repoPathRewrites: 1,
    workspacePathRewrites: 0,
    externalPathRewrites: 0
  });

  const workspace = redactor.redactString(`workspace_file: ${fixture.workspaceFilePath}`);
  assert.equal(workspace.value, "workspace_file: <process_workspace>/src/scratch.js");
  assert.deepEqual(workspace.redaction, {
    applied: true,
    repoPathRewrites: 0,
    workspacePathRewrites: 1,
    externalPathRewrites: 0
  });

  const external = redactor.redactString(`external_file: ${fixture.externalPath}`);
  assert.equal(external.value, "external_file: <absolute_path>");
  assert.deepEqual(external.redaction, {
    applied: true,
    repoPathRewrites: 0,
    workspacePathRewrites: 0,
    externalPathRewrites: 1
  });
});

test("boundary path redactor keeps relative paths unchanged", () => {
  const fixture = buildPathFixture();
  const redactor = createBoundaryPathRedactor({
    repositoryRoot: fixture.repositoryRoot,
    processWorkspaceRoots: [fixture.workspaceRoot]
  });

  const result = redactor.redactString("relative/path.txt");
  assert.equal(result.value, "relative/path.txt");
  assert.deepEqual(result.redaction, {
    applied: false,
    repoPathRewrites: 0,
    workspacePathRewrites: 0,
    externalPathRewrites: 0
  });
});

test("boundary path redactor rewrites single-segment absolute posix roots without drive-letter false positives", () => {
  const redactor = createBoundaryPathRedactor({
    repositoryRoot: "/repo",
    processWorkspaceRoots: ["/tmp"]
  });

  const result = redactor.redactString("repo:/repo workspace:/tmp external:/opt relative:relative/path.txt");
  assert.equal(
    result.value,
    "repo:. workspace:<process_workspace> external:<absolute_path> relative:relative/path.txt"
  );
  assert.deepEqual(result.redaction, {
    applied: true,
    repoPathRewrites: 1,
    workspacePathRewrites: 1,
    externalPathRewrites: 1
  });
});

test("redaction metadata normalization fails closed for malformed present values", () => {
  assert.throws(
    () => normalizeRedactionMetadata({
      applied: true,
      repoPathRewrites: 0,
      workspacePathRewrites: 0,
      externalPathRewrites: 0
    }, {
      fieldName: "entry.redaction",
      allowMissing: false
    }),
    /entry\.redaction\.applied must be false/u
  );
});

test("mergeRedactionMetadata sums rewrite counters deterministically", () => {
  const merged = mergeRedactionMetadata(
    {
      applied: true,
      repoPathRewrites: 1,
      workspacePathRewrites: 0,
      externalPathRewrites: 0
    },
    {
      applied: true,
      repoPathRewrites: 0,
      workspacePathRewrites: 2,
      externalPathRewrites: 1
    }
  );

  assert.deepEqual(merged, {
    applied: true,
    repoPathRewrites: 1,
    workspacePathRewrites: 2,
    externalPathRewrites: 1
  });
});

test("recomputeRedactionMetadataFromCoveredStrings derives deterministic rewrite counts from covered strings", () => {
  const fixture = buildPathFixture();
  const redactor = createBoundaryPathRedactor({
    repositoryRoot: fixture.repositoryRoot,
    processWorkspaceRoots: [fixture.workspaceRoot]
  });
  const recomputed = recomputeRedactionMetadataFromCoveredStrings({
    redactor,
    stringFields: [
      {
        fieldName: "entry.summary",
        value: `repo_file: ${fixture.repoFilePath}`
      }
    ],
    stringArrayFields: [
      {
        fieldName: "entry.evidence",
        value: [
          `workspace_file: ${fixture.workspaceFilePath}`,
          `external_file: ${fixture.externalPath}`
        ]
      }
    ]
  });

  assert.deepEqual(recomputed, {
    applied: true,
    repoPathRewrites: 1,
    workspacePathRewrites: 1,
    externalPathRewrites: 1
  });
});

test("assertRedactionMetadataMatchesCoveredStrings fails closed when supplied metadata is fabricated", () => {
  const fixture = buildPathFixture();
  const redactor = createBoundaryPathRedactor({
    repositoryRoot: fixture.repositoryRoot
  });

  assert.throws(
    () => assertRedactionMetadataMatchesCoveredStrings({
      applied: true,
      repoPathRewrites: 1,
      workspacePathRewrites: 0,
      externalPathRewrites: 0
    }, {
      redactor,
      fieldName: "entry.redaction",
      stringFields: [
        {
          fieldName: "entry.summary",
          value: "relative/path.txt"
        }
      ]
    }),
    /entry\.redaction must exactly match redaction metadata recomputed from covered strings/u
  );
});
